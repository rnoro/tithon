PROGRESS.md, DECISIONS.md, docs/design.md(§3.2 Cell View, §3.3 위젯 미러)를 읽고
Stage B를 진행해. Stage A의 데몬은 완성되어 있다.

## 만들 것
1) ⑥ Percent-format NotebookSerializer (extension/):
   - `#%%` / `# %%` / `# %% [markdown]` 파싱 ↔ 직렬화. 커스텀 notebook type `tithon-py`.
   - 라운드트립 무결성이 절대 조건: parse→serialize가 입력과 바이트 단위로 동일해야 한다.
   - verify/v6.sh: (a) 까다로운 코퍼스(verify/corpus/*.py — CRLF, 탭/공백 혼용, 후행 공백,
     파일 끝 개행 없음, 빈 셀, 셀 마커가 문자열 리터럴 안에 있는 경우, 매직 커맨드,
     markdown 셀, 셀 구분자 이전의 모듈 헤더)에 대해 라운드트립 diff가 0바이트,
     (b) fast-check 기반 property 테스트(임의 생성 percent 파일 1,000케이스) 통과,
     (c) 저널의 origin(cell_hash) → 셀 부착 매핑 단위 테스트 통과 시 PASS.
2) ⑤ 위젯 렌더링 스파이크:
   - 데몬에 Widget State Mirror 추가(comm_open/comm_msg/comm_close 해석, binary buffers
     포함, widget-state+json 스냅샷 생성). tqdm.notebook 50,000 iteration 후 신규 attach
     스냅샷에 FloatProgress 최종 상태(value == total)가 들어있어야 한다.
   - @jupyter-widgets/html-manager로 미러 스냅샷을 DOM으로 렌더(jsdom): progress bar
     요소가 기대 value로 렌더되는지 단위 검증.
   - @vscode/test-electron(xvfb-run) 통합: tithon-py 노트북을 열고 데몬 경유로 셀 실행,
     출력(NotebookCellOutput)이 해당 셀에 부착되는지 + 위젯 mime 출력이 에러 없이
     렌더러에 전달되는지 검증.
   - verify/v5.sh: 위 세 가지가 모두 통과하면 PASS. 단, 통합 테스트에서 렌더러 내부 DOM을
     직접 검증할 수 없는 한계가 확인되면 그 사실과 대체 검증(렌더러 에러 로그 부재 +
     jsdom 검증)을 DECISIONS.md에 기록하는 조건으로 인정한다.
3) 텍스트 뷰용 CodeLens("Run Cell")로 데몬 execute를 호출하는 최소 연결(스파이크 수준).

## 진행 방식
- CLAUDE.md 규칙 동일. 매 턴 make verify-b 출력 전체를 대화에 표출.
- ⑥을 먼저 끝내고(순수 로직이라 루프가 빠름) ⑤로 넘어간다. ⑤에서 html-manager 로딩이
  VSCode 렌더러 샌드박스와 충돌하면, 충돌 내용을 최소 재현으로 분리해 PROGRESS.md에
  기록하고 설계서의 폴백(최종 상태 텍스트 렌더) 구현으로 전환한 뒤 그 사실을 명시한다.
