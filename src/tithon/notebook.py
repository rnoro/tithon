"""Python nbformat interchange using percent source and the existing output sidecar."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import tokenize
from pathlib import Path

import nbformat

from . import sidecar
from .widgets import WidgetMirror

MARKER = re.compile(r"^#\s*%%(.*)$")
WIDGET_STATE = "application/vnd.jupyter.widget-state+json"
IMAGE_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
    "image/gif": "gif",
    "image/webp": "webp",
}


def parse_percent(text: str) -> list[dict]:
    """Find top-level comment markers with Python's string-aware tokenizer."""
    lines = text.splitlines(keepends=True)
    markers = {}
    depth = 0
    try:
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            if token.type == tokenize.OP:
                if token.string in "([{":
                    depth += 1
                elif token.string in ")]}":
                    depth = max(0, depth - 1)
            if token.type == tokenize.COMMENT and token.start[1] == 0 and not depth:
                found = MARKER.match(token.string)
                if found:
                    suffix = found[1].strip().lower()
                    markers[token.start[0] - 1] = (
                        "markdown"
                        if suffix.startswith("[markdown]")
                        else "raw"
                        if suffix.startswith("[raw]")
                        else "code"
                    )
    except (tokenize.TokenError, IndentationError) as error:
        raise ValueError(f"Cannot identify cell boundaries: {error}") from error
    cells = []
    current = None
    for index, line in enumerate(lines):
        if index in markers:
            current = {"kind": markers[index], "body": "", "start": index + 1, "index": len(cells)}
            cells.append(current)
        else:
            if current is None:
                current = {"kind": "code", "body": "", "start": 0, "index": 0}
                cells.append(current)
            current["body"] += line
    return cells


def _metadata_path(root: Path, source: Path) -> Path:
    rel = source.resolve().relative_to(root.resolve())
    return root / ".tithon" / "notebooks" / rel.with_name(rel.name + ".json")


def _externalize(value, root: Path, pending: dict[Path, bytes], *, output=False):
    if isinstance(value, list):
        return [_externalize(v, root, pending, output=output) for v in value]
    if not isinstance(value, dict):
        return value
    if "$tithon_artifact" in value:
        raise ValueError("Notebook contains a reserved Tithon artifact reference")
    result = {}
    for key, payload in value.items():
        if key.startswith("image/") and isinstance(payload, (str, list)):
            payload = "".join(payload) if isinstance(payload, list) else payload
            try:
                raw = (
                    payload.encode("utf-8")
                    if key == "image/svg+xml"
                    else base64.b64decode(re.sub(r"\s", "", payload), validate=True)
                )
            except ValueError as error:
                raise ValueError(f"Invalid {key} data") from error
            sha = hashlib.sha256(raw).hexdigest()
            prefix = "notebook" if output else "notebook_asset"
            rel = Path(".tithon/outputs") / f"{prefix}_{sha}.{IMAGE_EXT.get(key, 'bin')}"
            pending[root / rel] = raw
            result[key] = {
                "$tithon_artifact": {
                    "artifact_id": sha,
                    "sha256": sha,
                    "mime": key,
                    "rel_path": str(rel),
                }
            }
        else:
            result[key] = _externalize(payload, root, pending, output=output)
    return result


def _embed(value, root: Path):
    if isinstance(value, list):
        return [_embed(v, root) for v in value]
    if not isinstance(value, dict):
        return value
    if "$tithon_artifact" in value:
        ref = value["$tithon_artifact"]
        path = (root / ref["rel_path"]).resolve()
        if not path.is_relative_to((root / ".tithon/outputs").resolve()):
            raise ValueError("Image reference is outside the output directory")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != ref["sha256"]:
            raise ValueError("Image reference hash does not match its file")
        return (
            raw.decode("utf-8")
            if ref["mime"] == "image/svg+xml"
            else base64.b64encode(raw).decode("ascii")
        )
    return {k: _embed(v, root) for k, v in value.items()}


