import test from "node:test";
import assert from "node:assert/strict";

import {
  isArchivableIntegrationOrder,
  selectArchivableIntegrationOrders,
  summarizeIntegrationOrdersRetention,
} from "../modules/integration/orders-retention.js";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function order(overrides = {}) {
  return {
    id: "00001",
    workflowStatus: "delivered",
    paymentStatus: "paid",
    dueAmount: 0,
    completedAtMs: NOW - 48 * HOUR,
    ...overrides,
  };
}

test("una comanda consegnata e pagata senza residuo e archiviabile", () => {
  assert.equal(isArchivableIntegrationOrder(order()), true);
});

test("una comanda annullata e archiviabile anche se non pagata", () => {
  assert.equal(
    isArchivableIntegrationOrder(order({ workflowStatus: "cancelled", paymentStatus: "unpaid" })),
    true,
  );
});

test("una comanda consegnata ma non pagata non e archiviabile", () => {
  assert.equal(isArchivableIntegrationOrder(order({ paymentStatus: "unpaid" })), false);
});

test("una comanda consegnata con residuo da incassare non e archiviabile", () => {
  assert.equal(isArchivableIntegrationOrder(order({ dueAmount: 12.5 })), false);
});

test("le comande ancora nel flusso operativo non sono archiviabili", () => {
  for (const workflowStatus of ["waiting", "prep", "ready"]) {
    assert.equal(isArchivableIntegrationOrder(order({ workflowStatus })), false, workflowStatus);
  }
});

test("la finestra di retention protegge le comande chiuse da poco", () => {
  const selection = selectArchivableIntegrationOrders(
    [
      order({ id: "00001", completedAtMs: NOW - 48 * HOUR }),
      order({ id: "00002", completedAtMs: NOW - 2 * HOUR }),
    ],
    { nowMs: NOW, retentionMs: 24 * HOUR },
  );
  assert.deepEqual(selection.archivableIds, ["00001"]);
  assert.equal(selection.retained.length, 1);
});

test("senza una data attendibile la comanda resta calda", () => {
  const selection = selectArchivableIntegrationOrders(
    [order({ id: "00003", completedAtMs: 0, updatedAt: "", createdAt: "" })],
    { nowMs: NOW, retentionMs: HOUR },
  );
  assert.deepEqual(selection.archivableIds, []);
});

test("il limite per giro non lascia comande scoperte nel conteggio", () => {
  const orders = Array.from({ length: 5 }, (_, index) =>
    order({ id: String(index + 1).padStart(5, "0") }),
  );
  const selection = selectArchivableIntegrationOrders(orders, {
    nowMs: NOW,
    retentionMs: HOUR,
    limit: 2,
  });
  assert.equal(selection.archivable.length, 2);
  assert.equal(selection.retained.length, 3);
  assert.equal(selection.archivable.length + selection.retained.length, orders.length);
});

test("una comanda senza id non viene mai archiviata", () => {
  const selection = selectArchivableIntegrationOrders([order({ id: "  " })], {
    nowMs: NOW,
    retentionMs: HOUR,
  });
  assert.deepEqual(selection.archivableIds, []);
});

test("il riepilogo conserva scansionate, archiviate e trattenute", () => {
  const selection = selectArchivableIntegrationOrders(
    [order({ id: "00001" }), order({ id: "00002", workflowStatus: "ready" })],
    { nowMs: NOW, retentionMs: HOUR },
  );
  const summary = summarizeIntegrationOrdersRetention(selection, {
    retentionHours: 24,
    reason: "test",
  });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.archived, 1);
  assert.equal(summary.retained, 1);
  assert.equal(summary.retentionHours, 24);
  assert.equal(summary.reason, "test");
});

test("un input non valido non fa esplodere la selezione", () => {
  const selection = selectArchivableIntegrationOrders(null, { nowMs: NOW, retentionMs: HOUR });
  assert.deepEqual(selection.archivableIds, []);
  assert.equal(selection.retained.length, 0);
});
