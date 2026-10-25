@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Creating Python virtual environment...
  py -3.11 -m venv .venv
  if errorlevel 1 (
    echo ERROR: Python 3.11 is required. Install Python 3.11 and enable the Python Launcher.
    pause
    exit /b 1
  )
)

echo Installing/updating Bridge V2 dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :failed
".venv\Scripts\python.exe" -m pip install -r "mt5_bridge_v2\requirements.txt"
if errorlevel 1 goto :failed

if not exist ".env" (
  echo ERROR: Copy .env.example to .env and set MT5_RELAY_SERVER_URL and MT5_BRIDGE_TOKEN first.
  pause
  exit /b 1
)

echo Starting Bridge V2 outbound agent. Keep this window open.
".venv\Scripts\python.exe" -m mt5_bridge_v2.agent.main
if errorlevel 1 goto :failed
goto :eof

:failed
echo.
echo Bridge V2 stopped with an error. Review the messages above.
pause
exit /b 1
