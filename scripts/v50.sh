#!/usr/bin/env bash
# v50 — MULTI-CLIENT ON THE SAME FILE (RISKS #4, first half).
#
#       The per-file session model has always been N-clients-per-session on paper
#       (`Session._subs` is a set, `_broadcast` fans out to all of them), but
#       nothing ever ran two clients against ONE session at the same time. Every
#       existing test drives a single client; v9 has a second one only to freeze
#       it. So the claim "two people, or the same person in two windows, can share
#       a live file" was untested — and the failure mode of an untested fan-out is
#       silent divergence, where each client is individually plausible.
#
#       This drives TWO real long-lived websocket subscribers against one session
#       and pins the properties a shared session actually needs:
#
#         1. both clients attach and the daemon counts exactly 2 (`clients` in
#            status) — they are two subscribers, not one connection reused;
#         2. each client's own stream is strictly seq-ordered and duplicate-free;
#         3. in the window both were attached, their event streams are IDENTICAL
#            — same seqs, same kinds, same payloads, same order (asserted as full
#            frame equality, not "both saw the marker");
#         4. a cell submitted over client A's socket is delivered to client B and
#            vice versa (the fan-out itself, in both directions);
#         5. a client leaving does not take the stream with it: A disconnects, a
#            third cell runs, and B — still attached — receives it, while A's
#            transcript proves it was already gone;
#         6. delta replay (`attach --since K`) reproduces exactly what the live
#            client received after K, so a reconnecting third client converges on
#            the same history rather than a second version of it;
#         7. a late client attaching from scratch gets a snapshot holding all
#            three executions.
#
#       Both clients submit at the same barrier on purpose: the daemon's exec
#       queue is the only ordering authority, and whichever order it picks must be
#       the SAME order for every client. That is what assertion 3 pins.
#
# Hermetic: real daemon + real detached kernel + real SQLite journal, no VSCode.
. "$(dirname "$0")/lib.sh"

HERE="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "RESULT v50 FAIL $1"; exit 1; }

S="file:///proj/multi.py"
MARK_A="FROM_CLIENT_A"
MARK_B="FROM_CLIENT_B"
MARK_LATE="AFTER_A_LEFT"

# Client B's cell carries an ipywidget so the session's comm frames land INSIDE the
# two-client comparison, and the post-disconnect cell updates the SAME widget so
# they also land inside the replay comparison (it runs strictly after K). Comm is
# the one path that used to hand-build its wire frame instead of going through
# `event_from_message`, so "live == replay" has to be asserted on it explicitly.
A_CELL="print('$MARK_A')"
B_CELL="$(cat <<PY
import ipywidgets as _W
_wb = _W.IntProgress(value=1, max=10)
display(_wb)
_wb.value = 3
print('$MARK_B')
PY
)"
# The late cell both UPDATES the existing widget and OPENS a second one, so the
# replay window (which starts strictly after K) contains a comm_open as well as a
# comm_msg — otherwise the open could land before K and only the update would be
# covered, depending on which client's cell finished first.
LATE_CELL="$(cat <<PY
_wb.value = 9
_wb2 = _W.IntProgress(value=2, max=10)
display(_wb2)
print('$MARK_LATE')
PY
)"

cleanup() {
  [ -n "${A_PID:-}" ] && kill -9 "$A_PID" 2>/dev/null
  [ -n "${B_PID:-}" ] && kill -9 "$B_PID" 2>/dev/null
  cleanup_procs
  pkill -9 -f "[i]pykernel_launcher.*-f $TITHON_HOME" 2>/dev/null
  return 0
}
trap cleanup EXIT

setup_env v50
start_daemon || fail "daemon start failed"

A_OUT="$TITHON_HOME/client-a.ndjson"
B_OUT="$TITHON_HOME/client-b.ndjson"
R_OUT="$TITHON_HOME/replay.ndjson"
A_READY="$TITHON_HOME/a.ready"
B_READY="$TITHON_HOME/b.ready"
GO="$TITHON_HOME/go"
SOCK="$TITHON_HOME/daemon.sock"

clients_count() { # subscribers currently attached to $S ("" when unreadable)
  timeout 10 "$TITHON" status --session "$S" 2>/dev/null \
    | "$PY" -c 'import json,sys; print(json.load(sys.stdin).get("clients"))' 2>/dev/null
}

