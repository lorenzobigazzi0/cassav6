import assert from "node:assert/strict";
import test from "node:test";

import { createPostazioneLogoutWriter } from "../modules/integration/postazione-logout-writer.js";

function makeResult(overrides = {}) {
  return {
    changed: true,
    noActiveStationsAlertChanged: true,
    notificationIds: ["notification_offline", "notification_no_active"],
    deactivatedStationStates: [{ recordId: "station_bar_1" }],
    ...overrides,
  };
}

test("postazione logout writer persists station data before session invalidation", async () => {
  const calls = [];
  const counters = [];
  const writer = createPostazioneLogoutWriter({
    resolveStationStateId: (entry) => entry.recordId,
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
    },
    writeStationPresenceDb: async (_db, options) => {
      calls.push(["station", options]);
      return true;
    },
    writeSessionAuditFastDb: async (_db, options) => {
      calls.push(["session", options]);
      return true;
    },
  });

  const written = await writer({}, {
    stationLogoutResult: makeResult(),
    deletedSessionIds: ["session_1"],
    auditEventIds: ["audit_1"],
  });

  assert.equal(written, true);
  assert.deepEqual(calls, [
    [
      "station",
      {
        stationStateIds: ["station_bar_1"],
        notificationIds: ["notification_offline", "notification_no_active"],
        syncNoActiveStationsAlert: true,
      },
    ],
    [
      "session",
      {
        deletedSessionIds: ["session_1"],
        auditEventIds: ["audit_1"],
      },
    ],
  ]);
  assert.deepEqual(counters, ["postazioneLogoutFastWrites"]);
});

test("postazione logout writer leaves the full fallback to the caller", async () => {
  let sessionWrites = 0;
  const counters = [];
  const writer = createPostazioneLogoutWriter({
    resolveStationStateId: (entry) => entry.recordId,
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
    },
    writeStationPresenceDb: async () => false,
    writeSessionAuditFastDb: async () => {
      sessionWrites += 1;
      return true;
    },
  });

  const written = await writer({}, {
    stationLogoutResult: makeResult(),
    deletedSessionIds: ["session_1"],
    auditEventIds: ["audit_1"],
  });

  assert.equal(written, false);
  assert.equal(sessionWrites, 0);
  assert.deepEqual(counters, ["postazioneLogoutFastFallbacks"]);
});

test("postazione logout writer converts partial write errors into a durable fallback", async () => {
  const warnings = [];
  const counters = [];
  const writer = createPostazioneLogoutWriter({
    resolveStationStateId: (entry) => entry.recordId,
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
    },
    writeStationPresenceDb: async () => true,
    writeSessionAuditFastDb: async () => {
      throw new Error("session write failed");
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
  });

  const written = await writer({}, {
    stationLogoutResult: makeResult(),
    deletedSessionIds: ["session_1"],
    auditEventIds: ["audit_1"],
  });

  assert.equal(written, false);
  assert.deepEqual(counters, [
    "postazioneLogoutFastErrors",
    "postazioneLogoutFastFallbacks",
  ]);
  assert.match(warnings[0], /session write failed/);
});
