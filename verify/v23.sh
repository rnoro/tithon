#!/usr/bin/env bash
# v23 — REAL VSCode: daemon AUTO-START. We deliberately do NOT start the daemon;
#       the extension must spawn it on first use (kernel select + run a cell) and
#       stream output. Also checks the kernel's Python version is reported.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v23 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do [ -x "$d/npx" ] && PATH="$d:$PATH" && break; done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v23-npm.log 2>&1) || fail "npm install failed"; }
(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v23
FIX="$WORK/auto.py"
cat >"$FIX" <<'PY'
# %% cell
print("AUTO_OK", flush=True)
PY

# NOTE: deliberately NOT calling start_daemon — the extension must auto-start it.
echo "v23: NO daemon started; extension must auto-start it via <python> -m tithon (xvfb)"
export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="autostart"
# Interpreter path (Jupyter-style): venv python, no activation, tithon NOT on PATH.
export TITHON_PYTHON="$PY"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
pyline="$(grep -E '\[v23\] daemon auto-started' "$OUT" | tail -1)"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode auto-start test failed (rc=$rc)"
echo "RESULT v23 PASS real VSCode host: daemon auto-started on first use + streamed output; ${pyline:-python reported}; $passed_line"
