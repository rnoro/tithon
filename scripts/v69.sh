#!/usr/bin/env bash
# Real VSCode: workspace home overrides the inherited environment consistently;
# bounded reconnect stops, then manual retry preserves the detached namespace.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v69 FAIL $1"; exit 1; }
cleanup() {
  if [ -n "${TITHON_CONFIGURED_HOME:-}" ]; then
    TITHON_HOME="$TITHON_CONFIGURED_HOME" cleanup_procs
  fi
  cleanup_procs
}
trap cleanup EXIT
ensure_extension_build || fail "extension build failed"
setup_env v69
export TITHON_CONFIGURED_HOME="$TITHON_HOME/configured"
mkdir -p "$WORK/.vscode"
export TITHON_FIXTURE="$WORK/connectionsettings.py" TITHON_WORKSPACE="$WORK" TITHON_SUITE="connectionsettings"
"$PY" - "$PY" <<'PY'
import json
import os
import sys
from pathlib import Path
Path(os.environ['TITHON_FIXTURE']).write_text('# %%\nn = globals().get("n", 0) + 1\nprint(f"VALUE {n}")\n')
settings = {'tithon.homePath': os.environ['TITHON_CONFIGURED_HOME'], 'tithon.pythonPath': sys.argv[1], 'tithon.reconnectMaxAttempts': 1, 'tithon.confirmDestructiveActions': False}
Path(os.environ['TITHON_WORKSPACE'], '.vscode', 'settings.json').write_text(json.dumps(settings))
PY
OUT="$(mktemp)"
(cd "$ROOT/extension" && run_vscode node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -Eq '1 passing' "$OUT" || rc=1
tail -50 "$OUT"
rm -f "$OUT"
[ "$rc" -eq 0 ] || fail "workspace connection settings test failed (rc=$rc)"
echo "RESULT v69 PASS configured home startup/execution/management; bounded reconnect; manual retry preserves namespace"
