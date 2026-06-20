#!/usr/bin/env bash
# v37 — REAL VSCode: clearing a cell's output must NOT leave it stuck "running",
#       and live output must not keep the notebook perpetually dirty.
#   - starts a real daemon (the in-host test drives the cell),
#   - launches VSCode via @vscode/test-electron under xvfb,
#   - tithon.startLive attaches; the test runs a cell that prints CLEARME, then
#     issues the native "Clear All Cell Outputs" command and asserts:
#       (A) the notebook was never dirtied by live output (transientOutputs), and
#       (B) the cleared cell has no open proxy execution afterwards — i.e. the
#           daemon's clear_output tombstone echo did NOT resurrect a phantom
#           spinner (the user-reported "clearing leaves the cell stuck running").
# The durable-clear daemon path is unit/hermetic-verified (test_clear.py, v34);
# this verifies the real-VSCode spinner + dirty behavior. Needs network + xvfb
# (see scripts/v8.sh header for apt prerequisites); run via `make vscode`.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v37 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v37
FIX="$WORK/clearme.py"
cat >"$FIX" <<'PY'
# %% clearme
print("CLEARME")
PY

start_daemon || fail "daemon start failed"
echo "v37: daemon up (pid $(daemon_pid)); launching VSCode clear/spinner test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="clearspinner"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode clear/spinner test failed (rc=$rc)"
echo "RESULT v37 PASS real VSCode clear leaves no stuck spinner + outputs stay transient (not dirty); $passed_line"
