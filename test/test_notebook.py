"""Notebook interchange preserves source, output, metadata and image bytes."""

import base64
import copy
import json

import nbformat
import pytest

from tithon import notebook, sidecar
from tithon.daemon import Session


@pytest.fixture
def rich_notebook(tmp_path):
    png = base64.b64encode(b"test image").decode()
    widget = {
        "version_major": 2,
        "version_minor": 0,
        "state": {
            "progress": {
                "model_name": "FloatProgressModel",
                "model_module": "@jupyter-widgets/controls",
                "model_module_version": "2.0.0",
                "state": {
                    "_model_name": "FloatProgressModel",
                    "_model_module": "@jupyter-widgets/controls",
                    "_model_module_version": "2.0.0",
                    "value": 42,
                },
                "buffers": [],
            }
        },
    }
    doc = nbformat.v4.new_notebook(
        cells=[
            nbformat.v4.new_markdown_cell(
                "# 제목\n![plot](attachment:a.png)",
                attachments={"a.png": {"image/png": png}},
                metadata={"tags": ["intro"]},
            ),
            nbformat.v4.new_code_cell(
                "print('한글')",
                outputs=[
                    nbformat.v4.new_output("stream", name="stdout", text="한글\n"),
                    nbformat.v4.new_output(
                        "display_data",
                        data={
                            "image/png": png,
                            "image/svg+xml": "<svg>✓</svg>",
                            "text/plain": "figure",
                        },
                        metadata={"image/png": {"width": 10}},
                    ),
                    nbformat.v4.new_output(
                        "execute_result", data={"application/json": {"a": 1}}, execution_count=1
                    ),
                    nbformat.v4.new_output(
                        "display_data",
                        data={
                            "application/vnd.jupyter.widget-view+json": {
                                "version_major": 2,
                                "version_minor": 0,
                                "model_id": "progress",
                            }
                        },
                    ),
                ],
                execution_count=1,
                metadata={"tags": ["train"]},
            ),
            nbformat.v4.new_raw_cell("\\LaTeX\n# %% inside raw", metadata={"format": "text/latex"}),
            nbformat.v4.new_code_cell("", metadata={"tags": ["empty"]}),
            nbformat.v4.new_code_cell(
                "raise ValueError('bad')\n",
                outputs=[
                    nbformat.v4.new_output(
                        "error", ename="ValueError", evalue="bad", traceback=["trace"]
                    )
                ],
            ),
        ],
        metadata={
            "language_info": {"name": "python"},
            "kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
            "authors": [{"name": "Author"}],
            "widgets": {notebook.WIDGET_STATE: widget},
        },
    )
    source = tmp_path / "source.ipynb"
    nbformat.write(doc, source)
    return source, doc


def test_rich_round_trip_and_existing_sidecar_restore(tmp_path, rich_notebook):
    source, original = rich_notebook
    py = tmp_path / "nested" / "converted.py"
    notebook.import_notebook(source, py, tmp_path)
    shared_path = sidecar.sidecar_path(tmp_path, py)
    shared_doc = sidecar.read(shared_path)[0]
    assert b"test image" not in shared_path.read_bytes()
    assert "dGVzdCBpbWFnZQ==" not in shared_path.read_text()
    assert len(list((tmp_path / ".tithon/outputs").iterdir())) == 3
    # The existing session importer serves rich output without running any code.
    s = Session(py.as_uri(), tmp_path / "session", tmp_path)
    s._import_sidecar()
    s._rebuild_folds()
    s._rebuild_mirror()
    assert s.journal.count_local_executions() == 0
    assert s._mirror.snapshot()["state"]["progress"]["state"]["value"] == 42
    assert all(
        s.read_artifact(ref["artifact_id"])["found"]
        for e in shared_doc["executions"]
        for ref in sidecar.artifact_refs(e["outputs"])
    )
    s.journal.close()
    exported = tmp_path / "out.ipynb"
    notebook.export_notebook(py, exported, tmp_path)
    result = nbformat.read(exported, as_version=4)
    nbformat.validate(result)
    assert result.metadata == original.metadata
    assert result.cells == original.cells


