@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
call "%~dp0_start-profile.cmd" "NEAR_REALTIME_MQTT" "near-realtime-mqtt"
