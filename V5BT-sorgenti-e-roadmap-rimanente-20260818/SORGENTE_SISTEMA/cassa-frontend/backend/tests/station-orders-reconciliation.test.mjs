import assert from "node:assert/strict";
import test from "node:test";
import {
  applyStationOrdersPollReconciliation,
  buildStationOrdersPollReconciliationCursor,
  createStationOrdersPollReconciliationScheduler,
} from "../modules/integration/station-orders-reconciliation.js";

test("station orders reconciliation segnala changed quando assegna o promuove ordini", () => {
  const calls = [];
  const result = applyStationOrdersPollReconciliation(
    { integration: { orders: [{ id: "00001" }] } },
    {
      station: "BAR PRINCIPALE",
      assignQueuedUnassignedIntegrationOrders(db, context) {
        calls.push(["assign", context.station, context.source]);
        return [{ orderId: "00001", stationId: context.station }];
      },
      backfillStationOperatorAssignments(db, context) {
        calls.push(["backfill", context.station]);
        return [{ orderId: "00002", stationId: context.station }];
      },
      reconcileIntegrationPreparationQueue(db, context) {
        calls.push(["queue", context.station, context.source]);
        return [
          { orderId: "00001", stationId: context.station },
          { orderId: "00003", stationId: context.station },
        ];
      },
    },
  );

  assert.equal(result.changed, true);
  assert.equal(result.assignedPendingOrders.length, 1);
  assert.equal(result.assignedOperatorOrders.length, 1);
  assert.equal(result.queuePromotions.length, 2);
  assert.deepEqual(result.changedOrderIds, ["00001", "00002", "00003"]);
  assert.equal(result.pruned, false);
  assert.deepEqual(calls, [
    ["assign", "BAR PRINCIPALE", "orders_poll_reconciliation"],
    ["backfill", "BAR PRINCIPALE"],
    ["queue", "BAR PRINCIPALE", "orders_poll_reconciliation"],
  ]);
});

test("station orders reconciliation resta no-op quando non cambia nulla", () => {
  const result = applyStationOrdersPollReconciliation(
    { integration: { orders: [] } },
    {
      station: "BAR PRINCIPALE",
      assignQueuedUnassignedIntegrationOrders: () => [],
      backfillStationOperatorAssignments: () => [],
      reconcileIntegrationPreparationQueue: () => [],
    },
  );

  assert.equal(result.changed, false);
  assert.deepEqual(result.assignedPendingOrders, []);
  assert.deepEqual(result.assignedOperatorOrders, []);
  assert.deepEqual(result.queuePromotions, []);
  assert.deepEqual(result.changedOrderIds, []);
});

test("station orders cursor cambia solo con dati ordine rilevanti", () => {
  const baseOrders = [
    {
      id: "00001",
      updatedAt: "2026-06-30T14:00:00.000Z",
      workflowStatus: "waiting",
      paymentStatus: "unpaid",
      assignmentStatus: "assigned",
      assignedStationId: "BAR-1",
      items: [{ lineId: "l1", productId: "p1", quantity: 1 }],
    },
  ];
  const sameCursor = buildStationOrdersPollReconciliationCursor([
    {
      ...baseOrders[0],
      tableLabel: "Tavolo 1",
    },
  ]);
  const statusCursor = buildStationOrdersPollReconciliationCursor([
    {
      ...baseOrders[0],
      workflowStatus: "prep",
    },
  ]);
  const quantityCursor = buildStationOrdersPollReconciliationCursor([
    {
      ...baseOrders[0],
      items: [{ lineId: "l1", productId: "p1", quantity: 2 }],
    },
  ]);

  assert.equal(buildStationOrdersPollReconciliationCursor(baseOrders), sameCursor);
  assert.notEqual(buildStationOrdersPollReconciliationCursor(baseOrders), statusCursor);
  assert.notEqual(buildStationOrdersPollReconciliationCursor(baseOrders), quantityCursor);
});

