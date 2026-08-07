#!/usr/bin/env bash
# v54 — an ipywidgets.Output's clear_output must NOT destroy its SIBLING outputs
# (RISKS #17), over a REAL daemon + kernel.
#
# The reported shape is the most common training-loop notebook there is: a
# tqdm.notebook bar AND a live matplotlib loss plot captured by an Output widget
# in the SAME cell. `Output.clear_output(wait=True)` is published INSIDE the
# widget's msg_id claim (ipywidgets wraps it in `with self:`), so it is scoped to
# that widget — but a fold that clears the whole cell instead wipes the bar. The
# user sees the plot and nothing else, silently, and output a live client already
# rendered is destroyed.
#
# CASE A (the bug): bar + Output-widget plot -> BOTH must survive.
# CASE B (control): bar alone -> the bar survives. Proves CASE A's assertion is
#   not passing for some unrelated reason (e.g. bars never folding at all), and
#   that a regression in CASE A is specific to the redirected clear.
. "$(dirname "$0")/lib.sh"

STEPS=6
fail() { echo "RESULT v54 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

"$PY" -c "import matplotlib, matplotlib_inline, ipywidgets, tqdm" 2>/dev/null \
  || fail "matplotlib/matplotlib_inline/ipywidgets/tqdm missing from daemon venv"

setup_env v54
start_daemon || fail "daemon start failed"
echo "v54: daemon up (pid $(daemon_pid)); workdir=$WORK"

# One cell per case so each gets its own execution/fold.
cat >"$WORK/case_a.py" <<PY
import matplotlib
matplotlib.use("module://matplotlib_inline.backend_inline")
import matplotlib.pyplot as plt
from tqdm.notebook import tqdm
from IPython.display import display
import ipywidgets as widgets

bar = tqdm(total=$STEPS, desc="Training")   # sibling output, emitted FIRST
out = widgets.Output(); display(out)
fig, ax = plt.subplots(figsize=(3, 1.5))
line, = ax.plot([])
for i in range($STEPS):
    line.set_data(range(i + 1), [1.0 / (j + 1) for j in range(i + 1)])
    ax.relim(); ax.autoscale_view()
    with out:                       # ipywidgets claims the cell's msg_id here
        out.clear_output(wait=True) # ... so THIS clear is widget-scoped
        display(fig)
    bar.update(1)
print("CASE_A_DONE")
PY

cat >"$WORK/case_b.py" <<PY
from tqdm.notebook import tqdm
bar = tqdm(total=$STEPS, desc="Training")
for i in range($STEPS):
    bar.update(1)
print("CASE_B_DONE")
PY

for case in a b; do
  timeout 180 "$TITHON" run --timeout 150 -c "exec(open('case_$case.py').read())" \
    >"$TITHON_HOME/run_$case.out" 2>&1 || fail "case $case run failed (rc=$?); $(tail -3 "$TITHON_HOME/run_$case.out")"
  grep -qi "CASE_${case}_DONE" "$TITHON_HOME/run_$case.out" \
    || fail "case $case did not complete: $(tail -3 "$TITHON_HOME/run_$case.out")"
done

DB="$TITHON_HOME/sessions/default/journal.db"

# Read the folded snapshot the daemon persisted — this is exactly what a
# reconnecting client is handed, so asserting here covers live AND restore.
read -r a_widgets a_images a_stream b_widgets < <("$PY" - "$DB" <<'PY'
import json, sqlite3, sys

db = sqlite3.connect(sys.argv[1])
folds = {}
for code, folded in db.execute("SELECT code, folded_json FROM executions ORDER BY seq"):
    case = "a" if "case_a" in code else "b" if "case_b" in code else None
    if case and folded:
        folds[case] = json.loads(folded)

def count(items):
    w = i = s = 0
    for o in items:
        if o.get("output_type") == "stream":
            s += 1
            continue
        for mime in (o.get("data") or {}):
            if mime == "application/vnd.jupyter.widget-view+json":
                w += 1
            elif mime.startswith("image/"):
                i += 1
    return w, i, s

aw, ai, as_ = count(folds.get("a", []))
bw, _, _ = count(folds.get("b", []))
print(aw, ai, as_, bw)
PY
)

echo "v54: CASE A folded -> widget_views=$a_widgets images=$a_images streams=$a_stream | CASE B folded -> widget_views=$b_widgets"

# CASE B first: if the control is broken the CASE A result means nothing.
[ "$b_widgets" -ge 1 ] || fail "control broken: a tqdm.notebook bar alone did not survive its own fold (widget_views=$b_widgets)"

# The bug: the bar (and the Output widget's own view) are wiped by the widget-scoped clear.
[ "$a_widgets" -ge 1 ] || fail "RISKS #17: the Output widget's clear_output destroyed the sibling tqdm bar (widget_views=$a_widgets, expected >=1)"
# The plot must still be there, and the per-step frames must still SUPERSEDE each
# other — artifact GC reclaims exactly what the fold drops, so a fold that kept
# every frame would also keep every PNG. Bounded rather than pinned to 1: the
# inline backend flushes the live figure again at end-of-cell, OUTSIDE the
# widget's claim, which is a legitimate second image.
[ "$a_images" -ge 1 ] || fail "the plot itself was lost (images=$a_images)"
[ "$a_images" -lt "$STEPS" ] || fail "supersession broken: $a_images folded frames for $STEPS steps (artifact GC would grow unbounded)"
[ "$a_stream" -ge 1 ] || fail "the trailing print() was destroyed too (streams=$a_stream)"

echo "RESULT v54 PASS Output-widget clear_output is widget-scoped: sibling bar + 1 folded plot frame + stream all survive (control: bar-alone=$b_widgets)"
