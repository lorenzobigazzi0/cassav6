import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runManualAuditEventsMigration } from "../scripts/migrate-app-state-to-relational.mjs";
import { runRelationalSchemaMigration } from "../scripts/migrate-relational-schema.mjs";
import {
  closeRelationalConnection,
  openRelationalConnection,
} from "../db/relational/index.js";
import { RELATIONAL_MIGRATIONS } from "../db/relational/migrations.js";
import {
  buildTestState,
  cassaRoot,
  createTempRunDir,
} from "./helpers/test-server.mjs";

const expectedMigrationVersions = RELATIONAL_MIGRATIONS.map((migration) => migration.version);

async function loadDatabaseSync() {
  const sqliteModule = await import("node:sqlite");
  return sqliteModule.DatabaseSync;
}

function buildAuditState() {
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-05-13T11:00:00.000Z";
  state.auditEvents = [
    {
      id: "evt_manual_a",
      occurredAt: "2026-05-13T11:01:00.000Z",
      actorUserId: "u_admin",
      actorRole: "ADMIN",
      roomId: "room_pedana",
      deviceId: "device-manual",
      action: "payment.completed",
      entityType: "payment",
      entityId: "pay_1",
      correlationId: "corr-manual",
      payload: { total: 42, nested: { ok: true } },
      before: { due: 42 },
      after: { due: 0 },
      deletedAt: null,
      deletedBy: null,
      deleteReason: null,
    },
    {
      id: "evt_manual_b",
      occurredAt: "2026-05-13T11:02:00.000Z",
      actorUserId: "u_admin",
      actorRole: "ADMIN",
      roomId: null,
      deviceId: null,
      action: "security.admin_delete",
      entityType: "audit_event",
      entityId: "evt_old",
      correlationId: null,
      payload: { reason: "manual" },
      before: null,
      after: { deleted: true },
      deletedAt: "2026-05-13T11:03:00.000Z",
      deletedBy: "u_admin",
      deleteReason: "manual cleanup",
    },
  ];
  return state;
}

