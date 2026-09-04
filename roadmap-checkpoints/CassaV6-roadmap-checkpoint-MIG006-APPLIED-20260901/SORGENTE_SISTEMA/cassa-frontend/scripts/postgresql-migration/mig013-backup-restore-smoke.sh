#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postgresql-backup-lib.sh
source "$SCRIPT_DIR/postgresql-backup-lib.sh"

cassav6_require_root
cassav6_require_identifier "PG_MIGRATION_ROLE" "$CASSAV6_PG_MIGRATION_ROLE"
cassav6_require_pg_tools
cassav6_prepare_backup_tree

lock_path="$CASSAV6_BACKUP_ROOT/.mig013-smoke.lock"
exec 8> "$lock_path"
chmod 0600 "$lock_path"
flock -n 8 || cassav6_die "lo smoke MIG-013 e gia in esecuzione."

installed_directory="/usr/local/libexec/cassav6-postgresql"
for script in backup-postgresql-logical.sh verify-postgresql-logical-restore.sh backup-postgresql-base.sh restore-postgresql-wal.sh; do
  [[ -x "$installed_directory/$script" ]] || cassav6_die "script installato mancante: ${script}"
done

settings="$(cassav6_psql postgres --tuples-only --no-align --field-separator='|' --command="SELECT current_setting('fsync'), current_setting('full_page_writes'), current_setting('synchronous_commit'), current_setting('archive_mode');")"
[[ "$settings" == "on|on|on|on" ]] || cassav6_die "durabilita/archiviazione non attiva: ${settings}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
compact_timestamp="${timestamp//[-:TZ]/}"
source_database="cassav6_mig013_smoke"
restore_point="mig013_${compact_timestamp}_$$"
cassav6_require_identifier "database fixture" "$source_database"
cassav6_require_identifier "restore point" "$restore_point"

restore_directory=""
restore_started=0
source_created=0
cleanup() {
  if (( restore_started == 1 )) && [[ -n "$restore_directory" && -f "$restore_directory/postmaster.pid" ]]; then
    cassav6_as_postgres "$CASSAV6_PG_BIN/pg_ctl" -D "$restore_directory" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ -n "$restore_directory" && -d "$restore_directory" ]]; then
    local resolved_restore
    resolved_restore="$(realpath -e -- "$restore_directory")"
    if [[ "$(dirname -- "$resolved_restore")" == "$CASSAV6_BACKUP_ROOT/restore-work" && "$(basename -- "$resolved_restore")" =~ ^\.restore-[0-9]{8}T[0-9]{6}Z\.[A-Za-z0-9]+$ ]]; then
      rm -rf --one-file-system -- "$resolved_restore"
    fi
  fi
  if (( source_created == 1 )); then
    cassav6_drop_database_if_exists "$source_database" || true
  fi
}
trap cleanup EXIT

cassav6_database_exists "$source_database" && cassav6_die "database fixture gia esistente."
cassav6_psql postgres --quiet --command="CREATE DATABASE ${source_database} OWNER ${CASSAV6_PG_MIGRATION_ROLE} ENCODING 'UTF8' TEMPLATE template0;" >/dev/null
source_created=1
cassav6_psql "$source_database" --quiet <<SQL
SET ROLE ${CASSAV6_PG_MIGRATION_ROLE};
CREATE SCHEMA mig013_restore_probe AUTHORIZATION ${CASSAV6_PG_MIGRATION_ROLE};
CREATE TABLE mig013_restore_probe.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stage text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO mig013_restore_probe.events(stage) VALUES ('base_seed');
SQL

logical_output="$(PG_DATABASE="$source_database" CASSAV6_LOGICAL_RETENTION=3 "$installed_directory/backup-postgresql-logical.sh")"
logical_path="$(sed -n 's/^BACKUP_PATH=//p' <<< "$logical_output")"
logical_duration_ms="$(sed -n 's/^BACKUP_DURATION_MS=//p' <<< "$logical_output")"
[[ -n "$logical_path" && -f "$logical_path" ]] || cassav6_die "backup logico di smoke non prodotto."

logical_restore_output="$("$installed_directory/verify-postgresql-logical-restore.sh" \
  --archive "$logical_path" \
  --expect-table mig013_restore_probe.events \
  --expect-rows 1)"
