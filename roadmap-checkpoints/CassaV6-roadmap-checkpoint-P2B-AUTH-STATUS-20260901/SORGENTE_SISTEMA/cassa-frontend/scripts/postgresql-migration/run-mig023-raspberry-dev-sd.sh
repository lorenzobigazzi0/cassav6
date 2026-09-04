#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Eseguire come root sul Raspberry." >&2
  exit 1
fi

RUN_DIR="${1:-}"
MIGRATION_ENV="/etc/cassav6/postgresql-migration.env"
APP_ENV="/etc/cassav6/postgresql-app.env"
SMOKE_DATABASE="${MIG023_DATABASE:-cassav6_mig023_20260831a}"

if [[ -z "$RUN_DIR" || ! -d "$RUN_DIR" ]]; then
  echo "Directory di staging MIG-023 non valida." >&2
  exit 2
fi
if [[ ! "$SMOKE_DATABASE" =~ ^cassav6_mig023_[a-z0-9_]+$ ]]; then
  echo "Nome database temporaneo MIG-023 non valido." >&2
  exit 3
fi
if [[ ! -r "$MIGRATION_ENV" || ! -r "$APP_ENV" ]]; then
  echo "Configurazione PostgreSQL DEV non disponibile." >&2
  exit 4
fi

read_env_value() {
  local file="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

require_identifier() {
  local label="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "${label} non valido." >&2
    exit 5
  fi
}

MIGRATION_USER="$(read_env_value "$MIGRATION_ENV" POSTGRES_USER)"
APP_USER="$(read_env_value "$APP_ENV" POSTGRES_USER)"
RUNTIME_ROLE="$(read_env_value "$APP_ENV" POSTGRES_RUNTIME_ROLE)"
RUNTIME_ROLE="${RUNTIME_ROLE:-cassav6_runtime}"
require_identifier "POSTGRES_USER migration" "$MIGRATION_USER"
require_identifier "POSTGRES_USER app" "$APP_USER"
require_identifier "POSTGRES_RUNTIME_ROLE" "$RUNTIME_ROLE"

cleanup() {
  sudo -u postgres dropdb --if-exists --force "$SMOKE_DATABASE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
sudo -u postgres createdb --owner="$MIGRATION_USER" --encoding=UTF8 --template=template0 "$SMOKE_DATABASE"
sudo -u postgres psql --no-psqlrc --set ON_ERROR_STOP=1 postgres \
  --set database_name="$SMOKE_DATABASE" \
  --set app_user="$APP_USER" \
  --set migration_user="$MIGRATION_USER" <<'SQL' >/dev/null
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO :"app_user";
GRANT CONNECT ON DATABASE :"database_name" TO :"migration_user";
SQL

set -a
# shellcheck disable=SC1090
source "$MIGRATION_ENV"
set +a
POSTGRES_DATABASE="$SMOKE_DATABASE" \
  node "$RUN_DIR/backend/scripts/migrate-postgresql.mjs" >/tmp/mig023-migration-result.json

sudo -u postgres psql --no-psqlrc --set ON_ERROR_STOP=1 "$SMOKE_DATABASE" \
  --set runtime_role="$RUNTIME_ROLE" <<'SQL' >/dev/null
CREATE SCHEMA mig023_probe;
CREATE TABLE mig023_probe.side_effects (
  event_id text NOT NULL,
  idempotency_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON SCHEMA mig023_probe FROM PUBLIC;
REVOKE ALL ON mig023_probe.side_effects FROM PUBLIC;
GRANT USAGE ON SCHEMA mig023_probe TO :"runtime_role";
GRANT SELECT, INSERT ON mig023_probe.side_effects TO :"runtime_role";
SQL

HOST_NAME="$(hostname)"
ARCHITECTURE="$(uname -m)"
STORAGE_DEVICE="$(findmnt -n -o SOURCE -T /var/lib/postgresql | head -n 1)"
STORAGE_FILESYSTEM="$(findmnt -n -o FSTYPE -T /var/lib/postgresql | head -n 1)"
POSTGRES_SERVICE="$(systemctl is-active postgresql@17-main)"
CASSA_SERVICE="$(systemctl is-active cassav5bt.service)"

set -a
# shellcheck disable=SC1090
source "$APP_ENV"
set +a
POSTGRES_DATABASE="$SMOKE_DATABASE" \
MIG023_ALLOW_SMOKE=1 \
MIG023_HOSTNAME="$HOST_NAME" \
MIG023_ARCHITECTURE="$ARCHITECTURE" \
MIG023_STORAGE_DEVICE="$STORAGE_DEVICE" \
MIG023_STORAGE_FILESYSTEM="$STORAGE_FILESYSTEM" \
MIG023_POSTGRES_SERVICE="$POSTGRES_SERVICE" \
MIG023_CASSA_SERVICE="$CASSA_SERVICE" \
  node "$RUN_DIR/scripts/postgresql-migration/mig023-event-outbox-smoke.mjs"

[[ "$(systemctl is-active postgresql@17-main)" == "active" ]]
[[ "$(systemctl is-active cassav5bt.service)" == "active" ]]

