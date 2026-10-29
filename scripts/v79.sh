#!/usr/bin/env bash
# Exercise a classic AMD widget with a separately mapped JavaScript dependency.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v79 FAIL $1"; exit 1; }
trap cleanup_procs EXIT
setup_env v79
ensure_extension_build || fail "extension build"
FIX="$WORK/threejs.pynb"
cat > "$FIX" <<'PY'
# %%
import pythreejs as three
from IPython.display import display
cube = three.Mesh(geometry=three.BoxGeometry(), material=three.MeshBasicMaterial(color='red'))
scene = three.Scene(children=[three.AmbientLight(color='white'), cube])
camera = three.PerspectiveCamera(position=[0, 0, 5])
orbit = three.OrbitControls(controlling=camera)
view = three.Renderer(scene=scene, camera=camera, controls=[orbit], width=300, height=200, model_id='three')
display(view)
PY
start_daemon || fail "daemon start"
mkdir -p "$TITHON_HOME/test-extension"
(cd "$ROOT/extension" && node test/buildWidgetTransportHarness.cjs "$TITHON_HOME/test-extension") || fail "disposable renderer harness build"
export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="threejswidget" TITHON_HELPER="$PY" TITHON_TEST_WEBGL=1
OUT="$TITHON_HOME/vscode.log"
run_vscode node "$TITHON_HOME/test-extension/out-int/integration/runTest.js" > "$OUT" 2>&1
rc=$?
tail -60 "$OUT"
[ "$rc" -eq 0 ] || fail "real mapped dependency widget suite (rc=$rc)"
echo "RESULT v79 PASS real VSCode pythreejs mapped three dependency, camera interaction, live changes and reconnect"
