# Tithon과 vscode-jupyter 비교 분석

> 상태: 참고용 분석 문서. 구현 코드는 변경하지 않는다.
>
> 비교 대상: Tithon `extension/`, `src/tithon/`, `docs/SPEC.md`와 로컬에 저장된
> `vscode-jupyter/` 소스 (Jupyter 확장 `2026.6.1`).

## 0. 이 문서의 출처

두 번의 독립 분석을 교차검증해 하나로 합친 문서다. 두 분석은 접근 방향이 달라 결과가 거의
서로소였고, 중복은 2건(위젯 단방향, reconnect/crash UX)뿐이었다.

| | 분석 A (sol) | 분석 B (fable) |
| --- | --- | --- |
| 시점 / 기준 커밋 | 2026-07-19, `84e2773` 이전 | 2026-07-25, `756497e` |
| 접근 | 위→아래: 책임경계·프로토콜 알고리즘 차용 설계 | 아래→위: 구체적 실패 시나리오 + `file:line` |
| 강점 | 구조적 gap, 비차용 경계, 테스트 시나리오 | 개별 결함의 재현 경로와 심각도 |
| 약점 | 개별 버그를 거의 못 잡음 | 프로토콜/구조 레벨 gap을 통째로 놓침 |

§4의 모든 항목은 2026-07-25에 HEAD(`266561e`) 코드에 직접 대조해 재검증했다. 검증 과정에서
정정된 주장은 §5에, 두 분석 모두 놓친 항목은 §4에 `본 문서` 출처로 표기했다.

## 1. 결론

Tithon은 `vscode-jupyter`를 축소판으로 만들기보다, Jupyter의 실행 수명주기·출력 이벤트 처리·위젯
통신 패턴을 선택적으로 차용하는 편이 맞다.

두 코드베이스는 표면적으로 모두 VS Code에서 Jupyter kernel과 notebook output을 다루지만, 핵심
책임 경계가 다르다.

- `vscode-jupyter`: VS Code 확장 호스트가 `@jupyterlab/services`로 kernel session과 socket을 직접 소유한다.
- Tithon: daemon이 detached kernel, FIFO 실행 큐, journal, folded output, widget mirror를 소유하고
  VS Code 확장은 projection client 역할을 한다.

따라서 Jupyter의 `BaseKernel`, `KernelExecution`, 직접 kernel socket bridge를 그대로 복사하면
Tithon의 영속 daemon 구조와 두 개의 상태 권위자가 충돌할 수 있다. 가져올 대상은 원본 클래스보다
다음 경계 알고리즘이다.

1. shell reply와 IOPub 완료를 결합하는 execution completion barrier
2. cell별 실행 상태 객체와 cancel/restart/dispose 수명주기
3. notebook/session 전체의 `display_id` registry
4. reconnect·kernel crash의 상태 전이와 사용자 피드백
5. 양방향 widget comm 및 renderer readiness 처리

## 2. 구조 비교

| 기준 | vscode-jupyter | Tithon | 판단 |
| --- | --- | --- | --- |
| Kernel 소유자 | 확장 호스트의 Jupyter session | daemon의 detached ipykernel | Tithon의 현재 경계를 유지 |
| 상태 저장 | kernel/session과 확장 메모리 중심 | SQLite WAL journal + folded snapshot + artifact | Tithon이 reconnect/장기 실행에 더 적합 |
| 실행 큐 | `CellExecutionQueue`가 extension 내부에서 관리 | daemon 세션별 FIFO queue | 큐를 이중화하지 말고 client adapter만 보강 |
| 출력 완료 | shell reply, idle IOPub, message handler를 함께 추적 | shell reply 후 50ms grace | Tithon의 완료 판정 개선 필요 (§4-1) |
| 출력 갱신 | notebook 전체 `display_id` 추적, cross-cell update | execution/cell-local map 중심 | session-level registry 차용 가치가 큼 (§4-4) |
| Widget | kernel socket을 통한 양방향 comm | kernel → daemon → client mirror, 현재 receive-only | protocol adapter로 양방향 확장 (§4-7) |
| Widget module | local/remote/CDN source provider와 timeout | base/controls 번들 중심 | third-party widget 계획이 있을 때만 확장 |
| Reconnect | 연결 상태 monitor, progress, crash UX | snapshot 재동기화와 exponential backoff | transport는 Tithon 유지, UX는 Jupyter 참고 |
| 실행 완료 신호 | idle-status + shell reply + fallback timer 휴리스틱 | journal의 명시적 `tithon.queued/started/done` | **Tithon이 우위** — §3 참조 |

