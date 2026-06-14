"""Tithon daemon: kernel ownership, journaling, multi-client sync server.

Single fixed session ("default"). WebSocket server on a unix domain socket
(0600) only — no TCP (design.md §4 security). All events carry a monotonic
``seq``; clients attach with ``last_seen_seq`` and receive snapshot+delta.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import signal
import socket
from pathlib import Path

from websockets.asyncio.server import unix_serve

from .artifacts import ArtifactStore
from .folding import ExecutionFold
from .journal import JOURNALED_IOPUB, Journal, event_from_message
from .kernel import KernelHandle
from .widgets import WidgetMirror, is_comm

log = logging.getLogger("tithon.daemon")

SESSION = "default"

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


class Subscriber:
    """One attached client's event queue + a 'too slow, drop me' flag."""

    __slots__ = ("queue", "dropped")

    def __init__(self, queue: "asyncio.Queue") -> None:
        self.queue = queue
        self.dropped = False


class Daemon:
    def __init__(self, home: Path, workdir: Path):
        self.home = home
        self.workdir = workdir
        self.sock_path = home / "daemon.sock"
        self.pid_file = home / "daemon.pid"
        session_dir = home / "sessions" / SESSION
        self.journal = Journal(session_dir / "journal.db", SESSION)
        self.kernel = KernelHandle(session_dir, workdir, home / "kernel.log")
        self.artifacts = ArtifactStore(workdir, self.journal)
        self.kc = None
        self.kernel_status = "unknown"
        self._folds: dict[str, ExecutionFold] = {}
        self._mirror = WidgetMirror()
        self._msgid_to_exec: dict[str, str] = {}
        self._subs: set[Subscriber] = set()
        self._queue: asyncio.Queue = asyncio.Queue()
        self._exec_counter = 0
        self._stop = asyncio.Event()

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

    def _rebuild_folds(self) -> None:
        """Recompute in-memory folded snapshots from raw journal messages."""
        for exec_id, *_ in self.journal.executions():
            fold = ExecutionFold()
            for _seq, msg_type, content_json in self.journal.messages_for_exec(exec_id):
                if not msg_type.startswith("tithon."):
                    fold.apply(msg_type, json.loads(content_json))
            self._folds[exec_id] = fold

    def _rebuild_mirror(self) -> None:
        """Replay journaled comm messages to restore widget state after restart."""
        for _seq, _exec_id, msg_type, content_json in self.journal.messages_after(0):
            if is_comm(msg_type):
                content = json.loads(content_json)
                buffers = [base64.b64decode(b) for b in content.pop("_buffers_b64", [])]
                self._mirror.apply(msg_type, content, buffers)

    async def run(self) -> None:
        self._preflight()
        spawned = self.kernel.ensure()
        self.kc = self.kernel.make_client()
        if spawned:
            await self._wait_kernel_ready(timeout=120)
        orphaned = self.journal.orphan_inflight()
        if orphaned:
            log.info("marked %d in-flight executions as orphaned", orphaned)
        self._rebuild_folds()
        self._rebuild_mirror()
        self._exec_counter = self.journal.max_exec_seq()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._stop.set)

        tasks = [
            asyncio.create_task(self._iopub_pump(), name="iopub-pump"),
            asyncio.create_task(self._exec_worker(), name="exec-worker"),
        ]
        # write_limit caps each connection's send buffer so a slow client makes
        # ws.send apply backpressure instead of growing daemon memory unbounded.
        async with unix_serve(
            self._handler, path=str(self.sock_path), write_limit=WRITE_BUFFER_HIGH
        ):
            os.chmod(self.sock_path, 0o600)
            self.pid_file.write_text(str(os.getpid()))
            log.info(
                "daemon ready pid=%d kernel_pid=%s reattached=%s sock=%s",
                os.getpid(), self.kernel.pid, self.kernel.reattached, self.sock_path,
            )
            await self._stop.wait()
        for t in tasks:
            t.cancel()
        self.kc.stop_channels()
        self.pid_file.unlink(missing_ok=True)
        self.sock_path.unlink(missing_ok=True)
        log.info("daemon stopped")

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
                log.info("kernel ready")
                return
            if loop.time() > deadline:
                raise RuntimeError("kernel did not become ready in time")
            await asyncio.sleep(0.2)

    # -- kernel message flow ---------------------------------------------------
    async def _iopub_pump(self) -> None:
        while True:
            try:
                msg = await self.kc.iopub_channel.get_msg()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("iopub recv failed")
                await asyncio.sleep(0.2)
                continue
            try:
                self._handle_iopub(msg)
            except Exception:
                log.exception("iopub handling failed: %s", msg.get("header"))

    def _handle_iopub(self, msg: dict) -> None:
        msg_type = msg["header"]["msg_type"]
        content = msg.get("content", {})
        if msg_type == "status":
            new_state = content.get("execution_state", self.kernel_status)
            if new_state != self.kernel_status:
                log.debug("kernel status: %s → %s", self.kernel_status, new_state)
            self.kernel_status = new_state
        parent_id = (msg.get("parent_header") or {}).get("msg_id")
        exec_id = self._msgid_to_exec.get(parent_id)
        if is_comm(msg_type):
            self._handle_comm(exec_id, msg_type, content, msg.get("buffers") or [])
            return
        if exec_id is None or msg_type not in JOURNALED_IOPUB:
            return
        log.debug("iopub exec=%s type=%s", exec_id, msg_type)
        artifact_ref = None
        if msg_type in ("display_data", "execute_result", "update_display_data"):
            refs = self.artifacts.extract(exec_id, content)
            artifact_ref = ",".join(refs) or None
        seq = self.journal.append_message(exec_id, msg_type, content, artifact_ref)
        self._folds[exec_id].apply(msg_type, content)
        self._broadcast(event_from_message(seq, exec_id, msg_type, content))

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
                "payload": {"msg_type": msg_type, "comm_id": content.get("comm_id")},
            }
        )

    async def _exec_worker(self) -> None:
        while True:
            exec_id, code = await self._queue.get()
            msg_id = self.kc.execute(code)
            self._msgid_to_exec[msg_id] = exec_id
            started_at = self.journal.mark_started(exec_id)
            self._journal_lifecycle(exec_id, "tithon.started", {"ts": started_at})
            log.info("exec %s started (msg_id=%s)", exec_id, msg_id)
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
            log.info("exec %s done status=%s", exec_id, status)

    # -- protocol ---------------------------------------------------------------
    def _journal_lifecycle(self, exec_id: str, msg_type: str, payload: dict) -> None:
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
                log.warning("subscriber overflow (>%d queued) — dropping client", SUB_QUEUE_MAX)

    def _submit(self, code: str, submitted_by: str | None = None,
                origin: dict | None = None) -> str:
        self._exec_counter += 1
        exec_id = f"e{self._exec_counter}"
        # cell_hash is computed daemon-side from the submitted code (authoritative,
        # matches the extension's sha256(code)) so output<->cell attachment works
        # even for CLI runs that send no origin (design.md §3.2).
        cell_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()
        self.journal.insert_execution(
            exec_id, self._exec_counter, code, submitted_by, origin, cell_hash
        )
        self._folds[exec_id] = ExecutionFold()
        self._journal_lifecycle(exec_id, "tithon.queued", {"code": code})
        self._queue.put_nowait((exec_id, code))
        return exec_id

    def _snapshot(self) -> dict:
        execs = []
        for (exec_id, seq, code, status, execution_count, folded_json,
             cell_origin_uri, cell_range, cell_hash,
             started_at, finished_at) in self.journal.executions():
            fold = self._folds.get(exec_id)
            if fold is not None:
                outputs = fold.outputs()
            else:
                outputs = json.loads(folded_json) if folded_json else []
            origin = None
            if cell_origin_uri is not None or cell_range is not None:
                origin = {
                    "uri": cell_origin_uri,
                    "range": json.loads(cell_range) if cell_range else None,
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
            "max_seq": self.journal.max_seq(),
            "kernel": {"status": self.kernel_status, "pid": self.kernel.pid},
            "queue_len": self._queue.qsize(),
            "executions": execs,
            "widgets": self._mirror.snapshot(),
        }

    def _status(self) -> dict:
        return {
            "session": SESSION,
            "daemon_pid": os.getpid(),
            "kernel_pid": self.kernel.pid,
            "kernel_status": self.kernel_status,
            "kernel_reattached": self.kernel.reattached,
            "queue_len": self._queue.qsize(),
            "max_seq": self.journal.max_seq(),
            "executions": len(self.journal.executions()),
            "widget_models": len(self._mirror),
        }

    async def _handler(self, ws) -> None:
        sub: Subscriber | None = None
        pump: asyncio.Task | None = None
        log.info("client connected (subscribers=%d)", len(self._subs) + 1)
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                op = msg.get("op")
                if op == "attach":
                    if sub is None:
                        sub = Subscriber(asyncio.Queue(maxsize=SUB_QUEUE_MAX))
                        self._subs.add(sub)  # buffer live events from this instant
                        # Bound the kernel send buffer for this connection so a
                        # stalled client cannot park tens of MB in kernel memory.
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
                        backlog = [{"op": "snapshot", **self._snapshot()}]
                        cutoff = backlog[0]["max_seq"]
                    elif last < 0:  # live-only attach
                        backlog = []
                        cutoff = self.journal.max_seq()
                    else:
                        rows = self.journal.messages_after(last)
                        backlog = [
                            event_from_message(s, e, t, json.loads(c)) for s, e, t, c in rows
                        ]
                        cutoff = rows[-1][0] if rows else last
                    for item in backlog:
                        await ws.send(json.dumps(item))
                    await ws.send(json.dumps({"op": "sync", "seq": cutoff}))
                    if pump is None:
                        pump = asyncio.create_task(self._sub_pump(ws, sub, cutoff))
                    log.info(
                        "client attached last_seen_seq=%d cutoff=%d backlog=%d subscribers=%d",
                        last, cutoff, len(backlog), len(self._subs),
                    )
                elif op == "execute":
                    code = msg.get("code", "")
                    preview = code[:80].replace("\n", "↵")
                    exec_id = self._submit(
                        code, msg.get("submitted_by"), msg.get("origin")
                    )
                    log.info("execute queued exec_id=%s queue_len=%d code=%r",
                             exec_id, self._queue.qsize(), preview)
                    await ws.send(json.dumps({"op": "execute_ack", "exec_id": exec_id}))
                elif op == "status":
                    await ws.send(json.dumps({"op": "status_reply", **self._status()}))
        finally:
            if pump is not None:
                pump.cancel()
            if sub is not None:
                self._subs.discard(sub)
            log.info("client disconnected (subscribers=%d)", len(self._subs))

    async def _sub_pump(self, ws, sub: Subscriber, cutoff: int) -> None:
        while True:
            try:
                event = await asyncio.wait_for(sub.queue.get(), SUB_POLL)
            except (asyncio.TimeoutError, TimeoutError):
                if sub.dropped:
                    return await self._notify_overflow(ws)
                continue
            if sub.dropped:
                return await self._notify_overflow(ws)
            if event.get("seq", 0) <= cutoff:
                continue  # already covered by snapshot/delta replay
            try:
                await asyncio.wait_for(ws.send(json.dumps(event)), SEND_TIMEOUT)
            except (asyncio.TimeoutError, TimeoutError):
                # Client stalled accepting data: drop it (host stays healthy).
                sub.dropped = True
                log.warning("subscriber send stalled >%.0fs — dropping client", SEND_TIMEOUT)
                return await self._notify_overflow(ws)

    @staticmethod
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
