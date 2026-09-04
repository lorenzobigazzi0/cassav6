CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relational_sync_state (
  domain TEXT PRIMARY KEY,
  source_last_write_at TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,
  synced_at TEXT NOT NULL
);
