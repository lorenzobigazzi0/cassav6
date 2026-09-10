CREATE SCHEMA IF NOT EXISTS identity;

REVOKE ALL ON SCHEMA identity FROM PUBLIC;

CREATE TABLE identity.roles (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.permissions (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.users (
  id text PRIMARY KEY,
  username text NOT NULL,
  full_name text,
  role_id text NOT NULL REFERENCES identity.roles(id),
  role_label text,
  pin_hash text,
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX identity_users_username_ci_uq
  ON identity.users(lower(username));

CREATE TABLE identity.user_permissions (
  user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  permission_id text NOT NULL REFERENCES identity.permissions(id),
  PRIMARY KEY (user_id, permission_id)
);

CREATE TABLE identity.user_groups (
  id text PRIMARY KEY,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.group_permissions (
  group_id text NOT NULL REFERENCES identity.user_groups(id) ON DELETE CASCADE,
  permission_id text NOT NULL REFERENCES identity.permissions(id),
  PRIMARY KEY (group_id, permission_id)
);

CREATE TABLE identity.user_group_members (
  group_id text NOT NULL REFERENCES identity.user_groups(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX identity_user_group_members_user_idx
  ON identity.user_group_members(user_id, group_id);

REVOKE ALL ON ALL TABLES IN SCHEMA identity FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO cassav6_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO cassav6_runtime;

COMMENT ON SCHEMA identity IS 'Directory utenti, ruoli, permessi e gruppi; le sessioni sono introdotte separatamente da MIG-041.';
COMMENT ON TABLE identity.users IS 'Identita utente autorevole; payload conserva senza perdita gli attributi legacy non ancora normalizzati.';
COMMENT ON TABLE identity.user_permissions IS 'Permessi effettivi materializzati per conservare la semantica legacy durante il primo cutover.';
COMMENT ON TABLE identity.user_groups IS 'Gruppi utente con payload lossless per room, workstation e policy applicative.';

