#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ROOT="$ROOT/SORGENTE_SISTEMA"
RUNTIME_DIR="${CASSAV5BT_RUNTIME_DIR:-$ROOT/.runtime/cassav5bt}"
SERVER_LOG_DIR="$RUNTIME_DIR/server-logs"

BACKEND_PORT="${CASSAV5BT_BACKEND_PORT:-5381}"
FRONTEND_PORT="${CASSAV5BT_FRONTEND_PORT:-5380}"
BATTERY_PORT="${CASSAV5BT_BATTERY_PORT:-8865}"
CHECK_INTERVAL_SECONDS="${CASSAV5BT_SERVICE_CHECK_INTERVAL_SECONDS:-5}"
MAX_HEALTH_FAILURES="${CASSAV5BT_SERVICE_MAX_HEALTH_FAILURES:-3}"

if ! [[ "$CHECK_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Intervallo di controllo V5BT non valido: $CHECK_INTERVAL_SECONDS" >&2
  exit 1
fi
if ! [[ "$MAX_HEALTH_FAILURES" =~ ^[1-9][0-9]*$ ]]; then
  echo "Soglia di controllo V5BT non valida: $MAX_HEALTH_FAILURES" >&2
  exit 1
fi

cleanup() {
  local status=$?
  trap - EXIT TERM INT HUP
  CASSAV5BT_RUNTIME_DIR="$RUNTIME_DIR" bash "$ROOT/stop-v5bt.sh" || true
  exit "$status"
}

trap cleanup EXIT
trap 'exit 0' TERM INT HUP

bash "$ROOT/start-v5bt.sh"

pid_belongs_to_v5bt() {
  local pid_file="$1"
  local pid process_cwd
  [[ -s "$pid_file" ]] || return 1
  pid="$(<"$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  process_cwd="$(readlink -e "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$process_cwd" == "$APP_ROOT" || "$process_cwd" == "$APP_ROOT/"* ]]
}

health_check() {
  pid_belongs_to_v5bt "$RUNTIME_DIR/battery.pid" &&
    pid_belongs_to_v5bt "$SERVER_LOG_DIR/backend-linux-current.pid" &&
    pid_belongs_to_v5bt "$SERVER_LOG_DIR/frontends-linux-current.pid" &&
    curl -fsS --max-time 3 "http://127.0.0.1:${BATTERY_PORT}/api/health" >/dev/null &&
    curl -fsS --max-time 3 "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null &&
    curl -kfsS --max-time 3 "https://127.0.0.1:${FRONTEND_PORT}/mobile/" >/dev/null
}

health_failures=0
while true; do
  sleep "$CHECK_INTERVAL_SECONDS" &
  wait $!

  if health_check; then
    health_failures=0
    continue
  fi

  health_failures=$((health_failures + 1))
  echo "Controllo runtime Cassa V5BT fallito ($health_failures/$MAX_HEALTH_FAILURES)." >&2
  if (( health_failures >= MAX_HEALTH_FAILURES )); then
    exit 1
  fi
done
