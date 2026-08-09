#!/usr/bin/env bash
# record_demo.sh — produce the README hero demo as a REAL recording of the real
# product: run the `demo` integration suite inside a real VSCode under a
# recordable Xvfb, capture the framebuffer with ffmpeg, and encode a trimmed
# preview plus the raw capture from which the published cut is composed.
#
# This is a DEMO ASSET BUILDER, not a pass/fail gate — but it drives the same
# real-VSCode harness the vNN.sh suites use and the suite keeps the gate's
# assertions, so what it records is the product actually working, never a mockup.
# If the suite fails, no demo is written.
#
# The interesting window is a few seconds inside a ~1 minute Electron session, so
# the suite's own `[demo]` log lines are timestamped against the recording clock
# and used to auto-trim and place editorial beats. Retiming the demo therefore means
# editing the suite's narrative, not hand-scrubbing a video.
#
# Usage: bash scripts/record_demo.sh
# Output: scripts/demo/{demo-full.mp4,markers.txt,demo.mp4 (uncaptioned preview)}
#
# `demo-full.mp4` (raw, uncropped, uncaptioned) plus `markers.txt` are also input
# to the external /workspace/tithon-demo Remotion toolchain. Keeping that
# marketing-only Node/Chromium workspace outside this repository prevents its
# dependencies and render caches from becoming product files. The gif/mp4 this
# script writes itself stay a self-contained unannotated fallback.
#
# For the published assets, capture bigger: DEMO_W=1920 DEMO_H=1200 DEMO_ZOOM=2.
#
# Knobs (env): DEMO_W DEMO_H DEMO_ZOOM DEMO_FPS DEMO_PRE DEMO_POST
#
# DEMO_ZOOM must rise with DEMO_W. VSCode's zoomLevel sets the UI's PHYSICAL size,
# so a wider capture at a fixed zoom yields text that is smaller RELATIVE to the
# frame — a 1920-wide grab at zoom 1 reads worse after scaling than a 1280-wide
# one, not better. Each step is a factor of 1.2.
set -u
. "$(dirname "$0")/lib.sh"

W="${DEMO_W:-1280}"; H="${DEMO_H:-800}"; FPS="${DEMO_FPS:-15}"; ZOOM="${DEMO_ZOOM:-1}"
PRE="${DEMO_PRE:-3}"      # seconds of lead-in before the first caption marker
POST="${DEMO_POST:-7}"    # seconds to keep rolling after the last marker
# Cropping the 34px title bar drops the "[Extension Development Host] … [Superuser]"
# caption and the Sign In button — harness artifacts that would read as the product.
CHROME_TOP="${DEMO_CROP_TOP:-34}"

OUTDIR="$ROOT/scripts/demo"; mkdir -p "$OUTDIR"
FULL="$OUTDIR/demo-full.mp4"; MARKERS="$OUTDIR/markers.txt"
die() { echo "record_demo: $*" >&2; exit 1; }
trap cleanup_procs EXIT

command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg not found (needs x11grab)"
command -v Xvfb   >/dev/null 2>&1 || die "Xvfb not found (apt-get install xvfb)"

ensure_extension_build || die "extension build failed"

# ---------------------------------------------------------------- stage the run
setup_env demo-record
FIX="$WORK/train.py"
# A tqdm widget plus a training-log line: the bar exercises the widget-state
# mirror (it must come back at its real value, not reset), and the log gives the
# suite a cheap assertable signal. The suite keys off the TITHON_DEMO_LOOP tag.
cat >"$FIX" <<'PY'
# %% train
# TITHON_DEMO_LOOP — long run on the remote box
import time, math
from tqdm.notebook import tqdm

for step in tqdm(range(240), desc="epoch 1/3"):
    loss = 2.4 * math.exp(-step / 60) + 0.08
    print(f"step {step:3d}   loss {loss:.4f}", flush=True)
    time.sleep(0.4)