logical_restore_duration_ms="$(sed -n 's/^RESTORE_DURATION_MS=//p' <<< "$logical_restore_output")"
[[ -n "$logical_restore_duration_ms" ]] || cassav6_die "tempo restore logico non rilevato."

base_output="$(CASSAV6_BASE_RETENTION=2 "$installed_directory/backup-postgresql-base.sh")"
base_path="$(sed -n 's/^BASE_BACKUP_PATH=//p' <<< "$base_output")"
base_duration_ms="$(sed -n 's/^BASE_BACKUP_DURATION_MS=//p' <<< "$base_output")"
[[ -n "$base_path" && -d "$base_path" ]] || cassav6_die "base backup di smoke non prodotto."

cassav6_psql "$source_database" --quiet --command="INSERT INTO mig013_restore_probe.events(stage) VALUES ('before_target');" >/dev/null
cassav6_psql postgres --quiet --command="SELECT pg_create_restore_point('${restore_point}');" >/dev/null
cassav6_psql "$source_database" --quiet --command="INSERT INTO mig013_restore_probe.events(stage) VALUES ('after_target');" >/dev/null
required_wal="$(cassav6_psql postgres --tuples-only --no-align --command='SELECT pg_walfile_name(pg_current_wal_lsn())')"
[[ "$required_wal" =~ ^[0-9A-F]{24}$ ]] || cassav6_die "nome WAL corrente inatteso."
cassav6_psql postgres --quiet --command='SELECT pg_switch_wal();' >/dev/null

archive_path="$CASSAV6_BACKUP_ROOT/wal/$required_wal"
for _ in {1..60}; do
  [[ -f "$archive_path" ]] && break
  sleep 1
done
[[ -s "$archive_path" ]] || cassav6_die "WAL richiesto non archiviato entro 60 secondi: ${required_wal}"

pitr_started_ns="$(date +%s%N)"
restore_directory="$(mktemp -d "$CASSAV6_BACKUP_ROOT/restore-work/.restore-${timestamp}.XXXXXX")"
cp -a -- "$base_path/." "$restore_directory/"
chown -R postgres:postgres "$restore_directory"
chmod 0700 "$restore_directory"
socket_directory="$restore_directory/socket"
install -d -m 0700 -o postgres -g postgres "$socket_directory"

cat > "$restore_directory/postgresql.conf" <<'CONF'
# Configurazione minima del clone PITR; il cluster Debian principale usa /etc.
CONF
cat > "$restore_directory/pg_hba.conf" <<'HBA'
local all postgres peer
local all all reject
HBA
: > "$restore_directory/pg_ident.conf"
chown postgres:postgres \
  "$restore_directory/postgresql.conf" \
  "$restore_directory/pg_hba.conf" \
  "$restore_directory/pg_ident.conf"
chmod 0600 \
  "$restore_directory/postgresql.conf" \
  "$restore_directory/pg_hba.conf" \
  "$restore_directory/pg_ident.conf"

restore_port=""
for candidate_port in {55433..55450}; do
  if ! ss -H -ltn "sport = :${candidate_port}" | grep -q .; then
    restore_port="$candidate_port"
    break
  fi
done
[[ -n "$restore_port" ]] || cassav6_die "nessuna porta disponibile per il restore temporaneo."

cat >> "$restore_directory/postgresql.auto.conf" <<CONF
port = '${restore_port}'
listen_addresses = ''
unix_socket_directories = '${socket_directory}'
archive_mode = 'off'
archive_command = ''
restore_command = '${installed_directory}/restore-postgresql-wal.sh %f %p'
recovery_target_name = '${restore_point}'
recovery_target_action = 'promote'
hot_standby = 'off'
CONF
chown postgres:postgres "$restore_directory/postgresql.auto.conf"
install -m 0600 -o postgres -g postgres /dev/null "$restore_directory/recovery.signal"

restore_log="$restore_directory/postgresql.log"
if ! cassav6_as_postgres "$CASSAV6_PG_BIN/pg_ctl" -D "$restore_directory" -l "$restore_log" -w -t 90 start; then
  sed -n '1,200p' "$restore_log" >&2 || true
  cassav6_die "avvio cluster PITR temporaneo fallito."
