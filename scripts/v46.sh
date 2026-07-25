#!/usr/bin/env bash
# v46 — HOST REBOOT: lost-state signal. A reboot takes the kernel with it but
#       leaves the journal, artifacts, pid file and connection file on disk. The
#       daemon deliberately does NOT error on an unresumable kernel — it spawns a
#       fresh one — so the file reopens with its FULL output history restored and
#       LOOKS intact while the namespace is empty. Without a signal the user only
#       finds out via a NameError several cells later.
#
#       Reboot shape (distinct from v45's idle-GC reap and v4's daemon-only
#       crash): kernel SIGKILLed + daemon killed + the STALE pid/connection files
#       left in place, then the daemon restarted. Asserts:
#         1. the stale connection + pid files really did survive (the reboot shape),
#         2. re-attach restores the pre-reboot output history from the journal,
#         3. the new kernel is a DIFFERENT, working process with an EMPTY namespace,
#         4. the daemon reports kernel_lost_state=true to the client (the signal),
#         5. NO false positive: a daemon restart with the kernel ALIVE re-attaches
#            (kernel_lost_state=false) — otherwise every reconnect would nag,
#         6. NO false positive: a brand-new session has nothing to have lost,
#         7. NO false positive: a DELIBERATE restart_kernel clears the flag,
#         8. DURABILITY: an unreported loss survives a later daemon restart that
#            re-attaches to the replacement kernel (it must not be erased before
#            a client ever read it),
#         9. NO false positive: `tithon kill` then reopen is remembered as
#            deliberate across the new Session,
#        10. NO false positive: a kill-kernels shutdown (interpreter change) too,
#        11. a durable kernel_generation is exposed for client de-duplication
#            (keying on the reusable pid would swallow a real second loss),
#        12. NO false NEGATIVE: a deliberate restart does not pardon a LATER
#            reboot — state rebuilt on the fresh kernel is still lost state,
#        13. the generation id ADVANCES between two distinct losses (a constant
#            or the pid would make the client swallow the second warning).
# Hermetic: real daemon + real detached kernels over the unix socket via the CLI.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v46 FAIL $1"; exit 1; }

A="file:///proj/reboot.py"    # killed like a host reboot -> must report lost state
S="file:///proj/survivor.py"  # kernel stays alive across the daemon restart
N="file:///proj/newfile.py"   # never had a kernel before  -> must NOT report

cleanup() {
  cleanup_procs
  pkill -9 -f "[i]pykernel_launcher.*-f $TITHON_HOME" 2>/dev/null
  return 0
}
trap cleanup EXIT

