#!/usr/bin/env bash
# v58 — KERNEL PROCESS-GROUP CLEANUP: a deliberate kernel termination must take
#       down the workers the kernel forked (multiprocessing pool / torch
#       DataLoader), not just the kernel's own pid. Those workers inherit the
#       kernel's process group (setsid at spawn) and, when only the leader is
#       signalled, survive re-parented to init with nothing left that could ever
#       collect them — they even keep `ipykernel_launcher` in their cmdline, so
#       `ps` reports a crowd of kernels for one file.
#       Proven on real processes, over the CLI, against a real daemon:
#         1. kill  -> kernel AND worker gone
#         2. restart -> pre-restart worker gone, new kernel pid
#         3. daemon restart -> kernel AND worker SURVIVE (the opposite invariant:
#            detached kernels outlive the daemon — that is the product)
#         4. a kernel killed behind the daemon's back (crash/OOM) leaves orphans;
#            the next spawn sweeps them.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v58 FAIL $1"; exit 1; }

A="file:///proj/kill.py"
B="file:///proj/restart.py"
C="file:///proj/survive.py"

cleanup() {
  cleanup_procs
  # Workers are forks of the kernel, so they carry the kernel's cmdline and the
  # standard sweep (which matches this test's TITHON_HOME) reaches them too.
  pkill -9 -f "[i]pykernel_launcher.*-f $TITHON_HOME" 2>/dev/null
  return 0
}
trap cleanup EXIT

# A cell that forks a worker the way a DataLoader does, then reports both pids.
WORKER_CELL='import multiprocessing as mp, os, time
def _work():
    time.sleep(600)
p = mp.Process(target=_work)
p.start()
print("PIDS", os.getpid(), p.pid, flush=True)'

pgid_of() { # $1 = pid -> its process group id ('' if the pid is gone)
  # /proc/<pid>/stat: comm can contain spaces and parens, so read the fields
  # AFTER the last ')': state, ppid, pgrp.
  sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $3}'
}

run_worker_cell() { # $1 = session -> "<kernel pid> <worker pid>"
  local out
  out="$(timeout 90 "$TITHON" run --session "$1" -c "$WORKER_CELL" --timeout 60)" || return 1
  echo "$out" | awk '/^PIDS /{print $2, $3}'
}

wait_gone() { # $1 = pid; up to ~10s
  for _ in $(seq 1 100); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

setup_env v58
start_daemon || fail "daemon start failed"

# 1) `tithon kill` — the explicit "terminate this session's kernel" op.
pids="$(run_worker_cell "$A")" || fail "A worker cell failed"
kA="$(echo "$pids" | awk '{print $1}')"; wA="$(echo "$pids" | awk '{print $2}')"
[ -n "$kA" ] && [ -n "$wA" ] || fail "A did not report kernel/worker pids ($pids)"
kill -0 "$wA" 2>/dev/null || fail "A worker not running ($wA)"
[ "$(pgid_of "$wA")" = "$kA" ] || fail "A worker is not in the kernel's process group"

timeout 30 "$TITHON" kill --session "$A" >/dev/null || fail "kill op failed"
wait_gone "$kA" || fail "kill left the kernel alive ($kA)"
wait_gone "$wA" || fail "kill orphaned the worker ($wA) — the kernel's group survived"

# 2) `tithon restart` — same teardown, followed by a fresh kernel.
pids="$(run_worker_cell "$B")" || fail "B worker cell failed"
kB="$(echo "$pids" | awk '{print $1}')"; wB="$(echo "$pids" | awk '{print $2}')"
[ -n "$kB" ] && [ -n "$wB" ] || fail "B did not report kernel/worker pids ($pids)"
timeout 60 "$TITHON" restart --session "$B" | grep -q kernel_restarted || fail "restart op failed"
wait_gone "$wB" || fail "restart orphaned the pre-restart worker ($wB)"
kB2="$(timeout 10 "$TITHON" status | "$PY" -c "
import json,sys
print({d['session']: d['kernel_pid'] for d in json.load(sys.stdin)['sessions']}.get('$B') or '')
")"
[ -n "$kB2" ] && [ "$kB2" != "$kB" ] || fail "B has no fresh kernel after restart ($kB -> $kB2)"

# 3) The opposite invariant: a DAEMON restart must not touch kernel or workers.
pids="$(run_worker_cell "$C")" || fail "C worker cell failed"
kC="$(echo "$pids" | awk '{print $1}')"; wC="$(echo "$pids" | awk '{print $2}')"
[ -n "$kC" ] && [ -n "$wC" ] || fail "C did not report kernel/worker pids ($pids)"
dp="$(daemon_pid)"; [ -n "$dp" ] || fail "no daemon pid"
kill -9 "$dp" || fail "daemon kill -9 failed"
sleep 0.5
start_daemon || fail "daemon restart failed"
kill -0 "$kC" 2>/dev/null || fail "daemon restart killed the detached kernel ($kC)"
kill -0 "$wC" 2>/dev/null || fail "daemon restart killed the kernel's worker ($wC)"
out="$(timeout 90 "$TITHON" run --session "$C" -c "print('C_ALIVE', p.is_alive())" --timeout 60)" \
  || fail "C not usable after daemon restart"
echo "$out" | grep -q "C_ALIVE True" || fail "C's kernel lost its worker across the daemon restart ($out)"

# 4) A kernel killed behind the daemon's back leaves orphans; the next spawn
#    sweeps them (the daemon that recorded the group is gone by then, so this
#    exercises the pid-file path, not the in-memory one).
kill -9 "$kC" || fail "could not kill C's kernel"
wait_gone "$kC" || fail "C's kernel still alive after kill -9"
kill -0 "$wC" 2>/dev/null || fail "precondition: worker $wC should be orphaned, not dead"
dp="$(daemon_pid)"; kill -9 "$dp"; sleep 0.5
start_daemon || fail "second daemon restart failed"
out="$(timeout 90 "$TITHON" run --session "$C" -c "print('C_FRESH', 'p' in dir())" --timeout 60)" \
  || fail "C did not come back on a fresh kernel"
echo "$out" | grep -q "C_FRESH False" || fail "C did not spawn a fresh kernel ($out)"
wait_gone "$wC" || fail "orphaned worker ($wC) survived the next kernel spawn"

echo "RESULT v58 PASS kill+restart take down the kernel's forked workers (A $kA/$wA, B $kB/$wB), a daemon restart does not (C $kC/$wC survived), and the next spawn sweeps orphans of a crashed kernel"
