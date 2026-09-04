#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$ROOT/SORGENTE_SISTEMA"
source "$ROOT/tools/v5bt-node-runtime.sh"
NODE_BIN="$(resolve_v5bt_node_bin "$ROOT")"
RUNTIME_DIR="$ROOT/.runtime/cassav5bt"
DATA_DIR="$RUNTIME_DIR/data"
LOG_DIR="$RUNTIME_DIR/logs"
SERVER_LOG_DIR="$RUNTIME_DIR/server-logs"
SECRETS_FILE="$RUNTIME_DIR/v5bt.env"
HARDWARE_FILE="$RUNTIME_DIR/hardware.env"

BACKEND_PORT="${CASSAV5BT_BACKEND_PORT:-5381}"
FRONTEND_PORT="${CASSAV5BT_FRONTEND_PORT:-5380}"
REALTIME_PORT="${CASSAV5BT_REALTIME_PORT:-5382}"
API_WORKER_PORT="${CASSAV5BT_API_WORKER_PORT:-5383}"
BATTERY_PORT="${CASSAV5BT_BATTERY_PORT:-8865}"
FISCAL_PORT="${CASSAV5BT_FISCAL_PORT:-9390}"
AUTOMATIC_CASH_PORT="${CASSAV5BT_AUTOMATIC_CASH_PORT:-9391}"
PRINTER_FARM_PORTS="${CASSAV5BT_PRINTER_FARM_PORTS:-9201,9202,9203,9204}"
PRINTER_FARM_METRICS_PORT="${CASSAV5BT_PRINTER_FARM_METRICS_PORT:-9299}"
PRINTER_FARM_ENABLED="${CASSAV5BT_PRINTER_FARM:-0}"
HARDWARE_MODE="${CASSAV5BT_HARDWARE_MODE:-real}"
DATABASE_HOST="127.0.0.1"
DATABASE_PORT="3306"
DATABASE_NAME="cassa_v5bt"
DATABASE_USER="cassa_v5bt_app"
LAN_IP="${CASSAV5BT_LAN_IP:-192.168.0.67}"
PRODUCTION_SEED_SHA256="9c1bcdd6095c669440a524987dc173874edd6186f64571eb98788f957ec613f8"

RELATIONAL_DB_PATH="$DATA_DIR/backend-relational.sqlite"
APP_STATE_SPLIT_DB_PATH="$DATA_DIR/app-state-split.sqlite"

case "$HARDWARE_MODE" in
  real|simulated) ;;
  *)
    echo "Modalita hardware V5BT non valida: '$HARDWARE_MODE' (real|simulated)." >&2
    exit 1
    ;;
esac

mkdir -p "$DATA_DIR" "$LOG_DIR" "$SERVER_LOG_DIR"
chmod 700 "$RUNTIME_DIR" "$DATA_DIR" "$LOG_DIR" "$SERVER_LOG_DIR"

for command_name in bash curl flock grep mysql readlink ss stat; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Comando richiesto non trovato: $command_name" >&2
    exit 1
  fi
done

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Runtime Node V5BT non trovato: $NODE_BIN" >&2
  exit 1
fi

case "${DATABASE_NAME,,}" in
  cassa|cassav4)
    echo "Avvio bloccato: '$DATABASE_NAME' appartiene a un'installazione precedente." >&2
    exit 1
    ;;
esac

