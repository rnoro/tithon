"""RISKS #14: `_handle_comm` must journal BEFORE mutating the Widget State
Mirror. A failed `journal.append_message` (the iopub pump catches a handler
exception and keeps going) must not leave the live mirror ahead of what a
restart's `_rebuild_mirror` would derive from the journal alone — journal and
mirror must never disagree about what was accepted."""
from tithon.daemon import Session


def make_session(tmp_path) -> Session:
    # Session.__init__ wires Journal/ArtifactStore without spawning a kernel.
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return Session("default", tmp_path / "sess", work)


def _open(comm_id: str, value: int) -> dict:
    return {
        "comm_id": comm_id,
        "target_name": "jupyter.widget",
        "data": {"state": {"_model_name": "X", "value": value}},
    }


def _update(comm_id: str, value: int) -> dict:
    return {"comm_id": comm_id, "data": {"method": "update", "state": {"value": value}}}


def test_failed_append_does_not_mutate_the_mirror(tmp_path):
    s = make_session(tmp_path)
    s._handle_comm("e1", "comm_open", _open("c1", 1), [])
    assert s._mirror.snapshot()["state"]["c1"]["state"]["value"] == 1

    def boom(*a, **kw):
        raise RuntimeError("simulated journal write failure")
    s.journal.append_message = boom

    raised = False
    try:
        s._handle_comm("e1", "comm_msg", _update("c1", 2), [])
    except RuntimeError:
        raised = True
    assert raised, "expected the simulated journal failure to propagate"

    # would_accept() ran before the append, so apply() (the mutation) never
    # ran — the mirror must NOT have advanced past the last successful append.
    assert s._mirror.snapshot()["state"]["c1"]["state"]["value"] == 1


def test_live_mirror_matches_a_rebuild_after_a_failed_append(tmp_path):
    """Full RISKS #14 verify: live mirror state (after a transient append
    failure) must equal what a daemon restart's _rebuild_mirror derives from
    the journal alone — not just non-crashing, but byte-identical."""
    s = make_session(tmp_path)
    s._handle_comm("e1", "comm_open", _open("c1", 1), [])

    def boom(*a, **kw):
        raise RuntimeError("simulated journal write failure")
    real_append = s.journal.append_message
    s.journal.append_message = boom
    try:
        s._handle_comm("e1", "comm_msg", _update("c1", 2), [])  # dropped: append failed
    except RuntimeError:
        pass
    s.journal.append_message = real_append

    # A later, successful update lands normally.
    s._handle_comm("e1", "comm_msg", _update("c1", 3), [])

    live_snapshot = s._mirror.snapshot()
    assert live_snapshot["state"]["c1"]["state"]["value"] == 3  # NOT 2 — the failed update never applied

    # Simulate a daemon restart: a FRESH Session reopening the same journal.
    s2 = Session("default", tmp_path / "sess", tmp_path / "work")
    s2._rebuild_mirror()

    assert s2._mirror.snapshot() == live_snapshot
