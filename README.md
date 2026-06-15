# Tithon

**Persistent, loss-free remote Python sessions.** Tithon keeps an interactive
Python (Jupyter) kernel running on a remote host independently of any client,
and losslessly restores cell output, progress, and widget state whenever a
client (re)connects — close your laptop mid-run, reopen over an SSH/VSCode
tunnel hours later, and your outputs are still there and still streaming.

> The name is from Tithonus of Greek myth, granted immortality but not eternal
> youth — like a remote kernel that stays alive while its outputs wither the
> moment the client disconnects. Tithon lifts the curse: _immortality, with
> eternal youth this time._

The authoritative design document is [`docs/SPEC.md`](docs/SPEC.md); it also
covers current implementation maturity and the verification matrix.

---

## Features

- **Kernel persistence.** The kernel is spawned detached (`setsid`) and is not a
  child of the daemon, so it survives daemon restarts, crashes, and disconnects.
- **Loss-free journal.** Every iopub/shell message is preserved verbatim in a
  SQLite (WAL) journal, plus a per-execution _folded_ snapshot (the current
  display state) for fast reconnects.
- **Snapshot + delta sync.** Clients attach with a `last_seen_seq` and receive a
  snapshot followed by a monotonic-sequence delta stream — gapless and ordered.
- **Live streaming with bounded cost.** Output streams to cells _as it runs_;
  rendering is coalesced so a 50,000-iteration loop collapses to a handful of
  UI updates instead of melting the renderer.
- **Outputs live in the journal, not the file.** A percent-format `.py` stays
  pure source (byte-exact round-trip, clean diffs); outputs are reattached to
  cells by content hash. Rich outputs (images) are stored as files, not base64.
- **Widget state mirror.** `ipywidgets` comm traffic is folded into a
  `widget-state+json` snapshot — a `tqdm` bar with 50k updates reconnects as a
  single bar, not 50k events.
- **Host protection.** A slow or stalled client cannot grow daemon memory
  without bound or block other clients; the daemon caps per-subscriber buffers
  and drops clients that fall too far behind (they reconnect and resync).
- **Unix-socket only.** The daemon binds a `0600` unix domain socket — no TCP.

---

## How it works

```
   VSCode / CLI client                    Remote Host
  ┌────────────────────┐                 ┌───────────────────────────────┐
  │ subscribe(last_seq)│ ── unix sock ── │  tithon daemon                │
  │ snapshot + delta   │ ◀───0600─────  │   ├─ journal (SQLite WAL)     │
  │ restore / live     │                 │   ├─ folded snapshots         │
  └────────────────────┘                 │   └─ widget mirror            │
                                         │            │ ZMQ (detached)   │
                                         │      ┌─────┴───────┐          │
                                         │      │  ipykernel  │ survives │
                                         │      └─────────────┘ restarts │
                                         └───────────────────────────────┘
```

The daemon owns the kernel and journals everything it emits. Clients never talk
to the kernel directly — they sync against the journal, so any number of clients
can connect and disconnect at any time and always converge on the same state.

---

## Requirements

