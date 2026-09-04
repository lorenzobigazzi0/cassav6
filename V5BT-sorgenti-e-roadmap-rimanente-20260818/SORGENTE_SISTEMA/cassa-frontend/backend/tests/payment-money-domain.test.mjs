import test from "node:test";
import assert from "node:assert/strict";
import { createPaymentMoneyHelpers } from "../modules/payments/payment-money.domain.js";

const helpers = createPaymentMoneyHelpers({
  normalizeUsername: (value) => String(value ?? "").trim().toLowerCase(),
  roundMoney: (value) => Math.round((Number(value) || 0) * 100) / 100,
});

test("payment money converte importi in centesimi con clamp legacy", () => {
  assert.equal(helpers.moneyToCents(1.235), 124);
  assert.equal(helpers.moneyToCents("7.50"), 750);
  assert.equal(helpers.moneyToCents(-2), 0);
  assert.equal(helpers.moneyToCents("non-numero"), 0);
});

test("payment money converte centesimi in euro arrotondati", () => {
  assert.equal(helpers.centsToMoney(751), 7.51);
  assert.equal(helpers.centsToMoney(751.9), 7.51);
  assert.equal(helpers.centsToMoney(-100), 0);
  assert.equal(helpers.centsToMoney("abc"), 0);
});

test("payment money normalizza bill ids", () => {
  assert.deepEqual(helpers.normalizePaymentBillIds([" a ", "b", "a", "", null]), ["a", "b"]);
  assert.deepEqual(helpers.normalizePaymentBillIds("a"), []);
});

test("payment money trova linea per lineId, productId o nome", () => {
  const bill = {
    lines: [
      { lineId: "line_1", productId: "prod_1", name: "Gin Tonic" },
      { id: "line_2", productId: "prod_2", productName: "Caffe" },
      { id: "line_3", itemName: "Acqua" },
    ],
  };

  assert.equal(helpers.findPaymentBillLine(bill, { lineId: "line_1" })?.productId, "prod_1");
  assert.equal(helpers.findPaymentBillLine(bill, { productId: "prod_2" })?.id, "line_2");
  assert.equal(helpers.findPaymentBillLine(bill, { name: " acqua " })?.id, "line_3");
  assert.equal(helpers.findPaymentBillLine(bill, { name: "missing" }), null);
  assert.equal(helpers.findPaymentBillLine(null, { lineId: "line_1" }), null);
});
