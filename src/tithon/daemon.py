"""Tithon daemon: per-file kernel ownership, journaling, multi-client sync.

Each editor file (``session`` id = the file uri) gets its OWN ipykernel and
its OWN journal — like Jupyter, where every notebook has its own kernel, so
variables never leak between files and one file's runs never bleed into
another's view. A single WebSocket server on a unix domain socket (0600) only
— no TCP (SPEC.md security) — routes every op to its session by the
``session`` field. Sessions are created lazily on first attach/execute and the
kernel is spawned detached (setsid), so it survives daemon restarts and the
next client to touch that file re-attaches to the running kernel.

All events carry a monotonic per-session ``seq``; clients attach with
``last_seen_seq`` and receive snapshot+delta.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import signal
import socket
import time
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

from websockets.asyncio.server import unix_serve

from .artifacts import ArtifactStore
from .folding import SCOPE_CELL, SCOPE_KEY, ExecutionFold
from .journal import JOURNALED_IOPUB, Journal, event_from_message
from .kernel import KernelHandle
from .widgets import WidgetMirror, is_comm
from . import sidecar

log = logging.getLogger("tithon.daemon")

#: Session id used when a client sends no ``session`` (the CLI / legacy clients).
DEFAULT_SESSION = "default"

# Backpressure (host-memory protection): a client that cannot keep up must not
# grow the daemon's memory without bound. We cap each subscriber's backlog and
# drop a client that overflows it or stalls on send; the client can reconnect and
# catch up cheaply via snapshot+delta (folding makes a fresh snapshot small).
# The cap/timeout are env-tunable so verification can force the bound quickly;
# the defaults are the production values.
SUB_QUEUE_MAX = int(os.environ.get("TITHON_SUB_QUEUE_MAX", "10000"))  # max queued events/sub
SUB_POLL = float(os.environ.get("TITHON_SUB_POLL", "0.5"))            # dropped-flag recheck (s)
SEND_TIMEOUT = float(os.environ.get("TITHON_SEND_TIMEOUT", "10.0"))   # max stall on send (s)
# Cap each connection's send buffer (websockets `write_limit`) so a slow client
# makes ws.send apply backpressure instead of buffering unboundedly in daemon
# memory. With the bounded queue, host memory per subscriber is ~queue + this.
WRITE_BUFFER_HIGH = int(os.environ.get("TITHON_WRITE_BUFFER_HIGH", str(1 << 20)))  # bytes
# Cap the kernel socket send buffer per connection too (the kernel can otherwise
# hold tens of MB of undelivered data for a stalled client). Bounds host memory.
SOCK_SNDBUF = int(os.environ.get("TITHON_SOCK_SNDBUF", str(1 << 20)))  # bytes
# After (re)creating the kernel client, give the STDIN DEALER a moment to register
# at the kernel's ROUTER before any cell can run. The kernel's stdin ROUTER drops
# an input_request to a not-yet-registered peer (ZMQ default), so an input()/
# getpass() executed in the first tens of ms after channel start could lose its
# prompt and hang. A short settle closes that connection race (measured reliable).
STDIN_SETTLE_S = float(os.environ.get("TITHON_STDIN_SETTLE", "0.3"))  # seconds

# How often, while waiting for a cell's execute_reply, to wake and check the
# kernel is still alive. A kernel that dies mid-run (crash / OOM-kill / os._exit)
# never sends a reply; without this the exec worker would block forever and the
# whole session (incl. queued cells) wedges. Small enough to surface the death
# quickly, large enough not to busy-poll.
KERNEL_REPLY_POLL = float(os.environ.get("TITHON_KERNEL_REPLY_POLL", "1.0"))  # seconds
# Upper bound on the completion barrier (see `_await_idle`). A FALLBACK for a kernel
# that never publishes its closing `status: idle` — never the normal path; the
# barrier's own liveness poll returns sooner whenever the kernel is actually gone.
IDLE_BARRIER_TIMEOUT = float(os.environ.get("TITHON_IDLE_BARRIER_TIMEOUT", "10"))  # s

# Kernel lifetime policy (idle GC). Detached kernels otherwise live forever: with
# per-file kernels, every file ever opened leaves one more immortal process on
# the GPU host. A session whose kernel has been idle — no attached client,
# nothing running or queued, no pending input() — longer than this many seconds
# is reaped: kernel terminated, Session dropped. The journal + artifacts stay on
# disk, so reopening the file restores its full output history under a fresh
# kernel; only the in-memory namespace is lost. 0 (the default) disables the
# policy — a GPU-host kernel must never be surprise-killed unless the operator
# opted in (CLI --idle-timeout / the extension's tithon.kernelIdleTimeout).
KERNEL_IDLE_TIMEOUT = float(os.environ.get("TITHON_KERNEL_IDLE_TIMEOUT", "0"))  # seconds; 0=off
GC_POLL = float(os.environ.get("TITHON_GC_POLL", "60"))  # idle-GC sweep interval (s)
# Kernel liveness watchdog. `KernelHandle.is_alive` is otherwise consulted only on
# the EXECUTION path, and `Session.start()` — which derives the lost-state signal
# — is not re-entered while the daemon lives. So a kernel that dies while IDLE
# (host OOM-kill, operator kill, remote host loss) is observed by nobody and the
# client keeps showing a healthy kernel until the user's next cell. Deliberately
# INDEPENDENT of the idle-GC loop: that loop exists only when idle_timeout > 0,
# which is off by default, so there is no "already running sweep" to ride on.
KERNEL_WATCHDOG_POLL = float(os.environ.get("TITHON_KERNEL_WATCHDOG_POLL", "5"))  # s; 0=off


def _safe_component(s: str) -> str:
    """One filesystem-safe path component (readable, bounded)."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", s)[:80] or "_"


def _uri_to_path(uri: str) -> Path | None:
    """Local filesystem path for a ``file://`` uri, else None."""
    try:
        p = urlparse(uri)
        if p.scheme != "file" or not p.path:
            return None
        return Path(url2pathname(unquote(p.path)))
    except Exception:  # pragma: no cover - defensive
        return None


def _session_layout(
    home: Path, session_id: str, workdir_hint: str | None, default_workdir: Path
) -> tuple[Path, Path]:
    """Return ``(session_dir, artifact_workdir)`` for a session.

    Splits per SPEC.md / ADR-044: the kernel connection file (which carries an
    hmac-sha256 key), pid, log and journal live under ``~/.tithon`` (never in a
    repo); only artifacts are project-local.

    - The default session (CLI/REPL) keeps its historical ``sessions/default``
      dir and the daemon's launch cwd.
    - A file-uri session whose project root is known (``workdir_hint``, sent by
      the client) gets a READABLE, project-qualified kernel/journal dir
      ``sessions/<project>-<hash8>/<relpath…>`` (so a human debugging finds a
      file's session by name, not by an opaque hash), and its artifacts +
      kernel cwd are rooted at its OWN project — fixing the bug where every
      session shared the daemon's single launch cwd, so a second project's
      images landed in the first project's ``.tithon/outputs``.
    - Without a project root (single-file open / a uri outside the root / the
      CLI) fall back to a stable hashed dir + the daemon's cwd.
    """
    base = home / "sessions"
    if session_id == DEFAULT_SESSION:
        return base / DEFAULT_SESSION, default_workdir
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    if workdir_hint:
        root = Path(workdir_hint)
        file_path = _uri_to_path(session_id)
        rel = None
        if file_path is not None:
            try:
                rel = file_path.relative_to(root)
            except ValueError:
                rel = None  # the file is not under the project root
        if rel is not None and rel.parts:
            # Hash the ROOT (stable per project) so all of a project's files
            # share one readable parent; the relpath gives per-file uniqueness.
            proj_hash = hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:8]
            proj = f"{_safe_component(root.name or 'root')}-{proj_hash}"
            parts = [_safe_component(p) for p in rel.parts]
            return base / proj / Path(*parts), root
        return base / digest[:16], root  # outside the root: still root artifacts there
    return base / digest[:16], default_workdir


class SessionKilledError(Exception):
    """Raised by a Session op that lost a race against its own removal.

    See `Session._killed`: kill_kernel/idle-GC pop the session from the manager
    and the op (e.g. restart_kernel) was already past that lookup, bound to the
    now-orphaned Session object.
    """


class Subscriber:
    """One attached client's event queue + a 'too slow, drop me' flag."""

    __slots__ = ("queue", "dropped")

    def __init__(self, queue: "asyncio.Queue") -> None:
        self.queue = queue
        self.dropped = False


