#!/usr/bin/env bash
# v1 — 출력 무손실: 60개 메시지(0.1s 간격) 출력 셀 실행 중 attach→detach→re-attach 3회.
# 최종 수신 시퀀스가 0..59 무결(gap/중복 없음)이고 저널 내용과 일치하면 PASS.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v1 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

setup_env v1
start_daemon || fail "daemon start failed"

CODE='import time
for i in range(60):
    print(f"MSG {i}", flush=True)
    time.sleep(0.1)'
timeout 15 "$TITHON" run --no-wait -c "$CODE" >/dev/null || fail "cell submit failed"

LAST=0
for i in 1 2 3; do
  if [ "$i" -lt 3 ]; then
    timeout 2 "$TITHON" attach --since "$LAST" >"$TITHON_HOME/attach$i.ndjson"
    sleep 0.5  # stay detached while the cell keeps printing
  else
    timeout 30 "$TITHON" attach --since "$LAST" --until-done >"$TITHON_HOME/attach$i.ndjson" \
      || fail "final attach did not observe done"
  fi
  LAST="$("$PY" "$ROOT/scripts/_lastseq.py" "$TITHON_HOME/attach$i.ndjson" "$LAST")" || fail "lastseq parse"
done

DETAIL="$("$PY" "$ROOT/scripts/_check_v1.py" "$TITHON_HOME")" || fail "$DETAIL"
echo "RESULT v1 PASS $DETAIL"
