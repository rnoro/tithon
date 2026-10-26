#!/usr/bin/env bash
# Actual socket comms, callback correlation, binary framing and binding validation.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v72 FAIL $1"; exit 1; }
timeout 120 "$PY" -m pytest -q "$ROOT/test/test_widget_transport.py" || fail "real comm transport regressions"
(cd "$ROOT/extension" && timeout 90 npx vitest run test/widgetComm.test.ts) || fail "client/shared registry/callback regressions"
echo "RESULT v72 PASS real socket/kernel clicks + repeated slider correction + binary custom + peer/replay equality + stale rejection + shared live views"
