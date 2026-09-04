-- DRAFT TARGET PostgreSQL — REV2 2026-08-31
BEGIN;
CREATE SCHEMA IF NOT EXISTS sales;
CREATE SCHEMA IF NOT EXISTS reservations;
CREATE SCHEMA IF NOT EXISTS operations;

CREATE TABLE IF NOT EXISTS sales.rooms (id text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS sales.tables (id text PRIMARY KEY, room_id text NOT NULL REFERENCES sales.rooms(id), number_label text, label text, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS sales.table_groups (id text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS sales.table_group_members (group_id text REFERENCES sales.table_groups(id) ON DELETE CASCADE, table_id text REFERENCES sales.tables(id) ON DELETE CASCADE, PRIMARY KEY(group_id,table_id));
CREATE TABLE IF NOT EXISTS sales.table_states (table_id text PRIMARY KEY REFERENCES sales.tables(id) ON DELETE CASCADE, status text NOT NULL, guest_name text, covers integer NOT NULL DEFAULT 0 CHECK(covers>=0), sale_session_id text, opened_at timestamptz, revision bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sales.table_work_locks (table_id text PRIMARY KEY REFERENCES sales.tables(id) ON DELETE CASCADE, user_id text, username text, device_uuid text, session_id text, purpose text, acquired_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revision bigint NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS sales.sale_session_templates (id text PRIMARY KEY, name text NOT NULL, start_time time NOT NULL, end_time time NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS sales.sale_sessions (id text PRIMARY KEY, template_id text REFERENCES sales.sale_session_templates(id), status text NOT NULL, opened_at timestamptz NOT NULL, closed_at timestamptz, opened_by_user_id text, closed_by_user_id text, revision bigint NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS sales.solar_closures (id text PRIMARY KEY, business_date date NOT NULL, sale_session_id text REFERENCES sales.sale_sessions(id), closed_at timestamptz NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb);

CREATE TABLE IF NOT EXISTS sales.orders (
  id text PRIMARY KEY,
  order_number bigint,
  table_id text REFERENCES sales.tables(id),
  room_id text REFERENCES sales.rooms(id),
  sale_session_id text REFERENCES sales.sale_sessions(id),
  status text NOT NULL,
  created_by_user_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  commercial_version_id text,
  currency text NOT NULL DEFAULT 'EUR',
  total_cents bigint NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS orders_open_table_idx ON sales.orders(table_id,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS sales.order_lines (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES sales.orders(id) ON DELETE CASCADE,
  product_id text,
  offer_id text,
  product_name_snapshot text NOT NULL,
  quantity integer NOT NULL CHECK(quantity>0),
  unit_price_cents bigint NOT NULL,
  discount_cents bigint NOT NULL DEFAULT 0,
  tax_rate_bps integer,
  tax_code text,
  status text NOT NULL,
  pricing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS order_lines_order_idx ON sales.order_lines(order_id);
CREATE TABLE IF NOT EXISTS sales.order_line_variants (order_line_id text REFERENCES sales.order_lines(id) ON DELETE CASCADE, id text NOT NULL, name_snapshot text NOT NULL, price_delta_cents bigint NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(order_line_id,id));
CREATE TABLE IF NOT EXISTS sales.order_events (id text PRIMARY KEY, order_id text NOT NULL REFERENCES sales.orders(id) ON DELETE CASCADE, event_type text NOT NULL, actor_user_id text, occurred_at timestamptz NOT NULL DEFAULT now(), revision bigint, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE INDEX IF NOT EXISTS order_events_order_time_idx ON sales.order_events(order_id,occurred_at);

-- REV2: aggiunta due_cents (mancava, era nel doc 05) e vincoli di coerenza monetaria.
CREATE TABLE IF NOT EXISTS sales.bills (
  id text PRIMARY KEY,
  table_id text REFERENCES sales.tables(id),
  status text NOT NULL,
  subtotal_cents bigint NOT NULL DEFAULT 0,
  discount_cents bigint NOT NULL DEFAULT 0 CHECK(discount_cents >= 0),
  tax_cents bigint NOT NULL DEFAULT 0 CHECK(tax_cents >= 0),
  total_cents bigint NOT NULL DEFAULT 0 CHECK(total_cents >= 0),
  paid_cents bigint NOT NULL DEFAULT 0 CHECK(paid_cents >= 0),
  due_cents bigint NOT NULL DEFAULT 0 CHECK(due_cents >= 0),
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bills_no_overpayment CHECK(paid_cents <= total_cents),
  CONSTRAINT bills_balance CHECK(total_cents = paid_cents + due_cents)
);
CREATE INDEX IF NOT EXISTS bills_open_idx ON sales.bills(status, updated_at DESC) WHERE due_cents > 0;
CREATE TABLE IF NOT EXISTS sales.bill_order_links (bill_id text REFERENCES sales.bills(id) ON DELETE CASCADE, order_id text REFERENCES sales.orders(id) ON DELETE RESTRICT, PRIMARY KEY(bill_id,order_id));

CREATE TABLE IF NOT EXISTS reservations.reservations (id text PRIMARY KEY, status text NOT NULL, guest_name text, phone text, covers integer NOT NULL DEFAULT 0, starts_at timestamptz NOT NULL, ends_at timestamptz, room_id text REFERENCES sales.rooms(id), notes text, revision bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS reservations.table_assignments (reservation_id text REFERENCES reservations.reservations(id) ON DELETE CASCADE, table_id text REFERENCES sales.tables(id), PRIMARY KEY(reservation_id,table_id));
CREATE TABLE IF NOT EXISTS reservations.locks (reservation_id text PRIMARY KEY REFERENCES reservations.reservations(id) ON DELETE CASCADE, user_id text, device_uuid text, acquired_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revision bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reservations.room_change_requests (id text PRIMARY KEY, reservation_id text REFERENCES reservations.reservations(id), from_room_id text, to_room_id text, status text NOT NULL, requested_by_user_id text, resolved_by_user_id text, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS reservations.table_room_move_requests (id text PRIMARY KEY, table_id text REFERENCES sales.tables(id), from_room_id text, to_room_id text, status text NOT NULL, requested_by_user_id text, resolved_by_user_id text, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, payload jsonb NOT NULL DEFAULT '{}'::jsonb);

CREATE TABLE IF NOT EXISTS operations.stations (id text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS operations.station_states (station_id text PRIMARY KEY REFERENCES operations.stations(id) ON DELETE CASCADE, active boolean NOT NULL DEFAULT false, paused boolean NOT NULL DEFAULT false, operator_user_id text, device_uuid text, last_heartbeat_at timestamptz, revision bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS operations.order_fulfillment_events (id text PRIMARY KEY, order_id text REFERENCES sales.orders(id), order_line_id text REFERENCES sales.order_lines(id), station_id text REFERENCES operations.stations(id), event_type text NOT NULL, actor_user_id text, occurred_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL DEFAULT '{}'::jsonb);
COMMIT;
