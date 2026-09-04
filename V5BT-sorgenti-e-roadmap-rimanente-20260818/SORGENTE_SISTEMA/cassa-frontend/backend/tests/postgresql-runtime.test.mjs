import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresqlRuntime,
  normalizePostgresqlConfig,
} from "../db/postgresql/index.js";

test("PostgreSQL resta disabilitato per default e non richiede credenziali", async () => {
  const config = normalizePostgresqlConfig({ env: {} });
  assert.equal(config.enabled, false);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.max, 6);

  const runtime = createPostgresqlRuntime({ env: {} });
  assert.deepEqual(await runtime.checkHealth(), {
    enabled: false,
    ok: true,
    status: "disabled",
  });
});

test("PostgreSQL abilitato rifiuta password vuote o di esempio", () => {
  assert.throws(
    () => normalizePostgresqlConfig({ env: { BACKEND_POSTGRES_ENABLED: "1" } }),
    /POSTGRES_PASSWORD/,
  );
  assert.throws(
    () => normalizePostgresqlConfig({
      env: { BACKEND_POSTGRES_ENABLED: "1", POSTGRES_PASSWORD: "CHANGE_ME" },
    }),
    /POSTGRES_PASSWORD/,
  );
});

test("pool PostgreSQL misura attesa, espone gauge e chiude le connessioni", async () => {
  const counters = new Map();
  const gauges = new Map();
  const operations = [];
  let ended = false;
  let released = false;
  const fakePool = {
    totalCount: 1,
    idleCount: 0,
    waitingCount: 2,
    on() {},
    async connect() {
      this.waitingCount = 0;
      return {
        async query(sql) {
          assert.equal(sql, "SELECT 1 AS ok");
          return { rows: [{ ok: 1 }] };
        },
        release() {
          released = true;
          fakePool.idleCount = 1;
        },
      };
    },
    async end() {
      ended = true;
    },
  };
  let clock = 0;
  const runtime = createPostgresqlRuntime({
    env: {
      BACKEND_POSTGRES_ENABLED: "1",
      POSTGRES_PASSWORD: "test-only-password",
      POSTGRES_POOL_MAX: "4",
    },
    nowMs: () => {
      clock += 5;
      return clock;
    },
    poolFactory: (poolOptions) => {
      assert.equal(poolOptions.max, 4);
      assert.equal(poolOptions.password, "test-only-password");
      return fakePool;
    },
    runtimeMetrics: {
      incrementCounter(name) {
        counters.set(name, (counters.get(name) ?? 0) + 1);
      },
      recordOperation(kind, label, durationMs) {
        operations.push({ kind, label, durationMs });
      },
      setGauge(name, value) {
        gauges.set(name, value);
      },
    },
  });

  const health = await runtime.checkHealth();
  assert.equal(health.ok, true);
  assert.equal(health.status, "ready");
  assert.equal(health.pool.max, 4);
  assert.equal(released, true);
  assert.equal(counters.get("postgresHealthChecks"), 1);
  assert.equal(counters.get("postgresPoolAcquires"), 1);
  assert.deepEqual(operations, [{ kind: "postgresPoolWait", label: "health", durationMs: 5 }]);
  assert.equal(gauges.get("postgresPoolTotalConnections"), 1);
  assert.equal(gauges.get("postgresPoolIdleConnections"), 1);
  assert.equal(gauges.get("postgresPoolWaitingAcquires"), 0);

  await runtime.close();
  assert.equal(ended, true);
});

test("health PostgreSQL non espone dettagli dell'errore o credenziali", async () => {
  const warnings = [];
  const runtime = createPostgresqlRuntime({
    env: {
      BACKEND_POSTGRES_ENABLED: "1",
      POSTGRES_PASSWORD: "do-not-expose",
    },
    logger: { warn: (message) => warnings.push(message) },
    poolFactory: () => ({
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      on() {},
      async connect() {
        const error = new Error("connection failed with do-not-expose");
        error.code = "ECONNREFUSED";
        throw error;
      },
      async end() {},
    }),
  });

  const health = await runtime.checkHealth();
  assert.equal(health.ok, false);
  assert.equal(health.errorCode, "ECONNREFUSED");
  assert.equal(JSON.stringify(health).includes("do-not-expose"), false);
  assert.equal(warnings.join(" ").includes("do-not-expose"), false);
});

test("il rilascio fallito non sostituisce l'errore originale del callback", async () => {
  const primaryError = new Error("errore applicativo primario");
  const releaseError = new Error("dettaglio sensibile del rilascio");
  const warnings = [];
  const runtime = createPostgresqlRuntime({
    env: {
      BACKEND_POSTGRES_ENABLED: "1",
      POSTGRES_PASSWORD: "test-only-password",
    },
    logger: { warn: (message) => warnings.push(message) },
    poolFactory: () => ({
      totalCount: 1,
      idleCount: 0,
      waitingCount: 0,
      on() {},
      async connect() {
        return {
          release() {
            throw releaseError;
          },
        };
      },
      async end() {},
    }),
  });

  await assert.rejects(
    runtime.withConnection("release-failure", async () => {
      throw primaryError;
    }),
    (error) => error === primaryError && error.releaseError === releaseError,
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings.join(" ").includes("dettaglio sensibile"), false);
});

test("telemetria difettosa non altera una transazione eseguita dal runtime", async () => {
  const queries = [];
  const runtime = createPostgresqlRuntime({
    env: {
      BACKEND_POSTGRES_ENABLED: "1",
      POSTGRES_PASSWORD: "test-only-password",
    },
    poolFactory: () => ({
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      on() {},
      async connect() {
        return {
          async query(sql) {
            queries.push(sql);
            return { rowCount: 0, rows: [] };
          },
          release() {},
        };
      },
      async end() {},
    }),
    runtimeMetrics: {
      incrementCounter() {
        throw new Error("counter non disponibile");
      },
      recordOperation() {
        throw new Error("operation recorder non disponibile");
      },
      setGauge() {
        throw new Error("gauge non disponibile");
      },
    },
  });

  const result = await runtime.withTransaction("telemetry-failure", async () => "ok");
  assert.equal(result, "ok");
  assert.deepEqual(queries, [
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "COMMIT",
  ]);
  await runtime.close();
});

test("rilascio fallito dopo rollback impedisce il retry automatico", async () => {
  const primaryError = new Error("serialization failure");
  primaryError.code = "40001";
  const releaseError = new Error("release failure");
  const queries = [];
  let callbackCalls = 0;
  const runtime = createPostgresqlRuntime({
    env: {
      BACKEND_POSTGRES_ENABLED: "1",
      POSTGRES_PASSWORD: "test-only-password",
    },
    logger: { warn() {} },
    poolFactory: () => ({
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      on() {},
      async connect() {
        return {
          async query(sql) {
            queries.push(sql);
            return { rowCount: 0, rows: [] };
          },
          release() {
            throw releaseError;
          },
        };
      },
      async end() {},
    }),
    sleep: async () => assert.fail("un client non rilasciato non deve essere ritentato"),
  });

  await assert.rejects(
    runtime.withTransaction("release-after-rollback", async () => {
      callbackCalls += 1;
      throw primaryError;
    }),
    (error) => error === primaryError && error.releaseError === releaseError,
  );
  assert.equal(callbackCalls, 1);
  assert.deepEqual(queries, [
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "ROLLBACK",
  ]);
  await runtime.close();
});
