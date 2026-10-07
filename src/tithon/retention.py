"""Opt-in output compaction using the existing folds as restart seeds."""

from __future__ import annotations

import json
import math
import time

OUTPUT_TYPES = (
    "stream",
    "display_data",
    "update_display_data",
    "execute_result",
    "error",
    "clear_output",
)


def nonnegative(value: str | float) -> float:
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError("retention settings must be finite and nonnegative")
    return number


def storage(session) -> dict:
    journal = session.journal
    db = journal.db
    physical = {}
    for name, suffix in (("db", ""), ("wal", "-wal"), ("shm", "-shm")):
        path = session.session_dir / f"journal.db{suffix}"
        try:
            physical[name] = path.stat().st_size
        except FileNotFoundError:
            physical[name] = 0
        except OSError:
            physical[name] = None
    logical = sum(
        db.execute(query).fetchone()[0]
        for query in (
            "SELECT COALESCE(SUM(length(CAST(content_json AS BLOB))),0) FROM messages",
            "SELECT COALESCE(SUM(length(CAST(code AS BLOB))+length(CAST(COALESCE(folded_json,'') AS BLOB))),0) FROM executions",
            "SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM meta",
        )
    )
    images = 0
    missing = 0
    for aid in session._artifact_refs:
        row = journal.find_artifact(aid)
        if row is None:
            missing += 1
            continue
        try:
            images += (session.artifacts.workdir / row[3]).stat().st_size
        except OSError:
            missing += 1
    shared_bytes = 0
    if session.sidecar_path:
        try:
            shared_bytes = session.sidecar_path.stat().st_size
        except FileNotFoundError:
            pass
        except OSError:
            shared_bytes = None
    target = session.history_target_mib * 1024 * 1024
    return {
        "physical_bytes": physical,
        "logical_bytes": logical,
        "referenced_image_bytes": images if not missing else None,
        "missing_images": missing,
        "shared_output_bytes": shared_bytes,
        "shared_images_may_be_counted_in_multiple_sessions": True,
        "message_count": db.execute("SELECT COUNT(*) FROM messages").fetchone()[0],
        "policy": {
            "retention_days": session.history_retention_days,
            "target_mib": session.history_target_mib,
        },
        "last_cleanup": json.loads(journal.get_meta("history_cleanup") or "null"),
        "target_exceeded": bool(target and logical + images > target),
        "limit_kind": "soft target; current outputs, executions, widgets and lifecycle records are retained",
    }


def compact(session, now: float | None = None) -> int:
    """Persist all folds and delete eligible output rows without yielding.

    The seed covers ALL fold-affecting events through its boundary, including
    retained comm/clear-control rows. Widget and lifecycle rebuilds still use
    their complete journals. No await may split state capture and commit.
    """
    if not (session.history_retention_days or session.history_target_mib):
        return 0
    if (
        not session.journal.count_local_executions()
        or session._busy
        or not session._queue.empty()
        or session._recovering
        or session._restarting
        or session._killed
        or session._pending_input
        or session.journal.db.execute(
            "SELECT 1 FROM executions WHERE status IN ('running','queued') LIMIT 1"
        ).fetchone()
    ):
        return 0
    journal = session.journal
    now = time.time() if now is None else now
    placeholders = ",".join("?" for _ in OUTPUT_TYPES)
    cutoff_time = now - session.history_retention_days * 86400
    target = session.history_target_mib * 1024 * 1024
    sizes = storage(session)
    total = sizes["logical_bytes"] + (sizes["referenced_image_bytes"] or 0)
    over = bool(target and total > target)
    if not over and not session.history_retention_days:
        return 0
    eligible = f"msg_type IN ({placeholders})"
    if not journal.db.execute(
        f"SELECT 1 FROM messages WHERE {eligible} LIMIT 1", OUTPUT_TYPES
    ).fetchone():
        return 0
    boundary = journal.max_seq()
    seed = {
        "seq": boundary,
        "folds": {
            eid: {"outputs": fold.outputs(), "state": fold.fold_state()}
            for eid, fold in session._folds.items()
        },
        "display_registry": session._display_registry,
    }
    journal.db.execute("SAVEPOINT compact_outputs")
    try:
        for eid, fold in session._folds.items():
            journal.set_folded(eid, json.dumps(fold.outputs()))
        journal.set_meta("output_seed", json.dumps(seed))
        # Account for the newly materialized seed before choosing size victims.
        sizes = storage(session)
        remaining = sizes["logical_bytes"] + (sizes["referenced_image_bytes"] or 0)
        age_clause = "ts < ?" if session.history_retention_days else "0"
        age_params = (cutoff_time,) if session.history_retention_days else ()
        aged_bytes = journal.db.execute(
            f"SELECT COALESCE(SUM(length(CAST(content_json AS BLOB))),0) FROM messages WHERE {eligible} AND {age_clause}",
            (*OUTPUT_TYPES, *age_params),
        ).fetchone()[0]
        remaining -= aged_bytes
        size_seq = 0
        if target and remaining > target:
            for seq, size in journal.db.execute(
                f"SELECT msg_seq,length(CAST(content_json AS BLOB)) FROM messages WHERE {eligible} AND NOT ({age_clause}) ORDER BY msg_seq",
                (*OUTPUT_TYPES, *age_params),
            ):
                size_seq = seq
                remaining -= size
                if remaining <= target:
                    break
        predicate = f"{eligible} AND ({age_clause} OR msg_seq<=?)"
        params = (*OUTPUT_TYPES, *age_params, size_seq)
        count, deleted_max = journal.db.execute(
            f"SELECT COUNT(*),MAX(msg_seq) FROM messages WHERE {predicate}", params
        ).fetchone()
        if not count:
            journal.db.execute("ROLLBACK TO compact_outputs")
            journal.db.execute("RELEASE compact_outputs")
            return 0
        floor = max(deleted_max, int(journal.get_meta("history_floor") or 0))
        journal.set_meta("history_floor", str(floor))
        previous = json.loads(journal.get_meta("history_cleanup") or "{}")
        journal.set_meta(
            "history_cleanup",
            json.dumps(
                {
                    "at": now,
                    "deleted_messages": count,
                    "total_deleted_messages": previous.get("total_deleted_messages", 0) + count,
                }
            ),
        )
        journal.db.execute(f"DELETE FROM messages WHERE {predicate}", params)
        journal.db.execute("RELEASE compact_outputs")
    except BaseException:
        journal.db.execute("ROLLBACK TO compact_outputs")
        journal.db.execute("RELEASE compact_outputs")
        raise
    return count
