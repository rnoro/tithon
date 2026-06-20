#!/usr/bin/env bash
# v20 — REAL VSCode: two cells with IDENTICAL code each show their OWN output
#       (user feedback #2). Both cells print "SAME"; cell 1 must NOT be empty
#       (the bug collapsed its output onto cell 0 because cell_hash was equal).
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v20 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v20
FIX="$WORK/dup.py"
cat >"$FIX" <<'PY'
# %% one
print("SAME", flush=True)

# %% two
print("SAME", flush=True)
PY

start_daemon || fail "daemon start failed"
echo "v20: daemon up (pid $(daemon_pid)); duplicate-code-cells test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="dupcode"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode duplicate-code test failed (rc=$rc)"
echo "RESULT v20 PASS real VSCode host: identical-code cells each got their own output (cell 1 not collapsed); $passed_line"
