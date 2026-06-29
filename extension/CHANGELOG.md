# Changelog

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
