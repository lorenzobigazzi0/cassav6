import assert from "node:assert/strict";
import test from "node:test";

import { createAuthHandlers } from "../auth/auth.handlers.js";
import { createSessionStatusWriteModel } from "../auth/session-status-write-model.js";

function sessionFixture(clientApp = "mobile-frontend") {
  const user = { id: "user-1", username: "mario" };
  const session = {
    id: "session-1",
    userId: user.id,
    deviceUuid: "device-1",
    clientApp,
    workstationId: clientApp === "postazione" ? "" : null,
    stationName: clientApp === "postazione" ? "BAR-1" : null,
    lastSeenAt: "2026-09-01T10:00:00.000Z",
  };
  return {
    db: {
      users: [user],
      sessions: [session],
      integration: { stationStates: [{ id: "station-1", updatedAt: "old" }] },
      meta: {},
    },
    session,
    user,
  };
}

test("[BE][P2b] auth.sessionStatus richiede il retry persistente senza mutare il DB autenticato", async () => {
  const { db, user } = sessionFixture("postazione");
  const events = [];
  const { refreshSessionStatus } = createSessionStatusWriteModel({
    normalizeClientApp: (value) => String(value ?? ""),
    readDb: async () => {
      throw new Error("readDb inatteso con authenticatedDb");
    },
    rememberVolatileSession: async () => events.push("redis"),
    touchSessionHeartbeat(nextDb) {
      nextDb.sessions[0].lastSeenAt = "2026-09-01T10:01:00.000Z";
      return true;
    },
    validateSessionContext: (nextDb) => ({ user, session: nextDb.sessions[0] }),
    writeDb: async () => events.push("write"),
  });

  const result = await refreshSessionStatus({
    authenticatedDb: db,
    clientApp: "postazione",
    fastPath: true,
    payload: { deviceUuid: "device-1" },
  });

  assert.deepEqual(result, { outcome: "retry_persistently" });
  assert.equal(db.sessions[0].lastSeenAt, "2026-09-01T10:00:00.000Z");
  assert.deepEqual(events, []);
});

test("[BE][P2b] auth.sessionStatus conserva fallback, metriche e ordine Redis dopo persistenza", async () => {
  const { db, session, user } = sessionFixture();
  const events = [];
  const { refreshSessionStatus } = createSessionStatusWriteModel({
    normalizeClientApp: (value) => String(value ?? ""),
    nowIso: () => "2026-09-01T10:02:00.000Z",
    readDb: async (options) => {
      events.push(["read", options]);
      return db;
    },
    refreshPostazioneStationStateFromSessionHeartbeat: () => false,
    rememberVolatileSession: async () => events.push(["redis"]),
    touchSessionHeartbeat: () => true,
    validateSessionContext: () => ({ user, session }),
    writeAuthSessionFastDb: async (_nextDb, options) => {
      events.push(["fast", options]);
      return false;
    },
    writeDb: async (_nextDb, options) => events.push(["write", options]),
  });

  const result = await refreshSessionStatus({
    clientApp: "mobile-frontend",
    payload: { deviceUuid: "device-1" },
  });

  assert.deepEqual(events.map(([name]) => name), ["read", "fast", "write", "redis"]);
  assert.deepEqual(events[0][1], { refreshExternalizedSessions: true });
  assert.deepEqual(events[1][1], {
    metricLabel: "auth.sessionStatus.sessionFastWrite",
    sessionIds: ["session-1"],
  });
  assert.deepEqual(events[2][1], {
    metricLabel: "auth.sessionStatus.appStateWrite",
    splitDomains: ["sessions"],
    sessionsSync: { deleteMissing: false },
  });
  assert.equal(db.meta.lastWriteAt, "2026-09-01T10:02:00.000Z");
  assert.equal(result.outcome, "valid");
  assert.equal(result.preserveIntegrationHotCaches, false);
});

test("[BE][P2b] auth.sessionStatus no-op restituisce il read model e preserva le cache calde", async () => {
  const { db, session, user } = sessionFixture("postazione");
  const events = [];
  const { refreshSessionStatus } = createSessionStatusWriteModel({
    normalizeClientApp: (value) => String(value ?? ""),
    readDb: async () => db,
    rememberVolatileSession: async () => events.push("redis"),
    touchSessionHeartbeat: () => false,
    validateSessionContext: () => ({ user, session }),
    writeDb: async () => events.push("write"),
  });

  const result = await refreshSessionStatus({
    clientApp: "postazione",
    payload: { deviceUuid: "device-1" },
  });

  assert.deepEqual(events, ["redis"]);
  assert.equal(result.preserveIntegrationHotCaches, true);
  assert.deepEqual(result.response, {
    ok: true,
    valid: true,
    userId: "user-1",
    sessionId: "session-1",
    clientApp: "postazione",
    workstationSelectionRequired: true,
    workstationId: null,
    stationName: "BAR-1",
  });
});

test("[BE][P2b] il handler auth.sessionStatus delega il retry senza accessi app-state", async () => {
  const calls = [];
  const req = {
    __authDb: { marker: "authenticated" },
    __authSessionStatusFastPath: true,
  };
  const res = {};
  const handlers = createAuthHandlers({
    readDb: async () => {
      throw new Error("readDb diretto inatteso");
    },
    readJsonBody: async () => ({ clientApp: "postazione", deviceUuid: "device-1" }),
    refreshSessionStatus: async (intent) => {
      calls.push(["refresh", intent]);
      return { outcome: "retry_persistently" };
    },
    resolveClientAppFromRequest: (_req, value) => value,
    retrySessionStatusPersistently: async (nextReq, nextRes) =>
      calls.push(["retry", nextReq, nextRes]),
    sendJson: () => {
      throw new Error("ACK inatteso prima del retry");
    },
    writeDb: async () => {
      throw new Error("writeDb diretto inatteso");
    },
  });

  await handlers.handleAuthSessionStatus(req, res);

  assert.equal(calls[0][0], "refresh");
  assert.deepEqual(calls[0][1], {
    authenticatedDb: req.__authDb,
    clientApp: "postazione",
    fastPath: true,
    payload: { clientApp: "postazione", deviceUuid: "device-1" },
  });
  assert.deepEqual(calls[1], ["retry", req, res]);
});

test("[BE][P2b] il handler auth.sessionStatus invia l'ACK solo dopo il modello", async () => {
  const events = [];
  const response = { ok: true, valid: true, userId: "user-1", sessionId: "session-1" };
  const req = {};
  const handlers = createAuthHandlers({
    readJsonBody: async () => ({ clientApp: "mobile-frontend" }),
    refreshSessionStatus: async () => {
      events.push("model");
      return {
        outcome: "valid",
        preserveIntegrationHotCaches: true,
        response,
      };
    },
    resolveClientAppFromRequest: (_req, value) => value,
    sendJson: (_res, status, body) => events.push(["send", status, body]),
  });

  await handlers.handleAuthSessionStatus(req, {});

  assert.deepEqual(events, ["model", ["send", 200, response]]);
  assert.equal(req.__preserveIntegrationHotCaches, true);
});
