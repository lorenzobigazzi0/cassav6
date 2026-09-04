#!/usr/bin/env bash
set -euo pipefail

TAG="v3-backend-restart-20260622-0200"
APP_ROOT="/srv/applicazione/v3"
BACKEND_ROOT="${APP_ROOT}/cassa-frontend"
LOG_DIR="${APP_ROOT}/logs"
BACKEND_LOG="${LOG_DIR}/backend-v3.log"
RESTART_LOG="${LOG_DIR}/scheduled-restarts.log"
NODE_BIN="/usr/local/bin/node"
PORT_VALUE="5281"
HEALTH_URL="http://127.0.0.1:${PORT_VALUE}/api/health"

mkdir -p "${LOG_DIR}"

log() {
  printf '%s %s\n' "$(date --iso-8601=seconds)" "$*" >> "${RESTART_LOG}"
}

remove_cron_entry() {
  local current_cron
  current_cron="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "${current_cron}" | grep -q "${TAG}"; then
    printf '%s\n' "${current_cron}" | grep -v "${TAG}" | crontab -
  fi
}

find_backend_pids() {
  pgrep -f "${BACKEND_ROOT}/backend/server.js" || true
}

wait_backend_down() {
  local pid
  local attempt
  for attempt in $(seq 1 50); do
    local alive=0
    for pid in "$@"; do
      if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
        alive=1
        break
      fi
    done
    if [ "${alive}" -eq 0 ]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

log "restart backend V3 scheduled job started"

mapfile -t backend_pids < <(find_backend_pids)
if [ "${#backend_pids[@]}" -gt 0 ]; then
  log "stopping backend pids: ${backend_pids[*]}"
  for pid in "${backend_pids[@]}"; do
    if [ -n "${pid}" ]; then
      kill -TERM "${pid}" 2>/dev/null || true
    fi
  done
  if ! wait_backend_down "${backend_pids[@]}"; then
    log "backend did not stop after TERM, sending KILL"
    for pid in "${backend_pids[@]}"; do
      if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
        kill -KILL "${pid}" 2>/dev/null || true
      fi
    done
  fi
else
  log "no backend pid found, starting a fresh backend"
fi

cd "${BACKEND_ROOT}"
nohup env NODE_ENV=development PORT="${PORT_VALUE}" PRINTING_ENABLED=1 "${NODE_BIN}" backend/server.js >> "${BACKEND_LOG}" 2>&1 &
new_pid="$!"
log "backend started with pid ${new_pid}"

for _ in $(seq 1 60); do
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    log "backend health OK after restart"
    remove_cron_entry
    log "cron entry ${TAG} removed"
    exit 0
  fi
  sleep 1
done

log "backend health FAILED after restart"
remove_cron_entry
exit 1
