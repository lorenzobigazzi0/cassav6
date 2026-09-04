import assert from "node:assert/strict";
import test from "node:test";

import { isUserAppEnabled, sanitizeUserEnabledAppIds } from "../auth/user-app-access.js";
import { createUsersHandlers } from "../users/users.handlers.js";
import { createUsersListReader } from "../users/users-list-read-model.js";

class TestHttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.status = status;
    this.code = options.code;
  }
}

function normalizeDraft(rawUser) {
  return {
    id: rawUser.id,
    username: rawUser.username,
    normalizedUsername: rawUser.username,
    fullName: rawUser.fullName,
    role: rawUser.role,
    roleLabel: rawUser.roleLabel,
    permissions: rawUser.permissions,
    extraPermissionIds: rawUser.permissions,
    enabledRoomIds: [],
    hasEnabledRoomIds: true,
    authorizedRoomIds: [],
    hasAuthorizedRoomIds: true,
    allowedPaymentMethodIds: [],
    hasAllowedPaymentMethodIds: true,
    groupIds: [],
    hasGroupIds: true,
    workstationIds: [],
    hasWorkstationIds: true,
    enabledAppIds: sanitizeUserEnabledAppIds(rawUser.enabledAppIds),
    hasEnabledAppIds: Array.isArray(rawUser.enabledAppIds),
    waiterPauseSettings: null,
    pin: "",
  };
}

test("[BE][P0] disabilitare Cassa revoca solo la relativa sessione e le cache Redis", async () => {
  const admin = {
    id: "user-admin",
    username: "admin",
    fullName: "Admin",
    role: "admin",
    roleLabel: "Amministratore",
    permissions: ["manage_users"],
    pinHash: "admin-hash",
  };
  const operator = {
    id: "user-operator",
    username: "operatore",
    fullName: "Operatore",
    role: "operator",
    roleLabel: "Operatore",
    permissions: [],
    enabledAppIds: ["cassa", "palmare"],
    pinHash: "operator-hash",
  };
  const adminSession = {
    id: "session-settings",
    userId: admin.id,
    deviceUuid: "device-settings",
    clientApp: "settings-frontend",
  };
  const cassaSession = {
    id: "session-cassa",
    userId: operator.id,
    deviceUuid: "device-cassa",
    clientApp: "cassa-frontend",
  };
  const palmareSession = {
    id: "session-palmare",
    userId: operator.id,
    deviceUuid: "device-palmare",
    clientApp: "mobile-frontend",
  };
  const db = {
    users: [admin, operator],
    userGroups: [],
    sessions: [adminSession, cassaSession, palmareSession],
    posSettings: {},
    meta: {},
  };
  const events = [];
  const payload = {
    users: [
      { ...admin, enabledAppIds: [] },
      { ...operator, enabledAppIds: ["palmare"] },
    ],
    groups: [],
  };
  const handlers = createUsersHandlers({
    POS_PERMISSION_DEFINITIONS: [],
    HttpError: TestHttpError,
    appendAuditEvent: () => {},
    buildAuditActor: () => ({}),
    buildPosSettingsUsersPayload: (nextDb) => ({ ok: true, users: nextDb.users }),
    buildUniqueUserId: () => "unused",
    hashPin: () => {
      throw new Error("hashPin inatteso");
    },
    hasPermission: () => true,
    isUserAppEnabled,
    normalizeSettingsUserDraft: normalizeDraft,
    normalizeSettingsUserGroupDraft: () => null,
    normalizeWaiterPauseSettings: () => ({}),
    nowIso: () => "2026-08-04T12:00:00.000Z",
    readDb: async () => db,
    readJsonBody: async () => payload,
    redisVolatileStore: {
      async deleteAuthSessions(sessions) {
        events.push(["deleteAuthSessions", sessions.map((entry) => entry.id)]);
        return true;
      },
      async deleteSession(session) {
        events.push(["deleteSession", session.sessionId]);
        return true;
      },
    },
    requireAuthSessionCacheInvalidation: () => true,
    resolveSettingsLastWriteAt: () => "",
    resolveSettingsVersion: () => 1,
    sanitizeAuthorizedRoomIds: () => [],
    sanitizeEnabledRoomIds: () => [],
    sanitizeUser: (user) => ({ ...user, pinHash: undefined }),
    sanitizeUserEnabledAppIds,
    sanitizeUserPaymentMethodIds: () => [],
    sendJson: (_res, status) => events.push(["send", status]),
    touchSettingsMetadata: () => {},
    validateSessionContext: () => ({ user: admin, session: adminSession }),
    writeDb: async () => events.push(["writeDb"]),
  });

  await handlers.handleSavePosSettingsUsers({}, {});

  assert.deepEqual(
    db.sessions.map((session) => session.id),
    ["session-settings", "session-palmare"],
  );
  assert.deepEqual(
    db.users.find((user) => user.id === operator.id)?.enabledAppIds,
    ["palmare"],
  );
  assert.deepEqual(events, [
    ["deleteAuthSessions", ["session-cassa"]],
    ["deleteSession", "session-cassa"],
    ["writeDb"],
    ["send", 200],
  ]);
});

