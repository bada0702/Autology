#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"
mkdir -p "$PID_DIR"

BACKEND_PID_FILE="$PID_DIR/backend.pid"
FRONTEND_PID_FILE="$PID_DIR/frontend.pid"
BACKEND_LOG="$SCRIPT_DIR/.pids/backend.log"
FRONTEND_LOG="$SCRIPT_DIR/.pids/frontend.log"

# 이미 실행 중인지 확인
if [ -f "$FRONTEND_PID_FILE" ] && kill -0 "$(cat "$FRONTEND_PID_FILE")" 2>/dev/null; then
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo "[Autology] Already running (frontend PID $(cat "$FRONTEND_PID_FILE"))."
    echo "  Frontend  http://localhost:5173"
    [ -n "$LOCAL_IP" ] && echo "  Frontend  http://$LOCAL_IP:5173  (LAN)"
    echo "  Backend   http://localhost:8000"
    exit 0
fi

echo "[Autology] Starting..."

# Backend
cd "$SCRIPT_DIR/backend"
if [ -f "venv/bin/activate" ]; then
    echo "[Backend] Using venv..."
    # shellcheck disable=SC1091
    source venv/bin/activate
fi

nohup uvicorn main:app --reload --host 0.0.0.0 --port 8000 > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$BACKEND_PID_FILE"
echo "[Backend] Started (PID $BACKEND_PID) — log: $BACKEND_LOG"

# Frontend
cd "$SCRIPT_DIR"
sleep 2  # 백엔드가 먼저 올라오도록 대기
nohup npm run dev > "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > "$FRONTEND_PID_FILE"
echo "[Frontend] Started (PID $FRONTEND_PID) — log: $FRONTEND_LOG"

LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

echo ""
echo "Servers started:"
echo "  Frontend  http://localhost:5173"
if [ -n "$LOCAL_IP" ]; then
    echo "  Frontend  http://$LOCAL_IP:5173  (LAN)"
fi
echo "  Backend   http://localhost:8000"
echo ""
echo "Logs:"
echo "  tail -f $BACKEND_LOG"
echo "  tail -f $FRONTEND_LOG"
echo ""
echo "Stop with:  ./stop.sh"
