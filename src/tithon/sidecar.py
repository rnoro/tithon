"""Portable current notebook outputs, independent of the producer's local journal.

The project stores one display record per current code cell, with images kept
as file references. Execution history and source code stay in the local journal.
"""

from __future__ import annotations

import copy
import hashlib
import html
import json
import os
import re
from pathlib import Path

from .cells import parse_percent
from .journal import Journal
from .widgets import MODEL_REFERENCE_PREFIXES, WidgetMirror

#: Bumped when the on-disk shape changes incompatibly. A reader that does not
#: recognize the version ignores the file rather than importing a shape it would
#: misread — a shared repository can hold a sidecar written by a newer client.
SIDECAR_VERSION = 2

CELLS_REL = Path(".tithon") / "cells"

#: Executions worth sharing. `queued`/`running` are in-flight on the producer's
#: machine and would import as a cell that was cut off mid-run on a reader's
#: machine that never ran it; `skipped` renders as a blank, never-run cell.
SHAREABLE_STATUS = ("done", "error", "orphaned")
WIDGET_VIEW = "application/vnd.jupyter.widget-view+json"

#: Trait defaults of the bundled ``@jupyter-widgets`` model classes, generated
#: from the extension's renderer bundle (``extension/test/widgetDefaults.test.ts``
#: fails when they drift). The renderer constructs a saved model through that
#: class, which fills every missing trait from these values, so a saved trait
#: equal to its default carries no information and is omitted on write.
_WIDGET_DEFAULTS = json.loads(
    Path(__file__).with_name("widget_defaults.json").read_text(encoding="utf-8")
)


def saved_snapshot(snapshot: dict) -> dict:
    """Project scoped widget history into portable, non-authoritative saved state.

    Namespace references even when their model is absent: an unresolved reference
    must not accidentally resolve to another kernel's model after flattening.
    """
    result = copy.deepcopy(snapshot)
    context = result.pop("widget_context", None)
    states = context.get("states") if isinstance(context, dict) else None
    scoped = isinstance(states, dict)

    def model_id(scope: str, identifier: str) -> str:
        identity = json.dumps([scope, identifier], ensure_ascii=False, separators=(",", ":"))
        return "saved_" + hashlib.sha256(identity.encode()).hexdigest()

    def rewrite_output(output, scope):
        if not isinstance(output, dict):
            return output
        view = (output.get("data") or {}).get(WIDGET_VIEW)
        if isinstance(view, dict) and isinstance(view.get("model_id"), str):
            view["model_id"] = model_id(scope, view["model_id"])
        return output

    def rewrite(value, scope):
        if isinstance(value, str):
            for prefix in MODEL_REFERENCE_PREFIXES:
                if value.startswith(prefix):
                    return prefix + model_id(scope, value[len(prefix) :])
            return value
        if isinstance(value, list):
            return [rewrite(item, scope) for item in value]
        if not isinstance(value, dict):
            return value
        return {
            key: [rewrite_output(output, scope) for output in item]
            if key == "outputs" and isinstance(item, list)
            else rewrite(item, scope)
            for key, item in value.items()
        }

    if scoped:
        models = {}
        for scope, state in states.items():
            if not isinstance(scope, str) or not isinstance(state, dict):
                raise ValueError("Invalid scoped widget state")
            WidgetMirror().hydrate(state)
            entries = state.get("state", {})
            if not isinstance(entries, dict):
                raise ValueError("Invalid scoped widget state")
            for identifier, entry in entries.items():
                if not isinstance(identifier, str) or not isinstance(entry, dict):
                    raise ValueError("Invalid scoped widget model")
                saved = copy.deepcopy(entry)
                saved["state"] = rewrite(saved.get("state", {}), scope)
                models[model_id(scope, identifier)] = saved
        result["widgets"] = {"version_major": 2, "version_minor": 0, "state": models}
    for execution in result.get("executions", []):
        if not isinstance(execution, dict):
            continue
        if not isinstance(execution.get("outputs") or [], list):
            continue
        outputs = []
        for output in execution.get("outputs") or []:
            if not isinstance(output, dict):
                outputs.append(output)
                continue
            scope = output.pop("widget_kernel_id", "saved")
            if not isinstance(scope, str):
                scope = "saved"
            outputs.append(rewrite_output(output, scope) if scoped else output)
        execution["outputs"] = outputs
    return result


