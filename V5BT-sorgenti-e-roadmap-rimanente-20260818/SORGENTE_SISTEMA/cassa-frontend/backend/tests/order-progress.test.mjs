import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIntegrationItemProgressAuditSnapshot,
  hasIntegrationItemProgressAuditChange,
  markIntegrationOrderItemsReady,
} from "../modules/orders/order-progress.js";

test("markIntegrationOrderItemsReady marca tutte le righe come pronte preservando i campi", () => {
  const [first, second] = markIntegrationOrderItemsReady([
    { id: "oi_1", qty: 3, doneQty: 1, name: "Gin" },
    { id: "oi_2", qty: 2, doneQty: 5, name: "Vodka" },
  ]);

  assert.deepEqual(first, { id: "oi_1", qty: 3, doneQty: 3, name: "Gin", done: true });
  assert.deepEqual(second, { id: "oi_2", qty: 2, doneQty: 5, name: "Vodka", done: true });
});

test("markIntegrationOrderItemsReady gestisce input non-array senza mutazioni", () => {
  assert.deepEqual(markIntegrationOrderItemsReady(null), []);
  assert.deepEqual(markIntegrationOrderItemsReady({ items: [] }), []);
});

test("buildIntegrationItemProgressAuditSnapshot normalizza progress e voided", () => {
  assert.deepEqual(
    buildIntegrationItemProgressAuditSnapshot({
      items: [
        { id: " oi_1 ", lineId: " line_0001 ", qty: "2", done: true, doneQty: "1" },
        { lineId: null, qty: -3, done: false, doneQty: Number.NaN, voidedAt: "2026-06-07" },
      ],
    }),
    [
      { id: "oi_1", lineId: "line_0001", qty: 2, done: true, doneQty: 1, voided: false },
      { id: "item_2", lineId: "", qty: 0, done: false, doneQty: 0, voided: true },
    ]
  );
});

test("buildIntegrationItemProgressAuditSnapshot gestisce ordini senza righe", () => {
  assert.deepEqual(buildIntegrationItemProgressAuditSnapshot(null), []);
  assert.deepEqual(buildIntegrationItemProgressAuditSnapshot({ items: null }), []);
});

test("hasIntegrationItemProgressAuditChange evita snapshot quando il progress normalizzato e invariato", () => {
  const previousOrder = {
    items: [
      { id: " oi_1 ", lineId: " line_0001 ", qty: "2", done: false, doneQty: null },
      { id: "oi_2", lineId: "line_0002", qty: 1, done: true, doneQty: 1, name: "Gin" },
    ],
  };
  const nextOrder = {
    items: [
      { id: "oi_1", lineId: "line_0001", qty: 2, done: false, doneQty: Number.NaN, note: "extra" },
      { id: "oi_2", lineId: "line_0002", qty: "1", done: true, doneQty: "1", name: "Gin tonic" },
    ],
  };

  assert.equal(hasIntegrationItemProgressAuditChange(previousOrder, nextOrder), false);
});

test("hasIntegrationItemProgressAuditChange rileva cambi di quantita, stato e annullamento", () => {
  const baseOrder = {
    items: [{ id: "oi_1", lineId: "line_0001", qty: 2, done: false, doneQty: 0 }],
  };

  assert.equal(
    hasIntegrationItemProgressAuditChange(baseOrder, {
      items: [{ id: "oi_1", lineId: "line_0001", qty: 2, done: true, doneQty: 0 }],
    }),
    true
  );
  assert.equal(
    hasIntegrationItemProgressAuditChange(baseOrder, {
      items: [{ id: "oi_1", lineId: "line_0001", qty: 2, done: false, doneQty: 1 }],
    }),
    true
  );
  assert.equal(
    hasIntegrationItemProgressAuditChange(baseOrder, {
      items: [{ id: "oi_1", lineId: "line_0001", qty: 2, done: false, doneQty: 0, voidedAt: "2026-07-08" }],
    }),
    true
  );
  assert.equal(
    hasIntegrationItemProgressAuditChange(baseOrder, {
      items: [
        { id: "oi_1", lineId: "line_0001", qty: 2, done: false, doneQty: 0 },
        { id: "oi_2", lineId: "line_0002", qty: 1, done: false, doneQty: 0 },
      ],
    }),
    true
  );
});
