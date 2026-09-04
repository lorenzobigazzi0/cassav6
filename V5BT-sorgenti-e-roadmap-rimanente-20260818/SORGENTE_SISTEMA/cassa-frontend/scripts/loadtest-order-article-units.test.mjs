import assert from "node:assert/strict";
import test from "node:test";
import {
  enumerateOrderArticleUnits,
  firstPayableOrderArticleUnit,
  isStalePaymentArticleSelectionResponse,
  resolveRefreshedOrder,
} from "./loadtest-order-article-units.mjs";

test("non riutilizza l'ordine obsoleto quando il refresh 200 e vuoto", () => {
  const staleOrder = { id: "order-stale" };

  assert.equal(
    resolveRefreshedOrder(staleOrder, { status: 200, body: { orders: [] } }),
    null,
  );
  assert.equal(
    resolveRefreshedOrder(staleOrder, { status: 404, body: {} }),
    null,
  );
  assert.equal(
    resolveRefreshedOrder(staleOrder, { status: 409, body: {} }),
    staleOrder,
  );
});

test("riconosce soltanto il rifiuto transitorio per unita articolo obsoleta", () => {
  assert.equal(
    isStalePaymentArticleSelectionResponse({
      status: 400,
      body: { error: "Articolo selezionato non appartenente al tavolo." },
    }),
    true,
  );
  assert.equal(
    isStalePaymentArticleSelectionResponse({
      status: 400,
      body: { error: "Pagamento non applicabile." },
    }),
    false,
  );
  assert.equal(
    isStalePaymentArticleSelectionResponse({
      status: 409,
      body: { error: "Articolo selezionato non appartenente al tavolo." },
    }),
    false,
  );
});

test("distribuisce i centesimi tra le unita articolo come il backend", () => {
  const units = enumerateOrderArticleUnits({
    id: "order-1",
    items: [{ lineId: "line-a", qty: 3, lineTotal: 10 }],
  });

  assert.deepEqual(
    units.map(({ unitId, amountCents }) => ({ unitId, amountCents })),
    [
      { unitId: "order-1_0_0", amountCents: 334 },
      { unitId: "order-1_0_1", amountCents: 333 },
      { unitId: "order-1_0_2", amountCents: 333 },
    ],
  );
});

test("mantiene l'indice progressivo per righe con lo stesso lineId", () => {
  const units = enumerateOrderArticleUnits({
    id: "order-2",
    items: [
      { lineId: "shared", qty: 2, lineTotal: 4 },
      { lineId: "shared", qty: 1, lineTotal: 3 },
      { lineId: "other", qty: 1, lineTotal: 5 },
    ],
  });

  assert.deepEqual(
    units.map((unit) => unit.unitId),
    ["order-2_0_0", "order-2_0_1", "order-2_0_2", "order-2_1_0"],
  );
});

test("sceglie la prima unita positiva non annullata e non gia pagata", () => {
  const selection = firstPayableOrderArticleUnit({
    id: "order-3",
    paidArticleUnits: ["order-3_0_0"],
    items: [
      { lineId: "voided", qty: 1, lineTotal: 9, voidedAt: "2026-07-16T10:00:00.000Z" },
      { lineId: "active", qty: 2, lineTotal: 8 },
    ],
  });

  assert.deepEqual(selection, {
    unitId: "order-3_0_1",
    amount: 4,
    amountCents: 400,
    orderId: "order-3",
    lineIndex: 0,
    unitIndex: 1,
  });
});

test("non restituisce unita per ordini pagati o senza importi pagabili", () => {
  assert.equal(
    firstPayableOrderArticleUnit({
      id: "order-paid",
      paymentStatus: "paid",
      items: [{ qty: 1, lineTotal: 3 }],
    }),
    null,
  );
  assert.equal(
    firstPayableOrderArticleUnit({
      id: "order-zero",
      items: [{ qty: 1, lineTotal: 0 }],
    }),
    null,
  );
});