function usersListFixture() {
  const admin = {
    id: "user-admin",
    username: "admin",
    fullName: "Admin",
    permissions: ["manage_users"],
    pinHash: "hash-admin",
  };
  const waiter = {
    id: "user-waiter",
    username: "cameriere",
    fullName: "Cameriere",
    permissions: [],
    pinHash: "hash-waiter",
  };
  return {
    admin,
    waiter,
    db: {
      users: [admin, waiter],
      userGroups: [{ id: "group-sala", name: "Sala" }],
      posSettings: { id: "pos" },
      meta: { lastWriteAt: "2026-09-01T10:00:00.000Z", version: 42 },
      sessions: [],
    },
  };
}

function createReaderUnderTest({ db, viewer, permitted, onReadDb = () => {} }) {
  return createUsersListReader({
    POS_PERMISSION_DEFINITIONS: [{ id: "manage_users", label: "Gestione utenti" }],
    buildPosSettingsUsersPayload: (nextDb) => ({
      ok: true,
      users: nextDb.users.map((user) => ({ ...user, pinHash: undefined })),
      groups: nextDb.userGroups,
      permissions: [{ id: "manage_users", label: "Gestione utenti" }],
      lastWriteAt: nextDb.meta.lastWriteAt,
      version: nextDb.meta.version,
    }),
    hasPermission: () => permitted,
    readDb: async () => {
      onReadDb();
      return db;
    },
    resolveSettingsLastWriteAt: (meta) => meta.lastWriteAt,
    resolveSettingsVersion: (meta) => meta.version,
    sanitizeUser: (user) => ({ ...user, pinHash: undefined }),
    validateSessionContext: () => ({ user: viewer }),
  });
}

test("[BE][P0] users.list restituisce la vista completa a chi gestisce gli utenti", async () => {
  const { admin, db } = usersListFixture();
  const { readUsersListView } = createReaderUnderTest({ db, viewer: admin, permitted: true });

  const view = await readUsersListView({});

  assert.equal(view.ok, true);
  assert.equal(view.readOnly, undefined);
  assert.deepEqual(view.users.map((user) => user.id), ["user-admin", "user-waiter"]);
  assert.deepEqual(view.groups, db.userGroups);
  assert.equal(view.lastWriteAt, "2026-09-01T10:00:00.000Z");
  assert.equal(view.version, 42);
});

test("[BE][P0] users.list restituisce la sola vista personale a chi non gestisce gli utenti", async () => {
  const { waiter, db } = usersListFixture();
  const { readUsersListView } = createReaderUnderTest({ db, viewer: waiter, permitted: false });

  const view = await readUsersListView({});

  assert.equal(view.ok, true);
  assert.equal(view.readOnly, true);
  assert.deepEqual(view.users.map((user) => user.id), ["user-waiter"]);
  assert.equal(view.groups, undefined);
  assert.deepEqual(view.permissions, [{ id: "manage_users", label: "Gestione utenti" }]);
  assert.equal(view.lastWriteAt, "2026-09-01T10:00:00.000Z");
  assert.equal(view.version, 42);
});

test("[BE][P0] users.list non espone il PIN in nessuna delle due viste", async () => {
  const { admin, waiter, db } = usersListFixture();
  const completa = await createReaderUnderTest({ db, viewer: admin, permitted: true })
    .readUsersListView({});
  const personale = await createReaderUnderTest({ db, viewer: waiter, permitted: false })
    .readUsersListView({});

  for (const user of [...completa.users, ...personale.users]) {
    assert.equal(user.pinHash, undefined);
  }
  assert.equal(db.users.every((user) => typeof user.pinHash === "string"), true);
});

test("[BE][P0] users.list propaga invariato l'errore di sessione non valida", async () => {
  const { db } = usersListFixture();
  const { readUsersListView } = createUsersListReader({
    POS_PERMISSION_DEFINITIONS: [],
    buildPosSettingsUsersPayload: () => {
      throw new Error("vista completa inattesa");
    },
    hasPermission: () => {
      throw new Error("permesso valutato su sessione non valida");
    },
    readDb: async () => db,
    resolveSettingsLastWriteAt: () => "",
    resolveSettingsVersion: () => 0,
    sanitizeUser: (user) => user,
    validateSessionContext: () => {
      throw new TestHttpError(401, "Sessione login non valida o scaduta.", {
        code: "SESSION_EXPIRED",
      });
    },
  });

  await assert.rejects(readUsersListView({}), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, "SESSION_EXPIRED");
    return true;
  });
});

test("[BE][P0] il handler users.list delega al reader senza leggere l'app-state", async () => {
  const { admin, db } = usersListFixture();
  let readDbDalHandler = 0;
  const { readUsersListView } = createReaderUnderTest({ db, viewer: admin, permitted: true });
  const inviati = [];
  const handlers = createUsersHandlers({
    HttpError: TestHttpError,
    readDb: async () => {
      readDbDalHandler += 1;
      return db;
    },
    readJsonBody: async () => ({ token: "t", deviceUuid: "d" }),
    readUsersListView,
    sendJson: (_res, status, body) => inviati.push([status, body]),
  });

  await handlers.handlePosSettingsUsers({}, {});

  assert.equal(readDbDalHandler, 0);
  assert.equal(inviati.length, 1);
  const [status, body] = inviati[0];
  assert.equal(status, 200);
  assert.deepEqual(body.users.map((user) => user.id), ["user-admin", "user-waiter"]);
});
