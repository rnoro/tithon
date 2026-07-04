# Tithon for VSCode

Run a Python `.py` file as a notebook against a **persistent remote kernel**.
Close your laptop in the middle of a long run, reopen hours later over a VSCode
Tunnel or Remote-SSH, and the cell outputs are still there — and still streaming.

This is the VSCode client for [Tithon][repo]. The kernel and all session state
live in a host-resident daemon, not in the editor, so disconnecting only stops
the rendering — never the work.

> The name is from Tithonus, who was granted immortality but not eternal youth
> and withered forever without dying. A remote kernel has the same curse: it
> keeps running, but its output dies the moment the client disconnects. Tithon
> lifts the curse — immortality, with the eternal youth this time. (And it
> rhymes with Python.)

> **Status: alpha.** It works and it's in daily use, but you will hit rough
> edges. Bug reports are genuinely useful — please [open an issue][issues].

## The problem

VSCode's built-in Jupyter ties the kernel to the extension-host process: close
the window or drop the network and the kernel dies, taking your outputs with
it. The source of truth for your session lives in the client, or in a channel
that doesn't outlive a disconnect. Tithon moves it to the host — the extension
is a thin view over a daemon, not the owner of the kernel.

> And in the age of coding agents, one more: a `.ipynb` is JSON bloat — the same
> notebook is ~250 lines of `"cell_type"`/`"outputs"` noise that Tithon keeps as
> ~50 lines of clean `.py`. Output images? Tithon keeps them as real files, so an
> agent hands them to the model as actual images it can _see_ — not base64 the
> model burns thousands of tokens on and still can't read. **Don't feed your LLM
> idiot JSON.**

## Requirements

- The **Tithon daemon** must be installed on the host (`pip install tithon`, or
  `uv add tithon`). The extension can start it for you (see
  `tithon.autoStartDaemon`).
- A Unix-like host — the daemon talks over a local unix domain socket.
- VSCode 1.85+.

The intended setup is a **Tunnel** or **Remote-SSH** connection, where the
extension host runs _on the remote host_ and reaches the daemon's local socket
directly — no port forwarding. It works exactly the same locally.

## Install

```bash
code --install-extension rnoro.tithon
```

or search for "tithon" in the Extensions view. The daemon side ships on PyPI:

```bash
pip install tithon      # or: uv add tithon
```

## Quickstart

A percent-format `.py` (a plain script with `# %%` cell markers) opens as a
**notebook** backed by the daemon — same cells, same Run buttons, same rich
output as a Jupyter `.ipynb`, except the kernel and its output live on the host
and survive your disconnects.

1. Open a `.py`. It opens as plain text by default; switch it with **Open as
   Notebook** — the CodeLens at the top of the file, or the editor title menu.
2. Pick the **Tithon** kernel and run cells as usual.

That's all. Selecting the kernel attaches the session and restores any earlier
output automatically; new output then streams into the cells live as it is
produced. Close the laptop or drop the connection — the daemon and kernel keep
running. Reopen the notebook later (VSCode remembers the kernel) and the outputs
are back and resume streaming, with **no command to run**.

Outputs are matched to cells by content hash, so they survive edits and reopens;
an output whose cell changed after it ran is flagged stale. The `.py` itself
stays pure source — outputs never touch the file, so diffs stay clean.

## What you get

- **Notebook view** for percent `.py` files, with per-cell run and a kernel
  toolbar (interrupt / restart / select interpreter).
- **Automatic restore + live sync** — selecting the kernel (or reopening the
  file) rebuilds the folded output state into the cells and resumes streaming;
  stdout/stderr, `matplotlib` figures, and rich `display_data` arrive in real
  time, with no manual command.
- **ipywidgets** — `tqdm` bars and interactive widgets render through a bundled
  widget renderer and come back at their real state, not their initial value.

## Commands

Restore and live sync happen automatically, so there are no commands for them.
The rest are run from the command palette or the notebook's kernel toolbar:

| Command | What it does |
| --- | --- |
| `Tithon: Open as Notebook` / `Open as Text Editor` | Toggle a `.py` between notebook and plain text. |
| `Tithon: Restart Kernel` | Restart the session's kernel. |
| `Tithon: Interrupt Kernel` | Interrupt the running cell. |
| `Tithon: Select Python Interpreter` | Choose the interpreter the daemon runs the kernel as. |
| `Tithon: Restart Daemon` | Restart the host daemon. |
| `Tithon: Terminate Kernel…` | Kill the session's kernel. |

`Run Cell` is offered as a CodeLens above each `# %%` cell.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `tithon.autoStartDaemon` | `true` | Start the daemon on the host when it isn't already running (spawned detached, so it survives reconnects). |
| `tithon.daemonCommand` | `tithon` | Command used to launch the daemon (run as `<command> daemon`). Set an absolute path if `tithon` isn't on `PATH`. |
| `tithon.pythonPath` | `""` | Run the daemon as `<python> -m tithon daemon`. Leave empty to use the Python extension's selected interpreter. |
| `tithon.kernelIdleTimeout` | `0` | Reap a kernel after this many seconds idle (no attached notebook, nothing running or queued). Outputs stay restorable from the journal; only the in-memory variables are lost. `0` = never. Applied when the extension (re)starts the daemon. |

## How it works

A long-lived **daemon** on the host owns the kernel and serves clients:

![Tithon architecture overview: a detached ipykernel connected to the tithon daemon over ZMQ. The daemon journals every message verbatim to SQLite/WAL, folds it into a current-display snapshot plus an ipywidgets state mirror, stores rich outputs as files referenced by hash, and serves VSCode and CLI clients over a 0600 unix socket — no TCP.](https://raw.githubusercontent.com/rnoro/tithon/main/docs/how-it-works.png)

- The kernel runs **detached** (`setsid`), so it is not a child of the daemon.
  The daemon can crash, restart, or be upgraded; the kernel keeps running and
  re-attaches through a persisted connection file.
- Every iopub/shell message is journaled **verbatim** to append-only SQLite
  (WAL), alongside a per-execution _folded_ snapshot — the current display
  state — so reconnects are fast.
- The extension attaches with the last sequence number it saw and gets a
  snapshot plus an ordered, gapless delta stream; reconnecting is just resuming
  the stream.
- Rich outputs (images) are stored as files and referenced by hash, never
  base64-embedded, and `ipywidgets` traffic is folded into a `widget-state+json`
  snapshot, so a `tqdm` bar or a slider comes back at its real value.
- The daemon binds a `0600` unix domain socket. No TCP.

The kernel itself is plain `ipykernel` — Tithon replaces the session-management
layer around it, not the execution engine.

## How it pairs with the daemon

The extension and the daemon must share `TITHON_HOME` (both default to
`~/.tithon` for the same user on the host). Because the extension host runs on
the host under a Tunnel/Remote-SSH session, it uses the host-local socket and
needs no forwarding. If you instead run the extension on your laptop against a
_remote_ daemon, you must forward the unix socket yourself (SSH `RemoteForward`,
`socat`, …) — that is not the default path.

See the [main project README][repo] and the [design spec][spec] for the full
architecture.

## License

[MIT](LICENSE).

[repo]: https://github.com/rnoro/tithon
[spec]: https://github.com/rnoro/tithon/blob/main/docs/SPEC.md
[issues]: https://github.com/rnoro/tithon/issues
