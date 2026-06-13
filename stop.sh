#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"

BACKEND_PID_FILE="$PID_DIR/backend.pid"
FRONTEND_PID_FILE="$PID_DIR/frontend.pid"

stop_pid() {
    local label="$1"
    local pid_file="$2"

    if [ ! -f "$pid_file" ]; then
        echo "[$label] PID file not found — may not be running."
        return
    fi

    local pid
    pid=$(cat "$pid_file")

    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid"
        echo "[$label] Stopped (PID $pid)."
    else
        echo "[$label] Process $pid not found — already stopped."
    fi

    rm -f "$pid_file"
}

echo "[Autology] Stopping..."
stop_pid "Frontend" "$FRONTEND_PID_FILE"
stop_pid "Backend"  "$BACKEND_PID_FILE"

# 포트 기반 fallback (PID 파일 없을 때)
for port in 5173 8000; do
    pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "[Port $port] Killing leftover process(es): $pids"
        kill $pids 2>/dev/null || true
    fi
done

echo "[Autology] Done."
