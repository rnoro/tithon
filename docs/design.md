# 프로젝트 설계서: Tithon (Τιθωνός)

> **명명**: 그리스 신화의 티토노스(Tithonos)에서. 새벽의 여신 에오스는 제우스에게 연인 티토노스의 불사(不死)는 얻어냈지만 영원한 젊음을 청하는 것을 잊었고, 티토노스는 죽지 못한 채 영원히 시들어가다 매미가 되었다 — **지금의 원격 커널이 정확히 티토노스다.** 호스트에서 프로세스는 살아있지만(불사), 클라이언트가 끊기는 순간 출력과 세션 상태는 시들어 사라진다(젊음의 부재). Tithon은 그 저주를 푼다: _immortality — with eternal youth, this time._ 매미(영원히 노래하는 존재 = 끊김 없이 출력을 스트리밍하는 세션)를 로고 모티프로 한다. 덤으로 ti-**thon**의 운율이 py**thon**과 호응한다. PyPI/npm 네임스페이스 가용 확인 완료(2026-06). 패키지/CLI: `tithon` (`pip install tithon`).

원격 GPU 호스트에서 실행 중인 인터랙티브 Python 세션을 클라이언트의 접속/단절과 완전히 무관하게 유지하고, 어떤 클라이언트가 언제 접속하든 셀 실행 이력·진행 상황·출력을 동일하게 동기화하는 시스템.

---

## 1. 문제 정의와 원인 분석

### 1.1 기존 도구의 실패 지점

| 도구                                            | 실패 지점                                                                  | 근본 원인                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| JupyterLab                                      | 재접속 시 그 사이 발생한 셀 출력 유실                                      | iopub 메시지가 WebSocket으로 스트리밍만 되고 서버에 영속화되지 않음. 끊긴 동안의 메시지는 재전송 불가 |
| VSCode Jupyter 확장 (.ipynb / interactive mode) | 창 종료·네트워크 단절 시 커널 및 세션 상태 전체 유실                       | 커널 수명과 출력 상태가 확장 호스트 프로세스에 종속됨. 출력은 클라이언트 메모리/문서에만 존재         |
| tmux + jupyter console                          | 출력은 유지되나 rich output(이미지·HTML) 불가, 멀티 클라이언트 동기화 없음 | 터미널 기반의 한계                                                                                    |

### 1.2 핵심 통찰

세 가지 실패는 모두 같은 원인에서 나온다: **"실행 상태의 단일 진실 공급원(source of truth)이 클라이언트 쪽 또는 휘발성 채널에 있다"**는 것. 따라서 해결책은 커널 프로토콜을 새로 만드는 것이 아니라,

1. 커널과 세션의 **소유권을 호스트 상주 데몬으로 이전**하고,
2. 커널이 내보내는 **모든 메시지를 호스트에 저널(append-only log)로 영속화**하며,
3. 클라이언트는 "마지막으로 본 시퀀스 번호 이후의 델타"를 받아 **리플레이로 상태를 복원**하는

이벤트 소싱(event sourcing) 구조다. 실행 엔진 자체는 검증된 `ipykernel`을 그대로 사용한다. (새 커널을 밑바닥부터 구현하는 것은 목표 대비 비용이 크고, 문제의 원인이 커널이 아니라 세션 관리 계층이기 때문. 단, 필요해지면 ipykernel을 fork/확장하는 길은 열어둔다 — §7 참고.)

---

## 2. 전체 아키텍처

```
┌─────────────────────────────  원격 GPU 호스트  ─────────────────────────────┐
│                                                                              │
│  ┌────────────────┐     ZMQ (Jupyter protocol)      ┌─────────────────────┐ │
│  │   ipykernel    │◄────────────────────────────────►│   Tithon Daemon      │ │
│  │  (detached,    │                                   │  (systemd --user)   │ │
│  │   setsid)      │                                   │                     │ │
│  └────────────────┘                                   │  - Session Manager  │ │
│        ▲ connection file 영속화                       │  - Message Journal  │ │
│        │ (데몬 재시작 시 re-attach)                    │  - Replay Engine    │ │
│                                                       │  - WS Pub/Sub       │ │
│                                                       └─────────┬───────────┘ │
│                                                                 │ localhost   │
│  ┌──────────────────────────┐                                   │ WS/HTTP     │
│  │ VSCode Tunnel Server     │      ┌──────────────────────┐     │             │
│  │ (code tunnel)            │──────│ Extension Host        │─────┘             │
│  │                          │      │ (Tithon VSCode 확장)   │                   │
│  └──────────┬───────────────┘      └──────────────────────┘                   │
└─────────────┼────────────────────────────────────────────────────────────────┘
              │ vscode.dev tunnel (MS relay)
   ┌──────────┴───────────┐   ┌──────────────────────┐
   │ 클라이언트 A          │   │ 클라이언트 B (브라우저)│   ← 동시 접속, 동일 상태
   │ (데스크톱 VSCode)     │   │  vscode.dev          │
   └──────────────────────┘   └──────────────────────┘
```

