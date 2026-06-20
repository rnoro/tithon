#!/usr/bin/env bash
# v29 — REAL VSCode ipywidget rendering (SPEC.md, the project's top risk):
#       a tqdm.notebook FloatProgress renders via @jupyter-widgets/html-manager
#       INSIDE the notebook webview (not the text fallback). Proves the renderer
#       contribution + 3MB browser bundle + mime routing + html-manager work in a
#       real Extension Host. The renderer reports html vs fallback; we assert html.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v29 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v29
FIX="$WORK/widget.py"
cat >"$FIX" <<'PY'
# %% nb
from tqdm.notebook import tqdm as tnb
for i in tnb(range(5)):
    pass
PY

start_daemon || fail "daemon start failed"
echo "v29: daemon up (pid $(daemon_pid)); real VSCode will render an ipywidget (xvfb)"
export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="widget"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
render_line="$(grep -E '\[tithon\] widget rendered: html' "$OUT" | tail -1)"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode widget render test failed (rc=$rc)"
[ -n "$render_line" ] || fail "renderer never reported an html paint (fallback or no render)"
echo "RESULT v29 PASS real VSCode: tqdm.notebook FloatProgress rendered via html-manager (html, not fallback); $passed_line"
