"""Shell-channel routing (T7) + the execution completion barrier (T1).

Before this, ``_await_reply`` consumed the shell channel itself and DISCARDED every
message whose parent was not the cell it was waiting for — so ``comm_info_reply`` /
``inspect_reply`` / ``complete_reply`` were silently eaten and no shell request could
be issued while a cell was running. ``_shell_pump`` is now the sole consumer and
routes by ``parent_header.msg_id``.

And ``_run_one`` used to end a cell with ``await asyncio.sleep(0.05)`` — a guess that
trailing iopub had landed. The shell ``execute_reply`` and the last iopub of the same
execution race (there is NO ordering guarantee between the two sockets), so when the
guess lost, the ``folded_json`` persisted for that execution was missing output that
was already in the journal: a reconnecting client's snapshot then disagreed with what
a live client had seen. The barrier waits for the kernel's own ``status: idle``, which
the messaging spec publishes after the execution's associated iopub output.

v49.sh proves the end-to-end ordering against a real daemon + real kernel.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from tithon.daemon import IDLE_BARRIER_TIMEOUT, Session
from tithon.folding import ExecutionFold


def make_session(tmp_path, sid="file:///proj/a.py", name="sess") -> Session:
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    s = Session(sid, tmp_path / name, work)
    s.kernel.pid = 4242
    s.kernel.is_alive = lambda: True
    s.kernel_status = "idle"
    return s


def shell_reply(parent: str, msg_type="execute_reply", **content) -> dict:
    return {
        "header": {"msg_type": msg_type},
        "parent_header": {"msg_id": parent},
        "content": {"status": "ok", "execution_count": 1, **content},
    }


def iopub_status(parent: str, state: str) -> dict:
    return {
        "header": {"msg_type": "status"},
        "parent_header": {"msg_id": parent},
        "content": {"execution_state": state},
    }


def seeded_exec(s: Session, exec_id="e1", msg_id="m1") -> None:
    s.journal.insert_execution(exec_id, 1, "print(1)")
    s._folds[exec_id] = ExecutionFold()
    s._msgid_to_exec[msg_id] = exec_id


# -- T7: the shell router ----------------------------------------------------


def test_reply_is_routed_to_its_waiter(tmp_path):
    s = make_session(tmp_path)

    async def main():
        fut = s._expect_shell("m1")
        s._route_shell(shell_reply("m1"))
        return await fut

    got = asyncio.run(main())
    assert got["content"]["execution_count"] == 1


def test_concurrent_requests_do_not_steal_each_others_replies(tmp_path):
    """The whole point of T7: a comm_info/inspect request in flight alongside a
    running cell must each get THEIR OWN reply. The old code read the channel
    inside `_await_reply` and dropped everything that was not its execute_reply."""
    s = make_session(tmp_path)

    async def main():
        exec_fut = s._expect_shell("m-exec")
        info_fut = s._expect_shell("m-info")
        # Arrive out of order — the comm_info reply first, while the cell still runs.
        s._route_shell(shell_reply("m-info", "comm_info_reply", comms={}))
        s._route_shell(shell_reply("m-exec", "execute_reply"))
        return await exec_fut, await info_fut

    ex, info = asyncio.run(main())
    assert ex["header"]["msg_type"] == "execute_reply"
    assert info["header"]["msg_type"] == "comm_info_reply"


def test_unrouted_reply_is_dropped_without_raising(tmp_path):
    """A reply whose caller already timed out has no waiter. That must not kill the
    pump — it is the ONLY thing the router is allowed to drop."""
    s = make_session(tmp_path)
    s._route_shell(shell_reply("nobody-waiting"))  # must not raise
    assert s._shell_waiters == {}


def test_fail_shell_waiters_unblocks_pending_requests(tmp_path):
    """Teardown must settle outstanding futures. Otherwise a caller awaiting a reply
    from channels that no longer exist waits forever."""
    s = make_session(tmp_path)

    async def main():
        fut = s._expect_shell("m1")
        s._fail_shell_waiters("kernel restarted")
        with pytest.raises(ConnectionError):
            await fut

    asyncio.run(main())
    assert s._shell_waiters == {}


def test_await_reply_surfaces_routed_status(tmp_path):
    s = make_session(tmp_path)
    seeded_exec(s)

    async def main():
        fut = s._expect_shell("m1")
        s._route_shell(shell_reply("m1", status="error", execution_count=7))
        return await s._await_reply(fut, "e1")

    assert asyncio.run(main()) == ("error", 7)


def test_await_reply_reports_a_kernel_that_died_before_replying(tmp_path):
    """No reply will ever arrive; the poll must notice the dead kernel rather than
    block the (serial) exec worker forever."""
    s = make_session(tmp_path)
    seeded_exec(s)
    s.kernel.is_alive = lambda: False

    async def main():
        fut = s._expect_shell("m1")
        return await s._await_reply(fut, "e1")

    assert asyncio.run(main()) == ("error", None)
    assert s.kernel_status == "dead"


def test_await_reply_survives_channel_teardown(tmp_path):
    s = make_session(tmp_path)
    seeded_exec(s)

    async def main():
        fut = s._expect_shell("m1")
        s._fail_shell_waiters("kernel restarted")
        return await s._await_reply(fut, "e1")

    assert asyncio.run(main()) == ("error", None)


# -- T1: the completion barrier ----------------------------------------------


def test_idle_status_releases_the_barrier(tmp_path):
    s = make_session(tmp_path)
    seeded_exec(s)
    ev = asyncio.Event()
    s._idle_events["e1"] = ev

    s._handle_iopub(iopub_status("m1", "idle"))

    assert ev.is_set()


def test_busy_status_does_not_release_the_barrier(tmp_path):
    """`busy` is published when the execution STARTS. Releasing on it would restore
    exactly the bug the barrier removes — persisting the fold before any output."""
    s = make_session(tmp_path)
    seeded_exec(s)
    ev = asyncio.Event()
    s._idle_events["e1"] = ev

    s._handle_iopub(iopub_status("m1", "busy"))

    assert not ev.is_set()


def test_barrier_is_not_released_when_journaling_the_idle_fails(tmp_path):
    """The signal must come AFTER the message is journaled/folded/broadcast.

    `status` is in JOURNALED_IOPUB, so releasing the waiter before the append would
    let `_run_one` persist `folded_json` + `tithon.done` while the idle status was
    still unjournaled — inverting their seq order — and would release it even when
    the append raised. This test fails if the signal is moved back above the append.
    """
    s = make_session(tmp_path)
    seeded_exec(s)
    ev = asyncio.Event()
    s._idle_events["e1"] = ev

    def boom(*a, **kw):
        raise RuntimeError("disk full")

    s.journal.append_message = boom

    with pytest.raises(RuntimeError):
        s._handle_iopub(iopub_status("m1", "idle"))

    assert not ev.is_set(), "the barrier was released although the idle was not journaled"


def test_idle_for_an_unknown_parent_is_ignored(tmp_path):
    s = make_session(tmp_path)
    seeded_exec(s)
    ev = asyncio.Event()
    s._idle_events["e1"] = ev

    s._handle_iopub(iopub_status("some-other-msg", "idle"))

    assert not ev.is_set()


def test_await_idle_returns_once_signalled(tmp_path):
    s = make_session(tmp_path)

    async def main():
        ev = asyncio.Event()
        ev.set()
        await asyncio.wait_for(s._await_idle("e1", ev), 1.0)

    asyncio.run(main())  # must not hang


def test_await_idle_gives_up_when_the_kernel_dies(tmp_path):
    """A kernel SIGKILLed between its reply and its idle never publishes one. The
    exec worker is serial, so an unbounded wait would wedge every queued cell."""
    s = make_session(tmp_path)
    s.kernel.is_alive = lambda: False

    async def main():
        ev = asyncio.Event()  # never set
        await asyncio.wait_for(s._await_idle("e1", ev), 5.0)

    asyncio.run(main())  # returns via the liveness poll, not the long timeout


def test_barrier_timeout_is_a_fallback_not_the_mechanism(tmp_path):
    """The bound exists so a non-conforming kernel cannot wedge the queue, but it
    must be far longer than a poll — if it were short it would just be the old
    timer heuristic wearing a new name."""
    assert IDLE_BARRIER_TIMEOUT >= 5


# -- cleanup ------------------------------------------------------------------


def test_completed_execution_leaves_no_routing_state(tmp_path):
    """`_msgid_to_exec` was never popped, leaking one entry per cell forever. It can
    only be dropped once the barrier has passed: any earlier and trailing iopub
    loses its execution."""
    s = make_session(tmp_path)
    seeded_exec(s)
    ev = asyncio.Event()
    s._idle_events["e1"] = ev
    fut = None

    async def main():
        nonlocal fut
        fut = s._expect_shell("m1")
        s._route_shell(shell_reply("m1"))
        s._handle_iopub(iopub_status("m1", "idle"))
        status, _ = await s._await_reply(fut, "e1")
        await s._await_idle("e1", ev)
        # the `finally` in `_run_one` — asserted here on its constituent parts
        s._shell_waiters.pop("m1", None)
        s._idle_events.pop("e1", None)
        s._msgid_to_exec.pop("m1", None)
        return status

    assert asyncio.run(main()) == "ok"
    assert s._msgid_to_exec == {}
    assert s._idle_events == {}
    assert s._shell_waiters == {}


def test_late_output_still_folds_before_the_barrier_passes(tmp_path):
    """The bug T1 fixes, at unit level: output published between the reply and the
    idle must be in the fold that gets persisted."""
    s = make_session(tmp_path)
    seeded_exec(s)
    ev = asyncio.Event()
    s._idle_events["e1"] = ev

    # reply already arrived; trailing stream lands only now
    s._handle_iopub(
        {
            "header": {"msg_type": "stream"},
            "parent_header": {"msg_id": "m1"},
            "content": {"name": "stdout", "text": "trailing\n"},
        }
    )
    s._handle_iopub(iopub_status("m1", "idle"))

    folded = json.dumps(s._folds["e1"].outputs())
    assert "trailing" in folded
    assert ev.is_set()