def test_no_execution_and_no_overwrite(tmp_path):
    source = tmp_path / "source.ipynb"
    sentinel = tmp_path / "executed"
    nbformat.write(
        nbformat.v4.new_notebook(
            cells=[nbformat.v4.new_code_cell(f"open({str(sentinel)!r}, 'w').write('bad')")]
        ),
        source,
    )
    py = tmp_path / "converted.py"
    notebook.import_notebook(source, py)
    assert not sentinel.exists()
    before = py.read_bytes()
    with pytest.raises(FileExistsError):
        notebook.import_notebook(source, py)
    assert py.read_bytes() == before
    output = tmp_path / "export.ipynb"
    notebook.export_notebook(py, output)
    before = output.read_bytes()
    with pytest.raises(FileExistsError):
        notebook.export_notebook(py, output)
    assert output.read_bytes() == before


def test_source_edit_marks_stale_and_live_snapshot_overrides_sidecar(tmp_path, rich_notebook):
    source, _ = rich_notebook
    py = tmp_path / "converted.py"
    notebook.import_notebook(source, py)
    py.write_text(py.read_text().replace("print('한글')", "print('changed')"))
    output = tmp_path / "edited.ipynb"
    notebook.export_notebook(py, output)
    result = nbformat.read(output, as_version=4)
    assert result.cells[1].source.startswith("print('changed')")
    assert result.cells[1].metadata.tithon.stale_outputs
    assert result.cells[1].outputs[0].text == "한글\n"
    body = notebook.parse_percent(py.read_text())[1]["body"]
    import hashlib

    snapshot = {
        "executions": [
            {
                "seq": 999,
                "origin": {"index": 1},
                "cell_hash": hashlib.sha256(body.encode()).hexdigest(),
                "outputs": [{"output_type": "stream", "name": "stdout", "text": "live!"}],
                "execution_count": 2,
            }
        ]
    }
    output2 = tmp_path / "live.ipynb"
    notebook.export_notebook(py, output2, snapshot=snapshot)
    assert nbformat.read(output2, as_version=4).cells[1].outputs[0].text == "live!"


@pytest.mark.parametrize("code", ["x = 1\n# %%\ny = 2", "x = '''unterminated"])
def test_unrepresentable_cells_rejected_before_writes(tmp_path, code):
    source = tmp_path / "source.ipynb"
    nbformat.write(nbformat.v4.new_notebook(cells=[nbformat.v4.new_code_cell(code)]), source)
    with pytest.raises(ValueError):
        notebook.import_notebook(source, tmp_path / "converted.py")
    assert not (tmp_path / "converted.py").exists()
    assert not (tmp_path / ".tithon").exists()


def test_string_markers_duplicate_empty_cells_and_crlf(tmp_path):
    source = tmp_path / "source.ipynb"
    original = nbformat.v4.new_notebook(
        cells=[
            nbformat.v4.new_code_cell("x = '''\n# %%\n'''\r\nprint(x)\r\n"),
            nbformat.v4.new_code_cell("", metadata={"name": "first"}),
            nbformat.v4.new_code_cell("", metadata={"name": "second"}),
        ]
    )
    nbformat.write(original, source)
    py = tmp_path / "converted.py"
    notebook.import_notebook(source, py)
    notebook.export_notebook(py, tmp_path / "out.ipynb")
    assert nbformat.read(tmp_path / "out.ipynb", as_version=4).cells == original.cells


@pytest.mark.parametrize("language", ["julia", "R"])
def test_other_languages_rejected(tmp_path, language):
    source = tmp_path / "source.ipynb"
    nbformat.write(nbformat.v4.new_notebook(metadata={"language_info": {"name": language}}), source)
    with pytest.raises(ValueError, match="Python"):
        notebook.import_notebook(source, tmp_path / "converted.py")


