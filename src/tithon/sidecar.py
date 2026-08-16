"""Portable per-file output snapshot — the shareable half of a session.

The journal is this machine's verbatim write-ahead record: binary SQLite+WAL,
unbounded (no compaction), rewritten wholesale on every run and unmergeable, so
it can never travel in a git repository. What a reader of a shared notebook
needs is not that record but the FOLD — the current output state per execution,
which the daemon already materializes (``Journal.set_folded``) and already
serves to clients as the attach snapshot's ``executions[].outputs``.

This module projects that fold onto a text file INSIDE the project
(``<workdir>/.tithon/cells/<relpath>.json``), so cloning the repository restores
the outputs — the one property ``.ipynb`` has that a percent-format ``.py`` does
not. Images are not embedded: they stay in ``<workdir>/.tithon/outputs/``,
sha256-deduplicated and fold-GC'd, so a live-updating plot commits ONE file
instead of one base64 blob per frame.

The journal stays the source of truth for the machine that ran the cells; the
sidecar is a projection of it, imported only where there is no local history to
project (see ``import_into``).
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from .journal import Journal

#: Bumped when the on-disk shape changes incompatibly. A reader that does not
#: recognize the version ignores the file rather than importing a shape it would
#: misread — a shared repository can hold a sidecar written by a newer client.
SIDECAR_VERSION = 1

CELLS_REL = Path(".tithon") / "cells"

#: Executions worth sharing. `queued`/`running` are in-flight on the producer's
#: machine and would import as a cell that was cut off mid-run on a reader's
#: machine that never ran it; `skipped` renders as a blank, never-run cell.
SHAREABLE_STATUS = ("done", "error", "orphaned")


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


def build(executions: list[dict]) -> dict:
    """Build the sidecar document from snapshot-shaped execution dicts.

    Takes the SAME dicts ``Session.snapshot()`` sends to clients rather than
    re-deriving them, so a restored-from-sidecar cell and a restored-over-the-
    socket cell cannot disagree about what the output was.
    """
    execs = []
    for ex in executions:
        if ex.get("status") not in SHAREABLE_STATUS:
            continue
        execs.append(
            {
                "exec_id": ex["exec_id"],
                "seq": ex["seq"],
                "code": ex["code"],
                "status": ex["status"],
                "execution_count": ex.get("execution_count"),
                "cell_hash": ex.get("cell_hash"),
                # Position only. `origin.uri` is an absolute path on the machine
                # that ran the cell — meaningless to a reader, and a filesystem
                # layout nobody meant to commit. `import_into` rebinds it to the
                # reader's own uri, which the sidecar's location already implies.
                "origin": _position(ex.get("origin")),
                "outputs": ex.get("outputs") or [],
                # No `fold_state`. That is CONTINUATION state — how to keep
                # folding an execution as more messages arrive — and every
                # execution here is terminal by construction, so carrying it
                # would be a field that is written, never read, and wrong the
                # moment a reader re-published it from imported rows.
                "started_at": ex.get("started_at"),
                "finished_at": ex.get("finished_at"),
            }
        )
    # No session id: it is the author's absolute file path, nothing reads it
    # back, and the file's own location already says which source it belongs to.
    return {"version": SIDECAR_VERSION, "executions": execs}


def dumps(doc: dict) -> str:
    """Serialize for git: sorted keys, one field per line, trailing newline.

    Line-oriented and stably ordered so a rerun shows a reviewable diff and two
    branches conflict only where the outputs genuinely differ.
    """
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
    if not isinstance(doc, dict) or doc.get("version") != SIDECAR_VERSION:
        return None
    if not isinstance(doc.get("executions"), list):
        return None
    return doc, hashlib.sha256(raw).hexdigest()


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
        except (TypeError, ValueError):
            return None

    rows = []
    for ex in doc.get("executions", []):
        if not isinstance(ex, dict) or ex.get("status") not in SHAREABLE_STATUS:
            continue
        if not isinstance(ex.get("outputs") or [], list):
            continue
        try:
            order = int(ex.get("seq") or 0)
        except (TypeError, ValueError):
            continue
        rows.append((order, ex))
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
