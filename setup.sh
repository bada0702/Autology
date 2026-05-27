#!/usr/bin/env bash
set -euo pipefail

# 스크립트가 실행된 디렉토리로 이동
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==================================================="
echo " Autology Backend Setup Script"
echo "==================================================="

# Python 3 또는 Python 설치 확인
PYTHON_CMD=""
if command -v python3 &>/dev/null; then
    PYTHON_CMD="python3"
elif command -v python &>/dev/null; then
    PYTHON_CMD="python"
else
    echo "[Error] Python이 설치되어 있지 않거나 PATH에 추가되지 않았습니다."
    exit 1
fi

echo "Using Python: $($PYTHON_CMD --version)"

# 기존 가상환경이 존재하면 재설치 여부 묻기
CREATE_VENV=true
if [ -d "backend/venv" ]; then
    echo "[Backend] Virtual environment already exists."
    read -p "Do you want to reinstall and clean the existing environment? (y/n): " REINSTALL
    if [[ "$REINSTALL" =~ ^[Yy]$ ]]; then
        echo "[Backend] Removing existing virtual environment..."
        rm -rf backend/venv
    else
        CREATE_VENV=false
    fi
fi

if [ "$CREATE_VENV" = true ]; then
    echo "[Backend] Creating virtual environment (venv)..."
    # 혹시 모를 잔재 폴더 삭제
    rm -rf backend/venv
    $PYTHON_CMD -m venv backend/venv
fi

# 가상환경 내의 실행 파일로 패키지 업데이트 및 설치 진행
echo "[Backend] pip 라이브러리를 업그레이드하는 중..."
backend/venv/bin/python -m pip install --upgrade pip

echo "[Backend] requirements.txt를 통해 라이브러리를 설치하는 중..."
backend/venv/bin/pip install -r backend/requirements.txt

# 4. Node.js 확인 및 frontend npm 패키지 설치
echo ""
echo "==================================================="
echo " Autology Frontend Setup"
echo "==================================================="
echo "[Frontend] Node.js 설치 확인 중..."
if ! command -v node &>/dev/null; then
    echo "[Error] Node.js가 설치되어 있지 않거나 PATH에 추가되지 않았습니다."
    echo "https://nodejs.org 에서 Node.js를 설치한 후 다시 실행해주세요."
    exit 1
fi

echo "[Frontend] frontend 의존성 라이브러리를 설치하는 중 (npm install)..."
npm install

echo ""
echo "==================================================="
echo " 설치가 성공적으로 완료되었습니다!"
echo " 이제 ./start.sh 파일을 사용해 서버를 시작할 수 있습니다."
echo "==================================================="
echo ""
