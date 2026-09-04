import assert from "node:assert/strict";
import test from "node:test";

import {
  createOrderAsyncAppStateFlushQueue,
  partitionOrderAsyncIntegrationObjectFields,
} from "../modules/integration/order-async-appstate-flush.js";

function createFakeMetrics() {
  const counters = {};
  const gauges = {};
  const operations = [];
  return {
    counters,
    gauges,
    operations,
    incrementCounter(name, amount = 1) {
      counters[name] = (counters[name] ?? 0) + amount;
    },
    setGauge(name, value) {
      gauges[name] = value;
    },
    recordOperation(kind, label, ms) {
      operations.push({ kind, label, ms });
    },
  };
}

function createQueue(overrides = {}) {
  const flushCalls = [];
  const metrics = createFakeMetrics();
  const fakeDb = { fake: true };
  const queue = createOrderAsyncAppStateFlushQueue({
    readDb: async () => fakeDb,
    runFlush: async (db, options) => {
      flushCalls.push({ db, options });
    },
    runtimeMetrics: metrics,
    logger: { warn() {}, log() {} },
    intervalMs: 10,
    maxPendingOrders: 1_000,
    retryBaseMs: 10,
    retryMaxMs: 40,
    ...overrides,
  });
  return { queue, flushCalls, metrics, fakeDb };
}

test("isola i metadata hot mantenendo sequence nel commit che contiene notifiche", () => {
  assert.deepEqual(
    partitionOrderAsyncIntegrationObjectFields(
      ["sequence", "lastWriteAt", "orderCorrections", "lastWriteAt"],
      { detachLastWriteAt: true },
    ),
    {
      bulkFields: ["sequence", "orderCorrections"],
      detachedFields: ["lastWriteAt"],
    },
  );
  assert.deepEqual(
    partitionOrderAsyncIntegrationObjectFields(
      ["sequence", "lastWriteAt"],
      { detachLastWriteAt: true, detachSequence: false },
    ),
    {
      bulkFields: ["sequence"],
      detachedFields: ["lastWriteAt"],
    },
  );
  assert.deepEqual(
    partitionOrderAsyncIntegrationObjectFields(
      ["sequence", "lastWriteAt", "orderComps"],
      { detachLastWriteAt: true, detachSequence: true },
    ),
    {
      bulkFields: ["orderComps"],
      detachedFields: ["sequence", "lastWriteAt"],
    },
  );
});

test("coalesca piu' defer sullo stesso ordine in un solo flush", async () => {
  const { queue, flushCalls, metrics, fakeDb } = createQueue();
  assert.equal(queue.tryDefer({ orderIds: ["101"], auditEventIds: ["a1"], syncSequence: true, metricLabel: "orders.create.appStateWrite", defer: true, integrationObjectFields: ["orderCorrections"] }), true);
  assert.equal(queue.tryDefer({ orderIds: ["101"], auditEventIds: ["a2"], syncNotifications: true, notificationIds: ["n1"], integrationObjectFields: ["orderComps"] }), true);
  assert.equal(queue.tryDefer({ orderIds: ["101"], integrationObjectFields: ["barChargeReplacements"] }), true);
  const result = await queue.drain({ timeoutMs: 2_000 });
  assert.equal(result.drained, true);
  assert.equal(flushCalls.length, 1);
  const { db, options } = flushCalls[0];
  assert.equal(db, fakeDb);
  assert.deepEqual(options.orderIds, ["101"]);
  assert.deepEqual([...options.auditEventIds].sort(), ["a1", "a2"]);
  assert.deepEqual(options.notificationIds, ["n1"]);
  assert.deepEqual([...options.integrationObjectFields].sort(), ["barChargeReplacements", "orderComps", "orderCorrections"]);
  assert.equal(options.syncSequence, true);
  assert.equal(options.syncNotifications, true);
  assert.equal(options.metricLabel, "orders.asyncFlush.appStateWrite");
  assert.equal(options.defer, undefined);
  assert.equal(metrics.counters.ordersAsyncFlushEnqueued, 3);
  assert.equal(metrics.counters.ordersAsyncFlushCoalesced, 2);
  assert.equal(metrics.counters.ordersAsyncFlushBatches, 1);
  assert.equal(metrics.gauges.ordersAsyncFlushPendingDepth, 0);
});

