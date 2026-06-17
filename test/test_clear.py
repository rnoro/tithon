"""User-initiated clear is durable (SPEC.md append-only journal).

Clearing a cell's output appends a synthetic ``clear_output`` tombstone — it does
NOT delete journal rows — so the folded snapshot empties, a fresh attach does not
restore the cleared output, the cached ``folded_json`` is re-materialized, and the
freed image artifact is GC'd. The originals stay in ``messages`` (auditable)."""
import asyncio
import base64
import json
from collections import Counter

from tithon.daemon import Session, Subscriber
from tithon.folding import ExecutionFold

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


def _seed_exec_with_output(s: Session, exec_id: str = "e1") -> ExecutionFold:
    """One finished execution with a stream + an image artifact, mirroring the
    daemon's iopub path (extract -> fold.apply -> append_message -> mark_done)."""
    s.journal.insert_execution(exec_id, 1, "print('x'); display(fig)")
    fold = ExecutionFold()
    fold.apply("stream", {"name": "stdout", "text": "hello\n"})
    s.journal.append_message(exec_id, "stream", {"name": "stdout", "text": "hello\n"})
    content = {"data": {"image/png": base64.b64encode(PNG).decode()}}
    refs = s.artifacts.extract(exec_id, content)  # writes file + registers + mutates to ref
    fold.apply("display_data", content)
    s.journal.append_message(exec_id, "display_data", content, ",".join(refs))
    s.journal.mark_done(exec_id, "done", 1, json.dumps(fold.outputs()))
    s._folds[exec_id] = fold
    # The live ref counter normally accrues in _handle_iopub; seed it here.
    s._artifact_refs = Counter(fold.artifact_ids())
    return fold


def test_clear_outputs_empties_fold_and_persists(tmp_path):
    s = make_session(tmp_path)
    fold = _seed_exec_with_output(s)
    aid = next(iter(fold.artifact_ids()))
    rel = s.journal.find_artifact(aid)[3]
    assert (s.artifacts.workdir / rel).exists()
    assert fold.outputs()  # non-empty before

    n = s.clear_outputs(["e1"])

    assert n == 1
    assert fold.outputs() == []                          # folded view emptied
    folded_col = s.journal.executions()[0][5]            # executions()[*][5] = folded_json
    assert json.loads(folded_col) == []                  # cached snapshot re-materialized
    # tombstone appended; originals preserved (append-only journal).
    types = [m[1] for m in s.journal.messages_for_exec("e1")]
    assert types[-1] == "clear_output"
    assert "stream" in types and "display_data" in types
    # the freed image is GC'd (file + row gone).
    assert s.journal.find_artifact(aid) is None
    assert not (s.artifacts.workdir / rel).exists()


def test_clear_outputs_broadcasts_and_survives_rebuild(tmp_path):
    s = make_session(tmp_path)
    _seed_exec_with_output(s)
    sub = Subscriber(asyncio.Queue(maxsize=100))
    s._subs.add(sub)

    assert s.clear_outputs(None) == 1  # clear-all

    seen = []
    while not sub.queue.empty():
        seen.append(sub.queue.get_nowait())
    assert any(ev.get("payload", {}).get("msg_type") == "clear_output" for ev in seen)

    # Rebuild folds from the raw journal (a daemon restart) — still cleared,
    # because the clear_output tombstone replays like any other message.
    s._folds.clear()
    s._rebuild_folds()
    assert s._folds["e1"].outputs() == []


def test_clear_outputs_unknown_exec_is_noop(tmp_path):
    s = make_session(tmp_path)
    _seed_exec_with_output(s)
    assert s.clear_outputs(["does-not-exist"]) == 0
    assert s._folds["e1"].outputs()  # untouched
