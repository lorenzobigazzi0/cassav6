CREATE TABLE IF NOT EXISTS fiscal_outbox (
  fiscal_id TEXT PRIMARY KEY,
  store_id TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payment_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'processing', 'issued', 'failed', 'retrying', 'manual_required')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  locked_by TEXT,
  locked_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  issued_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_fiscal_outbox_status_next
  ON fiscal_outbox(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_fiscal_outbox_aggregate
  ON fiscal_outbox(aggregate_type, aggregate_id);

CREATE INDEX IF NOT EXISTS idx_fiscal_outbox_payment
  ON fiscal_outbox(payment_id);
