# Tithon — Specification

Tithon keeps an interactive Python (Jupyter) kernel running on a remote host
independently of any client, and restores cell outputs, execution state and
widget state whenever a client connects or reconnects.

## How to read this document

- It lists **requirements** Tithon must meet. It is not a design rationale and
  not a description of the current code.
- Anything not stated here is open. Decide it from tests and observed behavior,
  not by extrapolating from this text. Do not cite this document to justify an
  implementation choice it does not state.
- If code and a requirement disagree, either the code is a bug or the
  requirement must change. A requirement changes only through an issue the
  owner accepts, and this file is updated in the same pull request.
- Usage lives in the [README](../README.md); behavior details live in the code
  and its tests.

## Components

- **Daemon** (Python, [`src/tithon/`](../src/tithon/)): owns kernels, stores
  outputs, serves clients.
- **Kernel**: stock `ipykernel`, spawned by the daemon.
- **VSCode extension** ([`extension/`](../extension/)): renders percent source
  files as notebooks with outputs from the daemon.
- **CLI** (`tithon`): drives the same daemon.

The extension host runs on the same host as the daemon (Remote-SSH or
`code tunnel`). Supported platforms are Linux and macOS; Windows only through WSL.

## Requirements

### Kernel lifetime

- A kernel survives client disconnects, extension host exits, and daemon crashes
  or restarts. A restarted daemon re-attaches to the running kernels.
- Each source file has its own session and kernel. The CLI's session is named
  `default`.
- Queued cells keep running when every client disconnects.
- A kernel ends only by explicit user action, by crashing, or by an opt-in idle
  policy that never reaps a session with an attached client, queued or running
  work, or a pending `input()`. Terminating a kernel also terminates the
  processes it spawned.
- A kernel death, and a fresh kernel replacing one whose namespace was lost
  (such as after a host reboot), are reported to clients.

### Output restore

- After any connect or reconnect, a client shows the same current outputs,
  execution state and widget state as a client that stayed connected, including
  output produced while it was away.
- Reconnect cost scales with the size of the current outputs, not with the
  number of messages the kernel emitted.
- All clients of one file see the same state.
- A slow or stalled client cannot grow daemon memory without bound or delay
  other clients.
- A session the user terminated is not restored automatically on the next open;
  its outputs remain available on explicit request.

### Storage

- Image outputs are stored as files and referenced, never embedded as base64.
  Image files for an output that keeps updating stay bounded by what the current
  outputs reference.
- Machine-local state (output history, kernel connection files) lives under
  `TITHON_HOME`, never inside a project.
- A project's `.tithon/` holds only shareable current outputs: no source code,
  execution history or machine-specific data. A cloned repository opens with
  those outputs in place.

### Source files

- Files on disk are percent-format Python (`.pynb`, or `.py` opened as a
  notebook). Outputs are never written into source files.
- Opening and saving a file in the notebook view round-trips it byte for byte.
- The notebook view uses the file's own URI, and only one view of a URI is open
  at a time, so language servers keep working inside cells.
- `.ipynb` is an import and export format only. Conversion never executes code
  and never overwrites an existing file.

### Widgets

- Widgets restore to their current state on reconnect.
- A widget is an interactive control only while backed by the current kernel.
  Otherwise it renders read-only or as text, never as a control that drops
  input. User actions are never replayed automatically.

### Interfaces and security

- The client-facing daemon endpoint is a unix domain socket with `0600`
  permissions. No TCP binding is offered. The kernel's own localhost ZMQ ports
  are the Jupyter standard and are not client-facing.
- Operations that do not need a kernel (status, interrupt, terminate, shutdown,
  output queries, notebook conversion) never create a session or spawn a kernel.
- Interrupt is answered without waiting for unrelated work such as another
  file's kernel startup.

## Verification

Every requirement is covered by tests that run real processes: real kernels, a
real daemon and, for the extension, a real VSCode. The test suites and
`scripts/Makefile` own the mapping from requirement to test.
[CONTRIBUTING.md](../CONTRIBUTING.md) describes how to run them and the rule
that tests are never weakened to pass.
