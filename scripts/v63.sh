#!/usr/bin/env bash
# v63 — REAL VSCode: a session the user CLOSED is not re-seeded on open (ADR-114).
#
# v62 proves the daemon records and reports the intent. What it cannot prove is
# that the EXTENSION honours the answer: the seed skip in `startLive` is one
# expression, and deleting it leaves every other test in this repository green
# while the reported symptom — a deliberately terminated kernel handing its
# outputs back on every reopen — comes straight back.
#
# The suite drives it the way it happens: a driver runs the cell with no window
# open on the file, `kill_kernel` terminates the kernel, and only then is the
# file opened, so the cells genuinely start empty and anything in them came from
# the extension. `tithon._seedTrace` (written BEFORE the skip) is what tells
# "deliberately withheld" apart from "the attach silently failed".
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v63 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v63
FIX="$WORK/closed.py"
cat >"$FIX" <<'PY'
# %% work
print("CLOSEDRUN")
PY

start_daemon || fail "daemon start failed"
echo "v63: daemon up (pid $(daemon_pid)); deliberate-close seed gate under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="closedsession"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode closed-session test failed (rc=$rc)"
echo "RESULT v63 PASS real VSCode host: a terminated session's outputs are withheld on open (history still mapped) and come back on Restore Previous Outputs; $passed_line"
