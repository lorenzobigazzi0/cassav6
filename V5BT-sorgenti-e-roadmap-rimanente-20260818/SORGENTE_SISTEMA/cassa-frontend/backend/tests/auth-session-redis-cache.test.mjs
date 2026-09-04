import assert from "node:assert/strict";
import test from "node:test";

import { createAuthHandlers } from "../auth/auth.handlers.js";
import { createLoginWriteModel } from "../auth/login-write-model.js";
import { createLogoutWriteModel } from "../auth/logout-write-model.js";
import { createSessionStatusWriteModel } from "../auth/session-status-write-model.js";
import { createVolatileSessionCache } from "../auth/volatile-session-cache.js";

// La cache volatile e stata estratta da createAuthHandlers e viene iniettata dal
// composition root: le fixture la ricostruiscono sullo stesso store finto.
function rememberVolatileSessionFor(
  redisVolatileStore = null,
  requireAuthSessionCacheInvalidation = () => true,
) {
  return createVolatileSessionCache({
    normalizeClientApp: (value) => String(value ?? ""),
    redisVolatileStore,
    requireAuthSessionCacheInvalidation,
  }).rememberVolatileSession;
}

function forgetVolatileSessionsFor(
  redisVolatileStore = null,
  requireAuthSessionCacheInvalidation = () => true,
) {
  return createVolatileSessionCache({
    normalizeClientApp: (value) => String(value ?? ""),
    redisVolatileStore,
    requireAuthSessionCacheInvalidation,
  }).forgetVolatileSessions;
}

function createLogoutFixture({ deleteResult = true } = {}) {
  const events = [];
  const responses = [];
  const user = { id: "user-1", username: "mario" };
  const session = {
    id: "session-1",
    userId: user.id,
    deviceUuid: "device-1",
    tokenHash: "token-hash-1",
    clientApp: "mobile-frontend",
  };
  const db = { sessions: [session], auditEvents: [], meta: {} };
  const logoutRedisVolatileStore = {
    async deleteAuthSessions(entries) {
      events.push("redis-delete");
      assert.deepEqual(entries, [session]);
      return deleteResult;
    },
  };
  const { logout } = createLogoutWriteModel({
    appendAuditEvent() {
      return { id: "audit-1" };
    },
    buildAuditActor: () => ({}),
    forgetVolatileSessions: forgetVolatileSessionsFor(logoutRedisVolatileStore),
    normalizeClientApp: (value) => String(value ?? ""),
    nowIso: () => "2026-07-11T12:00:00.000Z",
    readDb: async () => db,
    validateSessionContext: () => ({ user, session }),
    async writeAuthSessionFastDb(_nextDb, options) {
      events.push("mysql-delete");
      assert.deepEqual(options.deletedSessionIds, [session.id]);
      return true;
    },
    writeDb: async () => {
      throw new Error("writeDb fallback inatteso");
    },
  });
  const handlers = createAuthHandlers({
    logout,
    readJsonBody: async () => ({ token: "token-1", deviceUuid: "device-1" }),
    sendJson(_res, status, body) {
      events.push("send");
      responses.push({ status, body });
    },
  });
  return { db, events, handlers, responses, session };
}

test("[BE][P4] logout invalida Redis prima della sessione MySQL", async () => {
  const fixture = createLogoutFixture();

  await fixture.handlers.handleLogout({}, {});

  assert.deepEqual(fixture.events, ["redis-delete", "mysql-delete", "send"]);
  assert.equal(fixture.responses[0].status, 200);
  assert.equal(fixture.db.sessions.length, 0);
});

test("[BE][P4] logout resta attivo se Redis non conferma la revoca", async () => {
  const fixture = createLogoutFixture({ deleteResult: false });

  await fixture.handlers.handleLogout({}, {});

  assert.deepEqual(fixture.events, ["redis-delete", "send"]);
  assert.equal(fixture.responses[0].status, 503);
  assert.equal(fixture.responses[0].body.code, "SESSION_CACHE_INVALIDATION_UNAVAILABLE");
  assert.deepEqual(fixture.db.sessions, [fixture.session]);
});

test("[BE][P4] session status attende il refresh Redis prima dell'ACK", async () => {
  const events = [];
  const user = { id: "user-1", username: "mario" };
  const session = {
    id: "session-1",
    userId: user.id,
    deviceUuid: "device-1",
    tokenHash: "token-hash-1",
    clientApp: "mobile-frontend",
  };
  const db = { sessions: [session], meta: {} };
  const redisVolatileStore = {
    async storeAuthSession(payload) {
      events.push("redis-store");
      assert.equal(payload.tokenHash, session.tokenHash);
      return true;
    },
  };
  const rememberVolatileSession = rememberVolatileSessionFor(redisVolatileStore);
  const { refreshSessionStatus } = createSessionStatusWriteModel({
    normalizeClientApp: (value) => String(value ?? ""),
    readDb: async () => db,
    rememberVolatileSession,
    touchSessionHeartbeat: () => false,
    validateSessionContext: () => ({ user, session }),
  });
  const handlers = createAuthHandlers({
    normalizeClientApp: (value) => String(value ?? ""),
    readDb: async () => db,
    readJsonBody: async () => ({ token: "token-1", deviceUuid: "device-1" }),
    redisVolatileStore,
    rememberVolatileSession,
    refreshSessionStatus,
    requireAuthSessionCacheInvalidation: () => true,
    resolveClientAppFromRequest: () => "mobile-frontend",
    sendJson(_res, status) {
      events.push("send");
      assert.equal(status, 200);
    },
    touchSessionHeartbeat: () => false,
    validateSessionContext: () => ({ user, session }),
  });

  await handlers.handleAuthSessionStatus({}, {});

  assert.deepEqual(events, ["redis-store", "send"]);
});

