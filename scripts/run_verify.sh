#!/usr/bin/env bash
# Runs verify scripts for a stage, prints per-test RESULT table + summary.
# Usage: run_verify.sh a|b|all
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${1:-a}" in
  a) scripts="v1 v2 v3 v4"; label="VERIFY-A" ;;
  b) scripts="v5 v6"; label="VERIFY-B" ;;
  c) scripts="v7 v9 v17 v27"; label="VERIFY-C" ;;   # client restore + backpressure + per-file kernels + rich outputs (hermetic)
  d) scripts="v8 v10 v11 v12 v13 v14 v15 v16 v18 v19 v20 v21 v22 v23 v24 v25 v26 v28 v29 v30"; label="VERIFY-D" ;;  # real VSCode end-to-end (network + xvfb)
  all) scripts="v1 v2 v3 v4 v5 v6 v7 v9"; label="VERIFY" ;;
  *) echo "usage: $0 a|b|c|d|all" >&2; exit 2 ;;
esac

declare -a results=()
pass=0
total=0
for s in $scripts; do
  echo "===== $s ====="
  out="$(mktemp)"
  timeout 600 bash "$ROOT/scripts/$s.sh" 2>&1 | tee "$out"
  line="$(grep -E "^RESULT $s " "$out" | tail -1)"
  rm -f "$out"
  [ -z "$line" ] && line="RESULT $s FAIL (no RESULT line — crashed or timed out)"
  results+=("$line")
  total=$((total + 1))
  case "$line" in "RESULT $s PASS"*) pass=$((pass + 1));; esac
done

echo
echo "==== $label RESULTS ===="
printf '%-4s | %-4s | %s\n' "test" "res" "detail"
printf -- '-----+------+------------------------------------------------------------\n'
for line in "${results[@]}"; do
  t="$(echo "$line" | awk '{print $2}')"
  r="$(echo "$line" | awk '{print $3}')"
  d="$(echo "$line" | cut -d' ' -f4-)"
  printf '%-4s | %-4s | %s\n' "$t" "$r" "$d"
done
echo "$label SUMMARY: $pass/$total PASS"
[ "$pass" -eq "$total" ]
