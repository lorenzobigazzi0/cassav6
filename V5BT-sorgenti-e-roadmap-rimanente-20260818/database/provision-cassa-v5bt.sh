#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATABASE_DIR="$ROOT/database"
source "$ROOT/tools/v5bt-node-runtime.sh"
NODE_BIN="$(resolve_v5bt_node_bin "$ROOT")"
RUNTIME_DIR="$ROOT/.runtime/cassav5bt"
DATA_DIR="$RUNTIME_DIR/data"
SECRETS_FILE="$RUNTIME_DIR/v5bt.env"
SEED_FILE="$DATABASE_DIR/cassav5bt_production_seed_20260719.sql.gz"
RELATIONAL_SOURCE="$ROOT/BASELINE_SERVER_RASPBERRY/database/sqlite/backend-relational.sqlite"
APP_STATE_SPLIT_SOURCE="$ROOT/BASELINE_SERVER_RASPBERRY/database/sqlite/app-state-split.sqlite"
RELATIONAL_TARGET="$DATA_DIR/backend-relational.sqlite"
APP_STATE_SPLIT_TARGET="$DATA_DIR/app-state-split.sqlite"

DATABASE_NAME="cassa_v5bt"
APP_USER="cassa_v5bt_app"
APP_HOST="127.0.0.1"

SEED_SHA256="9c1bcdd6095c669440a524987dc173874edd6186f64571eb98788f957ec613f8"
RELATIONAL_SHA256="8e370904d58d4ccfa9068331920f4de91f2e083484a5fa55fdd7d11bb1f0723e"
APP_STATE_SPLIT_SHA256="71a54689bec8818c3adccd0ed3b24847e7ce2137d34235ff9943aac751760d22"
EXPECTED_PRODUCTION_TABLES=480

if (( EUID == 0 )); then
  echo "Esegui questo script come utente normale; chiedera sudo solo per MySQL." >&2
  exit 1
fi

case "${DATABASE_NAME,,}" in
  cassa|cassav4)
    echo "Operazione bloccata: '$DATABASE_NAME' appartiene a un'installazione precedente." >&2
    exit 1
    ;;
esac

for value in "$DATABASE_NAME" "$APP_USER"; do
  if [[ ! "$value" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "Identificatore MySQL non valido: '$value'." >&2
    exit 1
  fi
done

if [[ "${APP_USER,,}" == "cassa_app" ]]; then
  echo "Operazione bloccata: V5BT richiede un utente MySQL dedicato." >&2
  exit 1
fi

for command_name in \
  awk chmod flock gzip id install mkdir mktemp mysql mv openssl sha256sum \
  stat sudo zgrep; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Comando richiesto non trovato: $command_name" >&2
    exit 1
  fi
done

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Runtime Node V5BT non trovato: $NODE_BIN" >&2
  exit 1
fi

for required_file in "$SEED_FILE" "$RELATIONAL_SOURCE" "$APP_STATE_SPLIT_SOURCE"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Sorgente V5BT mancante: $required_file" >&2
    exit 1
  fi
done

mkdir -p "$RUNTIME_DIR" "$DATA_DIR"
chmod 700 "$RUNTIME_DIR" "$DATA_DIR"
exec 9>"$RUNTIME_DIR/provision.lock"
if ! flock -n 9; then
  echo "Un altro provisioning V5BT e in corso." >&2
  exit 1
fi

verify_hash() {
  local expected="$1"
  local file_path="$2"
  local actual
  actual="$(sha256sum "$file_path" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "SHA-256 non valido per $file_path" >&2
    exit 1
  fi
}

echo "Verifica delle copie di produzione V5BT..."
verify_hash "$SEED_SHA256" "$SEED_FILE"
verify_hash "$RELATIONAL_SHA256" "$RELATIONAL_SOURCE"
verify_hash "$APP_STATE_SPLIT_SHA256" "$APP_STATE_SPLIT_SOURCE"
"$NODE_BIN" --no-warnings "$ROOT/tools/v5bt-sqlite-quick-check.mjs" \
  "$RELATIONAL_SOURCE" "$APP_STATE_SPLIT_SOURCE"
gzip --test "$SEED_FILE"

create_table_count="$(zgrep -c '^CREATE TABLE' "$SEED_FILE")"
if [[ "$create_table_count" != "$EXPECTED_PRODUCTION_TABLES" ]]; then
  echo "Dump inatteso: attese $EXPECTED_PRODUCTION_TABLES CREATE TABLE, trovate $create_table_count." >&2
  exit 1
fi
if zgrep -Eq '^(CREATE DATABASE|USE[[:space:]])' "$SEED_FILE"; then
  echo "Dump non isolabile: contiene CREATE DATABASE o USE." >&2
  exit 1
fi

if [[ "${CASSAV5BT_PROVISION_PREFLIGHT_ONLY:-0}" == "1" ]]; then
  echo "Preflight provisioning V5BT superato: dump e copie SQLite integri."
  exit 0
fi

create_secrets_file() {
  [[ ! -e "$SECRETS_FILE" ]] || return 0
  local temporary_file
  temporary_file="$(mktemp "$RUNTIME_DIR/.v5bt.env.XXXXXX")"
  chmod 600 "$temporary_file"
  {
    printf 'CASSAV5BT_MYSQL_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'CASSAV5BT_BACKEND_TOKEN_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'CASSAV5BT_INTEGRATION_SERVICE_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'CASSAV5BT_SMART_CARD_PUSH_TOKEN=%s\n' "$(openssl rand -hex 32)"
  } >"$temporary_file"
  mv "$temporary_file" "$SECRETS_FILE"
}

create_secrets_file
if [[ "$(stat -c '%a' "$SECRETS_FILE")" != "600" ||
      "$(stat -c '%u' "$SECRETS_FILE")" != "$(id -u)" ]]; then
  echo "File segreti V5BT non sicuro: $SECRETS_FILE" >&2
  exit 1
fi

APP_PASSWORD=""
declare -A SECRETS_SEEN=()
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  case "$key" in
    CASSAV5BT_MYSQL_PASSWORD|CASSAV5BT_BACKEND_TOKEN_SECRET|\
    CASSAV5BT_INTEGRATION_SERVICE_TOKEN|CASSAV5BT_SMART_CARD_PUSH_TOKEN)
      ;;
    *)
      echo "Chiave non prevista nel file segreti V5BT: '$key'." >&2
      exit 1
      ;;
  esac
  if [[ -n "${SECRETS_SEEN[$key]:-}" ]]; then
    echo "Chiave duplicata nel file segreti V5BT: '$key'." >&2
    exit 1
  fi
  if [[ ! "$value" =~ ^[0-9A-Fa-f]{64,128}$ ]]; then
    echo "Valore non valido nel file segreti V5BT." >&2
    exit 1
  fi
  SECRETS_SEEN["$key"]=1
  if [[ "$key" == "CASSAV5BT_MYSQL_PASSWORD" ]]; then
    APP_PASSWORD="$value"
  fi
