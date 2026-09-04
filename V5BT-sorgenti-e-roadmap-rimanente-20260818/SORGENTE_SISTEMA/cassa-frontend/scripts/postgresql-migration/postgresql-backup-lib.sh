#!/usr/bin/env bash
set -Eeuo pipefail

CASSAV6_BACKUP_ROOT="${CASSAV6_BACKUP_ROOT:-/var/backups/cassav6-postgresql}"
CASSAV6_PG_VERSION="${PG_VERSION:-17}"
CASSAV6_PG_CLUSTER="${PG_CLUSTER:-main}"
CASSAV6_PG_PORT="${PG_PORT:-5432}"
CASSAV6_PG_DATABASE="${PG_DATABASE:-cassav6}"
CASSAV6_PG_MIGRATION_ROLE="${PG_MIGRATION_ROLE:-cassav6_migrator}"
CASSAV6_PG_BIN="/usr/lib/postgresql/${CASSAV6_PG_VERSION}/bin"
CASSAV6_PG_SOCKET_DIR="/var/run/postgresql"
CASSAV6_BACKUP_MARKER=".cassav6-postgresql-backup-root"
CASSAV6_BACKUP_MARKER_CONTENT="cassav6-postgresql-backup-root-v1"

cassav6_die() {
  echo "ERRORE: $*" >&2
  exit 1
}

cassav6_require_root() {
  [[ ${EUID} -eq 0 ]] || cassav6_die "eseguire come root (sudo)."
}

cassav6_require_command() {
  command -v "$1" >/dev/null 2>&1 || cassav6_die "comando richiesto non trovato: $1"
}

