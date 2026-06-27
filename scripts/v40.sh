#!/usr/bin/env bash
# v40 — TERMINATE KERNEL: a user picks a running kernel and terminates it. The
#       kernel process is killed (frees the GPU host) and the session is dropped
#       from the daemon; reopening the file later spawns a fresh kernel while the
#       journaled output history survives on disk.
# Hermetic: drives the real daemon over the unix socket via the CLI (no VSCode).
#   1. session A defines x; its kernel is alive and listed in global status,
#   2. `tithon kill --session A` -> ok:true, the kernel PROCESS is dead,
#   3. A is no longer listed in global status (session dropped),
#   4. re-running A spawns a FRESH kernel (x gone, new pid),
#   5. killing an unknown session is a no-op (ok:false), not an error.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v40 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

A="file:///proj/k.py"

kpid() { # $1 = session id; kernel_pid from GLOBAL status ('' if not listed)
  "$TITHON" status | "$PY" -c "
import json,sys
d={s['session']: s['kernel_pid'] for s in json.load(sys.stdin)['sessions']}
print(d.get(sys.argv[1], ''))
" "$1"
}

kernel_dead() { # $1 = pid; true if no longer a running ipykernel (gone OR zombie).
  # `kill -0` can't tell a dead-but-unreaped zombie (empty /proc cmdline) from a
  # live process, so test the cmdline the way the daemon's liveness check does.
  [ -r "/proc/$1/cmdline" ] || return 0  # /proc gone -> reaped/dead
  local cmd
  cmd="$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null)"
  case "$cmd" in *ipykernel_launcher*) return 1 ;; *) return 0 ;; esac
}

setup_env v40
start_daemon || fail "daemon start failed"

# 1) A defines x; its kernel is alive and listed.
"$TITHON" run --session "$A" -c "x = 5
print('A_X', x)" --timeout 60 | grep -q "A_X 5" || fail "A did not set/print x"
pidA="$(kpid "$A")"
[ -n "$pidA" ] || fail "A's kernel not listed in global status"
kernel_dead "$pidA" && fail "A's kernel pid $pidA not actually alive"

# 2) Terminate A's kernel -> ok:true and the PROCESS is gone.
"$TITHON" kill --session "$A" | grep -q '"ok": true' || fail "kill op did not report ok:true"
for _ in $(seq 1 20); do kernel_dead "$pidA" && break; sleep 0.1; done
kernel_dead "$pidA" || fail "kernel pid $pidA still a live ipykernel after kill"

# 3) A is no longer listed (session dropped from the manager).
[ -z "$(kpid "$A")" ] || fail "session A still listed after kill"

# 4) Re-running A spawns a FRESH kernel: x is gone, new pid.
out="$("$TITHON" run --session "$A" -c "print('A_POST', 'x' in dir())" --timeout 60)"
echo "$out" | grep -q "A_POST False" || fail "re-run did not get a fresh namespace ($out)"
pidA2="$(kpid "$A")"
[ -n "$pidA2" ] || fail "A's fresh kernel not listed after re-run"
[ "$pidA2" != "$pidA" ] || fail "kernel pid unchanged after kill+rerun ($pidA2)"

# 5) Killing an unknown session is a graceful no-op (ok:false).
"$TITHON" kill --session "file:///proj/nope.py" | grep -q '"ok": false' \
  || fail "killing an unknown session did not report ok:false"

echo "RESULT v40 PASS terminate kernel kills the process (pid $pidA gone), drops the session, fresh kernel on re-run (pid $pidA2), unknown-session no-op"
