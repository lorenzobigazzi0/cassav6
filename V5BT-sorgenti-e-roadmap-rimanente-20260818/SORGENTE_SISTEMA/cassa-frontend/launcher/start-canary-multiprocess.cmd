@echo off
setlocal EnableExtensions
set "ROOT=%~dp0.."
cd /d "%ROOT%"
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT%\configs\canary-multiprocess.env.example") do set "%%A=%%B"
echo WARNING: canary-multiprocess is experimental. Use only after STOP/REVIEW gate.
node scripts\check-release-clean.mjs --warn-only .
node scripts\print-runtime-profile.mjs --profile canary-multiprocess --root "%ROOT%"
npm run dev:backend
endlocal
