#!/usr/bin/env bash
# v19 — REAL VSCode: two different files = two isolated kernels (feedback #1/#6).
#       Run A (sets va="AAA"), run B (cannot see va), run A again — each file
#       shows only its own output and B never sees A's variable.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v19 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v19
FIXA="$WORK/a.py"; FIXB="$WORK/b.py"
cat >"$FIXA" <<'PY'
# %% a
va = "AAA"
print(va, flush=True)
PY
cat >"$FIXB" <<'PY'
# %% b
print("BBB", "va" in dir(), flush=True)
PY

start_daemon || fail "daemon start failed"
echo "v19: daemon up (pid $(daemon_pid)); two-file isolation test under xvfb"

export TITHON_FIXTURE="$FIXA" TITHON_FIXTURE2="$FIXB" TITHON_WORKSPACE="$WORK" TITHON_SUITE="twofiles"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode two-file test failed (rc=$rc)"
echo "RESULT v19 PASS real VSCode host: two files = two isolated kernels (A=AAA, B can't see va); $passed_line"
