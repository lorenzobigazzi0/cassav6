#!/usr/bin/env bash
set -euo pipefail

API_BASE="http://127.0.0.1:5281"
DEVICE_UUID="monitor_scheduled_handheld_report_20260620_1710"
SESSION_DATE="2026-06-20"
SCRIPT_PATH="/srv/applicazione/v3/tools/print-handheld-session-report-once-20260620-1710.sh"

cleanup_cron() {
  (crontab -l 2>/dev/null | grep -v "$SCRIPT_PATH" || true) | crontab -
}

trap cleanup_cron EXIT

login_payload='{"username":"admin","pin":"1234","deviceUuid":"'"$DEVICE_UUID"'","clientApp":"monitor-frontend"}'
login_response="$(curl -fsS -X POST "$API_BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  --data "$login_payload")"

token="$(node -e 'const data=JSON.parse(process.argv[1]); if(!data.ok||!data.token) process.exit(1); process.stdout.write(data.token);' "$login_response")"
user_id="$(node -e 'const data=JSON.parse(process.argv[1]); process.stdout.write(String(data.user?.id||""));' "$login_response")"

print_payload="$(node - <<NODE
console.log(JSON.stringify({
  date: "$SESSION_DATE",
  token: "$token",
  userId: "$user_id",
  deviceUuid: "$DEVICE_UUID",
  clientApp: "monitor-frontend"
}));
NODE
)"

curl -fsS -X POST "$API_BASE/api/reports/handheld-session/print" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $token" \
  -H "X-User-Id: $user_id" \
  -H "X-Device-Uuid: $DEVICE_UUID" \
  --data "$print_payload"

echo
echo "Riepilogo palmari $SESSION_DATE inviato alla stampa alle $(date '+%Y-%m-%d %H:%M:%S %Z')."
