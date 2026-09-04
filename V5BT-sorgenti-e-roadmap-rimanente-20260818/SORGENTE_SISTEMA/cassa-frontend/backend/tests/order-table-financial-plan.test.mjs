import assert from "node:assert/strict";
import test from "node:test";

import { buildOrderTableFinancialPlan } from "../modules/integration/order-table-financial-plan.js";

test("MP-4z table financial plan lascia invariato un tavolo gia coerente", () => {
  const currentTable = {
    id: "table-1",
    status: "payment_due",
    seatedAt: 1_000,
    covers: 2,
    totalDue: 18.5,
    amountDue: 18.5,
    dueAmount: 18.5,
    pendingBills: [{ id: "bill-1", subtotal: 18.5 }],
  };
  const plan = buildOrderTableFinancialPlan({
    currentTable,
    currentPendingBills: currentTable.pendingBills,
    live: {
      amountDue: 18.5,
      covers: 1,
      ordersInProgress: 1,
      earliestOrderAtMs: 1_000,
    },
    nextPendingBills: currentTable.pendingBills,
    nowMs: () => 2_000,
    sessionStartMs: 900,
  });

  assert.equal(plan.changed, false);
  assert.equal(plan.nextTable, currentTable);
});

test("MP-4z table financial plan aggiorna importi e stato payment_due", () => {
  const plan = buildOrderTableFinancialPlan({
    currentTable: {
      id: "table-2",
      status: "free",
      seatedAt: null,
      covers: 0,
      totalDue: 0,
      amountDue: 0,
      dueAmount: 0,
      pendingBills: [],
    },
    currentPendingBills: [],
    live: {
      amountDue: 22.337,
      covers: 3,
      ordersInProgress: 1,
      earliestOrderAtMs: 1_500,
    },
    nextPendingBills: [{ id: "bill-1", subtotal: 22.34 }],
    nowMs: () => 3_000,
    sessionStartMs: 1_800,
  });

  assert.equal(plan.changed, true);
  assert.equal(plan.tableId, "table-2");
  assert.deepEqual(plan.patch, {
    status: "payment_due",
    seatedAt: 1_500,
    covers: 3,
    totalDue: 22.34,
    amountDue: 22.34,
    dueAmount: 22.34,
    pendingBills: [{ id: "bill-1", subtotal: 22.34 }],
  });
});

test("MP-4z table financial plan passa a no_orders quando non resta lavoro aperto", () => {
  const plan = buildOrderTableFinancialPlan({
    currentTable: {
      id: "table-3",
      status: "waiting",
      seatedAt: 4_000,
      covers: 4,
      totalDue: 0,
      amountDue: 0,
      dueAmount: 0,
      pendingBills: [],
    },
    currentPendingBills: [],
    live: {
      amountDue: 0,
      covers: 0,
      ordersInProgress: 0,
    },
    nextPendingBills: [],
    nowMs: () => 5_000,
  });

  assert.equal(plan.changed, true);
  assert.equal(plan.nextTable.status, "no_orders");
  assert.equal(plan.nextTable.seatedAt, 4_000);
  assert.equal(plan.nextTable.covers, 4);
});

test("MP-4z table financial plan limita a 100 i coperti del singolo tavolo", () => {
  const plan = buildOrderTableFinancialPlan({
    currentTable: {
      id: "table-capacity",
      status: "waiting",
      covers: 2,
      totalDue: 0,
      amountDue: 0,
      dueAmount: 0,
      pendingBills: [],
    },
    currentPendingBills: [],
    live: { amountDue: 10, covers: 101, ordersInProgress: 1 },
    nextPendingBills: [{ id: "bill-capacity", subtotal: 10 }],
    nowMs: () => 6_000,
  });

  assert.equal(plan.nextTable.covers, 100);
});
