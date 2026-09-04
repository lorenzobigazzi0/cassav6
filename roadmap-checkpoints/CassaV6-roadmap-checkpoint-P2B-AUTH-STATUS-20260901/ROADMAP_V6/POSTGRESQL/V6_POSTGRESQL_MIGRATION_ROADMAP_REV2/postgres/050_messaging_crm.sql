-- DRAFT TARGET PostgreSQL — REV2 2026-08-31
BEGIN;
CREATE SCHEMA IF NOT EXISTS messaging;
CREATE SCHEMA IF NOT EXISTS crm;
CREATE SCHEMA IF NOT EXISTS operations;
CREATE SCHEMA IF NOT EXISTS fiscal;

CREATE TABLE IF NOT EXISTS messaging.notifications (id text PRIMARY KEY, type text NOT NULL, priority text, title text, message text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS messaging.notification_targets (notification_id text REFERENCES messaging.notifications(id) ON DELETE CASCADE, target_type text NOT NULL, target_id text NOT NULL, PRIMARY KEY(notification_id,target_type,target_id));
CREATE TABLE IF NOT EXISTS messaging.notification_receipts (notification_id text REFERENCES messaging.notifications(id) ON DELETE CASCADE, user_id text, device_uuid text, delivered_at timestamptz, read_at timestamptz, PRIMARY KEY(notification_id,user_id,device_uuid));

CREATE TABLE IF NOT EXISTS operations.waiter_pauses (id text PRIMARY KEY, user_id text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz, reason text, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS operations.waiter_deferred_calls (id text PRIMARY KEY, user_id text, table_id text, due_at timestamptz, status text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS operations.device_status_events (id text PRIMARY KEY, device_id text NOT NULL, event_type text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL DEFAULT '{}'::jsonb);

CREATE TABLE IF NOT EXISTS crm.customers (id text PRIMARY KEY, display_name text, enabled boolean NOT NULL DEFAULT true, revision bigint NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS crm.customer_passes (id text PRIMARY KEY, customer_id text NOT NULL REFERENCES crm.customers(id) ON DELETE CASCADE, pass_type text, status text NOT NULL, valid_from timestamptz, valid_until timestamptz, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS crm.customer_access_events (id text PRIMARY KEY, customer_id text NOT NULL REFERENCES crm.customers(id) ON DELETE CASCADE, pass_id text REFERENCES crm.customer_passes(id), event_type text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS crm.customer_transactions (id text PRIMARY KEY, customer_id text NOT NULL REFERENCES crm.customers(id) ON DELETE CASCADE, payment_id text, transaction_type text NOT NULL, amount_cents bigint NOT NULL DEFAULT 0, occurred_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL DEFAULT '{}'::jsonb);

CREATE TABLE IF NOT EXISTS fiscal.non_fiscal_transactions (id text PRIMARY KEY, customer_id text REFERENCES crm.customers(id), transaction_type text NOT NULL, amount_cents bigint NOT NULL DEFAULT 0, occurred_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL DEFAULT '{}'::jsonb);
COMMIT;