핵심 토폴로지 결정: `code tunnel` 환경에서 확장 호스트는 원격에서 돈다. 따라서 **확장 ↔ 데몬 통신은 localhost(또는 unix domain socket)로 충분**하며 추가 포트 노출이 필요 없다. 클라이언트 단절 시 확장 호스트는 죽을 수 있지만 데몬과 커널은 영향받지 않고, 재접속하면 확장이 데몬에 re-attach하여 상태를 복원한다.

---

## 3. 컴포넌트 상세 설계

### 3.1 Tithon Daemon (Python)

**역할**: 커널 수명 관리, 메시지 저널링, 멀티 클라이언트 동기화 서버.

**커널 수명 관리**

- `jupyter_client.KernelManager`로 커널을 spawn하되, **데몬의 자식이 아닌 분리 프로세스(setsid/daemonize)**로 띄우고 connection file을 DB에 영속화한다. 이렇게 하면 데몬이 크래시·업데이트로 재시작해도 `BlockingKernelClient.load_connection_file()`로 기존 커널에 재연결할 수 있다 → 데몬 자체도 단일 장애점이 아니게 됨.
- 세션 모델: `session = 커널 1개 + 실행 이력 1개 + 이름(예: "exp-resnet-lr3e4")`. 세션 목록/생성/종료/interrupt/restart API 제공.
- 데몬은 systemd user service로 등록 (`Restart=always`), 호스트 부팅 시 자동 시작.

**메시지 저널 (단일 진실 공급원)**

- SQLite(WAL 모드)에 append-only로 기록. 스키마 골자:

```sql
executions(exec_id, session_id, seq, code, cell_origin_uri, cell_range,
           submitted_by, status, execution_count, started_at, finished_at)
messages(msg_seq, session_id, exec_id, msg_type, content_json, artifact_ref, ts)
artifacts(artifact_id, sha256, mime, rel_path, bytes_len)  -- rich output을 실제 파일로 분리 저장
```

- **출력 아티팩트는 base64 임베딩이 아니라 실제 파일로 저장한다** (.ipynb과의 핵심 차별점). `image/png`, `image/jpeg`, `image/svg+xml` 등 rich mime 페이로드는 데몬이 수신 즉시 디코딩해 `<세션 디렉터리>/.tithon/outputs/exec{N}_{idx}_{sha8}.png` 형태로 기록하고, 저널에는 파일 참조만 남긴다. sha256 기반 중복 제거(동일 이미지는 하드링크). 효과: ① 저널 DB가 가볍게 유지됨, ② 출력 이미지를 파일 탐색기에서 직접 열람·복사·보고서 활용 가능, ③ git 친화적(.ipynb의 base64 diff 지옥 해소). 출력 디렉터리 위치는 설정 가능(기본: 워크스페이스 내 `.tithon/`).

- 저널에는 **원본 iopub/shell 메시지를 그대로** 보존한다(stream, display_data, update_display_data, clear_output, execute_result, error, status). 리플레이 의미론을 클라이언트가 아니라 서버가 책임지기 위함.
- **Materialized view**: 메시지를 그대로 다 리플레이하면 tqdm처럼 `\r`/`update_display_data`를 수만 번 찍는 셀에서 재접속이 느려진다. 그래서 데몬이 실행별로 "현재 출력 상태"를 접어둔(folded) 스냅샷을 함께 유지한다 — stream 메시지 병합(carriage return 처리 포함), `update_display_data`는 display_id별 최종본만, `clear_output` 반영. 클라이언트 attach 시에는 **스냅샷 + 그 이후 델타**를 준다.
- 출력 용량 정책: 실행당 출력 상한(예: 기본 8MB, 설정 가능) 초과 시 head/tail 보존 + 절단 마커. 전체 저널은 세션 종료 후 보존 기간 정책으로 정리.

**동기화 프로토콜 (WebSocket, JSON)**

클라이언트 → 데몬:

```
attach        { session_id, last_seen_seq }     # 0이면 풀 스냅샷
execute       { code, origin: {uri, range}, exec_nonce }
interrupt / restart / shutdown { session_id }
list_sessions / create_session { name, kernel_spec, cwd, env }
input_reply   { exec_id, value }                 # stdin (input()) 지원
```

데몬 → 클라이언트 (모든 클라이언트에 브로드캐스트):

```
snapshot      { executions: [folded outputs...], kernel_status, queue }
event         { seq, exec_id, kind: queued|started|output|done, payload }
presence      { clients: [...] }                 # 누가 붙어있고 누가 실행했는지
```

- 모든 이벤트에 단조 증가 `seq`를 부여 → 클라이언트는 자신의 `last_seen_seq`만 기억하면 끊겼다 붙어도 정확히 이어받는다 (at-least-once + 멱등 적용).
- 실행 큐: 셀 실행 요청은 데몬이 세션별 FIFO 큐로 직렬화. 여러 클라이언트가 동시에 실행해도 순서가 결정적이며, 큐 상태(대기 중인 셀 목록)도 동기화 대상이다. 클라이언트 단절 시에도 **이미 큐에 들어간 셀은 계속 실행**된다 — "Run Above 걸어놓고 노트북 닫고 퇴근" 시나리오가 정확히 이것.

### 3.2 VSCode 확장 (TypeScript)

**셀 인식·실행 UX**

- `#%%` (및 `# %%`, `# %% [markdown]`) 구분자 파싱 → CodeLens("Run Cell / Run Above / Run Below") + 키바인딩(`Shift+Enter` 등) 제공. ms-toolsai.jupyter와 키맵 호환을 기본값으로.
- 실행 모델은 노트북 문서가 아니라 **interactive-window 스타일의 append-only 실행 이력**이다. `.py` percent format에는 안정적인 셀 ID가 없으므로, 셀을 문서 상의 객체가 아니라 "그 시점에 제출된 코드 스냅샷"으로 다룬다. 이것이 .ipynb 의존성을 버리는 결정과 정확히 맞물리는 모델.

**출력 렌더링 — 핵심 설계 결정**

- 자체 webview를 만들지 않고 **VSCode Notebook API의 `NotebookController` + 커스텀 notebook type**으로 구현한다. 즉 "Tithon Interactive" 가상 노트북 문서(읽기 전용, append-only)를 열고, 실행 이력을 셀로 추가하며 출력은 `NotebookCellOutputItem`으로 흘린다.
- 이 선택의 이점: VSCode 내장 렌더러(ANSI 컬러, image/png, text/html, error traceback, 스크롤 가능한 긴 출력)를 공짜로 얻고, 렌더러 생태계(예: plotly 렌더러 확장)와도 호환된다. webview 자체 구현은 렌더링 패리티 비용이 매우 크므로 배제.
- 재접속 시: 확장 activate → 데몬 attach → snapshot으로 가상 노트북 재구성 → 이후 event 스트림 실시간 반영. 사용자는 "끊긴 적 없는 것처럼" 보게 된다.

**출력의 셀 위치 앵커링 — (B) 에디터 내 인라인 출력은 v1 필수 요구사항**

- 모든 실행은 `origin: {uri, range, cell_hash}`(원본 `.py` 파일, `#%%` 셀 범위, 셀 코드 해시)를 가지고 저널에 기록되므로, 이미지 등 출력 파일은 항상 "어느 파일의 어느 셀에서 나왔는지"와 연결된다.
- **(B) 1차 구현 경로 — Percent-format NotebookSerializer ("Cell View")**: VSCode 공개 API에는 텍스트 에디터 임의 위치에 webview를 삽입하는 inset API가 없다(`createWebviewTextEditorInset`은 proposed 상태로 고착, 마켓플레이스 배포 불가). 따라서 `.py` 자체를 커스텀 notebook type(`tithon-py`)의 **NotebookSerializer로 파싱해 셀 문서로 여는** 방식을 채택한다 — jupytext 확장이 검증한 패턴. 디스크에는 순수 percent-format `.py`만 존재하고, 에디터에서는 각 `#%%` 셀 바로 아래에 이미지·위젯·텍스트 출력이 네이티브 노트북 렌더링으로 표시된다. 출력은 파일이 아니라 저널에서 와서 셀에 부착되므로(아래 매핑 규칙) `.py`는 끝까지 오염되지 않는다.
  - **라운드트립 무결성이 절대 조건**: 직렬화 시 사용자의 코드 포매팅·공백·주석을 바이트 단위로 보존해야 한다(자동 리포맷 금지). Phase 0 검증 항목.
  - **출력↔셀 매핑 규칙**: 1순위 `cell_hash`(코드 내용 해시) 일치 → 2순위 range 근접 매칭. 셀이 수정되면 이전 출력은 "stale" 배지와 함께 유지(재실행 전까지 참고용), 재실행 시 교체. 같은 파일을 텍스트 에디터로 열고 CodeLens로 실행해도 저널은 동일하므로, Cell View를 열면 출력이 그대로 보인다 — 두 뷰는 같은 진실(저널)의 두 표현이다.
  - 듀얼 뷰: 사용자는 "Reopen Editor With…"로 텍스트 뷰 ↔ Cell View를 자유 전환. 동시 오픈 시 편집 충돌 방지를 위해 한쪽을 읽기 전용 권장(설정).
