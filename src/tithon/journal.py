"""SQLite(WAL) append-only message journal — the single source of truth.

Schema follows SPEC.md: ``executions`` / ``messages`` / ``artifacts``.
``messages.msg_seq`` (AUTOINCREMENT rowid) doubles as the global monotonic
event ``seq`` used by the snapshot+delta sync protocol.

Raw iopub messages are preserved as-is, except that rich image payloads are
replaced by artifact references *before* journaling (no base64 in the DB —
SPEC.md). Execution lifecycle transitions are journaled as pseudo
messages (``tithon.queued`` / ``tithon.started`` / ``tithon.done``) so that
delta replay reproduces exactly what live subscribers saw.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from .widgets import COMM_TYPES, is_comm  # widgets.py imports nothing local

SCHEMA = """
CREATE TABLE IF NOT EXISTS executions(
  exec_id         TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  code            TEXT NOT NULL,
  cell_origin_uri TEXT,
  cell_range      TEXT,
  cell_hash       TEXT,
  cell_index      INTEGER,
  submitted_by    TEXT,
  status          TEXT NOT NULL,
  execution_count INTEGER,
  kernel_msg_id   TEXT,
  allow_stdin     INTEGER NOT NULL DEFAULT 0,
  started_at      REAL,
  finished_at     REAL,
  folded_json     TEXT
);
CREATE TABLE IF NOT EXISTS messages(
  msg_seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  exec_id      TEXT,
  msg_type     TEXT NOT NULL,
  content_json TEXT NOT NULL,
  artifact_ref TEXT,
  target_exec  TEXT,
  ts           REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_exec ON messages(exec_id);
CREATE INDEX IF NOT EXISTS idx_messages_type_seq ON messages(msg_type, msg_seq);
CREATE TABLE IF NOT EXISTS artifacts(
  artifact_id TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL,
  mime        TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  bytes_len   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta(
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

#: iopub message types preserved verbatim in the journal
JOURNALED_IOPUB = (
    "stream",
    "display_data",
    "update_display_data",
    "execute_result",
    "error",
    "clear_output",
    "status",
)


def event_from_message(seq: int, exec_id: str | None, msg_type: str, content: dict) -> dict:
    """Build the wire event for a journaled message (live broadcast == replay).

    This is the ONLY builder, for the live broadcast and the attach-backlog replay
    alike. A second one would let the same journal row reach a live client as
    ``kind: "widget"`` and a client resuming with ``last_seen_seq > 0`` as ``kind:
    "output"``; since clients advance their widget mirror only from ``kind ==
    "widget"``, the resuming one would silently stop mirroring.
    """
    if is_comm(msg_type):
        # `_buffers_b64` lives at the top level of the stored row (added by
        # _handle_comm only when the message actually carried buffers), so
        # reading it yields the identical payload whether this is called with
        # the raw content or the journaled one — forwarded here whenever
        # present, since a widget with partly-binary state (e.g. Image) must
        # not go stale between reconnects. `data.buffer_paths` — which
        # says WHERE those bytes go — already rides inside `data`, forwarded
        # below unchanged.
        payload = {
            "msg_type": msg_type,
            "comm_id": content.get("comm_id"),
            "data": content.get("data"),
        }
        buffers_b64 = content.get("_buffers_b64")
        if buffers_b64:
            payload["_buffers_b64"] = buffers_b64
        return {"op": "event", "seq": seq, "exec_id": exec_id, "kind": "widget", "payload": payload}
    if msg_type.startswith("tithon."):
        kind = msg_type.split(".", 1)[1]
        payload = content
    elif msg_type == "status":
        kind = "status"
        payload = {"msg_type": msg_type, "content": content}
    else:
        kind = "output"
        payload = {"msg_type": msg_type, "content": content}
    return {"op": "event", "seq": seq, "exec_id": exec_id, "kind": kind, "payload": payload}


class Journal:
    def __init__(self, path: Path, session_id: str = "default"):
        self.session_id = session_id
        path.parent.mkdir(parents=True, exist_ok=True)
        # autocommit; WAL + synchronous=NORMAL keeps 50k-msg bursts cheap
        self.db = sqlite3.connect(str(path), isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """Additive migrations for journals created by earlier daemon versions."""
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(executions)").fetchall()}
        if "cell_hash" not in cols:  # added with output->cell attachment wiring
            self.db.execute("ALTER TABLE executions ADD COLUMN cell_hash TEXT")
        if "cell_index" not in cols:  # added with per-cell identity (duplicate-code fix)
            self.db.execute("ALTER TABLE executions ADD COLUMN cell_index INTEGER")
        if "kernel_msg_id" not in cols:
            self.db.execute("ALTER TABLE executions ADD COLUMN kernel_msg_id TEXT")
        if "allow_stdin" not in cols:
            self.db.execute(
                "ALTER TABLE executions ADD COLUMN allow_stdin INTEGER NOT NULL DEFAULT 0"
            )
        if "imported" not in cols:  # added with shared-sidecar import
            self.db.execute("ALTER TABLE executions ADD COLUMN imported INTEGER NOT NULL DEFAULT 0")
        mcols = {r[1] for r in self.db.execute("PRAGMA table_info(messages)").fetchall()}
        if "target_exec" not in mcols:  # added with session-wide display_id routing
            self.db.execute("ALTER TABLE messages ADD COLUMN target_exec TEXT")

    # -- messages ----------------------------------------------------------
    def append_message(
        self,
        exec_id: str | None,
        msg_type: str,
        content: dict,
        artifact_ref: str | None = None,
        target_exec: str | None = None,
    ) -> int:
        """Append one row. ``exec_id`` is always the TRUE EMITTER.

        ``target_exec`` names the execution whose FOLD this row belongs to when
        that differs from the emitter — today only a cross-cell
        ``update_display_data`` (see `Session._display_registry`). The two must
        stay separate columns: `orphan_inflight` freezes an execution's finish
        time at ``MAX(ts) WHERE exec_id=...``, so attributing a redirected row to
        the owner would silently shorten the EMITTER's restored duration. It is a
        derived routing sidecar like ``artifact_ref``; ``content_json`` is still
        the kernel's message verbatim.
        """
        cur = self.db.execute(
            "INSERT INTO messages(session_id, exec_id, msg_type, content_json, artifact_ref,"
            " target_exec, ts) VALUES(?,?,?,?,?,?,?)",
            (
                self.session_id,
                exec_id,
                msg_type,
                json.dumps(content),
                artifact_ref,
                target_exec,
                time.time(),
            ),
        )
        return cur.lastrowid

    def max_seq(self) -> int:
        return self.db.execute("SELECT COALESCE(MAX(msg_seq),0) FROM messages").fetchone()[0]

    def messages_after(self, seq: int) -> list[tuple]:
        """Rows (msg_seq, ROUTED exec_id, msg_type, content_json) with msg_seq > seq.

        The exec_id returned is the routing target (`target_exec` when the row
        was redirected, the emitter otherwise) because this feeds the attach
        delta replay, whose wire ``exec_id`` IS the execution a client folds the
        row into. Resolving it here — from what was decided once at append time —
        rather than re-deriving from live state is what makes a resumed replay
        byte-identical to the broadcast a live client already saw (ADR-083): a
        display_id re-created by a LATER execution would otherwise make the two
        disagree about which cell an old update belonged to.
        """
        return self.db.execute(
            "SELECT msg_seq, COALESCE(target_exec, exec_id), msg_type, content_json FROM messages"
            " WHERE msg_seq>? ORDER BY msg_seq",
            (seq,),
        ).fetchall()

    def all_messages(self) -> sqlite3.Cursor:
        """Every row (msg_seq, ROUTED exec_id, msg_type, content_json) in seq
        order, as a lazily-iterated cursor (no ``.fetchall()`` — a session's whole
        history must never be materialized at once). Routing follows
        `messages_after`. One global-ordered pass is what lets `_rebuild_folds`
        replay rows into a fold OTHER than their emitter's."""
        return self.db.execute(
            "SELECT msg_seq, COALESCE(target_exec, exec_id), msg_type, content_json FROM messages"
            " ORDER BY msg_seq"
        )

    def comm_messages_after(self, seq: int) -> sqlite3.Cursor:
        """Comm-type rows (msg_seq, exec_id, msg_type, content_json) with
        msg_seq > seq, as a lazily-iterated cursor (no `.fetchall()`), using
        `idx_messages_type_seq` to seek directly to comm rows instead of
        scanning the session's whole history. The `IN` clause is built from
        `COMM_TYPES` (widgets.py) — the SAME authority `is_comm()` uses — so a
        future addition to that tuple cannot silently diverge between live
        classification and this rebuild query."""
        placeholders = ",".join("?" for _ in COMM_TYPES)
        return self.db.execute(
            "SELECT msg_seq, exec_id, msg_type, content_json FROM messages"
            f" WHERE msg_seq>? AND msg_type IN ({placeholders})"
            " ORDER BY msg_seq",
            (seq, *COMM_TYPES),
        )

    def messages_for_exec(self, exec_id: str) -> list[tuple]:
        """Rows (msg_seq, msg_type, content_json) this execution EMITTED.

        The audit view — what this execution actually published — which is not the
        same set as what folds into it: a cross-cell `update_display_data` appears
        under its emitter here and under the display's owner in `all_messages`.
        """
        return self.db.execute(
            "SELECT msg_seq, msg_type, content_json FROM messages WHERE exec_id=? ORDER BY msg_seq",
            (exec_id,),
        ).fetchall()

    # -- executions --------------------------------------------------------
    def insert_execution(
        self,
        exec_id: str,
        seq: int,
        code: str,
        submitted_by: str | None = None,
        origin: dict | None = None,
        cell_hash: str | None = None,
        allow_stdin: bool = False,
    ) -> None:
        uri = origin.get("uri") if origin else None
        rng = origin.get("range") if origin else None
        idx = origin.get("index") if origin else None
        cell_range = json.dumps(rng) if rng is not None else None
        self.db.execute(
            "INSERT INTO executions(exec_id, session_id, seq, code, submitted_by, status,"
            " cell_origin_uri, cell_range, cell_hash, cell_index, allow_stdin)"
            " VALUES(?,?,?,?,?, 'queued', ?,?,?,?,?)",
            (
                exec_id,
                self.session_id,
                seq,
                code,
                submitted_by,
                uri,
                cell_range,
                cell_hash,
                idx,
                int(allow_stdin),
            ),
        )

    def mark_started(self, exec_id: str, kernel_msg_id: str | None = None) -> float:
        ts = time.time()
        self.db.execute(
            "UPDATE executions SET status='running', started_at=?, kernel_msg_id=? WHERE exec_id=?",
            (ts, kernel_msg_id, exec_id),
        )
        return ts

    def prepare_reattach(self) -> list[tuple[str, str, bool]]:
        """Keep only executions proven accepted by the surviving kernel.

        A persisted request id proves merely that the old client sent a frame.
        A journaled old-parent ``status: busy`` proves ipykernel actually began
        handling it. Queued rows and ambiguous running rows cannot be recovered
        after the daemon's in-memory queue/router disappeared, so they become
        orphaned. The serial worker makes at most one accepted row recoverable.
        """
        recoverable: list[tuple[str, str, bool]] = []
        for exec_id, msg_id, allow_stdin in self.db.execute(
            "SELECT exec_id, kernel_msg_id, allow_stdin FROM executions"
            " WHERE status='running' ORDER BY seq"
        ):
            accepted = False
            if msg_id:
                for (content_json,) in self.db.execute(
                    "SELECT content_json FROM messages"
                    " WHERE exec_id=? AND msg_type='status' ORDER BY msg_seq",
                    (exec_id,),
                ):
                    try:
                        if json.loads(content_json).get("execution_state") == "busy":
                            accepted = True
                            break
                    except (TypeError, ValueError):
                        continue
            if accepted:
                recoverable.append((exec_id, msg_id, bool(allow_stdin)))
        keep = recoverable[-1:]  # defensive: one kernel can execute only one request here
        keep_ids = {row[0] for row in keep}
        candidates = [
            exec_id
            for (exec_id,) in self.db.execute(
                "SELECT exec_id FROM executions WHERE status IN ('queued','running')"
                + (f" AND exec_id NOT IN ({','.join('?' for _ in keep_ids)})" if keep_ids else ""),
                tuple(keep_ids),
            )
        ]
        self._orphan_executions(candidates)
        return keep

    def _orphan_executions(self, exec_ids: list[str]) -> int:
        """Atomically orphan rows and append replayable terminal events."""
        if not exec_ids:
            return 0
        self.db.execute("BEGIN IMMEDIATE")
        try:
            count = 0
            for exec_id in exec_ids:
                row = self.db.execute(
                    "SELECT status FROM executions WHERE exec_id=?"
                    " AND status IN ('queued','running')",
                    (exec_id,),
                ).fetchone()
                if row is None:
                    continue
                ts = time.time()
                if row[0] == "running":
                    self.db.execute(
                        "UPDATE executions SET status='orphaned',"
                        " finished_at=COALESCE("
                        "  (SELECT MAX(ts) FROM messages WHERE messages.exec_id=executions.exec_id),"
                        "  started_at) WHERE exec_id=?",
                        (exec_id,),
                    )
                else:
                    self.db.execute(
                        "UPDATE executions SET status='orphaned' WHERE exec_id=?",
                        (exec_id,),
                    )
                self.append_message(
                    exec_id,
                    "tithon.done",
                    {"status": "orphaned", "execution_count": None, "ts": ts},
                )
                count += 1
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return count

    def finish_recovered(self, exec_id: str, status: str, folded_json: str) -> tuple[float, int]:
        """Atomically terminalize a recovered execution and append its done event."""
        ts = time.time()
        payload = {"status": status, "execution_count": None, "ts": ts}
        self.db.execute("BEGIN IMMEDIATE")
        try:
            updated = self.db.execute(
                "UPDATE executions SET status=?, execution_count=NULL, finished_at=?,"
                " folded_json=? WHERE exec_id=? AND status='running'",
                (status, ts, folded_json, exec_id),
            )
            if updated.rowcount != 1:
                raise RuntimeError(f"execution {exec_id} is no longer recoverable")
            seq = self.append_message(exec_id, "tithon.done", payload)
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return ts, seq

    def has_pending_input(self, exec_id: str) -> bool:
        """Whether the newest input lifecycle row is an unresolved request."""
        row = self.db.execute(
            "SELECT msg_type FROM messages WHERE exec_id=?"
            " AND msg_type IN ('tithon.input_request','tithon.input_resolved')"
            " ORDER BY msg_seq DESC LIMIT 1",
            (exec_id,),
        ).fetchone()
        return row is not None and row[0] == "tithon.input_request"

    def has_error(self, exec_id: str) -> bool:
        """Whether the append-only journal contains an error from this execution."""
        return (
            self.db.execute(
                "SELECT 1 FROM messages WHERE exec_id=? AND msg_type='error' LIMIT 1",
                (exec_id,),
            ).fetchone()
            is not None
        )

    def mark_done(
        self, exec_id: str, status: str, execution_count: int | None, folded_json: str
    ) -> float:
        ts = time.time()
        self.db.execute(
            "UPDATE executions SET status=?, execution_count=?, finished_at=?, folded_json=?"
            " WHERE exec_id=?",
            (status, execution_count, ts, folded_json, exec_id),
        )
        return ts

    def set_folded(self, exec_id: str, folded_json: str) -> None:
        """Overwrite an execution's cached folded snapshot.

        Used after a user clear: ``mark_done`` already wrote the pre-clear
        snapshot, so the column must be re-materialized to match the folded
        state (otherwise the snapshot fallback path would restore the cleared
        output for a session that never replays this exec's raw messages).
        """
        self.db.execute(
            "UPDATE executions SET folded_json=? WHERE exec_id=?", (folded_json, exec_id)
        )

    def orphan_inflight(self) -> int:
        """Mark queued/running executions as orphaned (after a daemon/kernel restart).

        A ``running`` exec never got a ``done``, so its ``finished_at`` is NULL.
        Freeze it at the exec's LAST journaled activity (``MAX(messages.ts)``,
        which is always >= ``started_at`` because every exec journals a
        ``tithon.started`` message): a restored cell then shows the REAL elapsed
        run time it accumulated before being cut off — not a live spinner, and not
        wall-clock-since-then. A ``queued`` exec never started, so it keeps a NULL
        ``finished_at``.
        """
        exec_ids = [
            exec_id
            for (exec_id,) in self.db.execute(
                "SELECT exec_id FROM executions WHERE status IN ('queued','running') ORDER BY seq"
            )
        ]
        return self._orphan_executions(exec_ids)

    def executions(self) -> list[tuple]:
        """Rows by seq: (exec_id, seq, code, status, execution_count, folded_json,
        cell_origin_uri, cell_range, cell_hash, cell_index, started_at,
        finished_at)."""
        return self.db.execute(
            "SELECT exec_id, seq, code, status, execution_count, folded_json,"
            " cell_origin_uri, cell_range, cell_hash, cell_index, started_at, finished_at"
            " FROM executions ORDER BY seq"
        ).fetchall()

    def max_exec_seq(self) -> int:
        return self.db.execute("SELECT COALESCE(MAX(seq),0) FROM executions").fetchone()[0]

    def has_started_since(self, seq: int = 0) -> bool:
        """Did any execution actually BEGIN running after ``seq``?

        Keyed on the ``tithon.started`` pseudo message, which the exec worker
        appends when the kernel accepts the cell — NOT on the ``executions``
        table. A row there is inserted when the cell is SUBMITTED, so
        ``max_exec_seq() > 0`` (and even a status filter) counts code that never
        touched the kernel: ``orphan_inflight`` rewrites a never-started
        ``queued`` row to ``orphaned`` after a crash, which no status test can
        tell apart from a run that was cut off mid-flight. A ``started`` message
        exists only for code the kernel really began.

        Used by the lost-state signal to answer "did the kernel generation that
        just died hold anything the user would miss?" — ``seq`` is the journal
        seq of the lifecycle event that opened that generation, so work done
        before an accepted reset is not counted against the new kernel.
        """
        row = self.db.execute(
            "SELECT 1 FROM messages WHERE msg_type='tithon.started' AND msg_seq>? LIMIT 1",
            (seq,),
        ).fetchone()
        return row is not None

    #: ``tithon.kernel`` statuses that begin or end a kernel GENERATION. Anything
    #: else on that channel (``interrupted``) leaves the running kernel and its
    #: namespace in place and must not shadow the real provenance record.
    GENERATION_STATUSES = frozenset(
        {"restarting", "restarted", "killed", "shutdown", "gc", "replaced"}
    )

    def last_kernel_event(self) -> tuple[int, dict] | None:
        """The newest kernel-GENERATION message as ``(msg_seq, content)``.

        This is the DURABLE record of what last happened to this session's kernel
        — restarted / killed / shut down / gc'd / replaced — and it outlives the
        daemon process, which is what makes the lost-state signal survive a reboot
        (and makes it derivable again rather than inferred from in-memory state).

        Rows are streamed newest-first and the first generation status wins, so an
        arbitrary number of interleaved ``interrupted`` events cannot push the
        provenance record out of reach.
        """
        cur = self.db.execute(
            "SELECT msg_seq, content_json FROM messages"
            " WHERE msg_type='tithon.kernel' ORDER BY msg_seq DESC"
        )
        for msg_seq, content_json in cur:
            try:
                content = json.loads(content_json)
            except (TypeError, ValueError):  # pragma: no cover - defensive
                continue
            if content.get("status") in self.GENERATION_STATUSES:
                return msg_seq, content
        return None

    # -- artifacts ----------------------------------------------------------
    def find_artifact(self, artifact_id: str) -> tuple | None:
        return self.db.execute(
            "SELECT artifact_id, sha256, mime, rel_path, bytes_len FROM artifacts"
            " WHERE artifact_id=?",
            (artifact_id,),
        ).fetchone()

    def register_artifact(
        self, artifact_id: str, sha256: str, mime: str, rel_path: str, bytes_len: int
    ) -> None:
        self.db.execute(
            "INSERT OR IGNORE INTO artifacts(artifact_id, sha256, mime, rel_path, bytes_len)"
            " VALUES(?,?,?,?,?)",
            (artifact_id, sha256, mime, rel_path, bytes_len),
        )

    def delete_artifact(self, artifact_id: str) -> None:
        """Drop an artifact row (its file is GC'd once no live fold references it).

        The row must go too, not just the file: otherwise ``find_artifact`` would
        let ``ArtifactStore.extract`` dedup a re-occurring image onto a deleted
        file. The raw iopub message still carries the ``$tithon_artifact`` ref, so
        a mid-history delta replay degrades to a ``found:false`` text fallback.
        """
        self.db.execute("DELETE FROM artifacts WHERE artifact_id=?", (artifact_id,))

    def all_artifacts(self) -> list[tuple]:
        """(artifact_id, rel_path) for every registered artifact (startup sweep)."""
        return self.db.execute("SELECT artifact_id, rel_path FROM artifacts").fetchall()

    # -- session meta (kv) -------------------------------------------------
    def get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return default if row is None else row[0]

    def set_meta(self, key: str, value: str) -> None:
        self.db.execute(
            "INSERT INTO meta(key, value) VALUES(?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    # -- imported (shared sidecar) executions ------------------------------
    def count_executions(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM executions").fetchone()[0]

    def count_local_executions(self) -> int:
        """Executions that ran on THIS machine (never imported from a sidecar).

        The re-import gate: a pulled sidecar may replace imported rows freely,
        but never once the user has run something here — that history is theirs
        and is not represented in the incoming file.
        """
        return self.db.execute("SELECT COUNT(*) FROM executions WHERE imported=0").fetchone()[0]

    def imported_exec_ids(self) -> set[str]:
        """Executions whose outputs came from a sidecar, so have no raw messages.

        `_rebuild_folds` replays raw messages to rebuild a fold; these rows have
        none, so their folds are hydrated from ``folded_json`` instead.
        """
        return {r[0] for r in self.db.execute("SELECT exec_id FROM executions WHERE imported=1")}

    def drop_imported(self) -> int:
        """Remove every imported execution (a newer sidecar supersedes them).

        Imported rows own no ``messages`` rows, so nothing else has to be
        cleaned up here; their artifacts are reclaimed by the ordinary
        fold-driven sweep once the re-import has rebuilt the folds.
        """
        cur = self.db.execute("DELETE FROM executions WHERE imported=1")
        return cur.rowcount or 0

    def import_execution(
        self,
        exec_id: str,
        seq: int,
        code: str,
        status: str,
        execution_count: int | None,
        folded_json: str,
        origin: dict | None = None,
        cell_hash: str | None = None,
        started_at: float | None = None,
        finished_at: float | None = None,
    ) -> None:
        """Insert one execution restored from a sidecar, already terminal.

        Terminal on arrival by construction (`sidecar.py` never writes an
        in-flight execution): a ``queued``/``running`` row here would be flipped
        to ``orphaned`` by the next `orphan_inflight()` and shown as a cell that
        was cut off mid-run on a machine that never ran it.
        """
        uri = origin.get("uri") if origin else None
        rng = origin.get("range") if origin else None
        idx = origin.get("index") if origin else None
        self.db.execute(
            "INSERT OR REPLACE INTO executions(exec_id, session_id, seq, code, status,"
            " execution_count, cell_origin_uri, cell_range, cell_hash, cell_index,"
            " started_at, finished_at, folded_json, imported)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)",
            (
                exec_id,
                self.session_id,
                seq,
                code,
                status,
                execution_count,
                uri,
                json.dumps(rng) if rng is not None else None,
                cell_hash,
                idx,
                started_at,
                finished_at,
                folded_json,
            ),
        )

    def close(self) -> None:
        self.db.close()
