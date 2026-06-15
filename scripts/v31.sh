#!/usr/bin/env bash
# v31 — live-updating matplotlib loss-plot artifact GC over a REAL daemon+kernel.
#
# Reproduces the exact tunnel-user bug: an ipywidgets.Output container updated
# every step via `with plot: clear_output(wait=True); display(fig)`. ipywidgets 8
# routes the captured figure as a NORMAL iopub display_data (no display_id) + a
# real clear_output(wait), so each frame is a distinct image the artifact store
# would write to .tithon/outputs/ forever. ExecutionFold collapses each
# clear_output(wait)+display_data to the latest frame, so the daemon must GC the
# superseded frame's file. This asserts the output dir stays O(1), not O(steps).
. "$(dirname "$0")/lib.sh"

STEPS=25
fail() { echo "RESULT v31 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

"$PY" -c "import matplotlib, matplotlib_inline, ipywidgets" 2>/dev/null \
  || fail "matplotlib/matplotlib_inline/ipywidgets missing from daemon venv"

setup_env v31
start_daemon || fail "daemon start failed"
echo "v31: daemon up (pid $(daemon_pid)); workdir=$WORK"

# The user's pattern, condensed into one cell so the loop shares one namespace.
cat >"$WORK/loop.py" <<PY
import random
import matplotlib
matplotlib.use("module://matplotlib_inline.backend_inline")
import matplotlib.pyplot as plt
from IPython.display import display
import ipywidgets as widgets

losses = []
plt.ion()
fig, ax = plt.subplots(figsize=(6, 2))
line, = ax.plot(losses)
plot = widgets.Output()
display(plot)

def update(v):
    losses.append(v)
    line.set_ydata(losses); line.set_xdata(range(len(losses)))
    ax.relim(); ax.autoscale_view()
    with plot:
        plot.clear_output(wait=True)
        display(fig)

for i in range($STEPS):
    update(random.random())   # each frame is a visually distinct PNG (new sha)
print("LOOP_DONE", len(losses))
PY

timeout 180 "$TITHON" run --timeout 150 -c "exec(open('loop.py').read())" \
  >"$TITHON_HOME/run.out" 2>&1 || fail "run failed (rc=$?); $(tail -3 "$TITHON_HOME/run.out")"
grep -q "LOOP_DONE $STEPS" "$TITHON_HOME/run.out" || fail "loop did not complete: $(tail -3 "$TITHON_HOME/run.out")"

OUTDIR="$WORK/.tithon/outputs"
nfiles=$(find "$OUTDIR" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')
DB="$TITHON_HOME/sessions/default/journal.db"
nrows=$("$PY" -c "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('SELECT COUNT(*) FROM artifacts').fetchone()[0])" "$DB")

# Every artifact id referenced by a folded snapshot must STILL exist in the
# artifacts table — GC must only drop superseded frames, never a live reference.
read -r ndistinct ndangling < <("$PY" - "$DB" <<'PY'
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
have = {r[0] for r in db.execute("SELECT artifact_id FROM artifacts")}
refs = set()
for (folded,) in db.execute("SELECT folded_json FROM executions WHERE folded_json IS NOT NULL"):
    for o in json.loads(folded):
        for v in (o.get("data") or {}).values():
            ref = v.get("$tithon_artifact") if isinstance(v, dict) else None
            if isinstance(ref, dict):
                refs.add(ref["artifact_id"])
print(len(refs), len(refs - have))
PY
)

echo "v31: ran $STEPS live-plot frames -> outputs/*.png=$nfiles  artifacts_rows=$nrows  distinct_refs=$ndistinct  dangling=$ndangling"

# Without GC: nfiles == nrows == STEPS. With fold-driven GC the superseded frames
# are reclaimed, leaving O(1) (the current frame, possibly one in-flight).
[ "$nfiles" -lt "$STEPS" ] || fail "no GC: $nfiles png files for $STEPS frames (expected O(1))"
[ "$nfiles" -le 2 ] || fail "output dir not O(1): $nfiles png files remain"
[ "$nrows" -le 2 ] || fail "artifact rows not O(1): $nrows rows (deleted file but kept row?)"
[ "$ndistinct" -le 2 ] || fail "snapshot references $ndistinct distinct images (expected O(1))"
[ "$ndangling" -eq 0 ] || fail "$ndangling folded reference(s) point at a GC'd artifact (over-collected)"

echo "RESULT v31 PASS live-plot GC: $STEPS frames -> $nfiles file(s)/$nrows row(s), $ndistinct live image ref(s), 0 dangling (fold-driven supersession GC)"
