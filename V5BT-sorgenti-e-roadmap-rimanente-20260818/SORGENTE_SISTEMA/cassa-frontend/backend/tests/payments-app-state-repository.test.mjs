import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentsAppStateRepository } from "../modules/payments/index.js";

function createInfrastructure(overrides = {}) {
  return {
    readDb: async () => ({}),
    writeDb: async () => undefined,
    ...overrides,
  };
}

test("payments repository forwards generic reads and writes without caching", async () => {
  const snapshot = { payments: [] };
  const calls = [];
  const repository = createPaymentsAppStateRepository(
    createInfrastructure({
      readDb: async (options) => {
        calls.push({ kind: "read", options });
        return snapshot;
      },
      writeDb: async (value, options) => {
        calls.push({ kind: "write", value, options });
        return "written";
      },
    }),
  );

  assert.equal(await repository.read({ forceReload: true }), snapshot);
  assert.equal(await repository.write(snapshot, { splitDomains: ["payments"] }), "written");
  assert.equal(calls[1].value, snapshot);
});

test("payments repository preserves the automatic-cash split guard", async () => {
  const snapshot = { posSettings: { automaticCash: {} } };
  const calls = [];
  const repository = createPaymentsAppStateRepository(
    createInfrastructure({
      readAutomaticCashDb: async (options) => {
        calls.push({ kind: "automatic-read", options });
        return snapshot;
      },
      writeAutomaticCashDb: async (value) => {
        calls.push({ kind: "automatic-write", value });
        return true;
      },
    }),
  );

  assert.equal(await repository.readAutomaticCash({ refresh: true }), snapshot);
  assert.equal(await repository.writeAutomaticCash(snapshot), true);
  assert.deepEqual(calls.map((entry) => entry.kind), ["automatic-read", "automatic-write"]);
});

test("payments repository delegates counter collection and its scoped fallback", async () => {
  const snapshot = { paymentContainers: [] };
  const mutation = { paymentContainerIds: ["pc-1"] };
  const calls = [];
  const specialized = createPaymentsAppStateRepository(
    createInfrastructure({
      writeCounterCollectionDb: async (value, nextMutation) => {
        calls.push({ kind: "specialized", value, mutation: nextMutation });
        return true;
      },
    }),
  );

  assert.equal(await specialized.writeCounterCollection(snapshot, mutation, {}), true);

  const fallbackOptions = { splitDomains: ["paymentContainers"] };
  const fallback = createPaymentsAppStateRepository(
    createInfrastructure({
      writeDb: async (value, options) => {
        calls.push({ kind: "fallback", value, options });
        return false;
      },
    }),
  );
  assert.equal(await fallback.writeCounterCollection(snapshot, mutation, fallbackOptions), false);
  assert.equal(calls[0].mutation, mutation);
  assert.equal(calls[1].options, fallbackOptions);
});

test("payments repository rejects incomplete infrastructure wiring", () => {
  assert.throws(
    () => createPaymentsAppStateRepository({ readDb: async () => ({}) }),
    /requires writeDb/,
  );
  assert.throws(
    () => createPaymentsAppStateRepository({ writeDb: async () => undefined }),
    /requires readDb/,
  );
});
