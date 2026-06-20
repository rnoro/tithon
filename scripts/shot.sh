#!/usr/bin/env bash
# shot.sh — RENDER verification: run a real-VSCode integration suite under a
# screenshot-able Xvfb, capture the notebook, and assert the screen is NOT blank
# (pixel std-dev above a floor). This closes the gap where a test asserts on the
# cell.outputs data model but not on what is actually painted (the user's ask:
# "verify output is actually drawn on screen"). The PNG is left for inspection.
#
# Usage: bash scripts/shot.sh <suite> [holdMs]
#   <suite> = integration suite filename substring (e.g. reconnect, screenshot,
#             runcell). A matching fixture is written below.
#   PNG -> scripts/screenshots/<suite>.png
set -u
. "$(dirname "$0")/lib.sh"
SUITE="${1:-reconnect}"
HOLD="${2:-16000}"
fail() { echo "RESULT shot:$SUITE FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
SHOTDIR="$ROOT/scripts/screenshots"; mkdir -p "$SHOTDIR"
OUT="$SHOTDIR/$SUITE.png"
for t in Xvfb import convert; do command -v "$t" >/dev/null 2>&1 || fail "$t not installed (apt-get install scrot imagemagick x11-apps)"; done

(cd "$EXT" && npx tsc -p ./ >/dev/null 2>&1) || fail "dist build failed"
(cd "$EXT" && npx tsc -p tsconfig.integration.json >/dev/null 2>&1) || fail "integration build failed"

# A free display number so parallel runs don't collide.
DISP=":$((90 + RANDOM % 9))"
Xvfb "$DISP" -screen 0 1700x950x24 >/tmp/xvfb-shot.log 2>&1 & XVFB_PID=$!
sleep 2

setup_env "shot-$SUITE"
FIX="$WORK/shot.py"
case "$SUITE" in
  reconnect)
    printf '# %%%% training loop\nimport time\nfor i in range(30):\n    print(i, flush=True)\n    time.sleep(0.5)\n' >"$FIX" ;;
  reconnectstates)
    printf '# %%%% A\nprint("DONE_CELL")\n\n# %%%% B\nimport time\nfor i in range(40):\n    print(i, flush=True)\n    time.sleep(0.5)\n\n# %%%% C\nprint("QUEUED_CELL")\n' >"$FIX" ;;
  dupcode)
    printf '# %%%% one\nprint("SAME", flush=True)\n\n# %%%% two\nprint("SAME", flush=True)\n' >"$FIX" ;;
  widget)
    cat >"$FIX" <<'PY'
# %% nb
from tqdm.notebook import tqdm as tnb
for i in tnb(range(50)):
    pass
PY
    ;;
  widgetlive)
    cat >"$FIX" <<'PY'
# %% nb
from tqdm.notebook import tqdm as tnb
import time
for i in tnb(range(600)):
    time.sleep(0.05)
PY
    ;;
  richoutputs)
    cat >"$FIX" <<'PY'
# %% mpl
%matplotlib inline
import matplotlib.pyplot as plt
plt.figure(figsize=(3.2, 1.8))
plt.plot([0, 1, 2], [0, 1, 4])
plt.title("matplotlib inline")
plt.tight_layout()
plt.show()

# %% tqdm
from tqdm import tqdm
import sys
for i in tqdm(range(20), file=sys.stderr):
    pass

# %% nb
from tqdm.notebook import tqdm as tnb
for i in tnb(range(5)):
    pass
PY
    ;;
  opentextshot)
    printf '# %%%% greeting\nprint("HELLO_OPENTEXT", flush=True)\n\n# %%%% math\nx = 6 * 7\nprint(f"answer = {x}")\n' >"$FIX" ;;
  autocellviewshot)
    printf '# %%%% greeting\nprint("HELLO_AUTOCELL", flush=True)\n\n# %%%% math\nx = 6 * 7\nprint(f"answer = {x}")\n' >"$FIX" ;;
  orphanrestore)
    printf '# %%%% orphan\nimport time\nprint("ORPHANME", flush=True)\nfor i in range(200):\n    time.sleep(0.1)\n    print(f"tick {i}", flush=True)\n' >"$FIX" ;;
  *)
    printf '# %%%%\nprint("hello from cell 1")\n\n# %%%%\nfor i in range(5):\n    print(f"Iteration {i}")\n\n# %%%%\nprint("Loop completed.")\n' >"$FIX" ;;
esac

start_daemon || fail "daemon start failed"
export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="$SUITE" TITHON_HOLD_MS="$HOLD" DISPLAY="$DISP"
( cd "$EXT" && node out-int/integration/runTest.js > /tmp/shot-test.log 2>&1 ) & TEST_PID=$!

# Electron launch + render timing varies, and the window only exists during the
# suite's HOLD window. Sample several frames and keep the most-rendered one
# (highest pixel variance) — robust against launch jitter.
sd_of() { convert "$1" -colorspace Gray -format '%[fx:standard_deviation]' info: 2>/dev/null; }
best_sd=0; tmp="$OUT.frame.png"
start=$(date +%s); deadline=$(( start + (HOLD/1000) + 8 ))
sleep 8
# Keep the LAST frame whose variance clears the floor — the most settled render
# (outputs painted), rather than an early transitional frame.
while [ "$(date +%s)" -lt "$deadline" ]; do
  if import -display "$DISP" -window root "$tmp" 2>/dev/null; then
    sd="$(sd_of "$tmp")"
    if awk -v a="$sd" 'BEGIN{ exit !(a+0 > 0.04) }'; then best_sd="$sd"; cp "$tmp" "$OUT"; fi
  fi
  sleep 3
done
rm -f "$tmp"
wait $TEST_PID 2>/dev/null; rc=$?
kill $XVFB_PID 2>/dev/null

[ "$rc" -eq 0 ] || fail "integration suite '$SUITE' failed (rc=$rc); see /tmp/shot-test.log"
[ -s "$OUT" ] || fail "no screenshot produced"
# Blank-screen guard: a rendered editor has high pixel variance; a blank/black
# frame is near-uniform. Require std-dev (0..1 normalised) above a floor.
awk -v sd="$best_sd" 'BEGIN{ exit !(sd+0 > 0.02) }' || fail "screenshot looks blank (best std-dev=$best_sd)"
echo "RESULT shot:$SUITE PASS rendered + non-blank (std-dev=$best_sd); png=$OUT"
