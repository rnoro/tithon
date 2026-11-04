"""The kernel's ``In [n]`` is known from ``execute_input``, when the cell STARTS.

A client attaching while a cell still runs reads the count from the snapshot,
and a live client reads it from the broadcast ``execute_input`` event; neither
may have to wait for ``execute_reply``, which a dead kernel never sends.
"""

from __future__ import annotations

import asyncio

from tithon.daemon import Session, Subscriber
from tithon.folding import ExecutionFold


def make_session(tmp_path) -> Session:
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return Session("default", tmp_path / "sess", work)


def start_exec(s: Session, exec_id: str) -> None:
    s.journal.insert_execution(exec_id, 1, "x = 1")
    s.journal.mark_started(exec_id)
    s._folds[exec_id] = ExecutionFold()
    s._msgid_to_exec[f"m-{exec_id}"] = exec_id


def execute_input(s: Session, exec_id: str, count: int) -> None:
    s._handle_iopub(
        {
            "header": {"msg_type": "execute_input"},
            "parent_header": {"msg_id": f"m-{exec_id}"},
            "content": {"code": "x = 1", "execution_count": count},
        }
    )


def snapshot_count(s: Session, exec_id: str) -> int | None:
    return next(e for e in s._execution_snapshots() if e["exec_id"] == exec_id)["execution_count"]


def test_a_running_cell_reports_its_count_before_it_finishes(tmp_path):
    s = make_session(tmp_path)
    start_exec(s, "a")
    sub = Subscriber(asyncio.Queue(maxsize=10))
    s._subs.add(sub)

    execute_input(s, "a", 7)

    assert snapshot_count(s, "a") == 7
    live = sub.queue.get_nowait()
    assert (live["exec_id"], live["kind"], live["payload"]["msg_type"]) == (
        "a",
        "output",
        "execute_input",
    )
    assert live["payload"]["content"]["execution_count"] == 7
    replay = [(e, t) for _seq, e, t, _c in s.journal.messages_after(0)]
    assert replay == [("a", "execute_input")]
    assert s._folds["a"].outputs() == []


def test_a_run_without_a_reply_keeps_the_count_execute_input_set(tmp_path):
    s = make_session(tmp_path)
    start_exec(s, "a")
    execute_input(s, "a", 3)

    s.journal.mark_done("a", "error", None, "[]")

    assert snapshot_count(s, "a") == 3


def test_a_recovered_run_keeps_its_count(tmp_path):
    s = make_session(tmp_path)
    start_exec(s, "a")
    execute_input(s, "a", 4)

    s.journal.finish_recovered("a", "orphaned", "[]")

    assert snapshot_count(s, "a") == 4
