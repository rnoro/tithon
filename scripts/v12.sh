#!/usr/bin/env bash
# v12 — REAL VSCode multi-cell "Run All" (DECISIONS ADR-019 #2 regression guard).
#   - opens a tithon-py notebook with three `# %%` cells (blank lines between),
#   - selects the Tithon kernel, runs ALL cells natively (no manual live step),
#   - asserts EACH cell's output lands on its OWN cell (CELL0/1/2), not all
#     collapsed onto the top cell.
# Needs network + xvfb (see scripts/v8.sh header); run via `make verify-d`.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v12 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$d/npx" ] && PATH="$d:$PATH" && break
  done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v12-npm.log 2>&1) || fail "npm install failed"; }

(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v12
FIX="$WORK/multi.py"
cat >"$FIX" <<'PY'
# %% one
print("CELL0")

# %% two
print("CELL1")

# %% three
print("CELL2")
PY

start_daemon || fail "daemon start failed"
echo "v12: daemon up (pid $(daemon_pid)); launching VSCode multi-cell test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="multicell"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -E '^\[v12\]|[0-9]+ passing|failing|AssertionError|should contain' "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode multi-cell test failed (rc=$rc)"
echo "RESULT v12 PASS real VSCode host: each of 3 cells mapped to its own cell (no collapse); $passed_line"
