"""Killing a kernel must take down the workers that kernel forked.

The kernel is spawned with ``start_new_session=True``, so everything a cell
forks — a ``multiprocessing`` pool, a torch ``DataLoader``'s workers — runs in
the kernel's process group. Signalling only the kernel's own pid left those
workers alive and re-parented to init, with nothing left in the system that
could ever collect them: a 48-worker DataLoader outlived its kernel that way,
pinning CPU and GPU memory on the host until an operator noticed.

These tests use a REAL leader process in its own session with a REAL forked
child, not a mock: the whole point is which pids the OS still reports after the
call. The stand-in leader carries ``ipykernel_launcher`` and the connection-file
path in its argv, which is exactly what ``KernelHandle._alive_pid`` matches on,
so the liveness path under test is the production one.

v58.sh proves the same guarantees end to end (real daemon, real kernel, real
worker processes, over the CLI).
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time

import pytest

from tithon.kernel import KernelHandle

# The leader forks one long-lived child (the "worker") and then sleeps, mirroring
# a cell that started a DataLoader and is waiting on it. A real `fork` rather
# than a spawned command, because the worker inheriting the kernel's argv is both
# what makes `ps` report a crowd of kernels and what `_is_ours` proves ownership
# with.
LEADER = """
import os, time
worker = os.fork()          # a fork: keeps the leader's argv, like a DataLoader worker
if worker == 0:
    time.sleep(300)
    os._exit(0)
execd = os.fork()           # in the same group, but its argv is its own
if execd == 0:
    os.execvp("sleep", ["sleep", "300"])
print(worker, execd, flush=True)
time.sleep(300)
"""


def _pid_gone(pid: int, timeout: float = 5.0) -> bool:
    """True once ``pid`` is neither running nor a reapable zombie of ours."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            os.waitpid(pid, os.WNOHANG)  # collect it if it is our child
        except OSError:
            pass
        try:
            os.kill(pid, 0)
        except OSError:
            return True
        time.sleep(0.02)
    return False


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


@pytest.fixture
def handle(tmp_path):
    """A KernelHandle whose "kernel" is a real detached leader + one worker."""
    session_dir = tmp_path / "sessions" / "s"
    session_dir.mkdir(parents=True)
    h = KernelHandle(session_dir, tmp_path, session_dir / "kernel.log")
    h.conn_file.write_text("{}")
    started: list[subprocess.Popen] = []

    def start() -> tuple[int, int, int]:
        """-> (leader, forked worker, exec'd group member)"""
        proc = subprocess.Popen(
            [sys.executable, "-c", LEADER, "ipykernel_launcher", "-f", str(h.conn_file)],
            stdout=subprocess.PIPE,
            start_new_session=True,  # same detaching as the real _spawn
        )
        started.append(proc)
        worker, execd = (int(x) for x in proc.stdout.readline().split())
        h.pid = proc.pid
        h.pgid = h._resolve_pgid(proc.pid)
        h.pid_file.write_text(str(proc.pid))
        return proc.pid, worker, execd

    yield h, start
    for proc in started:  # nothing may outlive the test, pass or fail
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            pass


def test_kill_takes_down_the_workers_the_kernel_forked(handle):
    h, start = handle
    leader, worker, execd = start()
    assert h.pgid == leader  # setsid: the kernel leads its own group

    h.kill()

    assert _pid_gone(leader), "kernel leader survived kill()"
    assert _pid_gone(worker), "forked worker outlived its kernel (orphan)"
    assert _pid_gone(execd), "an exec'd group member outlived its kernel"


def test_kill_leaves_processes_outside_the_kernels_group_alone(handle, tmp_path):
    h, start = handle
    leader, worker, execd = start()
    bystander = subprocess.Popen(["sleep", "300"], start_new_session=True)
    try:
        h.kill()

        assert _pid_gone(worker)
        assert _alive(bystander.pid), "kill() reached outside the kernel's group"
    finally:
        bystander.kill()
        bystander.wait(timeout=5)


def test_kill_sweeps_workers_of_a_kernel_that_already_died(handle):
    """A crashed kernel takes the `gone` shortcut — its workers still must go."""
    h, start = handle
    leader, worker, execd = start()
    os.kill(leader, signal.SIGKILL)  # crash / OOM-kill: only the leader dies
    assert _pid_gone(leader)
    assert _alive(worker)

    h.kill()

    assert _pid_gone(worker), "kill() skipped the sweep because the leader was gone"


