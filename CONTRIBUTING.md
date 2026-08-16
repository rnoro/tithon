# Contributing to Tithon

Thanks for being here. Tithon keeps a Python session alive on a remote host
independently of the client, so most of its interesting failures only show up on
someone else's machine and under someone else's workflow — the things you hit
that we never would are the point of this file.

Tithon is alpha software with a written design: [docs/SPEC.md](docs/SPEC.md)
describes how it currently works and why. It is a description of today's system,
not a fence around it — see [Changing the design](#changing-the-design).

**Everything here is in English** — issues, pull requests, commit messages, code
comments, and docs

## Open an issue first

- **Bugs, questions, ideas** — [open an issue][issues]. Always welcome, no
  ceremony needed.
- **Code changes** — please sketch the approach in an issue before writing the
  patch. This is about saving your time, not gatekeeping: a change that crosses
  the daemon / journal / fold boundary is a design conversation, and it is
  unfair to discover that after you have written the code.
- Small, self-evident fixes (a typo, a broken link, a crash with a traceback
  attached) can go straight to a pull request.

Some rough edges are already tracked in
[docs/known_issue.md](docs/known_issue.md) — worth a look first.

## Reporting a bug

The daemon outlives the client, so "what the UI showed" is rarely enough to
locate the fault. Useful reports include:

- **The daemon log** — `$TITHON_HOME/daemon.log` (`~/.tithon/daemon.log` by
  default). The interesting window usually starts at the last `attach` before
  things went wrong.
- **`tithon status`** output.
- **Versions** — Tithon (`pip show tithon`), the VSCode extension, VSCode, and
  Python.
- **Environment** — OS and how you connect: local, Tunnel, Remote-SSH, WSL,
  container, cluster login node. Tithon's whole job is surviving a flaky link
  between client and host, so how yours is shaped is diagnostic information.
- **Reproduction as a sequence of session events** — "start daemon → run a cell
  that prints for 30s → close the window → reopen after it finishes → output is
  missing". Whether the client disconnected, and whether the daemon or the host
  restarted, are usually the decisive details.

If you are on a platform Tithon does not support yet, say so in the issue rather
than assuming it is out of scope — that is how support gets planned.

## Development setup

You need Python **3.11 or newer** and Node for the extension. The repo is set up
for [uv](https://docs.astral.sh/uv/) and npm, but nothing stops you using
another toolchain as long as the checks below pass.

Python — from the repo root:

```bash
uv sync                 # runtime deps + the dev group (pytest, ruff, matplotlib, tqdm, ipywidgets)
uv run pytest -q
uv run ruff check . && uv run ruff format --check .
```

`uv sync` provisions a matching interpreter for you, so an older default
`python3` on your machine is not a problem. Run the CLI through `uv run tithon`
(or the project venv) to be sure you are testing the tree and not an installed
copy.

VSCode extension — from `extension/`:

```bash
npm ci
npm run lint            # biome
npm run build           # tsc
npm test                # vitest unit tests
```

The daemon runs in the foreground, so while debugging it is easiest to background
it and tail the log rather than tie up a terminal.

## Verifying a change

Unit tests are not the whole safety net here. Most regressions in Tithon are
cross-process — a kernel that should have survived, a snapshot that arrives one
message short — and those are caught by the verification suite in
[scripts/](scripts/), which drives real daemons and real kernels. It is grouped
into topic bundles:

```bash
make -C scripts fast          # every hermetic test — the required gate
make -C scripts restore       # just the reconnect/restore bundle, etc.
```

Topics: `core` `serializer` `backpressure` `widgets` `restore` `livesync`
`kernels` `richoutputs` `notebook`. Meta bundles: `fast` (all hermetic),
`vscode` (all real-VSCode), `all` (both). `scripts/run_verify.sh` documents what
is in each.

**What a pull request needs:**

1. `make -C scripts fast` green, plus the topic bundle covering the area you
   touched.
2. That suite's summary table pasted into the PR body — "tests pass" without the
   output is not something a reviewer can check.
3. The language gates for the side you touched: `ruff check` / `ruff format
   --check` for Python, `npm run lint` / `npm run build` for the extension.

`make -C scripts vscode` drives a real VSCode instance and needs a display
(xvfb) plus network, so it is a nice-to-have rather than a requirement — just
say in the PR whether you could run it.

New behavior should arrive with a test. If the behavior is cross-process, that
means a script in `scripts/` and an entry in its bundle; if it is pure logic, a
unit test is fine. Adding a case that fails before your fix and passes after is
the most persuasive thing in a PR.

One practical note: the scripts spawn **detached** kernels under a temporary
`/tmp/tithon-*` home, so an interrupted run can leave some behind and make later
runs flaky. Clear them with:

```bash
pkill -f '[i]pykernel_launcher.*-f /tmp/tithon'
```

The `[i]` character class is deliberate — a bare pattern also matches `pkill`'s
own command line.

## Changing the design

Tithon's current behavior rests on a handful of decisions that a lot of the code
quietly depends on. They are listed here so you can tell the difference between
*changing* one and *breaking* one by accident — not to put them beyond
discussion. Each exists for a reason, and a better reason supersedes it.

- The kernel is spawned **detached** rather than as a child of the daemon, with
  its connection file persisted, so it survives the daemon and can be
  re-attached.
- Sessions are **per file (uri)**, isolated from one another and created lazily.
- Messages from the kernel are journaled **verbatim**, with a folded
  per-execution snapshot derived from them, so a reconnecting client can be
  served without replaying everything.
- Client sync is **snapshot + delta over a monotonic sequence number**, which is
  what makes a reconnect lossless rather than best-effort.
- Rich output is stored as **files with references in the journal**, not
  base64 inline, which is what keeps a long-running live plot from growing
  without bound.
- The client-facing binding is a **unix domain socket with 0600 permissions**,
  which is what keeps a session on a shared host private.

If you think one of these should change — a different transport, a different
storage model, a platform that needs a different process model — that is a
welcome conversation. Open an issue, make the case against the property it
currently protects, and update [docs/SPEC.md](docs/SPEC.md) in the same PR that
changes the behavior. The thing to avoid is a patch that silently invalidates
one of them while the spec still claims it holds.

## Keeping the tests honest

The verification suite is only worth anything if it can still fail. Bug fixes,
stronger assertions, better isolation, and new cases are all welcome. What is
not: hardcoding a pass, skipping a test to get green, hiding a race by
lengthening a `sleep`, or replacing a real-process check with a mock. If a
script is wrong, fix the script and explain the reasoning in the PR — a test
that no longer detects its failure is worse than no test.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`, where type is `feat` / `fix` / `refactor` / `test` /
`docs` / `build` / `chore` and scope is optional (`daemon`, `extension`,
`verify`, …).

```text
feat(extension): render ipywidget outputs
fix(daemon): re-attach the kernel after a socket reset
```

This is load-bearing, not cosmetic:
[release-please](https://github.com/googleapis/release-please) derives the
version bump and the CHANGELOG from these subjects, so a malformed one shows up
verbatim in a release note.

- Keep subjects to 72 characters or fewer; bodies optional and short.
- Investigation history belongs in the PR discussion, not in the permanent log.
- Please leave AI model, provider, and reviewer names out of commit subjects and
  bodies.
- `main` is the release branch — base your work on `develop` unless the issue
  says otherwise, and tidy up "fix typo" commits before asking for review.

## Using AI tools

You are welcome to use them. If you point an agent at this repo, give it this
file and [docs/SPEC.md](docs/SPEC.md) — the design rationale is what an agent
cannot infer from the code, and it is what keeps a patch from quietly
invalidating a property something else depends on.

The bar is the same either way, and it is on you rather than the tool: **run the
bundles yourself and read the output before you submit.** A patch whose tests
were never executed, or a bug report that is a model's speculation rather than
an observed failure, costs more to review than it saves — those will be closed
with a request for the missing evidence.

## License

Tithon is [MIT](LICENSE) licensed. By contributing you agree that your
contribution is licensed under the same terms.

[issues]: https://github.com/rnoro/tithon/issues
