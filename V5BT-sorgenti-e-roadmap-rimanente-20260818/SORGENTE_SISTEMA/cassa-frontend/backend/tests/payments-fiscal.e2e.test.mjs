import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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
import {
  COMMERCIAL_BENEFIT_KINDS,
  createCommercialBenefitCampaign,
} from "../modules/commercial-benefits/index.js";

async function createDeliveredOrder(baseUrl, session, deviceUuid) {
  const lock = await acquireTableLock(baseUrl, session, "room_pedana_t05", {
    deviceUuid,
    purpose: "payment_fixture",
  });
  assert.equal(lock.response.status, 200);
  const created = await createSimpleOrder(baseUrl, session, { deviceUuid });
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
      workflowReason: "payment_fixture",
    })
  );
  assert.equal(ready.response.status, 200);
  const delivered = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: ready.body.order.id,
      order: {
        ...ready.body.order,
        workflowStatus: "delivered",
        items: ready.body.order.items.map((item) => ({ ...item, done: true })),
      },
      workflowReason: "payment_fixture",
    })
  );
  assert.equal(delivered.response.status, 200);
  assert.equal(delivered.body.order.workflowStatus, "delivered");
  return delivered.body.order;
}

async function startIdempotencyStoreBackend(t, prefix = "payment-idempotency-store", extraEnv = {}) {
  const runDir = await createTempRunDir(prefix);
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      IDEMPOTENCY_STORE_ENABLED: "1",
      ...extraEnv,
    },
  });
  return { ...backend, relationalPath };
}

async function readIdempotencyRow(relationalPath, key) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM idempotency_keys WHERE idempotency_key = ?")
      .get(key);
  } finally {
    db.close();
  }
}

async function readOutboxRows(relationalPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM event_outbox ORDER BY id ASC").all();
  } finally {
    db.close();
  }
}

async function readSseEvent(response, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const readResult = await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout SSE")), remainingMs),
      ),
    ]);
    if (readResult.done) break;
    buffer += decoder.decode(readResult.value, { stream: true });
    const parts = buffer.split(/\n\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = { event: "message", data: "" };
      for (const line of part.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event.event = line.slice("event:".length).trim();
        if (line.startsWith("data:")) event.data += line.slice("data:".length).trim();
      }
      if (predicate(event)) return event;
    }
  }
  throw new Error("Evento SSE atteso non ricevuto");
}

async function collectSseEvents(response, predicate, controller, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const settleMs = options.settleMs ?? 750;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const matches = [];
  let buffer = "";
  let settleTimer = null;
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    while (true) {
      const readResult = await reader.read();
      if (readResult.done) break;
      buffer += decoder.decode(readResult.value, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const event = { id: null, event: "message", data: "" };
        for (const line of part.split(/\r?\n/)) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("id:")) event.id = line.slice("id:".length).trim();
          if (line.startsWith("event:")) event.event = line.slice("event:".length).trim();
          if (line.startsWith("data:")) event.data += line.slice("data:".length).trim();
        }
        if (!predicate(event)) continue;
        matches.push(event);
        if (!settleTimer) settleTimer = setTimeout(() => controller.abort(), settleMs);
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timeoutTimer);
    if (settleTimer) clearTimeout(settleTimer);
  }

  if (matches.length === 0) {
    throw new Error(timedOut ? "Timeout SSE" : "Evento SSE atteso non ricevuto");
  }
  return matches;
}

