-- DRAFT TARGET PostgreSQL — REV2 2026-08-31
BEGIN;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS commerce;

CREATE TABLE IF NOT EXISTS catalog.products (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  sku text,
  barcode text,
  unit text,
  department text,
  tax_rate_bps integer CHECK(tax_rate_bps IS NULL OR (tax_rate_bps >= 0 AND tax_rate_bps <= 10000)),
  tax_code text,
  base_price_cents bigint NOT NULL DEFAULT 0 CHECK(base_price_cents >= 0),
  enabled boolean NOT NULL DEFAULT true,
  image_url text,
  revision bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS products_sku_unique ON catalog.products(sku) WHERE sku IS NOT NULL AND sku <> '';
CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_unique ON catalog.products(barcode) WHERE barcode IS NOT NULL AND barcode <> '';

CREATE TABLE IF NOT EXISTS catalog.product_variants (
  product_id text NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  price_delta_cents bigint NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY(product_id,id)
);
CREATE TABLE IF NOT EXISTS catalog.product_allergens (product_id text REFERENCES catalog.products(id) ON DELETE CASCADE, allergen text NOT NULL, PRIMARY KEY(product_id,allergen));
CREATE TABLE IF NOT EXISTS catalog.product_tags (product_id text REFERENCES catalog.products(id) ON DELETE CASCADE, tag text NOT NULL, PRIMARY KEY(product_id,tag));
CREATE TABLE IF NOT EXISTS catalog.product_routes (product_id text REFERENCES catalog.products(id) ON DELETE CASCADE, route_type text NOT NULL, route_id text NOT NULL, PRIMARY KEY(product_id,route_type,route_id));
CREATE TABLE IF NOT EXISTS catalog.product_ingredient_labels (product_id text REFERENCES catalog.products(id) ON DELETE CASCADE, position integer NOT NULL, label text NOT NULL, PRIMARY KEY(product_id,position));

CREATE TABLE IF NOT EXISTS commerce.config_versions (
  id text PRIMARY KEY,
  version_number bigint NOT NULL UNIQUE,
  status text NOT NULL CHECK(status IN ('draft','published','archived')),
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  checksum text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS commerce.config_state (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), published_version_id text REFERENCES commerce.config_versions(id), draft_version_id text REFERENCES commerce.config_versions(id), updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS catalog.catalogs (version_id text NOT NULL REFERENCES commerce.config_versions(id) ON DELETE CASCADE, id text NOT NULL, name text NOT NULL, status text NOT NULL, is_default boolean NOT NULL DEFAULT false, base_price_list_id text, payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(version_id,id));
CREATE TABLE IF NOT EXISTS catalog.catalog_categories (version_id text NOT NULL, catalog_id text NOT NULL, id text NOT NULL, name text NOT NULL, department_id text, sort_order integer NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(version_id,catalog_id,id), FOREIGN KEY(version_id,catalog_id) REFERENCES catalog.catalogs(version_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS catalog.catalog_groups (version_id text NOT NULL, catalog_id text NOT NULL, category_id text NOT NULL, id text NOT NULL, name text NOT NULL, sort_order integer NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(version_id,catalog_id,category_id,id), FOREIGN KEY(version_id,catalog_id,category_id) REFERENCES catalog.catalog_categories(version_id,catalog_id,id) ON DELETE CASCADE);
-- REV2: aggiunta FK verso catalog_groups (group_id era orfano).
CREATE TABLE IF NOT EXISTS catalog.catalog_entries (version_id text NOT NULL, catalog_id text NOT NULL, category_id text NOT NULL, id text NOT NULL, sellable_type text NOT NULL CHECK(sellable_type IN ('product','offer')), sellable_id text NOT NULL, group_id text, sort_order integer NOT NULL DEFAULT 0, visible boolean NOT NULL DEFAULT true, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(version_id,catalog_id,category_id,id), FOREIGN KEY(version_id,catalog_id,category_id) REFERENCES catalog.catalog_categories(version_id,catalog_id,id) ON DELETE CASCADE, FOREIGN KEY(version_id,catalog_id,category_id,group_id) REFERENCES catalog.catalog_groups(version_id,catalog_id,category_id,id) ON DELETE SET NULL);

CREATE TABLE IF NOT EXISTS commerce.price_lists (version_id text NOT NULL REFERENCES commerce.config_versions(id) ON DELETE CASCADE, id text NOT NULL, catalog_id text NOT NULL, name text NOT NULL, currency text NOT NULL DEFAULT 'EUR', status text NOT NULL, inherits_from_id text, payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(version_id,id));
CREATE TABLE IF NOT EXISTS commerce.price_list_entries (version_id text NOT NULL, price_list_id text NOT NULL, id text NOT NULL, sellable_type text NOT NULL CHECK(sellable_type IN ('product','offer','variant','offer_option')), sellable_id text NOT NULL, price_cents bigint NOT NULL, available boolean NOT NULL DEFAULT true, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(version_id,price_list_id,id), FOREIGN KEY(version_id,price_list_id) REFERENCES commerce.price_lists(version_id,id) ON DELETE CASCADE);

CREATE TABLE IF NOT EXISTS commerce.offers (version_id text NOT NULL REFERENCES commerce.config_versions(id) ON DELETE CASCADE, id text NOT NULL, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, pricing_strategy text NOT NULL CHECK(pricing_strategy IN ('fixed','sum_components')), tax_allocation_strategy text NOT NULL CHECK(tax_allocation_strategy IN ('proportional','dominant_rate','component_exact')), base_price_cents bigint NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(version_id,id));
CREATE TABLE IF NOT EXISTS commerce.offer_included_items (version_id text NOT NULL, offer_id text NOT NULL, id text NOT NULL, product_id text NOT NULL REFERENCES catalog.products(id), quantity integer NOT NULL CHECK(quantity>0), payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(version_id,offer_id,id), FOREIGN KEY(version_id,offer_id) REFERENCES commerce.offers(version_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS commerce.offer_choice_groups (version_id text NOT NULL, offer_id text NOT NULL, id text NOT NULL, name text NOT NULL, min_selections integer NOT NULL, max_selections integer NOT NULL, included_selections integer NOT NULL DEFAULT 0, allow_repeat boolean NOT NULL DEFAULT false, sort_order integer NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(version_id,offer_id,id), FOREIGN KEY(version_id,offer_id) REFERENCES commerce.offers(version_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS commerce.offer_choice_options (version_id text NOT NULL, offer_id text NOT NULL, group_id text NOT NULL, id text NOT NULL, product_id text NOT NULL REFERENCES catalog.products(id), quantity integer NOT NULL DEFAULT 1 CHECK(quantity>0), supplement_cents bigint NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(version_id,offer_id,group_id,id), FOREIGN KEY(version_id,offer_id,group_id) REFERENCES commerce.offer_choice_groups(version_id,offer_id,id) ON DELETE CASCADE);

CREATE TABLE IF NOT EXISTS commerce.assignments (version_id text NOT NULL REFERENCES commerce.config_versions(id) ON DELETE CASCADE, id text NOT NULL, target_type text NOT NULL CHECK(target_type IN ('catalog','price_list')), target_id text NOT NULL, scope_type text NOT NULL CHECK(scope_type IN ('global','channel','activity','room','workstation','role','user_group','user')), scope_id text NOT NULL, priority integer NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true, valid_from timestamptz, valid_to timestamptz, weekdays smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]::smallint[], start_minute integer NOT NULL DEFAULT 0 CHECK(start_minute BETWEEN 0 AND 1439), end_minute integer NOT NULL DEFAULT 1440 CHECK(end_minute BETWEEN 1 AND 1440), payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(version_id,id));

-- Ingredient labels esistenti NON equivalgono a ricette.
-- REV2 / PERIMETRO: le tabelle inventory.* sono create come target ma NON vengono
-- popolate ne usate durante la migrazione. Il dominio ricette e un progetto
-- separato: vedi ANNEX_A_FUORI_PERIMETRO.md sezione A.1. In migrazione si popola
-- soltanto catalog.product_ingredient_labels.
CREATE TABLE IF NOT EXISTS inventory.units (id text PRIMARY KEY, symbol text NOT NULL UNIQUE, name text NOT NULL, dimension text NOT NULL, factor_to_base numeric(20,8));
CREATE TABLE IF NOT EXISTS inventory.ingredients (id text PRIMARY KEY, name text NOT NULL, default_unit_id text REFERENCES inventory.units(id), enabled boolean NOT NULL DEFAULT true, allergen_metadata jsonb NOT NULL DEFAULT '[]'::jsonb, revision bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS inventory.recipes (id text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, revision bigint NOT NULL DEFAULT 0, metadata jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS inventory.recipe_versions (recipe_id text NOT NULL REFERENCES inventory.recipes(id) ON DELETE CASCADE, version bigint NOT NULL, status text NOT NULL CHECK(status IN ('draft','published','archived')), yield_quantity numeric(20,6), yield_unit_id text REFERENCES inventory.units(id), created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, PRIMARY KEY(recipe_id,version));
CREATE TABLE IF NOT EXISTS inventory.recipe_components (recipe_id text NOT NULL, recipe_version bigint NOT NULL, position integer NOT NULL, component_type text NOT NULL CHECK(component_type IN ('ingredient','recipe')), ingredient_id text REFERENCES inventory.ingredients(id), child_recipe_id text REFERENCES inventory.recipes(id), quantity numeric(20,6) NOT NULL CHECK(quantity>0), unit_id text NOT NULL REFERENCES inventory.units(id), waste_bps integer NOT NULL DEFAULT 0 CHECK(waste_bps BETWEEN 0 AND 10000), PRIMARY KEY(recipe_id,recipe_version,position), FOREIGN KEY(recipe_id,recipe_version) REFERENCES inventory.recipe_versions(recipe_id,version) ON DELETE CASCADE, CHECK((component_type='ingredient' AND ingredient_id IS NOT NULL AND child_recipe_id IS NULL) OR (component_type='recipe' AND child_recipe_id IS NOT NULL AND ingredient_id IS NULL)));
CREATE TABLE IF NOT EXISTS inventory.product_recipe_links (product_id text PRIMARY KEY REFERENCES catalog.products(id) ON DELETE CASCADE, recipe_id text NOT NULL REFERENCES inventory.recipes(id), active_recipe_version bigint, servings numeric(20,6) NOT NULL DEFAULT 1 CHECK(servings>0));

-- REV2 / PERIMETRO: le tabelle commerce.promotion* sono create come target ma NON
-- vengono popolate ne usate durante la migrazione. Il motore promozioni automatiche
-- e un progetto separato: vedi ANNEX_A_FUORI_PERIMETRO.md sezione A.2.
-- Restano invece IN PERIMETRO le tabelle benefit_* (coupon/voucher esistenti).
CREATE TABLE IF NOT EXISTS commerce.promotions (id text PRIMARY KEY, version_id text NOT NULL REFERENCES commerce.config_versions(id) ON DELETE CASCADE, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, priority integer NOT NULL DEFAULT 0, exclusivity_group text, stackable boolean NOT NULL DEFAULT false, valid_from timestamptz, valid_to timestamptz, revision bigint NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS commerce.promotion_conditions (promotion_id text REFERENCES commerce.promotions(id) ON DELETE CASCADE, position integer NOT NULL, condition_type text NOT NULL, config jsonb NOT NULL, PRIMARY KEY(promotion_id,position));
CREATE TABLE IF NOT EXISTS commerce.promotion_actions (promotion_id text REFERENCES commerce.promotions(id) ON DELETE CASCADE, position integer NOT NULL, action_type text NOT NULL, config jsonb NOT NULL, PRIMARY KEY(promotion_id,position));
CREATE TABLE IF NOT EXISTS commerce.promotion_scopes (promotion_id text REFERENCES commerce.promotions(id) ON DELETE CASCADE, scope_type text NOT NULL, scope_id text NOT NULL, PRIMARY KEY(promotion_id,scope_type,scope_id));
CREATE TABLE IF NOT EXISTS commerce.promotion_usage (promotion_id text REFERENCES commerce.promotions(id) ON DELETE CASCADE, subject_type text NOT NULL, subject_id text NOT NULL, usage_count bigint NOT NULL DEFAULT 0, last_used_at timestamptz, PRIMARY KEY(promotion_id,subject_type,subject_id));

CREATE TABLE IF NOT EXISTS commerce.benefit_campaigns (id text PRIMARY KEY, title text NOT NULL, benefit_kind text NOT NULL CHECK(benefit_kind IN ('fixed_discount','value_voucher','percentage_discount')), amount_cents bigint NOT NULL DEFAULT 0, face_value_cents bigint NOT NULL DEFAULT 0, percentage_bps integer NOT NULL DEFAULT 0, max_discount_cents bigint NOT NULL DEFAULT 0, residual_policy text, valid_from timestamptz NOT NULL, valid_until timestamptz, max_usage_count bigint NOT NULL DEFAULT 1, unlimited_usage boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT true, conditions jsonb NOT NULL DEFAULT '{}'::jsonb, revision bigint NOT NULL DEFAULT 0);
-- REV2: il gate "doppia redemption impossibile" deve stare nello schema, non solo
-- nella transazione. remaining_cents non puo scendere sotto zero ne superare il
-- valore nominale, qualunque sia il codice applicativo che ci scrive.
CREATE TABLE IF NOT EXISTS commerce.benefit_coupons (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES commerce.benefit_campaigns(id),
  code_hash text NOT NULL UNIQUE,
  masked_code text,
  face_value_cents bigint NOT NULL DEFAULT 0 CHECK(face_value_cents >= 0),
  remaining_cents bigint NOT NULL DEFAULT 0 CHECK(remaining_cents >= 0),
  usage_count bigint NOT NULL DEFAULT 0 CHECK(usage_count >= 0),
  status text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT coupon_remaining_within_face CHECK(remaining_cents <= face_value_cents)
);
CREATE TABLE IF NOT EXISTS commerce.benefit_applications (id text PRIMARY KEY, coupon_id text NOT NULL REFERENCES commerce.benefit_coupons(id), order_id text, payment_id text, status text NOT NULL CHECK(status IN ('reserved','released','redeemed','expired')), reserved_cents bigint NOT NULL DEFAULT 0 CHECK(reserved_cents >= 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
-- REV2: al piu una prenotazione attiva per coupon. Impedisce la doppia riserva
-- concorrente a livello di schema, non solo di transazione.
CREATE UNIQUE INDEX IF NOT EXISTS benefit_application_active_unique ON commerce.benefit_applications(coupon_id) WHERE status = 'reserved';
CREATE TABLE IF NOT EXISTS commerce.benefit_redemptions (id text PRIMARY KEY, coupon_id text NOT NULL REFERENCES commerce.benefit_coupons(id), application_id text REFERENCES commerce.benefit_applications(id), payment_id text, amount_cents bigint NOT NULL CHECK(amount_cents>0), redeemed_at timestamptz NOT NULL DEFAULT now());
COMMIT;
