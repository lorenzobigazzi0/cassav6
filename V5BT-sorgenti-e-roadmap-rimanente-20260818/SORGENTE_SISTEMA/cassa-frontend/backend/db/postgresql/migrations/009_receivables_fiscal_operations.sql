CREATE SCHEMA IF NOT EXISTS payments;
CREATE SCHEMA IF NOT EXISTS fiscal;

CREATE TABLE payments.receivables (
  id text PRIMARY KEY,
  correlation_id text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('GOODS', 'SERVICES')),
  status text NOT NULL CHECK (status IN ('OPEN', 'PARTIAL', 'SETTLEMENT_PENDING', 'PAID', 'CANCELLED')),
  original_document_id text,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  paid_cents bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0 AND paid_cents <= amount_cents),
  owner_user_id text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fiscal.operations (
  id text PRIMARY KEY,
  operation_id text NOT NULL UNIQUE,
  correlation_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('UNPAID_GOODS_DOCUMENT','UNPAID_SERVICES_DOCUMENT','RECOVER_CREDIT_CASH','RECOVER_CREDIT_CHECK','SERVICE_RECEIVABLE_SETTLEMENT','PRINT_PAYMENT_RECEIPT','REPRINT_PAYMENT_RECEIPT')),
  receivable_id text REFERENCES payments.receivables(id),
  payment_id text,
  fiscal_document_id text,
  gateway_operation_id text,
  status text NOT NULL CHECK (status IN ('CREATED','QUEUED','SENT','PROCESSING','COMPLETED','FAILED','UNKNOWN','RECONCILING')),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  response_payload jsonb CHECK (response_payload IS NULL OR jsonb_typeof(response_payload) = 'object'),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX fiscal_operations_correlation_idx ON fiscal.operations(correlation_id, created_at DESC);
CREATE INDEX fiscal_operations_reconcile_idx ON fiscal.operations(status, created_at) WHERE status IN ('UNKNOWN','RECONCILING');
REVOKE ALL ON SCHEMA fiscal FROM PUBLIC;
REVOKE ALL ON payments.receivables, fiscal.operations FROM PUBLIC;
GRANT USAGE ON SCHEMA fiscal TO cassav6_runtime;
GRANT SELECT, INSERT, UPDATE ON payments.receivables, fiscal.operations TO cassav6_runtime;

COMMENT ON TABLE fiscal.operations IS 'Operazioni semantiche POS verso gateway RT esterno; UNKNOWN richiede riconciliazione prima di ogni retry.';
