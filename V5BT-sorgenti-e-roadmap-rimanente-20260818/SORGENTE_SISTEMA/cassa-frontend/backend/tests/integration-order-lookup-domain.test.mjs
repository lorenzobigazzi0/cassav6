import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIntegrationOrderLookupIndex,
  buildIntegrationOrderLookupCandidates,
  buildIntegrationOrderTitleFromItems,
  findIntegrationOrderIndexByLookup,
  resolveIntegrationOrderDisplayTitle,
} from "../modules/integration/order-lookup.domain.js";

test("order lookup genera alias robusti per numeri comanda", () => {
  assert.deepEqual(buildIntegrationOrderLookupCandidates("comanda #272"), [
    "comanda #272",
    "272",
    "00272",
  ]);
  assert.deepEqual(buildIntegrationOrderLookupCandidates("order_00272"), [
    "order_00272",
    "00272",
  ]);
  assert.deepEqual(buildIntegrationOrderLookupCandidates(""), []);
});

test("order lookup trova comande con id diretto, hash e prefisso", () => {
  const orders = [{ id: "00023" }, { id: "00272" }, { id: "ABC" }];

  assert.equal(findIntegrationOrderIndexByLookup(orders, "272"), 1);
  assert.equal(findIntegrationOrderIndexByLookup(orders, "#00272"), 1);
  assert.equal(findIntegrationOrderIndexByLookup(orders, "order_00023"), 0);
  assert.equal(findIntegrationOrderIndexByLookup(orders, "missing"), -1);
  assert.equal(findIntegrationOrderIndexByLookup(null, "272"), -1);
});

test("order lookup indicizzato preserva la precedenza dello snapshot", () => {
  const orders = [{ id: "00272" }, { id: "272" }];
  const lookupIndex = buildIntegrationOrderLookupIndex(orders);

  assert.equal(findIntegrationOrderIndexByLookup(orders, "272"), 0);
  assert.equal(findIntegrationOrderIndexByLookup(orders, "272", { lookupIndex }), 0);
  assert.equal(findIntegrationOrderIndexByLookup(orders, "order_272", { lookupIndex }), 0);
});

test("order lookup costruisce titolo da articoli validi", () => {
  const title = buildIntegrationOrderTitleFromItems([
    { qty: 2, name: "Gin Tonic" },
    { quantity: 0, productNameSnapshot: "Acqua" },
    { qty: 1, name: "Reso", voidedAt: "2026-06-05T10:00:00Z" },
    { qty: 1, name: "Sostituzione", lineType: "BAR_CHARGE_REPLACEMENT" },
  ]);

  assert.equal(title, "2x Gin Tonic | 1x Acqua");
});

test("order lookup risolve titolo display con fallback", () => {
  assert.equal(
    resolveIntegrationOrderDisplayTitle({ items: [{ qty: 1, productName: "Caffe" }], title: "Vecchio" }),
    "1x Caffe"
  );
  assert.equal(resolveIntegrationOrderDisplayTitle({ items: [], title: "Titolo storico" }), "");
  assert.equal(resolveIntegrationOrderDisplayTitle({ items: [], title: "Titolo storico" }, "Titolo storico"), "Titolo storico");
  assert.equal(resolveIntegrationOrderDisplayTitle({ items: [] }, "Fallback"), "Fallback");
});
