CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  device_uuid TEXT NOT NULL,
  client_app TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  raw_json TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash
  ON sessions(token_hash);

CREATE INDEX IF NOT EXISTS idx_sessions_user_device
  ON sessions(user_id, device_uuid);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
  ON sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_sessions_revoked_at
  ON sessions(revoked_at);
