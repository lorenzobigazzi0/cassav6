#!/usr/bin/env bash
set -euo pipefail

MARKER="v3-heartbeat-deploy-20260622-0300"
APP_ROOT="/srv/applicazione/v3"
CASSA_ROOT="${APP_ROOT}/cassa-frontend"
LOG_DIR="${APP_ROOT}/logs"
LOG_FILE="${LOG_DIR}/deploy-heartbeat-write-reduction-20260622-0300.log"
HEALTH_URL="http://127.0.0.1:5281/api/health"

mkdir -p "${LOG_DIR}"
exec >> "${LOG_FILE}" 2>&1

echo "=== ${MARKER} start $(date --iso-8601=seconds) ==="

cd "${CASSA_ROOT}"

echo "[check] backend syntax"
/usr/local/bin/node --check backend/server.js
/usr/local/bin/node --check backend/auth/auth.handlers.js

OLD_PID="$(systemctl show -p MainPID --value applicazione-backend.service || true)"
echo "[restart] old backend pid=${OLD_PID}"
systemctl restart applicazione-backend.service

echo "[health] waiting ${HEALTH_URL}"
for attempt in $(seq 1 30); do
  if curl -fsS "${HEALTH_URL}"; then
    echo
    NEW_PID="$(systemctl show -p MainPID --value applicazione-backend.service || true)"
    echo "[ok] new backend pid=${NEW_PID}"
    break
  fi
  sleep 1
  if [ "${attempt}" = "30" ]; then
    echo "[error] backend health non OK dopo 30 secondi"
    systemctl --no-pager --lines=80 status applicazione-backend.service || true
    exit 1
  fi
done

if crontab -l >/tmp/${MARKER}.cron 2>/dev/null; then
  grep -v "${MARKER}" /tmp/${MARKER}.cron | crontab -
  rm -f /tmp/${MARKER}.cron
fi

echo "=== ${MARKER} end $(date --iso-8601=seconds) ==="
