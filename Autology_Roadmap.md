# AUTOLOGY — 온톨로지 그래프 빌더
> **프로젝트 로드맵 v2.0**
>
> `autos (자기 자신) + logos (말·이성)` → **스스로 지식을 정의하는 도구**

| 항목 | 내용 |
|------|------|
| 프로젝트명 | Autology |
| 목적 | 온톨로지 지식 그래프 빌더 (인터랙티브) |
| 기술 스택 | Vite + React, SVG, Ollama (로컬 LLM) |
| 구현 방식 | Vite + React 멀티파일 프로젝트 |

---

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [기술 스택](#2-기술-스택)
3. [전체 기능 목록](#3-전체-기능-목록)
4. [LLM 파이프라인](#4-llm-파이프라인)
5. [이벤트 파이프라인](#5-이벤트-파이프라인)
6. [Reducer 액션 목록](#6-reducer-액션-목록)
7. [구현 로드맵](#7-구현-로드맵)
8. [데이터 구조](#8-데이터-구조)

---

## 1. 프로젝트 개요

Autology는 온톨로지 데이터를 시각적으로 구성하고 관리하는 **인터랙티브 지식 그래프 빌더**입니다.
사용자는 노드와 관계선을 직접 드래그로 연결하며 지식 구조를 만들 수 있으며,
Ollama 로컬 LLM을 통해 텍스트나 파일에서 온톨로지를 자동으로 추출할 수 있습니다.

### 핵심 개념

| 노드 타입 | 설명 | 예시 |
|-----------|------|------|
| **Class** | 추상 개념·범주 | 사람, 도시, 사건, 조직 |
| **Instance** | 실제 개체·객체 | 홍길동, 서울, 3.1운동 |
| **Literal** | 구체적 값·속성 | "1919-03-01", "35세" |
| **Property** (엣지) | 관계·속성 | is-a, part-of, has-value |

### 3단계 고정 계층 구조

```
Level 1  Class      추상 개념·범주       (파란색)
             ↓  has-instance / is-a
Level 2  Instance   실제 개체·객체       (초록색)
             ↓  has-value / located-at
Level 3  Literal    구체적 값            (노란색)
```

#### 계층 간 허용 관계
- `Class → Class` : is-a, part-of, related-to
- `Class → Instance` : has-instance
- `Instance → Instance` : 연결됨, 소속, 참여
- `Instance → Literal` : has-value, born-on, located-at

---

## 2. 기술 스택

### 렌더링 전략

| 레이어 | 기술 | 설명 |
|--------|------|------|
| 노드 (Node) | HTML div | DOM 기반, 텍스트·스타일 자유롭게 |
| 엣지 (Edge) | SVG | 곡선 화살표, 레이블 정확한 위치 |
| 캔버스 | div + SVG 오버레이 | 같은 좌표계 공유 |
| 상태 관리 | React Context + useReducer | 전역 그래프 상태 |
| 좌표계 | World Coordinates | screenToWorld() 변환 함수 통일 |
| LLM | Ollama API | localhost:11434, 스트리밍 지원 |
| 파일 파싱 | pdfjs / papaparse / mammoth | 다중 포맷 지원 |
| 빌드 | Vite + React | 멀티파일 프로젝트 |

### 프로젝트 파일 구조

```
autology/
├── src/
│   ├── App.jsx
│   ├── context/
│   │   ├── GraphContext.jsx
│   │   ├── LLMContext.jsx
│   │   ├── RuleContext.jsx          ← NEW
│   │   └── WorkflowContext.jsx      ← NEW
│   ├── components/
│   │   ├── Canvas/
│   │   ├── Nodes/
│   │   ├── Edges/
│   │   │   └── InferredEdge.jsx     ← NEW (점선 + ⚡)
│   │   ├── Panels/
│   │   │   ├── RulePanel.jsx        ← NEW
│   │   │   └── WorkflowPanel.jsx    ← NEW
│   │   ├── MiniMap/
│   │   ├── Toolbar/
│   │   └── Workflow/
│   │       └── StepIndicator.jsx    ← NEW
│   ├── hooks/
│   │   ├── useGraph.js
│   │   ├── useDrag.js
│   │   ├── useHistory.js
│   │   ├── useOllama.js
│   │   ├── useRuleEngine.js         ← NEW
│   │   └── useWorkflow.js           ← NEW
│   ├── utils/
│   │   ├── layout.js
│   │   ├── fileParser.js
│   │   ├── chunker.js
│   │   ├── merger.js
│   │   ├── exporters.js
│   │   ├── ruleEngine.js            ← NEW
│   │   └── entityNormalizer.js      ← NEW
│   └── constants/
│       └── nodeTypes.js
├── package.json
└── index.html
```

---

## 3. 전체 기능 목록

### 그래프 편집 (Core)

| 기능 | 상세 |
|------|------|
| 노드 추가 | 더블클릭 또는 버튼으로 캔버스에 노드 생성 |
| 노드 이동 | 드래그 앤 드롭 |
| 관계선 연결 | 노드 hover 시 포트 표시 → 드래그로 연결 |
| 관계 레이블 편집 | 엣지 클릭 시 인라인 편집 |
| 프로퍼티 편집 | 우측 패널에서 key-value 속성 추가/삭제/수정 |
| 노드 타입 | Class / Instance / Literal 색상 구분 |
| 저장/불러오기 | JSON 파일 export / import |
| 캔버스 조작 | 마우스 휠 줌, 배경 드래그 팬 |
| 삭제 | 노드/엣지 선택 후 Delete 키 |
| 단축키 | N: 노드추가, E: 엣지모드, Del: 삭제 등 |
| 멀티선택 | 드래그로 여러 노드 한번에 선택/이동 |
| 복사·붙여넣기 | 노드/그룹 복제 |
| 그리드 스냅 | 정렬된 배치 지원 |
| 노드 잠금 | 실수 이동 방지 |
| 필터 뷰 | Class만 / Instance만 토글 |
| Undo/Redo | Ctrl+Z 작업 히스토리 |

### 시각화 / 레이아웃

| 기능 | 상세 |
|------|------|
| 자동 레이아웃 | Force-directed / 계층형 / 방사형 자동 배치 |
| 미니맵 | 우측 하단 전체 그래프 축소 뷰 |
| 노드 크기 자동 조정 | 연결 수에 따라 크기 변화 |
| 엣지 스타일 구분 | 실선 / 점선 / 굵기로 관계 강도 표현 |
| 그룹/클러스터 박스 | 관련 노드를 박스로 묶기 |
| 다크/라이트 테마 | 테마 전환 지원 |

### LLM (Ollama 연동)

| 기능 | 상세 |
|------|------|
| 텍스트 → 그래프 | 텍스트 입력 → 온톨로지 자동 생성 |
| 파일 → 그래프 | 파일 업로드 → 청크 분석 → 병합 |
| 노드 설명 생성 | 선택 노드의 설명 스트리밍 생성 |
| 그래프 요약 | 전체 그래프를 자연어로 설명 |
| 관계 자동 추천 | 선택 노드에 연결 가능한 노드 제안 |
| 모순/충돌 감지 | 논리적으로 이상한 관계 감지 |
| 질의응답 (RAG) | "이 그래프에서 X와 관련된 것은?" |
| 온톨로지 확장 제안 | 기존 그래프 보고 빠진 개념 제안 |
| 다국어 번역 | 노드 레이블 자동 번역 |

### 파일 분석 파이프라인

| 기능 | 상세 |
|------|------|
| 지원 포맷 | PDF / TXT / MD / CSV / Excel / JSON / XML / DOCX |
| 청크 분할 | 1500 token 단위, 200 token 오버랩 |
| 순차 LLM 분석 | 각 청크 → 부분 그래프 JSON |
| 진행률 표시 | chunk 3/7 처리 중... 실시간 표시 |
| 부분 그래프 병합 | 중복 노드 통합, 관계 dedup |
| 3계층 자동 분류 | Class → Instance → Literal 자동 분류 |

### 그래프 분석

| 기능 | 상세 |
|------|------|
| 노드 검색 & 하이라이트 | 키워드로 노드 찾기 |
| 경로 탐색 | A → B 사이 모든 경로 시각화 |
| 중심성 분석 | 연결 많은 노드 크기/색상으로 강조 |
| 고립 노드 감지 | 관계 없는 노드 자동 표시 |
| 서브그래프 추출 | 선택 노드 중심 N홉 범위만 표시 |
| 클러스터링 | 연관 노드 자동 그룹핑 & 색상 구분 |

### Export / 출력

| 기능 | 상세 |
|------|------|
| JSON | 그래프 전체 저장/불러오기 |
| PNG / SVG | 이미지로 저장 |
| Mermaid 다이어그램 | Mermaid 코드로 변환 |
| Markdown 리포트 | 그래프 내용 문서화 |
| Cypher (Neo4j) | 그래프 DB 쿼리로 변환 |
| OWL/RDF | 표준 온톨로지 포맷 (기본) |

### 히스토리 / 협업

| 기능 | 상세 |
|------|------|
| 변경 이력 타임라인 | 언제 어떤 노드/엣지 추가했는지 |
| 버전 스냅샷 | 특정 시점 그래프 저장 & 복원 |
| 코멘트/메모 | 노드에 노트 첨부 |
| 복사 & 붙여넣기 | 노드/그룹 복제 |

### 6단계 온톨로지 구축 워크플로우 (SAIP 참조)

| 기능 | 상세 |
|------|------|
| Step 1  문제 정의 | 어떤 도메인? 무엇을 분석할 것인가? — LLM 가이드 제공 |
| Step 2  목표 설정 | 어떤 인사이트를 얻을 것인가? — 시나리오 & 유즈케이스 정의 |
| Step 3  데이터 수집 | 파일 업로드 (PDF/CSV/JSON 등) — 다중 포맷 지원 |
| Step 4  엔티티 추출 | LLM이 Class/Instance/Literal 자동 추출 & 분류 |
| Step 5  관계 모델링 | 추출된 엔티티를 캔버스에서 관계 연결 & 편집 |
| Step 6  검증 | LLM이 모순/누락 감지 → 피드백 & 개선 제안 |
| 워크플로우 UI | 좌측 패널에 스텝 진행 바 형태로 단계별 안내 |
| 단계별 LLM 가이드 | 각 단계마다 LLM이 컨텍스트 맞는 도움말 제공 |

### Rule 엔진 (온톨로지 추론 규칙)

| 기능 | 상세 |
|------|------|
| 추이 규칙 (Transitivity) | IF A→B AND B→C  THEN A→C 자동 추론 |
| 역관계 규칙 (Inverse) | IF A→B  THEN B→A 역방향 관계 자동 생성 |
| 도메인 규칙 (Domain) | IF type(A)=Class  THEN 특정 조건 적용 |
| 사용자 정의 규칙 | IF/THEN 조건 텍스트로 직접 규칙 입력 |
| 규칙 자동 제안 | LLM이 기존 그래프 분석 후 적용 가능한 규칙 추천 |
| 추론 엣지 시각화 | 추론된 관계는 점선 + ⚡ 아이콘으로 구분 표시 |
| 규칙 활성/비활성 | 규칙별 토글로 추론 결과 on/off |
| 규칙 저장 | rules[] 배열로 JSON에 함께 저장/불러오기 |

### 엔티티 표준화 파이프라인 (SAIP 참조)

| 기능 | 상세 |
|------|------|
| 엔티티 자동 감지 | 동일 개념 다른 표현 자동 탐지 (예: 홍길동 / 홍 씨 / 그) |
| 의미론적 표준화 | 레이블 정규화 — 대소문자, 띄어쓰기, 약어 통일 |
| 중복 노드 병합 제안 | 유사 노드 감지 후 병합 여부 사용자에게 확인 |
| 표준 온톨로지 매핑 | foaf:Person, schema:Place 등 표준 용어로 매핑 |
| 다국어 동의어 처리 | 서울 / Seoul / 서울시 → 동일 노드로 처리 |
| 표준화 리포트 | 변경된 엔티티 목록 & 병합 이력 확인 |

---

## 4. LLM 파이프라인

### 연결 방식

```
React 앱  →  fetch  →  localhost:11434/api/chat
모델: llama3 (기본값, 설정에서 변경 가능)
스트리밍: stream: true  →  응답 실시간 표시
```

### 텍스트 → 그래프 파이프라인

```
사용자 텍스트 입력  (예: "태양계에 대한 온톨로지")
  ↓
LLM System Prompt: 온톨로지 전문가, JSON only
  ↓
LLM 응답: { nodes[], edges[] } JSON
  ↓
dispatch(LOAD_GRAPH)  →  캔버스 자동 배치
```

### 파일 → 그래프 파이프라인 (청크)

```
파일 업로드 (PDF/TXT/CSV/Excel/JSON/XML/DOCX)
  ↓  형식별 파싱 (pdfjs / papaparse / mammoth 등)
원본 텍스트 추출
  ↓  1500 token 단위 청크 분할 (200 token 오버랩)
[chunk1] [chunk2] [chunk3] ... [chunkN]
  ↓  순차 LLM 분석 (진행률 표시)
각 청크 → 부분 그래프 JSON
  ↓  중복 노드/엣지 병합 (dedup)
최종 그래프  →  dispatch(LOAD_GRAPH)
```

### 노드 설명 스트리밍

```
노드 선택  →  우측 패널 "✨ 설명 생성" 클릭
  ↓
프롬프트: 노드명 + 타입 + 연결된 관계 전달
  ↓  stream: true
실시간 타이핑 효과로 패널에 표시
  ↓
dispatch(UPDATE_NODE, { description })
```

### Rule 엔진 추론 파이프라인

```
사용자 Rule 정의 (추이/역관계/도메인/사용자 정의)
  ↓  또는  LLM 규칙 자동 제안
dispatch(ADD_RULE, { type, condition, conclusion })
  ↓  dispatch(APPLY_RULES)
기존 엣지 순회 → 규칙 조건 매칭
  ↓  조건 충족 시
추론 엣지 생성 (inferred: true)
  ↓
캔버스에 점선 + ⚡ 아이콘으로 시각화
```

### 엔티티 표준화 파이프라인

```
파일 분석 or 텍스트 → 그래프 생성 완료
  ↓  LLM 유사 엔티티 감지
예) "홍길동" / "홍 씨" / "그"  →  동일 Instance 후보
예) "서울" / "서울시" / "Seoul"  →  동일 노드 후보
  ↓  dispatch(SUGGEST_MERGE, [...])
UI에 병합 제안 목록 표시
  ↓  사용자 수락 / 거절
dispatch(ACCEPT_MERGE)  →  노드 통합 & 엣지 재연결
  ↓  레이블 정규화 + 표준 용어 매핑 (foaf / schema.org)
표준화 리포트 생성
```

---

## 5. 이벤트 파이프라인

### 노드 추가
```
더블클릭 (캔버스)
  → screenToWorld(e.clientX, e.clientY)
  → dispatch(ADD_NODE, { x, y })
  → 우측 패널 열림 (자동 선택)
```

### 노드 드래그 이동
```
mousedown(노드)  →  mode = DRAGGING, 오프셋 저장
mousemove(document)  →  dispatch(MOVE_NODE, { id, x, y })
mouseup(document)  →  mode = IDLE
```

### 관계선 연결 (핵심)
```
mousedown(노드 포트 핸들)  →  mode = CONNECTING, sourceId 저장
임시 엣지 (점선) SVG로 렌더링
mousemove  →  임시 엣지 끝점 업데이트
mouseenter(다른 노드)  →  타겟 노드 하이라이트
mouseup(다른 노드)  →  dispatch(ADD_EDGE, { source, target, label: '' })
mouseup(빈 공간)  →  mode = IDLE, 임시 엣지 제거
```

### 엣지 레이블 편집
```
click(엣지 레이블 영역)  →  인라인 input 활성화
blur / Enter  →  dispatch(UPDATE_EDGE, { id, label })
```

### 캔버스 팬/줌
```
wheel(캔버스)  →  zoom += delta  (min 0.2 ~ max 3.0)
mousedown(캔버스 배경)  →  mode = PANNING
mousemove  →  panX, panY 업데이트
mouseup  →  mode = IDLE
```

### 저장 / 불러오기
```
저장:      { nodes, edges } → JSON.stringify → Blob → a.download
불러오기:  input[file] → FileReader → JSON.parse → dispatch(LOAD_GRAPH)
```

---

## 6. Reducer 액션 목록

### 그래프 조작

| 액션 | 파라미터 |
|------|----------|
| `ADD_NODE` | id, label, type, x, y |
| `MOVE_NODE` | id, x, y |
| `UPDATE_NODE` | id, label, type |
| `UPDATE_NODE_PROPS` | id, properties[] |
| `DELETE_NODE` | id (연결된 엣지도 같이 삭제) |
| `ADD_EDGE` | id, source, target, label |
| `UPDATE_EDGE` | id, label |
| `DELETE_EDGE` | id |
| `SET_SELECTED` | id (node or edge) |
| `SET_MODE` | select \| connecting \| dragging \| panning |
| `LOAD_GRAPH` | { nodes, edges } |
| `RESET_GRAPH` | — |

### LLM

| 액션 | 설명 |
|------|------|
| `LLM_REQUEST_START` | 로딩 상태 on |
| `LLM_REQUEST_SUCCESS` | 생성된 그래프 머지 |
| `LLM_REQUEST_ERROR` | 에러 메시지 표시 |
| `LLM_STREAM_CHUNK` | 설명 텍스트 스트리밍 누적 |
| `LLM_STREAM_DONE` | 스트리밍 완료 |
| `SET_LLM_MODEL` | 모델명 변경 (llama3 등) |

### 히스토리

| 액션 | 설명 |
|------|------|
| `UNDO` | 이전 상태로 복원 |
| `REDO` | 다음 상태로 이동 |
| `SNAPSHOT` | 현재 상태 스냅샷 저장 |
| `RESTORE_SNAPSHOT` | id → 특정 스냅샷 복원 |

### Rule 엔진

| 액션 | 파라미터 |
|------|----------|
| `ADD_RULE` | id, type, condition, conclusion |
| `UPDATE_RULE` | id, 규칙 내용 수정 |
| `DELETE_RULE` | id |
| `TOGGLE_RULE` | id → 활성/비활성 |
| `APPLY_RULES` | 모든 활성 규칙 적용 → 추론 엣지 생성 |
| `CLEAR_INFERRED` | 추론된 엣지 전체 제거 |

### 워크플로우

| 액션 | 파라미터 |
|------|----------|
| `SET_WORKFLOW_STEP` | 현재 단계 (1~6) 설정 |
| `COMPLETE_STEP` | step → 완료 표시 |
| `RESET_WORKFLOW` | 워크플로우 초기화 |

### 엔티티 표준화

| 액션 | 파라미터 |
|------|----------|
| `SUGGEST_MERGE` | 유사 노드 쌍 제안 목록 |
| `ACCEPT_MERGE` | sourceId, targetId → 노드 병합 |
| `REJECT_MERGE` | 노드 병합 제안 거절 |
| `NORMALIZE_LABELS` | 전체 레이블 정규화 적용 |
| `MAP_STANDARD_TERM` | nodeId, standardUri → 표준 용어 매핑 |

---

## 7. 구현 로드맵

### Phase 1 — Core 그래프 편집

- [x] Canvas + 노드 추가(더블클릭 / 툴바 버튼) / 이동 / 삭제
- [x] SVG 엣지 + 포트 드래그 연결 + 레이블 인라인 편집
- [x] 우측 패널 + 프로퍼티 key-value 편집
- [x] 저장 / 불러오기 (JSON export/import, meta.version 2.0)
- [x] 단축키 시스템 (V/H/Delete/Escape/Ctrl+Z/Y), Undo/Redo
- [x] 빈 캔버스 Empty State 가이드 (4가지 시작 방법)
- [ ] 멀티선택, 복사·붙여넣기
- [ ] 필터뷰, 그리드 스냅, 노드 잠금

### Phase 2 — 시각화 & 레이아웃

- [ ] 자동 레이아웃 (계층형 / 방사형 / Force-directed)
- [ ] 미니맵 (우측 하단 전체 뷰)
- [ ] 노드 크기 자동 조정 (연결 수 기반)
- [ ] 엣지 스타일 구분 (실선/점선/굵기)
- [ ] 그룹/클러스터 박스
- [ ] 다크/라이트 테마 전환

### Phase 3 — LLM Ollama 연동

- [x] Ollama 연결 상태 표시 + 모델 선택 드롭다운
- [x] 텍스트 입력 → 그래프 자동 생성 (AI 생성 패널)
- [x] 노드 설명 자동 생성 (스트리밍, 우측 패널)
- [x] 설명 없는 노드 일괄 AI 설명 생성 (GraphInspector)
- [ ] 그래프 전체 요약 생성
- [ ] 관계 자동 추천
- [ ] 모순/충돌 감지, 온톨로지 확장 제안
- [ ] 질의응답 (RAG), 다국어 번역

### Phase 4 — 파일 분석 파이프라인

- [ ] 파일 파싱 (PDF/TXT/MD/CSV/Excel/JSON/XML/DOCX)
- [ ] 청크 분할 (1500 token, 200 오버랩)
- [ ] 순차 LLM 분석 + 진행률 표시
- [ ] 부분 그래프 병합 (중복 dedup)
- [ ] Class → Instance → Literal 3계층 자동 분류

### Phase 5 — 6단계 온톨로지 워크플로우

- [x] 스텝 진행 바 UI (Step 1~6 좌측 패널) — WorkflowPanel.jsx
- [x] Step 1: 문제 정의 — 도메인 & 분석 이유 입력 (가이드 예시 포함)
- [x] Step 2: 목표 설정 — 시나리오 & 유즈케이스 정의 (가이드 예시 포함)
- [x] Step 3: 데이터 수집 — 파일 업로드 (txt/csv/xlsx) + 직접 입력
- [x] Step 4: 엔티티 추출 — Step 1-3 컨텍스트로 LLM 그래프 자동 생성
- [x] Step 5: 관계 모델링 — 캔버스 편집 연동 (노드/엣지 수 표시)
- [x] Step 6: 검증 — 고립 노드·중복 레이블 감지 & 표시
- [ ] 워크플로우 데이터(문제 정의·목표) JSON 저장 연동
- [ ] 단계별 LLM 가이드 메시지 (Step 6 LLM 모순 감지)
> **주의**: WorkflowContext/WorkflowPanel은 이미 구현됨. 로드맵에 ← NEW 표시는 과거 기준.

### Phase 6 — Rule 엔진 (추론 규칙)

- [ ] Rule 패널 UI — 규칙 추가/편집/삭제
- [ ] 추이 규칙: IF A→B AND B→C THEN A→C
- [ ] 역관계 규칙: IF A→B THEN B→A
- [ ] 도메인/사용자 정의 규칙 입력
- [ ] LLM 규칙 자동 제안
- [ ] 추론 엣지 시각화 (점선 + ⚡)
- [ ] 규칙 활성/비활성 토글
- [ ] rules[] JSON 저장/불러오기

### Phase 7 — 엔티티 표준화 파이프라인

- [ ] 동일 개념 다른 표현 자동 탐지
- [ ] 레이블 정규화 (대소문자, 띄어쓰기, 약어)
- [ ] 중복 노드 병합 제안 UI
- [ ] 표준 온톨로지 용어 매핑 (foaf / schema.org)
- [ ] 다국어 동의어 처리
- [ ] 표준화 리포트 & 병합 이력

### Phase 8 — 그래프 분석

- [ ] 노드 검색 & 하이라이트
- [ ] 경로 탐색 (A → B 시각화)
- [ ] 중심성 분석 (연결 수 기반 시각화)
- [ ] 고립 노드 감지
- [ ] 서브그래프 추출 (N홉)
- [ ] 클러스터링 (자동 그룹핑)

### Phase 9 — Export / 출력

- [x] JSON 저장/불러오기 (그래프 nodes/edges 한정, 워크플로우 데이터 미포함)
- [ ] PNG / SVG 이미지 export
- [ ] Mermaid 다이어그램 변환
- [ ] Markdown 리포트 생성
- [ ] Cypher (Neo4j) 쿼리 변환
- [ ] OWL/RDF 기본 포맷

### Phase 10 — 히스토리 & 메모

- [ ] 변경 이력 타임라인
- [ ] 버전 스냅샷 저장 & 복원
- [ ] 노드 코멘트/메모 첨부
- [ ] 복사 & 붙여넣기

---

## 8. 데이터 구조

### JSON Schema

```json
{
  "nodes": [
    {
      "id": "node_1",
      "label": "Person",
      "type": "Class",
      "x": 200,
      "y": 150,
      "locked": false,
      "description": "사람을 나타내는 클래스",
      "properties": [
        { "key": "name",  "value": "홍길동" },
        { "key": "age",   "value": "30" }
      ]
    }
  ],
  "edges": [
    {
      "id": "edge_1",
      "source": "node_1",
      "target": "node_2",
      "label": "lives_in",
      "style": "solid",
      "inferred": false
    }
  ],
  "meta": {
    "version": "2.0",
    "createdAt": "2025-01-01T00:00:00Z",
    "snapshots": []
  },
  "rules": [
    {
      "id": "rule_1",
      "type": "transitivity",
      "label": "추이 관계",
      "condition": "A→B AND B→C",
      "conclusion": "A→C",
      "edgeLabel": "inferred-from",
      "active": true
    }
  ],
  "workflow": {
    "currentStep": 3,
    "completedSteps": [1, 2],
    "domain": "태양계 온톨로지",
    "objective": "행성 간 관계 구조화"
  }
}
```

### node.type 허용값

| 값 | 설명 |
|----|------|
| `"Class"` | 추상 개념·범주 |
| `"Instance"` | 실제 개체·객체 |
| `"Literal"` | 구체적 값·속성 |

### edge.style 허용값

| 값 | 설명 |
|----|------|
| `"solid"` | 직접 연결된 관계 |
| `"dashed"` | Rule 엔진으로 추론된 관계 |

### rule.type 허용값

| 값 | 설명 |
|----|------|
| `"transitivity"` | IF A→B AND B→C THEN A→C |
| `"inverse"` | IF A→B THEN B→A |
| `"domain"` | 타입 기반 도메인 제약 |
| `"custom"` | 사용자 정의 IF/THEN |

---

*Autology Roadmap v2.0 — 최종 업데이트: 2025*
