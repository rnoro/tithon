"""Historical widget state never grants ownership of an active kernel comm."""

import asyncio
import json
import os

import pytest

from tithon.daemon import Session, Subscriber
from tithon.folding import ExecutionFold
from tithon.journal import event_from_message
from tithon.kernel import KernelHandle
from tithon.sidecar import saved_snapshot


def session(tmp_path):
    return Session("default", tmp_path / "session", tmp_path)


def opened(value):
    return {
        "comm_id": "same",
        "target_name": "jupyter.widget",
        "data": {"state": {"_model_name": "IntProgressModel", "value": value}},
    }


def value(context, scope):
    return context["states"][scope]["state"]["same"]["state"]["value"]


def test_reused_comm_id_keeps_historical_state_and_replays(tmp_path):
    s = session(tmp_path)
    s.kernel.kernel_id = "kernel-one"
    s._handle_comm(None, "comm_open", opened(1), [])
    s.kernel.kernel_id = "kernel-two"
    s._handle_comm(None, "comm_open", opened(2), [])
    s._handle_comm(
        None,
        "comm_msg",
        {"comm_id": "same", "data": {"method": "update", "state": {"value": 3}}},
        [],
    )
    context = s.widget_context()
    assert value(context, "kernel-one") == 1
    assert value(context, "kernel-two") == 3
    assert context["active_model_ids"] == ["same"]
    rebuilt = session(tmp_path)
    rebuilt.kernel.kernel_id = "kernel-two"
    rebuilt._rebuild_mirror()
    assert rebuilt.widget_context() == context
    rebuilt.kernel.kernel_id = "kernel-three"
    assert rebuilt.widget_context()["active_model_ids"] == []


def test_unknown_current_comm_cannot_patch_history(tmp_path):
    s = session(tmp_path)
    s.kernel.kernel_id = "old"
    s._handle_comm(None, "comm_open", opened(7), [])
    s.kernel.kernel_id = "new"
    before = s.journal.max_seq()
    s._handle_comm(
        None,
        "comm_msg",
        {"comm_id": "same", "data": {"method": "update", "state": {"value": 8}}},
        [],
    )
    assert s.journal.max_seq() == before
    assert value(s.widget_context(), "old") == 7
    assert s.widget_context()["active_model_ids"] == []


def test_failed_open_does_not_create_active_scope(tmp_path, monkeypatch):
    s = session(tmp_path)
    s.kernel.kernel_id = "new"

    def fail(*args, **kwargs):
        raise OSError("unavailable journal")

    monkeypatch.setattr(s.journal, "append_message", fail)
    with pytest.raises(OSError):
        s._handle_comm(None, "comm_open", opened(3), [])
    assert s.widget_context()["states"] == {}
    assert s.widget_context()["active_model_ids"] == []


def test_imported_and_untagged_models_are_read_only(tmp_path):
    s = session(tmp_path)
    s.journal.append_message(None, "comm_open", opened(1))
    state = {"version_major": 2, "version_minor": 0, "state": {"same": {"state": {"value": 9}}}}
    s.journal.set_meta("imported_widgets", json.dumps(state))
    s.kernel.kernel_id = "current"
    s._rebuild_mirror()
    assert value(s.widget_context(), "legacy") == 1
    assert value(s.widget_context(), "saved") == 9
    assert "current" not in s.widget_context()["states"]
    assert s.widget_context()["active_model_ids"] == []


@pytest.mark.parametrize("kind", ["display_data", "execute_result"])
def test_output_scope_survives_fold_seed_and_metadata_is_unchanged(kind):
    fold = ExecutionFold()
    content = {
        "data": {"application/vnd.jupyter.widget-view+json": {"model_id": "same"}},
        "metadata": {"tithon_widget_kernel_id": "user-owned"},
        "_tithon_kernel_id": "old",
        "transient": {"display_id": "view"},
    }
    fold.apply(kind, content)
    assert fold.outputs()[0]["widget_kernel_id"] == "old"
    assert fold.outputs()[0]["metadata"] == content["metadata"]
    hydrated = ExecutionFold.hydrate(fold.outputs(), fold.fold_state())
    assert hydrated.outputs() == fold.outputs()
    if kind == "display_data":
        fold.apply("update_display_data", {**content, "_tithon_kernel_id": "new"})
        assert fold.outputs()[0]["widget_kernel_id"] == "new"


def test_actual_process_identity_survives_new_handle_and_changes_with_connection(tmp_path):
    kernel = KernelHandle(tmp_path, tmp_path, tmp_path / "kernel.log")
    kernel.conn_file.write_text(json.dumps({"key": "first-private-key"}))
    identity = kernel._identity(os.getpid())
    another = KernelHandle(tmp_path, tmp_path, tmp_path / "kernel.log")
    assert another._identity(os.getpid()) == identity
    kernel.conn_file.write_text(json.dumps({"key": "second-private-key"}))
    assert another._identity(os.getpid()) != identity
    assert "private-key" not in identity


