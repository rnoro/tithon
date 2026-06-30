# Tithon for VSCode

Run a Python `.py` file as a notebook against a **persistent remote kernel**.
Close your laptop in the middle of a long run, reopen hours later over a VSCode
Tunnel or Remote-SSH, and the cell outputs are still there — and still streaming.

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
extension host runs _on the remote host_ and reaches the daemon's local socket
directly — no port forwarding. It works exactly the same locally.

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
