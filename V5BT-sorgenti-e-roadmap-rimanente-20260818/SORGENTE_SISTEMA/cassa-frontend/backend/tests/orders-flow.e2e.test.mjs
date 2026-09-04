import test from "node:test";
import assert from "node:assert/strict";
import {
  apiPost,
  authHeaders,
  authPayload,
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";
import { createTableStateSplitRepository } from "../db/app-state/index.js";

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

test("[BE][P0] creazione ordine semplice aggiorna ordine, tavolo e audit", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-simple-device",
    clientApp: "mobile-frontend",
  });

  const result = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "order-simple-device",
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.order.id, "00001");
  assert.equal(result.body.order.tableId, "room_pedana_t05");
  assert.equal(result.body.order.workflowStatus, "waiting");
  assert.equal(result.body.order.total, 1.3);
  assert.equal(result.body.order.items[0].productId, "menu_caffetteria_caffe");

  const persisted = await readJson(dbPath);
  const order = persisted.integration.orders.find((entry) => entry.id === "00001");
  const table = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(order.total, 1.3);
  assert.equal(order.paymentStatus, "unpaid");
  assert.equal(table.status, "waiting");
  assert.equal(table.totalDue, 0);
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "order.created"));
});

test("[BE][P0] creazione ordine multi-linea calcola totali e snapshot prezzo", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      const ginTonic = state.menuItems.find((entry) => entry.id === "menu_drink_gin_tonic");
      ginTonic.variantRequired = true;
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-multiline-device",
    clientApp: "mobile-frontend",
  });

  const result = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "order-multiline-device",
    lines: [
      { name: "Caffe", productId: "menu_caffetteria_caffe", qty: 2, price: 1.3 },
      { name: "Cappuccino", productId: "menu_caffetteria_cappuccino", qty: 1, price: 1.6 },
    ],
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.order.total, 4.2);
  assert.equal(result.body.order.items.length, 3);
  assert.equal(result.body.order.items.filter((entry) => entry.productId === "menu_caffetteria_caffe").length, 2);
  assert.ok(result.body.order.items.every((entry) => Number.isFinite(entry.unitPriceApplied)));

  const persisted = await readJson(dbPath);
  const lineAudit = persisted.auditEvents.filter((entry) => entry.action === "order.line_added");
  assert.equal(lineAudit.length, 2);
  assert.equal(persisted.integration.orders[0].total, 4.2);
});

test("[BE][P0] creazione ordine con variante salva delta e routing cocktail", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      const ginTonic = state.menuItems.find((entry) => entry.id === "menu_drink_gin_tonic");
      ginTonic.variantRequired = true;
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-variant-device",
    clientApp: "mobile-frontend",
  });

  const result = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "order-variant-device",
    lines: [
      {
        name: "Gin Tonic",
        productId: "menu_drink_gin_tonic",
        qty: 1,
        price: 8,
        variant: "Gin premium",
      },
    ],
  });

  assert.equal(result.response.status, 200);
  const item = result.body.order.items[0];
  assert.equal(item.selectedVariantName, "Gin premium");
  assert.equal(item.selectedVariantPriceDelta, 2.5);
  assert.equal(item.unitPriceApplied, 10.5);
  assert.deepEqual(item.routeStations, ["BAR-1"]);
  assert.ok(result.body.order.tickets.some((entry) => entry.stationId === "BAR-1"));

  const persisted = await readJson(dbPath);
  const order = persisted.integration.orders[0];
  assert.equal(order.total, 10.5);
  assert.deepEqual(order.items[0].routeStations, ["BAR-1"]);
});

test("[BE][P0] variante obbligatoria senza scelta viene rifiutata senza mutazioni", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      const ginTonic = state.menuItems.find((entry) => entry.id === "menu_drink_gin_tonic");
      ginTonic.variantRequired = true;
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-variant-required",
    clientApp: "mobile-frontend",
  });

  const result = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "order-variant-required",
    lines: [{ name: "Gin Tonic", productId: "menu_drink_gin_tonic", qty: 1, price: 8 }],
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, "PREMIUM_ALCOHOL_VARIANT_REQUIRED");

  const persisted = await readJson(dbPath);
  assert.equal(persisted.integration.orders.length, 0);
  const table = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(table.totalDue, 0);
});