test("station orders scheduler persiste la riconciliazione fuori dalla GET", async () => {
  const db = { integration: { orders: [{ id: "00001" }] }, meta: {} };
  let writes = 0;
  let writeOptions = null;
  let shouldPreserveHotCaches = null;
  const schedule = createStationOrdersPollReconciliationScheduler({
    readDb: async () => db,
    writeIntegrationOrderEntriesDb: async (_db, options) => {
      writes += 1;
      writeOptions = options;
    },
    enqueueMutation(label, key, run, options = {}) {
      assert.equal(label, "GET /api/integration/orders station reconciliation");
      assert.equal(key, "station:BAR PRINCIPALE");
      shouldPreserveHotCaches = options.shouldPreserveHotCaches;
      return run();
    },
    nowIso: () => "2026-06-30T13:00:00.000Z",
    normalizeStation: (value) => String(value ?? "").trim().toUpperCase(),
    assignQueuedUnassignedIntegrationOrders: () => [{ orderId: "00001" }],
    backfillStationOperatorAssignments: () => [{ orderId: "00002" }],
    reconcileIntegrationPreparationQueue: () => [
      { orderId: "00001" },
      { orderId: "00003" },
    ],
  });

  assert.equal(schedule("bar principale"), true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(writes, 1);
  assert.equal(shouldPreserveHotCaches?.(), false);
  assert.equal(db.integration.lastWriteAt, "2026-06-30T13:00:00.000Z");
  assert.equal(db.meta.lastWriteAt, "2026-06-30T13:00:00.000Z");
  assert.deepEqual(writeOptions, {
    orderIds: ["00001", "00002", "00003"],
    integrationObjectFields: ["lastWriteAt"],
    skipAudit: true,
    skipPrintSpool: true,
    metricLabel: "orders.stationReconciliation.appStateWrite",
  });
  assert.equal("notificationIds" in writeOptions, false);
  assert.equal("fulfillmentHistoryIds" in writeOptions, false);
});

test("station orders scheduler preserva hot cache quando la riconciliazione e no-op", async () => {
  let shouldPreserveHotCaches = null;
  const schedule = createStationOrdersPollReconciliationScheduler({
    minIntervalMs: 0,
    readDb: async () => ({ integration: { orders: [{ id: "00001" }] }, meta: {} }),
    writeIntegrationOrderEntriesDb: async () => {
      throw new Error("non deve scrivere");
    },
    enqueueMutation(label, key, run, options = {}) {
      assert.equal(label, "GET /api/integration/orders station reconciliation");
      assert.equal(key, "station:BAR PRINCIPALE");
      shouldPreserveHotCaches = options.shouldPreserveHotCaches;
      return run();
    },
    normalizeStation: (value) => String(value ?? "").trim().toUpperCase(),
    assignQueuedUnassignedIntegrationOrders: () => [],
    backfillStationOperatorAssignments: () => [],
    reconcileIntegrationPreparationQueue: () => [],
  });

  assert.equal(schedule("bar principale"), true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(shouldPreserveHotCaches?.(), true);
});

test("station orders scheduler deduplica poll ravvicinati della stessa postazione", async () => {
  let release;
  let enqueued = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const schedule = createStationOrdersPollReconciliationScheduler({
    minIntervalMs: 0,
    readDb: async () => ({ integration: {}, meta: {} }),
    writeIntegrationOrderDb: async () => {},
    enqueueMutation() {
      enqueued += 1;
      return pending;
    },
    normalizeStation: (value) => String(value ?? "").trim().toUpperCase(),
  });

  assert.equal(schedule("BAR PRINCIPALE"), true);
  assert.equal(schedule("bar principale"), false);
  assert.equal(enqueued, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(schedule("bar principale"), true);
});

test("station orders scheduler limita riconciliazioni ripetute anche dopo il completamento", async () => {
  let enqueued = 0;
  const schedule = createStationOrdersPollReconciliationScheduler({
    minIntervalMs: 1_000,
    readDb: async () => ({ integration: {}, meta: {} }),
    writeIntegrationOrderDb: async () => {},
    enqueueMutation(label, key, run) {
      enqueued += 1;
      return run();
    },
    normalizeStation: (value) => String(value ?? "").trim().toUpperCase(),
  });

  assert.equal(schedule("BAR PRINCIPALE"), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(schedule("bar principale"), false);
  assert.equal(enqueued, 1);
});

test("station orders scheduler non rischedula la stessa versione gia riconciliata", async () => {
  let enqueued = 0;
  const schedule = createStationOrdersPollReconciliationScheduler({
    minIntervalMs: 0,
    readDb: async () => ({ integration: {}, meta: {} }),
    writeIntegrationOrderDb: async () => {},
    enqueueMutation(label, key, run) {
      enqueued += 1;
      return run();
    },
    normalizeStation: (value) => String(value ?? "").trim().toUpperCase(),
  });

  assert.equal(schedule("BAR PRINCIPALE", { stateVersion: "v1" }), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(schedule("bar principale", { stateVersion: "v1" }), false);
  assert.equal(schedule("bar principale", { stateVersion: "v2" }), true);
  assert.equal(enqueued, 2);
});

test("station orders scheduler accorpa una nuova versione mentre un job e pendente", async () => {
  const gates = [];
  let enqueued = 0;
  const schedule = createStationOrdersPollReconciliationScheduler({
    minIntervalMs: 0,
    readDb: async () => ({ integration: {}, meta: {} }),
    writeIntegrationOrderDb: async () => {},
    enqueueMutation(label, key, run) {
      enqueued += 1;
      const gate = new Promise((resolve) => gates.push(resolve));
      return gate.then(run);
    },
    normalizeStation: (value) => String(value ?? "").trim().toUpperCase(),
  });

  assert.equal(schedule("BAR PRINCIPALE", { stateVersion: "v1" }), true);
  assert.equal(schedule("bar principale", { stateVersion: "v2" }), false);
  assert.equal(schedule("bar principale", { stateVersion: "v2" }), false);
  assert.equal(enqueued, 1);

  gates[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(enqueued, 2);
  gates[1]();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("station orders scheduler differisce il poll quando la order lane e sotto pressione", async () => {
  let backpressureActive = true;
  let enqueued = 0;
  let observedVersion = "";
  const schedule = createStationOrdersPollReconciliationScheduler({
    minIntervalMs: 0,
    backpressureDelayMs: 1,
    readDb: async () => ({ integration: {}, meta: {} }),
    writeIntegrationOrderDb: async () => {},
    enqueueMutation(label, key, run) {
      enqueued += 1;
      assert.equal(label, "GET /api/integration/orders station reconciliation");
      assert.equal(key, "station:BAR PRINCIPALE");
      return run();
    },
    isBackpressureActive: () => backpressureActive,
    normalizeStation: (value) => String(value ?? "").trim().toUpperCase(),
  });

  assert.equal(schedule("BAR PRINCIPALE", { stateVersion: "v1" }), false);
  assert.equal(schedule("bar principale", { stateVersion: "v2" }), false);
  assert.equal(enqueued, 0);

  backpressureActive = false;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(enqueued, 1);
  assert.equal(schedule("bar principale", { stateVersion: "v2" }), false);
  assert.equal(schedule("bar principale", { stateVersion: "v3" }), true);
  observedVersion = buildStationOrdersPollReconciliationCursor([]);
  assert.equal(observedVersion, "orders:empty");
  assert.equal(enqueued, 2);
});

test("station orders scheduler applica debounce iniziale prima di accodare il poll", async () => {
  let enqueued = 0;
  const schedule = createStationOrdersPollReconciliationScheduler({
    minIntervalMs: 0,
    backpressureDelayMs: 1,
    deferInitialSchedule: true,
    readDb: async () => ({ integration: {}, meta: {} }),
    writeIntegrationOrderDb: async () => {},
    enqueueMutation(label, key, run) {
      enqueued += 1;
      assert.equal(label, "GET /api/integration/orders station reconciliation");
      assert.equal(key, "station:BAR PRINCIPALE");
      return run();
    },
    normalizeStation: (value) => String(value ?? "").trim().toUpperCase(),
  });

  assert.equal(schedule("BAR PRINCIPALE", { stateVersion: "v1" }), false);
  assert.equal(schedule("bar principale", { stateVersion: "v2" }), false);
  assert.equal(enqueued, 0);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(enqueued, 1);
  assert.equal(schedule("bar principale", { stateVersion: "v2" }), false);
});
