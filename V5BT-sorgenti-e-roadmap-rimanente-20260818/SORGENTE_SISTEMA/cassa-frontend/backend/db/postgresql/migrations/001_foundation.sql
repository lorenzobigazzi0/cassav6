CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS messaging;

REVOKE ALL ON SCHEMA app_meta FROM PUBLIC;
REVOKE ALL ON SCHEMA audit FROM PUBLIC;
REVOKE ALL ON SCHEMA messaging FROM PUBLIC;

CREATE TABLE audit.events (
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

CREATE INDEX audit_events_aggregate_time_idx
  ON audit.events(aggregate_type, aggregate_id, occurred_at DESC);

CREATE TABLE messaging.idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text,
  status text NOT NULL,
  response_code integer,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY(scope, key)
);

CREATE INDEX idempotency_expiry_idx
  ON messaging.idempotency_keys(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE messaging.command_inbox (
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

CREATE TABLE messaging.event_outbox (
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

CREATE INDEX event_outbox_claimable_idx
  ON messaging.event_outbox(available_at, created_at)
  WHERE processed_at IS NULL;

CREATE INDEX event_outbox_lease_idx
  ON messaging.event_outbox(lease_until)
  WHERE processed_at IS NULL AND lease_until IS NOT NULL;

REVOKE ALL ON app_meta.schema_migrations FROM PUBLIC;
REVOKE ALL ON audit.events FROM PUBLIC;
REVOKE ALL ON messaging.idempotency_keys FROM PUBLIC;
REVOKE ALL ON messaging.command_inbox FROM PUBLIC;
REVOKE ALL ON messaging.event_outbox FROM PUBLIC;

GRANT USAGE ON SCHEMA audit, messaging TO cassav6_runtime;
GRANT SELECT, INSERT ON audit.events TO cassav6_runtime;
GRANT SELECT, INSERT, UPDATE ON messaging.idempotency_keys TO cassav6_runtime;
GRANT SELECT, INSERT, UPDATE ON messaging.command_inbox TO cassav6_runtime;
GRANT SELECT, INSERT, UPDATE ON messaging.event_outbox TO cassav6_runtime;

COMMENT ON SCHEMA audit IS 'Audit applicativo append-only; le policy operative sono introdotte da MIG-024.';
COMMENT ON SCHEMA messaging IS 'Foundation per idempotenza, command inbox e transactional outbox.';
COMMENT ON TABLE audit.events IS 'Eventi audit applicativi; il ruolo runtime non possiede UPDATE o DELETE.';
COMMENT ON TABLE messaging.idempotency_keys IS 'Struttura foundation; invarianti e repository sono responsabilita di MIG-025.';
COMMENT ON TABLE messaging.command_inbox IS 'Struttura foundation per comandi durevoli.';
COMMENT ON TABLE messaging.event_outbox IS 'Struttura foundation; claim lease e SKIP LOCKED sono responsabilita di MIG-023.';
