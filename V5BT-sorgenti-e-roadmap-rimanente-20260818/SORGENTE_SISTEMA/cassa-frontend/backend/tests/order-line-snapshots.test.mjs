import assert from "node:assert/strict";
import test from "node:test";

import { createIntegrationOrderLineSnapshotHelpers } from "../modules/orders/order-line-snapshots.js";

const { buildIntegrationOrderLineSnapshots } = createIntegrationOrderLineSnapshotHelpers({
  roundMoney: (value) => Math.round((Number(value) || 0) * 100) / 100,
  cloneJson: (value, fallback = null) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  },
  normalizeStringList: (value, maxLength, itemMaxLength) => {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((entry) => String(entry ?? "").trim().slice(0, itemMaxLength)).filter(Boolean))].slice(
      0,
      maxLength
    );
  },
  normalizeIntegrationStationName: (value) => String(value ?? "").trim().toUpperCase(),
});

test("buildIntegrationOrderLineSnapshots aggrega le righe con lo stesso lineId", () => {
  const lines = buildIntegrationOrderLineSnapshots({
    items: [
      {
        lineId: " line_0001 ",
        productId: " prod_gin ",
        productNameSnapshot: "Gin",
        qty: 2,
        unitPriceApplied: 8,
        lineTotal: 16,
        routeStations: [" bar-1 "],
      },
      {
        lineId: "line_0001",
        productNameSnapshot: "Gin",
        qty: 1,
        unitPriceApplied: 8,
        lineTotal: 8,
        routeStations: ["bar-2"],
      },
    ],
  });

  const snapshot = lines.get("line_0001");
  assert.equal(snapshot.qty, 3);
  assert.equal(snapshot.lineTotal, 24);
  assert.equal(snapshot.finalLinePrice, 24);
  assert.equal(snapshot.productId, "prod_gin");
  assert.deepEqual(snapshot.routeStations, ["BAR-1"]);
});

test("buildIntegrationOrderLineSnapshots ignora righe annullate o senza lineId", () => {
  const lines = buildIntegrationOrderLineSnapshots({
    items: [
      { lineId: "line_0001", name: "Valida", qty: 1, unitPriceApplied: 2 },
      { lineId: "line_0002", name: "Annullata", voidedAt: "2026-06-07T10:00:00.000Z", unitPriceApplied: 4 },
      { name: "Senza lineId", unitPriceApplied: 6 },
    ],
  });

  assert.deepEqual([...lines.keys()], ["line_0001"]);
});

test("buildIntegrationOrderLineSnapshots applica fallback compatibili per nomi, prezzi e varianti", () => {
  const lines = buildIntegrationOrderLineSnapshots({
    items: [
      {
        lineId: "line_0001",
        name: "  ",
        qty: 3,
        listPriceAtTime: 1.5,
        variants: { size: "small" },
        variant: " Premium ",
        variantPriceDelta: 0.5,
        note: " Poco ghiaccio ",
      },
    ],
  });

  const snapshot = lines.get("line_0001");
  assert.equal(snapshot.productNameSnapshot, "Articolo");
  assert.equal(snapshot.qty, 3);
  assert.equal(snapshot.unitPriceApplied, 0);
  assert.equal(snapshot.listPriceAtTime, 1.5);
  assert.equal(snapshot.lineTotal, 4.5);
  assert.deepEqual(snapshot.variants, { size: "small" });
  assert.equal(snapshot.selectedVariantName, "Premium");
  assert.equal(snapshot.selectedVariantPriceDelta, 0.5);
  assert.equal(snapshot.notes, "Poco ghiaccio");
});

test("buildIntegrationOrderLineSnapshots normalizza allergeni e postazioni", () => {
  const lines = buildIntegrationOrderLineSnapshots({
    items: [
      {
        lineId: "line_0001",
        name: "Gelato",
        unitPriceApplied: 4,
        allergens: [" Latte ", "Glutine", "Latte"],
        routeStations: [" bar-1 ", "chiringuito-2"],
      },
    ],
  });

  const snapshot = lines.get("line_0001");
  assert.deepEqual(snapshot.allergens, ["Latte", "Glutine"]);
  assert.deepEqual(snapshot.routeStations, ["BAR-1", "CHIRINGUITO-2"]);
});

test("buildIntegrationOrderLineSnapshots non ripristina il listino su un override a zero", () => {
  const lines = buildIntegrationOrderLineSnapshots({
    items: [
      {
        lineId: "line_0001",
        name: "Omaggio rettificato",
        qty: 1,
        unitPriceApplied: 0,
        listPriceAtTime: 10,
        lineTotal: 0,
        priceOverrideApplied: true,
      },
    ],
  });

  const snapshot = lines.get("line_0001");
  assert.equal(snapshot.unitPriceApplied, 0);
  assert.equal(snapshot.listPriceAtTime, 10);
  assert.equal(snapshot.lineTotal, 0);
  assert.equal(snapshot.priceOverrideApplied, true);
});

test("buildIntegrationOrderLineSnapshots gestisce input non valido", () => {
  assert.equal(buildIntegrationOrderLineSnapshots(null).size, 0);
  assert.equal(buildIntegrationOrderLineSnapshots({ items: null }).size, 0);
});
