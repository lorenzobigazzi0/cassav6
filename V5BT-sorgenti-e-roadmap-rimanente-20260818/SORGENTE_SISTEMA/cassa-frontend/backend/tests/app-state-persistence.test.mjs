import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildTestState,
  cassaRoot,
  createTempRunDir,
  freePort,
  readJson,
  TEST_TOKEN_SECRET,
  waitForHealth,
} from "./helpers/test-server.mjs";
import { readJsonStateFile, writeJsonStateFile } from "../db/app-state/index.js";

async function loadDatabaseSync() {
  const sqliteModule = await import("node:sqlite");
  return sqliteModule.DatabaseSync;
}

async function writeSqliteState(dbPath, state) {
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
    ).run(JSON.stringify(state), String(state.meta?.lastWriteAt ?? new Date().toISOString()));
  } finally {
    db.close();
  }
}

async function readSqliteState(dbPath) {
  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const row = db.prepare("SELECT json FROM app_state WHERE id = 1").get();
    assert.equal(typeof row?.json, "string");
    return JSON.parse(row.json);
  } finally {
    db.close();
  }
}

async function readSqliteRawAppState(dbPath) {
  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT json FROM app_state WHERE id = 1").get();
    return row?.json;
  } finally {
    db.close();
  }
}

function productionEnv(extra = {}) {
  return {
    ...process.env,
    NODE_ENV: "production",
    BACKEND_HOST: "127.0.0.1",
    BACKEND_TOKEN_SECRET: TEST_TOKEN_SECRET,
    SMART_CARD_READER_MODE: "push",
    SMART_CARD_PUSH_TOKEN: "test-smart-card-token",
    SMART_CARD_AUTO_DETECT: "0",
    FISCAL_PROVIDER: "real-provider",
    PRINTING_ENABLED: "0",
    ENABLE_DEBUG_ENDPOINTS: "0",
    ENABLE_MAINTENANCE_ENDPOINTS: "0",
    ...extra,
  };
}

function testEnv(extra = {}) {
  return {
    ...process.env,
    NODE_ENV: "test",
    BACKEND_HOST: "127.0.0.1",
    BACKEND_TOKEN_SECRET: TEST_TOKEN_SECRET,
    SMART_CARD_READER_MODE: "push",
    SMART_CARD_PUSH_TOKEN: "test-smart-card-token",
    SMART_CARD_AUTO_DETECT: "0",
    FISCAL_PROVIDER: "mock",
    PRINTING_ENABLED: "0",
    ENABLE_DEBUG_ENDPOINTS: "0",
    ENABLE_MAINTENANCE_ENDPOINTS: "0",
    ...extra,
  };
}

function spawnBackend(env, stdio = ["ignore", "ignore", "pipe"]) {
  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: cassaRoot,
    env,
    stdio,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return { child, getStderr: () => stderr };
}

async function waitForExit(child, timeoutMs = 10_000) {
  const exitPromise = once(child, "exit");
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      reject(new Error("Timed out waiting for backend process exit"));
    }, timeoutMs);
    timer.unref?.();
  });
  const [code, signal] = await Promise.race([exitPromise, timeout]);
  return { code, signal };
}

