param(
  [string]$Serial = "",
  [switch]$ForceReinstall
)

$ErrorActionPreference = "Stop"
$Apk = Join-Path $PSScriptRoot "Palmare-1.0.5-debug.apk"
if (-not (Test-Path $Apk)) { throw "APK non trovato: $Apk" }
if (-not (Get-Command adb -ErrorAction SilentlyContinue)) { throw "adb non presente nel PATH" }

$Prefix = @()
if ($Serial) { $Prefix = @("-s", $Serial) }

Write-Host "Installazione fix realtime Palmare..." -ForegroundColor Cyan
& adb @Prefix install -r $Apk
if ($LASTEXITCODE -eq 0) {
  Write-Host "Installazione completata." -ForegroundColor Green
  exit 0
}

if (-not $ForceReinstall) {
  Write-Warning "L'aggiornamento potrebbe essere stato rifiutato per firma debug differente."
  Write-Warning "Rieseguire con -ForceReinstall solo dopo avere annotato URL e impostazioni locali."
  exit $LASTEXITCODE
}

Write-Warning "Disinstallazione del package: i dati locali verranno cancellati."
& adb @Prefix uninstall com.sentrapa.palmare
if ($LASTEXITCODE -ne 0) { throw "Disinstallazione fallita" }
& adb @Prefix install $Apk
if ($LASTEXITCODE -ne 0) { throw "Installazione fallita" }
Write-Host "Reinstallazione completata." -ForegroundColor Green
