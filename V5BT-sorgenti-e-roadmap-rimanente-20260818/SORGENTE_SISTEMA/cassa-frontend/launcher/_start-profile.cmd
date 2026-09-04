@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "PROFILE_NAME=%~1"
set "ENV_BASENAME=%~2"
if "%PROFILE_NAME%"=="" set "PROFILE_NAME=STANDARD"
if "%ENV_BASENAME%"=="" set "ENV_BASENAME=standard"
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "PROJECT_ROOT=%%~fI"
set "ENV_FILE=%PROJECT_ROOT%\configs\%ENV_BASENAME%.env"
set "ENV_EXAMPLE=%PROJECT_ROOT%\configs\%ENV_BASENAME%.env.example"
if exist "%ENV_FILE%" (
  set "SOURCE_FILE=%ENV_FILE%"
) else if exist "%ENV_EXAMPLE%" (
  set "SOURCE_FILE=%ENV_EXAMPLE%"
  echo [launcher] WARNING: uso %ENV_EXAMPLE%. Copialo in %ENV_FILE% per valori reali e segreti fuori repo.
) else (
  echo [launcher] Config non trovata: %ENV_FILE% o %ENV_EXAMPLE% 1>&2
  exit /b 1
)
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%SOURCE_FILE%") do (
  set "KEY=%%A"
  set "VALUE=%%B"
  if not "!KEY!"=="" set "!KEY!=!VALUE!"
)
if "%CASSA_RUNTIME_PROFILE%"=="" set "CASSA_RUNTIME_PROFILE=%PROFILE_NAME%"
cd /d "%PROJECT_ROOT%"
node scripts\print-runtime-profile.mjs --profile "%CASSA_RUNTIME_PROFILE%" --root "%PROJECT_ROOT%"
npm run dev:backend
