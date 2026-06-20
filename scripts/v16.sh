#!/usr/bin/env bash
# v16 — REAL VSCode reconnect must restore cell STATE (done/running/queued) + timing,
#       running (driven by a separate client), then a fresh VSCode client
#       attaches partway through and must show BOTH the pre-reconnect output
#       (restored) AND the rest streamed live — seamless. Needs network + xvfb
#       (see scripts/v8.sh header); run via `make vscode`.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v16 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v16
FIX="$WORK/states.py"
cat >"$FIX" <<'PYEOF'
# %% A
print("DONE_CELL")

# %% B
import time
for i in range(40):
    print(i, flush=True)
    time.sleep(0.5)

# %% C
print("QUEUED_CELL")
PYEOF

start_daemon || fail "daemon start failed"
echo "v16: daemon up (pid $(daemon_pid)); launching VSCode reconnect test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="reconnectstates"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -E '^\[v16\]|[0-9]+ passing|failing|AssertionError|timed out' "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode reconnect test failed (rc=$rc)"
echo "RESULT v16 PASS real VSCode host: mid-run reconnect restored done/running/queued cell state + timing; $passed_line"
