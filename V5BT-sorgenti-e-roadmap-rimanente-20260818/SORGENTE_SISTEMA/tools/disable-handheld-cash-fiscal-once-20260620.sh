#!/usr/bin/env bash
set -euo pipefail

MARKER="pos-handheld-cash-fiscal-pos-only-20260620"
LOG="/srv/applicazione/v3/logs/handheld-cash-fiscal-scheduler.log"

{
  echo "$(date --iso-8601=seconds) ${MARKER}: start"
  /usr/local/bin/node /srv/applicazione/v3/tools/set-handheld-cash-fiscal-mode.mjs off
  echo "$(date --iso-8601=seconds) ${MARKER}: done"
} >> "$LOG" 2>&1

tmp_file="$(mktemp)"
crontab -l 2>/dev/null | grep -v "$MARKER" > "$tmp_file" || true
crontab "$tmp_file"
rm -f "$tmp_file"
