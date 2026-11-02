"""Saved widget state: default-trait omission and the plain-text alternative."""

import asyncio
import copy
import json
from pathlib import Path

import nbformat
from test_current_outputs import add, execution
from test_feature_processes import host as host
from test_feature_processes import run
from websockets.asyncio.client import unix_connect

from tithon import notebook, sidecar
from tithon.daemon import Session

FIXTURE = Path(__file__).parent.parent / "extension/test/fixtures/tqdm_widget_state.json"
ROOT = "0552c8589ebe4644a9ecce646ea6e147"  # the fixture's HBox


def tqdm_widgets():
    return json.loads(FIXTURE.read_text())


def widget_doc(widgets, text="  0%|          | 0/5"):
    view = {"model_id": ROOT, "version_major": 2, "version_minor": 0}
    output = {
        "output_type": "display_data",
        "metadata": {},
        "data": {sidecar.WIDGET_VIEW: view, "text/plain": text},
    }
    return {"version": 2, "cells": [{"outputs": [output]}], "widgets": widgets}


def test_compaction_round_trips_every_trait_value():
    widgets = tqdm_widgets()
    compact = sidecar.compact_widgets(widgets)
    layouts = [m for m in compact["state"].values() if m["model_name"] == "LayoutModel"]
    assert layouts and all(m["state"] == {} for m in layouts)
    assert len(sidecar.dumps({"widgets": compact})) * 3 < len(json.dumps(widgets, indent=1))
    expanded = sidecar.expand_widgets(compact)
    for identifier, model in widgets["state"].items():
        restored = expanded["state"][identifier]
        assert restored.keys() == model.keys()
        for key, value in model["state"].items():
            assert sidecar._same_json(restored["state"][key], value), (identifier, key)
    assert sidecar.compact_widgets(expanded) == compact


def test_renderer_fixture_matches_daemon_compaction():
    compact = FIXTURE.with_name("tqdm_widget_state.compact.json")
    assert json.loads(compact.read_text()) == sidecar.compact_widgets(tqdm_widgets())


def test_compaction_keeps_what_the_renderer_would_not_fill_in():
    progress = {
        "model_module": "@jupyter-widgets/controls",
        "model_name": "FloatProgressModel",
        "model_module_version": "2.0.0",
        "state": {"value": 0, "max": 100, "description": "", "orientation": 0},
        "buffers": [],
    }
    image = {
        "model_module": "@jupyter-widgets/controls",
        "model_name": "ImageModel",
        "model_module_version": "2.0.0",
        "state": {"value": {}, "format": "png", "width": ""},
        "buffers": [{"path": ["value"], "encoding": "base64", "data": ""}],
    }
    custom = {**copy.deepcopy(progress), "model_module": "custom-widgets"}
    future = {**copy.deepcopy(progress), "model_module_version": "3.0.0"}
    renamed = copy.deepcopy(progress)
    renamed["state"]["_model_name"] = "IntProgressModel"
    flag = copy.deepcopy(progress)
    flag["state"] = {"description_allow_html": 0}
    widgets = {
        "state": {
            "p": progress,
            "i": image,
            "c": custom,
            "f": future,
            "r": renamed,
            "b": flag,
        }
    }
    compact = sidecar.compact_widgets(widgets)["state"]
    # 0 == 0.0 for the renderer, but a non-default type is information.
    assert compact["p"]["state"] == {"orientation": 0}
    assert compact["i"]["state"] == {"value": {}}  # a binary placeholder is never a default
    for kept in ("c", "f", "r"):
        assert compact[kept] == widgets["state"][kept]
    assert compact["b"]["state"] == {"description_allow_html": 0}  # 0 is not false


def test_text_mode_saves_the_final_state_and_no_widget_state():
    doc = sidecar.text_widgets(widget_doc(tqdm_widgets()))
    assert "widgets" not in doc
    (output,) = doc["cells"][0]["outputs"]
    assert output["data"] == {"text/plain": sidecar.widget_text(ROOT, tqdm_widgets())}
    assert output["data"]["text/plain"].startswith("100% |" + "█" * 20 + "| 50000/50000")


