@echo off
chcp 65001 >nul
title Claude Desktop Installer
echo ============================================
echo   Claude Desktop Installer
echo ============================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-claude.ps1"
echo.
echo Finished.
pause
