-- DRAFT TARGET PostgreSQL — REV2 2026-08-31. Convertire nel migration framework definitivo.
BEGIN;
CREATE SCHEMA IF NOT EXISTS app_meta;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS messaging;

CREATE TABLE IF NOT EXISTS app_meta.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text NOT NULL
);

CREATE TABLE IF NOT EXISTS audit.events (
  id text PRIMARY KEY,
  domain text NOT NULL,
  aggregate_type text,
  aggregate_id text,
  action text NOT NULL,
  actor_user_id text,
  actor_username text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_events_aggregate_time_idx ON audit.events(aggregate_type, aggregate_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS messaging.idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text,
  status text NOT NULL,
  response_code integer,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY(scope,key)
);
-- REV2: indice per la pulizia periodica delle chiavi scadute (retention).
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON messaging.idempotency_keys(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS messaging.command_inbox (
  command_key text PRIMARY KEY,
  command_type text NOT NULL,
  aggregate_type text,
  aggregate_id text,
  status text NOT NULL,
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS messaging.event_outbox (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  lease_owner text,
  lease_until timestamptz,
  processed_at timestamptz,
  last_error text
);
-- REV2: indice allineato alla strategia di claim unica (lease + SKIP LOCKED),
-- documentata in 05_DATA_MODEL_AND_TRANSACTIONS.md. Include lease_until perche
-- la query di claim filtra anche i lease scaduti.
CREATE INDEX IF NOT EXISTS event_outbox_claimable_idx
  ON messaging.event_outbox(available_at, created_at)
  WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_lease_idx
  ON messaging.event_outbox(lease_until)
  WHERE processed_at IS NULL AND lease_until IS NOT NULL;
COMMIT;