def test_text_mode_falls_back_and_drops_output_widget_views():
    missing = sidecar.text_widgets(widget_doc({"state": {}}, text=["  0%", "|"]))
    assert missing["cells"][0]["outputs"][0]["data"] == {"text/plain": "  0%|"}
    output_area = {
        "state": {
            ROOT: {
                "model_module": "@jupyter-widgets/output",
                "model_name": "OutputModel",
                "state": {"_model_name": "OutputModel", "outputs": []},
            }
        }
    }
    assert sidecar.text_widgets(widget_doc(output_area))["cells"][0]["outputs"] == []


def test_text_mode_keeps_outputs_held_in_output_widget_state():
    widgets = tqdm_widgets()
    nested_view = {"model_id": ROOT, "version_major": 2, "version_minor": 0}
    widgets["state"]["area"] = {
        "model_module": "@jupyter-widgets/output",
        "model_name": "OutputModel",
        "state": {
            "_model_name": "OutputModel",
            "outputs": [
                {"output_type": "stream", "name": "stdout", "text": "appended\n"},
                {
                    "output_type": "display_data",
                    "metadata": {},
                    "data": {sidecar.WIDGET_VIEW: nested_view},
                },
                {
                    "output_type": "display_data",
                    "metadata": {},
                    "data": {sidecar.WIDGET_VIEW: {"model_id": "area"}},
                },
            ],
        },
    }
    doc = widget_doc(widgets)
    doc["cells"][0]["outputs"][0]["data"][sidecar.WIDGET_VIEW]["model_id"] = "area"
    outputs = sidecar.text_widgets(doc)["cells"][0]["outputs"]
    assert outputs[0]["text"] == "appended\n"
    assert outputs[1]["data"]["text/plain"].startswith("100% |")
    assert len(outputs) == 2  # a self-reference cannot recurse


def test_text_mode_keeps_the_final_selection_or_the_original_text():
    widgets = {
        "state": {
            "pick": {
                "state": {
                    "_model_name": "DropdownModel",
                    "description": "device",
                    "_options_labels": ["cpu", "gpu"],
                    "index": 1,
                }
            },
            "many": {
                "state": {
                    "_model_name": "SelectMultipleModel",
                    "_options_labels": ["a", "b", "c"],
                    "index": [0, 2],
                }
            },
            "button": {"state": {"_model_name": "ButtonModel", "description": ""}},
        }
    }
    assert sidecar.widget_text("pick", widgets) == "device gpu"
    assert sidecar.widget_text("many", widgets) == "a, c"
    assert sidecar.widget_text("button", widgets) is None
    doc = widget_doc(widgets, text="Button(style=ButtonStyle())")
    doc["cells"][0]["outputs"][0]["data"][sidecar.WIDGET_VIEW]["model_id"] = "button"
    data = sidecar.text_widgets(doc)["cells"][0]["outputs"][0]["data"]
    assert data == {"text/plain": "Button(style=ButtonStyle())"}


def test_widget_text_describes_controls_and_custom_models():
    widgets = {
        "state": {
            "box": {
                "state": {"_model_name": "VBoxModel", "children": ["IPY_MODEL_s", "IPY_MODEL_x"]}
            },
            "s": {"state": {"_model_name": "IntSliderModel", "description": "epochs", "value": 5}},
            "x": {"state": {"_model_name": "Map", "_model_module": "leaflet", "value": 1}},
        }
    }
    assert sidecar.widget_text("box", widgets) == "epochs 5 [Map (leaflet)]"
    assert sidecar.widget_text("absent", widgets) is None