test("[BE][P0] pagamento tavolo completo contanti chiude dovuto e ordine", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "pay-table-device");

  const paid = await apiPost(
    baseUrl,
    "/api/payments/table",
    authPayload(cashier, "pay-table-device", {
      tableId: "room_pedana_t05",
      paymentMethodId: "pay_cash",
      cashGiven: 1.3,
      idempotencyKey: "pay-table-00001",
    })
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);
  assert.equal(paid.body.paymentContainer?.amount ?? paid.body.payment?.amount, 1.3);

  const persisted = await readJson(dbPath);
  const persistedOrder = persisted.integration.orders.find((entry) => entry.id === order.id);
  const table = persisted.posSettings.tables.find((entry) => entry.id === "room_pedana_t05");
  assert.equal(persistedOrder.paymentStatus, "paid");
  assert.equal(persistedOrder.dueAmount, 0);
  assert.equal(table.totalDue, 0);
  assert.equal(table.pendingBills.length, 0);
  assert.equal(persisted.paymentContainers.length, 1);
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "payment.completed"));
});

test("[BE][P0] idempotency store pagamento tavolo riproduce risposta e non duplica", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startIdempotencyStoreBackend(
    t,
    "payment-idempotency-store-table-replay",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });
  await createDeliveredOrder(baseUrl, cashier, "pay-table-device");

  const payload = authPayload(cashier, "pay-table-device", {
    tableId: "room_pedana_t05",
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    idempotencyKey: "pay-table-store-once",
  });

  const first = await apiPost(baseUrl, "/api/payments/table", payload);
  assert.equal(first.response.status, 200);
  const second = await apiPost(baseUrl, "/api/payments/table", payload);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.idempotencyStore, true);
  assert.equal(second.body.payment.id, first.body.payment.id);

  const persisted = await readJson(dbPath);
  const containers = persisted.paymentContainers.filter((entry) => entry.idempotencyKey === "pay-table-store-once");
  assert.equal(containers.length, 1);

  const row = await readIdempotencyRow(relationalPath, "pay-table-store-once");
  assert.equal(row.scope, "payment.table");
  assert.equal(row.status, "completed");
  assert.equal(JSON.parse(row.response_json).payment.id, first.body.payment.id);
});

test("[BE][P0] event outbox pagamento tavolo conserva e pubblica payment.status su SSE", async (t) => {
  const { baseUrl, relationalPath } = await startIdempotencyStoreBackend(
    t,
    "payment-event-outbox-table-sse",
    {
      EVENT_OUTBOX_ENABLED: "1",
      SSE_EVENT_PAYLOAD: "1",
    },
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-outbox-device",
    clientApp: "mobile-frontend",
  });
  await createDeliveredOrder(baseUrl, cashier, "pay-table-outbox-device");

  const streamController = new AbortController();
  t.after(() => streamController.abort());
  const streamResponse = await fetch(
    `${baseUrl}/api/integration/notifications/stream?consumer=payment-outbox&clientApp=mobile-frontend&userId=${cashier.user.id}&username=${cashier.user.username}&deviceUuid=pay-table-outbox-device`,
    { signal: streamController.signal },
  );
  assert.equal(streamResponse.status, 200);
  const deliveredPaymentEventsPromise = collectSseEvents(
    streamResponse,
    (candidate) => {
      if (candidate.event !== "payload") return false;
      const parsed = JSON.parse(candidate.data || "{}");
      return parsed.type === "payment.status";
    },
    streamController,
    { timeoutMs: 8_000, settleMs: 750 },
  );

  const paid = await apiPost(
    baseUrl,
    "/api/payments/table",
    authPayload(cashier, "pay-table-outbox-device", {
      tableId: "room_pedana_t05",
      paymentMethodId: "pay_cash",
      cashGiven: 1.3,
      idempotencyKey: "pay-table-outbox-once",
    }),
  );
  assert.equal(paid.response.status, 200);

  const deliveredPaymentEvents = (await deliveredPaymentEventsPromise).filter(
    (event) => JSON.parse(event.data || "{}").payload?.detail?.paymentId === paid.body.payment.id,
  );
  assert.equal(
    deliveredPaymentEvents.length,
    1,
    "un pagamento deve produrre una sola consegna SSE anche dopo il polling outbox",
  );

  const rowsAfterDelivery = await readOutboxRows(relationalPath);
  const paymentRows = rowsAfterDelivery.filter(
    (entry) =>
      entry.event_type === "payment.status" &&
      entry.aggregate_id === paid.body.payment.id,
  );
  assert.equal(paymentRows.length, 1, "un pagamento deve creare una sola riga event_outbox");
  const [paymentRow] = paymentRows;
  assert.ok(paymentRow);
  assert.equal(paymentRow.aggregate_type, "payment");
  assert.ok(paymentRow.published_at);
  const queuedPayload = JSON.parse(paymentRow.payload_json);
  assert.equal(queuedPayload.detail.paymentId, paid.body.payment.id);
  assert.equal(queuedPayload.detail.source, "table_payment");
  const [event] = deliveredPaymentEvents;
  const parsed = JSON.parse(event.data);
  const payload =
    parsed.payload && typeof parsed.payload === "object" ? parsed.payload : parsed;
  assert.equal(Number(event.id), paymentRow.id);
  assert.equal(parsed.eventId, paymentRow.id);
  assert.equal(payload.reason, "payment_completed");
  assert.equal(payload.detail.tableId, "room_pedana_t05");
});

