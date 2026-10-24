"""Independent percent notebook copies own their artifacts and never migrate kernels."""

import hashlib
from pathlib import Path

import nbformat
import pytest

from tithon import notebook, sidecar
from tithon.artifacts import ArtifactStore
from tithon.daemon import Daemon, Session, _session_layout
from tithon.journal import Journal
from tithon.widgets import WidgetMirror


def execution(seq, code, index=0, outputs=None):
    return {
        "exec_id": f"e{seq}",
        "seq": seq,
        "code": code,
        "status": "done",
        "cell_hash": hashlib.sha256(code.encode()).hexdigest(),
        "origin": {"index": index, "range": {"start": 1, "end": 1}},
        "outputs": outputs or [],
        "execution_count": seq,
    }


def test_copy_current_outputs_metadata_and_independent_artifacts(tmp_path):
    incoming = tmp_path / "input.ipynb"
    original = nbformat.v4.new_notebook(
        cells=[
            nbformat.v4.new_code_cell(
                "print(1)",
                outputs=[nbformat.v4.new_output("display_data", data={"image/png": "aW1hZ2U="})],
                execution_count=1,
            ),
            nbformat.v4.new_markdown_cell(
                "![x](attachment:x.png)",
                attachments={"x.png": {"image/png": "aW1hZ2U="}},
                metadata={"tags": ["keep"]},
            ),
        ],
        metadata={"language_info": {"name": "python"}, "authors": [{"name": "Author"}]},
    )
    nbformat.write(original, incoming)
    source, target = tmp_path / "source.py", tmp_path / "target.pynb"
    notebook.import_notebook(incoming, source, tmp_path)
    source_bytes = source.read_bytes()
    notebook.copy_percent(source, target, tmp_path)
    assert source.read_bytes() == target.read_bytes() == source_bytes
    source_doc = sidecar.read(sidecar.sidecar_path(tmp_path, source))[0]
    target_doc = sidecar.read(sidecar.sidecar_path(tmp_path, target))[0]
    source_ref = next(sidecar.artifact_refs(source_doc["executions"][0]["outputs"]))
    target_ref = next(sidecar.artifact_refs(target_doc["executions"][0]["outputs"]))
    assert source_ref["rel_path"] != target_ref["rel_path"]
    source_journal = Journal(tmp_path / "source-journal.db", source.as_uri())
    target_journal = Journal(tmp_path / "target-journal.db", target.as_uri())
    sidecar.import_into(source_journal, tmp_path, source_doc)
    sidecar.import_into(target_journal, tmp_path, target_doc)
    source_image, target_image = (
        tmp_path / source_ref["rel_path"],
        tmp_path / target_ref["rel_path"],
    )
    ArtifactStore(tmp_path, source_journal).delete(source_ref["artifact_id"])
    assert target_image.read_bytes() == b"image"
    source_image.write_bytes(b"image")
    ArtifactStore(tmp_path, target_journal).delete(target_ref["artifact_id"])
    assert source_image.read_bytes() == b"image"
    target_image.write_bytes(b"image")
    exported = tmp_path / "export.ipynb"
    notebook.export_notebook(target, exported, tmp_path)
    result = nbformat.read(exported, as_version=4)
    assert result.metadata.authors == original.metadata.authors
    assert result.cells[1].metadata.tags == ["keep"]
    assert result.cells[1].attachments["x.png"]["image/png"] == "aW1hZ2U="
    assert result.cells[0].outputs[0].data["image/png"] == "aW1hZ2U="
    source_journal.close()
    target_journal.close()


def test_copy_keeps_only_current_attachments_and_stale_hash(tmp_path):
    source, target = tmp_path / "source.py", tmp_path / "target.pynb"
    source.write_text("# %%\nnew = 2\n# %%\nmoved = 3\n")
    old, moved = "old = 1\n", "moved = 3\n"
    snapshot = {"executions": [execution(1, old), execution(2, old), execution(3, moved, 0)]}
    notebook.copy_percent(source, target, tmp_path, snapshot)
    copied = sidecar.read(sidecar.sidecar_path(tmp_path, target))[0]["executions"]
    assert [(e["seq"], e["origin"]["index"]) for e in copied] == [(2, 0), (3, 1)]
    assert copied[0]["cell_hash"] == hashlib.sha256(old.encode()).hexdigest()
    assert source.read_bytes() == target.read_bytes()


