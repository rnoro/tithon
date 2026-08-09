"""Kernel liveness watchdog: death observed while the daemon stays UP.

``KernelHandle.is_alive()`` is consulted only on the EXECUTION path (before
submit, and on the reply poll timeout), and ``Session.start()`` — which derives
the lost-state signal — is not re-entered while the daemon lives. So a kernel
that dies while IDLE (host OOM-kill, operator kill, remote host loss) was
observed by nobody: the client kept showing a healthy kernel until the user ran
the next cell. This is the false negative ADR-075 explicitly left open
(RISKS.md #3).

The watchdog must be independent of the idle-GC loop: ``_gc_loop`` is only
created when ``idle_timeout > 0`` and the default is 0, so "just piggyback on the
sweep that already runs every 60s" has no loop to piggyback on in the default
configuration. ``test_watchdog_runs_with_the_idle_gc_disabled`` pins that.

v48.sh proves the end-to-end path (real daemon + real SIGKILL + real client).
"""
from __future__ import annotations

import asyncio
import json

from tithon.daemon import Daemon, Session, Subscriber
from tithon.folding import ExecutionFold
from tithon.journal import Journal


def make_session(tmp_path, sid="file:///proj/a.py", name="sess") -> Session:
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    s = Session(sid, tmp_path / name, work)
    # A session the daemon has loaded always has a spawned/re-attached kernel;
    # Session.__init__ alone does not spawn one.
    s.kernel.pid = 4242
    s.kernel_status = "idle"
    return s


def kill(s: Session) -> None:
    """The process is gone — exactly what ``is_alive`` reports for a dead pid."""
    s.kernel.is_alive = lambda: False


def revive(s: Session) -> None:
    s.kernel.is_alive = lambda: True


def kernel_events(s: Session) -> list[dict]:
    return [
        json.loads(c)
        for _seq, _e, t, c in s.journal.messages_after(0)
        if t == "tithon.kernel"
    ]


# -- Session.check_kernel_liveness ------------------------------------------

def test_live_kernel_journals_nothing(tmp_path):
    s = make_session(tmp_path)
    revive(s)

    assert s.check_kernel_liveness() is False
    assert kernel_events(s) == []
    assert s.kernel_status == "idle"


def test_dead_kernel_is_journaled_and_marked(tmp_path):
    s = make_session(tmp_path)
    kill(s)

    assert s.check_kernel_liveness() is True

    assert s.kernel_status == "dead"
    evs = kernel_events(s)
    assert len(evs) == 1
    assert evs[0]["status"] == "dead"
    assert evs[0]["pid"] == 4242
    assert evs[0]["deliberate"] is False


def test_dead_kernel_reaches_live_clients(tmp_path):
    """Journaled AND broadcast — an attached client must not wait for its next
    execute to learn the kernel is gone."""
    s = make_session(tmp_path)
    sub = Subscriber(asyncio.Queue())
    s._subs.add(sub)
    kill(s)

    s.check_kernel_liveness()

    ev = sub.queue.get_nowait()
    assert ev["kind"] == "kernel"
    assert ev["payload"]["status"] == "dead"


def test_detection_is_reported_once(tmp_path):
    """The watchdog re-polls forever; a dead kernel must not append an event per
    tick (it would flood the journal and re-warn the user every few seconds)."""
    s = make_session(tmp_path)
    kill(s)

    assert s.check_kernel_liveness() is True
    for _ in range(5):
        assert s.check_kernel_liveness() is False

    assert len(kernel_events(s)) == 1


def test_exec_path_death_is_not_double_reported(tmp_path):
    """``_emit_kernel_dead`` (the exec worker's detection) already set the status
    and gave the user an error output on the cell; the watchdog must not add a
    second, redundant notification for the same death."""
    s = make_session(tmp_path)
    s.journal.insert_execution("e1", 1, "os._exit(1)")
    s._folds["e1"] = ExecutionFold()
    kill(s)
    s._emit_kernel_dead("e1")

    assert s.check_kernel_liveness() is False
    assert kernel_events(s) == []


def test_restart_window_is_not_reported_as_death(tmp_path):
    """``restart_kernel`` kills the kernel and spawns a fresh one; a watchdog tick
    landing in that window would report a deliberate restart as a crash."""
    s = make_session(tmp_path)
    kill(s)
    s._restarting = True

    assert s.check_kernel_liveness() is False
    assert kernel_events(s) == []

    s._restarting = False
    assert s.check_kernel_liveness() is True


