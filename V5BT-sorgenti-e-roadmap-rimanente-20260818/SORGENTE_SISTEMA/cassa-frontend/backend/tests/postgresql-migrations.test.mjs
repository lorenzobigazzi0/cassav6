import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checksumPostgresqlMigration,
  discoverPostgresqlMigrations,
  runPostgresqlMigrationsWithClient,
} from "../db/postgresql/index.js";
import { runPostgresqlSchemaMigration } from "../scripts/migrate-postgresql.mjs";

class FakeMigrationClient {
  constructor(options = {}) {
    this.appliedSql = [];
    this.failSql = options.failSql ?? null;
    this.registry = new Map();
    this.statements = [];
    this.lockAvailable = options.lockAvailable !== false;
  }

  async query(sql, params = []) {
    const statement = String(sql).trim();
    this.statements.push({ statement, params: [...params] });
    if (statement.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ locked: this.lockAvailable }] };
    if (statement.startsWith("SELECT pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }] };
    if (statement.startsWith("CREATE SCHEMA") || statement.startsWith("CREATE TABLE IF NOT EXISTS app_meta.schema_migrations")) {
      return { rows: [] };
    }
    if (statement.startsWith("SELECT version, checksum FROM app_meta.schema_migrations")) {
      const checksum = this.registry.get(String(params[0]));
      return { rows: checksum ? [{ version: String(params[0]), checksum }] : [] };
    }
    if (statement.startsWith("INSERT INTO app_meta.schema_migrations")) {
      this.registry.set(String(params[0]), String(params[1]));
      return { rowCount: 1, rows: [] };
    }
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [] };
    if (statement === this.failSql) {
      const error = new Error("errore SQL simulato");
      error.code = "42601";
      throw error;
    }
    this.appliedSql.push(statement);
    return { rows: [] };
  }
}

async function createMigrationDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cassav6-pg-migrations-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("discovery ordina i file e calcola checksum SHA-256 riproducibili", async (t) => {
  const dir = await createMigrationDir(t);
  await fs.writeFile(path.join(dir, "010_second.sql"), "SELECT 2;\n", "utf8");
  await fs.writeFile(path.join(dir, "001_first.sql"), "SELECT 1;\n", "utf8");

  const migrations = await discoverPostgresqlMigrations(dir);
  assert.deepEqual(migrations.map(({ version, name }) => ({ version, name })), [
    { version: "001", name: "first" },
    { version: "010", name: "second" },
  ]);
  assert.equal(migrations[0].checksum, checksumPostgresqlMigration("SELECT 1;\n"));
  assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/);
});

test("discovery rifiuta nomi non canonici e versioni duplicate", async (t) => {
  const invalidDir = await createMigrationDir(t);
  await fs.writeFile(path.join(invalidDir, "migrazione.sql"), "SELECT 1;\n", "utf8");
  await assert.rejects(() => discoverPostgresqlMigrations(invalidDir), /Nome file.*non valido/);

  const duplicateDir = await createMigrationDir(t);
  await fs.writeFile(path.join(duplicateDir, "001_first.sql"), "SELECT 1;\n", "utf8");
  await fs.writeFile(path.join(duplicateDir, "001_second.sql"), "SELECT 2;\n", "utf8");
  await assert.rejects(() => discoverPostgresqlMigrations(duplicateDir), /duplicata: 001/);
});

test("runner applica una migration una sola volta e conserva il checksum", async () => {
  const client = new FakeMigrationClient();
  const migration = {
    version: "001",
    name: "runner_test",
    sql: "CREATE TABLE runner_test(id integer PRIMARY KEY);",
  };

  const first = await runPostgresqlMigrationsWithClient(client, [migration], { nowMs: () => 10 });
  const second = await runPostgresqlMigrationsWithClient(client, [migration], { nowMs: () => 20 });

  assert.equal(first.applied.length, 1);
  assert.equal(first.skipped.length, 0);
  assert.equal(second.applied.length, 0);
  assert.equal(second.skipped.length, 1);
  assert.deepEqual(client.appliedSql, [migration.sql]);
  assert.equal(client.registry.get("001"), checksumPostgresqlMigration(migration.sql));
  assert.equal(client.statements.filter(({ statement }) => statement.startsWith("SELECT pg_try_advisory_lock")).length, 2);
  assert.equal(client.statements.filter(({ statement }) => statement.startsWith("SELECT pg_advisory_unlock")).length, 2);
});

test("runner blocca checksum drift su una migration gia applicata", async () => {
  const client = new FakeMigrationClient();
  await runPostgresqlMigrationsWithClient(client, [{
    version: "001",
    name: "immutable",
    sql: "SELECT 1;",
  }]);

  await assert.rejects(
    () => runPostgresqlMigrationsWithClient(client, [{
      version: "001",
      name: "immutable",
      sql: "SELECT 2;",
    }]),
    /Checksum drift.*non puo essere modificato/,
  );
  assert.equal(client.appliedSql.length, 1);
});

test("runner esegue rollback e non registra una migration fallita", async () => {
  const sql = "CREATE BROKEN OBJECT;";
  const client = new FakeMigrationClient({ failSql: sql });

  await assert.rejects(
    () => runPostgresqlMigrationsWithClient(client, [{ version: "001", name: "broken", sql }]),
    /001_broken fallita: errore SQL simulato/,
  );
  assert.equal(client.registry.size, 0);
  assert.equal(client.statements.some(({ statement }) => statement === "ROLLBACK"), true);
  assert.equal(client.statements.at(-1).statement.startsWith("SELECT pg_advisory_unlock"), true);
});

test("runner vieta transazioni dentro i file SQL", async () => {
  const client = new FakeMigrationClient();
  await assert.rejects(
    () => runPostgresqlMigrationsWithClient(client, [{
      version: "001",
      name: "nested_transaction",
      sql: "-- commento\nBEGIN;\nSELECT 1;\nCOMMIT;",
    }]),
    /contiene controllo transazione/,
  );
  assert.equal(client.statements.length, 0);
});

test("runner fallisce subito se un'altra istanza detiene il lock", async () => {
  const client = new FakeMigrationClient({ lockAvailable: false });
  await assert.rejects(
    () => runPostgresqlMigrationsWithClient(client, [{
      version: "001",
      name: "concurrent",
      sql: "SELECT 1;",
    }]),
    /gia attivo/,
  );
  assert.equal(client.statements.length, 1);
});

test("CLI --plan valida le migration senza richiedere credenziali o collegarsi", async (t) => {
  const dir = await createMigrationDir(t);
  await fs.writeFile(path.join(dir, "001_plan.sql"), "SELECT 1;\n", "utf8");

  const result = await runPostgresqlSchemaMigration({}, { migrationsDir: dir, planOnly: true });
  assert.equal(result.ok, true);
  assert.equal(result.planOnly, true);
  assert.deepEqual(result.migrations.map(({ version, name }) => ({ version, name })), [
    { version: "001", name: "plan" },
  ]);
});
