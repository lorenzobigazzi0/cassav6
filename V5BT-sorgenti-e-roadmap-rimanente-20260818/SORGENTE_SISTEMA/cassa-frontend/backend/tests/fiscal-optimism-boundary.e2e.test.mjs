import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  acquireTableLock,
  apiPost,
  authPayload,
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

async function startBoundaryBackend(t, prefix, extraEnv = {}) {
  const runDir = await createTempRunDir(prefix);
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      EVENT_OUTBOX_ENABLED: "1",
      SSE_EVENT_PAYLOAD: "1",
      POS_FISCAL_API_JOB_RETRY_DELAY_MS: "60000",
      POS_FISCAL_API_RECOVERY_RETRY_DELAY_MS: "60000",
      POS_FISCAL_API_TIMEOUT_MS: "100",
      ...extraEnv,
    },
  });
  return { ...backend, relationalPath };
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

async function createDeliveredOrder(baseUrl, session, deviceUuid, options = {}) {
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    tableId: options.tableId ?? "room_pedana_t05",
    tableNumber: options.tableNumber ?? 5,
    roomId: "room_pedana",
    lines: options.lines ?? [
      {
        name: "Caffe boundary",
        productId: "test_fiscal_boundary_caffe",
        qty: 1,
        price: 1.3,
      },
    ],
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
      workflowReason: "fiscal_boundary_fixture",
    }),
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
      workflowReason: "fiscal_boundary_fixture",
    }),
  );
  assert.equal(delivered.response.status, 200);
  assert.equal(delivered.body.order.workflowStatus, "delivered");
  const locked = await acquireTableLock(baseUrl, session, delivered.body.order.tableId, {
    deviceUuid,
    purpose: "payment",
  });
  assert.equal(locked.response.status, 200);
  return delivered.body.order;
}

function parseOutboxPayload(row) {
  return JSON.parse(String(row.payload_json ?? "{}"));
}

async function findPaymentStatusPayload(relationalPath, paymentId, source) {
  const rows = await readOutboxRows(relationalPath);
  const matches = rows
    .filter((row) => row.event_type === "payment.status")
    .filter((row) => String(row.aggregate_id ?? "") === String(paymentId))
    .map((row) => ({ row, payload: parseOutboxPayload(row) }))
    .filter(({ payload }) => !source || payload.detail?.source === source);
  assert.ok(matches.length > 0, `Nessun evento payment.status per ${paymentId}`);
  return matches.at(-1).payload;
}

function fiscalIssuedAudits(state, paymentId) {
  return (Array.isArray(state.auditEvents) ? state.auditEvents : []).filter(
    (entry) =>
      entry.action === "fiscal.issued" &&
      String(entry.payload?.paymentId ?? entry.entityId ?? "") === String(paymentId),
  );
}

test("[BE][P0] fiscal boundary: fiscale sincrono riuscito pubblica payment_completed dopo fiscal.issued", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startBoundaryBackend(
    t,
    "fiscal-boundary-sync-ok",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });
  await createDeliveredOrder(baseUrl, cashier, "pay-table-device");

  const paid = await apiPost(
    baseUrl,
    "/api/payments/table",
    authPayload(cashier, "pay-table-device", {
      tableId: "room_pedana_t05",
      paymentMethodId: "pay_cash",
      cashGiven: 1.3,
      idempotencyKey: "fiscal-boundary-sync-ok",
    }),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.fiscalPending, false);

  const paymentId = paid.body.payment.id;
  const persisted = await readJson(dbPath);
  assert.equal(fiscalIssuedAudits(persisted, paymentId).length, 1);

  const payload = await findPaymentStatusPayload(relationalPath, paymentId, "table_payment");
  assert.equal(payload.reason, "payment_completed");
  assert.equal(payload.detail.paymentStatus, "COMPLETED");
  assert.equal(payload.detail.fiscalPending, false);
});

test("[BE][P0] fiscal boundary: metodo non fiscale resta rapido e pubblica payment_completed", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startBoundaryBackend(
    t,
    "fiscal-boundary-non-fiscal",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });
  await createDeliveredOrder(baseUrl, cashier, "pay-table-device");

  const paid = await apiPost(
    baseUrl,
    "/api/payments/table",
    authPayload(cashier, "pay-table-device", {
      tableId: "room_pedana_t05",
      paymentMethodId: "pay_smart",
      idempotencyKey: "fiscal-boundary-non-fiscal",
    }),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.fiscalPending, false);

  const paymentId = paid.body.payment.id;
  const persisted = await readJson(dbPath);
  assert.equal(
    (Array.isArray(persisted.fiscalReceipts) ? persisted.fiscalReceipts : []).length,
    0,
  );

  const payload = await findPaymentStatusPayload(relationalPath, paymentId, "table_payment");
  assert.equal(payload.reason, "payment_completed");
  assert.equal(payload.detail.paymentStatus, "COMPLETED");
  assert.equal(payload.detail.fiscalPending, false);
});

