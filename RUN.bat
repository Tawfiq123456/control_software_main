@echo off
setlocal enabledelayedexpansion
title AXIO-ONEFINITY CNC Control Software

rem Always run from this script's own folder, no matter where it was
rem double-clicked from (Desktop shortcut, USB stick, etc).
cd /d "%~dp0"

echo ============================================================
echo  AXIO-ONEFINITY CNC Control Software
echo ============================================================
echo.

if not exist "runtime\node.exe" (
    echo [ERROR] runtime\node.exe not found.
    echo This package is incomplete or was extracted wrong.
    echo Re-download/re-extract the zip and try again.
    echo.
    pause
    exit /b 1
)

if not exist "backend\index.js" (
    echo [ERROR] backend\index.js not found.
    echo This package is incomplete or was extracted wrong.
    echo.
    pause
    exit /b 1
)

echo Starting backend server on http://localhost:4000 ...
echo (Leave this window open. Closing it stops the server.)
echo.

rem Open the browser a couple seconds after launch, giving the server time
rem to bind the port. If it opens too early the user just refreshes once.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:4000"

"runtime\node.exe" "backend\index.js"

echo.
echo ============================================================
echo  Server stopped (exit code %errorlevel%).
echo  If this was unexpected, see README.txt "DEBUG" section.
echo ============================================================
pause
