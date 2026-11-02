"""Portable outputs grow with the current notebook, not its execution history."""

import asyncio
import hashlib
import json
import shutil

import pytest
from test_feature_processes import attach, request
from test_feature_processes import host as host

from tithon import sidecar
from tithon.daemon import Session
from tithon.folding import ExecutionFold


def execution(seq, code, index=0, text="current", status="done"):
    return {
        "exec_id": f"e{seq}",
        "seq": seq,
        "code": code,
        "cell_hash": hashlib.sha256(code.encode()).hexdigest(),
        "origin": {"index": index, "range": {"start": index * 2, "end": index * 2 + 1}},
        "status": status,
        "execution_count": seq,
        "outputs": []
        if text is None
        else [{"output_type": "stream", "name": "stdout", "text": text}],
    }


def add(session, ex):
    session.journal.insert_execution(
        ex["exec_id"],
        ex["seq"],
        ex["code"],
        origin={**ex["origin"], "uri": session.session_id},
        cell_hash=ex["cell_hash"],
    )
    fold = ExecutionFold.hydrate(ex["outputs"])
    session._folds[ex["exec_id"]] = fold
    session.journal.mark_done(
        ex["exec_id"], ex["status"], ex["execution_count"], json.dumps(ex["outputs"])
    )


def test_repeated_publication_is_bounded_and_clone_needs_no_original_journal(tmp_path):
    work = tmp_path / "original"
    work.mkdir()
    source = work / "train.pynb"
    code = "print('current')\n"
    source.write_text("# %%\n" + code)
    session = Session(source.as_uri(), tmp_path / "local-session", work)
    sizes = []
    try:
        for i in range(1, 101):
            add(session, execution(i, code))
            assert session._publish_sidecar()
            raw = session.sidecar_path.read_bytes()
            doc = json.loads(raw)
            records = doc.get("cells", doc.get("executions"))
            assert len(records) == 1
            sizes.append(len(raw))
        assert not {"code", "exec_id", "seq", "started_at", "finished_at"} & records[0].keys()
        assert max(sizes) - min(sizes) <= 2
        assert session.journal.count_local_executions() == 100
        clone = tmp_path / "clone"
        shutil.copytree(work, clone)
        restored = Session((clone / source.name).as_uri(), tmp_path / "new-session", clone)
        try:
            restored._import_sidecar()
            restored._rebuild_folds()
            rows = restored.snapshot()["executions"]
            assert len(rows) == 1 and rows[0]["execution_count"] == 100
            assert rows[0]["outputs"][0]["text"] == "current"
            assert rows[0]["code"] == ""
            assert restored.journal.count_local_executions() == 0
        finally:
            restored.journal.close()
    finally:
        session.journal.close()


@pytest.mark.parametrize("status,text", [("error", "failed"), ("done", None)])
def test_new_failure_or_empty_output_replaces_old_success(status, text):
    code = "value = 1\n"
    saved = sidecar.build(
        [execution(1, code, text="old"), execution(2, code, status=status, text=text)],
        "# %%\n" + code,
    )
    assert len(saved["cells"]) == 1
    assert saved["cells"][0]["status"] == status
    assert saved["cells"][0]["outputs"] == execution(2, code, text=text)["outputs"]


def test_deleted_newer_cell_cannot_overwrite_a_surviving_moved_cell():
    a, b = "a = 1\n", "b = 2\n"
    saved = sidecar.build([execution(1, b, 1, "B"), execution(2, a, 0, "A")], "# %%\n" + b)
    assert len(saved["cells"]) == 1
    assert saved["cells"][0]["outputs"][0]["text"] == "B"


def test_reverted_source_does_not_resurrect_an_older_exact_execution():
    a, b = "a = 1\n", "b = 2\n"
    saved = sidecar.build([execution(1, a), execution(2, b)], "# %%\n" + a)
    assert saved["cells"] == []


def test_legacy_read_refresh_and_future_version(tmp_path):
    source = tmp_path / "legacy.pynb"
    code = "value = 1\n"
    source.write_text("# %%\n" + code)
    path = sidecar.sidecar_path(tmp_path, source)
    sidecar.write(path, {"version": 1, "executions": [execution(1, code), execution(2, code)]})
    assert sidecar.read(path)[0]["version"] == 1
    assert sidecar.refresh_file(tmp_path, source)
    doc = json.loads(path.read_text())
    assert doc["version"] == 2 and len(doc["cells"]) == 1
    assert "code" not in doc["cells"][0]
    source.write_text("")
    assert sidecar.refresh_file(tmp_path, source)
    assert json.loads(path.read_text())["cells"] == []
    sidecar.write(path, {"version": 999, "cells": []})
    assert sidecar.read(path) is None


@pytest.mark.parametrize("change", ["missing", "invalid"])
def test_failed_source_projection_preserves_saved_bytes_and_sha(tmp_path, change):
    source = tmp_path / "train.pynb"
    code = "value = 1\n"
    source.write_text("# %%\n" + code)
    session = Session(source.as_uri(), tmp_path / "session", tmp_path)
    try:
        add(session, execution(1, code))
        assert session._publish_sidecar()
        before = session.sidecar_path.read_bytes()
        sha = session.journal.get_meta("sidecar_sha")
        if change == "missing":
            source.unlink()
        else:
            source.write_text("# %%\nx = '''unterminated")
        assert not session._publish_sidecar()
        assert session.sidecar_path.read_bytes() == before
        assert session.journal.get_meta("sidecar_sha") == sha
    finally:
        session.journal.close()


