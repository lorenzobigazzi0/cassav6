import assert from "node:assert/strict";
import test from "node:test";
import { createTableRoomMoveRequestAppStateFastPath } from "../modules/table-room-move/table-room-move-request-app-state-fastpath.js";

function createHarness(overrides = {}) {
  const calls = [];
  const counters = [];
  const operations = [];
  let refreshed = 0;
  const repository = {
    enabled: true,
    domains: ["posTableRoomMoveRequests", "integration"],
    syncDomainArrayEntriesFromAppState: async (...args) =>
      calls.push(["request", ...args]),
    syncObjectArrayEntriesAndObjectEntriesFromAppState: async (...args) =>
      calls.push(["integration", ...args]),
    ...overrides.repository,
  };
  const runtimeMetrics = {
    incrementCounter: (name) => counters.push(name),
    recordOperation: (kind, label, durationMs) =>
      operations.push({ kind, label, durationMs }),
  };
  const write = createTableRoomMoveRequestAppStateFastPath({
    enabled: overrides.enabled ?? true,
    dbMode: overrides.dbMode ?? "mysql",
    mysqlDomainsRepository: repository,
    refreshHealthSnapshot: () => {
      refreshed += 1;
    },
    runtimeMetrics,
  });
  const db = {
    posTableRoomMoveRequests: [
      { requestId: "move_1", status: "pending" },
      { requestId: "move_other", status: "pending" },
    ],
    integration: {
      notifications: [{ id: "ntf_1", type: "general" }],
      sequence: { notification: 2 },
      waiterDeferredCalls: [{ id: "deferred_1" }],
      lastWriteAt: "2026-07-13T12:00:00.000Z",
    },
  };
  return {
    calls,
    counters,
    db,
    operations,
    repository,
    write,
    refreshed: () => refreshed,
  };
}

test("table-room-move request fast path persiste richiesta e integrazione puntuali", async () => {
  const harness = createHarness();

  const written = await harness.write(harness.db, {
    requestId: "move_1",
    notificationId: "ntf_1",
  });

  assert.equal(written, true);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0][0], "integration");
  assert.equal(harness.calls[0][2], "integration");
  assert.deepEqual(harness.calls[0][3], {
    objectArrayEntries: [
      { fieldName: "notifications", entryIds: ["ntf_1"] },
    ],
    objectFields: ["sequence", "lastWriteAt"],
  });
  assert.deepEqual(harness.calls[1].slice(0, 4), [
    "request",
    harness.db,
    "posTableRoomMoveRequests",
    ["move_1"],
  ]);
  assert.equal(harness.refreshed(), 1);
  assert.deepEqual(harness.counters, [
    "tableRoomMoveRequestAppStateFastWrites",
  ]);
  assert.deepEqual(
    harness.operations.map(({ kind, label }) => [kind, label]),
    [
      ["tableRoomMoveRequestWrite", "mysql.integration"],
      ["tableRoomMoveRequestWrite", "mysql.request"],
      ["tableRoomMoveRequestWrite", "total"],
    ],
  );
});

test("table-room-move request fast path include le chiamate differite solo quando cambiano", async () => {
  const harness = createHarness();

  const written = await harness.write(harness.db, {
    requestId: "move_1",
    notificationIds: ["ntf_1"],
    deferredCallsChanged: true,
  });

  assert.equal(written, true);
  assert.deepEqual(harness.calls[0][3].objectFields, [
    "sequence",
    "waiterDeferredCalls",
    "lastWriteAt",
  ]);
});

test("table-room-move request fast path fa fallback prima delle write se il prune ha rimosso record", async () => {
  const harness = createHarness();

  const written = await harness.write(harness.db, {
    requestId: "move_1",
    notificationId: "ntf_1",
    requiresFullFallback: true,
  });

  assert.equal(written, false);
  assert.equal(harness.calls.length, 0);
  assert.deepEqual(harness.counters, [
    "tableRoomMoveRequestAppStateFastFallbacks",
    "tableRoomMoveRequestAppStateFastFallbackCollectionPruned",
  ]);
});

test("table-room-move request fast path rifiuta scope incompleti prima delle write", async () => {
  for (const options of [
    { requestId: "missing", notificationId: "ntf_1" },
    { requestId: "move_1", notificationId: "missing" },
    { requestIds: ["move_1", "move_other"], notificationId: "ntf_1" },
  ]) {
    const harness = createHarness();
    assert.equal(await harness.write(harness.db, options), false);
    assert.equal(harness.calls.length, 0);
    assert.deepEqual(harness.counters, [
      "tableRoomMoveRequestAppStateFastFallbacks",
      "tableRoomMoveRequestAppStateFastFallbackInvalidScope",
    ]);
  }
});

test("table-room-move request fast path verifica tutti i writer prima di iniziare", async () => {
  const cases = [
    {
      repository: { syncDomainArrayEntriesFromAppState: undefined },
      counter:
        "tableRoomMoveRequestAppStateFastFallbackRequestWriterUnavailable",
    },
    {
      repository: {
        syncObjectArrayEntriesAndObjectEntriesFromAppState: undefined,
      },
      counter:
        "tableRoomMoveRequestAppStateFastFallbackIntegrationWriterUnavailable",
    },
  ];

  for (const entry of cases) {
    const harness = createHarness({ repository: entry.repository });
    const written = await harness.write(harness.db, {
      requestId: "move_1",
      notificationId: "ntf_1",
    });
    assert.equal(written, false);
    assert.equal(harness.calls.length, 0);
    assert.deepEqual(harness.counters, [
      "tableRoomMoveRequestAppStateFastFallbacks",
      entry.counter,
    ]);
  }
});

test("table-room-move request fast path resta disattivato per default", async () => {
  const harness = createHarness({ enabled: false });

  const written = await harness.write(harness.db, {
    requestId: "move_1",
    notificationId: "ntf_1",
  });

  assert.equal(written, false);
  assert.equal(harness.calls.length, 0);
  assert.deepEqual(harness.counters, [
    "tableRoomMoveRequestAppStateFastFallbacks",
    "tableRoomMoveRequestAppStateFastFallbackRequestWriterUnavailable",
  ]);
});

test("table-room-move request fast path propaga errori dopo l'avvio senza fallback silenzioso", async () => {
  const harness = createHarness({
    repository: {
      syncDomainArrayEntriesFromAppState: async () => {
        throw new Error("mysql unavailable");
      },
    },
  });

  await assert.rejects(
    harness.write(harness.db, {
      requestId: "move_1",
      notificationId: "ntf_1",
    }),
    /mysql unavailable/,
  );
  assert.equal(
    harness.counters.includes("tableRoomMoveRequestAppStateFastFallbacks"),
    false,
  );
  assert.deepEqual(
    harness.operations.map(({ label }) => label),
    ["mysql.integration", "mysql.request", "total"],
  );
});
