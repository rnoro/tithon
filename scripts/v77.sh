#!/usr/bin/env bash
# A restricted workspace must not execute a custom widget's JavaScript.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v77 FAIL $1"; exit 1; }
trap cleanup_procs EXIT
setup_env v77
ensure_extension_build || fail "extension build"
FIX="$WORK/untrusted.pynb"
cat > "$FIX" <<'PY'
# %%
import ipywidgets as w
from IPython.display import display
clicks = 0
button = w.Button(description='Allowed', model_id='button')
def clicked(_):
    global clicks
    clicks += 1
button.on_click(clicked)
display(button)
# %%
import anywidget
class Custom(anywidget.AnyWidget):
    _esm = """export default {
      initialize({model}) { model.send({event: 'unexpected'}); },
      render({el}) { el.textContent = 'unexpected JavaScript execution'; }
    };"""
events = []
custom = Custom(model_id='custom')
custom.on_msg(lambda _, content, buffers: events.append(content))
display(custom)
# %%
import bqplot as bq
figure = bq.Figure(title='Restricted bqplot', model_id='untrusted-figure')
display(figure)
PY
start_daemon || fail "daemon start"
"$PY" - "$TITHON_HOME/daemon.sock" "$FIX" <<'PY' || fail "seed notebook session"
import asyncio
import json
import sys
from pathlib import Path
from websockets.asyncio.client import unix_connect

socket = sys.argv[1]
source = Path(sys.argv[2])
session = source.as_uri()
cells = source.read_text().split('# %%\n')[1:]

async def seed():
    async with unix_connect(socket) as ws:
        await ws.send(json.dumps({'op': 'attach', 'session': session, 'workdir': str(source.parent)}))
        while json.loads(await ws.recv())['op'] != 'sync':
            pass
        for index, code in enumerate(cells):
            await ws.send(json.dumps({'op': 'execute', 'session': session, 'code': code,
                                      'origin': {'uri': session, 'index': index}}))
            while True:
                message = json.loads(await ws.recv())
                if message.get('kind') == 'done':
                    assert message['payload']['status'] == 'ok', message
                    break

asyncio.run(seed())
PY
mkdir -p "$TITHON_HOME/test-extension"
(cd "$ROOT/extension" && node test/buildWidgetTransportHarness.cjs "$TITHON_HOME/test-extension") || fail "disposable renderer DOM harness build"
export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="untrustedwidget" TITHON_HELPER="$PY" TITHON_TEST_UNTRUSTED=1
OUT="$TITHON_HOME/vscode.log"
run_vscode node "$TITHON_HOME/test-extension/out-int/integration/runTest.js" > "$OUT" 2>&1
rc=$?
tail -40 "$OUT"
[ "$rc" -eq 0 ] || fail "untrusted workspace suite (rc=$rc)"
echo "RESULT v77 PASS untrusted VSCode workspace rejects anywidget and external modules and preserves live stock controls"
