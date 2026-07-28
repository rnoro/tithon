"""Unit tests for the Widget State Mirror (SPEC.md).

Deterministic, no kernel: exercises comm_open/comm_msg/comm_close interpretation,
the widget-state+json snapshot shape, and binary-buffer handling (which tqdm's
FloatProgress does not exercise — covered live by scripts/v5.sh).
"""
import base64

from tithon.widgets import WidgetMirror, is_comm


def _open(comm_id, state, target="jupyter.widget", buffer_paths=None, buffers=None):
    content = {
        "comm_id": comm_id,
        "target_name": target,
        "data": {"state": state, "buffer_paths": buffer_paths or []},
    }
    return ("comm_open", content, buffers or [])


def test_comm_open_creates_model_and_snapshot_shape():
    m = WidgetMirror()
    ok = m.apply(*_open("c1", {
        "_model_name": "FloatProgressModel",
        "_model_module": "@jupyter-widgets/controls",
        "_model_module_version": "2.0.0",
        "value": 0.0, "max": 50000.0, "min": 0.0,
    }))
    assert ok and len(m) == 1
    snap = m.snapshot()
    assert snap["version_major"] == 2 and snap["version_minor"] == 0
    entry = snap["state"]["c1"]
    assert entry["model_name"] == "FloatProgressModel"
    assert entry["model_module"] == "@jupyter-widgets/controls"
    assert entry["model_module_version"] == "2.0.0"
    assert entry["state"]["value"] == 0.0
    assert entry["buffers"] == []


def test_comm_msg_update_patches_state():
    m = WidgetMirror()
    m.apply(*_open("c1", {"_model_name": "FloatProgressModel", "value": 0.0, "max": 50000.0}))
    # simulate tqdm progressing to completion: value == max == total
    m.apply("comm_msg", {"comm_id": "c1", "data": {"method": "update", "state": {"value": 50000.0}}}, [])
    assert m.snapshot()["state"]["c1"]["state"]["value"] == 50000.0


def test_echo_update_also_patches():
    m = WidgetMirror()
    m.apply(*_open("c1", {"_model_name": "X", "value": 1}))
    m.apply("comm_msg", {"comm_id": "c1", "data": {"method": "echo_update", "state": {"value": 2}}}, [])
    assert m.snapshot()["state"]["c1"]["state"]["value"] == 2


def test_custom_messages_do_not_change_state():
    m = WidgetMirror()
    m.apply(*_open("c1", {"_model_name": "X", "value": 1}))
    changed = m.apply("comm_msg", {"comm_id": "c1", "data": {"method": "custom", "content": {"k": "v"}}}, [])
    assert changed is False
    assert m.snapshot()["state"]["c1"]["state"]["value"] == 1


def test_non_widget_comm_is_ignored():
    m = WidgetMirror()
    changed = m.apply(*_open("c1", {"_model_name": "X"}, target="some.other.target"))
    assert changed is False
    assert len(m) == 0


def test_comm_close_removes_model():
    m = WidgetMirror()
    m.apply(*_open("c1", {"_model_name": "X"}))
    assert m.apply("comm_close", {"comm_id": "c1"}, []) is True
    assert len(m) == 0
    # closing an unknown comm is a no-op
    assert m.apply("comm_close", {"comm_id": "nope"}, []) is False


def test_binary_buffers_kept_out_of_json_state_and_base64_in_snapshot():
    payload = b"\x89PNG\x00\x01\x02binary-not-utf8\xff"
    m = WidgetMirror()
    m.apply(*_open(
        "img",
        {"_model_name": "ImageModel", "_model_module": "@jupyter-widgets/controls",
         "_model_module_version": "2.0.0", "format": "png"},
        buffer_paths=[["value"]],
        buffers=[payload],
    ))
    entry = m.snapshot()["state"]["img"]
    # buffer is NOT inside the JSON state (schema keeps it separate)
    assert "value" not in entry["state"]
    assert entry["buffers"][0]["encoding"] == "base64"
    assert entry["buffers"][0]["path"] == ["value"]
    assert base64.b64decode(entry["buffers"][0]["data"]) == payload


