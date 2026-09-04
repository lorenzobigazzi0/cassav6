import assert from "node:assert/strict";
import test from "node:test";

import { createWaiterPauseWriter } from "../modules/notifications/waiter-pause-writer.js";

function buildWriter({ enabled = true, fastResult = true } = {}) {
  const calls = [];
  const counters = [];
  const repository = {
    enabled: true,
    syncObjectEntryFromAppState: async () => {},
  };
  const writer = createWaiterPauseWriter({
    enabled,
    dbMode: "mysql",
    mysqlDomainsRepository: repository,
    syncIntegrationObjectFields: async (...args) => calls.push(["integration", ...args]),
    writeSessionAuditFastDb: async (...args) => {
      calls.push(["session-audit", ...args]);
      return fastResult;
    },
    writeNotificationDb: async (...args) => calls.push(["notification", ...args]),
    refreshHealthSnapshot: (db) => calls.push(["health", db]),
    runtimeMetrics: { incrementCounter: (name) => counters.push(name) },
  });
  return { calls, counters, repository, writer };
}

test("waiter pause fastpath sincronizza sessione e audit per ID", async () => {
  const { calls, counters, writer } = buildWriter();
  const db = { integration: { waiterPauses: [], waiterDeferredCalls: [] } };
  const labels = [];

  const result = await writer(db, {
    metricLabel: "waiter.pause.start.appStateWrite",
    sessionIds: ["session-1", "session-1", ""],
    auditEventIds: ["event-1"],
    measure: async (label, action) => {
      labels.push(label);
      return action();
    },
  });

  assert.equal(result.mode, "session-audit-fast");
  assert.deepEqual(labels, ["state.integrationFields", "state.sessionAuditFast"]);
  assert.equal(calls[0][0], "integration");
  assert.deepEqual(calls[0][3], ["waiterPauses", "waiterDeferredCalls", "lastWriteAt"]);
  assert.equal(calls[1][0], "session-audit");
  assert.deepEqual(calls[1][2], {
    sessionIds: ["session-1"],
    auditEventIds: ["event-1"],
  });
  assert.equal(calls[2][0], "health");
  assert.deepEqual(counters, [
    "waiterPauseAppStateSequentialWrites",
    "waiterPauseSessionAuditFastWrites",
  ]);
});

test("waiter pause conserva lo split completo con flag disattivato", async () => {
  const { calls, counters, writer } = buildWriter({ enabled: false });

  const result = await writer({ integration: {} }, { sessionIds: ["session-1"] });

  assert.equal(result.mode, "sequential");
  assert.equal(calls[0][0], "integration");
  assert.equal(calls[1][0], "notification");
  assert.deepEqual(calls[1][2].splitDomains, ["sessions", "auditEvents"]);
  assert.equal("sessionIds" in calls[1][2], false);
  assert.deepEqual(counters, ["waiterPauseAppStateSequentialWrites"]);
});

test("waiter pause ripiega sullo split se il writer per ID rifiuta", async () => {
  const { calls, counters, writer } = buildWriter({ fastResult: false });

  const result = await writer({ integration: {} }, {
    sessionIds: ["session-1"],
    auditEventIds: ["event-1"],
  });

  assert.equal(result.mode, "sequential");
  assert.deepEqual(calls.map(([name]) => name), [
    "integration",
    "session-audit",
    "notification",
    "health",
  ]);
  assert.deepEqual(counters, [
    "waiterPauseAppStateSequentialWrites",
    "waiterPauseSessionAuditFastFallbacks",
  ]);
});

test("waiter pause non invia un secondo writer dopo un errore durevole", async () => {
  const calls = [];
  let failSessionAudit = true;
  const writer = createWaiterPauseWriter({
    enabled: true,
    dbMode: "mysql",
    mysqlDomainsRepository: {
      enabled: true,
      syncObjectEntryFromAppState: async () => {},
    },
    syncIntegrationObjectFields: async () => calls.push("integration"),
    writeSessionAuditFastDb: async () => {
      calls.push("session-audit");
      if (failSessionAudit) throw new Error("write failed");
      return true;
    },
    writeNotificationDb: async () => calls.push("notification"),
    refreshHealthSnapshot: () => calls.push("health"),
  });

  await assert.rejects(
    writer({ integration: {} }, { auditEventIds: ["event-1"] }),
    /write failed/,
  );
  assert.deepEqual(calls, ["integration", "session-audit"]);

  failSessionAudit = false;
  const recovered = await writer(
    { integration: {} },
    { auditEventIds: ["event-1"], skipIntegrationFields: true },
  );
  assert.equal(recovered.mode, "session-audit-recovery");
  assert.deepEqual(calls, ["integration", "session-audit", "session-audit", "health"]);
});

test("waiter pause usa il fallback completo fuori dal MySQL split", async () => {
  const calls = [];
  const counters = [];
  const writer = createWaiterPauseWriter({
    enabled: true,
    dbMode: "json",
    mysqlDomainsRepository: null,
    syncIntegrationObjectFields: async () => assert.fail("writer scoped inatteso"),
    writeSessionAuditFastDb: async () => assert.fail("fastpath inatteso"),
    writeNotificationDb: async (...args) => calls.push(args),
    runtimeMetrics: { incrementCounter: (name) => counters.push(name) },
  });

  const result = await writer({ integration: {} });

  assert.equal(result.mode, "full-fallback");
  assert.deepEqual(calls[0][1].splitDomains, ["integration", "sessions", "auditEvents"]);
  assert.deepEqual(counters, ["waiterPauseAppStateFullFallbacks"]);
});