def test_spawn_sweeps_orphans_left_by_a_previous_kernel(handle):
    """A daemon restart forgets the pgid; the pid file is what is left of it."""
    h, start = handle
    leader, worker, execd = start()
    os.kill(leader, signal.SIGKILL)
    assert _pid_gone(leader)

    fresh = KernelHandle(h.session_dir, h.workdir, h.log_path)  # no in-memory pgid
    fresh._sweep_orphans()

    assert _pid_gone(worker), "orphaned worker survived the next kernel spawn"


def test_orphan_sweep_spares_a_group_whose_leader_pid_was_recycled(handle, tmp_path):
    """The recorded pid is alive again, leading a group that is not ours.

    Modelled with a second session whose pid file points at the first session's
    LIVE leader: its argv names the other session's connection file, so
    ``_alive_pid`` reads it as "not our kernel" exactly as it would for a
    recycled pid — and the live leader in the group is the tell that the number
    was reused, since our own orphaned group can never have one.
    """
    h, start = handle
    leader, worker, execd = start()
    other_dir = tmp_path / "sessions" / "recycled"
    other_dir.mkdir(parents=True)
    fresh = KernelHandle(other_dir, tmp_path, other_dir / "kernel.log")
    fresh.pid_file.write_text(str(leader))
    assert fresh._alive_pid() is None

    fresh._sweep_orphans()

    assert _alive(worker), "swept a group we could not prove was ours"
    assert _alive(leader)


def test_resolve_pgid_declines_a_process_that_does_not_lead_its_group(tmp_path):
    session_dir = tmp_path / "s"
    session_dir.mkdir()
    h = KernelHandle(session_dir, tmp_path, session_dir / "kernel.log")
    child = subprocess.Popen(["sleep", "300"])  # no setsid: inherits OUR group
    try:
        assert h._resolve_pgid(child.pid) is None
    finally:
        child.kill()
        child.wait(timeout=5)


def test_group_members_ignores_zombies(handle):
    h, start = handle
    leader, worker, execd = start()
    os.kill(worker, signal.SIGKILL)
    os.kill(leader, signal.SIGKILL)  # leader is our child -> unreaped zombie
    time.sleep(0.2)

    # The leader is still listed by /proc, so a killpg(0) probe would say the
    # group is populated; only the state check makes the group read as empty.
    assert leader not in h._group_members(leader)


def test_orphan_sweep_spares_a_group_whose_recycled_leader_died_into_a_zombie(handle, tmp_path):
    """The hole "no LIVE leader" leaves open, and why argv is the real proof.

    A recycled pid can lead a new group and then exit into a zombie while its
    children run on. The member scan filters zombies out, so the group presents
    exactly like one of our orphaned ones — no live leader, live members. Only
    "does a member still carry OUR connection file" separates the two.
    """
    h, start = handle
    leader, worker, execd = start()
    os.kill(leader, signal.SIGKILL)  # a zombie: our fixture has not reaped it
    assert leader not in h._group_members(leader)  # invisible to the scan
    other_dir = tmp_path / "sessions" / "stranger"
    other_dir.mkdir(parents=True)
    stranger = KernelHandle(other_dir, tmp_path, other_dir / "kernel.log")
    stranger.conn_file.write_text("{}")
    stranger.pid_file.write_text(str(leader))  # "its" old kernel had that pid

    stranger._sweep_orphans()

    assert _alive(worker), "swept a group whose members belong to another session"


def test_orphan_sweep_declines_a_group_with_no_member_carrying_our_argv(handle, tmp_path):
    """Conservative by design: an exec'd worker is a leak, not a licence."""
    h, start = handle
    leader, worker, execd = start()
    # Leave only the exec'd member: an exec replaced the inherited argv, so
    # nothing in the group ties it to this session any more.
    os.kill(worker, signal.SIGKILL)
    os.kill(leader, signal.SIGKILL)
    assert _pid_gone(worker) and _pid_gone(leader)

    fresh = KernelHandle(h.session_dir, h.workdir, h.log_path)
    fresh._sweep_orphans()

    assert _alive(execd), "swept a group with nothing tying it to us"