test("[BE][P0] idempotency store pagamento tavolo blocca stessa key con payload diverso", async (t) => {
  const { baseUrl, dbPath } = await startIdempotencyStoreBackend(
    t,
    "payment-idempotency-store-table-conflict",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });
  await createDeliveredOrder(baseUrl, cashier, "pay-table-device");

  const payload = authPayload(cashier, "pay-table-device", {
    tableId: "room_pedana_t05",
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    idempotencyKey: "pay-table-store-conflict",
  });

  const first = await apiPost(baseUrl, "/api/payments/table", payload);
  assert.equal(first.response.status, 200);
  const conflict = await apiPost(baseUrl, "/api/payments/table", {
    ...payload,
    cashGiven: 1.2,
  });

  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_CONFLICT");

  const persisted = await readJson(dbPath);
  const containers = persisted.paymentContainers.filter((entry) => entry.idempotencyKey === "pay-table-store-conflict");
  assert.equal(containers.length, 1);
});

test("[BE][P0] overpayment free split viene rifiutato senza mutare stato", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-over-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "pay-over-device");

  const overpaid = await apiPost(
    baseUrl,
    "/api/payments/free-split",
    authPayload(cashier, "pay-over-device", {
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      orderId: order.id,
      splitType: "FREE_SPLIT",
      parts: [
        {
          amountDue: 2.3,
          transactions: [{ method: "CASH", amountPaid: 2.3, cashGiven: 2.3 }],
        },
      ],
    })
  );

  assert.equal(overpaid.response.status, 409);
  assert.equal(overpaid.body.code, "PAYMENT_OVERPAYMENT");

  const persisted = await readJson(dbPath);
  const persistedOrder = persisted.integration.orders.find((entry) => entry.id === order.id);
  assert.equal(persistedOrder.paymentStatus, "unpaid");
  assert.equal(persistedOrder.dueAmount, 1.3);
  assert.equal(persisted.paymentContainers.length, 0);
});

test("[BE][P0] idempotency pagamento free split evita duplicati", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-idem-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "pay-idem-device");

  const payload = authPayload(cashier, "pay-idem-device", {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    orderId: order.id,
    splitType: "FREE_SPLIT",
    idempotencyKey: "pay-free-split-once",
    parts: [
      {
        amountDue: 1.3,
        transactions: [{ method: "CASH", amountPaid: 1.3, cashGiven: 1.3 }],
      },
    ],
  });

  const first = await apiPost(baseUrl, "/api/payments/free-split", payload);
  assert.equal(first.response.status, 200);
  const second = await apiPost(baseUrl, "/api/payments/free-split", payload);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.payment.id, first.body.payment.id);

  const persisted = await readJson(dbPath);
  const containers = persisted.paymentContainers.filter((entry) => entry.idempotencyKey === "pay-free-split-once");
  assert.equal(containers.length, 1);
  assert.equal(persisted.paymentTransactions.length, 1);
});