def test_empty_connection_key_is_supported_without_changing_live_connection(tmp_path):
    kernel = KernelHandle(tmp_path, tmp_path, tmp_path / "kernel.log")
    original = json.dumps({"key": "", "shell_port": 10000})
    kernel.conn_file.write_text(original)
    identity = kernel._identity(os.getpid())
    assert kernel._identity(os.getpid()) == identity
    assert kernel.conn_file.read_text() == original
    kernel.conn_file.write_text(json.dumps({"key": "", "shell_port": 10001}))
    assert kernel._identity(os.getpid()) != identity
    kernel.conn_file.write_text(json.dumps({"key": None}))
    with pytest.raises(ValueError):
        kernel._identity(os.getpid())


def test_comm_scope_is_identical_in_live_and_replay_events(tmp_path):
    s = session(tmp_path)
    s.kernel.kernel_id = "current"
    sub = Subscriber(asyncio.Queue(maxsize=10))
    s._subs.add(sub)
    s._handle_comm(None, "comm_open", opened(4), [])
    live = sub.queue.get_nowait()
    assert live["payload"]["_tithon_kernel_id"] == "current"
    seq, exec_id, kind, raw = s.journal.messages_after(0)[0]
    assert event_from_message(seq, exec_id, kind, json.loads(raw)) == live


def test_legacy_live_updates_remain_read_only_and_do_not_touch_imports(tmp_path):
    s = session(tmp_path)
    s.journal.append_message(None, "comm_open", opened(1))
    saved = {"version_major": 2, "version_minor": 0, "state": {"same": {"state": {"value": 99}}}}
    s.journal.set_meta("imported_widgets", json.dumps(saved))
    s.kernel.kernel_id = "surviving"
    s.kernel.reattached = True
    s._rebuild_mirror()
    sub = Subscriber(asyncio.Queue(maxsize=10))
    s._subs.add(sub)
    update = {"comm_id": "same", "data": {"method": "update", "state": {"value": 5}}}
    s._handle_comm(None, "comm_msg", update, [])
    context = s.widget_context()
    assert value(context, "legacy") == 5
    assert value(context, "saved") == 99
    assert context["active_model_ids"] == []
    assert context["legacy_kernel_id"] == "surviving"
    display = {"data": {"application/vnd.jupyter.widget-view+json": {"model_id": "same"}}}
    assert s._widget_display_scope(display) == "legacy"
    live = sub.queue.get_nowait()
    assert live["payload"]["_tithon_kernel_id"] == "legacy"
    assert live["payload"]["_tithon_legacy_kernel_id"] == "surviving"
    rows = s.journal.messages_after(0)
    seq, exec_id, kind, raw = rows[-1]
    assert event_from_message(seq, exec_id, kind, json.loads(raw)) == live
    rebuilt = session(tmp_path)
    rebuilt.kernel.kernel_id = "surviving"
    rebuilt.kernel.reattached = True
    rebuilt._rebuild_mirror()
    assert rebuilt.widget_context() == context
    rebuilt.kernel.kernel_id = "replacement"
    rebuilt.kernel.reattached = True
    rebuilt._rebuild_mirror()
    assert rebuilt.widget_context()["legacy_kernel_id"] == "surviving"
    assert rebuilt._widget_display_scope(display) == "replacement"
    before = rebuilt.journal.max_seq()
    rebuilt._handle_comm(None, "comm_msg", update, [])
    assert rebuilt.journal.max_seq() == before
    assert value(rebuilt.widget_context(), "legacy") == 5


def test_fresh_kernel_cannot_later_adopt_legacy_history(tmp_path):
    s = session(tmp_path)
    s.journal.append_message(None, "comm_open", opened(1))
    s.kernel.kernel_id = "fresh"
    s.kernel.reattached = False
    s._rebuild_mirror()
    assert s.widget_context()["legacy_kernel_id"] is None
    s.kernel.reattached = True
    s._rebuild_mirror()
    assert not s._legacy_widget_live()
    assert s.widget_context()["active_model_ids"] == []


def test_raw_legacy_display_replay_and_fold_have_same_scope():
    content = {"data": {"application/vnd.jupyter.widget-view+json": {"model_id": "same"}}}
    fold = ExecutionFold()
    fold.apply("display_data", content)
    assert fold.outputs()[0]["widget_kernel_id"] == "legacy"
    event = event_from_message(1, "e1", "display_data", content)
    assert event["payload"]["content"]["_tithon_kernel_id"] == "legacy"
    assert "_tithon_kernel_id" not in content


