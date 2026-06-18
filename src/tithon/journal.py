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
  ts           REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_exec ON messages(exec_id);
CREATE TABLE IF NOT EXISTS artifacts(
  artifact_id TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL,
  mime        TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  bytes_len   INTEGER NOT NULL
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
    """Build the wire event for a journaled message (live broadcast == replay)."""
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

    # -- messages ----------------------------------------------------------
    def append_message(self, exec_id: str | None, msg_type: str, content: dict,
                       artifact_ref: str | None = None) -> int:
        cur = self.db.execute(
            "INSERT INTO messages(session_id, exec_id, msg_type, content_json, artifact_ref, ts)"
            " VALUES(?,?,?,?,?,?)",
            (self.session_id, exec_id, msg_type, json.dumps(content), artifact_ref, time.time()),
        )
        return cur.lastrowid

    def max_seq(self) -> int:
        return self.db.execute("SELECT COALESCE(MAX(msg_seq),0) FROM messages").fetchone()[0]

    def messages_after(self, seq: int) -> list[tuple]:
        """Rows (msg_seq, exec_id, msg_type, content_json) with msg_seq > seq."""
        return self.db.execute(
            "SELECT msg_seq, exec_id, msg_type, content_json FROM messages"
            " WHERE msg_seq>? ORDER BY msg_seq",
            (seq,),
        ).fetchall()

    def messages_for_exec(self, exec_id: str) -> list[tuple]:
        return self.db.execute(
            "SELECT msg_seq, msg_type, content_json FROM messages"
            " WHERE exec_id=? ORDER BY msg_seq",
            (exec_id,),
        ).fetchall()

    # -- executions --------------------------------------------------------
    def insert_execution(self, exec_id: str, seq: int, code: str,
                         submitted_by: str | None = None,
                         origin: dict | None = None,
                         cell_hash: str | None = None) -> None:
        uri = origin.get("uri") if origin else None
        rng = origin.get("range") if origin else None
        idx = origin.get("index") if origin else None
        cell_range = json.dumps(rng) if rng is not None else None
        self.db.execute(
            "INSERT INTO executions(exec_id, session_id, seq, code, submitted_by, status,"
            " cell_origin_uri, cell_range, cell_hash, cell_index)"
            " VALUES(?,?,?,?,?, 'queued', ?,?,?,?)",
            (exec_id, self.session_id, seq, code, submitted_by, uri, cell_range,
             cell_hash, idx),
        )

    def mark_started(self, exec_id: str) -> float:
        ts = time.time()
        self.db.execute(
            "UPDATE executions SET status='running', started_at=? WHERE exec_id=?",
            (ts, exec_id),
        )
        return ts

    def mark_done(self, exec_id: str, status: str, execution_count: int | None,
                  folded_json: str) -> float:
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
        running = self.db.execute(
            "UPDATE executions SET status='orphaned',"
            " finished_at=COALESCE("
            "  (SELECT MAX(ts) FROM messages WHERE messages.exec_id=executions.exec_id),"
            "  started_at)"
            " WHERE status='running'"
        ).rowcount
        queued = self.db.execute(
            "UPDATE executions SET status='orphaned' WHERE status='queued'"
        ).rowcount
        return running + queued

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

    # -- artifacts ----------------------------------------------------------
    def find_artifact(self, artifact_id: str) -> tuple | None:
        return self.db.execute(
            "SELECT artifact_id, sha256, mime, rel_path, bytes_len FROM artifacts"
            " WHERE artifact_id=?",
            (artifact_id,),
        ).fetchone()

    def register_artifact(self, artifact_id: str, sha256: str, mime: str,
                          rel_path: str, bytes_len: int) -> None:
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

    def close(self) -> None:
        self.db.close()