test("[BE][P0] sync stato ordine da postazione aggiorna pronta senza duplicare ordine", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-sync-cashier",
    clientApp: "mobile-frontend",
  });
  const station = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-sync-postazione",
    clientApp: "postazione",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "order-sync-cashier",
  });
  assert.equal(created.response.status, 200);

  const nextOrder = {
    ...created.body.order,
    workflowStatus: "ready",
    items: created.body.order.items.map((item) => ({ ...item, done: true })),
  };
  const synced = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "order-sync-postazione", {
      id: created.body.order.id,
      order: nextOrder,
      clientApp: "postazione",
      workflowReason: "station_ready",
    })
  );

  assert.equal(synced.response.status, 200);
  assert.equal(synced.body.order.id, created.body.order.id);
  assert.equal(synced.body.order.workflowStatus, "delivered");
  assert.ok(synced.body.order.items.every((entry) => entry.done === true));

  const persisted = await readJson(dbPath);
  assert.equal(persisted.integration.orders.length, 1);
  assert.equal(persisted.integration.orders[0].workflowStatus, "delivered");
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "order.status_changed"));
});

test("[BE][MP-4] orders/sync aggiorna tableStates externalized senza stato tavolo nel JSON primario", async (t) => {
  const runDir = await createTempRunDir("order-sync-table-states-externalized");
  const splitDbPath = `${runDir}/app-state-split.sqlite`;
  const { baseUrl, dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
      BACKEND_APP_STATE_SPLIT_DB_PATH: splitDbPath,
      RUNTIME_METRICS: "1",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-sync-table-state-cashier",
    clientApp: "mobile-frontend",
  });
  const station = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-sync-table-state-postazione",
    clientApp: "postazione",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "order-sync-table-state-cashier",
  });
  assert.equal(created.response.status, 200);

  const synced = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "order-sync-table-state-postazione", {
      id: created.body.order.id,
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
      clientApp: "postazione",
      workflowReason: "station_ready",
    }),
  );
  assert.equal(synced.response.status, 200);
  assert.equal(synced.body.order.workflowStatus, "delivered");

  const persisted = await readJson(dbPath);
  const persistedTable = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(persistedTable.status, undefined);
  assert.equal(persistedTable.totalDue, undefined);
  assert.equal(persistedTable.pendingBills, undefined);
  assert.equal(persisted.meta.appStateSplitDomains.tableStates.mode, "externalized");

  const split = createTableStateSplitRepository({
    mode: "externalized",
    dbPath: splitDbPath,
    cloneJson,
    logger: { warn() {} },
  });
  try {
    const splitTables = await split.listTableStates();
    const splitTable = splitTables.find((entry) => entry.tableId === "room_pedana_t05");
    assert.ok(splitTable);
    assert.equal(splitTable.state.status, "payment_due");
    assert.equal(splitTable.state.totalDue, 1.3);
    assert.equal(splitTable.state.pendingBills.length, 1);
    assert.equal(splitTable.state.pendingBills[0].orderIds[0], created.body.order.id);
  } finally {
    split.close();
  }
});

