#!/usr/bin/env bash
# shotlsp.sh — RENDER verification of ty's inlay-hint painting after a Cell View
#   -> Text -> Cell View round trip. The API-level v43 shows ty RETURNS correct
#   hints; this captures what is actually PAINTED so the visual desync the user
#   reported (`val_lodevice=ss`, missing `: int`) can be seen and a fix verified.
#
#   Reuses the `lspinlay` suite with TITHON_HOLD_MS set: it opens the Cell View,
#   runs, round-trips, runs again, then HOLDS the reopened notebook on screen.
#   ty is ENABLED via TITHON_LSP_EXT_DIR. PNG -> scripts/screenshots/lspinlay.png
#
# Usage: bash scripts/shotlsp.sh [holdMs]
set -u
. "$(dirname "$0")/lib.sh"
HOLD="${1:-18000}"
fail() { echo "RESULT shot:lspinlay FAIL $1"; exit 1; }
trap cleanup_procs EXIT
EXT="$ROOT/extension"
SHOTDIR="$ROOT/scripts/screenshots"; mkdir -p "$SHOTDIR"
OUT="$SHOTDIR/lspinlay.png"
for t in Xvfb import convert; do command -v "$t" >/dev/null 2>&1 || fail "$t not installed"; done
ensure_extension_build || fail "extension build failed"

EXTROOT="$HOME/.vscode-server/extensions"
TY_DIR="$(ls -d "$EXTROOT"/astral-sh.ty-* 2>/dev/null | head -1)"
PY_DIR="$(ls -d "$EXTROOT"/ms-python.python-* 2>/dev/null | head -1)"
DBG_DIR="$(ls -d "$EXTROOT"/ms-python.debugpy-* 2>/dev/null | head -1)"
[ -n "$TY_DIR" ] || fail "ty extension not found under $EXTROOT"

DISP=":$((90 + RANDOM % 9))"
Xvfb "$DISP" -screen 0 1700x1100x24 >/tmp/xvfb-shotlsp.log 2>&1 & XVFB_PID=$!
sleep 2

setup_env shotlsp
LSP_EXT_DIR="$TITHON_HOME/lsp-extensions"; mkdir -p "$LSP_EXT_DIR"
for d in "$TY_DIR" "$PY_DIR" "$DBG_DIR"; do
  [ -n "$d" ] && ln -s "$d" "$LSP_EXT_DIR/$(basename "$d")"
done

# Scale fixture: many interleaved markdown+code cells with heavy live output, to
# mirror the user's 44-cell notebook. The "observed" rich cell (val_loss / scale
# / .to(device)) sits in the middle so the screenshot lands on a cell with many
# inlay hints, after a high-volume notebookDocument/didChange stream from output.
FIX="$WORK/baseline.py"
{
  printf '# %%%% [markdown]\n# # Setup\n\n'
  printf '# %%%% setup\n'
  printf 'def scale(value: int, factor: int) -> int:\n    return value * factor\n\n'
  printf 'class Tensor:\n    def to(self, device: str) -> "Tensor":\n        return self\n\n'
  printf 'base = 10\ndevice = "cpu"\nt = Tensor()\n\n'
  for n in $(seq 1 6); do
    printf '# %%%% [markdown]\n# ## Block %s\n\n' "$n"
    printf '# %%%% blk%s\n' "$n"
    printf 'count_%s = 0\n' "$n"
    printf 'for i in range(40):\n    count_%s = count_%s + scale(i, base)\n    print("blk%s", i, count_%s, flush=True)\n\n' "$n" "$n" "$n" "$n"
  done
  printf '# %%%% [markdown]\n# ## Training Loop\n\n'
  printf '# %%%% loop\n'
  printf 'train_length, valid_length = 100, 20\ntotal = 0\n'
  printf 'for i in range(40):\n    x = scale(i, base)\n    t.to(device)\n    total = total + x\n    print("step", i, total, flush=True)\n'
  printf 'val_loss = 0\nval_loss += scale(total, base)\nacc = scale(base, base)\n'
  printf 'print(train_length, valid_length, total, val_loss, acc)\n\n'
  for n in $(seq 7 12); do
    printf '# %%%% [markdown]\n# ## Block %s\n\n' "$n"
    printf '# %%%% blk%s\n' "$n"
    printf 'count_%s = 0\n' "$n"
    printf 'for i in range(40):\n    count_%s = count_%s + scale(i, base)\n    print("blk%s", i, count_%s, flush=True)\n\n' "$n" "$n" "$n" "$n"
  done
} >"$FIX"
echo "shotlsp: fixture cells = $(grep -c '^# %%' "$FIX")"

mkdir -p "$WORK/.vscode"
cat >"$WORK/.vscode/settings.json" <<JSON
{
  "python.defaultInterpreterPath": "$PY",
  "ty.importStrategy": "useBundled",
  "ty.interpreter": "$PY",
  "ty.diagnosticMode": "openFilesOnly",
  "editor.inlayHints.enabled": "on",
  "notebook.inlayHints.enabled": true,
  "editor.fontSize": 15
}
JSON

start_daemon || fail "daemon start failed"
echo "shotlsp: daemon up (pid $(daemon_pid)); ty=$(basename "$TY_DIR"); disp=$DISP hold=${HOLD}ms"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="lspinlay"
export TITHON_LSP_EXT_DIR="$LSP_EXT_DIR" TITHON_HOLD_MS="$HOLD" DISPLAY="$DISP"
( cd "$EXT" && env -u ELECTRON_RUN_AS_NODE node out-int/integration/runTest.js > /tmp/shotlsp-test.log 2>&1 ) & TEST_PID=$!

sd_of() { convert "$1" -colorspace Gray -format '%[fx:standard_deviation]' info: 2>/dev/null; }
best_sd=0; tmp="$OUT.frame.png"
deadline=$(( $(date +%s) + (HOLD/1000) + 12 ))
sleep 10
while [ "$(date +%s)" -lt "$deadline" ]; do
  if import -display "$DISP" -window root "$tmp" 2>/dev/null; then
    sd="$(sd_of "$tmp")"
    awk -v a="$sd" 'BEGIN{ exit !(a+0 > 0.04) }' && { best_sd="$sd"; cp "$tmp" "$OUT"; }
  fi
  sleep 3
done
rm -f "$tmp"
wait $TEST_PID 2>/dev/null; rc=$?
kill $XVFB_PID 2>/dev/null
tail -25 /tmp/shotlsp-test.log | grep -vE "shared storage|update#|AccountPolicyGate" || true
[ "$rc" -eq 0 ] || fail "suite failed (rc=$rc); see /tmp/shotlsp-test.log"
[ -s "$OUT" ] || fail "no screenshot produced"
echo "RESULT shot:lspinlay PASS captured (std-dev=$best_sd); png=$OUT"
