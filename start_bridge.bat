@echo off
setlocal EnableExtensions EnableDelayedExpansion
title XAUUSD MT5 Bridge - Demo Only

cd /d "%~dp0"

echo ==========================================
echo   XAUUSD MT5 BRIDGE - DEMO ONLY
echo ==========================================
echo.
echo This launcher is locked to DEMO mode.
echo Live trading is not enabled by this launcher.
echo.
set "MT5_EXECUTION_ENVIRONMENT=DEMO"
set "MT5_LIVE_TRADING_ENABLED=false"
set "MT5_LIVE_CONFIRMATION="

:PREPARE
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

py -3.12 -m pip show MetaTrader5 >nul 2>&1
if errorlevel 1 (
  echo Installing the required MT5 Python package...
  py -3.12 -m pip install -r "mt5_bridge\requirements.txt"
  if errorlevel 1 (
    echo ERROR: Could not install the MT5 Python package.
    pause
    exit /b 1
  )
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

set "MT5_BRIDGE_PORT=8765"
echo.
echo Selected mode: %MT5_EXECUTION_ENVIRONMENT%
echo The bridge will verify the actual MT5 account mode before allowing execution.
echo The outbound relay connects to Render over HTTPS. No tunnel or open inbound port is needed.
echo Keep both windows open. The relay token must match MT5_BRIDGE_TOKEN in Render.
echo.
set "MT5_RELAY_SERVER_URL=https://xauusd-ai-trading-bot-preview.onrender.com"
start "XAUUSD MT5 Outbound Relay" cmd /k "cd /d ""%~dp0"" && set MT5_BRIDGE_TOKEN=%MT5_BRIDGE_TOKEN% && set MT5_RELAY_SERVER_URL=%MT5_RELAY_SERVER_URL% && py -3.12 mt5_bridge\outbound_agent.py"
py -3.12 mt5_bridge\bridge.py
echo.
echo Bridge process ended.
pause