- **(B) 보조 경로**: 텍스트 뷰에서도 최소한의 인라인성을 제공 — 셀 범위 hover에 최신 출력 이미지 프리뷰(MarkdownString 이미지), gutter 아이콘 클릭 시 출력 peek. Comments API 기반 인라인 스레드는 UX 검증 후 선택 적용.
- (A) 인터랙티브 패널(가상 노트북)은 **전체 실행 이력 뷰**로 유지: Cell View가 "셀당 최신 출력"을 보여준다면, 패널은 시간순 append-only 이력(재실행 비교, 과거 출력 열람)을 담당. 각 항목에서 원본 셀로 점프 링크.

**상태 가시화**

- 상태바: 세션명, 커널 상태(idle/busy), 큐 길이, 데몬 연결 상태.
- 실행 중인 셀의 원본 `.py` 위치에 gutter 표시(진행 중/완료/에러), 멀티 클라이언트 presence 표시.
- 세션 picker: 호스트의 모든 세션 나열, attach/detach/restart.

### 3.3 ipywidgets / Comm 동기화 계층 (v1 필수 — 최대 기술 리스크)

위젯(tqdm.notebook, FloatProgress, interactive plot 등)은 stream/display와 달리 **커널 측 객체 ↔ 프론트엔드 모델의 양방향 상태 동기화**가 필요하다. 단순 메시지 리플레이로는 복원이 안 되므로 다음 구조로 해결한다.

**데몬 측: Widget State Mirror**

- 데몬이 "그림자 프론트엔드" 역할로 comm 채널을 해석한다: `comm_open`(target `jupyter.widget`)으로 모델 생성, `comm_msg`(method `update`)로 상태 패치, `comm_close`로 제거. binary buffers 포함. 결과적으로 데몬은 항상 **현재 위젯 상태의 완전한 스냅샷**(`application/vnd.jupyter.widget-state+json`과 동일한 형식)을 보유한다.
- 저널에는 원본 comm 메시지도 보존하되, 재접속 리플레이는 메시지 재생이 아니라 **상태 스냅샷 전송**으로 처리 — tqdm.notebook이 수만 번 update해도 attach 비용은 최종 상태 크기뿐이다(§3.1 materialized view와 동일 원리).
- 라이브 양방향: 클라이언트에서의 위젯 조작(슬라이더 드래그 등) → 확장 → 데몬 → 커널 shell 채널로 comm_msg 전달, 커널의 echo/응답은 전체 클라이언트에 브로드캐스트. **멀티 클라이언트 간 위젯 상태 동기화가 구조적으로 따라온다.**

**확장 측: 커스텀 위젯 렌더러**

- `application/vnd.jupyter.widget-view+json` mime에 대한 notebook renderer를 직접 contribute하고, 내부에서 `@jupyter-widgets/html-manager`로 모델/뷰를 인스턴스화한다. 렌더러 ↔ 확장 호스트 ↔ 데몬을 잇는 kernel proxy로 comm 양방향을 연결.
- 주의: ms-toolsai.jupyter의 위젯 지원은 자사 컨트롤러 내부 구현이라 재사용 불가 — 직접 구현이 불가피하며, **이 항목이 프로젝트 전체에서 가장 불확실한 부분**이다. 따라서 Phase 0 검증 항목에 포함한다(§6).
- 커스텀 위젯(서드파티 JS 모듈)은 html-manager의 CDN 로딩(기본) 또는 로컬 캐시로 지원. 표준 위젯 세트(ipywidgets core)는 번들에 포함.
- 폴백: 렌더러 실패 시 위젯의 최종 상태를 텍스트(예: 진행률 수치)로라도 표시해 정보 유실을 막는다.