def import_notebook(source: Path, destination: Path, root: Path | None = None) -> dict:
    """Validate before publishing; the .py is published last and never executed."""
    source, destination = source.resolve(), destination.resolve()
    root = (root or destination.parent).resolve()
    if source.suffix.lower() != ".ipynb" or destination.suffix.lower() != ".py":
        raise ValueError("Import requires an .ipynb source and a .py destination")
    doc = nbformat.read(source, as_version=nbformat.NO_CONVERT)
    if doc.nbformat != 4:
        raise ValueError("Only nbformat 4 notebooks are supported")
    nbformat.validate(doc)
    for language in (
        doc.metadata.get("language_info", {}).get("name"),
        doc.metadata.get("kernelspec", {}).get("language"),
    ):
        if language and language.lower() != "python":
            raise ValueError("Only Python notebooks are supported")
    shared = sidecar.sidecar_path(root, destination)
    metadata_path = _metadata_path(root, destination)
    if shared is None:
        raise ValueError("Destination must be inside the project directory")
    pending = {}
    pieces = []
    saved_cells = []
    executions = []
    line = 0
    for index, cell in enumerate(doc.cells):
        kind, original = cell.cell_type, cell.source
        body = (
            original if kind == "code" else "\n".join("# " + part for part in original.split("\n"))
        )
        body = body if body.endswith("\n") else body + "\n"
        marker = "# %%" + (f" [{kind}]" if kind != "code" else "") + "\n"
        piece = marker + body
        parsed = parse_percent(piece)
        if len(parsed) != 1 or parsed[0]["kind"] != kind or parsed[0]["body"] != body:
            raise ValueError(
                f"Cell {index + 1} cannot be represented unambiguously in percent format"
            )
        pieces.append(piece)
        saved = {
            "kind": kind,
            "body_sha": hashlib.sha256(body.encode()).hexdigest(),
            "source": original,
            "metadata": _externalize(cell.metadata, root, pending),
        }
        for key in ("attachments", "id"):
            if key in cell:
                saved[key] = _externalize(cell[key], root, pending)
        saved_cells.append(saved)
        if kind == "code":
            outputs = _externalize(cell.outputs, root, pending, output=True)
            executions.append(
                {
                    "exec_id": f"e{len(executions) + 1}",
                    "seq": len(executions) + 1,
                    "code": body,
                    "status": "error"
                    if any(o.get("output_type") == "error" for o in outputs)
                    else "done",
                    "execution_count": cell.execution_count,
                    "cell_hash": hashlib.sha256(body.encode()).hexdigest(),
                    "origin": {
                        "index": index,
                        "range": {"start": line + 1, "end": line + piece.count("\n") - 1},
                    },
                    "outputs": outputs,
                }
            )
        line += piece.count("\n")
    shared_doc = sidecar.build(executions)
    widgets = doc.metadata.get("widgets", {})
    if not isinstance(widgets, dict):
        raise ValueError("Notebook widgets metadata must be an object")
    shared_doc["widgets"] = widgets.get(WIDGET_STATE)
    WidgetMirror().hydrate(shared_doc["widgets"] or {})
    notebook_metadata = _externalize(dict(doc.metadata), root, pending)
    pending[metadata_path] = (
        json.dumps(
            {"version": 1, "metadata": notebook_metadata, "cells": saved_cells},
            ensure_ascii=False,
            indent=1,
        )
        + "\n"
    ).encode()
    pending[shared] = sidecar.dumps(shared_doc).encode()
    pending[destination] = "".join(pieces).encode()
    for path in (metadata_path, shared, destination):
        if path.exists():
            raise FileExistsError(f"Destination already exists: {path}")
    created = []
    try:
        for path, data in pending.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path not in (metadata_path, shared, destination):
                if path.read_bytes() != data:
                    raise ValueError(f"Conflicting image file: {path}")
                continue
            with path.open("xb") as handle:
                created.append(path)
                handle.write(data)
    except BaseException:
        for path in reversed(created):
            path.unlink(missing_ok=True)
        raise
    return {"cells": len(doc.cells), "destination": str(destination)}


