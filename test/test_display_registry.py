"""Session-wide ``display_id`` resolution (RISKS #6).

``update_display(..., display_id="d")`` from cell B must update the output cell A
created with that id — Jupyter scopes a display to the SESSION, not to the
execution that emitted the update. The daemon owns the resolution: it routes the
row into the OWNER's fold and broadcasts it under the OWNER's exec_id, so every
client (live, resuming, or restarted) agrees on which cell the update belongs to
without knowing anything about display ids.

The two exec-id columns must stay distinct: ``messages.exec_id`` is the TRUE
EMITTER (``orphan_inflight`` freezes an execution's duration at its last row's
``ts``), ``messages.target_exec`` is the routing target.
"""
from __future__ import annotations

import asyncio
import base64
import json
import sqlite3

import pytest

from tithon.daemon import Session, Subscriber
from tithon.folding import ExecutionFold
from tithon.journal import Journal

# 1x1 transparent PNG (same fixture as test_artifacts).
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4"
    "2mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def make_session(tmp_path) -> Session:
    # Session.__init__ wires Journal/ArtifactStore without spawning a kernel.
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return Session("default", tmp_path / "sess", work)


def seed_exec(s: Session, exec_id: str, seq: int, code: str = "x") -> ExecutionFold:
    s.journal.insert_execution(exec_id, seq, code)
    fold = ExecutionFold()
    s._folds[exec_id] = fold
    return fold


def iopub(exec_id: str, msg_type: str, content: dict) -> dict:
    """An iopub message as the kernel would send it, routed like the real pump."""
    return {
        "header": {"msg_type": msg_type},
        "parent_header": {"msg_id": f"m-{exec_id}"},
        "content": content,
    }


def display(text: str, did: str | None = None) -> dict:
    content: dict = {"data": {"text/plain": text}, "metadata": {}}
    if did is not None:
        content["transient"] = {"display_id": did}
    return content


def feed(s: Session, exec_id: str, msg_type: str, content: dict) -> None:
    s._msgid_to_exec[f"m-{exec_id}"] = exec_id
    s._handle_iopub(iopub(exec_id, msg_type, content))


def texts(fold: ExecutionFold) -> list[str]:
    return [o["data"]["text/plain"] for o in fold.outputs() if "data" in o]


def test_cross_cell_update_lands_in_the_creating_execution(tmp_path):
    s = make_session(tmp_path)
    fold_a = seed_exec(s, "a", 1)
    fold_b = seed_exec(s, "b", 2)

    feed(s, "a", "display_data", display("v0", "d"))
    feed(s, "b", "update_display_data", display("v1", "d"))

    assert texts(fold_a) == ["v1"]   # A's one output, updated in place
    assert texts(fold_b) == []       # B gains nothing — it only emitted the update


def test_update_is_journaled_under_the_emitter_with_a_routing_target(tmp_path):
    """The audit row stays the emitter's; only `target_exec` names the owner.

    Conflating them would make `orphan_inflight` freeze B's finish time before
    its own last activity — the restored cell would understate its run time.
    """
    s = make_session(tmp_path)
    seed_exec(s, "a", 1)
    seed_exec(s, "b", 2)

    feed(s, "a", "display_data", display("v0", "d"))
    feed(s, "b", "update_display_data", display("v1", "d"))

    rows = s.journal.db.execute(
        "SELECT exec_id, target_exec, msg_type FROM messages ORDER BY msg_seq"
    ).fetchall()
    assert rows == [("a", None, "display_data"), ("b", "a", "update_display_data")]
    # The emitter's own audit view still holds the row it published.
    assert [t for _seq, t, _c in s.journal.messages_for_exec("b")] == ["update_display_data"]


def test_live_broadcast_and_delta_replay_agree_on_the_owner(tmp_path):
    """ADR-083's live==replay contract, extended to a redirected row."""
    s = make_session(tmp_path)
    seed_exec(s, "a", 1)
    seed_exec(s, "b", 2)
    sub = Subscriber(asyncio.Queue(maxsize=100))
    s._subs.add(sub)

    feed(s, "a", "display_data", display("v0", "d"))
    feed(s, "b", "update_display_data", display("v1", "d"))

    live = []
    while not sub.queue.empty():
        live.append(sub.queue.get_nowait())
    updates = [e for e in live if e["payload"].get("msg_type") == "update_display_data"]
    assert [e["exec_id"] for e in updates] == ["a"]

    replay = [
        (exec_id, msg_type) for _seq, exec_id, msg_type, _c in s.journal.messages_after(0)
    ]
    assert replay == [("a", "display_data"), ("a", "update_display_data")]