test("unisce ordini distinti e flag booleani in OR", async () => {
  const { queue, flushCalls } = createQueue();
  queue.tryDefer({ orderIds: ["201"], syncSequence: true });
  queue.tryDefer({ orderIds: ["202"], syncFulfillmentHistory: true, fulfillmentHistoryIds: ["f1"], extraSplitDomains: ["posSettings"], posSettingsTableIds: ["t1"] });
  await queue.drain({ timeoutMs: 2_000 });
  assert.equal(flushCalls.length, 1);
  const { options } = flushCalls[0];
  assert.deepEqual([...options.orderIds].sort(), ["201", "202"]);
  assert.equal(options.syncSequence, true);
  assert.equal(options.syncFulfillmentHistory, true);
  assert.deepEqual(options.fulfillmentHistoryIds, ["f1"]);
  assert.deepEqual(options.extraSplitDomains, ["posSettings"]);
  assert.equal(options.syncPosSettings, true);
  assert.deepEqual(options.posSettingsTableIds, ["t1"]);
});

test("retry con backoff: nessun ID perso dopo un flush fallito", async () => {
  const flushCalls = [];
  let failures = 1;
  const metrics = createFakeMetrics();
  const queue = createOrderAsyncAppStateFlushQueue({
    readDb: async () => ({}),
    runFlush: async (db, options) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("MySQL transient finto");
      }
      flushCalls.push(options);
    },
    runtimeMetrics: metrics,
    logger: { warn() {}, log() {} },
    intervalMs: 5,
    retryBaseMs: 10,
    retryMaxMs: 40,
  });
  queue.tryDefer({ orderIds: ["301"], auditEventIds: ["a1"] });
  const result = await queue.drain({ timeoutMs: 5_000 });
  assert.equal(result.drained, true);
  assert.equal(flushCalls.length, 1);
  assert.deepEqual(flushCalls[0].orderIds, ["301"]);
  assert.deepEqual(flushCalls[0].auditEventIds, ["a1"]);
  assert.equal(metrics.counters.ordersAsyncFlushRetries, 1);
  assert.equal(metrics.counters.ordersAsyncFlushBatches, 1);
});

test("una collisione NOWAIT conserva il batch e viene attestata come deferral", async () => {
  const flushCalls = [];
  const warnings = [];
  let attempts = 0;
  const metrics = createFakeMetrics();
  const queue = createOrderAsyncAppStateFlushQueue({
    readDb: async () => ({}),
    runFlush: async (db, options) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("Locking read non disponibile"), {
          code: "ER_LOCK_NOWAIT",
          errno: 3_572,
        });
      }
      flushCalls.push(options);
    },
    runtimeMetrics: metrics,
    logger: { warn: (message) => warnings.push(message) },
    intervalMs: 5,
    retryBaseMs: 10,
    retryMaxMs: 40,
  });

  queue.tryDefer({ orderIds: ["nowait-1"], auditEventIds: ["audit-nowait-1"] });
  const result = await queue.drain({ timeoutMs: 2_000 });

  assert.equal(result.drained, true);
  assert.equal(attempts, 2);
  assert.deepEqual(flushCalls[0].orderIds, ["nowait-1"]);
  assert.deepEqual(flushCalls[0].auditEventIds, ["audit-nowait-1"]);
  assert.equal(metrics.counters.ordersAsyncFlushRetries, 1);
  assert.equal(metrics.counters.ordersAsyncFlushMysqlLockContentionDeferrals, 1);
  assert.equal(metrics.counters.ordersAsyncFlushBatches, 1);
  assert.deepEqual(warnings, []);
});

test("backpressure: oltre maxPendingOrders tryDefer rifiuta e conta il fallback sincrono", async () => {
  const { queue, metrics } = createQueue({ maxPendingOrders: 2, intervalMs: 500 });
  assert.equal(queue.tryDefer({ orderIds: ["401"] }), true);
  assert.equal(queue.tryDefer({ orderIds: ["402"] }), true);
  assert.equal(queue.pendingDepth(), 2);
  assert.equal(queue.tryDefer({ orderIds: ["403"] }), false);
  assert.equal(metrics.counters.ordersAsyncFlushBackpressureSync, 1);
  const result = await queue.drain({ timeoutMs: 3_000 });
  assert.equal(result.drained, true);
  assert.equal(queue.pendingDepth(), 0);
});

test("drain a coda vuota risolve subito", async () => {
  const { queue, flushCalls } = createQueue();
  assert.equal(queue.hasPressure(), false);
  const result = await queue.drain({ timeoutMs: 500 });
  assert.equal(result.drained, true);
  assert.equal(result.remaining, 0);
  assert.equal(queue.hasPressure(), false);
  assert.equal(flushCalls.length, 0);
});

