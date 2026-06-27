#!/usr/bin/env bash
# v41 — REAL VSCode + Pylance: SAME-file go-to-definition in a tithon-py Cell
#   View must NOT open a phantom `a.py.py` file.
#
#   A tithon-py notebook reuses the .py's own file:// uri as the notebook uri
#   (ADR-041). For an in-notebook definition Pylance returns a `file://` Location
#   whose path is the notebook path plus an EXTRA `.py` (cell handle in the
#   fragment) — e.g. `file:///x/a.py.py#W0..`. For `.ipynb` that pseudo-path
#   round-trips back to a cell uri, but here it becomes `a.py.py` and VSCode
#   opens a phantom text tab for the non-existent file. The extension detects
#   that phantom tab and redirects to the real cell. This launches a real
#   Extension Host with Pylance ENABLED and asserts: go-to-def from one cell to a
#   symbol defined in another cell leaves NO `*.py.py` tab and lands on the
#   defining cell in the notebook.
#
# Needs xvfb + the cached @vscode/test-electron VSCode and the user's installed
# Pylance (+ ms-python.python) under ~/.vscode-server/extensions. Not in `make verify`.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v41 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

# Curate an extensions dir with Pylance + its host ms-python.python.
EXTROOT="$HOME/.vscode-server/extensions"
PYLANCE_DIR="$(ls -d "$EXTROOT"/ms-python.vscode-pylance-* 2>/dev/null | sort | tail -1)"
PY_DIR="$(ls -d "$EXTROOT"/ms-python.python-* 2>/dev/null | head -1)"
[ -n "$PYLANCE_DIR" ] || fail "Pylance (ms-python.vscode-pylance) not found under $EXTROOT"
[ -n "$PY_DIR" ]      || fail "ms-python.python (Pylance host) not found under $EXTROOT"

setup_env v41
LSP_EXT_DIR="$TITHON_HOME/lsp-extensions"
mkdir -p "$LSP_EXT_DIR"
for d in "$PYLANCE_DIR" "$PY_DIR"; do
  [ -n "$d" ] && ln -s "$d" "$LSP_EXT_DIR/$(basename "$d")"
done

# Fixture: a function DEFINED in the first cell and USED in the last cell, so
# go-to-definition crosses cells inside the SAME .py (the reported case).
FIX="$WORK/baseline.py"
cat >"$FIX" <<'PY'
# %% c1
def my_func() -> int:
    return 42

# %% c2
print("HELLO_DEF", flush=True)
x = my_func()
PY

# Pylance as the language server, pointed at the repo venv.
mkdir -p "$WORK/.vscode"
cat >"$WORK/.vscode/settings.json" <<JSON
{
  "python.defaultInterpreterPath": "$ROOT/.venv/bin/python",
  "python.languageServer": "Pylance"
}
JSON

start_daemon || fail "daemon start failed"
echo "v41: daemon up (pid $(daemon_pid)); pylance=$(basename "$PYLANCE_DIR")"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="lspdef" TITHON_LSP_EXT_DIR="$LSP_EXT_DIR"
OUT="$(mktemp)"
# Unset ELECTRON_RUN_AS_NODE (inherited as 1 inside a VSCode server/tunnel).
(cd "$EXT" && env -u ELECTRON_RUN_AS_NODE xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -50
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "in-host Pylance go-to-def test failed (rc=$rc) — see output above"
# Guard against a no-op exit-0: require the mocha suite to have actually run.
case "$passed_line" in *passing*) : ;; *) fail "no mocha 'passing' line — the suite did not run";; esac
echo "RESULT v41 PASS same-file go-to-def stays in the Cell View: no phantom a.py.py tab, lands on the defining cell; $passed_line"