def test_legacy_seed_annotation_never_relabels_imported_outputs(tmp_path):
    s = session(tmp_path)
    output = {
        "output_type": "display_data",
        "data": {"application/vnd.jupyter.widget-view+json": {"model_id": "same"}},
        "metadata": {},
    }
    for seq, eid in enumerate(("e1", "e2"), 1):
        s.journal.insert_execution(eid, seq, "pass")
        s.journal.mark_done(eid, "done", seq, json.dumps([output]))
    s.journal.db.execute("UPDATE executions SET imported=1 WHERE exec_id='e2'")
    s.journal.set_meta(
        "output_seed",
        json.dumps(
            {
                "seq": 0,
                "folds": {eid: {"outputs": [output], "state": {}} for eid in ("e1", "e2")},
                "display_registry": {},
            }
        ),
    )
    s._rebuild_folds()
    assert s._folds["e1"].outputs()[0]["widget_kernel_id"] == "legacy"
    assert "widget_kernel_id" not in s._folds["e2"].outputs()[0]


def test_failed_legacy_update_does_not_mutate_any_scope(tmp_path, monkeypatch):
    s = session(tmp_path)
    s.journal.append_message(None, "comm_open", opened(1))
    s.kernel.kernel_id = "surviving"
    s.kernel.reattached = True
    s._rebuild_mirror()
    before = s.widget_context()

    def fail(*args, **kwargs):
        raise OSError("unavailable journal")

    monkeypatch.setattr(s.journal, "append_message", fail)
    with pytest.raises(OSError):
        s._handle_comm(
            None,
            "comm_msg",
            {"comm_id": "same", "data": {"method": "update", "state": {"value": 2}}},
            [],
        )
    assert s.widget_context() == before


def test_migrated_kernel_keeps_new_and_legacy_graphs_together_until_replacement(tmp_path):
    s = session(tmp_path)
    s.journal.append_message(None, "comm_open", opened(1))
    s.journal.append_message(
        None,
        "comm_open",
        {
            "comm_id": "old-box",
            "target_name": "jupyter.widget",
            "data": {"state": {"_model_name": "VBoxModel", "children": []}},
        },
    )
    s.kernel.kernel_id = "surviving"
    s.kernel.reattached = True
    s._rebuild_mirror()
    s._handle_comm(
        None,
        "comm_open",
        {
            "comm_id": "new-box",
            "target_name": "jupyter.widget",
            "data": {"state": {"_model_name": "VBoxModel", "children": ["IPY_MODEL_same"]}},
        },
        [],
    )
    child = opened(2)
    child["comm_id"] = "new-child"
    s._handle_comm(None, "comm_open", child, [])
    s._handle_comm(
        None,
        "comm_msg",
        {
            "comm_id": "old-box",
            "data": {"method": "update", "state": {"children": ["IPY_MODEL_new-child"]}},
        },
        [],
    )
    context = s.widget_context()
    assert set(context["states"]["legacy"]["state"]) == {"same", "old-box", "new-box", "new-child"}
    assert "surviving" not in context["states"]
    assert context["active_model_ids"] == []
    for root in ("new-box", "old-box"):
        content = {"data": {"application/vnd.jupyter.widget-view+json": {"model_id": root}}}
        assert s._widget_display_scope(content) == "legacy"
    snapshot = {
        "executions": [
            {
                "outputs": [
                    {
                        "output_type": "display_data",
                        "data": {"application/vnd.jupyter.widget-view+json": {"model_id": root}},
                        "widget_kernel_id": "legacy",
                    }
                    for root in ("new-box", "old-box")
                ]
            }
        ],
        "widget_context": context,
    }
    saved = saved_snapshot(snapshot)
    models = saved["widgets"]["state"]
    outputs = saved["executions"][0]["outputs"]
    for output, expected in zip(outputs, (1, 2), strict=True):
        root = output["data"]["application/vnd.jupyter.widget-view+json"]["model_id"]
        ref = models[root]["state"]["children"][0].removeprefix("IPY_MODEL_")
        assert models[ref]["state"]["value"] == expected
    s.kernel.kernel_id = "replacement"
    s.kernel.reattached = False
    s._handle_comm(None, "comm_open", opened(99), [])
    replaced = s.widget_context()
    assert value(replaced, "legacy") == 1
    assert value(replaced, "replacement") == 99
    assert replaced["active_model_ids"] == ["same"]
    snapshot["widget_context"] = replaced
    saved_again = saved_snapshot(snapshot)
    assert saved_again["executions"] == saved["executions"]
    for identifier, model in models.items():
        assert saved_again["widgets"]["state"][identifier] == model
    rebuilt = session(tmp_path)
    rebuilt.kernel.kernel_id = "replacement"
    rebuilt.kernel.reattached = True
    rebuilt._rebuild_mirror()
    assert rebuilt.widget_context() == replaced
