#!/usr/bin/env bash
# v25 — REAL VSCode: .py opens as TEXT by default (no forced notebook); the
#       "Open as Cell View" opt-in opens a runnable Tithon notebook (also proves
#       vscode.openWith works with an EMPTY notebook selector). User feedback:
#       don't always render .py as a notebook.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v25 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do [ -x "$d/npx" ] && PATH="$d:$PATH" && break; done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v25-npm.log 2>&1) || fail "npm install failed"; }
(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v25
FIX="$WORK/edit.py"
cat >"$FIX" <<'PY'
# %% cell
print("HELLO_CELLVIEW", flush=True)
PY

start_daemon || fail "daemon start failed"
echo "v25: daemon up (pid $(daemon_pid)); text-default + opt-in Cell View test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="editordefault"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode text-default test failed (rc=$rc)"
echo "RESULT v25 PASS real VSCode host: .py opened as text by default; Open as Cell View opened a runnable notebook; $passed_line"
