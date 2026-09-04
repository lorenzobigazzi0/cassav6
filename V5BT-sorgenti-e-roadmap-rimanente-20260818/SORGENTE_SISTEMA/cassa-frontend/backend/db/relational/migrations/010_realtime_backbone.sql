CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_scope_expires
  ON idempotency_keys(scope, expires_at);

CREATE TABLE IF NOT EXISTS event_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  scope TEXT,
  scope_sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  published_at TEXT,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_outbox_unpublished
  ON event_outbox(published_at, id);

CREATE INDEX IF NOT EXISTS idx_event_outbox_scope_sequence
  ON event_outbox(scope, scope_sequence);
