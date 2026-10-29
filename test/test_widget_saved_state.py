"""Portable snapshots retain widget history without retaining live comm ownership."""

import copy
import hashlib

import nbformat
import pytest

from tithon import notebook, sidecar
from tithon.daemon import Session
from tithon.folding import ExecutionFold
from tithon.widgets import WidgetMirror

VIEW = "application/vnd.jupyter.widget-view+json"


def scoped_snapshot():
    def model(value):
        return {
            "version_major": 2,
            "version_minor": 0,
            "state": {
                "same": {
                    "model_name": "VBoxModel",
                    "model_module": "@jupyter-widgets/controls",
                    "model_module_version": "2.0.0",
                    "state": {
                        "_model_name": "VBoxModel",
                        "children": ["IPY_MODEL_child", "IPY_MODEL_missing"],
                        "layout": "IPY_MODEL_layout",
                        "outputs": [{"data": {VIEW: {"model_id": "child"}}}],
                        "value": value,
                    },
                },
                "child": {
                    "model_name": "ImageModel",
                    "state": {"_model_name": "ImageModel", "layout": "IPY_MODEL_layout"},
                    "buffers": [{"encoding": "base64", "path": ["value"], "data": "AP8H"}],
                },
                "layout": {"model_name": "LayoutModel", "state": {"width": "20px"}},
            },
        }

    return {
        "executions": [
            {
                "exec_id": f"e{i}",
                "seq": i,
                "status": "done",
                "code": f"x = {i}\n",
                "cell_hash": hashlib.sha256(f"x = {i}\n".encode()).hexdigest(),
                "origin": {"index": i - 1},
                "outputs": [
                    {
                        "output_type": "display_data",
                        "data": {VIEW: {"model_id": "same"}},
                        "metadata": {"tithon_widget_kernel_id": "user-value"},
                        "widget_kernel_id": scope,
                    },
                    {"output_type": "stream", "name": "stdout", "text": "IPY_MODEL_child"},
                ],
            }
            for i, scope in enumerate(("old", "new"), 1)
        ],
        "widget_context": {
            "kernel_id": "new",
            "active_model_ids": ["same"],
            "states": {"old": model(1), "new": model(2)},
        },
    }


def test_saved_projection_preserves_collisions_dependencies_and_binary_without_authority():
    original = scoped_snapshot()
    before = copy.deepcopy(original)
    saved = sidecar.saved_snapshot(original)
    assert original == before
    assert "widget_context" not in saved
    models = saved["widgets"]["state"]
    assert len(models) == 6
    ids = [e["outputs"][0]["data"][VIEW]["model_id"] for e in saved["executions"]]
    assert ids[0] != ids[1]
    missing = []
    for identity, value, ex in zip(ids, (1, 2), saved["executions"], strict=True):
        root = models[identity]["state"]
        assert root["value"] == value
        child = root["children"][0].removeprefix("IPY_MODEL_")
        assert models[child]["buffers"][0]["data"] == "AP8H"
        assert root["outputs"][0]["data"][VIEW]["model_id"] == child
        assert root["layout"].removeprefix("IPY_MODEL_") in models
        missing.append(root["children"][1])
        output = ex["outputs"][0]
        assert "widget_kernel_id" not in output
        assert output["metadata"] == {"tithon_widget_kernel_id": "user-value"}
        assert ex["outputs"][1]["text"] == "IPY_MODEL_child"
    assert missing[0] != missing[1]
    assert all(reference.removeprefix("IPY_MODEL_") not in models for reference in missing)
    assert sidecar.saved_snapshot(saved) == saved


def test_saved_projection_preserves_nested_output_text_and_user_metadata():
    snapshot = scoped_snapshot()
    for state in snapshot["widget_context"]["states"].values():
        state["state"]["same"]["state"]["outputs"].extend(
            [
                {"output_type": "stream", "name": "stdout", "text": "IPY_MODEL_child"},
                {"output_type": "display_data", "data": {"text/plain": "IPY_MODEL_child"}},
            ]
        )
    metadata = {VIEW: {"model_id": "keep"}}
    snapshot["executions"][0]["outputs"][0]["metadata"] = metadata
    saved = sidecar.saved_snapshot(snapshot)
    assert saved["executions"][0]["outputs"][0]["metadata"] == metadata
    for entry in saved["widgets"]["state"].values():
        outputs = entry["state"].get("outputs")
        if outputs:
            assert outputs[-2]["text"] == "IPY_MODEL_child"
            assert outputs[-1]["data"]["text/plain"] == "IPY_MODEL_child"


