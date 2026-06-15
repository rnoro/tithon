#!/usr/bin/env bash
# v6 — ⑥ percent-format NotebookSerializer.
#   (a) tricky corpus (verify/corpus/*.py) round-trips with a 0-byte diff,
#   (b) fast-check property test: 1,000 random percent files round-trip,
#   (c) journal origin(cell_hash) -> cell attachment mapping unit test.
# All three are vitest tests in extension/; PASS iff vitest exits 0.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v6 FAIL $1"; exit 1; }

EXT="$ROOT/extension"

# Locate node/npx (verify runs under make; node may be on an nvm path).
if ! command -v npx >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$d/npx" ] && PATH="$d:$PATH" && break
  done
fi
command -v npx >/dev/null 2>&1 || fail "npx not found on PATH"

[ -d "$EXT" ] || fail "no extension/ dir"
cd "$EXT" || fail "cannot cd extension"
if [ ! -d node_modules ]; then
  echo "installing extension deps..."
  npm install >/tmp/v6-npm.log 2>&1 || { tail -20 /tmp/v6-npm.log; fail "npm install failed"; }
fi

OUT="$(mktemp)"
NO_COLOR=1 npx vitest run test/serializer.test.ts test/cellAttach.test.ts >"$OUT" 2>&1
rc=$?
cat "$OUT"

corpus=$(ls "$ROOT"/verify/corpus/*.py 2>/dev/null | grep -vc '/_')
tests_line="$(grep -E '^[[:space:]]*Tests[[:space:]]+[0-9]+ passed' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "vitest non-zero exit ($rc)"
echo "RESULT v6 PASS round-trip 0-byte diff on $corpus corpus files + 1000-case property + cell_hash attach mapping; $tests_line"
