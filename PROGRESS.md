# PROGRESS

## 현재 상태 (2026-06-13)
**Stage B 완료 — `make verify-b` 2/2 PASS (종료코드 0). vitest 25/25, pytest 25/25 통과.**
(Stage A도 그대로 PASS 유지 — `make verify-a` 4/4.)

### Stage B 산출물
- extension/ (TS, npm·vitest): 신규 VSCode 확장 프로젝트
  - `serializer.ts`: percent(`#%%`/`# %%`/`# %% [markdown]`) 파서·직렬화. 물리 라인
    종결자 보존 + 문자열/괄호 인식 마커 탐지 → 바이트 단위 라운드트립(ADR-011).
  - `cellAttach.ts`: 저널 origin(cell_hash) → 셀 부착(1순위 해시, 2순위 range 근접, stale 배지).
  - `widgetRender.ts`: @jupyter-widgets/html-manager로 미러 스냅샷 렌더(ESM loadClass
    서브클래스, ADR-013) + §3.3 폴백(최종 상태 텍스트).
  - `notebookSerializer.ts`/`codeLens.ts`/`daemonClient.ts`/`extension.ts`/
    `widgetRendererEntry.ts`: Cell View·"Run Cell" CodeLens→데몬 execute·위젯 렌더러
    엔트리(스파이크). `tsc -p` 빌드 통과.
  - test/: serializer(코퍼스 8 + 1000케이스 property) · cellAttach · widget(jsdom) = 25 tests.
- daemon/tithon/`widgets.py`: Widget State Mirror(comm 해석, 바이너리 버퍼, widget-state+json).
  daemon.py에 통합(iopub comm 처리 → 미러·저널·브로드캐스트, 스냅샷에 widgets 포함,
  재시작 시 _rebuild_mirror). pytest test_widgets.py 9개(버퍼 포함).
- verify/v5.sh(tqdm 5만→fresh attach FloatProgress value==max==total + jsdom 렌더 + 미러
  유닛) · v6.sh(코퍼스 0바이트 diff + 1000케이스 + cell_hash 부착) · _check_v5.py · corpus/.
- ipywidgets를 daemon/.venv에 추가(tqdm.notebook가 comm 발생시키는 데 필요).

---

## (이전) Stage A 완료 — `make verify-a` 4/4 PASS (종료코드 0), pytest 16/16 통과.

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

### Stage B 후속 (⑥ end-to-end 연결)
- execute 경로에 origin{uri,range} + 데몬 산출 cell_hash(=sha256(code)) 저널 기록 → 스냅샷
  executions[]에 cell_hash·origin 노출. extension `executionsFromSnapshot`가 이를 받아
  `attachOutputs`로 셀 부착 → v6의 cell_hash 매핑이 실데이터로 연결(ADR-014). 구 저널은
  additive 마이그레이션(ALTER TABLE ADD COLUMN cell_hash). pytest 28, vitest 27, verify 6/6.

## 다음 단계 (Phase 0 검증 ①~⑥ 전부 통과 — Phase 1로)
- Phase 0 6항목 PASS: ①~④(Stage A) + ⑤⑥(Stage B). 설계 유효성 확인 완료.
- Phase 1(데몬 MVP)로: 멀티 세션, 실행 큐 가시화, 아티팩트 스토어 확장, systemd 패키징,
  stale 배지/듀얼 뷰 UX.
- ⑤ 통합 검증의 잔여: xvfb/디스플레이 있는 환경에서 @vscode/test-electron 실제 구동
  (현재는 jsdom 대체 — ADR-012).

## 막힌 것
- 없음. (Stage B 함정·대체: html-manager의 webpack require/CSS가 jsdom과 충돌 →
  ESM loadClass 서브클래스 + lib 서브모듈 import로 해소(ADR-013). jsdom 부재 글로벌
  (DragEvent/ResizeObserver/__webpack_public_path__)은 test/setup.ts에서 폴리필.)

## 환경 메모
- uv는 ~/.local/bin/uv (PATH에 추가 필요). venv: daemon/.venv (Python 3.11.15).
  ipywidgets 설치됨(tqdm.notebook comm 발생용).
- 시스템 python3는 3.10이라 사용 금지. 항상 daemon/.venv/bin/{python,tithon} 사용
- verify는 테스트별 mktemp TITHON_HOME으로 격리, trap cleanup으로 데몬+커널 정리
- Node: node v24/npm 11(nvm). extension/ 은 npm. vitest(jsdom는 파일별 docblock).
  v5/v6.sh는 npx를 PATH에서 찾고 없으면 ~/.nvm/versions/node/*/bin 추가. xvfb-run 없음.
