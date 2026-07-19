# Tithon과 vscode-jupyter 비교 분석

> 상태: 참고용 분석 문서. 이 문서 작성 시점에는 Tithon 구현 코드를 변경하지 않았다.
>
> 분석일: 2026-07-19 (KST)
>
> 비교 대상: Tithon `extension/`, `src/tithon/`, `docs/SPEC.md`와 로컬에 저장된
> `vscode-jupyter/` 소스. 로컬 Jupyter 확장 버전은 `2026.6.1`이다.

## 1. 결론

Tithon은 `vscode-jupyter`를 축소판으로 만들기보다, Jupyter의 실행 수명주기·출력 이벤트 처리·위젯 통신 패턴을 선택적으로 차용하는 편이 맞다.

두 코드베이스는 표면적으로 모두 VS Code에서 Jupyter kernel과 notebook output을 다루지만, 핵심 책임 경계가 다르다.

- `vscode-jupyter`: VS Code 확장 호스트가 `@jupyterlab/services`로 kernel session과 socket을 직접 소유한다.
- Tithon: daemon이 detached kernel, FIFO 실행 큐, journal, folded output, widget mirror를 소유하고 VS Code 확장은 projection client 역할을 한다.

따라서 Jupyter의 `BaseKernel`, `KernelExecution`, 직접 kernel socket bridge를 그대로 복사하면 Tithon의 영속 daemon 구조와 두 개의 상태 권위자가 충돌할 수 있다. 가져올 대상은 원본 클래스보다 다음 경계 알고리즘이다.

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
| 출력 완료 | shell reply, idle IOPub, message handler를 함께 추적 | shell reply 후 50ms grace | Tithon의 완료 판정 개선 필요 |
| 출력 갱신 | notebook 전체 `display_id` 추적, cross-cell update | execution/cell-local map 중심 | session-level registry 차용 가치가 큼 |
| Widget | kernel socket을 통한 양방향 comm | kernel → daemon → client mirror, 현재 receive-only | protocol adapter로 양방향 확장 |
| Widget module | local/remote/CDN source provider와 timeout | base/controls 번들 중심 | third-party widget 계획이 있을 때만 확장 |
| Reconnect | 연결 상태 monitor, progress, crash UX | snapshot 재동기화와 exponential backoff | transport는 Tithon 유지, UX는 Jupyter 참고 |

Jupyter 쪽은 범용 kernel, 원격 서버, raw kernel, debugger, variable explorer, telemetry까지 포함하는 대규모 제품이다. Tithon의 핵심 소스는 훨씬 작고 목적도 “영속 session과 output restore”에 집중되어 있으므로 전체 구조를 이식하는 것은 과도하다.

## 3. Tithon에서 유지할 강점

다음 구조는 Jupyter 코드보다 Tithon의 제품 목표에 더 잘 맞으므로 유지해야 한다.

