import test from "node:test";
import assert from "node:assert/strict";
import {
  applyIntegrationVariantDeltaToBasePrice,
  collectIntegrationVariantMarkers,
  normalizeIntegrationVariantData,
  readIntegrationVariantDeltaCandidate,
  resolveIntegrationLineExplicitVariantDelta,
  resolveIntegrationLineSupplementMarkerDelta,
} from "../modules/integration/order-line-variants.domain.js";

test("integration order line variants raccoglie marker diretti e alias legacy", () => {
  assert.deepEqual(
    collectIntegrationVariantMarkers({
      variant: "Tonic",
      variantName: "Gin premium",
      variantId: "drink_premium_tonic",
      variant_id: "legacy_tonic",
    }),
    ["Tonic", "Gin premium", "drink_premium_tonic", "legacy_tonic"]
  );
});

test("integration order line variants visita oggetti annidati, array e flag booleani", () => {
  assert.deepEqual(
    collectIntegrationVariantMarkers({
      selectedVariant: {
        id: "premium",
        name: "Premium",
        extra: {
          label: "Tonica secca",
          tonic: true,
        },
      },
      variants: [
        { key: "supplemento", value: "Menu Apericena" },
        { label: "Lime", priceDelta: 0.5 },
      ],
    }),
    [
      "premium",
      "Premium",
      "id",
      "name",
      "Tonica secca",
      "label",
      "tonic",
      "Menu Apericena",
      "supplemento",
      "key",
      "value",
      "Lime",
      "priceDelta",
      "0.5",
    ]
  );
});

test("integration order line variants deduplica e ignora valori vuoti", () => {
  assert.deepEqual(
    collectIntegrationVariantMarkers({
      variant: "Tonic",
      variantName: " Tonic ",
      selected_variant: {
        id: "",
        name: null,
        label: "Tonic",
      },
      variants: [null, "", "Sour", "Sour"],
    }),
    ["Tonic", "id", "label", "Sour"]
  );
  assert.deepEqual(collectIntegrationVariantMarkers(null), []);
});

test("integration order line variants normalizza varianti da nome legacy", () => {
  assert.deepEqual(normalizeIntegrationVariantData(null, " Premium "), { label: "Premium" });
  assert.deepEqual(normalizeIntegrationVariantData(undefined, ""), {});
  assert.deepEqual(normalizeIntegrationVariantData(undefined, "   "), {});
});

test("integration order line variants clona varianti oggetto o array", () => {
  const rawObject = { label: "Premium", nested: { priceDelta: 2 } };
  const normalizedObject = normalizeIntegrationVariantData(rawObject, "Fallback");
  assert.deepEqual(normalizedObject, rawObject);
  assert.notEqual(normalizedObject, rawObject);
  assert.notEqual(normalizedObject.nested, rawObject.nested);

  const rawArray = [{ label: "Tonic" }];
  const normalizedArray = normalizeIntegrationVariantData(rawArray, "Fallback");
  assert.deepEqual(normalizedArray, rawArray);
  assert.notEqual(normalizedArray, rawArray);
});

test("integration order line variants ritorna oggetto vuoto per varianti non serializzabili", () => {
  const circular = {};
  circular.self = circular;
  assert.deepEqual(normalizeIntegrationVariantData(circular, "Fallback"), {});
});

test("integration order line variants legge delta diretto e ignora valori nulli o negativi", () => {
  assert.equal(readIntegrationVariantDeltaCandidate("€ 2,50"), 2.5);
  assert.equal(readIntegrationVariantDeltaCandidate("1.234,50"), 1234.5);
  assert.equal(readIntegrationVariantDeltaCandidate(0), 0);
  assert.equal(readIntegrationVariantDeltaCandidate(-1), 0);
  assert.equal(readIntegrationVariantDeltaCandidate("non prezzo"), 0);
  assert.equal(
    resolveIntegrationLineExplicitVariantDelta({
      variantPriceDelta: 0,
      variant_delta: "3,40",
      modifierPriceDelta: 5,
    }),
    3.4
  );
});

test("integration order line variants legge delta da variante annidata", () => {
  assert.equal(
    resolveIntegrationLineExplicitVariantDelta({
      selectedVariant: {
        extraPrice: "1,20",
      },
      selected_variant: {
        priceDelta: 9,
      },
    }),
    1.2
  );
  assert.equal(
    resolveIntegrationLineExplicitVariantDelta({
      variants: {
        supplement: "4.50",
      },
    }),
    4.5
  );
});

test("integration order line variants somma delta da array varianti", () => {
  assert.equal(
    resolveIntegrationLineExplicitVariantDelta({
      variants: [
        { priceDelta: 0.5 },
        { extra_price: "1,20" },
        { delta: null },
        { price_delta: "bad" },
      ],
    }),
    1.7
  );
  assert.equal(resolveIntegrationLineExplicitVariantDelta({ variants: [{ priceDelta: 0 }] }), 0);
});

test("integration order line variants legge supplemento da marker variante", () => {
  assert.equal(
    resolveIntegrationLineSupplementMarkerDelta({
      variant: "Drink premium +4",
    }),
    4
  );
  assert.equal(
    resolveIntegrationLineSupplementMarkerDelta({
      variants: [{ label: "Menu Apericena + 2,50" }],
    }),
    2.5
  );
});

test("integration order line variants legge supplemento da note e descrizione", () => {
  assert.equal(
    resolveIntegrationLineSupplementMarkerDelta({
      note: "aggiungi tonica +1,20",
    }),
    1.2
  );
  assert.equal(
    resolveIntegrationLineSupplementMarkerDelta({
      description: "supplemento + 3",
    }),
    3
  );
});

test("integration order line variants non inventa supplementi senza marcatore piu", () => {
  assert.equal(resolveIntegrationLineSupplementMarkerDelta({ note: "supplemento 3" }), 0);
  assert.equal(resolveIntegrationLineSupplementMarkerDelta({ variant: "Tonic" }), 0);
  assert.equal(resolveIntegrationLineSupplementMarkerDelta(null), 0);
});

test("integration order line variants applica delta al prezzo base di catalogo", () => {
  assert.equal(applyIntegrationVariantDeltaToBasePrice(8, 8, 2.5), 10.5);
  assert.equal(applyIntegrationVariantDeltaToBasePrice("8", "8", 1.2), 9.2);
});

test("integration order line variants non raddoppia prezzi gia premium", () => {
  assert.equal(applyIntegrationVariantDeltaToBasePrice(10.5, 8, 2.5), 10.5);
  assert.equal(applyIntegrationVariantDeltaToBasePrice(10.4995, 8, 2.5), 10.5);
});

test("integration order line variants non applica delta se base o delta non validi", () => {
  assert.equal(applyIntegrationVariantDeltaToBasePrice(0, 8, 2.5), 0);
  assert.equal(applyIntegrationVariantDeltaToBasePrice(8, 8, 0), 8);
  assert.equal(applyIntegrationVariantDeltaToBasePrice(8, null, 2.5), 8);
});
