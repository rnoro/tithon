#!/usr/bin/env bash
# v2 — folded replay 성능: tqdm 50,000 iteration 셀 완료 후 신규 attach.
# snapshot 수신 완료 2초 이내 + folded 출력이 최종 진행줄 하나 + 저널 raw stream >= 1000이면 PASS.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v2 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

setup_env v2
start_daemon || fail "daemon start failed"

CODE='from tqdm import tqdm
for _ in tqdm(range(50000), mininterval=0, miniters=1):
    pass'
timeout 300 "$TITHON" run -c "$CODE" >/dev/null 2>&1 || fail "tqdm cell failed"

T0=$(date +%s%N)
timeout 30 "$TITHON" attach --since 0 --once >"$TITHON_HOME/attach.ndjson" || fail "attach failed"
T1=$(date +%s%N)
ELAPSED_MS=$(( (T1 - T0) / 1000000 ))

DETAIL="$("$PY" "$ROOT/scripts/_check_v2.py" "$TITHON_HOME" "$ELAPSED_MS")" || fail "$DETAIL"
echo "RESULT v2 PASS $DETAIL"
