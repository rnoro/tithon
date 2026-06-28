#!/usr/bin/env bash
# v42 — REAL VSCode + ty LSP: go-to-definition must survive a Cell View -> Text
#   Editor -> Cell View ROUND TRIP.
#
#   A tithon-py notebook reuses the .py's own file:// URI as the notebook URI
#   (ADR-041), so ty keys both the notebook document and a transient plain text
#   document under the SAME URI. The reported bug: open as Cell View (go-to-def
#   works), switch to the Text Editor and back, and go-to-def is dead while ty
#   floods `notebookDocument/didChange: document not found for key: …/baseline.py`
#   — the notebook<->text switch tore ty's per-URI notebook controller down
#   without a clean didClose/didOpen.
#
#   v32 covers the FIRST open; this drives the round trip and asserts go-to-def
#   STILL resolves into helper.py afterwards, then scans the ty server log for the
#   "document not found" signature (0 required).
#
# Needs xvfb + the cached @vscode/test-electron VSCode and the user's installed
# ruff/ty extensions under ~/.vscode-server/extensions. Not part of `make verify`.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v42 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

# Curate an extensions dir with ruff + ty and their hard dependency
# (ms-python.python; debugpy rounds out its pack). Pylance intentionally absent.
EXTROOT="$HOME/.vscode-server/extensions"
RUFF_DIR="$(ls -d "$EXTROOT"/charliermarsh.ruff-* 2>/dev/null | head -1)"
TY_DIR="$(ls -d "$EXTROOT"/astral-sh.ty-* 2>/dev/null | head -1)"
PY_DIR="$(ls -d "$EXTROOT"/ms-python.python-* 2>/dev/null | head -1)"
DBG_DIR="$(ls -d "$EXTROOT"/ms-python.debugpy-* 2>/dev/null | head -1)"
[ -n "$TY_DIR" ]   || fail "ty extension not found under $EXTROOT"
[ -n "$PY_DIR" ]   || fail "ms-python.python (ty dependency) not found under $EXTROOT"

setup_env v42
LSP_EXT_DIR="$TITHON_HOME/lsp-extensions"
mkdir -p "$LSP_EXT_DIR"
for d in "$RUFF_DIR" "$TY_DIR" "$PY_DIR" "$DBG_DIR"; do
  [ -n "$d" ] && ln -s "$d" "$LSP_EXT_DIR/$(basename "$d")"
done

# Fixture: a cell referencing a symbol defined in a SEPARATE file, so
# go-to-definition has an unambiguous cross-file target (helper.py).
FIX="$WORK/baseline.py"
HELPER="$WORK/helper.py"
cat >"$HELPER" <<'PY'
def my_helper() -> int:
    return 42
PY
cat >"$FIX" <<'PY'
# %% c1
from helper import my_helper

print("HELLO_ROUNDTRIP", flush=True)
result = my_helper()
PY

# Workspace settings: ty native server, bundled binary (offline), verbose server
# trace into a log file we scan afterwards.
TY_LOG="$TITHON_HOME/ty.log"
mkdir -p "$WORK/.vscode"
cat >"$WORK/.vscode/settings.json" <<JSON
{
  "python.defaultInterpreterPath": "$PY",
  "ruff.nativeServer": "on",
  "ruff.importStrategy": "useBundled",
  "ty.importStrategy": "useBundled",
  "ty.interpreter": "$PY",
  "ty.diagnosticMode": "openFilesOnly",
  "ty.logLevel": "debug",
  "ty.logFile": "$TY_LOG",
  "ty.trace.server": "verbose"
}
JSON

start_daemon || fail "daemon start failed"
echo "v42: daemon up (pid $(daemon_pid)); ty=$(basename "$TY_DIR")"

export TITHON_FIXTURE="$FIX" TITHON_HELPER="$HELPER" TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="lsproundtrip" TITHON_LSP_EXT_DIR="$LSP_EXT_DIR"
OUT="$(mktemp)"
# Unset ELECTRON_RUN_AS_NODE (inherited as 1 inside a VSCode server/tunnel).
(cd "$EXT" && env -u ELECTRON_RUN_AS_NODE xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -50
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

# Scan the ty server log for the desync signature the user reported. ty ignores
# the `ty.logFile` setting and writes to VSCode's per-window output-channel log
# dir under the test user-data-dir, so locate the real "ty Language Server" log
# there (the configured $TY_LOG is a fallback). An empty result here would be a
# vacuous pass, so REQUIRE at least one ty log to have been written.
SIG="document not found|controller not available|isn't open|didn't exist"
echo "v42: ty server log scan ------------------------------------------------"
mapfile -t TY_LOGS < <(find "$TITHON_HOME/vscode-user/logs" -name '*ty Language Server*.log' 2>/dev/null)
[ -f "$TY_LOG" ] && TY_LOGS+=("$TY_LOG")
if [ "${#TY_LOGS[@]}" -eq 0 ]; then
  echo "  ty: (no ty server log found — cannot verify the desync signature)"
  ty_bad=1
else
  ty_bad=0
  for lf in "${TY_LOGS[@]}"; do
    n="$(grep -ciE "$SIG" "$lf" 2>/dev/null || true)"
    echo "  ty: $n desync line(s) in ${lf##*/logs/}"
    if [ "${n:-0}" -gt 0 ]; then
      grep -iE "$SIG" "$lf" | tail -4 | sed 's/^/    > /'
      ty_bad=$((ty_bad + n))
    fi
  done
fi

[ "$rc" -eq 0 ] || fail "in-host round-trip go-to-def test failed (rc=$rc) — see output above"
# Guard against a no-op exit-0: require the mocha suite to have actually run.
case "$passed_line" in *passing*) : ;; *) fail "no mocha 'passing' line — the suite did not run";; esac
[ "$ty_bad" -eq 0 ] || fail "ty server logged $ty_bad desync error(s) across the round trip"
echo "RESULT v42 PASS go-to-def survives the Cell View<->Text round trip; no ty desync; $passed_line"
