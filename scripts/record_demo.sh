#!/usr/bin/env bash
# record_demo.sh — produce the README hero demo as a REAL recording of the real
# product: run the `demo` integration suite inside a real VSCode under a
# recordable Xvfb, capture the framebuffer with ffmpeg, and encode a trimmed,
# captioned mp4 + GIF.
#
# This is a DEMO ASSET BUILDER, not a pass/fail gate — but it drives the same
# real-VSCode harness the vNN.sh suites use and the suite keeps the gate's
# assertions, so what it records is the product actually working, never a mockup.
# If the suite fails, no demo is written.
#
# The interesting window is a few seconds inside a ~1 minute Electron session, so
# the suite's own `[demo]` log lines are timestamped against the recording clock
# and used to auto-trim and to place captions. Retiming the demo therefore means
# editing the suite's narrative, not hand-scrubbing a video.
#
# Usage: bash scripts/record_demo.sh
# Output: scripts/demo/{demo.gif,demo.mp4,demo-full.mp4,markers.txt}
#
# Knobs (env): DEMO_W DEMO_H DEMO_FPS DEMO_GIF_W DEMO_GIF_FPS DEMO_PRE DEMO_POST
set -u
. "$(dirname "$0")/lib.sh"

W="${DEMO_W:-1280}"; H="${DEMO_H:-800}"; FPS="${DEMO_FPS:-15}"
GIF_W="${DEMO_GIF_W:-900}"; GIF_FPS="${DEMO_GIF_FPS:-11}"
PRE="${DEMO_PRE:-3}"      # seconds of lead-in before the first caption marker
POST="${DEMO_POST:-7}"    # seconds to keep rolling after the last marker
# Cropping the 34px title bar drops the "[Extension Development Host] … [Superuser]"
# caption and the Sign In button — harness artifacts that would read as the product.
CHROME_TOP="${DEMO_CROP_TOP:-34}"

OUTDIR="$ROOT/scripts/demo"; mkdir -p "$OUTDIR"
FULL="$OUTDIR/demo-full.mp4"; MARKERS="$OUTDIR/markers.txt"; ASS="$OUTDIR/captions.ass"
die() { echo "record_demo: $*" >&2; exit 1; }
trap cleanup_procs EXIT

command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg not found (needs x11grab + libass)"
command -v Xvfb   >/dev/null 2>&1 || die "Xvfb not found (apt-get install xvfb)"
ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' subtitles ' || die "ffmpeg lacks the libass 'subtitles' filter"

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
  "workbench.colorTheme": "Dark 2026",
  "window.zoomLevel": 1,
  "window.commandCenter": false,
  "chat.commandCenter.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "editor.minimap.enabled": false,
  "editor.fontSize": 14,
  "notebook.output.fontSize": 14,
  "notebook.globalToolbar": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off"
}
JSON

DISP=":$((60 + RANDOM % 9))"
Xvfb "$DISP" -screen 0 "${W}x${H}x24" >/tmp/xvfb-record.log 2>&1 & XVFB_PID=$!
sleep 3

start_daemon || die "daemon start failed"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="demo" \
       TITHON_HOLD_MS="$(( (POST + 4) * 1000 ))" DISPLAY="$DISP" TITHON_SKIP_BUILD=1
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

# Timestamp each `[demo]` narrative line against the recording clock. Polling the
# log (rather than parsing afterwards) is what ties suite phases to video time.
: >"$MARKERS"
seen=0
while kill -0 $TEST_PID 2>/dev/null; do
  n=$(grep -c '^\[demo\]' "$TESTLOG" 2>/dev/null || true); n="${n:-0}"
  if [ "$n" -gt "$seen" ] 2>/dev/null; then
    off=$(awk -v a="$(date +%s.%N)" -v b="$T0" 'BEGIN{printf "%.2f", a-b}')
    grep '^\[demo\]' "$TESTLOG" | sed -n "$((seen+1)),${n}p" | while IFS= read -r line; do
      printf '%s\t%s\n' "$off" "$line" >>"$MARKERS"
      echo "  marker @${off}s  $line"
    done
    seen="$n"
  fi
  sleep 0.25
done
wait $TEST_PID 2>/dev/null; rc=$?

sleep 1
kill -INT $FF_PID 2>/dev/null; wait $FF_PID 2>/dev/null
kill $XVFB_PID 2>/dev/null

