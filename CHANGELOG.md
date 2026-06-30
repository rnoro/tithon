# Changelog

## [0.2.1](https://github.com/rnoro/tithon/compare/v0.2.0...v0.2.1) (2026-06-30)


### Documentation

* update extension/README.md ([4f8a5bc](https://github.com/rnoro/tithon/commit/4f8a5bc9c9c227e6e9a68a02fc2f51589c6cbe05))

## [0.2.0](https://github.com/rnoro/tithon/compare/v0.1.3...v0.2.0) (2026-06-30)


### ⚠ BREAKING CHANGES

* **extension:** tithon.openAsCellView -> tithon.openAsNotebook; tithon.startLive and tithon.restoreOutputs removed (now automatic). Update affected keybindings.

### Code Refactoring

* **extension:** notebook-centric UX (rename "Cell View" -&gt; "Notebook") ([0098c71](https://github.com/rnoro/tithon/commit/0098c7184b3366b2e07d333fd6e18512069c25c7))

## [0.1.3](https://github.com/rnoro/tithon/compare/v0.1.2...v0.1.3) (2026-06-29)


### Features

* **extension:** move "Open as Text Editor" to the tab bar ([6eea7ec](https://github.com/rnoro/tithon/commit/6eea7ec53fae970b5218ca7ba50d2ea9a3cbb4c9))
* terminate a running kernel from VSCode (ADR-061) ([c79b2d8](https://github.com/rnoro/tithon/commit/c79b2d844dbbabf7db3043c012becd6835920681))


### Bug Fixes

* **extension:** keep the .py reopenable after a Cell View↔Text round trip (ADR-065) ([20dce8e](https://github.com/rnoro/tithon/commit/20dce8e9f5f37f7fca56ddfd9fa688a959ddab10))
* **extension:** keep ty go-to-def alive across the Cell View↔Text round trip (ADR-064) ([06cb3c3](https://github.com/rnoro/tithon/commit/06cb3c3412bdd9098277a381285a216c26603feb))
* **extension:** redirect Pylance's a.py.py go-to-definition phantom to the cell ([c8b4fcd](https://github.com/rnoro/tithon/commit/c8b4fcd3cadb8f7bbfe0adc4191748dac74e1fd1))


### Documentation

* note the Pylance same-file go-to-def flicker in the Cell View ([bb22a56](https://github.com/rnoro/tithon/commit/bb22a565b0a072931fae9d14ed9e1cea2bc46720))

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
