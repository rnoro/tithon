"""Durable routing and conservative terminal state for daemon-crash recovery."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from test_clear import make_session
from tithon.folding import ExecutionFold


def _status(s, exec_id):
    return next(row[3] for row in s.journal.executions() if row[0] == exec_id)


def test_prepare_reattach_keeps_only_accepted_running_execution(tmp_path):
    s = make_session(tmp_path)
    s.journal.insert_execution("accepted", 1, "work()", allow_stdin=True)
    s.journal.mark_started("accepted", "msg-accepted")
    s.journal.append_message("accepted", "status", {"execution_state": "busy"})
    s.journal.insert_execution("sent-only", 2, "maybe()")
    s.journal.mark_started("sent-only", "msg-sent")
    s.journal.insert_execution("queued", 3, "later()")

    assert s.journal.prepare_reattach() == [("accepted", "msg-accepted", True)]
    assert _status(s, "accepted") == "running"
    assert _status(s, "sent-only") == "orphaned"
    assert _status(s, "queued") == "orphaned"
    done = s.journal.db.execute(
        "SELECT exec_id, content_json FROM messages WHERE msg_type='tithon.done' ORDER BY msg_seq"
    ).fetchall()
    assert [row[0] for row in done] == ["sent-only", "queued"]
    assert all(json.loads(row[1])["status"] == "orphaned" for row in done)


def test_prepare_reattach_legacy_running_row_is_not_guessed(tmp_path):
    s = make_session(tmp_path)
    s.journal.insert_execution("legacy", 1, "work()")
    s.journal.mark_started("legacy")
    s.journal.append_message("legacy", "status", {"execution_state": "busy"})

    assert s.journal.prepare_reattach() == []
    assert _status(s, "legacy") == "orphaned"


def test_pending_input_is_derived_from_durable_lifecycle(tmp_path):
    s = make_session(tmp_path)
    s.journal.insert_execution("e1", 1, "input()", allow_stdin=True)
    assert not s.journal.has_pending_input("e1")
    s.journal.append_message("e1", "tithon.input_request", {"prompt": "> "})
    assert s.journal.has_pending_input("e1")
    s.journal.append_message("e1", "tithon.input_resolved", {"exec_id": "e1"})
    assert not s.journal.has_pending_input("e1")


def test_finish_recovered_updates_row_and_done_event_together(tmp_path):
    s = make_session(tmp_path)
    s.journal.insert_execution("e1", 1, "work()")
    s.journal.mark_started("e1", "m1")

    finished, seq = s.journal.finish_recovered(
        "e1", "orphaned", json.dumps([{"output_type": "stream", "text": "tail"}])
    )

    row = next(row for row in s.journal.executions() if row[0] == "e1")
    assert row[3] == "orphaned"
    assert row[4] is None
    assert row[11] == finished
    event = s.journal.db.execute(
        "SELECT msg_type, content_json FROM messages WHERE msg_seq=?", (seq,)
    ).fetchone()
    assert event[0] == "tithon.done"
    assert json.loads(event[1])["status"] == "orphaned"


def test_raw_error_survives_a_cleared_fold_for_recovery_status(tmp_path):
    s = make_session(tmp_path)
    s.journal.insert_execution("e1", 1, "raise ValueError()")
    s.journal.mark_started("e1", "m1")
    s.journal.append_message("e1", "error", {"ename": "ValueError"})
    s.journal.append_message("e1", "clear_output", {"wait": False})

    assert s.journal.has_error("e1")


def test_live_kernel_probe_error_is_retried(tmp_path):
    async def main():
        s = make_session(tmp_path)
        attempts = 0

        def kernel_info():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("transient channel error")
            raise asyncio.CancelledError

        s.kc = SimpleNamespace(kernel_info=kernel_info)
        s.kernel.is_alive = lambda: True
        task = asyncio.create_task(s._recovery_probe())
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert attempts == 2

    asyncio.run(main())


def test_control_probe_status_is_null_exec_and_never_folds(tmp_path):
    s = make_session(tmp_path)

    async def main():
        idle = asyncio.Event()
        s._control_fences["probe"] = {"busy": False, "idle": idle}
        s._handle_iopub(
            {
                "header": {"msg_type": "status"},
                "parent_header": {"msg_id": "probe"},
                "content": {"execution_state": "busy"},
            }
        )
        s._handle_iopub(
            {
                "header": {"msg_type": "status"},
                "parent_header": {"msg_id": "probe"},
                "content": {"execution_state": "idle"},
            }
        )
        assert idle.is_set()

    asyncio.run(main())
    rows = s.journal.messages_after(0)
    assert [(row[1], row[2]) for row in rows] == [(None, "status"), (None, "status")]
    assert s._folds == {}


def test_exec_worker_waits_for_recovery_gate_before_dequeue(tmp_path):
    s = make_session(tmp_path)

    async def main():
        s._recovery_gate = asyncio.Event()
        s._queue.put_nowait(([("e1", "pass")], False, False))
        called = asyncio.Event()

        async def fake_run(*_args):
            called.set()
            return "ok"

        s._run_one = fake_run
        worker = asyncio.create_task(s._exec_worker())
        await asyncio.sleep(0)
        assert not called.is_set()
        s._recovery_gate.set()
        await asyncio.wait_for(called.wait(), 1.0)
        worker.cancel()
        try:
            await worker
        except asyncio.CancelledError:
            pass

    asyncio.run(main())


def test_allow_stdin_execution_is_interrupted_only_with_unresolved_prompt(tmp_path):
    async def run_case(name: str, pending: bool) -> int:
        case_dir = tmp_path / name
        case_dir.mkdir()
        s = make_session(case_dir)
        s.journal.insert_execution("e1", 1, "work()", allow_stdin=True)
        s.journal.mark_started("e1", "m1")
        if pending:
            s.journal.append_message(
                "e1", "tithon.input_request", {"prompt": "> ", "password": False}
            )
        s._folds["e1"] = ExecutionFold()
        s._msgid_to_exec["m1"] = "e1"
        s._recovery_gate = asyncio.Event()
        interrupts = 0

        def interrupt():
            nonlocal interrupts
            interrupts += 1
            return True

        async def probe():
            return None

        s.kernel.interrupt = interrupt
        s._recovery_probe = probe
        await s._recover_inflight("e1", "m1", True)
        assert _status(s, "e1") == "orphaned"
        assert s._recovery_gate.is_set()
        return interrupts

    async def main():
        assert await run_case("no-prompt", False) == 0
        assert await run_case("pending-prompt", True) == 1

    asyncio.run(main())