async function startBackendWithDb(t, { mode, dbPath, state = buildTestState(), env = {} }) {
  if (state) {
    if (mode === "sqlite") {
      await writeSqliteState(dbPath, state);
    } else {
      await writeJsonStateFile(dbPath, `${dbPath}.tmp`, state);
    }
  }

  const port = await freePort();
  const { child } = spawnBackend(
    testEnv({
      BACKEND_PORT: String(port),
      PORT: String(port),
      BACKEND_DB_MODE: mode,
      BACKEND_DB_PATH: dbPath,
      ...env,
    }),
    ["ignore", "ignore", "ignore"]
  );
  t.after(() => {
    if (!child.killed) child.kill();
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  return { baseUrl, child, port };
}

async function startMissingBackend(t, { mode, nodeEnv = "test", allowEmptyInit = false }) {
  const runDir = await createTempRunDir(`app-state-missing-${mode}`);
  const dbPath = path.join(runDir, mode === "sqlite" ? "backend.sqlite" : "app-state.json");
  const port = await freePort();
  const envFactory = nodeEnv === "production" ? productionEnv : testEnv;
  const { child } = spawnBackend(
    envFactory({
      BACKEND_PORT: String(port),
      PORT: String(port),
      BACKEND_DB_MODE: mode,
      BACKEND_DB_PATH: dbPath,
      ...(allowEmptyInit ? { BACKEND_ALLOW_EMPTY_DB_INIT: "1" } : {}),
    }),
    ["ignore", "ignore", "pipe"]
  );
  t.after(() => {
    if (!child.killed) child.kill();
  });
  return { baseUrl: `http://127.0.0.1:${port}`, child, dbPath };
}

async function publishNotification(baseUrl, index) {
  const response = await fetch(`${baseUrl}/api/integration/notifications/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "general",
      title: `Persistenza ${index}`,
      description: `Scrittura concorrente ${index}`,
      meta: { index },
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("JSON app-state temporaneo: scrittura e rilettura", async () => {
  const runDir = await createTempRunDir("app-state-json-roundtrip");
  const dbPath = path.join(runDir, "app-state.json");
  const state = buildTestState();
  state.meta.roundtrip = "json";

  await writeJsonStateFile(dbPath, `${dbPath}.tmp`, state);
  const reread = await readJsonStateFile(dbPath);

  assert.equal(reread.meta.roundtrip, "json");
  assert.equal(reread.users.some((user) => user.username === "admin_test"), true);
});

test("SQLite app-state temporaneo: scrittura e rilettura", async () => {
  const runDir = await createTempRunDir("app-state-sqlite-roundtrip");
  const dbPath = path.join(runDir, "backend.sqlite");
  const state = buildTestState();
  state.meta.roundtrip = "sqlite";

  await writeSqliteState(dbPath, state);
  const reread = await readSqliteState(dbPath);

  assert.equal(reread.meta.roundtrip, "sqlite");
  assert.equal(reread.users.some((user) => user.username === "admin_test"), true);
});

test("BACKEND_DB_MODE non valido in produzione blocca l'avvio", async () => {
  const port = await freePort();
  const runDir = await createTempRunDir("app-state-invalid-mode");
  const { child, getStderr } = spawnBackend(
    productionEnv({
      BACKEND_PORT: String(port),
      PORT: String(port),
      BACKEND_DB_MODE: "memory",
      BACKEND_DB_PATH: path.join(runDir, "app-state.json"),
    })
  );

  const { code } = await waitForExit(child);
  assert.notEqual(code, 0);
  assert.match(getStderr(), /BACKEND_DB_MODE non valido/);
});

test("JSON corrotto in produzione non viene sovrascritto", async () => {
  const port = await freePort();
  const runDir = await createTempRunDir("app-state-json-corrupt");
  const dbPath = path.join(runDir, "app-state.json");
  const corrupt = "{ questo non e json valido";
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, corrupt, "utf8");

  const { child } = spawnBackend(
    productionEnv({
      BACKEND_PORT: String(port),
      PORT: String(port),
      BACKEND_DB_MODE: "json",
      BACKEND_DB_PATH: dbPath,
    })
  );

  const { code } = await waitForExit(child);
  assert.notEqual(code, 0);
  assert.equal(await fs.readFile(dbPath, "utf8"), corrupt);
});

test("SQLite con riga app_state invalida in produzione non viene sovrascritto", async () => {
  const port = await freePort();
  const runDir = await createTempRunDir("app-state-sqlite-invalid");
  const dbPath = path.join(runDir, "backend.sqlite");
  const invalid = JSON.stringify({ bad: true });
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO app_state (id, json, updated_at) VALUES (1, ?, ?)").run(
      invalid,
      new Date().toISOString()
    );
  } finally {
    db.close();
  }

  const { child } = spawnBackend(
    productionEnv({
      BACKEND_PORT: String(port),
      PORT: String(port),
      BACKEND_DB_MODE: "sqlite",
      BACKEND_DB_PATH: dbPath,
    })
  );

  const { code } = await waitForExit(child);
  assert.notEqual(code, 0);
  assert.equal(await readSqliteRawAppState(dbPath), invalid);
});

test("DB mancante in test viene inizializzato in modalita json e sqlite", async (t) => {
  for (const mode of ["json", "sqlite"]) {
    const { baseUrl, dbPath } = await startMissingBackend(t, { mode, nodeEnv: "test" });
    await waitForHealth(baseUrl);
    assert.equal(existsSync(dbPath), true, mode);
    const state = mode === "sqlite" ? await readSqliteState(dbPath) : await readJson(dbPath);
    assert.equal(Array.isArray(state.users), true, mode);
    assert.equal(Array.isArray(state.sessions), true, mode);
  }
});

test("DB mancante in produzione richiede BACKEND_ALLOW_EMPTY_DB_INIT=1", async (t) => {
  for (const mode of ["json", "sqlite"]) {
    const denied = await startMissingBackend(t, { mode, nodeEnv: "production" });
    const deniedExit = await waitForExit(denied.child);
    assert.notEqual(deniedExit.code, 0, `${mode} senza opt-in deve fallire`);
    assert.equal(existsSync(denied.dbPath), false, `${mode} senza opt-in non deve creare il DB`);

    const allowed = await startMissingBackend(t, { mode, nodeEnv: "production", allowEmptyInit: true });
    await waitForHealth(allowed.baseUrl);
    assert.equal(existsSync(allowed.dbPath), true, `${mode} con opt-in deve creare il DB`);
    const state = mode === "sqlite" ? await readSqliteState(allowed.dbPath) : await readJson(allowed.dbPath);
    assert.equal(Array.isArray(state.users), true, mode);
  }
});

test("scritture concorrenti simulate non perdono aggiornamenti in json e sqlite", async (t) => {
  for (const mode of ["json", "sqlite"]) {
    const runDir = await createTempRunDir(`app-state-concurrent-${mode}`);
    const dbPath = path.join(runDir, mode === "sqlite" ? "backend.sqlite" : "app-state.json");
    const { baseUrl } = await startBackendWithDb(t, { mode, dbPath });

    const expected = Array.from({ length: 16 }, (_, index) => `Persistenza ${index}`);
    await Promise.all(expected.map((_, index) => publishNotification(baseUrl, index)));

    const state = mode === "sqlite" ? await readSqliteState(dbPath) : await readJson(dbPath);
    const titles = new Set((state.integration?.notifications ?? []).map((entry) => entry.title));
    for (const title of expected) {
      assert.equal(titles.has(title), true, `${mode}: notifica mancante ${title}`);
    }
  }
});
