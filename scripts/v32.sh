#!/usr/bin/env bash
# v32 — REAL VSCode + ruff/ty LSP in a tithon-py Cell View.
#   A tithon-py notebook reuses the .py's own file:// URI as the notebook URI, so
#   if the same .py is ALSO open as a plain text editor, notebook-aware Python
#   LSPs (ruff, ty) key one URI as both a text doc AND a notebook doc and desync
#   ("document … isn't open" / "Document controller not available"), killing cell
#   LSP. This launches a real Extension Host with ruff+ty ENABLED, reproduces the
#   coexistence, and asserts: (A) single representation per URI, (B) ruff lints
#   the cell, (C) go-to-definition works from a cell, (D) the go-to target opens
#   as a text editor. Also scans the ruff/ty server logs for the desync errors.
#
# Needs xvfb + the cached @vscode/test-electron VSCode, and the user's installed
# ruff/ty extensions under ~/.vscode-server/extensions. Not part of `make verify`.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v32 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

# Curate an extensions dir with ruff + ty and their hard dependency
# (ms-python.python; debugpy rounds out its pack). Pylance is intentionally
# absent — ruff/ty bring their own language features, mirroring the user setup.
EXTROOT="$HOME/.vscode-server/extensions"
RUFF_DIR="$(ls -d "$EXTROOT"/charliermarsh.ruff-* 2>/dev/null | head -1)"
TY_DIR="$(ls -d "$EXTROOT"/astral-sh.ty-* 2>/dev/null | head -1)"
PY_DIR="$(ls -d "$EXTROOT"/ms-python.python-* 2>/dev/null | head -1)"
DBG_DIR="$(ls -d "$EXTROOT"/ms-python.debugpy-* 2>/dev/null | head -1)"
[ -n "$RUFF_DIR" ] || fail "ruff extension not found under $EXTROOT"
[ -n "$TY_DIR" ]   || fail "ty extension not found under $EXTROOT"
[ -n "$PY_DIR" ]   || fail "ms-python.python (ruff/ty dependency) not found under $EXTROOT"

setup_env v32
LSP_EXT_DIR="$TITHON_HOME/lsp-extensions"
mkdir -p "$LSP_EXT_DIR"
for d in "$RUFF_DIR" "$TY_DIR" "$PY_DIR" "$DBG_DIR"; do
  [ -n "$d" ] && ln -s "$d" "$LSP_EXT_DIR/$(basename "$d")"
done

# Fixture: a cell that (a) has an unused import for ruff to flag (F401) and
# (b) references a symbol defined in a SEPARATE file for go-to-definition.
FIX="$WORK/baseline.py"
HELPER="$WORK/helper.py"
cat >"$HELPER" <<'PY'
def my_helper() -> int:
    return 42
PY
cat >"$FIX" <<'PY'
# %% c1
import os
from helper import my_helper

print("HELLO_LSP", flush=True)
result = my_helper()
PY

# Workspace settings: ruff/ty native servers, bundled binaries (offline), and
# server logs written to files we can scan afterwards.
RUFF_LOG="$TITHON_HOME/ruff.log"
TY_LOG="$TITHON_HOME/ty.log"
mkdir -p "$WORK/.vscode"
cat >"$WORK/.vscode/settings.json" <<JSON
{
  "python.defaultInterpreterPath": "$PY",
  "ruff.nativeServer": "on",
  "ruff.importStrategy": "useBundled",
  "ruff.logLevel": "debug",
  "ruff.logFile": "$RUFF_LOG",
  "ruff.trace.server": "verbose",
  "ty.importStrategy": "useBundled",
  "ty.interpreter": "$PY",
  "ty.diagnosticMode": "openFilesOnly",
  "ty.logLevel": "debug",
  "ty.logFile": "$TY_LOG",
  "ty.trace.server": "verbose"
}
JSON

start_daemon || fail "daemon start failed"
echo "v32: daemon up (pid $(daemon_pid)); ruff=$(basename "$RUFF_DIR") ty=$(basename "$TY_DIR")"

export TITHON_FIXTURE="$FIX" TITHON_HELPER="$HELPER" TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="lsp" TITHON_LSP_EXT_DIR="$LSP_EXT_DIR"
OUT="$(mktemp)"
# Unset ELECTRON_RUN_AS_NODE: inside a VSCode server/tunnel it is inherited as 1
# and would make the spawned desktop Electron run as plain Node.
(cd "$EXT" && env -u ELECTRON_RUN_AS_NODE xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -50
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

# Scan the LSP server logs for the desync signatures the user reported.
scan_desync() { # $1=label $2=logfile
  [ -f "$2" ] || { echo "  $1: (no log written)"; return 0; }
  local n
  n="$(grep -ciE "isn't open|controller not available|document not found|didn't exist" "$2" 2>/dev/null || true)"
  echo "  $1: $n desync line(s) in $(basename "$2")"
  [ "${n:-0}" -gt 0 ] && grep -iE "isn't open|controller not available|document not found|didn't exist" "$2" | tail -4 | sed 's/^/    > /'
  return "${n:-0}"
}
echo "v32: LSP server log scan -----------------------------------------------"
scan_desync ruff "$RUFF_LOG"; ruff_bad=$?
scan_desync ty   "$TY_LOG";   ty_bad=$?

[ "$rc" -eq 0 ] || fail "in-host LSP test failed (rc=$rc) — see output above"
# Guard against a no-op exit-0 (e.g. the host launched but ran no tests): require
# the mocha suite to have actually run and passed.
case "$passed_line" in *passing*) : ;; *) fail "no mocha 'passing' line — the suite did not run";; esac
[ "$ruff_bad" -eq 0 ] || fail "ruff server logged $ruff_bad desync error(s) in the Cell View"
[ "$ty_bad" -eq 0 ] || fail "ty server logged $ty_bad desync error(s) in the Cell View"
echo "RESULT v32 PASS Cell View keeps ruff/ty LSP alive: single representation, ruff lints the cell, go-to-def opens text, no desync in server logs; $passed_line"