test("[BE][P0] idempotency store free split completa e riproduce la risposta", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startIdempotencyStoreBackend(
    t,
    "payment-idempotency-store-replay",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-idem-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "pay-idem-device");

  const payload = authPayload(cashier, "pay-idem-device", {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    orderId: order.id,
    splitType: "FREE_SPLIT",
    idempotencyKey: "pay-free-split-store-once",
    parts: [
      {
        amountDue: 1.3,
        transactions: [{ method: "CASH", amountPaid: 1.3, cashGiven: 1.3 }],
      },
    ],
  });

  const first = await apiPost(baseUrl, "/api/payments/free-split", payload);
  assert.equal(first.response.status, 200);
  const second = await apiPost(baseUrl, "/api/payments/free-split", payload);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.idempotencyStore, true);
  assert.equal(second.body.payment.id, first.body.payment.id);

  const persisted = await readJson(dbPath);
  const containers = persisted.paymentContainers.filter(
    (entry) => entry.idempotencyKey === "pay-free-split-store-once",
  );
  assert.equal(containers.length, 1);

  const row = await readIdempotencyRow(relationalPath, "pay-free-split-store-once");
  assert.equal(row.scope, "payment.free_split");
  assert.equal(row.status, "completed");
  assert.equal(JSON.parse(row.response_json).payment.id, first.body.payment.id);
});

test("[BE][P0] idempotency store free split blocca stessa key con payload diverso", async (t) => {
  const { baseUrl, dbPath } = await startIdempotencyStoreBackend(
    t,
    "payment-idempotency-store-conflict",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-idem-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "pay-idem-device");

  const payload = authPayload(cashier, "pay-idem-device", {
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    orderId: order.id,
    splitType: "FREE_SPLIT",
    idempotencyKey: "pay-free-split-store-conflict",
    parts: [
      {
        amountDue: 1.3,
        transactions: [{ method: "CASH", amountPaid: 1.3, cashGiven: 1.3 }],
      },
    ],
  });

  const first = await apiPost(baseUrl, "/api/payments/free-split", payload);
  assert.equal(first.response.status, 200);
  const conflict = await apiPost(baseUrl, "/api/payments/free-split", {
    ...payload,
    parts: [
      {
        amountDue: 1.2,
        transactions: [{ method: "CASH", amountPaid: 1.2, cashGiven: 1.2 }],
      },
    ],
  });

  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_CONFLICT");

  const persisted = await readJson(dbPath);
  const containers = persisted.paymentContainers.filter(
    (entry) => entry.idempotencyKey === "pay-free-split-store-conflict",
  );
  assert.equal(containers.length, 1);
});

test("[BE][P0] idempotency store ticket banco riproduce risposta e non duplica", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startIdempotencyStoreBackend(
    t,
    "payment-idempotency-store-ticket-replay",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-ticket-device",
    clientApp: "mobile-frontend",
  });
  const payload = authPayload(cashier, "pay-ticket-device", {
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    idempotencyKey: "pay-ticket-store-once",
    lines: [
      {
        name: "Caffe",
        qty: 1,
        unitPrice: 1.3,
        unitPriceApplied: 1.3,
        lineTotal: 1.3,
      },
    ],
  });

  const first = await apiPost(baseUrl, "/api/payments/ticket", payload);
  assert.equal(first.response.status, 200);
  const second = await apiPost(baseUrl, "/api/payments/ticket", payload);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.idempotencyStore, true);
  assert.equal(second.body.payment.id, first.body.payment.id);

  const persisted = await readJson(dbPath);
  const containers = persisted.paymentContainers.filter((entry) => entry.idempotencyKey === "pay-ticket-store-once");
  assert.equal(containers.length, 1);

  const row = await readIdempotencyRow(relationalPath, "pay-ticket-store-once");
  assert.equal(row.scope, "payment.ticket");
  assert.equal(row.status, "completed");
  assert.equal(JSON.parse(row.response_json).payment.id, first.body.payment.id);
});

