"""Detached ipykernel lifecycle: spawn with setsid, persist connection file,
re-attach across daemon restarts.

The kernel is intentionally NOT tied to the daemon's lifetime: it is started
with ``start_new_session=True`` (setsid) so a daemon crash/restart leaves it
running, and the connection file + pid file under the session directory let
the next daemon re-attach (SPEC.md).
"""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from jupyter_client.asynchronous import AsyncKernelClient
from jupyter_client.connect import write_connection_file

log = logging.getLogger("tithon.kernel")


class KernelHandle:
    def __init__(self, session_dir: Path, workdir: Path, log_path: Path):
        self.session_dir = session_dir
        self.workdir = workdir
        self.log_path = log_path
        self.conn_file = session_dir / "kernel.json"
        self.pid_file = session_dir / "kernel.pid"
        self.pid: int | None = None
        # Process group of the running kernel — the cleanup boundary for
        # everything it forked (see :meth:`_sweep_group`). Recorded while the
        # kernel is verified alive, because it cannot be re-derived from a pid
        # that has already died.
        self.pgid: int | None = None
        self.reattached = False

    def _alive_pid(self) -> int | None:
        """PID from pid file iff that process is alive and really our kernel."""
        try:
            pid = int(self.pid_file.read_text().strip())
        except (OSError, ValueError):
            return None
        try:
            os.kill(pid, 0)
        except OSError:
            return None
        if not self._is_ours(pid):
            return None  # pid was recycled by an unrelated process
        return pid

    def _is_ours(self, pid: int) -> bool:
        """True iff ``pid``'s argv names THIS session's kernel.

        Also true for a WORKER the kernel forked: a fork inherits the argv, which
        is why a `DataLoader` pool shows up as a crowd of `ipykernel_launcher`
        processes in `ps`. :meth:`_sweep_orphans` relies on exactly that to prove
        an unattached process group is ours.
        """
        try:
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().decode().replace("\0", " ")
        except OSError:
            return False
        return "ipykernel_launcher" in cmdline and str(self.conn_file) in cmdline

    def is_alive(self) -> bool:
        """True iff our kernel process is still running.

        Uses the same pid-file + ``/proc`` cmdline check as :meth:`_alive_pid`,
        so a DEAD-but-unreaped kernel (a zombie, whose ``/proc/<pid>/cmdline`` is
        empty) reads as not-alive — ``os.kill(pid, 0)`` alone would wrongly
        succeed for a zombie. Used by the exec worker to detect a kernel that
        died mid-execution (crash / OOM-kill / ``os._exit``) so the cell errors
        out instead of waiting forever for an ``execute_reply`` that never comes.
        """
        return self._alive_pid() is not None

    def ensure(self) -> bool:
        """Re-attach to a live kernel if possible, else spawn. True if spawned."""
        pid = self._alive_pid()
        if pid is not None and self.conn_file.exists():
            self.pid = pid
            self.pgid = self._resolve_pgid(pid)
            self.reattached = True
            log.info("re-attaching to existing kernel pid=%d conn=%s", pid, self.conn_file)
            return False
        self._spawn()
        return True

    def _spawn(self) -> None:
        self.session_dir.mkdir(parents=True, exist_ok=True)
        self._sweep_orphans()  # must read the pid file before it is replaced
        self.conn_file.unlink(missing_ok=True)
        self.pid_file.unlink(missing_ok=True)
        write_connection_file(fname=str(self.conn_file), ip="127.0.0.1")
        with open(self.log_path, "ab") as log_f:
            proc = subprocess.Popen(
                [sys.executable, "-m", "ipykernel_launcher", "-f", str(self.conn_file)],
                cwd=str(self.workdir),
                stdin=subprocess.DEVNULL,
                stdout=log_f,
                stderr=log_f,
                start_new_session=True,  # detached: survives daemon death
            )
        self.pid = proc.pid
        self.pgid = self._resolve_pgid(proc.pid)
        self.reattached = False
        self.pid_file.write_text(str(proc.pid))
        log.info("spawned kernel pid=%d conn=%s", proc.pid, self.conn_file)

    def make_client(self) -> AsyncKernelClient:
        kc = AsyncKernelClient()
        kc.load_connection_file(str(self.conn_file))
        kc.start_channels()
        return kc

    def interrupt(self) -> bool:
        """Send SIGINT to the kernel (Jupyter 'interrupt'). True if delivered."""
        if self.pid is None:
            return False
        try:
            os.kill(self.pid, signal.SIGINT)
            log.info("interrupted kernel pid=%d", self.pid)
            return True
        except OSError:
            return False

    def kill(self) -> None:
        """Terminate the kernel AND everything it forked (best effort: TERM then
        KILL), then reap it so a crashed/killed kernel doesn't linger as a zombie.

        The signal goes to the kernel's PROCESS GROUP, not to its pid alone:
        workers a cell spawned (a ``multiprocessing`` pool, a torch
        ``DataLoader``) inherit that group, and signalling only the leader leaves
        them running, re-parented to init, holding CPU and GPU memory with
        nothing left that could ever collect them (see :meth:`_sweep_group`).
        This is also what ``jupyter_client`` does for its own kernels.

        The group is the boundary, so a descendant that deliberately left it —
        its own ``setsid`` / ``start_new_session=True`` — is out of reach, by the
        same mechanism that keeps the kernel itself alive across a daemon death.

        Liveness is checked via ``_alive_pid`` (``/proc`` cmdline), not
        ``os.kill(pid, 0)``: a dead-but-unreaped child is a ZOMBIE whose pid
        ``os.kill(.., 0)`` still answers, which would spin the full
        TERM→KILL→"did not exit" path on every crash and leave the zombie behind.
        """
        if self.pid is None:
            return
        pgid = self.pgid if self.pgid is not None else self._resolve_pgid(self.pid)
        gone = self._alive_pid() is None  # already dead (e.g. it crashed)
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if gone:
                break
            try:
                if pgid is not None:
                    os.killpg(pgid, sig)
                else:  # not a group leader: only the pid is safe to signal
                    os.kill(self.pid, sig)
            except OSError:
                gone = True
                break  # already gone
            for _ in range(20):  # up to ~1s for it to exit between TERM and KILL
                if self._alive_pid() is None:
                    gone = True
                    break
                time.sleep(0.05)
        # Reap BEFORE sweeping: our own leader is a zombie in that group until
        # this runs, and a group holding one is not "still has workers".
        self._reap()
        if gone:
            log.info("killed kernel pid=%d", self.pid)
        else:
            log.warning("kernel pid=%s did not exit after SIGKILL", self.pid)
        # A worker that ignored SIGTERM, or a leader that died before we signalled
        # anything, can leave the group populated after the loop above.
        self._sweep_group(pgid)

    def _resolve_pgid(self, pid: int) -> int | None:
        """The kernel's own process group id, or None when signalling the group
        would be unsafe.

        :meth:`_spawn` uses ``start_new_session=True``, so our kernel leads its
        own session and process group: ``pgid == pid``. Anything else means this
        pid is not that leader and the group may contain processes we never
        started, so the caller must fall back to signalling the pid alone.
        """
        try:
            pgid = os.getpgid(pid)
        except OSError:
            return None
        if pgid != pid or pgid <= 1 or pgid == os.getpgrp():
            return None
        return pgid

    @staticmethod
    def _group_members(pgid: int) -> list[int]:
        """Live (non-zombie) pids in ``pgid``, read from ``/proc``.

        ``os.killpg(pgid, 0)`` cannot answer this on its own: it succeeds for a
        ZOMBIE member too, and a killed kernel is a zombie until it is reaped
        (by :meth:`_reap`, or by init for a kernel we re-attached to), which
        would read as "the workers are still there" and spin the escalation.
        """
        members: list[int] = []
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                stat = Path(f"/proc/{entry}/stat").read_text()
                # comm can contain spaces/parens, so split after the LAST ')':
                # then fields are state, ppid, pgrp, ...
                fields = stat.rsplit(") ", 1)[1].split()
                state, pgrp = fields[0], int(fields[2])
            except (OSError, IndexError, ValueError):
                continue  # exited mid-scan, or an unparsable entry
            if pgrp == pgid and state != "Z":
                members.append(int(entry))
        return members

    def _group_alive(self, pgid: int) -> bool:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return False  # empty group; skip the /proc scan
        except OSError:
            pass  # e.g. EPERM: members exist, we merely may not signal them
        return bool(self._group_members(pgid))

    def _sweep_group(self, pgid: int | None) -> None:
        """TERM→KILL whatever is still in the kernel's process group.

        Safe against pid reuse: Linux keeps a pgid number reserved for as long
        as the group has members, so a group that still answers under a pgid we
        recorded from a live kernel is that kernel's group even after its leader
        died. Callers that did not record it from a live kernel must establish
        that separately (see :meth:`_sweep_orphans`).
        """
        if pgid is None:
            return
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if not self._group_alive(pgid):
                return
            try:
                os.killpg(pgid, sig)
            except OSError:
                return
            # Coarser than the leader's own poll: each check can cost a full
            # /proc scan, and nothing is waiting on this latency (callers run
            # `kill` off the event loop).
            for _ in range(10):  # up to ~1s to exit between TERM and KILL
                if not self._group_alive(pgid):
                    return
                time.sleep(0.1)
        log.warning("kernel pgid=%d still has members after SIGKILL", pgid)

    def _sweep_orphans(self) -> None:
        """Kill workers left behind by a PREVIOUS kernel of this session.

        A kernel that died without going through :meth:`kill` — a crash, an
        OOM-kill, an operator's ``kill -9``, or a daemon restart that outlived
        the process it remembered — leaves its forked workers running in its
        group with no leader. Nothing else will ever collect them, so the next
        spawn does it.

        Unlike :meth:`kill`, this pgid comes off DISK, so it carries no proof
        that the group is ours and three conditions have to establish one: the
        recorded pid must not be a live kernel of ours (``_alive_pid``), the
        group must have no live leader (a recycled pid can only own a group by
        leading it), and at least one member must still carry our connection
        file in its argv (``_is_ours``). The last is what makes it safe: "no LIVE
        leader" alone is not, because a recycled pid can lead a new group and
        then die into a zombie, which the member scan filters out — the innocent
        children would then look exactly like our orphans.

        The cost of that strictness is a false negative: a worker that exec'd
        something else (or a ``multiprocessing`` pool using the *spawn* start
        method) leaves no member carrying our argv, and its group is left alone.
        Declining to sweep leaks processes; sweeping the wrong group kills a
        stranger's.
        """
        if self._alive_pid() is not None:
            return
        try:
            pid = int(self.pid_file.read_text().strip())
        except (OSError, ValueError):
            return
        if pid <= 1 or pid == os.getpgrp():
            return
        members = self._group_members(pid)
        if not members or pid in members:
            return
        if not any(self._is_ours(m) for m in members):
            return  # cannot prove this group is ours; see the docstring
        log.warning("sweeping %d orphan(s) left by dead kernel pid=%d", len(members), pid)
        self._sweep_group(pid)

    def _reap(self) -> None:
        """Reap our now-dead kernel child so it doesn't linger as a zombie. No-op
        if it isn't our child (re-attached across a daemon restart) or already
        reaped (``waitpid`` raises ``ChildProcessError``).

        ``waitpid(WNOHANG)`` can return 0 (not yet waitable) in the brief window
        between the process emptying its ``/proc`` cmdline — which is what made
        :meth:`kill` consider it gone — and the kernel delivering SIGCHLD, so a
        single non-blocking call could leave a zombie behind. Retry the
        non-blocking reap for a short bounded window; it never blocks (WNOHANG),
        so a pid that is somehow not our child / not yet dead can't hang us."""
        if self.pid is None:
            return
        for _ in range(20):  # up to ~0.2s for the dead child to become waitable
            try:
                pid, _status = os.waitpid(self.pid, os.WNOHANG)
            except (ChildProcessError, OSError):
                return  # not our child / already reaped
            if pid != 0:
                return  # reaped
            time.sleep(0.01)

    def restart(self) -> None:
        """Kill the running kernel and spawn a fresh one (new namespace)."""
        self.kill()
        self._spawn()
