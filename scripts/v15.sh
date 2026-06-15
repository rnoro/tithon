#!/usr/bin/env bash
# v15 — REAL VSCode mid-run RECONNECT (SPEC.md): a long loop is already
#       running (driven by a separate client), then a fresh VSCode client
#       attaches partway through and must show BOTH the pre-reconnect output
#       (restored) AND the rest streamed live — seamless. Needs network + xvfb
#       (see scripts/v8.sh header); run via `make verify-d`.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v15 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$d/npx" ] && PATH="$d:$PATH" && break
  done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v15-npm.log 2>&1) || fail "npm install failed"; }

(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v15
FIX="$WORK/train.py"
cat >"$FIX" <<'PY'
# %% training loop
import time
for i in range(30):
    print(i, flush=True)
    time.sleep(0.5)
PY

start_daemon || fail "daemon start failed"
echo "v15: daemon up (pid $(daemon_pid)); launching VSCode reconnect test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="reconnect"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -E '^\[v15\]|[0-9]+ passing|failing|AssertionError|timed out' "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode reconnect test failed (rc=$rc)"
echo "RESULT v15 PASS real VSCode host: mid-run reconnect restored prior output and continued live; $passed_line"
