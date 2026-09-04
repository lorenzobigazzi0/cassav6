import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { normalizeRelationalConfig } from "../db/relational/connection.js";
import { createRelationalRuntime } from "../db/relational/index.js";
import { createRelationalWalCheckpointScheduler } from "../db/relational/wal-checkpoint.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

function createMetricsProbe() {
  const counters = new Map();
  const gauges = new Map();
  const operations = [];
  return {
    counters,
    gauges,
    operations,
    incrementCounter(name, amount = 1) {
      counters.set(name, (counters.get(name) ?? 0) + amount);
    },
    recordOperation(family, label, durationMs) {
      operations.push({ family, label, durationMs });
    },
    setGauge(name, value) {
      gauges.set(name, value);
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "shadow",
    BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED: "0",
    ...overrides,
  };
}

test("P3.73 flag OFF mantiene autocheckpoint SQLite e nessun owner scheduler", () => {
  const config = normalizeRelationalConfig({ env: baseEnv() });

  assert.equal(config.walCheckpointEnabled, false);
  assert.equal(config.walCheckpointOwner, false);
  assert.equal(config.walAutoCheckpointPages, 1000);
});

test("P3.73 flag ON disabilita autocheckpoint in tutti i processi ma elegge solo owner", () => {
  const owner = normalizeRelationalConfig({
    env: baseEnv({
      BACKEND_PROCESS_ROLE: "api-owner",
      BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER: "1",
      BACKEND_RELATIONAL_WAL_CHECKPOINT_INTERVAL_MS: "750",
    }),
  });
  const worker = normalizeRelationalConfig({
    env: baseEnv({
      BACKEND_PROCESS_ROLE: "api-worker",
      BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER: "1",
    }),
  });

  assert.equal(owner.walCheckpointOwner, true);
  assert.equal(owner.walCheckpointIntervalMs, 750);
  assert.equal(owner.walAutoCheckpointPages, 0);
  assert.equal(worker.walCheckpointOwner, false);
  assert.equal(worker.walAutoCheckpointPages, 0);
});

test("P3.73 runtime owner applica wal_autocheckpoint=0 ed espone checkpoint PASSIVE", async (t) => {
  const runDir = await createTempRunDir("rel-wal-checkpoint");
  const dbPath = path.join(runDir, "relational.sqlite");
  const metrics = createMetricsProbe();
  const runtime = createRelationalRuntime({
    env: baseEnv({
      BACKEND_PROCESS_ROLE: "api-owner",
      BACKEND_RELATIONAL_DB_PATH: dbPath,
      BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER: "1",
      BACKEND_RELATIONAL_WAL_CHECKPOINT_INTERVAL_MS: "60000",
    }),
    logger: { warn() {} },
    runtimeMetrics: metrics,
  });
  t.after(async () => {
    runtime.close();
    await fs.rm(runDir, { force: true, recursive: true });
  });

  await runtime.initialize();
  const autoCheckpoint = runtime.db.prepare("PRAGMA wal_autocheckpoint").get();
  assert.equal(Number(autoCheckpoint.wal_autocheckpoint), 0);

  runtime.db.exec("CREATE TABLE p3_73_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  runtime.db.prepare("INSERT INTO p3_73_probe (value) VALUES (?)").run("checkpoint");
  const result = runtime.walCheckpoint.runNow();

  assert.equal(result.ok, true);
  assert.equal(Number.isInteger(result.busy), true);
  assert.equal(Number.isInteger(result.logPages), true);
  assert.equal(Number.isInteger(result.checkpointedPages), true);
  assert.equal(metrics.counters.get("relationalWalCheckpointRuns"), 1);
  assert.equal(metrics.counters.get("relationalWalCheckpointErrors") ?? 0, 0);
  assert.equal(metrics.gauges.get("relationalWalAutoCheckpointPages"), 0);
  assert.equal(metrics.gauges.get("relationalWalCheckpointRunning"), 0);
  assert.deepEqual(
    metrics.operations.map(({ family, label }) => ({ family, label })),
    [{ family: "relationalWalCheckpoint", label: "passive" }],
  );
});

test("P3.73 errore checkpoint resta non bloccante e viene misurato", () => {
  const metrics = createMetricsProbe();
  const warnings = [];
  const scheduler = createRelationalWalCheckpointScheduler({
    enabled: true,
    getDb: () => ({
      prepare() {
        throw new Error("checkpoint boom");
      },
    }),
    logger: { warn(message) { warnings.push(message); } },
    runtimeMetrics: metrics,
  });

  const result = scheduler.runNow();

  assert.equal(result.ok, false);
  assert.match(result.error, /checkpoint boom/);
  assert.equal(metrics.counters.get("relationalWalCheckpointRuns"), 1);
  assert.equal(metrics.counters.get("relationalWalCheckpointErrors"), 1);
  assert.equal(metrics.gauges.get("relationalWalCheckpointRunning"), 0);
  assert.match(warnings[0], /checkpoint PASSIVE fallito/);
});
