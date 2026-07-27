#!/usr/bin/env bash
# v5 — ⑤ widget rendering spike. PASS requires all three:
#   (1) Widget State Mirror: tqdm.notebook(50000) then a *fresh* attach snapshot
#       holds a FloatProgress with value == max == total (real kernel+daemon).
#   (2) @jupyter-widgets/html-manager renders that mirror snapshot to a progress
#       bar at the expected value under jsdom (vitest test/widget.test.ts).
#   (3) Widget State Mirror unit tests incl. binary buffers (pytest).
# Bundle: widgets (hermetic — vitest jsdom + pytest, NO electron download). The
# jsdom html-manager render (2) is now ALSO covered by a REAL webview render in
# v29 (ADR-016 retired ADR-012's jsdom-only premise); v5 is kept as the fast
# hermetic widget-mirror + render smoke that runs without a VSCode download.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v5 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$d/npx" ] && PATH="$d:$PATH" && break
  done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v5-npm.log 2>&1) || fail "npm install failed"; }

# (1) real kernel + daemon: 50k-iteration tqdm.notebook, then fresh attach.
setup_env v5
start_daemon || fail "daemon start failed"
CODE='from tqdm.notebook import tqdm
for _ in tqdm(range(50000)):
    pass
print("loop done")'
timeout 180 "$TITHON" run -c "$CODE" >/dev/null || fail "tqdm.notebook cell failed"

MODELS="$(status_field widget_models)" || fail "status failed"
echo "v5: daemon mirror holds $MODELS widget models after 50k iterations"
SNAP="$(timeout 20 "$TITHON" attach --since 0 --once 2>/dev/null)"
echo "$SNAP" | "$PY" "$ROOT/scripts/_check_v5.py" 50000 || fail "(1) widget mirror snapshot check failed"

# (2) html-manager jsdom render of the mirror snapshot.
echo "v5: html-manager jsdom render ---------------------------------------"
(cd "$EXT" && NO_COLOR=1 timeout 180 npx vitest run test/widget.test.ts) || fail "(2) jsdom widget render failed"

# (3) Widget State Mirror unit tests (deterministic, incl. binary buffers).
echo "v5: Widget State Mirror unit tests ----------------------------------"
timeout 120 "$PY" -m pytest "$ROOT/test/test_widgets.py" -q || fail "(3) mirror unit tests failed"

# (4) The CLIENT half of the mirror: which wire events actually reach it. Pins the
#     two silent drops of ADR-083 — an event with `exec_id: null` (a widget updated
#     from a background thread after its cell's barrier popped the mapping) and the
#     pre-ADR-083 `kind:"output"` replay shape, which must stay a no-op.
echo "v5: widget comm event dispatch --------------------------------------"
(cd "$EXT" && NO_COLOR=1 timeout 180 npx vitest run test/widgetEvents.test.ts) \
  || fail "(4) widget comm event dispatch failed"

# Document the integration-test environment limitation in the RESULT detail.
have_display="no-display(xvfb absent)"
command -v xvfb-run >/dev/null 2>&1 && have_display="xvfb-present"

echo "RESULT v5 PASS mirror 50k FloatProgress value==max==total ($MODELS models) + jsdom html-manager render + mirror unit tests + client comm-event dispatch (exec_id null / wrong replay shape); vscode-electron integration: $have_display -> jsdom alternative (see DECISIONS ADR-012)"
