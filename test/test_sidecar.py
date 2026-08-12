"""The shared sidecar: outputs travel with the repository, like an .ipynb.

A percent-format ``.py`` carries no outputs, and the journal that does carry them
is machine-local and unshareable (binary SQLite+WAL, no compaction). ``sidecar.py``
projects the folds onto ``<project>/.tithon/cells/<relpath>.json`` so that cloning
the project restores the outputs, with images left as files in
``.tithon/outputs/`` rather than embedded.
"""
import base64
import json
import shutil
from collections import Counter

import pytest

from tithon import sidecar
from tithon.daemon import Session
from tithon.folding import ExecutionFold

# 1x1 transparent PNG (same fixture as test_artifacts/test_clear).
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4"
    "2mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def make_session(tmp_path, project: str = "projA", name: str = "train.py") -> Session:
    """A Session wired to a real journal/artifact store, no kernel spawned."""
    work = tmp_path / project
    work.mkdir(parents=True, exist_ok=True)
    return Session(f"file://{work}/{name}", tmp_path / f"sess-{project}", work)


def seed_exec(s: Session, exec_id: str = "e1", status: str = "done") -> ExecutionFold:
    """One finished execution with a stream + an image, via the daemon's own path."""
    s.journal.insert_execution(exec_id, 1, "print('x'); display(fig)", cell_hash="h1",
                               origin={"uri": s.session_id, "range": None, "index": 0})
    fold = ExecutionFold()
    fold.apply("stream", {"name": "stdout", "text": "hello\n"})
    s.journal.append_message(exec_id, "stream", {"name": "stdout", "text": "hello\n"})
    content = {"data": {"image/png": base64.b64encode(PNG).decode()}}
    refs = s.artifacts.extract(exec_id, content)  # file + row, content mutated to a ref
    fold.apply("display_data", content)
    s.journal.append_message(exec_id, "display_data", content, ",".join(refs))
    s.journal.mark_done(exec_id, status, 1, json.dumps(fold.outputs()))
    s._folds[exec_id] = fold
    s._artifact_refs = Counter(fold.artifact_ids())
    return fold


# -- path derivation --------------------------------------------------------

def test_sidecar_path_mirrors_the_source_tree(tmp_path):
    root = tmp_path / "proj"
    p = sidecar.sidecar_path(root, root / "src" / "train.py")
    assert p == root / ".tithon" / "cells" / "src" / "train.py.json"


