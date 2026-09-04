CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  service_date TEXT NOT NULL,
  state_key TEXT,
  reservation_at_ms INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT,
  covers INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  intolerances TEXT,
  note TEXT,
  assigned_table_id TEXT,
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  released_at_ms INTEGER,
  arrived_at_ms INTEGER,
  no_show_at_ms INTEGER,
  cancelled_at_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_reservations_room_date
  ON reservations(room_id, service_date, reservation_at_ms);

CREATE INDEX IF NOT EXISTS idx_reservations_status
  ON reservations(status);

CREATE INDEX IF NOT EXISTS idx_reservations_assigned_table
  ON reservations(assigned_table_id);

CREATE TABLE IF NOT EXISTS reservation_table_assignments (
  reservation_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  PRIMARY KEY (reservation_id, table_id),
  FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reservation_assignments_table
  ON reservation_table_assignments(table_id);

CREATE TABLE IF NOT EXISTS reservation_locks (
  reservation_id TEXT PRIMARY KEY,
  lock_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_uuid TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT,
  FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reservation_locks_user
  ON reservation_locks(user_id);

CREATE INDEX IF NOT EXISTS idx_reservation_locks_expires
  ON reservation_locks(expires_at_ms);

CREATE TABLE IF NOT EXISTS room_change_requests (
  request_id TEXT PRIMARY KEY,
  user_id TEXT,
  session_id TEXT,
  device_uuid TEXT,
  target_room_id TEXT,
  target_room_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at_ms INTEGER,
  expires_at_ms INTEGER,
  approved_at_ms INTEGER,
  cancelled_at_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_room_change_requests_user
  ON room_change_requests(user_id);

CREATE INDEX IF NOT EXISTS idx_room_change_requests_status
  ON room_change_requests(status);

CREATE TABLE IF NOT EXISTS table_room_move_requests (
  request_id TEXT PRIMARY KEY,
  requester_user_id TEXT,
  requester_username TEXT,
  requester_full_name TEXT,
  requester_device_uuid TEXT,
  from_room_id TEXT,
  from_room_name TEXT,
  target_room_id TEXT,
  target_room_name TEXT,
  from_table_id TEXT,
  from_table_label TEXT,
  target_table_ids_json TEXT,
  target_table_labels_json TEXT,
  source_leaf_count INTEGER,
  target_table_count INTEGER,
  adjust_covers_delta INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at_ms INTEGER,
  expires_at_ms INTEGER,
  approved_at_ms INTEGER,
  rejected_at_ms INTEGER,
  resolved_by_user_id TEXT,
  resolved_by_username TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_table_room_move_requests_target_room
  ON table_room_move_requests(target_room_id, status);

CREATE INDEX IF NOT EXISTS idx_table_room_move_requests_requester
  ON table_room_move_requests(requester_user_id, requester_device_uuid);

CREATE INDEX IF NOT EXISTS idx_table_room_move_requests_from_table
  ON table_room_move_requests(from_table_id);
