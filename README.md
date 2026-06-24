# Tithon

Keep a Jupyter kernel alive on a remote host, independent of any client. Close
your laptop in the middle of a long run, reopen hours later over SSH or a VSCode
tunnel, and the output is still there — and still streaming.

> The name is from Tithonus, who was granted immortality but not eternal youth
> and withered forever without dying. A remote kernel has the same curse: it
> keeps running, but its output dies the moment the client disconnects. Tithon
> lifts the curse — immortality, with the eternal youth this time. (And it
> rhymes with Python.)

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
> And in the age of coding agents, one more: a `.ipynb` is JSON bloat — the same
> notebook is ~250 lines of `"cell_type"`/`"outputs"` noise that Tithon keeps as
> ~50 lines of clean `.py`. Output images? Tithon keeps them as real files, so an
> agent hands them to the model as actual images it can _see_ — not base64 the
> model burns thousands of tokens on and still can't read. **Don't feed your LLM
> idiot JSON.**

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

## Requirements

- **Python 3.11+** for the daemon and CLI.
- A Unix-like host — the daemon uses unix domain sockets and `setsid` (developed
  and tested on Linux).
- For the remote workflow, **VSCode** with a Tunnel or Remote-SSH connection.

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

## Remote workflow

This is what Tithon is built for: you edit from a laptop while the kernel runs
on a remote GPU host and keeps running across your disconnects.

With a VSCode **Tunnel** (or **Remote-SSH**) connection, the extension host runs
_on the remote host_, so the extension talks to the daemon's host-local unix
socket directly — no port forwarding, and closing your laptop only stops the
rendering, never the work.

1. Connect to the host (VSCode ▸ _Connect to Tunnel…_ or _Remote-SSH_) and open
   your project folder.
2. Open a percent-format `.py`. Run cells with the **Run Cell** CodeLens, then
   run **Tithon: Start Live Output Sync** to stream output into the cells as it
   is produced.
3. Close the laptop or drop the connection. The daemon and kernel keep running.
4. Reconnect later and run **Tithon: Restore Cell Outputs from Daemon** (or just
   reopen the file): the outputs are back and resume streaming.

The daemon and the extension must share `TITHON_HOME` (both default to
`~/.tithon` for the same user). If you instead run the extension on your laptop
against a _remote_ daemon, you have to forward the unix socket yourself (SSH
`RemoteForward`, `socat`, …) — that's not the default path.

## CLI reference

| Command              | Description                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tithon daemon`      | Run the daemon (foreground). Owns the kernel and serves clients.                                                                                   |
| `tithon run -c CODE` | Submit code and stream its output. `--no-wait` prints the exec id and exits; `--timeout N` bounds the wait.                                        |
| `tithon attach`      | Stream events as NDJSON. `--since N` sets the resume point; `--once` exits after the backlog sync; `--until-done` exits after the next completion. |
| `tithon status`      | Print session, queue, kernel, and widget-model status.                                                                                             |

`attach --since` is the reconnect knob:

- `--since 0` — full folded snapshot, then live delta.
- `--since N` — replay only events after seq `N`, then a `sync` marker, then live.
- `--since -1` — live only, ignore history.

## VSCode extension

The extension opens percent-format `.py` files as a `tithon-py` notebook and
talks to the daemon over its unix socket.

| Command                                    | What it does                                                       |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `Tithon: Restore Cell Outputs from Daemon` | Reconnect and restore the journal's folded outputs into the cells. |
| `Tithon: Start Live Output Sync`           | Keep a session open and stream output into cells in real time.     |
| `Run Cell` (CodeLens)                      | Submit a `# %%` cell's code to the daemon.                         |

Outputs are matched to cells by content hash, so they survive edits and reopens.
An output whose cell was edited after it ran is flagged stale. The `.py` itself
stays pure source — outputs never touch the file, so diffs stay clean.

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

## Design invariants

These are load-bearing; the rationale is in [`docs/SPEC.md`](docs/SPEC.md).

1. The kernel is spawned detached and its connection file is persisted, so the
   daemon re-attaches to it after a restart.
2. Every iopub/shell message is kept verbatim in SQLite (WAL), with a folded
   per-execution snapshot maintained alongside.
3. Client sync is snapshot + delta over a monotonically increasing sequence.
4. Rich `image/*` outputs are stored as files, not base64 in the journal.
5. The daemon binds a `0600` unix domain socket only — never TCP.

## License

[MIT](LICENSE).

[issues]: https://github.com/rnoro/tithon/issues
[marketplace]: https://marketplace.visualstudio.com/items?itemName=rnoro.tithon
