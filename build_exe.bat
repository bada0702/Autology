@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===================================================
echo  Autology - EXE Build
echo ===================================================

:: 1. Frontend build
echo.
echo [1/4] Building React frontend...
node --version >nul 2>&1
if %errorlevel% neq 0 ( echo [ERROR] Node.js not found. & pause & exit /b 1 )
taskkill /F /IM Autology.exe >nul 2>&1
call npm run build
if %errorlevel% neq 0 ( echo [ERROR] Frontend build failed. & pause & exit /b 1 )
echo [DONE] dist\ ready.

:: 2. Check venv
echo.
echo [2/4] Checking venv...
if not exist "backend\venv\Scripts\python.exe" (
    echo Creating venv...
    python -m venv backend\venv
    backend\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
)

:: Install pyinstaller into venv if missing
if not exist "backend\venv\Scripts\pyinstaller.exe" (
    echo Installing pyinstaller into venv...
    backend\venv\Scripts\python.exe -m pip install pyinstaller
)
echo [DONE] venv ready.

:: 3. PyInstaller
echo.
echo [3/4] Building EXE...
if exist "release" rmdir /s /q release
mkdir release
if exist "build_tmp" rmdir /s /q build_tmp

cd backend
..\backend\venv\Scripts\pyinstaller.exe --clean --distpath ..\release --workpath ..\build_tmp autology-backend.spec
if %errorlevel% neq 0 ( cd .. & echo [ERROR] PyInstaller failed. & pause & exit /b 1 )
cd ..

if exist "build_tmp" rmdir /s /q build_tmp

echo.
echo ===================================================
echo  Done! Output: release\Autology.exe
echo ===================================================
pause
