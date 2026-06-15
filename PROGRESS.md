# PROGRESS

## 현재 상태 (2026-06-15)
**파일별 커널/세션 + 데몬 자동시작 + 패키징·UX 라운드 + matplotlib·tqdm 출력 + tqdm.notebook 위젯(정적+라이브) (ext 0.0.13).**
suite 구성: `make verify-a` 4(v1~v4), `make verify-b` 2(v5~v6), `make verify-c` 4(v7·v9·v17·v27),
`make verify-d` 20(v8·v10~v16·v18~v30 실 VSCode), `make verify`(all) 8(v1~v7·v9).
이번 세션: **daemon pytest 36/36**, **vitest 57 pass/6 skip**(richOutput 7 + richDaemon 4 + widget jsdom 5),
**verify-c 4/4 PASS**, **실 VSCode v28·v29·v30 PASS**(+ shot richoutputs/widget/widgetlive 픽셀 — matplotlib
그림 · 초록 막대 100% · 블루 막대 34% 실행 중). verify-d 전체 재실행은 백그라운드 진행 중.

### matplotlib inline + tqdm 출력 지원 (ADR-034, v27/v28, Option 1)
이전엔 matplotlib figure가 셀에 "<Figure size 640x480 with 1 Axes>" **텍스트로만** 떴다 —
`toOutputItem`이 display_data에서 text/plain을 우선 골랐고, 데몬이 png를 `$tithon_artifact`
파일로 추출해 두었지만 클라이언트가 그 바이트를 받을 경로가 없었다. 수정:
- **데몬 `get_artifact` op**(세션 스코프, `Session.read_artifact`): 아티팩트 파일 바이트를 base64로
  같은 unix 소켓에 반환. 저널엔 base64 안 들어가는 §3.1 유지 + 공유 FS 가정 없음 + sha 디둡(고유
  이미지당 1회 fetch).
- **클라이언트**: `SessionClient.getArtifact`(캐시)/`cachedArtifact`(동기)/`prefetchArtifacts` +
  `widgets()`(미러 스냅샷). 순수 헬퍼 `richOutput.ts`(imageOf/imageRefsOf/widgetModelIdOf/widgetFallbackText).
- **렌더**: `toOutputItem`이 이미지 바이트 > svg > 위젯-view 텍스트폴백 > html > text/plain 순.
  matplotlib는 prefetch한 바이트로 `image/png` 출력 아이템. tqdm.notebook 위젯은 §3.3 폴백 —
  미러에서 HBox children 순회로 `100% |████| 5/5 [time]` **최종 막대** 재구성(모델 미상=라이브 첫
  실행이면 display의 text/plain "0%…"로 폴백). 라이브 이미지 append 후 done end()가 "execution
  ended" 거부하지 않게 VSCodeCellSink에 per-cell promise chain.
- **터미널 tqdm**(`from tqdm import tqdm`, stderr `\r`)은 stream fold로 이미 동작 — 검증만 추가.
- **스코프 한정**: 위젯 풀렌더(html-manager 커스텀 렌더러, §6⑤ 최대 리스크)는 분리; update_display_data
  인플레이스 갱신 미구현. 라이브 tqdm.notebook은 0% 시작상태만(최종 막대는 재접속/restore 시 복원).
- 검증: v27(hermetic 실데몬 3) + v28(실 VSCode: image/png PNG매직 20KB + 터미널 tqdm 100% +
  restore 위젯 "100% 5/5") + shot richoutputs. 데몬 venv에 matplotlib/matplotlib_inline 필요.

### tqdm.notebook ipywidget 렌더러 — 정적/재접속 (ADR-035, v29, §6⑤)
ADR-034의 텍스트 폴백을 넘어 **실제 위젯**을 실 VSCode webview에서 렌더(프로젝트 최대 리스크 §6⑤ 통과).
- **자체완결 커스텀 mime** `application/vnd.tithon.widget+json` = `{model_id, state(미러 전체)}` → 렌더러가
  호스트 왕복 없이 html-manager로 즉시 렌더(state-도착-전-render 레이스 제거).
- esbuild 렌더러 번들(browser/esm, 3.3MB, html-manager+base+controls+widgets.built.css 인라인→`<style>`
  주입). package.json `notebookRenderer`(**`requiresMessaging:"optional"` 필수** — 없으면 postMessage no-op,
  첫 v29 실패 원인) + `.vscodeignore`.
- `toOutputItem`→`toOutputItems`(배열): widget-view는 미러에 모델 있으면 위젯 mime+텍스트폴백, 없으면 텍스트.
- 렌더러 엔트리: `{model_id,state}` 읽어 html-manager 렌더, 실패 시 텍스트 폴백, html|fallback을 host로 보고
  (`tithon._widgetRenderLog` 테스트 명령). output id별 manager 캐시(라이브 업데이트 대비).
- 검증 v29(실 VSCode: tqdm.notebook→restore→위젯 mime + 렌더러 **html 보고**) + shot widget(픽셀: 초록 막대).

