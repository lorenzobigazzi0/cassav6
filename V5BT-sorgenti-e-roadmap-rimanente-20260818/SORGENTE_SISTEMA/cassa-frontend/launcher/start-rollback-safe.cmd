@echo off
setlocal EnableExtensions
set "ROOT=%~dp0.."
cd /d "%ROOT%"
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT%\configs\rollback-safe.env.example") do set "%%A=%%B"
node scripts\print-runtime-profile.mjs --profile rollback-safe --root "%ROOT%"
npm run dev:backend
endlocal
