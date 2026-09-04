#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  printf 'run-p4-load100-raspberry.sh deve essere eseguito come root.\n' >&2
  exit 1
fi

CASSAV4_ROOT="${CASSAV4_ROOT:-/opt/cassav4/current}"
CASSA_ROOT="${CASSA_ROOT:-$CASSAV4_ROOT/cassa-frontend}"
ENV_FILE="${CASSAV4_ENV_FILE:-/etc/cassav4/cassav4.env}"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"
SQLITE_BIN="${SQLITE_BIN:-/usr/bin/sqlite3}"
RUN_ID="${P4_LOAD_RUN_ID:-p4_load100_$(date +%Y%m%d_%H%M%S)}"
CONTROL_LOG_DIR="${P4_CONTROL_LOG_DIR:-/var/log/cassav4/$RUN_ID}"
CASSAV4_RUN_USER="${CASSAV4_RUN_USER:-cassav4}"
CASSAV4_RUN_GROUP="${CASSAV4_RUN_GROUP:-cassav4}"
P4_MAX_START_TEMP_MILLIC="${P4_MAX_START_TEMP_MILLIC:-80000}"
P4_MIN_AVAILABLE_MEMORY_KB="${P4_MIN_AVAILABLE_MEMORY_KB:-524288}"
P4_MIN_FREE_DISK_KB="${P4_MIN_FREE_DISK_KB:-2097152}"
P4_ALLOW_CURRENT_THROTTLING="${P4_ALLOW_CURRENT_THROTTLING:-0}"
P4_PREFLIGHT_ONLY="${P4_PREFLIGHT_ONLY:-0}"
P4_PROGRESS_INTERVAL_SEC="${P4_PROGRESS_INTERVAL_SEC:-10}"
P4_API_WORKERS="${LOADTEST_API_WORKERS:-2}"
PROGRESS_LOG="$CONTROL_LOG_DIR/progress.log"

LIVE_SERVICES=(
  cassav4-frontend.service
  cassav4-realtime.service
  cassav4-api-worker@5283.service
  cassav4-api-worker@5284.service
  cassav4-table-lock-worker.service
  cassav4-backend.service
  cassav4-battery.service
  cassav4-fiscal-simulator.service
  cassav4-automatic-cash-simulator.service
)
ACTIVE_SERVICES=()
MOCK_PIDS=()
CLEANUP_STARTED=0
PROGRESS_MONITOR_PID=0
HOST_TEMP_MILLIC=unavailable
HOST_MEMORY_AVAILABLE_KB=0
HOST_FREE_DISK_KB=0
HOST_THROTTLED_RAW=unavailable
HOST_CURRENT_THROTTLE_MASK=unavailable
HOST_TELEMETRY_SERVICE=unavailable

require_nonnegative_integer() {
  local name=$1
  local value=$2
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    printf '%s deve essere un intero non negativo, valore ricevuto: %s\n' "$name" "$value" >&2
    exit 2
  fi
}

