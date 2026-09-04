import assert from "node:assert/strict";
import test from "node:test";

import { createOrderAsyncFlushMysqlLockRunner } from "../db/app-state/order-async-flush-mysql-lock.js";

function createHarness({ acquired = 1, enabled = true, releaseError = null } = {}) {
  const counters = [];
  const operations = [];
  const queries = [];
  const warnings = [];
  let connectionReleases = 0;
  let poolRequests = 0;
  const runner = createOrderAsyncFlushMysqlLockRunner({
    enabled,
    lockName: "orders:test:async-flush",
    logger: { warn: (...parts) => warnings.push(parts) },
    mysqlRepository: {
      async getPool() {
        poolRequests += 1;
        return {
          async getConnection() {
            return {
              async query(sql, parameters) {
                queries.push([sql, parameters]);
                if (sql.includes("GET_LOCK")) return [[{ acquired }]];
                if (sql.includes("RELEASE_LOCK")) {
                  if (releaseError) throw releaseError;
                  return [[{ released: 1 }]];
                }
                throw new Error(`Query inattesa: ${sql}`);
              },
              release() {
                connectionReleases += 1;
              },
            };
          },
        };
      },
    },
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
      recordOperation: (kind, label, durationMs) => operations.push({ durationMs, kind, label }),
    },
    timeoutSeconds: 4,
  });
  return {
    connectionReleases: () => connectionReleases,
    counters,
    operations,
    poolRequests: () => poolRequests,
    queries,
    runner,
    warnings,
  };
}

test("async flush lock mantiene query, metriche e rilascio del comportamento legacy", async () => {
  const harness = createHarness();
  assert.equal(await harness.runner(async () => "written"), "written");
  assert.deepEqual(harness.queries, [
    ["SELECT GET_LOCK(?, ?) AS acquired", ["orders:test:async-flush", 4]],
    ["SELECT RELEASE_LOCK(?)", ["orders:test:async-flush"]],
  ]);
  assert.deepEqual(harness.counters, ["ordersAsyncFlushMysqlLockAcquired"]);
  assert.equal(harness.operations.length, 1);
  assert.deepEqual(
    { kind: harness.operations[0].kind, label: harness.operations[0].label },
    { kind: "orderWorkflow", label: "orders.asyncFlush.mysqlLockWait" },
  );
  assert.equal(harness.operations[0].durationMs >= 0, true);
  assert.equal(harness.connectionReleases(), 1);
});

test("async flush lock conserva il codice timeout e non esegue l'azione", async () => {
  const harness = createHarness({ acquired: 0 });
  let actionCalls = 0;
  await assert.rejects(
    harness.runner(async () => {
      actionCalls += 1;
    }),
    (error) => error?.code === "ORDERS_ASYNC_FLUSH_MYSQL_LOCK_TIMEOUT",
  );
  assert.equal(actionCalls, 0);
  assert.equal(harness.connectionReleases(), 1);
  assert.equal(harness.queries.length, 1);
});

test("async flush lock disabilitato non apre il pool", async () => {
  const harness = createHarness({ enabled: false });
  assert.equal(await harness.runner(async () => "legacy"), "legacy");
  assert.equal(harness.poolRequests(), 0);
});

test("errore di rilascio lock resta non bloccante e la connessione viene restituita", async () => {
  const releaseError = new Error("release failed");
  const harness = createHarness({ releaseError });
  assert.equal(await harness.runner(async () => "written"), "written");
  assert.equal(harness.warnings.length, 1);
  assert.equal(harness.warnings[0].at(-1), "release failed");
  assert.equal(harness.connectionReleases(), 1);
});
