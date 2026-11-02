@echo off
setlocal
set "KIT=%~dp0YuE"
set "YUE2_KIT=%KIT%"
set "HF_ENDPOINT=https://hf-mirror.com"
cd /d "%~dp0"
netstat -ano | findstr ":8083" | findstr "LISTENING"
if not errorlevel 1 (
  echo YuE2 Web is already running at http://127.0.0.1:8083
  echo Run stop.bat first if you want to restart it.
  start "" http://127.0.0.1:8083
  pause
  exit /b 0
)
echo YuE2 Web UI starting at http://127.0.0.1:8083
echo Close this window or run stop.bat to stop.
start "" /b cmd /c "timeout /t 4 /nobreak && start http://127.0.0.1:8083"
"%KIT%\.venv\Scripts\python.exe" -m uvicorn app.server:app --host 127.0.0.1 --port 8083
echo.
echo YuE2 Web stopped.
pause