cassav6_is_safe_identifier() {
  [[ "$1" =~ ^[a-z_][a-z0-9_]*$ && ${#1} -le 63 ]]
}

cassav6_require_identifier() {
  local label="$1"
  local value="$2"
  cassav6_is_safe_identifier "$value" || cassav6_die "${label} non e un identificatore PostgreSQL sicuro."
}

cassav6_require_uint_range() {
  local label="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"
  [[ "$value" =~ ^[0-9]+$ ]] || cassav6_die "${label} deve essere un intero."
  (( value >= minimum && value <= maximum )) || cassav6_die "${label} deve essere fra ${minimum} e ${maximum}."
}

cassav6_normalize_backup_root() {
  local candidate="$1"
  [[ "$candidate" == /* ]] || cassav6_die "CASSAV6_BACKUP_ROOT deve essere assoluto."
  [[ "$candidate" != *$'\n'* && "$candidate" != *$'\r'* ]] || cassav6_die "CASSAV6_BACKUP_ROOT contiene caratteri non validi."
  local normalized
  normalized="$(realpath -m -- "$candidate")"
  case "$normalized" in
    /|/var|/var/backups|/home|/root|/mnt|/media)
      cassav6_die "CASSAV6_BACKUP_ROOT e troppo ampio: ${normalized}"
      ;;
  esac
  printf '%s\n' "$normalized"
}

cassav6_prepare_backup_tree() {
  local normalized
  normalized="$(cassav6_normalize_backup_root "$CASSAV6_BACKUP_ROOT")"
  [[ ! -L "$normalized" ]] || cassav6_die "la radice backup non puo essere un link simbolico."

  install -d -m 0750 -o root -g postgres "$normalized"
  CASSAV6_BACKUP_ROOT="$(realpath -e -- "$normalized")"

  local marker="$CASSAV6_BACKUP_ROOT/$CASSAV6_BACKUP_MARKER"
  if [[ -e "$marker" ]]; then
    [[ -f "$marker" && ! -L "$marker" ]] || cassav6_die "marker backup non valido."
    [[ "$(<"$marker")" == "$CASSAV6_BACKUP_MARKER_CONTENT" ]] || cassav6_die "marker backup inatteso."
  else
    umask 0077
    printf '%s\n' "$CASSAV6_BACKUP_MARKER_CONTENT" > "$marker"
    chown root:root "$marker"
    chmod 0644 "$marker"
  fi

  install -d -m 0700 -o root -g root "$CASSAV6_BACKUP_ROOT/logical"
  install -d -m 0700 -o postgres -g postgres "$CASSAV6_BACKUP_ROOT/base"
  install -d -m 0700 -o postgres -g postgres "$CASSAV6_BACKUP_ROOT/wal"
  install -d -m 0700 -o postgres -g postgres "$CASSAV6_BACKUP_ROOT/restore-work"
  install -d -m 0700 -o root -g root "$CASSAV6_BACKUP_ROOT/reports"
}

cassav6_assert_backup_tree() {
  local normalized
  normalized="$(cassav6_normalize_backup_root "$CASSAV6_BACKUP_ROOT")"
  [[ -d "$normalized" && ! -L "$normalized" ]] || cassav6_die "radice backup assente o non sicura."
  CASSAV6_BACKUP_ROOT="$(realpath -e -- "$normalized")"
  local marker="$CASSAV6_BACKUP_ROOT/$CASSAV6_BACKUP_MARKER"
  [[ -f "$marker" && ! -L "$marker" ]] || cassav6_die "marker backup assente."
  [[ "$(<"$marker")" == "$CASSAV6_BACKUP_MARKER_CONTENT" ]] || cassav6_die "marker backup inatteso."
}

cassav6_require_pg_tools() {
  local tool
  for tool in psql pg_dump pg_restore pg_basebackup pg_verifybackup pg_ctl pg_archivecleanup; do
    [[ -x "$CASSAV6_PG_BIN/$tool" ]] || cassav6_die "tool PostgreSQL mancante: $CASSAV6_PG_BIN/$tool"
  done
  cassav6_require_command runuser
  cassav6_require_command sha256sum
  cassav6_require_command flock
}

cassav6_as_postgres() {
  runuser -u postgres -- "$@"
}

cassav6_psql() {
  local database="$1"
  shift
  cassav6_as_postgres "$CASSAV6_PG_BIN/psql" \
    --host="$CASSAV6_PG_SOCKET_DIR" \
    --port="$CASSAV6_PG_PORT" \
    --username=postgres \
    --dbname="$database" \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 \
    "$@"
}

cassav6_database_exists() {
  local database="$1"
  [[ "$(cassav6_psql postgres --tuples-only --no-align --command="SELECT 1 FROM pg_database WHERE datname = '${database}'")" == "1" ]]
}

cassav6_drop_database_if_exists() {
  local database="$1"
  cassav6_require_identifier "database temporaneo" "$database"
  cassav6_psql postgres --quiet --command="SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid();" >/dev/null
  cassav6_psql postgres --quiet --command="DROP DATABASE IF EXISTS ${database};" >/dev/null
}

cassav6_elapsed_ms() {
  local started_ns="$1"
  local ended_ns="$2"
  printf '%s\n' "$(( (ended_ns - started_ns) / 1000000 ))"
}

cassav6_json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

cassav6_write_sha256_sidecar() {
  local artifact="$1"
  local sidecar="$2"
  local digest
  digest="$(sha256sum -- "$artifact" | awk '{print $1}')"
  umask 0077
  printf '%s  %s\n' "$digest" "$(basename -- "$artifact")" > "$sidecar"
  chmod 0600 "$sidecar"
  printf '%s\n' "$digest"
}

cassav6_verify_sha256_sidecar() {
  local artifact="$1"
  local sidecar="${artifact}.sha256"
  [[ -f "$sidecar" && ! -L "$sidecar" ]] || cassav6_die "checksum assente: ${sidecar}"
  local expected remainder actual
  read -r expected remainder < "$sidecar"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || cassav6_die "checksum non valido: ${sidecar}"
  [[ "$remainder" == "$(basename -- "$artifact")" ]] || cassav6_die "il checksum non punta all'archivio selezionato."
  actual="$(sha256sum -- "$artifact" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || cassav6_die "checksum archivio non valido."
}

cassav6_prune_logical_backups() {
  local database="$1"
  local retention="$2"
  cassav6_require_identifier "database" "$database"
  cassav6_require_uint_range "retention logica" "$retention" 1 365
  local directory="$CASSAV6_BACKUP_ROOT/logical"
  local -a names=()
  mapfile -t names < <(find "$directory" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | \
    awk -v prefix="logical-${database}-" 'index($0, prefix) == 1 && $0 ~ /[0-9]{8}T[0-9]{6}Z[.]dump$/ { print }' | \
    LC_ALL=C sort -r)

  local index name path
  for (( index=retention; index<${#names[@]}; index++ )); do
    name="${names[$index]}"
    [[ "$name" =~ ^logical-${database}-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || cassav6_die "nome backup inatteso durante retention: ${name}"
    path="$directory/$name"
    [[ "$(realpath -e -- "$path")" == "$directory/$name" ]] || cassav6_die "backup fuori dalla directory prevista."
    rm -f -- "$path" "${path}.sha256" "${path%.dump}.json"
  done
}

cassav6_base_start_wal() {
  local backup_directory="$1"
  sed -n 's/^START WAL LOCATION:.*(file \([0-9A-F]\{24\}\)).*$/\1/p' "$backup_directory/backup_label" | head -n 1
}

cassav6_prune_base_backups() {
  local retention="$1"
  cassav6_require_uint_range "retention base backup" "$retention" 1 52
  local directory="$CASSAV6_BACKUP_ROOT/base"
  local -a names=()
  mapfile -t names < <(find "$directory" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | \
    awk '$0 ~ /^base-[0-9]{8}T[0-9]{6}Z$/ { print }' | LC_ALL=C sort -r)

  local index name path resolved
  for (( index=retention; index<${#names[@]}; index++ )); do
    name="${names[$index]}"
    [[ "$name" =~ ^base-[0-9]{8}T[0-9]{6}Z$ ]] || cassav6_die "nome base backup inatteso: ${name}"
    path="$directory/$name"
    resolved="$(realpath -e -- "$path")"
    [[ "$(dirname -- "$resolved")" == "$directory" ]] || cassav6_die "base backup fuori dalla directory prevista."
    rm -rf --one-file-system -- "$resolved"
    rm -f -- "$directory/${name}.json"
  done

  mapfile -t names < <(find "$directory" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | \
    awk '$0 ~ /^base-[0-9]{8}T[0-9]{6}Z$/ { print }' | LC_ALL=C sort)
  if (( ${#names[@]} > 0 )); then
    local oldest="$directory/${names[0]}"
    local oldest_wal
    oldest_wal="$(cassav6_base_start_wal "$oldest")"
    [[ "$oldest_wal" =~ ^[0-9A-F]{24}$ ]] || cassav6_die "START WAL non leggibile dal base backup piu vecchio."
    cassav6_as_postgres "$CASSAV6_PG_BIN/pg_archivecleanup" "$CASSAV6_BACKUP_ROOT/wal" "$oldest_wal"
  fi
}
