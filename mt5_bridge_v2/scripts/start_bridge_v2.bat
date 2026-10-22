@echo off
setlocal
cd /d "%~dp0\..\.."
if not exist ".env" (
  echo ERROR: project-root .env was not found.
  pause
  exit /b 1
)
py -3.12 -m pip install -r "mt5_bridge_v2\requirements.txt"
if errorlevel 1 (
  echo ERROR: Python dependencies failed to install.
  pause
  exit /b 1
)
py -3.12 -m mt5_bridge_v2.agent.main
echo.
echo Bridge V2 stopped.
pause
