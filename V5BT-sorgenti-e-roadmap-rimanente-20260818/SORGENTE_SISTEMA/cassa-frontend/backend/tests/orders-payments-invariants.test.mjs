import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  compareDomain,
  openRelationalConnection,
  runRelationalMigrations,
} from "../db/relational/index.js";
import { normalizeRelationalConfig } from "../db/relational/connection.js";
import {
  apiPost,
  acquireTableLock,
  authPayload,
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

function roundMoney(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function nowIso() {
  return "2026-05-13T19:00:00.000Z";
}

function numericValue(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function billLineTotal(bill) {
  return roundMoney(
    (Array.isArray(bill?.lines) ? bill.lines : []).reduce((sum, line) => {
      const qty = Number(line?.qty ?? line?.quantity) || 1;
      const unit = numericValue(
        line?.unitPrice,
        line?.unitPriceApplied,
        line?.price,
        line?.lineTotal,
        line?.total
      );
      if (unit === null) return sum;
      if (line?.lineTotal !== undefined || line?.total !== undefined) return sum + unit;
      return sum + unit * qty;
    }, 0)
  );
}

function billOpenDue(bill) {
  const explicitDue = numericValue(bill?.dueAmount, bill?.amountDue, bill?.due, bill?.totalDue);
  if (explicitDue !== null) return roundMoney(Math.max(explicitDue, 0));
  const total = numericValue(bill?.totalAmount, bill?.amount, bill?.total, bill?.subtotal) ?? billLineTotal(bill);
  const paid = numericValue(bill?.paidAmount, bill?.paid) ?? 0;
  return roundMoney(Math.max(total - paid, 0));
}

function openBills(table) {
  return (Array.isArray(table?.pendingBills) ? table.pendingBills : []).filter((bill) => {
    const status = String(bill?.status ?? "").trim().toLowerCase();
    return !["paid", "closed", "cancelled", "voided"].includes(status);
  });
}

function assertTableDueMatchesOpenBills(table) {
  const dueFromBills = roundMoney(openBills(table).reduce((sum, bill) => sum + billOpenDue(bill), 0));
  assert.equal(roundMoney(table?.totalDue), dueFromBills);
}

function findOrder(state, orderId) {
  const order = (state.integration?.orders ?? []).find((entry) => String(entry?.id) === String(orderId));
  assert.ok(order, `ordine ${orderId} non trovato`);
  return order;
}

function findTable(state, tableId) {
  const table = (state.posSettings?.tables ?? []).find((entry) => String(entry?.id) === String(tableId));
  assert.ok(table, `tavolo ${tableId} non trovato`);
  return table;
}

async function createReadyOrder(baseUrl, session, deviceUuid, options = {}) {
  const tableId = options.tableId ?? "room_pedana_t05";
  const lock = await acquireTableLock(baseUrl, session, tableId, {
    deviceUuid,
    purpose: "guardrail_payment_fixture",
  });
  assert.equal(lock.response.status, 200);
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    tableId,
    roomId: options.roomId ?? "room_pedana",
    tableNumber: options.tableNumber ?? 5,
    lines: options.lines,
  });
  assert.equal(created.response.status, 200);
  const ready = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: created.body.order.id,
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
      workflowReason: "guardrail_ready",
    })
  );
  assert.equal(ready.response.status, 200);
  return ready.body.order;
}

async function createDeliveredOrder(baseUrl, session, deviceUuid, options = {}) {
  const ready = await createReadyOrder(baseUrl, session, deviceUuid, options);
  const delivered = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: ready.id,
      order: {
        ...ready,
        workflowStatus: "delivered",
        items: ready.items.map((item) => ({ ...item, done: true })),
      },
      workflowReason: "guardrail_delivered",
    })
  );
  assert.equal(delivered.response.status, 200);
  return delivered.body.order;
}