def export_notebook(
    source: Path, destination: Path, root: Path | None = None, snapshot: dict | None = None
) -> dict:
    """Export saved source and matching outputs; stale results are explicitly marked."""
    source, destination = source.resolve(), destination.resolve()
    root = (root or source.parent).resolve()
    if source.suffix.lower() != ".py" or destination.suffix.lower() != ".ipynb":
        raise ValueError("Export requires a .py source and an .ipynb destination")
    if destination.exists():
        raise FileExistsError(f"Destination already exists: {destination}")
    with source.open(encoding="utf-8", newline="") as handle:
        cells = parse_percent(handle.read())
    metadata_path = _metadata_path(root, source)
    saved = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {}
    if snapshot is None:
        shared = sidecar.sidecar_path(root, source)
        found = sidecar.read(shared) if shared else None
        snapshot = found[0] if found else {}
    executions = snapshot.get("executions", [])
    nb_cells = []
    used_ids = set()
    for cell in cells:
        kind, body, index = cell["kind"], cell["body"], cell["index"]
        sha = hashlib.sha256(body.encode()).hexdigest()
        candidates = [
            s for s in saved.get("cells", []) if s.get("kind") == kind and s.get("body_sha") == sha
        ]
        previous = (
            candidates[0]
            if len(candidates) == 1
            else (
                saved.get("cells", [])[index]
                if index < len(saved.get("cells", []))
                and saved["cells"][index].get("kind") == kind
                and saved["cells"][index].get("body_sha") == sha
                else {}
            )
        )
        if not previous and len(cells) == len(saved.get("cells", [])):
            positional = saved["cells"][index]
            unchanged_elsewhere = any(
                c["kind"] == positional.get("kind")
                and hashlib.sha256(c["body"].encode()).hexdigest() == positional.get("body_sha")
                for c in cells
            )
            if positional.get("kind") == kind and not unchanged_elsewhere:
                previous = positional
        text = (
            previous["source"]
            if previous.get("body_sha") == sha
            else body
            if kind == "code"
            else re.sub(r"^# ?", "", body, flags=re.MULTILINE)
        )
        nb_cell = {
            "cell_type": kind,
            "source": text,
            "metadata": _embed(previous.get("metadata", {}), root),
        }
        for key in ("attachments", "id"):
            if key in previous:
                nb_cell[key] = _embed(previous[key], root)
        if kind == "code":
            matches = [e for e in executions if (e.get("origin") or {}).get("index") == index]
            exact = [e for e in matches if e.get("cell_hash") == sha]
            if not exact:
                exact = [e for e in executions if e.get("cell_hash") == sha]
            ex = max(exact or matches, key=lambda e: e.get("seq", 0), default={})
            outputs = _embed(ex.get("outputs", []), root)
            for output in outputs:
                output.pop("display_id", None)
            nb_cell.update(outputs=outputs, execution_count=ex.get("execution_count"))
            if ex and ex.get("cell_hash") != sha:
                nb_cell["metadata"]["tithon"] = {"stale_outputs": True}
        if "id" not in nb_cell or nb_cell["id"] in used_ids:
            nb_cell["id"] = nbformat.v4.new_code_cell().id
        used_ids.add(nb_cell["id"])
        nb_cells.append(nb_cell)
    metadata = _embed(saved.get("metadata", {"language_info": {"name": "python"}}), root)
    if snapshot.get("widgets") is not None:
        metadata.setdefault("widgets", {})[WIDGET_STATE] = snapshot["widgets"]
    doc = nbformat.from_dict(
        {"nbformat": 4, "nbformat_minor": 5, "metadata": metadata, "cells": nb_cells}
    )
    # New or duplicated cells need fresh IDs; nbformat's normalizer owns this contract.
    _, doc = nbformat.validator.normalize(doc)
    nbformat.validate(doc)
    data = nbformat.writes(doc).encode()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as handle:
        handle.write(data)
    return {"cells": len(cells), "destination": str(destination)}
