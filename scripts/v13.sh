#!/usr/bin/env bash
# v13 — REAL VSCode robustness: output maps even when the on-disk .py differs
#       from the open notebook (ADR-021 — the user's glue-bug/stale-file case).
#   - disk fixture prints DISKVERSION,
#   - the test edits the cell in memory to print EDITED (notebook dirty, disk
#     stale), runs it natively, and asserts the cell shows EDITED.
# Needs network + xvfb (see verify/v8.sh header); run via `make verify-d`.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v13 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$d/npx" ] && PATH="$d:$PATH" && break
  done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v13-npm.log 2>&1) || fail "npm install failed"; }

(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v13
FIX="$WORK/edited.py"
cat >"$FIX" <<'PY'
# %%
print("DISKVERSION")
PY

start_daemon || fail "daemon start failed"
echo "v13: daemon up (pid $(daemon_pid)); launching VSCode stale-file test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="editedcell"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode stale-file test failed (rc=$rc)"
echo "RESULT v13 PASS real VSCode host: in-memory cell edit mapped output despite stale disk file; $passed_line"
