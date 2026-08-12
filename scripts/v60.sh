#!/usr/bin/env bash
# v60 — THE STOP BUTTON IS PRIORITIZED. One cell is running in file A; the daemon
#       is simultaneously spawning kernels for four other files. The interrupt for
#       A must be answered during that window, not after it — and it must actually
#       stop A's cell.
#
#       Why this is not hypothetical: `_get_session()` holds `_sessions_lock`
#       across `Session.start()`, which waits out a real kernel spawn. Every op
#       that binds a session before running inherits that wait, and `asyncio.Lock`
#       is FIFO-fair, so an op queued behind four in-flight creations waits for all
#       four. Opening a few files is enough to make a stop press arrive seconds
#       late — precisely when a user reaches for it. So `interrupt` is answered
#       above the session bind, with no lock and no session creation.
#
#       Asserted here:
#         1. an interrupt naming a never-opened file answers ok=false and does NOT
#            bring that session (or its kernel) into existence;
#         2. with four kernel spawns in flight, A's interrupt is answered within a
#            fraction of the time those spawns take — the threshold is derived from
#            the measured spawn time, not a fixed stopwatch value;
#         3. it was a real interrupt, not just a fast reply: A's cell ends with
#            KeyboardInterrupt and stops printing;
#         4. the kernel survives, so A can be re-run (the ADR-031 contract, which
#            the priority change must not regress).
# Hermetic: real daemon + real detached kernels over the unix socket, no VSCode.
. "$(dirname "$0")/lib.sh"

HERE="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "RESULT v60 FAIL $1"; exit 1; }

A="file:///proj/v60-running.py"

cleanup() {
  cleanup_procs
  # This test spawns a kernel for A plus four contention sessions; reap them all
  # (targeted to THIS test's TITHON_HOME so parallel tests are untouched).
  pkill -9 -f "[i]pykernel_launcher.*-f $TITHON_HOME" 2>/dev/null
  return 0
}
trap cleanup EXIT

setup_env v60
start_daemon || fail "daemon start failed"

# A runs a long loop that prints ticks, so "did the interrupt land" is observable
# from its output rather than only from the reply.
timeout 60 "$TITHON" run --session "$A" -c "import time
for i in range(600):
    print('tick', i, flush=True)
    time.sleep(0.1)" --no-wait >/dev/null || fail "A submit failed"

# Wait until A is demonstrably mid-cell: an interrupt sent before the cell starts
# would prove nothing (SIGINT to an idle kernel is delivered but stops nothing).
for _ in $(seq 1 120); do
  ticks="$(timeout 60 "$TITHON" attach --session "$A" --once 2>/dev/null | grep -o 'tick [0-9]*' | wc -l)"
  [ "${ticks:-0}" -ge 3 ] && break
  sleep 0.5
done
[ "${ticks:-0}" -ge 3 ] || fail "A's cell never started printing (ticks=${ticks:-0})"
echo "v60: A is mid-cell (ticks=$ticks)"

# 1) + 2): the no-creation property and the contended latency measurement.
timeout 300 "$PY" "$HERE/_check_interrupt_priority.py" \
  --sock "$TITHON_HOME/daemon.sock" --session "$A" --workdir "$WORK" --spawns 4 \
  || exit 1

# 3) It was a real interrupt: A's cell ends with KeyboardInterrupt and stops.
for _ in $(seq 1 60); do
  snap="$(timeout 60 "$TITHON" attach --session "$A" --once 2>/dev/null)"
  echo "$snap" | grep -q "KeyboardInterrupt" && break
  sleep 0.5
done
echo "$snap" | grep -q "KeyboardInterrupt" || fail "A's cell did not raise KeyboardInterrupt"
before="$(echo "$snap" | grep -o 'tick [0-9]*' | wc -l)"
sleep 2
after="$(timeout 60 "$TITHON" attach --session "$A" --once 2>/dev/null | grep -o 'tick [0-9]*' | wc -l)"
[ "$after" -le "$((before + 1))" ] || fail "A's loop kept running after the interrupt ($before -> $after)"
echo "v60: A raised KeyboardInterrupt and stopped printing ($before -> $after ticks)"

# 4) The kernel survived the interrupt, so A can be re-run (ADR-031).
out="$(timeout 60 "$TITHON" run --session "$A" -c "print('A_ALIVE', 1 + 1)" --timeout 60)"
echo "$out" | grep -q "A_ALIVE 2" || fail "A's kernel did not survive the interrupt"

echo "RESULT v60 PASS interrupt answered during 4 concurrent kernel spawns, created no session for an unknown file, stopped A's cell (KeyboardInterrupt), kernel survived for re-run"
