import assert from "node:assert/strict";
import test from "node:test";

import {
  addOrderSyncFinancialNoopTableSnapshot,
  buildOrderCancelFinancialDeltaBeforeSnapshotFastPath,
  buildOrderCreateFinancialDeltaBeforeSnapshotFastPath,
  buildOrderCreateFinancialDeltaFastPath,
  buildOrderFinancialSyncState,
  buildOrderSyncFinancialNoopFastPath,
} from "../modules/integration/order-financial-sync-source.js";

test("MP-4aa financial sync usa dbcache quando manca snapshot ordini", () => {
  const baseState = {
    integration: {
      orders: [{ id: "001" }],
    },
  };
  const result = buildOrderFinancialSyncState({ baseState, orderSnapshot: null });

  assert.equal(result.state, baseState);
  assert.equal(result.sourceKind, "dbcache");
  assert.equal(result.externalized, false);
});

test("MP-4aa financial sync usa snapshot relazionale senza mutare lo stato base", () => {
  const baseState = {
    integration: {
      orders: [{ id: "001" }],
      sequence: { order: 3 },
    },
    posSettings: { tables: [{ id: "t1" }] },
  };
  const snapshot = {
    sourceKind: "relational-orders",
    externalized: true,
    orders: [{ id: "001" }, { id: "002" }],
  };

  const result = buildOrderFinancialSyncState({ baseState, orderSnapshot: snapshot });

  assert.notEqual(result.state, baseState);
  assert.notEqual(result.state.integration, baseState.integration);
  assert.equal(result.state.posSettings, baseState.posSettings);
  assert.deepEqual(result.state.integration.orders, snapshot.orders);
  assert.deepEqual(baseState.integration.orders, [{ id: "001" }]);
  assert.deepEqual(result.state.integration.sequence, { order: 3 });
  assert.equal(result.sourceKind, "relational-orders");
  assert.equal(result.externalized, true);
});

