CREATE TABLE IF NOT EXISTS commercial_config_versions (
  version_id TEXT PRIMARY KEY,
  version_number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  revision INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 2,
  source_version_id TEXT,
  snapshot_json TEXT NOT NULL,
  compiled_json TEXT,
  checksum TEXT NOT NULL,
  publication_note TEXT,
  created_at TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_by_username TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  updated_by_username TEXT NOT NULL,
  published_at TEXT,
  published_by_user_id TEXT,
  published_by_username TEXT,
  FOREIGN KEY (source_version_id) REFERENCES commercial_config_versions(version_id)
);

CREATE INDEX IF NOT EXISTS idx_commercial_config_versions_status_number
  ON commercial_config_versions(status, version_number DESC);

CREATE TABLE IF NOT EXISTS commercial_config_state (
  state_id INTEGER PRIMARY KEY CHECK (state_id = 1),
  current_published_version_id TEXT,
  current_draft_version_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (current_published_version_id) REFERENCES commercial_config_versions(version_id),
  FOREIGN KEY (current_draft_version_id) REFERENCES commercial_config_versions(version_id)
);

INSERT OR IGNORE INTO commercial_config_state (
  state_id,
  current_published_version_id,
  current_draft_version_id,
  updated_at
) VALUES (1, NULL, NULL, '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS commercial_products (
  version_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sku TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  tax_rate REAL,
  base_price_cents INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, product_id),
  FOREIGN KEY (version_id) REFERENCES commercial_config_versions(version_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_catalogs (
  version_id TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  base_price_list_id TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, catalog_id),
  FOREIGN KEY (version_id) REFERENCES commercial_config_versions(version_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_catalog_categories (
  version_id TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  department_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, catalog_id, category_id),
  FOREIGN KEY (version_id, catalog_id)
    REFERENCES commercial_catalogs(version_id, catalog_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_catalog_groups (
  version_id TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, catalog_id, category_id, group_id),
  FOREIGN KEY (version_id, catalog_id, category_id)
    REFERENCES commercial_catalog_categories(version_id, catalog_id, category_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_catalog_entries (
  version_id TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  sellable_type TEXT NOT NULL,
  sellable_id TEXT NOT NULL,
  group_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, catalog_id, category_id, entry_id),
  FOREIGN KEY (version_id, catalog_id, category_id)
    REFERENCES commercial_catalog_categories(version_id, catalog_id, category_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commercial_catalog_entries_sellable
  ON commercial_catalog_entries(version_id, sellable_type, sellable_id);

CREATE TABLE IF NOT EXISTS commercial_price_lists (
  version_id TEXT NOT NULL,
  price_list_id TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  inherits_from_id TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, price_list_id),
  FOREIGN KEY (version_id) REFERENCES commercial_config_versions(version_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_price_list_entries (
  version_id TEXT NOT NULL,
  price_list_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  sellable_type TEXT NOT NULL,
  sellable_id TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, price_list_id, entry_id),
  FOREIGN KEY (version_id, price_list_id)
    REFERENCES commercial_price_lists(version_id, price_list_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commercial_price_entries_sellable
  ON commercial_price_list_entries(version_id, sellable_type, sellable_id);

CREATE TABLE IF NOT EXISTS commercial_offers (
  version_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  pricing_strategy TEXT NOT NULL,
  tax_allocation_strategy TEXT NOT NULL,
  base_price_cents INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, offer_id),
  FOREIGN KEY (version_id) REFERENCES commercial_config_versions(version_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_offer_included_items (
  version_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  included_item_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, offer_id, included_item_id),
  FOREIGN KEY (version_id, offer_id)
    REFERENCES commercial_offers(version_id, offer_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_offer_choice_groups (
  version_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  min_selections INTEGER NOT NULL,
  max_selections INTEGER NOT NULL,
  included_selections INTEGER NOT NULL,
  allow_repeat INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, offer_id, group_id),
  FOREIGN KEY (version_id, offer_id)
    REFERENCES commercial_offers(version_id, offer_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_offer_choice_options (
  version_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  supplement_cents INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, offer_id, group_id, option_id),
  FOREIGN KEY (version_id, offer_id, group_id)
    REFERENCES commercial_offer_choice_groups(version_id, offer_id, group_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_assignments (
  version_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_to TEXT,
  weekdays_json TEXT NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (version_id, assignment_id),
  FOREIGN KEY (version_id) REFERENCES commercial_config_versions(version_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commercial_assignments_runtime
  ON commercial_assignments(version_id, target_type, scope_type, scope_id, enabled, priority);

CREATE TABLE IF NOT EXISTS commercial_config_audit_events (
  event_id TEXT PRIMARY KEY,
  version_id TEXT,
  action TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (version_id) REFERENCES commercial_config_versions(version_id)
);

CREATE INDEX IF NOT EXISTS idx_commercial_config_audit_version_time
  ON commercial_config_audit_events(version_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS commercial_config_commands (
  command_key TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  response_json TEXT NOT NULL
);
