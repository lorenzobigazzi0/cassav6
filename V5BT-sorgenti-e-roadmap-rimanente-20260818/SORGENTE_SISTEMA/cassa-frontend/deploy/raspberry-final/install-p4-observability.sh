#!/usr/bin/env bash
set -Eeuo pipefail

umask 027

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SOURCE_ROOT="${P4_OBSERVABILITY_SOURCE_ROOT:-$(cd -- "$SCRIPT_DIR/../.." && pwd)}"
TARGET_ROOT="${P4_OBSERVABILITY_TARGET_ROOT:-/opt/cassav4/current/cassa-frontend}"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-/usr/bin/systemctl}"
CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
SYSTEM_ROOT="${P4_OBSERVABILITY_SYSTEM_ROOT:-}"
SYSTEM_ROOT=${SYSTEM_ROOT%/}
PREFLIGHT_LOG_ROOT="${P4_OBSERVABILITY_PREFLIGHT_LOG_ROOT:-/var/log/cassav4}"
RUN_USER="${CASSAV4_RUN_USER:-cassav4}"
RUN_GROUP="${CASSAV4_RUN_GROUP:-cassav4}"
DRY_RUN="${P4_OBSERVABILITY_DRY_RUN:-0}"
REQUIRE_LIVE_HEALTH="${P4_OBSERVABILITY_REQUIRE_LIVE_HEALTH:-1}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_ROOT="${P4_OBSERVABILITY_BACKUP_ROOT:-/opt/cassav4/backups/p4-observability-$TIMESTAMP}"
INSTALL_REPORT="${P4_OBSERVABILITY_INSTALL_REPORT:-/var/log/cassav4/p4-observability-install-$TIMESTAMP.log}"
TELEMETRY_UNIT=cassav4-hardware-telemetry.service

SOURCE_FILES=(
  scripts/loadtest-full-capacity.mjs
  scripts/run-p4-load100-raspberry.sh
  backend/tests/phase-p-validation-preflight.test.mjs
  backend/tests/raspberry-multiprocess-deploy-static.test.mjs
  deploy/raspberry-final/README.md
  deploy/raspberry-final/cassav4-hardware-telemetry.sh
  deploy/raspberry-final/cassav4-hardware-telemetry.service
  deploy/raspberry-final/cassav4-p4-crash-forensics.sh
  deploy/raspberry-final/install-p4-observability.sh
  FASE_P4_PACED100_AUTOPRINT_COMPARISON_INTERRUPTED_20260710.md
)

SYSTEM_SOURCES=(
  deploy/raspberry-final/cassav4-hardware-telemetry.sh
  deploy/raspberry-final/cassav4-hardware-telemetry.service
  deploy/raspberry-final/cassav4-p4-crash-forensics.sh
)
SYSTEM_TARGETS=(
  "$SYSTEM_ROOT/usr/local/libexec/cassav4-hardware-telemetry"
  "$SYSTEM_ROOT/etc/systemd/system/cassav4-hardware-telemetry.service"
  "$SYSTEM_ROOT/usr/local/sbin/cassav4-p4-crash-forensics"
)
SYSTEM_MODES=(0755 0644 0755)

if [[ ! "$DRY_RUN" =~ ^[01]$ ]] || [[ ! "$REQUIRE_LIVE_HEALTH" =~ ^[01]$ ]]; then
  printf 'P4_OBSERVABILITY_DRY_RUN e P4_OBSERVABILITY_REQUIRE_LIVE_HEALTH accettano solo 0 o 1.\n' >&2
  exit 2
fi

for relative_path in "${SOURCE_FILES[@]}"; do
  if [[ ! -f "$SOURCE_ROOT/$relative_path" ]]; then
    printf 'Sorgente osservabilita P4 mancante: %s\n' "$SOURCE_ROOT/$relative_path" >&2
    exit 2
  fi
done

if (( DRY_RUN == 1 )); then
  printf 'P4 observability dry-run\nsource=%s\ntarget=%s\nbackup=%s\n' "$SOURCE_ROOT" "$TARGET_ROOT" "$BACKUP_ROOT"
  for relative_path in "${SOURCE_FILES[@]}"; do
    printf 'source-install %s -> %s\n' "$SOURCE_ROOT/$relative_path" "$TARGET_ROOT/$relative_path"
  done
  for index in "${!SYSTEM_SOURCES[@]}"; do
    printf 'system-install mode=%s %s -> %s\n' "${SYSTEM_MODES[$index]}" "$SOURCE_ROOT/${SYSTEM_SOURCES[$index]}" "${SYSTEM_TARGETS[$index]}"
  done
  printf 'services_restart=none\ntelemetry_enable=%s\n' "$TELEMETRY_UNIT"
  exit 0
fi

if (( EUID != 0 )); then
  printf 'install-p4-observability.sh deve essere eseguito come root.\n' >&2
  exit 1
fi
for required_bin in "$NODE_BIN" "$SYSTEMCTL_BIN" "$CURL_BIN"; do
  if [[ ! -x "$required_bin" ]]; then
    printf 'Binario deploy non eseguibile: %s\n' "$required_bin" >&2
    exit 2
  fi
done

TELEMETRY_WAS_ACTIVE=$($SYSTEMCTL_BIN is-active "$TELEMETRY_UNIT" 2>/dev/null || true)
TELEMETRY_WAS_ENABLED=$($SYSTEMCTL_BIN is-enabled "$TELEMETRY_UNIT" 2>/dev/null || true)
INSTALL_STARTED=0

