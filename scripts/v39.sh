#!/usr/bin/env bash
# v39 — REAL VSCode: the manual Cell View <-> Text toggle for a `.py`. A `.py`
#       opens as plain text by default; the Cell View is opt-in (ADR-032; the
#       content-based auto-open heuristic was removed as a fragile session-state
#       machine). Asserts: (1) the opt-in `tithon.openAsCellView` opens a RUNNABLE
#       notebook even for a markerless .py (empty selector), (2) "Open as Text"
#       resolves with no argument via the active editor (the toolbar path).
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v39 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v39
# A percent-format file (test 2: opt-in Cell View, then Open-as-Text) and a plain
# markerless script (test 1: opt-in Cell View opens a runnable notebook).
FIX="$WORK/notebook.py"
cat >"$FIX" <<'PY'
# %% greeting
print("HELLO_AUTOCELL", flush=True)

# %% math
x = 6 * 7
print(f"answer = {x}")
PY
PLAIN="$WORK/plain.py"
cat >"$PLAIN" <<'PY'
import os
print("just a script", os.getpid())
PY

start_daemon || fail "daemon start failed"
echo "v39: daemon up (pid $(daemon_pid)); manual Cell View<->Text toggle test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_HELPER="$PLAIN" TITHON_WORKSPACE="$WORK" TITHON_SUITE="celltoggle"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -50
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
[ -z "$passed_line" ] && { rm -f "$OUT"; fail "no mocha 'passing' line (suite did not run)"; }
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode Cell View<->Text toggle test failed (rc=$rc)"
echo "RESULT v39 PASS real VSCode host: opt-in Cell View opens+runs (empty selector); no-arg Open-as-Text toggles back; $passed_line"
