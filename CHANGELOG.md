# Changelog

본 프로젝트의 주요 변경 사항을 기록합니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따르며,
버전은 [유의적 버전(SemVer)](https://semver.org/lang/ko/)을 따릅니다.

## [2.0.0] - 2026-06-13

### Added
- **단일 실행파일 데스크톱 배포**: 백엔드가 빌드된 프론트엔드(`dist/`)를 동일 출처
  (`http://127.0.0.1:8000`)에서 정적 서빙. `build_exe.bat`로 단일 `.exe` 생성.
- **Ollama 자동 기동**: 앱 실행 시 로컬 Ollama 서버가 떠 있지 않으면 자동으로 기동
  (`ollama_manager`). 기본 브라우저도 준비되면 자동으로 열림.
- **Ollama 안내 오버레이**: 미설치 / 미실행 / 모델 없음 상황을 구분해 설치 링크와
  명령어(`ollama pull gemma2` 등)를 안내. 연결되면 자동으로 사라짐.
- **`GET /api/ollama/status`** 엔드포인트 (`installed` / `running` / `models`).
- **`.env` 지원** 및 `backend/.env.example` (`TAVILY_API_KEY`, `SERPER_API_KEY`, `OLLAMA_BASE`).
- **`AUTOLOGY_SKIP_OLLAMA_AUTOSTART`** 환경 변수 — Ollama 자동 기동 비활성화 escape hatch.
- **스모크 테스트** (`backend/tests/test_smoke.py`) — 외부 의존성 없이 핵심 엔드포인트 검증.
- **설치 스크립트 Ollama 사전 점검** (`setup.sh`) 및 README **문제 해결** 섹션.

### Changed
- 프론트엔드의 백엔드 / WebSocket / Ollama 호출이 개발(`npm run dev`)과 프로덕션(exe)
  환경에 따라 자동으로 경로를 전환(동일 출처 vs 직접 호출).
- 백엔드 API 버전 `1.0.0` → `2.0.0` (프론트엔드 `package.json`과 일치).

### Fixed
- 프로덕션 빌드에서 Ollama 호출이 404 나던 문제 — 개발 전용 Vite 프록시(`/ollama-proxy`)
  의존을 제거하고 백엔드 프록시(`/ollama`)를 사용하도록 수정.
