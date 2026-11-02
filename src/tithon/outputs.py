"""Bounded, agent-readable views of a notebook file's current cell outputs.

The full saved or live output of a notebook is mostly noise for an agent that
edits research code: widget graphs, MIME bundles, base64 and ANSI escapes. This
module projects the current output of each source-matched code cell into short
text items and bounds them, so a caller asks only for the cells, kinds and lines
it needs. It never runs code; `select` works on the same execution snapshot the
shared output file is built from.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
from pathlib import Path

from . import sidecar
from .cells import parse_percent

#: Lines kept from the end of a text item unless the caller asks otherwise. A
#: loop that reruns a cell needs its latest metrics, which are at the end; every
#: extra line is paid again on each iteration, so the default is short.
DEFAULT_TAIL = 5
#: A traceback needs its frames as well as the final line to be actionable.
ERROR_TAIL = 20
#: Rendered characters before the text view stops and says how to narrow it.
DEFAULT_MAX_CHARS = 6000

_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_TAGS = re.compile(r"<[^>]*>")


def _text(value) -> str:
    """Output text as a string; a malformed value stays visible, never dropped."""
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if isinstance(value, list):
        return "".join(v if isinstance(v, str) else json.dumps(v) for v in value)
    return json.dumps(value)


def _clean(text: str) -> str:
    return _ANSI.sub("", text)


def project(output: dict, widgets) -> dict | None:
    """One output as a short item: kind plus text, or an image file reference."""
    if not isinstance(output, dict):
        return None
    kind = output.get("output_type")
    if kind == "stream":
        return {"kind": output.get("name") or "stdout", "text": _clean(_text(output.get("text")))}
    if kind == "error":
        traceback = "\n".join(_clean(_text(line)) for line in output.get("traceback") or [])
        head = f"{output.get('ename', 'Error')}: {output.get('evalue', '')}".rstrip(": ")
        return {"kind": "error", "text": traceback or head, "summary": head}
    data = output.get("data")
    if not isinstance(data, dict):
        return None
    label = "result" if kind == "execute_result" else "display"
    view = data.get(sidecar.WIDGET_VIEW)
    if isinstance(view, dict) and isinstance(view.get("model_id"), str):
        text = sidecar.widget_text(view["model_id"], widgets)
        return {"kind": "widget", "text": text or _clean(_text(data.get("text/plain")))}
    for mime, value in data.items():
        if not mime.startswith("image/"):
            continue
        ref = value.get("$tithon_artifact") if isinstance(value, dict) else None
        if isinstance(ref, dict) and ref.get("rel_path"):
            return {"kind": "image", "mime": mime, "path": ref["rel_path"]}
        return {"kind": "image", "mime": mime, "path": None}
    if "text/plain" in data:
        return {"kind": label, "text": _clean(_text(data["text/plain"]))}
    for mime in ("text/markdown", "text/html"):
        if mime in data:
            text = _text(data[mime])
            if mime == "text/html":
                text = html.unescape(_TAGS.sub("", text))
            return {"kind": label, "text": text.strip()}
    return {"kind": label, "text": f"[{', '.join(sorted(data))}]"}


def _merge(items: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for item in items:
        previous = merged[-1] if merged else None
        if previous and item["kind"] in ("stdout", "stderr") and previous["kind"] == item["kind"]:
            previous["text"] += item["text"]
        else:
            merged.append(dict(item))
    return merged


def code_cells(source: str) -> list[dict]:
    """Every code cell's index, 1-based line span, body and cell hash."""
    cells = parse_percent(source)
    ranges = sidecar.cell_ranges(cells, source)
    return [
        {
            "cell": c["index"],
            "lines": [ranges[c["index"]]["start"] + 1, ranges[c["index"]]["end"] + 1],
            "range": ranges[c["index"]],
            "body": c["body"],
            "cell_hash": hashlib.sha256(c["body"].encode()).hexdigest(),
        }
        for c in cells
        if c["kind"] == "code"
    ]


def parse_selection(spec: str | None) -> set[int] | None:
    """``"2,4-6"`` as a set of cell indices; None selects every cell."""
    if not spec:
        return None
    chosen: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        low, _, high = part.partition("-")
        if not low.isdigit() or (high and not high.isdigit()):
            raise ValueError(f"Invalid cell selection: {spec!r}")
        chosen.update(range(int(low), int(high or low) + 1))
    return chosen


def select(
    snapshot: dict,
    source: str,
    cells: set[int] | None = None,
    errors_only: bool = False,
) -> list[dict]:
    """Current output per selected code cell, from a saved-form snapshot.

    Every selected code cell gets a record; one that has not run has status
    ``None`` and no outputs, so a caller can tell "no output" from "never run".
    """
    widgets = snapshot.get("widgets")
    current = {
        ex["origin"]["index"]: ex
        for ex in sidecar.current_executions(snapshot.get("executions", []), source)
    }
    records = []
    for cell in code_cells(source):
        if cells is not None and cell["cell"] not in cells:
            continue
        ex = current.get(cell["cell"], {})
        items = [item for o in ex.get("outputs") or [] if (item := project(o, widgets))]
        record = {
            "cell": cell["cell"],
            "lines": cell["lines"],
            "status": ex.get("status"),
            "execution_count": ex.get("execution_count"),
            "outputs": _merge(items),
        }
        started, finished = ex.get("started_at"), ex.get("finished_at")
        if isinstance(started, int | float) and isinstance(finished, int | float):
            record["seconds"] = round(finished - started, 2)
        if errors_only and record["status"] != "error":
            continue
        records.append(record)
    return records


