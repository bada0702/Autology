@echo off
echo Searching for Autology process on port 5173...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5173') do (
    echo Killing process PID: %%a
    taskkill /f /pid %%a
)
echo Autology Development Server Stopped.
pause