done <"$SECRETS_FILE"
for required_secret in \
  CASSAV5BT_MYSQL_PASSWORD \
  CASSAV5BT_BACKEND_TOKEN_SECRET \
  CASSAV5BT_INTEGRATION_SERVICE_TOKEN \
  CASSAV5BT_SMART_CARD_PUSH_TOKEN; do
  if [[ -z "${SECRETS_SEEN[$required_secret]:-}" ]]; then
    echo "Chiave mancante nel file segreti V5BT: '$required_secret'." >&2
    exit 1
  fi
done

echo "E richiesta l'autorizzazione amministrativa locale per MySQL."
sudo -v
MYSQL_ADMIN=(sudo mysql --no-defaults --protocol=socket -N -B)

schema_exists="$("${MYSQL_ADMIN[@]}" -e \
  "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${DATABASE_NAME}'")"
schema_table_count=0
marker_hash=""
if [[ "$schema_exists" == "1" ]]; then
  schema_table_count="$("${MYSQL_ADMIN[@]}" -e \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DATABASE_NAME}'")"
  marker_exists="$("${MYSQL_ADMIN[@]}" -e \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DATABASE_NAME}' AND table_name='cassav5bt_provisioning_marker'")"
  if [[ "$marker_exists" == "1" ]]; then
    marker_hash="$("${MYSQL_ADMIN[@]}" "$DATABASE_NAME" -e \
      "SELECT source_sha256 FROM cassav5bt_provisioning_marker WHERE id=1")"
  fi
fi

already_provisioned=0
if [[ "$marker_hash" == "$SEED_SHA256" ]]; then
  imported_table_count="$("${MYSQL_ADMIN[@]}" -e \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DATABASE_NAME}' AND table_type='BASE TABLE' AND table_name<>'cassav5bt_provisioning_marker'")"
  if [[ "$imported_table_count" != "$EXPECTED_PRODUCTION_TABLES" ]]; then
    echo "Marker V5BT presente ma numero tabelle inatteso: $imported_table_count." >&2
    exit 1
  fi
  already_provisioned=1
elif [[ "$schema_table_count" != "0" ]]; then
  echo "Importazione bloccata: '$DATABASE_NAME' contiene gia $schema_table_count tabelle senza marker valido." >&2
  exit 1
fi

install_sqlite_copy() {
  local source_path="$1"
  local target_path="$2"
  local expected_hash="$3"
  if [[ -e "$target_path" ]]; then
    verify_hash "$expected_hash" "$target_path"
    return 0
  fi
  install -m 600 "$source_path" "$target_path"
  verify_hash "$expected_hash" "$target_path"
}