async function payFreeSplit(baseUrl, session, deviceUuid, order, amount, options = {}) {
  return apiPost(
    baseUrl,
    "/api/payments/free-split",
    authPayload(session, deviceUuid, {
      tableId: options.tableId ?? order.tableId,
      roomId: options.roomId ?? order.roomId ?? "room_pedana",
      orderId: order.id,
      splitType: "FREE_SPLIT",
      idempotencyKey: options.idempotencyKey ?? `guardrail-split-${order.id}-${amount}`,
      releaseTable: options.releaseTable,
      parts: [
        {
          amountDue: amount,
          transactions: [
            {
              method: options.method ?? "CASH",
              methodId: options.methodId ?? "pay_cash",
              methodLabel: options.methodLabel ?? "Contanti",
              amountPaid: amount,
              cashGiven: options.cashGiven ?? amount,
            },
          ],
        },
      ],
    })
  );
}

async function cancelOrder(baseUrl, session, deviceUuid, order, expectedStatus = 200) {
  await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId: order.tableId, purpose: "order.cancel" })
  );
  const result = await apiPost(
    baseUrl,
    "/api/integration/orders/cancel",
    authPayload(session, deviceUuid, {
      orderId: order.id,
      tableId: order.tableId,
      roomId: order.roomId ?? "room_pedana",
      expectedRevision: order.revision ?? order.currentRevision ?? 1,
      reason: "Guardrail annullamento",
    })
  );
  assert.equal(result.response.status, expectedStatus);
  return result;
}

async function correctOrder(baseUrl, session, deviceUuid, order) {
  const lineId = order.items?.[0]?.lineId ?? order.items?.[0]?.id;
  assert.ok(lineId, "serve una riga correggibile");
  await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId: order.tableId, purpose: "order.correction" })
  );
  const result = await apiPost(
    baseUrl,
    "/api/integration/orders/correct",
    authPayload(session, deviceUuid, {
      orderId: order.id,
      tableId: order.tableId,
      roomId: order.roomId ?? "room_pedana",
      expectedRevision: order.revision ?? order.currentRevision ?? 1,
      changedItems: [{ lineId, nextQuantity: 2 }],
      idempotencyKey: `guardrail-correct-${order.id}`,
    })
  );
  assert.equal(result.response.status, 200);
  return result.body.order;
}

async function startShadowBackend(t, prefix = "orders-payments-shadow") {
  const runDir = await createTempRunDir(prefix);
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
  });
  return { ...backend, relationalPath };
}

async function assertRelationalDomainsMatch(state, relationalPath, domains) {
  const db = await openRelationalConnection(
    normalizeRelationalConfig({
      env: {
        BACKEND_RELATIONAL_ENABLED: "1",
        BACKEND_RELATIONAL_MODE: "shadow",
        BACKEND_RELATIONAL_DB_PATH: relationalPath,
      },
    })
  );
  try {
    await runRelationalMigrations(db, { nowIso });
    for (const domain of domains) {
      const comparison = compareDomain(state, db, domain);
      assert.equal(comparison.skipped, false, comparison.reason ?? domain);
      assert.equal(
        comparison.matches,
        true,
        `${domain} mismatch app-state=${comparison.appState?.checksum} relational=${comparison.relational?.checksum}`
      );
    }
  } finally {
    closeRelationalConnection(db);
  }
}

test("orders/payments primary read e write restano disattivati", () => {
  assert.throws(
    () =>
      normalizeRelationalConfig({
        env: {
          BACKEND_RELATIONAL_ENABLED: "1",
          BACKEND_RELATIONAL_MODE: "primary",
          BACKEND_RELATIONAL_PRIMARY_DOMAINS: "orders",
        },
      }),
    /BACKEND_RELATIONAL_PRIMARY_DOMAINS non valido/i
  );
  assert.throws(
    () =>
      normalizeRelationalConfig({
        env: {
          BACKEND_RELATIONAL_ENABLED: "1",
          BACKEND_RELATIONAL_MODE: "primary",
          BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users",
          BACKEND_RELATIONAL_WRITE_PRIMARY_DOMAINS: "orders,payments",
        },
      }),
    /BACKEND_RELATIONAL_WRITE_PRIMARY_DOMAINS non e' ancora supportato/i
  );
});

