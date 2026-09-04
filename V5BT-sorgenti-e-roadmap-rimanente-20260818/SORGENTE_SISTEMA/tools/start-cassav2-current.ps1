param(
  [switch]$SkipStop,
  [switch]$SkipMobileDev
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot = Resolve-Path (Join-Path $ScriptDir "..")
$BackendRoot = Join-Path $AppRoot "cassa-frontend"
$MobileRoot = Join-Path $AppRoot "mobile-frontend"
$BatteryRoot = Join-Path $AppRoot "battery-dashboard"
$LogDir = Join-Path $AppRoot "logs"
$RunDir = Join-Path $LogDir "autostart"
$LanHttpsIp = "192.168.0.28"
$LanHttpsCert = Join-Path $MobileRoot ("certs\{0}.pem" -f $LanHttpsIp)
$LanHttpsKey = Join-Path $MobileRoot ("certs\{0}-key.pem" -f $LanHttpsIp)

New-Item -ItemType Directory -Force -Path $LogDir, $RunDir | Out-Null

$NodeCmd = "node"
$NpmCmd = "npm.cmd"

function Write-StartupLog {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath (Join-Path $LogDir "cassav2-autostart.log") -Value $line -Encoding UTF8
  Write-Output $line
}

function Stop-PortListener {
  param([int]$Port)

  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    $pidValue = [int]$listener.OwningProcess
    if ($pidValue -le 0 -or $pidValue -eq $PID) {
      continue
    }

    try {
      $process = Get-Process -Id $pidValue -ErrorAction Stop
      Write-StartupLog ("Stopping port {0} listener pid={1} name={2}" -f $Port, $pidValue, $process.ProcessName)
      Stop-Process -Id $pidValue -Force -ErrorAction Stop
    } catch {
      Write-StartupLog ("Unable to stop pid={0} on port {1}: {2}" -f $pidValue, $Port, $_.Exception.Message)
    }
  }
}

function Wait-PortFree {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $busy = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
    if (-not $busy) {
      return $true
    }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Wait-PortListening {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
    if ($listening) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Ensure-LocalMySql {
  $mysqlPort = 3306
  if (Wait-PortListening -Port $mysqlPort -TimeoutSeconds 1) {
    Write-StartupLog "MySQL port 3306 already listening"
    return
  }

  $xamppStart = "C:\xampp\mysql_start.bat"
  if (-not (Test-Path -LiteralPath $xamppStart)) {
    throw "MySQL is not listening on port 3306 and XAMPP startup script was not found at $xamppStart."
  }

  Write-StartupLog "MySQL port 3306 is not listening; starting XAMPP MySQL"
  Start-Process -FilePath $xamppStart -WorkingDirectory "C:\xampp" -WindowStyle Hidden | Out-Null

  if (-not (Wait-PortListening -Port $mysqlPort -TimeoutSeconds 90)) {
    throw "MySQL did not start listening on port 3306 within timeout."
  }

  Write-StartupLog "MySQL port 3306 is listening"
}

function New-LaunchCmd {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][hashtable]$Environment,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$OutLog,
    [Parameter(Mandatory = $true)][string]$ErrLog
  )

  $cmdPath = Join-Path $RunDir ("{0}.cmd" -f $Name)
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("@echo off")
  $lines.Add("cd /d ""$WorkingDirectory""")
  foreach ($key in ($Environment.Keys | Sort-Object)) {
    $value = [string]$Environment[$key]
    $lines.Add("set ""$key=$value""")
  }
  $lines.Add("echo [%date% %time%] starting $Name >> ""$OutLog""")
  $lines.Add("$Command >> ""$OutLog"" 2>> ""$ErrLog""")
  Set-Content -LiteralPath $cmdPath -Value $lines -Encoding ASCII
  return $cmdPath
}

function Start-HiddenProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$CmdPath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  Write-StartupLog ("Starting {0} with {1}" -f $Name, $CmdPath)
  Start-Process -FilePath $CmdPath -WorkingDirectory $WorkingDirectory -WindowStyle Hidden | Out-Null
}

function Wait-HttpOk {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
      if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400) {
        Write-StartupLog ("Health OK: {0}" -f $Url)
        return $true
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  Write-StartupLog ("Health FAILED: {0}" -f $Url)
  return $false
}

Write-StartupLog "cassav2 current startup requested"
Write-StartupLog ("AppRoot={0}" -f $AppRoot)

if (-not $SkipStop) {
  foreach ($port in @(5173, 5280, 5281, 8765)) {
    Stop-PortListener -Port $port
  }
  foreach ($port in @(5173, 5280, 5281, 8765)) {
    if (-not (Wait-PortFree -Port $port -TimeoutSeconds 20)) {
      throw "Port $port is still busy after stop."
    }
  }
}

Ensure-LocalMySql

