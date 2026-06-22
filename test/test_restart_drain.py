"""Kernel restart drains the exec queue (bug-hunt: stale queued cells).

When a cell is running and more cells are queued behind it, clicking "Restart
Kernel" must NOT run those queued cells on the fresh kernel. restart_kernel
orphans the in-flight/queued executions in the journal AND drops the waiting
batches from the queue; otherwise the new worker would pick them up and re-run
(and re-journal) cells the user just asked to abandon. These cover the queue +
journal surface without a live kernel (restart_kernel itself spawns a kernel).
"""
from __future__ import annotations

from tithon.daemon import Session


def make_session(tmp_path) -> Session:
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return Session("default", tmp_path / "sess", work)


def _status(s: Session, exec_id: str) -> str | None:
    for row in s.journal.executions():
        if row[0] == exec_id:
            return row[3]
    return None


def test_drain_queue_drops_waiting_batches(tmp_path):
    s = make_session(tmp_path)
    s.submit_batch([{"code": "a\n", "origin": {"index": 0}}], stop_on_error=False)
    s.submit_batch([{"code": "b\n", "origin": {"index": 1}}], stop_on_error=False)
    assert s._queue.qsize() == 2

    dropped = s._drain_queue()

    assert dropped == 2
    assert s._queue.qsize() == 0


def test_drain_queue_empty_is_a_noop(tmp_path):
    s = make_session(tmp_path)
    assert s._drain_queue() == 0


def test_restart_semantics_orphan_then_drain(tmp_path):
    """The restart sequence (orphan_inflight + _drain_queue) leaves the queued
    cells terminal-orphaned and removed from the queue, so the fresh worker has
    nothing stale to run."""
    s = make_session(tmp_path)
    ids = s.submit_batch(
        [{"code": "a\n", "origin": {"index": 0}},
         {"code": "b\n", "origin": {"index": 1}}],
        stop_on_error=False,
    )
    # The restart path runs these two steps before spawning the new kernel.
    s.journal.orphan_inflight()
    dropped = s._drain_queue()

    assert dropped == 1                       # one batch item held both cells
    assert s._queue.qsize() == 0
    for exec_id in ids:                       # never run again; not a pending clock
        assert _status(s, exec_id) == "orphaned"
