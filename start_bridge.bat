@echo off
setlocal EnableExtensions EnableDelayedExpansion
title XAUUSD MT5 Bridge - Demo and Live

cd /d "%~dp0"

echo ==========================================
echo   XAUUSD MT5 BRIDGE
echo ==========================================
echo.
echo   1. Demo account
echo   2. Live account (real-money trading)
echo   3. Exit
echo.
choice /c 123 /n /m "Choose mode [1-3]: "
if errorlevel 3 exit /b 0
if errorlevel 2 goto LIVE
if errorlevel 1 goto DEMO

:DEMO
set "MT5_EXECUTION_ENVIRONMENT=DEMO"
set "MT5_LIVE_TRADING_ENABLED=false"
set "MT5_LIVE_CONFIRMATION="
goto PREPARE

:LIVE
echo.
echo WARNING: LIVE mode can place orders using real money.
echo Only continue if you intentionally want to connect to a real account.
echo.
set "LIVE_CONFIRM="
set /p "LIVE_CONFIRM=Type ENABLE LIVE TRADING to continue: "
if /i not "!LIVE_CONFIRM!"=="ENABLE LIVE TRADING" (
  echo Live mode cancelled. No real-trading authorization was enabled.
  pause
  exit /b 1
)
set "MT5_EXECUTION_ENVIRONMENT=LIVE"
set "MT5_LIVE_TRADING_ENABLED=true"
set "MT5_LIVE_CONFIRMATION=I_UNDERSTAND_LIVE_TRADING_RISK"
goto PREPARE

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
  echo ERROR: MetaTrader5 is not installed for Python 3.12.
  echo Install requirements first.
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
echo Selected mode: %MT5_EXECUTION_ENVIRONMENT%
echo The bridge will verify the actual MT5 account mode before allowing execution.
echo Keep this window open. Press Ctrl+C to stop.
echo Never expose port 8765 directly to the public internet.
echo.
py -3.12 mt5_bridge\bridge.py
echo.
echo Bridge process ended.
pause
