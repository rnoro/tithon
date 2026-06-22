"""Run-All stop-on-error batching (ADR-051).

A multi-cell run is submitted as ONE queue item; on the first error the worker
skips the rest. These tests cover the daemon surface that does NOT need a live
kernel — batch submission (journal + queued broadcast + single queue item) and
the terminal "skipped" transition. End-to-end stop-on-error (the worker running a
real kernel) is covered by the real-kernel check + the bug_runall_error probe.
"""
from __future__ import annotations

import json

from tithon.daemon import Session


def make_session(tmp_path) -> Session:
    # __init__ wires Journal/ArtifactStore without spawning a kernel.
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return Session("default", tmp_path / "sess", work)


def _status(s: Session, exec_id: str) -> str | None:
    for row in s.journal.executions():
        if row[0] == exec_id:
            return row[3]  # executions()[*][3] = status
    return None


def test_submit_batch_enqueues_one_item_with_all_cells_and_flag(tmp_path):
    s = make_session(tmp_path)
    cells = [
        {"code": "a = 1\n", "origin": {"index": 0}},
        {"code": "b = 2\n", "origin": {"index": 1}},
        {"code": "c = 3\n", "origin": {"index": 2}},
    ]
    ids = s.submit_batch(cells, stop_on_error=True)

    assert len(ids) == 3
    # ONE queue item = the whole batch (so the worker sees the run atomically).
    assert s._queue.qsize() == 1
    batch, stop_on_error = s._queue.get_nowait()
    assert stop_on_error is True
    assert [e for e, _ in batch] == ids
    assert [code for _, code in batch] == ["a = 1\n", "b = 2\n", "c = 3\n"]
    # Every cell is journaled queued + each carries its own cell_hash.
    for exec_id, code in batch:
        assert _status(s, exec_id) == "queued"


def test_submit_single_is_a_one_cell_batch_without_stop_on_error(tmp_path):
    s = make_session(tmp_path)
    e = s.submit("x = 1\n", origin={"index": 0})
    batch, stop_on_error = s._queue.get_nowait()
    assert stop_on_error is False          # nothing to stop in a 1-cell run
    assert [eid for eid, _ in batch] == [e]


def test_mark_skipped_is_terminal_and_broadcasts(tmp_path):
    s = make_session(tmp_path)
    ids = s.submit_batch(
        [{"code": "ok\n", "origin": {"index": 0}},
         {"code": "rest\n", "origin": {"index": 1}}],
        stop_on_error=True,
    )
    # Capture broadcasts on the live fold/journal path.
    events: list[dict] = []
    s._broadcast = lambda ev: events.append(ev)  # type: ignore[method-assign]

    s._mark_skipped(ids[1])

    assert _status(s, ids[1]) == "skipped"
    # finished_at is set (terminal) so a fresh attach won't restore a pending clock
    # and orphan_inflight (queued/running only) won't touch it.
    row = next(r for r in s.journal.executions() if r[0] == ids[1])
    assert row[11] is not None  # executions()[*][11] = finished_at
    # A done event with status "skipped" was broadcast so the client clears it
    # (event_from_message maps tithon.done -> kind "done").
    done = [e for e in events if e.get("kind") == "done"]
    assert any(e.get("payload", {}).get("status") == "skipped" for e in done)


def test_orphan_inflight_leaves_skipped_untouched(tmp_path):
    s = make_session(tmp_path)
    ids = s.submit_batch(
        [{"code": "ok\n"}, {"code": "rest\n"}], stop_on_error=True
    )
    s._mark_skipped(ids[1])
    s.journal.orphan_inflight()  # a restart must NOT re-animate a skipped cell
    assert _status(s, ids[1]) == "skipped"
