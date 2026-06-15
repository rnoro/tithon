#!/usr/bin/env bash
# v9 — ⑨ daemon backpressure / host protection: a slow (frozen) client must NOT
#      degrade the GPU host. With a stalled subscriber attached and frozen
#      (SIGSTOP — its event loop stopped, never reading), the daemon must:
#        (1) keep the kernel stream flowing — a fast client's 20k-event run still
#            completes promptly (the stalled client doesn't block iopub/exec),
#        (2) stay responsive — `status` answers quickly,
#        (3) stay alive.
# Per-subscriber memory is bounded by construction (capped event queue +
# write_limit on the transport; undelivered bytes sit in the OS socket buffer,
# not daemon memory) and the drop-on-overflow / drop-on-stall paths are proven
# deterministically in test/test_backpressure.py. Hermetic (real
# daemon+kernel, no network/display) — part of `make verify`.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v9 FAIL $1"; exit 1; }
SC=""
cleanup_v9() { [ -n "$SC" ] && { kill -CONT "$SC" 2>/dev/null; kill -9 "$SC" 2>/dev/null; }; cleanup_procs; }
trap cleanup_v9 EXIT

setup_env v9
start_daemon || fail "daemon start failed"
DP="$(daemon_pid)"
echo "v9: daemon up (pid $DP)"

# Attach a subscriber, then freeze it so its event loop stops reading entirely.
# Run python directly (no `timeout` wrapper) so $! is the client itself.
"$PY" "$ROOT/scripts/_stalled_client.py" "$TITHON_HOME/daemon.sock" 120 \
  >"$TITHON_HOME/stalled.log" 2>&1 &
SC=$!
for _ in $(seq 1 50); do
  grep -q "attached" "$TITHON_HOME/stalled.log" 2>/dev/null && break
  sleep 0.2
done
grep -q "attached" "$TITHON_HOME/stalled.log" || fail "stalled client failed to attach"
kill -STOP "$SC" 2>/dev/null || fail "could not freeze stalled client"
[ "$(ps -o stat= -p "$SC" 2>/dev/null | cut -c1)" = "T" ] || fail "stalled client not frozen"
echo "v9: stalled subscriber attached and frozen (SIGSTOP)"

# (1) The kernel stream must keep flowing for a fast client despite the frozen one.
t0=$(date +%s%3N)
timeout 60 "$TITHON" run -c 'for i in range(20000): print(i)' >/dev/null 2>&1 \
  || fail "fast 20k-event run did not complete while a frozen client was attached"
t1=$(date +%s%3N); run_ms=$((t1 - t0))
[ "$run_ms" -lt 30000 ] || fail "fast run was throttled by the frozen client (${run_ms}ms)"
echo "v9: fast 20k-event run completed in ${run_ms}ms despite the frozen client"

# (2) The daemon must stay responsive while the frozen client is attached.
s0=$(date +%s%3N)
timeout 5 "$TITHON" status >/dev/null 2>&1 || fail "daemon unresponsive to status"
s1=$(date +%s%3N); st_ms=$((s1 - s0))
echo "v9: status answered in ${st_ms}ms with the frozen client attached"

# (3) Daemon still alive.
kill -0 "$DP" 2>/dev/null || fail "daemon died"

echo "RESULT v9 PASS host healthy with a frozen client: 20k-run ${run_ms}ms, status ${st_ms}ms, daemon alive; per-sub memory bounded (queue+write_limit), drop proven in test_backpressure.py"
