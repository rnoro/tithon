"""Kernel lifetime policy (idle GC): eligibility + sweep semantics.

A detached kernel otherwise lives forever; with per-file kernels every opened
file leaves one more immortal process on the GPU host (SPEC §3.1). The idle-GC
reaps a session only when NOTHING can lose work: no attached client, no queued
or running batch, no pending input() prompt, kernel not busy, and the idle
clock past the operator's opt-in timeout (0 = disabled, the default). These
cover the policy surface without a live kernel; v45.sh proves the end-to-end
reap + journal-restore on real processes.
"""
from __future__ import annotations

import asyncio
import json

from tithon.daemon import Daemon, Session, Subscriber


def make_session(tmp_path, sid="file:///proj/a.py", name="sess") -> Session:
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return Session(sid, tmp_path / name, work)


def backdate(s: Session, seconds: float) -> None:
    s._last_activity -= seconds


def test_disabled_policy_never_eligible(tmp_path):
    s = make_session(tmp_path)
    backdate(s, 10_000)
    assert not s.gc_eligible(0)
    assert not s.gc_eligible(-1)


def test_idle_past_timeout_is_eligible(tmp_path):
    s = make_session(tmp_path)
    backdate(s, 100)
    assert s.gc_eligible(5)


def test_touch_resets_the_idle_clock(tmp_path):
    s = make_session(tmp_path)
    backdate(s, 100)
    s.touch()
    assert s.idle_seconds() < 1
    assert not s.gc_eligible(5)


def test_attached_client_blocks(tmp_path):
    s = make_session(tmp_path)
    backdate(s, 100)
    sub = Subscriber(asyncio.Queue())
    s._subs.add(sub)
    assert not s.gc_eligible(5)
    s._subs.discard(sub)
    assert s.gc_eligible(5)


def test_queued_batch_blocks(tmp_path):
    s = make_session(tmp_path)
    s.submit_batch([{"code": "x = 1\n", "origin": None}], stop_on_error=False)
    backdate(s, 100)
    assert not s.gc_eligible(5)


def test_running_batch_blocks(tmp_path):
    # _busy is what the exec worker sets while a batch is in flight — the queue
    # alone can't see the running batch (it lives in the worker coroutine).
    s = make_session(tmp_path)
    backdate(s, 100)
    s._busy = True
    assert not s.gc_eligible(5)
    s._busy = False
    assert s.gc_eligible(5)


def test_pending_input_blocks(tmp_path):
    s = make_session(tmp_path)
    backdate(s, 100)
    s._pending_input = {"exec_id": "e1", "prompt": "? ", "password": False}
    assert not s.gc_eligible(5)


def test_busy_kernel_status_blocks(tmp_path):
    # Re-attach edge: a kernel still crunching code submitted before a daemon
    # restart is busy on iopub even though this daemon holds no batch for it.
    s = make_session(tmp_path)
    backdate(s, 100)
    s.kernel_status = "busy"
    assert not s.gc_eligible(5)


def test_status_reports_clients_and_idle(tmp_path):
    s = make_session(tmp_path)
    st = s.status()
    assert st["clients"] == 0
    assert st["idle_seconds"] >= 0
    s._subs.add(Subscriber(asyncio.Queue()))
    assert s.status()["clients"] == 1


def test_sweep_reaps_only_eligible(tmp_path):
    d = Daemon(tmp_path / "home", tmp_path / "work", idle_timeout=5)
    idle = make_session(tmp_path, "file:///proj/idle.py", "idle")
    watched = make_session(tmp_path, "file:///proj/watched.py", "watched")
    backdate(idle, 100)
    backdate(watched, 100)
    watched._subs.add(Subscriber(asyncio.Queue()))
    d._sessions = {idle.session_id: idle, watched.session_id: watched}

    asyncio.run(d._gc_sweep())

    assert idle.session_id not in d._sessions
    assert watched.session_id in d._sessions
    # The reap is journaled (tithon.kernel status=gc) so the next client to
    # open the file sees the kernel was reclaimed, mirroring the "killed" path.
    payloads = [
        json.loads(c)
        for _seq, _exec_id, msg_type, c in idle.journal.messages_after(0)
        if msg_type == "tithon.kernel"
    ]
    assert any(p.get("status") == "gc" for p in payloads)


def test_sweep_disabled_is_a_noop(tmp_path):
    d = Daemon(tmp_path / "home", tmp_path / "work", idle_timeout=0)
    s = make_session(tmp_path)
    backdate(s, 10_000)
    d._sessions = {s.session_id: s}
    asyncio.run(d._gc_sweep())
    assert s.session_id in d._sessions
