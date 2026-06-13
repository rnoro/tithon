# PROGRESS

## 현재 상태 (2026-06-13)
**Stage A 완료 — `make verify-a` 4/4 PASS (종료코드 0), pytest 16/16 통과.**

- daemon/tithon 패키지: 데몬 + CLI 구현 완료
  - `folding.py`: folded 스냅샷 순수 로직 (\r/\n/\b 터미널 의미론, clear_output(wait),
    update_display_data display_id별 최종본). pytest 16개.
  - `journal.py`: SQLite WAL 저널 (executions/messages/artifacts, §3.1).
    messages.msg_seq(AUTOINCREMENT)가 전역 단조 seq. 라이프사이클은 tithon.queued/
    started/done 의사 메시지로 저널링 → 라이브 브로드캐스트와 리플레이가 동일 형식.
  - `kernel.py`: ipykernel을 setsid(start_new_session)로 detached spawn,
    connection file/pid file을 sessions/default/에 영속화, 데몬 재시작 시
    pid 생존 + /proc cmdline 검사로 re-attach.
  - `daemon.py`: unix socket(0600) WS 서버. attach{last_seen_seq}: 0=풀 스냅샷,
    -1=라이브 전용, >0=저널 delta 리플레이 → sync 마커 → 라이브 스트림(컷오프 중복 제거).
    실행은 FIFO 큐 직렬화. image/png|jpeg는 수신 즉시 .tithon/outputs/ 파일화(sha dedup).
  - `cli.py`: `tithon daemon | run -c [--no-wait] | attach [--since][--once][--until-done] | status`
- verify/: v1~v4 + lib.sh + run_verify.sh + 파이썬 체커(_check_v1~3, _lastseq)
- Makefile: verify-a / verify-b / verify / test

## 다음 단계 (Stage B — 새 세션에서 prompts/stage-b.md)
- v5: VSCode 커스텀 notebook renderer + @jupyter-widgets/html-manager 위젯 렌더/복원
- v6: percent-format NotebookSerializer 바이트 라운드트립 + 저널 출력 셀 부착
- 데몬에 위젯 상태 미러(§3.3 comm 해석) 추가 필요 — Stage A에서는 comm 메시지 미처리

## 막힌 것
- 없음. (해결된 함정은 DECISIONS.md와 메모리 참조: wait_for_ready HB 오판 →
  자체 kernel_info 폴링으로 대체)

## 환경 메모
- uv는 ~/.local/bin/uv (PATH에 추가 필요). venv: daemon/.venv (Python 3.11.15)
- 시스템 python3는 3.10이라 사용 금지. 항상 daemon/.venv/bin/{python,tithon} 사용
- verify는 테스트별 mktemp TITHON_HOME으로 격리, trap cleanup으로 데몬+커널 정리
