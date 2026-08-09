#!/usr/bin/env bash
# v49 — EXECUTION COMPLETION BARRIER (T1): a cell is finished when its shell
#       `execute_reply` AND its iopub `status: idle` have both arrived — not 50ms
#       after the reply.
#
#       `_run_one` used to end every cell with `await asyncio.sleep(0.05)`, a guess
#       that trailing iopub had landed. There is NO ordering guarantee between the
#       shell and iopub sockets, and ipykernel publishes `idle` only after the
#       handler returns — so output emitted between the reply and the idle loses the
#       race whenever it takes longer than the guess. When it lost, the `folded_json`
#       materialized view persisted for that execution was missing output that WAS
#       already in the journal: a reconnecting client's snapshot then disagreed with
#       what a live client had seen, breaking the snapshot+delta equivalence the
#       whole design rests on.
#
#       The race is REPRODUCED here, not waited out: a real ipykernel
#       `post_handler_hook` emits real output after the real `execute_reply` has been
#       sent and before ipykernel publishes its own `idle`. That is protocol
#       perturbation inside the real kernel process — not a mock, and not a sleep
#       added to make the daemon pass.
#
#       T7 (the shell msg_id router) is what delivers the reply here at all; its
#       multiplexing is pinned directly by test/test_barrier.py
#       (`test_concurrent_requests_do_not_steal_each_others_replies`), because the
#       CLI exposes no second shell request to race a running cell with.
# Hermetic: real daemon + real detached kernel + real SQLite journal.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v49 FAIL $1"; exit 1; }

S="file:///proj/barrier.py"
# Longer than the obsolete 50ms grace by a wide margin, short enough to keep the
# script quick. This delay is INSIDE THE KERNEL, reproducing the race; it is not a
# sleep in the daemon or in this script papering over one.
LATE_MS=400

cleanup() {
  cleanup_procs
  pkill -9 -f "[i]pykernel_launcher.*-f $TITHON_HOME" 2>/dev/null
  return 0
}
trap cleanup EXIT

setup_env v49
start_daemon || fail "daemon start failed"

# 1) Install a real post_handler_hook. ipykernel calls it AFTER the handler has sent
#    execute_reply and BEFORE dispatch publishes `status: idle`, so anything printed
#    here is genuinely late output for the cell that just replied.
hook_out="$(timeout 60 "$TITHON" run --session "$S" --timeout 60 -c "$(cat <<'PY'
import sys, time
_k = get_ipython().kernel
_orig = _k.post_handler_hook
ARM = False
def _hook():
    global ARM
    if ARM:
        ARM = False
        time.sleep(0.4)
        print("LATE_OUTPUT_MARKER")
        sys.stdout.flush()
    _orig()
_k.post_handler_hook = _hook
print("HOOK_INSTALLED")
PY
)")" || fail "hook install cell failed"
# Fixture precondition, checked BEFORE the assertions that depend on it: if this
# kernel build has no post_handler_hook to wrap, every later assertion would pass or
# fail for reasons unrelated to the barrier.
echo "$hook_out" | grep -q "HOOK_INSTALLED" \
  || fail "could not install post_handler_hook — the fixture itself is broken: $hook_out"

# 2) The target cell. EARLY_MARKER is ordinary output; LATE_OUTPUT_MARKER is emitted
#    by the hook after this cell's execute_reply has already gone out.
timeout 60 "$TITHON" run --session "$S" --timeout 60 -c "$(cat <<'PY'
ARM = True
print("EARLY_MARKER")
PY
)" >/dev/null || fail "target cell failed"

DB="$(find "$TITHON_HOME/sessions" -name journal.db -newermt '-10 minutes' 2>/dev/null | head -1)"
[ -n "$DB" ] || fail "could not locate the session journal.db under $TITHON_HOME"

# 3) Assert against the REAL journal + the REAL persisted materialized view.
"$PY" - "$DB" <<'PY' || exit 1
import json, sqlite3, sys

db = sqlite3.connect(sys.argv[1])
def die(msg):
    print(f"RESULT v49 FAIL {msg}")
    sys.exit(1)

