# Tithon (Τιθωνός)

> 원격 GPU 호스트의 인터랙티브 Python 세션을 **클라이언트 생사와 무관하게 영속화**하고,
> 재접속 시 셀 출력·진행상황·위젯 상태를 **무손실 복원**하는 시스템.
>
> 호스트의 커널은 살아있지만(불사) 클라이언트가 끊기는 순간 출력이 시들어 사라지는
> "티토노스의 저주"를 푸는 것이 목표다 — _immortality, with eternal youth this time._

설계의 단일 진실은 [`docs/design.md`](docs/design.md)다. 본 문서는 **현재 무엇이 동작하고
무엇이 아직 spike인지**, 그리고 동작하는 부분을 **어떻게 직접 써보는지**를 정리한다.

---

## 1. 지금 어디까지 됐나 (정직한 현황)

Tithon은 현재 **Phase 0 PoC 완료** 상태다. Phase 0의 목표는 제품이 아니라 **설계의 핵심
가설("클라이언트와 무관하게 세션을 영속화하고 무손실 복원할 수 있다")을 증명**하는 것이었고,
6개 검증 항목(`make verify` → 6/6 PASS)으로 증명됐다.

### ✅ 완성·검증된 것 — 영속화 엔진 (백엔드 + CLI)

| 항목 | 내용 | 검증 |
|------|------|------|
| 커널 영속 | ipykernel을 detached(setsid)로 spawn. 데몬의 자식이 아니므로 데몬이 죽어도 커널 생존 | v4: 데몬 `kill -9` 후 커널 PID 동일 + 변수 상태 연속 |
| 무손실 저널 | 모든 iopub/shell 메시지를 SQLite(WAL)에 원본 보존 + 실행별 folded 스냅샷 | v1: seq 무결성, v2: 5만 메시지 보존 |
| 재접속 복원 | 단조 증가 seq 기반 snapshot + delta. `attach(last_seen_seq)` 의미론 | v1·v2: client 스트림 == 저널 |
| 리치 출력 | image/* 는 base64 임베딩 금지 → `.tithon/outputs/` 파일로 저장, 저널엔 참조만 | v3: 유효 PNG 파일 + 저널 참조 |
| 위젯 미러 | comm 메시지를 해석해 widget-state+json 스냅샷 상시 유지 (tqdm 5만 update → 막대 1개) | v5: fresh attach에서 value==max==total |
| 무손실 직렬화 | percent(`# %%`) `.py` 파서/직렬화 — 바이트 단위 라운드트립 | v6: 코퍼스 0바이트 diff + 1000케이스 |

**이 엔진은 지금 당장 CLI로 써볼 수 있다** (→ §3).

### 🚧 아직 spike인 것 — VSCode 클라이언트 (Phase 1 UX)

`extension/`은 **컴파일은 되지만(tsc) 실제 VSCode 통합은 미완성인 spike**다:

- ❌ `.vsix` 패키징·VSCode 설치·실제 구동 **안 됨**.
- ❌ `daemonClient.ts`는 셀 **제출**(`execute`)과 `status`만 한다. **데몬 스트림을 구독해
  출력을 노트북 셀에 다시 그리는 경로가 없다** — 즉 재접속 시 VSCode UI에 출력을 복원하는
  절반이 아직 미구현.
- ✅ 라이브러리 단위(percent 직렬화, cell_hash 부착, 위젯 jsdom 렌더)는 단위 테스트로 검증됨.

> **결론:** "VSCode tunnel로 붙으면 셀 출력이 그대로 유지되는가?"
> — **영속화 메커니즘은 완성되어 CLI로 증명 가능**하지만, 그것을 **VSCode 노트북 UI에
> 복원해 보여주는 클라이언트는 아직 없다.** 현재 tunnel로 붙으면 CodeLens로 셀을 *제출*할 수는
> 있어도 출력이 VSCode 화면에 *복원되어 뜨지는 않는다.* 이 "구독→렌더" 연결이 Phase 1의 핵심
> UX 작업이다.

---

## 2. 설치

### 요구 사항
- Python **3.11+** (시스템 3.10은 사용 금지 — 항상 venv 사용)
- [uv](https://github.com/astral-sh/uv) (`~/.local/bin/uv`)
- (extension 빌드/테스트 시) Node 20+ / npm

### 데몬 + CLI

```bash
cd daemon
uv venv                                   # .venv 생성 (Python 3.11)
uv pip install -e '.[dev]'                # tithon CLI + pytest/matplotlib/tqdm
uv pip install ipywidgets                 # tqdm.notebook 위젯 comm 발생용 (선택)
# 이후 daemon/.venv/bin/tithon 으로 호출 (또는 .venv 활성화)
```

`tithon`이 설치되면 `tithon daemon | run | attach | status` 서브커맨드를 쓸 수 있다.

---

## 3. 사용법 — 영속화를 직접 시연하기

데몬의 상태(소켓·로그·저널·아티팩트)는 `TITHON_HOME`(기본 `~/.tithon`)에 모인다.
클라이언트 노출은 **unix domain socket(0600) 전용**이다 (TCP 없음).

### 3.1 데몬 띄우기

```bash
# 데몬은 foreground 프로세스 → 백그라운드로 띄우고 로그를 관찰한다
cd daemon
.venv/bin/tithon daemon &                 # ~/.tithon/daemon.sock 바인딩
tail -f ~/.tithon/daemon.log              # 별 터미널에서 관찰 (선택)
```

### 3.2 코드 실행하고 출력 받기

```bash
.venv/bin/tithon run -c 'print("hello"); x = 41'
.venv/bin/tithon run -c 'x += 1; print(x)'        # → 42  (커널 상태가 이어진다)
.venv/bin/tithon status                            # 세션/큐/위젯 모델 수
```

`run`은 제출한 실행의 출력만 라이브로 따라 출력한다.
`--no-wait`면 `exec_id`만 찍고 즉시 종료, `--timeout N`이면 N초 제한.

### 3.3 ★ 핵심: 끊겨도 출력이 보존되는지 확인

```bash
# 1) 무언가 실행해서 출력 이력을 남긴다
.venv/bin/tithon run -c 'for i in range(3): print("line", i)'

# 2) 데몬을 강제 종료한다 (커널은 detached라 살아있다)
pkill -9 -f 'tithon daemon'

# 3) 데몬을 다시 띄운다 → 살아있던 커널에 re-attach
.venv/bin/tithon daemon &

# 4) 처음부터 다시 붙으면(snapshot) 죽기 전 출력이 그대로 복원된다
.venv/bin/tithon attach --since 0 --once     # 전체 스냅샷을 NDJSON으로
.venv/bin/tithon run -c 'print(x)'           # → 42  (변수 상태도 연속)
```

`attach`의 `--since`가 재접속 의미론의 핵심이다:
- `--since 0` : 풀 스냅샷(folded) + 이후 라이브 delta
- `--since N` : seq N 이후만 delta 리플레이 → sync 마커 → 라이브
- `--since -1`: 라이브 전용(과거 무시)

`--once`는 backlog sync 후 종료, `--until-done`은 done 이벤트 후 종료.

> 이 흐름이 곧 "VSCode에서 노트북을 닫았다 tunnel로 다시 붙어도 출력이 복원된다"의
> **백엔드 증명**이다. VSCode UI에 이걸 그려주는 클라이언트가 Phase 1 작업이다.

---

## 4. extension/ (spike) 빌드·테스트

VSCode 통합은 미완성이지만, Phase 0에서 검증한 라이브러리 로직은 빌드/테스트할 수 있다.

```bash
cd extension
npm install
npm run build                  # tsc → dist/ (컴파일만; .vsix 패키징 아님)
npm test                       # vitest: serializer / cellAttach / widget(jsdom)
```

- `src/serializer.ts` — percent `.py` 바이트 정확 라운드트립 (ADR-011)
- `src/cellAttach.ts` — 저널 `cell_hash` → 셀 부착 (해시 1순위, range 근접 fallback, stale 배지)
- `src/widgetRender.ts` — html-manager를 ESM/jsdom에서 구동해 위젯 렌더 (ADR-012/013)
- `src/{extension,daemonClient,codeLens,notebookSerializer,widgetRendererEntry}.ts` — **spike**:
  Cell View + "Run Cell" CodeLens→데몬 제출까지만. **출력 구독·렌더는 미구현.**

---

## 5. 검증 (Phase 0 종료 조건)

```bash
make verify        # v1~v6 전체 (6/6 PASS가 Phase 0 종료 조건)
make verify-a      # v1~v4 (데몬/CLI: 영속·복원·아티팩트)
make verify-b      # v5~v6 (위젯 미러 + percent 직렬화)
make test          # pytest 단위 테스트 (daemon/)
# extension 단위 테스트는 cd extension && npm test (vitest)
```

검증 스크립트(`verify/`)는 **결과를 약화시키는 방향으로 수정 금지**다 (CLAUDE.md 안티치팅 규칙).
v4의 `kill -9`는 진짜 데몬 프로세스에 수행하고 커널 생존을 PID 동일성 + 변수 연속성으로
이중 확인한다.

---

## 6. 아키텍처 불변 조건 (위반 금지)

`docs/design.md`가 단일 진실이며, 다음은 절대 어기지 않는다:

1. 커널은 detached(setsid) spawn + connection file 영속화 → 데몬 재시작 후 re-attach.
2. 모든 iopub/shell 메시지는 SQLite(WAL) 원본 보존 + 실행별 folded 스냅샷.
3. 클라이언트 동기화는 단조 증가 seq 기반 snapshot + delta.
4. image/* 리치 출력은 base64 금지 → `.tithon/outputs/` 파일, 저널엔 참조만.
5. 데몬 바인딩은 unix domain socket(0600) 전용. TCP 금지.

---

## 7. 리포 구조

```
daemon/      Python 3.11+ (uv). tithon 패키지: 데몬 + CLI
  tithon/    daemon.py kernel.py journal.py folding.py widgets.py artifacts.py cli.py
  tests/     pytest 단위 테스트
extension/   TypeScript VSCode 확장 (Phase 0 spike) — npm·vitest
verify/      Phase 0 검증 v1.sh~v6.sh + lib + 코퍼스
docs/        design.md (설계 단일 진실)
Makefile     verify-a / verify-b / verify / test
```

진행 상태와 설계 판단은 [`PROGRESS.md`](PROGRESS.md) / [`DECISIONS.md`](DECISIONS.md)(ADR)에 있다.

---

## 8. 다음 단계 (Phase 1 — 아직 미착수)

Phase 0가 백엔드 가설을 증명했으니, 다음은 그것을 **실제로 쓰는 클라이언트와 운영**이다:

- **VSCode tunnel 클라이언트 완성**: 데몬 스트림 구독 → 노트북 셀에 출력/진행/위젯 **복원 렌더**
  (현재 빠진 "구독→렌더" 절반). 이게 끝나야 질문하신 "tunnel로 붙으면 출력 유지"가 UI로 성립.
- 멀티 세션, 실행 큐 가시화, 아티팩트 스토어 확장.
- systemd 패키징(데몬 상시 구동), stale 배지/듀얼 뷰 UX.
- xvfb/디스플레이 환경에서 `@vscode/test-electron` 실제 통합 테스트(현재는 jsdom 대체, ADR-012).

---

<sub>이 PoC는 Claude Code로 단계 구동됐다 (`prompts/stage-{a,b}.md`). 작업 루프 규칙은
`CLAUDE.md`, 누적 맥락은 `PROGRESS.md`/`DECISIONS.md` 참조.</sub>