test("totale tavolo uguale alla somma dei bills aperti meno pagato", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-due-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, session, "guardrail-due-device");
  const partial = await payFreeSplit(baseUrl, session, "guardrail-due-device", order, 0.5, {
    idempotencyKey: "guardrail-due-partial",
    releaseTable: false,
  });
  assert.equal(partial.response.status, 200);

  const state = await readJson(dbPath);
  const table = findTable(state, order.tableId);
  assert.equal(roundMoney(table.totalDue), 0.8);
  assert.equal(roundMoney(table.amountDue), 0.8);
  assert.equal(roundMoney(table.dueAmount), 0.8);
  assertTableDueMatchesOpenBills(table);
});

test("ordine pagato non puo tornare unpaid da sync tardivo", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-paid-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, session, "guardrail-paid-device");
  const paid = await apiPost(
    baseUrl,
    "/api/payments/table",
    authPayload(session, "guardrail-paid-device", {
      tableId: order.tableId,
      paymentMethodId: "pay_cash",
      cashGiven: 1.3,
      idempotencyKey: "guardrail-paid-table",
    })
  );
  assert.equal(paid.response.status, 200);

  const stale = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, "guardrail-paid-device", {
      id: order.id,
      order: {
        ...order,
        paymentStatus: "unpaid",
        paidAmount: 0,
        dueAmount: 1.3,
        workflowStatus: "ready",
      },
      workflowReason: "guardrail_stale_unpaid",
    })
  );
  assert.ok([200, 409].includes(stale.response.status));

  const state = await readJson(dbPath);
  const persistedOrder = findOrder(state, order.id);
  assert.equal(persistedOrder.paymentStatus, "paid");
  assert.equal(roundMoney(persistedOrder.dueAmount), 0);
});

test("pagamento con stessa idempotency key non duplica transazioni", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-idem-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, session, "guardrail-idem-device");
  const payload = {
    idempotencyKey: "guardrail-idempotent-payment",
  };

  const first = await payFreeSplit(baseUrl, session, "guardrail-idem-device", order, 1.3, payload);
  assert.equal(first.response.status, 200);
  const second = await payFreeSplit(baseUrl, session, "guardrail-idem-device", order, 1.3, payload);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.idempotent, true);

  const state = await readJson(dbPath);
  assert.equal(
    state.paymentContainers.filter((entry) => entry.idempotencyKey === "guardrail-idempotent-payment").length,
    1
  );
  assert.equal(state.paymentTransactions.length, 1);
});

test("cancellazione ordine pagato non crea saldo negativo", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-cancel-paid-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, session, "guardrail-cancel-paid-device");
  const paid = await apiPost(
    baseUrl,
    "/api/payments/table",
    authPayload(session, "guardrail-cancel-paid-device", {
      tableId: order.tableId,
      paymentMethodId: "pay_cash",
      cashGiven: 1.3,
      idempotencyKey: "guardrail-cancel-paid-table",
    })
  );
  assert.equal(paid.response.status, 200);

  const cancelled = await cancelOrder(baseUrl, session, "guardrail-cancel-paid-device", {
    ...order,
    revision: 1,
  }, 409);
  assert.equal(cancelled.body.code, "ORDER_ALREADY_PAID");

  const state = await readJson(dbPath);
  const persistedOrder = findOrder(state, order.id);
  const table = findTable(state, order.tableId);
  assert.equal(persistedOrder.paymentStatus, "paid");
  assert.ok(roundMoney(persistedOrder.dueAmount) >= 0);
  assert.ok(roundMoney(table.totalDue) >= 0);
});

