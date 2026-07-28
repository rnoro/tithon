#!/usr/bin/env bash
# v52 — REAL VSCode: killing the daemon out from under an OPEN, live notebook
#       must show a reconnect progress notification (RISKS #8/T6) for the whole
#       drop-to-recovery window, not a single ~3s status-bar flash — and it must
#       clear once the daemon auto-respawns (v23's auto-start mechanism) and the
#       client reconnects. Unlike v15/v16 (close+reopen) or v26
#       (the deliberate `tithon.restartDaemon` command), this is a REAL abrupt
#       SIGKILL with the notebook staying open, driving
#       client.onDisconnect -> scheduleReconnect specifically.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v52 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v52
FIX="$WORK/reconnectprogress.py"
cat >"$FIX" <<'PY'
# %% cell
n = (n + 1) if ('n' in dir()) else 1
print(f"RUN {n}")
PY

start_daemon || fail "daemon start failed"
echo "v52: daemon up (pid $(daemon_pid)); reconnect-progress test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="reconnectprogress"
export TITHON_PYTHON="$PY"   # so the extension can auto-respawn the daemon after the kill
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode reconnect-progress test failed (rc=$rc)"
echo "RESULT v52 PASS real VSCode: reconnect progress notification shown across a daemon-kill/auto-respawn cycle; $passed_line"
