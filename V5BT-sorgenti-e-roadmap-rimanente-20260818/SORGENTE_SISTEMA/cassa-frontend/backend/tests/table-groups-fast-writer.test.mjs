import assert from "node:assert/strict";
import test from "node:test";

import { createTableGroupsFastWriter } from "../modules/integration/table-groups-fast-writer.js";

test("table groups persiste solo campi integration, tavoli e spool richiesto", async () => {
  const calls = [];
  const writer = createTableGroupsFastWriter({
    dbMode: "mysql",
    repository: {
      enabled: true,
      syncObjectEntryFromAppState() {},
    },
    syncIntegrationObjectFields: async (_repository, _db, fields) =>
      calls.push(["integration", fields]),
    syncPosSettingsTables: async (_db, tableIds) =>
      calls.push(["tables", tableIds]),
    writePrintSpool: async (_db, ids) => calls.push(["spool", ids]),
    refreshHealthSnapshot: () => calls.push(["health"]),
  });

  assert.equal(
    await writer(
      {},
      {
        printJobsChanged: true,
        printJobIds: [" print-2 ", "print-1", "print-2"],
        tableIds: [" table-2 ", "table-1", "table-2", "", null],
      },
    ),
    true,
  );
  assert.deepEqual(calls, [
    ["integration", ["tableGroups"]],
    ["integration", ["lastWriteAt"]],
    ["tables", ["table-2", "table-1"]],
    ["spool", ["print-2", "print-1"]],
    ["health"],
  ]);
});

test("table groups segnala fallback se il repository non e disponibile", async () => {
  const counters = [];
  const writer = createTableGroupsFastWriter({
    dbMode: "json",
    repository: null,
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
    },
  });

  assert.equal(await writer({}), false);
  assert.deepEqual(counters, ["tableGroupsFastFallbacks"]);
});

test("table groups non riscrive tutti i tavoli senza variazioni finanziarie", async () => {
  let tableSyncCalls = 0;
  const writer = createTableGroupsFastWriter({
    dbMode: "mysql",
    repository: {
      enabled: true,
      syncObjectEntryFromAppState() {},
    },
    syncIntegrationObjectFields: async () => {},
    syncPosSettingsTables: async () => {
      tableSyncCalls += 1;
    },
  });

  assert.equal(await writer({}, { tableIds: [] }), true);
  assert.equal(tableSyncCalls, 0);
});