test("P3.57 financial noop fast path salta solo sync progress-only con tavolo coerente", () => {
  const settings = {
    orderWorkflow: { deliveryConfirmationEnabled: true },
    tables: [{ id: "t1", status: "payment_due", ordersInProgress: 1, totalDue: 12, pendingBills: [{ orderId: "001", subtotal: 12 }] }],
  };
  const currentOrder = {
    id: "001",
    tableId: "t1",
    roomId: "room",
    tableNumber: 1,
    workflowStatus: "waiting",
    paymentStatus: "unpaid",
    total: 12,
    paidAmount: 0,
    dueAmount: 12,
    receivedAtMs: 1000,
    items: [{ lineId: "l1", name: "Acqua", qty: 2, lineTotal: 12 }],
  };
  const mergedOrder = {
    ...currentOrder,
    workflowStatus: "prep",
    items: [{ ...currentOrder.items[0], done: true, doneQty: 1 }],
  };

  const result = buildOrderSyncFinancialNoopFastPath({
    currentOrder,
    mergedOrder,
    settings,
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "financial_signature_unchanged");
  assert.equal(result.financialSync.changed, false);
});

test("P3.57 financial noop fast path non salta quando cambia importo o pagamento", () => {
  const settings = {
    orderWorkflow: { deliveryConfirmationEnabled: true },
    tables: [{ id: "t1", status: "payment_due", totalDue: 12, pendingBills: [{ orderId: "001", subtotal: 12 }] }],
  };
  const currentOrder = {
    id: "001",
    tableId: "t1",
    workflowStatus: "prep",
    paymentStatus: "unpaid",
    total: 12,
    paidAmount: 0,
    dueAmount: 12,
    items: [{ lineId: "l1", name: "Acqua", qty: 2, lineTotal: 12 }],
  };

  const result = buildOrderSyncFinancialNoopFastPath({
    currentOrder,
    mergedOrder: { ...currentOrder, dueAmount: 10, paidAmount: 2, paymentStatus: "partial" },
    settings,
  });

  assert.equal(result.skipped, false);
  assert.equal(result.reason, "financial_signature_changed");
});

test("P3.57 financial noop fast path non salta se coda o tavolo indicano side-effect", () => {
  const currentOrder = {
    id: "001",
    tableId: "t1",
    workflowStatus: "waiting",
    paymentStatus: "unpaid",
    total: 12,
    paidAmount: 0,
    dueAmount: 12,
    items: [{ lineId: "l1", name: "Acqua", qty: 2, lineTotal: 12 }],
  };
  const mergedOrder = { ...currentOrder, workflowStatus: "prep" };

  assert.equal(
    buildOrderSyncFinancialNoopFastPath({
      currentOrder,
      mergedOrder,
      settings: { tables: [{ id: "t1", status: "waiting", ordersInProgress: 1 }] },
      queuePromotions: [{ orderId: "002" }],
    }).reason,
    "queue_side_effects",
  );
  assert.equal(
    buildOrderSyncFinancialNoopFastPath({
      currentOrder,
      mergedOrder,
      settings: { tables: [{ id: "t1", status: "free", ordersInProgress: 0, totalDue: 0 }] },
    }).reason,
    "table_not_compatible",
  );
});

test("P3.58 financial noop aggancia snapshot tavolo gia pronta per realtime", () => {
  const financialSync = { changed: false, tableIds: [], tableSnapshotsById: new Map() };
  const snapshot = { id: "t1", roomId: "room", amountDue: 12, pendingBills: [{ orderId: "001" }] };

  const result = addOrderSyncFinancialNoopTableSnapshot(financialSync, "t1", snapshot);

  assert.equal(result, financialSync);
  assert.equal(result.tableSnapshotsById.get("t1"), snapshot);
  addOrderSyncFinancialNoopTableSnapshot(financialSync, "t1", { id: "t1", amountDue: 99 });
  assert.equal(result.tableSnapshotsById.get("t1"), snapshot);
});

test("P3.65 orders/create financial delta aggiorna solo il tavolo target", () => {
  const appState = {
    posSettings: {
      tables: [
        { id: "t1", roomId: "room", number: 1, status: "free", covers: 0, totalDue: 0, amountDue: 0, dueAmount: 0, pendingBills: [] },
        { id: "t2", roomId: "room", number: 2, status: "free", covers: 0, totalDue: 0, amountDue: 0, dueAmount: 0, pendingBills: [] },
      ],
    },
  };
  const order = {
    id: "101",
    tableId: "t1",
    covers: 2,
    createdAt: "2026-07-09T10:00:00.000Z",
    dueAmount: 18,
    paymentStatus: "unpaid",
    receivedAtMs: 1000,
    workflowStatus: "waiting",
    items: [{ lineId: "l1", name: "Pasta", qty: 2, unitPriceApplied: 9, lineTotal: 18 }],
  };

  const result = buildOrderCreateFinancialDeltaFastPath({ appState, order, targetTableIds: ["t1"] });

  assert.equal(result.applied, true);
  assert.equal(result.reason, "delta_applied");
  assert.equal(result.financialSync.changed, true);
  assert.deepEqual(result.financialSync.tableIds, ["t1"]);
  assert.equal(appState.posSettings.tables[0].status, "payment_due");
  assert.equal(appState.posSettings.tables[0].amountDue, 18);
  assert.equal(appState.posSettings.tables[0].covers, 2);
  assert.equal(appState.posSettings.tables[0].pendingBills[0].orderId, "101");
  assert.equal(appState.posSettings.tables[1].status, "free");
});

test("P3.65 orders/create financial delta limita i coperti del singolo tavolo a 100", () => {
  const appState = {
    posSettings: {
      tables: [
        { id: "t1", roomId: "room", number: 1, status: "free", covers: 0, totalDue: 0, amountDue: 0, dueAmount: 0, pendingBills: [] },
      ],
    },
  };

  const result = buildOrderCreateFinancialDeltaFastPath({
    appState,
    order: {
      id: "101",
      tableId: "t1",
      covers: 250,
      dueAmount: 18,
      paymentStatus: "unpaid",
      receivedAtMs: 1000,
      workflowStatus: "waiting",
      items: [{ name: "Pasta", qty: 2, lineTotal: 18 }],
    },
    targetTableIds: ["t1"],
  });

  assert.equal(result.applied, true);
  assert.equal(appState.posSettings.tables[0].covers, 100);
});

test("P3.65 orders/create financial delta fa fallback su tavoli collegati", () => {
  const result = buildOrderCreateFinancialDeltaFastPath({
    appState: { posSettings: { tables: [{ id: "t1" }] } },
    linkedTableIds: ["t1", "t2"],
    order: { id: "101", tableId: "t1", dueAmount: 10, paymentStatus: "unpaid" },
    targetTableIds: ["t1"],
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "linked_tables");
  assert.equal(result.financialSync, null);
});

test("P3.65 orders/create financial delta copre ordini waiting non ancora pagabili", () => {
  const appState = {
    posSettings: {
      orderWorkflow: { requireDeliveredForPayment: true },
      tables: [{ id: "t1", status: "free", covers: 0, totalDue: 0, amountDue: 0, dueAmount: 0, pendingBills: [] }],
    },
  };

  const result = buildOrderCreateFinancialDeltaFastPath({
    appState,
    order: { id: "101", tableId: "t1", covers: 3, dueAmount: 18, paymentStatus: "unpaid", workflowStatus: "waiting", receivedAtMs: 1000, items: [{ name: "Pasta", qty: 2, lineTotal: 18 }] },
    targetTableIds: ["t1"],
  });

  assert.equal(result.applied, true);
  assert.equal(result.reason, "waiting_delta_applied");
  assert.equal(appState.posSettings.tables[0].status, "waiting");
  assert.equal(appState.posSettings.tables[0].amountDue, 0);
  assert.equal(appState.posSettings.tables[0].covers, 3);
  assert.deepEqual(appState.posSettings.tables[0].pendingBills, []);
});

test("P3.65 orders/create financial delta rimpiazza il bill dello stesso ordine", () => {
  const appState = {
    posSettings: {
      tables: [{ id: "t1", status: "payment_due", covers: 1, totalDue: 8, amountDue: 8, dueAmount: 8, pendingBills: [{ id: "order_101", orderId: "101", subtotal: 8, lines: [{ name: "Old", qty: 1, unitPrice: 8, lineTotal: 8 }] }] }],
    },
  };
  const result = buildOrderCreateFinancialDeltaFastPath({
    appState,
    order: { id: "101", tableId: "t1", covers: 1, dueAmount: 10, paymentStatus: "unpaid", items: [{ name: "New", qty: 1, lineTotal: 10 }] },
    targetTableIds: ["t1"],
  });

  assert.equal(result.applied, true);
  assert.equal(appState.posSettings.tables[0].pendingBills.length, 1);
  assert.equal(appState.posSettings.tables[0].amountDue, 10);
  assert.equal(appState.posSettings.tables[0].pendingBills[0].lines[0].name, "New");
});

test("P3.67 orders/create financial delta before snapshot richiede token revisione coerente", () => {
  const appState = {
    posSettings: {
      tables: [{ id: "t1", revision: 4, status: "free", covers: 0, totalDue: 0, pendingBills: [] }],
    },
  };
  const order = { id: "101", tableId: "t1", covers: 1, dueAmount: 10, paymentStatus: "unpaid", workflowStatus: "waiting", items: [{ name: "Pasta", qty: 1, lineTotal: 10 }] };
  const result = buildOrderCreateFinancialDeltaBeforeSnapshotFastPath({
    appState,
    guardTokens: [{ tableId: "t1", revision: 4, exists: true }],
    order,
    targetTableIds: ["t1"],
  });

  assert.equal(result.applied, true);
  assert.equal(result.reason, "delta_applied");
  assert.equal(appState.posSettings.tables[0].pendingBills[0].orderId, "101");

  const staleState = {
    posSettings: {
      tables: [{ id: "t1", revision: 3, status: "free", covers: 0, totalDue: 0, pendingBills: [] }],
    },
  };
  const stale = buildOrderCreateFinancialDeltaBeforeSnapshotFastPath({
    appState: staleState,
    guardTokens: [{ tableId: "t1", revision: 4, exists: true }],
    order,
    targetTableIds: ["t1"],
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "guard_mismatch");
  assert.deepEqual(staleState.posSettings.tables[0].pendingBills, []);
});

test("P3.69 orders/cancel financial delta before snapshot rimuove solo il bill target", () => {
  const appState = {
    posSettings: {
      tables: [
        {
          id: "t1",
          revision: 7,
          status: "payment_due",
          covers: 2,
          totalDue: 30,
          amountDue: 30,
          dueAmount: 30,
          ordersInProgress: 1,
          pendingBills: [
            { id: "order_101", orderId: "101", subtotal: 18, lines: [{ name: "Pasta", qty: 2, lineTotal: 18 }] },
            { id: "order_102", orderId: "102", subtotal: 12, lines: [{ name: "Acqua", qty: 2, lineTotal: 12 }] },
          ],
        },
      ],
    },
  };
  const currentOrder = {
    id: "101",
    tableId: "t1",
    workflowStatus: "prep",
    paymentStatus: "unpaid",
    total: 18,
    dueAmount: 18,
    covers: 2,
    items: [{ lineId: "l1", name: "Pasta", qty: 2, lineTotal: 18 }],
  };
  const nextOrder = {
    ...currentOrder,
    workflowStatus: "cancelled",
    paymentStatus: "paid",
    total: 0,
    dueAmount: 0,
    items: [{ ...currentOrder.items[0], voidedAt: "2026-07-09T12:00:00.000Z" }],
  };

  const result = buildOrderCancelFinancialDeltaBeforeSnapshotFastPath({
    appState,
    currentOrder,
    guardTokens: [{ tableId: "t1", revision: 7, exists: true }],
    linkedTableIds: ["t1"],
    nextOrder,
    targetTableIds: ["t1"],
  });

  assert.equal(result.applied, true);
  assert.equal(result.reason, "delta_applied");
  assert.equal(result.financialSync.changed, true);
  assert.deepEqual(result.financialSync.tableIds, ["t1"]);
  assert.equal(appState.posSettings.tables[0].amountDue, 12);
  assert.equal(appState.posSettings.tables[0].pendingBills.length, 1);
  assert.equal(appState.posSettings.tables[0].pendingBills[0].orderId, "102");
});

test("P3.69 orders/cancel financial delta before snapshot usa lo snapshot guard se la cache worker e stale", () => {
  const appState = {
    posSettings: {
      tables: [{ id: "t1", revision: 3, status: "payment_due", amountDue: 99, pendingBills: [] }],
    },
  };
  const currentOrder = { id: "101", tableId: "t1", workflowStatus: "prep", paymentStatus: "unpaid", total: 10, dueAmount: 10, items: [{ name: "Pasta", qty: 1, lineTotal: 10 }] };
  const nextOrder = { ...currentOrder, workflowStatus: "cancelled", paymentStatus: "paid", total: 0, dueAmount: 0 };

  const result = buildOrderCancelFinancialDeltaBeforeSnapshotFastPath({
    appState,
    currentOrder,
    guardTokens: [{
      tableId: "t1",
      revision: 8,
      exists: true,
      tableSnapshot: { id: "t1", revision: 8, status: "payment_due", amountDue: 10, pendingBills: [{ orderId: "101", subtotal: 10 }] },
    }],
    linkedTableIds: ["t1"],
    nextOrder,
    targetTableIds: ["t1"],
  });

  assert.equal(result.applied, true);
  assert.equal(result.reason, "delta_applied");
  assert.equal(appState.posSettings.tables[0].revision, 8);
  assert.equal(appState.posSettings.tables[0].amountDue, 0);
  assert.deepEqual(appState.posSettings.tables[0].pendingBills, []);
});

test("P3.69 orders/cancel financial delta before snapshot fa fallback se guard o scope non sono sicuri", () => {
  const appState = {
    posSettings: {
      tables: [{ id: "t1", revision: 3, status: "payment_due", amountDue: 10, pendingBills: [{ orderId: "101", subtotal: 10 }] }],
    },
  };
  const currentOrder = { id: "101", tableId: "t1", workflowStatus: "prep", paymentStatus: "unpaid", total: 10, dueAmount: 10, items: [{ name: "Pasta", qty: 1, lineTotal: 10 }] };
  const nextOrder = { ...currentOrder, workflowStatus: "cancelled", paymentStatus: "paid", total: 0, dueAmount: 0 };

  const stale = buildOrderCancelFinancialDeltaBeforeSnapshotFastPath({
    appState,
    currentOrder,
    guardTokens: [{ tableId: "t1", revision: 4, exists: true }],
    linkedTableIds: ["t1"],
    nextOrder,
    targetTableIds: ["t1"],
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "guard_mismatch");

  const linked = buildOrderCancelFinancialDeltaBeforeSnapshotFastPath({
    appState,
    currentOrder,
    guardTokens: [{ tableId: "t1", revision: 3, exists: true }],
    linkedTableIds: ["t1", "t2"],
    nextOrder,
    targetTableIds: ["t1"],
  });
  assert.equal(linked.applied, false);
  assert.equal(linked.reason, "linked_tables");
  assert.equal(appState.posSettings.tables[0].amountDue, 10);
});