test("[BE][P0] idempotency store ticket banco blocca stessa key con payload diverso", async (t) => {
  const { baseUrl, dbPath } = await startIdempotencyStoreBackend(
    t,
    "payment-idempotency-store-ticket-conflict",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-ticket-device",
    clientApp: "mobile-frontend",
  });
  const payload = authPayload(cashier, "pay-ticket-device", {
    paymentMethodId: "pay_cash",
    cashGiven: 1.3,
    idempotencyKey: "pay-ticket-store-conflict",
    lines: [
      {
        name: "Caffe",
        qty: 1,
        unitPrice: 1.3,
        unitPriceApplied: 1.3,
        lineTotal: 1.3,
      },
    ],
  });

  const first = await apiPost(baseUrl, "/api/payments/ticket", payload);
  assert.equal(first.response.status, 200);
  const conflict = await apiPost(baseUrl, "/api/payments/ticket", {
    ...payload,
    amount: 1.2,
    cashGiven: 1.2,
    lines: [
      {
        name: "Caffe",
        qty: 1,
        unitPrice: 1.2,
        unitPriceApplied: 1.2,
        lineTotal: 1.2,
      },
    ],
  });

  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_CONFLICT");

  const persisted = await readJson(dbPath);
  const containers = persisted.paymentContainers.filter((entry) => entry.idempotencyKey === "pay-ticket-store-conflict");
  assert.equal(containers.length, 1);
});


test("[BE][P0] payload mobile FrontendV2 free-split chiude ordine e registra pagamento", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-mobile-v2-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "pay-mobile-v2-device");

  const paid = await apiPost(
    baseUrl,
    "/api/payments/free-split",
    authPayload(cashier, "pay-mobile-v2-device", {
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      orderId: order.id,
      splitType: "FREE_SPLIT",
      splitMode: "amount",
      amount: 1.3,
      idempotencyKey: "pay-mobile-v2-free-split",
      clientPaymentId: "pay-mobile-v2-free-split",
      releaseTable: true,
      paymentMethod: "cash",
      receiptType: "scontrino",
      issueFiscal: true,
      fiscalDocType: "RECEIPT",
      parts: [
        {
          amountDue: 1.3,
          transactions: [
            {
              method: "CASH",
              methodId: "pay_cash",
              methodLabel: "Contanti",
              amountPaid: 1.3,
              cashGiven: 2,
              note: "quota mobile",
            },
          ],
        },
      ],
    })
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);

  const persisted = await readJson(dbPath);
  const persistedOrder = persisted.integration.orders.find((entry) => entry.id === order.id);
  const payment = persisted.paymentContainers.find(
    (entry) => entry.idempotencyKey === "pay-mobile-v2-free-split"
  );
  const paymentPart = persisted.paymentParts.find((entry) => entry.paymentId === payment?.id);
  const transaction = persisted.paymentTransactions.find((entry) => entry.partId === paymentPart?.id);
  assert.equal(persistedOrder.paymentStatus, "paid");
  assert.equal(persistedOrder.dueAmount, 0);
  assert.equal(payment.amount, 1.3);
  assert.equal(payment.splitMode, "amount");
  assert.equal(payment.fiscalDocType, "RECEIPT");
  assert.equal(transaction.method, "CASH");
});

