# PROGRESS

## 현재 상태 (2026-06-13)
**Phase 1 + 실 tunnel 사용자 버그(#1/#2) 수정. `make verify` 8/8 + `make verify-d` 4/4 PASS.**
재접속 1회 복원(v7/v8)을 넘어 **실행 중 출력을 실 VSCode 셀에 라이브 스트리밍**(v10)하고,
렌더 비용을 coalescing으로 상한 지었으며(5만 이벤트→1 sink 호출), 느린 클라이언트로부터
**GPU 호스트를 보호**하는 백프레셔(v9 + pytest)를 추가했다.

### 실 tunnel 사용자 버그 수정 (ADR-019, v11/v12)
실제 VSCode tunnel 사용에서 보고된 두 버그를 재현·수정:
- **#1 셀 실행해도 출력 안 보임** (restoreOutputs 수동 실행해야 보임): DaemonClient.execute가
  ack 직후 소켓 close → 출력 도착 전 구독자 없음. 네이티브 play의 executeHandler는 무동작이었음.
  → executeHandler/CodeLens가 제출 전 `ensureLive()`로 영속 구독자 attach. **실 VSCode v11**로 검증.
- **#2 모두 실행 시 마지막 셀 출력만 맨 위 셀에 표시**: restore의 `attachOutputs` proximity 폴백이
  전역/영속 저널의 hash 불일치 실행들을 range {0,0}/cell-index로 비교해 전부 cell 0에 collapse.
  → `attachOutputs`를 **정확 cell_hash 일치 전용**(불일치 skip)으로, `restoreInto(cells, fileUri)`로
  **현재 파일 uri 스코프**, executeHandler origin.range를 **line range로 통일**. 회귀: cellAttach.test
  (collapse→0 부착) + **실 VSCode v12**(blank-line 멀티셀 각자 셀 매핑).
- verify-d = v8 v10 v11 v12 (run_verify.sh `d`). integration/suite에 runcell/multicell 추가.
- **#3 +Code로 추가한 셀 저장 시 마커 glue** (`print("x")# %%` → 재오픈 시 3셀이 1셀로 붕괴):
  synthesizeCell이 마지막 줄 terminator를 ""로 둔 탓. serializer.ts `bodyLinesFromText()`(순수,
  모든 줄 "\n" 종결+끝개행 1개 정규화)로 수정, synthesizeCell이 사용. 기존 셀 verbatim 불변(ADR-011).
  회귀: serializer.test.ts(glue 금지 + 3셀 라운드트립). ADR-020.
- **#4 매핑을 메모리 노트북 셀에서 산출** (ADR-021): 0.0.2 설치 후에도 출력이 안 뜬 원인 — startLive/
  restore가 디스크 .py를 다시 parse해 hashIndex를 만들었는데, 손상된 test.py(옛 glue로 1셀 붕괴)나
  저장 안 한 편집이면 실행 셀 해시와 불일치 → 미매핑 → 드롭. `cellsFromNotebook()`이 열린 노트북의
  getText()를 그대로 해시(cellSource===getText())해 데몬 cell_hash와 정확히 일치. 디스크 read 제거.
  검증 실 VSCode v13(디스크 DISKVERSION ↔ 메모리 EDITED 실행→EDITED 출력). verify-d = v8 v10 v11 v12 v13.
- **#5 셀 추가 후 실행 시 라이브 출력 안 뜸** (ADR-022): LiveOutputSync hashIndex가 startLive 때 1회만
  구성돼 이후 추가된 셀이 미매핑→드롭(restore는 됐던 이유). `refreshCells()` + onDidChangeNotebookDocument
  구독 + 제출 직전 `refreshLive()`. 검증 실 VSCode v14(라이브 시작 후 셀 추가→그 셀 실행이 restore 없이
  라이브 출력). verify-d = v8 v10 v11 v12 v13 v14 (6/6).
- 확장 버전 0.0.1→0.0.2(강제 재로드)→0.0.3(메모리 매핑)→0.0.4(인덱스 갱신). vsix 재패키징+재설치 필요.
- 트레일링 개행 함정: 디스크 cellSource는 끝 \n O, 방금 타이핑한 셀 getText()는 \n X → 0.0.2 디스크 매핑이
  깨졌던 이유. 0.0.3 메모리 매핑(getText 그대로 해시)이 근본 해결.
- **#6 중간 재접속 시 이전 출력 미복원** (ADR-023): startLive가 실시간만 그리고 재접속 이전 출력을 빠뜨림.
  attach(0) 직후 동기로 각 exec의 folded 출력을 `seedCell()`로 렌더 + streamOut 등록 → 라이브 delta가
  같은 블록에 이어붙어 연속 스트림. 검증 v15(루프 중 재접속→0~29 전체) + 스크린샷. 0.0.5.
- **렌더 스크린샷 검증 표준화** (ADR-024): `verify/shot.sh <suite>` — 실 VSCode를 Xvfb에서 띄워 여러 프레임
  캡처→최대 렌더 프레임 보관, std-dev>0.02 blank 차단(verify/shots/, gitignore). `make shot`. 앞으로 확장
  변경 시 모델 단언 + 픽셀 렌더 확인 병행.
- **#7 재접속 시 셀 상태 + 시간 복원** (ADR-025): 출력뿐 아니라 완료(✓+소요시간)/실행중(스피너+실제 경과)/
  대기중(시계) 상태 복원. 데몬 started_at/finished_at를 스냅샷+이벤트로 노출, VSCodeCellSink를
  pending/running/done 상태머신으로 재설계(실제 데몬 시각으로 start/end → 경과·소요시간 정확). 함정:
  clearOutput은 start() 후에만 유효. 검증 실 VSCode v16(A done 0.1s / B running 15.7s / C queued) + 스크린샷.
- verify-d = v8 v10 v11 v12 v13 v14 v15 v16 (8/8). 확장 0.0.6.

### Phase 1 ⑨⑩ 산출물 (라이브 동기화 · 최적화 · 백프레셔)
- extension/src/`liveSync.ts`: `LiveOutputSync` — throttle/coalesce(주입 Scheduler) + run-merge +
  delta-append + dirty-set + cell_hash 메모이즈(ADR-017). `sessionClient.ts`에 onEvent 훅 추가.
- extension/src/`sessionController.ts`: `VSCodeCellSink`(proxy execution + appendOutputItems) +
  `startLive()`. extension.ts/package.json에 `tithon.startLive` 커맨드.
- daemon/tithon/`daemon.py`: 백프레셔(ADR-018) — Subscriber 큐 상한 + SEND_TIMEOUT drop +
  write_limit(transport 버퍼 bound) + SO_SNDBUF. 상한/타임아웃 env 조정 가능(기본=프로덕션).
- test: `liveSync.test.ts`(7, coalescing 상한·순서·\r·clear) · `test_backpressure.py`(4, 큐 bound +
  send-stall drop) · `restore`/`live` 실 VSCode(v8/v10) · `v9.sh`(호스트 건강성).
- run_verify.sh: c=v7+v9(hermetic), d=v8+v10(실 VSCode). all=v1~v7+v9.

### Phase 1 ⑧ 산출물 (실 VSCode 통합)
- extension/integration/: `runTest.ts`(@vscode/test-electron 런처) + `suite/{index,restore.test}.ts`
  (in-host mocha) + `seed.ts`(검증된 SessionClient로 데몬 시드). `tsconfig.integration.json`→out-int/.
- v8.sh: 실데몬 시드 → xvfb 아래 실 VSCode(1.124.2) 구동 → fixture .py를 tithon-py 노트북으로 열고
  컨트롤러 select → tithon.restoreOutputs → NotebookCell.outputs에 stdout"0\n1\n2\n"/result 42/
  ValueError 단언. run_verify.sh `d`, Makefile verify-d.
- package.json: publisher "tithon"(결정적 ext id), activationEvents(onNotebook/onCommand),
  @vscode/test-electron·mocha 추가. → sessionController는 "스파이크" 아님(실 VSCode 구동 검증).
- 환경: xvfb + electron libs를 apt로 설치(이 환경은 root+apt+네트워크 가능). v8.sh 헤더에 apt 목록.

### Phase 1 ⑦ 산출물 (재접속 복원)
- extension/src/`outputFold.ts`: folding.py의 정확한 TS 포트(\r/\n/\b·clear_output(wait)·
  update_display_data·execute_result/error). `seed()`로 스냅샷 folded outputs에서 이어 fold(ADR-015).
- extension/src/`sessionClient.ts`: attach(last_seen_seq)로 snapshot+delta+live 소비, 실행별 fold
  유지, `restoreInto(cells)`가 cellAttach로 셀 부착. `execute()`도 포함.
- extension/src/`sessionController.ts`: NotebookController.replaceOutput로 복원 출력을 셀에 쓰는
  VSCode 바인딩(스파이크, 실 VSCode 미구동 — ADR-012 기조). extension.ts에서 registerRestore로 등록,
  package.json에 `tithon.restoreOutputs` 커맨드+노트북 툴바 메뉴.
- test/`outputFold.test.ts`(8, 결정론) + test/`restore.test.ts`(2, **실데몬** E2E: 재접속 복원 +
  client fold==daemon snapshot fold 동등성). verify/`v7.sh` + run_verify.sh `c`/`all` + Makefile verify-c.
- 안티치팅: restore.test.ts는 소켓 없으면 skip(npm test 격리)이나 v7.sh는 데몬 가동 중 skip을 FAIL 처리.

---

## (이전) Stage B 완료 — `make verify-b` 2/2 PASS (종료코드 0). vitest 25/25, pytest 25/25 통과.
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

## 다음 단계 (Phase 1 진행 중)
- ✅ ①~⑥ + ⑦ 재접속 복원 + ⑧ 실 VSCode + ⑨ 데몬 백프레셔 + ⑩ 라이브 스트리밍 — verify 8/8 + verify-d 2/2.
- 다음 후보:
  - 위젯 라이브: tqdm 위젯 미러 스냅샷을 라이브 경로로 렌더(현재 stream/result/error 렌더; 위젯은 복원만).
  - update_display_data 인플레이스 갱신(현재 sessionController는 append 스파이크) — 매칭 출력 교체.
  - .vsix 패키징(vsce) + tunnel 시나리오 문서화.
  - 데몬 MVP: 멀티 세션, 실행 큐 가시화, 아티팩트 스토어 확장, systemd 패키징, stale 배지/듀얼 뷰.

## 막힌 것
- 없음. (⑦ 함정: NotebookDocument엔 getText()/NotebookEdit.updateCellOutputs 없음 →
  workspace.fs.readFile + NotebookController.createNotebookCellExecution().replaceOutput로 해소.
  cell_hash는 snapshot에만 실리므로(queued 이벤트엔 없음) 재접속 복원은 fresh attach(0) 경로가 정답.)

## 환경 메모
- uv는 ~/.local/bin/uv (PATH에 추가 필요). venv: daemon/.venv (Python 3.11.15).
  ipywidgets 설치됨(tqdm.notebook comm 발생용).
- 시스템 python3는 3.10이라 사용 금지. 항상 daemon/.venv/bin/{python,tithon} 사용
- verify는 테스트별 mktemp TITHON_HOME으로 격리, trap cleanup으로 데몬+커널 정리
- Node: node v24/npm 11(nvm). extension/ 은 npm. vitest(jsdom는 파일별 docblock).
  v5/v6.sh는 npx를 PATH에서 찾고 없으면 ~/.nvm/versions/node/*/bin 추가. xvfb-run 없음.
