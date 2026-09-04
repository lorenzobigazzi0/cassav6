CREATE TABLE IF NOT EXISTS payment_mirror_outbox (
  mirror_id TEXT PRIMARY KEY,
  mirror_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  idempotency_key TEXT,
  payload_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'processing', 'retrying', 'completed', 'failed'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  locked_by TEXT,
  locked_at TEXT,
  lock_expires_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (mirror_kind, aggregate_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_mirror_outbox_idempotency
  ON payment_mirror_outbox(mirror_kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_mirror_outbox_ready
  ON payment_mirror_outbox(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_payment_mirror_outbox_lease
  ON payment_mirror_outbox(status, lock_expires_at);
