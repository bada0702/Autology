@echo off
echo Autology Starting...

:: Check if Python venv exists in backend
if exist backend\venv\Scripts\activate.bat (
    echo [Backend] Using venv...
    start "Autology Backend" cmd /k "cd backend && venv\Scripts\activate && uvicorn main:app --reload --port 8000"
) else (
    echo [Backend] Starting without venv...
    start "Autology Backend" cmd /k "cd backend && uvicorn main:app --reload --port 8000"
)

:: Small delay so backend starts first
timeout /t 2 /nobreak >nul

echo [Frontend] Starting Vite dev server...
start "Autology Frontend" cmd /k "npm run dev"

echo.
echo Servers started:
echo   Frontend  http://localhost:5173
echo   Backend   http://localhost:8000
echo.
pause