def _same_json(a, b) -> bool:
    """JSON equality as the renderer sees it: 1 == 1.0, but true != 1."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, int | float) and isinstance(b, int | float):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same_json(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same_json(a[k], b[k]) for k in a)
    return type(a) is type(b) and a == b


def _model_defaults(entry) -> dict | None:
    """The traits the renderer supplies for a saved model, or None to keep all."""
    if not isinstance(entry, dict) or not isinstance(entry.get("state"), dict):
        return None
    module, name = entry.get("model_module"), entry.get("model_name")
    if _WIDGET_DEFAULTS["model_module_versions"].get(module) != entry.get("model_module_version"):
        return None
    defaults = _WIDGET_DEFAULTS["models"].get(f"{module}/{name}")
    state = entry["state"]
    if defaults is None or state.get("_model_name", name) != name:
        return None
    if state.get("_model_module", module) != module:
        return None
    return defaults


def _map_models(widgets, transform):
    if not isinstance(widgets, dict) or not isinstance(widgets.get("state"), dict):
        return widgets
    models = {}
    for identifier, entry in widgets["state"].items():
        defaults = _model_defaults(entry)
        models[identifier] = entry if defaults is None else transform(entry, defaults)
    return {**widgets, "state": models}


def compact_widgets(widgets):
    """Omit saved traits equal to the renderer's defaults (see `_WIDGET_DEFAULTS`).

    A trait holding a binary buffer is always kept: its JSON value is only a
    placeholder for the bytes.
    """

    def compact(entry, defaults):
        binary = {
            b["path"][0]
            for b in entry.get("buffers") or []
            if isinstance(b, dict) and isinstance(b.get("path"), list) and b["path"]
        }
        state = {
            key: value
            for key, value in entry["state"].items()
            if key in binary or key not in defaults or not _same_json(value, defaults[key])
        }
        return {**entry, "state": state}

    return _map_models(widgets, compact)


def expand_widgets(widgets):
    """Restore the traits `compact_widgets` omitted, so readers see full state."""
    return _map_models(
        widgets,
        lambda entry, defaults: {**entry, "state": {**copy.deepcopy(defaults), **entry["state"]}},
    )


def _bar(value: float, maximum: float) -> tuple[str, str]:
    percent = round(value / maximum * 100) if maximum > 0 else 0
    filled = max(0, min(20, round(percent / 100 * 20)))
    return f"{percent}%", "\u2588" * filled + "\u2591" * (20 - filled)


def _number(value) -> str:
    return str(int(value)) if float(value).is_integer() else str(round(value, 2))


def widget_text(model_id: str, widgets) -> str | None:
    """A one-line plain-text rendering of a saved widget's final state.

    Follows the extension's text fallback for progress bars, so a finished
    ``tqdm.notebook`` bar reads ``100% |████| 5/5 [time]``. None when the model
    is not in the saved state or its state yields no text.
    """
    models = widgets.get("state") if isinstance(widgets, dict) else None
    if not isinstance(models, dict) or not isinstance(models.get(model_id), dict):
        return None
    progress = None
    parts = []
    seen = set()
    queue = [model_id]
    while queue:
        identifier = queue.pop(0)
        if identifier in seen:
            continue
        seen.add(identifier)
        entry = models.get(identifier)
        state = entry.get("state") if isinstance(entry, dict) else None
        if not isinstance(state, dict):
            parts.append(f"[Widget not shown: {identifier}]")
            continue
        name = str(state.get("_model_name") or entry.get("model_name") or "")
        module = state.get("_model_module") or entry.get("model_module")
        value = state.get("value")
        if module not in (None, "@jupyter-widgets/base", "@jupyter-widgets/controls"):
            parts.append(f"[{name or identifier} ({module})]")
        elif "Progress" in name and isinstance(value, int | float) and not isinstance(value, bool):
            if progress is None:
                maximum = state.get("max", 100)
                progress = (value, maximum if isinstance(maximum, int | float) else 0)
        elif name in ("HTMLModel", "HTMLMathModel", "LabelModel"):
            if isinstance(value, str) and value.strip():
                parts.append(html.unescape(re.sub(r"<[^>]*>", "", value)).strip())
        elif isinstance(state.get("_options_labels"), list) and "index" in state:
            labels, index = state["_options_labels"], state["index"]
            chosen = [
                str(labels[i])
                for i in (index if isinstance(index, list) else [index])
                if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(labels)
            ]
            description = state.get("description")
            label = f"{description} " if isinstance(description, str) and description else ""
            parts.append(f"{label}{', '.join(chosen)}".strip())
        elif isinstance(value, str | int | float | bool) and name != "OutputModel":
            description = state.get("description")
            label = f"{description} " if isinstance(description, str) and description else ""
            parts.append(f"{label}{value}")
        children = state.get("children")
        if isinstance(children, list):
            for child in children:
                if isinstance(child, str):
                    for prefix in MODEL_REFERENCE_PREFIXES:
                        child = child.removeprefix(prefix)
                    queue.append(child)
    if progress is not None:
        percent, bar = _bar(*progress)
        left = parts[0] if parts else percent
        right = " ".join(parts[1:]) or f"{_number(progress[0])}/{_number(progress[1])}"
        return f"{left} |{bar}| {right}".strip()
    parts = [part for part in parts if part]
    return " ".join(parts) if parts else None


def text_widgets(doc: dict) -> dict:
    """Save each widget view as plain text of its final state, without widget state.

    An ``Output`` widget's view is replaced by the outputs its state holds
    (kernel-appended or imported ones); what it captured from a cell's
    execution is already folded into that cell's outputs.
    """
    widgets = doc.get("widgets")
    models = widgets.get("state") if isinstance(widgets, dict) else None
    models = models if isinstance(models, dict) else {}

    def convert(outputs, inside=frozenset()):
        if not isinstance(outputs, list):
            return outputs
        result = []
        for output in outputs:
            data = output.get("data") if isinstance(output, dict) else None
            view = data.get(WIDGET_VIEW) if isinstance(data, dict) else None
            model_id = view.get("model_id") if isinstance(view, dict) else None
            if not isinstance(model_id, str):
                result.append(output)
                continue
            entry = models.get(model_id)
            state = entry.get("state") if isinstance(entry, dict) else None
            if isinstance(state, dict) and state.get("_model_name") == "OutputModel":
                nested = state.get("outputs")
                if model_id not in inside and isinstance(nested, list):
                    result.extend(convert(nested, inside | {model_id}))
                continue
            text = widget_text(model_id, widgets)
            if text is None:
                plain = data.get("text/plain")
                text = "".join(plain) if isinstance(plain, list) else plain
            if not isinstance(text, str):
                name = state.get("_model_name") if isinstance(state, dict) else None
                text = f"[{name or 'widget'}]"
            replaced = {key: value for key, value in data.items() if key != WIDGET_VIEW}
            replaced["text/plain"] = text
            result.append({**output, "data": replaced})
        return result

    converted = {key: value for key, value in doc.items() if key != "widgets"}
    for key in ("cells", "executions"):
        if isinstance(doc.get(key), list):
            converted[key] = [
                {**item, "outputs": convert(item.get("outputs") or [])}
                if isinstance(item, dict)
                else item
                for item in doc[key]
            ]
    return converted


def sidecar_path(workdir: Path, file_path: Path | None) -> Path | None:
    """Where this session's shared snapshot lives, or None if it has none.

    Only a file session rooted inside the project gets one. The CLI/default
    session has no document to share, and a file outside the project root has
    nowhere inside the project that mirrors its path.
    """
    if file_path is None:
        return None
    try:
        rel = file_path.resolve().relative_to(workdir.resolve())
    except (ValueError, OSError):
        return None
    if not rel.parts:
        return None
    return workdir / CELLS_REL / rel.with_name(rel.name + ".json")


def artifact_refs(outputs: list[dict]):
    """Yield every ``$tithon_artifact`` reference inside a folded output list."""
    for item in outputs:
        data = item.get("data")
        if not isinstance(data, dict):
            continue
        for value in data.values():
            ref = value.get("$tithon_artifact") if isinstance(value, dict) else None
            if isinstance(ref, dict) and ref.get("artifact_id"):
                yield ref


def _position(origin: dict | None) -> dict | None:
    """An origin stripped to where the cell sat, with no machine-specific uri."""
    if not isinstance(origin, dict):
        return None
    return {"index": origin.get("index"), "range": origin.get("range")}


def cell_ranges(cells: list[dict], source: str) -> dict[int, dict]:
    """Each cell's 0-based inclusive line range, marker line included."""
    lines = len(source.splitlines())
    return {
        c["index"]: {
            "start": max(0, c["start"] - 1),
            "end": max(0, cells[i + 1]["start"] - 2 if i + 1 < len(cells) else lines - 1),
        }
        for i, c in enumerate(cells)
    }


