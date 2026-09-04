CREATE TABLE IF NOT EXISTS payment_containers (
  id TEXT PRIMARY KEY,
  table_id TEXT,
  bill_id TEXT,
  order_id TEXT,
  status TEXT NOT NULL,
  total_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  due_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_payment_containers_table_id
  ON payment_containers(table_id);

CREATE INDEX IF NOT EXISTS idx_payment_containers_bill_id
  ON payment_containers(bill_id);

CREATE INDEX IF NOT EXISTS idx_payment_containers_status
  ON payment_containers(status);

CREATE TABLE IF NOT EXISTS payment_parts (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL,
  method_id TEXT,
  method_type TEXT,
  amount_cents INTEGER NOT NULL,
  fiscal_status TEXT,
  created_at TEXT,
  raw_json TEXT,
  FOREIGN KEY (container_id) REFERENCES payment_containers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payment_parts_container_id
  ON payment_parts(container_id);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  container_id TEXT,
  idempotency_key TEXT,
  table_id TEXT,
  bill_id TEXT,
  order_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  raw_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_transactions_idempotency_key
  ON payment_transactions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_container_id
  ON payment_transactions(container_id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_status
  ON payment_transactions(status);

CREATE TABLE IF NOT EXISTS fiscal_receipts (
  id TEXT PRIMARY KEY,
  payment_transaction_id TEXT,
  fiscal_provider TEXT,
  fiscal_status TEXT,
  fiscal_document_number TEXT,
  issued_at TEXT,
  payload_json TEXT,
  raw_json TEXT,
  FOREIGN KEY (payment_transaction_id) REFERENCES payment_transactions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fiscal_receipts_transaction
  ON fiscal_receipts(payment_transaction_id);
