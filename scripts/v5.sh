#!/usr/bin/env bash
# v5 — ⑤ widget rendering spike. PASS requires all three:
#   (1) Widget State Mirror: tqdm.notebook(50000) then a *fresh* attach snapshot
#       holds a FloatProgress with value == max == total (real kernel+daemon).
#   (2) @jupyter-widgets/html-manager renders that mirror snapshot to a progress
#       bar at the expected value under jsdom (vitest test/widget.test.ts).
#   (3) Widget State Mirror unit tests incl. binary buffers (pytest).
# The @vscode/test-electron integration cannot run here (no display/xvfb); the
# sanctioned alternative (renderer renders without error + jsdom DOM check) is
# used and the limitation is recorded in DECISIONS.md (ADR-012).
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
echo "$SNAP" | "$PY" "$ROOT/verify/_check_v5.py" 50000 || fail "(1) widget mirror snapshot check failed"

# (2) html-manager jsdom render of the mirror snapshot.
echo "v5: html-manager jsdom render ---------------------------------------"
(cd "$EXT" && NO_COLOR=1 timeout 180 npx vitest run test/widget.test.ts) || fail "(2) jsdom widget render failed"

# (3) Widget State Mirror unit tests (deterministic, incl. binary buffers).
echo "v5: Widget State Mirror unit tests ----------------------------------"
timeout 120 "$PY" -m pytest "$ROOT/daemon/tests/test_widgets.py" -q || fail "(3) mirror unit tests failed"

# Document the integration-test environment limitation in the RESULT detail.
have_display="no-display(xvfb absent)"
command -v xvfb-run >/dev/null 2>&1 && have_display="xvfb-present"

echo "RESULT v5 PASS mirror 50k FloatProgress value==max==total ($MODELS models) + jsdom html-manager render + mirror unit tests; vscode-electron integration: $have_display -> jsdom alternative (see DECISIONS ADR-012)"