await_clients() { # $1 = expected count, $2 = seconds; the daemon drops a
                  # subscriber in its handler's finally, so allow a moment
  local want="$1" secs="$2" n=""
  for _ in $(seq 1 $((secs * 5))); do
    n="$(clients_count)"
    [ "$n" = "$want" ] && return 0
    sleep 0.2
  done
  echo "$n"
  return 1
}

# 1) Two independent subscribers on the SAME session. Neither is warmed up
#    first: they race to lazily create the session, which is itself part of the
#    multi-client path (`_get_session` is lock-guarded).
#    A leaves after both executions complete; B stays for the third.
"$PY" "$HERE/_multi_client.py" --sock "$SOCK" --session "$S" --name client-A \
  --out "$A_OUT" --ready "$A_READY" --go "$GO" \
  --exec "$A_CELL" --until-done 2 --timeout 180 &
A_PID=$!
"$PY" "$HERE/_multi_client.py" --sock "$SOCK" --session "$S" --name client-B \
  --out "$B_OUT" --ready "$B_READY" --go "$GO" \
  --exec "$B_CELL" --until-done 3 --timeout 240 &
B_PID=$!

# 2) Barrier: both attached (includes the kernel spawn on first attach).
for _ in $(seq 1 600); do
  [ -f "$A_READY" ] && [ -f "$B_READY" ] && break
  sleep 0.2
done
[ -f "$A_READY" ] || fail "client A never attached (no sync within 120s)"
[ -f "$B_READY" ] || fail "client B never attached (no sync within 120s)"
echo "v50: both clients attached (sync seq A=$(cat "$A_READY") B=$(cat "$B_READY"))"

# 3) The daemon must see TWO subscribers on this one session. `status` binds the
#    session but does not subscribe, so it does not inflate the count.
n="$(await_clients 2 10)" || fail "daemon reports clients=$n on $S, expected 2 attached subscribers"
echo "v50: daemon reports 2 attached clients on $S"

# 4) Release both clients at once: each submits its own cell over its own socket.
touch "$GO"

wait "$A_PID"; a_rc=$?
[ "$a_rc" -eq 0 ] || fail "client A exited $a_rc (3=timeout 4=daemon error 5=dropped 6=closed early)"
A_PID=""
echo "v50: client A saw both executions complete and disconnected"

# 5) A is gone; B must still be attached and still fed.
n="$(await_clients 1 15)" || fail "after client A left, clients=$n on $S (expected exactly B)"

timeout 120 "$TITHON" run --session "$S" --timeout 90 -c "$LATE_CELL" >/dev/null \
  || fail "the post-disconnect run failed"

wait "$B_PID"; b_rc=$?
[ "$b_rc" -eq 0 ] || fail "client B exited $b_rc — it did not receive the third execution (3=timeout 4=daemon error 5=dropped 6=closed early)"
B_PID=""
echo "v50: client B received the third execution after A had left"

# 6) Delta replay from the middle of the shared window: a third client resuming
#    at K must be handed exactly what the live client got after K.
K="$("$PY" - "$A_OUT" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    m = json.loads(line)
    if m.get("op") == "event" and m.get("kind") == "done":
        print(m["seq"])
        break
else:
    print(0)
PY
)"
[ -n "$K" ] && [ "$K" != "0" ] || fail "could not locate the first completed execution in client A's transcript"
timeout 60 "$TITHON" attach --session "$S" --since "$K" --once >"$R_OUT" \
  || fail "replay attach --since $K failed"
echo "v50: replaying from seq $K ($(wc -l <"$R_OUT") frames)"

# 7) All the cross-client assertions, against the two real transcripts.
"$PY" "$HERE/_check_multi.py" --a "$A_OUT" --b "$B_OUT" --replay "$R_OUT" --since "$K" \
  --marker-a "$MARK_A" --marker-b "$MARK_B" --marker-late "$MARK_LATE" \
  --widget-value 9 || exit 1

# 8) A client joining fresh (no history) must see all three executions.
snap="$(timeout 60 "$TITHON" attach --session "$S" --once)" || fail "fresh snapshot attach failed"
for m in "$MARK_A" "$MARK_B" "$MARK_LATE"; do
  echo "$snap" | grep -q "$m" || fail "the fresh-client snapshot is missing $m"
done
echo "v50: a fresh client's snapshot carries all three executions"

echo "RESULT v50 PASS 2 clients on one session: byte-identical event streams in the shared window, cross-client delivery both ways, survivor keeps streaming after the other leaves, delta replay == live (incl. comm frames as kind=widget, folding to the same widget state), fresh snapshot complete"