test("espone pressione finche' il batch asincrono non e' completato", async () => {
  let releaseFlush;
  const flushBlocked = new Promise((resolve) => {
    releaseFlush = resolve;
  });
  const { queue } = createQueue({
    runFlush: async () => flushBlocked,
    intervalMs: 5,
  });

  assert.equal(queue.tryDefer({ orderIds: ["pressure-1"] }), true);
  assert.equal(queue.hasPressure(), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(queue.hasPressure(), true);

  releaseFlush();
  assert.equal((await queue.drain({ timeoutMs: 2_000 })).drained, true);
  assert.equal(queue.hasPressure(), false);
});

test("puo' eseguire il flush dentro un wrapper esclusivo", async () => {
  const exclusiveCalls = [];
  const { queue, flushCalls } = createQueue({
    runExclusive: async (action, context) => {
      exclusiveCalls.push(context);
      return action();
    },
  });
  queue.tryDefer({ orderIds: ["501"], auditEventIds: ["a501"] });
  const result = await queue.drain({ timeoutMs: 2_000 });
  assert.equal(result.drained, true);
  assert.equal(exclusiveCalls.length, 1);
  assert.equal(exclusiveCalls[0].options.metricLabel, "orders.asyncFlush.appStateWrite");
  assert.deepEqual(flushCalls[0].options.orderIds, ["501"]);
});

test("rilegge lo snapshot dentro il wrapper esclusivo", async () => {
  const events = [];
  const { queue, flushCalls } = createQueue({
    readDb: async () => {
      events.push("readDb");
      return { fresh: true };
    },
    runExclusive: async (action) => {
      events.push("lock:enter");
      try {
        return await action();
      } finally {
        events.push("lock:exit");
      }
    },
  });
  queue.tryDefer({ orderIds: ["601"] });
  const result = await queue.drain({ timeoutMs: 2_000 });
  assert.equal(result.drained, true);
  assert.deepEqual(events, ["lock:enter", "readDb", "lock:exit"]);
  assert.deepEqual(flushCalls[0].db, { fresh: true });
});

test("inoltra all'owner prima di leggere lo snapshot e acquisire il lock", async () => {
  const events = [];
  const { queue, flushCalls, metrics } = createQueue({
    tryRemoteFlush: async (options, context) => {
      events.push("forward");
      assert.deepEqual(options.orderIds, ["651"]);
      assert.equal(Number.isFinite(context.queueWaitMs), true);
      return true;
    },
    readDb: async () => {
      events.push("readDb");
      return {};
    },
    runExclusive: async (action) => {
      events.push("lock");
      return action();
    },
  });
  queue.tryDefer({ orderIds: ["651"] });
  const result = await queue.drain({ timeoutMs: 2_000 });
  assert.equal(result.drained, true);
  assert.deepEqual(events, ["forward"]);
  assert.equal(flushCalls.length, 0);
  assert.equal(metrics.counters.ordersAsyncFlushBatches, 1);
  assert.equal(metrics.counters.ordersAsyncFlushRetries ?? 0, 0);
});

test("usa lock, rilettura e flush locale quando l'owner non accetta", async () => {
  const events = [];
  const { queue } = createQueue({
    tryRemoteFlush: async () => {
      events.push("forward");
      return false;
    },
    readDb: async () => {
      events.push("readDb");
      return { fresh: true };
    },
    runFlush: async () => {
      events.push("flush");
    },
    runExclusive: async (action) => {
      events.push("lock:enter");
      try {
        return await action();
      } finally {
        events.push("lock:exit");
      }
    },
  });
  queue.tryDefer({ orderIds: ["652"] });
  const result = await queue.drain({ timeoutMs: 2_000 });
  assert.equal(result.drained, true);
  assert.deepEqual(events, ["forward", "lock:enter", "readDb", "flush", "lock:exit"]);
});

test("recupera inline un conflitto revisione app-state dentro il lock", async () => {
  const readOptions = [];
  const flushCalls = [];
  let remainingConflicts = 1;
  const metrics = createFakeMetrics();
  const queue = createOrderAsyncAppStateFlushQueue({
    readDb: async (options = {}) => {
      readOptions.push(options);
      return { read: readOptions.length };
    },
    runFlush: async (db, options) => {
      flushCalls.push({ db, options });
      if (remainingConflicts > 0) {
        remainingConflicts -= 1;
        throw new Error("Record has changed since last read in table 'app_state_domain_records'");
      }
    },
    runExclusive: async (action) => action(),
    runtimeMetrics: metrics,
    logger: { warn() {}, log() {} },
    intervalMs: 5,
    retryBaseMs: 10,
    retryMaxMs: 40,
  });
  queue.tryDefer({ orderIds: ["701"] });
  const result = await queue.drain({ timeoutMs: 2_000 });
  assert.equal(result.drained, true);
  assert.equal(flushCalls.length, 2);
  assert.deepEqual(readOptions, [{}, { forceReload: true }]);
  assert.equal(metrics.counters.ordersAsyncFlushInlineRevisionConflictRetries, 1);
  assert.equal(metrics.counters.ordersAsyncFlushRetries ?? 0, 0);
  assert.equal(metrics.counters.ordersAsyncFlushBatches, 1);
});
