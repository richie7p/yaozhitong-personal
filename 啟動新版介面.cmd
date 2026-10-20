@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-seminar.ps1" -NoBrowser -Port 8086 -DataDirectory .local/seminar-demo-ui-preview-v1
if errorlevel 1 (
  echo 新版預覽未能啟動，請查看上方提示。
  pause
  exit /b 1
)
start "" "http://127.0.0.1:8086/#home"
