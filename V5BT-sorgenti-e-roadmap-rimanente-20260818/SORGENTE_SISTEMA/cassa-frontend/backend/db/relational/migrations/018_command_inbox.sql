CREATE TABLE IF NOT EXISTS command_inbox (
  request_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  user_id TEXT,
  station_id TEXT,
  command_type TEXT NOT NULL,
  aggregate_type TEXT,
  aggregate_id TEXT,
  expected_version INTEGER,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'committed', 'rejected', 'failed')),
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_command_inbox_status_updated
  ON command_inbox(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_command_inbox_aggregate
  ON command_inbox(aggregate_type, aggregate_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_command_inbox_device
  ON command_inbox(device_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_command_inbox_expires
  ON command_inbox(expires_at);
