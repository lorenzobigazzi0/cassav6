import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentRecordNormalization } from "../modules/payments/payment-record-normalization.js";

const normalizeStringList = (value, maxLength = 12, itemMaxLength = 40) => [
  ...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => String(entry ?? "").trim().slice(0, itemMaxLength))
      .filter(Boolean),
  ),
].slice(0, maxLength);

const normalization = createPaymentRecordNormalization({
  CASH_DENOM_DIRECTIONS: new Set(["IN", "OUT"]),
  PAYMENT_CONTAINER_STATUSES: new Set(["OPEN", "COMPLETED", "VOIDED"]),
  PAYMENT_METHOD_TYPES: new Set(["CASH", "POS", "OTHER"]),
  PAYMENT_PART_STATUSES: new Set(["PENDING", "PAID", "CANCELLED"]),
  clampInt: (value, min, max, fallback = min) => {
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? Math.min(Math.max(Math.trunc(parsed), min), max)
      : fallback;
  },
  cloneJson: (value, fallback = null) => {
    try {
      return structuredClone(value);
    } catch {
      return fallback;
    }
  },
  normalizePaymentContinuationSplitMode: (value) =>
    ["amount", "roman", "items"].includes(value) ? value : null,
  normalizePaymentOrderIdList: (value) =>
    normalizeStringList(value, 1000, 120),
  normalizePaymentSplitType: (value) =>
    ["FULL", "PARTIAL"].includes(String(value ?? "").toUpperCase())
      ? String(value).toUpperCase()
      : "FULL",
  normalizeStringList,
  nowIso: () => "2026-08-06T10:00:00.000Z",
  roundMoney: (value) => Math.round((Number(value) || 0) * 100) / 100,
  sanitizePaymentAdminAdjustmentRecord: (value) =>
    value && typeof value === "object" ? { kind: String(value.kind ?? "") } : null,
});

test("payment record normalizza riferimenti e metadati cassa automatica", () => {
  const container = normalization.sanitizePaymentContainerRecord(
    {
      id: "container_1",
      tableId: " table_4 ",
      orderId: "order_1",
      orderIds: ["order_1", "order_2"],
      billIds: ["bill_1", "bill_1", "bill_2"],
      status: "completed",
      splitType: "partial",
      splitMode: "amount",
      amount: 12.345,
      paymentSource: "automatic-cash",
      automaticCashOperationId: " op_1 ",
      articleUnitIds: ["unit_1", "unit_1", "unit_2"],
      adminAdjustment: { kind: "discount" },
    },
    "fallback",
  );

  assert.equal(container.id, "container_1");
  assert.equal(container.tableId, "table_4");
  assert.deepEqual(container.orderIds, ["order_1", "order_2"]);
  assert.deepEqual(container.billIds, ["bill_1", "bill_2"]);
  assert.equal(container.status, "COMPLETED");
  assert.equal(container.splitType, "PARTIAL");
  assert.equal(container.splitMode, "amount");
  assert.equal(container.amount, 12.35);
  assert.equal(container.paymentSource, "automatic_cash");
  assert.equal(container.cashSource, "automatic");
  assert.equal(container.automaticCashPaymentOperationId, "op_1");
  assert.deepEqual(container.articleUnitIds, ["unit_1", "unit_2"]);
  assert.deepEqual(container.adminAdjustment, { kind: "discount" });

  assert.equal(normalization.mapPaymentMethodToTransactionType("pay_cash", ""), "CASH");
  assert.equal(normalization.mapPaymentMethodToTransactionType("", "Carta"), "POS");
  assert.equal(normalization.mapPaymentMethodToTransactionType("voucher", "Buono"), "OTHER");
});

test("payment item, transaction e tracking arrays applicano gli invarianti", () => {
  const variants = { size: "large" };
  const item = normalization.sanitizePaymentItem({
    name: " Pizza ",
    qty: 2,
    unitPrice: 8,
    selectedVariant: { name: "Grande", price: 9.5 },
    vatRate: 10,
    variants,
    articleUnitIds: ["u1", "u2"],
  });
  variants.size = "small";
  assert.equal(item.name, "Pizza");
  assert.equal(item.unitPriceApplied, 9.5);
  assert.equal(item.lineTotal, 19);
  assert.equal(item.variantName, "Grande");
  assert.deepEqual(item.variants, { size: "large" });

  const transaction = normalization.sanitizePaymentTransactionRecord({
    id: "tx_1",
    partId: "part_1",
    method: "cash",
    amountPaid: 20,
    cashGiven: 25,
    changeGiven: 5,
    cashOperationId: "cash_1",
  });
  assert.equal(transaction.method, "CASH");
  assert.equal(transaction.paymentSource, "automatic_cash");
  assert.equal(transaction.automaticCashPaymentOperationId, "cash_1");

  const denom = normalization.sanitizeCashTxDenomRecord({
    txId: "tx_1",
    direction: "out",
    denomCents: 1000,
    qty: 2,
  }, "denom_1");
  assert.deepEqual(denom, {
    id: "denom_1",
    txId: "tx_1",
    direction: "OUT",
    denomCents: 1000,
    qty: 2,
  });

  const db = {};
  normalization.ensurePaymentTrackingArrays(db);
  assert.deepEqual(db, {
    paymentContainers: [],
    paymentParts: [],
    paymentTransactions: [],
    cashTxDenoms: [],
  });
});
