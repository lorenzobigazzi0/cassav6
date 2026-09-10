import assert from "node:assert/strict";
import test from "node:test";

import { createOperationsAppStateRepository } from "../modules/operations/index.js";

test("operations repository forwards reads without owning a second snapshot", async () => {
  const snapshot = { meta: { lastWriteAt: "2026-09-10T10:00:00.000Z" } };
  const calls = [];
  const repository = createOperationsAppStateRepository({
    readDb: async (options) => {
      calls.push(options);
      return snapshot;
    },
    writeDb: async () => undefined,
  });

  const result = await repository.read({ preferCache: true });

  assert.equal(result, snapshot);
  assert.deepEqual(calls, [{ preferCache: true }]);
});

test("operations repository forwards the same snapshot and write options", async () => {
  const snapshot = { integration: { stationStates: [] } };
  const calls = [];
  const repository = createOperationsAppStateRepository({
    readDb: async () => snapshot,
    writeDb: async (value, options) => {
      calls.push({ value, options });
      return { persisted: true };
    },
  });

  const result = await repository.write(snapshot, {
    metricLabel: "operations.test.appStateWrite",
    splitDomains: ["integration"],
  });

  assert.deepEqual(result, { persisted: true });
  assert.equal(calls[0].value, snapshot);
  assert.deepEqual(calls[0].options, {
    metricLabel: "operations.test.appStateWrite",
    splitDomains: ["integration"],
  });
});

test("operations repository rejects incomplete infrastructure wiring", () => {
  assert.throws(
    () => createOperationsAppStateRepository({ readDb: async () => ({}) }),
    /requires writeDb/,
  );
  assert.throws(
    () => createOperationsAppStateRepository({ writeDb: async () => undefined }),
    /requires readDb/,
  );
});
