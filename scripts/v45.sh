#!/usr/bin/env bash
# v45 — KERNEL LIFETIME POLICY (idle GC): a kernel idle past TITHON_KERNEL_IDLE_TIMEOUT
#       with no attached client and nothing running/queued is reaped host-side; the
#       journal + artifacts survive, so reopening the file restores its outputs under
#       a FRESH kernel (only the namespace is lost). Guards proven on real processes:
#       a BUSY kernel (long cell mid-run) and an ATTACHED session are never reaped.
# Hermetic: real daemon + real detached kernels over the unix socket via the CLI.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v45 FAIL $1"; exit 1; }

A="file:///proj/idle.py"     # runs one cell, client leaves -> must be reaped
B="file:///proj/busy.py"     # long cell still running          -> must survive
C="file:///proj/watched.py"  # client stays attached            -> must survive

pidA= pidB= pidC= pidA2= C_ATTACH=
cleanup() {
  [ -n "$C_ATTACH" ] && kill "$C_ATTACH" 2>/dev/null
  cleanup_procs
  # This test spawns kernels for 3+ file sessions; reap them all (targeted to
  # THIS test's TITHON_HOME so parallel tests are untouched).
  pkill -9 -f "[i]pykernel_launcher.*-f $TITHON_HOME" 2>/dev/null
  return 0
}
trap cleanup EXIT

session_pid() { # $1 = session id -> its kernel pid from the global status ('' if absent)
  timeout 10 "$TITHON" status | "$PY" -c "
import json, sys
sessions = {d['session']: d['kernel_pid'] for d in json.load(sys.stdin)['sessions']}
print(sessions.get(sys.argv[1]) or '')
" "$1"
}

setup_env v45
export TITHON_KERNEL_IDLE_TIMEOUT=3   # reap after 3s idle (production default: 0 = never)
export TITHON_GC_POLL=1               # sweep every 1s so the test is fast
start_daemon || fail "daemon start failed"

# 1) A runs a cell, then its client disconnects -> A's idle clock starts.
timeout 60 "$TITHON" run --session "$A" -c "x = 42
print('A_SET', x)" --timeout 60 | grep -q "A_SET 42" || fail "A run failed"
pidA="$(session_pid "$A")"
[ -n "$pidA" ] || fail "no kernel pid for A"

# 2) B starts a LONG cell (still running through the whole GC window).
timeout 30 "$TITHON" run --session "$B" -c "import time
time.sleep(30)" --no-wait >/dev/null || fail "B submit failed"
pidB="$(session_pid "$B")"
[ -n "$pidB" ] || fail "no kernel pid for B"

# 3) C keeps a client ATTACHED (a live subscriber) through the GC window.
timeout 30 "$TITHON" attach --session "$C" >"$TITHON_HOME/c_attach.log" 2>&1 &
C_ATTACH=$!
for _ in $(seq 1 60); do pidC="$(session_pid "$C")"; [ -n "$pidC" ] && break; sleep 0.5; done
[ -n "$pidC" ] || fail "no kernel pid for C (attach did not create the session)"

# The status surface exposes the lifetime info the pickers show.
timeout 10 "$TITHON" status | grep -q '"idle_seconds"' || fail "status lacks idle_seconds"
timeout 10 "$TITHON" status | grep -q '"clients"' || fail "status lacks clients"

# 4) Wait past the idle timeout (+ sweep slack): only A may be reaped.
sleep 7
kill -0 "$pidA" 2>/dev/null && fail "idle kernel A (pid $pidA) still alive after timeout"
timeout 10 "$TITHON" status | grep -q "$A" && fail "reaped session A still listed in status"
kill -0 "$pidB" 2>/dev/null || fail "BUSY kernel B (pid $pidB) was reaped mid-cell"
kill -0 "$pidC" 2>/dev/null || fail "ATTACHED session C's kernel (pid $pidC) was reaped"

# 5) The reap lost no history: a fresh attach restores A's pre-GC output from the
#    journal (under a NEW kernel), and the reap itself is journaled (status=gc).
snap="$(timeout 60 "$TITHON" attach --session "$A" --once)" || fail "re-attach to A failed"
echo "$snap" | grep -q "A_SET 42" || fail "A's snapshot lost its pre-GC output"
delta="$(timeout 60 "$TITHON" attach --session "$A" --since 1 --once)" || fail "delta attach failed"
echo "$delta" | grep -Fq '"status": "gc"' || fail "journal has no tithon.kernel gc event"

# 6) Fresh kernel semantics: the namespace is gone, the pid is new.
out="$(timeout 60 "$TITHON" run --session "$A" -c "print('A_FRESH', 'x' in dir())" --timeout 60)"
echo "$out" | grep -q "A_FRESH False" || fail "reaped A kept its namespace ($out)"
pidA2="$(session_pid "$A")"
[ -n "$pidA2" ] && [ "$pidA2" = "$pidA" ] && fail "A's kernel pid unchanged after reap"

echo "RESULT v45 PASS idle kernel reaped (pid $pidA -> gone), busy ($pidB) + attached ($pidC) survived, journal restored A's output under a fresh kernel ($pidA2)"
