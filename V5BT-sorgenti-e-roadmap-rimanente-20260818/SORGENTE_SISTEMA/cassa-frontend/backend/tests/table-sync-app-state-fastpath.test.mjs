import assert from "node:assert/strict";
import test from "node:test";

import { createTableSyncAppStateFastPath } from "../modules/tables/table-sync-app-state-fastpath.js";

function createHarness(overrides = {}) {
  const calls = [];
  const counters = [];
  const operations = [];
  let refreshed = 0;
  const mysqlDomainsRepository = {
    enabled: true,
    domains: ["posSettings"],
    syncObjectArrayEntriesFromAppState: async (...args) => calls.push(["mysql.table", ...args]),
  };
  const tableStateRepository = {
    enabled: true,
    syncEntriesFromAppState: async (...args) => calls.push(["sqlite.table", ...args]),
  };
  const mysqlAuditEventsRepository = {
    enabled: true,
    syncEntriesFromAppState: async (...args) => calls.push(["mysql.audit", ...args]),
  };
  const auditEventsRepository = {
    enabled: true,
    syncEntriesFromAppState: async (...args) => calls.push(["sqlite.audit", ...args]),
  };
  const write = createTableSyncAppStateFastPath({
    enabled: true,
    dbMode: "mysql",
    mysqlDomainsRepository,
    tableStateRepository,
    mysqlAuditEventsRepository,
    auditEventsRepository,
    prepareTableSyncState: (db) => ({ ...db, prepared: true }),
    refreshHealthSnapshot: () => {
      refreshed += 1;
    },
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
      recordOperation: (category, label) => operations.push([category, label]),
    },
    ...overrides,
  });
  return {
    calls,
    counters,
    operations,
    refreshed: () => refreshed,
    write,
  };
}

test("table sync fast path persiste solo tavolo e audit indicati", async () => {
  const harness = createHarness();
  const db = {
    posSettings: { tables: [{ id: "table-1" }, { id: "table-2" }] },
    auditEvents: [{ id: "audit-1" }],
  };

  const written = await harness.write(db, {
    tableId: "table-1",
    auditEventIds: ["audit-1", "audit-1"],
  });

  assert.equal(written, true);
  assert.deepEqual(harness.calls.map(([label]) => label), [
    "mysql.table",
    "sqlite.table",
    "mysql.audit",
    "sqlite.audit",
  ]);
  assert.equal(harness.calls[0][1].prepared, true);
  assert.deepEqual(harness.calls[0].slice(2), ["posSettings", "tables", ["table-1"]]);
  assert.deepEqual(harness.calls[1][2], ["table-1"]);
  assert.deepEqual(harness.calls[2][2], ["audit-1"]);
  assert.deepEqual(harness.counters, ["tableSyncAppStateFastWrites"]);
  assert.equal(harness.refreshed(), 1);
  assert.ok(harness.operations.some(([category, label]) => category === "tableSyncWrite" && label === "total"));
});

test("table sync fast path usa il fallback prima di scrivere per domini correlati", async () => {
  const harness = createHarness();

  const written = await harness.write(
    { posSettings: { tables: [{ id: "table-1" }] } },
    { tableId: "table-1", requiresFullFallback: true },
  );

  assert.equal(written, false);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.counters, [
    "tableSyncAppStateFastFallbacks",
    "tableSyncAppStateFastFallbackRelatedDomain",
  ]);
  assert.equal(harness.refreshed(), 0);
});

test("table sync fast path non esegue write parziali senza audit writer durevole", async () => {
  const harness = createHarness({
    mysqlAuditEventsRepository: { enabled: false },
  });

  const written = await harness.write(
    { posSettings: { tables: [{ id: "table-1" }] }, auditEvents: [{ id: "audit-1" }] },
    { tableId: "table-1", auditEventIds: ["audit-1"] },
  );

  assert.equal(written, false);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.counters, [
    "tableSyncAppStateFastFallbacks",
    "tableSyncAppStateFastFallbackAuditWriterUnavailable",
  ]);
});

test("table sync fast path propaga gli errori sincroni e non aggiorna la health", async () => {
  const failure = new Error("mysql unavailable");
  const harness = createHarness({
    mysqlDomainsRepository: {
      enabled: true,
      domains: ["posSettings"],
      syncObjectArrayEntriesFromAppState: async () => {
        throw failure;
      },
    },
  });

  await assert.rejects(
    harness.write(
      { posSettings: { tables: [{ id: "table-1" }] } },
      { tableId: "table-1" },
    ),
    (error) => error === failure,
  );
  assert.equal(harness.refreshed(), 0);
  assert.ok(harness.operations.some(([category, label]) => category === "tableSyncWrite" && label === "total"));
});