PY

# The harness boots a throwaway profile (runTest.ts points --user-data-dir here),
# so seeding its settings is the only way to control how the demo LOOKS. Defaults
# would record the classic chrome at 100% zoom: correct, but small and dated next
# to what a reader has on screen.
mkdir -p "$TITHON_HOME/vscode-user/User"
cat >"$TITHON_HOME/vscode-user/User/settings.json" <<'JSON'
{
  "workbench.experimental.modernUI": true,
  "workbench.colorTheme": "GitHub Dark Default",
  "workbench.activityBar.location": "hidden",
  "window.zoomLevel": __ZOOM__,
  "window.commandCenter": false,
  "chat.commandCenter.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "editor.minimap.enabled": false,
  "breadcrumbs.enabled": false,
  "editor.fontSize": 14,
  "notebook.output.fontSize": 14,
  "notebook.globalToolbar": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off"
}
JSON
sed -i "s/__ZOOM__/${ZOOM}/" "$TITHON_HOME/vscode-user/User/settings.json"

# The integration host normally disables third-party extensions. The demo uses a
# curated directory containing only GitHub's theme so the recording stays
# readable without loading a user's unrelated extensions. Override the source on
# hosts whose VSCode extension cache lives elsewhere.
GITHUB_THEME_SRC="${DEMO_GITHUB_THEME_DIR:-}"
if [[ -z "$GITHUB_THEME_SRC" ]]; then
  GITHUB_THEME_SRC="$(find /root/.vscode-server/extensions -maxdepth 1 -type d \
    -name 'github.github-vscode-theme-*' -print 2>/dev/null | sort -V | tail -1)"
fi
[[ -f "$GITHUB_THEME_SRC/package.json" ]] || \
  die "GitHub Theme extension not found; set DEMO_GITHUB_THEME_DIR"
DEMO_EXTENSIONS="$TITHON_HOME/vscode-extensions"
mkdir -p "$DEMO_EXTENSIONS"
ln -s "$GITHUB_THEME_SRC" "$DEMO_EXTENSIONS/$(basename "$GITHUB_THEME_SRC")"

DISP=":$((60 + RANDOM % 9))"
Xvfb "$DISP" -screen 0 "${W}x${H}x24" >/tmp/xvfb-record.log 2>&1 & XVFB_PID=$!
sleep 3

start_daemon || die "daemon start failed"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="demo" \
       TITHON_HOLD_MS="$(( (POST + 4) * 1000 ))" DISPLAY="$DISP" TITHON_SKIP_BUILD=1 \
       TITHON_PYTHON="$PY" TITHON_LSP_EXT_DIR="$DEMO_EXTENSIONS"
TESTLOG="$TITHON_HOME/test.log"

# --------------------------------------------------------------------- record
# Lossless capture; all trimming/scaling happens in the encode pass so the source
# can be re-cut without re-running the suite.
ffmpeg -hide_banner -loglevel error -y \
  -f x11grab -draw_mouse 0 -video_size "${W}x${H}" -framerate "$FPS" -i "$DISP" \
  -c:v libx264 -preset ultrafast -qp 0 -pix_fmt yuv444p "$FULL" & FF_PID=$!
T0=$(date +%s.%N)
sleep 1

( cd "$ROOT/extension" && node out-int/integration/runTest.js >"$TESTLOG" 2>&1 ) & TEST_PID=$!

# Xvfb runs no window manager, so Electron keeps its own ~1440x895 default and a
# capture wider than that records a small window on a black field. Nothing can
# "maximize" it without a WM, so drive the geometry through X11 directly. Applied
# twice because Electron re-lays-out once after the first resize.
( for _ in $(seq 1 80); do
    wid=$(DISPLAY="$DISP" xdotool search --name "Visual Studio Code" 2>/dev/null | tail -1)
    [ -n "$wid" ] || { sleep 0.5; continue; }
    DISPLAY="$DISP" xdotool windowmove "$wid" 0 0 windowsize "$wid" "$W" "$H" 2>/dev/null
    sleep 2
    DISPLAY="$DISP" xdotool windowmove "$wid" 0 0 windowsize "$wid" "$W" "$H" 2>/dev/null
    break
  done ) >/dev/null 2>&1 &

