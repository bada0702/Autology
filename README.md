# Autology (오톨로지)

AI 멀티 에이전트(CrewAI)와 시맨틱 웹 기술을 결합한 **지능형 온톨로지 생성 및 시각화 플랫폼**입니다. 사용자가 특정 주제를 입력하면, 백엔드의 AI 에이전트들이 웹 리서치부터 개체 추출, 관계 매핑, 검증을 거쳐 구조화된 온톨로지(Ontology) 그래프를 생성하고 프론트엔드 캔버스에 시각화합니다.

---

## 🚀 주요 기능

### 1. AI 멀티 에이전트 파이프라인 (CrewAI & Ollama)
로컬 LLM(Ollama 등)을 연동하여 5단계의 독립적인 에이전트가 협업해 온톨로지를 설계합니다.
* **Research Agent**: 입력된 주제와 관련된 웹 자료를 수집하고 기초 정보를 분석합니다.
* **Extraction Agent**: 수집된 텍스트에서 주요 개념을 분석하여 Class, Instance, Literal로 분류합니다.
* **Relation Agent**: 추출된 개념들 간의 세부 관계(`is-a`, `part-of`, `has-value`, `related-to` 등)를 정의합니다.
* **Validation Agent**: 온톨로지의 순환 참조, 모순, 누락된 관계 등을 품질 검증합니다.
* **Editor Agent**: 검증 결과를 바탕으로 Autology 캔버스 규격에 최적화된 최종 온톨로지 JSON 데이터를 생성합니다.

### 2. 시맨틱 웹 표준 규격 연동 (RDFLib & pySHACL)
단순한 시각화를 넘어, 표준 시맨틱 웹 기술과의 호환성을 갖추고 있습니다.
* **RDF 가져오기/내보내기**: 생성된 온톨로지를 Turtle, RDF/XML, JSON-LD 등 표준 포맷으로 상호 변환하고 다운로드할 수 있습니다.
* **SPARQL 쿼리 엔진**: 온톨로지 데이터를 대상으로 직접 SPARQL SELECT 쿼리를 작성하고 실행할 수 있습니다.
* **SHACL 검증**: SHACL Shape 데이터 모델을 활용해 생성된 온톨로지 그래프가 논리적/스키마 제약 조건에 부합하는지 유효성 검사를 제공합니다.

### 3. 인터랙티브 웹 시각화 캔버스 (React)
* 생성된 온톨로지 노드(Class, Instance, Literal)와 엣지(관계)를 반응형 그래프로 렌더링합니다.
* 마우스 드래그, 줌 인/아웃, 노드 세부 정보 편집 및 노출 기능을 제공합니다.
* WebSocket 연결을 통해 백엔드 AI 에이전트들의 실시간 추론 상태(생각, 실행 로그)를 모니터링할 수 있습니다.

### 4. 단일 실행파일 데스크톱 배포 (PyInstaller)
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
* **Semantic Engine**: RDFLib, pySHACL

---

## 💻 실행 방법

### 사전 요구사항
* Node.js (v18 이상 권장)
* Python (v3.10 이상 권장)
* Ollama ([ollama.com/download](https://ollama.com/download) 설치 후 모델 1개 이상 받기 — 예: `ollama pull gemma2`)
  * Autology는 Ollama에 설치된 모델 목록을 자동으로 불러와 첫 번째 모델을 선택합니다. UI 상단에서 변경 가능합니다.

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

## 📂 프로젝트 구조

```text
Autology/
├── backend/                # FastAPI 백엔드 애플리케이션
│   ├── crew/               # CrewAI 에이전트 및 태스크 정의
│   ├── models/             # API 요청/응답 스키마 및 잡 모델
│   ├── semantic.py         # RDFLib, SPARQL, SHACL 비즈니스 로직
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