**범위 한정**: v1 목표는 ipywidgets core + tqdm.notebook + matplotlib `widget`이 아닌 `inline` 백엔드. `%matplotlib widget`(ipympl) 같은 무거운 커스텀 위젯은 동작하면 보너스, 보장은 v2.

### 3.4 보조 클라이언트 (Phase 4, 선택)

데몬 프로토콜이 VSCode에 종속되지 않으므로, 읽기 전용 웹 대시보드(학습 진행을 휴대폰에서 확인)나 CLI attach 클라이언트를 저비용으로 추가할 수 있다. 이는 "언제 어디서든"이라는 목표 2를 VSCode 바깥까지 확장한다.

---

## 4. 까다로운 지점과 대응

**스트리밍 출력 폭주 (tqdm, 학습 로그)**: 저널에는 원본 보존하되 디스크 쓰기는 배치 커밋(예: 50ms 코얼레싱), 브로드캐스트도 같은 주기로 묶어 전송. materialized view가 carriage-return 의미론을 접어주므로 재접속 비용은 출력 길이가 아니라 최종 상태 크기에 비례한다.

**ipywidgets / comm 메시지**: §3.3의 Widget State Mirror로 v1에서 정식 지원한다. 잔여 리스크는 ① 커스텀 위젯 JS 모듈 로딩(오프라인 환경), ② 위젯 간 jslink처럼 프론트엔드에서만 일어나는 상태 변화는 데몬 미러가 모른다는 점(클라이언트가 주기적으로 상태를 데몬에 역보고하는 state-sync로 보완), ③ VSCode 렌더러 샌드박스 제약. ①③은 Phase 0에서 검증.

**`input()` / getpass**: stdin 요청 이벤트를 브로드캐스트하고 아무 클라이언트나 응답 가능하게. 응답자가 없으면 큐에 pending 상태로 표시.

**matplotlib 등 display 훅**: ipykernel을 그대로 쓰므로 `%matplotlib inline` 동작은 동일. 데몬이 kernel 시작 시 기본 매직을 주입하는 설정 제공.

**데몬과 커널의 장애 분리**: 커널 detached + connection file 영속화로 데몬 재시작에 커널이 생존(§3.1). 반대로 커널이 OOM 등으로 죽으면 데몬이 감지해 `kernel_died` 이벤트를 저널에 기록 — 적어도 "언제, 어떤 셀에서 죽었는지"는 모든 클라이언트가 안다.

**호스트 재부팅**: 인메모리 파이썬 상태는 본질적으로 보존 불가. 저널(코드+출력 이력)은 남으므로 "재실행으로 복원"이 빠르다. 자동 재실행(replay-to-restore) 커맨드를 Phase 3에 포함. dill/CRIU 기반 프로세스 체크포인트는 GPU 상태 때문에 신뢰성이 낮아 stretch goal로만 둔다 — 근본 대책은 학습 코드 쪽의 model checkpoint이며, 이 시스템은 그것과 상호보완 관계.

**보안 (단일 사용자 기준 단순화)**: 데몬은 unix domain socket에만 바인딩하고 소켓 파일 퍼미션(0600)으로 접근 제어 — 같은 OS 계정만 접근 가능하므로 별도 인증 계층 불필요. 멀티유저 인증·세션 권한은 설계에서 제외(추후 필요 시 Phase 4). 단, 코드 실행 데몬이므로 TCP/0.0.0.0 바인딩은 옵션으로도 제공하지 않는 것을 기본 방침으로 한다.

---

## 5. 기술 스택

| 영역      | 선택                                                                  | 비고                                 |
| --------- | --------------------------------------------------------------------- | ------------------------------------ |
| 데몬      | Python 3.11+, asyncio                                                 | GPU 서버에 이미 있는 런타임          |
| 커널 통신 | `jupyter_client` (ZMQ)                                                | 프로토콜 재구현 회피                 |
| API 서버  | FastAPI + uvicorn (WS) 또는 순수 `websockets`                         | 의존성 최소화 우선이면 후자          |
| 저장소    | SQLite (WAL) + blob 파일                                              | 단일 사용자 규모에 최적, 운영 부담 0 |
| 확장      | TypeScript, VSCode Notebook/CodeLens API                              | `engines.vscode` 최신 stable 기준    |
| 배포      | 데몬: pipx/uv tool + systemd unit 생성 CLI / 확장: VSIX → Marketplace | `tithon install-service` 한 줄 설치  |

