import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildPaymentsReportReadDb,
  closeRelationalConnection,
  openRelationalConnection,
  runRelationalMigrations,
  syncPaymentsFromAppState,
} from "../db/relational/index.js";
import {
  apiPost,
  authPayload,
  buildTestState,
  createTempRunDir,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

function nowIso() {
  return "2026-05-13T16:00:00.000Z";
}

function seedPaymentsReportState(state = buildTestState()) {
  state.meta.lastWriteAt = "2026-05-13T16:10:00.000Z";
  state.payments = [
    {
      id: "pay_k1_report",
      tableId: "room_pedana_t05",
      tableNumber: 5,
      tableLabel: "Tavolo 5",
      roomId: "room_pedana",
      orderId: "order_k1",
      orderIds: ["order_k1"],
      billId: "bill_k1",
      billIds: ["bill_k1"],
      amount: 10,
      methodId: "pay_card",
      methodLabel: "Carta",
      fiscal: true,
      source: "table_payment",
      createdAt: "2026-05-13T16:01:00.000Z",
      createdByUserId: "u_admin",
      createdByUsername: "admin_test",
      paymentContainerId: "pay_k1_report",
      paymentPartId: "part_k1_report",
      paymentTxId: "tx_k1_report",
      items: [
        {
          name: "K1 Prosecco",
          qty: 1,
          unitPrice: 10,
          unitPriceApplied: 10,
          lineTotal: 10,
        },
      ],
    },
  ];
  state.paymentContainers = [
    {
      id: "pay_k1_report",
      tableId: "room_pedana_t05",
      tableNumber: 5,
      tableLabel: "Tavolo 5",
      orderId: "order_k1",
      orderIds: ["order_k1"],
      billId: "bill_k1",
      billIds: ["bill_k1"],
      roomId: "room_pedana",
      paymentMethod: "pay_card",
      amount: 10,
      status: "COMPLETED",
      splitType: "SINGLE",
      idempotencyKey: "idem-k1-report",
      clientPaymentId: "client-k1-report",
      createdByUserId: "u_admin",
      createdByUsername: "admin_test",
      collectedByUserId: "u_admin",
      collectedByUsername: "admin_test",
      createdAt: "2026-05-13T16:00:00.000Z",
      updatedAt: "2026-05-13T16:02:00.000Z",
    },
  ];
  state.paymentParts = [
    {
      id: "part_k1_report",
      paymentId: "pay_k1_report",
      partNo: 1,
      amountDue: 10,
      status: "PAID",
    },
  ];
  state.paymentTransactions = [
    {
      id: "tx_k1_report",
      partId: "part_k1_report",
      createdByUserId: "u_admin",
      createdByUsername: "app_state_cashier",
      createdAt: "2026-05-13T16:01:30.000Z",
      method: "POS",
      amountPaid: 10,
    },
  ];
  state.paymentProviderTransactions = [];
  state.fiscalReceipts = [
    {
      id: "fiscal_k1_report",
      paymentId: "tx_k1_report",
      command: "print_receipt",
      status: "ok",
      responseCode: "RT_OK",
      responseMessage: "Operazione completata.",
      fiscalStatus: "ISSUED",
      fiscalProvider: "mock",
      fiscalProviderRef: "RT-K1-001",
      createdAt: "2026-05-13T16:02:30.000Z",
    },
  ];
  return state;
}

async function openMigratedDb(dbPath) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath,
  });
  await runRelationalMigrations(db, { nowIso });
  return db;
}

async function tamperRelationalPaymentTransaction(relationalPath) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    const row = db.prepare("SELECT raw_json FROM payment_transactions WHERE id = ?").get("tx_k1_report");
    const raw = JSON.parse(row.raw_json);
    raw.createdByUsername = "relational_cashier";
    raw.amountPaid = 12;
    db.prepare("UPDATE payment_transactions SET amount_cents = ?, raw_json = ? WHERE id = ?").run(
      1200,
      JSON.stringify(raw),
      "tx_k1_report"
    );
  } finally {
    closeRelationalConnection(db);
  }
}

