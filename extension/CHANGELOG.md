# Changelog

## [0.2.1](https://github.com/rnoro/tithon/compare/vscode-v0.2.0...vscode-v0.2.1) (2026-08-08)


### Features

* **daemon:** add opt-in idle kernel cleanup ([6e18554](https://github.com/rnoro/tithon/commit/6e18554c025b72423288d6ab5c5871da7073888c))
* **daemon:** add payload replay and kernel watchdog ([4f05dfd](https://github.com/rnoro/tithon/commit/4f05dfd5fa0cecfbc2623fb5bb00030ba76206c5))
* **daemon:** warn after unrecoverable kernel death ([cffc3fa](https://github.com/rnoro/tithon/commit/cffc3fa79eb41130eba10a604eee062574bb4e24))
* **extension:** improve traceback and reconnect UX ([15c4871](https://github.com/rnoro/tithon/commit/15c4871046eb1798cdfbe574baaede812854cfd1))
* **extension:** render only display-safe widgets ([4ed5db6](https://github.com/rnoro/tithon/commit/4ed5db66f5e3632f99525526efc0dd26cf6e9306))
* **widgets:** sync binary comm buffers ([42122b9](https://github.com/rnoro/tithon/commit/42122b9aa1ac9ac43d5fbaafc7199283f630a23a))


### Bug Fixes

* **daemon,extension:** close restart and sync races ([853b7d7](https://github.com/rnoro/tithon/commit/853b7d7e3a76bf25b2f5534250e573a7af6f7607))
* **daemon,extension:** close session lifecycle races ([469ea90](https://github.com/rnoro/tithon/commit/469ea90af804c440bb8994f5d02183d829298642))
* **daemon:** scope an Output widget's clear_output to its own area ([56d96f8](https://github.com/rnoro/tithon/commit/56d96f8a4fb426dff707b802bffa20dbcc692c08))
* **daemon:** unify widget event frames ([3942412](https://github.com/rnoro/tithon/commit/394241263a29d1a2969157f46a3a8d0e7dcd7af1))
* **extension:** cancel pending live-sync flushes ([19b8c58](https://github.com/rnoro/tithon/commit/19b8c582d7d12d324a02bfc8eac276237da56979))
* **extension:** defer output-map teardown ([e29f5c4](https://github.com/rnoro/tithon/commit/e29f5c4b64fbb139fe190b5ab7e78ea85b376ff2))
* **extension:** drop an Output widget's redundant placeholder output ([fdf1b53](https://github.com/rnoro/tithon/commit/fdf1b535b5a77c9a7165de45486b33686f1933bc))
* **extension:** honour an Output widget's clear on the live path too ([7341032](https://github.com/rnoro/tithon/commit/73410329461dee4c602cbb952f87368615a4fa21))
* **extension:** make widget text follow the VSCode theme ([f76da20](https://github.com/rnoro/tithon/commit/f76da205332275a45c4a507eefdb56b0fe8fb99d))
* **extension:** preserve mixed outputs on restore ([8c1bc6a](https://github.com/rnoro/tithon/commit/8c1bc6a6b4d60283f65e75e3812d4b61c38152fe))
* **verify:** build the widget renderer bundle in the verify path ([f22e0c7](https://github.com/rnoro/tithon/commit/f22e0c7731250934c2159504742817ad45030aed))

## [0.2.0](https://github.com/rnoro/tithon/compare/vscode-v0.1.1...vscode-v0.2.0) (2026-06-30)


### ⚠ BREAKING CHANGES

* **extension:** tithon.openAsCellView -> tithon.openAsNotebook; tithon.startLive and tithon.restoreOutputs removed (now automatic). Update affected keybindings.

### Code Refactoring

* **extension:** notebook-centric UX (rename "Cell View" -&gt; "Notebook") ([0098c71](https://github.com/rnoro/tithon/commit/0098c7184b3366b2e07d333fd6e18512069c25c7))

## [0.1.1](https://github.com/rnoro/tithon/compare/vscode-v0.1.0...vscode-v0.1.1) (2026-06-29)


### Features

* **extension:** move "Open as Text Editor" to the tab bar ([6eea7ec](https://github.com/rnoro/tithon/commit/6eea7ec53fae970b5218ca7ba50d2ea9a3cbb4c9))
* terminate a running kernel from VSCode (ADR-061) ([c79b2d8](https://github.com/rnoro/tithon/commit/c79b2d844dbbabf7db3043c012becd6835920681))


### Bug Fixes

* **extension:** keep the .py reopenable after a Cell View↔Text round trip (ADR-065) ([20dce8e](https://github.com/rnoro/tithon/commit/20dce8e9f5f37f7fca56ddfd9fa688a959ddab10))
* **extension:** keep ty go-to-def alive across the Cell View↔Text round trip (ADR-064) ([06cb3c3](https://github.com/rnoro/tithon/commit/06cb3c3412bdd9098277a381285a216c26603feb))
* **extension:** redirect Pylance's a.py.py go-to-definition phantom to the cell ([c8b4fcd](https://github.com/rnoro/tithon/commit/c8b4fcd3cadb8f7bbfe0adc4191748dac74e1fd1))

## 0.1.0 (2026-06-24)

Initial release.


### Features

* **Cell View** for percent-format `.py` files — open a file with `# %%` markers as notebook-style cells and run them with the **Run Cell** / **Run All** CodeLens. The `.py` stays pure source; outputs never touch the file.
* **Live Output Sync** — stream stdout/stderr, rich outputs, and progress into cells in real time as the kernel produces them.
* **Restore Cell Outputs from Daemon** — on reconnect or reopen, restore the daemon's folded output snapshot into cells. Outputs are matched by content hash and flagged stale when their cell was edited after it ran.
* **ipywidgets rendering** — `tqdm` bars, sliders, and other widgets render and come back at their real value from the widget-state mirror.
* **matplotlib / image output** rendering.
* **Auto-reconnect** — the live view reconnects when the daemon drops the client.
* Settings to auto-start the host daemon, and to configure the daemon command or Python interpreter.
