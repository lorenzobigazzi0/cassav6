import assert from "node:assert/strict";
import test from "node:test";

import { refreshOrderCreateExternalizedReadsInParallel } from "../modules/integration/order-create-read-refresh.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function buildDb() {
  return {
    integration: {
      orders: [{ id: "order-1" }],
      stationStates: [{ id: "station-old" }],
    },
    posSettings: {
      tables: [{ id: "table-1", workLock: null }],
    },
  };
}

test("order create avvia lock e stati postazione in parallelo e committa insieme", async () => {
  const db = buildDb();
  const lockGate = deferred();
  const stationGate = deferred();
  const started = [];
  const metrics = [];

  const refreshPromise = refreshOrderCreateExternalizedReadsInParallel({
    db,
    recordStep(label, durationMs) {
      metrics.push({ durationMs, label });
    },
    async refreshTableLocks(candidate) {
      started.push("lock");
      await lockGate.promise;
      return {
        ...candidate,
        posSettings: {
          ...candidate.posSettings,
          tables: [{ id: "table-1", workLock: { userId: "user-1" } }],
        },
      };
    },
    async refreshStationStates(candidate) {
      started.push("station");
      await stationGate.promise;
      candidate.integration.stationStates = [{ id: "station-new" }];
      return candidate;
    },
  });

  await Promise.resolve();
  assert.deepEqual(started.sort(), ["lock", "station"]);
  assert.equal(db.posSettings.tables[0].workLock, null);
  assert.equal(db.integration.stationStates[0].id, "station-old");

  lockGate.resolve();
  stationGate.resolve();
  const result = await refreshPromise;

  assert.equal(result, db);
  assert.equal(db.posSettings.tables[0].workLock.userId, "user-1");
  assert.equal(db.integration.stationStates[0].id, "station-new");
  assert.deepEqual(
    metrics.map((entry) => entry.label).sort(),
    ["refreshStationStates", "refreshTableLocks"],
  );
  assert.equal(metrics.every((entry) => entry.durationMs >= 0), true);
});

test("order create non applica risultati parziali se un refresh fallisce", async () => {
  const db = buildDb();
  const originalPosSettings = db.posSettings;
  const originalIntegration = db.integration;
  const stationError = new Error("station repository offline");

  await assert.rejects(
    refreshOrderCreateExternalizedReadsInParallel({
      db,
      async refreshTableLocks(candidate) {
        return {
          ...candidate,
          posSettings: {
            tables: [{ id: "table-1", workLock: { userId: "user-1" } }],
          },
        };
      },
      async refreshStationStates() {
        throw stationError;
      },
    }),
    (error) => error === stationError,
  );

  assert.equal(db.posSettings, originalPosSettings);
  assert.equal(db.integration, originalIntegration);
  assert.equal(db.posSettings.tables[0].workLock, null);
  assert.equal(db.integration.stationStates[0].id, "station-old");
  assert.equal(stationError.orderCreateRefreshStage, "refreshStationStates");
});

test("order create rifiuta dipendenze refresh mancanti", async () => {
  await assert.rejects(
    refreshOrderCreateExternalizedReadsInParallel({ db: buildDb() }),
    /refreshTableLocks deve essere una funzione/,
  );
});