async function writeJsonState(dbPath, state) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function writeSqliteDocumentState(dbPath, state) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO app_state (id, json, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          json = excluded.json,
          updated_at = excluded.updated_at
      `
    ).run(JSON.stringify(state), state.meta.lastWriteAt);
  } finally {
    db.close();
  }
}

async function openRelational(dbPath) {
  return openRelationalConnection({ enabled: true, mode: "shadow", dbPath });
}

async function readAuditRows(dbPath) {
  const db = await openRelational(dbPath);
  try {
    return db.prepare("SELECT * FROM audit_events ORDER BY app_state_position ASC").all();
  } finally {
    closeRelationalConnection(db);
  }
}

async function readSyncState(dbPath) {
  const db = await openRelational(dbPath);
  try {
    return db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'auditEvents'").get();
  } finally {
    closeRelationalConnection(db);
  }
}

async function runCli(env) {
  const child = spawn(process.execPath, ["backend/scripts/migrate-app-state-to-relational.mjs"], {
    cwd: cassaRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

async function runSchemaCli(env, scriptPath = "backend/scripts/migrate-relational-schema.mjs") {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: cassaRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

test("script importa auditEvents da app-state JSON temporaneo", async () => {
  const runDir = await createTempRunDir("rel-script-json");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  await writeJsonState(appStatePath, buildAuditState());

  const result = await runCli({
    BACKEND_DB_MODE: "json",
    BACKEND_DB_PATH: appStatePath,
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Modalita sorgente: json/);
  assert.match(result.stdout, /Righe importate: 2/);
  assert.match(result.stdout, /Esito finale: ok/);
  const rows = await readAuditRows(relationalPath);
  assert.deepEqual(rows.map((row) => row.id), ["evt_manual_a", "evt_manual_b"]);
});

test("script importa auditEvents da app_state SQLite documentale temporaneo", async () => {
  const runDir = await createTempRunDir("rel-script-sqlite");
  const sqlitePath = path.join(runDir, "backend.sqlite");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  await writeSqliteDocumentState(sqlitePath, buildAuditState());

  const result = await runManualAuditEventsMigration({
    BACKEND_DB_MODE: "sqlite",
    BACKEND_DB_PATH: sqlitePath,
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
  });

  assert.equal(result.sourceMode, "sqlite");
  assert.equal(result.importedRows, 2);
  const rows = await readAuditRows(relationalPath);
  assert.deepEqual(rows.map((row) => row.id), ["evt_manual_a", "evt_manual_b"]);
});

test("script fallisce con messaggio chiaro se app-state JSON e corrotto", async () => {
  const runDir = await createTempRunDir("rel-script-corrupt");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  await fs.writeFile(appStatePath, "{ json non valido", "utf8");

  const result = await runCli({
    BACKEND_DB_MODE: "json",
    BACKEND_DB_PATH: appStatePath,
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /App-state JSON non leggibile o corrotto/);
});

test("script non modifica app-state sorgente", async () => {
  const runDir = await createTempRunDir("rel-script-no-touch");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  await writeJsonState(appStatePath, buildAuditState());
  const before = await fs.readFile(appStatePath, "utf8");

  await runManualAuditEventsMigration({
    BACKEND_DB_MODE: "json",
    BACKEND_DB_PATH: appStatePath,
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
  });

  const after = await fs.readFile(appStatePath, "utf8");
  assert.equal(after, before);
});

test("script applica migrazioni se il DB relazionale e vuoto", async () => {
  const runDir = await createTempRunDir("rel-script-migrations");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  await writeJsonState(appStatePath, buildAuditState());

  await runManualAuditEventsMigration({
    BACKEND_DB_MODE: "json",
    BACKEND_DB_PATH: appStatePath,
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
  });

  const db = await openRelational(relationalPath);
  try {
    const migrations = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    assert.deepEqual(migrations.map((row) => row.version), expectedMigrationVersions);
    assert.equal(Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name = 'audit_events'").get()), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("script schema-only applica migrazioni senza app-state sorgente", async () => {
  const runDir = await createTempRunDir("rel-script-schema-only");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");

  const result = await runRelationalSchemaMigration({
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
  });

  assert.equal(result.ok, true);
  assert.equal(result.appliedMigrations, expectedMigrationVersions.length);
  const db = await openRelational(relationalPath);
  try {
    const migrations = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    assert.deepEqual(migrations.map((row) => row.version), expectedMigrationVersions);
    assert.equal(Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name = 'fiscal_outbox'").get()), true);
    assert.equal(Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_fiscal_outbox_lease'").get()), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("script schema-only CLI non richiede app-state sorgente", async () => {
  const runDir = await createTempRunDir("rel-script-schema-only-cli");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");

  const result = await runSchemaCli({
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Migrazioni registrate:/);
  assert.match(result.stdout, /Esito finale: ok/);
});

test("script schema-only CLI funziona attraverso il symlink current del deploy", async () => {
  const runDir = await createTempRunDir("rel-script-schema-only-symlink");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const currentLink = path.join(runDir, "current");
  await fs.symlink(cassaRoot, currentLink, "dir");

  const result = await runSchemaCli(
    { BACKEND_RELATIONAL_DB_PATH: relationalPath },
    path.join(currentLink, "backend", "scripts", "migrate-relational-schema.mjs"),
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Migrazioni registrate: ${RELATIONAL_MIGRATIONS.length}`));
  assert.match(result.stdout, /Esito finale: ok/);
});

test("script e idempotente: due run producono stesso row_count e checksum", async () => {
  const runDir = await createTempRunDir("rel-script-idempotent");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  await writeJsonState(appStatePath, buildAuditState());

  await runManualAuditEventsMigration({
    BACKEND_DB_MODE: "json",
    BACKEND_DB_PATH: appStatePath,
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
  });
  const first = await readSyncState(relationalPath);

  await runManualAuditEventsMigration({
    BACKEND_DB_MODE: "json",
    BACKEND_DB_PATH: appStatePath,
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
  });
  const second = await readSyncState(relationalPath);

  assert.equal(second.row_count, first.row_count);
  assert.equal(second.checksum, first.checksum);
});
