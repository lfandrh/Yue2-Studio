@echo off
setlocal
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8083" ^| findstr "LISTENING"') do (
  echo Stopping YuE2 Web process PID %%a
  taskkill /PID %%a /T /F
)
timeout /t 2 /nobreak
netstat -ano | findstr ":8083" | findstr "LISTENING"
if errorlevel 1 (
  echo YuE2 Web stopped.
) else (
  echo WARNING: port 8083 still busy, kill it manually.
)
pause
