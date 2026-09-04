import test from "node:test";
import assert from "node:assert/strict";
import {
  apiPost,
  authPayload,
  createSimpleOrder,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

test("[BE][P0] acquisizione lock tavolo impedisce lock concorrente", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "lock-cashier-a",
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "lock-manager-b",
    clientApp: "cassa-frontend",
  });

  const acquired = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(cashier, "lock-cashier-a", {
      tableId: "room_pedana_t05",
      purpose: "open_table",
    })
  );
  assert.equal(acquired.response.status, 200);
  assert.equal(acquired.body.lock.tableId, "room_pedana_t05");
  assert.equal(acquired.body.lock.userId, "u_cashier");

  const denied = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(manager, "lock-manager-b", {
      tableId: "room_pedana_t05",
      purpose: "open_table",
    })
  );
  assert.equal(denied.response.status, 409);
  assert.equal(denied.body.code, "TABLE_LOCKED");

  const persisted = await readJson(dbPath);
  const table = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(table.workLock.userId, "u_cashier");
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "table.lock_acquired"));
});

test("[BE][P0] heartbeat mantiene vivo il lock e release richiede stesso device", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "lock-heartbeat-device",
    clientApp: "mobile-frontend",
  });
  await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(cashier, "lock-heartbeat-device", {
      tableId: "room_pedana_t05",
      purpose: "edit",
    })
  );

  const heartbeat = await apiPost(
    baseUrl,
    "/api/tables/lock/heartbeat",
    authPayload(cashier, "lock-heartbeat-device", {
      tableId: "room_pedana_t05",
      purpose: "edit",
    })
  );
  assert.equal(heartbeat.response.status, 200);
  assert.equal(heartbeat.body.lock.deviceUuid, "lock-heartbeat-device");

  const wrongDeviceRelease = await apiPost(
    baseUrl,
    "/api/tables/lock/release",
    authPayload(cashier, "other-device", {
      tableId: "room_pedana_t05",
    })
  );
  assert.equal(wrongDeviceRelease.response.status, 401);

  const released = await apiPost(
    baseUrl,
    "/api/tables/lock/release",
    authPayload(cashier, "lock-heartbeat-device", {
      tableId: "room_pedana_t05",
    })
  );
  assert.equal(released.response.status, 200);
  assert.equal(released.body.released, true);

  const persisted = await readJson(dbPath);
  const table = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(table.workLock, null);
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "table.lock_heartbeat"));
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "table.lock_released"));
});

test("[BE][P0] force release funziona solo con permesso adeguato", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "force-owner",
    clientApp: "mobile-frontend",
  });
  const waiter = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "force-waiter",
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "force-manager",
    clientApp: "cassa-frontend",
  });

  await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(cashier, "force-owner", {
      tableId: "room_pedana_t05",
      purpose: "payment",
    })
  );

  const denied = await apiPost(
    baseUrl,
    "/api/tables/lock/force-release",
    authPayload(waiter, "force-waiter", {
      tableId: "room_pedana_t05",
    })
  );
  assert.equal(denied.response.status, 403);

  const forced = await apiPost(
    baseUrl,
    "/api/tables/lock/force-release",
    authPayload(manager, "force-manager", {
      tableId: "room_pedana_t05",
    })
  );
  assert.equal(forced.response.status, 200);
  assert.equal(forced.body.released, true);

  const persisted = await readJson(dbPath);
  const table = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(table.workLock, null);
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "table.lock_force_released"));
});

test("[BE][P0] mutazioni sono bloccate da lock altrui", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "mutation-owner",
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "mutation-other",
    clientApp: "mobile-frontend",
  });

  await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(cashier, "mutation-owner", {
      tableId: "room_pedana_t05",
      purpose: "order",
    })
  );

  const deniedOrder = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: "mutation-other",
    tableId: "room_pedana_t05",
  });
  assert.equal(deniedOrder.response.status, 409);
  assert.equal(deniedOrder.body.code, "TABLE_LOCKED");

  const persisted = await readJson(dbPath);
  assert.equal(persisted.integration.orders.length, 0);
  const table = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(table.status, "free");
});

