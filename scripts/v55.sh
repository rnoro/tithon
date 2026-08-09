#!/usr/bin/env bash
# v55 — a `display_id` is SESSION-wide, not execution-wide (RISKS #6), over a
# REAL daemon + kernel.
#
# `update_display(..., display_id="tid")` run in cell B must update the output
# cell A created with that id. Before the fix the update was journaled, folded
# and broadcast under B, so A's output kept the stale value forever and B grew a
# duplicate — the same failure a real notebook hits with the "compute in one
# cell, refresh a status line in another" idiom.
#
# Four independent surfaces must agree on the OWNER, because a client can reach
# the state through any one of them:
#   1. the live fold        -> A's folded snapshot holds the NEW value, B stays empty
#   2. the journal          -> the row is the EMITTER's (`exec_id`=B) with a routing
#                              `target_exec`=A; conflating them would corrupt
#                              `orphan_inflight`'s elapsed-time provenance
#   3. the delta replay     -> `attach --since K` reports the update under A, exactly
#                              as a live subscriber saw it (ADR-083)
#   4. a daemon restart     -> `_rebuild_folds` replays the journal into A, not B
#
# CONTROL: a same-cell update (the case that already worked) must still update in
# place — so a green CASE A cannot be an artifact of updates being dropped.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v55 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

setup_env v55
start_daemon || fail "daemon start failed"
echo "v55: daemon up (pid $(daemon_pid)); workdir=$WORK"

DB="$TITHON_HOME/sessions/default/journal.db"
q() { "$PY" -c "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone()[0])" "$DB" "$1"; }

# --- cell A: create the display, and (control) update it from its OWN cell ----
timeout 120 "$TITHON" run --timeout 100 -c \
  'from IPython.display import display, update_display
display("v0", display_id="tid")
display("same-cell-v0", display_id="own")
update_display("same-cell-v1", display_id="own")
print("CELL_A_DONE")' >"$TITHON_HOME/a.out" 2>&1 \
  || fail "cell A failed (rc=$?); $(tail -3 "$TITHON_HOME/a.out")"
grep -q CELL_A_DONE "$TITHON_HOME/a.out" || fail "cell A did not complete"

K="$(q 'SELECT COALESCE(MAX(msg_seq),0) FROM messages')"
echo "v55: cell A done; journal seq now $K"

# --- cell B: update A's display from a DIFFERENT execution -------------------
timeout 120 "$TITHON" run --timeout 100 -c \
  'from IPython.display import update_display
update_display("v1", display_id="tid")
print("CELL_B_DONE")' >"$TITHON_HOME/b.out" 2>&1 \
  || fail "cell B failed (rc=$?); $(tail -3 "$TITHON_HOME/b.out")"
grep -q CELL_B_DONE "$TITHON_HOME/b.out" || fail "cell B did not complete"

# --- 3. delta replay: the wire event must name A, not B ----------------------
# Captured BEFORE the daemon restart so it exercises the LIVE daemon's replay.
timeout 30 "$TITHON" attach --since "$K" --once >"$TITHON_HOME/delta.ndjson" 2>&1 \
  || fail "attach --since $K failed"

read -r a_exec b_exec a_text b_items row_exec row_target replay_exec ctrl_items ctrl_text \
  < <("$PY" - "$DB" "$TITHON_HOME/delta.ndjson" <<'PY'
import json, sqlite3, sys

db = sqlite3.connect(sys.argv[1])
execs = {}
for exec_id, code, folded in db.execute("SELECT exec_id, code, folded_json FROM executions ORDER BY seq"):
    cell = "a" if "CELL_A_DONE" in code else "b" if "CELL_B_DONE" in code else None
    if cell:
        execs[cell] = (exec_id, json.loads(folded) if folded else [])

a_exec, a_out = execs["a"]
b_exec, b_out = execs["b"]

def plain(items, did):
    for o in items:
        if o.get("display_id") == did:
            # `display("v1")` renders text/plain as the repr — strip the quotes.
            return ((o.get("data") or {}).get("text/plain", "?")).strip("'\"")
    return "MISSING"

def displays(items):  # display outputs only; the cells also print a marker line
    return [o for o in items if o.get("output_type") == "display_data"]

# 2. the journal row: emitter vs routing target
row = db.execute(
    "SELECT exec_id, target_exec FROM messages"
    " WHERE msg_type='update_display_data' AND content_json LIKE '%\"tid\"%'"
).fetchone() or ("NONE", "NONE")

# 3. the delta replay's wire exec_id for that same update
replay_exec = "NONE"
with open(sys.argv[2]) as f:
    for line in f:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        p = m.get("payload") or {}
        if p.get("msg_type") == "update_display_data" and \
                ((p.get("content") or {}).get("transient") or {}).get("display_id") == "tid":
            replay_exec = m.get("exec_id") or "NULL"

print(a_exec, b_exec, plain(a_out, "tid"), len(displays(b_out)), row[0], row[1] or "NULL",
      replay_exec, len(displays(a_out)), plain(a_out, "own"))
PY
)

