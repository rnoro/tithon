#!/usr/bin/env bash
# v56 — REAL VSCode cross-cell update_display (RISKS #6, extension half).
#
# v55 pins the DAEMON's session-wide display_id routing (fold, journal, delta
# replay, restart). This pins what the extension does with a redirected event:
# the update arrives carrying the OWNER's exec_id, whose cell has already
# finished — so the sink must perform a BOUNDED output edit (momentary execution:
# start, replaceOutputItems, end) instead of ensureStarted(), which would clear
# the cell and strand a spinner no `done` ever ends (ADR-093's CRITICAL finding,
# the RISKS #15 class of bug).
#
#   - starts a real daemon (no pre-seed; the in-host test drives both cells),
#   - launches VSCode via @vscode/test-electron under xvfb,
#   - selecting the kernel auto-attaches; the test runs cell A, waits for it to
#     FINISH, runs cell B, and asserts A's output was edited in place, B grew no
#     copy, no cell is left executing, and cell A can still be RE-RUN (the only
#     probe that can observe a stranded bounded execution — see the suite header).
# Needs network + xvfb (see scripts/v8.sh header for the apt prerequisites);
# run via `make vscode` or `make livesync`.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v56 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v56
FIX="$WORK/crosscell.py"
cat >"$FIX" <<'PY'
# %% create
from IPython.display import display
display("v0", display_id="xid")
display("v0", display_id="xid")   # TWO outputs under one id — an update hits both
print("CELL_A_READY")

# %% update
from IPython.display import update_display
update_display("v1", display_id="xid")
print("CELL_B_DONE")
PY

start_daemon || fail "daemon start failed"
echo "v56: daemon up (pid $(daemon_pid)); launching VSCode cross-cell display test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="crosscell"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode cross-cell update_display test failed (rc=$rc)"
echo "RESULT v56 PASS real VSCode edited cell A's display in place from cell B after A finished; no stranded execution (cell A re-runs); $passed_line"
