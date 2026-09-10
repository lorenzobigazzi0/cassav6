import assert from "node:assert/strict";
import test from "node:test";
import { createSmartReadModel } from "../modules/smart/smart-read-model.js";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createModel(state, calls = []) {
  return createSmartReadModel({
    HttpError,
    SMART_CARD_ALLOW_MOCK_FALLBACK: false,
    SMART_CARD_READ_TIMEOUT_MS: 5_000,
    clampSmartCardReadTimeout: (value) => Math.min(Math.max(value, 100), 10_000),
    nowIso: () => "2026-09-10T12:00:00.000Z",
    async readDb() {
      calls.push("read");
      return state;
    },
    sanitizeSmartCustomerForResponse(customer) {
      return { ...customer };
    },
    sanitizeSmartNonFiscalEntry(entry) {
      return entry?.valid === false ? null : { ...entry };
    },
    validateSessionContext(db, payload) {
      calls.push(`auth:${payload.token}`);
      assert.equal(db, state);
    },
    waitForSmartCardDetection: async () => ({
      chipCode: "CARD-01",
      detectedAt: "2026-09-10T11:59:59.000Z",
    }),
  });
}

test("smart reader ordina i clienti e autentica sullo snapshot letto", async () => {
  const calls = [];
  const state = {
    smartCustomers: [
      { id: "2", firstName: "Zeno", lastName: "Bianchi" },
      { id: "1", firstName: "Anna", lastName: "Bianchi" },
    ],
  };
  const model = createModel(state, calls);

  const result = await model.listCustomers({ token: "sessione" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.customers.map(({ id }) => id), ["1", "2"]);
  assert.deepEqual(calls, ["read", "auth:sessione"]);
  assert.deepEqual(state.smartCustomers.map(({ id }) => id), ["2", "1"]);
});

test("smart reader autentica e restituisce la rilevazione card", async () => {
  const calls = [];
  const model = createModel({}, calls);

  const result = await model.readCard({ token: "sessione", waitMs: 250 });

  assert.deepEqual(result, {
    ok: true,
    chipCode: "CARD-01",
    detectedAt: "2026-09-10T11:59:59.000Z",
  });
  assert.deepEqual(calls, ["read", "auth:sessione"]);
});

test("smart reader normalizza, ordina e limita le registrazioni non fiscali", async () => {
  const state = {
    smartNonFiscal: [
      { id: "invalid", valid: false, createdAt: "2026-09-10T12:00:00.000Z" },
      ...Array.from({ length: 205 }, (_, index) => ({
        id: `entry-${index}`,
        createdAt: new Date(Date.UTC(2026, 8, 10, 0, index)).toISOString(),
      })),
    ],
  };
  const model = createModel(state);

  const result = await model.listNonFiscalEntries({ token: "sessione" });

  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 200);
  assert.equal(result.entries[0].id, "entry-204");
  assert.equal(result.entries.at(-1).id, "entry-5");
  assert.equal(result.entries.some(({ id }) => id === "invalid"), false);
});

test("smart reader inizializza le collezioni legacy mancanti senza persistere", async () => {
  const state = {};
  const model = createModel(state);

  assert.deepEqual((await model.listCustomers({ token: "sessione" })).customers, []);
  assert.deepEqual((await model.listNonFiscalEntries({ token: "sessione" })).entries, []);
  assert.deepEqual(state.smartCustomers, []);
  assert.deepEqual(state.smartNonFiscal, []);
});
