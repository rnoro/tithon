#!/usr/bin/env bash
# v21 — REAL VSCode: restart the kernel from the client (user feedback #5).
#       Cell 0 sets v=42; tithon.restartKernel; cell 1 sees v is gone (fresh
#       namespace) -> "CHECK False".
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v21 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v21
FIX="$WORK/restart.py"
cat >"$FIX" <<'PY'
# %% set
v = 42
print("SET", v, flush=True)

# %% check
print("CHECK", "v" in dir(), flush=True)
PY

start_daemon || fail "daemon start failed"
echo "v21: daemon up (pid $(daemon_pid)); kernel-restart test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="restartkernel"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode kernel-restart test failed (rc=$rc)"
echo "RESULT v21 PASS real VSCode host: restartKernel reset the namespace (v gone after restart); $passed_line"