for value in "$DATABASE_NAME" "$DATABASE_USER"; do
  if [[ ! "$value" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "Identificatore MySQL V5BT non valido: '$value'." >&2
    exit 1
  fi
done

if [[ ! "$LAN_IP" =~ ^[A-Za-z0-9.:-]+$ ]]; then
  echo "Host HTTPS V5BT non valido: '$LAN_IP'." >&2
  exit 1
fi

for port in \
  "$BACKEND_PORT" "$FRONTEND_PORT" "$REALTIME_PORT" "$API_WORKER_PORT" \
  "$BATTERY_PORT" "$FISCAL_PORT" "$AUTOMATIC_CASH_PORT" "$DATABASE_PORT"; do
  if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    echo "Porta V5BT non valida: '$port'." >&2
    exit 1
  fi
done

FILE_DATABASE_PASSWORD=""
FILE_BACKEND_TOKEN_SECRET=""
FILE_INTEGRATION_SERVICE_TOKEN=""
FILE_SMART_CARD_PUSH_TOKEN=""

load_secrets_file() {
  local mode owner line key value
  [[ -f "$SECRETS_FILE" ]] || return 0
  mode="$(stat -c '%a' "$SECRETS_FILE")"
  owner="$(stat -c '%u' "$SECRETS_FILE")"
  if [[ "$mode" != "600" || "$owner" != "$(id -u)" ]]; then
    echo "Permessi non sicuri per $SECRETS_FILE: richiesti proprietario corrente e 0600." >&2
    exit 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      echo "Riga non valida nel file segreti V5BT." >&2
      exit 1
    fi
    key="${line%%=*}"
    value="${line#*=}"
    if [[ ! "$value" =~ ^[0-9A-Fa-f]{64,128}$ ]]; then
      echo "Valore segreto V5BT non valido per '$key'." >&2
      exit 1
    fi
    case "$key" in
      CASSAV5BT_MYSQL_PASSWORD) FILE_DATABASE_PASSWORD="$value" ;;
      CASSAV5BT_BACKEND_TOKEN_SECRET) FILE_BACKEND_TOKEN_SECRET="$value" ;;
      CASSAV5BT_INTEGRATION_SERVICE_TOKEN) FILE_INTEGRATION_SERVICE_TOKEN="$value" ;;
      CASSAV5BT_SMART_CARD_PUSH_TOKEN) FILE_SMART_CARD_PUSH_TOKEN="$value" ;;
      *)
        echo "Chiave non prevista nel file segreti V5BT: '$key'." >&2
        exit 1
        ;;
    esac
  done <"$SECRETS_FILE"
}

load_secrets_file

DATABASE_PASSWORD="${CASSAV5BT_MYSQL_PASSWORD:-$FILE_DATABASE_PASSWORD}"
BACKEND_TOKEN_SECRET="${CASSAV5BT_BACKEND_TOKEN_SECRET:-$FILE_BACKEND_TOKEN_SECRET}"
INTEGRATION_SERVICE_TOKEN="${CASSAV5BT_INTEGRATION_SERVICE_TOKEN:-$FILE_INTEGRATION_SERVICE_TOKEN}"
SMART_CARD_PUSH_TOKEN="${CASSAV5BT_SMART_CARD_PUSH_TOKEN:-$FILE_SMART_CARD_PUSH_TOKEN}"

for secret_name in \
  DATABASE_PASSWORD BACKEND_TOKEN_SECRET INTEGRATION_SERVICE_TOKEN SMART_CARD_PUSH_TOKEN; do
  secret_value="${!secret_name}"
  if [[ ! "$secret_value" =~ ^[0-9A-Fa-f]{64,128}$ ]]; then
    echo "Segreti V5BT mancanti o non validi. Esegui database/provision-cassa-v5bt.sh." >&2
    exit 1
  fi
done

FILE_POS_FISCAL_API_BASE_URL=""
FILE_AUTOMATIC_CASH_GATEWAY_BASE_URL=""
FILE_AUTOMATIC_CASH_GATEWAY_USERNAME=""
FILE_AUTOMATIC_CASH_GATEWAY_PASSWORD=""