test("[BE][P3] sync terminale duplicata resta idempotente senza side effect", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    env: {
      RUNTIME_METRICS: "1",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-sync-noop-cashier",
    clientApp: "mobile-frontend",
  });
  const station = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-sync-noop-postazione",
    clientApp: "postazione",
  });
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid: "order-sync-noop-admin",
    clientApp: "cassa-frontend",
  });
  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "order-sync-noop-cashier",
  });
  assert.equal(created.response.status, 200);

  const synced = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "order-sync-noop-postazione", {
      id: created.body.order.id,
      clientApp: "postazione",
      workflowReason: "station_ready",
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
    })
  );
  assert.equal(synced.response.status, 200);
  assert.equal(synced.body.order.workflowStatus, "delivered");

  const before = await readJson(dbPath);
  const beforeOrder = before.integration.orders.find((entry) => entry.id === created.body.order.id);
  const duplicate = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "order-sync-noop-postazione", {
      id: created.body.order.id,
      clientApp: "postazione",
      workflowReason: "station_ready",
      order: { ...synced.body.order, workflowStatus: "delivered" },
    })
  );
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.idempotent, true);
  assert.equal(duplicate.body.noop, true);
  assert.equal(duplicate.body.order.revision, beforeOrder.revision);

  const after = await readJson(dbPath);
  const afterOrder = after.integration.orders.find((entry) => entry.id === created.body.order.id);
  assert.equal(afterOrder.revision, beforeOrder.revision);
  assert.equal(after.auditEvents.length, before.auditEvents.length);
  assert.equal(after.integration.notifications.length, before.integration.notifications.length);
  assert.equal(
    (after.integration.orderFulfillmentHistory ?? []).length,
    (before.integration.orderFulfillmentHistory ?? []).length,
  );

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(admin, "order-sync-noop-admin"),
  });
  assert.equal(metricsResponse.status, 200);
  const metricsBody = await metricsResponse.json();
  assert.equal(
    metricsBody.runtimeMetrics.counters.orderTerminalDuplicateSyncNoops,
    1,
  );
  assert.equal(
    metricsBody.runtimeMetrics.counters.orderTerminalDuplicateSyncPreLaneNoops,
    0,
  );
  assert.equal(metricsBody.runtimeMetrics.counters.orderSyncTableStateChanged, 1);
  assert.equal(metricsBody.runtimeMetrics.counters.orderSyncTableStateNoops, 0);
  assert.equal(metricsBody.runtimeMetrics.counters.orderLaneEnqueued, 0);
});

test("[BE][P3] sync terminale duplicata externalized salta la order lane", async (t) => {
  const runDir = await createTempRunDir("order-sync-prelane");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_APP_STATE_SPLIT_ORDERS: "externalized",
      BACKEND_APP_STATE_SPLIT_DB_PATH: `${runDir}/app-state-split.sqlite`,
      RUNTIME_METRICS: "1",
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-sync-prelane-cashier",
    clientApp: "mobile-frontend",
  });
  const station = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-sync-prelane-postazione",
    clientApp: "postazione",
  });
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid: "order-sync-prelane-admin",
    clientApp: "cassa-frontend",
  });
  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "order-sync-prelane-cashier",
  });
  assert.equal(created.response.status, 200);
  const synced = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "order-sync-prelane-postazione", {
      id: created.body.order.id,
      clientApp: "postazione",
      workflowReason: "station_ready",
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
    })
  );
  assert.equal(synced.response.status, 200);
  assert.equal(synced.body.order.workflowStatus, "delivered");

  const duplicate = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "order-sync-prelane-postazione", {
      id: created.body.order.id,
      clientApp: "postazione",
      workflowReason: "station_ready",
      order: { id: synced.body.order.id, workflowStatus: "delivered" },
    })
  );
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.idempotent, true);
  assert.equal(duplicate.body.noop, true);
  assert.equal(duplicate.body.preLane, true);
  assert.equal(duplicate.body.order.revision, synced.body.order.revision);

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(admin, "order-sync-prelane-admin"),
  });
  assert.equal(metricsResponse.status, 200);
  const metricsBody = await metricsResponse.json();
  assert.equal(metricsBody.runtimeMetrics.counters.orderTerminalDuplicateSyncNoops, 1);
  assert.equal(metricsBody.runtimeMetrics.counters.orderTerminalDuplicateSyncPreLaneNoops, 1);
  assert.equal(metricsBody.runtimeMetrics.counters.orderSyncTableStateChanged, 1);
  assert.equal(metricsBody.runtimeMetrics.counters.orderSyncTableStateNoops, 0);
  assert.equal(metricsBody.runtimeMetrics.counters.orderLaneEnqueued, 2);
});
