"""Kill/restart mutual exclusion (bug-hunt: RISKS #7 finding 1).

kill_kernel (and idle-GC) used to pop a Session out of SessionManager._sessions
and tear it down WITHOUT taking the session's own `_restart_lock` — so a
restart_kernel() already in flight on that same (now-orphaned) Session could
still respawn a fresh kernel and pumps nobody could ever reach again, while a
NEW Session for the same id gets created on the next lookup. Both `_kill_session`
and `restart_kernel` now share `_restart_lock`, and a restart that loses the
race (sees `_killed`) raises `SessionKilledError` instead of respawning.

These tests stub out the real kernel machinery (`_restart_kernel_inner`,
`Session.stop`) to isolate the LOCKING behavior from kernel-spawn cost/timing —
the race is about which coroutine's body runs when, not about ipykernel itself.
"""
from __future__ import annotations

import asyncio

import pytest

from tithon.daemon import Daemon, Session, SessionKilledError


def make_session(tmp_path) -> Session:
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return Session("default", tmp_path / "sess", work)


def test_restart_after_killed_raises_without_respawning(tmp_path):
    """A restart that acquires the lock AFTER kill already ran must bail, not
    respawn onto an orphaned session."""
    s = make_session(tmp_path)
    s._killed = True
    entered_inner = False

    async def fake_inner():
        nonlocal entered_inner
        entered_inner = True
        return 1234

    s._restart_kernel_inner = fake_inner  # type: ignore[method-assign]

    with pytest.raises(SessionKilledError):
        asyncio.run(s.restart_kernel())
    assert not entered_inner, "respawn body must never run once _killed is set"


def test_kill_session_waits_for_in_flight_restart(tmp_path):
    """A restart already running when kill_kernel arrives must finish (holding
    the shared lock) before kill's stop() runs — never interleaved."""
    tmp_path_a = tmp_path / "a"
    s = make_session(tmp_path_a)
    d = Daemon(tmp_path / "home", tmp_path / "work")
    d._sessions["default"] = s

    events: list[str] = []
    busy = {"flag": False}

    async def fake_inner():
        assert not busy["flag"], "restart body overlapped with a concurrent stop()"
        busy["flag"] = True
        events.append("restart-enter")
        await asyncio.sleep(0.05)  # widen the window a real race would need
        events.append("restart-exit")
        busy["flag"] = False
        return 4321

    async def fake_stop(kill_kernel: bool = False) -> None:
        assert not busy["flag"], "stop() overlapped with a concurrent restart body"
        busy["flag"] = True
        events.append("stop-enter")
        await asyncio.sleep(0.01)
        events.append("stop-exit")
        busy["flag"] = False

    s._restart_kernel_inner = fake_inner  # type: ignore[method-assign]
    s.stop = fake_stop  # type: ignore[method-assign]
    s._journal_lifecycle = lambda *a, **k: None  # type: ignore[method-assign]

    async def run_both():
        await asyncio.gather(s.restart_kernel(), d._kill_session("default"))

    asyncio.run(run_both())

    # Restart won the race (started first): it must run to completion, and only
    # THEN does kill's stop() run — never interleaved (each pair is contiguous).
    assert events == ["restart-enter", "restart-exit", "stop-enter", "stop-exit"]
    assert s._killed is True
    assert "default" not in d._sessions


def test_kill_first_makes_racing_restart_bail(tmp_path):
    """If kill_kernel's stop() is already running, a restart that arrives
    afterwards must see `_killed` and raise instead of respawning."""
    tmp_path_a = tmp_path / "a"
    s = make_session(tmp_path_a)
    d = Daemon(tmp_path / "home", tmp_path / "work")
    d._sessions["default"] = s

    entered_inner = False

    async def fake_inner():
        nonlocal entered_inner
        entered_inner = True
        return 1234

    async def fake_stop(kill_kernel: bool = False) -> None:
        await asyncio.sleep(0.05)  # hold the lock long enough for restart to queue

    s._restart_kernel_inner = fake_inner  # type: ignore[method-assign]
    s.stop = fake_stop  # type: ignore[method-assign]
    s._journal_lifecycle = lambda *a, **k: None  # type: ignore[method-assign]

    async def run_both():
        async def delayed_restart():
            await asyncio.sleep(0.01)  # let kill_kernel acquire the lock first
            with pytest.raises(SessionKilledError):
                await s.restart_kernel()

        await asyncio.gather(d._kill_session("default"), delayed_restart())

    asyncio.run(run_both())
    assert not entered_inner, "respawn body must never run once kill won the race"
    assert "default" not in d._sessions
