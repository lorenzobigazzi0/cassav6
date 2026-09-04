import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPaymentFreeSplitMirrorPayload,
  beginPaymentFreeSplitMirrorCapture,
  buildPaymentFreeSplitMirrorPayload,
} from "../modules/payments/payment-free-split-mirror-payload.js";

function state() {
  return {
    payments: [{ id: "pay_old", amount: 1 }],
    paymentContainers: [],
    paymentParts: [],
    paymentTransactions: [],
    paymentProviderTransactions: [{ transactionId: "ptx_1", status: "created" }],
    cashTxDenoms: [],
    fiscalReceipts: [],
    fiscalEvents: [],
    printSpoolJobs: [],
    commercialBenefitApplications: [],
    commercialBenefitRedemptions: [],
    auditEvents: [],
    integration: {
      orders: [{ id: "ord_1", revision: 1, dueAmount: 10 }],
      lastWriteAt: "2026-07-14T08:00:00.000Z",
    },
    posSettings: {
      tables: [{ id: "table_1", revision: 1, totalDue: 10, pendingBills: [] }],
    },
    meta: { lastWriteAt: "2026-07-14T08:00:00.000Z" },
  };
}

test("P4.3 payload free-split cattura solo il delta successivo", () => {
  const db = state();
  const capture = beginPaymentFreeSplitMirrorCapture(db);
  db.payments.push({ id: "pay_new", amount: 5 });
  db.paymentContainers.push({ id: "container_1", amount: 5 });
  db.paymentProviderTransactions[0] = { transactionId: "ptx_1", status: "settled" };
  db.auditEvents.push({ id: "audit_1", action: "payment.created" });

  const payload = buildPaymentFreeSplitMirrorPayload(db, {
    capture,
    aggregateId: "container_1",
    idempotencyKey: "idem_1",
    orderIds: ["ord_1"],
    tableIds: ["table_1"],
    occurredAt: "2026-07-14T09:00:00.000Z",
    explicitIds: { paymentProviderTransactions: ["ptx_1"] },
  });

  assert.deepEqual(payload.collections.payments.map((entry) => entry.id), ["pay_new"]);
  assert.equal(payload.collections.payments[0].position, 1);
  assert.deepEqual(payload.collections.paymentContainers.map((entry) => entry.id), ["container_1"]);
  assert.equal(payload.collections.paymentContainers[0].position, 0);
  assert.equal(payload.collections.paymentProviderTransactions[0].value.status, "settled");
  assert.equal(payload.collections.paymentProviderTransactions[0].position, 0);
  assert.deepEqual(payload.auditEventIds, ["audit_1"]);
  assert.equal(payload.collections.auditEvents[0].position, 0);
  assert.deepEqual(payload.integration.orders.map((entry) => entry.id), ["ord_1"]);
  assert.equal(payload.integration.orders[0].position, 0);
  assert.equal(payload.integration.ordersFieldPosition, 0);
  assert.equal(payload.integration.lastWriteAtFieldPosition, 1);
  assert.deepEqual(payload.posSettings.tables.map((entry) => entry.id), ["table_1"]);
  assert.equal(payload.posSettings.tables[0].position, 0);
  assert.equal(payload.posSettings.tablesFieldPosition, 0);
});

test("P4.3 apply usa ordini e tavoli relazionali autoritativi", () => {
  const source = state();
  const capture = beginPaymentFreeSplitMirrorCapture(source);
  source.payments.push({ id: "pay_new", amount: 5, updatedAt: "2026-07-14T09:00:00.000Z" });
  const payload = buildPaymentFreeSplitMirrorPayload(source, {
    capture,
    aggregateId: "container_1",
    orderIds: ["ord_1"],
    tableIds: ["table_1"],
    occurredAt: "2026-07-14T09:00:00.000Z",
  });
  const target = state();
  const result = applyPaymentFreeSplitMirrorPayload(target, payload, {
    latestOrders: [{ id: "ord_1", revision: 3, dueAmount: 0 }],
    latestTables: [{ id: "table_1", revision: 4, totalDue: 0, pendingBills: [] }],
  });

  assert.equal(target.payments.some((entry) => entry.id === "pay_new"), true);
  assert.equal(target.integration.orders.find((entry) => entry.id === "ord_1").dueAmount, 0);
  assert.equal(target.posSettings.tables.find((entry) => entry.id === "table_1").totalDue, 0);
  assert.deepEqual(result.mirrorOptions.orderIds, ["ord_1"]);
  assert.deepEqual(result.mirrorOptions.collectionEntryIds, { payments: ["pay_new"] });
  assert.equal(result.mirrorOptions.allowTransientDefer, false);
});

test("P4.3 apply rifiuta versioni payload sconosciute", () => {
  assert.throws(
    () => applyPaymentFreeSplitMirrorPayload(state(), { version: 99 }),
    /Versione payment mirror non supportata/,
  );
});
