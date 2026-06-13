# Implementation status & verification

This document tracks what is implemented, how mature it is, and how it is
verified. The product guide is [`../README.md`](../README.md); the design source
of truth is [`design.md`](design.md). Working notes and decisions live in
[`../PROGRESS.md`](../PROGRESS.md) and [`../DECISIONS.md`](../DECISIONS.md).

## Maturity at a glance

- **Production-usable today:** the daemon and CLI (`tithon daemon | run | attach
  | status`) — kernel persistence, journaling, snapshot+delta reconnect, rich
  output artifacts, widget mirror, and host-protecting backpressure.
- **Working, run from source:** the VSCode extension — percent notebook view,
  output restore, and live output streaming. It is exercised in a real VSCode
  Extension Host by the integration suite but is not yet packaged (`.vsix`) or
  published to the Marketplace.
- **Not yet implemented:** live rendering of widget state (widgets currently
  restore on reconnect only), in-place `update_display_data`, multi-session,
  queue visualization, and systemd packaging.

## Capability → verification matrix

| Capability | What it guarantees | Verified by |
|------------|--------------------|-------------|
| Kernel persistence | Kernel survives daemon crash/restart (detached spawn + re-attach) | v4: `kill -9` the daemon, kernel PID and variable state continue |
| Loss-free journal | Every iopub/shell message preserved + folded snapshot | v1 (seq integrity), v2 (50k messages preserved) |
| Reconnect sync | Snapshot + monotonic-seq delta; `attach(last_seen_seq)` | v1, v2 (client stream == journal) |
| Rich outputs | Images stored as files, journal holds references (no base64) | v3 (valid PNG file + journal reference) |
| Widget mirror | `widget-state+json` snapshot kept current | v5 (50k tqdm updates → `FloatProgress value==max==total`) |
| Loss-free serialization | Percent `.py` byte-exact round-trip | v6 (0-byte diff on corpus + 1000-case property test) |
| Output → cell attachment | Journal outputs reattach to cells by `cell_hash` | v6, v7 (real daemon snapshot → cells) |
| Client restore | Subscribe + fold + restore on reconnect | v7 (real daemon; client fold == daemon fold), v8 (real VSCode) |
| Live streaming | Output streams into cells as it runs | v10 (real VSCode; observed incremental growth) |
| Bounded render cost | Coalescing caps UI updates regardless of event volume | `liveSync.test.ts` (50k events → 1 sink call) |
| Host protection | Slow client can't grow daemon memory or block others | `test_backpressure.py` (queue bound + drop), v9 (host stays responsive) |

## Verification suite

```bash
make verify        # hermetic: v1–v7 + v9 (no network/display needed)
make verify-a      # v1–v4   daemon/CLI: persistence, restore, artifacts
make verify-b      # v5–v6   widget mirror + percent serialization
make verify-c      # v7, v9  client restore (e2e) + daemon backpressure
make verify-d      # v8, v10 real VSCode: restore + live streaming
make test          # daemon unit tests (pytest)
```

- `make verify` is hermetic and is the default gate.
- `make verify-d` runs a **real VSCode** Extension Host via
  `@vscode/test-electron` under `xvfb`. It downloads VSCode (needs network) and
  requires system libraries. Install once (Debian/Ubuntu, root):

  ```bash
  apt-get install -y xvfb libgtk-3-0 libgbm1 libnss3 libasound2 libxss1 \
    libxtst6 libxshmfence1 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxrandr2 libxfixes3 libxext6 libxi6 libcups2 libatk-bridge2.0-0 \
    libatspi2.0-0 libpango-1.0-0 libcairo2 ca-certificates
  ```

The verification scripts are append-only with respect to strength: they may be
fixed, hardened, or extended, but never weakened to pass. For example, v4 sends
`kill -9` to the real daemon process and double-checks kernel survival by PID
identity *and* in-kernel variable continuity.

## Module status (`extension/src`)

Verified by unit and/or end-to-end tests:

- `serializer.ts` — percent `.py` byte-exact round-trip.
- `cellAttach.ts` — journal `cell_hash` → cell attachment (hash first, range
  proximity fallback, stale flag).
- `outputFold.ts` — client-side fold (TS port of `folding.py`).
- `sessionClient.ts` — daemon stream subscription (snapshot/delta/live) + restore.
- `liveSync.ts` — live output coalescing (throttle + run-merge + delta-append).
- `sessionController.ts` — NotebookController binding for restore and live (runs
  in real VSCode: v8, v10).
- `widgetRender.ts` — `@jupyter-widgets/html-manager` under jsdom.

Spike (compiles; thin glue, not the focus of testing):

- `daemonClient.ts`, `codeLens.ts`, `notebookSerializer.ts`,
  `widgetRendererEntry.ts` — Cell View, "Run Cell" CodeLens, widget renderer entry.

## Roadmap

- Live rendering of widget state (route the widget mirror through the live path).
- In-place `update_display_data` (currently appended).
- Package the extension (`.vsix`) and document the tunnel workflow.
- Multi-session, execution-queue visualization, artifact-store expansion,
  systemd packaging, stale-badge / dual-view UX.
