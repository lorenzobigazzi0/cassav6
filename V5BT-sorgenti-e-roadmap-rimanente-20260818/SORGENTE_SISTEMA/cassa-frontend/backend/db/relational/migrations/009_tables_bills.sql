CREATE TABLE IF NOT EXISTS table_states (
  table_id TEXT PRIMARY KEY,
  room_id TEXT,
  status TEXT,
  covers INTEGER,
  customer_name TEXT,
  notes TEXT,
  total_due_cents INTEGER NOT NULL DEFAULT 0,
  total_paid_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_table_states_room
  ON table_states(room_id);

CREATE INDEX IF NOT EXISTS idx_table_states_status
  ON table_states(status);

CREATE TABLE IF NOT EXISTS table_bills (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL,
  status TEXT NOT NULL,
  total_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  due_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  raw_json TEXT,
  FOREIGN KEY (table_id) REFERENCES table_states(table_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_table_bills_table
  ON table_bills(table_id);

CREATE INDEX IF NOT EXISTS idx_table_bills_status
  ON table_bills(status);

CREATE TABLE IF NOT EXISTS table_locks (
  table_id TEXT PRIMARY KEY,
  user_id TEXT,
  device_uuid TEXT,
  acquired_at TEXT,
  heartbeat_at TEXT,
  expires_at TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_table_locks_user
  ON table_locks(user_id);

CREATE INDEX IF NOT EXISTS idx_table_locks_expires
  ON table_locks(expires_at);