def test_widget_projection_keeps_reachable_graph_only():
    view = sidecar.WIDGET_VIEW
    code = "display(widget)\n"
    ex = execution(1, code)
    ex["outputs"] = [{"output_type": "display_data", "data": {view: {"model_id": "root"}}}]
    doc = sidecar.build([ex], "# %%\n" + code)
    doc["widgets"] = {
        "version_major": 2,
        "version_minor": 0,
        "state": {
            "root": {"state": {"children": ["IPY_MODEL_child"], "other": "anywidget:other"}},
            "child": {
                "state": {
                    "parent": "IPY_MODEL_root",
                    "outputs": [{"data": {view: {"model_id": "nested"}}}],
                }
            },
            "other": {
                "state": {},
                "buffers": [{"encoding": "base64", "path": ["value"], "data": "AP8H"}],
            },
            "nested": {"state": {}},
            "retired": {"state": {"value": "obsolete"}},
        },
    }
    pruned = sidecar.prune_widgets(doc)
    assert set(pruned["widgets"]["state"]) == {"root", "child", "other", "nested"}
    assert "retired" in doc["widgets"]["state"]
    pruned["cells"][0]["outputs"] = []
    assert sidecar.prune_widgets(pruned)["widgets"]["state"] == {}


def test_save_refresh_protocol_does_not_create_a_session_or_kernel(host):
    root, work, env, start = host
    start()
    source = work / "offline.pynb"
    code = "value = 1\n"
    source.write_text("# %%\n" + code)
    path = sidecar.sidecar_path(work, source)
    sidecar.write(path, sidecar.build([execution(1, code)]))
    source.write_text("# %%\nchanged = 2\n")
    reply = asyncio.run(
        request(
            root / "home/daemon.sock",
            {"op": "refresh_outputs", "source": str(source), "workdir": str(work)},
        )
    )
    assert reply == {"op": "outputs_refreshed", "ok": True}
    assert json.loads(path.read_text())["cells"] == []
    status = asyncio.run(request(root / "home/daemon.sock", {"op": "status"}))
    assert status["sessions"] == []
    assert not list((root / "home").rglob("kernel.pid"))


def test_live_save_refresh_keeps_journal_and_restores_latest_result(host):
    root, work, env, start = host
    start()
    source = work / "live.pynb"
    code = "print('current')\n"
    source.write_text("# %%\n" + code)
    sock = root / "home/daemon.sock"
    sid = source.as_uri()
    asyncio.run(attach(sock, sid, work))
    from test_feature_processes import run

    for _ in range(2):
        run(env, "run", "--session", sid, "-c", code)
    path = sidecar.sidecar_path(work, source)
    assert len(json.loads(path.read_text())["cells"]) == 1
    source.write_text("# %%\nchanged = 2\n")
    reply = asyncio.run(
        request(sock, {"op": "refresh_outputs", "source": str(source), "workdir": str(work)})
    )
    assert reply["ok"]
    assert json.loads(path.read_text())["cells"] == []
    assert len(asyncio.run(attach(sock, sid, work))[0]["executions"]) == 2


@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"])
def test_save_added_final_newline_does_not_drop_a_new_cell_output(newline):
    code = "print('fresh')"
    saved = sidecar.build([execution(1, code)], "# %%" + newline + code + newline)
    assert len(saved["cells"]) == 1
    cell = saved["cells"][0]
    assert cell["outputs"][0]["text"] == "current"
    assert cell["cell_hash"] == hashlib.sha256((code + newline).encode()).hexdigest()
    assert "code" not in cell


@pytest.mark.parametrize("publish", [False, True])
def test_import_only_restart_reprojects_changed_source_even_with_same_published_sha(
    tmp_path, publish
):
    source = tmp_path / "imported.pynb"
    code = "value = 1\n"
    source.write_text("# %%\n" + code)
    path = sidecar.sidecar_path(tmp_path, source)
    sidecar.write(path, sidecar.build([execution(1, code)]))
    session = Session(source.as_uri(), tmp_path / "session", tmp_path)
    session._import_sidecar()
    session._rebuild_folds()
    assert session.journal.count_executions() == 1
    source.write_text("# %%\nchanged = 2\n")
    if publish:
        assert session._publish_sidecar()
    session.journal.close()
    restored = Session(source.as_uri(), tmp_path / "session", tmp_path)
    try:
        restored._import_sidecar()
        restored._rebuild_folds()
        assert restored.snapshot()["executions"] == []
        assert restored.journal.count_local_executions() == 0
    finally:
        restored.journal.close()


def test_v1_missing_cell_hash_is_derived_from_legacy_code_before_projection(tmp_path):
    source = tmp_path / "legacy.pynb"
    code = "value = 1\n"
    source.write_text("# %%\n" + code)
    ex = execution(1, code)
    del ex["cell_hash"]
    path = sidecar.sidecar_path(tmp_path, source)
    sidecar.write(path, {"version": 1, "executions": [ex]})
    assert sidecar.refresh_file(tmp_path, source)
    saved = json.loads(path.read_text())
    assert len(saved["cells"]) == 1
    assert saved["cells"][0]["cell_hash"] == hashlib.sha256(code.encode()).hexdigest()
    assert "code" not in saved["cells"][0]


@pytest.mark.parametrize(
    "rng", [{"start": -2, "end": 9}, {"start": 8, "end": 2}, {"start": -9, "end": -3}]
)
def test_invalid_imported_ranges_cannot_steer_duplicate_cell_proximity(tmp_path, rng):
    code = "same = 1\n"
    ex = execution(1, code, index=99)
    ex["origin"]["range"] = rng
    path = tmp_path / "outputs.json"
    sidecar.write(path, sidecar.build([ex]))
    loaded = sidecar.read(path)[0]["executions"]
    assert loaded[0]["origin"]["range"] is None
    projected = sidecar.build(loaded, "# %%\n" + code + "# %%\n" + code)
    assert projected["cells"][0]["origin"]["index"] == 0