test("[BE][P5] session status mobile persiste soltanto la sessione aggiornata", async () => {
  const events = [];
  const user = { id: "user-1", username: "mario" };
  const session = {
    id: "session-1",
    userId: user.id,
    deviceUuid: "device-1",
    tokenHash: "token-hash-1",
    clientApp: "mobile-frontend",
  };
  const db = { sessions: [session], meta: {} };
  const redisVolatileStore = {
    async storeAuthSession() {
      events.push("redis-store");
      return true;
    },
  };
  const rememberVolatileSession = rememberVolatileSessionFor(redisVolatileStore);
  const { refreshSessionStatus } = createSessionStatusWriteModel({
    normalizeClientApp: (value) => String(value ?? ""),
    nowIso: () => "2026-07-16T12:00:00.000Z",
    readDb: async () => db,
    refreshPostazioneStationStateFromSessionHeartbeat: () => false,
    rememberVolatileSession,
    touchSessionHeartbeat: () => true,
    validateSessionContext: () => ({ user, session }),
    async writeAuthSessionFastDb(_nextDb, options) {
      events.push("mysql-session");
      assert.deepEqual(options.sessionIds, [session.id]);
      assert.equal(options.metricLabel, "auth.sessionStatus.sessionFastWrite");
      return true;
    },
    writeDb: async () => {
      throw new Error("writeDb fallback inatteso");
    },
  });
  const handlers = createAuthHandlers({
    normalizeClientApp: (value) => String(value ?? ""),
    nowIso: () => "2026-07-16T12:00:00.000Z",
    readDb: async () => db,
    readJsonBody: async () => ({ token: "token-1", deviceUuid: "device-1" }),
    redisVolatileStore,
    rememberVolatileSession,
    refreshSessionStatus,
    refreshPostazioneStationStateFromSessionHeartbeat: () => false,
    requireAuthSessionCacheInvalidation: () => true,
    resolveClientAppFromRequest: () => "mobile-frontend",
    sendJson(_res, status) {
      events.push("send");
      assert.equal(status, 200);
    },
    touchSessionHeartbeat: () => true,
    validateSessionContext: () => ({ user, session }),
    async writeAuthSessionFastDb(_nextDb, options) {
      events.push("mysql-session");
      assert.deepEqual(options.sessionIds, [session.id]);
      assert.equal(options.metricLabel, "auth.sessionStatus.sessionFastWrite");
      return true;
    },
    writeDb: async () => {
      throw new Error("writeDb fallback inatteso");
    },
  });

  await handlers.handleAuthSessionStatus({}, {});

  assert.deepEqual(events, ["mysql-session", "redis-store", "send"]);
});

test("[BE][P5] session status postazione persiste sessione e station state puntuali", async () => {
  const events = [];
  const user = { id: "user-1", username: "mario" };
  const session = {
    id: "session-1",
    userId: user.id,
    deviceUuid: "device-1",
    tokenHash: "token-hash-1",
    clientApp: "postazione",
  };
  const db = { sessions: [session], integration: { stationStates: [] }, meta: {} };
  const rememberVolatileSession = rememberVolatileSessionFor(null, () => false);
  const refreshStationHeartbeat = (_nextDb, options) => {
    assert.ok(Array.isArray(options.touchedStationStateIds));
    options.touchedStationStateIds.push("BAR_1_user-1_device-1", "BAR_2_user-1_device-1");
    return true;
  };
  const { refreshSessionStatus } = createSessionStatusWriteModel({
    normalizeClientApp: (value) => String(value ?? ""),
    nowIso: () => "2026-08-04T10:00:00.000Z",
    readDb: async () => db,
    refreshPostazioneStationStateFromSessionHeartbeat: refreshStationHeartbeat,
    rememberVolatileSession,
    touchSessionHeartbeat: () => true,
    validateSessionContext: () => ({ user, session }),
    async writeAuthSessionFastDb(_nextDb, options) {
      events.push("mysql-session");
      assert.deepEqual(options.sessionIds, [session.id]);
      return true;
    },
    async writeIntegrationStationPresenceDb(_nextDb, options) {
      events.push("mysql-station-states");
      assert.deepEqual(options.stationStateIds, [
        "BAR_1_user-1_device-1",
        "BAR_2_user-1_device-1",
      ]);
      return true;
    },
    writeDb: async () => {
      throw new Error("writeDb fallback inatteso");
    },
  });
  const handlers = createAuthHandlers({
    normalizeClientApp: (value) => String(value ?? ""),
    nowIso: () => "2026-08-04T10:00:00.000Z",
    readDb: async () => db,
    readJsonBody: async () => ({ token: "token-1", deviceUuid: "device-1" }),
    refreshPostazioneStationStateFromSessionHeartbeat: refreshStationHeartbeat,
    rememberVolatileSession,
    refreshSessionStatus,
    resolveClientAppFromRequest: () => "postazione",
    sendJson(_res, status) {
      events.push("send");
      assert.equal(status, 200);
    },
    touchSessionHeartbeat: () => true,
    validateSessionContext: () => ({ user, session }),
    async writeAuthSessionFastDb(_nextDb, options) {
      events.push("mysql-session");
      assert.deepEqual(options.sessionIds, [session.id]);
      return true;
    },
    async writeIntegrationStationPresenceDb(_nextDb, options) {
      events.push("mysql-station-states");
      assert.deepEqual(options.stationStateIds, [
        "BAR_1_user-1_device-1",
        "BAR_2_user-1_device-1",
      ]);
      return true;
    },
    writeDb: async () => {
      throw new Error("writeDb fallback inatteso");
    },
  });

  await handlers.handleAuthSessionStatus({}, {});

  assert.deepEqual(events, ["mysql-session", "mysql-station-states", "send"]);
});

