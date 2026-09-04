import assert from "node:assert/strict";
import test from "node:test";

import { createNotificationPersistenceWriter } from "../modules/notifications/notification-persistence-writer.js";

function buildWriter({ enabled = true, sessionFastResult = true } = {}) {
  const calls = [];
  const counters = [];
  const repository = {
    enabled: true,
    syncObjectArrayEntriesAndObjectEntriesFromAppState: async (...args) =>
      calls.push(["integration", ...args]),
  };
  const writer = createNotificationPersistenceWriter({
    enabled,
    dbMode: "mysql",
    mysqlDomainsRepository: repository,
    writeSessionAuditFastDb: async (...args) => {
      calls.push(["session", ...args]);
      return sessionFastResult;
    },
    writeNotificationDb: async (...args) => calls.push(["fallback", ...args]),
    refreshHealthSnapshot: (db) => calls.push(["health", db]),
    runtimeMetrics: { incrementCounter: (name) => counters.push(name) },
  });
  return { calls, counters, writer };
}

test("notification writer persiste una nuova notifica e i contatori in un solo bulk", async () => {
  const { calls, counters, writer } = buildWriter();
  const db = { integration: { notifications: [{ id: "ntf_1" }] } };

  const result = await writer(db, {
    notificationIds: ["ntf_1", "ntf_1"],
    integrationObjectFields: ["sequence"],
  });

  assert.equal(result.mode, "punctual");
  assert.equal(calls[0][0], "integration");
  assert.deepEqual(calls[0][3], {
    objectArrayEntries: [
      { fieldName: "notifications", entryIds: ["ntf_1"] },
    ],
    objectFields: ["sequence", "lastWriteAt"],
    replaceObjectArrayFields: [],
  });
  assert.equal(calls[1][0], "health");
  assert.deepEqual(counters, ["notificationPunctualWrites"]);
});

test("notification writer rende atomici ACK, claim e ordine e sincronizza la sola sessione", async () => {
  const { calls, counters, writer } = buildWriter();
  const db = { integration: { notifications: [], orders: [{ id: "ord_1" }] } };

  const result = await writer(db, {
    replaceNotifications: true,
    orderIds: ["ord_1"],
    integrationObjectFields: ["sequence", "recentBellClaims"],
    sessionIds: ["session_1"],
    syncSessions: true,
  });

  assert.equal(result.mode, "punctual-with-session");
  assert.deepEqual(calls[0][3], {
    objectArrayEntries: [{ fieldName: "orders", entryIds: ["ord_1"] }],
    objectFields: ["sequence", "recentBellClaims", "lastWriteAt"],
    replaceObjectArrayFields: ["notifications"],
  });
  assert.equal(calls[1][0], "session");
  assert.deepEqual(calls[1][2], {
    sessionIds: ["session_1"],
    auditEventIds: [],
    updateOnly: true,
  });
  assert.equal(calls[2][0], "health");
  assert.deepEqual(counters, [
    "notificationPunctualWrites",
    "notificationPunctualFullReplacements",
    "notificationPunctualSessionWrites",
  ]);
});

test("notification writer non usa un fallback upsert se manca l'ID heartbeat", async () => {
  const { calls, counters, writer } = buildWriter();

  const result = await writer({ integration: {} }, { syncSessions: true });

  assert.equal(result.mode, "punctual-with-session");
  assert.equal(calls[0][0], "health");
  assert.deepEqual(counters, ["notificationPunctualSessionFallbacks"]);
});

test("notification writer usa il writer completo quando il fast path e disattivato", async () => {
  const { calls, counters, writer } = buildWriter({ enabled: false });

  const result = await writer(
    { integration: {} },
    { notificationIds: ["ntf_1"], syncSessions: true },
  );

  assert.equal(result.mode, "full-fallback");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "fallback");
  assert.deepEqual(calls[0][2].splitDomains, [
    "integration",
    "auditEvents",
  ]);
  assert.deepEqual(counters, ["notificationPunctualFallbacks"]);
});