def current_executions(executions: list[dict], source: str | None = None) -> list[dict]:
    """Select one display per current cell, matching exact source and moved cells.

    A newer empty/error result must replace a successful result. Queued and
    skipped work has not changed the display, while running work hides the
    previous execution until a terminal portable result can be published.
    """
    cells = parse_percent(source) if source is not None else None
    code_cells = [c for c in cells if c["kind"] == "code"] if cells is not None else []
    hashes = {c["index"]: hashlib.sha256(c["body"].encode()).hexdigest() for c in code_cells}
    by_index = {c["index"]: c for c in code_cells}
    by_hash = {}
    cell_hashes = {}
    for cell in code_cells:
        body = cell["body"]
        # A notebook save adds a final newline when the submitted cell has none.
        without_newline = (
            body.removesuffix("\r\n")
            if body.endswith("\r\n")
            else body.removesuffix("\n").removesuffix("\r")
        )
        variants = {hashes[cell["index"]], hashlib.sha256(without_newline.encode()).hexdigest()}
        cell_hashes[cell["index"]] = variants
        for sha in variants:
            by_hash.setdefault(sha, []).append(cell)
    ranges = cell_ranges(cells, source) if cells is not None else {}
    attached = {}
    owners = {}
    for ex in sorted(executions, key=lambda e: e.get("seq", 0)):
        if ex.get("status") not in (*SHAREABLE_STATUS, "running") or not ex.get("cell_hash"):
            continue
        origin = ex.get("origin") or {}
        index = origin.get("index")
        if cells is not None:
            target = by_index.get(index)
            if target is None or ex["cell_hash"] not in cell_hashes[index]:
                matches = by_hash.get(ex["cell_hash"], [])
                if matches:
                    previous = origin.get("range") or {"start": 0, "end": 0}

                    def proximity(cell, previous=previous):
                        current = ranges[cell["index"]]
                        start, end = previous.get("start", 0), previous.get("end", 0)
                        gap = max(0, current["start"] - end, start - current["end"])
                        return gap, cell["index"]

                    target = min(matches, key=proximity)
                else:
                    target = None
            if target is None:
                # An edited/reverted cell must not revive its older exact run;
                # a different cell that moved here still owns its own output.
                if owners.get(index) == index:
                    attached.pop(index, None)
                continue
            index = target["index"]
            current = dict(
                ex, cell_hash=hashes[index], origin={"index": index, "range": ranges[index]}
            )
        else:
            if not isinstance(index, int) or isinstance(index, bool) or index < 0:
                continue
            current = ex
        attached[index] = current
        owners[index] = origin.get("index")
    return [attached[index] for index in sorted(attached)]


