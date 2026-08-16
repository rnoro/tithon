#!/usr/bin/env bash
# v62 — a session the user CLOSED is not re-seeded on open (ADR-114), over a
# REAL daemon+kernel.
#
# Restoring a file's cells is what makes a crash, a reboot, an idle-GC reap or a
# dropped tunnel invisible — the whole premise of Tithon. Replaying those same
# outputs after the user deliberately terminated the kernel is the opposite: it
# hands back state they walked away from, on that open and on every open after.
# The daemon records the intent in the journal (so it outlives the daemon that
# observed it) and reports it in the attach snapshot.
#
# Withheld, NOT deleted: the executions must still be in the snapshot, or the
# "Restore Previous Outputs" command would have nothing to restore.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v62 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

setup_env v62
PROJ="$TITHON_HOME/proj"; mkdir -p "$PROJ"
start_daemon || fail "daemon start failed"
echo "v62: daemon up (pid $(daemon_pid))"

SOCK="$TITHON_HOME/daemon.sock"
URI="file://$PROJ/train.py"
probe() {  # attach-only; prints EXECS/CLOSED_BY_USER/STREAM_TEXT
  timeout 120 "$PY" "$ROOT/scripts/_clone_client.py" "$SOCK" "$URI" "$PROJ" >"$1" 2>&1 \
    || fail "attach probe failed: $(tail -5 "$1")"
}
kv() { grep "^$2=" "$1" | head -1 | cut -d= -f2-; }

# --- a normal run: restore stays armed ---------------------------------------
timeout 150 "$PY" "$ROOT/scripts/_workdir_client.py" "$SOCK" "$URI" "$PROJ" 'print("FIRST")' \
  >"$TITHON_HOME/run1.out" 2>&1 || fail "first run failed"
grep -q "DONE ok" "$TITHON_HOME/run1.out" || fail "first run did not finish ok"
probe "$TITHON_HOME/p1.out"
[ "$(kv "$TITHON_HOME/p1.out" EXECS)" = "1" ] || fail "run not journaled"
[ "$(kv "$TITHON_HOME/p1.out" CLOSED_BY_USER)" = "False" ] \
  || fail "a plain run must leave restore armed (got $(kv "$TITHON_HOME/p1.out" CLOSED_BY_USER))"
echo "v62: after a run  closed_by_user=False execs=1"

# --- the user terminates the kernel on purpose -------------------------------
timeout 60 "$TITHON" kill --session "$URI" >"$TITHON_HOME/kill.out" 2>&1 \
  || fail "kill failed: $(tail -3 "$TITHON_HOME/kill.out")"
probe "$TITHON_HOME/p2.out"
[ "$(kv "$TITHON_HOME/p2.out" CLOSED_BY_USER)" = "True" ] \
  || fail "a deliberate kill must disarm restore (got $(kv "$TITHON_HOME/p2.out" CLOSED_BY_USER))"
# Withheld from the seed, not deleted.
[ "$(kv "$TITHON_HOME/p2.out" EXECS)" = "1" ] \
  || fail "the closed session lost its history ($(kv "$TITHON_HOME/p2.out" EXECS) execs)"
[ "$(kv "$TITHON_HOME/p2.out" STREAM_TEXT)" = "FIRST" ] \
  || fail "the withheld output is not intact ('$(kv "$TITHON_HOME/p2.out" STREAM_TEXT)')"
echo "v62: after kill   closed_by_user=True  execs=1 (history intact)"

# The flag lives in the journal, so it must survive the daemon that saw the kill.
# A plain shutdown (kernels stay detached) — the flag must not be confused with
# kernel liveness, which this restart deliberately leaves untouched.
timeout 60 "$TITHON" shutdown >/dev/null 2>&1 || true
for _ in $(seq 1 60); do [ -S "$SOCK" ] || break; sleep 0.2; done
[ -S "$SOCK" ] && fail "daemon did not shut down"
start_daemon || fail "daemon restart failed"
probe "$TITHON_HOME/p3.out"
[ "$(kv "$TITHON_HOME/p3.out" CLOSED_BY_USER)" = "True" ] \
  || fail "the closed flag did not survive a daemon restart"
echo "v62: after daemon restart  closed_by_user=True (persisted in the journal)"

# --- running a cell re-arms restore ------------------------------------------
timeout 150 "$PY" "$ROOT/scripts/_workdir_client.py" "$SOCK" "$URI" "$PROJ" 'print("SECOND")' \
  >"$TITHON_HOME/run2.out" 2>&1 || fail "second run failed"
grep -q "DONE ok" "$TITHON_HOME/run2.out" || fail "second run did not finish ok"
probe "$TITHON_HOME/p4.out"
[ "$(kv "$TITHON_HOME/p4.out" CLOSED_BY_USER)" = "False" ] \
  || fail "running a cell must re-arm restore (got $(kv "$TITHON_HOME/p4.out" CLOSED_BY_USER))"
[ "$(kv "$TITHON_HOME/p4.out" EXECS)" = "2" ] \
  || fail "expected 2 executions after the second run, got $(kv "$TITHON_HOME/p4.out" EXECS)"
echo "v62: after new run closed_by_user=False execs=2"

echo "RESULT v62 PASS deliberate kill disarms restore (persisted across a daemon restart) while keeping the history; a new run re-arms it"
