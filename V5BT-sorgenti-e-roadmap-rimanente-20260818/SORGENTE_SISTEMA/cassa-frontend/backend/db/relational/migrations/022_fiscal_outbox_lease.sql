ALTER TABLE fiscal_outbox ADD COLUMN lock_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_fiscal_outbox_lease
  ON fiscal_outbox(status, lock_expires_at);
