#!/usr/bin/env bash
# Real VSCode DOM events drive the production host/socket/kernel transport.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v75 FAIL $1"; exit 1; }
trap cleanup_procs EXIT
setup_env v75
ensure_extension_build || fail "extension build"
FIX="$WORK/widgets.pynb"
cat > "$FIX" <<'PY'
# %%
import ipywidgets as w
from IPython.display import display, HTML, Image, clear_output
import base64
button = w.Button(model_id='button')
out = w.Output(model_id='out')
clicks = 0
def clicked(_):
    global clicks
    clicks += 1
    print('PLAIN', clicks, flush=True)
    if clicks == 3:
        raise RuntimeError('plain-error')
    with out:
        clear_output(wait=True)
        print('CAPTURE', clicks, flush=True)
        display(HTML('<b>captured-%s</b>' % clicks))
        display(Image(data=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')))
        if clicks == 2:
            raise ValueError('captured-error')
    print('TAIL', clicks, flush=True)
button.on_click(clicked)
display(out)
print('SIBLING A')
# %%
display(button)
print('SIBLING B')
# %%
with out:
    clear_output()
print('CLEARED')
PY
start_daemon || fail "daemon start"
mkdir -p "$TITHON_HOME/test-extension"
(cd "$ROOT/extension" && node test/buildWidgetTransportHarness.cjs "$TITHON_HOME/test-extension") || fail "disposable renderer DOM harness build"
export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="widgetoutput" TITHON_HELPER="$PY"
OUT="$TITHON_HOME/vscode.log"
run_vscode node "$TITHON_HOME/test-extension/out-int/integration/runTest.js" > "$OUT" 2>&1
rc=$?
tail -40 "$OUT"
[ "$rc" -eq 0 ] || fail "real DOM transport suite (rc=$rc)"
echo "RESULT v75 PASS real VSCode DOM callbacks -> separate cell stdout/HTML/PNG/errors; Output replacement and later clear preserve siblings"