test("cancellazione tavolo conserva ordini pagati e marca cancellati quelli non pagati", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-table-cancel-cashier",
    clientApp: "mobile-frontend",
  });
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "guardrail-table-cancel-admin",
    clientApp: "monitor-frontend",
  });
  const tableId = "room_pedana_t05";
  const unpaidOrder = await createDeliveredOrder(baseUrl, cashier, "guardrail-table-cancel-cashier", {
    tableId,
    roomId: "room_pedana",
    tableNumber: 5,
  });
  const paidOrder = await createDeliveredOrder(baseUrl, cashier, "guardrail-table-cancel-cashier", {
    tableId,
    roomId: "room_pedana",
    tableNumber: 5,
  });
  const paid = await payFreeSplit(baseUrl, cashier, "guardrail-table-cancel-cashier", paidOrder, 1.3, {
    idempotencyKey: "guardrail-table-cancel-paid",
    releaseTable: false,
  });
  assert.equal(paid.response.status, 200);

  const cancelled = await apiPost(
    baseUrl,
    "/api/monitor/control",
    authPayload(admin, "guardrail-table-cancel-admin", {
      action: "table_cancel_full",
      tableId,
      confirm: true,
      reason: "Test cancellazione logica tavolo",
    })
  );
  assert.equal(cancelled.response.status, 200);
  const cancellationResult = cancelled.body?.result ?? cancelled.body;
  assert.deepEqual(cancellationResult.deletedOrderIds, []);
  assert.ok(cancellationResult.cancelledOrderIds.includes(unpaidOrder.id));
  assert.ok(!cancellationResult.cancelledOrderIds.includes(paidOrder.id));

  const state = await readJson(dbPath);
  const persistedUnpaidOrder = findOrder(state, unpaidOrder.id);
  const persistedPaidOrder = findOrder(state, paidOrder.id);
  const table = findTable(state, tableId);
  assert.equal(persistedUnpaidOrder.workflowStatus, "cancelled");
  assert.equal(persistedUnpaidOrder.paymentStatus, "unpaid");
  assert.equal(roundMoney(persistedUnpaidOrder.dueAmount), 0);
  assert.equal(typeof persistedUnpaidOrder.tableCancellationId, "string");
  assert.equal(persistedPaidOrder.paymentStatus, "paid");
  assert.equal(roundMoney(persistedPaidOrder.dueAmount), 0);
  assert.equal(roundMoney(table.totalDue), 0);
  assert.equal(openBills(table).length, 0);
});

test("split parziale mantiene residuo corretto", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-split-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, session, "guardrail-split-device");
  const split = await payFreeSplit(baseUrl, session, "guardrail-split-device", order, 0.5, {
    idempotencyKey: "guardrail-partial-split",
    releaseTable: false,
  });
  assert.equal(split.response.status, 200);

  const state = await readJson(dbPath);
  const persistedOrder = findOrder(state, order.id);
  const table = findTable(state, order.tableId);
  assert.equal(persistedOrder.paymentStatus, "partial");
  assert.equal(roundMoney(persistedOrder.paidAmount), 0.5);
  assert.equal(roundMoney(persistedOrder.dueAmount), 0.8);
  assert.equal(roundMoney(table.totalDue), 0.8);
  assertTableDueMatchesOpenBills(table);
});

test("stampa ricevuta non viene duplicata su retry idempotente", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-print-idem-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, session, "guardrail-print-idem-device");
  const payload = { idempotencyKey: "guardrail-print-idempotent" };
  const first = await payFreeSplit(baseUrl, session, "guardrail-print-idem-device", order, 1.3, payload);
  assert.equal(first.response.status, 200);
  const afterFirst = await readJson(dbPath);
  const firstJobIds = new Set((afterFirst.printSpoolJobs ?? []).map((job) => job.id));

  const second = await payFreeSplit(baseUrl, session, "guardrail-print-idem-device", order, 1.3, payload);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.idempotent, true);
  const afterSecond = await readJson(dbPath);
  const secondJobIds = new Set((afterSecond.printSpoolJobs ?? []).map((job) => job.id));
  assert.deepEqual(secondJobIds, firstJobIds);
});

