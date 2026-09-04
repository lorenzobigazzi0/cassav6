import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_POSTGRESQL_MIGRATIONS_DIR,
  discoverPostgresqlMigrations,
} from "../db/postgresql/index.js";
import { runPostgresqlSchemaMigration } from "../scripts/migrate-postgresql.mjs";

const provisionScriptPath = path.resolve(
  "scripts/postgresql-migration/provision-postgresql-dev-sd.sh",
);

test("le migration foundation PostgreSQL restano ordinate per responsabilita", async () => {
  const migrations = await discoverPostgresqlMigrations();
  assert.deepEqual(
    migrations.map(({ version, name }) => ({ version, name })),
    [
      { version: "001", name: "foundation" },
      { version: "002", name: "event_outbox_lease_contract" },
      { version: "003", name: "audit_events_append_only" },
      { version: "004", name: "idempotency_store_contract" },
      { version: "005", name: "retention_control_plane" },
      { version: "006", name: "audit_events_partitioned_retention" },
    ],
  );
  assert.equal(migrations.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)), true);

  const plan = await runPostgresqlSchemaMigration({}, { planOnly: true });
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.migrations,
    migrations.map(({ version, name, checksum }) => ({ version, name, checksum })),
  );
});

test("MIG-020 crea solo gli schemi e gli oggetti foundation previsti", async () => {
  const [{ sql }] = await discoverPostgresqlMigrations(DEFAULT_POSTGRESQL_MIGRATIONS_DIR);
  for (const schema of ["audit", "messaging"]) {
    assert.match(sql, new RegExp(`CREATE SCHEMA IF NOT EXISTS ${schema};`));
  }
  for (const table of [
    "audit.events",
    "messaging.idempotency_keys",
    "messaging.command_inbox",
    "messaging.event_outbox",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table.replace(".", "\\.")} \\(`));
  }
  for (const index of [
    "audit_events_aggregate_time_idx",
    "idempotency_expiry_idx",
    "event_outbox_claimable_idx",
    "event_outbox_lease_idx",
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX ${index}`));
  }
  assert.match(sql, /attempt_count integer NOT NULL DEFAULT 0 CHECK\(attempt_count >= 0\)/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS/i);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im);
  assert.doesNotMatch(sql, /CREATE\s+ROLE|ALTER\s+ROLE/i);
});

test("MIG-020 mantiene DDL e cancellazioni fuori dal ruolo runtime", async () => {
  const [{ sql }] = await discoverPostgresqlMigrations(DEFAULT_POSTGRESQL_MIGRATIONS_DIR);
  assert.match(sql, /GRANT USAGE ON SCHEMA audit, messaging TO cassav6_runtime;/);
  assert.match(sql, /GRANT SELECT, INSERT ON audit\.events TO cassav6_runtime;/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON messaging\.idempotency_keys TO cassav6_runtime;/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON messaging\.command_inbox TO cassav6_runtime;/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON messaging\.event_outbox TO cassav6_runtime;/);
  assert.doesNotMatch(sql, /GRANT\s+(?:ALL|CREATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)[^;]*TO cassav6_runtime/i);
  assert.doesNotMatch(sql, /TO cassav6_app/i);
  assert.match(sql, /REVOKE ALL ON app_meta\.schema_migrations FROM PUBLIC;/);
});

test("il provisioning separa login applicativo e ruolo runtime senza login", async () => {
  const source = await fs.readFile(provisionScriptPath, "utf8");
  assert.match(source, /PG_RUNTIME_ROLE="\$\{PG_RUNTIME_ROLE:-cassav6_runtime\}"/);
  assert.match(source, /CREATE ROLE %I NOLOGIN/);
  assert.match(source, /ALTER ROLE \$\{PG_RUNTIME_ROLE\} WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT/);
  assert.match(source, /ALTER ROLE \$\{PG_APP_ROLE\} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT/);
  assert.match(source, /GRANT \$\{PG_RUNTIME_ROLE\} TO \$\{PG_APP_ROLE\};/);
});
