@echo off
setlocal EnableExtensions
title XAUUSD MT5 Bridge - Project .env
cd /d "%~dp0"

echo ==========================================================
echo   XAUUSD MT5 BRIDGE - PROJECT .env
echo ==========================================================
echo.

if not exist ".env" (
  echo ERROR: .env not found beside start_bridge.bat.
  pause
  exit /b 1
)
if not exist "mt5_bridge\bridge.py" (
  echo ERROR: mt5_bridge\bridge.py not found.
  pause
  exit /b 1
)
py -3.12 --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python 3.12 was not found.
  pause
  exit /b 1
)

rem Read all connection settings from the project-root .env. Never generate a token.
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do if not "%%A"=="" set "%%A=%%B"
if not defined MT5_BRIDGE_TOKEN (
  echo ERROR: Set MT5_BRIDGE_TOKEN in the project .env first.
  pause
  exit /b 1
)
if not defined MT5_RELAY_SERVER_URL (
  echo ERROR: MT5_RELAY_SERVER_URL missing from .env.
  pause
  exit /b 1
)
if not defined MT5_LOCAL_BRIDGE_URL set "MT5_LOCAL_BRIDGE_URL=http://127.0.0.1:8765"
if not defined MT5_BRIDGE_HOST set "MT5_BRIDGE_HOST=127.0.0.1"
if not defined MT5_BRIDGE_PORT set "MT5_BRIDGE_PORT=8765"

echo Installing/verifying bridge dependencies...
py -3.12 -m pip install -r "mt5_bridge\requirements.txt"
if errorlevel 1 (
  echo ERROR: Dependency installation failed.
  pause
  exit /b 1
)

echo Token source: project-root .env only.
echo Relay URL: %MT5_RELAY_SERVER_URL%
echo Local bridge: %MT5_LOCAL_BRIDGE_URL%
echo Environment: %MT5_EXECUTION_ENVIRONMENT%
echo Live trading is disabled by default. Keep both windows open.
echo.

start "XAUUSD MT5 Outbound Relay" cmd /k "cd /d ""%~dp0"" && py -3.12 mt5_bridge\outbound_agent.py"
py -3.12 mt5_bridge\bridge.py
echo.
echo Bridge process ended.
pause
