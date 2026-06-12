# Tithon — Phase 0 PoC

원격 GPU 호스트의 인터랙티브 Python 세션을 클라이언트 생사와 무관하게 영속화하고,
재접속 시 셀 출력·진행상황·위젯 상태를 무손실 복원하는 시스템.
설계의 단일 진실: docs/design.md (반드시 먼저 정독. 특히 §3.1 저널/리플레이,
§3.3 위젯 미러, §6 Phase 0 검증 항목 ①~⑥)

## 아키텍처 불변 조건 (위반 금지)
- 커널은 ipykernel 재사용. 커널 프로세스는 데몬의 자식이 아닌 detached(setsid)로
  spawn하고 connection file을 영속화한다 — 데몬 재시작 후 re-attach가 설계의 핵심.
- 모든 iopub/shell 메시지는 SQLite(WAL) 저널에 원본 보존 + 실행별 folded 스냅샷
  (materialized view) 유지.
- 클라이언트 동기화는 단조 증가 seq 기반 snapshot + delta. attach(last_seen_seq) 의미론.
- rich output(image/*)은 base64 임베딩 금지 — .tithon/outputs/ 에 실제 파일로 저장,
  저널엔 참조만.
- 데몬 바인딩은 unix domain socket(0600) 전용. TCP 금지.

## 리포 구조
- daemon/   : Python 3.11+, uv 관리. tithon 패키지(데몬+CLI)
- extension/: TypeScript VSCode 확장 (Stage B)
- verify/   : Phase 0 검증 스크립트 (v1.sh~v6.sh + 공용 lib)
- Makefile  : verify-a (v1~v4), verify-b (v5~v6), verify (전체)

## 작업 루프 규칙 (매 턴 공통)
1. 턴 시작: PROGRESS.md의 "현재 상태 / 다음 단계 / 막힌 것"을 읽고 거기서 이어서 작업한다.
2. 구현 → `make verify-a`(또는 -b) 실행 → **요약 테이블 전체를 대화에 그대로 출력**한다.
   (goal 평가자는 대화만 본다. 출력을 생략하면 진행이 인정되지 않는다)
3. 턴 종료 전: PROGRESS.md 갱신(완료/다음/막힌 것), 의미 있는 설계 판단은 DECISIONS.md에
   ADR 한 줄 요약으로 추가, 마일스톤마다 git commit (메시지: "p0: <항목> <내용>").
4. 같은 실패가 3회 반복되면 같은 방법을 더 시도하지 말 것: 실패 가설을 PROGRESS.md에
   기록하고 접근을 바꾼다(디버그 로그 추가 → 최소 재현 스크립트 분리 → 설계 재검토 순).
5. 컨텍스트가 compact되어도 PROGRESS.md/DECISIONS.md만으로 작업을 복구할 수 있어야 한다 —
   "머릿속에만 있는 상태"를 만들지 말 것. 반복해서 쓰는 환경 지식(예: 커널 spawn 시
   주의점)은 메모리에 저장해 다음 세션에서도 쓰이게 한다.

## 안티치팅 (절대 규칙)
- verify/ 스크립트는 결과를 약화시키는 방향으로 수정 금지. 버그 수정·검증 강화·항목 추가만
  허용하며, 수정 시 DECISIONS.md에 사유를 기록한다. 종료 조건 충족을 위한 PASS 하드코딩,
  테스트 skip, sleep 연장으로 타이밍 회피, mock으로 실제 프로세스 검증 대체 — 전부 금지.
- v4의 kill -9는 진짜 데몬 프로세스에 수행한다. 커널 생존은 PID 동일성 + 커널 내 변수
  상태 연속성으로 이중 확인한다.

## 환경
- Python: uv 사용(uv venv, uv pip install). pytest, jupyter_client, ipykernel,
  websockets(또는 FastAPI). 데몬 로그는 ~/.tithon/daemon.log.
- Node: extension/ 은 npm. 단위는 vitest, VSCode 통합은 @vscode/test-electron + xvfb-run.
- 장시간 명령은 timeout을 걸고, 데몬류는 백그라운드 실행 + 로그 파일 tail로 관찰한다.
