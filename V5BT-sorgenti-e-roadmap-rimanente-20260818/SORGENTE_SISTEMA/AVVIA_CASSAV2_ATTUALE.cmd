@echo off
setlocal
set "APP_ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP_ROOT%tools\start-cassav2-current.ps1"
endlocal
