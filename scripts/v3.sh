#!/usr/bin/env bash
# v3 — 아티팩트: matplotlib inline sin 곡선 plot. .tithon/outputs/에 유효 PNG(매직넘버),
# 저널이 그 경로를 참조, 신규 attach 시 해당 참조 전달이면 PASS.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v3 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

setup_env v3
start_daemon || fail "daemon start failed"

CODE='%matplotlib inline
import numpy as np
import matplotlib.pyplot as plt
x = np.linspace(0, 2 * np.pi, 200)
plt.plot(x, np.sin(x))
plt.title("sin")
plt.show()'
timeout 120 "$TITHON" run -c "$CODE" >/dev/null || fail "plot cell failed"

timeout 30 "$TITHON" attach --since 0 --once >"$TITHON_HOME/attach.ndjson" || fail "attach failed"

DETAIL="$("$PY" "$ROOT/verify/_check_v3.py" "$TITHON_HOME" "$WORK")" || fail "$DETAIL"
echo "RESULT v3 PASS $DETAIL"
