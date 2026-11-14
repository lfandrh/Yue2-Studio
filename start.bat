@echo off
setlocal enableextensions
rem ===========================================================================
rem  YuE2 local music workstation - launcher
rem  Pure ASCII. Keep CRLF line endings: a single lone LF makes cmd misparse.
rem
rem  Usage:  start.bat [port] [--no-pause]
rem  Port:   command line  >  YUE2_PORT  >  9090
rem  Stop:   stop.bat [port] [--no-pause]
rem ===========================================================================

set "ROOT=%~dp0"
set "KIT=%ROOT%YuE"
set "PY=%KIT%\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=%KIT%\.venv\python.exe"
set "SERVER=%ROOT%app\server.py"
set "RUNS=%ROOT%runs"

rem ---- arguments ------------------------------------------------------------
set "ARG_PORT="
set "NOPAUSE="
:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--no-pause" (
  set "NOPAUSE=1"
) else if /I "%~1"=="-nopause" (
  set "NOPAUSE=1"
) else if not defined ARG_PORT (
  set "ARG_PORT=%~1"
) else (
  echo WARN: ignoring unknown argument "%~1"
)
shift
goto :parse_args
:args_done

rem ---- port: arg > environment > default, then validate ---------------------
set "PORT=%ARG_PORT%"
if not defined PORT set "PORT=%YUE2_PORT%"
if not defined PORT set "PORT=9090"

set "BAD_PORT="
for /f "delims=0123456789" %%A in ("%PORT%") do set "BAD_PORT=1"
if defined BAD_PORT goto :bad_port
set /a PORT_NUM=%PORT% 2>nul
if errorlevel 1 goto :bad_port
if %PORT_NUM% lss 1 goto :bad_port
if %PORT_NUM% gtr 65535 goto :bad_port

rem  Stop flag: stop.bat creates it so a deliberate stop is not reported as a crash.
if not exist "%RUNS%" mkdir "%RUNS%" >nul 2>&1
set "STOPFLAG=%RUNS%\.stop_%PORT%.flag"
del /q "%STOPFLAG%" >nul 2>&1

rem ---- environment handed to the app and the worker -------------------------
set "YUE2_KIT=%KIT%"
set "YUE2_PORT=%PORT%"
set "HF_ENDPOINT=https://hf-mirror.com"

rem ---- preflight ------------------------------------------------------------
if not exist "%SERVER%" (
  echo ERROR: backend not found: "%SERVER%"
  echo         Run this file from the project root, or restore app\server.py.
  goto :fail
)
if not exist "%PY%" (
  echo ERROR: python environment not found: "%PY%"
  echo         Follow the setup steps in README.md, then try again.
  goto :fail
)

netstat -ano | findstr /C:":%PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo YuE2 Web is already running at http://127.0.0.1:%PORT%
  echo Run stop.bat first if you want to restart it.
  start "" "http://127.0.0.1:%PORT%"
  goto :done
)

rem  A reserved range (Hyper-V / WSL / Docker) fails with "Permission denied".
"%PY%" -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', %PORT%)); s.close()" >nul 2>nul
if errorlevel 1 (
  echo ERROR: port %PORT% cannot be bound.
  echo         It may be in use, or it may sit inside a Windows reserved range
  echo         held by Hyper-V / WSL / Docker.
  echo   List reserved ranges : netsh int ipv4 show excludedportrange protocol=tcp
  echo   Try another port     : start.bat 9091
  goto :fail
)

echo YuE2 Web UI starting at http://127.0.0.1:%PORT%
echo   log : %RUNS%\app.log
echo   stop: stop.bat %PORT%
echo Close this window to stop, or run stop.bat.
start "" /b cmd /c "ping -n 5 127.0.0.1 >nul && start """" http://127.0.0.1:%PORT%"

"%PY%" -m uvicorn app.server:app --host 127.0.0.1 --port %PORT%
set "UV_EXIT=%errorlevel%"
if exist "%STOPFLAG%" (
  echo.
  echo YuE2 Web stopped.
) else if "%UV_EXIT%"=="0" (
  echo.
  echo YuE2 Web stopped.
) else (
  echo.
  echo ERROR: the server exited with an error. See runs\app.log
)
goto :done

:bad_port
echo ERROR: port must be a number between 1 and 65535, got "%PORT%".
echo   Usage: start.bat [port]     e.g. start.bat 9091
goto :fail

:done
if defined NOPAUSE exit /b 0
echo.
pause
exit /b 0

:fail
if defined NOPAUSE exit /b 1
echo.
pause
exit /b 1