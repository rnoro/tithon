"use strict";

const assert = require("node:assert/strict");
const {
  formatReleasePrBody,
  restoreReleasePrBody,
} = require("./format-release-pr-body");

const grouped = `Header
---


<details><summary>0.2.2</summary>

## [0.2.2](https://example.test/compare/v0.2.1...v0.2.2) (2026-08-12)

### Bug Fixes

* Fix daemon

<details><summary>Example inside release notes</summary>
nested details remain intact
</details>
</details>

<details><summary>vscode: 0.3.0</summary>

## [0.3.0](https://example.test/compare/vscode-v0.2.2...vscode-v0.3.0) (2026-08-12)

### Features

* Improve extension
</details>

---
Footer`;

const visible = `Header
---


## tithon 0.2.2

[Compare changes](https://example.test/compare/v0.2.1...v0.2.2) (2026-08-12)

### Bug Fixes

* Fix daemon

<details><summary>Example inside release notes</summary>
nested details remain intact
</details>

## vscode-tithon 0.3.0

[Compare changes](https://example.test/compare/vscode-v0.2.2...vscode-v0.3.0) (2026-08-12)

### Features

* Improve extension

---
Footer`;

assert.equal(formatReleasePrBody(grouped), visible);
assert.equal(formatReleasePrBody(visible), visible);
assert.equal(formatReleasePrBody(restoreReleasePrBody(visible)), visible);

const rootOnly = `Header
---


## [0.2.2](https://example.test/compare/v0.2.1...v0.2.2) (2026-08-12)

* Fix daemon

---
Footer`;
assert.match(formatReleasePrBody(rootOnly), /^## tithon 0\.2\.2$/m);

const extensionOnly = `Header
---


## [0.4.0](https://example.test/compare/vscode-v0.3.0...vscode-v0.4.0) (2026-08-12)

* Improve extension

---
Footer`;
const visibleExtension = formatReleasePrBody(extensionOnly);
assert.match(visibleExtension, /^## vscode-tithon 0\.4\.0$/m);
assert.equal(
  formatReleasePrBody(restoreReleasePrBody(visibleExtension)),
  visibleExtension,
);

const unknown =
  "<details><summary>unknown: 1.0.0</summary>\n\nnotes\n</details>\n\n---\n";
assert.equal(formatReleasePrBody(unknown), unknown);