- append-only SQLite WAL journal과 raw IOPub 보존 ([`journal.py`](../src/tithon/journal.py#L1))
- image payload를 base64 대신 artifact file/reference로 저장
- snapshot + delta + monotonic sequence 기반 attach ([`daemon.py`](../src/tithon/daemon.py#L1142))
- bounded subscriber queue와 느린 client 자동 drop
- daemon이 실행 큐와 kernel 상태의 단일 source of truth인 구조
- `cell_hash`와 origin을 이용한 output-to-cell 복원
- server/client 양쪽의 folded output과 live update coalescing
- reconnect 시 실행 상태·시작 시각·종료 시각 복원 ([`sessionController.ts`](../extension/src/sessionController.ts#L271))
- self-contained widget MIME으로 초기 state 도착 race를 줄이는 renderer ([`richOutput.ts`](../extension/src/richOutput.ts#L15))

특히 snapshot/delta와 journal은 확장 호스트가 종료되어도 실행과 output을 보존한다. Jupyter의 reconnect 코드는 live kernel session 복원에는 유용하지만, host reboot 뒤의 durable history를 대신해 주지는 않는다.

## 4. 차용 우선순위

### P0-A. 고정 50ms grace를 execution completion barrier로 교체

현재 daemon은 `execute_reply`를 받은 뒤 50ms를 기다리고 execution을 완료 처리한다 ([`daemon.py`](../src/tithon/daemon.py#L623)). 이 방식은 정상적인 로컬 환경에서는 동작할 수 있지만, tunnel·원격 환경·고출력·widget comm에서는 마지막 IOPub가 늦게 도착할 수 있다.

Jupyter는 다음을 함께 추적한다.

- 해당 execution의 shell reply
- 동일 parent message의 IOPub `idle`
- shell reply 이후에도 도착할 수 있는 IOPub/comm message

관련 참고 구현은 [`cellExecution.ts`](../vscode-jupyter/src/kernels/execution/cellExecution.ts#L56)와 [`cellExecutionMessageHandler.ts`](../vscode-jupyter/src/kernels/execution/cellExecutionMessageHandler.ts#L300)이다.

Tithon에 적합한 형태는 execution별로 다음 상태를 갖는 것이다.

- `shell_reply_seen`
- `idle_seen`
- 마지막 IOPub journal sequence 또는 drain marker
- late comm/widget output을 처리하기 위한 handler 유지 여부

핵심은 단순히 sleep 시간을 늘리는 것이 아니라 protocol 상태로 완료를 판정하는 것이다.

### P0-B. `exec_id` 중심의 remote cell execution adapter

Tithon daemon은 이미 `queued`, `running`, `done`, `error`, `orphaned`, `skipped` 상태를 갖고 있다. 반면 extension 쪽은 execution 상태와 rendering이 `SessionClient`, `LiveOutputSync`, `VSCodeCellSink`에 분산되어 있다 ([`sessionClient.ts`](../extension/src/sessionClient.ts#L70), [`sessionController.ts`](../extension/src/sessionController.ts#L152)).

Jupyter의 다음 패턴을 차용할 가치가 있다.

- `CellExecution`: 한 cell 실행의 시작·종료·취소·실패를 캡슐화
- `CellExecutionQueue`: queued/running/cancelled/failed 상태를 명확히 관리
- `CellExecutionCreator`: cell당 execution 객체를 재사용하고 중복 execution을 방지
- graceful cancel과 forced cancel을 구분
- notebook close, kernel dead, restart 시 남은 execution을 정리

참고 파일은 [`cellExecutionQueue.ts`](../vscode-jupyter/src/kernels/execution/cellExecutionQueue.ts#L17)와 [`cellExecutionCreator.ts`](../vscode-jupyter/src/kernels/execution/cellExecutionCreator.ts#L17)이다.

단, Jupyter의 queue를 Tithon extension에 복제하면 안 된다. daemon queue가 권위 있는 실행 순서를 이미 보장한다. extension에는 `exec_id`를 primary identity로 하는 adapter를 두고, cell index는 단순한 현재 render target으로만 사용하는 것이 적합하다.

향후 adapter가 책임질 항목:

- execute ack → queued → started → terminal 상태 전이
- reconnect 중인 running execution의 재연결
- interrupt/restart/dispose의 single-flight 처리
- kernel generation이 바뀐 뒤 도착한 stale event 무시
- notebook close와 controller dispose 시 idempotent 종료

### P0-C. session/notebook 전체 `display_id` registry

현재 Tithon은 동일 cell 안의 `update_display_data`를 in-place로 교체할 수 있다 ([`sessionController.ts`](../extension/src/sessionController.ts#L360)). `LiveOutputSync`도 update를 coalesce하고 관련 테스트를 갖고 있다 ([`liveSync.ts`](../extension/src/liveSync.ts#L240)).

그러나 key가 `${cellIndex}:${displayId}`이고 daemon의 `ExecutionFold`가 execution 단위이므로, Cell A가 만든 display를 Cell B가 갱신하는 cross-cell update는 처리하기 어렵다 ([`folding.py`](../src/tithon/folding.py#L64)). 현재 구현은 foreign display를 찾지 못하면 새 output을 append하는 경로로 내려간다.

Jupyter는 notebook별로 다음을 추적한다.

- `display_id -> output container`
- 해당 output이 속한 cell
- output clear/delete 시 registry 제거
- 다른 cell에서 들어온 update
- 실제 output 내용이 같을 때 replace 생략

참고 구현은 [`cellDisplayIdTracker.ts`](../vscode-jupyter/src/kernels/execution/cellDisplayIdTracker.ts#L15)와 [`cellExecutionMessageHandler.ts`](../vscode-jupyter/src/kernels/execution/cellExecutionMessageHandler.ts#L1135)이다.

Tithon에서는 extension의 map만 추가하면 reconnect snapshot과 결과가 달라질 수 있다. 따라서 daemon에도 session-level display registry 또는 동일한 효과의 durable target resolution이 필요하다.

현재 SPEC에는 `update_display_data`가 아직 append 방식이라고 적혀 있지만 ([`SPEC.md`](./SPEC.md#L396)), 현재 코드는 동일 cell in-place update까지 구현되어 있다. 남은 핵심 gap은 “append만 지원”이 아니라 “session/notebook 전체 display_id 추적”이다.

### P1-A. reconnect 및 kernel crash UX

Tithon은 이미 capped exponential backoff reconnect를 구현했고, attach 직후 callback을 등록해 seed/prefetch 중 disconnect도 놓치지 않는다 ([`sessionController.ts`](../extension/src/sessionController.ts#L837), [`sessionController.ts`](../extension/src/sessionController.ts#L1000)).

Jupyter에서 가져올 부분은 transport가 아니라 사용자에게 보이는 상태 모델이다.

- `connecting` / `reconnecting` / `connected` / `disconnected` 구분
- `withProgress` 기반 reconnect 표시
- 의도적인 dispose와 실제 장애 구분
- daemon down, kernel dead, backpressure drop, restart 구분
- 마지막 실행 cell에 원인 표시
- reconnect 성공 시 retry state 초기화

관련 참고 구현은 [`kernelAutoReConnectMonitor.ts`](../vscode-jupyter/src/kernels/kernelAutoReConnectMonitor.ts#L120)와 [`kernelCrashMonitor.ts`](../vscode-jupyter/src/kernels/kernelCrashMonitor.ts#L19)이다.

Jupyter monitor는 Tithon의 host reboot replay를 해결하지 않는다. host reboot 뒤에는 Tithon journal은 남지만 kernel namespace는 사라지므로, “output history는 복원 가능하지만 variables는 사라짐”을 명확히 표시하는 Tithon 고유 UX가 필요하다.

### P1-B. 양방향 widget comm

Tithon의 [`WidgetMirror`](../src/tithon/widgets.py#L1)는 kernel → daemon 방향의 snapshot을 만들고, renderer는 `set_state`로 이를 적용한다 ([`widgetRendererEntry.ts`](../extension/src/widgetRendererEntry.ts#L68)). 현재 renderer가 kernel로 보내는 back-channel은 없다.

Jupyter의 [`ipyWidgetMessageDispatcher.ts`](../vscode-jupyter/src/notebooks/controllers/ipywidgets/message/ipyWidgetMessageDispatcher.ts#L120)에서 차용할 핵심은 다음이다.

- renderer → extension → kernel 메시지 전달
- 연결 전 pending message queue
- binary buffer 직렬화/역직렬화
- comm target 등록
- kernel restart 시 target 재등록
- message hook 정리와 처리 완료 ack

Tithon에서는 다음 경로로 재구성해야 한다.

```text
widget renderer
  -> VS Code renderer messaging
  -> extension
  -> daemon WebSocket op
  -> kernel comm channel
```

daemon의 `WidgetMirror`는 계속 snapshot의 권위자로 유지하고, outbound comm은 request/ack·timeout·session ownership·kernel generation을 명시해야 한다.

### P1-C. third-party widget module loader와 renderer readiness

현재 Tithon은 `@jupyter-widgets/base`와 `@jupyter-widgets/controls`를 직접 해결하고 나머지는 fallback으로 처리한다 ([`widgetRender.ts`](../extension/src/widgetRender.ts#L39)).

Jupyter는 다음을 지원한다.

- Python 환경의 `nbextensions` 탐색
- remote server script source
- 선택적 CDN fallback
- module/version/request id별 cache
- script load timeout과 실패 UX
- webview ready 전 메시지 queue
- 모델 생성 완료까지 render 대기

참고 파일은 [`ipyWidgetScriptSource.ts`](../vscode-jupyter/src/notebooks/controllers/ipywidgets/scriptSourceProvider/ipyWidgetScriptSource.ts#L100), [`scriptManager.ts`](../vscode-jupyter/src/webviews/webview-side/ipywidgets/kernel/scriptManager.ts#L143), [`commonMessageCoordinator.ts`](../vscode-jupyter/src/notebooks/controllers/ipywidgets/message/commonMessageCoordinator.ts#L103)이다.

이 기능은 `ipympl`, `plotly`, `bqplot` 등 third-party widget을 지원할 때만 우선순위가 높다. 현재 `tqdm`/controls 범위라면 먼저 양방향 comm과 readiness queue만 검토하고 module loader는 보류하는 편이 낫다.

Tithon의 self-contained custom MIME은 초기 state race를 줄이는 좋은 설계이므로 Jupyter의 직접 kernel proxy로 교체하지 않는다. 대신 output별 pending update buffer와 renderer ready/updated ack를 추가하는 방향이 적합하다.

### P2. output fidelity와 controller guard

Jupyter의 output converter는 MIME 우선순위, `metadata`, `transient`, `execution_count`, error output을 더 충실히 보존한다 ([`helpers.ts`](../vscode-jupyter/src/kernels/execution/helpers.ts#L129)). Tithon의 `toOutputItems`는 현재 image/widget/html/text 중 하나를 선택하는 단순 변환이다 ([`sessionController.ts`](../extension/src/sessionController.ts#L76)).

가져올 수 있는 부분:

- MIME fallback/우선순위 규칙
- metadata/transient 보존 테스트
- output 내용이 동일할 때 `replaceOutputItems` 생략
- stale/deleted cell filtering
- workspace trust 확인
- controller 변경 시 이전 execution 종료
- `DisposableStore` 스타일의 notebook별 subscription 정리

다만 Tithon의 artifact reference와 custom widget MIME을 보존해야 하므로 Jupyter의 converter나 `nbformat` 의존성을 그대로 복사하지 말고, 변환 규칙과 테스트 케이스만 참고한다.

## 5. 테스트로 먼저 고정할 시나리오

향후 구현 세션에서는 다음 테스트를 먼저 추가하거나 현재 검증 bundle에 편입하는 것이 좋다.

1. `execute_reply`가 마지막 IOPub보다 먼저 도착하는 execution
2. shell reply 이후 도착하는 widget comm/output
3. interrupt 중 kernel dead, interrupt timeout, restart race
4. reconnect 중인 running/queued/orphaned execution의 상태 복원
5. Cell A의 `display_id`를 Cell B가 갱신하는 cross-cell update
6. clear/delete 이후 stale `display_id` update
7. renderer ready 이전 widget update와 model 생성 지연
8. outbound widget binary buffer와 kernel restart 후 재등록
9. 같은 session에 두 client를 붙인 뒤 client A의 실행을 client B가 보는 경우
10. backpressure drop 후 snapshot 재동기화

Tithon은 이미 동일 cell `update_display_data` coalescing, snapshot/delta equivalence, widget mirror restore, reconnect restore에 대한 단위·통합 테스트를 갖고 있다. 새 테스트는 기존 coverage를 대체하지 말고 위 edge case를 보강해야 한다.

## 6. 가져오지 않을 것

다음은 현재 Tithon의 범위와 책임 경계에 맞지 않거나 과도하다.

- `BaseKernel`, `KernelConnector`, Jupyter의 직접 kernel session 관리
- Jupyter의 전체 `CellExecutionQueue`를 extension에 복제하는 것
- `inversify` 기반의 전체 서비스 컨테이너
- kernel discovery, remote Jupyter server provider, raw kernel
- debugger, variable explorer, data viewer 등 제품 기능
- Jupyter의 직접 socket 기반 widget webview proxy
- 대규모 Jupyter telemetry/제품별 UX 계층

Tithon extension에는 단순한 constructor-injected interface와 remote execution adapter 정도면 충분하다. 규모가 커질 때만 `ISessionTransport`, `IExecutionProjection`, `IWidgetBridge`, `IOutputResolver`로 분리한다.

## 7. 향후 개발 순서

1. completion barrier와 late IOPub/comm 테스트
2. `exec_id` 중심 execution adapter 및 interrupt/restart/dispose 상태 정리
3. daemon + extension 양쪽의 session-level `display_id` resolution
4. reconnect 상태 표시와 kernel/daemon 장애 UX
5. 양방향 widget comm
6. 필요할 때 third-party widget module loader

Jupyter 소스에서 코드를 직접 복사할 때는 해당 기능이 daemon-owned kernel protocol과 어떻게 연결되는지 먼저 확인해야 한다. 원본 파일의 책임 경계를 그대로 가져오는 것은 금지한다.
