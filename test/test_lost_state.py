"""Journal primitives behind the lost-state signal (SPEC §7 host reboot).

The signal answers "did the kernel generation that just died hold anything the
user would miss?" purely from the journal, so these two predicates are the whole
decision. Both have a failure mode that looks harmless in isolation and produces
a wrong warning in production:

* counting a cell that was SUBMITTED but never started tells a user their
  variables vanished when nothing ever ran, and
* letting a non-generation event (``interrupted``) shadow the provenance record
  loses the deliberate/involuntary distinction entirely.
"""
from test_clear import make_session


def test_never_started_cell_is_not_an_execution(tmp_path):
    """A queued-then-orphaned cell must not count as work the kernel lost.

    ``orphan_inflight`` rewrites a never-started ``queued`` row to ``orphaned``
    after a crash, which is indistinguishable BY STATUS from a run that was cut
    off mid-flight — so the predicate keys on the ``tithon.started`` message the
    exec worker appends only once the kernel accepts the cell.
    """
    s = make_session(tmp_path)
    s.journal.insert_execution("e1", 1, "x = 1")  # submitted, never picked up
    assert s.journal.has_started_since(0) is False
    s.journal.orphan_inflight()
    assert _status(s, "e1") == "orphaned"
    assert s.journal.has_started_since(0) is False, "a cell that never ran was counted as lost state"


def test_started_cell_counts_and_the_window_is_anchored(tmp_path):
    """Work is counted only when it started AFTER the anchoring lifecycle event."""
    s = make_session(tmp_path)
    s.journal.insert_execution("e1", 1, "x = 1")
    s.journal.mark_started("e1")
    s.journal.append_message("e1", "tithon.started", {"ts": 0.0})
    assert s.journal.has_started_since(0) is True
    reset = s.journal.append_message(None, "tithon.kernel",
                                     {"status": "restarted", "deliberate": True})
    # Nothing has run since the deliberate reset -> the user lost nothing new.
    assert s.journal.has_started_since(reset) is False
    s.journal.insert_execution("e2", 2, "y = 2")
    s.journal.mark_started("e2")
    s.journal.append_message("e2", "tithon.started", {"ts": 0.0})
    # ...but work rebuilt on the fresh kernel re-opens the window.
    assert s.journal.has_started_since(reset) is True


def test_interrupt_does_not_shadow_the_generation_record(tmp_path):
    """``interrupted`` leaves the kernel and its namespace alive.

    It is journaled on the same ``tithon.kernel`` channel, so a naive "newest
    kernel event" lookup would return it and lose the deliberate marker — after
    which a deliberate restart reads as an involuntary loss (and an involuntary
    replacement reads as pardoned).
    """
    s = make_session(tmp_path)
    seq = s.journal.append_message(None, "tithon.kernel",
                                   {"status": "restarted", "deliberate": True})
    for _ in range(3):
        s.journal.append_message(None, "tithon.kernel", {"status": "interrupted"})
    last = s.journal.last_kernel_event()
    assert last is not None
    assert last[0] == seq
    assert last[1]["status"] == "restarted"
    assert last[1]["deliberate"] is True


def test_no_kernel_event_at_all(tmp_path):
    s = make_session(tmp_path)
    assert s.journal.last_kernel_event() is None


def _status(s, exec_id):
    for row in s.journal.executions():
        if row[0] == exec_id:
            return row[3]
    raise AssertionError(f"no such exec {exec_id}")