### tqdm.notebook 라이브 애니메이션 (ADR-036, v30, Phase 3) ✅
정적 렌더(ADR-035)를 넘어 **막대가 실행 중 실시간으로 채워짐**(restore 불요):
- **데몬**: widget 이벤트 payload에 comm `data`(state) 포함 → 클라가 라이브 미러 구축 가능.
- **클라이언트**: `SessionClient.applyEvent`가 widget 이벤트로 라이브 미러(`applyWidgetEvent`: open/msg/close).
  comm_open이 display_data보다 먼저 와서 표시 시점에 모델 존재 → **라이브 중 위젯 mime 방출**.
- **컨트롤러**: startLive onEvent가 widget 델타를 comm_id별 coalesce(50ms)해 렌더러로 `tithon.widget-update`
  푸시 → 렌더러 `model.set_state`로 막대 애니메이트, 적용 시 `widget-updated` 보고(카운트 `_widgetUpdateCount`).
- 검증 v30(실 VSCode: 라이브 실행 중 위젯 mime + html 렌더 + 업데이트 적용>0) + shot widgetlive(픽셀: 34% 실행중)
  + hermetic richDaemon(driver 실행 전 attach→라이브 미러 value==max).
- **남은 것**: 위젯→커널 **양방향**(슬라이더 드래그 등 §3.3 bidirectional)은 미구현(tqdm은 display-only라 불요);
  바이너리 버퍼 위젯의 라이브 갱신은 버퍼 생략(정적 스냅샷 렌더는 처리).

### 패키징·인터프리터·UX 라운드 (ADR-029~033, v24~v26, ext 0.0.9→0.0.12)
PROGRESS가 0.0.8에서 멈춰 있던 구간을 갱신 — 실 tunnel 사용자 피드백 후속:
- **vsix 번들링** (ADR-029, 0.0.9): `vsce package --no-dependencies`가 런타임 의존 `ws`를 빠뜨려
  활성화가 `Cannot find module 'ws'`로 실패(.py를 못 엶). `esbuild.mjs`로 src를 dist/extension.js에
  번들(ws 인라인) → vsix 4파일·37KB. 통합테스트는 소스로 로드해 이 결함을 못 잡음 → vsix 자체를
  활성화까지 검증해야 한다는 교훈. ipywidget 렌더러(~3MB, jsdom 전용 미검증)는 이 패키지에서 제외.
- **인터프리터 기준 데몬 기동** (ADR-030, 0.0.10): jupyter처럼 "venv 활성화 없이 그냥 되게". `__main__.py`
  추가(`python -m tithon`), daemonProcess.resolvePython()이 ms-python 활성 인터프리터를 찾아
  `"<python>" -m tithon daemon`을 1순위 spawn. 각 후보는 곧 죽으면 fast-fail→다음 후보, 전부 실패 시
  데몬 로그 꼬리+시도 명령을 에러로 노출(이전 0.0.9는 단일 후보 20s 타임아웃→"daemon did not come up").
- **셀 stop 버튼** (ADR-031, 0.0.11): `controller.interruptHandler`→데몬 SIGINT(os.kill(kernel.pid,SIGINT)).
  실행 셀은 KeyboardInterrupt→✗로 종료, **커널 생존**해 재실행 가능. v24(루프→중단→tick 멈춤+재실행 RUN2).
- **.py 텍스트 기본 + Cell View opt-in** (ADR-032): selector `*.py` 유지(openWith 동작) + 활성화 시
  `editorAssociations["*.py"]="default"`로 텍스트에 양보(사용자 지정 연관은 가드). 명령 openAsCellView/
  openAsText + 제목줄 버튼/CodeLens. v25(open→텍스트, openAsCellView→tithon-py 노트북 실행).
- **Select Python Interpreter + 데몬 재시작** (ADR-033, 0.0.12): 커널은 데몬 Python(sys.executable)으로
  뜨므로 인터프리터는 데몬 전역 → 변경엔 재시작 필요. 데몬 `shutdown[--kill-kernels]` op 추가,
  waitForDaemonStop은 **소켓이 아니라 pid 파일 소멸 대기**(너무 일찍 반환→preflight "already running"
  레이스 회피). selectInterpreter QuickPick→pythonPath 저장→확인→restartDaemon(라이브 dispose→shutdown→
  대기→ensureDaemon→re-live). 상태바 `$(snake) Tithon: Python x.y`. v26(재시작→데몬·커널 pid 변경+카운터 리셋).

### 진행 중(미커밋) — daemon src 레이아웃 재구조화
워킹트리에 staged 상태로 `daemon/tithon/` → `daemon/src/tithon/`(9파일 rename),
`pyproject.toml [tool.hatch...].packages = ["src/tithon"]`, `prompts/` 삭제가 올라가 있음.
import는 정상(`daemon/src/tithon/__init__.py`에서 로드 OK). **verify v*.sh가 옛 경로를 하드코딩하지
않는지 `make verify` 통과로 확인 후 커밋할 것** — 미검증 상태.

