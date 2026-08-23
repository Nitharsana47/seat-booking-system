@echo off
title NeoSeat Launcher
echo ===================================================
echo 🚀 NeoSeat - Starting Ticketing & Concurrency Platform
echo ===================================================
echo.

:: Ensure we are in the script's directory
cd /d "%~dp0"

:: 1. Start Docker Containers
echo [1/3] Booting up PostgreSQL and Redis via Docker Compose...
docker compose up -d
if %errorlevel% neq 0 (
    echo.
    echo ❌ ERROR: Failed to start Docker Compose. Please verify Docker Desktop is running.
    pause
    exit /b %errorlevel%
)
echo.

:: 2. Prepend Node to path in case terminal is not updated
set PATH=C:\Program Files\nodejs;%PATH%

:: 3. Start Backend in a new window
echo [2/3] Starting Backend Server (Express + Socket.IO)...
start "NeoSeat Backend Server" cmd /c "cd backend && npm run dev"

:: 4. Start Frontend in a new window
echo [3/3] Starting Frontend Server (React + Vite)...
start "NeoSeat Frontend Client" cmd /c "cd frontend && npm run dev"
echo.

echo ===================================================
echo 🎉 All services initiated!
echo.
echo 🌐 Client UI:  http://localhost:5173
echo 🌐 Backend API: http://localhost:5000/api/health
echo ===================================================
echo.
echo Press any key to exit this launcher window (servers will continue running)...
pause > null
del null
