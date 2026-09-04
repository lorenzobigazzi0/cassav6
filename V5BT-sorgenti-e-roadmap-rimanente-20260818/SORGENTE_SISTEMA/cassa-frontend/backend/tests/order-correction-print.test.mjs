import assert from "node:assert/strict";
import test from "node:test";

import { buildCorrectionPrintAnnotations } from "../modules/orders/order-correction-print.js";

test("buildCorrectionPrintAnnotations indicizza righe aggiunte e modificate per lineId", () => {
  const added = { lineId: " line_0001 ", productName: "Gin" };
  const changed = { lineId: "line_0002", productName: "Vodka", quantity: 2 };
  const annotations = buildCorrectionPrintAnnotations({
    addedItems: [added, { lineId: "", productName: "Ignorato" }],
    changedItems: [changed, { productName: "Ignorato" }],
  });

  assert.equal(annotations.addedByLineId.get("line_0001"), added);
  assert.equal(annotations.changedByLineId.get("line_0002"), changed);
  assert.equal(annotations.addedByLineId.size, 1);
  assert.equal(annotations.changedByLineId.size, 1);
  assert.deepEqual(annotations.removedLines, []);
});

test("buildCorrectionPrintAnnotations crea snapshot stampabili per righe rimosse", () => {
  const annotations = buildCorrectionPrintAnnotations({
    removedItems: [
      { lineId: " line_0003 ", productId: "prod_1", productName: "Ichnusa", quantity: 2 },
      { productId: "prod_2", qty: 3 },
    ],
  });

  assert.deepEqual(annotations.removedLines, [
    {
      lineId: "line_0003",
      productId: "prod_1",
      productNameSnapshot: "Ichnusa",
      qty: 2,
      unitPriceApplied: 0,
      listPriceAtTime: 0,
      lineTotal: 0,
      variants: {},
      selectedVariantId: null,
      selectedVariantName: null,
      selectedVariantPriceDelta: 0,
      finalLinePrice: 0,
      notes: "",
      allergens: [],
      routeStations: [],
      correctionStatus: "removed",
    },
    {
      lineId: "removed_2",
      productId: "prod_2",
      productNameSnapshot: "prod_2",
      qty: 3,
      unitPriceApplied: 0,
      listPriceAtTime: 0,
      lineTotal: 0,
      variants: {},
      selectedVariantId: null,
      selectedVariantName: null,
      selectedVariantPriceDelta: 0,
      finalLinePrice: 0,
      notes: "",
      allergens: [],
      routeStations: [],
      correctionStatus: "removed",
    },
  ]);
});

test("buildCorrectionPrintAnnotations applica fallback sicuri su input non valido", () => {
  assert.equal(buildCorrectionPrintAnnotations(null).addedByLineId.size, 0);
  assert.equal(buildCorrectionPrintAnnotations({ removedItems: [{ qty: -4 }] }).removedLines[0].qty, 1);
  assert.equal(
    buildCorrectionPrintAnnotations({ removedItems: [{ lineId: "", productName: "" }] }).removedLines[0]
      .productNameSnapshot,
    "Articolo"
  );
});
