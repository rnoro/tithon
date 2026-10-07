#!/usr/bin/env bash
# Verify host dispatch without launching an editor or touching the user's Tunnel.
. "$(dirname "$0")/lib.sh"
timeout 30 "$PY" -m pytest -q "$ROOT/test/test_verify_portability.py" || { echo 'RESULT v68 FAIL verification host dispatch'; exit 1; }
echo 'RESULT v68 PASS Linux Xvfb + native macOS dispatch/process identity + host-compatible LSP selection'