def test_replay_pins_the_owner_a_later_recreation_would_have_stolen(tmp_path):
    """A re-created display_id must not retro-actively re-route OLD updates.

    The registry answers "who owns d NOW"; the resolution a live client already
    saw is a fact about a past seq. Storing it at append time is what keeps a
    `--since K` replay identical to the broadcast — re-deriving from the live
    registry would hand the resuming client `c` for a row every live client got
    as `a`.
    """
    s = make_session(tmp_path)
    seed_exec(s, "a", 1)
    seed_exec(s, "b", 2)
    seed_exec(s, "c", 3)

    feed(s, "a", "display_data", display("v0", "d"))
    feed(s, "b", "update_display_data", display("v1", "d"))
    feed(s, "c", "display_data", display("w0", "d"))     # steals ownership of "d"
    feed(s, "b", "update_display_data", display("w1", "d"))

    assert s._display_registry["d"] == "c"
    replay = [
        (exec_id, msg_type) for _seq, exec_id, msg_type, _c in s.journal.messages_after(0)
    ]
    assert replay == [
        ("a", "display_data"),
        ("a", "update_display_data"),   # resolved when it happened, not now
        ("c", "display_data"),
        ("c", "update_display_data"),
    ]
    assert texts(s._folds["a"]) == ["v1"]
    assert texts(s._folds["c"]) == ["w1"]


def test_unknown_display_id_stays_with_the_emitter(tmp_path):
    """No registry entry -> no redirect. The fold then no-ops on the update
    (nothing carries that id), which is what a real frontend does too."""
    s = make_session(tmp_path)
    fold_b = seed_exec(s, "b", 1)

    feed(s, "b", "update_display_data", display("v1", "ghost"))

    assert texts(fold_b) == []
    rows = s.journal.db.execute("SELECT exec_id, target_exec FROM messages").fetchall()
    assert rows == [("b", None)]


def test_execute_result_display_id_is_not_registered(tmp_path):
    """Scoped to `display_data`: neither fold preserves an `execute_result`'s
    display_id, so registering it would route updates at an item that can never
    match — worse than leaving them with their emitter."""
    s = make_session(tmp_path)
    seed_exec(s, "a", 1)
    seed_exec(s, "b", 2)

    content = display("r0", "d")
    content["execution_count"] = 1
    feed(s, "a", "execute_result", content)

    assert "d" not in s._display_registry
    feed(s, "b", "update_display_data", display("v1", "d"))
    rows = s.journal.db.execute(
        "SELECT target_exec FROM messages WHERE msg_type='update_display_data'"
    ).fetchall()
    assert rows == [(None,)]


def test_rebuild_from_journal_reproduces_the_redirect(tmp_path):
    """A daemon restart replays the journal in ONE global-seq-ordered pass, so a
    row folds into an execution other than its emitter — the per-execution loop
    this replaced could not express that at all."""
    s = make_session(tmp_path)
    seed_exec(s, "a", 1)
    seed_exec(s, "b", 2)
    feed(s, "a", "display_data", display("v0", "d"))
    feed(s, "b", "update_display_data", display("v1", "d"))

    s._folds.clear()
    s._display_registry.clear()
    s._rebuild_folds()

    assert texts(s._folds["a"]) == ["v1"]
    assert texts(s._folds["b"]) == []
    # ...and the registry is rebuilt with it, so the NEXT update still routes.
    assert s._display_registry == {"d": "a"}


def test_rebuild_seeds_a_fold_for_an_execution_with_no_messages(tmp_path):
    """`_handle_iopub` indexes `_folds` unguarded, so the map must stay total —
    an execution that emitted nothing still needs its (empty) fold."""
    s = make_session(tmp_path)
    s.journal.insert_execution("silent", 1, "pass")

    s._rebuild_folds()

    assert s._folds["silent"].outputs() == []


def test_finished_owner_snapshot_reflects_a_later_cross_cell_update(tmp_path):
    """The owner's cached `folded_json` is re-materialized on a redirect: it was
    written once by `mark_done`, so a client reading it (rather than the live
    fold) would otherwise still be shown the pre-update content."""
    s = make_session(tmp_path)
    fold_a = seed_exec(s, "a", 1)
    seed_exec(s, "b", 2)
    feed(s, "a", "display_data", display("v0", "d"))
    s.journal.mark_done("a", "done", 1, json.dumps(fold_a.outputs()))

    feed(s, "b", "update_display_data", display("v1", "d"))

    folded = json.loads(s.journal.executions()[0][5])  # executions()[*][5] = folded_json
    assert [o["data"]["text/plain"] for o in folded] == ["v1"]


