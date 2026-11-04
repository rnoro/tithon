# Tithon — Reference

Details that the [README](../README.md) leaves out. For the design see
[`SPEC.md`](./SPEC.md); for known limitations see [`known_issue.md`](./known_issue.md).

## VS Code: opening, copying, importing and exporting files

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

The CLI equivalents are `tithon import`, `tithon copy` and `tithon export`
(see `tithon <command> --help`).

## Environment variables

Read by the daemon and CLI:

| Variable                        | Default     | Purpose                                                                                   |
| ------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `TITHON_HOME`                   | `~/.tithon` | Root for the socket, daemon log, kernel connection files, and per-session journals.       |
| `TITHON_KERNEL_IDLE_TIMEOUT`    | `0`         | Seconds of inactivity before an unattached idle kernel is reaped (`0` = disabled).        |
| `TITHON_HISTORY_RETENTION_DAYS` | `0`         | Opt-in age limit (days) for raw output-message compaction (`0` = disabled).               |
| `TITHON_HISTORY_TARGET_MIB`     | `0`         | Opt-in soft size target (MiB) per session for raw output-message compaction (`0` = off).  |
| `TITHON_SUB_QUEUE_MAX`          | `10000`     | Max queued events per client before it is dropped (backpressure).                         |
| `TITHON_SEND_TIMEOUT`           | `10.0`      | Seconds a client may stall a send before being dropped.                                   |
| `TITHON_WRITE_BUFFER_HIGH`      | `1048576`   | Per-connection send-buffer high-water mark (bounds daemon memory).                        |
| `TITHON_SOCK_SNDBUF`            | `1048576`   | Per-connection kernel socket send buffer.                                                 |
| `TITHON_SUB_POLL`               | `0.5`       | Interval (seconds) at which a blocked sender re-checks for drop.                          |
| `TITHON_KERNEL_WATCHDOG_POLL`   | `5`         | Interval (seconds) at which the daemon checks loaded kernels for out-of-band death.       |
| `TITHON_GC_POLL`                | `60`        | Interval (seconds) between idle-kernel GC and output-history retention sweeps.            |
| `TITHON_STDIN_SETTLE`           | `0.3`       | Seconds to wait after a cell starts for a fast `input()` prompt before `--no-wait` exits. |
| `TITHON_KERNEL_REPLY_POLL`      | `1.0`       | Poll interval (seconds) while waiting for a kernel shell reply vs. unexpected exit.       |
| `TITHON_IDLE_BARRIER_TIMEOUT`   | `10`        | Max seconds after `execute_reply` to wait for the matching iopub `status: idle`.          |

Outputs live in `$TITHON_HOME/sessions/<session>/journal.db` (raw messages plus
folded snapshots), with rich outputs written as files under
`<workdir>/.tithon/outputs/` and referenced from the journal.

## Python language services: verification status

Notebook cells use the Python language. Pylance same/cross-cell definitions need
Tithon's guarded pseudo-path redirect for both suffixes. Tithon never rewrites
your Ruff configuration.

Real VS Code probes verified Pylance completion, imported-file definitions and
inlay providers; ty diagnostics, cell/imported definitions and inlays; and Ruff
diagnostics/edit/reopen with `extend-include = ["*.pynb"]`. Full language
compatibility is not established: Pylance diagnostics and the targeted ty
`str.upper` completion did not pass matched `.py` controls. The usual
text/notebook lifecycle guards remain necessary when manually reopening source as
text; routine text-toggle controls are shown only for `.py`.
