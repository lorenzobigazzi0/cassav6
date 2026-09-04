import assert from "node:assert/strict";
import test from "node:test";
import { applyOrderCorrectionItemChanges } from "../modules/orders/order-correction-changes.js";

class TestHttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.code = details.code;
  }
}

const roundMoney = (value) => Math.round(Number(value) * 100) / 100;
const helpers = {
  HttpError: TestHttpError,
  clampInt(value, min, max, fallback) {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed)
      ? Math.max(min, Math.min(max, parsed))
      : fallback;
  },
  cloneJson(value, fallback) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  },
  makeIntegrationOrderItemFromProduct({
    id,
    lineId,
    product,
    quantity,
    unitPrice,
  }) {
    return {
      id,
      lineId,
      productId: product.id,
      productNameSnapshot: product.name,
      qty: quantity,
      unitPriceApplied: unitPrice,
      listPriceAtTime: unitPrice,
    };
  },
  nextIntegrationOrderLineId: () => "line_next",
  normalizeCorrectionReason: (value) => String(value ?? "").trim(),
  nowIso: () => "2026-07-15T10:00:00.000Z",
  resolveMenuProductForPayload: () => null,
  roundMoney,
  slugifyId: (value) => String(value).toLowerCase().replace(/\W+/g, "_"),
};

const currentOrder = {
  id: "order_1",
  items: [
    {
      id: "oi_1",
      lineId: "line_1",
      productId: "product_1",
      productNameSnapshot: "Piatto",
      qty: 2,
      done: false,
      doneQty: 1,
      unitPriceApplied: 10,
      listPriceAtTime: 10,
      vatRate: 10,
      vatCode: "IVA10",
      departmentId: "food",
      fiscalDepartment: "1",
      variants: { cottura: "media" },
    },
  ],
};

test("rettifica prezzi unitari e conserva metadati fiscali e identificativi", () => {
  const result = applyOrderCorrectionItemChanges({
    db: {},
    currentOrder,
    payload: {
      changedItems: [
        {
          lineId: "line_1",
          nextQuantity: 2,
          nextUnitPrices: [8.33, 8.34],
          nextNotes: "Prezzo concordato",
          nextVariant: "media",
          nextModifiers: { cottura: "media" },
        },
      ],
    },
    helpers,
  });

  assert.equal(result.nextItems.length, 2);
  assert.deepEqual(
    result.nextItems.map((item) => item.unitPriceApplied),
    [8.33, 8.34],
  );
  assert.equal(
    result.nextItems.reduce(
      (sum, item) => sum + Math.round(item.unitPriceApplied * 100),
      0,
    ),
    1667,
  );
  assert.deepEqual(
    result.nextItems.map((item) => item.id),
    ["oi_1", "oi_2"],
  );
  assert.deepEqual(
    result.nextItems.map((item) => item.doneQty),
    [1, 0],
  );
  for (const item of result.nextItems) {
    assert.equal(item.productId, "product_1");
    assert.equal(item.vatRate, 10);
    assert.equal(item.vatCode, "IVA10");
    assert.equal(item.departmentId, "food");
    assert.equal(item.fiscalDepartment, "1");
    assert.equal(item.priceOverrideApplied, true);
  }
  assert.deepEqual(result.changedItems[0].previousUnitPrices, [10, 10]);
  assert.deepEqual(result.changedItems[0].nextUnitPrices, [8.33, 8.34]);
});

test("mantiene un prezzo manuale a zero anche in una rettifica successiva", () => {
  const first = applyOrderCorrectionItemChanges({
    db: {},
    currentOrder,
    payload: {
      changedItems: [
        {
          lineId: "line_1",
          nextQuantity: 2,
          nextUnitPrices: [0, 8],
        },
      ],
    },
    helpers,
  });
  const second = applyOrderCorrectionItemChanges({
    db: {},
    currentOrder: { ...currentOrder, items: first.nextItems },
    payload: {
      changedItems: [
        {
          lineId: "line_1",
          nextQuantity: 2,
          nextUnitPrices: [1, 7],
        },
      ],
    },
    helpers,
  });

  assert.deepEqual(first.nextItems.map((item) => item.unitPriceApplied), [0, 8]);
  assert.deepEqual(second.changedItems[0].previousUnitPrices, [0, 8]);
  assert.deepEqual(second.nextItems.map((item) => item.unitPriceApplied), [1, 7]);
});

test("rifiuta una ripartizione unitaria incoerente con la quantita", () => {
  assert.throws(
    () =>
      applyOrderCorrectionItemChanges({
        db: {},
        currentOrder,
        payload: {
          changedItems: [
            {
              lineId: "line_1",
              nextQuantity: 2,
              nextUnitPrices: [8.33],
            },
          ],
        },
        helpers,
      }),
    (error) =>
      error instanceof TestHttpError &&
      error.status === 400 &&
      error.code === "INVALID_CORRECTION_UNIT_PRICES",
  );
});
