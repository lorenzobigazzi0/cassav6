#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postgresql-backup-lib.sh
source "$SCRIPT_DIR/postgresql-backup-lib.sh"

cassav6_require_root
cassav6_require_identifier "PG_DATABASE" "$CASSAV6_PG_DATABASE"
cassav6_require_uint_range "PG_PORT" "$CASSAV6_PG_PORT" 1 65535
cassav6_require_pg_tools
cassav6_prepare_backup_tree
cassav6_database_exists "$CASSAV6_PG_DATABASE" || cassav6_die "database non trovato: ${CASSAV6_PG_DATABASE}"

retention="${CASSAV6_LOGICAL_RETENTION:-7}"
cassav6_require_uint_range "CASSAV6_LOGICAL_RETENTION" "$retention" 1 365

lock_path="$CASSAV6_BACKUP_ROOT/.logical-backup.lock"
exec 9> "$lock_path"
chmod 0600 "$lock_path"
flock -n 9 || cassav6_die "un backup logico e gia in esecuzione."

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
directory="$CASSAV6_BACKUP_ROOT/logical"
base_name="logical-${CASSAV6_PG_DATABASE}-${timestamp}"
final_path="$directory/${base_name}.dump"
[[ ! -e "$final_path" ]] || cassav6_die "esiste gia un backup con lo stesso timestamp."

temp_path="$(mktemp "$directory/.${base_name}.XXXXXX.dump")"
temp_sha=""
temp_metadata=""
cleanup() {
  [[ -z "$temp_path" ]] || rm -f -- "$temp_path"
  [[ -z "$temp_sha" ]] || rm -f -- "$temp_sha"
  [[ -z "$temp_metadata" ]] || rm -f -- "$temp_metadata"
}
trap cleanup EXIT

started_ns="$(date +%s%N)"
PGAPPNAME="cassav6-logical-backup" cassav6_as_postgres "$CASSAV6_PG_BIN/pg_dump" \
  --host="$CASSAV6_PG_SOCKET_DIR" \
  --port="$CASSAV6_PG_PORT" \
  --username=postgres \
  --dbname="$CASSAV6_PG_DATABASE" \
  --format=custom \
  --compress=zstd:6 \
  --no-owner \
  --no-privileges \
  > "$temp_path"

[[ -s "$temp_path" ]] || cassav6_die "pg_dump ha prodotto un archivio vuoto."
"$CASSAV6_PG_BIN/pg_restore" --list "$temp_path" >/dev/null
chmod 0600 "$temp_path"
sync -f "$temp_path"
mv -- "$temp_path" "$final_path"
temp_path=""

temp_sha="$(mktemp "$directory/.${base_name}.XXXXXX.sha256")"
digest="$(cassav6_write_sha256_sidecar "$final_path" "$temp_sha")"
mv -- "$temp_sha" "${final_path}.sha256"
temp_sha=""

ended_ns="$(date +%s%N)"
duration_ms="$(cassav6_elapsed_ms "$started_ns" "$ended_ns")"
size_bytes="$(stat --format='%s' "$final_path")"
server_version="$(cassav6_psql postgres --tuples-only --no-align --command='SHOW server_version')"

metadata_path="$directory/${base_name}.json"
temp_metadata="$(mktemp "$directory/.${base_name}.XXXXXX.json")"
cat > "$temp_metadata" <<JSON
{
  "kind": "logical",
  "created_at_utc": "${timestamp}",
  "database": "$(cassav6_json_escape "$CASSAV6_PG_DATABASE")",
  "postgresql_version": "$(cassav6_json_escape "$server_version")",
  "format": "custom",
  "compression": "zstd:6",
  "bytes": ${size_bytes},
  "sha256": "${digest}",
  "duration_ms": ${duration_ms}
}
JSON
chmod 0600 "$temp_metadata"
mv -- "$temp_metadata" "$metadata_path"
temp_metadata=""

cassav6_prune_logical_backups "$CASSAV6_PG_DATABASE" "$retention"
trap - EXIT

printf 'BACKUP_PATH=%s\n' "$final_path"
printf 'BACKUP_SHA256=%s\n' "$digest"
printf 'BACKUP_BYTES=%s\n' "$size_bytes"
printf 'BACKUP_DURATION_MS=%s\n' "$duration_ms"