class Session:
    """One file's kernel + journal + folded state + subscribers.

    Owns the iopub pump and the execute worker for its kernel. The daemon holds
    a dict of these, keyed by session id (the file uri).
    """

    def __init__(self, session_id: str, session_dir: Path, workdir: Path):
        self.session_id = session_id
        self.session_dir = session_dir
        session_dir.mkdir(parents=True, exist_ok=True)
        # Persist the human-readable session id (file uri) + project workdir next
        # to the kernel so `tithon status` and post-mortems can map the dir back
        # to a file and see where its artifacts/kernel-cwd are rooted.
        (session_dir / "meta.json").write_text(
            json.dumps({"session_id": session_id, "workdir": str(workdir)})
        )
        self.journal = Journal(session_dir / "journal.db", session_id)
        self.kernel = KernelHandle(session_dir, workdir, session_dir / "kernel.log")
        self.artifacts = ArtifactStore(workdir, self.journal)
        # The project-local, git-shareable projection of this file's folds
        # (see sidecar.py). None for the CLI/default session and for a file
        # outside the project root — neither has a document inside the project.
        self.sidecar_path = sidecar.sidecar_path(workdir, _uri_to_path(session_id))
        # Set when the user ENDS this session on purpose (kill kernel, or a
        # daemon shutdown that takes the kernels with it), cleared by the next
        # execution. Persisted in the journal because it must outlive the daemon:
        # reconnecting after a crash has to restore, reopening after a
        # deliberate close must not (see `_handler`'s kill_kernel).
        self.closed_by_user = self.journal.get_meta("closed_by_user") == "1"
        # Executions restored from the shared sidecar rather than run here; they
        # own no raw messages, so `_rebuild_folds` hydrates their folds and
        # `_execution_snapshots` withholds a continuation state for them.
        self._imported: set[str] = set()
        self.kc = None
        self.kernel_status = "unknown"
        self.kernel_pyversion: str | None = None  # e.g. "3.11.5"
        self._folds: dict[str, ExecutionFold] = {}
        # How many live folded snapshots reference each artifact id. When a count
        # hits zero (a frame superseded by clear_output/update_display_data) the
        # file is GC'd, so a live-updating plot keeps O(1) files, not one/step.
        self._artifact_refs: Counter[str] = Counter()
        self._mirror = WidgetMirror()
        # `display_id` -> the execution whose `display_data` CREATED it, for the
        # rest of the session — see `_register_display` / `_display_target`.
        # Never evicted: an update whose owner's fold no longer holds a matching
        # item is already a no-op in `ExecutionFold`, so a stale entry costs one
        # dict lookup, whereas dropping it would re-route the update to the
        # emitter and grow an output there instead.
        self._display_registry: dict[str, str] = {}
        self._msgid_to_exec: dict[str, str] = {}
        # Shell-channel routing: `parent_header.msg_id` -> the awaiter of that
        # request's reply. One pump owns the channel — see `_shell_pump`.
        self._shell_waiters: dict[str, asyncio.Future] = {}
        # Completion barrier: `status: idle` for an execution's parent, signalled
        # from `_handle_iopub` and awaited by `_run_one` (see `_await_idle`).
        self._idle_events: dict[str, asyncio.Event] = {}
        # Recovery probes are kernel requests, not user executions. Their status
        # frames need a parent-keyed fence without ever being folded into a cell.
        self._control_fences: dict[str, dict] = {}
        self._recovery_gate: asyncio.Event | None = None
        self._recovering = False
        # The unanswered input()/getpass() prompt, if a cell is blocked waiting on
        # stdin: {exec_id, prompt, password}. Surfaced live (tithon.input_request)
        # and in the snapshot (pending_input) so a reconnecting client re-prompts.
        self._pending_input: dict | None = None
        self._subs: set[Subscriber] = set()
        self._queue: asyncio.Queue = asyncio.Queue()
        self._exec_counter = 0
        self._tasks: list[asyncio.Task] = []
        # Set in start(): this kernel replaced a previous one WITHOUT the user
        # asking (host reboot, idle-GC reap), so outputs survived but the
        # namespace did not — see _classify_kernel_generation().
        self.kernel_lost_state = False
        # msg_seq of the lifecycle event that opened the current kernel generation:
        # a durable, monotonic id clients de-dup the lost-state warning on. NOT the
        # pid — a rebooted host restarts its pid space, so a later lost kernel can
        # reuse an earlier pid and would be silently suppressed.
        self.kernel_generation = 0
        # Idle-GC bookkeeping: when work last happened (monotonic, wall-jump
        # safe) and whether the exec worker is mid-batch (the queue alone can't
        # tell — the running batch lives in the worker coroutine, not the queue).
        self._busy = False
        self._last_activity = time.monotonic()
        # Watchdog suppression + mutual exclusion for restart_kernel(). Two clients
        # can each ask the same Session to restart (one handler coroutine per
        # connection); a bare flag would not stop the second body from running, and
        # whichever finished first would clear `_restarting` while the other was
        # still mid-respawn — reopening the window in which the watchdog reports
        # the user's own restart as a crash.
        self._restarting = False
        self._restart_lock = asyncio.Lock()
        # Set (under `_restart_lock`, BEFORE the session is popped from
        # SessionManager._sessions — see `_kill_session`/`_gc_sweep`) once this
        # session has been killed or idle-GC'd. A connection binds its
        # `session` reference once (see `_handler`) and never re-resolves it,
        # so a restart request already in flight on a just-removed session
        # must not respawn — that would leave a kernel/pump pair orphaned
        # outside the manager while a fresh session/kernel gets created for
        # the next lookup. Marking `_killed` and popping the id happen inside
        # the SAME lock acquisition, atomically from `_get_session()`'s
        # perspective — never mark-then-pop-later or pop-then-mark-later,
        # either ordering reopens a window where the id is either absent
        # while still alive (a second Session gets spawned for it) or present
        # but silently dead (a new connection binds to a corpse).
        self._killed = False

    # -- lifecycle -----------------------------------------------------------
    async def start(self) -> None:
        spawned = self.kernel.ensure()
        self.kc = self.kernel.make_client()
        if spawned:
            await self._wait_kernel_ready(timeout=120)
            # Must stay ahead of `_start_tasks()`: this reads the shell channel
            # directly. A re-attached busy kernel takes the separate recovery path
            # below; waiting on kernel_info there would discard the output emitted
            # while that request sat behind the running cell (RISKS #18).
            await self._capture_kernel_info()
            await asyncio.sleep(STDIN_SETTLE_S)
            orphaned = self.journal.orphan_inflight()
            recovery = []
        else:
            recovery = self.journal.prepare_reattach()
            orphaned = 0
            if not recovery:
                # A surviving idle kernel still gets a newly-created stdin DEALER.
                # Let it register before the first post-attach execution can run.
                await asyncio.sleep(STDIN_SETTLE_S)
        if orphaned:
            log.info("[%s] marked %d in-flight executions orphaned", self.session_id, orphaned)
        # Must precede the rebuild (it hydrates the imported folds) and the
        # `_exec_counter` seed below (local executions continue after the
        # imported seqs rather than colliding with them).
        self._import_sidecar()
        self._rebuild_folds()
        self._rebuild_mirror()
        self._exec_counter = self.journal.max_exec_seq()
        self._classify_kernel_generation()
        self._recovery_gate = asyncio.Event()
        if not recovery:
            self._recovery_gate.set()
        else:
            exec_id, msg_id, _allow_stdin = recovery[0]
            self._msgid_to_exec[msg_id] = exec_id
            self._idle_events[exec_id] = asyncio.Event()
        self._start_tasks(recovery[0] if recovery else None)
        # Becoming ready counts as activity: the idle clock must not include the
        # kernel-spawn seconds, or a short timeout could reap a session in the
        # gap between creation and the creating client's first op.
        self.touch()
        log.info(
            "session ready id=%s kernel_pid=%s reattached=%s lost_state=%s dir=%s",
            self.session_id, self.kernel.pid, self.kernel.reattached,
            self.kernel_lost_state, self.session_dir,
        )

    def _classify_kernel_generation(self) -> None:
        """Decide whether the current kernel lost the user's state involuntarily.

        `Kernel.ensure` deliberately never errors on an unresumable kernel: it
        re-attaches when the pid file names a live process and otherwise spawns a
        fresh one. That is what makes reconnect-after-daemon-restart work, but it
        means a HOST REBOOT takes the same silent path — the user reopens the
        file, sees the whole output history restored from the journal, assumes
        `df` is still defined, and learns otherwise from a NameError several cells
        later.

        The daemon cannot observe the reboot itself, so it reads INTENT from the
        journal rather than guessing from in-memory flags. Every deliberate
        namespace clear (`restart_kernel`, `tithon kill`, a kill-kernels shutdown)
        journals a ``tithon.kernel`` event carrying ``deliberate: true``; a reboot
        journals nothing, because the machine died. So the ABSENCE of a deliberate
        record in front of a fresh kernel is exactly the reboot signature.

        Deriving it from the journal (instead of ``not reattached``) also makes
        the signal durable. An involuntary replacement is journaled here, so a
        LATER daemon restart that re-attaches to that same replacement kernel
        re-derives ``True`` instead of overwriting the loss with ``False`` before
        any client ever saw it.

        A deliberate marker is NOT a standing pardon — it only excuses the work
        that predates it. "Restart the kernel, run an hour of setup, then the host
        reboots" must still warn, so the question asked of the journal is always
        "did anything RUN on the generation that just died?", anchored at the
        event that opened it.
        """
        last = self.journal.last_kernel_event()
        last_seq, last_content = last if last else (0, {})
        if self.kernel.reattached:
            # We inherited a kernel someone else spawned. Its provenance is
            # whatever the journal recorded when it was created — carry it
            # forward rather than re-deciding (that is the durability fix).
            replaced_involuntarily = (
                last_content.get("status") == "replaced"
                and not last_content.get("deliberate")
            )
            self.kernel_lost_state = bool(replaced_involuntarily)
            self.kernel_generation = last_seq
            return
        # A fresh spawn. Anchor the "did anything run?" window at the event that
        # opened the dead generation. A deliberate reset (`restarted`/`killed`/
        # `shutdown`) and a `replaced` both start the clock over — the user either
        # accepted that loss or was already told about it. An involuntary END
        # (`gc`) does not: the reaped kernel held everything the journal ever ran,
        # so the window stays open from the beginning.
        since = 0 if last_content.get("status") == "gc" else last_seq
        if not self.journal.has_started_since(since):
            self.kernel_lost_state = False
            self.kernel_generation = last_seq
            return
        self.kernel_lost_state = True
        # Record the involuntary replacement so it outlives this daemon process.
        seq = self.journal.append_message(
            None, "tithon.kernel",
            {"status": "replaced", "pid": self.kernel.pid, "deliberate": False},
        )
        self.kernel_generation = seq

    def _start_tasks(self, recovery: tuple[str, str, bool] | None = None) -> None:
        # A cancelled worker (kernel restart) may have died mid-batch with _busy
        # still set; the fresh worker starts with a clean slate — without this a
        # restarted session could never become idle-GC eligible again.
        self._recovering = recovery is not None
        self._busy = self._recovering
        self._tasks = [
            asyncio.create_task(self._iopub_pump(), name=f"iopub-{self.session_id}"),
            asyncio.create_task(self._shell_pump(), name=f"shell-{self.session_id}"),
            asyncio.create_task(self._stdin_pump(), name=f"stdin-{self.session_id}"),
        ]
        if recovery is not None:
            self._tasks.append(asyncio.create_task(
                self._recover_inflight(*recovery), name=f"recover-{self.session_id}"
            ))
        self._tasks.append(asyncio.create_task(
            self._exec_worker(), name=f"exec-{self.session_id}"
        ))

    # -- kernel liveness watchdog ----------------------------------------------
    def check_kernel_liveness(self) -> bool:
        """Observe an out-of-band kernel death; journal + broadcast it ONCE.

        Returns True only on the tick that discovers the death (see
        ``KERNEL_WATCHDOG_POLL`` for why nothing else observes it).

        The event is journaled (not merely broadcast) so a client that was
        disconnected at the moment of death still learns about it via delta
        replay. It carries ``status: "dead"``, which is deliberately NOT one of
        ``Journal.GENERATION_STATUSES``: a death ENDS a kernel generation without
        opening one, so it must not become the anchor of the "did anything RUN on
        the generation that just died?" window — anchoring there would place the
        anchor after all the lost work and silently pardon it. The replacement's
        provenance is recorded as ``replaced`` when the fresh kernel is classified.
        """
        if self._restarting or self.kernel.pid is None:
            return False
        if self.kernel_status == "dead":
            return False  # already reported (by us, or by the exec worker)
        if self.kernel.is_alive():
            return False
        self.kernel_status = "dead"
        self._journal_lifecycle(
            None, "tithon.kernel",
            {"status": "dead", "pid": self.kernel.pid, "deliberate": False},
        )
        log.warning(
            "[%s] kernel died out-of-band (pid=%s) — no execution was in flight",
            self.session_id, self.kernel.pid,
        )
        return True

    # -- idle-GC (kernel lifetime policy) --------------------------------------
    def touch(self) -> None:
        """Record activity now — resets the idle clock (see :meth:`gc_eligible`)."""
        self._last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        return time.monotonic() - self._last_activity

    def gc_eligible(self, timeout: float) -> bool:
        """True iff the idle-GC may reap this session.

        Conservative by design — reaping must never lose work, only an idle
        namespace: an attached client, a queued or running batch, a pending
        input() prompt, or a busy kernel each block it. The ``kernel_status``
        guard covers the re-attach edge where the kernel is still crunching
        code submitted before a daemon restart (busy with no in-daemon batch).
        """
        return (
            timeout > 0
            and not self._subs
            and self._queue.qsize() == 0
            and not self._busy
            and self._pending_input is None
            and not self._recovering
            and self.kernel_status != "busy"
            and self.idle_seconds() >= timeout
        )

    async def _stop_tasks(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
            except Exception:  # pragma: no cover - defensive
                log.exception("[%s] task teardown error", self.session_id)
        self._tasks = []
        self._recovering = False

    async def stop(self, kill_kernel: bool = False) -> None:
        await self._stop_tasks()
        try:
            self.kc.stop_channels()
        except Exception:  # pragma: no cover - defensive
            pass
        # Normally the kernel is left running (detached) so the next daemon
        # re-attaches. For a deliberate interpreter switch we kill it so the new
        # daemon spawns a fresh kernel under the new Python.
        if kill_kernel:
            # Off the event loop: the teardown is synchronous and waits on real
            # processes (TERM→KILL for the kernel, then for its whole group), so
            # inline it would stall EVERY other session and the socket handler.
            await asyncio.to_thread(self.kernel.kill)

    async def restart_kernel(self) -> int:
        """Kill this session's kernel and spawn a fresh one (new namespace).

        Jupyter-style restart: outputs/history stay in the journal, but the
        running namespace is gone. In-flight executions are orphaned and a
        ``tithon.kernel`` event tells clients to reset (clear spinners).
        """
        async with self._restart_lock:
            if self._killed:
                # A concurrent kill_kernel/idle-GC already removed this session
                # from the manager while this request was queued for the lock —
                # see `_killed`. Respawning now would orphan a kernel/pump pair
                # nothing can ever reach again.
                raise SessionKilledError(self.session_id)
            # Suppress the liveness watchdog for the whole teardown+respawn window:
            # the kernel IS momentarily dead here, deliberately.
            self._restarting = True
            try:
                return await self._restart_kernel_inner()
            finally:
                # Always re-arm, even if the respawn failed: leaving the flag set
                # would silently disable death detection for this session forever.
                self._restarting = False

    async def _restart_kernel_inner(self) -> int:
        await self._stop_tasks()
        try:
            self.kc.stop_channels()
        except Exception:  # pragma: no cover - defensive
            pass
        orphan_seq = self.journal.max_seq()
        self.journal.orphan_inflight()
        for seq, exec_id, msg_type, content_json in self.journal.messages_after(orphan_seq):
            if msg_type == "tithon.done":
                self._broadcast(event_from_message(
                    seq, exec_id, msg_type, json.loads(content_json)
                ))
        # Discard batches still WAITING in the queue (submitted behind the cell that
        # was running): orphan_inflight already flipped their queued execs to
        # 'orphaned', so leaving them in the queue would make the fresh worker run
        # stale pre-restart cells on the NEW kernel and re-journal an already-
        # orphaned exec. A restart means a clean slate — drop them.
        dropped = self._drain_queue()
        if dropped:
            log.info("[%s] dropped %d queued batch(es) on restart", self.session_id, dropped)
        self._pending_input = None  # a restart abandons any waiting prompt
        # Journal the INTENT before the kill, not just the outcome after it: a host
        # reboot inside that window would otherwise leave a fresh kernel with no
        # deliberate marker in front of it, reported as a surprise loss.
        self._journal_lifecycle(
            None, "tithon.kernel",
            {"status": "restarting", "pid": self.kernel.pid, "deliberate": True},
        )
        await asyncio.to_thread(self.kernel.restart)  # blocking teardown; see `stop`
        self.kc = self.kernel.make_client()
        await self._wait_kernel_ready(timeout=120)
        await asyncio.sleep(STDIN_SETTLE_S)  # stdin DEALER registers before the next run
        self.kernel_status = "starting"
        self._msgid_to_exec.clear()
        # The old kernel's channels are gone, so nothing will ever resolve a waiter
        # registered against them, and an idle event for a pre-restart execution can
        # never be set. `_stop_tasks` above already failed the shell waiters via the
        # pump's cancellation; clear both maps so the fresh kernel starts clean.
        self._fail_shell_waiters("kernel restarted")
        self._idle_events.clear()
        self._control_fences.clear()
        self._recovery_gate = asyncio.Event()
        self._recovery_gate.set()
        self._start_tasks()
        self._journal_lifecycle(
            None, "tithon.kernel",
            {"status": "restarted", "pid": self.kernel.pid, "deliberate": True},
        )
        self.kernel_lost_state = False
        self.kernel_generation = self.journal.max_seq()
        log.info("[%s] kernel restarted pid=%s", self.session_id, self.kernel.pid)
        return self.kernel.pid

    def interrupt(self) -> bool:
        """Interrupt the running cell (SIGINT to the kernel)."""
        ok = self.kernel.interrupt()
        self._journal_lifecycle(None, "tithon.kernel", {"status": "interrupted"})
        return ok

    def set_closed_by_user(self, closed: bool) -> None:
        """Record durably whether the user ENDED this session or it merely stopped.

        Restoring a file's cells on open is only justified when the disconnect
        was involuntary — a daemon restart, a host reboot, an idle-GC reap, a
        dropped tunnel. When the user killed the kernel themselves, re-seeding
        hands back output they deliberately walked away from, and every later
        reopen keeps handing it back. The journal holds the flag because it has
        to outlive the daemon that observed the intent.

        Not a delete: the history stays, and a client can still ask for it (the
        snapshot carries `closed_by_user`, not a truncated execution list).

        A KILLED session can never be re-armed. Two clients can be attached at
        once, and a connection binds its `session` reference for life (see
        `_killed`): after client B kills the kernel, client A's already-bound
        handler can still submit — which would clear the flag on a session that
        is being torn down, so the next open would restore the very history the
        kill was meant to retire.
        """
        if self.closed_by_user == closed or (not closed and self._killed):
            return
        self.closed_by_user = closed
        self.journal.set_meta("closed_by_user", "1" if closed else "0")

    def clear_outputs(self, exec_ids: list[str] | None) -> int:
        """Permanently clear the folded outputs of executions (all if ``None``).

        A user clearing a cell's output (VSCode "Clear Outputs" / "Clear All
        Outputs") must be durable: the folded snapshot is the daemon's source of
        truth, so without this the next attach re-seeds the old output and the
        cleared output reappears — not what the user asked for.

        SPEC.md keeps the journal append-only and original-preserving, so we do
        NOT delete rows. Instead we append a synthetic ``clear_output``
        (wait=False) per target — the exact message the fold (and the client's
        ``outputFold`` port) already collapse to "no output". That makes the full
        snapshot, the since-N delta replay, and any live subscriber all converge
        on cleared. The fold dropping its artifact references lets the existing
        artifact GC reclaim the image files (so a cleared plot frees its PNG).
        """
        targets = (
            list(self._folds) if exec_ids is None
            else [e for e in exec_ids if e in self._folds]
        )
        reclaim: list[tuple[set[str], set[str]]] = []
        for exec_id in targets:
            fold = self._folds[exec_id]
            before = fold.artifact_ids()
            content = {"wait": False, SCOPE_KEY: SCOPE_CELL}
            seq = self.journal.append_message(exec_id, "clear_output", content)
            fold.apply("clear_output", content)
            self.journal.set_folded(exec_id, json.dumps(fold.outputs()))
            self._broadcast(event_from_message(seq, exec_id, "clear_output", content))
            reclaim.append((before, fold.artifact_ids()))
        if targets:
            # The clear reaches the shared snapshot too — otherwise a colleague
            # who pulls still sees output this user deleted on purpose.
            #
            # Published BEFORE the image files are reclaimed, and the reclaim is
            # abandoned if that write failed (full disk, read-only checkout).
            # Either order without the gate leaves the shared snapshot naming an
            # image that is already deleted — which a clone imports as an output
            # it cannot render. Leaking the files is the recoverable half: the
            # next successful publish is followed by the startup sweep.
            if self._publish_sidecar():
                for before, after in reclaim:
                    self._gc_artifacts(before, after)
            else:
                log.warning("[%s] shared snapshot stale; keeping %d cleared image set(s)",
                            self.session_id, len(reclaim))
            log.info("[%s] user-cleared %d execution(s)", self.session_id, len(targets))
        return len(targets)

    def _import_sidecar(self) -> None:
        """Seed this session from the project's shared snapshot, if that is the
        only history there is.

        The gate is `count_local_executions()`, not "is the journal empty": once
        the user has run a cell here, THIS machine's record is authoritative and
        a pulled sidecar must not overwrite it. Before that, a sidecar whose
        bytes differ from the last imported ones replaces the imported rows
        wholesale — so pulling a notebook a colleague re-ran shows their new
        outputs instead of the ones cloned last week.
        """
        if self.sidecar_path is None:
            return
        found = sidecar.read(self.sidecar_path)
        if found is None:
            return
        doc, sha = found
        if self.journal.get_meta("sidecar_sha") == sha:
            return
        if self.journal.count_local_executions():
            return
        dropped = self.journal.drop_imported()
        imported = sidecar.import_into(self.journal, self.artifacts.workdir, doc)
        self.journal.set_meta("sidecar_sha", sha)
        log.info("[%s] imported %d shared execution(s), replacing %d",
                 self.session_id, imported, dropped)

    def _publish_sidecar(self) -> bool:
        """Rewrite the project's shared snapshot from the current folds.

        Returns whether the shared file now agrees with the folds — False means
        it is stale, and a caller about to delete image files it may still name
        must hold off (see `clear_outputs`).

        Called wherever an execution reaches a terminal state or its output is
        cleared — the same moments `folded_json` is written — so the shared file
        never claims output the daemon has already dropped. Its own sha is
        recorded so the next start does not read back its own write as an
        incoming change (`_import_sidecar`).

        Never fatal: a read-only checkout or a full disk must not fail the run
        that produced the output.
        """
        if self.sidecar_path is None:
            return True  # nothing shared, so nothing can be left inconsistent
        doc = sidecar.build(self._execution_snapshots())
        try:
            sidecar.write(self.sidecar_path, doc)
        except OSError as e:
            log.warning("[%s] could not publish %s: %s", self.session_id, self.sidecar_path, e)
            return False
        self.journal.set_meta("sidecar_sha", hashlib.sha256(
            sidecar.dumps(doc).encode("utf-8")).hexdigest())
        return True

    def _rebuild_folds(self) -> None:
        """Recompute in-memory folded snapshots from raw journal messages.

        ONE streaming, global-seq-ordered pass, not a per-execution loop: a
        cross-cell ``update_display_data`` is journaled under its emitter but
        folds into the display's OWNER (see `_display_registry`), so a loop that
        only ever saw one execution's own rows could not place it. The same pass
        rebuilds the display registry, so the two can never disagree about who
        owns a display after a restart. Streamed (never ``.fetchall()``) so
        restart memory stays independent of history length (RISKS #9a).

        Then seed the live-artifact reference counter from the rebuilt folds and
        sweep ``.tithon/outputs/`` of any artifact no surviving fold references —
        reclaiming frames left behind by a previous run (or by an older daemon
        that predated artifact GC)."""
        # Seed every execution first: `self._folds` must stay total (`_handle_iopub`
        # indexes it unguarded), including for an execution that produced no output.
        # An IMPORTED execution owns no raw messages for the pass below to replay,
        # so it is hydrated from its stored fold instead — an empty one would both
        # render the shared cell blank and make the sweep at the end of this
        # function delete the image files the import just brought in.
        self._imported = self.journal.imported_exec_ids()
        for exec_id, _seq, _code, _status, _count, folded_json, *_ in self.journal.executions():
            if exec_id in self._imported:
                self._folds[exec_id] = ExecutionFold.hydrate(
                    json.loads(folded_json) if folded_json else []
                )
            else:
                self._folds[exec_id] = ExecutionFold()
        self._display_registry.clear()
        for _seq, exec_id, msg_type, content_json in self.journal.all_messages():
            if msg_type.startswith("tithon."):
                continue
            # A row with no execution (a comm from a background thread after the
            # completion barrier popped `_msgid_to_exec`) has no fold to apply to.
            # The live path skips it for the same reason — see `_handle_comm`.
            fold = self._folds.get(exec_id) if exec_id is not None else None
            if fold is None:
                continue
            content = json.loads(content_json)
            fold.apply(msg_type, content)
            if msg_type == "display_data":
                self._register_display(exec_id, content)
        self._artifact_refs = Counter(
            aid for fold in self._folds.values() for aid in fold.artifact_ids()
        )
        removed = self.artifacts.sweep(keep=set(self._artifact_refs))
        if removed:
            log.info("[%s] swept %d orphaned artifact(s)", self.session_id, removed)

    def _rebuild_mirror(self) -> None:
        """Replay journaled comm messages to restore widget state after restart.

        Streams the journal via a cursor filtered to comm rows in SQL (RISKS
        #9a) — a long stream/output history is never fetched or parsed here,
        so restart cost scales with widget traffic, not total history length.
        `WidgetMirror.apply()` itself never raises on malformed content (it
        validates and rejects instead — RISKS #14's journal-before-mutate
        ordering means a malformed row, once journaled, replays on every
        future restart), but the surrounding `_buffers_b64` decode is daemon
        code, not the mirror's — one bad row here must skip and continue, not
        abort every OTHER widget's rebuild.
        """
        for seq, _exec_id, msg_type, content_json in self.journal.comm_messages_after(0):
            try:
                content = json.loads(content_json)
                buffers = [base64.b64decode(b) for b in content.pop("_buffers_b64", [])]
                self._mirror.apply(msg_type, content, buffers)
            except Exception:
                log.exception("[%s] skipping malformed comm row at seq=%d during rebuild",
                               self.session_id, seq)

    async def _wait_kernel_ready(self, timeout: float = 120.0) -> None:
        """Poll kernel_info until the kernel replies.

        Deliberately not ``KernelClient.wait_for_ready``: without a parent
        KernelManager it consults the heartbeat channel, which reports "not
        beating" right after spawn and raises "Kernel died" spuriously.

        Like :meth:`_capture_kernel_info` this reads the shell channel DIRECTLY.
        That is safe only because BOTH call sites (``start`` and
        ``_restart_kernel_inner``) run it before ``_start_tasks()`` creates
        ``_shell_pump``, so it is never a second concurrent consumer. Moving either
        call after ``_start_tasks()`` would make the pump swallow the reply and hang
        this loop until its deadline.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            msg_id = self.kc.kernel_info()
            try:
                reply = await asyncio.wait_for(self.kc.shell_channel.get_msg(), 2.0)
            except (asyncio.TimeoutError, TimeoutError):
                reply = None
            if (
                reply is not None
                and reply["header"]["msg_type"] == "kernel_info_reply"
                and (reply.get("parent_header") or {}).get("msg_id") == msg_id
            ):
                log.info("[%s] kernel ready", self.session_id)
                return
            # Fail fast if the kernel process exited during startup instead of
            # polling the full (120s) timeout — the common cause is the selected
            # interpreter lacking ipykernel, or a crashing startup file.
            if not self.kernel.is_alive():
                raise RuntimeError(
                    "kernel process exited during startup — is ipykernel installed "
                    f"for this interpreter? (see {self.kernel.log_path})"
                )
            if loop.time() > deadline:
                raise RuntimeError("kernel did not become ready in time")
            await asyncio.sleep(0.2)

    async def _capture_kernel_info(self) -> None:
        """One kernel_info round-trip to record the kernel's Python version.

        Runs before the exec worker so there is no shell-channel contention.
        Works for both freshly-spawned and re-attached kernels.
        """
        try:
            msg_id = self.kc.kernel_info()
            for _ in range(15):
                try:
                    reply = await asyncio.wait_for(self.kc.shell_channel.get_msg(), 2.0)
                except (asyncio.TimeoutError, TimeoutError):
                    continue
                if (
                    reply["header"]["msg_type"] == "kernel_info_reply"
                    and (reply.get("parent_header") or {}).get("msg_id") == msg_id
                ):
                    li = reply["content"].get("language_info") or {}
                    self.kernel_pyversion = li.get("version")
                    log.info("[%s] kernel python %s", self.session_id, self.kernel_pyversion)
                    return
        except Exception:  # pragma: no cover - best effort, label is cosmetic
            log.exception("[%s] kernel_info capture failed", self.session_id)

    async def _recovery_probe(self) -> None:
        """Establish a post-subscription fence on a re-attached kernel.

        The recoverable old request has a durable old-parent ``busy`` row, so it
        is already inside ipykernel's serial main-shell handler. A kernel_info
        request sent after the new pumps start can run only after that handler.
        The SUB slow-joiner window can still hide a probe's status frames, so a
        probe counts only when this daemon observes its own busy, shell reply,
        and idle; otherwise another probe is sent.
        """
        while True:
            if not self.kernel.is_alive():
                raise ConnectionError("kernel died during in-flight recovery")
            msg_id = None
            try:
                msg_id = self.kc.kernel_info()
                fut = self._expect_shell(msg_id)
                fence = {"busy": False, "idle": asyncio.Event()}
                self._control_fences[msg_id] = fence
                reply = await asyncio.wait_for(asyncio.shield(fut), 10.0)
                try:
                    await asyncio.wait_for(fence["idle"].wait(), 2.0)
                except (asyncio.TimeoutError, TimeoutError):
                    continue
                if not fence["busy"]:
                    continue
                li = (reply.get("content") or {}).get("language_info") or {}
                self.kernel_pyversion = li.get("version")
                return
            except (asyncio.TimeoutError, TimeoutError):
                continue
            except Exception:
                if not self.kernel.is_alive():
                    raise
                log.exception("[%s] recovery probe failed; retrying", self.session_id)
                await asyncio.sleep(0.2)
                continue
            finally:
                if msg_id is not None:
                    self._shell_waiters.pop(msg_id, None)
                    self._control_fences.pop(msg_id, None)

    async def _recover_inflight(
        self, exec_id: str, msg_id: str, allow_stdin: bool
    ) -> None:
        """Resume journaling an accepted execution owned by the previous daemon.

        The old shell reply is addressed to the dead client's ZMQ identity, so a
        new daemon cannot honestly recover its success flag or execution count.
        Output continues under the durable parent mapping, then the execution is
        terminalized as ``orphaned`` (or ``error`` when an error frame proves it)
        once the control fence says ipykernel left the old handler.
        """
        log.info("[%s] recovering in-flight exec %s (msg_id=%s)",
                 self.session_id, exec_id, msg_id)
        terminalized = False
        try:
            if allow_stdin and self.journal.has_pending_input(exec_id):
                # An input_request is routed to the old client's stdin identity;
                # interrupt is the only bounded, honest recovery policy.
                self.kernel.interrupt()
                self._journal_lifecycle(
                    exec_id, "tithon.input_resolved", {"exec_id": exec_id}
                )
            await self._recovery_probe()
            outputs = self._folds[exec_id].outputs()
            status = "error" if self.journal.has_error(exec_id) else "orphaned"
            folded = json.dumps(outputs)
            finished_at, seq = self.journal.finish_recovered(exec_id, status, folded)
            self._broadcast(event_from_message(
                seq, exec_id, "tithon.done",
                {"status": status, "execution_count": None, "ts": finished_at},
            ))
            log.info("[%s] recovered exec %s terminalized status=%s",
                     self.session_id, exec_id, status)
            terminalized = True
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("[%s] in-flight recovery failed for %s", self.session_id, exec_id)
            if not self.kernel.is_alive():
                self._emit_kernel_dead(exec_id)
                folded = json.dumps(self._folds[exec_id].outputs())
                finished_at, seq = self.journal.finish_recovered(exec_id, "error", folded)
                self._broadcast(event_from_message(
                    seq, exec_id, "tithon.done",
                    {"status": "error", "execution_count": None, "ts": finished_at},
                ))
                terminalized = True
        finally:
            self._msgid_to_exec.pop(msg_id, None)
            self._idle_events.pop(exec_id, None)
            if terminalized:
                self._recovering = False
                self._busy = False
                self.touch()
                # A cell that was in flight across a daemon restart also ends in
                # a shareable state — publish it like any other completion.
                self._publish_sidecar()
                if self._recovery_gate is not None:
                    self._recovery_gate.set()

    # -- kernel message flow ---------------------------------------------------
    async def _iopub_pump(self) -> None:
        while True:
            try:
                msg = await self.kc.iopub_channel.get_msg()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("[%s] iopub recv failed", self.session_id)
                await asyncio.sleep(0.2)
                continue
            try:
                self._handle_iopub(msg)
            except Exception:
                log.exception("[%s] iopub handling failed: %s", self.session_id, msg.get("header"))

    async def _shell_pump(self) -> None:
        """Sole consumer of the shell channel; routes replies by parent msg_id.

        The shell channel is request/reply and MULTIPLEXED: an execute_reply, a
        comm_info_reply and an inspect_reply can all be in flight at once, so one
        owner must demultiplex them. A caller reading the channel itself would
        consume — and discard — every reply but its own, making it impossible to
        ask the kernel anything while a cell is running.

        Note the pump does NOT journal: shell replies are request-scoped answers to
        the daemon's own questions, not session output. What the user must see from
        a reply (`payload`) is journaled by `_emit_reply_payloads` on the awaiting
        side, so the "every message is preserved" invariant stays anchored to the
        iopub stream and live/replay equivalence is unaffected.
        """
        while True:
            try:
                msg = await self.kc.shell_channel.get_msg()
            except asyncio.CancelledError:
                # Teardown (restart/stop): nobody will answer the outstanding
                # requests, so fail them instead of leaving `_run_one` — itself
                # about to be cancelled — blocked on a future that can never
                # resolve. Belt-and-braces: the exec worker is cancelled too.
                self._fail_shell_waiters("shell pump cancelled")
                raise
            except Exception:
                log.exception("[%s] shell recv failed", self.session_id)
                await asyncio.sleep(0.2)
                continue
            try:
                self._route_shell(msg)
            except Exception:
                log.exception("[%s] shell routing failed: %s", self.session_id, msg.get("header"))

    def _route_shell(self, msg: dict) -> None:
        """Hand one shell reply to its awaiter, if any."""
        parent = (msg.get("parent_header") or {}).get("msg_id")
        fut = self._shell_waiters.get(parent)
        if fut is None:
            # No awaiter: a reply to a request nobody is waiting on any more (its
            # caller timed out or was cancelled) — the only reply ever dropped.
            log.debug("[%s] unrouted shell reply parent=%s type=%s",
                      self.session_id, parent, msg["header"]["msg_type"])
            return
        if not fut.done():
            fut.set_result(msg)

    def _expect_shell(self, msg_id: str) -> asyncio.Future:
        """Register interest in the reply to `msg_id` BEFORE it can arrive.

        Must be called with no await between the request that produced `msg_id` and
        this call, so the pump cannot route the reply before the waiter exists.
        The caller owns removal (a `finally` that pops `msg_id`).
        """
        fut = asyncio.get_running_loop().create_future()
        self._shell_waiters[msg_id] = fut
        return fut

    def _fail_shell_waiters(self, reason: str) -> None:
        for msg_id, fut in list(self._shell_waiters.items()):
            if not fut.done():
                fut.set_exception(ConnectionError(reason))
        self._shell_waiters.clear()

    def _handle_iopub(self, msg: dict) -> None:
        msg_type = msg["header"]["msg_type"]
        content = msg.get("content", {})
        if msg_type == "status":
            new_state = content.get("execution_state", self.kernel_status)
            if new_state != self.kernel_status:
                log.debug("[%s] kernel status: %s → %s", self.session_id, self.kernel_status, new_state)
            self.kernel_status = new_state
        parent_id = (msg.get("parent_header") or {}).get("msg_id")
        control = self._control_fences.get(parent_id)
        if control is not None and msg_type == "status":
            # Control traffic is part of the raw IOPub history but never belongs
            # to a cell fold. Signal only after its row is durable.
            seq = self.journal.append_message(None, msg_type, content)
            self._broadcast(event_from_message(seq, None, msg_type, content))
            state = content.get("execution_state")
            if state == "busy":
                control["busy"] = True
            elif state == "idle":
                control["idle"].set()
            return
        exec_id = self._msgid_to_exec.get(parent_id)
        if is_comm(msg_type):
            self._handle_comm(exec_id, msg_type, content, msg.get("buffers") or [])
            return
        if exec_id is None or msg_type not in JOURNALED_IOPUB:
            return
        log.debug("[%s] iopub exec=%s type=%s", self.session_id, exec_id, msg_type)
        artifact_ref = None
        if msg_type in ("display_data", "execute_result", "update_display_data"):
            # Keyed on the EMITTER even for a redirected row: the artifact id is
            # provenance ("who produced these bytes"), while the fold that
            # REFERENCES it — and so decides when GC reclaims it — is resolved
            # separately below.
            refs = self.artifacts.extract(exec_id, content)
            artifact_ref = ",".join(refs) or None
        target = self._display_target(exec_id, msg_type, content)
        seq = self.journal.append_message(
            exec_id, msg_type, content, artifact_ref,
            target_exec=target if target != exec_id else None,
        )
        # Claim ownership only once the creating row is DURABLE, matching the
        # journal-before-mutate order the fold and the widget mirror already keep
        # (RISKS #14). A registry that ran ahead of a failed append would route
        # later updates at an owner no restart can re-derive.
        if msg_type == "display_data":
            self._register_display(exec_id, content)
        fold = self._folds[target]
        before = fold.artifact_ids()
        fold.apply(msg_type, content)
        self._gc_artifacts(before, fold.artifact_ids())
        if target != exec_id:
            # The owner may have FINISHED long ago, so its cached `folded_json` —
            # written once by `mark_done` — would otherwise still show the
            # pre-update content to anyone who read it. Same reason
            # `clear_outputs` re-materializes it.
            self.journal.set_folded(target, json.dumps(fold.outputs()))
        self._broadcast(event_from_message(seq, target, msg_type, content))
        # Completion-barrier signal (see `_await_idle`). Must stay AFTER the journal/
        # fold/broadcast above: `status` is itself in JOURNALED_IOPUB, so releasing
        # `_run_one` earlier would let it persist `folded_json` + `tithon.done` ahead
        # of the idle status's own seq — or release it after a failed append.
        if msg_type == "status" and content.get("execution_state") == "idle":
            ev = self._idle_events.get(exec_id)
            if ev is not None:
                ev.set()

    @staticmethod
    def _display_id_of(content: dict) -> str | None:
        did = (content.get("transient") or {}).get("display_id")
        return did if isinstance(did, str) and did else None

    def _register_display(self, exec_id: str, content: dict) -> None:
        """Record which execution owns a `display_data`'s display_id.

        Only `display_data` registers: `execute_result`'s display_id is carried
        by neither fold, so an update routed at one could never match an item.

        Last creator wins. The Jupyter protocol does not guarantee display_ids
        are unique across executions, so a second cell creating the SAME id takes
        ownership and the first stops receiving updates for it — an accepted
        single-owner limitation, not a case this can resolve: the wire carries no
        way to tell "re-create" from "collision".
        """
        did = self._display_id_of(content)
        if did is not None:
            self._display_registry[did] = exec_id

    def _display_target(self, exec_id: str, msg_type: str, content: dict) -> str:
        """The execution whose fold `msg_type`/`content` belongs to.

        Everything folds into its emitter except an `update_display_data` for a
        display_id another execution created — that one belongs to the creator,
        which is what makes `update_display` reach across cells (RISKS #6). The
        registry is only consulted, never used to invent a target: an unknown id,
        or an owner with no fold left, falls back to the emitter so the update
        still fold-no-ops rather than raising.
        """
        if msg_type != "update_display_data":
            return exec_id
        did = self._display_id_of(content)
        owner = self._display_registry.get(did) if did is not None else None
        return owner if owner is not None and owner in self._folds else exec_id

    def _gc_artifacts(self, before: set[str], after: set[str]) -> None:
        """Adjust the live-reference counter for one fold transition; delete the
        file of any artifact that no fold references anymore."""
        for aid in after - before:
            self._artifact_refs[aid] += 1
        for aid in before - after:
            self._artifact_refs[aid] -= 1
            if self._artifact_refs[aid] <= 0:
                del self._artifact_refs[aid]
                self.artifacts.delete(aid)

    def _handle_comm(self, exec_id, msg_type: str, content: dict, buffers: list) -> None:
        """Feed the Widget State Mirror; journal raw comm (buffers base64).

        Journals BEFORE mutating the mirror (matching `_handle_iopub`'s
        journal-then-fold order): `would_accept` decides acceptance without
        mutating, so a `journal.append_message` failure propagates before
        `apply()` ever runs — the live mirror can never get ahead of what a
        restart's `_rebuild_mirror` would derive from the journal (RISKS #14).
        """
        if not self._mirror.would_accept(msg_type, content):
            return
        stored = content
        if buffers:
            stored = {
                **content,
                "_buffers_b64": [base64.b64encode(bytes(b)).decode("ascii") for b in buffers],
            }
        seq = self.journal.append_message(exec_id, msg_type, stored)
        self._mirror.apply(msg_type, content, buffers)
        # The fold needs comm too, but only to track which Output area claims
        # this execution's msg_id (see `ExecutionFold`) — it produces no output
        # item. `_handle_iopub` returns early for comm, so without this the LIVE
        # fold would never see a claim while `_rebuild_folds` — which replays
        # every journaled row — always would, and a restart would fold the same
        # session differently. A comm with no exec_id (a background thread
        # updating a widget after the barrier popped `_msgid_to_exec`) has no
        # fold to claim against; `_rebuild_folds` skips a NULL-exec_id row for
        # the same reason — so both paths agree by omission.
        fold = self._folds.get(exec_id) if exec_id is not None else None
        if fold is not None:
            fold.apply(msg_type, content)
        # Same builder as the attach-backlog path (ADR-083), so a live and a
        # resuming client get the identical frame for this row — including any
        # `_buffers_b64` on `stored`, which event_from_message forwards when
        # present (RISKS #13). Carrying the comm data is what animates a
        # tqdm.notebook bar live rather than only on reconnect.
        self._broadcast(event_from_message(seq, exec_id, msg_type, stored))

    async def _stdin_pump(self) -> None:
        """Service the kernel's STDIN channel so input()/getpass() works.

        When a cell calls input() (possible only when it was submitted with
        allow_stdin=True), the kernel emits an ``input_request`` here and blocks
        until it receives an ``input_reply``. We surface the prompt to clients as
        a ``tithon.input_request`` event (and ``snapshot.pending_input`` for a
        reconnecting client) and unblock the kernel when a client answers via the
        ``input_reply`` op -> :meth:`send_input`. With no client answering, the
        cell simply waits at the prompt — the user can abandon it with the stop
        button (interrupt), so a missing/closed client never permanently wedges
        the session (the ADR-050 concern). A cell submitted WITHOUT allow_stdin
        never reaches here: the kernel raises StdinNotImplementedError instead."""
        while True:
            try:
                msg = await self.kc.stdin_channel.get_msg()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("[%s] stdin recv failed", self.session_id)
                await asyncio.sleep(0.2)
                continue
            if msg.get("header", {}).get("msg_type") != "input_request":
                continue
            parent = (msg.get("parent_header") or {}).get("msg_id")
            exec_id = self._msgid_to_exec.get(parent)
            content = msg.get("content", {})
            self._pending_input = {
                "exec_id": exec_id,
                "prompt": content.get("prompt", ""),
                "password": bool(content.get("password", False)),
            }
            self._journal_lifecycle(exec_id, "tithon.input_request", dict(self._pending_input))
            log.info("[%s] input_request exec=%s password=%s",
                     self.session_id, exec_id, self._pending_input["password"])

    def send_input(self, value: str) -> bool:
        """Answer a pending input()/getpass() prompt (client `input_reply` op).

        Sends ``input_reply`` on the kernel's stdin channel so the blocked
        input() returns ``value`` and the cell continues. No-op (returns False)
        when no prompt is pending."""
        if self._pending_input is None:
            return False
        exec_id = self._pending_input.get("exec_id")
        try:
            self.kc.input(value)
        except Exception:  # pragma: no cover - defensive
            log.exception("[%s] failed to send input_reply", self.session_id)
            return False
        self._pending_input = None
        self._journal_lifecycle(exec_id, "tithon.input_resolved", {"exec_id": exec_id})
        log.info("[%s] input_reply sent exec=%s", self.session_id, exec_id)
        return True

    def _clear_pending_input(self, exec_id: str | None) -> None:
        """Drop a pending prompt that belongs to a finishing/aborted exec (e.g. it
        was interrupted while waiting on input) and tell clients to dismiss it."""
        if self._pending_input is None:
            return
        if exec_id is None or self._pending_input.get("exec_id") == exec_id:
            stale = self._pending_input.get("exec_id")
            self._pending_input = None
            self._journal_lifecycle(stale, "tithon.input_resolved", {"exec_id": stale})

    async def _exec_worker(self) -> None:
        if self._recovery_gate is not None:
            await self._recovery_gate.wait()
        while True:
            batch, stop_on_error, allow_stdin = await self._queue.get()
            self._busy = True  # batch in flight: the idle-GC must not reap us
            # A batch is one user action (a single cell, or a "Run All" / multi-cell
            # run). For a Run-All, native Jupyter STOPS at the first cell that
            # raises and skips the rest; we honor that here, in the daemon, so it
            # holds even if the client disconnects mid-run (the persistence premise).
            # Processing the batch as one queue item makes "which cells belong to
            # this run" unambiguous — no run-id bookkeeping, no skip-the-wrong-cell
            # race with cells of a later, independent run.
            skip_rest = False
            try:
                for exec_id, code in batch:
                    if skip_rest:
                        self._mark_skipped(exec_id)
                        continue
                    status = await self._run_one(exec_id, code, allow_stdin)
                    if status != "ok" and stop_on_error:
                        skip_rest = True
            except asyncio.CancelledError:
                raise  # restart/stop: the task is meant to die here
            except Exception:
                # This worker is the SOLE consumer of the queue. Letting an
                # unexpected error escape would kill it, wedging every cell queued
                # afterwards, AND leave `_busy` set so idle-GC could never reap the
                # session either. The shell router adds new failure paths into
                # `_run_one`, which makes the containment worth having explicitly.
                log.exception("[%s] exec batch failed", self.session_id)
            finally:
                self._busy = False
                self.touch()  # the idle clock starts when the batch finishes
                # Once per USER ACTION, not once per cell. Publishing rebuilds
                # every execution's fold, so a per-cell write makes a Run-All
                # quadratic in the notebook's length. The file is a projection of
                # a journal that already holds everything, so it is free to lag a
                # running batch — and a daemon that dies mid-batch republishes
                # when `_recover_inflight` terminalizes the cell it was on.
                self._publish_sidecar()

    async def _run_one(self, exec_id: str, code: str, allow_stdin: bool = False) -> str:
        """Execute one cell on the kernel; journal its lifecycle; return the
        kernel's reply status ("ok"/"error").

        ``allow_stdin`` gates input()/getpass()/breakpoint()/pdb; when False the
        kernel raises StdinNotImplementedError at once instead (see
        :meth:`_stdin_pump`)."""
        # A kernel that already died (a previous cell crashed it) can't run this
        # cell — fail fast instead of executing into the void and timing out.
        if not self.kernel.is_alive():
            started_at = self.journal.mark_started(exec_id)
            self._journal_lifecycle(exec_id, "tithon.started", {"ts": started_at})
            self._emit_kernel_dead(exec_id)
            status, ec = "error", None
        else:
            msg_id = self.kc.execute(code, allow_stdin=allow_stdin)
            # Persist the parent id before yielding. Recovery still requires the
            # kernel's old-parent busy row, so a frame merely buffered in this
            # dying client can never be mistaken for accepted work.
            started_at = self.journal.mark_started(exec_id, msg_id)
            self._journal_lifecycle(
                exec_id, "tithon.started", {"ts": started_at, "kernel_msg_id": msg_id}
            )
            # Register BOTH awaiters with no await in between, so neither pump can
            # deliver this execution's terminator before anyone is listening.
            self._msgid_to_exec[msg_id] = exec_id
            idle = self._idle_events.setdefault(exec_id, asyncio.Event())
            fut = self._expect_shell(msg_id)
            log.info("[%s] exec %s started (msg_id=%s)", self.session_id, exec_id, msg_id)
            try:
                status, ec = await self._await_reply(fut, exec_id)
                # The completion barrier (see `_await_idle`): `execute_reply`
                # routinely beats this execution's last iopub, and persisting the
                # fold below before that iopub lands would hand a reconnecting
                # client a snapshot missing output a live client already saw.
                await self._await_idle(exec_id, idle)
            finally:
                self._shell_waiters.pop(msg_id, None)
                self._idle_events.pop(exec_id, None)
                # Only NOW is the parent→exec mapping dead: dropping it earlier
                # discards trailing iopub, never dropping it leaks one entry per cell.
                self._msgid_to_exec.pop(msg_id, None)
        # If the cell ended while still blocked at a prompt (interrupted, or the
        # kernel aborted input), drop the stale prompt so the client dismisses it.
        self._clear_pending_input(exec_id)
        folded = json.dumps(self._folds[exec_id].outputs())
        finished_at = self.journal.mark_done(
            exec_id, "done" if status == "ok" else "error", ec, folded
        )
        self._journal_lifecycle(
            exec_id,
            "tithon.done",
            {"status": status, "execution_count": ec, "ts": finished_at},
        )
        log.info("[%s] exec %s done status=%s", self.session_id, exec_id, status)
        return status

    async def _await_reply(self, fut: asyncio.Future, exec_id: str) -> tuple[str, int | None]:
        """Wait for this cell's routed ``execute_reply``, watching for kernel death.

        The reply is delivered by :meth:`_shell_pump`, which already matched it on
        ``parent_header.msg_id``.

        Polls with a timeout so that if the kernel dies mid-run (crash / OOM-kill /
        ``os._exit``) — in which case no reply is ever sent — we detect it and
        surface an error instead of blocking the exec worker (and every queued cell)
        forever. Returns ``(status, execution_count)``.
        """
        while True:
            try:
                # `shield` so the poll timeout cancels only this wait, never the
                # future the pump is still going to resolve.
                reply = await asyncio.wait_for(asyncio.shield(fut), KERNEL_REPLY_POLL)
            except (asyncio.TimeoutError, TimeoutError):
                if not self.kernel.is_alive():
                    self._emit_kernel_dead(exec_id)
                    return "error", None
                continue  # still running, just slow — keep waiting
            except ConnectionError:
                # Channels torn down under us (restart/stop). The exec worker is
                # being cancelled too; fail this cell rather than wait forever.
                log.info("[%s] exec %s: shell channel closed before reply",
                         self.session_id, exec_id)
                return "error", None
            content = reply["content"]
            self._emit_reply_payloads(exec_id, content.get("payload") or [])
            return content.get("status", "ok"), content.get("execution_count")

    async def _await_idle(self, exec_id: str, idle: asyncio.Event) -> None:
        """Block until the kernel publishes ``status: idle`` for this execution.

        The Jupyter messaging protocol has a kernel publish ``status: busy`` before
        it begins handling a request and ``status: idle`` once it has finished — and
        ipykernel emits that ``idle`` after every other iopub message the execution
        produced. ``idle`` is therefore the execution's terminator, and waiting on it
        is what makes the fold we persist provably complete instead of probably
        complete.

        The wait is bounded, but the bound is a FALLBACK, not the mechanism: a kernel
        SIGKILLed between its reply and its idle never publishes one, and the exec
        worker is serial, so an unbounded wait would wedge every queued cell behind a
        dead kernel. The liveness poll normally returns long before the timeout.
        """
        waited = 0.0
        while True:
            try:
                await asyncio.wait_for(idle.wait(), KERNEL_REPLY_POLL)
                return
            except (asyncio.TimeoutError, TimeoutError):
                if not self.kernel.is_alive():
                    log.warning("[%s] exec %s: kernel died before publishing idle",
                                self.session_id, exec_id)
                    return
                waited += KERNEL_REPLY_POLL
                if waited >= IDLE_BARRIER_TIMEOUT:
                    log.warning(
                        "[%s] exec %s: no iopub idle within %.0fs — persisting the "
                        "fold anyway (output may be incomplete)",
                        self.session_id, exec_id, IDLE_BARRIER_TIMEOUT,
                    )
                    return

    def _emit_reply_payloads(self, exec_id: str, payloads: list) -> None:
        """Surface ``execute_reply.payload`` text as stdout stream output.

        IPython does NOT publish the ``?``/``??`` help pager on iopub — it rides
        the SHELL reply's ``payload`` list. Reading only ``status`` and
        ``execution_count`` therefore makes ``obj?``, the first idiom an IPython
        user types, produce nothing at all: no output, no error, a silent hole.
        Any payload carrying ``text/plain`` becomes a ``stream`` message journaled
        + folded + broadcast like real output, so it survives reconnect and shows
        up in the snapshot (vscode-jupyter's ``handleExecuteReply`` does the same,
        also as a stream so ANSI in the pager text still renders).

        ``set_next_input`` (``%load``, ``%recall``) is deliberately NOT acted on:
        inserting or replacing a cell needs the notebook's cell structure, which
        belongs to the client. Doing it here would put cell layout knowledge in
        the daemon — a separate ADR, not a few lines in the reply path.
        """
        fold = self._folds.get(exec_id)
        if fold is None:
            return  # cleared/orphaned execution: do not resurrect an output
        for p in payloads:
            # The payload list is kernel-controlled: a malformed entry must be
            # skipped, not allowed to kill the exec worker and wedge the queue.
            if not isinstance(p, dict):
                continue
            data = p.get("data")
            text = data.get("text/plain") if isinstance(data, dict) else None
            if not text:
                continue
            content = {"name": "stdout", "text": str(text), SCOPE_KEY: SCOPE_CELL}
            seq = self.journal.append_message(exec_id, "stream", content)
            fold.apply("stream", content)
            self._broadcast(event_from_message(seq, exec_id, "stream", content))

    def _emit_kernel_dead(self, exec_id: str) -> None:
        """Journal + broadcast a synthetic error for a cell whose kernel died, so
        the cell stops spinning and shows why. ``mark_done`` is left to the
        caller (shared with the normal path). Marks the kernel status ``dead``."""
        self.kernel_status = "dead"
        content = {
            SCOPE_KEY: SCOPE_CELL,
            "ename": "KernelDied",
            "evalue": "the kernel died during execution (crash, OOM-kill, or os._exit)",
            "traceback": [
                "KernelDied: the kernel process exited during execution.",
                "Restart the kernel (Tithon: Restart Kernel) to continue.",
            ],
        }
        seq = self.journal.append_message(exec_id, "error", content)
        self._folds[exec_id].apply("error", content)
        self._broadcast(event_from_message(seq, exec_id, "error", content))
        log.warning("[%s] kernel died during exec %s (pid=%s)",
                    self.session_id, exec_id, self.kernel.pid)

    def _mark_skipped(self, exec_id: str) -> None:
        """Terminate a queued cell that a Run-All skipped after an earlier error.
        It never runs, but must reach a TERMINAL status (not linger as 'queued',
        which a fresh attach would restore as a pending clock and orphan_inflight
        would later flip to 'orphaned'). The client renders 'skipped' as a blank,
        un-run cell."""
        finished_at = self.journal.mark_done(exec_id, "skipped", None, "[]")
        self._journal_lifecycle(
            exec_id,
            "tithon.done",
            {"status": "skipped", "execution_count": None, "ts": finished_at},
        )
        log.info("[%s] exec %s skipped (run stopped on an earlier error)",
                 self.session_id, exec_id)

    def _drain_queue(self) -> int:
        """Drop every batch still waiting in the exec queue; return the count.

        Used on kernel restart: the waiting batches' executions are already
        journaled 'queued' (and flipped to 'orphaned' by orphan_inflight), so the
        fresh worker must NOT pick them up and run pre-restart cells on the new
        kernel. The currently-running cell's remaining batch lives in the worker
        coroutine's local list (lost when its task is cancelled), not here."""
        dropped = 0
        while True:
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            dropped += 1
        return dropped

    # -- protocol helpers ------------------------------------------------------
    def _journal_lifecycle(self, exec_id, msg_type: str, payload: dict) -> None:
        seq = self.journal.append_message(exec_id, msg_type, payload)
        self._broadcast(event_from_message(seq, exec_id, msg_type, payload))

    def _broadcast(self, event: dict) -> None:
        for sub in self._subs:
            if sub.dropped:
                continue
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:
                # Slow client: cap memory by dropping it (it can reconnect).
                sub.dropped = True
                log.warning(
                    "[%s] subscriber overflow (>%d queued) — dropping client",
                    self.session_id, SUB_QUEUE_MAX,
                )

    def submit(self, code: str, submitted_by: str | None = None,
               origin: dict | None = None, allow_stdin: bool = False) -> str:
        """Submit one cell (CLI / single play). A one-cell batch has nothing to
        stop, so stop_on_error is moot."""
        return self.submit_batch(
            [{"code": code, "origin": origin}], submitted_by,
            stop_on_error=False, allow_stdin=allow_stdin,
        )[0]

    def submit_batch(self, cells: list[dict], submitted_by: str | None = None,
                     stop_on_error: bool = False, allow_stdin: bool = False) -> list[str]:
        """Submit a batch of cells as ONE queue item (one user action). When
        ``stop_on_error`` and a cell raises, the worker skips the remaining cells
        of this batch (native "Run All" semantics — see _exec_worker).
        ``allow_stdin`` (per user action) enables the input()/getpass() bridge:
        a client that can present an input box opts in, CLI/default stays off."""
        # Running a cell re-opens a session the user had closed: from here on
        # its output is current again, so restore-on-open is armed once more.
        self.set_closed_by_user(False)
        batch: list[tuple[str, str]] = []
        exec_ids: list[str] = []
        for cell in cells:
            code = cell.get("code", "")
            origin = cell.get("origin")
            self._exec_counter += 1
            exec_id = f"e{self._exec_counter}"
            # cell_hash is computed daemon-side from the submitted code (authoritative,
            # matches the extension's sha256(code)) so output<->cell attachment works
            # even for CLI runs that send no origin (SPEC.md).
            cell_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()
            self.journal.insert_execution(
                exec_id, self._exec_counter, code, submitted_by, origin, cell_hash,
                allow_stdin=allow_stdin,
            )
            self._folds[exec_id] = ExecutionFold()
            # The queued event carries the origin so a live client can map this
            # execution to the right cell by index — not by code hash, which is
            # ambiguous when two cells hold identical code (duplicate-cell bug).
            self._journal_lifecycle(exec_id, "tithon.queued", {"code": code, "origin": origin})
            batch.append((exec_id, code))
            exec_ids.append(exec_id)
        self._queue.put_nowait((batch, stop_on_error, allow_stdin))
        self.touch()
        return exec_ids

    def _execution_snapshots(self) -> list[dict]:
        """Every execution in the shape clients and the sidecar both consume.

        ONE builder: the shared sidecar is written from these exact dicts, so a
        cell restored from a cloned snapshot and the same cell restored over the
        socket cannot disagree about what the output was.
        """
        execs = []
        for (exec_id, seq, code, status, execution_count, folded_json,
             cell_origin_uri, cell_range, cell_hash, cell_index,
             started_at, finished_at) in self.journal.executions():
            fold = self._folds.get(exec_id)
            # `fold_state` rides beside `outputs` so a client can CONTINUE folding
            # this execution the way the daemon does (see `fold_state`). Only a
            # live fold has it; an execution restored from `folded_json` alone is
            # finished, so there is nothing left to continue.
            fold_state = None
            if fold is not None:
                outputs = fold.outputs()
                # An imported execution ran on someone else's machine and is
                # terminal by construction, so there is nothing left to continue
                # and its hydrated fold has no real area ownership to advertise.
                if exec_id not in self._imported:
                    fold_state = fold.fold_state()
            else:
                outputs = json.loads(folded_json) if folded_json else []
            origin = None
            if cell_origin_uri is not None or cell_range is not None or cell_index is not None:
                origin = {
                    "uri": cell_origin_uri,
                    "range": json.loads(cell_range) if cell_range else None,
                    "index": cell_index,
                }
            execs.append(
                {
                    "exec_id": exec_id,
                    "seq": seq,
                    "code": code,
                    "status": status,
                    "execution_count": execution_count,
                    "cell_hash": cell_hash,
                    "origin": origin,
                    "outputs": outputs,
                    "fold_state": fold_state,
                    "started_at": started_at,
                    "finished_at": finished_at,
                }
            )
        return execs

    def snapshot(self) -> dict:
        return {
            "session": self.session_id,
            "max_seq": self.journal.max_seq(),
            "kernel": {
                "status": self.kernel_status,
                "pid": self.kernel.pid,
                "python": self.kernel_pyversion,
                # Outputs restored but every variable gone (host reboot / idle-GC
                # reap); the client warns the user, de-duping on `generation`.
                "lost_state": self.kernel_lost_state,
                "reattached": self.kernel.reattached,
                "generation": self.kernel_generation,
            },
            "queue_len": self._queue.qsize(),
            "executions": self._execution_snapshots(),
            # The user closed this session on purpose, so its history is history:
            # a client restores nothing until asked (see `closed_by_user`).
            "closed_by_user": self.closed_by_user,
            "widgets": self._mirror.snapshot(),
            # A cell blocked on input()/getpass() at attach time, so a reconnecting
            # client re-presents the prompt (None when nothing is waiting).
            "pending_input": self._pending_input,
        }

    def status(self) -> dict:
        return {
            "session": self.session_id,
            "kernel_pid": self.kernel.pid,
            "kernel_status": self.kernel_status,
            "kernel_python": self.kernel_pyversion,
            "kernel_reattached": self.kernel.reattached,
            "kernel_lost_state": self.kernel_lost_state,
            "kernel_generation": self.kernel_generation,
            "queue_len": self._queue.qsize(),
            "max_seq": self.journal.max_seq(),
            "executions": len(self.journal.executions()),
            "widget_models": len(self._mirror),
            # Lifetime info for `tithon status` and the extension's kernel picker:
            # who is watching, and how long since this kernel last did anything.
            "clients": len(self._subs),
            "idle_seconds": round(self.idle_seconds(), 1),
        }

    def read_artifact(self, artifact_id: str) -> dict:
        """Return a rich-output artifact's bytes (base64) by id.

        Images are stored as files on disk (SPEC.md) and journaled only
        as ``$tithon_artifact`` references, so a client renders them by fetching
        the bytes on demand over the same unix socket (no base64 in the journal,
        no shared-filesystem assumption). Deduped by sha, so each unique image is
        fetched at most once per client.
        """
        row = self.journal.find_artifact(artifact_id)
        if row is None:
            return {"artifact_id": artifact_id, "found": False}
        _, _, mime, rel_path, _ = row
        try:
            raw = (self.artifacts.workdir / rel_path).read_bytes()
        except OSError:
            return {"artifact_id": artifact_id, "found": False}
        return {
            "artifact_id": artifact_id,
            "mime": mime,
            "data_b64": base64.b64encode(raw).decode("ascii"),
            "found": True,
        }

    async def sub_pump(self, ws, sub: Subscriber, cutoff: int) -> None:
        while True:
            try:
                event = await asyncio.wait_for(sub.queue.get(), SUB_POLL)
            except (asyncio.TimeoutError, TimeoutError):
                if sub.dropped:
                    return await _notify_overflow(ws)
                continue
            if sub.dropped:
                return await _notify_overflow(ws)
            if event.get("seq", 0) <= cutoff:
                continue  # already covered by snapshot/delta replay
            try:
                await asyncio.wait_for(ws.send(json.dumps(event)), SEND_TIMEOUT)
            except (asyncio.TimeoutError, TimeoutError):
                # Client stalled accepting data: drop it (host stays healthy).
                sub.dropped = True
                log.warning("[%s] subscriber send stalled >%.0fs — dropping client",
                            self.session_id, SEND_TIMEOUT)
                return await _notify_overflow(ws)


async def _notify_overflow(ws) -> None:
    """Best-effort: tell the client to reconnect+resync, then close."""
    try:
        await asyncio.wait_for(ws.send(json.dumps({"op": "overflow"})), 2.0)
    except Exception:
        pass
    try:
        await ws.close()
    except Exception:
        pass


class Daemon:
    """Owns the unix socket server and a lazily-populated dict of sessions."""

    def __init__(self, home: Path, workdir: Path, idle_timeout: float | None = None):
        self.home = home
        self.workdir = workdir
        self.sock_path = home / "daemon.sock"
        self.pid_file = home / "daemon.pid"
        # Kernel lifetime policy: reap a session idle longer than this (seconds);
        # <=0 disables. Constructor arg (CLI --idle-timeout) wins over the env.
        self.idle_timeout = KERNEL_IDLE_TIMEOUT if idle_timeout is None else idle_timeout
        self._sessions: dict[str, Session] = {}
        self._sessions_lock = asyncio.Lock()
        self._stop = asyncio.Event()
        self._kill_kernels_on_stop = False  # set by an explicit kill shutdown

    # -- lifecycle -----------------------------------------------------------
    def _preflight(self) -> None:
        try:
            pid = int(self.pid_file.read_text().strip())
            os.kill(pid, 0)
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().decode()
            if "tithon" in cmdline:
                raise SystemExit(f"tithon daemon already running (pid {pid})")
        except (OSError, ValueError):
            pass  # stale or absent pid file
        self.sock_path.unlink(missing_ok=True)

    async def _get_session(self, session_id: str, workdir_hint: str | None = None) -> Session:
        """Return the session for this id, creating + starting it on first use.

        ``workdir_hint`` (the client's project root) is used only when the
        session is first created — it fixes the session's storage layout and
        artifact root (see ``_session_layout``); later ops on an existing session
        ignore it (the kernel/journal are already placed).
        """
        async with self._sessions_lock:
            s = self._sessions.get(session_id)
            if s is None:
                session_dir, workdir = _session_layout(
                    self.home, session_id, workdir_hint, self.workdir
                )
                s = Session(session_id, session_dir, workdir)
                await s.start()
                self._sessions[session_id] = s
            return s

    async def run(self) -> None:
        self._preflight()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._stop.set)
        # write_limit caps each connection's send buffer so a slow client makes
        # ws.send apply backpressure instead of growing daemon memory unbounded.
        async with unix_serve(
            self._handler, path=str(self.sock_path), write_limit=WRITE_BUFFER_HIGH
        ):
            os.chmod(self.sock_path, 0o600)
            self.pid_file.write_text(str(os.getpid()))
            log.info("daemon ready pid=%d sock=%s (sessions are per-file, lazy)",
                     os.getpid(), self.sock_path)
            bg: list[asyncio.Task] = []
            if self.idle_timeout > 0:
                bg.append(asyncio.create_task(self._gc_loop(), name="idle-gc"))
                log.info("idle-GC on: timeout=%.0fs poll=%.0fs", self.idle_timeout, GC_POLL)
            # NOT gated on idle_timeout: the watchdog is the only observer of a
            # kernel that dies while idle, and idle-GC is off by default.
            if KERNEL_WATCHDOG_POLL > 0:
                bg.append(asyncio.create_task(self._liveness_loop(), name="kernel-watchdog"))
                log.info("kernel liveness watchdog on: poll=%.0fs", KERNEL_WATCHDOG_POLL)
            try:
                await self._stop.wait()
            finally:
                for t in bg:
                    t.cancel()
                for t in bg:
                    try:
                        await t
                    except asyncio.CancelledError:
                        pass
        for s in list(self._sessions.values()):
            if self._kill_kernels_on_stop:
                # An explicit kill-kernels shutdown (the extension does this to
                # apply a new interpreter): `deliberate` so the next
                # `Session.start()` reports a requested reset, not a lost one.
                try:
                    s._journal_lifecycle(
                        None, "tithon.kernel",
                        {"status": "shutdown", "deliberate": True},
                    )
                except Exception:  # pragma: no cover - defensive
                    log.exception("[%s] shutdown lifecycle journal failed", s.session_id)
            await s.stop(kill_kernel=self._kill_kernels_on_stop)
        self.pid_file.unlink(missing_ok=True)
        self.sock_path.unlink(missing_ok=True)
        log.info("daemon stopped")

    def _global_status(self) -> dict:
        return {
            "op": "status_reply",
            "daemon_pid": os.getpid(),
            "sessions": [s.status() for s in self._sessions.values()],
        }

    async def _kill_session(self, session_id: str | None) -> bool:
        """Terminate a session's kernel and drop it from the manager.

        Pops the session under the lock so a concurrent op can't reuse a
        half-stopped session, tells any attached client the kernel is gone (a
        ``tithon.kernel`` ``killed`` event so spinners clear), then stops the
        session and kills its kernel. The journal/session dir stay on disk, so
        reopening the file re-creates the session lazily with a fresh kernel —
        but NOT with its cells re-seeded, because this is the user deliberately
        ending the session (`set_closed_by_user`). Returns False if no such
        live session.

        The idle-GC reap must never come through here: it kills a kernel the
        user did not ask about, so it keeps its own sweep (`_gc_sweep`) and
        leaves restore-on-open armed.
        """
        if not session_id:
            return False
        async with self._sessions_lock:
            s = self._sessions.get(session_id)
        if s is None:
            return False
        # Acquire the session's OWN restart lock before removing it from the
        # manager — not after. Popping first (an earlier version of this fix)
        # left a window, bounded by however long a CONCURRENT restart_kernel()
        # holds this lock (up to its 120s kernel-ready wait), where the id was
        # absent from `_sessions` while `s` was still alive and un-killed;
        # `_get_session()` during that window found nothing and spawned a
        # SECOND Session on the same session_dir/journal/kernel files
        # (duplicate pumps, exec_id collisions). Holding the lock FIRST makes
        # "marked `_killed`" and "removed from the manager" atomic from
        # `_get_session()`'s perspective — the id stays visible (and bindable,
        # a pre-existing tolerated race — see `_killed`'s docstring) right up
        # until the moment it is marked killed and popped in the same breath.
        async with s._restart_lock:
            if s._killed:
                return True  # a concurrent kill/GC already finished this one
            s._killed = True
            async with self._sessions_lock:
                # Only remove if we're still the current object for this id —
                # a concurrent GC sweep could have already popped+replaced it
                # while this call was waiting for the lock.
                if self._sessions.get(session_id) is s:
                    self._sessions.pop(session_id)
            try:
                s.set_closed_by_user(True)
                # `deliberate` so reopening the file later does not warn about a loss.
                s._journal_lifecycle(
                    None, "tithon.kernel", {"status": "killed", "deliberate": True})
            except Exception:  # pragma: no cover - defensive
                log.exception("[%s] kill lifecycle broadcast failed", session_id)
            await s.stop(kill_kernel=True)
        log.info("killed kernel for session %s (pid=%s)", session_id, s.kernel.pid)
        return True

    async def _gc_loop(self) -> None:
        """Kernel lifetime policy: periodically reap idle sessions.

        Only sessions this daemon has LOADED are considered — a detached kernel
        from before a daemon restart is invisible until its file is next touched
        (lazy re-attach), at which point its idle clock starts fresh. Reaping is
        conservative (see ``Session.gc_eligible``): surprise-killing a training
        run is worse than leaking a kernel.
        """
        while True:
            await asyncio.sleep(GC_POLL)
            try:
                await self._gc_sweep()
            except Exception:  # pragma: no cover - the sweep must never die
                log.exception("idle-GC sweep failed")

    async def _liveness_loop(self) -> None:
        """Kernel liveness watchdog: notice a kernel that died out-of-band.

        Runs for the daemon's whole lifetime regardless of ``idle_timeout``
        (see ``KERNEL_WATCHDOG_POLL``).
        """
        while True:
            await asyncio.sleep(KERNEL_WATCHDOG_POLL)
            try:
                self._liveness_sweep()
            except Exception:  # pragma: no cover - the watchdog must never die
                log.exception("kernel liveness sweep failed")

    def _liveness_sweep(self) -> None:
        """One watchdog pass over the loaded sessions (factored out for tests).

        Each session is isolated: a ``/proc`` read failing for one file must not
        stop the watchdog from reporting every other file's dead kernel.
        """
        for sid, s in list(self._sessions.items()):
            try:
                s.check_kernel_liveness()
            except Exception:  # pragma: no cover - defensive
                log.exception("[%s] liveness check failed", sid)

    async def _gc_sweep(self) -> None:
        """One idle-GC pass over the loaded sessions (factored out for tests)."""
        for sid, s in list(self._sessions.items()):
            if not s.gc_eligible(self.idle_timeout):
                continue
            # Lock ordering matches `_kill_session` (see its comment): acquire
            # the session's OWN restart lock BEFORE removing it from the
            # manager, not after, so the id is never absent from `_sessions`
            # while `s` is still alive and un-killed.
            async with s._restart_lock:
                if s._killed:
                    continue  # already reaped/killed by a concurrent pass
                # Re-check eligibility now that the lock is actually held: an
                # attach/execute (or a restart that just finished) may have
                # landed while this call waited for it.
                if not s.gc_eligible(self.idle_timeout):
                    continue
                idle = int(s.idle_seconds())
                s._killed = True
                async with self._sessions_lock:
                    if self._sessions.get(sid) is s:
                        self._sessions.pop(sid)
                # Journal the reap so the next client to open this file can see the
                # kernel was reclaimed (delta replay), mirroring the "killed" event.
                try:
                    s._journal_lifecycle(
                        None, "tithon.kernel", {"status": "gc", "idle_seconds": idle}
                    )
                except Exception:  # pragma: no cover - defensive
                    log.exception("[%s] gc lifecycle journal failed", sid)
                await s.stop(kill_kernel=True)
            log.info(
                "idle-GC reaped session %s (kernel pid=%s, idle %ds; journal kept)",
                sid, s.kernel.pid, idle,
            )

    async def _handler(self, ws) -> None:
        session: Session | None = None
        sub: Subscriber | None = None
        pump: asyncio.Task | None = None
        log.info("client connected")
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                op = msg.get("op")
                # Global status (no session): list every live session.
                if op == "status" and "session" not in msg:
                    await ws.send(json.dumps(self._global_status()))
                    continue
                # Shutdown the whole daemon (daemon-wide; used to relaunch under a
                # different Python interpreter). Stops every session's kernel.
                if op == "shutdown":
                    self._kill_kernels_on_stop = bool(msg.get("kill_kernels", False))
                    await ws.send(json.dumps({"op": "shutting_down"}))
                    log.info("shutdown requested (kill_kernels=%s)", self._kill_kernels_on_stop)
                    self._stop.set()
                    return
                # Terminate ONE session's kernel by id (frees host/GPU resources).
                # Global op (no session bind) so a client can kill any file's
                # kernel, including one it isn't attached to. The session is
                # dropped; reopening that file later restores its output history
                # under a fresh kernel.
                if op == "kill_kernel":
                    target = msg.get("target")
                    ok = await self._kill_session(target)
                    await ws.send(json.dumps(
                        {"op": "kernel_killed", "ok": ok, "session": target}))
                    continue
                # The stop button. Answered HERE — above the session bind — because
                # `_get_session()` holds `_sessions_lock` across a kernel spawn, so
                # binding first would make an interrupt for an already-running file
                # wait out an unrelated file's startup. The lookup takes no lock (a
                # dict read with no await is atomic under asyncio) and creates
                # nothing: a session that does not exist has no cell to stop, and
                # spawning a kernel just to signal it would be the delay this op
                # exists to avoid. A killed session is skipped — its pid may already
                # belong to someone else.
                if op == "interrupt":
                    sid = msg.get("session", DEFAULT_SESSION)
                    target_s = self._sessions.get(sid)
                    if target_s is not None and not target_s._killed:
                        target_s.touch()  # a stop press is activity: hold idle-GC off
                        ok = target_s.interrupt()
                    else:
                        ok = False
                    log.info("[%s] interrupt ok=%s", sid, ok)
                    await ws.send(json.dumps({"op": "interrupted", "ok": ok}))
                    continue
                # A connection is bound to one session, fixed on the first op.
                # The first op may carry the client's project root (`workdir`) so
                # a freshly-created session roots its artifacts/kernel there.
                if session is None:
                    try:
                        session = await self._get_session(
                            msg.get("session", DEFAULT_SESSION), msg.get("workdir")
                        )
                    except Exception as e:
                        # Session creation failed (e.g. the kernel exited during
                        # startup — ADR-059). Tell the client WHY before closing,
                        # so VSCode can show the actionable reason instead of a
                        # generic "connection closed".
                        log.exception("[%s] session start failed", msg.get("session"))
                        try:
                            await ws.send(json.dumps({"op": "error", "message": str(e)}))
                        except Exception:
                            pass
                        return
                session.touch()  # any client op resets the idle-GC clock

                if op == "attach":
                    if sub is None:
                        sub = Subscriber(asyncio.Queue(maxsize=SUB_QUEUE_MAX))
                        session._subs.add(sub)  # buffer live events from this instant
                        try:
                            s = ws.transport.get_extra_info("socket")
                            if s is not None:
                                s.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, SOCK_SNDBUF)
                        except Exception:  # pragma: no cover - transport may vary
                            pass
                    last = int(msg.get("last_seen_seq", 0))
                    # NOTE: no await between subscribing and computing the
                    # backlog/cutoff — atomicity within the event loop is what
                    # makes snapshot+delta gapless.
                    if last == 0:
                        backlog = [{"op": "snapshot", **session.snapshot()}]
                        cutoff = backlog[0]["max_seq"]
                    elif last < 0:  # live-only attach
                        backlog = []
                        cutoff = session.journal.max_seq()
                    else:
                        rows = session.journal.messages_after(last)
                        backlog = [
                            event_from_message(s2, e, t, json.loads(c)) for s2, e, t, c in rows
                        ]
                        cutoff = rows[-1][0] if rows else last
                    for item in backlog:
                        await ws.send(json.dumps(item))
                    await ws.send(json.dumps({"op": "sync", "seq": cutoff}))
                    if pump is None:
                        pump = asyncio.create_task(session.sub_pump(ws, sub, cutoff))
                    log.info(
                        "[%s] client attached last_seen_seq=%d cutoff=%d backlog=%d",
                        session.session_id, last, cutoff, len(backlog),
                    )
                elif op == "execute":
                    code = msg.get("code", "")
                    preview = code[:80].replace("\n", "↵")
                    exec_id = session.submit(
                        code, msg.get("submitted_by"), msg.get("origin"),
                        allow_stdin=bool(msg.get("allow_stdin", False)),
                    )
                    log.info("[%s] execute queued exec_id=%s queue_len=%d code=%r",
                             session.session_id, exec_id, session._queue.qsize(), preview)
                    await ws.send(json.dumps({"op": "execute_ack", "exec_id": exec_id}))
                elif op == "execute_batch":
                    cells = msg.get("cells", [])
                    stop_on_error = bool(msg.get("stop_on_error", True))
                    exec_ids = session.submit_batch(
                        cells, msg.get("submitted_by"), stop_on_error,
                        allow_stdin=bool(msg.get("allow_stdin", False)),
                    )
                    log.info("[%s] execute_batch queued %d cells stop_on_error=%s queue_len=%d",
                             session.session_id, len(exec_ids), stop_on_error,
                             session._queue.qsize())
                    await ws.send(json.dumps({"op": "execute_ack", "exec_ids": exec_ids}))
                elif op == "input_reply":
                    # Answer a pending input()/getpass() prompt. Sent over the live
                    # attach connection (fire-and-forget); ack so a caller can await.
                    ok = session.send_input(str(msg.get("value", "")))
                    await ws.send(json.dumps({"op": "input_ack", "ok": ok}))
                elif op == "clear_output":
                    # User cleared cell output(s): persist it so a resync does not
                    # restore them. `all` clears every execution; else `exec_ids`.
                    if msg.get("all"):
                        n = session.clear_outputs(None)
                    else:
                        n = session.clear_outputs(msg.get("exec_ids") or [])
                    await ws.send(json.dumps({"op": "cleared", "count": n}))
                elif op == "restart_kernel":
                    try:
                        pid = await session.restart_kernel()
                    except SessionKilledError:
                        # Lost the race against a concurrent kill_kernel/idle-GC —
                        # see Session._killed. `session` stays bound to this now-
                        # stopped Session for the rest of the connection (bound
                        # once above, never re-resolved), so any FURTHER op sent
                        # here would queue against a worker that no longer exists
                        # (Codex ② caught this) — end the connection like the
                        # session-creation-failure path above does, not `continue`.
                        await ws.send(json.dumps(
                            {"op": "error", "message": "session was killed"}))
                        return
                    await ws.send(json.dumps({"op": "kernel_restarted", "kernel_pid": pid}))
                elif op == "get_artifact":
                    art = session.read_artifact(msg.get("artifact_id", ""))
                    reply = {"op": "artifact", **art}
                    # Echo the request id so a client can multiplex many fetches
                    # over ONE long-lived connection (no socket-per-image churn).
                    if "req_id" in msg:
                        reply["req_id"] = msg["req_id"]
                    await ws.send(json.dumps(reply))
                elif op == "status":
                    await ws.send(json.dumps({"op": "status_reply", **session.status()}))
        finally:
            if pump is not None:
                pump.cancel()
            if sub is not None and session is not None:
                session._subs.discard(sub)
            if session is not None:
                session.touch()  # idle clock starts when the last client leaves
            log.info("client disconnected")
