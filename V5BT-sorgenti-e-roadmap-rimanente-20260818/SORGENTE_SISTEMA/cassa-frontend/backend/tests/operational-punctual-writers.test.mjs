import assert from "node:assert/strict";
import test from "node:test";

import { createOperationalPunctualWriters } from "../modules/integration/operational-punctual-writers.js";

function createHarness(overrides = {}) {
  const calls = [];
  const counters = [];
  let healthRefreshes = 0;
  const repository = {
    enabled: true,
    async syncDomainArrayEntriesFromAppState(...args) {
      calls.push(["domainArray", ...args]);
    },
    async syncObjectArrayEntriesAndObjectEntriesFromAppState(...args) {
      calls.push(["objectEntries", ...args]);
    },
  };
  const writers = createOperationalPunctualWriters({
    dbMode: "mysql",
    repository,
    syncSessionEntries: async (...args) => calls.push(["sessions", ...args]),
    syncPosSettingsTables: async (...args) => calls.push(["tables", ...args]),
    syncIntegrationObjectFields: async (...args) => calls.push(["integrationFields", ...args]),
    syncAuditEvents: async (...args) => calls.push(["audit", ...args]),
    syncPrintSpoolEntries: async (...args) => calls.push(["printSpool", ...args]),
    refreshHealthSnapshot: (db) => {
      healthRefreshes += 1;
      calls.push(["health", db]);
    },
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
    },
    ...overrides,
  });
  return {
    calls,
    counters,
    healthRefreshes: () => healthRefreshes,
    repository,
    writers,
  };
}

test("roomSession persiste soltanto utenti e sessioni richiesti", async () => {
  const harness = createHarness();
  const db = { marker: "room-session" };

  assert.equal(await harness.writers.roomSession(db, {
    userIds: [" user-2 ", "user-1", "user-2", ""],
    sessionIds: ["session-1", " session-1 ", null],
  }), true);

  assert.deepEqual(harness.calls, [
    ["domainArray", db, "users", ["user-2", "user-1"]],
    ["sessions", db, ["session-1"]],
    ["health", db],
  ]);
  assert.deepEqual(harness.counters, ["roomSessionPunctualWrites"]);
  assert.equal(harness.healthRefreshes(), 1);
});

test("reservation persiste stato, tavoli e gruppi correlati", async () => {
  const harness = createHarness();
  const db = { marker: "reservation" };

  assert.equal(await harness.writers.reservation(db, {
    reservationStateKeys: ["state-a", " state-a ", "state-b"],
    tableIds: ["table-2", "table-1", "table-2"],
    integrationTableGroupsChanged: true,
  }), true);

  assert.deepEqual(harness.calls, [
    ["domainArray", db, "posReservationStates", ["state-a", "state-b"]],
    ["tables", db, ["table-2", "table-1"]],
    ["integrationFields", harness.repository, db, ["tableGroups", "lastWriteAt"]],
    ["health", db],
  ]);
  assert.deepEqual(harness.counters, ["reservationPunctualWrites"]);
});

test("reservation richiede fallback conservativo prima di qualsiasi scrittura", async () => {
  const harness = createHarness();

  assert.equal(await harness.writers.reservation({}, {
    reservationStateKeys: ["state-a"],
    tableIds: ["table-1"],
    integrationTableGroupsChanged: true,
    requiresFullFallback: true,
  }), false);

  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.counters, []);
  assert.equal(harness.healthRefreshes(), 0);
});

test("tableMove persiste tavoli, ordini, audit e spool puntuali", async () => {
  const harness = createHarness();
  const db = { marker: "table-move" };

  assert.equal(await harness.writers.tableMove(db, {
    tableIds: ["source", " target ", "source"],
    orderIds: ["order-2", "order-1", "order-2"],
    auditEventIds: ["audit-1", " audit-1 "],
    printJobIds: ["print-1", "print-2", "print-1"],
  }), true);

  assert.deepEqual(harness.calls, [
    ["tables", db, ["source", "target"]],
    ["objectEntries", db, "integration", {
      objectArrayEntries: [{ fieldName: "orders", entryIds: ["order-2", "order-1"] }],
      objectFields: ["lastWriteAt"],
    }],
    ["audit", db, ["audit-1"]],
    ["printSpool", db, ["print-1", "print-2"]],
    ["health", db],
  ]);
  assert.deepEqual(harness.counters, ["tableMovePunctualWrites"]);
});

test("tableMove rifiuta fallback e cardinalita tavoli non sicura senza side effect", async () => {
  const fallbackHarness = createHarness();
  assert.equal(await fallbackHarness.writers.tableMove({}, {
    tableIds: ["source", "target"],
    requiresFullFallback: true,
  }), false);
  assert.deepEqual(fallbackHarness.calls, []);

  const cardinalityHarness = createHarness();
  assert.equal(await cardinalityHarness.writers.tableMove({}, {
    tableIds: ["source", "source"],
  }), false);
  assert.deepEqual(cardinalityHarness.calls, []);
  assert.deepEqual(cardinalityHarness.counters, []);
});