def test_session_choice_persists_and_imported_files_are_not_rewritten(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    source = work / "shared.pynb"
    code = "run()\n"
    source.write_text("# %%\n" + code)
    path = sidecar.sidecar_path(work, source)
    doc = sidecar.build([execution(1, code)], source.read_text())
    doc["widgets"] = tqdm_widgets()
    doc["cells"][0]["outputs"] = widget_doc(None)["cells"][0]["outputs"]
    sidecar.write(path, doc)
    pulled = path.read_bytes()
    loaded = sidecar.read(path)[0]
    assert loaded["widgets"] == sidecar.expand_widgets(sidecar.compact_widgets(tqdm_widgets()))

    session = Session(source.as_uri(), tmp_path / "session", work)
    try:
        assert session.save_widget_state
        session._import_sidecar()
        session.set_save_widget_state(False)
        assert path.read_bytes() == pulled  # opening a colleague's file must not churn git
        add(session, execution(2, code, text="local"))
        session.set_save_widget_state(True)
        session.set_save_widget_state(False)
        assert json.loads(path.read_text())["cells"][0]["outputs"][0]["text"] == "local"
    finally:
        session.journal.close()
    reopened = Session(source.as_uri(), tmp_path / "session", work)
    try:
        assert reopened.save_widget_state is False
    finally:
        reopened.journal.close()


def test_offline_refresh_and_interchange_follow_the_choice(tmp_path):
    work = tmp_path
    source = work / "offline.pynb"
    code = "run()\n"
    source.write_text("# %%\n" + code)
    path = sidecar.sidecar_path(work, source)
    doc = sidecar.build([execution(1, code)], source.read_text())
    doc["widgets"] = tqdm_widgets()
    doc["cells"][0]["outputs"] = widget_doc(None)["cells"][0]["outputs"]
    sidecar.write(path, doc)

    assert sidecar.refresh_file(work, source)  # None keeps the file's form
    assert json.loads(path.read_text())["widgets"]["state"]
    exported = work / "with_state.ipynb"
    notebook.export_notebook(source, exported, work)
    state = nbformat.read(exported, as_version=4).metadata["widgets"][notebook.WIDGET_STATE]
    assert {m["model_name"] for m in state["state"].values()} >= {"HBoxModel", "LayoutModel"}

    text_export = work / "text.ipynb"
    notebook.export_notebook(source, text_export, work, save_widget_state=False)
    result = nbformat.read(text_export, as_version=4)
    assert "widgets" not in result.metadata
    assert result.cells[0].outputs[0]["data"]["text/plain"].startswith("100% |")
    copied = work / "copy.pynb"
    notebook.copy_percent(source, copied, work, save_widget_state=False)
    assert "widgets" not in json.loads(sidecar.sidecar_path(work, copied).read_text())
    imported = work / "imported.pynb"
    notebook.import_notebook(exported, imported, work, save_widget_state=False)
    shared = json.loads(sidecar.sidecar_path(work, imported).read_text())
    assert "widgets" not in shared
    assert shared["cells"][0]["outputs"][0]["data"]["text/plain"].startswith("100% |")

    assert sidecar.refresh_file(work, source, False)
    saved = json.loads(path.read_text())
    assert "widgets" not in saved
    assert saved["cells"][0]["outputs"][0]["data"]["text/plain"].startswith("100% |")


async def attach_with(sock, sid, work, save_widget_state):
    async with unix_connect(str(sock), max_size=None) as ws:
        message = {
            "op": "attach",
            "session": sid,
            "workdir": str(work),
            "last_seen_seq": -1,
            "save_widget_state": save_widget_state,
        }
        await ws.send(json.dumps(message))
        while json.loads(await asyncio.wait_for(ws.recv(), 60))["op"] not in ("sync", "error"):
            pass


def test_real_daemon_tqdm_widget_follows_the_attached_choice(host):
    root, work, env, start = host
    start()
    sock = root / "home/daemon.sock"
    source = work / "progress.pynb"
    code = "import tqdm.notebook as tqdm\nfor _ in tqdm.tqdm(range(3)):\n    pass\n"
    source.write_text("# %%\n" + code)
    sid = source.as_uri()
    path = sidecar.sidecar_path(work, source)

    asyncio.run(attach_with(sock, sid, work, False))
    run(env, "run", "--session", sid, "-c", code)
    saved = json.loads(path.read_text())
    assert "widgets" not in saved
    (output,) = [o for o in saved["cells"][0]["outputs"] if o.get("output_type") == "display_data"]
    assert sidecar.WIDGET_VIEW not in output["data"]
    assert output["data"]["text/plain"].startswith("100% |" + "█" * 20 + "| 3/3")

    asyncio.run(attach_with(sock, sid, work, True))  # republishes this machine's outputs
    saved = json.loads(path.read_text())
    models = saved["widgets"]["state"]
    layouts = [m for m in models.values() if m["model_name"] == "LayoutModel"]
    assert len(layouts) == 4 and all(m["state"] == {} for m in layouts)
    (bar,) = [m for m in models.values() if m["model_name"] == "FloatProgressModel"]
    assert bar["state"]["value"] == 3 and bar["state"]["bar_style"] == "success"
    full = sidecar.read(path)[0]["widgets"]["state"]
    assert all(len(m["state"]) > 20 for m in full.values() if m["model_name"] == "LayoutModel")
