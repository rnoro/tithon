# Tithon — Design Specification

Tithon keeps an interactive Python (Jupyter) kernel running on a remote host
**independently of any client**, and losslessly restores cell output, progress,
and widget state whenever a client (re)connects. Close your laptop mid-run,
reopen over an SSH/VSCode tunnel hours later, and your outputs are still there
and still streaming.

This document is the authoritative description of _how Tithon is built_ and
_why_. For a user-facing overview see [`../README.md`](../README.md); for
setting up a development environment, the verification gates a change must pass,
and how to propose a change to a decision recorded here, see
[`../CONTRIBUTING.md`](../CONTRIBUTING.md). What is implemented versus planned is
[§9](#9-implementation-status); understood-but-unsolved issues with their
workarounds are [`known_issue.md`](./known_issue.md).

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
2. **Persist every message the kernel publishes** to an append-only journal on
   the host.
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

Key topology decision: under `code tunnel` — and equally under Remote-SSH — the
extension host runs **on the remote host**. So extension ↔ daemon communication
is a local **unix domain socket** — no extra port is exposed, and nothing has to
be forwarded. When a client disconnects the extension host may die, but the
daemon and kernel are unaffected; on reconnect the extension re-attaches to the
daemon and restores state. Running the extension on a laptop against a _remote_
daemon is possible but is the user's problem to arrange (forward the socket with
SSH `RemoteForward` or `socat`): the daemon and the extension must reach the
same `TITHON_HOME`.

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
- If the kernel dies (e.g. OOM) the daemon records the event in the journal, so
  every client learns _when_ and _in which cell_ it happened. A death that
  happens while nothing is running is caught by a **liveness watchdog** polling
  every loaded session (`TITHON_KERNEL_WATCHDOG_POLL`, default 5 s). It runs for
  the daemon's whole lifetime, deliberately independent of the idle-GC policy
  below (which exists only when that policy is enabled), because otherwise
  `is_alive` is consulted only on the execution path and a client keeps showing
  a healthy kernel until the user's next cell.
- Terminating a kernel signals its **process group**, not just its pid. Cells
  fork workers (a torch `DataLoader`, a multiprocessing pool) that inherit the
  `setsid` group; signalling only the group leader leaves them alive as
  init-owned orphans still holding GPU memory. Group ownership is proven before
  the sweep, so a reused pid can never widen the blast radius.
- Kernels otherwise live forever — that is the point — but the operator can opt
  in to a **lifetime policy (idle GC)**: a session idle longer than
  `--idle-timeout` / `TITHON_KERNEL_IDLE_TIMEOUT` seconds is reaped — kernel
  terminated, `Session` dropped. Reaping is deliberately conservative: an
  attached client, a queued or running cell, or a pending `input()` prompt each
  block it (surprise-killing a training run is worse than leaking a kernel).
  The journal and artifacts stay on disk, so reopening the file restores its
  full output history under a fresh kernel; only the in-memory namespace is
  lost, and the reap itself is journaled (`tithon.kernel` `status=gc`). Off by
  default (`0` = never); the extension exposes it as `tithon.kernelIdleTimeout`,
  and its kernel picker shows each kernel's idle time and attached-client count.

### 3.2 Message journal — the source of truth

Each session journals to its own **SQLite database in WAL mode**, append-only.
Schema outline:

```sql
executions(exec_id, session_id, seq, code, cell_origin_uri, cell_range,
           submitted_by, status, execution_count, kernel_msg_id, allow_stdin,
           started_at, finished_at)
messages(msg_seq, session_id, exec_id, msg_type, content_json, artifact_ref, ts)
artifacts(artifact_id, sha256, mime, rel_path, bytes_len)
```

- **Original execution iopub messages are preserved verbatim** (`stream`,
  `display_data`, `update_display_data`, `clear_output`, `execute_result`,
  `error`, `status`). Internal control-request shell replies are consumed by the
  daemon and are not part of an execution's replay stream. Replay semantics are
  the server's responsibility, not the client's.
