#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/_start-profile.sh" "NEAR_REALTIME_MQTT" "near-realtime-mqtt"