test("lock tavolo impedisce mutazioni concorrenti da altro device", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const holder = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-lock-holder",
    clientApp: "mobile-frontend",
  });
  const other = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "guardrail-lock-other",
    clientApp: "mobile-frontend",
  });
  const lock = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(holder, "guardrail-lock-holder", {
      tableId: "room_pedana_t05",
      purpose: "guardrail",
    })
  );
  assert.equal(lock.response.status, 200);

  const rejected = await createSimpleOrder(baseUrl, other, {
    deviceUuid: "guardrail-lock-other",
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    tableNumber: 5,
  });
  assert.equal(rejected.response.status, 409);

  const state = await readJson(dbPath);
  assert.equal(state.integration.orders.length, 0);
});

test("sync postazione tardivo non resuscita ordine cancellato", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-cancel-device",
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid: "guardrail-cancel-device",
  });
  assert.equal(created.response.status, 200);
  await cancelOrder(baseUrl, session, "guardrail-cancel-device", created.body.order);

  const late = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, "guardrail-cancel-device", {
      id: created.body.order.id,
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
      workflowReason: "guardrail_late_ready",
    })
  );
  assert.equal(late.response.status, 409);
  assert.equal(late.body.code, "ORDER_CANCELLED");

  const state = await readJson(dbPath);
  assert.equal(findOrder(state, created.body.order.id).workflowStatus, "cancelled");
});

test("ordine trasferito cambia tableId senza perdere bill/payment references", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "guardrail-move-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, session, "guardrail-move-device");
  const partial = await payFreeSplit(baseUrl, session, "guardrail-move-device", order, 0.5, {
    idempotencyKey: "guardrail-move-partial",
    releaseTable: false,
  });
  assert.equal(partial.response.status, 200);

  for (const tableId of ["room_pedana_t05", "room_pedana_t06"]) {
    await apiPost(
      baseUrl,
      "/api/tables/lock/acquire",
      authPayload(session, "guardrail-move-device", { tableId, purpose: "table.move" })
    );
  }
  const moved = await apiPost(
    baseUrl,
    "/api/integration/layout/table/move",
    authPayload(session, "guardrail-move-device", {
      fromTableId: "room_pedana_t05",
      toTableId: "room_pedana_t06",
    })
  );
  assert.equal(moved.response.status, 200);
  assert.equal(moved.body.movedOrdersCount, 1);

  const state = await readJson(dbPath);
  const movedOrder = findOrder(state, order.id);
  const sourceTable = findTable(state, "room_pedana_t05");
  const targetTable = findTable(state, "room_pedana_t06");
  assert.equal(movedOrder.tableId, "room_pedana_t06");
  assert.equal(roundMoney(movedOrder.dueAmount), 0.8);
  assert.equal(roundMoney(sourceTable.totalDue), 0);
  assert.equal(roundMoney(targetTable.totalDue), 0.8);
  assert.ok(
    state.paymentContainers.some(
      (payment) =>
        payment.idempotencyKey === "guardrail-move-partial" &&
        (payment.orderId === order.id || payment.orderIds?.includes(order.id))
    )
  );
  assert.ok(targetTable.pendingBills.some((bill) => bill.orderId === order.id || bill.orderIds?.includes(order.id)));
});

