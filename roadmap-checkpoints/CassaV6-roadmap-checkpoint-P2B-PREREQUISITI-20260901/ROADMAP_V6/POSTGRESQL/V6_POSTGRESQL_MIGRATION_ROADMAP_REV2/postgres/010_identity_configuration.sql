-- DRAFT TARGET PostgreSQL — REV2 2026-08-31
BEGIN;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS configuration;

CREATE TABLE IF NOT EXISTS identity.users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text,
  password_hash text,
  pin_hash text,
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS identity.roles (id text PRIMARY KEY, name text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS identity.permissions (id text PRIMARY KEY, name text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS identity.user_roles (user_id text REFERENCES identity.users(id) ON DELETE CASCADE, role_id text REFERENCES identity.roles(id) ON DELETE CASCADE, PRIMARY KEY(user_id,role_id));
CREATE TABLE IF NOT EXISTS identity.role_permissions (role_id text REFERENCES identity.roles(id) ON DELETE CASCADE, permission_id text REFERENCES identity.permissions(id) ON DELETE CASCADE, PRIMARY KEY(role_id,permission_id));
CREATE TABLE IF NOT EXISTS identity.user_groups (id text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS identity.user_group_members (group_id text REFERENCES identity.user_groups(id) ON DELETE CASCADE, user_id text REFERENCES identity.users(id) ON DELETE CASCADE, PRIMARY KEY(group_id,user_id));
CREATE TABLE IF NOT EXISTS identity.sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity.users(id),
  token_hash text NOT NULL UNIQUE,
  device_uuid text,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_active_idx ON identity.sessions(user_id, expires_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS configuration.settings (
  scope text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id text,
  PRIMARY KEY(scope,key)
);
CREATE TABLE IF NOT EXISTS configuration.activities (id text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS configuration.workstations (id text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS configuration.devices (id text PRIMARY KEY, device_type text NOT NULL, name text, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS configuration.printers (id text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS configuration.fiscal_devices (id text PRIMARY KEY, name text NOT NULL, provider text, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS configuration.payment_terminals (id text PRIMARY KEY, name text NOT NULL, provider text, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS configuration.radio_channels (id text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
COMMIT;
