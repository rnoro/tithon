#!/usr/bin/env bash
# v48 — KERNEL LIVENESS WATCHDOG: a kernel killed while the DAEMON STAYS UP (host
#       OOM-kill, operator kill, remote host loss) must be reported WITHOUT the user
#       running another cell. `is_alive` was consulted only on the execution path and
#       `Session.start()` — which derives the lost-state signal — is never re-entered
#       by a live daemon, so this death was previously observed by nobody: the client
#       kept showing a healthy kernel (the false negative ADR-075 left open, RISKS#3).
#       Also pins the two ways a naive watchdog goes wrong: re-reporting the same
#       death every tick, and reporting a DELIBERATE restart as a crash.
# Hermetic: real daemon + real detached kernel + a real SIGKILL on the kernel pid.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v48 FAIL $1"; exit 1; }

S="file:///proj/watchdog.py"
ATTACH=

cleanup() {
  [ -n "$ATTACH" ] && kill "$ATTACH" 2>/dev/null
  cleanup_procs
  pkill -9 -f "[i]pykernel_launcher.*-f $TITHON_HOME" 2>/dev/null
  return 0
}
trap cleanup EXIT

session_field() { # $1 = field; from THIS session's status
  timeout 10 "$TITHON" status --session "$S" \
    | "$PY" -c "import json,sys; print(json.load(sys.stdin).get(sys.argv[1]))" "$1"
}
count_dead() { # stdin = NDJSON stream -> number of tithon.kernel status=dead EVENTS.
  # Deliberately not `grep '"status": "dead"'`: the snapshot carries
  # kernel.status too, so a grep counts the CURRENT kernel state and reports a
  # success even when nothing was ever journaled. Match the event shape instead.
  "$PY" -c '
import json, sys
n = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        m = json.loads(line)
    except ValueError:
        continue
    if m.get("kind") == "kernel" and (m.get("payload") or {}).get("status") == "dead":
        n += 1
print(n)
'
}
dead_events() { # journaled dead events, from the DELTA replay (--since 1 = pure events)
  timeout 30 "$TITHON" attach --session "$S" --since 1 --once | count_dead
}

setup_env v48
export TITHON_KERNEL_WATCHDOG_POLL=1   # poll every 1s (production default: 5)
start_daemon || fail "daemon start failed"

# 1) A real session with a real detached kernel.
timeout 60 "$TITHON" run --session "$S" -c "x = 42
print('ALIVE', x)" --timeout 60 | grep -q "ALIVE 42" || fail "initial run failed"
kpid="$(session_field kernel_pid)"
[ -n "$kpid" ] && [ "$kpid" != "None" ] || fail "no kernel pid for $S"
kernel_dead "$kpid" && fail "kernel pid $kpid is not running"

# 2) A client is attached and LISTENING — it must be told, not have to ask.
timeout 60 "$TITHON" attach --session "$S" >"$TITHON_HOME/live.log" 2>&1 &
ATTACH=$!
sleep 1
grep -q '"op": "event"\|"op": "snapshot"' "$TITHON_HOME/live.log" || fail "attach produced no stream"

# 3) Kill the KERNEL only — the daemon stays up (that is the whole point).
dpid="$(daemon_pid)"
kill -9 "$kpid" || fail "could not SIGKILL kernel $kpid"
sleep 4                                   # several watchdog ticks; NO cell is run
kill -0 "$dpid" 2>/dev/null || fail "the daemon died too — this test proves nothing"
kernel_dead "$kpid" || fail "kernel $kpid survived SIGKILL"

# 4) The live client learned about it with no execute in between. It attached while
#    the kernel was healthy, so this can only have arrived as a pushed EVENT.
live_dead="$(count_dead <"$TITHON_HOME/live.log")"
[ "$live_dead" -ge 1 ] \
  || fail "attached client was never told the kernel died (watchdog silent)"

# 5) The daemon's own view flipped, so a fresh status call is honest too.
st="$(session_field kernel_status)"
[ "$st" = "dead" ] || fail "session status is '$st', expected 'dead'"

# 6) Journaled, not just broadcast: a client that reconnects LATER still learns it.
n="$(dead_events)"
[ "$n" -ge 1 ] || fail "no tithon.kernel dead event in the journal"

# 7) Reported ONCE. The watchdog re-polls forever; a per-tick event would flood the
#    journal and re-warn the user every second.
sleep 3
n2="$(dead_events)"
[ "$n2" = "$n" ] || fail "dead event re-journaled every tick ($n -> $n2)"
[ "$n2" = "1" ] || fail "expected exactly 1 dead event, got $n2"

# 8) Recovery: an explicit restart brings a fresh kernel back and the session works.
timeout 90 "$TITHON" restart --session "$S" >/dev/null || fail "restart after death failed"
kpid2="$(session_field kernel_pid)"
[ -n "$kpid2" ] && [ "$kpid2" != "$kpid" ] || fail "restart did not spawn a new kernel"
timeout 60 "$TITHON" run --session "$S" -c "print('BACK', 'x' in dir())" --timeout 60 \
  | grep -q "BACK False" || fail "fresh kernel unusable after the death"

# 9) NEGATIVE CONTROL: the deliberate restart must NOT have been reported as a crash.
#    (The kernel really is dead for a moment inside restart_kernel.)
sleep 3
n3="$(dead_events)"
[ "$n3" = "1" ] || fail "a deliberate restart was reported as a kernel death ($n3 dead events)"
st2="$(session_field kernel_status)"
[ "$st2" = "dead" ] && fail "session still reads 'dead' after a successful restart"

echo "RESULT v48 PASS out-of-band kernel death (pid $kpid SIGKILLed, daemon $dpid up) reached the attached client with no execute, reported exactly once, journaled; restart to pid $kpid2 not misreported"
