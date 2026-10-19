@echo off
setlocal EnableExtensions EnableDelayedExpansion
title XAUUSD MT5 Bridge - Dashboard Selects Demo or Live

cd /d "%~dp0"

echo ==========================================================
echo   XAUUSD MT5 BRIDGE - Demo / Live selected in dashboard
echo ==========================================================
echo.
echo The dashboard selects the requested environment.
echo This launcher does not force DEMO or LIVE.
echo The bridge verifies the actual connected MT5 account before execution.
echo A mismatched account blocks execution.
echo.

if not exist "mt5_bridge\bridge.py" (
  echo ERROR: mt5_bridge\bridge.py was not found.
  echo Keep this file in the project root beside the mt5_bridge folder.
  pause
  exit /b 1
)

py -3.12 --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python 3.12 was not found.
  pause
  exit /b 1
)

echo Installing/verifying bridge and relay dependencies...
py -3.12 -m pip install -r "mt5_bridge\requirements.txt"
if errorlevel 1 (
  echo ERROR: Dependency installation failed.
  pause
  exit /b 1
)

set "TOKEN_FILE=%USERPROFILE%\.xauusd-mt5-bridge-token"
if exist "%TOKEN_FILE%" (
  set /p "MT5_BRIDGE_TOKEN="<"%TOKEN_FILE%"
) else (
  echo Creating a private local bridge token...
  for /f "usebackq delims=" %%T in (`py -3.12 -c "import secrets; print(secrets.token_urlsafe(32))"`) do set "MT5_BRIDGE_TOKEN=%%T"
  if not defined MT5_BRIDGE_TOKEN (
    echo ERROR: Could not generate a bridge token.
    pause
    exit /b 1
  )
  >"%TOKEN_FILE%" echo(!MT5_BRIDGE_TOKEN!
  echo Token saved outside the project folder.
)
if not defined MT5_BRIDGE_TOKEN (
  echo ERROR: Could not load the local bridge token.
  pause
  exit /b 1
)

rem Keep this port aligned with MT5_LOCAL_BRIDGE_URL in the root .env.
set "MT5_BRIDGE_HOST=127.0.0.1"
set "MT5_BRIDGE_PORT=8765"
set "MT5_LOCAL_BRIDGE_URL=http://127.0.0.1:8765"
set "MT5_RELAY_SERVER_URL=https://xauusd-ai-trading-bot-preview.onrender.com"

echo.
echo Local bridge: %MT5_LOCAL_BRIDGE_URL%
echo Render relay: %MT5_RELAY_SERVER_URL%
echo Mode: selected in the dashboard; account type is verified by the bridge.
echo Keep both windows open. Set the same token in Render as MT5_BRIDGE_TOKEN.
echo Live availability requires explicit MT5_LIVE_TRADING_ENABLED and
echo MT5_LIVE_CONFIRMATION settings in the local .env and matching server
echo LIVE_TRADING_ENABLED and LIVE_TRADING_CONFIRMATION settings on Render.
echo.

start "XAUUSD MT5 Outbound Relay" cmd /k "cd /d ""%~dp0"" && set MT5_BRIDGE_TOKEN=%MT5_BRIDGE_TOKEN% && set MT5_RELAY_SERVER_URL=%MT5_RELAY_SERVER_URL% && set MT5_LOCAL_BRIDGE_URL=%MT5_LOCAL_BRIDGE_URL% && py -3.12 mt5_bridge\outbound_agent.py"
py -3.12 mt5_bridge\bridge.py
echo.
echo Bridge process ended.
pause
