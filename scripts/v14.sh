#!/usr/bin/env bash
# v14 — REAL VSCode: a cell ADDED after live sync started still streams live
#       output with no manual restore (ADR-022 — the user's "added cell" report).
#   - opens a 1-cell notebook, runs cell 0 (starts live sync),
#   - inserts a NEW cell and runs it, asserting it shows output live with no
#     manual restore (the live index must refresh to include it).
# Needs network + xvfb (see scripts/v8.sh header); run via `make vscode`.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v14 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v14
FIX="$WORK/addcell.py"
cat >"$FIX" <<'PYEOF'
# %%
print("CELL0")
PYEOF

start_daemon || fail "daemon start failed"
echo "v14: daemon up (pid $(daemon_pid)); launching VSCode add-cell test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="addcell"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode stale-file test failed (rc=$rc)"
echo "RESULT v14 PASS real VSCode host: a cell added after live sync still streamed output live (no restore); $passed_line"
