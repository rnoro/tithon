#!/usr/bin/env bash
# v65 — REAL VSCode: the destructive-action confirmation gate. Restart Kernel and
#       Restart Daemon must open a modal and touch NOTHING until it is answered.
#       Runs with tithon.confirmDestructiveActions at its shipped default
#       (TITHON_CONFIRM_DESTRUCTIVE=1); every other real-VSCode suite has it off,
#       since no in-host test can answer a modal.
#
#       Two Extension Host runs, one command each: a second modal requested while
#       one is open is DISMISSED, not queued, and a dismissed dialog looks exactly
#       like a gate that never asked. Run A asserts the kernel pid in-host; run B
#       fires Restart Daemon and this script asserts the daemon pid, which an
#       ungated restart would have replaced.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v65 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v65
FIX="$WORK/confirm.py"
cat >"$FIX" <<'PY'
# %% set
v = 42
print("SET", v, flush=True)
PY

start_daemon || fail "daemon start failed"
DPID_BEFORE="$(daemon_pid)"
[ -n "$DPID_BEFORE" ] || fail "no daemon pid"
echo "v65: daemon up (pid $DPID_BEFORE); confirmation-gate test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="confirmdestructive"
export TITHON_CONFIRM_DESTRUCTIVE=1

run_host() { # $1 = kernel|daemon -> echoes the "N passing" line, returns rc
  local out rc
  out="$(mktemp)"
  (cd "$EXT" && TITHON_CONFIRM_TARGET="$1" xvfb-run -a node out-int/integration/runTest.js) >"$out" 2>&1
  rc=$?
  grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$out" | tail -25
  passed_line="$(grep -E '[0-9]+ passing' "$out" | tail -1 | sed 's/^[[:space:]]*//')"
  rm -f "$out"
  return $rc
}

run_host kernel || fail "restart-kernel gate failed (rc=$?)"
kernel_passed="$passed_line"
echo "v65: kernel gate ok ($kernel_passed)"

run_host daemon || fail "restart-daemon gate failed (rc=$?)"
daemon_passed="$passed_line"

# The daemon half. An unanswered "Restart the Tithon daemon?" must leave the very
# same daemon process running — same pid, and still alive.
DPID_AFTER="$(daemon_pid)"
[ "$DPID_AFTER" = "$DPID_BEFORE" ] || \
  fail "daemon restarted despite an unanswered confirmation ($DPID_BEFORE -> $DPID_AFTER)"
kill -0 "$DPID_BEFORE" 2>/dev/null || fail "daemon pid $DPID_BEFORE is not alive"

echo "RESULT v65 PASS real VSCode host: restart kernel/daemon both blocked on an unanswered modal (daemon pid $DPID_BEFORE unchanged); $kernel_passed + $daemon_passed"