test("writeDb serializza mutazioni concorrenti", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const expected = Array.from({ length: 12 }, (_, index) => `Guardrail write ${index}`);
  await Promise.all(
    expected.map((title, index) =>
      fetch(`${baseUrl}/api/integration/notifications/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "general",
          title,
          description: `Mutazione concorrente ${index}`,
          meta: { index },
        }),
      }).then((response) => {
        assert.equal(response.status, 200);
      })
    )
  );

  const state = await readJson(dbPath);
  const titles = new Set((state.integration?.notifications ?? []).map((entry) => entry.title));
  for (const title of expected) {
    assert.equal(titles.has(title), true, `notifica mancante: ${title}`);
  }
});

test("shadow orders/tablesBills coerente dopo creazione ordine", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startShadowBackend(t, "guardrail-shadow-order-create");
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-shadow-create",
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid: "guardrail-shadow-create",
  });
  assert.equal(created.response.status, 200);

  await assertRelationalDomainsMatch(await readJson(dbPath), relationalPath, ["orders", "tablesBills"]);
});

test("shadow tablesBills coerente dopo lock e table-groups save", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startShadowBackend(t, "guardrail-shadow-tables-groups");
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "guardrail-shadow-tables-admin",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, admin, "guardrail-shadow-tables-admin", {
    tableId: "room_sala_t01",
    roomId: "room_sala",
    tableNumber: 1,
  });
  const grouped = await apiPost(
    baseUrl,
    "/api/integration/table-groups/save",
    authPayload(admin, "guardrail-shadow-tables-admin", {
      groups: [
        {
          id: "room_sala_t01",
          type: "complex",
          children: [
            { id: "room_sala_t01", type: "simple" },
            { id: "room_sala_t02", type: "simple" },
          ],
        },
      ],
      operation: "merge",
    })
  );
  assert.equal(grouped.response.status, 200);
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(admin, "guardrail-shadow-tables-admin", {
      tableId: order.tableId,
      purpose: "edit",
    })
  );
  assert.equal(locked.response.status, 200);

  const state = await readJson(dbPath);
  const table = findTable(state, order.tableId);
  assert.equal(roundMoney(table.totalDue), roundMoney(order.dueAmount));
  assert.equal(table.workLock?.deviceUuid, "guardrail-shadow-tables-admin");
  await assertRelationalDomainsMatch(state, relationalPath, ["tablesBills"]);
});

test("shadow payments/tablesBills coerente dopo pagamento", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startShadowBackend(t, "guardrail-shadow-payment");
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-shadow-payment",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, session, "guardrail-shadow-payment");
  const paid = await apiPost(
    baseUrl,
    "/api/payments/table",
    authPayload(session, "guardrail-shadow-payment", {
      tableId: order.tableId,
      paymentMethodId: "pay_cash",
      cashGiven: 1.3,
      idempotencyKey: "guardrail-shadow-table-payment",
    })
  );
  assert.equal(paid.response.status, 200);

  await assertRelationalDomainsMatch(await readJson(dbPath), relationalPath, ["payments", "tablesBills"]);
});

test("shadow payments/tablesBills coerente dopo split", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startShadowBackend(t, "guardrail-shadow-split");
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-shadow-split",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, session, "guardrail-shadow-split");
  const split = await payFreeSplit(baseUrl, session, "guardrail-shadow-split", order, 0.5, {
    idempotencyKey: "guardrail-shadow-partial-split",
    releaseTable: false,
  });
  assert.equal(split.response.status, 200);

  await assertRelationalDomainsMatch(await readJson(dbPath), relationalPath, ["payments", "tablesBills"]);
});

test("shadow orders/tablesBills coerente dopo cancel e correct", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startShadowBackend(t, "guardrail-shadow-cancel-correct");
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "guardrail-shadow-cancel-correct",
    clientApp: "mobile-frontend",
  });

  const cancelled = await createSimpleOrder(baseUrl, session, {
    deviceUuid: "guardrail-shadow-cancel-correct",
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    tableNumber: 5,
  });
  assert.equal(cancelled.response.status, 200);
  await cancelOrder(baseUrl, session, "guardrail-shadow-cancel-correct", cancelled.body.order);

  const corrected = await createSimpleOrder(baseUrl, session, {
    deviceUuid: "guardrail-shadow-cancel-correct",
    tableId: "room_pedana_t06",
    roomId: "room_pedana",
    tableNumber: 6,
  });
  assert.equal(corrected.response.status, 200);
  await correctOrder(baseUrl, session, "guardrail-shadow-cancel-correct", corrected.body.order);

  await assertRelationalDomainsMatch(await readJson(dbPath), relationalPath, ["orders", "tablesBills"]);
});
