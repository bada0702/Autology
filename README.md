# Autology

> `autos (자기 자신) + logos (말·이성)` — **스스로 지식을 정의하는 지능형 온톨로지 그래프 빌더**

AI 멀티 에이전트(CrewAI)와 시맨틱 웹 기술을 결합한 **인터랙티브 온톨로지 생성·시각화 플랫폼**입니다.  
주제를 입력하면 백엔드 AI 에이전트들이 리서치 → 개체 추출 → 관계 매핑 → 검증 → 편집의 5단계 파이프라인으로 온톨로지 그래프를 자동 생성하고, React 캔버스에 실시간으로 시각화합니다.

---

## 주요 기능

### 1. AI 멀티 에이전트 파이프라인 (CrewAI + Ollama)
로컬 LLM(Ollama)을 연동해 5개의 독립 에이전트가 협업합니다.

| 에이전트 | 역할 |
|----------|------|
| **Research Agent** | 입력 주제 관련 웹 자료 수집 및 기초 분석 |
| **Extraction Agent** | 텍스트에서 Class / Instance / Literal 분류 추출 |
| **Relation Agent** | `is-a`, `part-of`, `has-value`, `related-to` 등 관계 정의 |
| **Validation Agent** | 순환 참조, 모순, 누락 관계 품질 검증 |
| **Editor Agent** | 캔버스 규격에 최적화된 최종 온톨로지 JSON 생성 |

### 2. 인터랙티브 그래프 캔버스 (React + SVG)
- 3계층 고정 구조: **Class**(파랑) → **Instance**(초록) → **Literal**(노랑)
- 드래그·줌·패닝, 노드 인라인 편집, 미니맵 내비게이션
- WebSocket으로 AI 에이전트 실시간 추론 로그 모니터링
- 엑셀(xlsx) / JSON / RDF 등 다양한 포맷으로 내보내기

### 3. 시맨틱 웹 워크벤치 (RDFLib + pySHACL)
- **RDF 가져오기/내보내기**: Turtle, RDF/XML, JSON-LD 상호 변환
- **SPARQL 쿼리 엔진**: 온톨로지 데이터에 직접 SELECT 쿼리 실행
- **SHACL 검증**: 스키마 제약 조건 유효성 검사
- **코드 에디터 패널**: OWL/Turtle 직접 편집 지원

### 4. 규칙 엔진 & 워크플로
- 그래프 추론 규칙 정의 및 자동 적용
- 워크플로 패널로 멀티스텝 AI 작업 파이프라인 구성
- 속성 패널에서 노드/엣지 메타데이터 상세 편집

### 5. 크로스 플랫폼 배포
- 웹 브라우저(개발 서버) 및 **Tauri** 기반 네이티브 데스크톱 앱 빌드 지원
- Windows용 원클릭 실행 스크립트(`start.bat`) 포함

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| **Frontend** | React 18, Vite 4, Framer Motion, Lucide React, Inter/Outfit 폰트 |
| **Desktop** | Tauri |
| **Backend** | FastAPI, Uvicorn, WebSocket |
| **AI Orchestration** | CrewAI, LangChain Ollama |
| **Semantic Engine** | RDFLib, pySHACL |
| **데이터 소스** | BeautifulSoup4, Wikipedia-API |
| **파일 처리** | xlsx, pdfjs, papaparse, mammoth |

---

## 실행 방법

### 사전 요구사항
- **Node.js** v18 이상
- **Python** v3.10 이상
- **Ollama** 설치 및 실행 중 (기본 모델: `gemma3:27b` 또는 `.env`에서 변경)

### 1단계: 최초 설치

```bash
# Windows
setup.bat

# macOS / Linux
./setup.sh
```

백엔드 Python 가상환경 생성 및 npm 패키지를 자동으로 설치합니다.

### 2단계: 실행

```bash
# Windows (백엔드 + 프론트엔드 동시 실행)
start.bat

# macOS / Linux
./start.sh
```

| 서비스 | 주소 |
|--------|------|
| 프론트엔드 | http://localhost:5173 |
| 백엔드 API | http://localhost:8000 |
| API 문서 (Swagger) | http://localhost:8000/docs |

### 수동 실행

```bash
# 백엔드
cd backend
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS/Linux
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# 프론트엔드 (별도 터미널)
npm install
npm run dev
```

---

## 프로젝트 구조

```
Autology/
├── backend/                        # FastAPI 백엔드
│   ├── crew/                       # CrewAI 에이전트 파이프라인
│   │   ├── agents.py               # 5개 에이전트 정의
│   │   ├── tasks.py                # 에이전트 태스크
│   │   ├── orchestrator.py         # 파이프라인 오케스트레이터
│   │   ├── ollama_pipeline.py      # Ollama 직접 연동 파이프라인
│   │   └── tools/search.py         # 웹 검색 툴
│   ├── models/                     # Pydantic 스키마
│   │   ├── ontology.py
│   │   └── job.py
│   ├── memory/store.py             # 작업 상태 메모리 스토어
│   ├── semantic.py                 # RDFLib / SPARQL / SHACL 로직
│   ├── main.py                     # FastAPI 라우터 & WebSocket
│   ├── run_backend.py              # 백엔드 실행 진입점
│   └── requirements.txt
├── src/                            # React 프론트엔드
│   ├── components/
│   │   ├── Canvas/                 # SVG 오버레이 그래프 캔버스
│   │   ├── Nodes/ & Edges/         # 노드·엣지 렌더러
│   │   ├── MiniMap/                # 미니맵 내비게이션
│   │   ├── Toolbar/                # 상단 툴바
│   │   ├── Inspector/              # 그래프 인스펙터
│   │   ├── Evaluator/              # 그래프 평가 패널
│   │   ├── SemanticWorkbench/      # RDF/SPARQL/SHACL 워크벤치
│   │   ├── CodeEditor/             # OWL/Turtle 코드 에디터
│   │   ├── CrewPanel/              # AI 에이전트 모니터링 패널
│   │   └── Panels/                 # Chat / Property / Rule / Workflow
│   ├── context/                    # React Context 전역 상태
│   ├── hooks/                      # 커스텀 훅 (Ollama, CrewAI, KG-RAG 등)
│   ├── utils/                      # 파일 파싱, 레이아웃, 내보내기 유틸
│   └── constants/nodeTypes.js      # 노드 타입 상수
├── public/
├── index.html
├── package.json
├── vite.config.js
├── setup.bat / setup.sh            # 최초 설치 스크립트
├── start.bat / start.sh            # 통합 실행 스크립트
└── stop.bat / stop.sh              # 서버 종료 스크립트
```

---

## 온톨로지 노드 타입

| 타입 | 색상 | 설명 | 예시 |
|------|------|------|------|
| **Class** | 파랑 | 추상 개념·범주 | 사람, 도시, 조직 |
| **Instance** | 초록 | 실제 개체·객체 | 홍길동, 서울 |
| **Literal** | 노랑 | 구체적 값·속성 | "1919-03-01", "35세" |

**허용 관계**

```
Class     → Class     : is-a, part-of, related-to
Class     → Instance  : has-instance
Instance  → Instance  : connected, member-of, participated-in
Instance  → Literal   : has-value, born-on, located-at
```

---

## 라이선스

MIT
