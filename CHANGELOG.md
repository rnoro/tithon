# Changelog

## [0.2.2](https://github.com/rnoro/tithon/compare/v0.2.1...v0.2.2) (2026-08-09)


### Features

* resolve a display_id session-wide, not per execution ([e45a407](https://github.com/rnoro/tithon/commit/e45a40767d521163a4aaca0a968a95a1ec70ad85))


### Bug Fixes

* **extension:** simplify status UI and recovery demo ([23744f4](https://github.com/rnoro/tithon/commit/23744f423b83a59dd68a851ceee37cbacafd9fd1))


### Documentation

* cut the README GIF from 7.6MB to 2.6MB ([6f71a1b](https://github.com/rnoro/tithon/commit/6f71a1ba785f202978fa9b6babf29c7781362a0b))
* refocus the landing page on what Tithon does ([71f93da](https://github.com/rnoro/tithon/commit/71f93da473e4adfe79d8e9a1277bb30dca513dce))

## [0.2.1](https://github.com/rnoro/tithon/compare/v0.2.0...v0.2.1) (2026-08-08)


### Features

* **daemon:** add opt-in idle kernel cleanup ([6e18554](https://github.com/rnoro/tithon/commit/6e18554c025b72423288d6ab5c5871da7073888c))
* **daemon:** add payload replay and kernel watchdog ([4f05dfd](https://github.com/rnoro/tithon/commit/4f05dfd5fa0cecfbc2623fb5bb00030ba76206c5))
* **daemon:** add reply routing and completion barrier ([bf68a82](https://github.com/rnoro/tithon/commit/bf68a82a3889ad729ead5928bf3d1ba9b95a4b85))
* **daemon:** warn after unrecoverable kernel death ([cffc3fa](https://github.com/rnoro/tithon/commit/cffc3fa79eb41130eba10a604eee062574bb4e24))
* **extension:** improve traceback and reconnect UX ([15c4871](https://github.com/rnoro/tithon/commit/15c4871046eb1798cdfbe574baaede812854cfd1))
* **extension:** render only display-safe widgets ([4ed5db6](https://github.com/rnoro/tithon/commit/4ed5db66f5e3632f99525526efc0dd26cf6e9306))
* **site:** add reconnect landing page ([3a3f8b3](https://github.com/rnoro/tithon/commit/3a3f8b363cc0a85a248c33edd292d2c9ffc99a5f))
* **widgets:** sync binary comm buffers ([42122b9](https://github.com/rnoro/tithon/commit/42122b9aa1ac9ac43d5fbaafc7199283f630a23a))


### Bug Fixes

* **daemon,extension:** close restart and sync races ([853b7d7](https://github.com/rnoro/tithon/commit/853b7d7e3a76bf25b2f5534250e573a7af6f7607))
* **daemon,extension:** close session lifecycle races ([469ea90](https://github.com/rnoro/tithon/commit/469ea90af804c440bb8994f5d02183d829298642))
* **daemon:** persist comms before mirror updates ([8716588](https://github.com/rnoro/tithon/commit/87165886471e9906f5fae4da79d03ad3b658dd9c))
* **daemon:** recover output after daemon restart ([0c34c45](https://github.com/rnoro/tithon/commit/0c34c45019f330f5788aeafb497fb35a793bf2fc))
* **daemon:** scope an Output widget's clear_output to its own area ([56d96f8](https://github.com/rnoro/tithon/commit/56d96f8a4fb426dff707b802bffa20dbcc692c08))
* **daemon:** unify widget event frames ([3942412](https://github.com/rnoro/tithon/commit/394241263a29d1a2969157f46a3a8d0e7dcd7af1))
* **extension:** cancel pending live-sync flushes ([19b8c58](https://github.com/rnoro/tithon/commit/19b8c582d7d12d324a02bfc8eac276237da56979))
* **extension:** defer output-map teardown ([e29f5c4](https://github.com/rnoro/tithon/commit/e29f5c4b64fbb139fe190b5ab7e78ea85b376ff2))
* **extension:** drop an Output widget's redundant placeholder output ([fdf1b53](https://github.com/rnoro/tithon/commit/fdf1b535b5a77c9a7165de45486b33686f1933bc))
* **extension:** honour an Output widget's clear on the live path too ([7341032](https://github.com/rnoro/tithon/commit/73410329461dee4c602cbb952f87368615a4fa21))
* **extension:** make widget text follow the VSCode theme ([f76da20](https://github.com/rnoro/tithon/commit/f76da205332275a45c4a507eefdb56b0fe8fb99d))
* **extension:** preserve mixed outputs on restore ([8c1bc6a](https://github.com/rnoro/tithon/commit/8c1bc6a6b4d60283f65e75e3812d4b61c38152fe))
* **tooling:** pin review model configuration ([4c32d3f](https://github.com/rnoro/tithon/commit/4c32d3f59d4884532bbb5e3f876af6c472cf1f29))
* **verify:** build the widget renderer bundle in the verify path ([f22e0c7](https://github.com/rnoro/tithon/commit/f22e0c7731250934c2159504742817ad45030aed))
* **verify:** reap every session's kernel, not just `default` ([1fffa82](https://github.com/rnoro/tithon/commit/1fffa829fa079fae443293a4fbe5c455c555da0a))


### Performance Improvements

* **daemon:** stream validated widget journal rows ([45e5c11](https://github.com/rnoro/tithon/commit/45e5c111a2d7b704b99aaf68068c371cb6119233))


### Documentation

* **analysis:** consolidate VSCode comparison ([7919959](https://github.com/rnoro/tithon/commit/7919959642f5d7ff90e72cd63b1ede383663763a))
* **analysis:** document delegation retrospective ([40cc785](https://github.com/rnoro/tithon/commit/40cc78597b17827e1f6673ccc6ff63444aa60e08))
* **analysis:** document vscode-jupyter comparison ([ff32dea](https://github.com/rnoro/tithon/commit/ff32dea5a62eb8249d731c4c158e11b7cccee9c0))
* **analysis:** mark which vscode-jupyter comparison items still apply ([f3bc002](https://github.com/rnoro/tithon/commit/f3bc00280b7813f17a65e883d824367b0da403dd))
* **analysis:** update vscode-jupyter comparison ([c7a02dc](https://github.com/rnoro/tithon/commit/c7a02dc66e7e9afd4e4b5c9c037438e161225c72))
* **daemon:** consolidate source invariants ([43a77f4](https://github.com/rnoro/tithon/commit/43a77f449facbcf0349dc60998962a4f4d4b57a7))
* lead the README with the demo and a one-line hook ([23adbff](https://github.com/rnoro/tithon/commit/23adbff3b763400035fa673367f28b0ab2446dca))
* raise the demo to a produced 1080p master and README GIF ([0e62825](https://github.com/rnoro/tithon/commit/0e62825722505cce09f86224443a4936bd1ff955))
* rebuild README demo with Remotion ([fd56fec](https://github.com/rnoro/tithon/commit/fd56fec703ef1bdce157be11246621b5a550f9fe))
* update demo video ([869ffa8](https://github.com/rnoro/tithon/commit/869ffa8ba251217300d4cbf5f362fc777cf27aef))
* update extension/README.md ([9e98c54](https://github.com/rnoro/tithon/commit/9e98c54b52943de42891cc02fc463913900e5051))
* update README.md ([8311207](https://github.com/rnoro/tithon/commit/831120741a04decd64ca5712dd746643480663b0))

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