# Timestamp each `[demo]` narrative line against the recording clock. Polling the
# log (rather than parsing afterwards) is what ties suite phases to video time.
: >"$MARKERS"
seen=0
drain_markers() {
  local n off
  n=$(grep -c '^\[demo\]' "$TESTLOG" 2>/dev/null || true); n="${n:-0}"
  if [ "$n" -gt "$seen" ] 2>/dev/null; then
    off=$(awk -v a="$(date +%s.%N)" -v b="$T0" 'BEGIN{printf "%.2f", a-b}')
    grep '^\[demo\]' "$TESTLOG" | sed -n "$((seen+1)),${n}p" | while IFS= read -r line; do
      printf '%s\t%s\n' "$off" "$line" >>"$MARKERS"
      echo "  marker @${off}s  $line"
    done
    seen="$n"
  fi
}
while kill -0 $TEST_PID 2>/dev/null; do
  drain_markers
  sleep 0.25
done
wait $TEST_PID 2>/dev/null; rc=$?
drain_markers

sleep 1
kill -INT $FF_PID 2>/dev/null; wait $FF_PID 2>/dev/null
kill $XVFB_PID 2>/dev/null

echo "=== suite rc=$rc ==="
grep -E '\[demo\]|passing|failing' "$TESTLOG" | grep -ivE 'dbus|GPU' | tail -20
[ "$rc" -eq 0 ] || die "demo suite failed (rc=$rc); log: $TESTLOG — demo NOT written"
[ -s "$FULL" ] || die "no video captured"

# ------------------------------------------------------------------------- cut
mk() { awk -F'\t' -v pat="$1" '$0 ~ pat { print $1; exit }' "$MARKERS"; }
M_LIVE=$(mk 'streaming live')
M_KILL=$(mk 'daemon SIGKILLed')
M_BACK=$(mk 'reconnected to a new daemon')
M_CONT=$(mk 'streaming continued past')
[ -n "$M_LIVE" ] && [ -n "$M_KILL" ] && [ -n "$M_BACK" ] && [ -n "$M_CONT" ] || \
  die "missing live/kill/reconnect/continued markers; see $MARKERS"

START=$(awk -v a="$M_LIVE" -v p="$PRE" 'BEGIN{ s=a-p; print (s>0?s:0) }')
DUR=$(awk -v a="$M_CONT" -v b="$START" -v p="$POST" 'BEGIN{ printf "%.2f", a-b+p }')
rel() { awk -v a="$1" -v b="$START" 'BEGIN{ printf "%.2f", a-b }'; }
echo "trim: start=${START}s dur=${DUR}s | kill @$(rel "$M_KILL")s | back @$(rel "$M_BACK")s"

# An UNCAPTIONED preview, cropped only of the harness menu bar. Titling and
# annotation belong to the Remotion project that composes the published cut from
# `demo-full.mp4` + these markers — burning a second, different set of captions
# in here would just be a competing design to keep in sync.
CROP_H=$(( H - CHROME_TOP ))
ffmpeg -hide_banner -loglevel error -y -ss "$START" -t "$DUR" -i "$FULL" \
  -vf "crop=${W}:${CROP_H}:0:${CHROME_TOP}" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
  "$OUTDIR/demo.mp4" || die "preview encode failed"

echo
echo "DEMO OK"
ls -lh "$OUTDIR"/demo.mp4 "$OUTDIR"/demo-full.mp4 | awk '{print "  "$5"\t"$9}'
echo "compose the published cut:  bash /workspace/tithon-demo/render-readme-demo.sh $ROOT"