def test_concurrent_restarts_are_serialized(tmp_path):
    """Two clients can ask the SAME session to restart at once — each connection
    runs its own ``_handler`` coroutine and both await ``restart_kernel`` on the
    one Session object (daemon.py, the ``restart_kernel`` op).

    A bare boolean guard is not mutual exclusion: both bodies would run, and the
    first to finish would clear ``_restarting`` in its ``finally`` while the second
    is still tearing down channels or waiting for the fresh kernel — reopening the
    suppression window mid-restart, so the watchdog reports the user's own restart
    as a crash. (Both bodies also concurrently stopping channels and respawning is
    a hazard in its own right.)
    """
    s = make_session(tmp_path)
    kill(s)  # the kernel is legitimately dead for this whole window
    depth = 0
    peak = 0

    async def fake_inner():
        nonlocal depth, peak
        depth += 1
        peak = max(peak, depth)
        # A watchdog tick lands mid-restart: it must stay suppressed.
        assert s.check_kernel_liveness() is False
        await asyncio.sleep(0)  # yield — a second restart may try to interleave
        depth -= 1
        return 4242

    s._restart_kernel_inner = fake_inner

    async def main():
        await asyncio.gather(s.restart_kernel(), s.restart_kernel())

    asyncio.run(main())

    assert peak == 1, "two restarts of one session overlapped"
    assert kernel_events(s) == [], "a deliberate restart was journaled as a death"


def test_never_spawned_kernel_is_not_reported(tmp_path):
    """A Session constructed but not started has no kernel to be dead."""
    s = make_session(tmp_path)
    s.kernel.pid = None
    kill(s)

    assert s.check_kernel_liveness() is False
    assert kernel_events(s) == []


def test_recovery_after_a_restart_re_arms_the_watchdog(tmp_path):
    """A second, later death must be reported again — the once-only guard is per
    death, not per session lifetime."""
    s = make_session(tmp_path)
    kill(s)
    assert s.check_kernel_liveness() is True

    revive(s)              # restart_kernel spawned a fresh one
    s.kernel_status = "idle"
    kill(s)                # ...and that one dies too

    assert s.check_kernel_liveness() is True
    assert len(kernel_events(s)) == 2


# -- the lost-state signal must not be weakened (ADR-075) --------------------

def test_dead_is_not_a_generation_status(tmp_path):
    """A ``dead`` observation must NOT become the anchor of the lost-state window.

    ``_classify_kernel_generation`` anchors "did anything RUN on the generation
    that just died?" at the newest GENERATION event. If ``dead`` joined that set,
    the anchor would jump forward to the moment of death — after which nothing can
    have run, by definition — and every host-OOM kernel loss would be silently
    pardoned instead of warned about. ``dead`` ENDS a generation without opening
    one; the replacement's provenance is recorded as ``replaced`` when the fresh
    kernel is classified.
    """
    assert "dead" not in Journal.GENERATION_STATUSES


def test_watchdog_event_does_not_pardon_lost_work(tmp_path):
    """End-to-end on the predicate: work ran, the kernel died (watchdog event),
    the daemon later spawns a fresh kernel -> the user must still be warned."""
    s = make_session(tmp_path)
    s.journal.insert_execution("e1", 1, "df = load()")
    s.journal.mark_started("e1")
    s.journal.append_message("e1", "tithon.started", {"ts": 0.0})
    kill(s)
    s.check_kernel_liveness()

    last = s.journal.last_kernel_event()
    since = 0 if last is None else last[0]
    assert s.journal.has_started_since(since) is True, "the lost work was pardoned"


# -- Daemon-level sweep ------------------------------------------------------

def test_sweep_covers_every_loaded_session(tmp_path):
    d = Daemon(tmp_path / "home", tmp_path / "work")
    a = make_session(tmp_path, "file:///a.py", "sa")
    b = make_session(tmp_path, "file:///b.py", "sb")
    d._sessions = {"a": a, "b": b}
    kill(a)
    kill(b)

    d._liveness_sweep()

    assert a.kernel_status == "dead" and b.kernel_status == "dead"
    assert len(kernel_events(a)) == 1 and len(kernel_events(b)) == 1


def test_watchdog_runs_with_the_idle_gc_disabled(tmp_path):
    """The whole point of the item: the default configuration has idle-GC OFF, so
    the watchdog cannot be a rider on ``_gc_loop``."""
    d = Daemon(tmp_path / "home", tmp_path / "work")
    assert d.idle_timeout == 0
    s = make_session(tmp_path)
    d._sessions = {"a": s}
    kill(s)

    d._liveness_sweep()

    assert kernel_events(s)[0]["status"] == "dead"


def test_one_failing_session_does_not_stop_the_sweep(tmp_path):
    """The sweep is a daemon-lifetime loop; an exception in one session must not
    silence the watchdog for every other file."""
    d = Daemon(tmp_path / "home", tmp_path / "work")
    bad = make_session(tmp_path, "file:///bad.py", "sbad")
    good = make_session(tmp_path, "file:///good.py", "sgood")

    def boom():
        raise OSError("/proc read failed")

    bad.kernel.is_alive = boom
    kill(good)
    d._sessions = {"bad": bad, "good": good}

    d._liveness_sweep()

    assert kernel_events(good)[0]["status"] == "dead"
