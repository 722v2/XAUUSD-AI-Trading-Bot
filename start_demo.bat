@echo off
setlocal EnableExtensions EnableDelayedExpansion
title XAUUSD MT5 Bridge - Demo

cd /d "%~dp0"

echo ==========================================
echo   XAUUSD MT5 Bridge - DEMO STARTUP
echo ==========================================
echo.

if not exist "mt5_bridge\bridge.py" (
  echo ERROR: mt5_bridge\bridge.py was not found.
  echo This launcher must stay in the project root beside the mt5_bridge folder.
  pause
  exit /b 1
)

py -3.12 --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python 3.12 was not found.
  echo Install Python 3.12, then try again.
  pause
  exit /b 1
)

py -3.12 -m pip show MetaTrader5 >nul 2>&1
if errorlevel 1 (
  echo ERROR: MetaTrader5 is not installed for Python 3.12.
  echo Install project requirements before starting the bridge.
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

set "MT5_BRIDGE_PORT=8765"

echo.
echo Starting the bridge with its configured default mode.
echo Keep this window open while the bridge is in use.
echo Press Ctrl+C to stop.
echo Do not expose port 8765 directly to the public internet.
echo.
py -3.12 mt5_bridge\bridge.py

echo.
echo Bridge process ended.
pause
