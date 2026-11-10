# Autology (오톨로지)

AI 멀티 에이전트(CrewAI)와 시맨틱 웹 기술을 결합한 **지능형 온톨로지 생성 및 시각화 플랫폼**입니다. 사용자가 특정 주제를 입력하면, 백엔드의 AI 에이전트들이 웹 리서치부터 개체 추출, 관계 매핑, 검증을 거쳐 구조화된 온톨로지(Ontology) 그래프를 생성하고 프론트엔드 캔버스에 시각화합니다.

생성된 그래프는 표준 관계 어휘로 정규화되고, **OWL 2 RL 추론기**로 새 사실을 추론하며 모순을 찾아냅니다. 노드와 관계는 **Wikidata**에 연결되고, 결과는 출처와 함께 **지식 베이스**에 누적됩니다. 추론기 점수가 좋아질 때만 오류를 **자동 수정**합니다.

---

## 🚀 주요 기능

### 1. AI 멀티 에이전트 파이프라인 (CrewAI & Ollama)
로컬 LLM(Ollama 등)을 연동하여 독립적인 에이전트들이 협업해 온톨로지를 설계합니다.
* **Research Agent**: 입력된 주제와 관련된 웹 자료를 수집하고 기초 정보를 분석합니다.
* **Extraction Agent**: 수집된 텍스트에서 주요 개념을 분석하여 Class, Instance, Literal로 분류합니다.
* **Relation Agent**: 추출된 개념들 간의 세부 관계(`is-a`, `part-of`, `has-value`, `related-to` 등)를 정의합니다.
* **Validation Agent**: 온톨로지의 순환 참조, 모순, 누락된 관계 등을 품질 검증합니다.
* **Editor Agent**: 검증 결과를 바탕으로 Autology 캔버스 규격에 최적화된 최종 온톨로지 JSON 데이터를 생성합니다.
* **Critic Agent**: 완성된 초안을 OWL 검증 결과와 함께 검토하고, 피드백을 Editor에게 돌려보내 다시 고치게 합니다.

### 2. 시맨틱 웹 표준 규격 연동 (RDFLib & pySHACL)
단순한 시각화를 넘어, 표준 시맨틱 웹 기술과의 호환성을 갖추고 있습니다.
* **RDF 가져오기/내보내기**: 생성된 온톨로지를 Turtle, RDF/XML, JSON-LD 등 표준 포맷으로 상호 변환하고 다운로드할 수 있습니다.
* **SPARQL 쿼리 엔진**: 온톨로지 데이터를 대상으로 직접 SPARQL SELECT 쿼리를 작성하고 실행할 수 있습니다.
* **SHACL 검증**: SHACL Shape 데이터 모델을 활용해 생성된 온톨로지 그래프가 논리적/스키마 제약 조건에 부합하는지 유효성 검사를 제공합니다.

