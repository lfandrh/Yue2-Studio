@echo off
setlocal enableextensions
rem ===========================================================================
rem  YuE2 bundle - clean up test artifacts
rem  Pure ASCII. Keep CRLF line endings.
rem
rem  Usage:  clean.bat [--yes] [--dry-run] [--keep-runs] [--deep]
rem    --yes        do not ask for confirmation
rem    --dry-run    only report, change nothing
rem    --keep-runs  stop the server but keep runs\
rem    --deep       also delete every __pycache__ folder (slower)
rem
rem  It never touches app\, YuE\src, YuE\models or YuE\.venv.
rem ===========================================================================

set "BUNDLE=%~dp0"
set "RUNS=%BUNDLE%runs"
set "YES="
set "DRY="
set "KEEP="
set "DEEP="

:parse
if "%~1"=="" goto :parsed
if /I "%~1"=="--yes" set "YES=1"
if /I "%~1"=="--dry-run" set "DRY=1"
if /I "%~1"=="--keep-runs" set "KEEP=1"
if /I "%~1"=="--deep" set "DEEP=1"
shift
goto :parse
:parsed

rem ---- safety: refuse to run outside the real bundle --------------------
if not exist "%BUNDLE%app\server.py" (
  echo ERROR: not found: %BUNDLE%app\server.py
  echo         Run this file from the bundle root.
  goto :fail
)
if not exist "%BUNDLE%YuE\.venv\python.exe" (
  echo ERROR: not found: %BUNDLE%YuE\.venv\python.exe
  echo         This does not look like the YuE2 bundle.
  goto :fail
)
fsutil reparsepoint query "%BUNDLE%" >nul 2>&1
if not errorlevel 1 (
  echo ERROR: %BUNDLE% is a link, not a real folder. Refusing to clean.
  goto :fail
)

set "PORT=%YUE2_PORT%"
if not defined PORT set "PORT=9090"
cd /d "%BUNDLE%"
echo YuE2 bundle cleanup
echo   bundle: %BUNDLE%
echo.

rem ---- what will happen --------------------------------------------------
set "WILL_RUNS=0"
if not defined KEEP if exist "%RUNS%" set "WILL_RUNS=1"
if defined WILL_RUNS (echo   remove : %RUNS%) else (echo   keep   : %RUNS%)
echo   stop   : the web server on port %PORT%
if defined DEEP echo   remove : all __pycache__ folders
echo.
if defined WILL_RUNS fsutil reparsepoint query "%RUNS%" >nul 2>&1
if defined WILL_RUNS if not errorlevel 1 (
  echo ERROR: %RUNS% is a link. Refusing to delete it.
  goto :fail
)

if defined DRY (
  echo --dry-run: nothing changed.
  goto :done
)

if not defined YES (
  set "ANSWER="
  set /p "ANSWER=Type YES to continue: "
  if /I not "%ANSWER%"=="YES" (
    echo Cancelled.
    goto :done
  )
)

rem ---- stop the server (frees the GPU) ----------------------------------
call :stop_server

rem ---- delete ------------------------------------------------------------
if defined WILL_RUNS (
  rd /s /q "%RUNS%" >nul 2>&1
  if exist "%RUNS%" (
    echo WARNING: %RUNS% was not removed completely.
  ) else (
    echo Removed %RUNS%
  )
)
if defined DEEP call :clean_pyc

echo.
echo Cleanup done. Start again with start.bat
goto :done

:stop_server
if exist "%BUNDLE%stop.bat" call "%BUNDLE%stop.bat" %PORT% --no-pause >nul 2>&1
if exist "%RUNS%\." del /q "%RUNS%\.stop_*.flag" >nul 2>&1
exit /b 0

:clean_pyc
echo Scanning for __pycache__ ...
for /f "delims=" %%D in ('dir /s /b /ad "%BUNDLE%" 2^>nul ^| findstr /E /C:"__pycache__"') do (
  if exist "%%D" rd /s /q "%%D" >nul 2>&1
)
exit /b 0

:done
exit /b 0

:fail
exit /b 1