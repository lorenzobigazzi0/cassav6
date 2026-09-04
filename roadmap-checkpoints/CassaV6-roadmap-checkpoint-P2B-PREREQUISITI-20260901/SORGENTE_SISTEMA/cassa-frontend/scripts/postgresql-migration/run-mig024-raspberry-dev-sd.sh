#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Eseguire come root sul Raspberry." >&2
  exit 1
fi

RUN_DIR="${1:-}"
MIGRATION_ENV="/etc/cassav6/postgresql-migration.env"
APP_ENV="/etc/cassav6/postgresql-app.env"
SMOKE_DATABASE="${MIG024_DATABASE:-cassav6_mig024_20260831a}"

if [[ -z "$RUN_DIR" || ! -d "$RUN_DIR" ]]; then
  echo "Directory di staging MIG-024 non valida." >&2
  exit 2
fi
if [[ ! "$SMOKE_DATABASE" =~ ^cassav6_mig024_[a-z0-9_]+$ ]]; then
  echo "Nome database temporaneo MIG-024 non valido." >&2
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
  rm -f /tmp/mig024-owner-*.err /tmp/mig024-migration-result.json
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
  node "$RUN_DIR/backend/scripts/migrate-postgresql.mjs" >/tmp/mig024-migration-result.json

sudo -u postgres psql --no-psqlrc --set ON_ERROR_STOP=1 "$SMOKE_DATABASE" \
  --set runtime_role="$RUNTIME_ROLE" <<'SQL' >/dev/null
CREATE SCHEMA mig024_probe;
CREATE TABLE mig024_probe.business_rows (
  id text PRIMARY KEY,
  value integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON SCHEMA mig024_probe FROM PUBLIC;
REVOKE ALL ON mig024_probe.business_rows FROM PUBLIC;
GRANT USAGE ON SCHEMA mig024_probe TO :"runtime_role";
GRANT SELECT, INSERT ON mig024_probe.business_rows TO :"runtime_role";
INSERT INTO audit.events(id, domain, action, payload)
VALUES ('mig024-owner-trigger-probe', 'owner_probe', 'probe.created', '{}'::jsonb);
SQL

expect_owner_append_only() {
  local operation="$1"
  local sql="$2"
  local error_file="/tmp/mig024-owner-${operation}.err"
  if sudo -u postgres psql --no-psqlrc --set ON_ERROR_STOP=1 "$SMOKE_DATABASE" \
    --command "$sql" >/dev/null 2>"$error_file"; then
    echo "La mutazione owner ${operation} doveva essere rifiutata." >&2
    exit 6
  fi
  grep -q "audit.events is append-only" "$error_file" || {
    echo "La mutazione owner ${operation} non e stata bloccata dal trigger MIG-024." >&2
    exit 7
  }
}

expect_owner_append_only update \
  "UPDATE audit.events SET action = 'tampered' WHERE id = 'mig024-owner-trigger-probe'"
expect_owner_append_only delete \
  "DELETE FROM audit.events WHERE id = 'mig024-owner-trigger-probe'"
expect_owner_append_only truncate \
  "TRUNCATE audit.events"

HOST_NAME="$(hostname)"
ARCHITECTURE="$(uname -m)"
STORAGE_DEVICE="$(findmnt -n -o SOURCE -T /var/lib/postgresql | head -n 1)"
STORAGE_FILESYSTEM="$(findmnt -n -o FSTYPE -T /var/lib/postgresql | head -n 1)"

set -a
# shellcheck disable=SC1090
source "$APP_ENV"
set +a
POSTGRES_DATABASE="$SMOKE_DATABASE" \
MIG024_ALLOW_SMOKE=1 \
MIG024_HOSTNAME="$HOST_NAME" \
MIG024_ARCHITECTURE="$ARCHITECTURE" \
MIG024_STORAGE_DEVICE="$STORAGE_DEVICE" \
MIG024_STORAGE_FILESYSTEM="$STORAGE_FILESYSTEM" \
MIG024_OWNER_UPDATE_SQLSTATE=55000 \
MIG024_OWNER_DELETE_SQLSTATE=55000 \
MIG024_OWNER_TRUNCATE_SQLSTATE=55000 \
  node "$RUN_DIR/scripts/postgresql-migration/mig024-audit-events-smoke.mjs"

[[ "$(systemctl is-active postgresql@17-main)" == "active" ]]
[[ "$(systemctl is-active cassav5bt.service)" == "active" ]]

