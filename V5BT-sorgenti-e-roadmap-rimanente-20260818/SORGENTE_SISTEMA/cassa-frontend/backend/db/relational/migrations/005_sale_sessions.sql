CREATE TABLE IF NOT EXISTS sale_sessions (
  id TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  opened_by_user_id TEXT,
  closed_at TEXT,
  closed_by_user_id TEXT,
  status TEXT NOT NULL,
  opening_float_cents INTEGER,
  closing_total_cents INTEGER,
  notes TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sale_sessions_business_date
  ON sale_sessions(business_date);

CREATE INDEX IF NOT EXISTS idx_sale_sessions_status
  ON sale_sessions(status);

CREATE INDEX IF NOT EXISTS idx_sale_sessions_opened_at
  ON sale_sessions(opened_at);

CREATE TABLE IF NOT EXISTS solar_closures (
  id TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  closed_by_user_id TEXT,
  totals_json TEXT NOT NULL DEFAULT '{}',
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_solar_closures_business_date
  ON solar_closures(business_date);
