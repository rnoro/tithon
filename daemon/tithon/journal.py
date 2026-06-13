"""SQLite(WAL) append-only message journal — the single source of truth.

Schema follows design.md §3.1: ``executions`` / ``messages`` / ``artifacts``.
``messages.msg_seq`` (AUTOINCREMENT rowid) doubles as the global monotonic
event ``seq`` used by the snapshot+delta sync protocol.

Raw iopub messages are preserved as-is, except that rich image payloads are
replaced by artifact references *before* journaling (no base64 in the DB —
design.md §3.1). Execution lifecycle transitions are journaled as pseudo
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
        cell_range = json.dumps(rng) if rng is not None else None
        self.db.execute(
            "INSERT INTO executions(exec_id, session_id, seq, code, submitted_by, status,"
            " cell_origin_uri, cell_range, cell_hash) VALUES(?,?,?,?,?, 'queued', ?,?,?)",
            (exec_id, self.session_id, seq, code, submitted_by, uri, cell_range, cell_hash),
        )

    def mark_started(self, exec_id: str) -> None:
        self.db.execute(
            "UPDATE executions SET status='running', started_at=? WHERE exec_id=?",
            (time.time(), exec_id),
        )

    def mark_done(self, exec_id: str, status: str, execution_count: int | None,
                  folded_json: str) -> None:
        self.db.execute(
            "UPDATE executions SET status=?, execution_count=?, finished_at=?, folded_json=?"
            " WHERE exec_id=?",
            (status, execution_count, time.time(), folded_json, exec_id),
        )

    def orphan_inflight(self) -> int:
        """Mark queued/running executions as orphaned (after daemon restart)."""
        cur = self.db.execute(
            "UPDATE executions SET status='orphaned' WHERE status IN ('queued','running')"
        )
        return cur.rowcount

    def executions(self) -> list[tuple]:
        """Rows by seq: (exec_id, seq, code, status, execution_count, folded_json,
        cell_origin_uri, cell_range, cell_hash)."""
        return self.db.execute(
            "SELECT exec_id, seq, code, status, execution_count, folded_json,"
            " cell_origin_uri, cell_range, cell_hash"
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

    def close(self) -> None:
        self.db.close()
