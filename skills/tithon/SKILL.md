---
name: tithon
description: Edit, run, and read Tithon notebooks — `.pynb` files (and percent-format `.py` files with `# %%` cells) whose kernel lives in a persistent daemon. Use whenever a task touches a `.pynb`, a `.tithon/` directory, the `tithon` CLI, or notebook-style experiments (training runs, data exploration) in a project that has Tithon installed.
---

# Tithon notebooks for agents

A Tithon notebook is **plain Python text**. Outputs are kept outside the
source file, and code runs in a persistent kernel owned by a host daemon. The same
kernel is shared with any person who has the file open in VS Code.

What that means in practice:

| Task | How |
| --- | --- |
| Read the code | Read the file as is. |
| Edit a cell | Use a normal text edit (Edit tool, `sed`, `perl -pi`). |
| See results | Run `tithon outputs FILE`. It prints bounded text and lists images as real files. |
| Rerun after a change | Run `tithon run FILE --cells N`. Earlier cells' variables stay loaded. |
| Diff or review | Use an ordinary Python diff. |

**Do not read or edit `.tithon/cells/*.json` directly.** Use the commands below.

## File format

```python
# %% [markdown]
# # Title
# Markdown lines are comments.

# %%
import numpy as np
x = np.arange(10)

# %%
print(x.sum())
```

- `# %%` starts a code cell, and `# %% [markdown]` starts a markdown cell.
- Cells are numbered **from 0 in file order, and markdown cells count**. In the
  example, the markdown cell is 0, `import numpy` is cell 1, and `print` is cell 2.
- Output headers show each cell's line span (`cell 2 lines 8-10`), so you can map a
  result back to the lines to edit.
- `.pynb` and percent-format `.py` behave the same for the CLI.

## 1. Make sure the daemon is running

`tithon run` does **not** start the daemon. Check first:

```sh
tithon status >/dev/null 2>&1 || (nohup tithon daemon >/dev/null 2>&1 &)
```

- If `tithon` is missing, install it with `pip install tithon` (or `uv add tithon`).
- Kernel processes live on after the daemon stops, and a restarted daemon re-attaches
  to them. Restarting the daemon is safe and does not lose kernel state.
- On a cold start, the first run can fail with `kernel did not become ready in time`.
  Run the same command again.

## 2. The edit → run → read loop

```sh
tithon run exp.pynb                  # run all cells, print bounded outputs
tithon run exp.pynb --cells 3        # rerun only the cell you changed
tithon run exp.pynb --cells 2-4,7    # ranges work
tithon run exp.pynb --cells 3 --summary   # one line per cell
```

- Exit code `0` means every selected cell succeeded. `1` means a cell raised, and
  later cells are skipped unless you pass `--keep-going`.
- **Rerun only what changed.** The kernel keeps earlier cells' variables, data, and
  loaded models, so do not rerun expensive setup cells (data loading, model
  construction) after editing a later cell.
- Text outputs keep their last 5 lines by default (tracebacks keep 20) and say how
  many lines were dropped. Use `--tail N`, `--head N`, `--grep REGEX`, or
  `--max-chars N` to change that. Ask for more lines only when you need them.
- `--json` returns the same bounded records as machine-readable JSON.

### Batch several experiments in one tool call

```sh
for lr in 1e-2 1e-3 1e-4; do
  perl -pi -e "s/^lr = .*/lr = $lr/" exp.pynb
  echo "lr=$lr"; tithon run exp.pynb --cells 4-5 --summary
done
```

One shell call runs the whole sweep and returns a few lines per run, so you do not
pay for one call per experiment.

## 3. Read outputs without running anything

```sh
tithon outputs exp.pynb --summary          # status, time, last line of every cell
tithon outputs exp.pynb --errors           # only cells that raised, with traceback tails
tithon outputs exp.pynb --cells 5 --grep "val_loss"
tithon outputs exp.pynb --cells 5 --tail 50
```

- `outputs` never starts a daemon or kernel, and never executes code. Use it to see
  what a person already ran in VS Code before you touch anything.
- It shows cells that are **still running** live (`running [n] | step 2`).
- A cell whose source changed since its last run shows `not run`. You never read a
  result that came from older code, so rerun that cell when you need its output.

## 4. Long-running cells

`tithon run FILE` waits for the cells to finish. For training runs, cap the wait so
your shell call is not killed:

```sh
tithon run train.pynb --cells 6 --timeout 30   # exits with code 3 after 30s; the cell keeps running
tithon outputs train.pynb --cells 6 --tail 3   # check progress later
tithon outputs train.pynb --summary            # `running` turns into `done` or `error`
```

When the client times out or disconnects, execution stops being watched but keeps
running in the daemon. Do not submit the same cell again just because the wait ended.
Poll with `outputs` instead. To stop a cell, use `tithon interrupt --session <uri>`
(`tithon status` lists the session URIs).

## 5. Images and plots

Images are listed as file paths, for example
`image: .tithon/outputs/ab12….png (image/png)`. The path is relative to the project
root (the nearest directory containing `.tithon/`, or the git root). **Open that file
with your image-reading tool to actually see the plot.** It is a real PNG, not
base64 in your context. Widgets such as `tqdm` progress bars are shown as text of
their final state.

## Sharing the kernel with a person

The session for a file is its file URI. **You and a person viewing the file in VS Code
share one kernel.** Their variables are your variables.

- `tithon restart`, `tithon kill`, and `tithon shutdown --kill-kernels` erase live state
  that may have taken hours to build, such as loaded data or trained models. **Do not
  run them unless the user asks.** To get a clean namespace for your own work, use a
  separate `.pynb` file, because each file gets its own kernel.
- Before running anything in a notebook someone else is using, run
  `tithon outputs FILE --summary` to see what is running or already done. Avoid
  queueing work behind a running cell without saying so.
- `.tithon/cells/` and `.tithon/outputs/` hold the shared output state that the
  project may commit. Leave them to the daemon, and do not edit or delete them by hand.

## Quick reference

| Goal | Command |
| --- | --- |
| Check the daemon and list sessions | `tithon status` |
| Run cells | `tithon run FILE [--cells SPEC] [--summary] [--keep-going] [--timeout S]` |
| Read outputs | `tithon outputs FILE [--summary \| --errors] [--cells SPEC] [--tail N] [--grep RE] [--json]` |
| Run a quick snippet in a file's kernel | `tithon run -c 'print(df.shape)' --session <file-uri>` |
| Stop a running cell | `tithon interrupt --session <file-uri>` |
| Full option list | `tithon <command> --help` |