async function insertRelationalOnlyPayment(relationalPath) {
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: relationalPath,
  });
  try {
    db.prepare(
      `
        INSERT INTO payment_containers (
          id,
          table_id,
          bill_id,
          order_id,
          status,
          total_cents,
          paid_cents,
          due_cents,
          created_at,
          updated_at,
          raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      "pay_k1_rel_only",
      "room_pedana_t05",
      "bill_k1_rel_only",
      "order_k1_rel_only",
      "completed",
      800,
      800,
      0,
      "2026-05-13T16:05:00.000Z",
      "2026-05-13T16:05:30.000Z",
      JSON.stringify({
        id: "pay_k1_rel_only",
        tableId: "room_pedana_t05",
        tableNumber: 5,
        tableLabel: "Tavolo 5",
        roomId: "room_pedana",
        orderId: "order_k1_rel_only",
        orderIds: ["order_k1_rel_only"],
        billId: "bill_k1_rel_only",
        billIds: ["bill_k1_rel_only"],
        paymentMethod: "pay_card",
        amount: 8,
        status: "COMPLETED",
        createdByUserId: "u_admin",
        createdByUsername: "admin_test",
        collectedByUserId: "u_admin",
        collectedByUsername: "admin_test",
        createdAt: "2026-05-13T16:05:00.000Z",
      })
    );
    db.prepare(
      `
        INSERT INTO payment_parts (
          id,
          container_id,
          method_id,
          method_type,
          amount_cents,
          fiscal_status,
          created_at,
          raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      "part_k1_rel_only",
      "pay_k1_rel_only",
      "pay_card",
      "POS",
      800,
      null,
      "2026-05-13T16:05:10.000Z",
      JSON.stringify({
        id: "part_k1_rel_only",
        paymentId: "pay_k1_rel_only",
        partNo: 1,
        amountDue: 8,
        status: "PAID",
      })
    );
    db.prepare(
      `
        INSERT INTO payment_transactions (
          id,
          container_id,
          idempotency_key,
          table_id,
          bill_id,
          order_id,
          amount_cents,
          status,
          created_at,
          updated_at,
          raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      "tx_k1_rel_only",
      "pay_k1_rel_only",
      "idem-k1-rel-only",
      "room_pedana_t05",
      "bill_k1_rel_only",
      "order_k1_rel_only",
      800,
      "settled",
      "2026-05-13T16:05:20.000Z",
      "2026-05-13T16:05:20.000Z",
      JSON.stringify({
        id: "tx_k1_rel_only",
        partId: "part_k1_rel_only",
        createdByUserId: "u_admin",
        createdByUsername: "admin_test",
        createdAt: "2026-05-13T16:05:20.000Z",
        method: "POS",
        amountPaid: 8,
      })
    );
  } finally {
    closeRelationalConnection(db);
  }
}

async function startPaymentsReportsBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "rel-payments-reports-read");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    stateOverrides: seedPaymentsReportState,
    env: {
      BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS: "1",
      ...(options.relational === false
        ? {}
        : {
            BACKEND_RELATIONAL_ENABLED: "1",
            BACKEND_RELATIONAL_MODE: "shadow",
            BACKEND_RELATIONAL_DB_PATH: relationalPath,
          }),
    },
  });
  return { ...server, relationalPath, runDir };
}

test("K1 read-model payments/fiscal ricostruisce lo stesso campione app-state dopo sync", async () => {
  const runDir = await createTempRunDir("rel-payments-reports-model");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  const state = seedPaymentsReportState();
  try {
    syncPaymentsFromAppState(db, state, { nowIso });
    const readDb = buildPaymentsReportReadDb(state, db);
    assert.deepEqual(readDb.paymentContainers, state.paymentContainers);
    assert.deepEqual(readDb.paymentParts, state.paymentParts);
    assert.deepEqual(readDb.paymentTransactions, state.paymentTransactions);
    assert.deepEqual(readDb.paymentProviderTransactions, state.paymentProviderTransactions);
    assert.deepEqual(readDb.fiscalReceipts, state.fiscalReceipts);
  } finally {
    closeRelationalConnection(db);
  }
});

test("K1 reports sales usa payment_transactions relazionale quando il flag e attivo", async (t) => {
  const { baseUrl, relationalPath } = await startPaymentsReportsBackend(t);
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "k1-report-admin",
    clientApp: "cassa-frontend",
  });
  await tamperRelationalPaymentTransaction(relationalPath);

  const report = await apiPost(
    baseUrl,
    "/api/reports/sales",
    authPayload(session, "k1-report-admin")
  );

  assert.equal(report.response.status, 200);
  assert.equal(report.body.report.paymentsTracking.transactions[0].createdByUsername, "relational_cashier");
  const collector = report.body.report.staff.incassiPerUtente.find(
    (entry) => entry.username === "relational_cashier"
  );
  assert.equal(collector.totalCollected, 12);
});

test("K1 reports sales torna ad app-state se il relazionale non e disponibile", async (t) => {
  const { baseUrl } = await startPaymentsReportsBackend(t, {
    prefix: "rel-payments-reports-fallback",
    relational: false,
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "k1-report-fallback-admin",
    clientApp: "cassa-frontend",
  });

  const report = await apiPost(
    baseUrl,
    "/api/reports/sales",
    authPayload(session, "k1-report-fallback-admin")
  );

  assert.equal(report.response.status, 200);
  assert.equal(report.body.report.paymentsTracking.transactions[0].createdByUsername, "app_state_cashier");
  const collector = report.body.report.staff.incassiPerUtente.find(
    (entry) => entry.username === "app_state_cashier"
  );
  assert.equal(collector.totalCollected, 10);
});

test("K1 ristampa movimento puo leggere un pagamento presente solo nel relazionale", async (t) => {
  const { baseUrl, relationalPath } = await startPaymentsReportsBackend(t, {
    prefix: "rel-payments-reprint-read",
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "k1-reprint-admin",
    clientApp: "cassa-frontend",
  });
  await insertRelationalOnlyPayment(relationalPath);

  const reprint = await apiPost(
    baseUrl,
    "/api/reports/payment-movement/reprint",
    authPayload(session, "k1-reprint-admin", {
      movementId: "pay_k1_rel_only",
    })
  );

  assert.equal(reprint.response.status, 200);
  assert.equal(reprint.body.ok, true);
  assert.equal(reprint.body.movementType, "payment");
  assert.equal(reprint.body.printJobs.length, 1);
  assert.equal(reprint.body.printJobs[0].status, "disabled");
});