test("[BE][P0] free-split chiude ordine con beneficio commerciale al 100% senza incasso", async (t) => {
  const benefitResult = createCommercialBenefitCampaign(
    {
      title: "Sconto 100% Test",
      benefitKind: COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT,
      percentageBps: 10000,
      maxDiscountCents: 0,
      codes: ["SCON-TO10-0000"],
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2099-12-31T23:59:59.000Z",
    },
    {
      now: "2026-06-29T10:00:00.000Z",
      idFactory(prefix) {
        return `${prefix}_full_discount`;
      },
    }
  );
  assert.equal(benefitResult.ok, true);

  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.commercialBenefitCampaigns = [benefitResult.campaign];
      state.commercialBenefitCoupons = benefitResult.coupons;
      state.commercialBenefitApplications = [];
      state.commercialBenefitRedemptions = [];
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-benefit-only-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "pay-benefit-only-device");

  const validated = await apiPost(
    baseUrl,
    "/api/commercial-benefits/validate",
    authPayload(cashier, "pay-benefit-only-device", {
      source: "nfc",
      nfcToken: "SCON-TO10-0000",
      payableBeforeCents: 130,
      tableId: "room_pedana_t05",
      orderId: order.id,
      clientApplicationId: "cbapp_pay_benefit_only",
      readerSessionId: "reader_pay_benefit_only",
    })
  );
  assert.equal(validated.response.status, 200);
  assert.equal(validated.body.application.benefitAmountCents, 130);

  const paid = await apiPost(
    baseUrl,
    "/api/payments/free-split",
    authPayload(cashier, "pay-benefit-only-device", {
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      orderId: order.id,
      splitType: "FREE_SPLIT",
      splitMode: "amount",
      amount: 0,
      idempotencyKey: "pay-commercial-benefit-only",
      clientPaymentId: "pay-commercial-benefit-only",
      releaseTable: true,
      paymentMethod: "cash",
      receiptType: "scontrino",
      issueFiscal: false,
      commercialBenefitApplications: [
        {
          applicationId: validated.body.application.id,
          benefitAmountCents: validated.body.application.benefitAmountCents,
          benefitKind: validated.body.application.benefitKind,
        },
      ],
      parts: [
        {
          amountDue: 0,
          transactions: [],
        },
      ],
    })
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);

  const persisted = await readJson(dbPath);
  const persistedOrder = persisted.integration.orders.find((entry) => entry.id === order.id);
  const payment = persisted.paymentContainers.find(
    (entry) => entry.idempotencyKey === "pay-commercial-benefit-only"
  );
  assert.equal(persistedOrder.paymentStatus, "paid");
  assert.equal(persistedOrder.dueAmount, 0);
  assert.equal(payment.amount, 0);
  assert.equal(payment.status, "COMPLETED");
  assert.equal(payment.commercialBenefitAmountCents, 130);
  assert.deepEqual(payment.commercialBenefitApplicationIds, [validated.body.application.id]);
  assert.equal(persisted.paymentTransactions.length, 0);
  assert.equal(persisted.commercialBenefitApplications[0].status, "redeemed");
  assert.equal(persisted.commercialBenefitRedemptions.length, 1);
});

