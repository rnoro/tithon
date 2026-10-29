#!/usr/bin/env bash
# Real VSCode DOM events drive the production host/socket/kernel transport.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v73 FAIL $1"; exit 1; }
trap cleanup_procs EXIT
setup_env v73
ensure_extension_build || fail "extension build"
FIX="$WORK/widgets.pynb"
cat > "$FIX" <<'PY'
# %%
import ipywidgets as w
from IPython.display import display
button = w.Button(description='Click', model_id='button')
slider = w.IntSlider(value=0, min=0, max=100, model_id='slider')
fslider = w.FloatSlider(value=0, min=0, max=100, step=1, model_id='float-slider')
text = w.Text(value='initial', model_id='text')
dropdown = w.Dropdown(options=['a', 'b'], model_id='dropdown')
checkbox = w.Checkbox(value=False, description='Enabled', model_id='checkbox')
checkbox_changes = []
checkbox.observe(lambda change: checkbox_changes.append(change['new']), names='value')
label = w.Label(value='0', model_id='label')
clicks = 0
def clicked(_):
    global clicks
    clicks += 1
    label.value = str(clicks)
button.on_click(clicked)
group = w.VBox([button, slider, fslider, text, dropdown, checkbox, label], model_id='group')
display(button, slider, fslider, text, dropdown, checkbox, label, group)
PY
start_daemon || fail "daemon start"
mkdir -p "$TITHON_HOME/test-extension"
(cd "$ROOT/extension" && node test/buildWidgetTransportHarness.cjs "$TITHON_HOME/test-extension") || fail "disposable renderer DOM harness build"
export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="widgettransport" TITHON_HELPER="$PY"
OUT="$TITHON_HOME/vscode.log"
run_vscode node "$TITHON_HOME/test-extension/out-int/integration/runTest.js" > "$OUT" 2>&1
rc=$?
tail -40 "$OUT"
[ "$rc" -eq 0 ] || fail "real DOM transport suite (rc=$rc)"
echo "RESULT v73 PASS real VSCode DOM controls -> Python, checkbox remount and reconnect restore current value, replaced kernel revokes stale view"
