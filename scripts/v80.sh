#!/usr/bin/env bash
# v80 — REAL VSCode: a window with no saved kernel affinity (fresh profile)
#       auto-attaches a notebook whose file already has a daemon session, with
#       no kernel selection and no command (#32); a never-run file opened in
#       the same window gets no session (no kernel spawned just by opening).
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v80 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v80
FIX="$WORK/known.pynb" # the issue case: a .pynb (tithon-notebook controller)
cat >"$FIX" <<'PY'
# %% loop
import time
for i in range(40):
    print(i, flush=True)
    time.sleep(0.3)
PY
FRESH="$WORK/fresh.py" # the suite derives this path from TITHON_FIXTURE
cat >"$FRESH" <<'PY'
# %% never run
print("never")
PY

start_daemon || fail "daemon start failed"
echo "v80: daemon up (pid $(daemon_pid)); auto-attach without kernel selection under a fresh profile"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="autoattach"
OUT="$(mktemp)"
(cd "$EXT" && run_vscode node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode auto-attach test failed (rc=$rc)"
echo "RESULT v80 PASS real VSCode host: fresh-profile open auto-attached an existing session with no kernel selection; never-run file got no session; $passed_line"
