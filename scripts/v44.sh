#!/usr/bin/env bash
# v44 — REAL VSCode: after a Cell View -> Text -> Cell View round trip, closing
#       the .py and reopening it must actually open the file.
#
#       Bug (B): post round trip, the URI is left STUCK in cellViewUris with no
#       live notebook, so the single-representation guard (onDidChangeTabs) auto-
#       closes every text editor opened for that .py — the file flashes in the tab
#       bar then closes (Reload Window, which resets the in-memory Set, fixes it).
#       Asserts: (1) no stuck cellViewUris entry after close; (2) the reopened .py
#       leaves a visible editor that STAYS open. No LSP needed (pure tab/state).
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v44 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v44
FIX="$WORK/baseline.py"
cat >"$FIX" <<'PY'
# %% c1
x = 6 * 7
print("ANSWER", x, flush=True)

# %% c2
y = x + 1
print("NEXT", y, flush=True)
PY

start_daemon || fail "daemon start failed"
echo "v44: daemon up (pid $(daemon_pid)); reopen-after-round-trip test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="reopenafterroundtrip"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -50
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
[ -z "$passed_line" ] && { rm -f "$OUT"; fail "no mocha 'passing' line (suite did not run)"; }
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "reopen-after-round-trip test failed (rc=$rc)"
echo "RESULT v44 PASS .py reopens and stays open after the Cell View<->Text round trip; no stuck cellViewUris entry; $passed_line"