@pytest.mark.parametrize("collision", ["file", "sidecar", "metadata", "symlink"])
def test_copy_refuses_overwrite(tmp_path, collision):
    source, target = tmp_path / "source.py", tmp_path / "target.pynb"
    source.write_text("# %%\nx = 1\n")
    path = {
        "file": target,
        "sidecar": sidecar.sidecar_path(tmp_path, target),
        "metadata": notebook._metadata_path(tmp_path, target),
        "symlink": target,
    }[collision]
    path.parent.mkdir(parents=True, exist_ok=True)
    if collision == "symlink":
        path.symlink_to(tmp_path / "absent")
    else:
        path.write_text("keep")
    with pytest.raises(FileExistsError):
        notebook.copy_percent(source, target, tmp_path)
    if collision == "symlink":
        assert path.is_symlink() and not (tmp_path / "absent").exists()
    else:
        assert path.read_text() == "keep"


def test_copy_rolls_back_before_source_publication(tmp_path, monkeypatch):
    source, target = tmp_path / "source.py", tmp_path / "target.pynb"
    source.write_text("# %%\nx = 1\n")
    actual_open = Path.open

    def fail_source(path, *args, **kwargs):
        if path == target and args and args[0] == "xb":
            raise OSError("publication denied")
        return actual_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", fail_source)
    with pytest.raises(OSError, match="publication denied"):
        notebook.copy_percent(source, target, tmp_path)
    assert not target.exists()
    assert not sidecar.sidecar_path(tmp_path, target).exists()
    assert source.read_text() == "# %%\nx = 1\n"


@pytest.mark.parametrize("status", ["queued", "running"])
def test_daemon_rejects_unloaded_inflight_source(tmp_path, status):
    home, root = tmp_path / "home", tmp_path / "project"
    root.mkdir()
    source, target = root / "source.py", root / "target.pynb"
    source.write_text("# %%\nx = 1\n")
    directory, _ = _session_layout(home, source.as_uri(), str(root), root)
    session = Session(source.as_uri(), directory, root)
    session.journal.insert_execution("e1", 1, "x = 1")
    session.journal.db.execute("UPDATE executions SET status=?", (status,))
    daemon = Daemon(home, root)
    with pytest.raises(ValueError, match="running/queued"):
        daemon._copy_notebook(source, target, root)
    assert not target.exists()
    assert daemon._sessions == {}
    session.journal.close()


def test_daemon_rejects_destination_session_without_source_file(tmp_path):
    source, target = tmp_path / "source.py", tmp_path / "target.pynb"
    source.write_text("# %%\nx = 1\n")
    daemon = Daemon(tmp_path / "home", tmp_path)
    directory, _ = _session_layout(daemon.home, target.as_uri(), str(tmp_path), tmp_path)
    session = Session(target.as_uri(), directory, tmp_path)
    with pytest.raises(ValueError, match="saved session history"):
        daemon._copy_notebook(source, target, tmp_path)
    assert not target.exists()
    session.journal.close()


@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"])
def test_copy_duplicate_moved_cells_use_marker_range_overlap(tmp_path, newline):
    source, target = tmp_path / "source.py", tmp_path / "target.pynb"
    body = f"same = 2{newline}"
    source.write_bytes(
        newline.join(
            [
                "# %%",
                "changed = 1",
                "# %%",
                "same = 2",
                "# %%",
                "same = 2",
                "# %%",
                "last = 4",
            ]
        ).encode()
    )
    moved = execution(1, body, 0)
    moved["origin"]["range"] = {"start": 2, "end": 5}
    duplicate = execution(2, body, 2)
    notebook.copy_percent(source, target, tmp_path, {"executions": [moved, duplicate]})
    copied = sidecar.read(sidecar.sidecar_path(tmp_path, target))[0]["executions"]
    assert [(e["seq"], e["origin"]) for e in copied] == [
        (1, {"index": 1, "range": {"start": 2, "end": 3}}),
        (2, {"index": 2, "range": {"start": 4, "end": 5}}),
    ]
    assert source.read_bytes() == target.read_bytes()


def test_pynb_import_export_is_percent_source(tmp_path):
    incoming, source, outgoing = (
        tmp_path / "in.ipynb",
        tmp_path / "main.pynb",
        tmp_path / "out.ipynb",
    )
    original = nbformat.v4.new_notebook(cells=[nbformat.v4.new_code_cell("value = 3")])
    nbformat.write(original, incoming)
    notebook.import_notebook(incoming, source, tmp_path)
    assert source.read_text().startswith("# %%\nvalue = 3")
    notebook.export_notebook(source, outgoing, tmp_path)
    assert nbformat.read(outgoing, as_version=4).cells == original.cells


