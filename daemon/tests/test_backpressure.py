"""Host-memory protection: a slow/stalled client must not grow the daemon
without bound, and must be dropped (it can reconnect and resync)."""
from __future__ import annotations

import asyncio
import json

import pytest

from tithon import daemon as daemon_mod
from tithon.daemon import Daemon, Subscriber


def make_daemon(tmp_path) -> Daemon:
    # __init__ wires Journal/KernelHandle/ArtifactStore but does NOT spawn a kernel.
    home = tmp_path / "home"
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return Daemon(home, work)


def test_broadcast_caps_queue_and_drops_overflowing_client(tmp_path):
    d = make_daemon(tmp_path)
    sub = Subscriber(asyncio.Queue(maxsize=5))
    d._subs.add(sub)

    for i in range(1000):
        d._broadcast({"op": "event", "seq": i})

    assert sub.dropped is True
    assert sub.queue.qsize() <= 5  # memory bounded regardless of event count


def test_broadcast_delivers_in_full_within_capacity(tmp_path):
    d = make_daemon(tmp_path)
    sub = Subscriber(asyncio.Queue(maxsize=1000))
    d._subs.add(sub)

    for i in range(10):
        d._broadcast({"op": "event", "seq": i})

    assert sub.dropped is False
    assert sub.queue.qsize() == 10


def test_dropped_subscriber_is_skipped_by_broadcast(tmp_path):
    d = make_daemon(tmp_path)
    sub = Subscriber(asyncio.Queue(maxsize=5))
    sub.dropped = True
    d._subs.add(sub)
    d._broadcast({"op": "event", "seq": 1})
    assert sub.queue.qsize() == 0  # nothing enqueued to a dropped client


class _StalledWS:
    """A client whose send() never completes (never reading)."""

    def __init__(self) -> None:
        self.closed = False
        self.overflow_notified = False

    async def send(self, raw):
        msg = json.loads(raw)
        if msg.get("op") == "overflow":
            self.overflow_notified = True
            return  # the final notice is allowed through (it has its own timeout)
        await asyncio.Event().wait()  # hang forever

    async def close(self):
        self.closed = True


def test_sub_pump_drops_a_client_that_stalls_on_send(tmp_path, monkeypatch):
    monkeypatch.setattr(daemon_mod, "SEND_TIMEOUT", 0.2)
    d = make_daemon(tmp_path)
    sub = Subscriber(asyncio.Queue(maxsize=100))
    sub.queue.put_nowait({"op": "event", "seq": 1})  # seq > cutoff(0)
    ws = _StalledWS()

    async def run():
        # Should return (drop) within ~SEND_TIMEOUT, not hang.
        await asyncio.wait_for(d._sub_pump(ws, sub, cutoff=0), timeout=3.0)

    asyncio.run(run())
    assert sub.dropped is True
    assert ws.closed is True
    assert ws.overflow_notified is True