def test_malformed_and_old_format_rejected(tmp_path):
    source = tmp_path / "source.ipynb"
    for data in (
        "not JSON",
        json.dumps(
            {"nbformat": 4, "nbformat_minor": 5, "cells": [{"cell_type": "code"}], "metadata": {}}
        ),
    ):
        source.write_text(data)
        with pytest.raises((nbformat.reader.NotJSONError, nbformat.ValidationError)):
            notebook.import_notebook(source, tmp_path / "converted.py")
        assert not (tmp_path / "converted.py").exists()
    source.write_text(
        json.dumps({"nbformat": 3, "nbformat_minor": 0, "metadata": {}, "worksheets": []})
    )
    with pytest.raises(ValueError, match="nbformat 4"):
        notebook.import_notebook(source, tmp_path / "converted.py")


def test_missing_and_escaping_images_fail_export_without_file(tmp_path, rich_notebook):
    source, _ = rich_notebook
    py = tmp_path / "converted.py"
    notebook.import_notebook(source, py)
    shared = sidecar.read(sidecar.sidecar_path(tmp_path, py))[0]
    original = copy.deepcopy(shared)
    ref = next(sidecar.artifact_refs(shared["executions"][0]["outputs"]))
    ref["rel_path"] = "../../outside.png"
    with pytest.raises(ValueError, match="outside"):
        notebook.export_notebook(py, tmp_path / "out.ipynb", snapshot=shared)
    assert not (tmp_path / "out.ipynb").exists()
    ref2 = next(sidecar.artifact_refs(original["executions"][0]["outputs"]))
    (tmp_path / ref2["rel_path"]).unlink()
    with pytest.raises(FileNotFoundError):
        notebook.export_notebook(py, tmp_path / "out.ipynb", snapshot=original)
    assert not (tmp_path / "out.ipynb").exists()


def test_invalid_widgets_rejected_before_publishing(tmp_path):
    source = tmp_path / "bad.ipynb"
    nbformat.write(
        nbformat.v4.new_notebook(
            metadata={
                "widgets": {notebook.WIDGET_STATE: {"state": {"bad": {"state": [], "buffers": []}}}}
            }
        ),
        source,
    )
    with pytest.raises(ValueError, match="widget"):
        notebook.import_notebook(source, tmp_path / "bad.py")
    assert not (tmp_path / ".tithon").exists()


def test_attachment_survives_output_clear_and_markdown_edit(tmp_path, rich_notebook):
    source, original = rich_notebook
    py = tmp_path / "converted.py"
    notebook.import_notebook(source, py, tmp_path)
    session = Session(py.as_uri(), tmp_path / "session", tmp_path)
    session._import_sidecar()
    session._rebuild_folds()
    session._rebuild_mirror()
    session.clear_outputs(None)
    session.journal.close()
    py.write_text(py.read_text().replace("# 제목", "# Edited title"))
    destination = tmp_path / "out.ipynb"
    notebook.export_notebook(py, destination, tmp_path)
    result = nbformat.read(destination, as_version=4)
    assert result.cells[0].source.startswith("# Edited title")
    assert result.cells[0].metadata == original.cells[0].metadata
    assert result.cells[0].id == original.cells[0].id
    assert result.cells[0].attachments == original.cells[0].attachments
    assert result.cells[1].outputs == []


def test_moved_cells_export_matching_outputs_and_metadata(tmp_path):
    source, py = tmp_path / "source.ipynb", tmp_path / "converted.py"
    cells = [
        nbformat.v4.new_code_cell(
            code,
            outputs=[nbformat.v4.new_output("stream", name="stdout", text=code)],
            metadata={"tags": [code]},
        )
        for code in ("print('A')", "print('B')")
    ]
    nbformat.write(nbformat.v4.new_notebook(cells=cells), source)
    notebook.import_notebook(source, py)
    py.write_text("# %%\nprint('B')\n# %%\nprint('A')\n")
    notebook.export_notebook(py, tmp_path / "out.ipynb")
    result = nbformat.read(tmp_path / "out.ipynb", as_version=4)
    assert result.cells == cells[::-1]