def test_sessions_with_nothing_to_share_have_no_sidecar(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    # The CLI/default session has no document, and a file outside the project
    # has nowhere inside it that mirrors its path.
    assert sidecar.sidecar_path(root, None) is None
    assert sidecar.sidecar_path(root, tmp_path / "elsewhere" / "train.py") is None
    assert Session("default", tmp_path / "s", root).sidecar_path is None


# -- publishing -------------------------------------------------------------

def test_publish_writes_refs_not_base64(tmp_path):
    s = make_session(tmp_path)
    seed_exec(s)

    s._publish_sidecar()

    assert s.sidecar_path == tmp_path / "projA" / ".tithon" / "cells" / "train.py.json"
    raw = s.sidecar_path.read_text()
    doc = json.loads(raw)
    assert doc["version"] == sidecar.SIDECAR_VERSION
    assert [e["exec_id"] for e in doc["executions"]] == ["e1"]
    # The image is a reference to a real file, never embedded bytes — the whole
    # point of the artifact store, and what keeps a live plot at one file.
    refs = list(sidecar.artifact_refs(doc["executions"][0]["outputs"]))
    assert len(refs) == 1 and refs[0]["rel_path"].startswith(".tithon/outputs/")
    assert base64.b64encode(PNG).decode() not in raw


def test_publish_is_stable_and_line_oriented(tmp_path):
    """Re-publishing unchanged state must produce byte-identical output, or every
    run would dirty the working tree and conflict on merge."""
    s = make_session(tmp_path)
    seed_exec(s)
    s._publish_sidecar()
    first = s.sidecar_path.read_bytes()
    s._publish_sidecar()
    assert s.sidecar_path.read_bytes() == first
    assert first.endswith(b"\n")
    assert first.count(b"\n") > 5  # indented: a diff points at the field that moved


def test_in_flight_executions_are_not_shared(tmp_path):
    """A queued/running row would import as a cell cut off mid-run on a machine
    that never ran it (and `orphan_inflight` would then relabel it)."""
    s = make_session(tmp_path)
    s.journal.insert_execution("e1", 1, "sleep(9)")  # status 'queued'
    seed_exec(s, "e2")

    s._publish_sidecar()

    doc = json.loads(s.sidecar_path.read_text())
    assert [e["exec_id"] for e in doc["executions"]] == ["e2"]


def test_clear_reaches_the_shared_snapshot(tmp_path):
    """Clearing must not leave the deleted output visible to whoever pulls."""
    s = make_session(tmp_path)
    seed_exec(s)
    s._publish_sidecar()
    assert json.loads(s.sidecar_path.read_text())["executions"][0]["outputs"]

    s.clear_outputs(["e1"])

    assert json.loads(s.sidecar_path.read_text())["executions"][0]["outputs"] == []


# -- cloning ----------------------------------------------------------------

def clone(tmp_path, s: Session) -> Session:
    """Copy the project the way `git clone` would: the tracked `.tithon/` travels,
    the machine-local journal (in TITHON_HOME) does not."""
    shutil.copytree(tmp_path / "projA", tmp_path / "projB")
    dst = Session(f"file://{tmp_path / 'projB'}/train.py", tmp_path / "sess-projB",
                  tmp_path / "projB")
    dst._import_sidecar()
    dst._rebuild_folds()
    return dst


def test_clone_restores_outputs_and_keeps_the_image(tmp_path):
    src = make_session(tmp_path)
    fold = seed_exec(src)
    aid = next(iter(fold.artifact_ids()))
    src._publish_sidecar()

    dst = clone(tmp_path, src)

    execs = dst._execution_snapshots()
    assert [e["exec_id"] for e in execs] == ["e1"]
    assert execs[0]["status"] == "done"
    assert execs[0]["cell_hash"] == "h1"          # so output->cell mapping works
    assert execs[0]["origin"]["index"] == 0
    kinds = [o["output_type"] for o in execs[0]["outputs"]]
    assert kinds == ["stream", "display_data"]
    # `_rebuild_folds` ends in a fold-driven sweep. An imported execution owns no
    # raw messages to replay, so without fold hydration its fold would be empty,
    # the refcount zero, and the sweep would delete the very image that was cloned.
    assert dst._artifact_refs[aid] == 1
    art = dst.read_artifact(aid)
    assert art["found"] is True
    assert base64.b64decode(art["data_b64"]) == PNG


def test_clone_of_a_cleared_notebook_restores_nothing(tmp_path):
    src = make_session(tmp_path)
    seed_exec(src)
    src.clear_outputs(["e1"])
    src._publish_sidecar()

    dst = clone(tmp_path, src)

    assert dst._execution_snapshots()[0]["outputs"] == []


def test_imported_executions_advertise_no_continuation(tmp_path):
    """`fold_state` tells a client how to KEEP folding; an imported execution ran
    elsewhere and is terminal, so claiming one would be a lie."""
    src = make_session(tmp_path)
    seed_exec(src)
    src._publish_sidecar()

    dst = clone(tmp_path, src)

    assert dst._execution_snapshots()[0]["fold_state"] is None
    assert dst.snapshot()["executions"][0]["outputs"]


def test_local_runs_are_never_overwritten_by_a_pull(tmp_path):
    """Once the user has run something here, this machine's record wins — a
    colleague's newer sidecar must not delete their history."""
    src = make_session(tmp_path)
    seed_exec(src)
    src._publish_sidecar()
    dst = clone(tmp_path, src)
    seed_exec(dst, "e2")            # the reader runs a cell of their own
    dst.journal.set_meta("sidecar_sha", "stale")   # as if a newer sidecar arrived

    dst._import_sidecar()

    assert dst.journal.count_local_executions() == 1
    assert [e["exec_id"] for e in dst._execution_snapshots()] == ["e1", "e2"]


def test_a_newer_sidecar_replaces_imported_rows(tmp_path):
    """Before the reader runs anything, pulling a re-run notebook shows the new
    outputs instead of the ones cloned last week."""
    src = make_session(tmp_path)
    seed_exec(src)
    src._publish_sidecar()
    dst = clone(tmp_path, src)
    assert dst.journal.count_executions() == 1

    seed_exec(src, "e2")            # the author runs another cell and pushes
    src._publish_sidecar()
    shutil.copyfile(src.sidecar_path, dst.sidecar_path)   # git pull
    dst._import_sidecar()
    dst._rebuild_folds()

    assert dst.journal.count_local_executions() == 0
    assert [e["exec_id"] for e in dst._execution_snapshots()] == ["e1", "e2"]


def test_reimport_is_skipped_when_the_file_has_not_changed(tmp_path):
    src = make_session(tmp_path)
    seed_exec(src)
    src._publish_sidecar()
    dst = clone(tmp_path, src)
    before = dst.journal.get_meta("sidecar_sha")

    dst._import_sidecar()   # a second start with the same file on disk

    assert before is not None
    assert dst.journal.get_meta("sidecar_sha") == before
    assert dst.journal.count_executions() == 1


def _publish_count_for_batch(tmp_path, n_cells: int) -> int:
    """Drive the exec worker over one batch of `n_cells` and count publishes."""
    import asyncio

    s = make_session(tmp_path)
    s.kernel.pid = 4242
    s.kernel.is_alive = lambda: True
    calls: list[int] = []
    s._publish_sidecar = lambda: calls.append(1)

    async def fake_run_one(exec_id, code, allow_stdin=False):
        return "ok"

    s._run_one = fake_run_one

    async def drive():
        worker = asyncio.create_task(s._exec_worker())
        s.submit_batch([{"code": f"print({i})"} for i in range(n_cells)])
        for _ in range(400):
            await asyncio.sleep(0.005)
            if calls and not s._busy:
                break
        worker.cancel()
        try:
            await worker
        except asyncio.CancelledError:
            pass

    asyncio.run(drive())
    return len(calls)


def test_a_run_all_publishes_once_not_once_per_cell(tmp_path):
    """Publishing re-serializes EVERY execution's fold, so once per cell makes a
    Run All quadratic in the length of the notebook. A batch is one user action
    and gets one write."""
    assert _publish_count_for_batch(tmp_path / "many", 12) == 1
    # ...and the batching is not just "never publishes".
    assert _publish_count_for_batch(tmp_path / "one", 1) == 1


def test_publishing_records_its_own_bytes(tmp_path):
    """Otherwise the next start would read the daemon's own write back as an
    incoming change and re-import over live rows."""
    s = make_session(tmp_path)
    seed_exec(s)

    s._publish_sidecar()

    assert s.journal.get_meta("sidecar_sha") == sidecar.read(s.sidecar_path)[1]


# -- robustness -------------------------------------------------------------

@pytest.mark.parametrize("body", ["", "not json", '{"version": 999, "executions": []}',
                                  '{"version": 1}', '[]'])
def test_unusable_sidecars_are_ignored_not_fatal(tmp_path, body):
    """A sidecar is an optimization over an empty notebook, never a reason to
    fail an open — including one written by a future client."""
    s = make_session(tmp_path)
    s.sidecar_path.parent.mkdir(parents=True, exist_ok=True)
    s.sidecar_path.write_text(body)

    assert sidecar.read(s.sidecar_path) is None
    s._import_sidecar()     # must not raise
    assert s.journal.count_executions() == 0


def test_missing_image_degrades_instead_of_failing(tmp_path):
    """A ref whose file did not travel stays unregistered and falls back to text,
    the same as any other missing artifact."""
    src = make_session(tmp_path)
    fold = seed_exec(src)
    aid = next(iter(fold.artifact_ids()))
    src._publish_sidecar()
    shutil.copytree(tmp_path / "projA", tmp_path / "projB")
    for png in (tmp_path / "projB" / ".tithon" / "outputs").iterdir():
        png.unlink()

    dst = Session(f"file://{tmp_path / 'projB'}/train.py", tmp_path / "sess-projB",
                  tmp_path / "projB")
    dst._import_sidecar()
    dst._rebuild_folds()

    assert dst.journal.find_artifact(aid) is None
    assert dst.read_artifact(aid)["found"] is False
    assert [e["exec_id"] for e in dst._execution_snapshots()] == ["e1"]


def test_import_renumbers_ids_so_the_next_local_run_cannot_collide(tmp_path):
    """A sidecar is a tracked, hand-editable, merge-conflict-prone file, so its
    ids are data, not keys. `exec_id "e2"` at `seq 1` would otherwise seed
    `_exec_counter` at 1 and make the reader's next execution collide on the
    primary key."""
    s = make_session(tmp_path)
    doc = {"version": sidecar.SIDECAR_VERSION, "session": s.session_id, "executions": [
        {"exec_id": "e2", "seq": 1, "code": "a", "status": "done", "outputs": []},
        {"exec_id": "e9", "seq": 7, "code": "b", "status": "error", "outputs": []},
    ]}

    assert sidecar.import_into(s.journal, s.artifacts.workdir, doc) == 2

    rows = s.journal.executions()
    assert [r[0] for r in rows] == ["e1", "e2"]        # renumbered in seq order
    assert [r[1] for r in rows] == [1, 2]
    assert [r[2] for r in rows] == ["a", "b"]          # order preserved
    assert s.journal.max_exec_seq() == 2               # what seeds _exec_counter


def test_import_narrows_timings_to_numbers(tmp_path):
    """SQLite stores whatever it is given in a REAL column, and the client
    multiplies these to render a cell's duration."""
    s = make_session(tmp_path)
    doc = {"version": sidecar.SIDECAR_VERSION, "session": s.session_id, "executions": [
        {"exec_id": "e1", "seq": 1, "code": "a", "status": "done", "outputs": [],
         "started_at": "yesterday", "finished_at": True, "execution_count": "many"},
    ]}

    sidecar.import_into(s.journal, s.artifacts.workdir, doc)

    ex = s._execution_snapshots()[0]
    assert ex["started_at"] is None and ex["finished_at"] is None
    assert ex["execution_count"] is None


@pytest.mark.parametrize("bad", [
    {"exec_id": "e1", "seq": 1, "status": "running", "outputs": []},   # not terminal
    {"exec_id": "e1", "seq": 1, "status": "queued", "outputs": []},
    {"exec_id": "e1", "seq": 1, "status": "skipped", "outputs": []},
    {"exec_id": "e1", "seq": 1, "status": "done", "outputs": "nope"},  # wrong shape
    {"exec_id": "e1", "seq": "x", "status": "done", "outputs": []},    # unorderable
    "not even a row",
])
def test_unshareable_rows_are_dropped_not_coerced(tmp_path, bad):
    s = make_session(tmp_path)
    doc = {"version": sidecar.SIDECAR_VERSION, "session": s.session_id, "executions": [bad]}

    assert sidecar.import_into(s.journal, s.artifacts.workdir, doc) == 0
    assert s.journal.count_executions() == 0


def test_the_shared_file_carries_no_machine_paths(tmp_path):
    """`origin.uri` is an absolute path on the author's machine: meaningless to a
    reader and a filesystem layout nobody meant to commit."""
    s = make_session(tmp_path)
    seed_exec(s)

    s._publish_sidecar()

    raw = s.sidecar_path.read_text()
    assert str(tmp_path) not in raw
    origin = json.loads(raw)["executions"][0]["origin"]
    assert origin == {"index": 0, "range": None}


def test_import_rebinds_executions_to_the_readers_own_file(tmp_path):
    """A restore is scoped to the file's own runs (`SessionClient.restoreInto`
    drops any execution whose `origin.uri` is not this notebook), so an imported
    row still naming the author's path would never reach the cells."""
    src = make_session(tmp_path)
    seed_exec(src)
    src._publish_sidecar()

    dst = clone(tmp_path, src)

    origin = dst._execution_snapshots()[0]["origin"]
    assert origin["uri"] == dst.session_id != src.session_id
    assert origin["index"] == 0                 # position still carried


def test_the_shared_file_carries_no_continuation_state(tmp_path):
    """`fold_state` says how to KEEP folding an execution. Every execution in a
    sidecar is terminal, so carrying it would be written, never read, and wrong
    the moment a reader re-published these rows."""
    s = make_session(tmp_path)
    seed_exec(s)

    s._publish_sidecar()

    assert "fold_state" not in json.loads(s.sidecar_path.read_text())["executions"][0]


def test_a_failed_publish_does_not_reclaim_the_images_it_still_names(tmp_path, monkeypatch):
    """Deleting first would leave the committed snapshot advertising an image
    that is gone, which a clone imports as an output it cannot render. Leaking
    the file is the recoverable half — the next publish and sweep collect it."""
    s = make_session(tmp_path)
    fold = seed_exec(s)
    aid = next(iter(fold.artifact_ids()))
    png = s.artifacts.workdir / s.journal.find_artifact(aid)[3]
    s._publish_sidecar()
    monkeypatch.setattr(sidecar, "write", lambda p, d: (_ for _ in ()).throw(OSError(28, "full")))

    assert s.clear_outputs(["e1"]) == 1

    assert png.exists()                                   # not reclaimed
    assert s.journal.find_artifact(aid) is not None
    # ...and the stale shared file still names it, so it stays renderable.
    doc = json.loads(s.sidecar_path.read_text())
    assert list(sidecar.artifact_refs(doc["executions"][0]["outputs"]))


def test_publish_survives_an_unwritable_project(tmp_path, monkeypatch):
    """A read-only checkout or a full disk must not fail the run that produced
    the output. Driven at the write boundary rather than with a chmod, which a
    root-owned test session would silently bypass."""
    s = make_session(tmp_path)
    seed_exec(s)

    def boom(path, doc):
        raise OSError(30, "Read-only file system")

    monkeypatch.setattr(sidecar, "write", boom)
    s._publish_sidecar()          # must not raise

    assert not s.sidecar_path.exists()
    # No sha recorded, so a later writable publish is not mistaken for done.
    assert s.journal.get_meta("sidecar_sha") is None


# -- fold hydration ---------------------------------------------------------

def test_hydrate_round_trips_outputs_and_artifact_ids(tmp_path):
    fold = ExecutionFold()
    fold.apply("stream", {"name": "stdout", "text": "a\nb"})
    fold.apply("display_data", {"data": {"image/png": {"$tithon_artifact": {
        "artifact_id": "sha1", "mime": "image/png", "rel_path": "p.png", "sha256": "sha1"}}}})

    again = ExecutionFold.hydrate(fold.outputs(), fold.fold_state())

    assert again.outputs() == fold.outputs()
    assert again.artifact_ids() == fold.artifact_ids() == {"sha1"}


def test_hydrate_preserves_widget_area_ownership(tmp_path):
    """A property of the helper, not of the import path: `hydrate` is the exact
    inverse of `outputs()` + `fold_state()`, including the `owners` that scope a
    clear to one output area (RISKS #17). The sidecar deliberately carries no
    fold_state — see `test_the_shared_file_carries_no_continuation_state` — so
    the import calls hydrate WITHOUT it, which is sound only because an imported
    execution is terminal and never folds again."""
    fold = ExecutionFold()
    fold.apply("comm_open", {"comm_id": "w1", "target_name": "jupyter.widget",
                             "data": {"state": {}}})
    fold.apply("stream", {"name": "stdout", "text": "cell-level\n"})
    state = {"owners": [None, "w1"], "claims": [], "pending_clear": False,
             "pending_owner_clear": []}
    outputs = [{"output_type": "stream", "name": "stdout", "text": "cell-level\n"},
               {"output_type": "display_data", "data": {}, "metadata": {}}]

    again = ExecutionFold.hydrate(outputs, state)
    again.apply("clear_output", {"wait": False})   # arrives under no claim -> cell scope

    assert again.outputs() == []
    scoped = ExecutionFold.hydrate(outputs, state)
    scoped._claims = ["w1"]
    scoped.apply("clear_output", {"wait": False})  # under w1's claim -> that area only
    assert [o["output_type"] for o in scoped.outputs()] == ["stream"]
