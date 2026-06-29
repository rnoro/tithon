# Tithon for VSCode

Run a Python `.py` file as notebook-style cells against a **persistent remote
kernel**. Close your laptop in the middle of a long run, reopen hours later over
a VSCode Tunnel or Remote-SSH, and the cell outputs are still there — and still
streaming.

This is the VSCode client for [Tithon][repo]. The kernel and all session state
live in a host-resident daemon, not in the editor, so disconnecting only stops
the rendering — never the work.

## Why

VSCode's built-in Jupyter ties the kernel to the extension-host process: close
the window or drop the network and the kernel dies, taking your outputs with it.
Tithon moves the kernel and its entire output history into a daemon on the host.
The extension is a thin view over that daemon — it attaches, restores the folded
output snapshot into your cells, and resumes the live stream where it left off.

## Requirements

- The **Tithon daemon** must be installed on the host (`pip install tithon`, or
  `uv add tithon`). The extension can start it for you (see
  `tithon.autoStartDaemon`).
- A Unix-like host — the daemon talks over a local unix domain socket.
- VSCode 1.85+.

The intended setup is a **Tunnel** or **Remote-SSH** connection, where the
extension host runs *on the remote host* and reaches the daemon's local socket
directly — no port forwarding.

## Quickstart

1. Connect to the host (▸ *Connect to Tunnel…* or *Remote-SSH*) and open your
   project folder.
2. Open a percent-format `.py` — a file with `# %%` cell markers. It opens as
   plain text; click **Open as Cell View** in the editor title bar (or run
   *Tithon: Open as Cell View*) to switch to notebook-style cells.
3. Run a cell with the **Run Cell** CodeLens, then run **Tithon: Start Live
   Output Sync** to stream output into the cells as it is produced.
4. Close the laptop or drop the connection. The daemon and kernel keep running.
5. Reconnect later and run **Tithon: Resync Outputs from Daemon** (or just
   reopen the file): the outputs are back and resume streaming.

Outputs are matched to cells by content hash, so they survive edits and reopens;
an output whose cell changed after it ran is flagged stale. The `.py` itself
stays pure source — outputs never touch the file, so diffs stay clean.

## What you get

- **Cell View** for percent `.py` files, with per-cell run and a kernel toolbar
  (interrupt / restart / select interpreter).
- **Live output sync** — stdout/stderr, `matplotlib` figures, and rich
  `display_data` stream into cells in real time.
- **Output restore** — reconnect after any disconnect and the folded output
  state is rebuilt into the cells.
- **ipywidgets** — `tqdm` bars and interactive widgets render through a bundled
  widget renderer and come back at their real state, not their initial value.

## Commands

| Command | What it does |
| --- | --- |
| `Tithon: Start Live Output Sync` | Keep a session open and stream output into cells live. |
| `Tithon: Resync Outputs from Daemon` | Reconnect and restore the journal's folded outputs into the cells. |
| `Tithon: Restart Kernel` | Restart the session's kernel. |
| `Tithon: Interrupt Kernel` | Interrupt the running cell. |
| `Tithon: Select Python Interpreter` | Choose the interpreter the daemon runs the kernel as. |
| `Tithon: Open as Cell View` / `Open as Text Editor` | Toggle a `.py` between Cell View and plain text. |
| `Tithon: Restart Daemon` | Restart the host daemon. |

`Run Cell` is offered as a CodeLens above each `# %%` cell.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `tithon.autoStartDaemon` | `true` | Start the daemon on the host when it isn't already running (spawned detached, so it survives reconnects). |
| `tithon.daemonCommand` | `tithon` | Command used to launch the daemon (run as `<command> daemon`). Set an absolute path if `tithon` isn't on `PATH`. |
| `tithon.pythonPath` | `""` | Run the daemon as `<python> -m tithon daemon`. Leave empty to use the Python extension's selected interpreter. |

## How it pairs with the daemon

The extension and the daemon must share `TITHON_HOME` (both default to
`~/.tithon` for the same user on the host). Because the extension host runs on
the host under a Tunnel/Remote-SSH session, it uses the host-local socket and
needs no forwarding. If you instead run the extension on your laptop against a
*remote* daemon, you must forward the unix socket yourself (SSH `RemoteForward`,
`socat`, …) — that is not the default path.

See the [main project README][repo] and the [design spec][spec] for the full
architecture.

## License

[MIT](LICENSE).

[repo]: https://github.com/rnoro/tithon
[spec]: https://github.com/rnoro/tithon/blob/main/docs/SPEC.md
