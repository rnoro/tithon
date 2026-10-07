"""Compaction preserves restart seeds and delta correctness, including rollback."""

import json
import sqlite3
from collections import Counter

import pytest

from tithon import retention
from tithon.daemon import Session
from tithon.folding import ExecutionFold


def session(tmp_path, **policy):
    return Session("default", tmp_path / "session", tmp_path / "project", **policy)


def add(s, eid, seq):
    s.journal.insert_execution(eid, seq, f"code{seq}", cell_hash=f"hash{seq}")
    s._folds[eid] = ExecutionFold()
    s.journal.mark_done(eid, "done", seq, "[]")


def emit(s, eid, kind, content, target=None):
    seq = s.journal.append_message(eid, kind, content, target_exec=target)
    s._folds[target or eid].apply(kind, content)
    if kind == "display_data":
        s._register_display(eid, content)
    if kind.startswith("comm_"):
        s._mirror.apply(kind, content)
    return seq


def reopen(s):
    s.journal.close()
    rebuilt = Session(s.session_id, s.session_dir, s.artifacts.workdir)
    rebuilt._rebuild_folds()
    rebuilt._rebuild_mirror()
    return rebuilt


def test_disabled_does_not_change_rows(tmp_path):
    s = session(tmp_path)
    add(s, "e1", 1)
    emit(s, "e1", "stream", {"name": "stdout", "text": "a\r"})
    assert retention.compact(s, now=10**12) == 0
    assert s.journal.get_meta("output_seed") is None
    assert len(s.journal.messages_after(0)) == 1
    s.journal.close()


def test_restart_preserves_state_and_replays_new_rows_once(tmp_path):
    s = session(tmp_path, history_retention_days=1)
    add(s, "e1", 1)
    add(s, "e2", 2)
    emit(s, "e1", "stream", {"name": "stdout", "text": "abcdef\r"})
    emit(
        s,
        "e1",
        "display_data",
        {"data": {"text/plain": "old"}, "transient": {"display_id": "plot"}},
    )
    emit(
        s,
        "e2",
        "update_display_data",
        {"data": {"text/plain": "latest"}, "transient": {"display_id": "plot"}},
        "e1",
    )
    emit(
        s,
        "e1",
        "comm_open",
        {"comm_id": "w", "target_name": "jupyter.widget", "data": {"state": {"value": 9}}},
    )
    emit(
        s,
        "e1",
        "comm_msg",
        {"comm_id": "w", "data": {"method": "update", "state": {"msg_id": "request"}}},
    )
    emit(s, "e1", "clear_output", {"wait": True})
    high = s.journal.max_seq()
    expected = {eid: (f.outputs(), f.fold_state()) for eid, f in s._folds.items()}
    assert retention.compact(s, now=10**12) == 4
    assert s.journal.max_seq() == high
    assert int(s.journal.get_meta("history_floor")) == high
    assert [r[2] for r in s.journal.messages_after(0)] == ["comm_open", "comm_msg"]
    # Later writes update mutable folded_json; the checkpoint must stay immutable.
    emit(s, "e2", "stream", {"name": "stdout", "text": "new"})
    s.journal.set_folded("e2", json.dumps(s._folds["e2"].outputs()))
    expected["e2"] = (s._folds["e2"].outputs(), s._folds["e2"].fold_state())
    rebuilt = reopen(s)
    assert {eid: (f.outputs(), f.fold_state()) for eid, f in rebuilt._folds.items()} == expected
    assert rebuilt._display_registry == {"plot": "e1"}
    assert rebuilt._mirror.snapshot()["state"]["w"]["state"]["value"] == 9
    # The cursor survives hydration, so appending replaces the first character.
    rebuilt._folds["e2"].apply("stream", {"name": "stdout", "text": "!"})
    assert rebuilt._folds["e2"].outputs()[0]["text"] == "new!"
    assert rebuilt.journal.append_message("e2", "stream", {"text": "next"}) > high
    rebuilt.journal.close()


