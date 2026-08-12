#!/usr/bin/env bash
# v59 — REAL VSCode training-loop LIVE SYNC: the three output channels of the
#       canonical training cell (three tqdm.notebook bars + an ipywidgets.Output
#       repainted with a matplotlib figure + a `\r` print) must render the SAME
#       instant of kernel time while the cell runs.
#
# The fixture is scripts/baseline.py cell 37 reduced to its protocol essence: it
# emits the per-step message sequence measured in a real run's journal (comm
# update -> stream -> msg_id claim -> clear_output(wait) -> display_data(png) ->
# release), with no torch and no dataset so the loop's pace is deterministic.
#
# Widget state reaches the renderer latest-wins (coalesced postMessage) while
# stream/image output is applied through chained VSCode edits, so a cell-output
# path that cannot keep up shows the bars ahead of the print and the plot. The
# in-host suite samples the live MODEL and the DOCUMENT at one instant and fails
# if the document trails by more than TITHON_MAX_SKEW steps.
#
# Needs network + xvfb (see scripts/v8.sh header for the apt prerequisites);
# run via `make livesync` or `make vscode`.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v59 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v59
FIX="$WORK/trainsync.py"
cat >"$FIX" <<'PY'
# %% setup
import time

import matplotlib.pyplot as plt
import ipywidgets as widgets
from IPython.display import display
from tqdm.notebook import tqdm

get_ipython().run_line_magic("matplotlib", "inline")

STEPS = 30
PERIOD = 0.30


def create_plot():
    losses = []
    plt.ion()  # as in the real notebook: inline must not re-publish the figure at cell end
    fig, ax = plt.subplots(figsize=(6, 2))
    line, = ax.plot(losses)
    ax.set_xlabel("Iteration")
    ax.set_ylabel("Loss")
    ax.set_title("Cross Entropy Loss")
    plot = widgets.Output()
    display(plot)

    def update_plot(new_loss):
        losses.append(new_loss)
        line.set_ydata(losses)
        line.set_xdata(range(len(losses)))
        ax.relim()
        ax.autoscale_view()
        with plot:
            plot.clear_output(wait=True)
            display(fig)

    return update_plot

# %% loop
epochs = tqdm(range(2), desc="Running Epochs")
with (tqdm(total=STEPS, desc="Training") as train_progress,
        tqdm(total=STEPS, desc="Validation") as valid_progress):
    update = create_plot()

    for epoch in epochs:
        train_progress.reset(total=STEPS)
        valid_progress.reset(total=STEPS)
        for i in range(STEPS):
            time.sleep(PERIOD)
            update(1.0 / (i + 1))
            train_progress.update(1)
            print(f"\rstep {i + 1}/{STEPS} epoch {epoch + 1}", end="")
        for _ in range(STEPS):
            valid_progress.update(1)
PY

start_daemon || fail "daemon start failed"
echo "v59: daemon up (pid $(daemon_pid)); launching VSCode training-loop live-sync test under xvfb"

export TITHON_FIXTURE="$FIX"
export TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="trainsync"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -60
summary="$(grep -E '\[trainsync\] SUMMARY' "$OUT" | tail -1 | sed 's/^.*SUMMARY //')"
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "live output trailed the widget path (${summary:-no summary})"
echo "RESULT v59 PASS real VSCode kept print/plot/bars in sync during the loop ($summary); $passed_line"