fi
restore_started=1

in_recovery=""
for _ in {1..90}; do
  if in_recovery="$(cassav6_as_postgres "$CASSAV6_PG_BIN/psql" \
    --host="$socket_directory" --port="$restore_port" --username=postgres --dbname=postgres \
    --no-psqlrc --tuples-only --no-align --command='SELECT pg_is_in_recovery();' 2>/dev/null)"; then
    [[ "$in_recovery" == "f" ]] && break
  fi
  sleep 1
done
if [[ "$in_recovery" != "f" ]]; then
  sed -n '1,200p' "$restore_log" >&2 || true
  cassav6_die "il cluster PITR non e diventato disponibile al target entro 90 secondi."
fi
pitr_ended_ns="$(date +%s%N)"
pitr_restore_duration_ms="$(cassav6_elapsed_ms "$pitr_started_ns" "$pitr_ended_ns")"

restored_stages="$(cassav6_as_postgres "$CASSAV6_PG_BIN/psql" \
  --host="$socket_directory" \
  --port="$restore_port" \
  --username=postgres \
  --dbname="$source_database" \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --tuples-only \
  --no-align \
  --command="SELECT string_agg(stage, ',' ORDER BY stage) FROM mig013_restore_probe.events;")"
[[ "$restored_stages" == "base_seed,before_target" ]] || cassav6_die "PITR non fermato al target atteso: ${restored_stages}"

cassav6_as_postgres "$CASSAV6_PG_BIN/pg_ctl" -D "$restore_directory" -m fast -w stop >/dev/null
restore_started=0

host_name="$(hostname)"
machine="$(uname -m)"
kernel="$(uname -r)"
postgresql_version="$(cassav6_psql postgres --tuples-only --no-align --command='SHOW server_version')"
storage="$(findmnt -n -o SOURCE,FSTYPE,TARGET --target /var/lib/postgresql/${CASSAV6_PG_VERSION}/${CASSAV6_PG_CLUSTER} | tr -s ' ')"
report_path="$CASSAV6_BACKUP_ROOT/reports/mig013-${timestamp}.json"
umask 0077
cat > "$report_path" <<JSON
{
  "task": "MIG-013",
  "scope": "DEV_ONLY",
  "created_at_utc": "${timestamp}",
  "host": "$(cassav6_json_escape "$host_name")",
  "architecture": "$(cassav6_json_escape "$machine")",
  "kernel": "$(cassav6_json_escape "$kernel")",
  "storage": "$(cassav6_json_escape "$storage")",
  "postgresql_version": "$(cassav6_json_escape "$postgresql_version")",
  "dataset": "temporary_mig013_probe",
  "durability": {
    "fsync": "on",
    "full_page_writes": "on",
    "synchronous_commit": "on",
    "archive_mode": "on"
  },
  "logical_backup_duration_ms": ${logical_duration_ms},
  "logical_restore_duration_ms": ${logical_restore_duration_ms},
  "base_backup_duration_ms": ${base_duration_ms},
  "pitr_restore_duration_ms": ${pitr_restore_duration_ms},
  "recovery_target": "named_restore_point",
  "restored_stages": ["base_seed", "before_target"],
  "excluded_after_target": true,
  "production_certified": false
}
JSON
chmod 0600 "$report_path"
report_digest="$(cassav6_write_sha256_sidecar "$report_path" "${report_path}.sha256")"

cassav6_drop_database_if_exists "$source_database"
source_created=0
resolved_restore="$(realpath -e -- "$restore_directory")"
[[ "$(dirname -- "$resolved_restore")" == "$CASSAV6_BACKUP_ROOT/restore-work" ]] || cassav6_die "directory restore inattesa in cleanup."
rm -rf --one-file-system -- "$resolved_restore"
restore_directory=""
trap - EXIT

printf '%s\n' "$logical_output"
printf '%s\n' "$logical_restore_output"
printf '%s\n' "$base_output"
printf 'PITR_RESTORE_DURATION_MS=%s\n' "$pitr_restore_duration_ms"
printf 'PITR_RESTORED_STAGES=%s\n' "$restored_stages"
printf 'REPORT_PATH=%s\n' "$report_path"
printf 'REPORT_SHA256=%s\n' "$report_digest"
