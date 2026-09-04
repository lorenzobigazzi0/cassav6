#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Eseguire come root (esempio: sudo bash $0)." >&2
  exit 1
fi

PG_VERSION="${PG_VERSION:-17}"
PG_CLUSTER="${PG_CLUSTER:-main}"
PG_DATABASE="${PG_DATABASE:-cassav6}"
PG_APP_ROLE="${PG_APP_ROLE:-cassav6_app}"
PG_RUNTIME_ROLE="${PG_RUNTIME_ROLE:-cassav6_runtime}"
PG_MIGRATION_ROLE="${PG_MIGRATION_ROLE:-cassav6_migrator}"
PG_DATA_DIR="/var/lib/postgresql/${PG_VERSION}/${PG_CLUSTER}"
PG_CONFIG_DIR="/etc/postgresql/${PG_VERSION}/${PG_CLUSTER}"
PG_APP_ENV="/etc/cassav6/postgresql-app.env"
PG_MIGRATION_ENV="/etc/cassav6/postgresql-migration.env"

require_safe_identifier() {
  local label="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "${label} non valido: sono ammessi solo identificatori PostgreSQL minuscoli." >&2
    exit 2
  fi
}

read_env_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

random_password() {
  openssl rand -hex 32
}

require_safe_identifier "PG_DATABASE" "$PG_DATABASE"
require_safe_identifier "PG_APP_ROLE" "$PG_APP_ROLE"
require_safe_identifier "PG_RUNTIME_ROLE" "$PG_RUNTIME_ROLE"
require_safe_identifier "PG_MIGRATION_ROLE" "$PG_MIGRATION_ROLE"

if ! command -v pg_lsclusters >/dev/null 2>&1; then
  echo "postgresql-common non installato; installare PostgreSQL ${PG_VERSION} prima di eseguire il provisioning." >&2
  exit 3
fi

if ! pg_lsclusters --no-header | awk -v version="$PG_VERSION" -v cluster="$PG_CLUSTER" '$1 == version && $2 == cluster { found=1 } END { exit !found }'; then
  echo "Cluster PostgreSQL ${PG_VERSION}/${PG_CLUSTER} non trovato." >&2
  exit 4
fi

install -d -m 0750 -o root -g root /var/backups/cassav6-postgresql
backup_dir="/var/backups/cassav6-postgresql/pre-dev-sd-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 -o root -g root "$backup_dir"
cp -a "$PG_CONFIG_DIR" "$backup_dir/config"

systemctl enable postgresql >/dev/null
pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" start || true

sudo -u postgres psql --no-psqlrc --set ON_ERROR_STOP=1 postgres <<SQL
ALTER SYSTEM SET listen_addresses = '127.0.0.1';
ALTER SYSTEM SET max_connections = '30';
ALTER SYSTEM SET shared_buffers = '256MB';
ALTER SYSTEM SET effective_cache_size = '1GB';
ALTER SYSTEM SET work_mem = '2MB';
ALTER SYSTEM SET maintenance_work_mem = '64MB';
ALTER SYSTEM SET checkpoint_completion_target = '0.9';
ALTER SYSTEM SET max_wal_size = '1GB';
ALTER SYSTEM SET min_wal_size = '80MB';
ALTER SYSTEM SET password_encryption = 'scram-sha-256';
ALTER SYSTEM SET fsync = 'on';
ALTER SYSTEM SET full_page_writes = 'on';
ALTER SYSTEM SET synchronous_commit = 'on';
ALTER SYSTEM SET idle_in_transaction_session_timeout = '60s';
ALTER SYSTEM SET log_min_duration_statement = '1000ms';
SQL

if sudo -u postgres "/usr/lib/postgresql/${PG_VERSION}/bin/pg_controldata" "$PG_DATA_DIR" \
  | grep -q '^Data page checksum version:[[:space:]]*0$'; then
  pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" stop
  sudo -u postgres "/usr/lib/postgresql/${PG_VERSION}/bin/pg_checksums" --enable -D "$PG_DATA_DIR"
fi

pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" start || true
systemctl restart "postgresql@${PG_VERSION}-${PG_CLUSTER}"

