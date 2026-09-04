<#
  Avvio locale Cassa V5BT su Windows (profilo hardware simulato).
  Replica start-v5bt.sh adattandolo a Windows + XAMPP MySQL.
#>
param(
  [string]$LanIp = "192.168.0.28",
  [ValidateSet("simulated","real")][string]$HardwareMode = "simulated"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot = Join-Path $Root "SORGENTE_SISTEMA"
$RuntimeDir = Join-Path $Root ".runtime\cassav5bt"
$DataDir = Join-Path $RuntimeDir "data"
$LogDir = Join-Path $RuntimeDir "logs"
$ServerLogDir = Join-Path $RuntimeDir "server-logs"
$RunDir = Join-Path $RuntimeDir "run"
$SecretsFile = Join-Path $RuntimeDir "v5bt.env"

$BackendPort = 5381
$FrontendPort = 5380
$BatteryPort = 8865
$FiscalPort = 9390
$AutomaticCashPort = 9391
$PrinterFarmPorts = "9201,9202,9203,9204"
$PrinterFarmMetricsPort = 9299

$DatabaseHost = "127.0.0.1"
$DatabasePort = 3306
$DatabaseName = "cassa_v5bt"
$DatabaseUser = "cassa_v5bt_app"

$RelationalDbPath = Join-Path $DataDir "backend-relational.sqlite"
$AppStateSplitDbPath = Join-Path $DataDir "app-state-split.sqlite"
$CertPath = Join-Path $AppRoot ("mobile-frontend\certs\{0}.pem" -f $LanIp)
$KeyPath = Join-Path $AppRoot ("mobile-frontend\certs\{0}-key.pem" -f $LanIp)

New-Item -ItemType Directory -Force -Path $DataDir, $LogDir, $ServerLogDir, $RunDir | Out-Null

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath (Join-Path $LogDir "start-windows.log") -Value $line -Encoding UTF8
  Write-Output $line
}

if (-not (Test-Path -LiteralPath $SecretsFile)) { throw "File segreti mancante: $SecretsFile" }
$secrets = @{}
foreach ($line in Get-Content -LiteralPath $SecretsFile) {
  if ($line -match '^\s*#') { continue }
  if ($line -notmatch '=') { continue }
  $k = $line.Substring(0, $line.IndexOf('=')).Trim()
  $v = $line.Substring($line.IndexOf('=') + 1).Trim()
  $secrets[$k] = $v
}
foreach ($k in @("CASSAV5BT_MYSQL_PASSWORD","CASSAV5BT_BACKEND_TOKEN_SECRET","CASSAV5BT_INTEGRATION_SERVICE_TOKEN","CASSAV5BT_SMART_CARD_PUSH_TOKEN")) {
  if (-not $secrets.ContainsKey($k)) { throw "Segreto V5BT mancante: $k" }
  if ($secrets[$k] -notmatch '^[0-9A-Fa-f]{64,128}$') { throw "Segreto V5BT non valido: $k" }
}

foreach ($p in @($RelationalDbPath, $AppStateSplitDbPath, $CertPath, $KeyPath)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "File richiesto mancante: $p" }
}

function Stop-PortListener {
  param([int]$Port)
  foreach ($listener in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    $pidValue = [int]$listener.OwningProcess
    if ($pidValue -le 0 -or $pidValue -eq $PID) { continue }
    try {
      Stop-Process -Id $pidValue -Force -ErrorAction Stop
      Write-Log ("Porta {0}: terminato pid {1}" -f $Port, $pidValue)
    } catch { }
  }
}