load_hardware_file() {
  local mode owner line key value
  [[ "$HARDWARE_MODE" == "real" ]] || return 0
  if [[ ! -f "$HARDWARE_FILE" ]]; then
    echo "Configurazione hardware reale V5BT mancante: $HARDWARE_FILE" >&2
    exit 1
  fi
  mode="$(stat -c '%a' "$HARDWARE_FILE")"
  owner="$(stat -c '%u' "$HARDWARE_FILE")"
  if [[ "$mode" != "600" || "$owner" != "$(id -u)" ]]; then
    echo "Permessi non sicuri per $HARDWARE_FILE: richiesti proprietario corrente e 0600." >&2
    exit 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      echo "Riga non valida nel file hardware V5BT." >&2
      exit 1
    fi
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      CASSAV5BT_POS_FISCAL_API_BASE_URL)
        FILE_POS_FISCAL_API_BASE_URL="$value"
        ;;
      CASSAV5BT_AUTOMATIC_CASH_GATEWAY_BASE_URL)
        FILE_AUTOMATIC_CASH_GATEWAY_BASE_URL="$value"
        ;;
      CASSAV5BT_AUTOMATIC_CASH_GATEWAY_USERNAME)
        FILE_AUTOMATIC_CASH_GATEWAY_USERNAME="$value"
        ;;
      CASSAV5BT_AUTOMATIC_CASH_GATEWAY_PASSWORD)
        FILE_AUTOMATIC_CASH_GATEWAY_PASSWORD="$value"
        ;;
      *)
        echo "Chiave non prevista nel file hardware V5BT: '$key'." >&2
        exit 1
        ;;
    esac
  done <"$HARDWARE_FILE"
}

load_hardware_file

