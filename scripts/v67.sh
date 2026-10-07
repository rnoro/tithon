#!/usr/bin/env bash
# Real VSCode notebook import/export, rich restore readiness, retry and cancellation.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v67 FAIL $1"; exit 1; }
trap cleanup_procs EXIT
setup_env v67
ensure_extension_build || fail "extension build"
start_daemon || fail "daemon start"
"$PY" - "$WORK/input.ipynb" <<'PY_NOTEBOOK'
import base64, sys, nbformat
png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
nb = nbformat.v4.new_notebook(cells=[
    nbformat.v4.new_code_cell("open('executed', 'w').write('bad')", outputs=[nbformat.v4.new_output('stream', name='stdout', text='saved output\n'), nbformat.v4.new_output('display_data', data={'image/png': png})], execution_count=1),
    nbformat.v4.new_markdown_cell('# Markdown'),
    nbformat.v4.new_raw_cell('raw content')], metadata={'authors': [{'name': 'Test Author'}], 'language_info': {'name': 'python'}})
nbformat.write(nb, sys.argv[1])
PY_NOTEBOOK
export TITHON_WORKSPACE="$WORK" TITHON_FIXTURE="$WORK/input.ipynb" TITHON_SUITE=interchange
OUT="$TITHON_HOME/vscode.log"
(cd "$ROOT/extension" && run_vscode node out-int/integration/runTest.js) >"$OUT" 2>&1 || { tail -70 "$OUT"; fail "VSCode interchange suite"; }
"$PY" - "$WORK/converted.ipynb" <<'PY_VALIDATE'
import nbformat, sys
nbformat.validate(nbformat.read(sys.argv[1], as_version=4))
PY_VALIDATE
[ ! -e "$WORK/executed" ] || fail "imported code was executed"
echo "RESULT v67 PASS real VSCode import/export + images + restore completion/retry/cancellation"
