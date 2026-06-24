# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-06-24

### Added

- `Run All` aborts at the first cell that errors instead of running the rest.

### Changed

- Rewrote the README: clearer problem framing, an architecture diagram, and why
  a percent-format `.py` beats a JSON `.ipynb` for agent/LLM workflows.

### Fixed

- Kernel lifecycle: a kernel that exits during startup now fails fast, a kernel
  that dies mid-execution errors the running cell instead of wedging the session,
  and a session-start failure is surfaced to the client rather than closing the
  socket silently.
- `input()` no longer deadlocks the kernel; stdin is bridged to the connected
  client.
- Live output ordering, queue drain after a kernel restart, and output
  misattribution / false "stale" flags on reconnect.
- An orphaned cell restores its real frozen run time instead of `0.0s`.

## [0.1.1] - 2026-06-17

### Changed

- Update README for latest installiation guide

## [0.1.0] - 2026-06-17

### Added

- Initial alpha release of Tithon.
- Persistent remote interactive Python sessions with loss-free journal.
- Real-time cell output streaming and widget state mirroring.
- VSCode extension to sync kernel state losslessly.
