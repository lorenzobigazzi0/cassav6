CREATE TABLE IF NOT EXISTS order_id_allocator (
  scope TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL CHECK(next_value > 0),
  updated_at TEXT NOT NULL
);
