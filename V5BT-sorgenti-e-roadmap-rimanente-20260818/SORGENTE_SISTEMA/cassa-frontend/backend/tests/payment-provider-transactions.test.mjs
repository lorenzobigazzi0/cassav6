import assert from "node:assert/strict";
import test from "node:test";
import {
  PaymentTransactionRepository,
  assertPaymentProviderTransitionAllowed,
  canTransitionPaymentProviderStatus,
  normalizePaymentProviderTransaction,
  normalizePaymentProviderTransactionStatus,
} from "../modules/payments-provider/index.js";

function memoryDb() {
  let db = {
    meta: { lastWriteAt: "2026-05-13T00:00:00.000Z" },
    paymentProviderTransactions: [],
  };
  return {
    readDb: async () => db,
    writeDb: async (next) => {
      db = next;
    },
    snapshot: () => db,
  };
}

test("PaymentTransactionRepository mantiene idempotenza e stato provider generico", () => {
  const db = {
    paymentProviderTransactions: [],
  };
  const repository = new PaymentTransactionRepository({
    now: () => "2026-05-13T10:00:00.000Z",
  });

  const first = repository.createOrGetInDb(db, {
    transactionId: "ptx_1",
    idempotencyKey: "idem-1",
    amount: 12.345,
    currency: "eur",
    paymentMethodId: "cash",
    providerType: "cash",
    linesSnapshot: [{ id: "line_1", total: 12.35 }],
  });
  const second = repository.createOrGetInDb(db, {
    transactionId: "ptx_duplicate",
    idempotencyKey: "idem-1",
    amount: 99,
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(db.paymentProviderTransactions.length, 1);
  assert.equal(second.transaction.transactionId, "ptx_1");
  assert.equal(first.transaction.amount, 12.35);
  assert.equal(first.transaction.currency, "EUR");
});

test("PaymentTransactionRepository deduplica retry provider per transactionId", () => {
  const db = {
    paymentProviderTransactions: [],
  };
  const repository = new PaymentTransactionRepository({
    now: () => "2026-05-13T10:05:00.000Z",
  });

  const first = repository.createOrGetInDb(db, {
    transactionId: "ptx_same_provider_id",
    idempotencyKey: "idem-provider-1",
    amount: 12,
  });
  const retry = repository.createOrGetInDb(db, {
    transactionId: "ptx_same_provider_id",
    idempotencyKey: "idem-provider-retry-different",
    amount: 99,
  });

  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(db.paymentProviderTransactions.length, 1);
  assert.equal(retry.transaction.transactionId, "ptx_same_provider_id");
  assert.equal(retry.transaction.amount, 12);
});

test("PaymentTransactionRepository aggiorna settlement e completa stati terminali", () => {
  const db = {
    paymentProviderTransactions: [],
  };
  const repository = new PaymentTransactionRepository({
    now: () => "2026-05-13T10:30:00.000Z",
  });
  const { transaction } = repository.createOrGetInDb(db, {
    transactionId: "ptx_2",
    idempotencyKey: "idem-2",
    amount: 20,
    providerType: "card",
  });

  const updated = repository.updateInDb(db, transaction.transactionId, {
    status: "settled",
    settlementResponse: { authCode: "OK-1" },
    providerPayload: { terminalId: "T1" },
  });

  assert.equal(updated.status, "settled");
  assert.deepEqual(updated.settlementResponse, { authCode: "OK-1" });
  assert.deepEqual(updated.providerPayload, { terminalId: "T1" });
  assert.equal(updated.completedAt, "2026-05-13T10:30:00.000Z");
});

test("PaymentTransactionRepository normalizza stati provider esterni case-insensitive", () => {
  const db = {
    paymentProviderTransactions: [],
  };
  const repository = new PaymentTransactionRepository({
    now: () => "2026-05-13T10:35:00.000Z",
  });
  const { transaction } = repository.createOrGetInDb(db, {
    transactionId: "ptx_case_status",
    idempotencyKey: "idem-case-status",
    amount: 20,
    providerType: "card",
  });

  const updated = repository.updateInDb(db, transaction.transactionId, {
    status: " SETTLED ",
  });
  const repeated = repository.updateInDb(db, transaction.transactionId, {
    status: "settled",
    providerPayload: { retry: true },
  });

  assert.equal(normalizePaymentProviderTransactionStatus(" Cancelled "), "cancelled");
  assert.equal(canTransitionPaymentProviderStatus("CREATED", "SETTLED"), true);
  assert.equal(updated.status, "settled");
  assert.equal(updated.completedAt, "2026-05-13T10:35:00.000Z");
  assert.equal(repeated.completedAt, "2026-05-13T10:35:00.000Z");
  assert.deepEqual(repeated.providerPayload, { retry: true });
});

test("PaymentTransactionRepository lista solo transazioni da riconciliare", async () => {
  const db = memoryDb();
  const repository = new PaymentTransactionRepository({
    readDb: db.readDb,
    writeDb: db.writeDb,
    now: () => "2026-05-13T11:00:00.000Z",
  });

  await repository.createOrGet({
    transactionId: "ptx_pending",
    idempotencyKey: "idem-pending",
    amount: 10,
    status: "settlement_pending",
  });
  await repository.createOrGet({
    transactionId: "ptx_created",
    idempotencyKey: "idem-created",
    amount: 5,
    status: "created",
  });

  const entries = await repository.listForReconciliation();
  assert.deepEqual(
    entries.map((entry) => entry.transactionId),
    ["ptx_pending"]
  );
});

test("normalizePaymentProviderTransaction forza provider non riconosciuti su manual", () => {
  const normalized = normalizePaymentProviderTransaction({
    id: " ",
    amount: -1,
    providerType: "external-device",
  }, "ptx_legacy");

  assert.equal(normalized.transactionId, "ptx_legacy");
  assert.equal(normalized.providerType, "manual");
  assert.equal(normalized.amount, 0);
});

test("PaymentTransactionRepository blocca regressioni da stati terminali", () => {
  const db = {
    paymentProviderTransactions: [],
  };
  const repository = new PaymentTransactionRepository({
    now: () => "2026-05-13T12:00:00.000Z",
  });
  const { transaction } = repository.createOrGetInDb(db, {
    transactionId: "ptx_terminal",
    idempotencyKey: "idem-terminal",
    amount: 20,
    providerType: "card",
  });

  repository.updateInDb(db, transaction.transactionId, { status: "settlement_pending" });
  repository.updateInDb(db, transaction.transactionId, { status: "settled" });

  assert.throws(
    () => repository.updateInDb(db, transaction.transactionId, { status: "settlement_pending" }),
    /Transizione pagamento provider non ammessa: settled -> settlement_pending/
  );
  assert.equal(canTransitionPaymentProviderStatus("settled", "settlement_pending"), false);
  assert.equal(canTransitionPaymentProviderStatus("settled", "settled"), true);
});

test("payment provider state machine rifiuta stati sconosciuti", () => {
  const db = {
    paymentProviderTransactions: [],
  };
  const repository = new PaymentTransactionRepository({
    now: () => "2026-05-13T12:05:00.000Z",
  });
  const { transaction } = repository.createOrGetInDb(db, {
    transactionId: "ptx_unknown_status",
    idempotencyKey: "idem-unknown-status",
    amount: 20,
    providerType: "card",
  });

  assert.equal(canTransitionPaymentProviderStatus("created", "unknown"), false);
  assert.throws(
    () => assertPaymentProviderTransitionAllowed("created", "unknown"),
    /Transizione pagamento provider non ammessa: created -> unknown/
  );
  assert.throws(
    () => repository.updateInDb(db, transaction.transactionId, { status: "unknown" }),
    /Transizione pagamento provider non ammessa: created -> unknown/
  );
  assert.equal(db.paymentProviderTransactions[0].status, "created");
});

test("payment provider state machine consente override esplicito solo con reason", () => {
  assert.throws(
    () => assertPaymentProviderTransitionAllowed("failed", "settlement_pending", { allowOverride: true }),
    /Transizione pagamento provider non ammessa/
  );
  assert.equal(
    assertPaymentProviderTransitionAllowed("failed", "settlement_pending", {
      allowOverride: true,
      overrideReason: "migration-test",
    }),
    true
  );
});
