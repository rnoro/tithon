"""Session storage layout (ADR-044): the kernel connection file (hmac key), pid,
log and journal live under ~/.tithon with READABLE, project-qualified dir names;
only artifacts (+ the kernel cwd) are rooted at the file's OWN project — fixing
the bug where every session shared the daemon's single launch cwd."""
from pathlib import Path

from tithon.daemon import DEFAULT_SESSION, _session_layout


def test_default_session_keeps_historical_layout(tmp_path):
    home, cwd = tmp_path / "home", tmp_path / "cwd"
    sd, wd = _session_layout(home, DEFAULT_SESSION, None, cwd)
    assert sd == home / "sessions" / "default"
    assert wd == cwd


def test_file_session_is_readable_and_project_rooted(tmp_path):
    home, cwd = tmp_path / "home", tmp_path / "cwd"
    root = "/home/u/projects/myproj"
    sd, wd = _session_layout(home, f"file://{root}/src/train.py", root, cwd)
    assert wd == Path(root)                                  # NOT the daemon cwd
    rel = sd.relative_to(home / "sessions")
    assert rel.parts[0].startswith("myproj-")               # project-qualified
    assert rel.parts[-2:] == ("src", "train.py")            # mirrors the source tree


def test_same_name_different_projects_do_not_collide(tmp_path):
    home, cwd = tmp_path / "home", tmp_path / "cwd"
    a, _ = _session_layout(home, "file:///a/proj/train.py", "/a/proj", cwd)
    b, _ = _session_layout(home, "file:///b/proj/train.py", "/b/proj", cwd)
    assert a != b
    assert a.name == "train.py" and b.name == "train.py"    # both still readable


def test_no_workdir_falls_back_to_hash_and_cwd(tmp_path):
    home, cwd = tmp_path / "home", tmp_path / "cwd"
    sd, wd = _session_layout(home, "file:///x/y/train.py", None, cwd)
    assert wd == cwd
    assert sd.parent == home / "sessions" and len(sd.name) == 16
    # a uri whose path is NOT under the given root: artifacts still at the root,
    # but the kernel/journal dir falls back to a stable hash.
    sd2, wd2 = _session_layout(home, "file:///elsewhere/train.py", "/a/proj", cwd)
    assert wd2 == Path("/a/proj") and len(sd2.name) == 16
