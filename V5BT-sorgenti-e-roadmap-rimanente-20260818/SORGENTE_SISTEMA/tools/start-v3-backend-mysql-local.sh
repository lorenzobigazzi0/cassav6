#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd -- "${APP_ROOT}/.." && pwd)"
BACKEND_ROOT="${APP_ROOT}/cassa-frontend"
LOG_DIR="${APP_ROOT}/logs"
BACKEND_LOG="${LOG_DIR}/backend-mysql-local.log"
PORT_VALUE="${PORT:-5281}"
HEALTH_URL="http://127.0.0.1:${PORT_VALUE}/api/health"
NODE_BIN="${REPO_ROOT}/.tools/node/node-v26.3.1-linux-x64/bin/node"
LOCAL_RUNTIME_NODE="/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin/node"
FALLBACK_NODE_BIN="/media/sentrapa/HAND/cassav2-v3-patch7-complete-source/.tools/node/node-v26.3.1-linux-x64/bin/node"

if [ ! -x "${NODE_BIN}" ]; then
  if [ -x "${LOCAL_RUNTIME_NODE}" ]; then
    NODE_BIN="${LOCAL_RUNTIME_NODE}"
  elif [ -x "${FALLBACK_NODE_BIN}" ]; then
    NODE_BIN="${FALLBACK_NODE_BIN}"
  else
    NODE_BIN="$(command -v node || true)"
  fi
fi

if [ -z "${NODE_BIN}" ] || [ ! -x "${NODE_BIN}" ]; then
  printf 'node binary not found\n' >&2
  exit 1
fi

mkdir -p "${LOG_DIR}"

find_backend_pids() {
  local pid
  local cwd
  local cmdline
  local exe_name
  for pid in $(pgrep -f "backend/server.js" || true); do
    [ "${pid}" = "$$" ] && continue
    cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
    cmdline="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
    exe_name="$(basename "$(readlink -f "/proc/${pid}/exe" 2>/dev/null || true)")"
    [ "${exe_name}" = "node" ] || continue
    case "${cmdline}" in *backend/server.js*) ;; *) continue ;; esac
    if [ "${cwd}" = "${APP_ROOT}" ] || [ "${cwd}" = "${BACKEND_ROOT}" ]; then
      printf '%s\n' "${pid}"
      continue
    fi
    if printf '%s\n' "${cmdline}" | grep -Eq "(${APP_ROOT}/)?cassa-frontend/backend/server\\.js|${BACKEND_ROOT}/backend/server\\.js"; then
      printf '%s\n' "${pid}"
    fi
  done
}

port_is_free() {
  ! ss -ltn "sport = :${PORT_VALUE}" 2>/dev/null | grep -q LISTEN
}

mapfile -t backend_pids < <(find_backend_pids)
for pid in "${backend_pids[@]}"; do
  if [ -n "${pid}" ]; then
    kill -TERM "${pid}" 2>/dev/null || true
  fi
done

for _ in $(seq 1 50); do
  still_running=0
  for pid in "${backend_pids[@]}"; do
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      still_running=1
      break
    fi
  done
  [ "${still_running}" -eq 0 ] && break
  sleep 0.2
done

for pid in "${backend_pids[@]}"; do
  if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
    kill -KILL "${pid}" 2>/dev/null || true
  fi
done

for _ in $(seq 1 50); do
  port_is_free && break
  sleep 0.2
done

if ! port_is_free; then
  printf 'port %s is still busy\n' "${PORT_VALUE}" >&2
  exit 1
fi

cd "${BACKEND_ROOT}"
setsid -f env \
  NODE_ENV=development \
  BACKEND_HOST=0.0.0.0 \
  PORT="${PORT_VALUE}" \
  PRINTING_ENABLED=1 \
  POS_FISCAL_API_BASE_URL="${POS_FISCAL_API_BASE_URL:-http://192.168.1.200:8765}" \
  AUTOMATIC_CASH_GATEWAY_ENABLED="${AUTOMATIC_CASH_GATEWAY_ENABLED:-1}" \
  AUTOMATIC_CASH_GATEWAY_BASE_URL="${AUTOMATIC_CASH_GATEWAY_BASE_URL:-http://192.168.1.200:9090}" \
  AUTOMATIC_CASH_GATEWAY_USERNAME="${AUTOMATIC_CASH_GATEWAY_USERNAME:-amalia}" \
  AUTOMATIC_CASH_GATEWAY_PASSWORD="${AUTOMATIC_CASH_GATEWAY_PASSWORD:-182018}" \
  AUTOMATIC_CASH_GATEWAY_TIMEOUT_MS="${AUTOMATIC_CASH_GATEWAY_TIMEOUT_MS:-120000}" \
  BATTERY_SERVICE_URL="${BATTERY_SERVICE_URL:-http://127.0.0.1:8765/battery}" \
  BATTERY_PROXY_CACHE_MS="${BATTERY_PROXY_CACHE_MS:-750}" \
  BACKEND_DB_MODE=mysql \
  BACKEND_MYSQL_HOST=127.0.0.1 \
  BACKEND_MYSQL_PORT=3306 \
  BACKEND_MYSQL_USER=cassa_app \
  BACKEND_MYSQL_PASSWORD=amalia2026 \
  BACKEND_MYSQL_DATABASE=cassa \
  BACKEND_MYSQL_SPLIT_SESSIONS=1 \
  BACKEND_MYSQL_SESSIONS_TABLE=app_state_sessions \
  BACKEND_MYSQL_SPLIT_AUDIT_EVENTS=1 \
  BACKEND_MYSQL_AUDIT_EVENTS_TABLE=app_state_audit_events \
  BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS=1 \
  BACKEND_MYSQL_APP_STATE_DOMAINS_TABLE=app_state_domain_records \
  BACKEND_ALLOW_EMPTY_DB_INIT=1 \
  BACKEND_ALLOW_MYSQL_IMPORT_JSON=1 \
  BACKEND_DB_IMPORT_JSON_PATH="${BACKEND_ROOT}/backend/app-state.json" \
  BACKEND_APP_STATE_SPLIT_DEVICE_STATUS=externalized \
  BACKEND_APP_STATE_SPLIT_TABLE_LOCKS=externalized \
  BACKEND_APP_STATE_SPLIT_DB_PATH="${BACKEND_ROOT}/backend/app-state-split.sqlite" \
  "${NODE_BIN}" backend/server.js </dev/null >> "${BACKEND_LOG}" 2>&1 &

new_pid="$!"
printf 'backend mysql pid %s, log %s\n' "${new_pid}" "${BACKEND_LOG}"

for _ in $(seq 1 60); do
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    printf 'health OK: %s\n' "${HEALTH_URL}"
    exit 0
  fi
  sleep 1
done

printf 'health FAILED: %s\n' "${HEALTH_URL}" >&2
exit 1
