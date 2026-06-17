#!/usr/bin/env bash
# v36 — REAL VSCode: the Cell View "Open as Text Editor" toolbar button must
#       actually switch the .py from the tithon-py Cell View back to a plain TEXT
#       editor. User bug: clicking it did nothing. Drives the command via the
#       no-arg/active-editor path AND with a non-Uri toolbar argument; both must
#       end with a text editor for the URI and no notebook left open.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v36 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do [ -x "$d/npx" ] && PATH="$d:$PATH" && break; done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v36-npm.log 2>&1) || fail "npm install failed"; }
(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v36
FIX="$WORK/edit.py"
cat >"$FIX" <<'PY'
# %% cell
print("HELLO_OPENTEXT", flush=True)
PY

start_daemon || fail "daemon start failed"
echo "v36: daemon up (pid $(daemon_pid)); Open-as-Text toggle test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="opentext"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -50
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
[ -z "$passed_line" ] && { rm -f "$OUT"; fail "no mocha 'passing' line (suite did not run)"; }
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode Open-as-Text test failed (rc=$rc)"
echo "RESULT v36 PASS real VSCode host: Cell View 'Open as Text' switched to a text editor; $passed_line"
