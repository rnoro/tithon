#!/usr/bin/env bash
# v38 — REAL VSCode: an ORPHANED execution (in-flight when the kernel/daemon
#       restarted, so no `done` ever comes) must restore its output WITHOUT a
#       perpetual spinner (the user-reported "cell stuck running, 26667s elapsed"
#       on first open).
#   - starts a real daemon (the in-host test drives the cell),
#   - launches VSCode via @vscode/test-electron under xvfb,
#   - the test runs a cell that prints ORPHANME then sleeps (RUNNING with output),
#     then `tithon.restartKernel` (which calls journal.orphan_inflight() for real)
#     and asserts the re-seeded cell shows its output, has NO open proxy execution
#     (no spinner), is not falsely marked successful, and left the notebook clean.
# Needs network + xvfb (see scripts/v8.sh header for apt prerequisites); run via
# `make verify-d`.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v38 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$d/npx" ] && PATH="$d:$PATH" && break
  done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v38-npm.log 2>&1) || fail "npm install failed"; }

(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v38
FIX="$WORK/orphan.py"
cat >"$FIX" <<'PY'
# %% orphan
import time
print("ORPHANME", flush=True)
for i in range(200):
    time.sleep(0.1)
    print(f"tick {i}", flush=True)
PY

start_daemon || fail "daemon start failed"
echo "v38: daemon up (pid $(daemon_pid)); launching VSCode orphaned-restore test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="orphanrestore"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode orphaned-restore test failed (rc=$rc)"
echo "RESULT v38 PASS real VSCode orphaned execution restores output with no stuck spinner; $passed_line"
