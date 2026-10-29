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

State — socket, log, journal, artifacts — lives under `TITHON_HOME`
(default `~/.tithon`).

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

Outputs are matched to cells by content hash, so they survive edits and reopens.
An output whose cell was edited after it ran is flagged stale. The source file itself
stays pure source — outputs never touch the file, so diffs stay clean.

The widget renderer supports standard bundled ipywidgets, anywidget 0.11.x, and
some installed classic AMD widgets with matching frontend metadata and version
exports, including certain locally mapped dependencies. That path is verified
with bqplot 0.13.1 and pythreejs 2.4.2. Custom widget JavaScript runs only
for a live kernel in a trusted VS Code workspace; saved or untrusted custom
widgets fall back to text. Reconnection restores synchronized model traits and
does not replay clicks. A widget's browser-only state and transient custom
messages are not generally recoverable. CDN loading, broader AMD dependency
discovery, Lab-only bundles and dedicated `Output` layout support remain in progress.

In a local VS Code check with PyGWalker 0.5.0.1, the default `pyg.walk` Data
view with kernel computation displayed its data again after reconnecting. An
unsaved chart created in the browser did not survive reopening the view;
PyGWalker's saved-spec options and alternate anywidget frontend were not tested.

Workspace settings can isolate storage and bound automatic reconnects:

```json
{
  "tithon.homePath": "/tmp/tithon-clone-demo",
  "tithon.reconnectMaxAttempts": 5
}
```

`homePath` is an absolute directory on the extension host (`~/` is supported).
Empty uses `TITHON_HOME`, then `~/.tithon`. **Reload Window** applies a changed
home; it keeps journals and running kernels in the previous home. All socket
connections, startup and daemon management use the selected home. **Tithon:
Show Session Storage** displays its active path. A separately launched CLI must
use the same `TITHON_HOME` to reach that daemon. For a clone demo, select an empty
home and open the cloned project to restore its shared outputs.

`reconnectMaxAttempts` defaults to `0` (unlimited). The initial connection does
not count; the first automatic retry is attempt 1. Reaching a positive limit
ends the progress notification and offers **Retry**. Successful connection or
manual Retry resets the count. You can also cancel the reconnect notification
at any time; Retry remains available in the connection status bar. Stopping
retries leaves the daemon and kernel running.

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
- Every iopub/shell message is journaled **verbatim** to append-only SQLite
  (WAL), alongside a per-execution _folded_ snapshot — the current display
  state — so reconnects are fast.
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

| Command              | Description                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tithon daemon`      | Run the daemon (foreground). Owns the kernel and serves clients.                                                                                   |
| `tithon run -c CODE` | Submit code and stream its output. `--no-wait` prints the exec id and exits; `--timeout N` bounds the wait.                                        |
| `tithon attach`      | Stream events as NDJSON. `--since N` sets the resume point; `--once` exits after the backlog sync; `--until-done` exits after the next completion. |
| `tithon status`      | Print session, queue, kernel, and widget-model status.                                                                                             |

`tithon copy SOURCE DESTINATION --workdir PROJECT` copies percent source and current
outputs within one project, without transferring kernel variables. `tithon import`
and `tithon export` convert to and from Jupyter `.ipynb`.

`attach --since` is the reconnect knob:

- `--since 0` — full folded snapshot, then live delta.
- `--since N` — replay only events after seq `N`, then a `sync` marker, then live.
- `--since -1` — live only, ignore history.

## Configuration

Environment variables read by the daemon and CLI:

| Variable                   | Default     | Purpose                                                            |
| -------------------------- | ----------- | ------------------------------------------------------------------ |
| `TITHON_HOME`              | `~/.tithon` | Root for the socket, log, journal, and artifacts.                  |
| `TITHON_SUB_QUEUE_MAX`     | `10000`     | Max queued events per client before it is dropped (backpressure).  |
| `TITHON_SEND_TIMEOUT`      | `10.0`      | Seconds a client may stall a send before being dropped.            |
| `TITHON_WRITE_BUFFER_HIGH` | `1048576`   | Per-connection send-buffer high-water mark (bounds daemon memory). |
| `TITHON_SOCK_SNDBUF`       | `1048576`   | Per-connection kernel socket send buffer.                          |
| `TITHON_SUB_POLL`          | `0.5`       | Interval at which a blocked sender re-checks for drop.             |

Outputs live in `$TITHON_HOME/sessions/<session>/journal.db` (raw messages plus
folded snapshots), with rich outputs written as files under
`<workdir>/.tithon/outputs/` and referenced from the journal.

### Sharing a notebook's outputs

A percent-format `.py` holds only code, and the journal above is machine-local
(binary, unbounded, unmergeable). So alongside it the daemon keeps the _folded_
output state as text in your project:

```
<project>/.tithon/
  cells/<relpath>.json   # what each cell currently shows
  outputs/               # its images, sha256-deduplicated
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
