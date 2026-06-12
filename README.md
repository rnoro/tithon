# Tithon Phase 0 — Claude Code 실행 키트

## 배치
이 디렉터리 전체를 새 리포 루트에 복사하고, 설계 문서를 docs/design.md로 추가:

    mkdir tithon && cd tithon && git init
    cp -r <이 키트>/* .
    mkdir -p docs && cp <경로>/tithon-design.md docs/design.md
    git add -A && git commit -m "p0: bootstrap"

## 실행 (Stage A)
    claude                                  # 리포 루트에서 실행 → CLAUDE.md 자동 로드
    > @prompts/stage-a.md 읽고 그대로 진행해   # 1) 작업 지시
    > (prompts/stage-a.goal.txt 내용을 입력)  # 2) /goal 조건 등록 — 입력창에 직접 입력

또는 비대화형 완주:

    claude -p "@prompts/stage-a.md 읽고 그대로 진행해. $(cat prompts/stage-a.goal.txt)"

주의: /goal은 슬래시 커맨드라서 Claude가 파일에서 '읽는' 것으로는 등록되지 않는다.
반드시 입력(프롬프트 문자열의 시작 부분 포함)으로 전달할 것.

## Stage B
Stage A가 4/4 PASS 후 **새 세션**에서 동일 절차로 stage-b.md / stage-b.goal.txt 사용.
(문맥은 PROGRESS.md / DECISIONS.md로 이어진다)
