param(
    [switch]$Install,
    [string]$DeviceSerial = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$webRoot = Join-Path $root "web-frontend"
$androidRoot = Join-Path $root "android-app"
$apkSource = Join-Path $androidRoot "app\build\outputs\apk\debug\app-debug.apk"
$gradleConfig = Join-Path $androidRoot "app\build.gradle.kts"
$versionMatch = [regex]::Match((Get-Content -LiteralPath $gradleConfig -Raw), 'versionName\s*=\s*"([^"]+)"')
if (-not $versionMatch.Success) { throw "versionName non trovato in $gradleConfig" }
$apkTarget = Join-Path $root "Postazione-Advanced-$($versionMatch.Groups[1].Value)-debug.apk"

Push-Location $webRoot
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci non riuscito." }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Build frontend non riuscita." }
} finally {
    Pop-Location
}

if (-not $env:JAVA_HOME) {
    $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
}

if (-not $env:ANDROID_HOME) {
    $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk"
}
if (-not (Test-Path -LiteralPath $env:ANDROID_HOME)) {
    throw "Android SDK non trovato: $env:ANDROID_HOME"
}
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

Push-Location $androidRoot
try {
    & .\gradlew.bat testDebugUnitTest lintDebug assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Build Android non riuscita." }
} finally {
    Pop-Location
}

Copy-Item -LiteralPath $apkSource -Destination $apkTarget -Force
Write-Host "APK creato: $apkTarget"

if ($Install) {
    $adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (-not (Test-Path -LiteralPath $adb)) { throw "adb non trovato: $adb" }
    $serialArgs = if ($DeviceSerial) { @("-s", $DeviceSerial) } else { @() }
    & $adb @serialArgs install -r -g $apkTarget
    if ($LASTEXITCODE -ne 0) { throw "Installazione ADB non riuscita." }
}
