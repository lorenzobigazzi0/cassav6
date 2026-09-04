import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentSmartNormalization } from "../modules/configuration/payment-smart-normalization.js";

const defaults = {
  methods: [
    {
      id: "pay_cash",
      label: "Contanti",
      enabled: true,
      isSmart: false,
      isFiscal: true,
    },
    {
      id: "pay_chip",
      label: "MyConto",
      enabled: true,
      isSmart: true,
      isFiscal: false,
    },
  ],
  terminals: [
    {
      id: "pos_1",
      label: "POS 1",
      enabled: true,
      provider: "mock",
      protocol: "mock",
    },
  ],
};

const normalization = createPaymentSmartNormalization({
  DEFAULT_PAYMENT_METHODS: defaults.methods,
  DEFAULT_PAYMENT_TERMINALS: defaults.terminals,
  DEFAULT_SMART_CASH_SETTINGS: { beachEntryItemId: null, pointsPerEuro: 2 },
  SMART_CAPABILITY_KEYS: ["beach", "bar", "restaurant"],
  normalizeSmartCardCode: (value) =>
    String(value ?? "")
      .trim()
      .toUpperCase(),
  normalizeUserRole: (value) => String(value ?? "").trim().toLowerCase(),
  nowIso: () => "2026-08-06T10:00:00.000Z",
  roundMoney: (value) => Math.round((Number(value) || 0) * 100) / 100,
});

test("payment settings preservano fallback, dedupe e vincoli smart", () => {
  const methods = normalization.sanitizePaymentMethods([
    { id: "pay_chip", label: "Etichetta legacy", enabled: true },
    { id: "custom", label: "Buono", isFiscal: false },
    { id: "custom", label: "Buono aggiornato", enabled: false },
  ]);
  assert.equal(methods.find((entry) => entry.id === "pay_chip")?.label, "MyConto");
  assert.equal(methods.find((entry) => entry.id === "pay_chip")?.isFiscal, false);
  assert.equal(methods.find((entry) => entry.id === "custom")?.enabled, false);
  assert.ok(methods.some((entry) => entry.id === "pay_cash"));

  const terminals = normalization.sanitizePaymentTerminals([
    { id: "lan", label: "  Banco  ", host: " 10.0.0.8 ", protocol: "tcp" },
  ]);
  assert.equal(terminals[0].ipAddress, "10.0.0.8");
  assert.equal(terminals[0].provider, "tcp");
  assert.ok(terminals.some((entry) => entry.id === "pos_1"));

  assert.deepEqual(
    normalization.normalizeSmartCashSettings(
      { beachEntryItemId: "missing", pointsPerEuro: 200 },
      { menuItems: [{ id: "beach" }] },
    ),
    { beachEntryItemId: null, pointsPerEuro: 100 },
  );
});

test("smart customer normalizza credito, cronologia e ruoli senza mutare input", () => {
  const input = {
    id: "customer_1",
    cardCode: " ab-12 ",
    unifiedCredit: true,
    capabilities: { beach: true, unknown: true },
    balances: { barCredit: 4, restaurantCredit: 9.126, servicesCredit: 2 },
    passes: [{ type: "summer", months: [5, 6, 9, 10], weekDays: [0, 2, 8] }],
    accessLog: [
      { id: "old", createdAt: "2026-08-01T10:00:00.000Z", quantity: 1 },
      { id: "new", createdAt: "2026-08-02T10:00:00.000Z", quantity: 2 },
    ],
    transactions: [
      { id: "old", createdAt: "2026-08-01T10:00:00.000Z", description: "A" },
      { id: "new", createdAt: "2026-08-02T10:00:00.000Z", description: "B" },
    ],
  };
  const before = structuredClone(input);
  const customer = normalization.sanitizeSmartCustomer(input, "fallback");

  assert.deepEqual(input, before);
  assert.equal(customer.cardCode, "AB-12");
  assert.deepEqual(customer.capabilities, {
    beach: true,
    bar: false,
    restaurant: false,
  });
  assert.equal(customer.balances.barCredit, 9.13);
  assert.equal(customer.balances.restaurantCredit, 9.13);
  assert.equal(customer.balances.servicesCredit, 9.13);
  assert.deepEqual(customer.passes[0].months, [6, 9]);
  assert.deepEqual(customer.passes[0].weekDays, [2]);
  assert.deepEqual(customer.accessLog.map((entry) => entry.id), ["new", "old"]);
  assert.deepEqual(customer.transactions.map((entry) => entry.id), ["new", "old"]);
  assert.equal(normalization.resolveAuditActorRole({ role: "RESPONSABILE" }), "MANAGER");
});