$backendEnv = @{
  "NODE_ENV" = "development"
  "BACKEND_HOST" = "0.0.0.0"
  "PORT" = "5281"
  "PRINTING_ENABLED" = "1"
  "PRINT_SPOOL_FAST_WORKER" = "1"
  "BACKEND_DB_MODE" = "mysql"
  "BACKEND_MYSQL_HOST" = "127.0.0.1"
  "BACKEND_MYSQL_PORT" = "3306"
  "BACKEND_MYSQL_USER" = "cassa_app"
  "BACKEND_MYSQL_PASSWORD" = "amalia2026"
  "BACKEND_MYSQL_DATABASE" = "cassa"
  "BACKEND_MYSQL_SPLIT_SESSIONS" = "1"
  "BACKEND_MYSQL_SESSIONS_TABLE" = "app_state_sessions"
  "BACKEND_MYSQL_SPLIT_AUDIT_EVENTS" = "1"
  "BACKEND_MYSQL_AUDIT_EVENTS_TABLE" = "app_state_audit_events"
  "BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS" = "1"
  "BACKEND_MYSQL_APP_STATE_DOMAINS_TABLE" = "app_state_domain_records"
  "BACKEND_ALLOW_EMPTY_DB_INIT" = "1"
  "BACKEND_ALLOW_MYSQL_IMPORT_JSON" = "1"
  "BACKEND_DB_IMPORT_JSON_PATH" = (Join-Path $BackendRoot "backend\app-state.json")
  "BATTERY_SERVICE_URL" = "http://127.0.0.1:8765/battery"
  "BATTERY_SERVICE_TIMEOUT_MS" = "2500"
  "BATTERY_PROXY_CACHE_MS" = "750"
  "RUNTIME_METRICS" = "1"
  "SSE_EVENT_PAYLOAD" = "1"
  "SSE_LEGACY_REFRESH" = "0"
  "BACKEND_REALTIME_SCOPED_DELIVERY" = "1"
  "BACKEND_REALTIME_HEARTBEAT_MS" = "5000"
  "BACKEND_REALTIME_BOOTSTRAP_PADDING_BYTES" = "2048"
  "BACKEND_NOTIFICATION_PUNCTUAL_WRITER" = "1"
}

$frontendEnv = @{
  "FRONTEND_HOST" = "0.0.0.0"
  "FRONTEND_PORT" = "5280"
  "BACKEND_ORIGIN" = "http://127.0.0.1:5281"
  "FRONTEND_ROOT" = $AppRoot
  "FRONTEND_HTTPS" = "true"
  "FRONTEND_LAN_IP" = $LanHttpsIp
  "FRONTEND_HTTPS_CERT" = $LanHttpsCert
  "FRONTEND_HTTPS_KEY" = $LanHttpsKey
}

$mobileEnv = @{
  "VITE_API_PROXY_TARGET" = "http://127.0.0.1:5281"
  "API_PROXY_TARGET" = "http://127.0.0.1:5281"
}

$batteryEnv = @{
  "HOST" = "0.0.0.0"
  "PORT" = "8765"
  "OFFLINE_AFTER_SECONDS" = "180"
  "REMOVE_AFTER_SECONDS" = "300"
}

$batteryCmd = New-LaunchCmd `
  -Name "cassav2-battery-dashboard" `
  -WorkingDirectory $BatteryRoot `
  -Environment $batteryEnv `
  -Command "$NpmCmd run start" `
  -OutLog (Join-Path $LogDir "battery-dashboard-current-windows.out.log") `
  -ErrLog (Join-Path $LogDir "battery-dashboard-current-windows.err.log")

$backendCmd = New-LaunchCmd `
  -Name "cassav2-backend" `
  -WorkingDirectory $BackendRoot `
  -Environment $backendEnv `
  -Command "$NodeCmd backend/server.js" `
  -OutLog (Join-Path $LogDir "backend-mysql-current-windows.out.log") `
  -ErrLog (Join-Path $LogDir "backend-mysql-current-windows.err.log")

$frontendsCmd = New-LaunchCmd `
  -Name "cassav2-frontends" `
  -WorkingDirectory $AppRoot `
  -Environment $frontendEnv `
  -Command "$NodeCmd serve-frontends.mjs" `
  -OutLog (Join-Path $LogDir "frontends-current-windows.out.log") `
  -ErrLog (Join-Path $LogDir "frontends-current-windows.err.log")

Start-HiddenProcess -Name "battery-dashboard" -CmdPath $batteryCmd -WorkingDirectory $BatteryRoot
if (-not (Wait-HttpOk -Url "http://127.0.0.1:8765/battery" -TimeoutSeconds 30)) {
  throw "Battery dashboard health check failed."
}

Start-HiddenProcess -Name "backend" -CmdPath $backendCmd -WorkingDirectory $BackendRoot
if (-not (Wait-HttpOk -Url "http://127.0.0.1:5281/api/health" -TimeoutSeconds 90)) {
  throw "Backend health check failed."
}

Start-HiddenProcess -Name "frontends" -CmdPath $frontendsCmd -WorkingDirectory $AppRoot
if (-not (Wait-HttpOk -Url "https://127.0.0.1:5280/mobile/" -TimeoutSeconds 60)) {
  throw "Frontend health check failed."
}

if (-not $SkipMobileDev) {
  $mobileCmd = New-LaunchCmd `
    -Name "cassav2-mobile-vite" `
    -WorkingDirectory $MobileRoot `
    -Environment $mobileEnv `
    -Command "$NpmCmd run dev -- --host 0.0.0.0" `
    -OutLog (Join-Path $LogDir "mobile-vite-current-windows.out.log") `
    -ErrLog (Join-Path $LogDir "mobile-vite-current-windows.err.log")

  Start-HiddenProcess -Name "mobile-vite" -CmdPath $mobileCmd -WorkingDirectory $MobileRoot
  if (-not (Wait-HttpOk -Url "http://127.0.0.1:5173/mobile/" -TimeoutSeconds 60)) {
    throw "Mobile Vite health check failed."
  }
}

Write-StartupLog "cassav2 current startup completed"