def bound(
    records: list[dict],
    tail: int | None = None,
    head: int = 0,
    grep: str | None = None,
) -> list[dict]:
    """Trim each text item to its last ``tail`` (or first ``head``) lines.

    ``tail`` None keeps `DEFAULT_TAIL` lines, or `ERROR_TAIL` for a traceback.
    ``grep`` keeps only matching lines (case-insensitive) before trimming.
    0 disables a limit. Every trim records how many lines it dropped, so the
    caller can ask for them instead of silently missing them.
    """
    pattern = re.compile(grep, re.IGNORECASE) if grep else None
    bounded = []
    for record in records:
        items = []
        for item in record["outputs"]:
            if "text" not in item:
                items.append(item)
                continue
            lines = [line.rstrip() for line in item["text"].splitlines()]
            while lines and not lines[-1]:
                lines.pop()
            while lines and not lines[0]:
                lines.pop(0)
            if pattern is not None:
                lines = [line for line in lines if pattern.search(line)]
                if not lines:
                    continue
            omitted = 0
            if head and len(lines) > head:
                omitted, lines = len(lines) - head, lines[:head]
            else:
                keep = (
                    tail
                    if tail is not None
                    else ERROR_TAIL
                    if item["kind"] == "error"
                    else DEFAULT_TAIL
                )
                if keep and len(lines) > keep:
                    omitted, lines = len(lines) - keep, lines[-keep:]
            trimmed = {**item, "text": "\n".join(lines)}
            if omitted:
                trimmed["omitted_lines"] = omitted
            items.append(trimmed)
        if pattern is not None and not items and record["outputs"]:
            continue
        bounded.append({**record, "outputs": items})
    return bounded


def _header(record: dict) -> str:
    start, end = record["lines"]
    parts = [f"## cell {record['cell']} lines {start}-{end}", record["status"] or "not run"]
    if record.get("execution_count") is not None:
        parts.append(f"[{record['execution_count']}]")
    if record.get("seconds") is not None:
        parts.append(f"{record['seconds']}s")
    return " ".join(parts)


def render(records: list[dict], max_chars: int = DEFAULT_MAX_CHARS, head: bool = False) -> str:
    """Plain text for an agent: one header per cell, then each output item."""
    out: list[str] = []
    used = 0
    for index, record in enumerate(records):
        block = [_header(record)]
        for item in record["outputs"]:
            if item["kind"] == "image":
                block.append(f"image: {item.get('path') or '(embedded)'} ({item['mime']})")
                continue
            text = item["text"]
            omitted = item.get("omitted_lines")
            where = "later" if head else "earlier"
            note = f"[{omitted} {where} lines omitted]" if omitted else None
            if "\n" in text or note:
                block.append(f"{item['kind']}:")
                if note and not head:
                    block.append(note)
                block.append(text)
                if note and head:
                    block.append(note)
            else:
                block.append(f"{item['kind']}: {text}")
        chunk = "\n".join(block)
        if max_chars and used + len(chunk) > max_chars:
            if not out:
                cut = len(chunk) - max_chars
                out.append(chunk[:max_chars])
                out.append(f"[cut {cut} chars; narrow with --tail/--grep or raise --max-chars]")
                index += 1
            rest = len(records) - index
            if rest:
                out.append(
                    f"[stopped at {max_chars} chars; {rest} more cell(s): "
                    f"select with --cells, filter with --grep or raise --max-chars]"
                )
            break
        out.append(chunk)
        used += len(chunk) + 1
    return "\n".join(out)


def summary(records: list[dict], width: int = 100) -> str:
    """One line per cell: header plus the first line of its last text output."""
    lines = []
    for record in records:
        text = next(
            (
                item.get("summary") or item["text"].strip().splitlines()[-1]
                for item in reversed(record["outputs"])
                if item.get("text", "").strip()
            ),
            "",
        )
        images = sum(1 for item in record["outputs"] if item["kind"] == "image")
        tail = f" | {text[:width]}" if text else ""
        tail += f" | {images} image(s)" if images else ""
        lines.append(_header(record).removeprefix("## ") + tail)
    return "\n".join(lines)


def saved_snapshot_for(source: Path, workdir: Path) -> tuple[dict, str]:
    """The shared output file's snapshot for ``source``, and where it came from."""
    path = sidecar.sidecar_path(workdir, source)
    found = sidecar.read(path) if path is not None else None
    if found is None:
        return {"executions": []}, "none"
    return sidecar.saved_snapshot(found[0]), "saved"


def _count(value, default: int | None) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return default
    return value


def answer(snapshot: dict, source: str, request: dict) -> list[dict]:
    """Apply a ``query_outputs`` request's selection and bounds to a snapshot."""
    grep = request.get("grep")
    records = select(
        snapshot,
        source,
        parse_selection(request.get("cells")),
        errors_only=bool(request.get("errors")),
    )
    return bound(
        records,
        tail=_count(request.get("tail"), None),
        head=_count(request.get("head"), 0),
        grep=grep if isinstance(grep, str) else None,
    )
