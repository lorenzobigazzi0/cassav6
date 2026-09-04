#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Eseguire come root sul Raspberry." >&2
  exit 1
fi

RUN_DIR="${1:-}"
MIGRATION_ENV="/etc/cassav6/postgresql-migration.env"
APP_ENV="/etc/cassav6/postgresql-app.env"
SMOKE_DATABASE="${MIG026_DATABASE:-cassav6_mig026_20260831a}"

if [[ -z "$RUN_DIR" || ! -d "$RUN_DIR" ]]; then
  echo "Directory di staging MIG-026 non valida." >&2
  exit 2
fi
if [[ ! "$SMOKE_DATABASE" =~ ^cassav6_mig026_[a-z0-9_]+$ ]]; then
  echo "Nome database temporaneo MIG-026 non valido." >&2
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
require_identifier "POSTGRES_USER migration" "$MIGRATION_USER"
require_identifier "POSTGRES_USER app" "$APP_USER"

cleanup() {
  sudo -u postgres dropdb --if-exists --force "$SMOKE_DATABASE" >/dev/null 2>&1 || true
  rm -f /tmp/mig026-owner-*.err /tmp/mig026-migration-result.json
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
  node "$RUN_DIR/backend/scripts/migrate-postgresql.mjs" >/tmp/mig026-migration-result.json

DISABLED_ERROR="/tmp/mig026-owner-disabled.err"
if sudo -u postgres psql --no-psqlrc --set ON_ERROR_STOP=1 "$SMOKE_DATABASE" \
  --command "SELECT app_meta.purge_processed_outbox(10, true)" \
  >/dev/null 2>"$DISABLED_ERROR"; then
  echo "La purge con policy disabilitata doveva fallire." >&2
  exit 6
fi
grep -q "retention policy is disabled" "$DISABLED_ERROR" || {
  echo "La guard RET-01 disabilitata non ha prodotto l'errore previsto." >&2
  exit 7
}

PROTECTED_ERROR="/tmp/mig026-owner-protected.err"
if sudo -u postgres psql --no-psqlrc --set ON_ERROR_STOP=1 "$SMOKE_DATABASE" \
  --command "UPDATE app_meta.retention_policies SET notes = 'tampered' WHERE target = 'payments.payments'" \
  >/dev/null 2>"$PROTECTED_ERROR"; then
  echo "La policy legalmente protetta doveva essere immutabile." >&2
  exit 8
fi
grep -q "legally required retention policy is immutable" "$PROTECTED_ERROR" || {
  echo "La policy protetta non e stata fermata dal trigger." >&2
  exit 9
}

sudo -u postgres psql --no-psqlrc --set ON_ERROR_STOP=1 "$SMOKE_DATABASE" <<'SQL' >/dev/null
UPDATE app_meta.retention_policies
SET enabled = true,
    decision_ref = 'RET-01:MIG026_TEMP_SMOKE',
    approved_at = now()
WHERE target IN ('messaging.event_outbox', 'messaging.idempotency_keys');

INSERT INTO messaging.event_outbox(
  id, aggregate_type, aggregate_id, event_type, payload,
  created_at, available_at, processed_at
) VALUES
  ('mig026-outbox-old', 'probe', 'old', 'probe.old', '{}',
   now() - interval '40 days', now() - interval '40 days', now() - interval '31 days'),
  ('mig026-outbox-new', 'probe', 'new', 'probe.new', '{}',
   now() - interval '29 days', now() - interval '29 days', now() - interval '29 days'),
  ('mig026-outbox-pending', 'probe', 'pending', 'probe.pending', '{}',
   now() - interval '60 days', now() - interval '60 days', NULL);

BEGIN;
INSERT INTO messaging.idempotency_keys(
  scope, key, request_hash, status, created_at, expires_at
) VALUES
  ('mig026.probe', 'idem-old', repeat('a', 64), 'processing', now() - interval '100 days', now() - interval '40 days'),
  ('mig026.probe', 'idem-recent', repeat('b', 64), 'processing', now() - interval '20 days', now() - interval '1 day'),
  ('mig026.probe', 'idem-active', repeat('c', 64), 'processing', now(), now() + interval '1 day');
UPDATE messaging.idempotency_keys
SET status = 'completed', response_code = 200, response_json = '{}'::jsonb, completed_at = now()
WHERE scope = 'mig026.probe';
COMMIT;
SQL

OUTBOX_DRY_RUN="$(sudo -u postgres psql --no-psqlrc -At "$SMOKE_DATABASE" --command "SELECT app_meta.purge_processed_outbox(10, true)")"
OUTBOX_DELETED="$(sudo -u postgres psql --no-psqlrc -At "$SMOKE_DATABASE" --command "SELECT app_meta.purge_processed_outbox(10, false)")"
OUTBOX_SECOND_PASS="$(sudo -u postgres psql --no-psqlrc -At "$SMOKE_DATABASE" --command "SELECT app_meta.purge_processed_outbox(10, false)")"
IDEMPOTENCY_DRY_RUN="$(sudo -u postgres psql --no-psqlrc -At "$SMOKE_DATABASE" --command "SELECT app_meta.purge_expired_idempotency(10, true)")"
IDEMPOTENCY_DELETED="$(sudo -u postgres psql --no-psqlrc -At "$SMOKE_DATABASE" --command "SELECT app_meta.purge_expired_idempotency(10, false)")"
IDEMPOTENCY_SECOND_PASS="$(sudo -u postgres psql --no-psqlrc -At "$SMOKE_DATABASE" --command "SELECT app_meta.purge_expired_idempotency(10, false)")"

[[ "$OUTBOX_DRY_RUN" == "1" && "$OUTBOX_DELETED" == "1" && "$OUTBOX_SECOND_PASS" == "0" ]]
[[ "$IDEMPOTENCY_DRY_RUN" == "1" && "$IDEMPOTENCY_DELETED" == "1" && "$IDEMPOTENCY_SECOND_PASS" == "0" ]]

PRESERVED_COUNTS="$(sudo -u postgres psql --no-psqlrc -At -F '|' "$SMOKE_DATABASE" --command "SELECT (SELECT count(*) FROM messaging.event_outbox), (SELECT count(*) FROM messaging.idempotency_keys)")"
IFS='|' read -r PRESERVED_OUTBOX_ROWS PRESERVED_IDEMPOTENCY_ROWS <<<"$PRESERVED_COUNTS"
[[ "$PRESERVED_OUTBOX_ROWS" == "2" && "$PRESERVED_IDEMPOTENCY_ROWS" == "2" ]]

sudo -u postgres psql --no-psqlrc --set ON_ERROR_STOP=1 "$SMOKE_DATABASE" <<'SQL' >/dev/null
DELETE FROM messaging.event_outbox WHERE id LIKE 'mig026-%';
DELETE FROM messaging.idempotency_keys WHERE scope = 'mig026.probe';
UPDATE app_meta.retention_policies
SET enabled = false,
    decision_ref = 'RET-01:TODO',
    approved_at = NULL
WHERE target IN ('messaging.event_outbox', 'messaging.idempotency_keys');
SQL

HOST_NAME="$(hostname)"
ARCHITECTURE="$(uname -m)"
STORAGE_DEVICE="$(findmnt -n -o SOURCE -T /var/lib/postgresql | head -n 1)"
STORAGE_FILESYSTEM="$(findmnt -n -o FSTYPE -T /var/lib/postgresql | head -n 1)"

set -a
# shellcheck disable=SC1090
source "$APP_ENV"
set +a
POSTGRES_DATABASE="$SMOKE_DATABASE" \
MIG026_ALLOW_SMOKE=1 \
MIG026_HOSTNAME="$HOST_NAME" \
MIG026_ARCHITECTURE="$ARCHITECTURE" \
MIG026_STORAGE_DEVICE="$STORAGE_DEVICE" \
MIG026_STORAGE_FILESYSTEM="$STORAGE_FILESYSTEM" \
MIG026_OWNER_DISABLED_SQLSTATE=55000 \
MIG026_OWNER_PROTECTED_SQLSTATE=55000 \
MIG026_OUTBOX_DRY_RUN="$OUTBOX_DRY_RUN" \
MIG026_OUTBOX_DELETED="$OUTBOX_DELETED" \
MIG026_OUTBOX_SECOND_PASS="$OUTBOX_SECOND_PASS" \
MIG026_IDEMPOTENCY_DRY_RUN="$IDEMPOTENCY_DRY_RUN" \
MIG026_IDEMPOTENCY_DELETED="$IDEMPOTENCY_DELETED" \
MIG026_IDEMPOTENCY_SECOND_PASS="$IDEMPOTENCY_SECOND_PASS" \
MIG026_PRESERVED_OUTBOX_ROWS="$PRESERVED_OUTBOX_ROWS" \
MIG026_PRESERVED_IDEMPOTENCY_ROWS="$PRESERVED_IDEMPOTENCY_ROWS" \
MIG026_RESET_DISABLED=true \
  node "$RUN_DIR/scripts/postgresql-migration/mig026-retention-smoke.mjs"

[[ "$(systemctl is-active postgresql@17-main)" == "active" ]]
[[ "$(systemctl is-active cassav5bt.service)" == "active" ]]
