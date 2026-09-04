CREATE TABLE IF NOT EXISTS menu_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  category_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 1,
  department TEXT,
  station_id TEXT,
  stations_json TEXT,
  metadata_json TEXT,
  raw_json TEXT,
  FOREIGN KEY (category_id) REFERENCES menu_categories(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_menu_items_category
  ON menu_items(category_id);

CREATE INDEX IF NOT EXISTS idx_menu_items_active_available
  ON menu_items(active, available);

CREATE TABLE IF NOT EXISTS menu_item_variants (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT,
  FOREIGN KEY (item_id) REFERENCES menu_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_menu_item_variants_item
  ON menu_item_variants(item_id);

CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  fiscal INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS pos_rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS pos_tables (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  name TEXT,
  number TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  layout_json TEXT,
  raw_json TEXT,
  FOREIGN KEY (room_id) REFERENCES pos_rooms(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pos_tables_room
  ON pos_tables(room_id);
