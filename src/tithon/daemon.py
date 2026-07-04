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
from .folding import ExecutionFold
from .journal import JOURNALED_IOPUB, Journal, event_from_message
from .kernel import KernelHandle
from .widgets import WidgetMirror, is_comm

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


class Subscriber:
    """One attached client's event queue + a 'too slow, drop me' flag."""

    __slots__ = ("queue", "dropped")

    def __init__(self, queue: "asyncio.Queue") -> None:
        self.queue = queue
        self.dropped = False


class Session:
    """One file's kernel + journal + folded state + subscribers.

    Owns the iopub pump and the execute worker for its kernel. This is the unit
    that used to be the whole daemon; the daemon now holds a dict of these,
    keyed by session id (the file uri).
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
        self.kc = None
        self.kernel_status = "unknown"
        self.kernel_pyversion: str | None = None  # e.g. "3.11.5"
        self._folds: dict[str, ExecutionFold] = {}
        # How many live folded snapshots reference each artifact id. When a count
        # hits zero (a frame superseded by clear_output/update_display_data) the
        # file is GC'd, so a live-updating plot keeps O(1) files, not one/step.
        self._artifact_refs: Counter[str] = Counter()
        self._mirror = WidgetMirror()
        self._msgid_to_exec: dict[str, str] = {}
        # The unanswered input()/getpass() prompt, if a cell is blocked waiting on
        # stdin: {exec_id, prompt, password}. Surfaced live (tithon.input_request)
        # and in the snapshot (pending_input) so a reconnecting client re-prompts.
        self._pending_input: dict | None = None
        self._subs: set[Subscriber] = set()
        self._queue: asyncio.Queue = asyncio.Queue()
        self._exec_counter = 0
        self._tasks: list[asyncio.Task] = []
        # Idle-GC bookkeeping: when work last happened (monotonic, wall-jump
        # safe) and whether the exec worker is mid-batch (the queue alone can't
        # tell — the running batch lives in the worker coroutine, not the queue).
        self._busy = False
        self._last_activity = time.monotonic()

    # -- lifecycle -----------------------------------------------------------
    async def start(self) -> None:
        spawned = self.kernel.ensure()
        self.kc = self.kernel.make_client()
        if spawned:
            await self._wait_kernel_ready(timeout=120)
        # Capture the kernel's Python version (before the exec worker contends on
        # the shell channel) so the client can label the kernel "Python 3.x.y".
        await self._capture_kernel_info()
        # Let the stdin DEALER finish registering at the kernel ROUTER so the first
        # cell's input()/getpass() can't lose its prompt to the connection race.
        await asyncio.sleep(STDIN_SETTLE_S)
        orphaned = self.journal.orphan_inflight()
        if orphaned:
            log.info("[%s] marked %d in-flight executions orphaned", self.session_id, orphaned)
        self._rebuild_folds()
        self._rebuild_mirror()
        self._exec_counter = self.journal.max_exec_seq()
        self._start_tasks()
        # Becoming ready counts as activity: the idle clock must not include the
        # kernel-spawn seconds, or a short timeout could reap a session in the
        # gap between creation and the creating client's first op.
        self.touch()
        log.info(
            "session ready id=%s kernel_pid=%s reattached=%s dir=%s",
            self.session_id, self.kernel.pid, self.kernel.reattached, self.session_dir,
        )

    def _start_tasks(self) -> None:
        # A cancelled worker (kernel restart) may have died mid-batch with _busy
        # still set; the fresh worker starts with a clean slate — without this a
        # restarted session could never become idle-GC eligible again.
        self._busy = False
        self._tasks = [
            asyncio.create_task(self._iopub_pump(), name=f"iopub-{self.session_id}"),
            asyncio.create_task(self._stdin_pump(), name=f"stdin-{self.session_id}"),
            asyncio.create_task(self._exec_worker(), name=f"exec-{self.session_id}"),
        ]

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
            self.kernel.kill()

    async def restart_kernel(self) -> int:
        """Kill this session's kernel and spawn a fresh one (new namespace).

        Jupyter-style restart: outputs/history stay in the journal, but the
        running namespace is gone. In-flight executions are orphaned and a
        ``tithon.kernel`` event tells clients to reset (clear spinners).
        """
        await self._stop_tasks()
        try:
            self.kc.stop_channels()
        except Exception:  # pragma: no cover - defensive
            pass
        self.journal.orphan_inflight()
        # Discard batches still WAITING in the queue (submitted behind the cell that
        # was running): orphan_inflight already flipped their queued execs to
        # 'orphaned', so leaving them in the queue would make the fresh worker run
        # stale pre-restart cells on the NEW kernel and re-journal an already-
        # orphaned exec. A restart means a clean slate — drop them.
        dropped = self._drain_queue()
        if dropped:
            log.info("[%s] dropped %d queued batch(es) on restart", self.session_id, dropped)
        self._pending_input = None  # a restart abandons any waiting prompt
        self.kernel.restart()
        self.kc = self.kernel.make_client()
        await self._wait_kernel_ready(timeout=120)
        await asyncio.sleep(STDIN_SETTLE_S)  # stdin DEALER registers before the next run
        self.kernel_status = "starting"
        self._msgid_to_exec.clear()
        self._start_tasks()
        self._journal_lifecycle(
            None, "tithon.kernel", {"status": "restarted", "pid": self.kernel.pid}
        )
        log.info("[%s] kernel restarted pid=%s", self.session_id, self.kernel.pid)
        return self.kernel.pid

    def interrupt(self) -> bool:
        """Interrupt the running cell (SIGINT to the kernel)."""
        ok = self.kernel.interrupt()
        self._journal_lifecycle(None, "tithon.kernel", {"status": "interrupted"})
        return ok

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
        for exec_id in targets:
            fold = self._folds[exec_id]
            before = fold.artifact_ids()
            seq = self.journal.append_message(exec_id, "clear_output", {"wait": False})
            fold.apply("clear_output", {"wait": False})
            self._gc_artifacts(before, fold.artifact_ids())
            self.journal.set_folded(exec_id, json.dumps(fold.outputs()))
            self._broadcast(event_from_message(seq, exec_id, "clear_output", {"wait": False}))
        if targets:
            log.info("[%s] user-cleared %d execution(s)", self.session_id, len(targets))
        return len(targets)

    def _rebuild_folds(self) -> None:
        """Recompute in-memory folded snapshots from raw journal messages.

        Then seed the live-artifact reference counter from the rebuilt folds and
        sweep ``.tithon/outputs/`` of any artifact no surviving fold references —
        reclaiming frames left behind by a previous run (or by an older daemon
        that predated artifact GC)."""
        for exec_id, *_ in self.journal.executions():
            fold = ExecutionFold()
            for _seq, msg_type, content_json in self.journal.messages_for_exec(exec_id):
                if not msg_type.startswith("tithon."):
                    fold.apply(msg_type, json.loads(content_json))
            self._folds[exec_id] = fold
        self._artifact_refs = Counter(
            aid for fold in self._folds.values() for aid in fold.artifact_ids()
        )
        removed = self.artifacts.sweep(keep=set(self._artifact_refs))
        if removed:
            log.info("[%s] swept %d orphaned artifact(s)", self.session_id, removed)

    def _rebuild_mirror(self) -> None:
        """Replay journaled comm messages to restore widget state after restart."""
        for _seq, _exec_id, msg_type, content_json in self.journal.messages_after(0):
            if is_comm(msg_type):
                content = json.loads(content_json)
                buffers = [base64.b64decode(b) for b in content.pop("_buffers_b64", [])]
                self._mirror.apply(msg_type, content, buffers)

    async def _wait_kernel_ready(self, timeout: float = 120.0) -> None:
        """Poll kernel_info until the kernel replies.

        Deliberately not ``KernelClient.wait_for_ready``: without a parent
        KernelManager it consults the heartbeat channel, which reports "not
        beating" right after spawn and raises "Kernel died" spuriously.
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

    def _handle_iopub(self, msg: dict) -> None:
        msg_type = msg["header"]["msg_type"]
        content = msg.get("content", {})
        if msg_type == "status":
            new_state = content.get("execution_state", self.kernel_status)
            if new_state != self.kernel_status:
                log.debug("[%s] kernel status: %s → %s", self.session_id, self.kernel_status, new_state)
            self.kernel_status = new_state
        parent_id = (msg.get("parent_header") or {}).get("msg_id")
        exec_id = self._msgid_to_exec.get(parent_id)
        if is_comm(msg_type):
            self._handle_comm(exec_id, msg_type, content, msg.get("buffers") or [])
            return
        if exec_id is None or msg_type not in JOURNALED_IOPUB:
            return
        log.debug("[%s] iopub exec=%s type=%s", self.session_id, exec_id, msg_type)
        artifact_ref = None
        if msg_type in ("display_data", "execute_result", "update_display_data"):
            refs = self.artifacts.extract(exec_id, content)
            artifact_ref = ",".join(refs) or None
        seq = self.journal.append_message(exec_id, msg_type, content, artifact_ref)
        fold = self._folds[exec_id]
        before = fold.artifact_ids()
        fold.apply(msg_type, content)
        self._gc_artifacts(before, fold.artifact_ids())
        self._broadcast(event_from_message(seq, exec_id, msg_type, content))

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
        """Feed the Widget State Mirror; journal raw comm (buffers base64)."""
        if not self._mirror.apply(msg_type, content, buffers):
            return
        stored = content
        if buffers:
            stored = {
                **content,
                "_buffers_b64": [base64.b64encode(bytes(b)).decode("ascii") for b in buffers],
            }
        seq = self.journal.append_message(exec_id, msg_type, stored)
        self._broadcast(
            {
                "op": "event",
                "seq": seq,
                "exec_id": exec_id,
                "kind": "widget",
                # Carry the comm data (state patch) so a live client mirrors the
                # widget as it changes — that's what makes a tqdm.notebook bar
                # animate live (not just restore on reconnect). Binary buffers are
                # omitted here (tqdm has none); the snapshot still carries them.
                "payload": {
                    "msg_type": msg_type,
                    "comm_id": content.get("comm_id"),
                    "data": content.get("data"),
                },
            }
        )

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
            for exec_id, code in batch:
                if skip_rest:
                    self._mark_skipped(exec_id)
                    continue
                status = await self._run_one(exec_id, code, allow_stdin)
                if status != "ok" and stop_on_error:
                    skip_rest = True
            self._busy = False
            self.touch()  # the idle clock starts when the batch finishes

    async def _run_one(self, exec_id: str, code: str, allow_stdin: bool = False) -> str:
        """Execute one cell on the kernel; journal its lifecycle; return the
        kernel's reply status ("ok"/"error").

        allow_stdin gates input()/getpass()/breakpoint()/pdb. When False (CLI /
        default), the kernel raises StdinNotImplementedError at once so the cell
        fails cleanly and the session keeps moving — without this, an unanswered
        input_request would wedge the worker and every queued cell (ADR-050).
        When True (a VSCode client that can present an input box), the
        :meth:`_stdin_pump` bridges the prompt to the client; an unanswered prompt
        merely waits and is abandonable via interrupt, so it still cannot wedge
        the session permanently."""
        started_at = self.journal.mark_started(exec_id)
        self._journal_lifecycle(exec_id, "tithon.started", {"ts": started_at})
        # A kernel that already died (a previous cell crashed it) can't run this
        # cell — fail fast instead of executing into the void and timing out.
        if not self.kernel.is_alive():
            self._emit_kernel_dead(exec_id)
            status, ec = "error", None
        else:
            msg_id = self.kc.execute(code, allow_stdin=allow_stdin)
            self._msgid_to_exec[msg_id] = exec_id
            log.info("[%s] exec %s started (msg_id=%s)", self.session_id, exec_id, msg_id)
            status, ec = await self._await_reply(msg_id, exec_id)
        # If the cell ended while still blocked at a prompt (interrupted, or the
        # kernel aborted input), drop the stale prompt so the client dismisses it.
        self._clear_pending_input(exec_id)
        # tiny grace so trailing iopub lands before the folded cache persists
        await asyncio.sleep(0.05)
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

    async def _await_reply(self, msg_id: str, exec_id: str) -> tuple[str, int | None]:
        """Wait for this cell's ``execute_reply``, watching for kernel death.

        Polls with a timeout so that if the kernel dies mid-run (crash /
        OOM-kill / ``os._exit``) — in which case no reply is ever sent — we
        detect it and surface an error instead of blocking the exec worker (and
        every queued cell) forever. Returns ``(status, execution_count)``.
        """
        while True:
            try:
                reply = await asyncio.wait_for(
                    self.kc.shell_channel.get_msg(), KERNEL_REPLY_POLL
                )
            except (asyncio.TimeoutError, TimeoutError):
                if not self.kernel.is_alive():
                    self._emit_kernel_dead(exec_id)
                    return "error", None
                continue  # still running, just slow — keep waiting
            if (
                reply["header"]["msg_type"] == "execute_reply"
                and (reply.get("parent_header") or {}).get("msg_id") == msg_id
            ):
                content = reply["content"]
                return content.get("status", "ok"), content.get("execution_count")

    def _emit_kernel_dead(self, exec_id: str) -> None:
        """Journal + broadcast a synthetic error for a cell whose kernel died, so
        the cell stops spinning and shows why. ``mark_done`` is left to the
        caller (shared with the normal path). Marks the kernel status ``dead``."""
        self.kernel_status = "dead"
        content = {
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
        ``allow_stdin`` (per user action) enables the input()/getpass() bridge —
        a client that can present an input box opts in; CLI/default stays off so
        an unanswered prompt can't wedge the session (ADR-050)."""
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
                exec_id, self._exec_counter, code, submitted_by, origin, cell_hash
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

    def snapshot(self) -> dict:
        execs = []
        for (exec_id, seq, code, status, execution_count, folded_json,
             cell_origin_uri, cell_range, cell_hash, cell_index,
             started_at, finished_at) in self.journal.executions():
            fold = self._folds.get(exec_id)
            if fold is not None:
                outputs = fold.outputs()
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
                    "started_at": started_at,
                    "finished_at": finished_at,
                }
            )
        return {
            "session": self.session_id,
            "max_seq": self.journal.max_seq(),
            "kernel": {
                "status": self.kernel_status,
                "pid": self.kernel.pid,
                "python": self.kernel_pyversion,
            },
            "queue_len": self._queue.qsize(),
            "executions": execs,
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
            gc_task = None
            if self.idle_timeout > 0:
                gc_task = asyncio.create_task(self._gc_loop(), name="idle-gc")
                log.info("idle-GC on: timeout=%.0fs poll=%.0fs", self.idle_timeout, GC_POLL)
            try:
                await self._stop.wait()
            finally:
                if gc_task is not None:
                    gc_task.cancel()
                    try:
                        await gc_task
                    except asyncio.CancelledError:
                        pass
        for s in list(self._sessions.values()):
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
        reopening the file re-creates the session lazily with a fresh kernel and
        the restored output history. Returns False if no such live session.
        """
        if not session_id:
            return False
        async with self._sessions_lock:
            s = self._sessions.pop(session_id, None)
        if s is None:
            return False
        try:
            s._journal_lifecycle(None, "tithon.kernel", {"status": "killed"})
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

    async def _gc_sweep(self) -> None:
        """One idle-GC pass over the loaded sessions (factored out for tests)."""
        for sid, s in list(self._sessions.items()):
            if not s.gc_eligible(self.idle_timeout):
                continue
            idle = int(s.idle_seconds())
            async with self._sessions_lock:
                # Re-check under the lock: an attach/execute may have landed
                # between the scan and acquiring the lock.
                if self._sessions.get(sid) is not s or not s.gc_eligible(self.idle_timeout):
                    continue
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
                elif op == "interrupt":
                    ok = session.interrupt()
                    log.info("[%s] interrupt ok=%s", session.session_id, ok)
                    await ws.send(json.dumps({"op": "interrupted", "ok": ok}))
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
                    pid = await session.restart_kernel()
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