### 데몬 자동시작 + 커널 Python 버전 (ADR-028, v23)
- **데몬 자동시작**: `daemonProcess.ts` ensureDaemon이 소켓 연결 실패 시 `tithon daemon`을 detached
  spawn(설정 `tithon.autoStartDaemon`/`tithon.daemonCommand`). 커널 선택만 해도 자동 기동 → 사용자는
  데몬을 직접 띄울 필요 없음(남은 수동단계: 파일당 최초 1회 커널 선택, VSCode 모델상 불가피).
- **커널 라벨**: Session이 kernel_info로 Python 버전 캡처 → snapshot.kernel.python → 컨트롤러 라벨
  "Tithon · Python 3.11.15"(이전엔 "Tithon"만). 검증 v23 + 스크린샷.

### 2차 실 tunnel 사용자 버그 수정 (ADR-026/027, v17~v22)
사용자가 원격에서 직접 테스트하며 보고한 문제들:
- **#1 닫았다 열기/다른 파일 실행 시 먹통**: liveSession이 uri 키로 닫혀도 안 지워져 stale 세션
  재사용 → onDidCloseNotebookDocument→disposeLive + 파일별 세션 격리로 해소(v18 close+reopen 재실행).
- **#2 동일 코드 두 셀 → 첫 셀에 출력**: cell_hash 단독 정체성의 한계. origin.index(제출 시점 셀
  인덱스)를 권위 키로(journal cell_index 컬럼) → index 우선·hash 폴백(v20 + 단위테스트).
- **#3/#4 창 재시작 후 자동 동기화 안 됨/명령어 불필요**: controller.onDidChangeSelectedNotebooks로
  커널 선택 시점에 자동 복원+라이브(재오픈 시 VSCode가 커널 자동 재선택) → 명령 없이 동작(v22).
  혼란스럽던 restoreOutputs/startLive 툴바 버튼 제거.
- **#5 커널 재시작 UI 없음**: 데몬 restart_kernel/interrupt op + 툴바 명령(Restart/Interrupt Kernel)(v21).
- **#6 파일별 커널**: 데몬을 SessionManager+Session으로 분리, 파일(uri)별 커널·저널·격리(v17/v19).
- 부가: 라이브 done(status:ok)→✓ 정규화(스크린샷으로 발견), 통합 런처 per-suite --user-data-dir
  (배치 실행 격리), verify status_field per-session 적응.

### (이전) Phase 1 + 1차 사용자 버그(#1~#7) — verify 8/8 + verify-d 8/8(v8/v10~v16)
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
- daemon/src/tithon/`daemon.py`: 백프레셔(ADR-018) — Subscriber 큐 상한 + SEND_TIMEOUT drop +
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
- daemon/src/tithon/`widgets.py`: Widget State Mirror(comm 해석, 바이너리 버퍼, widget-state+json).
  daemon.py에 통합(iopub comm 처리 → 미러·저널·브로드캐스트, 스냅샷에 widgets 포함,
  재시작 시 _rebuild_mirror). pytest test_widgets.py 9개(버퍼 포함).
- verify/v5.sh(tqdm 5만→fresh attach FloatProgress value==max==total + jsdom 렌더 + 미러
  유닛) · v6.sh(코퍼스 0바이트 diff + 1000케이스 + cell_hash 부착) · _check_v5.py · corpus/.
- ipywidgets를 daemon/.venv에 추가(tqdm.notebook가 comm 발생시키는 데 필요).

---

## (이전) Stage A 완료 — `make verify-a` 4/4 PASS (종료코드 0), pytest 16/16 통과.

- daemon/src/tithon 패키지: 데몬 + CLI 구현 완료
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
- ✅ ①~⑩ + 1차(#1~#7) + 2차(#1~#6 파일별 커널) + 데몬 자동시작·Python 라벨(0.0.8) +
  vsix 번들·인터프리터 기동·stop 버튼·.py 텍스트 기본·인터프리터 선택/재시작(0.0.9~0.0.12) +
  **matplotlib inline 이미지 + tqdm 출력(0.0.13, ADR-034)**.
- 다음 후보:
  - **vsix 재패키징**: 0.0.13 esbuild 번들 + .vsix(사용자 설치용) — 출력기능은 소스 검증됨, vsix 미생성.
  - **src 레이아웃 커밋**: 미커밋 재구조화를 `make verify` 통과 확인 후 커밋(verify 경로 하드코딩 점검).
  - **위젯 양방향(§3.3 bidirectional)**: 슬라이더 드래그 등 위젯→커널 comm_msg 프록시 + echo 브로드캐스트.
    현재는 display-only(tqdm.notebook 정적+라이브 ✅, ADR-035/036); 인터랙티브 위젯은 이 조각 필요.
  - update_display_data 인플레이스 갱신(현재 sessionController는 append 스파이크) — 매칭 출력 교체.
  - 세션 GC: 닫힌 파일의 커널 수명 정책(현재 커널은 detached로 계속 생존; idle 종료/명시 종료 UI 필요).
  - tunnel 시나리오 문서화 갱신(파일별 커널 + 커널 재시작/인터럽트 UI).

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
