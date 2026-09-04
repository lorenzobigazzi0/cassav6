#!/usr/bin/env bash
set -Eeuo pipefail

umask 027

LOG_DIR="${CASSAV4_TELEMETRY_LOG_DIR:-/var/log/cassav4}"
STATE_DIR="${CASSAV4_TELEMETRY_STATE_DIR:-/var/lib/cassav4}"
INTERVAL_SEC="${CASSAV4_TELEMETRY_INTERVAL_SEC:-5}"
MAX_BYTES="${CASSAV4_TELEMETRY_MAX_BYTES:-16777216}"
MAX_FILES="${CASSAV4_TELEMETRY_MAX_FILES:-3}"
BOOT_JOURNAL_LINES="${CASSAV4_BOOT_JOURNAL_LINES:-2000}"
LOG_FILE="$LOG_DIR/hardware-telemetry.log"
BOOT_MARKER="$STATE_DIR/hardware-telemetry-boot-id"

require_positive_integer() {
  local name=$1
  local value=$2
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s deve essere un intero positivo, valore ricevuto: %s\n' "$name" "$value" >&2
    exit 2
  fi
}

require_positive_integer CASSAV4_TELEMETRY_INTERVAL_SEC "$INTERVAL_SEC"
require_positive_integer CASSAV4_TELEMETRY_MAX_BYTES "$MAX_BYTES"
require_positive_integer CASSAV4_TELEMETRY_MAX_FILES "$MAX_FILES"
require_positive_integer CASSAV4_BOOT_JOURNAL_LINES "$BOOT_JOURNAL_LINES"

install -d -m 0750 "$LOG_DIR" "$STATE_DIR"
touch "$LOG_FILE"
chmod 0640 "$LOG_FILE"

current_boot_id() {
  tr -d '\n' < /proc/sys/kernel/random/boot_id
}

rotate_log_if_needed() {
  local size=0
  size=$(stat -c '%s' "$LOG_FILE" 2>/dev/null || printf '0')
  if (( size < MAX_BYTES )); then
    return
  fi

  rm -f "$LOG_FILE.$MAX_FILES"
  local index
  for ((index = MAX_FILES - 1; index >= 1; index -= 1)); do
    if [[ -f "$LOG_FILE.$index" ]]; then
      mv -f "$LOG_FILE.$index" "$LOG_FILE.$((index + 1))"
    fi
  done
  mv -f "$LOG_FILE" "$LOG_FILE.1"
  : > "$LOG_FILE"
  chmod 0640 "$LOG_FILE"
}

vcgencmd_value() {
  local command_name=$1
  if ! command -v vcgencmd >/dev/null 2>&1; then
    printf 'unavailable'
    return
  fi
  timeout 2s vcgencmd "$command_name" 2>/dev/null | tr -d '\n' || printf 'unavailable'
}

capture_boot_diagnostics() {
  local boot_id previous_boot_id timestamp report_file temporary_file
  boot_id=$(current_boot_id)
  previous_boot_id=''
  if [[ -r "$BOOT_MARKER" ]]; then
    previous_boot_id=$(tr -d '\n' < "$BOOT_MARKER")
  fi
  if [[ "$previous_boot_id" == "$boot_id" ]]; then
    return
  fi

  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  report_file="$LOG_DIR/boot-diagnostics-$timestamp.log"
  temporary_file="$LOG_DIR/.boot-diagnostics-$timestamp.tmp"
  {
    printf 'captured_at=%s\n' "$(date --iso-8601=seconds)"
    printf 'boot_id=%s\n' "$boot_id"
    printf 'uptime='; uptime || true
    printf 'vcgencmd_throttled=%s\n' "$(vcgencmd_value get_throttled)"
    printf 'vcgencmd_temperature=%s\n' "$(vcgencmd_value measure_temp)"
    printf '\n[last -x]\n'
    timeout 10s last -x -n 30 || true
    printf '\n[previous boot kernel]\n'
    timeout 20s journalctl -b -1 -k --no-pager -n "$BOOT_JOURNAL_LINES" || true
    printf '\n[previous boot warnings]\n'
    timeout 20s journalctl -b -1 -p warning..alert --no-pager -n "$BOOT_JOURNAL_LINES" || true
  } > "$temporary_file"
  mv -f "$temporary_file" "$report_file"
  printf '%s\n' "$boot_id" > "$BOOT_MARKER.tmp"
  mv -f "$BOOT_MARKER.tmp" "$BOOT_MARKER"
  chmod 0640 "$report_file" "$BOOT_MARKER"
  sync -d "$report_file" "$BOOT_MARKER" 2>/dev/null || true
}

psi_avg10() {
  local file=$1
  local scope token remainder
  if [[ ! -r "$file" ]]; then
    printf 'unavailable'
    return
  fi
  read -r scope token remainder < "$file" || true
  if [[ "$token" == avg10=* ]]; then
    printf '%s' "${token#avg10=}"
  else
    printf 'unavailable'
  fi
}

capture_sample() {
  local timestamp boot_id uptime_seconds load1 load5 load15 remainder
  local mem_available_kb=0 swap_free_kb=0 key value unit
  local temperature_millic='unavailable' cpu_frequency_khz='unavailable'
  local candidate throttled

  timestamp=$(date --iso-8601=seconds)
  boot_id=$(current_boot_id)
  read -r uptime_seconds remainder < /proc/uptime
  read -r load1 load5 load15 remainder < /proc/loadavg
  while read -r key value unit; do
    case "$key" in
      MemAvailable:) mem_available_kb=$value ;;
      SwapFree:) swap_free_kb=$value ;;
    esac
  done < /proc/meminfo
  for candidate in /sys/class/thermal/thermal_zone*/temp; do
    if [[ -r "$candidate" ]]; then
      read -r temperature_millic < "$candidate"
      break
    fi
  done
  if [[ -r /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq ]]; then
    read -r cpu_frequency_khz < /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq
  fi
  throttled=$(vcgencmd_value get_throttled)
  throttled=${throttled#throttled=}

  printf 'ts=%s boot_id=%s uptime_s=%s load1=%s load5=%s load15=%s mem_available_kb=%s swap_free_kb=%s temp_millic=%s cpu_freq_khz=%s psi_cpu_avg10=%s psi_memory_avg10=%s psi_io_avg10=%s throttled=%s\n' \
    "$timestamp" "$boot_id" "$uptime_seconds" "$load1" "$load5" "$load15" \
    "$mem_available_kb" "$swap_free_kb" "$temperature_millic" "$cpu_frequency_khz" \
    "$(psi_avg10 /proc/pressure/cpu)" "$(psi_avg10 /proc/pressure/memory)" \
    "$(psi_avg10 /proc/pressure/io)" "$throttled"
}

capture_boot_diagnostics
printf 'ts=%s event=telemetry_started boot_id=%s interval_s=%s\n' \
  "$(date --iso-8601=seconds)" "$(current_boot_id)" "$INTERVAL_SEC" >> "$LOG_FILE"
sync -d "$LOG_FILE" 2>/dev/null || true

trap 'exit 0' INT TERM
while :; do
  rotate_log_if_needed
  capture_sample >> "$LOG_FILE"
  sync -d "$LOG_FILE" 2>/dev/null || true
  sleep "$INTERVAL_SEC"
done
