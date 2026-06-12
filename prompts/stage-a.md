docs/design.md를 정독한 뒤, Tithon Phase 0 Stage A를 구현해.

## 만들 것
1) daemon/ 에 tithon 데몬 최소본:
   - `tithon daemon`: unix socket(기본 ~/.tithon/daemon.sock)에서 WS 서버 구동.
     세션 1개 고정("default"). ipykernel을 setsid로 spawn하고 connection file을
     ~/.tithon/sessions/default/ 에 영속화. 데몬 시작 시 기존 connection file이 살아있는
     커널을 가리키면 spawn 대신 re-attach.
   - 저널: SQLite WAL. executions/messages/artifacts 테이블(설계서 §3.1 스키마).
     iopub 원본 보존 + 실행별 folded 스냅샷(stream의 \r 의미론, clear_output,
     update_display_data의 display_id별 최종본 반영).
   - 프로토콜: attach{last_seen_seq} → snapshot+delta, execute{code}, 이벤트 브로드캐스트
     (queued/started/output/done), 모든 이벤트에 단조 seq 부여.
   - image/png 등 rich mime은 .tithon/outputs/ 파일 저장(sha 기반 파일명) + 저널 참조.
2) CLI 클라이언트: `tithon run -c "<code>"`, `tithon attach [--since SEQ] [--once]`,
   `tithon status`.
3) verify/v1.sh ~ v4.sh + `make verify-a`:
   - v1 출력 무손실: 60개 메시지를 0.1s 간격으로 출력하는 셀을 백그라운드 실행 중
     attach→detach→re-attach를 3회 반복. 최종 수신 시퀀스가 0..59 무결(gap/중복 없음)이고
     저널 내용과 일치하면 PASS.
   - v2 folded replay 성능: tqdm 50,000 iteration 셀 완료 후 신규 attach. snapshot 수신
     완료가 2초 이내, folded 출력이 최종 진행줄 하나로 접혀 있고, 저널의 raw stream 메시지
     수가 1,000개 이상(원본 보존 증명)이면 PASS.
   - v3 아티팩트: matplotlib inline으로 sin 곡선 plot 셀 실행. .tithon/outputs/ 에 유효
     PNG가 생성되고(매직넘버 검사), 저널이 그 경로를 참조하며, 신규 attach 시 해당 참조가
     전달되면 PASS.
   - v4 데몬 크래시 생존: 1초마다 x를 증가시키는 셀 실행 중 데몬을 kill -9 → 재시작 →
     re-attach. 커널 PID가 동일하고, 이후 x 조회 값이 크래시 직전 마지막 관측치보다 크면
     (인메모리 상태 연속성) PASS.
   각 스크립트는 마지막 줄에 `RESULT v{N} PASS|FAIL <사유>`를 출력하고, make verify-a는
   각 RESULT를 모은 테이블 뒤 `VERIFY-A SUMMARY: {n}/4 PASS`로 끝난다.

## 진행 방식
- CLAUDE.md의 작업 루프 규칙과 안티치팅 규칙을 따른다. 매 턴 make verify-a 출력 전체를
  대화에 표출할 것.
- 구현 순서 권장: folded 스냅샷 로직(순수 함수, pytest 단위 테스트 먼저) → 커널
  spawn/re-attach → 저널 → WS 프로토콜 → CLI → verify 스크립트. pytest 단위 테스트는
  verify와 별개로 계속 유지·통과시킨다.