def test_orphan_finish_time_follows_the_emitter_not_the_owner(tmp_path):
    """RISKS #6 must not regress RISKS-adjacent provenance: an execution frozen
    by `orphan_inflight` keeps the timestamp of the last row IT emitted.

    The redirected update is deliberately B's LAST row, so the assertion reads
    that row's own ``ts`` — a later B-attributed lifecycle row would mask a wrong
    emitter attribution behind `MAX(ts)`.
    """
    s = make_session(tmp_path)
    seed_exec(s, "a", 1)
    seed_exec(s, "b", 2)
    feed(s, "a", "display_data", display("v0", "d"))
    s.journal.mark_started("b")
    feed(s, "b", "update_display_data", display("v1", "d"))

    redirected_ts = s.journal.db.execute(
        "SELECT ts FROM messages WHERE msg_type='update_display_data'"
    ).fetchone()[0]
    assert s.journal.orphan_inflight() >= 1

    finished_at = s.journal.db.execute(
        "SELECT finished_at FROM executions WHERE exec_id='b'"
    ).fetchone()[0]
    assert finished_at == redirected_ts


def test_registry_claims_ownership_only_after_the_creator_row_is_durable(tmp_path):
    """Journal-before-mutate, the same ordering `_handle_comm` keeps (RISKS #14).

    A registry that ran ahead of a failed append would route later updates at an
    owner no `_rebuild_folds` can re-derive — the live daemon and a restarted one
    would disagree about which cell owns the display.
    """
    s = make_session(tmp_path)
    seed_exec(s, "a", 1)
    seed_exec(s, "b", 2)

    def boom(*_a, **_kw):
        raise sqlite3.OperationalError("disk I/O error")

    real_append = s.journal.append_message
    s.journal.append_message = boom
    with pytest.raises(sqlite3.OperationalError):
        feed(s, "a", "display_data", display("v0", "d"))
    s.journal.append_message = real_append

    assert "d" not in s._display_registry
    # ...so a later update is NOT redirected at an owner the journal never recorded.
    feed(s, "b", "update_display_data", display("v1", "d"))
    assert s.journal.db.execute(
        "SELECT target_exec FROM messages WHERE msg_type='update_display_data'"
    ).fetchone() == (None,)


def test_redirect_moves_the_artifact_reference_to_the_owner(tmp_path):
    """The fold that REFERENCES an image decides when GC reclaims it, so a
    redirected frame must ref-count against the OWNER — otherwise the owner's
    superseded PNG is never released (it looks referenced by a fold that never
    saw it) and the new one is deleted the moment the emitter's fold is swept."""
    s = make_session(tmp_path)
    fold_a = seed_exec(s, "a", 1)
    seed_exec(s, "b", 2)

    def image(did):
        return {
            "data": {"image/png": base64.b64encode(PNG).decode()},
            "metadata": {},
            "transient": {"display_id": did},
        }

    feed(s, "a", "display_data", image("d"))
    first = next(iter(fold_a.artifact_ids()))
    rel_first = s.journal.find_artifact(first)[3]
    assert (s.artifacts.workdir / rel_first).exists()

    # A DIFFERENT image from cell B, under A's display id.
    content = image("d")
    content["data"]["image/png"] = base64.b64encode(PNG + b"\x00").decode()
    feed(s, "b", "update_display_data", content)

    second = next(iter(fold_a.artifact_ids()))
    assert second != first
    assert s._folds["b"].artifact_ids() == set()
    # the superseded frame is GC'd (row + file), the new one survives
    assert s.journal.find_artifact(first) is None
    assert not (s.artifacts.workdir / rel_first).exists()
    assert (s.artifacts.workdir / s.journal.find_artifact(second)[3]).exists()

    # ...and a restart re-derives the same single live reference.
    s._folds.clear()
    s._artifact_refs.clear()
    s._rebuild_folds()
    assert s._folds["a"].artifact_ids() == {second}
    assert (s.artifacts.workdir / s.journal.find_artifact(second)[3]).exists()


def test_migration_adds_target_exec_to_an_old_journal(tmp_path):
    """A journal written before session-wide routing must open, keep its rows,
    and read them back as un-redirected (NULL target -> the emitter)."""
    path = tmp_path / "old.db"
    db = sqlite3.connect(str(path))
    db.execute(
        "CREATE TABLE messages(msg_seq INTEGER PRIMARY KEY AUTOINCREMENT,"
        " session_id TEXT NOT NULL, exec_id TEXT, msg_type TEXT NOT NULL,"
        " content_json TEXT NOT NULL, artifact_ref TEXT, ts REAL NOT NULL)"
    )
    db.execute(
        "INSERT INTO messages(session_id, exec_id, msg_type, content_json, ts)"
        " VALUES('default','e0','stream','{\"name\":\"stdout\",\"text\":\"old\\n\"}',1.0)"
    )
    db.commit()
    db.close()

    j = Journal(path)  # __init__ runs the additive migration
    assert "target_exec" in {r[1] for r in j.db.execute("PRAGMA table_info(messages)")}
    assert j.messages_after(0) == [(1, "e0", "stream", '{"name":"stdout","text":"old\\n"}')]
    assert [r[1] for r in j.all_messages()] == ["e0"]
    j.close()
    Journal(path).close()  # reopening is idempotent (no duplicate ALTER)