test("[BE][P0] Banco chiude ordine con beneficio commerciale al 100% senza incasso", async (t) => {
  const benefitResult = createCommercialBenefitCampaign(
    {
      title: "Sconto 100% Banco Test",
      benefitKind: COMMERCIAL_BENEFIT_KINDS.PERCENTAGE_DISCOUNT,
      percentageBps: 10000,
      maxDiscountCents: 0,
      codes: ["SCON-TO10-0000"],
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2099-12-31T23:59:59.000Z",
    },
    {
      now: "2026-06-29T10:00:00.000Z",
      idFactory(prefix) {
        return `${prefix}_counter_full_discount`;
      },
    }
  );
  assert.equal(benefitResult.ok, true);

  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.commercialBenefitCampaigns = [benefitResult.campaign];
      state.commercialBenefitCoupons = benefitResult.coupons;
      state.commercialBenefitApplications = [];
      state.commercialBenefitRedemptions = [];
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "counter-benefit-only-device",
    clientApp: "mobile-frontend",
  });

  const validated = await apiPost(
    baseUrl,
    "/api/commercial-benefits/validate",
    authPayload(cashier, "counter-benefit-only-device", {
      source: "nfc",
      nfcToken: "SCON-TO10-0000",
      payableBeforeCents: 130,
      tableId: "counter:banco",
      orderId: "counter_order_benefit_only",
      clientApplicationId: "cbapp_counter_benefit_only",
      readerSessionId: "reader_counter_benefit_only",
    })
  );
  assert.equal(validated.response.status, 200);
  assert.equal(validated.body.application.benefitAmountCents, 130);

  const collected = await apiPost(
    baseUrl,
    "/api/tables/counter/orders/collect",
    authPayload(cashier, "counter-benefit-only-device", {
      context: "counter",
      roomId: "room_pedana",
      tableId: "counter:banco",
      tableLabel: "Banco",
      idempotencyKey: "counter-commercial-benefit-only",
      clientPaymentId: "counter-commercial-benefit-only",
      operator: {
        userId: cashier.user.id,
        username: cashier.user.username,
        fullName: cashier.user.fullName,
        label: "Cashier Test",
      },
      order: {
        id: "counter_order_benefit_only",
        title: "Ordine Banco",
        createdAt: Date.now(),
        totalCents: 130,
        lines: [
          {
            lineId: "counter_line_1",
            name: "Caffe",
            qty: 1,
            unitFinalPrice: 1.3,
            vatRate: 10,
            vatCode: "10",
          },
        ],
      },
      payment: {
        amountCents: 0,
        method: "cash",
        splitMode: "single",
        receiptType: "scontrino",
      },
      commercialBenefitApplications: [
        {
          applicationId: validated.body.application.id,
          benefitAmountCents: validated.body.application.benefitAmountCents,
          benefitKind: validated.body.application.benefitKind,
        },
      ],
    })
  );

  assert.equal(collected.response.status, 200);
  assert.equal(collected.body.ok, true);

  const persisted = await readJson(dbPath);
  const payment = persisted.paymentContainers.find(
    (entry) => entry.idempotencyKey === "counter-commercial-benefit-only"
  );
  assert.equal(payment.amount, 0);
  assert.equal(payment.status, "COMPLETED");
  assert.equal(payment.commercialBenefitAmountCents, 130);
  assert.equal(persisted.paymentTransactions.length, 0);
  assert.equal(persisted.commercialBenefitApplications[0].status, "redeemed");
  assert.equal(persisted.commercialBenefitRedemptions.length, 1);
});

test("[BE][P0] payload mobile FrontendV2 free-split non fiscalizza palmare non configurato", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-mobile-v2-unconfigured-device",
    clientApp: "mobile-frontend",
  });
  const order = await createDeliveredOrder(baseUrl, cashier, "pay-mobile-v2-unconfigured-device");

  const paid = await apiPost(
    baseUrl,
    "/api/payments/free-split",
    authPayload(cashier, "pay-mobile-v2-unconfigured-device", {
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      orderId: order.id,
      splitType: "FREE_SPLIT",
      splitMode: "amount",
      amount: 1.3,
      idempotencyKey: "pay-mobile-v2-free-split-no-fiscal-device",
      clientPaymentId: "pay-mobile-v2-free-split-no-fiscal-device",
      releaseTable: true,
      paymentMethod: "cash",
      receiptType: "scontrino",
      issueFiscal: true,
      fiscalDocType: "RECEIPT",
      parts: [
        {
          amountDue: 1.3,
          transactions: [
            {
              method: "CASH",
              methodId: "pay_cash",
              methodLabel: "Contanti",
              amountPaid: 1.3,
              cashGiven: 2,
              note: "quota mobile senza fiscalita palmare",
            },
          ],
        },
      ],
    })
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);

  const persisted = await readJson(dbPath);
  const payment = persisted.paymentContainers.find(
    (entry) => entry.idempotencyKey === "pay-mobile-v2-free-split-no-fiscal-device"
  );
  const paymentPart = persisted.paymentParts.find((entry) => entry.paymentId === payment?.id);
  const transaction = persisted.paymentTransactions.find((entry) => entry.partId === paymentPart?.id);
  assert.equal(payment.fiscalDocType, null);
  assert.equal(transaction.method, "CASH");
  assert.ok(
    persisted.fiscalEvents.some(
      (entry) =>
        entry.paymentId === transaction.id &&
        entry.result === "mobile_device_fiscal_disabled"
    )
  );
});

