@echo off
setlocal enableextensions
rem ===========================================================================
rem  YuE2 local music workstation - stop the web server and the model worker
rem  Pure ASCII. Keep CRLF line endings.
rem
rem  Usage:  stop.bat [port] [--no-pause]
rem  Port:   command line  >  YUE2_PORT  >  9090
rem ===========================================================================

set "ROOT=%~dp0"
set "RUNS=%ROOT%runs"

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

rem  Tell the launcher this is a deliberate stop, not a crash.
if not exist "%RUNS%" mkdir "%RUNS%" >nul 2>&1
type nul > "%RUNS%\.stop_%PORT%.flag"

rem ---- kill the listener and its child tree (the model worker) --------------
for /f "tokens=5" %%A in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr "LISTENING"') do call :kill_pid %%A

rem ---- bounded wait for the port to be released -----------------------------
set /a TRIES=0
:wait_free
set /a TRIES+=1
if %TRIES% gtr 25 goto :wait_over
netstat -ano | findstr /C:":%PORT% " | findstr "LISTENING" >nul
if errorlevel 1 goto :wait_over
ping -n 2 127.0.0.1 >nul
goto :wait_free
:wait_over

netstat -ano | findstr /C:":%PORT% " | findstr "LISTENING" >nul
if errorlevel 1 (
  echo YuE2 Web stopped.
  goto :done
)
echo WARNING: port %PORT% is still busy. Kill it manually, for example:
echo   netstat -ano ^| findstr /C:":%PORT% " ^| findstr LISTENING
goto :fail

:kill_pid
set "KP=%~1"
if not defined KP exit /b 0
set "KP_BAD="
for /f "delims=0123456789" %%N in ("%KP%") do set "KP_BAD=1"
if defined KP_BAD exit /b 0
echo   stopping pid %KP% ...
taskkill /PID %KP% /T /F >nul 2>&1
exit /b 0

:bad_port
echo ERROR: port must be a number between 1 and 65535, got "%PORT%".
echo   Usage: stop.bat [port]     e.g. stop.bat 9091
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