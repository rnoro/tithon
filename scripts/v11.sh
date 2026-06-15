#!/usr/bin/env bash
# v11 — REAL VSCode "just press the play button" path (the flow a user actually
#       does, and the one that was broken — see DECISIONS ADR-019 #1).
#   - opens a tithon-py notebook, selects the Tithon kernel,
#   - runs a cell via the NATIVE command (no manual tithon.startLive),
#   - asserts the cell shows the streamed output.
# Before the fix the cell stayed empty (executeHandler was a no-op and the submit
# path closed its socket before output arrived). Needs network + xvfb (see
# scripts/v8.sh header for apt prerequisites); run via `make verify-d`.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v11 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$d/npx" ] && PATH="$d:$PATH" && break
  done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v11-npm.log 2>&1) || fail "npm install failed"; }

(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v11
FIX="$WORK/runcell.py"
cat >"$FIX" <<'PY'
# %% cell
import time
for i in range(5):
    print(f"Iteration {i}", flush=True)
    time.sleep(0.1)
PY

start_daemon || fail "daemon start failed"
echo "v11: daemon up (pid $(daemon_pid)); launching VSCode native-run test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="runcell"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode native-run test failed (rc=$rc)"
echo "RESULT v11 PASS real VSCode host: native play button showed cell output with no manual live step; $passed_line"
