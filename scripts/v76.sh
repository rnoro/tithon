#!/usr/bin/env bash
# Exercise upstream anywidget models and composition through the real renderer.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v76 FAIL $1"; exit 1; }
trap cleanup_procs EXIT
setup_env v76
ensure_extension_build || fail "extension build"
FIX="$WORK/anywidget.pynb"
cat > "$FIX" <<'PY'
# %%
import anywidget
import traitlets
from IPython.display import display

class Counter(anywidget.AnyWidget):
    _esm = """export default {
      initialize({signal}) {
        globalThis.__tithonAnyCreated = (globalThis.__tithonAnyCreated || 0) + 1;
        signal.addEventListener('abort', () => {
          globalThis.__tithonAnyDestroyed = (globalThis.__tithonAnyDestroyed || 0) + 1;
        });
      },
      render({model, el, signal}) {
        const button = document.createElement('button');
        const update = () => { button.textContent = `Count ${model.get('value')}`; };
        model.on('change:value', update);
        signal.addEventListener('abort', () => model.off('change:value', update));
        button.addEventListener('click', () => {
          model.set('value', model.get('value') + 1);
          model.save_changes();
          model.send({event: 'click'});
        }, {signal});
        update();
        el.appendChild(button);
      }
    };"""
    value = traitlets.Int(0).tag(sync=True)

class Container(anywidget.AnyWidget):
    _esm = """export default {
      async render({model, el, signal, host}) {
        const child = await host.getWidget(model.get('child'));
        await child.render({el, signal});
      }
    };"""
    child = anywidget.WidgetTrait().tag(sync=True)

class Broken(anywidget.AnyWidget):
    _esm = """export default {
      initialize() { throw new Error('widget initialization failed'); },
      render({el}) { el.textContent = 'should not initialize'; }
    };"""
    value = traitlets.Int(0).tag(sync=True)

counter = Counter(model_id='counter')
parent = Container(child=counter, model_id='parent')
nested = Counter(model_id='nested')
nested_parent = Container(child=nested, model_id='nested-parent')
nested_changes = []
nested.observe(lambda change: nested_changes.append(change['new']), names='value')
broken = Broken(model_id='broken')
events = []
counter.on_msg(lambda _, content, buffers: events.append(content['event']))
display(counter, parent, nested_parent, broken)
PY
start_daemon || fail "daemon start"
mkdir -p "$TITHON_HOME/test-extension"
(cd "$ROOT/extension" && node test/buildWidgetTransportHarness.cjs "$TITHON_HOME/test-extension") || fail "disposable renderer DOM harness build"
export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="anywidget" TITHON_HELPER="$PY"
OUT="$TITHON_HOME/vscode.log"
run_vscode node "$TITHON_HOME/test-extension/out-int/integration/runTest.js" > "$OUT" 2>&1
rc=$?
tail -40 "$OUT"
[ "$rc" -eq 0 ] || fail "real anywidget suite (rc=$rc)"
echo "RESULT v76 PASS real anywidget DOM, shared and nested-only composition, custom messages, reconnect and cleanup, no replay, failed-model isolation, replacement revocation"
