@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0uninstall.ps1" (
  echo uninstall.ps1 not found. Please extract the whole archive first.
  pause
  exit /b 1
)
echo Starting uninstaller...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
