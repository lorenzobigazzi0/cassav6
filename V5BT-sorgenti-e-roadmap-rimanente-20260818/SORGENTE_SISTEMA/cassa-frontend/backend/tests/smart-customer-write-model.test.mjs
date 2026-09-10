import assert from "node:assert/strict";
import test from "node:test";
import { createSmartCustomerWriteModel } from "../modules/smart/smart-customer-write-model.js";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createHarness(customers = []) {
  const state = { meta: {}, smartCustomers: customers };
  const writes = [];
  let tick = 0;
  const model = createSmartCustomerWriteModel({
    HttpError,
    nowIso: () => `2026-09-10T12:00:0${tick++}.000Z`,
    randomUUID: () => "12345678-90ab-cdef-1234-567890abcdef",
    readDb: async () => state,
    sanitizeSmartCustomer: (customer) => ({ ...customer, active: customer.active !== false }),
    sanitizeSmartCustomerForResponse: (customer) => ({ ...customer }),
    validateSessionContext: () => ({ user: { id: "admin", username: "Admin" } }),
    writeDb: async (db) => writes.push(structuredClone(db)),
  });
  return { model, state, writes };
}

test("smart customer writer crea e persiste un cliente normalizzato", async () => {
  const { model, state, writes } = createHarness();

  const result = await model.upsertCustomer({
    customer: { firstName: " Anna ", lastName: " Rossi ", phone: " 333 " },
  });

  assert.equal(result.ok, true);
  assert.equal(result.updatedBy, "Admin");
  assert.equal(result.customer.id, "smart_cli_1234567890");
  assert.equal(result.customer.firstName, "Anna");
  assert.equal(result.customer.lastName, "Rossi");
  assert.equal(result.customer.phone, "333");
  assert.equal(state.smartCustomers.length, 1);
  assert.equal(writes.length, 1);
});

test("smart customer writer aggiorna senza cambiare createdAt", async () => {
  const { model, state } = createHarness([
    { id: "customer-1", firstName: "Prima", lastName: "Persona", phone: "1", createdAt: "originale" },
  ]);

  await model.upsertCustomer({
    customer: { id: "customer-1", firstName: "Dopo", lastName: "Persona", phone: "2" },
  });

  assert.equal(state.smartCustomers[0].firstName, "Dopo");
  assert.equal(state.smartCustomers[0].createdAt, "originale");
});

test("smart customer writer elimina logicamente dalla collezione e persiste", async () => {
  const { model, state, writes } = createHarness([
    { id: "customer-1" },
    { id: "customer-2" },
  ]);

  const result = await model.deleteCustomer({ customerId: "customer-1" });

  assert.deepEqual(result, { ok: true, customerId: "customer-1" });
  assert.deepEqual(state.smartCustomers.map(({ id }) => id), ["customer-2"]);
  assert.equal(writes.length, 1);
});

test("smart customer writer non persiste input invalidi o clienti mancanti", async () => {
  const { model, writes } = createHarness();

  await assert.rejects(
    model.upsertCustomer({ customer: { firstName: "", lastName: "Rossi", phone: "333" } }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    model.deleteCustomer({ customerId: "missing" }),
    (error) => error.status === 404,
  );
  assert.equal(writes.length, 0);
});
