CREATE INDEX IF NOT EXISTS idx_payment_mirror_outbox_terminal
  ON payment_mirror_outbox(status, completed_at);

CREATE INDEX IF NOT EXISTS idx_payment_mirror_outbox_failed_retention
  ON payment_mirror_outbox(status, updated_at);