Jupyter 쪽은 범용 kernel, 원격 서버, raw kernel, debugger, variable explorer, telemetry까지 포함하는
대규모 제품이다. Tithon의 핵심 소스는 훨씬 작고 목적도 "영속 session과 output restore"에 집중되어
있으므로 전체 구조를 이식하는 것은 과도하다.

## 3. Tithon에서 유지할 강점

다음 구조는 Jupyter 코드보다 Tithon의 제품 목표에 더 잘 맞으므로 유지해야 한다.

- append-only SQLite WAL journal과 raw IOPub 보존 ([`journal.py`](../src/tithon/journal.py#L1))
- image payload를 base64 대신 artifact file/reference로 저장 (단, comm 경로에 구멍이 있다 — §4-8)
- snapshot + delta + monotonic sequence 기반 attach ([`daemon.py`](../src/tithon/daemon.py#L1142))
- bounded subscriber queue와 느린 client 자동 drop
- daemon이 실행 큐와 kernel 상태의 단일 source of truth인 구조
- `cell_hash`와 origin을 이용한 output-to-cell 복원
- server/client 양쪽의 folded output과 live update coalescing
- reconnect 시 실행 상태·시작 시각·종료 시각 복원 ([`sessionController.ts`](../extension/src/sessionController.ts#L271))
- self-contained widget MIME으로 초기 state 도착 race를 줄이는 renderer ([`richOutput.ts`](../extension/src/richOutput.ts#L15))

특히 **실행 완료 판정의 권위**가 구조적 우위다. vscode-jupyter에는 영속 기록자가 없어서, 확장
호스트가 리로드되면 "이 셀이 끝났는가, 출력은 무엇인가"를 사후 도착하는 live kernel 메시지만으로
재구성해야 한다. `cellExecutionMessageHandler.ts:300-403`의 `onKernelAnyMessage`가 그 결과다 —
idle-status + shell reply를 공식 신호로 쓰되, 안 오는 경우를 위한 100ms/1s fallback 타이머, 그리고
`execute_input`/`kernel_info_reply`를 "새 요청이 왔으니 이전 건 끝났을 것"으로 스니핑하는 층이
겹쳐 있고, 코드 주석 자체가 이를 "a hacky way of ending the execution"이라고 부른다.

Tithon은 monotonic `seq`와 명시적 `tithon.queued`/`tithon.started`/`tithon.done` 수명주기 이벤트를
가진 journal을 daemon이 소유한다 ([`journal.py`](../src/tithon/journal.py#L1),
[`daemon.py`](../src/tithon/daemon.py#L833)). 재접속 클라이언트는 메시지 경쟁에서 추론하지 않고
journal을 읽어 셀 상태를 확정한다. `sessionController.ts`의 reconnect 경로(`startLive`, `seedCell`)에
타이머도 휴리스틱도 없는 이유가 이것이다. **아래 §4의 개선안은 이 선택을 확장하는 것이지 대체하는
것이 아니다.**

## 4. 검증된 gap — 통합 우선순위

각 항목은 HEAD(`266561e`)에서 코드로 확인했다. `출처`는 어느 분석이 잡았는지를 뜻한다.

| 순위 | 항목 | 출처 | 심각도 |
| --- | --- | --- | --- |
| 1 | 고정 50ms grace → completion barrier | sol | High |
| 2 | `execute_reply.payload` 폐기 → `?`/`??` 무반응 | fable | High |
| 3 | daemon 생존 중 kernel death 미탐지 | fable (= RISKS#3 잔여) | High |
| 4 | session 전체 `display_id` resolution | sol | Medium |
| 5 | `exec_id` 중심 execution lifecycle adapter | sol | Medium |
| 6 | traceback 포매팅 / reconnect progress UX | fable + sol | Low |
| 7 | `_await_reply` shell 라우팅 정리 → 양방향 widget comm | 본 문서 + 양쪽 공통 | Medium |
| 8 | journal pruning 부재 + 시작 시 전체 스캔 | 본 문서 | Medium |
| 9 | comm 경로의 artifact store 우회 (범위 축소판) | fable (정정) | Medium |
| 보류 | `raises-exception` 태그 / third-party widget loader | fable / sol | — |

### 4-1. [High] 고정 50ms grace를 execution completion barrier로 교체

현재 daemon은 `execute_reply`를 받은 뒤 `await asyncio.sleep(0.05)` 후 execution을 완료 처리한다
([`daemon.py`](../src/tithon/daemon.py#L742)). shell reply만 보고 **동일 parent의 IOPub `idle`은 전혀
보지 않는다**. 로컬에서는 동작하지만 터널·원격·고출력·widget comm에서는 마지막 IOPub이 50ms보다
늦게 도착해 **출력이 잘릴 수 있다**. Tithon이 겨냥하는 환경이 정확히 그 환경이므로 우선순위가
가장 높다.

Jupyter는 shell reply, 동일 parent의 IOPub `idle`, shell reply 이후에도 도착하는 IOPub/comm을 함께
추적한다 ([`cellExecution.ts`](../vscode-jupyter/src/kernels/execution/cellExecution.ts#L56),
[`cellExecutionMessageHandler.ts`](../vscode-jupyter/src/kernels/execution/cellExecutionMessageHandler.ts#L300)).

Tithon에 적합한 형태는 execution별로 `shell_reply_seen`, `idle_seen`, 마지막 IOPub journal sequence
(drain marker), late comm/widget output용 handler 유지 여부를 두는 것이다. 핵심은 **sleep을 늘리는
것이 아니라 protocol 상태로 완료를 판정하는 것**이다.

### 4-2. [High] `execute_reply.payload` 폐기 — `?`/`??` 페이저가 조용히 무반응

[`_await_reply`](../src/tithon/daemon.py#L756)는 `content.get("status")`와
`content.get("execution_count")`만 읽고 반환한다 ([`daemon.py`](../src/tithon/daemon.py#L779)).
`payload` 필드는 한 번도 보지 않는다. 이 필드는 IPython의 `page` payload(`?`/`??` 도움말 페이저)와
`set_next_input`(`%load`, `%recall` 등)을 실어 나른다.

**구체적 실패**: 셀에서 `obj?` — IPython 사용자가 가장 먼저 치는 관용구 — 를 실행하면 **출력도
에러도 없다**. 침묵하는 기능 공백이고, 실사용자가 낼 첫 버그리포트로 가장 유력하다.

vscode-jupyter는 `handleExecuteReply`
([`cellExecutionMessageHandler.ts`](../vscode-jupyter/src/kernels/execution/cellExecutionMessageHandler.ts#L885))가
`reply.payload`를 순회해 `set_next_input`은 `WorkspaceEdit`으로 다음 셀에 적용하고, `text/plain`을
가진 payload는 stream output으로 렌더한다.

최소 수정은 `page` payload의 `text/plain`을 stream output으로 흘리는 것으로, `_await_reply`에 몇 줄이면
된다. `set_next_input`의 셀 삽입은 daemon이 cell 구조를 알아야 해서 daemon/client 분리에 어긋나므로
별도 ADR 사안으로 미룬다.

### 4-3. [High] daemon이 살아있는 채로 kernel이 죽으면 탐지되지 않는다

`KernelHandle.is_alive()`는 실행 경로 세 곳에서만 호출된다 —
[`_wait_kernel_ready`](../src/tithon/daemon.py#L487), `_run_one` 제출 직전
([`daemon.py`](../src/tithon/daemon.py#L731)), [`_await_reply`](../src/tithon/daemon.py#L756)의 poll
timeout. 그 외에 `kernel_status`는 iopub `status` 메시지 파싱으로만 갱신된다. kernel이 **idle 상태에서**
죽으면(호스트 OOM-kill, 운영자 kill, 원격 호스트 유실) 아무도 관찰하지 않는다.

이는 신규 발견이 아니라 **ADR-075가 명시적으로 남긴 known false negative**다: 재부팅 감지는
`Session.start()` 재진입에 의존하는데, daemon이 살아 있으면 `start()`가 다시 불리지 않아
`_classify_kernel_generation()`이 돌지 않는다 (`.claude/RISKS.md` #3 잔여 항목). 독립 분석이 같은
지점을 다시 짚었다는 점에서 확증 가치가 있다.

vscode-jupyter는 `KernelCrashMonitor`, `KernelAutoReconnectMonitor`가 셀 실행 여부와 무관하게
`connectionStatusChanged`/`onKernelStatusChanged`를 상시 구독하고, `dead`/`autorestarting` 전이에서
즉시 에러를 띄우고 마지막 실행 셀을 닫아 표시한다
([`kernelCrashMonitor.ts`](../vscode-jupyter/src/kernels/kernelCrashMonitor.ts#L19),
[`kernelAutoReConnectMonitor.ts`](../vscode-jupyter/src/kernels/kernelAutoReConnectMonitor.ts#L120)).

**주의 — 순진한 수정안은 동작하지 않는다.** idle-GC sweep에 얹으면 된다는 제안이 있었으나,
`_gc_loop`는 `idle_timeout > 0`일 때만 생성되고([`daemon.py`](../src/tithon/daemon.py#L1087))
기본값은 0(off)이다([`daemon.py`](../src/tithon/daemon.py#L84)). 기본 설정에는 얹을 루프 자체가
없으므로 **`idle_timeout`과 무관한 독립 watchdog task**가 필요하다. 죽음을 감지하면 기존
`killed`/`gc` 이벤트와 같은 모양으로 `tithon.kernel {"status": "dead"}`를 journal에 남겨 delta replay로
클라이언트에 전달하고, 확장은 `client.onEvent` 훅에 분기를 추가하면 된다(배관은 이미 있다).

### 4-4. [Medium] session/notebook 전체 `display_id` registry

현재 Tithon은 동일 cell 안의 `update_display_data`를 in-place로 교체한다
([`sessionController.ts`](../extension/src/sessionController.ts#L369)). `LiveOutputSync`도 update를
coalesce한다 ([`liveSync.ts`](../extension/src/liveSync.ts#L248)).

그러나 확장의 키가 `${cellIndex}:${displayId}`이고
([`sessionController.ts`](../extension/src/sessionController.ts#L160)) daemon의 `ExecutionFold`가
execution 단위이므로 ([`folding.py`](../src/tithon/folding.py#L79)), Cell A가 만든 display를 Cell B가
갱신하는 cross-cell update는 처리되지 않고 새 output을 append하는 경로로 흘러내린다.

Jupyter는 notebook별로 `display_id -> output container`, 소속 cell, clear/delete 시 registry 제거,
타 cell에서 온 update, 내용이 동일하면 replace 생략까지 추적한다
([`cellDisplayIdTracker.ts`](../vscode-jupyter/src/kernels/execution/cellDisplayIdTracker.ts#L15)).

**확장에만 map을 추가하면 reconnect snapshot과 live 결과가 갈린다.** daemon에도 session-level display
registry 또는 동일 효과의 durable target resolution이 함께 있어야 한다 — 이 "양쪽 동시" 제약이
이 항목의 핵심이다.

SPEC에는 `update_display_data`가 아직 append 방식이라고 적혀 있지만
([`SPEC.md`](./SPEC.md#L416)), 현재 코드는 동일 cell in-place update까지 구현되어 있다. 남은 gap은
"append만 지원"이 아니라 "session 전체 display_id 추적"이다.

### 4-5. [Medium] `exec_id` 중심의 remote cell execution adapter

daemon은 이미 `queued`, `running`, `done`, `error`, `orphaned`, `skipped` 상태를 갖는다. 반면 확장
쪽은 실행 상태와 렌더링이 `SessionClient`, `LiveOutputSync`, `VSCodeCellSink`에 분산되어 있다
([`sessionClient.ts`](../extension/src/sessionClient.ts#L70),
[`sessionController.ts`](../extension/src/sessionController.ts#L152)).

Jupyter에서 차용할 패턴은 `CellExecution`(한 셀 실행의 시작·종료·취소·실패 캡슐화),
`CellExecutionQueue`(상태 명시), `CellExecutionCreator`(셀당 execution 재사용, 중복 방지), graceful/
forced cancel 구분, notebook close·kernel dead·restart 시 잔여 execution 정리다
([`cellExecutionQueue.ts`](../vscode-jupyter/src/kernels/execution/cellExecutionQueue.ts#L17),
[`cellExecutionCreator.ts`](../vscode-jupyter/src/kernels/execution/cellExecutionCreator.ts#L17)).

단, **Jupyter의 queue를 확장에 복제하면 안 된다.** daemon queue가 이미 권위 있는 실행 순서를
보장한다. 확장에는 `exec_id`를 primary identity로 하는 adapter를 두고 cell index는 현재 render
target으로만 쓴다. adapter 책임: execute ack → queued → started → terminal 전이, reconnect 중인
running execution 재연결, interrupt/restart/dispose의 single-flight, **kernel generation이 바뀐 뒤
도착한 stale event 무시**, notebook close/controller dispose 시 idempotent 종료.

ADR-075가 durable `kernel_generation`(journal seq)을 이미 도입했으므로 stale-event 필터를 붙이기에
지금이 적기다.

### 4-6. [Low] traceback 포매팅과 reconnect progress UX

`toOutputItems`의 error 분기는 `ename`/`evalue`/`traceback`을 그대로
`NotebookCellOutputItem.error(...)`에 넘긴다 ([`sessionController.ts`](../extension/src/sessionController.ts#L84)).
IPython 8의 프레임(`Cell In[3], line 7`)은 평문으로 렌더되고, 커널이 실은 배경색 ANSI 코드가 다크
테마와 충돌할 수 있다.

vscode-jupyter의 `NotebookTracebackFormatter`는 배경색 ANSI(`[4\dm`)를 제거하고 `-->` 이후 전경색을
정규화하며, `Cell In[N], line M`을 실패 라인으로 점프하는 링크로 바꾼다
([`tracebackFormatter.ts`](../vscode-jupyter/src/notebooks/outputs/tracebackFormatter.ts#L38)).
Tithon은 cell↔execution 동일성을 이미 해석하므로(`cellAttach.ts`) 점프 타깃은 확보되어 있다.
`richOutput.ts` 옆에 순수 함수로 포팅하면 된다.

reconnect/restart 표시도 같은 묶음이다. 현재는 `setStatusBarMessage`의 순간 플래시뿐이고
([`extension.ts`](../extension/src/extension.ts#L420),
[`sessionController.ts`](../extension/src/sessionController.ts#L1196)), daemon 재기동은 최대 15초까지
걸릴 수 있는데 진행 표시가 없다. Jupyter의 `withProgress(ProgressLocation.Notification, ...)`처럼
재접속 창 전체에 걸쳐 보이는 표시로 바꾸고, `connecting`/`reconnecting`/`connected`/`disconnected`를
구분하며 의도적 dispose와 실제 장애(daemon down, kernel dead, backpressure drop, restart)를 구별한다.

참고: "host reboot 후 output은 복원되나 variables는 사라짐"을 알리는 Tithon 고유 UX는 **ADR-075로
이미 구현되었다**(journal 파생 `lost_state` + `kernel_generation` 1회성 경고).

### 4-7. [Medium] `_await_reply`의 shell 라우팅 정리 → 양방향 widget comm

[`WidgetMirror`](../src/tithon/widgets.py#L1)는 kernel → daemon 방향 snapshot만 만들고, renderer는
`set_state`로 적용한다 ([`widgetRendererEntry.ts`](../extension/src/widgetRendererEntry.ts#L68)).
renderer가 kernel로 보내는 back-channel은 없다. 결과적으로:

- `tqdm.notebook`, `HTML`/`Label`, `Progress` 등 표시 전용 위젯은 정상 동작한다.
- `IntSlider`, `Button`, `Text`, `Checkbox`, `interact()` 기반은 **렌더는 되지만** 슬라이더를 끌거나
  버튼을 눌러도 `comm_msg`가 커널에 닿지 않는다. 에러조차 없어서 "동작할 것처럼 보이는" 침묵
  실패다.

**선행 조건 (본 문서 발견)**: [`_await_reply`](../src/tithon/daemon.py#L764)의 루프는 `execute_reply` +
parent msg_id 일치가 아닌 shell 메시지를 **전부 조용히 버린다**. in-flight execution이 하나뿐인 지금은
무해하지만, 양방향 comm을 붙여 shell 채널에 `comm_info_request`/`comm_msg` 응답이 실리는 순간 이
루프가 먹어버린다. shell 채널을 exec-reply 대기 루프에서 분리해 msg_id 기준으로 라우팅하는 리팩터가
양방향 위젯보다 먼저 와야 한다.

그 다음 경로는 다음과 같다.

```text
widget renderer
  -> VS Code renderer messaging
  -> extension
  -> daemon WebSocket op
  -> kernel comm channel
```

Jupyter의 [`ipyWidgetMessageDispatcher.ts`](../vscode-jupyter/src/notebooks/controllers/ipywidgets/message/ipyWidgetMessageDispatcher.ts#L120)에서
차용할 핵심은 연결 전 pending message queue, binary buffer 직렬화, comm target 등록, kernel restart 시
재등록, message hook 정리와 ack다. daemon의 `WidgetMirror`는 계속 snapshot의 권위자로 유지하고,
outbound comm은 request/ack·timeout·session ownership·kernel generation을 명시해야 한다.

중간 완화책으로, 상호작용형 위젯을 `_model_name` allow-list로 걸러 텍스트 요약
([`richOutput.ts`](../extension/src/richOutput.ts#L139))으로 폴백시키면 침묵 실패를 **정직한 실패**로
바꿀 수 있다. 양방향 구현 여부와 무관하게 먼저 넣을 만하다.

### 4-8. [Medium] journal pruning 부재 + 세션 시작 시 전체 스캔 (본 문서)

`Session.start()`는 [`_rebuild_folds()`](../src/tithon/daemon.py#L459)와
[`_rebuild_mirror()`](../src/tithon/daemon.py#L479)를 부른다
([`daemon.py`](../src/tithon/daemon.py#L233)). 후자는 `journal.messages_after(0)`을 호출하는데, 이는
**전체 메시지 테이블을 파이썬 list로 통째 로드**한다 ([`journal.py`](../src/tithon/journal.py#L115)).
전자도 모든 execution의 메시지를 순회한다. 그리고 `journal.py`의 `DELETE`는 artifacts 테이블용
하나뿐 — **메시지 journal에는 pruning/compaction이 전혀 없다**.

즉 tqdm/live widget을 한 번 오래 돌린 세션은 daemon 재시작 또는 lazy re-attach마다 전체 히스토리를
메모리에 올린다. 지속성 설계의 대가이고, 두 분석 모두 다루지 않았다. 방향: (a) `_rebuild_mirror`를
스트리밍/커서 기반으로 바꾸고, (b) mirror 재구성용 comm 체크포인트(주기적 state snapshot 후 이전
comm 메시지 폐기)를 도입한다. (b)는 "모든 iopub/shell 메시지를 verbatim 보존" 불변식을 건드리므로
ADR과 사전 설계 비평이 필요하다.

### 4-9. [Medium] comm 경로가 artifact store를 우회 (범위 정정본)

rich output 추출은 iopub `display_data`/`execute_result`/`update_display_data`에서만 돈다 —
`artifacts.extract` 호출 지점은 [`daemon.py`](../src/tithon/daemon.py#L579) **단 한 곳**이다. comm
메시지는 [`_handle_comm`](../src/tithon/daemon.py#L599)이라는 **별도 경로**로 처리되며 `content`를
(buffers는 base64로) **verbatim** 저장한다 — artifact 추출이 전혀 개입하지 않는다. `Output` 위젯의
`outputs` trait은 nbformat output entry 모양이라 base64 이미지를 담을 수 있고, 그 경우 SQLite에
그대로 들어간다. `.claude/CLAUDE.md`의 불변식("image/*는 base64로 embed하지 않는다") 위반이며,
comm state에는 `ExecutionFold.artifact_ids()`에 해당하는 GC 기준도 없다.

**단, 흔한 라이브 플롯 관용구는 여기에 해당하지 않는다** — §5-1의 정정을 반드시 함께 읽을 것.
실제 노출 면은 `out.append_display_data()` / `Output(outputs=[...])` 같은 명시적 trait 대입 경로로
좁다. 수정 방향은 `data.method in ("update", "echo_update")`이고 `data.state`에 `outputs` 키가 있을 때
각 entry의 `data`를 동일한 `artifacts.extract`에 통과시키는 것이며, exec_id가 아니라
comm_id + output-index로 키를 잡는 ref-counting이 함께 필요하다(Output 위젯의 수명은 한 execution에
묶이지 않는다).

### 4-보류-A. `raises-exception` 태그 / third-party widget module loader

`submit_batch`의 `stop_on_error`는 배치 전체에 대한 단일 플래그라, 한 셀이 실패하면 그 Run-All의
나머지가 무조건 skip된다(ADR-051의 의도된 동작). Jupyter는 셀별 `raises-exception` 태그를 확인해
해당 셀의 실패를 중단 사유로 삼지 않는다
([`cellExecutionQueue.ts`](../vscode-jupyter/src/kernels/execution/cellExecutionQueue.ts#L246)).
percent-format `.py`에는 태그 문법이 없으므로(`serializer.ts`의 `MARKER_RE`는 `[markdown]`/`[raw]`만
구분) 먼저 표기 규약(예: `# %% tags=["raises-exception"]`)이 필요하다. **이것 하나를 위해 태그 문법을
발명할 가치는 아직 없다.**

third-party widget module loader(`ipympl`, `plotly`, `bqplot`)도 마찬가지로 실수요가 생길 때 착수한다.
Jupyter는 `nbextensions` 탐색, remote script source, 선택적 CDN fallback, module/version별 cache,
load timeout UX, webview ready 전 queue를 지원한다
([`ipyWidgetScriptSource.ts`](../vscode-jupyter/src/notebooks/controllers/ipywidgets/scriptSourceProvider/ipyWidgetScriptSource.ts#L100),
[`scriptManager.ts`](../vscode-jupyter/src/webviews/webview-side/ipywidgets/kernel/scriptManager.ts#L143)).
현재 `tqdm`/controls 범위라면 양방향 comm과 readiness queue를 먼저 보고 module loader는 보류한다.
Tithon의 self-contained custom MIME은 초기 state race를 줄이는 좋은 설계이므로 Jupyter의 직접 kernel
proxy로 교체하지 않고, output별 pending update buffer와 renderer ready/updated ack를 더하는 방향이 맞다.

### 4-보류-B. output fidelity와 controller guard

Jupyter의 output converter는 MIME 우선순위, `metadata`, `transient`, `execution_count`, error output을
더 충실히 보존한다 ([`helpers.ts`](../vscode-jupyter/src/kernels/execution/helpers.ts#L129)). Tithon의
`toOutputItems`는 image/widget/html/text 중 하나를 고르는 단순 변환이다
([`sessionController.ts`](../extension/src/sessionController.ts#L76)). 차용할 부분: MIME fallback 규칙,
metadata/transient 보존 테스트, 내용이 동일할 때 `replaceOutputItems` 생략, stale/deleted cell 필터링,
workspace trust 확인, controller 변경 시 이전 execution 종료, `DisposableStore` 스타일의 notebook별
subscription 정리. 단 Tithon의 artifact reference와 custom widget MIME을 보존해야 하므로 Jupyter의
converter나 `nbformat` 의존성을 그대로 복사하지 말고 변환 규칙과 테스트 케이스만 참고한다.

## 5. 검증 중 정정된 주장

교차검증 과정에서 원 분석의 주장 일부가 코드/실증과 어긋나는 것으로 확인되었다. 후속 세션이 원
문서만 보고 잘못 착수하지 않도록 남긴다.

### 5-1. `Output` 위젯 라이브 플롯은 comm으로 base64를 보내지 않는다

`with out: plt.show()`가 figure를 comm state에 base64로 싣는다는 서술은 **ipywidgets 8에서 사실이
아니다**. 2026-06-15 jupyter_client 재현으로 실증된 바(메모리 `tithon-output-widget-plot-path`)는
`msg_id` 라우팅이다 — comm으로는 `comm_msg(method=update, state={msg_id})`만 가서 셀의 parent msg_id를
선점하고, figure는 **평범한 iopub `display_data`**(image/png, `display_id=None`)로 publish된 뒤
`clear_output(wait=True)`가 뒤따르고, 마지막에 msg_id를 해제하는 comm_msg가 온다.

따라서 이 관용구는 이미 `_handle_iopub` → `ArtifactStore.extract`를 타고, `ExecutionFold`가
`clear_output(wait)+display_data`를 최신 프레임으로 접어주므로 **fold 기반 artifact GC까지 정상
동작한다**(ADR-038/039/040, v31로 검증). §4-9의 실제 노출 면은 이보다 훨씬 좁다.

### 5-2. idle-GC sweep에 liveness 검사를 얹는 수정안은 기본 설정에서 동작하지 않는다

§4-3에 적은 대로 `_gc_loop`는 `idle_timeout > 0`에서만 생성되고 기본값은 0이다. "이미 60초마다 도는
루프"는 기본 구성에 존재하지 않는다.

### 5-3. 시점 차이로 이미 해결된 항목

- host reboot 시 "출력은 복원되나 variables는 사라짐"을 알리는 Tithon 고유 UX → **ADR-075 완료**.
- LSP/notebook-URI 취약성 → **ADR-074**로 hardening(불변식 I1..I5 + Insiders 조기경보 번들).
- 혼합 output 셀의 복원 붕괴 → **ADR-070** 완료.

§4-3은 ADR-075가 스스로 남긴 잔여 false negative를 가리키는 것이지 ADR-075가 미완이라는 뜻이 아니다.

## 6. 테스트로 먼저 고정할 시나리오

구현 세션은 다음을 먼저 추가하거나 기존 검증 번들에 편입하는 것이 좋다.

1. `execute_reply`가 마지막 IOPub보다 먼저 도착하는 execution (§4-1)
2. shell reply 이후 도착하는 widget comm/output (§4-1)
3. `obj?` / `obj??`가 페이저 출력을 내는지 (§4-2)
4. daemon이 살아있는 채로 kernel을 SIGKILL → 다음 실행 없이도 dead가 클라이언트에 도달 (§4-3)
5. interrupt 중 kernel dead, interrupt timeout, restart race
6. reconnect 중인 running/queued/orphaned execution의 상태 복원
7. Cell A의 `display_id`를 Cell B가 갱신하는 cross-cell update (§4-4)
8. clear/delete 이후 stale `display_id` update
9. renderer ready 이전 widget update와 model 생성 지연
10. outbound widget binary buffer와 kernel restart 후 재등록 (§4-7)
11. 같은 session에 두 client를 붙인 뒤 client A의 실행을 client B가 보는 경우 (RISKS#4)
12. backpressure drop 후 snapshot 재동기화
13. 대용량 journal에서의 세션 재시작 시간/메모리 (§4-8)

Tithon은 이미 동일 cell `update_display_data` coalescing, snapshot/delta equivalence, widget mirror
restore, reconnect restore에 대한 단위·통합 테스트를 갖고 있다. 새 테스트는 기존 coverage를
대체하지 말고 위 edge case를 보강해야 한다.

## 7. 가져오지 않을 것

다음은 현재 Tithon의 범위와 책임 경계에 맞지 않거나 과도하다.

- `BaseKernel`, `KernelConnector`, Jupyter의 직접 kernel session 관리
- Jupyter의 전체 `CellExecutionQueue`를 extension에 복제하는 것
- `inversify` 기반의 전체 서비스 컨테이너
- kernel discovery, remote Jupyter server provider, raw kernel
- debugger, variable explorer, data viewer 등 제품 기능
- Jupyter의 직접 socket 기반 widget webview proxy
- 대규모 Jupyter telemetry/제품별 UX 계층
- 실행 완료를 idle-status + fallback 타이머로 추론하는 휴리스틱 스택 (§3 — journal이 대신한다)

Tithon extension에는 단순한 constructor-injected interface와 remote execution adapter 정도면 충분하다.
규모가 커질 때만 `ISessionTransport`, `IExecutionProjection`, `IWidgetBridge`, `IOutputResolver`로
분리한다.

## 8. 향후 개발 순서

1. **completion barrier**와 late IOPub/comm 테스트 (§4-1)
2. **`execute_reply.payload` → 페이저 출력** (§4-2) — 공수 대비 사용자 체감이 가장 크다
3. **kernel liveness watchdog** (§4-3) — ADR-075의 알려진 false negative를 닫는다
4. daemon + extension 양쪽의 **session-level `display_id` resolution** (§4-4)
5. **`exec_id` 중심 execution adapter** 및 interrupt/restart/dispose 정리 (§4-5)
6. traceback 포매터 / reconnect progress UX (§4-6)
7. **shell 라우팅 분리** → 양방향 widget comm (§4-7)
8. journal 스캔/pruning (§4-8), comm artifact 추출 (§4-9)
9. 필요할 때 third-party widget module loader, `raises-exception` 태그

Jupyter 소스에서 코드를 직접 복사할 때는 해당 기능이 daemon-owned kernel protocol과 어떻게
연결되는지 먼저 확인해야 한다. 원본 파일의 책임 경계를 그대로 가져오는 것은 금지한다. 불변식을
건드리는 항목(§4-8의 comm 체크포인트, §4-9의 artifact 추출 확장)은 착수 전 ADR과 사전 설계 비평을
거친다.
