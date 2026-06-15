#!/usr/bin/env bash
# v26 — REAL VSCode: "Restart Daemon" (the interpreter-switch action) stops the
#       daemon, KILLS kernels, and relaunches -> cells run on a fresh kernel (new
#       daemon pid, new kernel pid, namespace reset). This is what makes a Python
#       interpreter change actually take effect.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v26 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do [ -x "$d/npx" ] && PATH="$d:$PATH" && break; done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v26-npm.log 2>&1) || fail "npm install failed"; }
(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v26
FIX="$WORK/restartd.py"
cat >"$FIX" <<'PY'
# %% cell
import os
n = (n + 1) if ('n' in dir()) else 1
print(f"RUN {n} kpid={os.getpid()}", flush=True)
PY

start_daemon || fail "daemon start failed"
echo "v26: daemon up (pid $(daemon_pid)); restart-daemon -> fresh kernel test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="restartdaemon"
export TITHON_PYTHON="$PY"   # so the extension can relaunch the daemon after shutdown
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
v26line="$(grep -E '\[v26\] after restart' "$OUT" | tail -1)"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode restart-daemon test failed (rc=$rc)"
echo "RESULT v26 PASS real VSCode host: restart daemon -> fresh kernel (new pid, namespace reset); ${v26line}; $passed_line"