def build(executions: list[dict], source: str | None = None) -> dict:
    """Project current displays into portable cells without local execution history."""
    return {
        "version": SIDECAR_VERSION,
        "cells": [
            {
                "cell_hash": ex["cell_hash"],
                "origin": _position(ex.get("origin")),
                "status": ex["status"],
                "execution_count": ex.get("execution_count"),
                "outputs": ex.get("outputs") or [],
            }
            for ex in current_executions(executions, source)
            if ex.get("status") in SHAREABLE_STATUS
        ],
    }


def as_snapshot(doc: dict) -> dict:
    """Adapt portable cells to the internal execution snapshot contract."""
    if doc.get("version") != 2 or "cells" not in doc:
        return doc
    return {
        **{key: value for key, value in doc.items() if key != "cells"},
        "executions": [
            dict(cell, exec_id=f"e{i}", seq=i)
            for i, cell in enumerate(doc["cells"], 1)
            if isinstance(cell, dict)
        ],
    }


def prune_widgets(doc: dict) -> dict:
    """Keep widget models reachable from the saved cell views, including dependencies."""
    snapshot = as_snapshot(doc)
    widgets = snapshot.get("widgets")
    if widgets is None:
        return doc
    WidgetMirror().hydrate(widgets)
    models = widgets.get("state", {})
    pending = []

    def views(outputs):
        for output in outputs:
            view = (output.get("data") or {}).get(WIDGET_VIEW)
            if isinstance(view, dict) and isinstance(view.get("model_id"), str):
                pending.append(view["model_id"])

    def refs(value):
        if isinstance(value, str):
            for prefix in MODEL_REFERENCE_PREFIXES:
                if value.startswith(prefix):
                    pending.append(value[len(prefix) :])
        elif isinstance(value, list):
            for item in value:
                refs(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key == "outputs" and isinstance(item, list):
                    views(item)
                else:
                    refs(item)

    for ex in snapshot.get("executions", []):
        views(ex.get("outputs") or [])
    keep = set()
    while pending:
        identifier = pending.pop()
        if identifier in keep or identifier not in models:
            continue
        keep.add(identifier)
        refs(models[identifier].get("state", {}))
    return {**doc, "widgets": {**widgets, "state": {k: v for k, v in models.items() if k in keep}}}


def dumps(doc: dict) -> str:
    """Serialize for git: sorted keys, one field per line, trailing newline.

    Line-oriented and stably ordered so a rerun shows a reviewable diff and two
    branches conflict only where the outputs genuinely differ. Widget traits
    equal to their defaults are omitted; `read` restores them.
    """
    if isinstance(doc.get("widgets"), dict):
        doc = {**doc, "widgets": compact_widgets(doc["widgets"])}
    return json.dumps(doc, sort_keys=True, indent=1, ensure_ascii=False) + "\n"


def write(path: Path, doc: dict) -> None:
    """Publish the snapshot atomically (temp file + rename).

    A reader may be a `git status` or another daemon at any moment; a partial
    write would present as a corrupt document rather than an older one.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(dumps(doc), encoding="utf-8")
    os.replace(tmp, path)


def read(path: Path) -> tuple[dict, str] | None:
    """Return ``(document, content_sha256)``, or None if absent/unusable.

    Unreadable, malformed and future-versioned files are all None: a sidecar is
    an optimization over an empty notebook, never a reason to fail an open.
    """
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    try:
        doc = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(doc, dict) or doc.get("version") not in (1, SIDECAR_VERSION):
        return None
    key = "cells" if doc["version"] == 2 else "executions"
    if not isinstance(doc.get(key), list):
        return None
    doc = as_snapshot(doc)
    if isinstance(doc.get("widgets"), dict):
        doc["widgets"] = expand_widgets(doc["widgets"])
    doc["executions"] = _importable(doc)
    try:
        saved_snapshot(doc)
    except (TypeError, ValueError, AttributeError):
        return None
    return doc, hashlib.sha256(raw).hexdigest()


def refresh_file(workdir: Path, source: Path, save_widget_state: bool | None = None) -> bool:
    """Reproject an offline saved view after source edits, without a journal or kernel.

    ``save_widget_state`` None keeps the file's current widget form.
    """
    path = sidecar_path(workdir, source)
    found = read(path) if path is not None else None
    if found is None:
        return False
    with source.open(encoding="utf-8", newline="") as handle:
        text = handle.read()
    snapshot = saved_snapshot(found[0])
    doc = build(snapshot.get("executions", []), text)
    if snapshot.get("widgets") is not None:
        doc["widgets"] = snapshot["widgets"]
        doc = prune_widgets(doc)
    if save_widget_state is False:
        doc = text_widgets(doc)
    write(path, doc)
    return True


def _importable(doc: dict) -> list[dict]:
    """The sidecar's executions, ordered and RENUMBERED for this journal.

    A sidecar is a tracked, hand-editable, merge-conflict-prone project file, so
    its ids are treated as data rather than trusted as keys. Every accepted row
    is reassigned ``e1..eN`` in recorded order, which makes the ids consistent
    with ``seq`` by construction — the daemon seeds ``_exec_counter`` from
    ``max_exec_seq()``, so a file claiming ``exec_id "e2", seq 1`` would
    otherwise make the reader's very next execution collide on the primary key.
    Nothing downstream depends on matching the author's ids: a client maps
    output to cells by ``cell_hash`` and index (ADR-049), never by exec_id.

    Rows that are not dicts, carry a non-shareable status, or whose outputs are
    not a list are dropped rather than coerced. Timings and execution counts are
    narrowed to numbers or None — SQLite would happily store a string in a REAL
    column, and the client multiplies those timings to render a duration.
    """

    def number(value, cast):
        try:
            return None if value is None or isinstance(value, bool) else cast(value)
        except (TypeError, ValueError, OverflowError):
            return None

    rows = []
    for ex in doc.get("executions", []):
        if not isinstance(ex, dict) or ex.get("status") not in SHAREABLE_STATUS:
            continue
        outputs = ex.get("outputs") or []
        if not isinstance(outputs, list) or any(not isinstance(o, dict) for o in outputs):
            continue
        try:
            order = int(ex.get("seq") or 0)
        except (TypeError, ValueError, OverflowError):
            continue
        origin = _position(ex.get("origin"))
        if origin is not None:
            index = origin["index"]
            if not isinstance(index, int) or isinstance(index, bool) or index < 0:
                origin["index"] = None
            rng = origin["range"]
            if (
                not isinstance(rng, dict)
                or any(
                    not isinstance(rng.get(key), int) or isinstance(rng[key], bool)
                    for key in ("start", "end")
                )
                or rng["start"] < 0
                or rng["end"] < rng["start"]
            ):
                origin["range"] = None
        cell_hash = ex.get("cell_hash")
        if not cell_hash and doc.get("version") == 1 and isinstance(ex.get("code"), str):
            cell_hash = hashlib.sha256(ex["code"].encode()).hexdigest()
        rows.append(
            (
                order,
                dict(
                    ex, origin=origin, cell_hash=cell_hash if isinstance(cell_hash, str) else None
                ),
            )
        )
    rows.sort(key=lambda r: r[0])  # stable: equal seqs keep their recorded order
    return [
        dict(
            ex,
            exec_id=f"e{i}",
            seq=i,
            execution_count=number(ex.get("execution_count"), int),
            started_at=number(ex.get("started_at"), float),
            finished_at=number(ex.get("finished_at"), float),
        )
        for i, (_, ex) in enumerate(rows, start=1)
    ]


def import_into(journal: Journal, workdir: Path, doc: dict) -> int:
    """Insert a sidecar's executions into a journal with no local history.

    Also registers each referenced artifact whose file is actually present, so
    the ordinary machinery works unchanged downstream: ``read_artifact`` can
    serve a cloned image over the socket (it resolves ids through the journal),
    and the startup sweep counts the file as live instead of reclaiming it.
    A ref whose file did not travel is left unregistered and degrades to the
    same text fallback as any other missing artifact.

    Each execution is rebound to THIS journal's file uri. The client scopes a
    restore to the file's own runs (``SessionClient.restoreInto``), so an
    execution still carrying the author's absolute path would be filtered out
    and the cloned outputs would never reach the cells.
    """
    doc = saved_snapshot(as_snapshot(doc))
    count = 0
    for ex in _importable(doc):
        outputs = ex.get("outputs") or []
        origin = dict(_position(ex.get("origin")) or {}, uri=journal.session_id)
        journal.import_execution(
            ex["exec_id"],
            ex["seq"],
            str(ex.get("code") or ""),
            ex["status"],
            ex.get("execution_count"),
            json.dumps(outputs),
            origin=origin,
            cell_hash=ex.get("cell_hash"),
            started_at=ex.get("started_at"),
            finished_at=ex.get("finished_at"),
        )
        for ref in artifact_refs(outputs):
            rel_path = ref.get("rel_path")
            if not rel_path:
                continue
            try:
                size = (workdir / rel_path).stat().st_size
            except OSError:
                continue
            journal.register_artifact(
                ref["artifact_id"],
                ref.get("sha256") or ref["artifact_id"],
                ref.get("mime") or "image/png",
                rel_path,
                size,
            )
        count += 1
    return count
