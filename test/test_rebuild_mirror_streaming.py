"""RISKS #9a: `_rebuild_mirror` must not materialize or parse non-comm rows.
`Journal.comm_messages_after` filters by `msg_type` in SQL and returns a
lazily-iterated cursor (no `.fetchall()`), so a session with a long
stream/output history (a tqdm/print loop) restarts in time proportional to
its widget traffic, not its total message count."""
from tithon.daemon import Session


def make_session(tmp_path) -> Session:
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return Session("default", tmp_path / "sess", work)


def test_rebuild_mirror_never_parses_non_comm_rows(tmp_path):
    s = make_session(tmp_path)
    s.journal.append_message("e1", "stream", {"name": "stdout", "text": "hello\n"})
    # Deliberately malformed JSON, inserted directly (bypassing append_message's
    # own json.dumps, which would never produce this). If _rebuild_mirror ever
    # fetched and parsed this row, json.loads would raise — proving the SQL
    # msg_type filter, not a Python-side skip, is what excludes it.
    s.journal.db.execute(
        "INSERT INTO messages(session_id, exec_id, msg_type, content_json, ts)"
        " VALUES(?,?,?,?,?)",
        ("default", "e1", "stream", "{not valid json", 0.0),
    )
    s._handle_comm("e1", "comm_open", {
        "comm_id": "c1", "target_name": "jupyter.widget",
        "data": {"state": {"_model_name": "X", "value": 1}},
    }, [])

    # A fresh Session reopening the same journal — simulates a daemon restart.
    s2 = Session("default", tmp_path / "sess", tmp_path / "work")
    s2._rebuild_mirror()  # must not raise on the malformed non-comm row

    assert s2._mirror.snapshot()["state"]["c1"]["state"]["value"] == 1


def test_comm_messages_after_filters_and_orders(tmp_path):
    s = make_session(tmp_path)
    s.journal.append_message("e1", "stream", {"name": "stdout", "text": "a\n"})
    seq_open = s.journal.append_message("e1", "comm_open", {
        "comm_id": "c1", "target_name": "jupyter.widget", "data": {"state": {"value": 1}},
    })
    s.journal.append_message("e1", "execute_result", {"data": {"text/plain": "1"}})
    seq_msg = s.journal.append_message("e1", "comm_msg", {
        "comm_id": "c1", "data": {"method": "update", "state": {"value": 2}},
    })

    rows = list(s.journal.comm_messages_after(0))
    assert [r[0] for r in rows] == [seq_open, seq_msg]  # non-comm rows excluded, order preserved
    assert [r[2] for r in rows] == ["comm_open", "comm_msg"]

    # `seq` cursor semantics match messages_after: only rows AFTER the given seq.
    rows_after_open = list(s.journal.comm_messages_after(seq_open))
    assert [r[0] for r in rows_after_open] == [seq_msg]