---

## 6. 단계별 로드맵

**Phase 0 — 기술 검증 PoC (2~3주)**
데몬 최소본(세션 1개 고정) + CLI 클라이언트 + 렌더러 스파이크. 검증 항목: ① 장시간 학습 루프 중 attach/detach 반복 시 출력 무손실, ② tqdm 5만 iteration의 folded replay 성능, ③ matplotlib png의 파일 저장 + 리플레이, ④ 데몬 kill -9 후 재시작 → 커널 re-attach 생존, ⑤ **VSCode 커스텀 notebook renderer에서 @jupyter-widgets/html-manager로 FloatProgress·tqdm.notebook 렌더 + 재접속 시 상태 복원**, ⑥ **percent-format NotebookSerializer의 바이트 단위 라운드트립 무결성 + 저널 출력의 셀 부착(이미지가 `#%%` 셀 아래에 표시)**. ⑤⑥이 양대 리스크 — 막히면 각각 폴백(위젯: 최종 상태 텍스트 / Cell View: hover·peek 기반)으로 전환 여부를 결정한다. **이 6개가 통과돼야 전체 설계가 유효하다.**

**Phase 1 — 데몬 MVP (2~3주)**
멀티 세션, 저널 스키마 확정(cell_hash 포함), snapshot/delta 프로토콜, 실행 큐, Widget State Mirror, 아티팩트 파일 스토어, systemd 패키징.

**Phase 2 — VSCode 확장 MVP (4~6주)**
`#%%` CodeLens·키바인딩, **Cell View(NotebookSerializer + 출력 셀 부착, stale 배지)**, NotebookController, 위젯 렌더러 + comm 양방향 프록시, attach 시 상태 복원(위젯 포함), 인터랙티브 이력 패널(A), 상태바.

**Phase 3 — 운영 품질 (2~3주)**
출력 용량 정책·절단 UX, 텍스트 뷰 hover/peek 출력 프리뷰, gutter 진행 표시, 세션 picker, presence, replay-to-restore, 재연결 견고화, 문서화.

**Phase 4 — 확장 (선택)**
읽기 전용 웹 대시보드, ipympl 등 무거운 커스텀 위젯, 멀티 사용자(인증·세션 권한), R/Julia 등 타 커널(jupyter 프로토콜이라 이론상 무료).

---

## 7. 의도적으로 내린 결정들 (요약)

1. **새 커널 대신 새 "세션 계층"**: 문제의 원인이 커널이 아니므로 ipykernel 재사용. 단 데몬-커널 인터페이스를 jupyter wire protocol로 고정해두었기 때문에, 추후 커널 측 기능(예: 변수 탐색기용 introspection 확장)이 필요하면 ipykernel 서브클래스 커널로 교체 가능 — "필요 시 커널 구현"이라는 목표와 양립.
2. **.ipynb 완전 배제, 실행-이력 모델**: 셀 ID 동기화라는 난제를 회피하고, percent format `.py`를 유일한 소스로. 출력은 문서가 아니라 저널의 소유.
3. **이벤트 소싱 + materialized view**: 무손실 보장과 재접속 성능을 동시에.
4. **VSCode Notebook API 재사용**: 렌더링을 직접 만들지 않는다 — 단 위젯 렌더러만은 예외적으로 직접 구현(html-manager 기반).
5. **데몬-커널 프로세스 분리**: 어떤 단일 컴포넌트가 죽어도 학습은 죽지 않는다(커널 자체 제외).
6. **rich output은 파일이다**: 이미지 등은 base64 임베딩 대신 디스크의 실제 파일 + 저널의 참조. 출력물이 일급 산출물(파일)이 되어 .ipynb의 비대화·diff 문제를 구조적으로 제거.
7. **위젯은 메시지 리플레이가 아니라 상태 미러로**: 데몬이 그림자 프론트엔드로서 위젯 상태 스냅샷을 유지, 재접속 비용을 상수화.
8. **에디터 인라인 출력은 inset 해킹이 아니라 Cell View로**: `.py`를 NotebookSerializer로 셀 문서로 열어 출력이 셀 아래에 네이티브로 붙게 한다. 디스크 포맷(.py)과 표시 형태(셀)를 분리 — 출력의 진실은 항상 저널이고, 텍스트 뷰와 Cell View는 같은 진실의 두 표현.
