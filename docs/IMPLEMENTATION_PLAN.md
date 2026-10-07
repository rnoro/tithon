# Storage, restore guidance, and notebook interchange

## Scope and acceptance

Reuse the existing execution rows, output folds, hydration, widget mirror, artifact GC,
and reconnect protocol. Add storage reporting, opt-in output-history retention,
restore state guidance, and Python notebook import/export. Do not add restore timing,
success-rate statistics, telemetry, execution comparison, or kernel widget queries.

1. Report physical DB/WAL/SHM sizes separately from logical retained data and referenced
   images. Show effective retention settings and whether restarting the daemon is needed.
2. Accept nonnegative finite retention days and target MiB (zero disables). At idle,
   persist current folds and their continuation state plus display routing and a sequence
   boundary, deletion of eligible output messages and the highest actually deleted sequence
   (`history_floor`) in one transaction. Roll back all three together on failure. Keep executions, comms,
   and lifecycle records. Never trim during execution, queued work, recovery, or stdin.
   Check loaded sessions every 60 seconds and after loading; never spawn for maintenance.
3. Restore stored folds with existing hydrate(), then replay newer messages. Keep existing
   widget/lifecycle recovery. Older clients reconnecting across deleted history receive a
   full snapshot. Sequence numbers are never reused. Limits are soft targets; current
   outputs, executions and comm/lifecycle history remain, SQLite pages are reused without
   automatic VACUUM. Opt-in compaction changes the raw-message preservation guarantee;
   document that downgraded daemons cannot read compacted journals safely.
4. Show per-notebook connecting/restoring/connected/retry/failure states using existing
   reconnect machinery. Connected means images and cell application completed. Preserve
   failures with an actionable retry, cancel on close/deselection, and avoid notification spam.
5. Import nbformat 4 Python notebooks into percent-format .py plus existing output sidecars
   and real image files. Export code/markdown/raw cells and their current outputs to nbformat
   4 .ipynb, embedding images only in the external notebook. Never execute imported code.
   Preserve cell metadata, attachments and widget state where supported; reject unsupported
   formats/languages and ambiguous cell boundaries with explicit errors. Never silently
   overwrite existing files. Provide CLI and VS Code commands.

## Implementation and verification

- Storage/retention: journal and session tests covering rollback, default disabled policy,
  restart, continuation, cross-cell displays, images/widgets and snapshot fallback.
- Interchange: real notebook fixtures and round-trip tests, Unicode, rich outputs, metadata,
  attachments, raw/empty cells, malformed input and overwrite protection.
- Extension: build/lint/unit tests plus real VS Code restore/interchange checks when available.
- Required gates: Python tests and ruff, extension lint/build/test, make -C scripts fast and
  core/restore/widgets/richoutputs/notebook topic bundles; paste full summary tables.
- Run independent design and diff reviews through the repository wrapper, triage every
  finding, update SPEC/contributor-facing docs and local notes, commit completed milestones.

## Status

- [x] Storage reporting and retention
- [x] Restore guidance
- [x] Notebook import/export
- [x] Verification, review, documentation, and milestone commit

## Verified outcome (2026-10-07)

Python: 243 passed; ruff check/format passed. Extension: lint/build passed,
158 unit tests passed; six intentionally daemon-dependent tests execute in the
restore/rich-output verifiers. Verification ran on macOS with installed VSCode
1.140.0 arm64. Linux dispatch/platform selection has regression coverage here;
a live Linux host and remote GPU/network topology were not exercised.

| Gate | Result |
| --- | --- |
| fast | 29/29 PASS |
| core | 10/10 PASS |
| restore | 9/9 PASS |
| widgets | 3/3 PASS |
| richoutputs | 7/7 PASS |
| notebook | 8/8 PASS |
| livesync | 12/12 PASS |
| enhanced standalone interchange/restore | PASS |

After the final sink ownership fix, restore/widgets/richoutputs/livesync and
the enhanced interchange test were rerun successfully. The new deterministic
lifecycle test fails before the fix and passes after it. Disabling compaction
fails the retention restart assertion; sharing an attachment's file with the
output cache fails export after an output clear. Independent Astra/medium design
and milestone reviews were processed; all actionable findings were fixed.

Tests use a fresh editor profile and Tunnel CLI directory. The active Tunnel
process identity remained unchanged with zero new RPC shutdown requests across
these runs. This observes continuity for these checks, not complete host isolation.
Screenshot/demo/recording tools retain their X11 requirements.
