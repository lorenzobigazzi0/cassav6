import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOrderFinancialTableRevisionTokens,
  buildOrderFinancialTableRevisionTokens,
} from "../modules/integration/order-financial-table-write-guard.js";

test("MP-4ab financial table guard cattura revisioni relazionali target", () => {
  const tokens = buildOrderFinancialTableRevisionTokens({
    tableIds: ["t1", "", "t1", "t2"],
    getTableState(tableId) {
      return tableId === "t1" ? { revision: 7 } : null;
    },
  });

  assert.deepEqual(tokens, [
    { tableId: "t1", revision: 7, exists: true },
    { tableId: "t2", revision: 1, exists: false },
  ]);
});

test("MP-4ab financial table guard include snapshot solo quando richiesto", () => {
  const tokens = buildOrderFinancialTableRevisionTokens({
    includeSnapshots: true,
    tableIds: ["t1"],
    getTableState() {
      return { id: "t1", revision: 9, pendingBills: [{ orderId: "o1", subtotal: 5 }] };
    },
  });

  assert.equal(tokens[0].revision, 9);
  assert.deepEqual(tokens[0].tableSnapshot.pendingBills, [{ orderId: "o1", subtotal: 5 }]);
});

test("MP-4ab financial table guard applica revision+1 solo ai tavoli toccati", () => {
  const settings = {
    tables: [
      { id: "t1", status: "payment_due", revision: 7, totalDue: 12 },
      { id: "t2", status: "free", revision: 3, totalDue: 0 },
    ],
  };
  const plan = applyOrderFinancialTableRevisionTokens({
    settings,
    tableIds: ["t1"],
    tokens: [{ tableId: "t1", revision: 7, exists: true }],
  });

  assert.equal(plan.changed, true);
  assert.equal(plan.settings.tables[0].revision, 8);
  assert.equal(plan.settings.tables[1], settings.tables[1]);
  assert.deepEqual(plan.tableIds, ["t1"]);
  assert.deepEqual(settings.tables[0].revision, 7);
});

test("MP-4ab financial table guard preserva currentRevision quando presente", () => {
  const plan = applyOrderFinancialTableRevisionTokens({
    settings: {
      tables: [{ id: "t1", revision: 2, currentRevision: 2 }],
    },
    tableIds: ["t1"],
    tokens: [{ tableId: "t1", revision: 2, exists: true }],
  });

  assert.equal(plan.settings.tables[0].revision, 3);
  assert.equal(plan.settings.tables[0].currentRevision, 3);
});