restore_file() {
  local backup=$1
  local target=$2
  if [[ -e "$backup" ]]; then
    install -d -m 0750 "$(dirname -- "$target")"
    cp -a "$backup" "$target"
  else
    rm -f "$target"
  fi
}

rollback() {
  local status=$?
  trap - ERR
  set +e
  if (( INSTALL_STARTED == 1 )); then
    for relative_path in "${SOURCE_FILES[@]}"; do
      restore_file "$BACKUP_ROOT/source/$relative_path" "$TARGET_ROOT/$relative_path"
    done
    for index in "${!SYSTEM_TARGETS[@]}"; do
      restore_file "$BACKUP_ROOT/system/$index" "${SYSTEM_TARGETS[$index]}"
    done
    "$SYSTEMCTL_BIN" daemon-reload
    if [[ "$TELEMETRY_WAS_ENABLED" == enabled ]]; then
      "$SYSTEMCTL_BIN" enable "$TELEMETRY_UNIT" >/dev/null 2>&1 || true
    else
      "$SYSTEMCTL_BIN" disable "$TELEMETRY_UNIT" >/dev/null 2>&1 || true
    fi
    if [[ "$TELEMETRY_WAS_ACTIVE" == active ]]; then
      "$SYSTEMCTL_BIN" start "$TELEMETRY_UNIT" || true
    else
      "$SYSTEMCTL_BIN" stop "$TELEMETRY_UNIT" || true
    fi
  fi
  printf 'Deploy osservabilita P4 fallito; rollback completato da %s.\n' "$BACKUP_ROOT" >&2
  exit "$status"
}
trap rollback ERR

install -d -m 0750 "$BACKUP_ROOT/source" "$BACKUP_ROOT/system"
INSTALL_STARTED=1
for relative_path in "${SOURCE_FILES[@]}"; do
  target_path="$TARGET_ROOT/$relative_path"
  if [[ -e "$target_path" ]]; then
    install -d -m 0750 "$BACKUP_ROOT/source/$(dirname -- "$relative_path")"
    cp -a "$target_path" "$BACKUP_ROOT/source/$relative_path"
  fi
done
for index in "${!SYSTEM_TARGETS[@]}"; do
  target_path=${SYSTEM_TARGETS[$index]}
  if [[ -e "$target_path" ]]; then
    cp -a "$target_path" "$BACKUP_ROOT/system/$index"
  fi
done

for relative_path in "${SOURCE_FILES[@]}"; do
  mode=0640
  [[ "$relative_path" == *.sh ]] && mode=0750
  install -D -m "$mode" -o "$RUN_USER" -g "$RUN_GROUP" "$SOURCE_ROOT/$relative_path" "$TARGET_ROOT/$relative_path"
done
for index in "${!SYSTEM_TARGETS[@]}"; do
  install -D -m "${SYSTEM_MODES[$index]}" -o root -g root "$SOURCE_ROOT/${SYSTEM_SOURCES[$index]}" "${SYSTEM_TARGETS[$index]}"
done

"$SYSTEMCTL_BIN" daemon-reload
"$SYSTEMCTL_BIN" enable --now "$TELEMETRY_UNIT"
"$SYSTEMCTL_BIN" is-active --quiet "$TELEMETRY_UNIT"

cd "$TARGET_ROOT"
"$NODE_BIN" --check scripts/loadtest-full-capacity.mjs
"$NODE_BIN" --test --test-isolation=none \
  backend/tests/phase-p-validation-preflight.test.mjs \
  backend/tests/raspberry-multiprocess-deploy-static.test.mjs

P4_PREFLIGHT_ONLY=1 \
P4_CONTROL_LOG_DIR="$PREFLIGHT_LOG_ROOT/p4-observability-preflight-$TIMESTAMP" \
"$TARGET_ROOT/scripts/run-p4-load100-raspberry.sh"

health_failure=0
for port in 5281 5282 5283 5284 5285; do
  if ! "$CURL_BIN" -fsS --max-time 3 "http://127.0.0.1:$port/api/health" >/dev/null; then
    printf 'Health backend non disponibile sulla porta %s.\n' "$port" >&2
    health_failure=1
  fi
done
if ! "$CURL_BIN" -kfsS --max-time 5 https://127.0.0.1:5280/mobile/ >/dev/null; then
  printf 'Frontend HTTPS non disponibile sulla porta 5280.\n' >&2
  health_failure=1
fi
if (( REQUIRE_LIVE_HEALTH == 1 && health_failure != 0 )); then
  false
fi

install -d -m 0750 "$(dirname -- "$INSTALL_REPORT")"
{
  printf 'installed_at=%s\n' "$(date --iso-8601=seconds)"
  printf 'source_root=%s\n' "$SOURCE_ROOT"
  printf 'target_root=%s\n' "$TARGET_ROOT"
  printf 'backup_root=%s\n' "$BACKUP_ROOT"
  printf 'telemetry_status=%s\n' "$($SYSTEMCTL_BIN is-active "$TELEMETRY_UNIT")"
  printf 'live_health=%s\n' "$([[ $health_failure == 0 ]] && printf ok || printf degraded)"
  sha256sum "${SYSTEM_TARGETS[@]}"
} > "$INSTALL_REPORT"
chmod 0640 "$INSTALL_REPORT"
sync -d "$INSTALL_REPORT" 2>/dev/null || true

trap - ERR
printf 'Deploy osservabilita P4 completato. backup=%s report=%s\n' "$BACKUP_ROOT" "$INSTALL_REPORT"
