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
        self._subs: set[Subscriber] = set()
        self._queue: asyncio.Queue = asyncio.Queue()
        self._exec_counter = 0
        self._tasks: list[asyncio.Task] = []

    # -- lifecycle -----------------------------------------------------------
    async def start(self) -> None:
        spawned = self.kernel.ensure()
        self.kc = self.kernel.make_client()
        if spawned:
            await self._wait_kernel_ready(timeout=120)
        # Capture the kernel's Python version (before the exec worker contends on
        # the shell channel) so the client can label the kernel "Python 3.x.y".
        await self._capture_kernel_info()
        orphaned = self.journal.orphan_inflight()
        if orphaned:
            log.info("[%s] marked %d in-flight executions orphaned", self.session_id, orphaned)
        self._rebuild_folds()
        self._rebuild_mirror()
        self._exec_counter = self.journal.max_exec_seq()
        self._start_tasks()
        log.info(
            "session ready id=%s kernel_pid=%s reattached=%s dir=%s",
            self.session_id, self.kernel.pid, self.kernel.reattached, self.session_dir,
        )

    def _start_tasks(self) -> None:
        self._tasks = [
            asyncio.create_task(self._iopub_pump(), name=f"iopub-{self.session_id}"),
            asyncio.create_task(self._exec_worker(), name=f"exec-{self.session_id}"),
        ]

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
        self.kernel.restart()
        self.kc = self.kernel.make_client()
        await self._wait_kernel_ready(timeout=120)
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

    async def _exec_worker(self) -> None:
        while True:
            exec_id, code = await self._queue.get()
            msg_id = self.kc.execute(code)
            self._msgid_to_exec[msg_id] = exec_id
            started_at = self.journal.mark_started(exec_id)
            self._journal_lifecycle(exec_id, "tithon.started", {"ts": started_at})
            log.info("[%s] exec %s started (msg_id=%s)", self.session_id, exec_id, msg_id)
            while True:
                reply = await self.kc.shell_channel.get_msg()
                if (
                    reply["header"]["msg_type"] == "execute_reply"
                    and (reply.get("parent_header") or {}).get("msg_id") == msg_id
                ):
                    break
            content = reply["content"]
            status = content.get("status", "ok")
            ec = content.get("execution_count")
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
               origin: dict | None = None) -> str:
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
        self._queue.put_nowait((exec_id, code))
        return exec_id

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

    def __init__(self, home: Path, workdir: Path):
        self.home = home
        self.workdir = workdir
        self.sock_path = home / "daemon.sock"
        self.pid_file = home / "daemon.pid"
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
            await self._stop.wait()
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
                # A connection is bound to one session, fixed on the first op.
                # The first op may carry the client's project root (`workdir`) so
                # a freshly-created session roots its artifacts/kernel there.
                if session is None:
                    session = await self._get_session(
                        msg.get("session", DEFAULT_SESSION), msg.get("workdir")
                    )

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
                    exec_id = session.submit(code, msg.get("submitted_by"), msg.get("origin"))
                    log.info("[%s] execute queued exec_id=%s queue_len=%d code=%r",
                             session.session_id, exec_id, session._queue.qsize(), preview)
                    await ws.send(json.dumps({"op": "execute_ack", "exec_id": exec_id}))
                elif op == "interrupt":
                    ok = session.interrupt()
                    log.info("[%s] interrupt ok=%s", session.session_id, ok)
                    await ws.send(json.dumps({"op": "interrupted", "ok": ok}))
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
            log.info("client disconnected")
