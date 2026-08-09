#!/usr/bin/env bash
# v53 — REAL VSCode: a widget-update flush pending in the shared coalescing
#       buffer at the instant of disposeLive() must not reach the renderer
#       afterward (RISKS #7 finding 2 — Codex trigger-④ review of the
#       exec_id-centric-adapter proposal found this as a narrower, actually
#       reachable defect independent of that larger rewrite).
#   - starts a real daemon,
#   - launches VSCode via @vscode/test-electron under xvfb,
#   - runs a live tqdm.notebook cell (comm deltas stream in continuously),
#   - polls tithon._hasPendingWidgetFlush for a genuinely pending flush window
#     and disposes the instant one is observed (same strategy as v51),
#   - asserts the renderer's applied-update count does not climb afterward.
# The buffer/timer mechanics (owner-tagging + purge-on-dispose) are pure and
# small; this verifies the real teardown wiring end-to-end. Needs network +
# xvfb (see scripts/v8.sh header); run via `make vscode`.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v53 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v53
FIX="$WORK/widgetdisposeflush.py"
cat >"$FIX" <<'PY'
# %% nb
from tqdm.notebook import tqdm as tnb
import time
for i in tnb(range(60)):
    time.sleep(0.05)
PY

start_daemon || fail "daemon start failed"
echo "v53: daemon up (pid $(daemon_pid)); real VSCode will dispose mid-flush and check for a stray widget paint"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="widgetdisposeflush"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode widget-dispose-flush-race test failed (rc=$rc)"
echo "RESULT v53 PASS real VSCode: no stray widget paint after disposeLive() with a pending flush; $passed_line"