echo "=== suite rc=$rc ==="
grep -E '\[demo\]|passing|failing' "$TESTLOG" | grep -ivE 'dbus|GPU' | tail -20
[ "$rc" -eq 0 ] || die "demo suite failed (rc=$rc); log: $TESTLOG — demo NOT written"
[ -s "$FULL" ] || die "no video captured"

# ---------------------------------------------------------------- cut + caption
mk() { awk -F'\t' -v pat="$1" '$0 ~ pat { print $1; exit }' "$MARKERS"; }
M_LIVE=$(mk 'streaming live before disconnect')
M_DISC=$(mk 'disconnected')
M_RECON=$(mk 'reconnected; restored')
M_CONT=$(mk 'streaming continued')
[ -n "$M_LIVE" ] && [ -n "$M_CONT" ] || die "missing markers; see $MARKERS"

START=$(awk -v a="$M_LIVE" -v p="$PRE" 'BEGIN{ s=a-p; print (s>0?s:0) }')
DUR=$(awk -v a="$M_CONT" -v b="$START" -v p="$POST" 'BEGIN{ printf "%.2f", a-b+p }')
rel() { awk -v a="$1" -v b="$START" 'BEGIN{ printf "%.2f", a-b }'; }
R_DISC=$(rel "$M_DISC"); R_RECON=$(rel "$M_RECON")
echo "trim: start=${START}s dur=${DUR}s | captions @ 0 / $R_DISC / $R_RECON"

# Captions carry the story a muted, autoplaying README GIF has to tell on its own.
# ASS (libass) rather than drawtext: not every ffmpeg build ships drawtext, and a
# BorderStyle=3 box gives the caption a readable plate over the editor.
CROP_H=$(( H - CHROME_TOP ))
awk -v w="$W" -v h="$CROP_H" -v dur="$DUR" -v d="$R_DISC" -v r="$R_RECON" '
function t(s,  hh,mm,ss){ hh=int(s/3600); mm=int((s%3600)/60); ss=s-hh*3600-mm*60; return sprintf("%d:%02d:%05.2f",hh,mm,ss) }
function line(a,b,txt){ printf "Dialogue: 0,%s,%s,Cap,,0,0,0,,%s\n", t(a), t(b), txt }
BEGIN{
  print "[Script Info]"; print "ScriptType: v4.00+"; print "WrapStyle: 2"
  printf "PlayResX: %d\nPlayResY: %d\n\n", w, h
  print "[V4+ Styles]"
  print "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding"
  print "Style: Cap,DejaVu Sans,30,&H00FFFFFF,&H000000FF,&H00000000,&H14180D0A,-1,0,0,0,100,100,0,0,3,8,0,2,40,40,46,1"
  print ""
  print "[Events]"
  print "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
  line(0,   d,   "Training run streaming live from the remote box")
  line(d,   r,   "Connection drops — the client is gone")
  line(r,   dur, "Reopened — output restored, timer never reset, still streaming")
}' >"$ASS"

# crop → burn captions. Escaping: the subtitles filter re-parses its argument.
ASS_ESC=$(printf '%s' "$ASS" | sed 's/:/\\:/g')
ffmpeg -hide_banner -loglevel error -y -ss "$START" -t "$DUR" -i "$FULL" \
  -vf "crop=${W}:${CROP_H}:0:${CHROME_TOP},subtitles='${ASS_ESC}'" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
  "$OUTDIR/demo.mp4" || die "mp4 encode failed"

# Two-pass palette: a flat editor UI banks few colours, so a per-clip palette
# keeps text crisp at a README-friendly file size.
PAL="$OUTDIR/.palette.png"
ffmpeg -hide_banner -loglevel error -y -i "$OUTDIR/demo.mp4" \
  -vf "fps=${GIF_FPS},scale=${GIF_W}:-2:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" \
  "$PAL" || die "palettegen failed"
ffmpeg -hide_banner -loglevel error -y -i "$OUTDIR/demo.mp4" -i "$PAL" \
  -lavfi "fps=${GIF_FPS},scale=${GIF_W}:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 "$OUTDIR/demo.gif" || die "gif encode failed"
rm -f "$PAL"

echo
echo "DEMO OK"
ls -lh "$OUTDIR"/demo.gif "$OUTDIR"/demo.mp4 "$OUTDIR"/demo-full.mp4 | awk '{print "  "$5"\t"$9}'