function Wait-Listening {
  param([int]$Port, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Wait-HttpOk {
  param([string]$Url, [int]$TimeoutSeconds = 90)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $code = & curl.exe -s -k -o NUL -w "%{http_code}" --max-time 3 $Url 2>$null
    if ($code -match '^[23]') {
      Write-Log ("Health OK ({0}): {1}" -f $code, $Url)
      return $true
    }
    Start-Sleep -Milliseconds 700
  }
  Write-Log ("Health FALLITO: {0}" -f $Url)
  return $false
}

function Start-V5btService {
  param([string]$Name, [string]$WorkingDirectory, [hashtable]$Environment, [string]$Command)
  $outLog = Join-Path $LogDir ("{0}.out.log" -f $Name)
  $errLog = Join-Path $LogDir ("{0}.err.log" -f $Name)
  $cmdPath = Join-Path $RunDir ("{0}.cmd" -f $Name)
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("@echo off")
  $lines.Add("cd /d ""$WorkingDirectory""")
  foreach ($key in ($Environment.Keys | Sort-Object)) {
    $value = [string]$Environment[$key]
    $lines.Add("set ""$key=$value""")
  }
  $lines.Add("echo [%date% %time%] avvio $Name >> ""$outLog""")
  $lines.Add("$Command >> ""$outLog"" 2>> ""$errLog""")
  Set-Content -LiteralPath $cmdPath -Value $lines -Encoding ASCII
  Write-Log ("Avvio {0}" -f $Name)
  $proc = Start-Process -FilePath $cmdPath -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath (Join-Path $RuntimeDir ("{0}.pid" -f $Name)) -Value $proc.Id -Encoding ASCII
}

Write-Log "Avvio Cassa V5BT (Windows, hardware=$HardwareMode)"

if (-not (Wait-Listening -Port $DatabasePort -TimeoutSeconds 1)) {
  Write-Log "MySQL non in ascolto: avvio XAMPP"
  Start-Process -FilePath "C:\xampp\mysql_start.bat" -WorkingDirectory "C:\xampp" -WindowStyle Hidden | Out-Null
  if (-not (Wait-Listening -Port $DatabasePort -TimeoutSeconds 90)) { throw "MySQL non disponibile sulla porta $DatabasePort." }
}

foreach ($port in @($FrontendPort, $BackendPort, $BatteryPort, $FiscalPort, $AutomaticCashPort, $PrinterFarmMetricsPort, 9201, 9202, 9203, 9204)) {
  Stop-PortListener -Port $port
}
Start-Sleep -Seconds 1

if ($HardwareMode -ne "simulated") { throw "Profilo hardware reale non supportato da questo avvio locale." }
$posFiscalBaseUrl = "http://127.0.0.1:$FiscalPort"
$automaticCashBaseUrl = "http://127.0.0.1:$AutomaticCashPort"
$automaticCashUser = "simulator"
$automaticCashPassword = "simulator"
$fiscalProvider = "mock"
$fiscalRealIoDisabled = "1"
$automaticCashRealEnabled = "0"
$automaticCashSimulatorSeed = "1"

Start-V5btService -Name "battery" -WorkingDirectory (Join-Path $AppRoot "battery-dashboard") -Environment @{
  "NODE_ENV" = "development"
  "HOST" = "0.0.0.0"
  "PORT" = "$BatteryPort"
} -Command "node server/index.js"
if (-not (Wait-HttpOk -Url "http://127.0.0.1:$BatteryPort/api/health" -TimeoutSeconds 45)) { throw "Servizio batteria non disponibile." }

Start-V5btService -Name "fiscal" -WorkingDirectory $AppRoot -Environment @{
  "NODE_ENV" = "development"
  "MOCK_FISCAL_HOST" = "127.0.0.1"
  "MOCK_FISCAL_PORT" = "$FiscalPort"
} -Command "node tools/mock-fiscal-server.mjs"
if (-not (Wait-HttpOk -Url "http://127.0.0.1:$FiscalPort/api/fiscal/status" -TimeoutSeconds 45)) { throw "Servizio fiscale simulato non disponibile." }

Start-V5btService -Name "automatic-cash" -WorkingDirectory $AppRoot -Environment @{
  "NODE_ENV" = "development"
  "FAKE_AUTOMATIC_CASH_HOST" = "127.0.0.1"
  "FAKE_AUTOMATIC_CASH_PORT" = "$AutomaticCashPort"
  "FAKE_AUTOMATIC_CASH_DEPOSIT_TOTAL_CENTS" = "2000"
  "FAKE_AUTOMATIC_CASH_STOCK_PER_DENOMINATION" = "120"
} -Command "node tools/fake-automatic-cash-gateway.mjs"
if (-not (Wait-HttpOk -Url "http://127.0.0.1:$AutomaticCashPort/api/health" -TimeoutSeconds 45)) { throw "Cassa automatica simulata non disponibile." }

Start-V5btService -Name "printer-farm" -WorkingDirectory $AppRoot -Environment @{
  "NODE_ENV" = "development"
  "MOCK_PRINTER_FARM_HOST" = "127.0.0.1"
  "MOCK_PRINTER_FARM_PORTS" = $PrinterFarmPorts
  "MOCK_PRINTER_FARM_METRICS_PORT" = "$PrinterFarmMetricsPort"
} -Command "node tools/mock-tcp-printer-farm.mjs"
if (-not (Wait-HttpOk -Url "http://127.0.0.1:$PrinterFarmMetricsPort/health" -TimeoutSeconds 45)) { throw "Stampanti simulate non disponibili." }

$backendEnv = @{
  "NODE_ENV" = "development"
  "CASSA_RUNTIME_LOG_DIR" = $ServerLogDir
  "BACKEND_HOST" = "0.0.0.0"
  "PORT" = "$BackendPort"
  "BACKEND_PORT" = "$BackendPort"
  "FRONTEND_LAN_IP" = $LanIp
  "BACKEND_DB_MODE" = "mysql"
  "BACKEND_MYSQL_HOST" = $DatabaseHost
  "BACKEND_MYSQL_PORT" = "$DatabasePort"
  "BACKEND_MYSQL_USER" = $DatabaseUser
  "BACKEND_MYSQL_PASSWORD" = $secrets["CASSAV5BT_MYSQL_PASSWORD"]
  "BACKEND_MYSQL_DATABASE" = $DatabaseName
  "BACKEND_ALLOW_EMPTY_DB_INIT" = "0"
  "BACKEND_ALLOW_MYSQL_IMPORT_JSON" = "0"
  "BACKEND_PROCESS_ROLE" = "monolith"
  "BACKEND_REALTIME_GATEWAY_ENABLED" = "0"
  "BACKEND_API_WORKER_ENABLED" = "0"
  "BACKEND_RELATIONAL_ENABLED" = "0"
  "BACKEND_RELATIONAL_MODE" = "off"
  "BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED" = "0"
  "BACKEND_RELATIONAL_DB_PATH" = $RelationalDbPath
  "BACKEND_APP_STATE_SPLIT_DB_PATH" = $AppStateSplitDbPath
  "BACKEND_APP_STATE_SPLIT_TABLE_STATES" = "externalized"
  "BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS" = "1"
  "SSE_EVENT_PAYLOAD" = "1"
  "SSE_LEGACY_REFRESH" = "0"
  "BACKEND_REALTIME_SCOPED_DELIVERY" = "1"
  "EVENT_OUTBOX_ENABLED" = "0"
  "IDEMPOTENCY_STORE_ENABLED" = "0"
  "BACKEND_MYSQL_TABLE_LOCK_NAMED_LOCKS" = "0"
  "ORDERS_ASYNC_FLUSH_MYSQL_LOCK" = "0"
  "REDIS_ENABLED" = "0"
  "MQTT_ENABLED" = "0"
  "MQTT_EVENTS_ENABLED" = "0"
  "MQTT_COMMANDS_ENABLED" = "0"
  "MQTT_STORE_ID" = "cassav5bt"
  "PRINTING_ENABLED" = "1"
  "PRINT_SPOOL_FAST_WORKER" = "1"
  "PRINT_SPOOL_SQL_PRIMARY" = "0"
  "PRINT_CIRCUIT_BREAKER" = "1"
  "PRINT_CIRCUIT_BREAKER_THRESHOLD" = "3"
  "PRINT_CIRCUIT_BREAKER_COOLDOWN_MS" = "10000"
  "PRINT_SPOOL_PRE_SEND_PROBE" = "1"
  "PRINT_TCP_TIMEOUT_MS" = "2500"
  "AUTO_PRINT_ENQUEUE_DELAY_MS" = "0"
  "LANE_PRINT" = "0"
  "PRINT_LANE_ENABLED" = "0"
  "BACKEND_FISCAL_OUTBOX_ENABLED" = "0"
  "BACKEND_FISCAL_OUTBOX_WORKER_ENABLED" = "0"
  "FISCAL_PROVIDER" = $fiscalProvider
  "POS_FISCAL_API_BASE_URL" = $posFiscalBaseUrl
  "POS_FISCAL_API_TIMEOUT_MS" = "20000"
  "FISCAL_REAL_IO_DISABLED" = $fiscalRealIoDisabled
  "POS_FISCAL_REAL_IO_DISABLED" = $fiscalRealIoDisabled
  "CARD_PAYMENT_PROVIDER" = "disabled"
  "SMART_CARD_READER_MODE" = "push"
  "SMART_CARD_AUTO_DETECT" = "0"
  "AUTOMATIC_CASH_GATEWAY_ENABLED" = "1"
  "AUTOMATIC_CASH_REAL_ENABLED" = $automaticCashRealEnabled
  "AUTOMATIC_CASH_GATEWAY_BASE_URL" = $automaticCashBaseUrl
  "AUTOMATIC_CASH_GATEWAY_USERNAME" = $automaticCashUser
  "AUTOMATIC_CASH_GATEWAY_PASSWORD" = $automaticCashPassword
  "AUTOMATIC_CASH_GATEWAY_TIMEOUT_MS" = "120000"
  "AUTOMATIC_CASH_SIMULATOR_SEED" = $automaticCashSimulatorSeed
  "BATTERY_SERVICE_URL" = "http://127.0.0.1:$BatteryPort/battery"
  "BATTERY_ORIGIN" = "http://127.0.0.1:$BatteryPort"
  "ORDERS_ASYNC_FLUSH_OWNER_URL" = "http://127.0.0.1:$BackendPort"
  "PRINT_SPOOL_LEGACY_MIRROR_OWNER_URL" = "http://127.0.0.1:$BackendPort"
  "SMART_CARD_BACKEND_URL" = "http://127.0.0.1:$BackendPort"
  "CORS_ALLOWED_ORIGINS" = "https://${LanIp}:$FrontendPort,https://127.0.0.1:$FrontendPort,https://localhost:$FrontendPort"
  "BACKEND_TOKEN_SECRET" = $secrets["CASSAV5BT_BACKEND_TOKEN_SECRET"]
  "INTEGRATION_SERVICE_TOKEN" = $secrets["CASSAV5BT_INTEGRATION_SERVICE_TOKEN"]
  "SMART_CARD_PUSH_TOKEN" = $secrets["CASSAV5BT_SMART_CARD_PUSH_TOKEN"]
  "ALLOW_AUTH_QUERY_TOKEN" = "0"
  "ALLOW_SERVICE_TOKEN_QUERY_PARAM" = "0"
  "SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS" = "15000"
  "INTEGRATION_WAITER_ACTIVE_WINDOW_MS" = "90000"
  "PAYMENT_LANE_CONCURRENCY" = "2"
  "APP_STATE_DIRTY_TRACKING_AUDIT_SAMPLE" = "1"
  "RUNTIME_METRICS" = "1"
}

Start-V5btService -Name "backend" -WorkingDirectory (Join-Path $AppRoot "cassa-frontend") -Environment $backendEnv -Command "node backend/server.js"
if (-not (Wait-HttpOk -Url "http://127.0.0.1:$BackendPort/api/health" -TimeoutSeconds 180)) { throw "Backend non disponibile: vedere $LogDir\backend.err.log" }

$frontendEnv = @{
  "NODE_ENV" = "development"
  "FRONTEND_HOST" = "0.0.0.0"
  "FRONTEND_PORT" = "$FrontendPort"
  "FRONTEND_ROOT" = $AppRoot
  "BACKEND_ORIGIN" = "http://127.0.0.1:$BackendPort"
  "BATTERY_ORIGIN" = "http://127.0.0.1:$BatteryPort"
  "FRONTEND_HTTPS" = "true"
  "FRONTEND_LAN_IP" = $LanIp
  "FRONTEND_HTTPS_CERT" = $CertPath
  "FRONTEND_HTTPS_KEY" = $KeyPath
}
Start-V5btService -Name "frontend" -WorkingDirectory $AppRoot -Environment $frontendEnv -Command "node serve-frontends.mjs"
if (-not (Wait-HttpOk -Url "https://127.0.0.1:$FrontendPort/mobile/" -TimeoutSeconds 90)) { throw "Frontend non disponibile: vedere $LogDir\frontend.err.log" }

Write-Log "Cassa V5BT avviata"
Write-Output ""
Write-Output "Palmare Advanced:    https://${LanIp}:$FrontendPort/mobile/"
Write-Output "Postazione Advanced: https://${LanIp}:$FrontendPort/postazione/"
Write-Output "Batteria:            https://${LanIp}:$FrontendPort/batteria/"
Write-Output "Backend health:      http://127.0.0.1:$BackendPort/api/health"
Write-Output "Database:            $DatabaseName ($DatabaseUser@${DatabaseHost}:$DatabasePort)"
Write-Output "Log:                 $LogDir"
