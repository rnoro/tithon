# Tithon — Design Specification

Tithon keeps an interactive Python (Jupyter) kernel running on a remote host
**independently of any client**, and losslessly restores cell output, progress,
and widget state whenever a client (re)connects. Close your laptop mid-run,
reopen over an SSH/VSCode tunnel hours later, and your outputs are still there
and still streaming.

This document is the authoritative description of _how Tithon is built_ and
_why_. For a user-facing overview see [`../README.md`](../README.md). For what is
implemented versus planned, see [§9 Implementation status](#9-implementation-status).

> **The name.** Tithonus of Greek myth was granted immortality but not eternal
> youth, and withered forever without dying. A remote kernel has the same curse:
> it stays alive, but its outputs wither the instant the client disconnects.
> Tithon lifts the curse — _immortality, with eternal youth this time._ The
> cicada (the form Tithonus finally took, singing endlessly) is the logo motif:
> a session that streams output without pause. And `ti-thon` rhymes with
> `Py-thon`.

---

## 1. Problem & approach

Three common setups all lose work on disconnect, for the same underlying reason:

| Tool                                    | Failure                                                                    | Root cause                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| JupyterLab                              | Output produced while disconnected is lost on reconnect                    | iopub messages are streamed over the WebSocket but never persisted server-side; messages emitted during the gap cannot be replayed |
| VSCode Jupyter (`.ipynb` / interactive) | Window close or network drop loses the kernel and all session state        | Kernel lifetime and output state are tied to the extension-host process; output lives only in client memory / the document         |
| `tmux` + `jupyter console`              | Output survives, but no rich output (images/HTML) and no multi-client sync | Inherent limits of a terminal                                                                                                      |

The common cause: **the single source of truth for execution state lives on the
client, or in a volatile channel.** The fix is therefore not a new kernel
protocol but a relocation of ownership:

1. **Move the kernel and session into a host-resident daemon.**
2. **Persist every message the kernel emits** to an append-only journal on the host.
3. **Let clients replay** "the delta since the sequence number I last saw" to
   restore their view.

This is event sourcing. The execution engine stays the proven `ipykernel` —
the problem was never the kernel, it was the session-management layer. (Forking
or extending `ipykernel` is left open for later if kernel-side features such as
an introspection variable explorer are ever needed; see [§11](#11-design-decisions).)

---

## 2. Architecture

```
┌──────────────────────────────  Remote GPU host  ──────────────────────────────┐
│                                                                                │
│  ┌────────────────┐      ZMQ (Jupyter protocol)     ┌──────────────────────┐  │
│  │   ipykernel    │◄────────────────────────────────►│    Tithon daemon     │  │
│  │  (detached,    │                                   │                      │  │
│  │   setsid)      │                                   │  - Session manager   │  │
│  └────────────────┘                                   │  - Message journal   │  │
│        ▲ connection file persisted                    │  - Folding engine    │  │
│        │ (re-attached after a daemon restart)         │  - Widget mirror     │  │
│        │                                              │  - Pub/sub server    │  │
│                                                       └──────────┬───────────┘  │
│  ┌──────────────────────────┐                                   │ unix socket  │
│  │ VSCode tunnel server     │      ┌──────────────────────┐     │ (0600)       │
│  │ (code tunnel)            │──────│ Extension host        │─────┘              │
│  │                          │      │ (Tithon VSCode ext)   │                    │
│  └──────────┬───────────────┘      └──────────────────────┘                    │
└─────────────┼──────────────────────────────────────────────────────────────────┘
              │ vscode.dev tunnel (MS relay)
   ┌──────────┴───────────┐   ┌──────────────────────┐
   │ Client A             │   │ Client B (browser)   │   ← concurrent, same state
   │ (desktop VSCode)     │   │  vscode.dev          │
   └──────────────────────┘   └──────────────────────┘
```

Key topology decision: under `code tunnel` the extension host runs **on the
remote host**. So extension ↔ daemon communication is a local **unix domain
socket** — no extra port is exposed. When a client disconnects the extension
host may die, but the daemon and kernel are unaffected; on reconnect the
extension re-attaches to the daemon and restores state.

---

## 3. The daemon (Python)

The daemon owns kernel lifetime, journals every message, and serves multiple
clients a consistent view. It is a single `asyncio` process; source lives in
[`src/tithon/`](../src/tithon/).

### 3.1 Kernel lifetime & failure isolation

- The kernel is spawned with `jupyter_client`, but as a **detached process
  (`setsid`), not a child of the daemon**, and its connection file is persisted.
  When the daemon restarts — crash, upgrade, interpreter switch — it re-attaches
  to the still-running kernel via the saved connection file. **The daemon is not
  a single point of failure for the kernel.**
- A session is `one kernel + one execution history + a name`. The daemon holds
  many sessions, keyed by `session_id`; each has its own kernel and its own
  journal database. The VSCode extension uses **one session per `.py` file**, so
  files have independent kernels. The CLI defaults to a session named `default`.
- If the kernel dies (e.g. OOM) the daemon detects it and records the event in
  the journal, so every client learns _when_ and _in which cell_ it happened.

### 3.2 Message journal — the source of truth

Each session journals to its own **SQLite database in WAL mode**, append-only.
Schema outline:

```sql
executions(exec_id, session_id, seq, code, cell_origin_uri, cell_range,
           submitted_by, status, execution_count, started_at, finished_at)
messages(msg_seq, session_id, exec_id, msg_type, content_json, artifact_ref, ts)
artifacts(artifact_id, sha256, mime, rel_path, bytes_len)
```

- **Original iopub/shell messages are preserved verbatim** (`stream`,
  `display_data`, `update_display_data`, `clear_output`, `execute_result`,
  `error`, `status`). Replay semantics are the server's responsibility, not the
  client's.
- **Rich outputs are files, not base64.** On receipt, `image/png`, `image/jpeg`,
  `image/svg+xml`, etc. are decoded and written to
  `<workdir>/.tithon/outputs/exec{N}_{idx}_{sha8}.{ext}`; the journal stores only
  a reference. Files are **deduplicated by sha256**. Benefits: the journal DB
  stays small, output images are real files you can open and reuse, and `.py`
  files stay free of the base64-diff bloat that plagues `.ipynb`.

### 3.3 Folding (materialized view)

Replaying every message is too slow for cells that emit tens of thousands of
`\r` / `update_display_data` updates (think `tqdm`). So alongside the raw
journal the daemon keeps a **folded snapshot** per execution — the _current_
display state:

- `stream` text merged with carriage-return semantics applied,
- `update_display_data` collapsed to the latest value per `display_id`,
- `clear_output` honored.

A client attaching gets **snapshot + delta-since**, so reconnect cost is
proportional to the _final_ output size, not the number of messages. A
TS port of the folding logic ([`outputFold.ts`](../extension/src/outputFold.ts))
lets the client fold live deltas the same way the daemon does.

### 3.4 Widget mirror (ipywidgets / comm)

Widgets (`tqdm.notebook`, `FloatProgress`, interactive plots) need two-way state
sync between a kernel-side object and a front-end model; plain message replay
cannot reconstruct them. The daemon therefore acts as a **shadow front end**:

- `comm_open` (target `jupyter.widget`) creates a model, `comm_msg` patches its
  state, `comm_close` removes it — so the daemon always holds a complete
  **widget state snapshot** (the `application/vnd.jupyter.widget-state+json`
  shape).
- On reconnect the daemon sends the _snapshot_, not the message history, so a
  50,000-update `tqdm` bar costs one final-state transfer. Live updates flow as
  deltas so a connected client can animate the bar in real time.
- _Bidirectional_ control (a client dragging a slider → kernel) is specified
  here but not yet implemented; see [§9](#9-implementation-status). `tqdm` is
  display-only and needs no back-channel.

### 3.5 Sessions, execution queue & sync protocol

Execution requests are serialized per session into a **FIFO queue**. Concurrent
clients get a deterministic order, and **work already queued keeps running even
if every client disconnects** — the "Run Above, close the laptop, go home"
case.

The daemon binds to a **unix domain socket only** and speaks line-delimited
JSON. A connection is bound to one session, fixed on its first op. Requests:

| Op                        | Payload                                   | Reply / effect                                                            |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| `status` _(no `session`)_ | —                                         | Live status of every session                                              |
| `attach`                  | `{ session, last_seen_seq }`              | Backlog (see below) then `{op:"sync", seq}`, then a live event stream     |
| `execute`                 | `{ session, code, submitted_by, origin }` | `{op:"execute_ack", exec_id}`; enqueues the cell                          |
| `interrupt`               | `{ session }`                             | SIGINT the running cell                                                   |
| `restart_kernel`          | `{ session }`                             | Fresh kernel namespace; journal/history retained                          |
| `get_artifact`            | `{ session, artifact_id }`                | Artifact bytes (base64) over the socket — no shared-filesystem assumption |
| `status`                  | `{ session }`                             | One session's status                                                      |
| `shutdown`                | `{ kill_kernels? }`                       | Stop the daemon; kernels stay detached unless `kill_kernels`              |

`attach` semantics by `last_seen_seq`:

- `0` → full **snapshot** of every execution (folded outputs), then live.
- `> 0` → **delta**: journal messages after that seq, then live.
- `< 0` → **live-only**: no backlog, just future events.

Server → client events carry a monotonic `seq` and a `kind`
(`started`, `output`, `done`, …), plus `kernel_status` and (on attach) the
`snapshot`. Everything is broadcast to all subscribers of the session, so
multi-client views stay identical. Because the subscriber is registered and the
backlog cutoff is computed without an `await` in between, snapshot+delta is
gapless by construction (at-least-once delivery + idempotent application).

### 3.6 Host protection (backpressure)

A slow or stalled client must never grow daemon memory without bound or block
other clients. Two bounds enforce this:

- each subscriber has a bounded event queue (`SUB_QUEUE_MAX`, default 10,000);
- each connection's OS send buffer and the WebSocket `write_limit` are capped.

A client that falls too far behind is **dropped**; it reconnects and resyncs
from its last seq. Memory stays bounded regardless of client behavior.

### 3.7 Security

The daemon binds **only** to a unix domain socket with `0600` permissions, so
only the same OS account can reach it. Since the daemon executes arbitrary code,
TCP / `0.0.0.0` binding is **not offered even as an option**. Multi-user auth
and per-session permissions are out of scope (a possible later phase).

---

## 4. The VSCode extension (TypeScript)

Source: [`extension/src/`](../extension/src/). The extension renders a `.py`
file's cells and their outputs natively, restoring from the daemon on attach and
streaming live while a cell runs.

### 4.1 Notebook — percent `.py` as a notebook

VSCode has no public API to inject a webview at an arbitrary editor position
(`createWebviewTextEditorInset` is stuck "proposed", not shippable). So Tithon
parses the `.py` itself with a **`NotebookSerializer`** for a custom notebook
type (`tithon-py`) — the pattern proven by the jupytext extension. On disk there
is only a pure percent-format `.py`; in the editor each `#%%` cell shows its
image / widget / text output below it as native notebook rendering. Outputs come
from the journal and are attached to cells, so the `.py` is never polluted.

`.py` files open as **plain text by default**; Notebook is opt-in (command
_Open as Notebook_), and you can flip back with _Open as Text Editor_.

- **Byte-exact round-trip is mandatory.** Serialization preserves the user's
  formatting, whitespace, and comments to the byte — no auto-reformat
  ([`serializer.ts`](../extension/src/serializer.ts)).

### 4.2 Output rendering & restore

Rendering uses the **VSCode Notebook API (`NotebookController`)** rather than a
custom webview, so ANSI color, `image/png`, `text/html`, error tracebacks, and
scrollable long output come for free, and third-party renderers (e.g. Plotly)
remain compatible ([`sessionController.ts`](../extension/src/sessionController.ts)).

- **On attach**: subscribe → fold the daemon snapshot → restore cell outputs.
- **Live**: deltas stream into cells as the cell runs, coalesced so a
  50,000-iteration loop collapses to a handful of UI updates
  ([`liveSync.ts`](../extension/src/liveSync.ts)).
- Rich-output bytes (matplotlib figures) are fetched via `get_artifact` and
  rendered as `image/png` items; the journal stays base64-free.

### 4.3 Output → cell attachment

Every execution records `origin: {uri, range, cell_hash}`, so each output knows
which file and which cell produced it. Attachment rule
([`cellAttach.ts`](../extension/src/cellAttach.ts)): **(1)** match by `cell_hash`
(code-content hash), **(2)** fall back to range proximity. If a cell is edited,
its old output is kept with a **stale** flag (useful until re-run) and replaced
on re-execution. The text view and Notebook are two presentations of the same
truth (the journal), so output appears identically in both.

### 4.4 Widget rendering

A notebook renderer (`tithon-widget`) renders widgets with
`@jupyter-widgets/html-manager`. To avoid a host round-trip race (render before
state arrives), the daemon emits a **self-contained custom mime**
`application/vnd.tithon.widget+json = { model_id, state }`; the renderer
instantiates the model immediately from that payload. The renderer is an esbuild
bundle (html-manager + ipywidgets controls + CSS inlined). It renders:

- **statically** and **on reconnect** (the widget mirror snapshot), and
- **live** — the bar animates as the cell runs (comm deltas coalesced and pushed
  to the renderer, applied with `model.set_state`).

If rendering fails it falls back to the widget's final state as text
(e.g. `100% |████| 5/5`), so information is never lost.

### 4.5 Lifecycle & UX

- **Daemon lifecycle**: the extension auto-starts the daemon, can restart it
  (_Restart Daemon_), and resolves the daemon path from the selected interpreter.
- **Interpreter**: _Select Python Interpreter_ picks the kernel's Python;
  restarting the daemon relaunches under it.
- **Execution control**: per-cell **Stop** button interrupts the running cell
  (kernel survives, cell re-runnable); _Restart Kernel_ gives a fresh namespace;
  _Resync Outputs from Daemon_ and _Start Live Output Sync_ re-establish state.
- **Packaging**: shipped as an esbuild-bundled `.vsix` (the runtime `ws`
  dependency is bundled — `vsce --no-dependencies` omits it and breaks
  activation). Not yet published to the Marketplace.

---

## 5. CLI

The `tithon` CLI ([`src/tithon/cli.py`](../src/tithon/cli.py))
drives the same daemon over the socket:

| Command            | Purpose                                                         |
| ------------------ | --------------------------------------------------------------- |
| `tithon daemon`    | Run the daemon (foreground)                                     |
| `tithon run`       | Execute code in a session                                       |
| `tithon attach`    | Attach and stream events as NDJSON                              |
| `tithon status`    | Daemon status (all sessions, or one)                            |
| `tithon restart`   | Restart a session's kernel (fresh namespace)                    |
| `tithon interrupt` | Interrupt the running cell (SIGINT)                             |
| `tithon shutdown`  | Stop the daemon (kernels stay detached unless `--kill-kernels`) |

---

## 6. On-disk layout

```
$TITHON_HOME (default ~/.tithon)/
  daemon.sock                  # unix socket (0600)
  daemon.pid
  daemon.log
  sessions/<session-dir>/
    meta.json
    journal.db                 # SQLite (WAL): executions, messages, artifacts

<workdir>/.tithon/outputs/     # rich-output files, sha256-deduplicated
  exec{N}_{idx}_{sha8}.png
```

The `.tithon/outputs/` location is configurable (default: inside the workspace).

---

## 7. Tricky points & how they are handled

- **Streaming floods (`tqdm`, training logs).** Verbatim in the journal, but
  disk writes and broadcasts are coalesced (~50 ms); folding makes reconnect cost
  scale with final state, not message count.
- **`input()` / `getpass`.** stdin requests are broadcast; any client may reply.
  (Implemented at the protocol level; UI surfacing is partial.)
- **matplotlib.** `ipykernel` is unchanged, so `%matplotlib inline` works as
  usual; figures are captured as artifact files and rendered as images.
- **Daemon ↔ kernel fault isolation.** Detached kernel + persisted connection
  file means the kernel survives a daemon restart; a dead kernel is recorded as
  an event.
- **Host reboot.** In-memory Python state cannot survive; the journal (code +
  output history) does, so re-running to restore is fast. Process checkpointing
  (dill / CRIU) is unreliable with GPU state and is at most a stretch goal — the
  real answer is model checkpointing in the training code, which this system
  complements.

---

## 8. Tech stack

| Area         | Choice                                                 | Notes                                            |
| ------------ | ------------------------------------------------------ | ------------------------------------------------ |
| Daemon       | Python 3.11+, `asyncio`                                | Already present on GPU hosts                     |
| Kernel comms | `jupyter_client` (ZMQ)                                 | No protocol reimplementation                     |
| Transport    | `websockets` over a unix domain socket                 | Minimal dependencies                             |
| Storage      | SQLite (WAL) + blob files                              | Zero-ops at single-user scale                    |
| Extension    | TypeScript, VSCode Notebook / CodeLens API             | —                                                |
| Widgets      | `@jupyter-widgets/html-manager` in a notebook renderer | Reused renderer where possible, custom where not |

---

## 9. Implementation status

The Phase 0 proof-of-concept is complete: all six gating criteria pass,
including the two highest-risk items — **in-VSCode widget rendering** and
**byte-exact percent round-trip with output→cell attachment**. The project is
past Phase 0; widget rendering reached live animation rather than the planned
text fallback.

**Working today**

- Daemon + CLI: kernel persistence (detached spawn + re-attach), WAL journal,
  folding, snapshot+delta reconnect, rich-output artifacts, widget mirror,
  per-session FIFO queue, backpressure.
- Per-file kernels/sessions; daemon auto-start; interpreter selection; daemon
  restart.
- Extension: Notebook (byte-exact round-trip), output restore, live
  streaming, matplotlib inline images, `tqdm` (terminal + `tqdm.notebook`),
  widget rendering (static, on-reconnect, **and live**), Stop / Restart Kernel.
- Packaged as an esbuild-bundled `.vsix`.

**Partial / not yet implemented**

- Bidirectional widgets (client → kernel control, e.g. slider drag).
- In-place `update_display_data` (currently appended).
- Session GC / kernel lifetime policy (detached kernels currently live on; no
  idle or explicit-shutdown UI).
- Multi-client presence UI and execution-queue visualization.
- Replay-to-restore after host reboot.
- systemd packaging; Marketplace publish.
- Read-only web/CLI dashboard; heavy custom widgets (`ipympl`); multi-user auth;
  other kernels (R/Julia — free in theory via the Jupyter protocol).

---

## 10. Verification

Tithon is validated by real processes, not mocks: the suite spawns real
detached kernels, a real daemon, and (for end-to-end tests) a **real VSCode**
Extension Host via `@vscode/test-electron` under `xvfb`. **Verification scripts
are append-only with respect to strength** — they may be fixed, hardened, or
extended, but never weakened to pass. For example, `v4` sends `kill -9` to the
real daemon and double-checks kernel survival by _both_ PID identity _and_
in-kernel variable continuity.

Tests are grouped into **topic bundles** — run the one for the area you are
working on, or a meta-bundle. Any bundle with a real-VSCode test builds the
extension **once** (shared across the bundle).

```bash
# meta-bundles
make fast        # every hermetic test (no network/display) — the quick gate (alias: make verify)
make vscode      # every real-VSCode test (needs network + xvfb; one shared build)
make all         # fast + vscode

# topic bundles (a test lives in exactly one)
make core        # v1–v4    journal / fold / artifact / daemon-crash survival
make serializer  # v6       percent <-> notebook round-trip
make backpressure# v9       slow-client host protection
make widgets     # v5 v29 v30           ipywidget mirror + render + live animation
make restore     # v7 v8 v15 v16 v22 v38 reconnect: output + cell-state restore, orphan
make livesync    # v10–v14 v33 v37       live streaming into cells
make kernels     # v17–v21 v23 v24 v26   per-file kernels + lifecycle
make richoutputs # v27 v28 v31 v34 v35   matplotlib/tqdm images, live-plot GC, clear, storage
make notebook    # v32 v39              text <-> Notebook, ruff/ty LSP
make test        # daemon unit tests (pytest)
```

Capability → what it guarantees → how it is verified:

| Capability               | Guarantee                                           | Verified by                                        |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------- |
| Kernel persistence       | Kernel survives daemon crash/restart                | `v4` (`kill -9` daemon; PID + variable continuity) |
| Loss-free journal        | Every message preserved + folded snapshot           | `v1` (seq integrity), `v2` (50k messages)          |
| Reconnect sync           | Snapshot + monotonic-seq delta                      | `v1`, `v2` (client stream == journal)              |
| Rich outputs             | Images as files, journal holds references           | `v3` (valid PNG file + journal reference)          |
| Widget mirror            | `widget-state+json` snapshot stays current          | `v5` (50k `tqdm` updates → `value==max`)           |
| Loss-free serialization  | Byte-exact percent `.py` round-trip                 | `v6` (0-byte diff + property test)                 |
| Output → cell attachment | Outputs reattach by `cell_hash`                     | `v6`, `v7`                                         |
| Client restore           | Subscribe + fold + restore on reconnect             | `v7`, `v8` (real VSCode)                           |
| Per-file kernels         | Each file gets its own kernel + journal             | `v17`                                              |
| Live streaming           | Output streams into cells as it runs                | `v10` (real VSCode), `v28`                         |
| Bounded render cost      | Coalescing caps UI updates                          | `liveSync.test.ts` (50k events → 1 sink call)      |
| Host protection          | Slow client can't grow memory or block others       | `test_backpressure.py`, `v9`                       |
| Widget rendering         | Widgets render in VSCode, restore, and animate live | `v29` (static + restore), `v30` (live)             |

`make vscode` downloads VSCode and needs system libraries (Debian/Ubuntu):

```bash
apt-get install -y xvfb libgtk-3-0 libgbm1 libnss3 libasound2 libxss1 \
  libxtst6 libxshmfence1 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxrandr2 libxfixes3 libxext6 libxi6 libcups2 libatk-bridge2.0-0 \
  libatspi2.0-0 libpango-1.0-0 libcairo2 ca-certificates
```

---

## 11. Design decisions

1. **A new session layer, not a new kernel.** The problem is session management,
   so `ipykernel` is reused. The daemon↔kernel interface is fixed to the Jupyter
   wire protocol, leaving room to swap in an `ipykernel` subclass later if
   kernel-side features are ever needed.
2. **No `.ipynb`; an execution-history model.** Percent `.py` is the only source.
   This sidesteps stable-cell-ID sync entirely; output is owned by the journal,
   not the document.
3. **Event sourcing + materialized view.** Loss-free guarantees and fast
   reconnect at the same time.
4. **Reuse the VSCode Notebook API.** Don't rebuild rendering — except the widget
   renderer, which must be custom (html-manager based).
5. **Daemon/kernel process separation.** No single component's death kills the
   run (the kernel itself aside).
6. **Rich output is a file.** Real files + journal references instead of base64
   embedding — outputs become first-class artifacts and `.ipynb`'s bloat/diff
   problems disappear by construction.
7. **Widgets via a state mirror, not message replay.** The daemon keeps a widget
   snapshot as a shadow front end, making reconnect cost constant.
8. **Inline output via Notebook, not inset hacks.** Open `.py` through a
   `NotebookSerializer` so output attaches natively below each cell. Disk format
   (`.py`) and display form (cells) are decoupled; the journal is the one truth,
   and text editor and Notebook are two views of it.
