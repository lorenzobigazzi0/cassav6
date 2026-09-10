import assert from "node:assert/strict";
import test from "node:test";
import { createSmartTransactionWriteModel } from "../modules/smart/smart-transaction-write-model.js";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function customer(overrides = {}) {
  return {
    id: "customer-1",
    firstName: "Anna",
    lastName: "Rossi",
    active: true,
    cardCode: "CARD-1",
    unifiedCredit: false,
    capabilities: { ingressi_spiaggia: true },
    balances: {
      ingressiSpiaggia: 3,
      barCredit: 10,
      restaurantCredit: 0,
      servicesCredit: 0,
      barDiscountPercent: 0,
      restaurantDiscountPercent: 0,
    },
    passes: [{ id: "pass-1", type: "ingressi_spiaggia", quantity: 3 }],
    accessLog: [],
    transactions: [],
    ...overrides,
  };
}

function createHarness(initialCustomer = customer()) {
  const state = {
    meta: {},
    menuItems: [],
    posSettings: {
      paymentMethods: [{ id: "pay_card", label: "Carta", isFiscal: false }],
    },
    smartCustomers: [initialCustomer],
    smartNonFiscal: [],
    fiscalReceipts: [],
    payments: [],
  };
  const writes = [];
  let uuidCounter = 0;
  const model = createSmartTransactionWriteModel({
    HttpError,
    assertUserPaymentMethodAllowed: () => {},
    computeDaysUntilDate: () => 10,
    computeSmartPassExpiry: () => "2026-09-30T00:00:00.000Z",
    executeFiscalProvider: () => {
      throw new Error("il gateway fiscale non deve essere chiamato in modalita demo");
    },
    findPaymentMethod: (settings, id) =>
      settings.paymentMethods.find((method) => method.id === id),
    formatDateIt: (date) => date.toISOString(),
    isPosDemoModeEnabled: () => true,
    normalizeSmartCardCode: (value) => String(value).trim().toUpperCase(),
    normalizeSmartPass: (pass) => ({ ...pass }),
    nowIso: () => "2026-09-10T18:30:00.000Z",
    randomUUID: () => `00000000-0000-0000-0000-${String(++uuidCounter).padStart(12, "0")}`,
    readDb: async () => state,
    resolveSmartBeachPassCandidates: (current) => ({
      candidates: current.passes
        .map((pass, index) => ({ index, pass }))
        .filter(({ pass }) => pass.quantity > 0),
      hasInvalidWeekday: false,
      hasInvalidSeason: false,
      latestExpiredDate: null,
    }),
    roundMoney: (value) => Math.round(Number(value) * 100) / 100,
    sanitizeFiscalReceipt: (value) => ({ ...value }),
    sanitizePaymentRecord: (value) => ({ ...value }),
    sanitizePosSettings: (value) => value,
    sanitizeSmartCustomer: (value) => ({
      ...value,
      capabilities: { ...value.capabilities },
      balances: { ...value.balances },
      passes: value.passes.map((pass) => ({ ...pass })),
      accessLog: [...value.accessLog],
      transactions: [...value.transactions],
    }),
    sanitizeSmartCustomerForResponse: (value) => structuredClone(value),
    sanitizeSmartNonFiscalEntry: (value) => ({ ...value }),
    validateSessionContext: () => ({ user: { id: "admin-1", username: "Admin" } }),
    writeDb: async (db) => writes.push(structuredClone(db)),
  });
  return { model, state, writes };
}

test("smart transaction writer consuma ingressi e persiste avviso di residuo", async () => {
  const { model, state, writes } = createHarness();

  const result = await model.consumeBeachEntry({ customerId: "customer-1", entries: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.consumedEntries, 2);
  assert.equal(result.remainingEntries, 1);
  assert.equal(result.warnings[0].code, "LOW_ENTRIES");
  assert.equal(state.smartCustomers[0].balances.ingressiSpiaggia, 1);
  assert.equal(state.smartCustomers[0].passes[0].quantity, 1);
  assert.equal(state.smartCustomers[0].accessLog[0].quantity, 2);
  assert.equal(writes.length, 1);
});

test("smart transaction writer ricarica credito e registra pagamento demo", async () => {
  const { model, state, writes } = createHarness();

  const result = await model.rechargeCustomer({
    customerId: "customer-1",
    target: "pagamenti_bar",
    mode: "amount",
    amount: 5.25,
    paymentMethodId: "pay_card",
  });

  assert.equal(result.ok, true);
  assert.equal(result.payment.amount, 5.25);
  assert.equal(result.middleware.responseCode, "SMART_OK");
  assert.equal(state.smartCustomers[0].balances.barCredit, 15.25);
  assert.equal(state.payments.length, 1);
  assert.equal(state.smartNonFiscal.length, 1);
  assert.equal(writes.length, 1);
});

test("smart transaction writer non persiste un consumo superiore al residuo", async () => {
  const { model, writes } = createHarness();

  await assert.rejects(
    model.consumeBeachEntry({ customerId: "customer-1", entries: 4 }),
    (error) => error.status === 409,
  );
  assert.equal(writes.length, 0);
});