install -d -m 0750 -o root -g admin /etc/cassav6
app_password="$(read_env_value "$PG_APP_ENV" POSTGRES_PASSWORD)"
migration_password="$(read_env_value "$PG_MIGRATION_ENV" POSTGRES_PASSWORD)"
[[ -n "$app_password" ]] || app_password="$(random_password)"
[[ -n "$migration_password" ]] || migration_password="$(random_password)"

sudo -u postgres psql --no-psqlrc --set ON_ERROR_STOP=1 postgres <<SQL
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', '${PG_APP_ROLE}', '${app_password}')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_APP_ROLE}')
\gexec
SELECT format('CREATE ROLE %I NOLOGIN', '${PG_RUNTIME_ROLE}')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_RUNTIME_ROLE}')
\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', '${PG_MIGRATION_ROLE}', '${migration_password}')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_MIGRATION_ROLE}')
\gexec
ALTER ROLE ${PG_RUNTIME_ROLE} WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT CONNECTION LIMIT -1;
ALTER ROLE ${PG_APP_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT CONNECTION LIMIT 20 PASSWORD '${app_password}';
ALTER ROLE ${PG_MIGRATION_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT CONNECTION LIMIT 2 PASSWORD '${migration_password}';
GRANT ${PG_RUNTIME_ROLE} TO ${PG_APP_ROLE};
SELECT format('CREATE DATABASE %I OWNER %I ENCODING %L TEMPLATE template0', '${PG_DATABASE}', '${PG_MIGRATION_ROLE}', 'UTF8')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${PG_DATABASE}')
\gexec
ALTER DATABASE ${PG_DATABASE} OWNER TO ${PG_MIGRATION_ROLE};
REVOKE ALL ON DATABASE ${PG_DATABASE} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${PG_DATABASE} TO ${PG_APP_ROLE};
GRANT CONNECT ON DATABASE ${PG_DATABASE} TO ${PG_MIGRATION_ROLE};
ALTER ROLE ${PG_APP_ROLE} IN DATABASE ${PG_DATABASE} SET statement_timeout = '5s';
ALTER ROLE ${PG_APP_ROLE} IN DATABASE ${PG_DATABASE} SET lock_timeout = '1s';
ALTER ROLE ${PG_APP_ROLE} IN DATABASE ${PG_DATABASE} SET idle_in_transaction_session_timeout = '60s';
SQL

sudo -u postgres psql --no-psqlrc --set ON_ERROR_STOP=1 "$PG_DATABASE" <<SQL
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM ${PG_APP_ROLE};
GRANT USAGE ON SCHEMA public TO ${PG_APP_ROLE};
SQL

umask 0077
printf '%s\n' \
  'POSTGRES_HOST=127.0.0.1' \
  'POSTGRES_PORT=5432' \
  "POSTGRES_DATABASE=${PG_DATABASE}" \
  "POSTGRES_USER=${PG_APP_ROLE}" \
  "POSTGRES_RUNTIME_ROLE=${PG_RUNTIME_ROLE}" \
  "POSTGRES_PASSWORD=${app_password}" \
  'POSTGRES_SSL_MODE=disable' \
  'POSTGRES_POOL_MAX=6' \
  'POSTGRES_POOL_IDLE_TIMEOUT_MS=30000' \
  'POSTGRES_STATEMENT_TIMEOUT_MS=5000' \
  'POSTGRES_LOCK_TIMEOUT_MS=1000' \
  'POSTGRES_APPLICATION_NAME=cassav6-backend-dev' \
  > "$PG_APP_ENV"
chown root:admin "$PG_APP_ENV"
chmod 0640 "$PG_APP_ENV"

printf '%s\n' \
  'POSTGRES_HOST=127.0.0.1' \
  'POSTGRES_PORT=5432' \
  "POSTGRES_DATABASE=${PG_DATABASE}" \
  "POSTGRES_USER=${PG_MIGRATION_ROLE}" \
  "POSTGRES_RUNTIME_ROLE=${PG_RUNTIME_ROLE}" \
  "POSTGRES_PASSWORD=${migration_password}" \
  'POSTGRES_SSL_MODE=disable' \
  'POSTGRES_APPLICATION_NAME=cassav6-migrations' \
  > "$PG_MIGRATION_ENV"
chown root:root "$PG_MIGRATION_ENV"
chmod 0600 "$PG_MIGRATION_ENV"

echo "Provisioning PostgreSQL DEV completato. Credenziali salvate fuori dal repository."
