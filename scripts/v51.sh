#!/usr/bin/env bash
# v51 — REAL VSCode: closing a notebook mid-run, while output streams faster
#       than LiveOutputSync's 50ms flush window, must not let a
#       scheduled-but-unfired flush resurrect a proxy execution after
#       dispose() already ran sink.endAll() (RISKS #15).
#   - starts a real daemon,
#   - launches VSCode via @vscode/test-electron under xvfb,
#   - selecting the kernel auto-attaches; a driver client kicks off a tight
#     print loop (15ms/iteration) on the SAME session the extension's live
#     client is attached to, so there is reliably a pending flush at any
#     instant while it runs; the test closes the notebook mid-loop, waits
#     several flush windows, lets the daemon-side execution actually finish,
#     then reopens the same file and asserts the cell shows finished/success
#     (not a resurrected running spinner) with no open proxy execution.
# The scheduler-cancellation mechanics are unit-verified
# (extension/test/liveSync.test.ts — "dispose()" describe block); this
# verifies the real-VSCode teardown wiring. Needs network + xvfb (see
# scripts/v8.sh header for the apt prerequisites); run via `make vscode`.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v51 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v51
FIX="$WORK/disposeflush.py"
cat >"$FIX" <<'PY'
# %% loop
import time
for i in range(200):
    print(f"step {i}")
    time.sleep(0.015)
PY

start_daemon || fail "daemon start failed"
echo "v51: daemon up (pid $(daemon_pid)); launching VSCode dispose-flush-race test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="disposeflush"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode dispose-flush-race test failed (rc=$rc)"
echo "RESULT v51 PASS real VSCode: no resurrected execution after a post-dispose flush window; $passed_line"
