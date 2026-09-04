CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  room_id TEXT,
  device_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  correlation_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  before_json TEXT,
  after_json TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  app_state_position INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_events_occurred_at
  ON audit_events(occurred_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_action
  ON audit_events(action);

CREATE INDEX IF NOT EXISTS idx_audit_events_entity
  ON audit_events(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_events_actor
  ON audit_events(actor_user_id);
