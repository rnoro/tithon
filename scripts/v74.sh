#!/usr/bin/env bash
# Actual callback output ownership, restart recovery, and scoped repaint.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v74 FAIL $1"; exit 1; }
timeout 120 "$PY" -m pytest -q "$ROOT/test/test_widget_output.py" || fail "callback output process regressions"
(cd "$ROOT/extension" && timeout 90 npx vitest run test/outputFold.test.ts test/liveSync.test.ts) || fail "output area/client repaint regressions"
echo "RESULT v74 PASS callback stdout/HTML/PNG/errors + cross-cell Output clear + replay/sidecar/compaction + actual daemon crash mid-callback + scoped repaint"
