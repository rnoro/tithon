#!/usr/bin/env bash
# Exercise installed classic AMD widget modules in the real VSCode renderer.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v78 FAIL $1"; exit 1; }
trap cleanup_procs EXIT
setup_env v78
ensure_extension_build || fail "extension build"
FIX="$WORK/thirdparty.pynb"
cat > "$FIX" <<'PY'
# %%
import bqplot as bq
from bqplot.interacts import BrushIntervalSelector
from IPython.display import display
import ipywidgets as w
import traitlets
x_scale = bq.LinearScale()
y_scale = bq.LinearScale()
line = bq.Lines(x=[0, 1, 2], y=[1, 2, 3], scales={'x': x_scale, 'y': y_scale})
selector = BrushIntervalSelector(scale=x_scale, marks=[line], model_id='selector')
fig = bq.Figure(marks=[line], interaction=selector, title='First title', model_id='figure')
class Missing(w.DOMWidget):
    _model_name = traitlets.Unicode('MissingModel').tag(sync=True)
    _view_name = traitlets.Unicode('MissingView').tag(sync=True)
    _model_module = traitlets.Unicode('no-such-widget').tag(sync=True)
    _view_module = traitlets.Unicode('no-such-widget').tag(sync=True)
    _model_module_version = traitlets.Unicode('^1.0.0').tag(sync=True)
    _view_module_version = traitlets.Unicode('^1.0.0').tag(sync=True)
missing = Missing(model_id='missing')
button = w.Button(description='Keep working', model_id='mixed-button')
clicks = 0
def clicked(_):
    global clicks
    clicks += 1
button.on_click(clicked)
mixed = w.VBox([button, missing], model_id='mixed')
display(fig, missing, mixed)
PY
start_daemon || fail "daemon start"
mkdir -p "$TITHON_HOME/test-extension"
(cd "$ROOT/extension" && node test/buildWidgetTransportHarness.cjs "$TITHON_HOME/test-extension") || fail "disposable renderer harness build"
export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="thirdpartywidget" TITHON_HELPER="$PY"
OUT="$TITHON_HOME/vscode.log"
run_vscode node "$TITHON_HOME/test-extension/out-int/integration/runTest.js" > "$OUT" 2>&1
rc=$?
tail -60 "$OUT"
[ "$rc" -eq 0 ] || fail "real third-party widget suite (rc=$rc)"
echo "RESULT v78 PASS real VSCode bqplot/bqscales, brush input, mixed controls, dynamic children, reconnect and replacement"
