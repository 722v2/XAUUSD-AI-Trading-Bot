@echo off
setlocal EnableExtensions
title XAUUSD MT5 Bridge V2
cd /d "%~dp0"

if not exist ".env" (
  echo ERROR: Project-root .env was not found.
  pause
  exit /b 1
)
if not exist "mt5_bridge_v2\scripts\start_bridge_v2.bat" (
  echo ERROR: Bridge V2 launcher is missing. Download the complete updated project.
  pause
  exit /b 1
)

call "mt5_bridge_v2\scripts\start_bridge_v2.bat"