- The daemon journals its own **lifecycle events** into the same stream: a
  `tithon.kernel` row carrying a status (`restarting`, `restarted`, `killed`,
  `shutdown`, `gc`, `replaced`, `dead`, `interrupted`) and whether the
  transition was `deliberate`, plus a `tithon.started` row when an execution
  actually begins. A kernel restart, a deliberate termination, an idle-GC reap
  and an out-of-band death therefore replay to a client that was disconnected
  when they happened, and the lost-state classification in
  [§7](#7-tricky-points--how-they-are-handled) reads intent from the journal
  rather than from daemon memory.
- **Rich outputs are files, not base64.** On receipt, `image/png`, `image/jpeg`,
  `image/svg+xml`, etc. are decoded and written to
  `<workdir>/.tithon/outputs/e{N}_{idx}_{sha8}.{ext}`; the journal stores only
  a reference. Files are **deduplicated by sha256**. Benefits: the journal DB
  stays small, output images are real files you can open and reuse, and `.py`
  files stay free of the base64-diff bloat that plagues `.ipynb`.

### 3.3 Folding (materialized view)

Replaying every message is too slow for cells that emit tens of thousands of
`\r` / `update_display_data` updates (think `tqdm`). So alongside the raw
journal the daemon keeps a **folded snapshot** per execution — the _current_
display state:

- `stream` text merged with carriage-return semantics applied,
- `update_display_data` collapsed to the latest value per `display_id`. A
  `display_id` is scoped to the SESSION, not to one execution, so the update
  folds into the execution whose `display_data` created the id — which may be a
  different (already finished) cell than the one that emitted the update. The
  journal row stays attributed to its true emitter and carries the resolved fold
  target beside it, so a live broadcast and a `since-N` replay never disagree,
- `clear_output` honored.

A fold is not one flat output list but a set of output **areas**. An
`ipywidgets.Output` claims the running cell's `msg_id` while it is entered, and
its `clear_output()` wraps itself in that claim — so folding such a clear
cell-wide annihilates the siblings of the same cell (the canonical training cell
loses its `tqdm` bars and keeps only the figure). Claims come from the comm rows
themselves, journaled under the same `exec_id` and replayed in seq order, so a
live fold and a rebuilt one converge with no side channel; they are a LIFO stack
because two `Output` widgets can hold one `msg_id`.

A client attaching gets **snapshot + delta-since**, so reconnect cost is
proportional to the _final_ output size, not the number of messages. A TS port
of the folding logic ([`outputFold.ts`](../extension/src/outputFold.ts)) mirrors
the same area model, so a live client folds deltas exactly as the daemon does;
the snapshot carries `fold_state` beside the outputs (area owners index-aligned
with them, plus claims and pending clears) so a reconnecting client resumes the
daemon's fold rather than a flattened rendering of it.

If the daemon dies while ipykernel is executing a request, re-attachment
restores routing only when both its request id and the kernel's durable
parent-scoped `status: busy` were journaled. Output published after the new
daemon subscribes continues into the same fold; output published while no
daemon was subscribed cannot be reconstructed. Because the old shell reply is
addressed to the dead client identity, recovery terminalizes the execution as
`orphaned` with an unknown execution count (or `error` when the raw journal
contains an error frame). Queued and merely-sent requests are also orphaned,
with replayable terminal events, rather than guessed or re-executed.
An `input_request` already journaled at crash time is interrupted during
recovery because its reply route belonged to the dead client. The narrower
receive-before-journal crash window cannot be distinguished from a long-running
stdin-enabled computation without kernel-side identity recovery; it remains a
documented limitation rather than interrupting every such computation.

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
- Binary widget state (`Image`, `ipympl`, `bqplot`) rides the comm frame as
  base64 buffers, live and on replay, so a widget whose state is partly binary
  does not go stale across a reconnect.
- _Bidirectional_ control (a client dragging a slider → kernel) is specified
  here but not implemented; see [§9](#9-implementation-status). `tqdm` is
  display-only and needs no back-channel. Because a rendered-but-dead control
  would silently swallow every input, the client deliberately routes interactive
  widgets to a text rendering instead — see [§4.4](#44-widget-rendering).

### 3.5 Sessions, execution queue & sync protocol

Execution requests are serialized per session into a **FIFO queue**. Concurrent
clients get a deterministic order, and **work already queued keeps running even
if every client disconnects** — the "Run Above, close the laptop, go home"
case.

The daemon binds to a **unix domain socket only** and speaks JSON over
WebSocket frames (`websockets.asyncio.server.unix_serve`). A connection is bound
to one session, fixed on its first op. Four ops take no bind at all:

| Op                        | Payload             | Reply / effect                                                            |
| ------------------------- | ------------------- | ------------------------------------------------------------------------- |
| `status` _(no `session`)_ | —                   | Live status of every session                                              |
| `interrupt`               | `{ session }`       | SIGINT the running cell                                                   |
| `kill_kernel`             | `{ target }`        | Terminate that session's kernel (process group) and drop it; journal kept |
| `shutdown`                | `{ kill_kernels? }` | Stop the daemon; kernels stay detached unless `kill_kernels`              |

The rest bind the connection to a session:

| Op                        | Payload                                              | Reply / effect                                                            |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `attach`                  | `{ session, last_seen_seq, workdir? }`               | Backlog (see below) then `{op:"sync", seq}`, then a live event stream     |
| `execute`                 | `{ session, code, submitted_by, origin, allow_stdin? }` | `{op:"execute_ack", exec_id}`; enqueues the cell                       |
| `execute_batch`           | `{ session, cells, stop_on_error? }`                 | `{op:"execute_ack", exec_ids}`; enqueues a Run-All as one unit           |
| `input_reply`             | `{ session, value }`                                 | Answers a pending `input()` / `getpass()` prompt                          |
| `clear_output`            | `{ session, all? \| exec_ids }`                      | Persists a user clear so a later resync does not restore it               |
| `restart_kernel`          | `{ session }`                                        | Fresh kernel namespace; journal/history retained                          |
| `get_artifact`            | `{ session, artifact_id, req_id? }`                  | Artifact bytes (base64) over the socket — no shared-filesystem assumption |
| `status`                  | `{ session }`                                        | One session's status                                                      |

The bind-free group is not an optimization but a correctness rule: the
**stop button** must outrank everything. Binding a session takes a lock held
across a kernel spawn, so answering `interrupt` after the bind would make a stop
for an already-running file wait out an unrelated file's startup. Looking a
session up creates nothing — a session that does not exist has no cell to stop.
`get_artifact` echoes `req_id` so a client multiplexes many image fetches over
one long-lived connection instead of a socket per image.

`attach` semantics by `last_seen_seq`:

- `0` → full **snapshot** of every execution (folded outputs), then live.
- `> 0` → **delta**: journal messages after that seq, then live.
- `< 0` → **live-only**: no backlog, just future events.

Server → client events carry a monotonic `seq` and a `kind` derived from the
journaled message type — `output` for iopub payloads, `widget` for comm frames,
`status` for kernel busy/idle, and the daemon's own `tithon.*` rows as
`started` / `done` / `kernel` / `input_request` / … — plus (on attach) the
`snapshot`. One builder serves both the live broadcast and the replay, so the
same journal row can never reach a live client as `widget` and a resuming one as
`output`; a client that advances its widget mirror only on `widget` would
otherwise stop mirroring exactly when it reconnected. Everything is broadcast to
all subscribers of the session, so
multi-client views stay identical. Because the subscriber is registered and the
backlog cutoff is computed without an `await` in between, snapshot+delta is
gapless by construction (at-least-once delivery + idempotent application).

### 3.6 Host protection (backpressure)

A slow or stalled client must never grow daemon memory without bound or block
other clients. Two bounds enforce this:

- each subscriber has a bounded event queue (`TITHON_SUB_QUEUE_MAX`, default
  10,000);
- each connection's OS send buffer (`TITHON_SOCK_SNDBUF`) and the WebSocket
  `write_limit` (`TITHON_WRITE_BUFFER_HIGH`) are capped, and a send that stalls
  longer than `TITHON_SEND_TIMEOUT` gives up on that client.

A client that falls too far behind is **dropped**; it reconnects and resyncs
from its last seq. Memory stays bounded regardless of client behavior. Every
`TITHON_*` tunable named in this document is an environment variable read once
at daemon start; they are declared, with the reasoning for each default, at the
top of [`daemon.py`](../src/tithon/daemon.py).

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
_Open as Notebook_), and you can flip back with _Open as Text Editor_. The
default is declarative — the notebook type is contributed with
`priority: "option"`, so an unassociated `.py` resolves to the text editor
without Tithon writing a Global `workbench.editorAssociations` entry on the
user's behalf. For a durable per-file choice, _Always Open With…_ offers exactly
_Text Editor_ and _Notebook_ from the Explorer context menu and both editor
representations, and writes one Workspace-scoped association for that file.

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

Every execution records `origin: {uri, range, index}` plus a `cell_hash` (the
hash of the submitted code), so each output knows which file and which cell
produced it. Attachment rule
([`cellAttach.ts`](../extension/src/cellAttach.ts)): **(1)** match by
`cell_hash`, which is authoritative — the same code means the same output —
tie-breaking duplicate hashes by range proximity, so an output follows its cell
when cells are inserted or moved rather than sticking to a stale index;
**(2)** failing that, fall back to the recorded index and mark the result
**stale**, i.e. the cell was edited after it ran. A stale output stays visible
(it is usually still what you want to read) and is replaced on re-execution.

The plain-text view of the same `.py` gets a **Run Cell** CodeLens per `# %%`
cell, so a cell can be submitted without leaving the text editor; it shares the
journal but does not render output — VSCode has no way to place output inline in
a text editor, which is the reason [§4.1](#41-notebook--percent-py-as-a-notebook)
exists.

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

Only **display-only** widgets take the html-manager path, decided by an
allow-list that fails closed on anything it does not recognize and recurses
through container `children`. Everything else — sliders, buttons, text boxes —
renders as text on purpose: without the client → kernel back-channel of
[§3.4](#34-widget-mirror-ipywidgets--comm) a live-looking control would accept a
drag and drop it silently, which is worse than an honest static value.

If html rendering fails, the widget's final state is shown as text
(e.g. `100% |████| 5/5`), so information is never lost. An
`ipywidgets.Output`'s own view is not rendered at all: what it holds is already
folded into the same cell by [§3.3](#33-folding-materialized-view), so its view
would be a duplicate placeholder.

### 4.5 Lifecycle & UX

- **Daemon lifecycle**: the extension auto-starts the daemon
  (`tithon.autoStartDaemon`), can restart it (_Restart Daemon_), and resolves
  the daemon path from `tithon.daemonCommand` / `tithon.pythonPath`. If the
  daemon is lost under an open notebook, a **reconnect progress notification**
  stays up for the whole drop-to-recovery window rather than flashing once, and
  clears when the daemon respawns and the session re-attaches.
- **Interpreter**: _Select Python Interpreter_ picks the kernel's Python;
  restarting the daemon relaunches under it.
- **Execution control**: the **Stop** button interrupts the running cell (kernel
  survives, cell re-runnable) — one path only, VSCode's own toolbar button for a
  controller with an `interruptHandler`, so there is never a second button that
  can disagree with it. _Restart Kernel_ gives a fresh namespace;
  _Terminate Kernel…_ opens a picker over every live kernel showing each one's
  idle time and attached-client count, and frees its host/GPU resources.
- **Output state**: outputs restore automatically on open. _Restore Previous
  Outputs_ is the one manual path — a session the user deliberately terminated
  is not re-seeded on open (see [§6](#6-on-disk-layout)), and this brings its
  history back.
- **Safety and feedback**: the three actions that destroy a namespace (_Restart
  Kernel_, _Terminate Kernel…_, _Restart Daemon_) ask modally first
  (`tithon.confirmDestructiveActions`, on by default; the helper fails safe, so
  an error answering the prompt cancels rather than proceeds). Command outcomes
  are notifications, not status-bar flashes.
- **Packaging**: shipped as an esbuild-bundled `.vsix` (the runtime `ws`
  dependency must be bundled — `vsce --no-dependencies` omits it and breaks
  activation), published to the Marketplace as `rnoro.tithon`; the daemon/CLI
  ships on PyPI as `tithon`. Versions and the changelog are cut by
  release-please from Conventional Commit subjects.

### 4.6 Language servers & the single-representation rule

A `tithon-py` notebook reuses the `.py`'s **own `file://` URI** as the notebook
URI. That is what keeps ruff / ty / Pylance working inside the cells: the
language server sees the file it already knows, so diagnostics, go-to-definition
and inlay hints resolve against the real source rather than a synthetic
notebook document.

The cost is exclusivity — one URI may have exactly one representation open at a
time, and the toggle has to respect the LSP's document lifecycle:

- Opening the Cell View closes the coexisting text editor and **waits for its
  `textDocument/didClose`** before sending `notebookDocument/didOpen`. Inverted,
  ty rejects the open and every later change is answered "document not found",
  which kills go-to-definition for the rest of the session.
- The guard keys off a **visible** Cell View tab rather than a notebook
  _document_, because overlapping fast toggles can leave a tabless zombie
  document behind; toggles are serialized per URI and stale entries self-heal,
  so a round trip never leaves the file unopenable.

Residual, upstream-owned issues (currently: Pylance's same-file
go-to-definition flicker, whose seamless alternative is `ty`) are documented
with their causes and workarounds in
[`known_issue.md`](./known_issue.md). Because every VSCode release can break
this area, the notebook/LSP suites also run against VSCode **Insiders** as an
advisory early warning (see [§10](#10-verification)).

---

## 5. CLI

The `tithon` CLI ([`src/tithon/cli.py`](../src/tithon/cli.py))
drives the same daemon over the socket:

| Command            | Purpose                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `tithon daemon`    | Run the daemon (foreground); `--log-level`, `--idle-timeout`                    |
| `tithon run`       | Execute code in a session; `-c`, `--no-wait`, `--timeout`                       |
| `tithon attach`    | Attach and stream events as NDJSON; `--since`, `--once`, `--until-done`         |
| `tithon status`    | Daemon status (all sessions, or one with `--session`)                           |
| `tithon restart`   | Restart a session's kernel (fresh namespace)                                    |
| `tithon interrupt` | Interrupt the running cell (SIGINT)                                             |
| `tithon kill`      | Terminate one session's kernel and drop the session; its journal is kept        |
| `tithon shutdown`  | Stop the daemon (kernels stay detached unless `--kill-kernels`)                 |

Session-scoped commands take `--session` (the file uri), defaulting to
`default` — the CLI's own session. `tithon kill` is the exception: it requires
an explicit `--session`, because terminating a kernel by accident is not
something a default should be able to do.

---

## 6. On-disk layout

```
$TITHON_HOME (default ~/.tithon)/          # machine-local; never in a repo
  daemon.sock                  # unix socket (0600)
  daemon.pid
  daemon.log
  sessions/default/            # the CLI session
  sessions/<project>-<hash8>/<relpath…>/   # one dir per file (uri)
    meta.json                  # session id (the file uri) + project workdir
    kernel.json                # connection file; carries an hmac-sha256 key
    kernel.pid
    kernel.log
    journal.db                 # SQLite (WAL): executions, messages, artifacts

<workdir>/.tithon/             # the document's output state; shareable
  outputs/                     # rich-output files, sha256-deduplicated
    e{N}_{idx}_{sha8}.png
  cells/<relpath>.json         # folded snapshot per source file
```

The session directory is named rather than hashed so a human debugging finds a
file's session by reading it: the project root is hashed once (stable per
project) and the file's path relative to it supplies uniqueness. `<workdir>` is
the client's project root, sent as `workdir` on its first op — so a second
project's images cannot land in the first project's `.tithon/outputs/`. Without
a known root (a single-file open, a uri outside the root, the CLI) the session
falls back to a stable hashed directory and the daemon's launch cwd.

**What lives where, and why.** The journal is this machine's verbatim
write-ahead record — binary, WAL, unbounded, rewritten on every run — so it can
neither be committed nor merged, and it sits in `$TITHON_HOME` beside the kernel
connection file whose hmac key must never reach a repository.

What a *reader* of a shared notebook needs is not that record but the **fold**:
the current output state per execution. The daemon projects it onto
`.tithon/cells/<relpath>.json` (stable key order, one field per line). Cloning
the project therefore restores the outputs — the one property `.ipynb` has that
a percent-format `.py` does not — while images stay as deduplicated files rather
than one base64 blob per frame, so a live-updating plot commits **one** file.

It is published once per **user action** — when a submitted batch drains, or a
clear lands — not once per cell: rebuilding it re-serializes every execution's
fold, so per-cell writes would make a Run All quadratic in the notebook's
length. The shared file therefore lags a running batch by design; that is sound
because it is a projection of a journal that already holds everything, and a
daemon that dies mid-batch republishes when `_recover_inflight` terminalizes the
cell it was on. A publish that fails (read-only checkout, full disk) also
suppresses the artifact reclaim that would otherwise follow a clear, so the
shared file never names an image that has already been deleted.

The journal stays authoritative for the machine that ran the cells: a sidecar is
imported only into a session with no local executions of its own, and an imported
execution is terminal, message-less, and has its fold hydrated from the stored
snapshot (`ExecutionFold.hydrate`) so the startup artifact sweep counts its
images as live instead of reclaiming them.

Restoring a file's cells on open is what makes a crash, a reboot, an idle-GC
reap or a dropped tunnel invisible — but it must not undo a decision. A kernel
the user terminated themselves (`tithon kill` / _Terminate Kernel…_) is a
statement that the session is finished, so the daemon records the intent and
that file is **not re-seeded** on the next open. Every involuntary loss still
restores automatically, and the history is kept either way: _Restore Previous
Outputs_ brings a deliberately closed session's cells back.

Nothing machine-specific is written. A cell's origin carries its index and range
but no uri, and execution ids are renumbered on import — the file is tracked,
hand-editable and merge-prone, so its ids are data rather than keys, and each row
is rebound to the reading file's own uri (which the sidecar's location already
implies) so that per-file restore scoping keeps it.

---

## 7. Tricky points & how they are handled

- **Streaming floods (`tqdm`, training logs).** Verbatim in the journal, but
  disk writes and broadcasts are coalesced (~50 ms); folding makes reconnect cost
  scale with final state, not message count.
- **`input()` / `getpass`.** stdin requests are broadcast; any client may reply
  (`input_reply`). The Cell View surfaces one input box per notebook, masked for
  `getpass`, and re-presents it from the snapshot after a mid-prompt reconnect —
  the live event will not replay. Dismissing the box interrupts the cell rather
  than feeding it bogus input.
- **matplotlib.** `ipykernel` is unchanged, so `%matplotlib inline` works as
  usual; figures are captured as artifact files and rendered as images.
- **Daemon ↔ kernel fault isolation.** Detached kernel + persisted connection
  file means the kernel survives a daemon restart; a dead kernel is recorded as
  an event.
- **Host reboot.** In-memory Python state cannot survive; the journal (code +
  output history) does, so re-running to restore is fast. Process checkpointing
  (dill / CRIU) is unreliable with GPU state and is at most a stretch goal — the
  real answer is model checkpointing in the training code, which this system
  complements. Because `Kernel.ensure` deliberately never errors on an
  unresumable kernel (it re-attaches when the pid is live, else spawns fresh —
  the same path that makes reconnect-after-daemon-restart work), a reboot would
  otherwise restore the full output history under an EMPTY namespace with no
  signal, and the user would discover the loss via a `NameError` several cells
  later. The daemon therefore reports **`kernel_lost_state`** in both the attach
  snapshot (`kernel.lost_state`) and `status`, alongside a durable
  **`kernel_generation`** the client de-duplicates its warning on (never the pid
  — a reboot restarts the pid space). Intent is read from the journal, not from
  daemon memory: deliberate transitions journal a `tithon.kernel` event carrying
  `deliberate: true`, and at every fresh spawn the daemon asks whether any
  execution actually BEGAN after the event that opened the generation which just
  died. A deliberate reset therefore pardons only the work that predates it —
  restart, rebuild an hour of state, then reboot, and the warning still fires. A
  re-attach to a surviving kernel and a brand-new session are excluded, so the
  warning stays trustworthy. A kernel that dies while the daemon stays UP (OOM,
  segfault, operator kill) would otherwise escape this entirely — `Session.start()`
  is not re-entered while the daemon lives — so the liveness watchdog of
  [§3.1](#31-kernel-lifetime--failure-isolation) journals that death as
  `status: "dead"`. It is deliberately not one of the statuses that _open_ a
  generation: a death ends one, and anchoring the "did anything run on the
  generation that just died?" window there would place the anchor after all the
  lost work and silently pardon it.

---

## 8. Tech stack

| Area         | Choice                                                 | Notes                                            |
| ------------ | ------------------------------------------------------ | ------------------------------------------------ |
| Daemon       | Python 3.11+, `asyncio`                                | Already present on GPU hosts                     |
| Kernel comms | `jupyter_client` (ZMQ)                                 | No protocol reimplementation                     |
| Transport    | `websockets` over a unix domain socket                 | Minimal dependencies                             |
| Storage      | SQLite (WAL) + blob files                              | Zero-ops at single-user scale                    |
| Extension    | TypeScript, VSCode Notebook / CodeLens API             | esbuild bundle; vitest + `@vscode/test-electron`  |
| Widgets      | `@jupyter-widgets/html-manager` in a notebook renderer | Reused renderer where possible, custom where not |
| Lint/format  | `ruff` (Python) and `biome` (TypeScript), width 100    | Formatters own line width; CI runs both          |
| Release      | release-please from Conventional Commits               | PyPI `tithon` + Marketplace `rnoro.tithon`       |

---

## 9. Implementation status

Tithon is released and in daily use, and it is **alpha**: both components ship
(PyPI `tithon`, Marketplace `rnoro.tithon`) and the design above is built, but
the rough edges are real and the interesting bugs come from setups the project
does not have.

**Working today**

- Daemon + CLI: kernel persistence (detached spawn + re-attach), WAL journal,
  folding over output areas, snapshot+delta reconnect, rich-output artifacts
  with fold-driven GC, widget mirror (binary buffers included), per-session FIFO
  queue, backpressure, in-flight recovery after a daemon crash.
- Per-file kernels/sessions; daemon auto-start; interpreter selection; daemon
  restart; kernel liveness watchdog; process-group termination.
- Kernel lifetime policy: opt-in idle GC (`tithon.kernelIdleTimeout` /
  `--idle-timeout`) — idle kernels reaped, outputs stay restorable from the
  journal; idle time + attached clients shown in `tithon status` and the
  kernel picker.
- Extension: Notebook (byte-exact round-trip) with a durable per-file editor
  association, output restore, live streaming, matplotlib inline images, `tqdm`
  (terminal + `tqdm.notebook`), display-only widget rendering (static,
  on-reconnect, **and live**), the `input()` bridge, Stop / Restart Kernel /
  Terminate Kernel, destructive-action confirmation, reconnect progress.
- Shared outputs: the fold is projected onto a git-tracked
  `<project>/.tithon/cells/<relpath>.json`, so a cloned repository opens with
  its results in place.
- Language-server coexistence in the Cell View (ruff, ty, Pylance), verified on
  VSCode stable with an advisory Insiders run.

**Partial / not yet implemented**

- Bidirectional widgets (client → kernel control, e.g. slider drag). Interactive
  widgets therefore render as text on purpose ([§4.4](#44-widget-rendering)).
  The remaining blocker is not only the comm back-channel: the widget mirror is
  not scoped to a kernel generation, so any model-identity scheme layered on top
  would be unsafe across a restart until that is fixed first.
- `update_display_data` emitted after its cell's completion barrier released (a
  background thread or timer, so the parent `msg_id` no longer maps to an
  execution) is dropped before display resolution — not journaled, not
  broadcast. A `display_id` the daemon has no owner for instead falls back to its
  emitter, where it folds to a no-op. In-place update — same cell and across
  cells — is otherwise implemented.
- Idle-GC of kernels predating a daemon restart: the sweep only sees sessions
  this daemon has loaded, so a detached kernel is invisible until its file is
  next opened (lazy re-attach restarts its idle clock).
- Shell replies are not journaled, so "every message verbatim" holds for the
  iopub stream, not literally for both channels.
- Multi-client presence UI and execution-queue visualization.
- Replay-to-restore after host reboot (re-running journaled code to rebuild the
  namespace; the *signal* that state was lost is implemented — see §7 host reboot
  — but rebuilding it automatically is not).
- systemd packaging.
- Read-only web/CLI dashboard; heavy custom widgets (`ipympl`); multi-user auth;
  other kernels (R/Julia — free in theory via the Jupyter protocol).
- Windows is supported only through WSL; the daemon assumes unix domain sockets
  and `setsid`.

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

# topic bundles — run the one covering the area you touched
make core        # v1–v4 v47 v49 v50 v57  journal / fold / artifacts / daemon-crash survival
make serializer  # v6                     percent <-> notebook round-trip
make backpressure# v9                     slow-client host protection
make widgets     # v5 v29 v30             ipywidget mirror + render + live animation
make restore     # v7 v8 v15 v16 v22 v38 v61 v62 v63  reconnect restore, orphan, cloned repo, closed session
make livesync    # v10–v14 v33 v37 v51 v53 v56 v59  live streaming, edits, cross-cell display, training loop
make kernels     # v17–v21 v23 v24 v26 v40 v45 v46 v48 v52 v58 v60 v65  per-file kernels + lifecycle
make richoutputs # v27 v28 v31 v34 v35 v54 v55  matplotlib/tqdm images, live-plot GC, clear, storage, display_id
make notebook    # v32 v39 v41–v44 v64    text <-> Notebook, durable association, ruff/ty/Pylance LSP
make test        # daemon unit tests (pytest)

# advisory, not a gate: the notebook/LSP suites re-run on VSCode Insiders,
# which surfaces a breaking VSCode change ~4 weeks before it reaches stable.
make notebook-insiders
```

Capability → what it guarantees → how it is verified:

| Capability               | Guarantee                                           | Verified by                                        |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------- |
| Kernel persistence       | Kernel survives daemon crash/restart                | `v4` (`kill -9` daemon; PID + variable continuity) |
| In-flight crash recovery | Accepted cell output resumes after daemon restart   | `v57` (durable busy, delta + snapshot + next cell) |
| Loss-free journal        | Every iopub message preserved + folded snapshot     | `v1` (seq integrity), `v2` (50k messages)          |
| Reconnect sync           | Snapshot + monotonic-seq delta                      | `v1`, `v2` (client stream == journal)              |
| Rich outputs             | Images as files, journal holds references           | `v3` (valid PNG file + journal reference)          |
| Widget mirror            | Snapshot stays current, binary state included       | `v5` (50k `tqdm` → `value==max`), `test_widget_buffer_delta.py` |
| Loss-free serialization  | Byte-exact percent `.py` round-trip                 | `v6` (0-byte diff + property test)                 |
| Output → cell attachment | Outputs reattach by `cell_hash`                     | `v6`, `v7`                                         |
| Client restore           | Subscribe + fold + restore on reconnect             | `v7`, `v8` (real VSCode)                           |
| Per-file kernels         | Each file gets its own kernel + journal             | `v17`                                              |
| Kernel lifetime (idle GC)| Idle kernel reaped; busy/attached never; outputs stay restorable | `v45`, `test_gc.py`                   |
| Live streaming           | Output streams into cells as it runs                | `v10` (real VSCode), `v28`                         |
| Bounded render cost      | Coalescing caps UI updates                          | `liveSync.test.ts` (50k events → 1 sink call)      |
| Host protection          | Slow client can't grow memory or block others       | `test_backpressure.py`, `v9`                       |
| Widget rendering         | Widgets render in VSCode, restore, and animate live | `v29` (static + restore), `v30` (live)             |
| Output-area isolation    | An `Output` widget's clear spares its siblings      | `v54` (real notebook shape), `test_folding.py`     |
| Session-wide `display_id`| A cross-cell in-place update lands in the right cell| `v55` (daemon), `v56` (real VSCode)                |
| Shared outputs           | A cloned repo restores outputs + images              | `v61` (real `git clone`), `test_sidecar.py`        |
| Deliberate close         | A killed session is not re-seeded; history kept     | `v62` (daemon), `v63` (real VSCode seed gate)      |
| Lost-state signal        | A reboot's empty namespace is reported, not silent  | `v46`, `test_lost_state.py`                        |
| Out-of-band kernel death | A kernel dying while idle is reported without a run | `v48`, `test_liveness.py`                          |
| Process-group cleanup    | Terminating a kernel takes its forked workers down  | `v58`, `test_kernel_group_kill.py`                 |
| Stop-button priority     | An interrupt is answered during unrelated spawns    | `v60`                                              |
| Destructive-action gate  | Restart/Terminate touch nothing until confirmed     | `v65` (real VSCode modal)                          |
| Durable editor choice    | "Always Open With…" survives close/reopen           | `v64` (real VSCode)                                |
| LSP coexistence          | Go-to-def + inlay hints survive a text↔cell round trip | `v41`–`v44` (real VSCode + ty/Pylance)          |

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
9. **One URI, one representation.** The Notebook reuses the `.py`'s own
   `file://` URI so language servers keep working inside the cells; the price is
   that the two views must never be open at once, and the toggle owes the LSP a
   correctly ordered close/open ([§4.6](#46-language-servers--the-single-representation-rule)).
10. **The journal is machine-local; the fold is shareable.** What a reader of a
    cloned repository needs is the current output state, not a binary
    write-ahead record — so the fold is projected onto a tracked text sidecar
    while the journal stays in `$TITHON_HOME` beside a connection file whose
    hmac key must never reach a repository ([§6](#6-on-disk-layout)).
11. **No control a client cannot honor.** Until the comm back-channel exists,
    an interactive widget renders as text rather than as a live-looking control
    that silently drops input ([§4.4](#44-widget-rendering)).
