#!/usr/bin/env bash
set -Eeuo pipefail

umask 027

if (( EUID != 0 )); then
  printf 'cassav4-p4-crash-forensics.sh deve essere eseguito come root.\n' >&2
  exit 1
fi

RUN_ID="${1:-${P4_FORENSICS_RUN_ID:-}}"
if [[ -z "$RUN_ID" ]]; then
  printf 'Uso: %s <run_id>\n' "${0##*/}" >&2
  exit 2
fi
if [[ ! "$RUN_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]]; then
  printf 'run_id non valido: %s\n' "$RUN_ID" >&2
  exit 2
fi

CASSAV4_ROOT="${CASSAV4_ROOT:-/opt/cassav4/current}"
OUTPUT_ROOT="${P4_FORENSICS_OUTPUT_ROOT:-/var/log/cassav4/forensics}"
INCLUDE_DATABASES="${P4_FORENSICS_INCLUDE_DATABASES:-1}"
JOURNAL_LINES="${P4_FORENSICS_JOURNAL_LINES:-10000}"
CONTROL_DIR="${P4_FORENSICS_CONTROL_DIR:-/var/log/cassav4/$RUN_ID}"
LOADTEST_DIR="${P4_FORENSICS_LOADTEST_DIR:-$CASSAV4_ROOT/logs/loadtest-$RUN_ID}"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BUNDLE_NAME="p4-forensics-$RUN_ID-$TIMESTAMP"
WORK_DIR="$OUTPUT_ROOT/.tmp-$BUNDLE_NAME"
ARCHIVE_PATH="$OUTPUT_ROOT/$BUNDLE_NAME.tar.gz"
CHECKSUM_PATH="$ARCHIVE_PATH.sha256"

if [[ ! "$INCLUDE_DATABASES" =~ ^[01]$ ]]; then
  printf 'P4_FORENSICS_INCLUDE_DATABASES deve essere 0 oppure 1.\n' >&2
  exit 2
fi
if [[ ! "$JOURNAL_LINES" =~ ^[1-9][0-9]*$ ]]; then
  printf 'P4_FORENSICS_JOURNAL_LINES deve essere un intero positivo.\n' >&2
  exit 2
fi

SERVICES=(
  cassav4-frontend.service
  cassav4-backend.service
  cassav4-realtime.service
  cassav4-api-worker@5283.service
  cassav4-api-worker@5284.service
  cassav4-battery.service
  cassav4-hardware-telemetry.service
  mariadb.service
  redis-server.service
  mosquitto.service
)

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install -d -m 0750 "$OUTPUT_ROOT"
rm -rf "$WORK_DIR"
install -d -m 0750 "$WORK_DIR/host" "$WORK_DIR/journal" "$WORK_DIR/systemd" "$WORK_DIR/artifacts"

capture_command() {
  local target=$1
  shift
  {
    printf 'captured_at=%s\n' "$(date --iso-8601=seconds)"
    printf 'command='; printf '%q ' "$@"; printf '\n\n'
    "$@"
  } > "$target" 2>&1 || true
}

capture_shell() {
  local target=$1
  local command_text=$2
  capture_command "$target" bash -o pipefail -c "$command_text"
}

copy_artifact_tree() {
  local source=$1
  local destination=$2
  if [[ ! -e "$source" ]]; then
    printf 'missing=%s\n' "$source" > "$destination.missing"
    return
  fi
  cp -a "$source" "$destination"
  if (( INCLUDE_DATABASES == 0 )); then
    find "$destination" -type f \( -name '*.sqlite' -o -name '*.sqlite-shm' -o -name '*.sqlite-wal' \) -delete
  fi
}

capture_command "$WORK_DIR/host/date.txt" date --iso-8601=seconds
capture_command "$WORK_DIR/host/hostnamectl.txt" hostnamectl
capture_command "$WORK_DIR/host/uname.txt" uname -a
capture_command "$WORK_DIR/host/uptime.txt" uptime
capture_command "$WORK_DIR/host/last-reboots.txt" last -x -n 50
capture_command "$WORK_DIR/host/lscpu.txt" lscpu
capture_command "$WORK_DIR/host/memory.txt" free -h
capture_command "$WORK_DIR/host/disk.txt" df -hT
capture_command "$WORK_DIR/host/ip-address.txt" ip -br address
capture_command "$WORK_DIR/host/ip-route.txt" ip route
capture_command "$WORK_DIR/host/kernel-cmdline.txt" cat /proc/cmdline
capture_command "$WORK_DIR/host/cpu-online.txt" cat /sys/devices/system/cpu/online
capture_shell "$WORK_DIR/host/thermal-zones.txt" 'for file in /sys/class/thermal/thermal_zone*/temp; do printf "%s=" "$file"; cat "$file"; done'
capture_shell "$WORK_DIR/host/vcgencmd.txt" 'if command -v vcgencmd >/dev/null 2>&1; then vcgencmd get_throttled; vcgencmd measure_temp; vcgencmd measure_clock arm; else echo vcgencmd_unavailable; fi'
capture_shell "$WORK_DIR/host/pressure.txt" 'for file in /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io; do echo "[$file]"; cat "$file"; done'

capture_command "$WORK_DIR/journal/previous-boot-kernel.log" journalctl -b -1 -k --no-pager -n "$JOURNAL_LINES"
capture_command "$WORK_DIR/journal/previous-boot-warnings.log" journalctl -b -1 -p warning..alert --no-pager -n "$JOURNAL_LINES"
capture_command "$WORK_DIR/journal/current-boot-kernel.log" journalctl -b 0 -k --no-pager -n "$JOURNAL_LINES"
capture_shell "$WORK_DIR/journal/previous-boot-critical-signals.log" "journalctl -b -1 -k --no-pager -n '$JOURNAL_LINES' | grep -Eai 'oom|out of memory|killed process|watchdog|panic|thermal|thrott|under.?voltage|voltage|i/o error|ext4|mmc|nvme|segfault|hung task|soft lockup|hard lockup' || true"
capture_command "$WORK_DIR/journal/coredumps.log" coredumpctl list --no-pager
capture_command "$WORK_DIR/journal/p4-units.log" journalctl --no-pager -n "$JOURNAL_LINES" -u 'cassav4-p4-*'

capture_command "$WORK_DIR/systemd/failed-units.txt" systemctl --failed --no-pager
capture_command "$WORK_DIR/systemd/p4-units.txt" systemctl list-units 'cassav4-p4-*' --all --no-pager
for service in "${SERVICES[@]}"; do
  safe_name=${service//@/_at_}
  capture_command "$WORK_DIR/systemd/$safe_name.status.txt" systemctl status "$service" --no-pager -n 100
  capture_command "$WORK_DIR/systemd/$safe_name.unit.txt" systemctl cat "$service" --no-pager
  capture_command "$WORK_DIR/systemd/$safe_name.previous-boot.log" journalctl -b -1 -u "$service" --no-pager -n "$JOURNAL_LINES"
done

copy_artifact_tree "$CONTROL_DIR" "$WORK_DIR/artifacts/control"
copy_artifact_tree "$LOADTEST_DIR" "$WORK_DIR/artifacts/loadtest"

{
  printf 'run_id=%s\n' "$RUN_ID"
  printf 'captured_at=%s\n' "$(date --iso-8601=seconds)"
  printf 'source_root=%s\n' "$CASSAV4_ROOT"
  printf 'control_dir=%s\n' "$CONTROL_DIR"
  printf 'loadtest_dir=%s\n' "$LOADTEST_DIR"
  printf 'include_databases=%s\n' "$INCLUDE_DATABASES"
} > "$WORK_DIR/CONTEXT.txt"

(
  cd "$WORK_DIR"
  find . -type f ! -name MANIFEST.sha256 -printf '%p\t%s bytes\n' | sort > MANIFEST.files
  find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 -r sha256sum > MANIFEST.sha256
)

tar -C "$WORK_DIR" -czf "$ARCHIVE_PATH" .
ARCHIVE_HASH=$(sha256sum "$ARCHIVE_PATH" | awk '{ print $1 }')
printf '%s  %s\n' "$ARCHIVE_HASH" "$ARCHIVE_PATH" > "$CHECKSUM_PATH"
chmod 0640 "$ARCHIVE_PATH" "$CHECKSUM_PATH"
sync -d "$ARCHIVE_PATH" "$CHECKSUM_PATH" 2>/dev/null || true

printf 'archive=%s\nsha256=%s\nchecksum_file=%s\n' "$ARCHIVE_PATH" "$ARCHIVE_HASH" "$CHECKSUM_PATH"
