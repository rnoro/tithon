#!/usr/bin/env bash
# v39 — REAL VSCode: a percent-format `.py` (with a `# %%` marker) opened as text
#       auto-switches to the Tithon Cell View (tithon.autoOpenCellView, default
#       on), so the user need not press "Open as Cell View" on every reopen.
#       Asserts: (1) auto-convert on open + single representation, (2) Open as
#       Text switches back AND sticks (no text<->notebook loop), (3) a plain
#       script (no markers) stays text.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v39 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v39
# A percent-format file (auto-opens as Cell View) and a plain script (stays text).
FIX="$WORK/notebook.py"
cat >"$FIX" <<'PY'
# %% greeting
print("HELLO_AUTOCELL", flush=True)

# %% math
x = 6 * 7
print(f"answer = {x}")
PY
PLAIN="$WORK/plain.py"
cat >"$PLAIN" <<'PY'
import os
print("just a script", os.getpid())
PY

start_daemon || fail "daemon start failed"
echo "v39: daemon up (pid $(daemon_pid)); auto-open Cell View test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_HELPER="$PLAIN" TITHON_WORKSPACE="$WORK" TITHON_SUITE="autocellview"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -50
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
[ -z "$passed_line" ] && { rm -f "$OUT"; fail "no mocha 'passing' line (suite did not run)"; }
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode auto-open Cell View test failed (rc=$rc)"
echo "RESULT v39 PASS real VSCode host: percent .py auto-opened as Cell View; Open-as-Text sticks; plain .py stays text; $passed_line"
