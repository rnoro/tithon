#!/usr/bin/env bash
# v34 — a user clear is DURABLE over a REAL daemon+kernel.
#
# Bug: clearing a cell's output only cleared the client; the daemon's folded
# snapshot kept it, so the next attach re-seeded the output and the cleared
# output reappeared (not what the user asked for). Fix (SPEC.md append-only):
# the clear_output op appends a synthetic clear_output(wait=False) tombstone —
# no journal rows deleted — so the fold empties, a fresh attach does NOT restore
# the output, the cached folded_json is re-materialized to [], and the freed
# image artifact is GC'd. This asserts all of that AND that the originals (the
# raw display_data + the tombstone) are preserved in the journal.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v34 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

"$PY" -c "import matplotlib, matplotlib_inline" 2>/dev/null \
  || fail "matplotlib/matplotlib_inline missing from daemon venv"

setup_env v34
start_daemon || fail "daemon start failed"
echo "v34: daemon up (pid $(daemon_pid)); workdir=$WORK"

cat >"$WORK/cell.py" <<PY
import matplotlib
matplotlib.use("module://matplotlib_inline.backend_inline")
import matplotlib.pyplot as plt
from IPython.display import display
print("hello from the cell")
fig, ax = plt.subplots(figsize=(3, 2))
ax.plot([1, 2, 3], [1, 4, 9])
display(fig)            # -> a real image artifact under .tithon/outputs/
print("done")
PY

timeout 120 "$TITHON" run --timeout 100 -c "exec(open('cell.py').read())" \
  >"$TITHON_HOME/run.out" 2>&1 || fail "run failed (rc=$?); $(tail -3 "$TITHON_HOME/run.out")"

OUTDIR="$WORK/.tithon/outputs"
DB="$TITHON_HOME/sessions/default/journal.db"
count_folded() { # sum of folded output items across executions
  "$PY" - "$DB" <<'PY'
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
n = 0
for (f,) in db.execute("SELECT folded_json FROM executions WHERE folded_json IS NOT NULL"):
    n += len(json.loads(f))
print(n)
PY
}
count_msg() { # messages of a given msg_type
  "$PY" -c "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('SELECT COUNT(*) FROM messages WHERE msg_type=?',(sys.argv[2],)).fetchone()[0])" "$DB" "$1"
}
count_art() {
  "$PY" -c "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('SELECT COUNT(*) FROM artifacts').fetchone()[0])" "$DB"
}

png_before=$(find "$OUTDIR" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')
folded_before=$(count_folded)
echo "v34: before clear -> png=$png_before folded_outputs=$folded_before"
[ "$png_before" -ge 1 ] || fail "expected an image artifact before clear (got $png_before)"
[ "$folded_before" -ge 1 ] || fail "expected folded output before clear (got $folded_before)"

# Drive the clear op, then assert a brand-new attach does not restore the output.
"$PY" "$ROOT/scripts/_clear_client.py" "$TITHON_HOME/daemon.sock" >"$TITHON_HOME/clear.out" 2>&1 \
  || fail "clear client failed; $(tail -5 "$TITHON_HOME/clear.out")"
cat "$TITHON_HOME/clear.out"
cleared=$(grep -oE "CLEARED [0-9]+" "$TITHON_HOME/clear.out" | grep -oE "[0-9]+" | head -1)
after=$(grep -oE "AFTER outputs=[0-9]+" "$TITHON_HOME/clear.out" | grep -oE "[0-9]+" | head -1)

png_after=$(find "$OUTDIR" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')
folded_after=$(count_folded)
art_rows=$(count_art)
tombstones=$(count_msg clear_output)
originals=$(count_msg display_data)

echo "v34: after clear -> cleared=$cleared resync_outputs=$after png=$png_after folded=$folded_after art_rows=$art_rows tombstones=$tombstones display_data_msgs=$originals"

[ "${cleared:-0}" -ge 1 ] || fail "clear op reported 0 cleared"
[ "${after:-1}" -eq 0 ] || fail "resync restored $after output(s) after a user clear (the bug)"
[ "$folded_after" -eq 0 ] || fail "cached folded snapshot still holds $folded_after output(s)"
[ "$png_after" -eq 0 ] || fail "cleared image not GC'd: $png_after png file(s) remain"
[ "$art_rows" -eq 0 ] || fail "artifact row not GC'd: $art_rows row(s) remain"
[ "$tombstones" -ge 1 ] || fail "no clear_output tombstone journaled"
[ "$originals" -ge 1 ] || fail "original display_data message deleted (journal not append-only)"

echo "RESULT v34 PASS user clear durable: resync_outputs=0, image GC'd ($png_before->0 png), tombstone kept + original display_data preserved (append-only)"
