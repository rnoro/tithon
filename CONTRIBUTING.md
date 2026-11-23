# Contributing to Tithon

Tithon is alpha software. [docs/SPEC.md](docs/SPEC.md) lists the requirements it
must meet. Everything in this repository is written in English: issues, pull
requests, commit messages, code comments and docs.

## Issues first

- Bugs, questions and ideas: [open an issue][issues].
- Code changes: describe the approach in an issue before writing the patch.
  Small, self-evident fixes (a typo, a broken link, a crash with a traceback)
  can go straight to a pull request.
- Changing a requirement in the spec: open an issue that makes the case, and
  update `docs/SPEC.md` in the same pull request that changes the behavior.

A useful bug report includes:

- `$TITHON_HOME/daemon.log` (default `~/.tithon/daemon.log`), from the last
  `attach` before the failure;
- `tithon status` output;
- versions of Tithon, the extension, VSCode and Python;
- OS and connection type (local, Tunnel, Remote-SSH, WSL, container);
- the reproduction as a sequence of events, including whether the client
  disconnected and whether the daemon or host restarted.

## Setup

Python 3.11+ with [uv](https://docs.astral.sh/uv/), and Node for the extension.

```bash
uv sync
uv run pytest -q
uv run ruff check . && uv run ruff format --check .

cd extension
npm ci
npm run lint && npm run build && npm test
```

Run the CLI as `uv run tithon` so you test the tree, not an installed copy.

## Verification

The suite in [scripts/](scripts/) drives real daemons, kernels and VSCode. It
is grouped into bundles:

```bash
make -C scripts fast       # all hermetic tests: the required gate
make -C scripts restore    # one topic bundle
make -C scripts vscode     # all real-VSCode tests
```

Topics: `core` `serializer` `backpressure` `widgets` `restore` `livesync`
`kernels` `richoutputs` `notebook`. `scripts/run_verify.sh` lists the members.
On macOS, install GNU coreutils (`brew install coreutils`).
`TITHON_VSCODE_EXECUTABLE` or `TITHON_VSCODE_VERSION` selects the VSCode build.

A pull request needs:

1. `make -C scripts fast` and the topic bundle for the area you touched, green;
2. the bundle's summary table pasted into the PR body;
3. the lint and build gates for the side you touched;
4. a test for new behavior that fails without the change.

Interrupted runs can leave detached kernels behind. Clear them with:

```bash
pkill -f '[i]pykernel_launcher.*-f /tmp/tithon'
```

## Keeping the tests honest

Fixes, stronger assertions, better isolation and new cases are welcome. Not
allowed: hardcoding a pass, skipping a test, hiding a race with a longer
`sleep`, or replacing a real-process check with a mock. If a script is wrong,
fix it and explain why in the PR.

## Commits and pull requests

- Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`, at most 72 characters). release-please builds the
  version bump and changelog from them.
- Bodies are optional and short. Investigation history belongs in the PR.
- Leave AI model, provider and reviewer names out of commits.
- Branch from `main`, one pull request per issue with `Fixes #N`. Pull requests
  are squash merged.

## Releases

Merging the release-please PR into `main` creates the tags and GitHub releases,
and `release-assets.yml` attaches the wheel, sdist and VSIX. To retry a failed
upload, run **release assets** from the Actions tab with the existing tag.
PyPI and Marketplace publishing are separate steps.

## AI tools

Welcome, with the same bar: run the bundles yourself and read the output before
you submit. Patches whose tests were never run, and bug reports that are
speculation rather than an observed failure, will be closed with a request for
evidence.

## License

[MIT](LICENSE). Contributions are licensed under the same terms.

[issues]: https://github.com/rnoro/tithon/issues
