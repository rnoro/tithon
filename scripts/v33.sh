#!/usr/bin/env bash
# v33 — REAL VSCode in-place update_display_data: a cell that creates a display
#       with a display_id and then calls update_display() in a loop must update
#       that ONE output IN PLACE, not stack a new output per frame.
#   - starts a real daemon (no pre-seed; the test drives the loop),
#   - launches VSCode via @vscode/test-electron under xvfb,
#   - selecting the kernel auto-attaches; the in-host test submits the display/update loop
#     and asserts the cell's output count stays 1 (would grow to N before the
#     fix) and ends showing the LATEST frame (in-place replace, not append).
# Coalescing bounds are unit-verified (test/liveSync.test.ts Fix E); this verifies
# the real in-place render. Needs network + xvfb (see scripts/v8.sh header for the
# apt prerequisites); run via `make vscode`.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v33 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v33
FIX="$WORK/livedisplay.py"
cat >"$FIX" <<'PY'
# %% disp
from IPython.display import display, update_display
import time
display("frame0", display_id="td")
for i in range(1, 12):
    time.sleep(0.05)
    update_display(f"frame{i}", display_id="td")
PY

start_daemon || fail "daemon start failed"
echo "v33: daemon up (pid $(daemon_pid)); launching VSCode in-place update_display test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="livedisplay"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode in-place update_display test failed (rc=$rc)"
echo "RESULT v33 PASS real VSCode updated one display output in place across 12 frames (no stacking); $passed_line"
