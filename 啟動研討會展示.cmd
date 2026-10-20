@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-seminar.ps1"
if errorlevel 1 pause