### 3. 관계 어휘 정규화와 OWL 2 RL 추론·검증
* **핵심 관계 어휘**: 도메인에 무관한 핵심 관계 15개(전이·대칭·속성 체인 특성, 한/영 별칭)로 LLM이 만든 엣지 라벨을 정규화합니다. `is-a`는 노드 종류에 따라 `rdfs:subClassOf` 또는 `rdf:type`으로 나뉘고, 역방향 표현은 방향을 뒤집어 맞춥니다. 한국어 조사·어미는 떼고 비교합니다.
* **OWL 2 RL 추론**: 전이(prp-trp), 하위 속성(prp-spo1), 속성 체인(prp-spo2), 대칭(prp-symp), 클래스 상속(cax-sco, cax-eqc) 규칙으로 새 사실을 추론합니다. 추론된 엣지마다 근거가 남아 클릭하면 설명을 볼 수 있으며, 결과는 테스트에서 [owlrl](https://github.com/RDFLib/OWL-RL)과 교차 검증합니다.
* **규칙 기반 검증**: 끊긴/자기 참조/중복 엣지, 고립 노드, 리터럴 오용, 순환, disjoint 위반, 충족 불가능 클래스 등을 찾습니다. 규칙 패널의 **"OWL 추론·검증"** 버튼으로 실행하며, 생성 파이프라인은 이 결과를 Critic 에이전트에게 전달합니다.

### 4. Wikidata 연결
* **관계 → Wikidata 속성**: 항목을 값으로 갖는 Wikidata 속성 1,790개를 내장하고, 문자 n-gram TF-IDF와 `bge-m3` 임베딩(Ollama)을 섞은 하이브리드 검색으로 후보를 찾습니다. LLM이 후보 중에서 고르거나 "해당 없음"을 선택하고, 방향을 뒤집어 다시 물어 반대 방향이나 비슷하지만 틀린 연결을 걸러냅니다.
* **노드 → Wikidata 항목**: 동음이의·목록 페이지를 제외하고 정확한 라벨을 우선해 노드를 Wikidata 항목에 연결합니다.
* RDF 내보내기에 `skos:exactMatch`와 `rdfs:subPropertyOf`가 함께 기록됩니다.

### 5. 누적 지식 베이스와 근거 있는 탐색
* **지식 베이스**: 생성한 그래프를 SQLite 지식 베이스(`backend/data/knowledge.db`)에 쌓습니다. 같은 Wikidata 항목이나 같은 라벨·종류의 엔터티는 하나로 합치고, 출처별로 기록하며 출처 단위로 삭제할 수 있습니다.
* **경로 탐색**: 명시된 사실과 추론된 사실을 함께 써서 두 노드 사이의 경로, 한 노드에 관한 사실을 찾습니다. 모든 답에는 지식 베이스 출처나 명시된 엣지까지 내려가는 유도 트리가 붙습니다.
* **지식 탭**: 연결·저장·이웃 불러오기·출처 관리와 탐색을 제공하며, 근거를 캔버스에 강조하거나 근거 서브그래프만 불러올 수 있습니다.

### 6. 추론기 기반 자동 수정
* 추론기가 그래프 점수를 매기고, **점수가 좋아지는 변경만 반영**합니다.
* 끊긴 엣지, 클래스처럼 쓰인 인스턴스, 뒤집힌 has-property 등은 LLM 없이 규칙으로 고칩니다.
* 순환이나 disjoint 위반처럼 오류가 증명된 경우에는 관련 진술만 LLM에 보여 주고 틀린 진술을 고르게 합니다(판단할 수 없으면 그대로 둡니다).
* 노드는 지우지 않고, 엣지 제거는 20%까지만 하며, 제거한 엣지는 `repair_report`에 남깁니다.

### 7. 인터랙티브 웹 시각화 캔버스 (React)
* 생성된 온톨로지 노드(Class, Instance, Literal)와 엣지(관계)를 반응형 그래프로 렌더링합니다.
* 마우스 드래그, 줌 인/아웃, 노드 세부 정보 편집 및 노출 기능을 제공합니다.
* WebSocket 연결을 통해 백엔드 AI 에이전트들의 실시간 추론 상태(생각, 실행 로그)를 모니터링할 수 있습니다.

### 8. 단일 실행파일 데스크톱 배포 (PyInstaller)
* 프론트엔드(React 빌드)와 백엔드(FastAPI)를 하나의 실행파일(`autology-backend.exe`)로 패키징합니다.
* 실행파일을 더블 클릭하면 백엔드가 뜨고, **로컬에 설치된 Ollama 서버를 자동으로 함께 기동**하며, 기본 브라우저가 자동으로 열립니다.
* API와 UI를 동일 출처(`http://127.0.0.1:8000`)에서 서빙하므로 별도 설정이 필요 없습니다.

---

## 🛠 기술 스택

### Frontend
* **Core**: React, Vite
* **Styling**: TailwindCSS, Framer Motion (애니메이션), Lucide React (아이콘)
* **Desktop Wrapper**: Tauri

### Backend
* **Core**: FastAPI, Uvicorn
* **AI Orchestration**: CrewAI, LangChain Ollama, WebSockets
* **Semantic Engine**: RDFLib, pySHACL, 자체 OWL 2 RL 추론기 (owlrl로 교차 검증)
* **Knowledge**: Wikidata, SQLite, `bge-m3` 임베딩 (Ollama)

---

## 💻 실행 방법

### 사전 요구사항
* Node.js (v18 이상 권장)
* Python **3.10 ~ 3.13** (CrewAI가 아직 3.14를 지원하지 않습니다. Windows의 `setup.bat`은 이 범위의 Python을 자동으로 찾습니다.)
* Ollama ([ollama.com/download](https://ollama.com/download) 설치 후 모델 1개 이상 받기 — 예: `ollama pull gemma2`)
  * Autology는 Ollama에 설치된 모델 목록을 자동으로 불러와 첫 번째 모델을 선택합니다. UI 상단에서 변경 가능합니다.
  * Wikidata 관계 연결의 의미 검색에는 임베딩 모델이 필요합니다: `ollama pull bge-m3` (없으면 문자 기반 검색만 사용합니다. `AUTOLOGY_EMBED_MODEL`로 바꿀 수 있습니다.)

### 1단계: 초기 설정 및 의존성 설치 (최초 1회 실행)
프로젝트 실행 전에 개발 환경(백엔드 Python 가상환경 및 프론트엔드 npm 패키지)을 설정해야 합니다.

* **Windows**: `setup.bat` 파일을 더블 클릭하거나 터미널에서 실행합니다.
* **macOS/Linux**: 터미널에서 `./setup.sh`를 실행합니다.

### 2단계: 애플리케이션 실행
설치가 완료되면 아래 스크립트를 실행하여 백엔드(FastAPI)와 프론트엔드(Vite) 개발 서버를 시작합니다.

* **Windows**: `start.bat` 파일을 더블 클릭하거나 터미널에서 실행합니다.
* **macOS/Linux**: 터미널에서 `./start.sh`를 실행합니다.

#### 1. Backend 실행
```bash
cd backend

# 가상환경 생성 및 패키지 설치
python -m venv venv
venv\Scripts\activate  # Windows
source venv/bin/activate  # macOS/Linux
pip install -r requirements.txt

# 서버 구동
uvicorn main:app --reload --port 8000
```
* **백엔드 API 주소**: `http://localhost:8000`
* **API 문서 (Swagger)**: `http://localhost:8000/docs`

#### 2. Frontend 실행
```bash
# 의존성 패키지 설치
npm install

# 개발 서버 실행
npm run dev
```
* **프론트엔드 접속 주소**: `http://localhost:5173`

---

## 📦 데스크톱 앱 빌드 및 배포 (단일 실행파일)

일반 사용자에게 배포할 때는 개발 서버 대신 단일 실행파일로 패키징합니다.

### 빌드 (개발자/배포 담당자)
* **Windows**: `build_exe.bat` 실행
  1. 프론트엔드를 빌드(`npm run build`)해 `dist/`를 생성하고
  2. PyInstaller로 백엔드 + `dist/`를 하나의 `autology-backend.exe`로 묶습니다.
* 결과물: `dist/autology-backend.exe`

### 실행 (최종 사용자)
1. [Ollama](https://ollama.com/download)를 설치하고 모델을 1개 이상 받습니다. (`ollama pull gemma2`)
2. `autology-backend.exe`를 더블 클릭합니다.
   * 백엔드 서버가 `http://127.0.0.1:8000`에서 API와 UI를 동시에 서빙합니다.
   * Ollama 서버가 실행 중이 아니면 **자동으로 기동**합니다. (Ollama 미설치 시 안내 메시지 출력)
   * 준비되면 **기본 브라우저가 자동으로 열립니다.**

> 참고: 실행파일은 단일 PC에서 동작하는 로컬 앱입니다. 프론트엔드/백엔드/Ollama가 모두 `127.0.0.1`에서 통신하므로 별도 네트워크 설정이 필요 없습니다.

---

## 🩺 문제 해결 (Troubleshooting)

| 증상 | 원인 / 해결 |
|---|---|
| **"Ollama가 필요합니다" 안내 화면이 뜸** | Ollama 미설치. [ollama.com/download](https://ollama.com/download)에서 설치 후 앱을 다시 실행하세요. |
| **"Ollama 서버를 켜는 중…"에서 멈춤** | 보통 몇 초 안에 자동 연결됩니다. 계속 안 되면 터미널에서 `ollama serve`를 직접 실행하세요. |
| **"설치된 모델이 없습니다"** | 모델을 받으세요: `ollama pull gemma2`. 받은 뒤 안내 화면의 **다시 확인**을 누르세요. |
| **모델 목록이 비어 있음 / 다른 모델을 쓰고 싶음** | 앱 우상단 모델 선택기에서 변경합니다. 설치된 모델은 자동으로 첫 번째가 선택됩니다. |
| **포트 8000 또는 5173이 이미 사용 중** | 기존 프로세스를 종료(`./stop.sh`)하거나 점유 프로세스를 정리한 뒤 다시 실행하세요. |
| **검색 결과가 빈약함 (리서치 단계)** | 키 없이도 Wikipedia로 동작합니다. 더 나은 결과를 원하면 `backend/.env`에 `TAVILY_API_KEY` 또는 `SERPER_API_KEY`를 설정하세요 (`backend/.env.example` 참고). |
| **원격/다른 포트의 Ollama 사용** | 앱 우상단 설정에서 Ollama 주소를 변경하거나, `backend/.env`에 `OLLAMA_BASE`를 지정하세요. |

---

<img width="2557" height="1266" alt="image" src="https://github.com/user-attachments/assets/bdd172ee-b03f-47fc-9980-7e065d8c2f39" />
<img width="686" height="935" alt="image" src="https://github.com/user-attachments/assets/54a3009d-f9db-4d22-a832-9199347a0631" />
<img width="1121" height="766" alt="image" src="https://github.com/user-attachments/assets/7f39dec3-c5f8-4502-9302-178accfb2fbf" />


## 🧪 테스트와 품질 평가

```bash
cd backend
# 테스트용 패키지 설치 (owlrl은 추론 결과 교차 검증에 사용)
./venv/Scripts/python -m pip install pytest owlrl

# 단위 테스트
./venv/Scripts/python -m pytest tests        # Windows
./venv/bin/python -m pytest tests            # macOS/Linux

# 품질 평가 (결과는 eval/results/<timestamp>.json에 저장)
./venv/Scripts/python eval/run_eval.py --suites normalization,reasoning,paths   # 오프라인
./venv/Scripts/python eval/run_eval.py --suites relations,entities --repeat 3 --model qwen3.5:4b   # LLM 필요
```

평가 항목: 관계 정규화, 관계 검색 recall@k, 관계·엔터티 연결 정확도, owlrl 대비 추론 정확성, 전수 탐색 대비 경로 탐색, 자동 수정. 튜닝에 쓰지 않은 held-out 세트를 포함합니다.

## 📂 프로젝트 구조

```text
Autology/
├── backend/                # FastAPI 백엔드 애플리케이션
│   ├── crew/               # CrewAI 에이전트 및 태스크 정의
│   ├── models/             # API 요청/응답 스키마 및 잡 모델
│   ├── semantic.py         # RDFLib, SPARQL, SHACL 비즈니스 로직
│   ├── vocabulary.py       # 핵심 관계 어휘와 엣지 라벨 정규화
│   ├── reasoning.py        # OWL 2 RL 추론기와 규칙 기반 검증
│   ├── vocab_rag.py        # 관계 → Wikidata 속성 연결 (하이브리드 검색 + LLM)
│   ├── entity_link.py      # 노드 → Wikidata 항목 연결
│   ├── knowledge.py        # SQLite 누적 지식 베이스
│   ├── explore.py          # 근거가 붙는 경로·사실 탐색
│   ├── repair.py           # 추론기 기반 자동 수정
│   ├── resources/          # 내장 Wikidata 속성 어휘 (CC0)
│   ├── scripts/            # 어휘 빌드 스크립트
│   ├── eval/               # 품질 평가 도구와 정답 데이터
│   ├── tests/              # pytest 테스트
│   ├── main.py             # FastAPI 라우터 및 WebSocket 엔드포인트
│   └── requirements.txt    # 백엔드 라이브러리 목록
├── src/                    # React 프론트엔드 소스 코드
│   ├── components/         # UI 및 그래프 캔버스 컴포넌트
│   ├── context/            # 전역 상태 관리 컨텍스트
│   ├── hooks/              # 커스텀 훅
│   ├── App.jsx             # 메인 앱 컴포넌트
│   └── index.css           # 글로벌 스타일 정의
├── package.json            # npm 설정 및 종속성
├── vite.config.js          # Vite 번들러 설정
├── start.bat / start.sh    # 통합 개발 서버 실행 스크립트
└── .gitignore              # Git 무시 파일 목록 (추가됨)
```

## 📄 라이선스

이 프로젝트는 [Apache License 2.0](./LICENSE)을 따릅니다.
