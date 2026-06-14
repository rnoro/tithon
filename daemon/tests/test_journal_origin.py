"""Journal persistence of execution origin + cell_hash (design.md §3.1/§3.2).

The output<->cell attachment (verify item ⑥, extension/cellAttach) keys on the
journal's cell_hash; these tests pin that the journal actually stores and
returns origin {uri, range} and cell_hash, and that an old journal missing the
column is migrated additively.
"""
import hashlib
import sqlite3

from tithon.journal import Journal


def test_insert_and_read_origin_and_cell_hash(tmp_path):
    j = Journal(tmp_path / "journal.db")
    code = "x = 1\nprint(x)\n"
    chash = hashlib.sha256(code.encode("utf-8")).hexdigest()
    j.insert_execution(
        "e1", 1, code,
        origin={"uri": "file:///w/a.py", "range": {"start": 4, "end": 6}},
        cell_hash=chash,
    )
    rows = j.executions()
    assert len(rows) == 1
    (exec_id, seq, c, status, ec, folded, uri, cell_range, cell_hash,
     started_at, finished_at) = rows[0]
    assert exec_id == "e1" and c == code and status == "queued"
    assert uri == "file:///w/a.py"
    assert cell_range == '{"start": 4, "end": 6}'
    assert cell_hash == chash


def test_origin_optional(tmp_path):
    j = Journal(tmp_path / "journal.db")
    j.insert_execution("e1", 1, "y = 2\n")  # no origin / cell_hash (e.g. legacy path)
    (_eid, _seq, _c, _st, _ec, _f, uri, cell_range, cell_hash,
     _sa, _fa) = j.executions()[0]
    assert uri is None and cell_range is None and cell_hash is None


def test_migration_adds_cell_hash_to_old_journal(tmp_path):
    # Simulate a pre-wiring journal: executions table without the cell_hash column.
    path = tmp_path / "old.db"
    db = sqlite3.connect(str(path))
    db.execute(
        "CREATE TABLE executions(exec_id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER,"
        " code TEXT, cell_origin_uri TEXT, cell_range TEXT, submitted_by TEXT, status TEXT,"
        " execution_count INTEGER, started_at REAL, finished_at REAL, folded_json TEXT)"
    )
    db.execute(
        "INSERT INTO executions(exec_id, session_id, seq, code, status) VALUES('e0','default',1,'old',"
        "'done')"
    )
    db.commit()
    db.close()

    j = Journal(path)  # __init__ runs the additive migration
    cols = {r[1] for r in j.db.execute("PRAGMA table_info(executions)").fetchall()}
    assert "cell_hash" in cols
    # existing row survives and reads back with NULL cell_hash
    (eid, _seq, code, *_rest, cell_hash, _sa, _fa) = j.executions()[0]
    assert eid == "e0" and code == "old" and cell_hash is None
