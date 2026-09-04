import assert from "node:assert/strict";
import test from "node:test";

import {
  collectArticleUnitIdsFromPaymentItems,
  isAmountStylePaymentContinuationMode,
  normalizePaymentContinuationSplitMode,
  normalizePaymentLineSelections,
  normalizePaymentSplitType,
} from "../modules/payments/payment-splits.js";

test("normalizePaymentSplitType keeps legacy defaults", () => {
  assert.equal(normalizePaymentSplitType("FREE_SPLIT"), "FREE_SPLIT");
  assert.equal(normalizePaymentSplitType("single"), "SINGLE");
  assert.equal(normalizePaymentSplitType("unknown"), "SINGLE");
  assert.equal(normalizePaymentSplitType(null), "SINGLE");
});

test("normalizePaymentContinuationSplitMode resolves explicit and inferred modes", () => {
  assert.equal(normalizePaymentContinuationSplitMode("roman"), "roman");
  assert.equal(normalizePaymentContinuationSplitMode("AMOUNT"), "amount");
  assert.equal(normalizePaymentContinuationSplitMode(""), null);
  assert.equal(normalizePaymentContinuationSplitMode("", { hasLineSelections: true }), "article");
  assert.equal(normalizePaymentContinuationSplitMode("", { articleUnitIds: [" u1 ", "u1"] }), "article");
  assert.equal(normalizePaymentContinuationSplitMode("", { hasRequestedBills: true }), "bill");
  assert.equal(normalizePaymentContinuationSplitMode("", { splitType: "SINGLE" }), "single");
  assert.equal(normalizePaymentContinuationSplitMode("", { splitType: "FREE_SPLIT" }), null);
});

test("isAmountStylePaymentContinuationMode detects roman and amount only", () => {
  assert.equal(isAmountStylePaymentContinuationMode("roman"), true);
  assert.equal(isAmountStylePaymentContinuationMode("amount"), true);
  assert.equal(isAmountStylePaymentContinuationMode("article"), false);
  assert.equal(isAmountStylePaymentContinuationMode("bill"), false);
  assert.equal(isAmountStylePaymentContinuationMode(null), false);
});

test("normalizePaymentLineSelections keeps only valid article selections", () => {
  const valid = { billId: " bill_1 ", lineIndex: 0, qty: 2, keep: true };
  const selections = normalizePaymentLineSelections([
    valid,
    { billId: "", lineIndex: 0, qty: 1 },
    { billId: "bill_2", lineIndex: "x", qty: 1 },
    { billId: "bill_3", lineIndex: 1, qty: 0 },
    null,
  ]);
  assert.deepEqual(selections, [valid]);
});

test("collectArticleUnitIdsFromPaymentItems normalizes and de-duplicates unit ids", () => {
  assert.deepEqual(
    collectArticleUnitIdsFromPaymentItems([
      { articleUnitIds: [" u1 ", "U1", "", "u2"] },
      { articleUnitIds: ["u3"] },
      { articleUnitIds: "not-array" },
    ]),
    ["u1", "u2", "u3"]
  );
});