def test_buffer_replaced_by_update():
    m = WidgetMirror()
    m.apply(*_open("img", {"_model_name": "ImageModel"}, buffer_paths=[["value"]], buffers=[b"old"]))
    m.apply(
        "comm_msg",
        {"comm_id": "img", "data": {"method": "update", "state": {}, "buffer_paths": [["value"]]}},
        [b"new-bytes"],
    )
    entry = m.snapshot()["state"]["img"]
    assert base64.b64decode(entry["buffers"][0]["data"]) == b"new-bytes"


def test_is_comm_helper():
    assert is_comm("comm_open") and is_comm("comm_msg") and is_comm("comm_close")
    assert not is_comm("stream") and not is_comm("status")


def test_would_accept_agrees_with_apply_without_mutating():
    """would_accept (RISKS #14: lets a caller journal before mutating) must
    predict apply()'s accept/reject exactly, and never mutate the mirror."""
    m = WidgetMirror()
    _, open_content, _ = _open("c1", {"_model_name": "X", "value": 1})

    # comm_open: accepted target/id predicts True, and calling it is a no-op.
    assert m.would_accept("comm_open", open_content) is True
    assert len(m) == 0  # no mutation from the prediction alone
    _, wrong_target, _ = _open("c1", {"_model_name": "X"}, target="some.other.target")
    assert m.would_accept("comm_open", wrong_target) is False
    assert m.would_accept("comm_open", {"target_name": "jupyter.widget"}) is False  # no comm_id

    m.apply("comm_open", open_content, [])

    # comm_msg: known id + update method predicts True; unknown id or a
    # non-state-changing method predicts False. Either way, no mutation yet.
    good_msg = {"comm_id": "c1", "data": {"method": "update", "state": {"value": 2}}}
    assert m.would_accept("comm_msg", good_msg) is True
    assert m.snapshot()["state"]["c1"]["state"]["value"] == 1  # unmutated
    assert m.would_accept("comm_msg", {"comm_id": "nope", "data": {"method": "update"}}) is False
    custom_msg = {"comm_id": "c1", "data": {"method": "custom"}}
    assert m.would_accept("comm_msg", custom_msg) is False

    m.apply("comm_msg", good_msg, [])
    assert m.snapshot()["state"]["c1"]["state"]["value"] == 2

    # comm_close: known id predicts True, unknown id predicts False.
    assert m.would_accept("comm_close", {"comm_id": "c1"}) is True
    assert m.would_accept("comm_close", {"comm_id": "nope"}) is False
    assert len(m) == 1  # still unmutated by the predictions


def test_malformed_state_is_rejected_not_raised():
    """Codex ② finding (RISKS #14 review): a JSON-legal but schema-malformed
    comm (e.g. `state` is a string, not a dict) must be REJECTED by both
    would_accept() and apply() — never raise. Pre-fix, apply() would raise
    (`dict("garbage")`), and since RISKS #14 made _handle_comm journal BEFORE
    mutating, a would_accept() that didn't also catch this would let such a
    message get durably journaled — then _rebuild_mirror would re-raise on
    EVERY future restart replaying that same row."""
    m = WidgetMirror()
    bad_open = {"comm_id": "c1", "target_name": "jupyter.widget", "data": {"state": "not-a-dict"}}
    assert m.would_accept("comm_open", bad_open) is False
    assert m.apply("comm_open", bad_open, []) is False
    assert len(m) == 0

    bad_paths = {
        "comm_id": "c2", "target_name": "jupyter.widget",
        "data": {"state": {"value": 1}, "buffer_paths": [42]},  # not path-shaped
    }
    assert m.would_accept("comm_open", bad_paths) is False
    assert m.apply("comm_open", bad_paths, []) is False
    assert len(m) == 0

    m.apply("comm_open", {"comm_id": "c3", "target_name": "jupyter.widget",
                           "data": {"state": {"value": 1}}}, [])
    bad_update = {"comm_id": "c3", "data": {"method": "update", "state": [1, 2, 3]}}
    assert m.would_accept("comm_msg", bad_update) is False
    assert m.apply("comm_msg", bad_update, []) is False
    assert m.snapshot()["state"]["c3"]["state"]["value"] == 1  # unchanged, not partially mutated