test("[BE][P0] payload mobile FrontendV2 fiscalizza palmare abilitato da impostazioni con deviceUuid distinto", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "settings-manager-device",
    clientApp: "settings-frontend",
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-mobile-v2-fiscal-device",
    clientApp: "mobile-frontend",
  });

  const savedDevices = await apiPost(
    baseUrl,
    "/api/settings/mobile-devices/save",
    authPayload(manager, "settings-manager-device", {
      mobileDevices: [
        {
          deviceId: "configured-pay-mobile-v2-fiscal-device",
          deviceUuid: "pay-mobile-v2-fiscal-device",
          deviceName: "Palmare fiscale test V3",
          fiscalEnabled: true,
          cashPaymentEnabled: true,
          electronicPaymentEnabled: false,
        },
      ],
    })
  );
  assert.equal(savedDevices.response.status, 200);

  const order = await createDeliveredOrder(baseUrl, cashier, "pay-mobile-v2-fiscal-device");
  const paid = await apiPost(
    baseUrl,
    "/api/payments/free-split",
    authPayload(cashier, "pay-mobile-v2-fiscal-device", {
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      orderId: order.id,
      splitType: "FREE_SPLIT",
      splitMode: "amount",
      amount: 1.3,
      idempotencyKey: "pay-mobile-v2-free-split-fiscal-enabled-distinct-uuid",
      clientPaymentId: "pay-mobile-v2-free-split-fiscal-enabled-distinct-uuid",
      releaseTable: true,
      paymentMethod: "cash",
      receiptType: "scontrino",
      issueFiscal: true,
      fiscalDocType: "RECEIPT",
      parts: [
        {
          amountDue: 1.3,
          transactions: [
            {
              method: "CASH",
              methodId: "pay_cash",
              methodLabel: "Contanti",
              amountPaid: 1.3,
              cashGiven: 2,
              note: "quota mobile fiscale V3",
            },
          ],
        },
      ],
    })
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.ok, true);

  const persisted = await readJson(dbPath);
  const payment = persisted.paymentContainers.find(
    (entry) => entry.idempotencyKey === "pay-mobile-v2-free-split-fiscal-enabled-distinct-uuid"
  );
  assert.equal(payment.fiscalDocType, "RECEIPT");
  assert.ok(payment.fiscalDocNo);
});

test("[BE][P1] fiscal command richiede permesso e usa provider mock in test", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const waiter = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "fiscal-waiter",
    clientApp: "cassa-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "fiscal-manager",
    clientApp: "cassa-frontend",
  });

  const denied = await apiPost(
    baseUrl,
    "/api/fiscal/command",
    authPayload(waiter, "fiscal-waiter", { command: "print_receipt" })
  );
  assert.equal(denied.response.status, 403);

  const issued = await apiPost(
    baseUrl,
    "/api/fiscal/command",
    authPayload(manager, "fiscal-manager", { command: "print_receipt" })
  );
  assert.equal(issued.response.status, 200);
  assert.equal(issued.body.ok, true);
  assert.equal(issued.body.middleware.ok, true);

  const persisted = await readJson(dbPath);
  assert.equal(persisted.fiscalEvents.length, 1);
  assert.equal(persisted.fiscalEvents[0].fiscalProvider, "mock");
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "fiscal.issued"));
});
