#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postgresql-backup-lib.sh
source "$SCRIPT_DIR/postgresql-backup-lib.sh"

cassav6_require_root
cassav6_require_uint_range "PG_PORT" "$CASSAV6_PG_PORT" 1 65535
cassav6_require_pg_tools
cassav6_prepare_backup_tree

install_directory="/usr/local/libexec/cassav6-postgresql"
install -d -m 0755 -o root -g root "$install_directory"
for script in \
  postgresql-backup-lib.sh \
  archive-postgresql-wal.sh \
  restore-postgresql-wal.sh \
  backup-postgresql-logical.sh \
  verify-postgresql-logical-restore.sh \
  backup-postgresql-base.sh; do
  [[ -f "$SCRIPT_DIR/$script" && ! -L "$SCRIPT_DIR/$script" ]] || cassav6_die "file installazione mancante: ${script}"
  install -m 0755 -o root -g root "$SCRIPT_DIR/$script" "$install_directory/$script"
done

for unit in \
  cassav6-postgresql-logical-backup.service \
  cassav6-postgresql-logical-backup.timer \
  cassav6-postgresql-base-backup.service \
  cassav6-postgresql-base-backup.timer; do
  [[ -f "$SCRIPT_DIR/systemd/$unit" && ! -L "$SCRIPT_DIR/systemd/$unit" ]] || cassav6_die "unita systemd mancante: ${unit}"
  install -m 0644 -o root -g root "$SCRIPT_DIR/systemd/$unit" "/etc/systemd/system/$unit"
done

config_directory="/etc/postgresql/${CASSAV6_PG_VERSION}/${CASSAV6_PG_CLUSTER}"
[[ -d "$config_directory" ]] || cassav6_die "cluster PostgreSQL non trovato: ${CASSAV6_PG_VERSION}/${CASSAV6_PG_CLUSTER}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
config_backup="$CASSAV6_BACKUP_ROOT/pre-mig013-${timestamp}"
install -d -m 0700 -o root -g root "$config_backup"
cp -a -- "$config_directory" "$config_backup/config"

cassav6_psql postgres <<SQL
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_command = '${install_directory}/archive-postgresql-wal.sh %p %f';
ALTER SYSTEM SET archive_timeout = '300s';
ALTER SYSTEM SET fsync = 'on';
ALTER SYSTEM SET full_page_writes = 'on';
ALTER SYSTEM SET synchronous_commit = 'on';
SQL

systemctl restart "postgresql@${CASSAV6_PG_VERSION}-${CASSAV6_PG_CLUSTER}.service"

settings="$(cassav6_psql postgres --tuples-only --no-align --field-separator='|' --command="SELECT current_setting('fsync'), current_setting('full_page_writes'), current_setting('synchronous_commit'), current_setting('wal_level'), current_setting('archive_mode'), current_setting('archive_command'), current_setting('archive_timeout');")"
expected="on|on|on|replica|on|${install_directory}/archive-postgresql-wal.sh %p %f|5min"
[[ "$settings" == "$expected" ]] || cassav6_die "configurazione PostgreSQL inattesa dopo il riavvio: ${settings}"

systemctl daemon-reload
systemctl enable --now cassav6-postgresql-logical-backup.timer cassav6-postgresql-base-backup.timer >/dev/null
systemd-analyze verify \
  /etc/systemd/system/cassav6-postgresql-logical-backup.service \
  /etc/systemd/system/cassav6-postgresql-logical-backup.timer \
  /etc/systemd/system/cassav6-postgresql-base-backup.service \
  /etc/systemd/system/cassav6-postgresql-base-backup.timer

printf 'CONFIG_BACKUP=%s\n' "$config_backup"
printf 'POSTGRESQL_SETTINGS=%s\n' "$settings"
systemctl list-timers --all --no-pager cassav6-postgresql-logical-backup.timer cassav6-postgresql-base-backup.timer
