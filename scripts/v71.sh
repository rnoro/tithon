#!/usr/bin/env bash
# Verify actual-kernel identity, historical widget scopes, and saved projection.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v71 FAIL $1"; exit 1; }

timeout 120 "$PY" -m pytest -q \
  "$ROOT/test/test_widget_identity.py" \
  "$ROOT/test/test_widget_saved_state.py" \
  "$ROOT/test/test_widget_identity_processes.py" \
  || fail "kernel/widget identity and saved-state regressions"
(cd "$ROOT/extension" && timeout 90 npx vitest run \
  test/widgetIdentity.test.ts test/widgetBuffers.test.ts test/restoreWidgets.test.ts) \
  || fail "client/renderer scope isolation regressions"

echo "RESULT v71 PASS actual kernel identity + SIGKILL reattach/namespace + colliding historical model IDs + live/replay equality + retention/clone/export + scoped client/renderer updates"
