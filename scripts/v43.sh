#!/usr/bin/env bash
# v43 — REAL VSCode + ty LSP: ty's per-cell analysis (inlay hints + go-to-def)
#   must be IDENTICAL after a Cell View -> Text Editor -> Cell View round trip.
#
#   Follow-up to ADR-064 (which stopped the "document not found" flood): the user
#   reported ty's RENDERING is still broken after the round trip — type inlay
#   hints vanish and the surviving parameter-name hints render at STALE character
#   offsets (a `device=` hint injected mid-`val_loss` -> `val_lodevice=ss`). That
#   is a position-level content desync: ty's text model of the reopened cells no
#   longer matches the editor. This captures the cell's inlay hints fresh, does
#   the round trip, captures them again, and asserts they are byte-identical, then
#   scans the ty server log for desync signatures.
#
# Needs xvfb + the cached @vscode/test-electron VSCode and the user's installed
# ty extension under ~/.vscode-server/extensions. Not part of `make verify`.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v43 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

EXTROOT="$HOME/.vscode-server/extensions"
TY_DIR="$(ls -d "$EXTROOT"/astral-sh.ty-* 2>/dev/null | head -1)"
PY_DIR="$(ls -d "$EXTROOT"/ms-python.python-* 2>/dev/null | head -1)"
DBG_DIR="$(ls -d "$EXTROOT"/ms-python.debugpy-* 2>/dev/null | head -1)"
[ -n "$TY_DIR" ] || fail "ty extension not found under $EXTROOT"
[ -n "$PY_DIR" ] || fail "ms-python.python (ty dependency) not found under $EXTROOT"

setup_env v43
LSP_EXT_DIR="$TITHON_HOME/lsp-extensions"
mkdir -p "$LSP_EXT_DIR"
for d in "$TY_DIR" "$PY_DIR" "$DBG_DIR"; do
  [ -n "$d" ] && ln -s "$d" "$LSP_EXT_DIR/$(basename "$d")"
done

# Fixture mirroring the user's notebook: MARKDOWN cells interspersed with code
# cells that have type-inferable assignments and positional call sites (so ty
# emits BOTH variable-type inlay hints `x: int` and parameter-name hints
# `scale(value=…)`), plus a printing loop so a live-output notebookDocument/
# didChange stream hits ty after the reopen — the two factors present in the
# real repro (markdown cells + live output) and absent from a bare round trip.
FIX="$WORK/baseline.py"
cat >"$FIX" <<'PY'
# %% [markdown]
# # Training

# %% c1
def scale(value: int, factor: int) -> int:
    return value * factor

class Tensor:
    def to(self, device: str) -> "Tensor":
        return self

base = 10
device = "cpu"
t = Tensor()

# %% [markdown]
# ## Training Loop

# %% c2
train_length, valid_length = 100, 20
total = 0
for i in range(base):
    x = scale(i, base)
    t.to(device)
    total = total + x
    print("step", i, total, flush=True)
val_loss = 0
val_loss += scale(total, base)
acc = scale(base, base)
print(train_length, valid_length, total, val_loss, acc)
PY

TY_LOG="$TITHON_HOME/ty.log"
mkdir -p "$WORK/.vscode"
cat >"$WORK/.vscode/settings.json" <<JSON
{
  "python.defaultInterpreterPath": "$PY",
  "ty.importStrategy": "useBundled",
  "ty.interpreter": "$PY",
  "ty.diagnosticMode": "openFilesOnly",
  "ty.logLevel": "debug",
  "ty.logFile": "$TY_LOG",
  "ty.trace.server": "verbose",
  "editor.inlayHints.enabled": "on"
}
JSON

start_daemon || fail "daemon start failed"
echo "v43: daemon up (pid $(daemon_pid)); ty=$(basename "$TY_DIR")"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK"
export TITHON_SUITE="lspinlay" TITHON_LSP_EXT_DIR="$LSP_EXT_DIR"
OUT="$(mktemp)"
(cd "$EXT" && env -u ELECTRON_RUN_AS_NODE xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -60
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

# Scan the REAL ty output-channel log (ty ignores `ty.logFile`).
SIG="document not found|controller not available|isn't open|didn't exist"
echo "v43: ty server log scan ------------------------------------------------"
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
    [ "${n:-0}" -gt 0 ] && { grep -iE "$SIG" "$lf" | tail -4 | sed 's/^/    > /'; ty_bad=$((ty_bad + n)); }
  done
fi

[ "$rc" -eq 0 ] || fail "in-host inlay round-trip test failed (rc=$rc) — see output above"
case "$passed_line" in *passing*) : ;; *) fail "no mocha 'passing' line — the suite did not run";; esac
[ "$ty_bad" -eq 0 ] || fail "ty server logged $ty_bad desync error(s) across the round trip"
echo "RESULT v43 PASS ty inlay hints + go-to-def identical after the Cell View<->Text round trip; no desync; $passed_line"