collect_host_metrics() {
  local candidate throttle_hex throttle_value
  HOST_TEMP_MILLIC=unavailable
  for candidate in /sys/class/thermal/thermal_zone*/temp; do
    if [[ -r "$candidate" ]]; then
      read -r HOST_TEMP_MILLIC < "$candidate"
      break
    fi
  done
  HOST_MEMORY_AVAILABLE_KB=$(awk '/^MemAvailable:/ { print $2; exit }' /proc/meminfo)
  HOST_FREE_DISK_KB=$(df -Pk "$CASSAV4_ROOT" | awk 'NR == 2 { print $4 }')
  HOST_THROTTLED_RAW=unavailable
  HOST_CURRENT_THROTTLE_MASK=unavailable
  if command -v vcgencmd >/dev/null 2>&1; then
    HOST_THROTTLED_RAW=$(timeout 2s vcgencmd get_throttled 2>/dev/null | tr -d '\n' || printf 'unavailable')
    throttle_hex=${HOST_THROTTLED_RAW#throttled=}
    if [[ "$throttle_hex" =~ ^0x[0-9a-fA-F]+$ ]]; then
      throttle_value=$((throttle_hex))
      HOST_CURRENT_THROTTLE_MASK=$((throttle_value & 0x0f))
    fi
  fi
  HOST_TELEMETRY_SERVICE=$(systemctl is-active cassav4-hardware-telemetry.service 2>/dev/null || true)
  HOST_TELEMETRY_SERVICE=${HOST_TELEMETRY_SERVICE:-inactive}
}

sync_control_log() {
  if [[ -f "$CONTROL_LOG_DIR/run.env" ]]; then
    sync -d "$CONTROL_LOG_DIR/run.env" 2>/dev/null || true
  fi
}

capture_host_snapshot() {
  local phase=$1
  if [[ ! -d "$CONTROL_LOG_DIR" ]]; then
    return
  fi
  collect_host_metrics
  printf 'host_%s_at=%s\nhost_%s_temp_millic=%s\nhost_%s_mem_available_kb=%s\nhost_%s_disk_free_kb=%s\nhost_%s_throttled=%s\nhost_%s_current_throttle_mask=%s\nhost_%s_telemetry_service=%s\n' \
    "$phase" "$(date --iso-8601=seconds)" \
    "$phase" "$HOST_TEMP_MILLIC" \
    "$phase" "$HOST_MEMORY_AVAILABLE_KB" \
    "$phase" "$HOST_FREE_DISK_KB" \
    "$phase" "$HOST_THROTTLED_RAW" \
    "$phase" "$HOST_CURRENT_THROTTLE_MASK" \
    "$phase" "$HOST_TELEMETRY_SERVICE" >> "$CONTROL_LOG_DIR/run.env"
  sync_control_log
}

enforce_host_preflight() {
  require_nonnegative_integer P4_MAX_START_TEMP_MILLIC "$P4_MAX_START_TEMP_MILLIC"
  require_nonnegative_integer P4_MIN_AVAILABLE_MEMORY_KB "$P4_MIN_AVAILABLE_MEMORY_KB"
  require_nonnegative_integer P4_MIN_FREE_DISK_KB "$P4_MIN_FREE_DISK_KB"
  require_nonnegative_integer P4_ALLOW_CURRENT_THROTTLING "$P4_ALLOW_CURRENT_THROTTLING"
  require_nonnegative_integer P4_PREFLIGHT_ONLY "$P4_PREFLIGHT_ONLY"
  require_nonnegative_integer LOADTEST_API_WORKERS "$P4_API_WORKERS"
  if (( P4_API_WORKERS < 1 || P4_API_WORKERS > 4 )); then
    printf 'LOADTEST_API_WORKERS deve essere compreso tra 1 e 4.\n' >&2
    return 1
  fi
  collect_host_metrics
  if [[ "$HOST_TEMP_MILLIC" =~ ^[0-9]+$ ]] && (( HOST_TEMP_MILLIC > P4_MAX_START_TEMP_MILLIC )); then
    printf 'Preflight P4 bloccato: temperatura %smC oltre il limite %smC.\n' "$HOST_TEMP_MILLIC" "$P4_MAX_START_TEMP_MILLIC" >&2
    return 1
  fi
  if (( HOST_MEMORY_AVAILABLE_KB < P4_MIN_AVAILABLE_MEMORY_KB )); then
    printf 'Preflight P4 bloccato: memoria disponibile %sKB sotto il minimo %sKB.\n' "$HOST_MEMORY_AVAILABLE_KB" "$P4_MIN_AVAILABLE_MEMORY_KB" >&2
    return 1
  fi
  if (( HOST_FREE_DISK_KB < P4_MIN_FREE_DISK_KB )); then
    printf 'Preflight P4 bloccato: spazio libero %sKB sotto il minimo %sKB.\n' "$HOST_FREE_DISK_KB" "$P4_MIN_FREE_DISK_KB" >&2
    return 1
  fi
  if [[ "$HOST_CURRENT_THROTTLE_MASK" =~ ^[0-9]+$ ]] && (( HOST_CURRENT_THROTTLE_MASK != 0 )) && (( P4_ALLOW_CURRENT_THROTTLING != 1 )); then
    printf 'Preflight P4 bloccato: throttling Raspberry attuale, mask=%s raw=%s.\n' "$HOST_CURRENT_THROTTLE_MASK" "$HOST_THROTTLED_RAW" >&2
    return 1
  fi
}

stop_progress_monitor() {
  if (( PROGRESS_MONITOR_PID <= 0 )); then
    return
  fi
  if kill -0 "$PROGRESS_MONITOR_PID" 2>/dev/null; then
    kill -TERM "$PROGRESS_MONITOR_PID" 2>/dev/null || true
    wait "$PROGRESS_MONITOR_PID" 2>/dev/null || true
  fi
  PROGRESS_MONITOR_PID=0
}

stop_mock_processes() {
  local pid attempt alive
  for pid in "${MOCK_PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for ((attempt = 0; attempt < 20; attempt++)); do
    alive=0
    for pid in "${MOCK_PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    if (( alive == 0 )); then break; fi
    sleep 0.1
  done
  for pid in "${MOCK_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
    wait "$pid" 2>/dev/null || true
  done
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if (( CLEANUP_STARTED == 1 )); then
    exit "$status"
  fi
  CLEANUP_STARTED=1
  stop_progress_monitor

  stop_mock_processes

  if (( ${#ACTIVE_SERVICES[@]} > 0 )); then
    systemctl start "${ACTIVE_SERVICES[@]}" || true
  fi
  capture_host_snapshot cleanup
  printf 'P4 cleanup completato; servizi ripristinati: %s\n' "${ACTIVE_SERVICES[*]:-nessuno}"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for required in "$CASSA_ROOT/scripts/loadtest-full-capacity.mjs" "$CASSAV4_ROOT/tools/mock-fiscal-server.mjs" "$CASSAV4_ROOT/tools/mock-tcp-printer.mjs" "$ENV_FILE" "$NODE_BIN" "$SQLITE_BIN"; do
  if [[ ! -e "$required" ]]; then
    printf 'Prerequisito P4 mancante: %s\n' "$required" >&2
    exit 1
  fi
done

install -d -o "$CASSAV4_RUN_USER" -g "$CASSAV4_RUN_GROUP" -m 0750 "$CONTROL_LOG_DIR"
printf 'run_id=%s\nstarted_at=%s\nsource_root=%s\n' "$RUN_ID" "$(date --iso-8601=seconds)" "$CASSAV4_ROOT" > "$CONTROL_LOG_DIR/run.env"
chown "$CASSAV4_RUN_USER:$CASSAV4_RUN_GROUP" "$CONTROL_LOG_DIR/run.env"
printf 'preflight_max_temp_millic=%s\npreflight_min_mem_available_kb=%s\npreflight_min_disk_free_kb=%s\n' \
  "$P4_MAX_START_TEMP_MILLIC" "$P4_MIN_AVAILABLE_MEMORY_KB" "$P4_MIN_FREE_DISK_KB" >> "$CONTROL_LOG_DIR/run.env"
capture_host_snapshot preflight
enforce_host_preflight
if (( P4_PREFLIGHT_ONLY == 1 )); then
  printf 'preflight_only=1\npreflight_result=ok\n' >> "$CONTROL_LOG_DIR/run.env"
  sync_control_log
  printf 'Preflight P4 completato senza fermare servizi o avviare il carico.\n'
  exit 0
fi

for service in "${LIVE_SERVICES[@]}"; do
  if systemctl is-active --quiet "$service"; then
    ACTIVE_SERVICES+=("$service")
  fi
done
if (( ${#ACTIVE_SERVICES[@]} > 0 )); then
  systemctl stop "${ACTIVE_SERVICES[@]}"
fi

for port in 5290 5291 5292 5293 5294 5295 5296 5297 9109 9290; do
  if ss -H -ltn "sport = :$port" | grep -q .; then
    printf 'Porta P4 gia occupata dopo lo stop dei servizi isolati: %s\n' "$port" >&2
    exit 1
  fi
done

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

run_as_cassav4() {
  setpriv --reuid="$CASSAV4_RUN_USER" --regid="$CASSAV4_RUN_GROUP" --init-groups env HOME=/var/lib/cassav4 "$@"
}

start_progress_monitor() {
  require_nonnegative_integer P4_PROGRESS_INTERVAL_SEC "$P4_PROGRESS_INTERVAL_SEC"
  if (( P4_PROGRESS_INTERVAL_SEC < 1 )); then
    printf 'P4_PROGRESS_INTERVAL_SEC deve essere almeno 1.\n' >&2
    return 1
  fi
  local relational_db="$CASSAV4_ROOT/logs/loadtest-$RUN_ID/relational.sqlite"
  : > "$PROGRESS_LOG"
  chown "$CASSAV4_RUN_USER:$CASSAV4_RUN_GROUP" "$PROGRESS_LOG"
  (
    trap 'exit 0' INT TERM
    printf 'ts=%s event=progress_monitor_started interval_s=%s db=%s\n' \
      "$(date --iso-8601=seconds)" "$P4_PROGRESS_INTERVAL_SEC" "$relational_db" >> "$PROGRESS_LOG"
    sync -d "$PROGRESS_LOG" 2>/dev/null || true
    while :; do
      local snapshot='db_pending'
      if [[ -r "$relational_db" ]]; then
        snapshot=$(run_as_cassav4 "$SQLITE_BIN" -readonly -cmd '.timeout 1000' "$relational_db" \
          "SELECT 'orders=' || COUNT(*) || ' devices=' || COUNT(DISTINCT created_by_device_uuid) || ' min_per_device=' || COALESCE((SELECT MIN(c) FROM (SELECT COUNT(*) c FROM orders WHERE created_by_device_uuid LIKE 'load-device-%' GROUP BY created_by_device_uuid)), 0) || ' max_per_device=' || COALESCE((SELECT MAX(c) FROM (SELECT COUNT(*) c FROM orders WHERE created_by_device_uuid LIKE 'load-device-%' GROUP BY created_by_device_uuid)), 0) || ' print_pending=' || (SELECT COUNT(*) FROM print_spool WHERE status NOT IN ('confirmed', 'disabled')) || ' outbox_unpublished=' || (SELECT COUNT(*) FROM event_outbox WHERE published_at IS NULL) FROM orders WHERE created_by_device_uuid LIKE 'load-device-%';" 2>/dev/null) || snapshot='db_unavailable'
      fi
      printf 'ts=%s %s\n' "$(date --iso-8601=seconds)" "$snapshot" >> "$PROGRESS_LOG"
      sync -d "$PROGRESS_LOG" 2>/dev/null || true
      sleep "$P4_PROGRESS_INTERVAL_SEC"
    done
  ) &
  PROGRESS_MONITOR_PID=$!
}

wait_for_port() {
  local port=$1
  local attempts=0
  while (( attempts < 100 )); do
    if (exec 9<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      exec 9>&-
      return 0
    fi
    sleep 0.2
    attempts=$((attempts + 1))
  done
  printf 'Timeout in attesa della porta locale %s.\n' "$port" >&2
  return 1
}

start_progress_monitor
setpriv --reuid="$CASSAV4_RUN_USER" --regid="$CASSAV4_RUN_GROUP" --init-groups env HOME=/var/lib/cassav4 MOCK_FISCAL_HOST=127.0.0.1 MOCK_FISCAL_PORT=9290 "$NODE_BIN" "$CASSAV4_ROOT/tools/mock-fiscal-server.mjs" > "$CONTROL_LOG_DIR/mock-fiscal.log" 2>&1 &
MOCK_PIDS+=("$!")
setpriv --reuid="$CASSAV4_RUN_USER" --regid="$CASSAV4_RUN_GROUP" --init-groups env HOME=/var/lib/cassav4 MOCK_PRINTER_HOST=127.0.0.1 MOCK_PRINTER_PORT=9109 "$NODE_BIN" "$CASSAV4_ROOT/tools/mock-tcp-printer.mjs" > "$CONTROL_LOG_DIR/mock-printer.log" 2>&1 &
MOCK_PIDS+=("$!")
wait_for_port 9290
wait_for_port 9109

cd "$CASSA_ROOT"
set +e
run_as_cassav4 \
  NODE_BIN="$NODE_BIN" \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  POS_FISCAL_API_BASE_URL=http://127.0.0.1:9290 \
  LOADTEST_RUN_ID="$RUN_ID" \
  LOADTEST_HANDHELDS="${LOADTEST_HANDHELDS:-100}" \
  LOADTEST_STATIONS="${LOADTEST_STATIONS:-10}" \
  LOADTEST_GUI="${LOADTEST_GUI:-5}" \
  LOADTEST_REALTIME_CLIENTS="${LOADTEST_REALTIME_CLIENTS:-100}" \
  LOADTEST_OPS_PER_DEVICE="${LOADTEST_OPS_PER_DEVICE:-80}" \
  LOADTEST_FISCAL_SAMPLE_LIMIT="${LOADTEST_FISCAL_SAMPLE_LIMIT:-5}" \
  LOADTEST_MULTIPROCESS=1 \
  LOADTEST_API_WORKERS="$P4_API_WORKERS" \
  LOADTEST_TABLE_LOCK_WORKERS="${LOADTEST_TABLE_LOCK_WORKERS:-1}" \
  LOADTEST_TABLE_LOCK_TOMBSTONES="${LOADTEST_TABLE_LOCK_TOMBSTONES:-1}" \
  LOADTEST_TABLE_LOCK_MYSQL_CONNECTION_LIMIT="${LOADTEST_TABLE_LOCK_MYSQL_CONNECTION_LIMIT:-8}" \
  LOADTEST_TABLE_LOCK_REDIS_POOL_SIZE="${LOADTEST_TABLE_LOCK_REDIS_POOL_SIZE:-4}" \
  LOADTEST_API_WORKER_AUTH_FASTPATH="${LOADTEST_API_WORKER_AUTH_FASTPATH:-1}" \
  LOADTEST_API_WORKER_REDIS_POOL_SIZE="${LOADTEST_API_WORKER_REDIS_POOL_SIZE:-4}" \
  LOADTEST_ORDER_CREATE_TARGETED_LOCK_REFRESH="${LOADTEST_ORDER_CREATE_TARGETED_LOCK_REFRESH:-0}" \
  LOADTEST_GUI_HEADLESS=1 \
  LOADTEST_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
  LOADTEST_CHROMIUM_NO_SANDBOX=1 \
  LOADTEST_PRINTING_ENABLED=1 \
  LOADTEST_PRINTER_HOST=127.0.0.1 \
  LOADTEST_PRINTER_PORT=9109 \
  LOADTEST_ALLOW_NON_LOOPBACK_IO=0 \
  APP_STATE_DIRTY_TRACKING=write \
  APP_STATE_DIRTY_TRACKING_MODE=write \
  PRINT_SPOOL_FAST_WORKER=1 \
  "$NODE_BIN" scripts/loadtest-full-capacity.mjs > "$CONTROL_LOG_DIR/loadtest.log" 2>&1
LOAD_STATUS=$?
set -e

stop_progress_monitor
capture_host_snapshot post_load
printf 'finished_at=%s\nexit_code=%s\n' "$(date --iso-8601=seconds)" "$LOAD_STATUS" >> "$CONTROL_LOG_DIR/run.env"
if [[ -f "$CASSAV4_ROOT/logs/loadtest-$RUN_ID/report.json" ]]; then
  printf 'report_json_sha256=%s\n' "$(sha256sum "$CASSAV4_ROOT/logs/loadtest-$RUN_ID/report.json" | awk '{ print $1 }')" >> "$CONTROL_LOG_DIR/run.env"
fi
sync_control_log
exit "$LOAD_STATUS"
