# DECISIONS (ADR 한 줄 요약)

- ADR-001: 이벤트 seq = messages.msg_seq(AUTOINCREMENT rowid) 재사용 — 별도 카운터 없이 저널 자체가 단조 seq의 진실 공급원.
- ADR-002: 실행 라이프사이클(queued/started/done)을 tithon.* 의사 메시지로 저널에 기록 — 라이브 브로드캐스트와 attach 리플레이가 같은 코드 경로(event_from_message)를 타서 의미 불일치 원천 차단.
- ADR-003: folded 스냅샷은 인메모리 유지 + 실행 done 시 executions.folded_json에 캐시, 데몬 재시작 시 raw 메시지 리플레이로 재구성 — 50k 메시지 실행 중 매 메시지 영속화 비용 회피.
- ADR-004: KernelClient.wait_for_ready 사용 금지 — KernelManager 없는 단독 클라이언트에선 HB 채널 초기 not-beating을 "Kernel died"로 오판. kernel_info 요청 폴링 루프로 대체.
- ADR-005: attach의 무손실 보장은 asyncio 단일 루프 원자성으로 구현 — 구독 등록과 스냅샷/델타 컷오프 계산 사이에 await 없음 + 구독 큐에서 seq<=cutoff 중복 제거.
- ADR-006: v4 검증 셀은 데몬 스레드 기반 증분(x+=1/s) — 커널 셸이 idle로 남아 크래시 직후 x 조회가 즉시 가능, "실행 중 상태 연속성"을 타이밍 의존 없이 검증.
- ADR-007: 커널 ZMQ는 127.0.0.1 TCP(jupyter 표준), 클라이언트 노출은 unix socket(0600) 전용 — TCP 금지 조항은 데몬 바인딩에 적용.
- ADR-008: 이미지 base64는 저널 진입 전에 아티팩트 참조($tithon_artifact)로 치환 — "원본 보존"은 메시지 구조·순서 기준, 페이로드는 파일이 일급(§3.1 두 요구의 양립).
- ADR-009: attach에 last_seen_seq=-1(라이브 전용) 확장 — run CLI가 스냅샷 비용 없이 자기 실행만 추적.
