#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postgresql-backup-lib.sh
source "$SCRIPT_DIR/postgresql-backup-lib.sh"

archive_path=""
expected_table=""
expected_rows=""

while (( $# > 0 )); do
  case "$1" in
    --archive)
      (( $# >= 2 )) || cassav6_die "--archive richiede un percorso."
      archive_path="$2"
      shift 2
      ;;
    --expect-table)
      (( $# >= 2 )) || cassav6_die "--expect-table richiede schema.tabella."
      expected_table="$2"
      shift 2
      ;;
    --expect-rows)
      (( $# >= 2 )) || cassav6_die "--expect-rows richiede un numero."
      expected_rows="$2"
      shift 2
      ;;
    *)
      cassav6_die "argomento sconosciuto: $1"
      ;;
  esac
done

cassav6_require_root
cassav6_require_identifier "PG_MIGRATION_ROLE" "$CASSAV6_PG_MIGRATION_ROLE"
cassav6_require_uint_range "PG_PORT" "$CASSAV6_PG_PORT" 1 65535
cassav6_require_pg_tools
cassav6_assert_backup_tree

logical_directory="$(realpath -e -- "$CASSAV6_BACKUP_ROOT/logical")"
if [[ -z "$archive_path" ]]; then
  archive_path="$(find "$logical_directory" -mindepth 1 -maxdepth 1 -type f -name 'logical-*.dump' -printf '%p\n' | LC_ALL=C sort | tail -n 1)"
fi
[[ -n "$archive_path" && -f "$archive_path" && ! -L "$archive_path" ]] || cassav6_die "archivio logico non trovato."
archive_path="$(realpath -e -- "$archive_path")"
[[ "$(dirname -- "$archive_path")" == "$logical_directory" ]] || cassav6_die "l'archivio deve trovarsi nella directory logica gestita."
[[ "$(basename -- "$archive_path")" =~ ^logical-[a-z_][a-z0-9_]*-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || cassav6_die "nome archivio non conforme."

if [[ -n "$expected_table" || -n "$expected_rows" ]]; then
  [[ -n "$expected_table" && -n "$expected_rows" ]] || cassav6_die "--expect-table e --expect-rows devono essere usati insieme."
  [[ "$expected_table" =~ ^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$ ]] || cassav6_die "tabella attesa non valida."
  expected_schema="${BASH_REMATCH[1]}"
  expected_relation="${BASH_REMATCH[2]}"
  cassav6_require_uint_range "--expect-rows" "$expected_rows" 0 2147483647
fi

cassav6_verify_sha256_sidecar "$archive_path"
"$CASSAV6_PG_BIN/pg_restore" --list "$archive_path" >/dev/null

timestamp="$(date -u +%Y%m%d%H%M%S)"
target_database="cassav6_restore_verify_${timestamp}_$$"
cassav6_require_identifier "database restore" "$target_database"
cassav6_database_exists "$target_database" && cassav6_die "il database temporaneo esiste gia."

created=0
cleanup() {
  if (( created == 1 )); then
    cassav6_drop_database_if_exists "$target_database"
  fi
}
trap cleanup EXIT

cassav6_psql postgres --quiet --command="CREATE DATABASE ${target_database} OWNER ${CASSAV6_PG_MIGRATION_ROLE} ENCODING 'UTF8' TEMPLATE template0;" >/dev/null
created=1

started_ns="$(date +%s%N)"
cassav6_as_postgres "$CASSAV6_PG_BIN/pg_restore" \
  --host="$CASSAV6_PG_SOCKET_DIR" \
  --port="$CASSAV6_PG_PORT" \
  --username=postgres \
  --dbname="$target_database" \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-privileges \
  --role="$CASSAV6_PG_MIGRATION_ROLE" \
  < "$archive_path"
ended_ns="$(date +%s%N)"
duration_ms="$(cassav6_elapsed_ms "$started_ns" "$ended_ns")"

catalog_count="$(cassav6_psql "$target_database" --tuples-only --no-align --command="SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p','v','m','S');")"

if [[ -n "$expected_table" ]]; then
  actual_rows="$(cassav6_psql "$target_database" --tuples-only --no-align --command="SELECT count(*) FROM ${expected_schema}.${expected_relation};")"
  [[ "$actual_rows" == "$expected_rows" ]] || cassav6_die "conteggio inatteso in ${expected_table}: ${actual_rows}, atteso ${expected_rows}."
fi

printf 'RESTORE_DATABASE=%s\n' "$target_database"
printf 'RESTORE_DURATION_MS=%s\n' "$duration_ms"
printf 'RESTORE_CATALOG_OBJECTS=%s\n' "$catalog_count"
[[ -z "$expected_table" ]] || printf 'RESTORE_EXPECTED_ROWS=%s\n' "$expected_rows"

cassav6_drop_database_if_exists "$target_database"
created=0
trap - EXIT
