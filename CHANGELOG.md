# Changelog

## [0.1.2](https://github.com/rnoro/tithon/compare/v0.1.1...v0.1.2) (2026-06-24)


### Features

* `Run All` aborts at the first cell that errors instead of running the rest.


### Bug Fixes

* Kernel lifecycle: a kernel that exits during startup now fails fast, a kernel that dies mid-execution errors the running cell instead of wedging the session, and a session-start failure is surfaced to the client rather than closing the socket silently.
* `input()` no longer deadlocks the kernel; stdin is bridged to the connected client.
* Live output ordering, queue drain after a kernel restart, and output misattribution / false "stale" flags on reconnect.
* An orphaned cell restores its real frozen run time instead of `0.0s`.


### Documentation

* Rewrote the README: clearer problem framing, an architecture diagram, and why a percent-format `.py` beats a JSON `.ipynb` for agent/LLM workflows.


## [0.1.1](https://github.com/rnoro/tithon/compare/v0.1.0...v0.1.1) (2026-06-17)


### Documentation

* Update the README for the latest installation guide.


## 0.1.0 (2026-06-17)


### Features

* Initial alpha release of Tithon.
* Persistent remote interactive Python sessions with a loss-free journal.
* Real-time cell output streaming and widget-state mirroring.
* VSCode extension to sync kernel state losslessly.
