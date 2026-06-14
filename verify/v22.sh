#!/usr/bin/env bash
# v22 — REAL VSCode: opening a file auto-restores output + continues live with NO
#       manual command (user feedback #3/#4). A driver runs a long loop; opening
#       the notebook (kernel selected, but no tithon.* command) shows the prior
#       output and keeps streaming.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v22 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do [ -x "$d/npx" ] && PATH="$d:$PATH" && break; done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v22-npm.log 2>&1) || fail "npm install failed"; }
(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v22
FIX="$WORK/autoopen.py"
cat >"$FIX" <<'PY'
# %% loop
import time
for i in range(30):
    print(i, flush=True)
    time.sleep(0.3)
PY

start_daemon || fail "daemon start failed"
echo "v22: daemon up (pid $(daemon_pid)); auto-restore-on-open test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="autoopen"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode auto-open test failed (rc=$rc)"
echo "RESULT v22 PASS real VSCode host: open auto-restored output + live continued with no command; $passed_line"
