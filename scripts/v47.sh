#!/usr/bin/env bash
# v47 — EXECUTE_REPLY PAYLOAD: IPython's `?`/`??` help pager rides the SHELL reply's
#       `payload` list, NOT iopub. A daemon reading only status/execution_count makes
#       `obj?` — the first idiom an IPython user types — produce NOTHING: no output,
#       no error, a silent hole. This proves the pager text reaches the client live,
#       is JOURNALED (so it survives reconnect in the snapshot), and that a plain
#       expression still produces exactly one execute_result (no duplicate output).
# Hermetic: real daemon + real detached kernel over the unix socket via the CLI.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v47 FAIL $1"; exit 1; }

S="file:///proj/pager.py"

cleanup() {
  cleanup_procs
  pkill -9 -f "[i]pykernel_launcher.*-f $TITHON_HOME" 2>/dev/null
  return 0
}
trap cleanup EXIT

setup_env v47
start_daemon || fail "daemon start failed"

# 1) `len?` — the single-? pager. Its text is carried ONLY by execute_reply.payload;
#    if the daemon drops the field this run prints nothing at all.
out="$(timeout 60 "$TITHON" run --session "$S" -c "len?" --timeout 60)" \
  || fail "run of 'len?' failed"
[ -n "$(echo "$out" | tr -d '[:space:]')" ] || fail "'len?' produced NO output (payload dropped)"
echo "$out" | grep -qi "signature\|docstring\|number of items" \
  || fail "'len?' output has no pager text: $out"

# 2) `??` (source/extended) goes through the same field.
out2="$(timeout 60 "$TITHON" run --session "$S" -c "dict??" --timeout 60)" \
  || fail "run of 'dict??' failed"
echo "$out2" | grep -qi "docstring\|signature\|type:" \
  || fail "'dict??' output has no pager text: $out2"

# 3) Durability: the pager text must be in the JOURNAL, not merely broadcast —
#    a client that reconnects later has only the snapshot to read.
snap="$(timeout 60 "$TITHON" attach --session "$S" --once)" || fail "snapshot attach failed"
echo "$snap" | grep -qi "signature\|docstring\|number of items" \
  || fail "pager output missing from the reconnect snapshot (not journaled)"

# 4) The payload path must be additive, not a second copy of ordinary output:
#    a plain expression still yields exactly ONE result line.
out3="$(timeout 60 "$TITHON" run --session "$S" -c "6*7" --timeout 60)" \
  || fail "plain expression run failed"
n="$(echo "$out3" | grep -c '^42$')"
[ "$n" = "1" ] || fail "plain expression produced $n '42' lines (expected 1): $out3"

# 5) A magic that returns no payload must stay silent (no empty stream injected).
out4="$(timeout 60 "$TITHON" run --session "$S" -c "z = 1" --timeout 60)" \
  || fail "assignment run failed"
[ -z "$(echo "$out4" | tr -d '[:space:]')" ] || fail "assignment emitted output: $out4"

echo "RESULT v47 PASS execute_reply.payload surfaced: 'len?' + 'dict??' render pager text live and after reconnect; plain output unaffected"
