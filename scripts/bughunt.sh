#!/usr/bin/env bash
# bughunt.sh <suite-stem> <fixture-file> [helper-file]
# Spin a FRESH daemon + real VSCode (xvfb) and run ONE integration suite as a
# probe. Prints the suite's console output (the [Hn] FINDING lines) + PASS/FAIL.
# Not part of the verify gate — an interactive bug-hunting harness.
. "$(dirname "$0")/lib.sh"
trap cleanup_procs EXIT

SUITE="$1"; FIXTURE="$2"; HELPER="${3:-}"
EXT="$ROOT/extension"
export TITHON_SKIP_BUILD=1   # caller builds once; don't rebuild each probe
ensure_extension_build || { echo "BUILD FAIL"; exit 1; }

setup_env "bh-$SUITE"
cp "$FIXTURE" "$WORK/$(basename "$FIXTURE")"
FIX="$WORK/$(basename "$FIXTURE")"
HELP=""
if [ -n "$HELPER" ]; then cp "$HELPER" "$WORK/$(basename "$HELPER")"; HELP="$WORK/$(basename "$HELPER")"; fi

start_daemon || { echo "DAEMON FAIL"; exit 1; }
echo ">>> [$SUITE] daemon up (pid $(daemon_pid)); driving real VSCode under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_HELPER="$HELP" TITHON_WORKSPACE="$WORK" TITHON_SUITE="$SUITE"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
# Show the test's own console (findings) + mocha result, drop xvfb/gpu noise.
grep -E "BUGHUNT|\[H[0-9]|FINDING|passing|failing|Error:|AssertionError|✓|✗|[0-9]+\) " "$OUT" | grep -vE "Gtk|dbus|GPU|libva|MESA|gbm_|vulkan|DevTools|ContextResult|Fontconfig" | sed 's/^[[:space:]]*//'
echo ">>> [$SUITE] rc=$rc"
cp "$OUT" /tmp/bughunt_last.log
rm -f "$OUT"
exit $rc
