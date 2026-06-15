#!/usr/bin/env bash
# v30 — REAL VSCode LIVE ipywidget animation (SPEC.md live path): a
#       tqdm.notebook bar renders AND animates while the cell runs, with NO
#       reconnect. Proves the live half: client builds the widget mirror from
#       comm events (widget output emitted with state mid-run) + renderer paints
#       html + live comm deltas update the model (the renderer confirms each).
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v30 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do [ -x "$d/npx" ] && PATH="$d:$PATH" && break; done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not found (install xvfb)"
"$PY" -c "import ipywidgets, tqdm" 2>/dev/null || fail "ipywidgets/tqdm missing from daemon venv"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v30-npm.log 2>&1) || fail "npm install failed"; }
(cd "$EXT" && npx tsc -p ./) || fail "extension build (dist) failed"
(cd "$EXT" && node esbuild.mjs >/tmp/v30-esbuild.log 2>&1) || { tail -20 /tmp/v30-esbuild.log; fail "renderer bundle failed"; }
[ -s "$EXT/dist/widgetRenderer.js" ] || fail "dist/widgetRenderer.js not produced"
(cd "$EXT" && npx tsc -p tsconfig.integration.json) || fail "integration build (out-int) failed"

setup_env v30
FIX="$WORK/widgetlive.py"
cat >"$FIX" <<'PY'
# %% nb
from tqdm.notebook import tqdm as tnb
import time
for i in tnb(range(30)):
    time.sleep(0.05)
PY

start_daemon || fail "daemon start failed"
echo "v30: daemon up (pid $(daemon_pid)); real VSCode will render+animate a live ipywidget (xvfb)"
export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="widgetlive"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
render_line="$(grep -E '\[tithon\] widget rendered: html' "$OUT" | tail -1)"
update_line="$(grep -E '\[tithon\] widget updated' "$OUT" | tail -1)"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode live widget test failed (rc=$rc)"
[ -n "$render_line" ] || fail "renderer never reported an html paint"
[ -n "$update_line" ] || fail "renderer never applied a live update (no animation)"
echo "RESULT v30 PASS real VSCode: tqdm.notebook renders live (html) + animates via comm deltas; $passed_line"
