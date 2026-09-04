@echo off
setlocal EnableExtensions
set "ROOT=%~dp0.."
cd /d "%ROOT%"
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT%\configs\near-realtime.env.example") do set "%%A=%%B"
node scripts\check-release-clean.mjs --warn-only .
node scripts\print-runtime-profile.mjs --profile near-realtime --root "%ROOT%"
npm run dev:backend
endlocal
