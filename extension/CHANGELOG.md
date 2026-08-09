# Changelog

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
