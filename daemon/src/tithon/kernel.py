"""Detached ipykernel lifecycle: spawn with setsid, persist connection file,
re-attach across daemon restarts.

The kernel is intentionally NOT tied to the daemon's lifetime: it is started
with ``start_new_session=True`` (setsid) so a daemon crash/restart leaves it
running, and the connection file + pid file under the session directory let
the next daemon re-attach (design.md §3.1).
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
        try:
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().decode().replace("\0", " ")
        except OSError:
            return None
        if "ipykernel_launcher" not in cmdline or str(self.conn_file) not in cmdline:
            return None  # pid was recycled by an unrelated process
        return pid

    def ensure(self) -> bool:
        """Re-attach to a live kernel if possible, else spawn. True if spawned."""
        pid = self._alive_pid()
        if pid is not None and self.conn_file.exists():
            self.pid = pid
            self.reattached = True
            log.info("re-attaching to existing kernel pid=%d conn=%s", pid, self.conn_file)
            return False
        self._spawn()
        return True

    def _spawn(self) -> None:
        self.session_dir.mkdir(parents=True, exist_ok=True)
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
        """Terminate the current kernel process (best effort: TERM then KILL)."""
        if self.pid is None:
            return
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(self.pid, sig)
            except OSError:
                return  # already gone
            for _ in range(20):  # up to ~1s for it to exit between TERM and KILL
                try:
                    os.kill(self.pid, 0)
                except OSError:
                    log.info("killed kernel pid=%d", self.pid)
                    return
                time.sleep(0.05)
        log.warning("kernel pid=%s did not exit after SIGKILL", self.pid)

    def restart(self) -> None:
        """Kill the running kernel and spawn a fresh one (new namespace)."""
        self.kill()
        self._spawn()
