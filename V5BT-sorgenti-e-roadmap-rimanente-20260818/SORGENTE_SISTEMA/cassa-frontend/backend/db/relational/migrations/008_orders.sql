CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  table_id TEXT,
  room_id TEXT,
  status TEXT NOT NULL,
  source TEXT,
  total_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  paid_at TEXT,
  operator_user_id TEXT,
  station_id TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_table_id
  ON orders(table_id);

CREATE INDEX IF NOT EXISTS idx_orders_status
  ON orders(status);

CREATE INDEX IF NOT EXISTS idx_orders_created_at
  ON orders(created_at);

CREATE INDEX IF NOT EXISTS idx_orders_station_id
  ON orders(station_id);

CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_id TEXT,
  product_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  station_id TEXT,
  prepared_quantity REAL,
  delivered_quantity REAL,
  cancelled_quantity REAL,
  raw_json TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_lines_order_id
  ON order_lines(order_id);

CREATE INDEX IF NOT EXISTS idx_order_lines_product_id
  ON order_lines(product_id);

CREATE INDEX IF NOT EXISTS idx_order_lines_station_id
  ON order_lines(station_id);

CREATE TABLE IF NOT EXISTS order_line_variants (
  id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL,
  variant_id TEXT,
  name TEXT NOT NULL,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  FOREIGN KEY (line_id) REFERENCES order_lines(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_line_variants_line
  ON order_line_variants(line_id);

CREATE TABLE IF NOT EXISTS order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_user_id TEXT,
  payload_json TEXT,
  raw_json TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_events_order
  ON order_events(order_id);

CREATE INDEX IF NOT EXISTS idx_order_events_type
  ON order_events(event_type);
