#!/usr/bin/env bash
# Real daemon/kernel and focused unit verification for retention and interchange.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v66 FAIL $1"; exit 1; }
timeout 180 "$PY" -m pytest -q "$ROOT/test/test_retention.py" "$ROOT/test/test_notebook.py" "$ROOT/test/test_feature_processes.py" || fail "storage/interchange regression tests"
echo "RESULT v66 PASS retention rollback/restart/sequence + notebook round trips + real daemon/kernel"