sess_dir_for_pid() { # $1 = kernel pid -> the session dir whose kernel.pid names it
  # A uri session with no workdir hint hashes to sessions/<sha256[:16]> (ADR-044),
  # so locate the dir by the pid we already know rather than recomputing the hash.
  local d
  for d in "$TITHON_HOME"/sessions/*/; do
    [ -f "$d/kernel.pid" ] || continue
    [ "$(cat "$d/kernel.pid")" = "$1" ] && { echo "${d%/}"; return 0; }
  done
  return 1
}

sess_field() { # $1 = session id, $2 = field -> that session's status field
  timeout 10 "$TITHON" status --session "$1" \
    | "$PY" -c "import json,sys; print(json.load(sys.stdin).get(sys.argv[1]))" "$2"
}

session_pid() { # $1 = session id -> kernel pid from the global status ('' if absent)
  timeout 10 "$TITHON" status | "$PY" -c "
import json, sys
sessions = {d['session']: d['kernel_pid'] for d in json.load(sys.stdin)['sessions']}
print(sessions.get(sys.argv[1]) or '')
" "$1"
}

setup_env v46
start_daemon || fail "daemon start failed"
echo "v46: daemon up (pid $(daemon_pid))"

# --- 1) Pre-reboot: A does real work; S is the control that will survive -------
timeout 60 "$TITHON" run --session "$A" -c "import os
secret = 4242
print('A_BEFORE', secret)" --timeout 60 | grep -q "A_BEFORE 4242" || fail "A pre-reboot run failed"
pidA="$(session_pid "$A")"
[ -n "$pidA" ] || fail "no kernel pid for A"

timeout 60 "$TITHON" run --session "$S" -c "keep = 7
print('S_BEFORE', keep)" --timeout 60 | grep -q "S_BEFORE 7" || fail "S pre-reboot run failed"
pidS="$(session_pid "$S")"
[ -n "$pidS" ] || fail "no kernel pid for S"

# Before the reboot A must report an INTACT kernel — otherwise assertion 4 below
# would pass vacuously (a flag that is always true signals nothing).
lost_before="$(sess_field "$A" kernel_lost_state)"
[ "$lost_before" = "False" ] || fail "A reported kernel_lost_state=$lost_before while its kernel was alive"

dirA="$(sess_dir_for_pid "$pidA")"
[ -n "$dirA" ] || fail "could not locate A's session dir"
echo "v46: pre-reboot pidA=$pidA pidS=$pidS dir=$dirA"

# --- 2) The reboot: A's kernel dies, the daemon dies, the files stay ----------
# A real reboot kills processes but does NOT clean $TITHON_HOME, so the pid file
# and connection file are left behind pointing at a dead kernel. That STALE pair
# is the whole point of this shape: it is what a naive re-attach would trust.
kill -9 "$pidA" 2>/dev/null
dp="$(daemon_pid)"
[ -n "$dp" ] || fail "no daemon pid file"
kill -9 "$dp" 2>/dev/null
for _ in $(seq 1 50); do kill -0 "$dp" 2>/dev/null || break; sleep 0.2; done
kill -0 "$dp" 2>/dev/null && fail "daemon (pid $dp) survived kill -9"
for _ in $(seq 1 50); do kill -0 "$pidA" 2>/dev/null || break; sleep 0.2; done
kill -0 "$pidA" 2>/dev/null && fail "A's kernel (pid $pidA) survived kill -9"

# Assertion 1: the reboot shape is real — stale files, dead process.
[ -f "$dirA/kernel.json" ] || fail "connection file vanished; this is not the reboot shape"
[ -f "$dirA/kernel.pid" ] || fail "pid file vanished; this is not the reboot shape"
[ "$(cat "$dirA/kernel.pid")" = "$pidA" ] || fail "pid file no longer names the dead kernel"
echo "v46: rebooted — kernel $pidA and daemon $dp dead; stale kernel.json/kernel.pid kept"

# --- 3) Boot back up ----------------------------------------------------------
start_daemon || fail "daemon restart failed"

# Assertion 2: the journal survived the reboot — full output history restored.
snap="$(timeout 60 "$TITHON" attach --session "$A" --once)" || fail "re-attach to A failed"
echo "$snap" | grep -q "A_BEFORE 4242" || fail "A's snapshot lost its pre-reboot output"

# Assertion 4: the lost-state signal reaches the client.
lost="$(sess_field "$A" kernel_lost_state)"
[ "$lost" = "True" ] || fail "A did not report kernel_lost_state after the reboot (got '$lost')"
sess_field "$A" kernel_reattached | grep -q False \
  || fail "A claims it re-attached to a kernel that was killed"

# Assertion 3: a DIFFERENT, working kernel with an EMPTY namespace.
pidA2="$(session_pid "$A")"
[ -n "$pidA2" ] || fail "no kernel pid for A after the reboot"
[ "$pidA2" = "$pidA" ] && fail "A's kernel pid unchanged after the reboot (stale pid trusted)"
kill -0 "$pidA2" 2>/dev/null || fail "A's post-reboot kernel (pid $pidA2) is not running"
out="$(timeout 60 "$TITHON" run --session "$A" -c "print('A_AFTER', 'secret' in dir())" --timeout 60)"
echo "$out" | grep -q "A_AFTER False" || fail "rebooted A kept its namespace ($out)"

# --- 5) False-positive guard: the surviving kernel must NOT be flagged --------
# S's kernel outlived the daemon (the detached-kernel invariant, v4). Re-attaching
# to it is the NORMAL reconnect path; flagging it would nag on every reconnect and
# train the user to ignore the warning that matters.
kill -0 "$pidS" 2>/dev/null || fail "S's kernel (pid $pidS) did not survive the daemon restart"
lostS="$(sess_field "$S" kernel_lost_state)"
[ "$lostS" = "False" ] || fail "S was flagged lost_state though its kernel survived (got '$lostS')"
sess_field "$S" kernel_reattached | grep -q True || fail "S did not re-attach to its live kernel"
pidS2="$(session_pid "$S")"
[ "$pidS2" = "$pidS" ] || fail "S's kernel pid changed ($pidS -> $pidS2): it was respawned, not re-attached"
outS="$(timeout 60 "$TITHON" run --session "$S" -c "print('S_AFTER', keep)" --timeout 60)"
echo "$outS" | grep -q "S_AFTER 7" || fail "S lost its namespace across the daemon restart"

# --- 6) False-positive guard: a brand-new session has lost nothing ------------
timeout 60 "$TITHON" run --session "$N" -c "print('N_NEW')" --timeout 60 | grep -q "N_NEW" \
  || fail "N run failed"
lostN="$(sess_field "$N" kernel_lost_state)"
[ "$lostN" = "False" ] || fail "brand-new session N flagged lost_state (got '$lostN')"

# --- 8) DURABILITY: an unreported loss must survive a later daemon restart ----
# A's kernel was replaced involuntarily above. If the daemon now restarts while
# that replacement kernel is still ALIVE, a naive `not reattached` rule would
# re-derive lost_state=False and the loss would be erased before any client ever
# saw it (the signal is only read on attach, and the first attach may be the CLI
# or an old client). The provenance is journaled, so it must survive.
pidA3="$(session_pid "$A")"
dp2="$(daemon_pid)"
kill "$dp2" 2>/dev/null
for _ in $(seq 1 50); do kill -0 "$dp2" 2>/dev/null || break; sleep 0.2; done
kill -0 "$pidA3" 2>/dev/null || fail "A's kernel died with the daemon; cannot test durability"
start_daemon || fail "daemon restart failed"
sess_field "$A" kernel_reattached | grep -q True \
  || fail "A did not re-attach to its surviving kernel; durability case not exercised"
lostD="$(sess_field "$A" kernel_lost_state)"
[ "$lostD" = "True" ] || fail "an unreported involuntary loss was erased by a daemon restart (got '$lostD')"

# --- 7) False-positive guard: a DELIBERATE restart clears the flag ------------
# A explicitly restarted its kernel: the namespace is empty because the user asked,
# so the "your state vanished" warning must not fire again for it.
timeout 60 "$TITHON" restart --session "$A" >/dev/null || fail "restart_kernel failed"
lostR="$(sess_field "$A" kernel_lost_state)"
[ "$lostR" = "False" ] || fail "deliberate restart still reports lost_state (got '$lostR')"
gen7="$(sess_field "$A" kernel_generation)"

# --- 12) A deliberate marker is NOT a standing pardon ------------------------
# The single most likely real sequence: the user restarts the kernel, rebuilds an
# hour of state on the FRESH kernel, and THEN the host reboots. The journal's last
# lifecycle record is still that deliberate restart, so a rule that merely asks
# "was the last event deliberate?" reports lost_state=false and the user is told
# nothing — the exact failure this whole feature exists to prevent. The window
# must be anchored at the restart and re-opened by work done after it.
timeout 60 "$TITHON" run --session "$A" -c "rebuilt = 99
print('A_REBUILT', rebuilt)" --timeout 60 | grep -q "A_REBUILT 99" \
  || fail "post-restart run failed"
pidA4="$(session_pid "$A")"
[ -n "$pidA4" ] || fail "no kernel pid for A after the deliberate restart"
kill -9 "$pidA4" 2>/dev/null
dp3="$(daemon_pid)"
kill -9 "$dp3" 2>/dev/null
for _ in $(seq 1 50); do kill -0 "$dp3" 2>/dev/null || break; sleep 0.2; done
for _ in $(seq 1 50); do kill -0 "$pidA4" 2>/dev/null || break; sleep 0.2; done
start_daemon || fail "daemon restart after the post-restart reboot failed"
lostP="$(sess_field "$A" kernel_lost_state)"
[ "$lostP" = "True" ] \
  || fail "a reboot AFTER a deliberate restart was pardoned by the stale marker (got '$lostP')"
outP="$(timeout 60 "$TITHON" run --session "$A" -c "print('A_REBOOT2', 'rebuilt' in dir())" --timeout 60)"
echo "$outP" | grep -q "A_REBOOT2 False" || fail "post-restart reboot kept its namespace ($outP)"

# --- 13) The generation id MOVES between two distinct losses -----------------
# De-duplication is only correct if a SECOND involuntary loss gets a new id: a
# client that keys on a constant (or on the recycled pid) would show the first
# warning and silently swallow every later one.
genP="$(sess_field "$A" kernel_generation)"
[ -n "$genP" ] && [ "$genP" != "None" ] || fail "no kernel_generation after the second loss"
[ "$genP" != "$gen7" ] \
  || fail "kernel_generation did not advance across a new loss ($gen7 -> $genP): warnings would be swallowed"
[ "$genP" != "$pidA4" ] && [ "$genP" != "$(session_pid "$A")" ] \
  || fail "kernel_generation is the kernel pid; a recycled pid would suppress a real loss"

# --- 9) A DELIBERATE kill is remembered as deliberate across a reopen ---------
# `tithon kill` drops the session; reopening the file builds a NEW Session with a
# fresh kernel over the same journal — indistinguishable from the reboot shape
# unless the intent was recorded. It was (the kill journals deliberate=true), so
# the user who asked for this must NOT be told their state vanished unexpectedly.
# Sessions are lazy: after the daemon restarts above, S is not loaded until
# something touches it, and `kill` only acts on a LIVE session. Re-attach first
# (this is what a client reopening the file does), then kill for real.
sess_field "$S" kernel_pid >/dev/null || fail "could not re-attach S before the kill"
timeout 30 "$TITHON" kill --session "$S" >/dev/null 2>&1 || fail "kill of S failed"
timeout 60 "$TITHON" run --session "$S" -c "print('S_REOPEN')" --timeout 60 | grep -q "S_REOPEN" \
  || fail "S did not reopen after kill"
lostK="$(sess_field "$S" kernel_lost_state)"
[ "$lostK" = "False" ] || fail "a deliberate 'tithon kill' was reported as an involuntary loss (got '$lostK')"

# --- 10) An interpreter change (kill-kernels shutdown) is deliberate too ------
# The extension's restartDaemon() does exactly this to apply a new interpreter.
# The namespace is genuinely cleared, but the user asked for it in this session.
timeout 30 "$TITHON" shutdown --kill-kernels >/dev/null 2>&1
for _ in $(seq 1 50); do timeout 5 "$TITHON" status >/dev/null 2>&1 || break; sleep 0.2; done
start_daemon || fail "daemon restart after interpreter-change shutdown failed"
lostI="$(sess_field "$A" kernel_lost_state)"
[ "$lostI" = "False" ] || fail "a deliberate kill-kernels shutdown was reported as a loss (got '$lostI')"
outI="$(timeout 60 "$TITHON" run --session "$A" -c "print('A_INTERP', 'secret' in dir())" --timeout 60)"
echo "$outI" | grep -q "A_INTERP False" || fail "namespace survived the kill-kernels restart ($outI)"

# --- 11) A generation id is still exposed at the end of all of the above ------
gen="$(sess_field "$A" kernel_generation)"
[ -n "$gen" ] && [ "$gen" != "None" ] || fail "status exposes no kernel_generation (got '$gen')"

echo "RESULT v46 PASS host reboot: stale conn+pid files ignored, output history restored, fresh working kernel ($pidA -> $pidA2) with empty namespace, kernel_lost_state=true reached the client; no false positive for the surviving kernel ($pidS), a new session, a deliberate restart, a kill+reopen, or an interpreter change; a reboot AFTER a deliberate restart is NOT pardoned and gets a new generation ($gen7 -> $genP); the loss survives a later daemon restart"
