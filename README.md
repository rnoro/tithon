<h1 align="center">Tithon</h1>

<p align="center">
  <strong>Your Jupyter kernel dies with your client. It shouldn't.</strong>
</p>

<p align="center">
  <a href="https://pypi.org/project/tithon/"><img src="https://img.shields.io/pypi/v/tithon?logo=pypi&amp;logoColor=white" alt="PyPI"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=rnoro.tithon"><img src="https://img.shields.io/visual-studio-marketplace/v/rnoro.tithon?logo=visualstudiocode&amp;logoColor=white&amp;label=VS%20Code" alt="VS Code Marketplace"></a>
  <a href="https://pypi.org/project/tithon/"><img src="https://img.shields.io/pypi/pyversions/tithon" alt="Python"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
</p>

![A real VS Code recording shows Tithon surviving a daemon crash: connection loss and reconnection are highlighted, then the same remote kernel resumes live output synchronization without restarting the cell.](https://raw.githubusercontent.com/rnoro/tithon/main/docs/demo.gif)

Keep a Jupyter kernel—and its output—alive independently of the client. Close your editor, lose your connection, or return later; the same session is still there and still streaming.

> **Status: alpha.** It works and it's in daily use, but you will hit rough
> edges. Bug reports are genuinely useful — please [open an issue][issues].

## The problem

You SSH into a GPU box, start a long run in a notebook, and close your laptop.
When you come back, depending on your setup:

- **JupyterLab** reconnects, but everything printed while you were away is gone.
  iopub output is streamed over the WebSocket and never persisted server-side,
  so there is nothing to replay.
- **VSCode Jupyter** ties the kernel to the extension-host process. Close the
  window or drop the network and the kernel dies, taking the session with it.
- **`tmux` + `jupyter console`** survives the disconnect, but you lose rich
  output (plots, HTML, widgets) and you can't open the same session from a
  second client.

The root cause is the same in all three: the source of truth for your session
lives on the client, or in a channel that doesn't outlive a disconnect. Tithon
moves it to the host.

> [!TIP]
> And in the era of AI agents, one more: a `.ipynb` is JSON bloat — the same
> notebook is ~250 lines of `"cell_type"`/`"outputs"` noise that Tithon keeps as
> ~50 lines of clean `.py`. Output images? Tithon keeps them as real files, so an
> agent hands them to the model as actual images it can _see_ — not base64 the
> model burns thousands of tokens on and still can't read. **Don't feed your AI
> idiot JSON.**

## Requirements

- **Python 3.11+** for the daemon and CLI.
- A Unix-like host — the daemon uses unix domain sockets and `setsid` (developed
  and tested on Linux).
- For the notebook UI, **VSCode** with the Tithon extension. If the host is
  remote, connect over a Tunnel or Remote-SSH — the notebook then works exactly
  as it does locally.

> On Windows, we recommend running Tithon inside WSL and connecting with VS Code using the WSL extension.  
> Native Windows is not currently supported.

## Install

The CLI ships on PyPI:

```bash
pip install tithon      # or: uv add tithon
```

The VSCode extension is on the Marketplace:

```bash
code --install-extension rnoro.tithon
```

or search for "tithon" in the Extensions view. ([Marketplace page][marketplace])

## Quickstart (CLI)

Daemon state — socket, log, kernel connection files, and per-session journals —
lives under `TITHON_HOME` (default `~/.tithon`); rich-output artifacts and
shared cell snapshots live under `<workdir>/.tithon/`.

Start the daemon. It runs in the foreground, so background it:

```bash
tithon daemon &
tail -f ~/.tithon/daemon.log     # optional
```

Run some code. Kernel state persists across calls:

```bash
tithon run -c 'x = 41'
tithon run -c 'x += 1; print(x)'     # -> 42
tithon status
```

Now prove the point — kill the daemon, and the kernel lives on:

```bash
tithon run -c 'for i in range(3): print("line", i)'

pkill -9 -f 'tithon daemon'          # the daemon dies; the kernel does not
tithon daemon &                      # restart -> re-attaches the same kernel

tithon attach --since 0 --once       # full snapshot: the earlier output is back
tithon run -c 'print(x)'             # -> 42, kernel state intact
```

## VSCode extension

A **Python Notebook** (`.pynb`) opens directly in the notebook editor. Its disk
format is readable percent-format Python (`# %%` cells); outputs and metadata
live separately under `.tithon/`, and execution lives in the persistent daemon.

1. Run **Tithon: New Python Notebook…** to create a saved `.pynb`, or open one.
2. Pick the **Tithon** kernel and run cells as usual.

Existing `.py` scripts still open as text by default. **Open as Notebook** keeps
the optional cell view; **Copy as Python Notebook…** creates a separate `.pynb`
with the saved source, current outputs and notebook metadata. Copying saves dirty
source first, refuses running/queued work and existing destinations, and stays
inside one project. It preserves the original file and creates a new URI/session:
**live variables, imported modules and full execution history do not migrate**.
Images are copied independently so rerunning one file cannot delete the other's
saved images. If the source has saved local session history, open it first so the
daemon can restore its authoritative outputs; wait for any unfinished work to recover before
copying. A deliberately terminated source copies no retired outputs or widgets.

**Import Jupyter Notebook…** defaults to `.pynb`; **Export to Jupyter Notebook…**
accepts `.pynb` and existing `.py`. **Export Python Script…** makes a separate
percent `.py` copy with saved outputs/metadata. Existing output/session history at
a destination also prevents copying, even if its source file was deleted.

That's all. Selecting the kernel attaches the session automatically; output is
journaled on the host, and when you reopen the notebook later — VSCode remembers
the kernel — it is restored and resumes streaming with no command. Over a VSCode
**Tunnel** or **Remote-SSH** this is identical: the extension host runs on the
remote, so it talks to the daemon's host-local socket directly, with no port
forwarding. Nothing special for the remote case.

> [!NOTE]
> The daemon and the extension must run on the **same host** (they share
> `TITHON_HOME`, default `~/.tithon`). A Tunnel/Remote-SSH satisfies this for
> free. If you instead run the extension on your laptop against a _remote_
> daemon, forward the unix socket yourself (SSH `RemoteForward`, `socat`, …).

## How it works

A long-lived **daemon** on the host owns the kernel and serves clients:

![Tithon architecture overview: a detached ipykernel connected to the tithon daemon over ZMQ. The daemon journals every message verbatim to SQLite/WAL, folds it into a current-display snapshot plus an ipywidgets state mirror, stores rich outputs as files referenced by hash, and serves VSCode and CLI clients over a 0600 unix socket — no TCP.](https://raw.githubusercontent.com/rnoro/tithon/main/docs/how-it-works.png)

- The kernel runs **detached** (`setsid`), so it is not a child of the daemon.
  The daemon can crash, restart, or be upgraded; the kernel keeps running and
  re-attaches through a persisted connection file.
- Every execution iopub message (plus daemon lifecycle and widget comm events) is
  journaled to append-only SQLite (WAL) by default, alongside a per-execution
  _folded_ snapshot — the current display state — so reconnects are fast.
- Clients attach with the last sequence number they saw and get a snapshot plus
  an ordered, gapless delta stream; reconnecting is just resuming the stream.
- Rich outputs (images) are stored as files and referenced by hash, never
  base64-embedded, and `ipywidgets` traffic is folded into a `widget-state+json`
  snapshot, so a `tqdm` bar or a slider comes back at its real value.
- Backpressure is bounded: per-subscriber buffers are capped, and a client that
  falls too far behind is dropped and resyncs on reconnect — so one slow client
  can't grow daemon memory or block the others.
- The daemon binds a `0600` unix domain socket. No TCP.

The kernel itself is plain `ipykernel` — Tithon replaces the session-management
layer around it, not the execution engine. See [`docs/SPEC.md`](docs/SPEC.md)
for the full design.

## CLI reference

| Command                     | Description                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tithon daemon`             | Run the daemon (foreground). Supports `--log-level`, `--idle-timeout`, `--history-retention-days`, and `--history-target-mib`.                      |
| `tithon run -c CODE`        | Submit code and stream its output (`--session <uri>`, `--no-wait` to print the exec id and exit, `--timeout N` to bound the wait).                  |
| `tithon run FILE`           | Run a notebook file's cells (`--cells 1,3-4`, default all) in its persistent kernel and print their bounded outputs; exit 1 if a cell raised.      |
| `tithon outputs FILE`       | Print a notebook file's current outputs, bounded for agents (`--cells`, `--errors`, `--summary`, `--tail/--head N`, `--grep RE`, `--json`).        |
| `tithon import SRC DEST`    | Import a Python nbformat 4 `.ipynb` as percent source (`.pynb` or `.py`) plus saved outputs and metadata (`--workdir PROJECT`).                     |
| `tithon copy SRC DEST`      | Copy percent source, current outputs, and metadata into an independent file session within one project (`--workdir PROJECT`).                       |
| `tithon export SRC DEST`    | Export saved source plus current/saved outputs as a Python nbformat 4 `.ipynb` without executing code (`--workdir PROJECT`).                        |
| `tithon attach`             | Stream events as NDJSON (`--session <uri>`, `--since N` resume point, `--once` exit after backlog sync, `--until-done` exit after next completion). |
| `tithon status`             | Print daemon, session, queue, kernel, widget-model, and storage status (all sessions, or one with `--session <uri>`).                               |
| `tithon restart`            | Restart a session's kernel with a fresh namespace (`--session <uri>`, default `default`).                                                           |
| `tithon interrupt`          | Send SIGINT to the running cell of a session (`--session <uri>`, default `default`).                                                                |
| `tithon kill`               | Terminate one session's kernel (`--session <uri>`) or all running kernels (`--all`); journals are kept.                                             |
| `tithon shutdown`           | Stop the daemon; kernels stay detached unless `--kill-kernels` is passed.                                                                           |
| `tithon version`            | Print the installed `tithon` package version.                                                                                                       |

`attach --since` is the reconnect knob:

- `--since 0` — full folded snapshot, then live delta.
- `--since N` — replay only events after seq `N`, then a `sync` marker, then live.
- `--since -1` — live only, ignore history.

### For coding agents

An agent that edits a notebook's research code needs a few lines of output per
iteration, not the whole notebook. `tithon run` and `tithon outputs` give it
exactly that, from the same persistent kernel a person sees in VSCode:

```sh
tithon run exp/train.pynb --cells 2-4      # rerun only what changed, print bounded outputs
tithon outputs exp/train.pynb --summary    # one line per cell: status, time, last line
tithon outputs exp/train.pynb --errors     # just the cells that raised, traceback tail
tithon outputs exp/train.pynb --cells 2 --grep "val_loss"
```

Cells are numbered as in the file (markdown cells count), and each header shows
the cell's line span for editing. Each text output keeps its last 5 lines by
default (a traceback 20) and says how many it dropped. Images are listed as file paths under
`.tithon/outputs/`, and widgets as text of their final state. `outputs` never
starts a daemon or a kernel: it reads the running daemon (live, including cells
still running) or the shared output file. An edited cell shows no output until
it runs again, so an agent never reads a result produced by older code.

The two commands are built for loops: `--summary` prints one line per cell,
and several edit-and-run steps fit in one shell command (see `tithon run --help`),
so an agent pays for one tool call instead of one per experiment.

## Configuration

Environment variables read by the daemon and CLI:

| Variable                        | Default     | Purpose                                                                                 |
| ------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `TITHON_HOME`                   | `~/.tithon` | Root for the socket, daemon log, kernel connection files, and per-session journals.     |
| `TITHON_KERNEL_IDLE_TIMEOUT`    | `0`         | Seconds of inactivity before an unattached idle kernel is reaped (`0` = disabled).      |
| `TITHON_HISTORY_RETENTION_DAYS` | `0`         | Opt-in age limit (days) for raw output-message compaction (`0` = disabled).             |
| `TITHON_HISTORY_TARGET_MIB`     | `0`         | Opt-in soft size target (MiB) per session for raw output-message compaction (`0` = off).|
| `TITHON_SUB_QUEUE_MAX`          | `10000`     | Max queued events per client before it is dropped (backpressure).                       |
| `TITHON_SEND_TIMEOUT`           | `10.0`      | Seconds a client may stall a send before being dropped.                                 |
| `TITHON_WRITE_BUFFER_HIGH`      | `1048576`   | Per-connection send-buffer high-water mark (bounds daemon memory).                      |
| `TITHON_SOCK_SNDBUF`            | `1048576`   | Per-connection kernel socket send buffer.                                               |
| `TITHON_SUB_POLL`               | `0.5`       | Interval (seconds) at which a blocked sender re-checks for drop.                        |
| `TITHON_KERNEL_WATCHDOG_POLL`   | `5`         | Interval (seconds) at which the daemon checks loaded kernels for out-of-band death.     |
| `TITHON_GC_POLL`                | `60`        | Interval (seconds) between idle-kernel GC and output-history retention sweeps.          |
| `TITHON_STDIN_SETTLE`           | `0.3`       | Seconds to wait after a cell starts for a fast `input()` prompt before `--no-wait` exits.|
| `TITHON_KERNEL_REPLY_POLL`      | `1.0`       | Poll interval (seconds) while waiting for a kernel shell reply vs. unexpected exit.     |
| `TITHON_IDLE_BARRIER_TIMEOUT`   | `10`        | Max seconds after `execute_reply` to wait for the matching iopub `status: idle`.        |

Outputs live in `$TITHON_HOME/sessions/<session>/journal.db` (raw messages plus
folded snapshots), with rich outputs written as files under
`<workdir>/.tithon/outputs/` and referenced from the journal.

### Sharing a notebook's outputs

A percent-format `.pynb` or `.py` holds only code, and the journal above is
machine-local (binary, unbounded, unmergeable). So alongside it the daemon keeps
the _folded_ output state as text in your project:

```
<project>/.tithon/
  cells/<relpath>.json       # what each cell currently shows (e.g. train.pynb.json)
  notebooks/<relpath>.json   # imported notebook metadata/attachments, when applicable
  outputs/                   # its images, sha256-deduplicated
```

Commit that directory and whoever clones the repository opens the file with your
results already in it — what `.ipynb` gives you, without the outputs living in
the `.py`. Images are referenced rather than embedded, so a plot redrawn every
step of a training loop still commits one file, not one per frame. Leave the
directory uncommitted (or `.gitignore` it) to keep your outputs to yourself;
nothing else depends on it, and your own session restores from the journal
either way.

Terminating a kernel yourself (`tithon kill`, or **Tithon: Terminate Kernel…**)
means you are done with that session, so reopening the file no longer restores
its cells. The history is kept — **Tithon: Restore Previous Outputs** brings it
back. Every involuntary loss (daemon restart, host reboot, dropped tunnel, idle
GC) still restores automatically.

### Python language services

Notebook cells use the Python language. Pylance same/cross-cell definitions need
Tithon's guarded pseudo-path redirect for both suffixes. Ruff's default file
selection excludes `.pynb`; add this explicitly to your project's `ruff.toml`
(or the equivalent `tool.ruff` setting in `pyproject.toml`):

```toml
extend-include = ["*.pynb"]
```

Tithon never rewrites your Ruff configuration. Real VS Code probes verified
Pylance completion, imported-file definitions and inlay providers; ty diagnostics,
cell/imported definitions and inlays; and Ruff diagnostics/edit/reopen with the
setting above. Full language compatibility is not established: Pylance diagnostics
and the targeted ty `str.upper` completion did not pass matched `.py` controls.
The usual text/notebook lifecycle guards remain necessary when manually reopening
source as text; routine text-toggle controls are shown only for `.py`.

## Contributing

Bug reports are especially welcome — Tithon's job is surviving disconnects, and
the ones that matter happen on setups we don't have. See
[CONTRIBUTING.md](CONTRIBUTING.md) for what makes a report actionable, how to
set up a development environment, and how to propose a change to the design.

## License

[MIT](LICENSE).

[issues]: https://github.com/rnoro/tithon/issues
[marketplace]: https://marketplace.visualstudio.com/items?itemName=rnoro.tithon
