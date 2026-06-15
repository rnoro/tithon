#!/usr/bin/env bash
# v10 — ⑩ REAL VSCode live output sync: a long-running cell streams into the
#       notebook cell *as it runs*, inside an actual Extension Host (xvfb).
#   - starts a real daemon (no pre-seed; the test drives a slow loop),
#   - launches VSCode via @vscode/test-electron under xvfb,
#   - tithon.startLive attaches and mirrors the stream; the in-host test submits
#     a 20-step slow loop and asserts the cell stdout GROWS over time and ends
#     with all 20 lines (live, not a single end-of-run dump).
# Coalescing/bounds are unit-verified (test/liveSync.test.ts); this verifies the
# live wiring renders in real VSCode. Needs network + xvfb (see scripts/v8.sh
# header for the apt prerequisites); run via `make verify-d`.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v10 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$d/npx" ] && PATH="$d:$PATH" && break
  done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v10-npm.log 2>&1) || fail "npm install failed"; }

(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v10
FIX="$WORK/live.py"
cat >"$FIX" <<'PY'
# %% slow
import time
for i in range(20):
    print(i, flush=True)
    time.sleep(0.1)
PY

start_daemon || fail "daemon start failed"
echo "v10: daemon up (pid $(daemon_pid)); launching VSCode live test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="live"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode live test failed (rc=$rc)"
echo "RESULT v10 PASS real VSCode host streamed a long cell live (observed incremental growth to 20 lines); $passed_line"
