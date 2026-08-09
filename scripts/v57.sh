#!/usr/bin/env bash
# v57 — an accepted, running execution keeps journaling after a daemon SIGKILL.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v57 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

setup_env v57
start_daemon || fail "daemon start failed"

CODE='import time
for i in range(24):
    print(f"RECOVER_STEP {i}", flush=True)
    time.sleep(0.35)'

"$PY" - "$TITHON_HOME/daemon.sock" "$CODE" <<'PY' || fail "submission failed"
import asyncio, json, sys
from websockets.asyncio.client import unix_connect

async def main():
    async with unix_connect(sys.argv[1], uri="ws://localhost") as ws:
        await ws.send(json.dumps({"op": "attach", "last_seen_seq": -1, "session": "default"}))
        while json.loads(await ws.recv()).get("op") != "sync":
            pass
        await ws.send(json.dumps({
            "op": "execute", "session": "default", "code": sys.argv[2],
            "allow_stdin": True,
        }))
        while json.loads(await ws.recv()).get("op") != "execute_ack":
            pass

asyncio.run(main())
PY
DB="$TITHON_HOME/sessions/default/journal.db"

pre=-1
for _ in $(seq 1 150); do
  pre="$($PY - "$DB" <<'PY' 2>/dev/null || true
import json, re, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
vals = []
for (raw,) in db.execute("SELECT content_json FROM messages WHERE msg_type='stream'"):
    vals += [int(x) for x in re.findall(r"RECOVER_STEP (\d+)", json.loads(raw).get("text", ""))]
print(max(vals, default=-1))
PY
)"
  [ "${pre:--1}" -ge 4 ] && break
  sleep 0.1
done
[ "${pre:--1}" -ge 4 ] || fail "execution never reached accepted streaming state"

read -r accepted msg_id cutoff <<EOF
$($PY - "$DB" <<'PY'
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
row = db.execute("SELECT exec_id, kernel_msg_id FROM executions WHERE status='running'").fetchone()
busy = False
if row:
    busy = any(json.loads(c).get("execution_state") == "busy" for (c,) in db.execute(
        "SELECT content_json FROM messages WHERE exec_id=? AND msg_type='status'", (row[0],)))
print(int(bool(row and row[1] and busy)), row[1] if row else "NONE",
      db.execute("SELECT COALESCE(MAX(msg_seq),0) FROM messages").fetchone()[0])
PY
)
EOF
[ "$accepted" = 1 ] || fail "precondition missing durable msg_id + old-parent busy"

dpid1="$(daemon_pid)"
kpid1="$(status_field kernel_pid)" || fail "pre-kill status failed"
kill -9 "$dpid1" || fail "daemon SIGKILL failed"
for _ in $(seq 1 50); do kill -0 "$dpid1" 2>/dev/null || break; sleep 0.1; done
kill -0 "$dpid1" 2>/dev/null && fail "old daemon still alive"

start_daemon || fail "daemon restart failed"
kpid2="$(status_field kernel_pid)" || fail "re-attach status failed"
[ "$kpid1" = "$kpid2" ] || fail "kernel changed across daemon restart: $kpid1 -> $kpid2"
[ "$(status_field kernel_reattached)" = True ] || fail "new daemon did not re-attach"

timeout 45 "$TITHON" attach --since "$cutoff" --until-done >"$TITHON_HOME/delta.ndjson" \
  || fail "delta attach did not observe recovered terminal event"
read -r status count post ordered post_delta done_delta <<EOF
$($PY - "$DB" "$TITHON_HOME/delta.ndjson" "$pre" <<'PY'
import json, re, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
row = db.execute("SELECT status, execution_count FROM executions ORDER BY seq LIMIT 1").fetchone()
vals = []
for (raw,) in db.execute("SELECT content_json FROM messages WHERE msg_type='stream' ORDER BY msg_seq"):
    vals += [int(x) for x in re.findall(r"RECOVER_STEP (\d+)", json.loads(raw).get("text", ""))]
delta_vals, done = [], False
for line in open(sys.argv[2]):
    ev = json.loads(line)
    if ev.get("kind") == "output":
        delta_vals += [int(x) for x in re.findall(r"RECOVER_STEP (\d+)", ev.get("payload", {}).get("content", {}).get("text", ""))]
    done |= ev.get("kind") == "done" and ev.get("payload", {}).get("status") == "orphaned"
ordered = vals == sorted(set(vals))
print(row[0], "NULL" if row[1] is None else row[1], max(vals, default=-1),
      int(ordered), int(any(v > int(sys.argv[3]) for v in delta_vals)), int(done))
PY
)
EOF
[ "$status" = orphaned ] || fail "recovered execution status is $status, expected orphaned"
[ "$count" = NULL ] || fail "unavailable execute_reply count was invented: $count"
[ "$post" -gt $((pre + 3)) ] || fail "journal did not resume: pre=$pre post=$post"
[ "$ordered" = 1 ] || fail "journal contains duplicate/reordered numbered output"
[ "$post_delta" = 1 ] || fail "delta contains no post-restart output"
[ "$done_delta" = 1 ] || fail "delta contains no honest orphaned terminal event"

snap="$(timeout 20 "$TITHON" attach --once)" || fail "fresh snapshot failed"
echo "$snap" | grep -q "RECOVER_STEP $post" || fail "fresh snapshot lacks recovered suffix"
after="$(timeout 20 "$TITHON" run -c 'print("AFTER_RECOVERY")')" || fail "next cell stayed gated"
[ "$after" = AFTER_RECOVERY ] || fail "next cell output mismatch: $after"

echo "RESULT v57 PASS daemon $dpid1 died; kernel $kpid1 survived; accepted msg $msg_id resumed $pre->$post, terminalized orphaned/count=NULL, delta+snapshot+next-cell gate verified"
