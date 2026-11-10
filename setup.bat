@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo  Autology Backend Setup Script
echo ===================================================

:: Move to script directory safely
cd /d "%~dp0"

:: 1. Find a compatible Python (crewai requires Python >=3.10,<3.14)
set PYTHON_CMD=
for %%V in (3.13 3.12 3.11 3.10) do (
    if not defined PYTHON_CMD (
        py -%%V --version >nul 2>&1
        if !errorlevel! equ 0 set PYTHON_CMD=py -%%V
    )
)
if defined PYTHON_CMD goto PYTHON_FOUND

for %%C in (python py) do (
    if not defined PYTHON_CMD (
        %%C -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] < (3,14) else 1)" >nul 2>&1
        if !errorlevel! equ 0 set PYTHON_CMD=%%C
    )
)
if defined PYTHON_CMD goto PYTHON_FOUND

echo [Error] No compatible Python found. Python 3.10 - 3.13 is required
echo         ^(crewai does not support Python 3.14 yet^).
echo         Install Python 3.13, e.g.: winget install Python.Python.3.13
pause
exit /b 1

:PYTHON_FOUND
echo [Info] Using Python command: %PYTHON_CMD%

:: 2. If venv exists, ask user if they want to clean reinstall
if not exist "backend\venv\Scripts\python.exe" goto CREATE_VENV

"backend\venv\Scripts\python.exe" -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] < (3,14) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [Backend] Existing virtual environment uses an unsupported Python version. Recreating...
    goto CREATE_VENV
)

echo [Backend] Virtual environment already exists.
set /p REINSTALL="Do you want to reinstall and clean the existing environment? (y/n): "
if /i "%REINSTALL%"=="y" (
    echo [Backend] Removing existing virtual environment...
    rd /s /q "backend\venv"
    goto CREATE_VENV
)
goto VENV_OK

:CREATE_VENV
echo [Backend] Creating virtual environment (venv)...
if exist "backend\venv" rd /s /q "backend\venv"

%PYTHON_CMD% -m venv backend\venv
if errorlevel 1 (
    echo [Error] Failed to create virtual environment.
    pause
    exit /b 1
)

:VENV_OK
:: 3. Run pip and python in venv directly
echo [Backend] Upgrading pip...
"backend\venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 (
    echo [Warning] Failed to upgrade pip, continuing setup...
)

echo [Backend] Installing libraries via requirements.txt...
"backend\venv\Scripts\pip.exe" install -r "backend\requirements.txt"
if errorlevel 1 (
    echo [Error] Failed to install backend dependencies.
    pause
    exit /b 1
)

:: 4. Check Node.js and install npm dependencies
echo.
echo ===================================================
echo  Autology Frontend Setup
echo ===================================================
echo [Frontend] Checking Node.js installation...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [Error] Node.js is not installed or not in PATH.
    echo Please install Node.js ^(which includes npm^) from https://nodejs.org and try again.
    pause
    exit /b 1
)

echo [Frontend] Installing frontend dependencies (npm install)...
call npm install
if errorlevel 1 (
    echo [Error] Failed to install frontend dependencies.
    pause
    exit /b 1
)

echo.
echo ===================================================
echo  Setup Completed Successfully!
echo  You can now start the application using start.bat
echo ===================================================
echo.
pause
