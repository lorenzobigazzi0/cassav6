ALTER TABLE orders ADD COLUMN last_event_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_orders_last_event_id
  ON orders(last_event_id);

ALTER TABLE table_states ADD COLUMN last_event_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_table_states_last_event_id
  ON table_states(last_event_id);