echo "v55: A=$a_exec B=$b_exec | A.tid='$a_text' A.displays=$ctrl_items A.own='$ctrl_text' | B.displays=$b_items"
echo "v55: journal row exec_id=$row_exec target_exec=$row_target | replay exec_id=$replay_exec"

# 1. the live fold
[ "$a_text" = "v1" ] || fail "cell A's display was not updated by cell B (got '$a_text', expected 'v1')"
[ "$b_items" -eq 0 ] || fail "cell B grew $b_items display output(s) — the update was appended to the emitter, not routed to the owner"
# CONTROL: same-cell update still replaces in place (2 displays in A: 'tid' + 'own').
[ "$ctrl_text" = "same-cell-v1" ] || fail "control broken: a SAME-cell update_display no longer updates in place (got '$ctrl_text')"
[ "$ctrl_items" -eq 2 ] || fail "control broken: cell A should hold exactly 2 display items, got $ctrl_items"

# 2. the journal keeps the emitter, and names the owner separately
[ "$row_exec" = "$b_exec" ] || fail "the update row must stay attributed to its EMITTER B (exec_id=$row_exec)"
[ "$row_target" = "$a_exec" ] || fail "the update row must carry target_exec=A (got $row_target)"

# 3. live == replay
[ "$replay_exec" = "$a_exec" ] || fail "delta replay reported the update under $replay_exec, not the owner A ($a_exec)"

# --- 4. a daemon restart must rebuild the same routing ----------------------
dp="$(daemon_pid)"
kill "$dp" 2>/dev/null
for _ in $(seq 1 50); do kill -0 "$dp" 2>/dev/null || break; sleep 0.2; done
start_daemon || fail "daemon restart failed"
timeout 30 "$TITHON" status --session default >/dev/null 2>&1 \
  || fail "session did not re-attach after the daemon restart"

# The snapshot is served from the REBUILT in-memory folds, so this reads what
# `_rebuild_folds` produced — not the cached folded_json column.
timeout 30 "$TITHON" attach --since 0 --once >"$TITHON_HOME/snap.ndjson" 2>&1 \
  || fail "post-restart snapshot attach failed"
rebuilt="$("$PY" - "$TITHON_HOME/snap.ndjson" "$a_exec" <<'PY'
import json, sys
want = sys.argv[2]
for line in open(sys.argv[1]):
    try:
        m = json.loads(line)
    except ValueError:
        continue
    if m.get("op") != "snapshot":
        continue
    for e in m.get("executions", []):
        if e.get("exec_id") == want:
            for o in e.get("outputs", []):
                if o.get("display_id") == "tid":
                    print(((o.get("data") or {}).get("text/plain", "?")).strip("'\""))
                    sys.exit(0)
print("MISSING")
PY
)"
echo "v55: after daemon restart -> A.tid='$rebuilt'"
[ "$rebuilt" = "v1" ] || fail "the rebuilt fold lost the cross-cell update (got '$rebuilt')"

echo "RESULT v55 PASS session-wide display_id: cell B's update lands in cell A live, on the wire (replay exec_id=A), in the journal (exec_id=B target_exec=A) and after a daemon restart; same-cell control intact"