test("[BE][P0] fiscal boundary: payments/table con RT pending non pubblica payment_completed", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startBoundaryBackend(
    t,
    "fiscal-boundary-table-pending",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });
  await createDeliveredOrder(baseUrl, cashier, "pay-table-device");

  const paid = await apiPost(
    baseUrl,
    "/api/payments/table",
    authPayload(cashier, "pay-table-device", {
      tableId: "room_pedana_t05",
      paymentMethodId: "pay_cash",
      cashGiven: 1.3,
      issueFiscal: true,
      fiscalDocType: "RECEIPT",
      idempotencyKey: "fiscal-boundary-table-pending",
    }),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.fiscalPending, true);
  assert.equal(paid.body.posFiscalReceipt?.fiscalStatus, "PENDING");

  const paymentId = paid.body.payment.id;
  const persisted = await readJson(dbPath);
  assert.equal(fiscalIssuedAudits(persisted, paymentId).length, 0);

  const payload = await findPaymentStatusPayload(relationalPath, paymentId, "table_payment");
  assert.equal(payload.reason, "payment_status_changed");
  assert.equal(payload.detail.paymentStatus, "PENDING_FISCAL");
  assert.equal(payload.detail.fiscalPending, true);
});

test("[BE][P0] fiscal boundary: payments/free-split con RT pending non pubblica payment_completed", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startBoundaryBackend(
    t,
    "fiscal-boundary-free-split-pending",
  );
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
      idempotencyKey: "fiscal-boundary-free-split-pending",
      clientPaymentId: "fiscal-boundary-free-split-pending",
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
              cashGiven: 1.3,
            },
          ],
        },
      ],
    }),
  );

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.fiscalPending, true);
  assert.equal(paid.body.posFiscalReceipts[0]?.fiscalStatus, "PENDING");

  const paymentId = paid.body.payment.id;
  const persisted = await readJson(dbPath);
  assert.equal(fiscalIssuedAudits(persisted, paymentId).length, 0);

  const payload = await findPaymentStatusPayload(relationalPath, paymentId, "free_split");
  assert.equal(payload.reason, "payment_status_changed");
  assert.equal(payload.detail.paymentStatus, "PENDING_FISCAL");
  assert.equal(payload.detail.economicPaymentStatus, "COMPLETED");
  assert.equal(payload.detail.fiscalPending, true);
});

test("[BE][P0] fiscal boundary: payments/ticket con RT pending non pubblica payment_completed", async (t) => {
  const { baseUrl, dbPath, relationalPath } = await startBoundaryBackend(
    t,
    "fiscal-boundary-ticket-pending",
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "pay-table-device",
    clientApp: "mobile-frontend",
  });

  const paid = await apiPost(
    baseUrl,
    "/api/payments/ticket",
    authPayload(cashier, "pay-table-device", {
      paymentMethodId: "pay_cash",
      cashGiven: 1.3,
      issueFiscal: true,
      fiscalDocType: "RECEIPT",
      idempotencyKey: "fiscal-boundary-ticket-pending",
      lines: [
        {
          name: "Caffe boundary banco",
          qty: 1,
          unitPrice: 1.3,
          unitPriceApplied: 1.3,
          lineTotal: 1.3,
        },
      ],
    }),
  );

  assert.equal(paid.response.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.fiscalPending, true);
  assert.equal(paid.body.posFiscalReceipt?.fiscalStatus, "PENDING");

  const paymentId = paid.body.payment.id;
  const persisted = await readJson(dbPath);
  assert.equal(fiscalIssuedAudits(persisted, paymentId).length, 0);

  const payload = await findPaymentStatusPayload(relationalPath, paymentId, "ticket_payment");
  assert.equal(payload.reason, "payment_status_changed");
  assert.equal(payload.detail.paymentStatus, "PENDING_FISCAL");
  assert.equal(payload.detail.fiscalPending, true);
});
