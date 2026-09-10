import assert from "node:assert/strict";
import test from "node:test";

import { createSalesAppStateRepository } from "../modules/sales/index.js";

test("sales repository forwards reads and writes without caching", async () => {
  const snapshot = { integration: { orders: [] } };
  const calls = [];
  const repository = createSalesAppStateRepository({
    readDb: async (options) => {
      calls.push({ kind: "read", options });
      return snapshot;
    },
    writeDb: async (value, options) => {
      calls.push({ kind: "write", value, options });
      return "written";
    },
  });

  const readOptions = { refreshExternalizedSessions: true };
  const writeOptions = { splitDomains: ["integration"] };
  assert.equal(await repository.read(readOptions), snapshot);
  assert.equal(await repository.write(snapshot, writeOptions), "written");
  assert.deepEqual(calls, [
    { kind: "read", options: readOptions },
    { kind: "write", value: snapshot, options: writeOptions },
  ]);
});

test("sales repository rejects incomplete infrastructure wiring", () => {
  assert.throws(
    () => createSalesAppStateRepository({ readDb: async () => ({}) }),
    /requires writeDb/,
  );
  assert.throws(
    () => createSalesAppStateRepository({ writeDb: async () => undefined }),
    /requires readDb/,
  );
});
