#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postgresql-backup-lib.sh
source "$SCRIPT_DIR/postgresql-backup-lib.sh"

cassav6_require_root
cassav6_require_uint_range "PG_PORT" "$CASSAV6_PG_PORT" 1 65535
cassav6_require_pg_tools
cassav6_prepare_backup_tree

retention="${CASSAV6_BASE_RETENTION:-2}"
cassav6_require_uint_range "CASSAV6_BASE_RETENTION" "$retention" 1 52

lock_path="$CASSAV6_BACKUP_ROOT/.base-backup.lock"
exec 9> "$lock_path"
chmod 0600 "$lock_path"
flock -n 9 || cassav6_die "un base backup e gia in esecuzione."

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
directory="$CASSAV6_BACKUP_ROOT/base"
base_name="base-${timestamp}"
final_path="$directory/$base_name"
[[ ! -e "$final_path" ]] || cassav6_die "esiste gia un base backup con lo stesso timestamp."

temp_path="$(mktemp -d "$directory/.${base_name}.XXXXXX")"
chown postgres:postgres "$temp_path"
chmod 0700 "$temp_path"
cleanup() {
  [[ -z "$temp_path" ]] || rm -rf --one-file-system -- "$temp_path"
}
trap cleanup EXIT

started_ns="$(date +%s%N)"
PGAPPNAME="cassav6-base-backup" cassav6_as_postgres "$CASSAV6_PG_BIN/pg_basebackup" \
  --host="$CASSAV6_PG_SOCKET_DIR" \
  --port="$CASSAV6_PG_PORT" \
  --username=postgres \
  --pgdata="$temp_path" \
  --format=plain \
  --wal-method=stream \
  --checkpoint=spread \
  --manifest-checksums=SHA256 \
  --label="cassav6-${timestamp}" \
  --no-password

[[ -s "$temp_path/backup_manifest" && -s "$temp_path/backup_label" ]] || cassav6_die "base backup incompleto."
cassav6_as_postgres "$CASSAV6_PG_BIN/pg_verifybackup" "$temp_path"
mv -- "$temp_path" "$final_path"
temp_path=""

ended_ns="$(date +%s%N)"
duration_ms="$(cassav6_elapsed_ms "$started_ns" "$ended_ns")"
size_bytes="$(du -sb -- "$final_path" | awk '{print $1}')"
server_version="$(cassav6_psql postgres --tuples-only --no-align --command='SHOW server_version')"
start_wal="$(cassav6_base_start_wal "$final_path")"
[[ "$start_wal" =~ ^[0-9A-F]{24}$ ]] || cassav6_die "START WAL non trovato nel base backup."

metadata_path="$directory/${base_name}.json"
umask 0077
cat > "$metadata_path" <<JSON
{
  "kind": "physical-base",
  "created_at_utc": "${timestamp}",
  "postgresql_version": "$(cassav6_json_escape "$server_version")",
  "format": "plain",
  "wal_method": "stream",
  "manifest_checksums": "SHA256",
  "start_wal": "${start_wal}",
  "bytes": ${size_bytes},
  "duration_ms": ${duration_ms}
}
JSON
chmod 0600 "$metadata_path"

cassav6_prune_base_backups "$retention"
trap - EXIT

printf 'BASE_BACKUP_PATH=%s\n' "$final_path"
printf 'BASE_BACKUP_START_WAL=%s\n' "$start_wal"
printf 'BASE_BACKUP_BYTES=%s\n' "$size_bytes"
printf 'BASE_BACKUP_DURATION_MS=%s\n' "$duration_ms"
