#!/usr/bin/env bash
# v18 — REAL VSCode: a file stays runnable after close+reopen (user feedback #1).
#       Run cell -> RUN 1; close all editors; reopen; run cell -> RUN 2 (the
#       kernel-resident counter advances, proving real re-execution after reopen).
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v18 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do [ -x "$d/npx" ] && PATH="$d:$PATH" && break; done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v18-npm.log 2>&1) || fail "npm install failed"; }
(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v18
FIX="$WORK/reopen.py"
cat >"$FIX" <<'PY'
# %% cell
n = (n + 1) if ('n' in dir()) else 1
print("RUN", n, flush=True)
PY

start_daemon || fail "daemon start failed"
echo "v18: daemon up (pid $(daemon_pid)); close+reopen test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="reopen"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode close+reopen test failed (rc=$rc)"
echo "RESULT v18 PASS real VSCode host: cell re-executed after close+reopen (RUN 1 -> RUN 2); $passed_line"
