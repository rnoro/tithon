#!/usr/bin/env bash
# DEMO (not a pass/fail gate): run the livereconnect suite under an explicit Xvfb
# and capture a frame every ~2.5s across a long-loop DISCONNECT->RECONNECT, to
# visually prove that cell state (spinner + real elapsed timer) and output are
# preserved and streaming continues. Frames -> scripts/screenshots/demo/ (gitignored).
#   bash scripts/demo_reconnect.sh
. "$(dirname "$0")/lib.sh"
trap cleanup_procs EXIT
EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do [ -x "$d/npx" ] && PATH="$d:$PATH" && break; done
fi
SHOTS="$ROOT/scripts/screenshots/demo"; rm -rf "$SHOTS"; mkdir -p "$SHOTS"
(cd "$EXT" && npx tsc -p tsconfig.integration.json >/dev/null 2>&1) || { echo "build failed"; exit 1; }

setup_env demo-reconnect
FIX="$WORK/train.py"
printf '# %%%% training loop\nimport time\nfor i in range(120):\n    print(f"step {i}", flush=True)\n    time.sleep(0.5)\n' >"$FIX"

DISP=":$((70 + RANDOM % 9))"
Xvfb "$DISP" -screen 0 1700x950x24 >/tmp/xvfb-demo.log 2>&1 & XVFB_PID=$!
sleep 2
start_daemon || { echo "daemon start failed"; exit 1; }

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="livereconnect" TITHON_HOLD_MS=28000 DISPLAY="$DISP"
( cd "$EXT" && node out-int/integration/runTest.js >"$TITHON_HOME/test.log" 2>&1 ) & TEST_PID=$!

i=0
for _ in $(seq 1 22); do
  import -display "$DISP" -window root "$(printf '%s/f%02d.png' "$SHOTS" "$i")" 2>/dev/null && echo "frame $i"
  i=$((i+1)); sleep 2.5
done
wait $TEST_PID 2>/dev/null; rc=$?
kill $XVFB_PID 2>/dev/null
echo "=== test rc=$rc ==="
grep -E "\[demo\]|passing|failing" "$TITHON_HOME/test.log" | grep -ivE "dbus|GPU" | tail
echo "frames -> $SHOTS"
[ "$rc" -eq 0 ] && echo "DEMO OK: disconnect->reconnect preserved state+output and kept streaming"