if [[ "$HARDWARE_MODE" == "real" ]]; then
  POS_FISCAL_API_BASE_URL="${CASSAV5BT_POS_FISCAL_API_BASE_URL:-$FILE_POS_FISCAL_API_BASE_URL}"
  AUTOMATIC_CASH_GATEWAY_BASE_URL="${CASSAV5BT_AUTOMATIC_CASH_GATEWAY_BASE_URL:-$FILE_AUTOMATIC_CASH_GATEWAY_BASE_URL}"
  AUTOMATIC_CASH_GATEWAY_USERNAME="${CASSAV5BT_AUTOMATIC_CASH_GATEWAY_USERNAME:-$FILE_AUTOMATIC_CASH_GATEWAY_USERNAME}"
  AUTOMATIC_CASH_GATEWAY_PASSWORD="${CASSAV5BT_AUTOMATIC_CASH_GATEWAY_PASSWORD:-$FILE_AUTOMATIC_CASH_GATEWAY_PASSWORD}"

  for setting_name in \
    POS_FISCAL_API_BASE_URL \
    AUTOMATIC_CASH_GATEWAY_BASE_URL \
    AUTOMATIC_CASH_GATEWAY_USERNAME \
    AUTOMATIC_CASH_GATEWAY_PASSWORD; do
    if [[ -z "${!setting_name}" ]]; then
      echo "Configurazione hardware reale V5BT incompleta: $setting_name." >&2
      exit 1
    fi
  done
  for endpoint in "$POS_FISCAL_API_BASE_URL" "$AUTOMATIC_CASH_GATEWAY_BASE_URL"; do
    if [[ ! "$endpoint" =~ ^https?://[^[:space:]]+$ ]]; then
      echo "Endpoint hardware V5BT non valido: '$endpoint'." >&2
      exit 1
    fi
    if [[ "$endpoint" =~ ^https?://(127\.0\.0\.1|localhost)(:|/) ]]; then
      echo "Endpoint loopback vietato nel profilo hardware reale: '$endpoint'." >&2
      exit 1
    fi
  done
  PRINTING_ENABLED_VALUE=1
  FISCAL_PROVIDER_VALUE=pos-fiscal-api
  FISCAL_REAL_IO_DISABLED_VALUE=0
  AUTOMATIC_CASH_REAL_ENABLED_VALUE=1
  AUTOMATIC_CASH_SIMULATOR_SEED_VALUE=0
else
  POS_FISCAL_API_BASE_URL="http://127.0.0.1:${FISCAL_PORT}"
  AUTOMATIC_CASH_GATEWAY_BASE_URL="http://127.0.0.1:${AUTOMATIC_CASH_PORT}"
  AUTOMATIC_CASH_GATEWAY_USERNAME=simulator
  AUTOMATIC_CASH_GATEWAY_PASSWORD=simulator
  PRINTING_ENABLED_VALUE=1
  FISCAL_PROVIDER_VALUE=mock
  FISCAL_REAL_IO_DISABLED_VALUE=1
  AUTOMATIC_CASH_REAL_ENABLED_VALUE=0
  AUTOMATIC_CASH_SIMULATOR_SEED_VALUE=1
fi

MYSQL_APP=(
  env "MYSQL_PWD=$DATABASE_PASSWORD"
  mysql --no-defaults --protocol=TCP
  -h "$DATABASE_HOST"
  -P "$DATABASE_PORT"
  -u "$DATABASE_USER"
  -N -B
  "$DATABASE_NAME"
)

marker_hash="$("${MYSQL_APP[@]}" -e \
  "SELECT source_sha256 FROM cassav5bt_provisioning_marker WHERE id=1" 2>/dev/null || true)"
if [[ "$marker_hash" != "$PRODUCTION_SEED_SHA256" ]]; then
  echo "Avvio bloccato: schema '$DATABASE_NAME' assente, incompleto o non certificato." >&2
  echo "Esegui database/provision-cassa-v5bt.sh prima dell'avvio." >&2
  exit 1
fi

production_table_count="$("${MYSQL_APP[@]}" -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' AND table_name<>'cassav5bt_provisioning_marker'")"
if [[ "$production_table_count" != "480" ]]; then
  echo "Avvio bloccato: attese 480 tabelle importate, trovate $production_table_count." >&2
  exit 1
fi

for sqlite_path in "$RELATIONAL_DB_PATH" "$APP_STATE_SPLIT_DB_PATH"; do
  if [[ ! -f "$sqlite_path" ]]; then
    echo "Avvio bloccato: copia SQLite V5BT mancante: $sqlite_path" >&2
    exit 1
  fi
  if [[ "$(stat -c '%a' "$sqlite_path")" != "600" ||
        "$(stat -c '%u' "$sqlite_path")" != "$(id -u)" ]]; then
    echo "Avvio bloccato: permessi SQLite V5BT non sicuri: $sqlite_path" >&2
    exit 1
  fi
done

verify_sqlite_runtime() {
  local file_path="$1"
  if ! "$NODE_BIN" --no-warnings \
    "$ROOT/tools/v5bt-sqlite-quick-check.mjs" "$file_path"; then
    echo "Avvio bloccato: quick_check SQLite V5BT fallito: $file_path" >&2
    exit 1
  fi
}

verify_sqlite_runtime "$RELATIONAL_DB_PATH"
verify_sqlite_runtime "$APP_STATE_SPLIT_DB_PATH"

CERT_PATH="$APP_ROOT/mobile-frontend/certs/${LAN_IP}.pem"
KEY_PATH="$APP_ROOT/mobile-frontend/certs/${LAN_IP}-key.pem"
if [[ ! -f "$CERT_PATH" || ! -f "$KEY_PATH" ]]; then
  echo "Certificato HTTPS V5BT mancante per $LAN_IP." >&2
  exit 1
fi

if [[ "${CASSAV5BT_PREFLIGHT_ONLY:-0}" == "1" ]]; then
  echo "Preflight Cassa V5BT superato: database, SQLite, segreti e TLS pronti."
  exit 0
fi

exec 9>"$RUNTIME_DIR/lifecycle.lock"
if ! flock -n 9; then
  echo "Un'altra operazione di avvio/arresto V5BT e in corso." >&2
  exit 1
fi

CASSAV5BT_LOCK_HELD=1 CASSAV5BT_RUNTIME_DIR="$RUNTIME_DIR" \
  bash "$ROOT/stop-v5bt.sh" >/dev/null

port_is_busy() {
  local port="$1"
  ss -ltnH "sport = :$port" 2>/dev/null | grep -q .
}

reserved_ports=(
  "$BACKEND_PORT" "$FRONTEND_PORT" "$REALTIME_PORT" "$API_WORKER_PORT"
  "$BATTERY_PORT"
)
if [[ "$HARDWARE_MODE" == "simulated" ]]; then
  reserved_ports+=("$FISCAL_PORT" "$AUTOMATIC_CASH_PORT")
fi
for port in "${reserved_ports[@]}"; do
  if port_is_busy "$port"; then
    echo "Porta riservata V5BT gia occupata: $port" >&2
    exit 1
  fi
done

START_COMPLETE=0
STARTED_ANY=0
rollback_partial_start() {
  local status=$?
  trap - EXIT
  if [[ "$START_COMPLETE" == "0" && "$STARTED_ANY" == "1" ]]; then
    echo "Avvio V5BT incompleto: arresto dei soli processi V5BT registrati." >&2
    CASSAV5BT_LOCK_HELD=1 CASSAV5BT_RUNTIME_DIR="$RUNTIME_DIR" \
      bash "$ROOT/stop-v5bt.sh" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap rollback_partial_start EXIT

COMMON_HOME="${HOME:-$ROOT}"
COMMON_PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"
COMMON_LANG="${LANG:-C.UTF-8}"

(
  cd "$APP_ROOT/battery-dashboard"
  nohup setsid env -i \
    HOME="$COMMON_HOME" PATH="$COMMON_PATH" LANG="$COMMON_LANG" \
    NODE_ENV=development HOST=0.0.0.0 PORT="$BATTERY_PORT" \
    "$NODE_BIN" server/index.js 9>&- </dev/null >>"$LOG_DIR/battery.log" 2>&1 &
  echo $! >"$RUNTIME_DIR/battery.pid"
)
STARTED_ANY=1

wait_url() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      echo "$label OK: $url"
      return 0
    fi
    sleep 0.5
  done
  echo "$label non disponibile: $url" >&2
  return 1
}

wait_url "http://127.0.0.1:${BATTERY_PORT}/api/health" "Batteria V5BT"

if [[ "$HARDWARE_MODE" == "simulated" ]]; then
  (
    cd "$APP_ROOT"
    nohup setsid env -i \
      HOME="$COMMON_HOME" PATH="$COMMON_PATH" LANG="$COMMON_LANG" \
      NODE_ENV=development MOCK_FISCAL_HOST=127.0.0.1 MOCK_FISCAL_PORT="$FISCAL_PORT" \
      "$NODE_BIN" tools/mock-fiscal-server.mjs \
      9>&- </dev/null >>"$LOG_DIR/fiscal.log" 2>&1 &
    echo $! >"$RUNTIME_DIR/fiscal.pid"
  )
  wait_url "http://127.0.0.1:${FISCAL_PORT}/api/fiscal/status" "Fiscale simulato V5BT"

  (
    cd "$APP_ROOT"
    nohup setsid env -i \
      HOME="$COMMON_HOME" PATH="$COMMON_PATH" LANG="$COMMON_LANG" \
      NODE_ENV=development \
      FAKE_AUTOMATIC_CASH_HOST=127.0.0.1 \
      FAKE_AUTOMATIC_CASH_PORT="$AUTOMATIC_CASH_PORT" \
      FAKE_AUTOMATIC_CASH_DEPOSIT_TOTAL_CENTS=2000 \
      FAKE_AUTOMATIC_CASH_STOCK_PER_DENOMINATION=120 \
      "$NODE_BIN" tools/fake-automatic-cash-gateway.mjs \
      9>&- </dev/null >>"$LOG_DIR/automatic-cash.log" 2>&1 &
    echo $! >"$RUNTIME_DIR/automatic-cash.pid"
  )
  wait_url "http://127.0.0.1:${AUTOMATIC_CASH_PORT}/api/health" "Cassa automatica simulata V5BT"

  :
fi

if [[ "$HARDWARE_MODE" == "simulated" || "$PRINTER_FARM_ENABLED" == "1" ]]; then
  # Stampanti TCP fittizie: accettano le connessioni sulle porte di loopback e contano i
  # byte, cosi il percorso di stampa resta esercitato senza toccare hardware reale.
  (
    cd "$APP_ROOT"
    nohup setsid env -i \
      HOME="$COMMON_HOME" PATH="$COMMON_PATH" LANG="$COMMON_LANG" \
      NODE_ENV=development \
      MOCK_PRINTER_FARM_HOST=127.0.0.1 \
      MOCK_PRINTER_FARM_PORTS="$PRINTER_FARM_PORTS" \
      MOCK_PRINTER_FARM_METRICS_PORT="$PRINTER_FARM_METRICS_PORT" \
      "$NODE_BIN" tools/mock-tcp-printer-farm.mjs \
      9>&- </dev/null >>"$LOG_DIR/printer-farm.log" 2>&1 &
    echo $! >"$RUNTIME_DIR/printer-farm.pid"
  )
  wait_url "http://127.0.0.1:${PRINTER_FARM_METRICS_PORT}/health" "Stampanti simulate V5BT"
fi

env -i \
  HOME="$COMMON_HOME" \
  PATH="$COMMON_PATH" \
  LANG="$COMMON_LANG" \
  NODE_BIN="$NODE_BIN" \
  CASSA_RUNTIME_LOG_DIR="$SERVER_LOG_DIR" \
  FRONTEND_LAN_IP="$LAN_IP" \
  BACKEND_PORT="$BACKEND_PORT" \
  FRONTEND_PORT="$FRONTEND_PORT" \
  BACKEND_REALTIME_PORT="$REALTIME_PORT" \
  BACKEND_API_WORKER_PORT="$API_WORKER_PORT" \
  BACKEND_API_WORKER_PORTS= \
  BACKEND_RESTART_DRY_RUN=0 \
  BACKEND_DB_MODE=mysql \
  BACKEND_MYSQL_HOST="$DATABASE_HOST" \
  BACKEND_MYSQL_PORT="$DATABASE_PORT" \
  BACKEND_MYSQL_USER="$DATABASE_USER" \
  BACKEND_MYSQL_PASSWORD="$DATABASE_PASSWORD" \
  BACKEND_MYSQL_DATABASE="$DATABASE_NAME" \
  BACKEND_ALLOW_EMPTY_DB_INIT=0 \
  BACKEND_ALLOW_MYSQL_IMPORT_JSON=0 \
  BACKEND_DB_IMPORT_JSON_PATH= \
  BACKEND_PROCESS_ROLE=monolith \
  BACKEND_REALTIME_GATEWAY_ENABLED=0 \
  BACKEND_API_WORKER_ENABLED=0 \
  BACKEND_REALTIME_ORIGIN= \
  BACKEND_API_WORKER_ORIGIN= \
  BACKEND_READ_ORIGIN= \
  BACKEND_TABLE_LOCK_WORKER_ORIGIN= \
  BACKEND_RUNTIME_METRICS_PEER_URLS= \
  BACKEND_RELATIONAL_ENABLED="${CASSAV5BT_RELATIONAL_ENABLED:-0}" \
  BACKEND_RELATIONAL_MODE="${CASSAV5BT_RELATIONAL_MODE:-off}" \
  BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED="${CASSAV5BT_RELATIONAL_SHADOW_SYNC:-0}" \
  BACKEND_RELATIONAL_DB_PATH="$RELATIONAL_DB_PATH" \
  BACKEND_APP_STATE_SPLIT_DB_PATH="$APP_STATE_SPLIT_DB_PATH" \
  BACKEND_APP_STATE_SPLIT_TABLE_STATES=externalized \
  BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS=1 \
  SSE_EVENT_PAYLOAD=1 \
  SSE_LEGACY_REFRESH=0 \
  BACKEND_REALTIME_SCOPED_DELIVERY=1 \
  EVENT_OUTBOX_ENABLED=0 \
  IDEMPOTENCY_STORE_ENABLED=0 \
  BACKEND_MYSQL_TABLE_LOCK_NAMED_LOCKS=0 \
  ORDERS_ASYNC_FLUSH_MYSQL_LOCK=0 \
  ORDERS_ASYNC_FLUSH_MYSQL_LOCK_NAME=cassav5bt:orders:async-flush \
  REDIS_ENABLED=0 \
  REDIS_URL= \
  REDIS_KEY_PREFIX=cassav5bt \
  MQTT_ENABLED=0 \
  MQTT_EVENTS_ENABLED=0 \
  MQTT_COMMANDS_ENABLED=0 \
  MQTT_STORE_ID=cassav5bt \
  PRINTING_ENABLED="$PRINTING_ENABLED_VALUE" \
  PRINT_SPOOL_FAST_WORKER=1 \
  PRINT_SPOOL_SQL_PRIMARY=0 \
  PRINT_CIRCUIT_BREAKER=1 \
  PRINT_CIRCUIT_BREAKER_THRESHOLD=3 \
  PRINT_CIRCUIT_BREAKER_COOLDOWN_MS=10000 \
  PRINT_SPOOL_PRE_SEND_PROBE=1 \
  PRINT_TCP_TIMEOUT_MS=2500 \
  AUTO_PRINT_ENQUEUE_DELAY_MS=0 \
  LANE_PRINT=0 \
  PRINT_LANE_ENABLED=0 \
  BACKEND_FISCAL_OUTBOX_ENABLED=0 \
  BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=0 \
  FISCAL_PROVIDER="$FISCAL_PROVIDER_VALUE" \
  POS_FISCAL_API_BASE_URL="$POS_FISCAL_API_BASE_URL" \
  POS_FISCAL_API_TIMEOUT_MS=20000 \
  FISCAL_REAL_IO_DISABLED="$FISCAL_REAL_IO_DISABLED_VALUE" \
  POS_FISCAL_REAL_IO_DISABLED="$FISCAL_REAL_IO_DISABLED_VALUE" \
  CARD_PAYMENT_PROVIDER=disabled \
  SMART_CARD_READER_MODE=push \
  SMART_CARD_AUTO_DETECT=0 \
  AUTOMATIC_CASH_GATEWAY_ENABLED=1 \
  AUTOMATIC_CASH_REAL_ENABLED="$AUTOMATIC_CASH_REAL_ENABLED_VALUE" \
  AUTOMATIC_CASH_GATEWAY_BASE_URL="$AUTOMATIC_CASH_GATEWAY_BASE_URL" \
  AUTOMATIC_CASH_GATEWAY_USERNAME="$AUTOMATIC_CASH_GATEWAY_USERNAME" \
  AUTOMATIC_CASH_GATEWAY_PASSWORD="$AUTOMATIC_CASH_GATEWAY_PASSWORD" \
  AUTOMATIC_CASH_GATEWAY_TIMEOUT_MS=120000 \
  AUTOMATIC_CASH_SIMULATOR_SEED="$AUTOMATIC_CASH_SIMULATOR_SEED_VALUE" \
  BATTERY_SERVICE_URL="http://127.0.0.1:${BATTERY_PORT}/battery" \
  BATTERY_ORIGIN="http://127.0.0.1:${BATTERY_PORT}" \
  ORDERS_ASYNC_FLUSH_OWNER_URL="http://127.0.0.1:${BACKEND_PORT}" \
  PRINT_SPOOL_LEGACY_MIRROR_OWNER_URL="http://127.0.0.1:${BACKEND_PORT}" \
  SMART_CARD_BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}" \
  CORS_ALLOWED_ORIGINS="https://${LAN_IP}:${FRONTEND_PORT},https://127.0.0.1:${FRONTEND_PORT},https://localhost:${FRONTEND_PORT}" \
  BACKEND_TOKEN_SECRET="$BACKEND_TOKEN_SECRET" \
  INTEGRATION_SERVICE_TOKEN="$INTEGRATION_SERVICE_TOKEN" \
  SMART_CARD_PUSH_TOKEN="$SMART_CARD_PUSH_TOKEN" \
  ALLOW_AUTH_QUERY_TOKEN=0 \
  ALLOW_SERVICE_TOKEN_QUERY_PARAM=0 \
  SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS=15000 \
  INTEGRATION_WAITER_ACTIVE_WINDOW_MS=90000 \
  PAYMENT_LANE_CONCURRENCY="${CASSAV5BT_PAYMENT_LANE_CONCURRENCY:-2}" \
  APP_STATE_DIRTY_TRACKING_AUDIT_SAMPLE="${CASSAV5BT_APP_STATE_AUDIT_SAMPLE:-1}" \
  bash "$APP_ROOT/tools/restart-v5bt-linux.sh" 9>&-

START_COMPLETE=1
trap - EXIT

echo "Cassa V5BT avviata:"
echo "- Palmare Advanced:    https://${LAN_IP}:${FRONTEND_PORT}/mobile/"
echo "- Postazione Advanced: https://${LAN_IP}:${FRONTEND_PORT}/postazione/"
echo "- Backend:             http://127.0.0.1:${BACKEND_PORT}/api/health"
echo "- Database:            $DATABASE_NAME"
echo "- Hardware:            $HARDWARE_MODE"
