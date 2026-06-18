"""Orphaning an in-flight execution freezes its real elapsed run time.

When the daemon/kernel restarts, ``orphan_inflight`` flips any queued/running
execution to ``orphaned`` (no ``done`` will ever come). A ``running`` exec's
``finished_at`` is frozen at the exec's LAST journaled activity so a restored cell
shows the REAL time it ran before being cut off — not a live spinner, and NOT
wall-clock-since-then (the "26667s" bug). A ``queued`` exec keeps a NULL finish.
"""
import time

from test_clear import make_session


def _row(s, exec_id):
    for r in s.journal.executions():
        if r[0] == exec_id:  # (exec_id, seq, code, status, ec, folded, ..., started, finished)
            return {"status": r[3], "started_at": r[10], "finished_at": r[11]}
    raise AssertionError(f"no such exec {exec_id}")


def test_orphan_running_freezes_finished_at_at_last_activity(tmp_path):
    s = make_session(tmp_path)
    s.journal.insert_execution("e1", 1, "for i in range(9): print(i)")
    started = s.journal.mark_started("e1")
    time.sleep(0.02)
    s.journal.append_message("e1", "stream", {"name": "stdout", "text": "0\n"})
    time.sleep(0.02)
    s.journal.append_message("e1", "stream", {"name": "stdout", "text": "1\n"})
    last_ts = s.journal.db.execute(
        "SELECT MAX(ts) FROM messages WHERE exec_id='e1'").fetchone()[0]

    n = s.journal.orphan_inflight()
    before_now = time.time()

    assert n == 1
    row = _row(s, "e1")
    assert row["status"] == "orphaned"
    # Frozen at the last journaled activity — a real, > 0 duration, NOT now().
    assert row["finished_at"] == last_ts
    assert row["finished_at"] > row["started_at"]
    assert row["finished_at"] < before_now  # not wall-clock-since-then
    assert row["finished_at"] - row["started_at"] >= 0.03


def test_orphan_queued_keeps_null_finish(tmp_path):
    s = make_session(tmp_path)
    s.journal.insert_execution("q1", 1, "print('later')")  # queued, never started

    assert s.journal.orphan_inflight() == 1
    row = _row(s, "q1")
    assert row["status"] == "orphaned"
    assert row["started_at"] is None
    assert row["finished_at"] is None  # never ran -> no duration to show