verify_runtime_sqlite() {
  local target_path="$1"
  if [[ ! -f "$target_path" ]]; then
    echo "Schema gia marcato ma copia SQLite mancante: $target_path" >&2
    exit 1
  fi
  if [[ "$(stat -c '%a' "$target_path")" != "600" ||
        "$(stat -c '%u' "$target_path")" != "$(id -u)" ]]; then
    echo "Copia SQLite V5BT con proprietario o permessi non sicuri: $target_path" >&2
    exit 1
  fi
  if ! "$NODE_BIN" --no-warnings \
    "$ROOT/tools/v5bt-sqlite-quick-check.mjs" "$target_path"; then
    echo "quick_check SQLite V5BT fallito: $target_path" >&2
    exit 1
  fi
}

if [[ "$already_provisioned" == "0" ]]; then
  if [[ "$schema_exists" == "0" ]]; then
    "${MYSQL_ADMIN[@]}" -e \
      "CREATE DATABASE \`${DATABASE_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
  fi

  existing_user="$("${MYSQL_ADMIN[@]}" -e \
    "SELECT COUNT(*) FROM mysql.user WHERE user='${APP_USER}' AND host='${APP_HOST}'")"
  if [[ "$existing_user" != "0" ]]; then
    echo "Provisioning bloccato: l'utente dedicato '${APP_USER}'@'${APP_HOST}' esiste gia senza marker V5BT." >&2
    exit 1
  fi

  echo "Importazione delle 480 tabelle di produzione in '$DATABASE_NAME'..."
  if ! gzip --decompress --stdout "$SEED_FILE" |
    "${MYSQL_ADMIN[@]}" "$DATABASE_NAME"; then
    echo "Importazione interrotta. Il marker non e stato creato e start-v5bt.sh restera bloccato." >&2
    exit 1
  fi

  imported_table_count="$("${MYSQL_ADMIN[@]}" -e \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DATABASE_NAME}' AND table_type='BASE TABLE'")"
  if [[ "$imported_table_count" != "$EXPECTED_PRODUCTION_TABLES" ]]; then
    echo "Verifica fallita: attese 480 tabelle, trovate $imported_table_count." >&2
    exit 1
  fi

  install_sqlite_copy "$RELATIONAL_SOURCE" "$RELATIONAL_TARGET" "$RELATIONAL_SHA256"
  install_sqlite_copy "$APP_STATE_SPLIT_SOURCE" "$APP_STATE_SPLIT_TARGET" "$APP_STATE_SPLIT_SHA256"

  "${MYSQL_ADMIN[@]}" "$DATABASE_NAME" -e \
    "CREATE TABLE cassav5bt_provisioning_marker (
       id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
       source_sha256 CHAR(64) NOT NULL,
       source_schema VARCHAR(64) NOT NULL,
       source_table_count INT UNSIGNED NOT NULL,
       imported_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
     ) ENGINE=InnoDB;
     INSERT INTO cassav5bt_provisioning_marker
       (id, source_sha256, source_schema, source_table_count)
     VALUES
       (1, '${SEED_SHA256}', 'cassav4', ${EXPECTED_PRODUCTION_TABLES})"
else
  verify_runtime_sqlite "$RELATIONAL_TARGET"
  verify_runtime_sqlite "$APP_STATE_SPLIT_TARGET"
fi

{
  printf "CREATE USER IF NOT EXISTS '%s'@'%s' IDENTIFIED BY '%s';\n" \
    "$APP_USER" "$APP_HOST" "$APP_PASSWORD"
  printf "ALTER USER '%s'@'%s' IDENTIFIED BY '%s';\n" \
    "$APP_USER" "$APP_HOST" "$APP_PASSWORD"
  printf 'GRANT ALL PRIVILEGES ON `%s`.* TO '\''%s'\''@'\''%s'\'';\n' \
    "$DATABASE_NAME" "$APP_USER" "$APP_HOST"
  printf 'FLUSH PRIVILEGES;\n'
} | "${MYSQL_ADMIN[@]}"

verified_marker="$(env MYSQL_PWD="$APP_PASSWORD" \
  mysql --no-defaults --protocol=TCP -h 127.0.0.1 -P 3306 -u "$APP_USER" -N -B "$DATABASE_NAME" \
  -e "SELECT source_sha256 FROM cassav5bt_provisioning_marker WHERE id=1")"
if [[ "$verified_marker" != "$SEED_SHA256" ]]; then
  echo "Verifica finale con l'utente applicativo V5BT fallita." >&2
  exit 1
fi

echo "Database V5BT pronto:"
echo "- schema: $DATABASE_NAME"
echo "- utente dedicato: ${APP_USER}@${APP_HOST}"
echo "- tabelle produzione: $EXPECTED_PRODUCTION_TABLES"
echo "- copie SQLite isolate: $DATA_DIR"
