import test from "node:test";
import assert from "node:assert/strict";
import {
  collectOrderIdsFromBills,
  collectOrderIdsFromLineSelections,
  collectOrderIdsFromSelectedBills,
  collectPosBillOrderIds,
  normalizePaymentOrderIdList,
  resolvePaymentOrderRefs,
} from "../modules/payments/payment-order-refs.domain.js";

const BILLS = [
  { id: "bill_1", orderId: "001", orderIds: ["001", "002"] },
  { id: "bill_2", orderId: "003" },
  { id: "bill_empty", orderId: "" },
];

test("payment order refs raccoglie orderId diretti e multipli senza duplicati", () => {
  assert.deepEqual(collectPosBillOrderIds(BILLS[0]), ["001", "002"]);
  assert.deepEqual(collectOrderIdsFromBills(BILLS), ["001", "002", "003"]);
  assert.deepEqual(collectOrderIdsFromBills(null), []);
});

test("payment order refs filtra per bill selezionate anche se Set", () => {
  assert.deepEqual(collectOrderIdsFromSelectedBills(BILLS, ["bill_2"]), ["003"]);
  assert.deepEqual(collectOrderIdsFromSelectedBills(BILLS, new Set(["bill_1", "missing"])), ["001", "002"]);
});

test("payment order refs risolve le orderIds da selezioni articolo", () => {
  assert.deepEqual(
    collectOrderIdsFromLineSelections(BILLS, [
      { billId: "bill_2", lineId: "l1" },
      { billId: "bill_2", lineId: "l2" },
      { billId: "bill_1", lineId: "l3" },
    ]),
    ["001", "002", "003"]
  );
});

test("payment order refs normalizza rimuovendo tableId e duplicati", () => {
  assert.deepEqual(normalizePaymentOrderIdList(["table_1", "001", "001", "", null, "002"], "table_1"), [
    "001",
    "002",
  ]);
});

test("payment order refs priorita target order, line selections, selected bills, tutti bills", () => {
  assert.deepEqual(resolvePaymentOrderRefs({ tableBills: BILLS, targetOrderId: "004", tableId: "table_1" }), {
    tableId: "table_1",
    orderId: "004",
    orderIds: ["004"],
    billId: null,
    billIds: [],
  });

  assert.deepEqual(
    resolvePaymentOrderRefs({
      tableBills: BILLS,
      selectedBillIds: ["bill_1"],
      lineSelections: [{ billId: "bill_2" }],
      tableId: "table_1",
    }),
    {
      tableId: "table_1",
      orderId: "003",
      orderIds: ["003"],
      billId: null,
      billIds: ["bill_1", "bill_2"],
    }
  );

  assert.deepEqual(resolvePaymentOrderRefs({ tableBills: BILLS, selectedBillIds: ["bill_2"], tableId: "table_1" }), {
    tableId: "table_1",
    orderId: "003",
    orderIds: ["003"],
    billId: "bill_2",
    billIds: ["bill_2"],
  });
});