test("[BE][P4] nuovo login revoca la cache precedente e pubblica la nuova solo dopo MySQL", async () => {
  const events = [];
  const responses = [];
  const user = {
    id: "user-1",
    username: "mario",
    pinHash: "pin-hash",
    role: "admin",
    roleLabel: "Admin",
    permissions: ["manage_users"],
    authorizedRoomIds: [],
    enabledRoomIds: [],
  };
  const previousSession = {
    id: "session-old",
    userId: user.id,
    deviceUuid: "device-1",
    tokenHash: "token-hash-old",
    clientApp: "cassa-frontend",
  };
  const nextSession = {
    id: "session-new",
    userId: user.id,
    deviceUuid: "device-1",
    tokenHash: "token-hash-new",
    clientApp: "cassa-frontend",
    createdAt: "2026-07-11T12:00:00.000Z",
    lastSeenAt: "2026-07-11T12:00:00.000Z",
    expiresAt: "2026-07-12T12:00:00.000Z",
  };
  const db = {
    users: [user],
    sessions: [previousSession],
    posSettings: {},
    meta: {},
  };
  const loginRedisVolatileStore = {
    async deleteAuthSessions(entries) {
      events.push("redis-delete");
      assert.deepEqual(entries, [previousSession]);
      return true;
    },
    async storeAuthSession(payload) {
      events.push("redis-store");
      assert.equal(payload.id, nextSession.id);
      return true;
    },
  };
  const { login } = createLoginWriteModel({
    appendAuditEvent: () => ({ id: "audit-login" }),
    authRepository: { getUserByUsername: () => user },
    buildAuditActor: () => ({}),
    buildMissingAdminMessage: () => "missing admin",
    createSession: () => ({ token: "token-new", session: nextSession }),
    enforceLoginSessionPolicy(nextDb) {
      nextDb.sessions = [];
      return 1;
    },
    forgetVolatileSessions: forgetVolatileSessionsFor(loginRedisVolatileStore),
    hasAdministrativeUser: () => true,
    normalizeClientApp: (value) => String(value ?? ""),
    normalizeUserRole: (value) => value,
    normalizeUsername: (value) => value,
    nowIso: () => "2026-07-11T12:00:00.000Z",
    readDb: async () => db,
    rememberVolatileSession: rememberVolatileSessionFor(loginRedisVolatileStore),
    resolveDefaultAuthorizedRoomIdsForUser: () => [],
    roleLabelFromRole: () => "Admin",
    sanitizeAuthorizedRoomIds: (value) => value,
    sanitizeEnabledRoomIds: (value) => value,
    sanitizePermissionList: (value) => value,
    sanitizeUser: (value) => value,
    verifyPin: () => true,
    async writeAuthSessionFastDb(_nextDb, options) {
      events.push("mysql-write");
      assert.deepEqual(options.sessionIds, [nextSession.id]);
      assert.deepEqual(options.deletedSessionIds, [previousSession.id]);
      return true;
    },
    writeDb: async () => {
      throw new Error("writeDb fallback inatteso");
    },
  });
  const handlers = createAuthHandlers({
    login,
    readJsonBody: async () => ({
      username: "mario",
      pin: "1234",
      deviceUuid: "device-1",
      clientApp: "cassa-frontend",
    }),
    resolveClientAppFromRequest: (_req, value) => value,
    sendJson(_res, status, body) {
      events.push("send");
      responses.push({ status, body });
    },
  });

  await handlers.handleLogin({}, {});

  assert.deepEqual(events, ["redis-delete", "mysql-write", "redis-store", "send"]);
  assert.equal(responses[0].status, 200);
  assert.deepEqual(db.sessions, [nextSession]);
});