def test_copy_rejects_invalid_widgets_and_external_project(tmp_path):
    source = tmp_path / "source.py"
    source.write_text("# %%\nx = 1\n")
    target = tmp_path / "target.pynb"
    with pytest.raises(ValueError):
        notebook.copy_percent(source, target, tmp_path, {"widgets": {"state": []}})
    with pytest.raises(ValueError, match="same project"):
        notebook.copy_percent(source, tmp_path.parent / "outside.pynb", tmp_path)
    assert not target.exists()


def test_daemon_rejects_loaded_busy_source(tmp_path):
    source, target = tmp_path / "source.py", tmp_path / "target.pynb"
    source.write_text("# %%\nx = 1\n")
    daemon = Daemon(tmp_path / "home", tmp_path)
    directory, _ = _session_layout(daemon.home, source.as_uri(), str(tmp_path), tmp_path)
    session = Session(source.as_uri(), directory, tmp_path)
    daemon._sessions[source.as_uri()] = session
    session._busy = True
    with pytest.raises(ValueError, match="running and queued"):
        daemon._copy_notebook(source, target, tmp_path)
    assert not target.exists()
    session.journal.close()


def test_cli_copy_preserves_lexical_destination_for_connected_daemon(tmp_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from tithon import cli

    source = tmp_path / "source.py"
    destination = tmp_path / "linked.pynb"
    destination.symlink_to(tmp_path / "absent.pynb")
    sent = []

    class Connection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def send(self, message):
            import json

            sent.append(json.loads(message))

        async def recv(self):
            return '{"op":"notebook_converted"}'

    async def connect():
        return Connection()

    monkeypatch.setattr(cli, "_connect", connect)
    asyncio.run(
        cli._export(
            SimpleNamespace(
                source=str(source), destination=str(destination), workdir=str(tmp_path)
            ),
            "copy",
        )
    )
    assert sent[0]["destination"] == str(destination.absolute())
    assert sent[0]["destination"] != str(destination.resolve())
    assert sent[0]["op"] == "copy_notebook"


@pytest.mark.parametrize("closed", [False, True])
def test_unloaded_journal_prevents_stale_sidecar_resurrection(tmp_path, closed):
    source, target = tmp_path / "source.py", tmp_path / "target.pynb"
    code = "value = 1\n"
    source.write_text("# %%\n" + code)
    daemon = Daemon(tmp_path / "home", tmp_path)
    directory, _ = _session_layout(daemon.home, source.as_uri(), str(tmp_path), tmp_path)
    session = Session(source.as_uri(), directory, tmp_path)
    stale = execution(
        1,
        code,
        outputs=[
            {"output_type": "stream", "name": "stdout", "text": "STALE SIDECAR\n"},
        ],
    )
    current = execution(
        1,
        code,
        outputs=[
            {"output_type": "stream", "name": "stdout", "text": "CURRENT JOURNAL\n"},
        ],
    )
    sidecar.import_into(session.journal, tmp_path, sidecar.build([current]))
    session.set_closed_by_user(closed)
    session.journal.close()
    saved = sidecar.build([stale])
    retired = WidgetMirror()
    retired.apply(
        "comm_open",
        {
            "target_name": "jupyter.widget",
            "comm_id": "retired",
            "data": {
                "state": {
                    "_model_name": "FloatProgressModel",
                    "_model_module": "@jupyter-widgets/controls",
                    "_model_module_version": "2.0.0",
                    "value": 99,
                }
            },
        },
    )
    saved["widgets"] = retired.snapshot()
    assert saved["widgets"]["state"]["retired"]["state"]["value"] == 99
    shared = sidecar.sidecar_path(tmp_path, source)
    sidecar.write(shared, saved)
    original_sidecar = shared.read_bytes()
    if closed:
        daemon._copy_notebook(source, target, tmp_path)
        copied = sidecar.read(sidecar.sidecar_path(tmp_path, target))[0]
        assert copied["executions"] == []
        assert copied["widgets"] is None
        assert target.read_bytes() == source.read_bytes()
    else:
        with pytest.raises(ValueError, match="authoritative saved outputs"):
            daemon._copy_notebook(source, target, tmp_path)
        assert not target.exists()
    assert daemon._sessions == {}
    assert not (directory / "kernel.pid").exists()
    assert shared.read_bytes() == original_sidecar