row = db.execute(
    "SELECT exec_id, folded_json FROM executions WHERE code LIKE '%ARM = True%'"
).fetchone()
if row is None:
    die("target execution not found in the journal")
exec_id, folded = row

msgs = db.execute(
    "SELECT msg_seq, msg_type, content_json FROM messages WHERE exec_id=? ORDER BY msg_seq",
    (exec_id,),
).fetchall()

def seq_of(pred):
    for msg_seq, msg_type, content in msgs:
        if pred(msg_seq, msg_type, json.loads(content)):
            return msg_seq
    return None

late = seq_of(lambda s, t, c: t == "stream" and "LATE_OUTPUT_MARKER" in c.get("text", ""))
early = seq_of(lambda s, t, c: t == "stream" and "EARLY_MARKER" in c.get("text", ""))
idle = seq_of(lambda s, t, c: t == "status" and c.get("execution_state") == "idle")
done = seq_of(lambda s, t, c: t == "tithon.done")

if early is None:
    die("target cell's own output missing from the journal")
# The hook is known installed (checked in the shell before this ran), so the late
# output WILL be published ~400ms after the reply. Its absence here therefore does
# not mean "the race was not reproduced" — it means the execution was declared
# finished, and this journal read reached, before its own output existed. That is
# the barrier failing in its most severe form, so name it as such rather than as a
# fixture problem.
if late is None:
    die("execution completed with its late output nowhere in the journal — "
        "the cell was marked done before the kernel had published everything")
if idle is None:
    die("no iopub idle journaled for the target execution")
if not (early < late < idle):
    die(f"unexpected journal order early={early} late={late} idle={idle}")

# -- the barrier itself. Without it the fold is persisted ~50ms after the reply,
#    i.e. ~350ms before LATE_OUTPUT_MARKER is even published.
if folded is None:
    die("no folded_json persisted for the target execution")
if "LATE_OUTPUT_MARKER" not in folded:
    die("persisted folded_json is MISSING the late output (barrier did not hold)")

# -- the fold must equal a fresh fold of the raw journal, which is exactly what a
#    reconnecting client rebuilds. This is the equivalence invariant, stated directly.
if "EARLY_MARKER" not in folded:
    die("persisted folded_json lost the cell's ordinary output")

# -- tithon.done closes the execution: nothing of that execution may be journaled
#    after it, or a client replaying the delta sees output arrive post-completion.
if done is None:
    die("no tithon.done journaled for the target execution")
if not (idle < done):
    die(f"tithon.done (seq {done}) precedes the idle status (seq {idle})")
if late > done:
    die(f"late output (seq {late}) was journaled AFTER tithon.done (seq {done})")

print(f"v49: order early={early} < late={late} < idle={idle} < done={done}; fold complete")
PY

# 4) Live-vs-replay convergence: a client reconnecting from scratch must be handed
#    the same late output. This reads the daemon's snapshot, not the DB.
snap="$(timeout 30 "$TITHON" attach --session "$S" --once)" || fail "snapshot attach failed"
echo "$snap" | grep -q "LATE_OUTPUT_MARKER" \
  || fail "reconnect snapshot is missing the late output (live != replay)"
echo "$snap" | grep -q "EARLY_MARKER" \
  || fail "reconnect snapshot is missing the cell's ordinary output"

# 5) The barrier must not have broken ordinary execution: the session still runs
#    cells, and a cell with no late output completes without waiting for a timeout.
t0=$(date +%s)
out="$(timeout 60 "$TITHON" run --session "$S" --timeout 60 -c "print(6*7)")" \
  || fail "post-barrier run failed"
t1=$(date +%s)
echo "$out" | grep -q '^42$' || fail "plain cell output wrong: $out"
[ $((t1 - t0)) -lt 10 ] \
  || fail "a plain cell took $((t1 - t0))s — the barrier is falling through to its timeout"

echo "RESULT v49 PASS completion barrier holds: late iopub (reply -> +${LATE_MS}ms -> idle) is in the persisted fold and the reconnect snapshot; journal order early<late<idle<done; plain cells still finish promptly"