def test_seed_stream_cursor_survives_cr_and_backspace(tmp_path):
    s = session(tmp_path, history_target_mib=0.000001)
    add(s, "e1", 1)
    emit(s, "e1", "stream", {"name": "stdout", "text": "abcdef\rXY\b"})
    retention.compact(s)
    rebuilt = reopen(s)
    rebuilt._folds["e1"].apply("stream", {"name": "stdout", "text": "!"})
    assert rebuilt._folds["e1"].outputs()[0]["text"] == "X!cdef"
    rebuilt.journal.close()


def test_transaction_failure_rolls_back_seed_watermark_and_deletion(tmp_path):
    s = session(tmp_path, history_retention_days=1)
    add(s, "e1", 1)
    emit(s, "e1", "stream", {"text": "keep"})
    s.journal.db.execute(
        "CREATE TRIGGER refuse_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'disk failure'); END"
    )
    with pytest.raises(sqlite3.IntegrityError, match="disk failure"):
        retention.compact(s, now=10**12)
    assert s.journal.get_meta("history_floor") is None
    assert s.journal.get_meta("output_seed") is None
    assert s.journal.get_meta("history_cleanup") is None
    assert s.journal.executions()[0][5] == "[]"
    assert len(s.journal.messages_after(0)) == 1
    s.journal.close()


@pytest.mark.parametrize(
    "guard", ["busy", "queued", "recovering", "restarting", "killed", "input", "running"]
)
def test_compaction_defers_unsafe_states(tmp_path, guard):
    s = session(tmp_path, history_target_mib=0.000001)
    add(s, "e1", 1)
    emit(s, "e1", "stream", {"text": "keep"})
    if guard == "queued":
        s._queue.put_nowait({})
    elif guard == "input":
        s._pending_input = {"prompt": "?"}
    elif guard == "running":
        s.journal.db.execute("UPDATE executions SET status='running'")
    else:
        setattr(s, "_" + guard, True)
    assert retention.compact(s) == 0
    assert s.journal.get_meta("output_seed") is None
    s.journal.close()


def test_age_then_size_remove_oldest_only(tmp_path):
    s = session(tmp_path, history_retention_days=1)
    add(s, "e1", 1)
    for _ in range(15):
        emit(
            s,
            "e1",
            "display_data",
            {"data": {"text/plain": "x" * 1000}, "transient": {"display_id": "p"}},
        )
    s.journal.db.execute("UPDATE messages SET ts=0 WHERE msg_seq=1")
    assert retention.compact(s) == 1
    baseline = retention.storage(s)["logical_bytes"]
    s.history_target_mib = (baseline - 2200) / 1048576
    assert 1 <= retention.compact(s) < 14
    remaining = s.journal.messages_after(0)
    assert remaining[-1][0] == 15
    first_floor = int(s.journal.get_meta("history_floor"))
    s.history_target_mib = 0.000001
    assert retention.compact(s) == len(remaining)
    assert int(s.journal.get_meta("history_floor")) > first_floor
    assert s.journal.max_seq() == 15
    assert retention.storage(s)["target_exceeded"]
    s.journal.close()


def test_image_reference_survives_gc_and_storage_missing_is_not_zero(tmp_path):
    import base64

    s = session(tmp_path, history_retention_days=1)
    add(s, "e1", 1)
    content = {"data": {"image/png": base64.b64encode(b"image bytes").decode()}}
    refs = s.artifacts.extract("e1", content)
    emit(s, "e1", "display_data", content)
    s._artifact_refs = Counter(refs)
    assert retention.storage(s)["referenced_image_bytes"] == 11
    assert retention.compact(s, now=10**12) == 1
    rebuilt = reopen(s)
    assert rebuilt.read_artifact(refs[0])["found"]
    row = rebuilt.journal.find_artifact(refs[0])
    (rebuilt.artifacts.workdir / row[3]).unlink()
    assert retention.storage(rebuilt)["referenced_image_bytes"] is None
    assert retention.storage(rebuilt)["missing_images"] == 1
    rebuilt.journal.close()


@pytest.mark.parametrize("value", [-1, "nan", "inf", "bad"])
def test_policy_rejects_invalid_numbers(value):
    with pytest.raises(ValueError):
        retention.nonnegative(value)
