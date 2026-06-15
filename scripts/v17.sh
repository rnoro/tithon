#!/usr/bin/env bash
# v17 — PER-FILE KERNELS: each file (session) gets its own kernel + journal, so
#       variables never leak between files and a restart wipes only that file's
#       namespace (user feedback #6 + #1 cross-file, and #5 kernel restart).
# Hermetic: drives the real daemon over the unix socket via the CLI (no VSCode).
#   1. session A sets x=111; session B cannot see x (isolation),
#   2. A still has x (persistent per-file kernel), B has its own kernel pid,
#   3. restart A's kernel -> x is gone in A (fresh namespace), new kernel pid,
#   4. B is untouched by A's restart.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v17 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

A="file:///proj/a.py"
B="file:///proj/b.py"

setup_env v17
start_daemon || fail "daemon start failed"

# 1) A defines x; B must not see it.
"$TITHON" run --session "$A" -c "x = 111
print('A_X', x)" --timeout 60 | grep -q "A_X 111" || fail "A did not set/print x"
out_b="$("$TITHON" run --session "$B" -c "print('B_HAS_X', 'x' in dir())" --timeout 60)"
echo "$out_b" | grep -q "B_HAS_X False" || fail "isolation broken: B sees A's x ($out_b)"

# 2) A still has x; two distinct kernels exist.
"$TITHON" run --session "$A" -c "print('A_AGAIN', x)" --timeout 60 | grep -q "A_AGAIN 111" \
  || fail "A lost x between calls (kernel not persistent)"
pids="$("$TITHON" status | "$PY" -c "
import json,sys
s={d['session']:d['kernel_pid'] for d in json.load(sys.stdin)['sessions']}
print(s.get('$A'), s.get('$B'))
")"
pidA_before="$(echo "$pids" | awk '{print $1}')"
pidB="$(echo "$pids" | awk '{print $2}')"
[ -n "$pidA_before" ] && [ -n "$pidB" ] || fail "missing kernel pids ($pids)"
[ "$pidA_before" != "$pidB" ] || fail "A and B share a kernel pid ($pidA_before) — not per-file"

# 3) Restart A's kernel: x must be gone, pid must change.
"$TITHON" restart --session "$A" | grep -q kernel_restarted || fail "restart op failed"
out_a="$("$TITHON" run --session "$A" -c "print('A_POST', 'x' in dir())" --timeout 60)"
echo "$out_a" | grep -q "A_POST False" || fail "restart did not reset A's namespace ($out_a)"
pidA_after="$("$TITHON" status | "$PY" -c "
import json,sys
print({d['session']:d['kernel_pid'] for d in json.load(sys.stdin)['sessions']}.get('$A'))
")"
[ "$pidA_after" != "$pidA_before" ] || fail "kernel pid unchanged after restart ($pidA_after)"

# 4) B survives A's restart (still has its own kernel, still isolated).
"$TITHON" run --session "$B" -c "y = 7
print('B_OK', y)" --timeout 60 | grep -q "B_OK 7" || fail "B broken after A restart"

echo "RESULT v17 PASS per-file kernels isolated (B!=A x), persistent (A keeps x), restart resets A only (pid $pidA_before->$pidA_after, B=$pidB)"