test("[BE][P0] pagamento tavolo richiede lock gia acquisito", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "payment-lock-required",
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "payment-lock-required",
    tableId: "room_pedana_t05",
  });
  assert.equal(created.response.status, 200);

  const denied = await apiPost(
    baseUrl,
    "/api/payments/table",
    authPayload(cashier, "payment-lock-required", {
      tableId: "room_pedana_t05",
      paymentMethodId: "pay_cash",
      cashGiven: 1.3,
      idempotencyKey: "payment-without-table-lock",
    })
  );

  assert.equal(denied.response.status, 428);
  assert.equal(denied.body.code, "TABLE_LOCK_REQUIRED");

  const persisted = await readJson(dbPath);
  assert.equal(persisted.paymentContainers.length, 0);
  assert.equal(persisted.paymentTransactions.length, 0);
  const table = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(table.workLock, null);
});

test("[BE][P0] orders/create rilascia solo il lock temporaneo", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "order-create-temp-lock-device",
    clientApp: "mobile-frontend",
  });

  const createdWithoutExistingLock = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "order-create-temp-lock-device",
    tableId: "room_pedana_t06",
    roomId: "room_pedana",
    tableNumber: 6,
    extraPayload: {
      idempotencyKey: "order-create-temp-lock-released",
    },
  });
  assert.equal(createdWithoutExistingLock.response.status, 200);
  let persisted = await readJson(dbPath);
  let table = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t06");
  assert.equal(table.workLock, null);
  assert.ok(
    persisted.auditEvents.some(
      (entry) =>
        entry.action === "table.lock_released" &&
        entry.payload?.tableId === "room_pedana_t06"
    )
  );

  const acquired = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(cashier, "order-create-temp-lock-device", {
      tableId: "room_pedana_t07",
      purpose: "manual_edit",
    })
  );
  assert.equal(acquired.response.status, 200);

  const createdWithExistingLock = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "order-create-temp-lock-device",
    tableId: "room_pedana_t07",
    roomId: "room_pedana",
    tableNumber: 7,
    extraPayload: {
      idempotencyKey: "order-create-existing-lock-preserved",
    },
  });
  assert.equal(createdWithExistingLock.response.status, 200);
  persisted = await readJson(dbPath);
  table = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t07");
  assert.equal(table.workLock.userId, "u_cashier");
  assert.equal(table.workLock.deviceUuid, "order-create-temp-lock-device");

  const released = await apiPost(
    baseUrl,
    "/api/tables/lock/release",
    authPayload(cashier, "order-create-temp-lock-device", {
      tableId: "room_pedana_t07",
    })
  );
  assert.equal(released.response.status, 200);
  assert.equal(released.body.released, true);
});

test("[BE][P0] secondo operatore non puo incassare un tavolo bloccato da altri", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "payment-owner",
    clientApp: "mobile-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "payment-other",
    clientApp: "mobile-frontend",
  });

  await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(cashier, "payment-owner", {
      tableId: "room_pedana_t05",
      purpose: "payment.free_split",
    })
  );

  const denied = await apiPost(
    baseUrl,
    "/api/payments/free-split",
    authPayload(manager, "payment-other", {
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      splitType: "FREE_SPLIT",
      parts: [
        {
          amountDue: 1.3,
          transactions: [{ method: "CASH", amountPaid: 1.3, cashGiven: 1.3 }],
        },
      ],
    })
  );

  assert.equal(denied.response.status, 409);
  assert.equal(denied.body.code, "TABLE_LOCKED");

  const persisted = await readJson(dbPath);
  assert.equal(persisted.paymentContainers.length, 0);
  assert.equal(persisted.paymentTransactions.length, 0);
});
