CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL,
  pin_hash TEXT,
  pin_salt TEXT,
  pin_params_json TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  default_room_id TEXT,
  last_selected_room_id TEXT,
  last_selected_room_name TEXT,
  last_selected_room_at TEXT,
  last_selected_room_device_uuid TEXT,
  raw_json TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
  ON users(username);

CREATE INDEX IF NOT EXISTS idx_users_role
  ON users(role);

CREATE INDEX IF NOT EXISTS idx_users_active
  ON users(active);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (user_id, permission),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_enabled_rooms (
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  PRIMARY KEY (user_id, room_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_authorized_rooms (
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  PRIMARY KEY (user_id, room_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_payment_methods (
  user_id TEXT NOT NULL,
  payment_method_id TEXT NOT NULL,
  PRIMARY KEY (user_id, payment_method_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
