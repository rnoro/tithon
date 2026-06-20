#!/usr/bin/env bash
# v24 — REAL VSCode: the cell STOP button interrupts a running cell, and the
#       kernel survives so the cell can be re-run (user report: interrupt button
#       does nothing). Run a long loop -> stop -> assert it ended (success=false)
#       and stopped -> re-run -> "RUN 2" proves the kernel is still alive.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v24 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v24
FIX="$WORK/interrupt.py"
cat >"$FIX" <<'PY'
# %% cell
import time
n = (n + 1) if ('n' in dir()) else 1
print(f"RUN {n}", flush=True)
for i in range(200):
    print(f"tick {i}", flush=True)
    time.sleep(0.2)
print("END", flush=True)
PY

start_daemon || fail "daemon start failed"
echo "v24: daemon up (pid $(daemon_pid)); interrupt + re-run test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="interrupt"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode interrupt test failed (rc=$rc)"
echo "RESULT v24 PASS real VSCode host: stop button interrupted the cell + kernel survived for re-run (RUN 2); $passed_line"
