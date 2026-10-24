#!/usr/bin/env bash
# Dedicated .pynb defaults, execution/restore and independent source/output copying.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v70 FAIL $1"; exit 1; }
trap cleanup_procs EXIT
setup_env v70
ensure_extension_build || fail "extension build"
start_daemon || fail "daemon start"
cat > "$WORK/source.py" <<'PY_FIXTURE'
# %%
from IPython.display import display
source_only = 41
print("SOURCE", source_only)
display({"image/png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="}, raw=True)
PY_FIXTURE
export TITHON_WORKSPACE="$WORK" TITHON_FIXTURE="$WORK/source.py" TITHON_SUITE=pynb
OUT="$TITHON_HOME/vscode.log"
(cd "$ROOT/extension" && run_vscode node out-int/integration/runTest.js) >"$OUT" 2>&1 || { tail -80 "$OUT"; fail "dedicated notebook integration"; }
grep -Eq '[1-9][0-9]* passing' "$OUT" || fail "no executed mocha tests"
echo "RESULT v70 PASS default .pynb open/new + native execution/restore + saved source/current output copy + independent kernel/images + preserved .py"
