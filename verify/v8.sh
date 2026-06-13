#!/usr/bin/env bash
# v8 — ⑧ REAL VSCode integration: the extension restores the daemon's outputs
#      into a real notebook inside an actual Extension Host (xvfb + electron).
#   - starts a real daemon, seeds 3 executions (stdout/execute_result/error),
#   - launches VSCode via @vscode/test-electron under xvfb,
#   - opens the fixture .py as a `tithon-py` notebook, selects the Tithon
#     controller, runs `tithon.restoreOutputs`, and asserts the cells now carry
#     the folded outputs (mocha test, in-host).
# This supersedes the ADR-012 "no display" limitation FOR THIS ENVIRONMENT
# (xvfb + electron libs installed). Needs network (downloads VSCode) + xvfb, so
# it is NOT part of `make verify` (hermetic v1~v7); run via `make verify-d`.
#
# System prerequisites (Debian/Ubuntu; install once, needs root):
#   apt-get install -y xvfb libgtk-3-0 libgbm1 libnss3 libasound2 libxss1 \
#     libxtst6 libxshmfence1 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
#     libxrandr2 libxfixes3 libxext6 libxi6 libcups2 libatk-bridge2.0-0 \
#     libatspi2.0-0 libpango-1.0-0 libcairo2 ca-certificates
# Node dev deps (@vscode/test-electron, mocha) come from extension/package.json.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v8 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"

# Locate node/npx.
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$d/npx" ] && PATH="$d:$PATH" && break
  done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v node >/dev/null 2>&1 || fail "node not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v8-npm.log 2>&1) || fail "npm install failed"; }

# Build the extension (dist/) and the integration sources (out-int/).
(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

# Isolated daemon + a fixture workspace whose cell bodies are what we submit.
setup_env v8
FIX="$WORK/restore.py"
cat >"$FIX" <<'PY'
# %% loop
for i in range(3):
    print(i)
# %% value
41 + 1
# %% boom
raise ValueError("kaboom")
PY

start_daemon || fail "daemon start failed"
echo "v8: daemon up (pid $(daemon_pid)); seeding executions from $FIX"
(cd "$EXT" && timeout 90 node out-int/integration/seed.js "$FIX") || fail "seeding the daemon failed"

# Launch a real VSCode Extension Host under xvfb and run the in-host suite.
export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
echo "v8: launching VSCode (@vscode/test-electron) under xvfb ----------------"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
# Show the in-host mocha output (filter electron's noisy GPU/dbus warnings).
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode integration test failed (rc=$rc)"
echo "RESULT v8 PASS real VSCode host restored daemon outputs into notebook cells (stdout 0/1/2 + result 42 + ValueError); $passed_line"