- **Python 3.11+** (the daemon and CLI).
- [**uv**](https://github.com/astral-sh/uv) for environment management.
- **Node 20+ / npm** — only to build or run the VSCode extension.

---

## Installation

### Daemon + CLI

```bash
uv sync                          # create .venv (Python 3.11+), install tithon + dev deps
```

This puts a `tithon` entry point in `.venv/bin`. Run it with `uv run tithon …`,
or call `.venv/bin/tithon` directly. Dependencies are managed with
[uv](https://docs.astral.sh/uv/): runtime deps in `[project.dependencies]`, dev
and verification deps in `[dependency-groups]`, all pinned by `uv.lock`.

### VSCode extension

The extension is not yet on the Marketplace; build it from source and either run
it in a development host or package it as a `.vsix`:

```bash
cd extension
npm install
npm run build                    # tsc -> dist/
npx vsce package                 # optional: -> tithon-extension-<version>.vsix
```

Press **F5** in `extension/` to launch an Extension Development Host, or install
the `.vsix` (Extensions panel ▸ "Install from VSIX…"). For the remote workflow
this project is built for, see
[Remote workflow (VSCode tunnel)](#remote-workflow-vscode-tunnel) below; the
automated integration harness is described in [`docs/SPEC.md`](docs/SPEC.md).

---

## Quickstart

State (socket, log, journal, artifacts) lives under `TITHON_HOME`, default
`~/.tithon`.

**1. Start the daemon** (it runs in the foreground; background it):

```bash
tithon daemon &
tail -f ~/.tithon/daemon.log     # optional
```

**2. Run code** — kernel state persists across calls:

```bash
tithon run -c 'x = 41'
tithon run -c 'x += 1; print(x)'     # -> 42
tithon status
```

**3. Survive a disconnect** — the kernel outlives the daemon, and a reconnect
restores everything:

```bash
tithon run -c 'for i in range(3): print("line", i)'

pkill -9 -f 'tithon daemon'          # kill the daemon; the kernel lives on
tithon daemon &                      # restart -> re-attaches the same kernel

tithon attach --since 0 --once       # full snapshot: the prior output is back
tithon run -c 'print(x)'             # -> 42, kernel state intact
```

---

## Remote workflow (VSCode tunnel)

This is the workflow Tithon is built for: you edit from a laptop while the kernel
runs on a remote GPU host and keeps running across your disconnects. With a
VSCode **Tunnel** (or **Remote-SSH**) connection the VSCode *Extension Host* runs
**on the remote host**, so the Tithon extension reaches the daemon's host-local
unix socket directly — no port forwarding. Your laptop only renders the UI, so
closing it never stops the work.

**On the remote host** — install (see [Installation](#installation)) and:

```bash
# 1. Start the daemon. It binds $TITHON_HOME/daemon.sock on the host
#    (default ~/.tithon/daemon.sock) and owns the kernel.
tithon daemon &

# 2. Make the extension available to the remote VSCode — package it once...
cd extension && npm install && npx vsce package    # -> tithon-extension-<version>.vsix
#    ...then install the .vsix into the remote VSCode (Extensions ▸ "Install from
#    VSIX…", or `code --install-extension tithon-extension-<version>.vsix`).
#    During development you can instead open extension/ and press F5.

# 3. Expose the host to VSCode.
code tunnel                                        # or connect via Remote-SSH
```

**From your laptop:**

1. Connect to the host (VSCode ▸ *Connect to Tunnel…* or *Remote-SSH*) and open
   your project folder.
2. Open a percent-format `.py`. Run cells with the **Run Cell** CodeLens, then
   run **Tithon: Start Live Output Sync** to stream output into the cells as it
   is produced.
3. Close the laptop or drop the connection — the daemon and kernel keep running
   on the host.
4. Reconnect later and run **Tithon: Restore Cell Outputs from Daemon** (or just
   reopen the notebook): the outputs are back and resume streaming live.

> **Note.** The daemon and the extension must share `TITHON_HOME` (both default
> to `~/.tithon` for the same user on the host). Because the Extension Host runs
> on the host, it uses the host-local socket — no manual forwarding. If you
> instead run the extension on your laptop against a remote daemon, you must
> forward the unix socket yourself (e.g. SSH `RemoteForward` or `socat`); that is
> not the default path.

---

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
- `--since -1` — live only (ignore history).

---

## VSCode extension

The extension opens percent-format `.py` files as a notebook (`tithon-py`) and
talks to the daemon over its unix socket. Commands:

| Command                                                              | What it does                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `Tithon: Restore Cell Outputs from Daemon` (`tithon.restoreOutputs`) | Reconnect and restore the journal's folded outputs into the notebook cells. |
| `Tithon: Start Live Output Sync` (`tithon.startLive`)                | Keep a session open and stream output into cells in real time.              |
| `Run Cell` (CodeLens, `tithon.runCell`)                              | Submit a `# %%` cell's code to the daemon.                                  |

Outputs are matched to cells by content hash, so they survive edits and reopens;
an output whose cell was edited since it ran is flagged stale.

---

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

**Where outputs are stored.** A percent `.py` never holds outputs. They live in
`$TITHON_HOME/sessions/default/journal.db` (raw messages + folded snapshots),
with rich outputs (images) written as files under `<workdir>/.tithon/outputs/`
and referenced from the journal.

---

## Architecture invariants

These are load-bearing; see [`docs/SPEC.md`](docs/SPEC.md) for the full
rationale.

1. The kernel is spawned detached and its connection file is persisted, so the
   daemon re-attaches to it after a restart.
2. All iopub/shell messages are kept verbatim in SQLite (WAL), with a folded
   per-execution snapshot maintained alongside.
3. Client sync is snapshot + delta over a monotonically increasing sequence.
4. Rich `image/*` outputs are stored as files, not base64 in the journal.
5. The daemon binds a `0600` unix domain socket only — never TCP.

---

## Repository layout

```
src/tithon/    Python 3.11+ package: daemon.py kernel.py journal.py folding.py widgets.py artifacts.py cli.py
test/          pytest unit tests
extension/     TypeScript VSCode extension (npm, vitest, + integration/ for electron)
scripts/       end-to-end verification scripts (v1–v30) + shared lib + Makefile
docs/          SPEC.md (design source of truth, maturity & verification)
pyproject.toml package + dependencies (uv); pinned by uv.lock
```

---

## Development & testing

```bash
make -C scripts verify     # hermetic end-to-end suite
uv run pytest              # Python unit tests
cd extension && npm test   # extension unit tests (vitest)
```

The real-VSCode integration tests (`make -C scripts verify-d`) download VSCode and run it
under `xvfb`; see [`docs/SPEC.md`](docs/SPEC.md) for the full suite
breakdown, prerequisites, and current implementation maturity. Project decisions
are recorded as ADRs in [`DECISIONS.md`](DECISIONS.md), and ongoing work in
[`PROGRESS.md`](PROGRESS.md).
