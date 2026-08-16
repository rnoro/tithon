"""Restoring a file's cells on open is only justified when the user did not
close the session on purpose.

A daemon restart, a host reboot, an idle-GC reap and a dropped tunnel are all
involuntary — the whole point of Tithon is that output survives them. Killing
the kernel yourself is not: re-seeding then hands back output that was
deliberately walked away from, on that open and on every open after it.
"""

import json

from tithon.daemon import Session


def make_session(tmp_path, name: str = "train.py") -> Session:
    work = tmp_path / "proj"
    work.mkdir(parents=True, exist_ok=True)
    return Session(f"file://{work}/{name}", tmp_path / "sess", work)


def test_default_is_armed(tmp_path):
    s = make_session(tmp_path)
    assert s.closed_by_user is False
    assert s.snapshot()["closed_by_user"] is False


def test_flag_outlives_the_daemon(tmp_path):
    """It is stored in the journal, not in memory: the daemon that observed the
    intent is usually gone by the time the file is reopened."""
    s = make_session(tmp_path)
    s.set_closed_by_user(True)

    reopened = make_session(tmp_path)  # a fresh Session on the same journal

    assert reopened.closed_by_user is True
    assert reopened.snapshot()["closed_by_user"] is True


def test_running_a_cell_re_arms_restore(tmp_path):
    s = make_session(tmp_path)
    s.set_closed_by_user(True)

    s.submit("print('back to work')")

    assert s.closed_by_user is False
    assert make_session(tmp_path).closed_by_user is False


def test_closing_keeps_the_history(tmp_path):
    """Not a delete: the outputs stay, the client is just told not to re-seed
    them unasked, so a 'restore previous outputs' action can still work."""
    s = make_session(tmp_path)
    s.journal.insert_execution("e1", 1, "print(1)")
    s.journal.mark_done(
        "e1", "done", 1, json.dumps([{"output_type": "stream", "name": "stdout", "text": "1\n"}])
    )

    s.set_closed_by_user(True)

    snap = make_session(tmp_path).snapshot()
    assert snap["closed_by_user"] is True
    assert [e["exec_id"] for e in snap["executions"]] == ["e1"]
    assert snap["executions"][0]["outputs"][0]["text"] == "1\n"


def test_a_killed_session_cannot_be_re_armed(tmp_path):
    """Two clients can be attached at once and a connection binds its session
    for life, so after client B kills the kernel, client A's already-bound
    handler can still submit. That must not clear the flag on a session being
    torn down — the next open would restore the history the kill retired."""
    s = make_session(tmp_path)
    s.set_closed_by_user(True)
    s._killed = True

    s.submit("print('from a client that has not noticed')")

    assert s.closed_by_user is True
    assert make_session(tmp_path).closed_by_user is True


def test_setting_the_same_value_does_not_rewrite(tmp_path):
    s = make_session(tmp_path)
    s.set_closed_by_user(False)
    assert s.journal.get_meta("closed_by_user") is None  # no write at all
    s.set_closed_by_user(True)
    s.set_closed_by_user(True)
    assert s.journal.get_meta("closed_by_user") == "1"
