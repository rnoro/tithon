#!/usr/bin/env bash
# v27 — rich outputs (matplotlib + tqdm) over a REAL daemon+kernel (hermetic).
#   matplotlib inline -> image journaled as a $tithon_artifact ref (no base64 in
#     the journal, §3.1) + get_artifact returns the real PNG bytes;
#   terminal tqdm     -> the `\r` stream folds to ONE final bar line (100%);
#   tqdm.notebook     -> the widget mirror restores and the §3.3 text fallback
#     reconstructs the final bar.
# Driven by extension/test/richDaemon.test.ts (vitest) against the live socket.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v27 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$d/npx" ] && PATH="$d:$PATH" && break
  done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"
[ -d "$EXT/node_modules" ] || { (cd "$EXT" && npm install >/tmp/v27-npm.log 2>&1) || fail "npm install failed"; }

# matplotlib is needed for the inline-figure cell; it ships in the daemon venv.
"$PY" -c "import matplotlib, matplotlib_inline" 2>/dev/null \
  || fail "matplotlib/matplotlib_inline missing from daemon venv"

setup_env v27
start_daemon || fail "daemon start failed"
echo "v27: daemon up (pid $(daemon_pid)); rich-output test will drive it over $TITHON_HOME/daemon.sock"

OUT="$(mktemp)"
(cd "$EXT" && NO_COLOR=1 timeout 240 npx vitest run test/richDaemon.test.ts) >"$OUT" 2>&1
rc=$?
cat "$OUT"
tests_line="$(grep -E '^[[:space:]]*Tests[[:space:]]+[0-9]+ passed' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
# Guard against the real-daemon test being silently skipped (would hide a regression).
if grep -qE 'rich outputs over a real daemon .* skipped|↓ test/richDaemon.test.ts' "$OUT"; then
  rm -f "$OUT"; fail "richDaemon.test.ts was skipped (no live daemon socket) — not a real verification"
fi
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "vitest non-zero exit ($rc)"
echo "RESULT v27 PASS matplotlib png artifact+get_artifact; terminal tqdm \\r-fold 100%; tqdm.notebook mirror+text fallback; $tests_line"
