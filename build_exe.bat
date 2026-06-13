@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo  Autology Windows EXE Packaging Script
echo ===================================================

:: Move to script directory safely
cd /d "%~dp0"

:: 1. Build Frontend
echo [Frontend] Checking Node.js installation...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [Error] Node.js is not installed. Please install Node.js.
    pause
    exit /b 1
)

echo [Frontend] Stopping any running autology-backend.exe instances to avoid resource locks...
taskkill /F /IM autology-backend.exe >nul 2>&1

echo [Frontend] Building React application (npm run build)...
call npm run build
if %errorlevel% neq 0 (
    echo [Error] Frontend build failed.
    pause
    exit /b 1
)
echo [Frontend] Build completed. 'dist' folder is ready.

:: 2. Check Python virtual environment and activate
echo.
echo [Backend] Activating virtual environment...
if not exist "backend\venv\Scripts\activate.bat" (
    echo [Backend] Virtual environment not found. Running setup.bat first...
    call setup.bat
    if %errorlevel% neq 0 (
        echo [Error] Setup failed.
        pause
        exit /b 1
    )
)

:: Activate venv
call backend\venv\Scripts\activate.bat

echo [Backend] Upgrading pip...
python -m pip install --upgrade pip

echo [Backend] Ensuring pyinstaller is installed...
python -m pip install pyinstaller

echo [Backend] Installing requirements...
python -m pip install -r backend\requirements.txt

:: 3. Build single EXE via PyInstaller
echo.
echo [Build] Packaging application into single EXE using PyInstaller...
pyinstaller --clean backend\autology-backend.spec
if %errorlevel% neq 0 (
    echo [Error] PyInstaller build failed.
    pause
    exit /b 1
)

echo.
echo ===================================================
echo  Packaging Completed Successfully!
echo  EXE location: c:\Autology-main\dist\autology-backend.exe
echo ===================================================
echo.
pause
