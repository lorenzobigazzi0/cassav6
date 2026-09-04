-- DRAFT TARGET PostgreSQL — REV2 2026-08-31
BEGIN;
CREATE SCHEMA IF NOT EXISTS payments;
CREATE SCHEMA IF NOT EXISTS fiscal;
CREATE SCHEMA IF NOT EXISTS operations;

CREATE TABLE IF NOT EXISTS payments.payments (
  id text PRIMARY KEY,
  client_payment_id text UNIQUE,
  status text NOT NULL,
  payment_method text NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents>=0),
  currency text NOT NULL DEFAULT 'EUR',
  collected_by_user_id text,
  device_uuid text,
  sale_session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  revision bigint NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- REV2: invariante di 08 ("nessun pagamento SETTLED con importo negativo"
  -- e "settled ha una data di settlement") espressa nello schema.
  CONSTRAINT payment_settled_coherent CHECK(status <> 'SETTLED' OR (amount_cents > 0 AND settled_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS payments.payment_parts (id text PRIMARY KEY, payment_id text NOT NULL REFERENCES payments.payments(id) ON DELETE CASCADE, payment_method text NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents>=0), payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS payments.payment_transactions (id text PRIMARY KEY, payment_id text NOT NULL REFERENCES payments.payments(id) ON DELETE CASCADE, transaction_type text NOT NULL, status text NOT NULL, amount_cents bigint NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS payments.payment_order_allocations (payment_id text REFERENCES payments.payments(id) ON DELETE CASCADE, order_id text REFERENCES sales.orders(id), amount_cents bigint NOT NULL CHECK(amount_cents>=0), PRIMARY KEY(payment_id,order_id));
CREATE TABLE IF NOT EXISTS payments.payment_bill_allocations (payment_id text REFERENCES payments.payments(id) ON DELETE CASCADE, bill_id text REFERENCES sales.bills(id), amount_cents bigint NOT NULL CHECK(amount_cents>=0), PRIMARY KEY(payment_id,bill_id));
CREATE TABLE IF NOT EXISTS payments.payment_line_allocations (payment_id text REFERENCES payments.payments(id) ON DELETE CASCADE, order_line_id text REFERENCES sales.order_lines(id), quantity integer, amount_cents bigint NOT NULL CHECK(amount_cents>=0), PRIMARY KEY(payment_id,order_line_id));

CREATE TABLE IF NOT EXISTS payments.provider_transactions (id text PRIMARY KEY, payment_id text REFERENCES payments.payments(id), provider text NOT NULL, provider_transaction_id text, terminal_id text, status text NOT NULL, requested_amount_cents bigint NOT NULL DEFAULT 0, settled_amount_cents bigint NOT NULL DEFAULT 0, request_payload jsonb NOT NULL DEFAULT '{}'::jsonb, response_payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS provider_transaction_ref_unique ON payments.provider_transactions(provider,provider_transaction_id) WHERE provider_transaction_id IS NOT NULL AND provider_transaction_id<>'';

-- REV2: vincoli di coerenza di apertura/chiusura cassa.
CREATE TABLE IF NOT EXISTS payments.cash_sessions (id text PRIMARY KEY, device_uuid text, user_id text, sale_session_id text, status text NOT NULL, opened_at timestamptz NOT NULL, closed_at timestamptz, opening_cents bigint NOT NULL DEFAULT 0 CHECK(opening_cents >= 0), closing_cents bigint CHECK(closing_cents IS NULL OR closing_cents >= 0), revision bigint NOT NULL DEFAULT 0, CONSTRAINT cash_session_closed_coherent CHECK((closed_at IS NULL AND closing_cents IS NULL) OR (closed_at IS NOT NULL AND closing_cents IS NOT NULL)));
CREATE TABLE IF NOT EXISTS payments.cash_movements (id text PRIMARY KEY, cash_session_id text REFERENCES payments.cash_sessions(id), payment_id text REFERENCES payments.payments(id), movement_type text NOT NULL, amount_cents bigint NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), actor_user_id text, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS payments.cash_movement_denominations (movement_id text REFERENCES payments.cash_movements(id) ON DELETE CASCADE, denomination_cents bigint NOT NULL CHECK(denomination_cents>0), quantity integer NOT NULL CHECK(quantity>=0), direction text NOT NULL, PRIMARY KEY(movement_id,denomination_cents,direction));
CREATE TABLE IF NOT EXISTS payments.cash_device_operations (id text PRIMARY KEY, provider text NOT NULL, device_id text, payment_id text REFERENCES payments.payments(id), status text NOT NULL, requested_cents bigint NOT NULL DEFAULT 0, accepted_cents bigint NOT NULL DEFAULT 0, change_cents bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb);

CREATE TABLE IF NOT EXISTS fiscal.documents (id text PRIMARY KEY, payment_id text REFERENCES payments.payments(id), document_type text NOT NULL, status text NOT NULL, provider text, provider_reference text, amount_cents bigint NOT NULL DEFAULT 0, issued_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), revision bigint NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS fiscal.operations (id text PRIMARY KEY, document_id text REFERENCES fiscal.documents(id), operation_type text NOT NULL, status text NOT NULL, provider text, idempotency_key text, request_payload jsonb NOT NULL DEFAULT '{}'::jsonb, response_payload jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL DEFAULT now(), error text);
CREATE UNIQUE INDEX IF NOT EXISTS fiscal_operation_idempotency_unique ON fiscal.operations(provider,idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key<>'';
CREATE TABLE IF NOT EXISTS fiscal.outbox (id text PRIMARY KEY, operation_id text NOT NULL REFERENCES fiscal.operations(id), status text NOT NULL, available_at timestamptz NOT NULL DEFAULT now(), attempt_count integer NOT NULL DEFAULT 0, lease_owner text, lease_until timestamptz, processed_at timestamptz, last_error text);
CREATE INDEX IF NOT EXISTS fiscal_outbox_claimable_idx ON fiscal.outbox(available_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS fiscal_outbox_lease_idx ON fiscal.outbox(lease_until) WHERE processed_at IS NULL AND lease_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS operations.print_jobs (id text PRIMARY KEY, job_type text NOT NULL, aggregate_type text, aggregate_id text, printer_id text, status text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), available_at timestamptz NOT NULL DEFAULT now(), attempt_count integer NOT NULL DEFAULT 0, lease_owner text, lease_until timestamptz, completed_at timestamptz, last_error text);
-- REV2: stessa strategia di claim dell'event_outbox (lease + SKIP LOCKED).
CREATE INDEX IF NOT EXISTS print_jobs_claimable_idx ON operations.print_jobs(available_at,created_at) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS print_jobs_lease_idx ON operations.print_jobs(lease_until) WHERE completed_at IS NULL AND lease_until IS NOT NULL;
CREATE TABLE IF NOT EXISTS operations.print_attempts (id text PRIMARY KEY, print_job_id text REFERENCES operations.print_jobs(id) ON DELETE CASCADE, started_at timestamptz NOT NULL, finished_at timestamptz, status text NOT NULL, error text, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
COMMIT;
