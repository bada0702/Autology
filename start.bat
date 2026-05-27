@echo off
echo Autology Starting...

echo [Ollama] Checking...
curl -s http://localhost:11434 >nul 2>&1
if %errorlevel% neq 0 (
    echo [Ollama] Starting ollama serve...
    start "Ollama" cmd /c "ollama serve"
    timeout /t 3 /nobreak >nul
) else (
    echo [Ollama] Already running.
)

echo [Backend] Starting...
start "Autology Backend" cmd /k "cd /d D:\autology\backend && uvicorn main:app --reload --port 8000"

echo.
echo   App       http://localhost:8000
echo   Ollama    http://localhost:11434
echo.
timeout /t 3 /nobreak >nul
start "" "http://localhost:8000"
pause