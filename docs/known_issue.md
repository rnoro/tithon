# Tithon — Known Issues

Issues that are understood but not (fully) solvable from the extension side,
with their cause and any workaround. For the design see [`SPEC.md`](./SPEC.md).

---

## Same-file go-to-definition flickers in the Cell View (Pylance only)

**Affected:** Pylance (`ms-python.vscode-pylance`) as the Python language server,
inside a Tithon Cell View (`tithon-py` notebook).

**Symptom.** Go-to-Definition (F12 / Ctrl+Click) on a symbol defined *in the
same `.py`* (e.g. another cell) briefly opens a new editor and closes it again
before the cursor lands on the definition — a visible flicker. Navigation still
ends up on the right cell; it just is not seamless. Go-to-Definition into a
*different* file (a library in `site-packages`, a sibling module) is unaffected.

**Cause.** A `tithon-py` notebook reuses the `.py`'s **own** `file://` URI as the
notebook URI (see ADR-041 — this is what keeps a single representation per URI
and the language server alive inside the cells). For an *in-notebook* definition
Pylance answers with a `file://` location whose path is the notebook path **plus
an extra `.py`**, carrying the target cell's handle in the fragment:

```
file:///path/to/a.py.py#W0sZmlsZQ==
```

For a normal `.ipynb` notebook (`a.ipynb` → `a.ipynb.py`) that pseudo-path
round-trips back to a `vscode-notebook-cell:` URI and navigation stays in the
notebook. But because a Tithon notebook URI already ends in `.py`, the pseudo-
path becomes `a.py.py`, the round-trip never fires, and VSCode opens a phantom
text tab for the non-existent `a.py.py` file.

**Current mitigation (ADR-062).** The extension detects that phantom `*.py.py`
tab as it opens, closes it, and reveals the real cell (guarded so it can never
touch a genuine file literally named `*.py.py`). This is *reactive*: VSCode has
already opened the phantom tab before any extension can run, so a brief
open→close flicker is visible. It cannot be made fully seamless from the
extension, because VSCode **merges** all DefinitionProvider results (we cannot
suppress Pylance's bad location) and exposes no hook *before* the navigation.

**Workaround — use `ty` instead of Pylance.** Astral's
[`ty`](https://github.com/astral-sh/ty) returns the correct
`vscode-notebook-cell:` location for an in-notebook definition, so go-to-def is
**seamless, with no flicker**, and lands on the exact line. If you mainly work
in the Cell View, `ty` (optionally with `ruff` for linting) gives the smoothest
experience today. Pylance remains fully supported — only the same-file go-to-def
animation is affected.

**Possible improvement.** Rebinding F12 to a custom command can make the
*keyboard* path flicker-free under Pylance too (the extension resolves and
rewrites the location itself, never opening the phantom), but the mouse
Ctrl+Click gesture is internal to VSCode and cannot be intercepted, so it would
stay flickery — an inconsistency we have chosen not to ship by default.

**Upstream.** The real fix belongs in Pylance/pyright: a notebook whose URI ends
in `.py` should still round-trip its cell pseudo-paths.

**Verification.** `scripts/v41.sh` (suite `lspdef`) reproduces the Pylance
pseudo-path and asserts the redirect lands on the defining cell with no surviving
`*.py.py` tab.
