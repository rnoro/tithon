#!/usr/bin/env bash
# v4 — 데몬 크래시 생존: 1초마다 x를 증가시키는 셀 실행 중 데몬 kill -9 → 재시작 → re-attach.
# 커널 PID 동일 + 이후 x 조회 값이 크래시 직전 마지막 관측치보다 크면(인메모리 연속성) PASS.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v4 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

setup_env v4
start_daemon || fail "daemon start failed"

# 백그라운드 스레드가 1초마다 x를 증가 — 셀 제출 후 데몬이 죽어도 커널 안에서 계속 돈다
CODE='import threading, time
x = 0
def _inc():
    global x
    while True:
        x += 1
        time.sleep(1)
threading.Thread(target=_inc, daemon=True).start()'
timeout 60 "$TITHON" run -c "$CODE" >/dev/null || fail "incrementer cell failed"

DPID1="$(daemon_pid)"
KPID1="$(status_field kernel_pid)" || fail "status before crash failed"
[ -n "$DPID1" ] || fail "no daemon pid"

sleep 2.5
X1="$(timeout 30 "$TITHON" run -c 'print(x)' | tr -d '[:space:]')"
case "$X1" in (''|*[!0-9]*) fail "x observation not numeric: '$X1'";; esac

# 진짜 데몬 프로세스에 kill -9
kill -9 "$DPID1" || fail "kill -9 failed"
sleep 0.5
kill -0 "$DPID1" 2>/dev/null && fail "daemon still alive after kill -9"

start_daemon || fail "daemon restart failed"
DPID2="$(daemon_pid)"
[ "$DPID1" != "$DPID2" ] || fail "daemon pid did not change after restart"

REATT="$(status_field kernel_reattached)" || fail "status after restart failed"
KPID2="$(status_field kernel_pid)"
[ "$REATT" = "True" ] || fail "daemon did not re-attach (spawned new kernel?)"
[ "$KPID1" = "$KPID2" ] || fail "kernel pid changed: $KPID1 -> $KPID2"
kill -0 "$KPID1" 2>/dev/null || fail "kernel process not alive"

sleep 2.5
X2="$(timeout 30 "$TITHON" run -c 'print(x)' | tr -d '[:space:]')"
case "$X2" in (''|*[!0-9]*) fail "post-crash x observation not numeric: '$X2'";; esac
[ "$X2" -gt "$X1" ] || fail "x not continuous: $X1 -> $X2"

echo "RESULT v4 PASS kernel pid $KPID1 survived daemon kill -9 (daemon $DPID1->$DPID2), x continuity $X1->$X2"
