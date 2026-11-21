@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0install.ps1" (
  echo install.ps1 not found. Please extract the whole archive first.
  pause
  exit /b 1
)
echo Starting installer...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
