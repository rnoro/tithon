#!/usr/bin/env bash
# v7 — ⑦ output restore on reconnect (the missing client half: subscribe -> fold
#      -> restore -> attach). PASS requires both:
#   (1) Client-side fold unit tests (TS port of folding.py: \r/\n/\b, clear_output,
#       execute_result/error, update_display_data, seed/resume) — deterministic.
#   (2) Against a REAL daemon+kernel: submit real cells, let them run, then a
#       *fresh* SessionClient reconnect restores the folded outputs and attaches
#       them to the right document cells by cell_hash; and a client that folded
#       the live raw stream agrees with one seeded from the daemon's snapshot.
# Both are vitest tests in extension/; PASS iff vitest exits 0.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v7 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$d/npx" ] && PATH="$d:$PATH" && break
  done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v7-npm.log 2>&1) || fail "npm install failed"; }

# Real kernel + daemon so the restore test can submit real cells over the socket.
setup_env v7
start_daemon || fail "daemon start failed"
echo "v7: daemon up (pid $(daemon_pid)); restore test will drive it over $TITHON_HOME/daemon.sock"

OUT="$(mktemp)"
# TITHON_HOME is exported by setup_env -> the test's defaultSocketPath() finds the socket.
(cd "$EXT" && NO_COLOR=1 timeout 180 npx vitest run test/outputFold.test.ts test/restore.test.ts) >"$OUT" 2>&1
rc=$?
cat "$OUT"
tests_line="$(grep -E '^[[:space:]]*Tests[[:space:]]+[0-9]+ passed' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
# Guard against the real-daemon test being silently skipped (would hide a regression).
if grep -qE 'restore over a real daemon .* skipped|↓ test/restore.test.ts' "$OUT"; then
  rm -f "$OUT"; fail "restore.test.ts was skipped (no live daemon socket) — not a real verification"
fi
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "vitest non-zero exit ($rc)"
echo "RESULT v7 PASS reconnect restores folded outputs + cell_hash attach over real daemon; client fold == daemon snapshot fold; $tests_line"
