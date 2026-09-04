CREATE TABLE IF NOT EXISTS print_spool (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'claimed', 'sent', 'confirmed', 'failed_retryable', 'failed_final'
  )),
  kind TEXT,
  order_id TEXT,
  printer_id TEXT,
  printer_host TEXT,
  printer_port INTEGER,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claimed_at TEXT,
  lease_expires_at TEXT,
  next_retry_at TEXT,
  last_error TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_print_spool_claim
  ON print_spool(status, next_retry_at, requested_at);

CREATE INDEX IF NOT EXISTS idx_print_spool_lease
  ON print_spool(status, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_print_spool_order
  ON print_spool(order_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_print_spool_terminal
  ON print_spool(status, terminal_at);
