@echo off
setlocal EnableDelayedExpansion

:: ─────────────────────────────────────────────────────────────────────
::  AzerEnerji Dashboard Launcher
::  Starts the backend server, frontend dev server, and opens the UI.
:: ─────────────────────────────────────────────────────────────────────

set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%backend"
set "FRONTEND_DIR=%ROOT%frontend"
set "VENV_PYTHON=%BACKEND_DIR%\.venv\Scripts\python.exe"
set "FRONTEND_URL=http://localhost:5173"
set "BACKEND_PORT=8001"

title AzerEnerji Dashboard - Starting...

:: ── Pre-flight checks ────────────────────────────────────────────────
if not exist "%VENV_PYTHON%" (
    echo [ERROR] Python virtual environment not found at:
    echo         %VENV_PYTHON%
    echo.
    echo Please run:  cd backend ^&^& python -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

:: ── Check if node_modules exist ──────────────────────────────────────
if not exist "%FRONTEND_DIR%\node_modules" (
    echo [INFO] Installing frontend dependencies...
    cd /d "%FRONTEND_DIR%"
    npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

:: ── Kill any existing processes on our ports ─────────────────────────
echo.
echo ══════════════════════════════════════════════════════════════
echo   AzerEnerji Energy Dashboard
echo ══════════════════════════════════════════════════════════════
echo.

:: ── Start Backend Server ─────────────────────────────────────────────
echo [1/3] Starting backend server on port %BACKEND_PORT%...
start "AzerEnerji Backend" /min cmd /c "cd /d "%BACKEND_DIR%" && "%VENV_PYTHON%" server.py"

:: ── Start Frontend Dev Server ────────────────────────────────────────
echo [2/3] Starting frontend dev server on port 5173...
start "AzerEnerji Frontend" /min cmd /c "cd /d "%FRONTEND_DIR%" && npm run dev"

:: ── Wait for frontend to be ready, then open browser ─────────────────
echo [3/3] Waiting for servers to start...
echo.

set "ATTEMPTS=0"
:wait_loop
set /a ATTEMPTS+=1
if %ATTEMPTS% gtr 60 (
    echo [WARN] Timed out waiting for frontend. Opening browser anyway...
    goto open_browser
)

timeout /t 2 /nobreak >nul

:: Try to reach the frontend
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '%FRONTEND_URL%' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 goto open_browser
echo        Still waiting... (attempt %ATTEMPTS%)
goto wait_loop

:open_browser
echo.
echo ══════════════════════════════════════════════════════════════
echo   Dashboard is ready!
echo   Backend:  http://localhost:%BACKEND_PORT%
echo   Frontend: %FRONTEND_URL%
echo ══════════════════════════════════════════════════════════════
echo.
echo   Opening browser...
echo   (Keep this window open. Close it to stop all servers.)
echo.
start "" "%FRONTEND_URL%"

:: ── Wait for user to close ───────────────────────────────────────────
echo Press any key to STOP all servers and exit...
pause >nul

:: ── Cleanup: kill the backend and frontend windows ───────────────────
echo.
echo Shutting down servers...
taskkill /fi "WINDOWTITLE eq AzerEnerji Backend*" /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq AzerEnerji Frontend*" /f >nul 2>&1
echo Done.
exit /b 0