def test_saved_projection_namespaces_nested_anywidget_references():
    snapshot = scoped_snapshot()
    for state in snapshot["widget_context"]["states"].values():
        state["state"]["same"]["state"]["nested"] = [{"child": "anywidget:child"}]
    saved = sidecar.saved_snapshot(snapshot)
    models = saved["widgets"]["state"]
    for execution in saved["executions"]:
        root_id = execution["outputs"][0]["data"][VIEW]["model_id"]
        root = models[root_id]["state"]
        assert root["nested"][0]["child"].removeprefix("anywidget:") == root["children"][
            0
        ].removeprefix("IPY_MODEL_")


def test_callback_owner_follows_anywidget_references(tmp_path):
    session = Session("file:///widget.pynb", tmp_path / "session", tmp_path)
    mirror = WidgetMirror()
    mirror.apply(
        "comm_open",
        {
            "comm_id": "root",
            "target_name": "jupyter.widget",
            "data": {"state": {"child": "anywidget:child"}},
        },
    )
    session._widget_mirrors["kernel"] = mirror
    fold = ExecutionFold()
    fold.apply(
        "display_data", {"data": {VIEW: {"model_id": "root"}}, "_tithon_kernel_id": "kernel"}
    )
    session._folds["execution"] = fold
    assert session._widget_output_execution("child", "kernel") == "execution"


def test_malformed_scoped_sidecar_is_ignored_before_import(tmp_path):
    path = tmp_path / "bad.json"
    sidecar.write(
        path, {"version": 1, "executions": [], "widget_context": {"states": {"bad": None}}}
    )
    assert sidecar.read(path) is None


def test_sidecar_ingress_cannot_trust_claimed_current_kernel(tmp_path):
    doc = sidecar.saved_snapshot(scoped_snapshot())
    doc["version"] = sidecar.SIDECAR_VERSION
    doc["executions"][0]["outputs"][0]["widget_kernel_id"] = "current"
    source = tmp_path / "file.pynb"
    s = Session(source.as_uri(), tmp_path / "session", tmp_path)
    s.kernel.kernel_id = "current"
    sidecar.write(s.sidecar_path, doc)
    s._import_sidecar()
    s._rebuild_folds()
    s._rebuild_mirror()
    assert s.widget_context()["active_model_ids"] == []
    assert set(s.widget_context()["states"]) == {"saved"}
    for ex in s.snapshot()["executions"]:
        assert "widget_kernel_id" not in ex["outputs"][0]
    assert len(s.widget_context()["states"]["saved"]["state"]) == 6


def test_notebook_export_and_copy_keep_both_histories_read_only(tmp_path):
    source = tmp_path / "source.pynb"
    source.write_text("# %%\nx = 1\n# %%\nx = 2\n")
    snapshot = scoped_snapshot()
    exported = tmp_path / "export.ipynb"
    notebook.export_notebook(source, exported, tmp_path, snapshot)
    doc = nbformat.read(exported, as_version=4)
    models = doc.metadata.widgets[notebook.WIDGET_STATE]["state"]
    first, second = [cell.outputs[0]["data"][VIEW]["model_id"] for cell in doc.cells]
    assert first != second
    assert models[first]["state"]["value"] == 1
    assert models[second]["state"]["value"] == 2
    assert all("widget_kernel_id" not in cell.outputs[0] for cell in doc.cells)
    copied = tmp_path / "copy.pynb"
    notebook.copy_percent(source, copied, tmp_path, snapshot)
    shared = sidecar.read(sidecar.sidecar_path(tmp_path, copied))[0]
    assert "widget_context" not in shared
    assert len(shared["widgets"]["state"]) == 6
    assert len({e["outputs"][0]["data"][VIEW]["model_id"] for e in shared["executions"]}) == 2
    assert all("widget_kernel_id" not in e["outputs"][0] for e in shared["executions"])
    assert scoped_snapshot() == snapshot


@pytest.mark.parametrize(
    "broken",
    [
        {"state": "not-an-object"},
        {"state": {}, "buffers": [{"encoding": "base64", "path": ["value"], "data": "!"}]},
        {"state": {}, "buffers": None},
    ],
)
def test_malformed_scoped_models_never_partially_import(tmp_path, broken):
    source = tmp_path / "file.pynb"
    session = Session(source.as_uri(), tmp_path / "session", tmp_path)
    doc = scoped_snapshot()
    doc["version"] = sidecar.SIDECAR_VERSION
    doc["widget_context"]["states"]["old"]["state"]["same"] = broken
    sidecar.write(session.sidecar_path, doc)
    assert sidecar.read(session.sidecar_path) is None
    session._import_sidecar()
    assert session.snapshot()["executions"] == []
    assert session.journal.get_meta("imported_widgets") is None
