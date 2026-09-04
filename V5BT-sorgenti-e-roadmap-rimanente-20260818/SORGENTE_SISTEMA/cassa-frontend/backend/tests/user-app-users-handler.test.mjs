import assert from "node:assert/strict";
import test from "node:test";

import { isUserAppEnabled, sanitizeUserEnabledAppIds } from "../auth/user-app-access.js";
import { createUsersHandlers } from "../users/users.handlers.js";
import { createUsersListReader } from "../users/users-list-read-model.js";
import { createUsersSaveWriteModel } from "../users/users-save-write-model.js";

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
  const { saveUsersList } = createUsersSaveWriteModel({
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
    sanitizeAuthorizedRoomIds: () => [],
    sanitizeEnabledRoomIds: () => [],
    sanitizeUser: (user) => ({ ...user, pinHash: undefined }),
    sanitizeUserEnabledAppIds,
    sanitizeUserPaymentMethodIds: () => [],
    touchSettingsMetadata: () => {},
    validateSessionContext: () => ({ user: admin, session: adminSession }),
    writeDb: async () => events.push(["writeDb"]),
  });
  const handlers = createUsersHandlers({
    readJsonBody: async () => payload,
    saveUsersList,
    sendJson: (_res, status) => events.push(["send", status]),
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

// ---------------------------------------------------------------------------
// users.save: il write model e ora l'unico owner dell'app-state della route.
// ---------------------------------------------------------------------------

function saveDraft(rawUser, index) {
  return {
    ...normalizeDraft(rawUser),
    normalizedUsername: String(rawUser.username ?? "").toLowerCase(),
    extraPermissionIds: Array.isArray(rawUser.permissions) ? rawUser.permissions : [],
    groupIds: Array.isArray(rawUser.groupIds) ? rawUser.groupIds : [],
    hasGroupIds: Array.isArray(rawUser.groupIds),
    enabledRoomIds: Array.isArray(rawUser.enabledRoomIds) ? rawUser.enabledRoomIds : [],
    hasEnabledRoomIds: Array.isArray(rawUser.enabledRoomIds),
    authorizedRoomIds: Array.isArray(rawUser.authorizedRoomIds) ? rawUser.authorizedRoomIds : [],
    hasAuthorizedRoomIds: Array.isArray(rawUser.authorizedRoomIds),
    pin: String(rawUser.pin ?? ""),
    indice: index,
  };
}

function saveFixture({ sessions = [], groups = [] } = {}) {
  const admin = {
    id: "user-admin",
    username: "admin",
    fullName: "Admin",
    role: "admin",
    roleLabel: "Amministratore",
    permissions: ["manage_users"],
    pinHash: "hash-admin",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    admin,
    db: {
      users: [admin],
      userGroups: groups,
      sessions,
      posSettings: { id: "pos" },
      meta: {},
    },
  };
}

function createSaveModelUnderTest({ db, admin, groups = [], deleteAuthSessionsOk = true }) {
  const audit = [];
  const scritture = [];
  const model = createUsersSaveWriteModel({
    HttpError: TestHttpError,
    appendAuditEvent: (_db, event) => audit.push(event),
    buildAuditActor: (actor) => ({ actorId: actor.id }),
    buildPosSettingsUsersPayload: (nextDb) => ({ ok: true, users: nextDb.users }),
    buildUniqueUserId: (username) => `user-${username}`,
    hashPin: (pin) => `hash-${pin}`,
    hasPermission: (user) => (user.permissions ?? []).includes("manage_users"),
    isUserAppEnabled,
    normalizeSettingsUserDraft: saveDraft,
    normalizeSettingsUserGroupDraft: (raw) => groups.find((group) => group.id === raw?.id) ?? null,
    normalizeWaiterPauseSettings: () => null,
    nowIso: () => "2026-09-02T12:00:00.000Z",
    readDb: async () => db,
    redisVolatileStore: {
      async deleteAuthSessions() {
        return deleteAuthSessionsOk;
      },
      async deleteSession() {
        return true;
      },
    },
    requireAuthSessionCacheInvalidation: () => true,
    sanitizeAuthorizedRoomIds: (value) => value,
    sanitizeEnabledRoomIds: (value) => value,
    sanitizeUser: (user) => ({ id: user.id, username: user.username, permissions: user.permissions }),
    sanitizeUserEnabledAppIds,
    sanitizeUserPaymentMethodIds: () => [],
    touchSettingsMetadata: (nextDb) => {
      nextDb.meta.touched = true;
    },
    validateSessionContext: () => ({ user: admin }),
    writeDb: async (_nextDb, options) => {
      scritture.push(options);
    },
  });
  return { ...model, audit, scritture };
}

const ADMIN_PAYLOAD = {
  id: "user-admin",
  username: "admin",
  fullName: "Admin",
  role: "admin",
  roleLabel: "Amministratore",
  permissions: ["manage_users"],
};

test("[BE][P0] users.save crea l'utente nuovo con hash del PIN e audit user.created", async () => {
  const { admin, db } = saveFixture();
  const modello = createSaveModelUnderTest({ db, admin });

  const view = await modello.saveUsersList({
    users: [
      ADMIN_PAYLOAD,
      {
        username: "cameriere",
        fullName: "Cameriere",
        role: "operator",
        roleLabel: "Operatore",
        permissions: [],
        pin: "4321",
      },
    ],
  });

  const creato = db.users.find((entry) => entry.username === "cameriere");
  assert.equal(creato.id, "user-cameriere");
  assert.equal(creato.pinHash, "hash-4321");
  assert.equal(creato.createdAt, "2026-09-02T12:00:00.000Z");
  assert.equal(creato.updatedAt, "2026-09-02T12:00:00.000Z");
  assert.deepEqual(modello.audit.map((event) => event.action), ["user.created"]);
  assert.equal(modello.audit[0].entityId, "user-cameriere");
  assert.equal(modello.audit[0].actorId, "user-admin");
  assert.deepEqual(view.users.map((entry) => entry.id), ["user-admin", "user-cameriere"]);
  assert.equal(db.meta.touched, true);
});

test("[BE][P0] users.save non registra user.updated se nulla cambia", async () => {
  const { admin, db } = saveFixture();
  const modello = createSaveModelUnderTest({ db, admin });

  await modello.saveUsersList({ users: [ADMIN_PAYLOAD] });

  assert.deepEqual(modello.audit, []);
  assert.equal(db.users[0].pinHash, "hash-admin");
});

test("[BE][P0] users.save registra security.admin_delete con lo stato precedente", async () => {
  const { admin, db } = saveFixture();
  db.users = [
    admin,
    {
      id: "user-vecchio",
      username: "vecchio",
      fullName: "Vecchio",
      role: "operator",
      roleLabel: "Operatore",
      permissions: [],
      pinHash: "hash-vecchio",
    },
  ];
  const modello = createSaveModelUnderTest({ db, admin });

  await modello.saveUsersList({ users: [ADMIN_PAYLOAD], deleteReason: "cessazione" });

  assert.deepEqual(modello.audit.map((event) => event.action), ["security.admin_delete"]);
  assert.equal(modello.audit[0].entityId, "user-vecchio");
  assert.equal(modello.audit[0].payload.reason, "cessazione");
  assert.deepEqual(modello.audit[0].before, {
    id: "user-vecchio",
    username: "vecchio",
    permissions: [],
  });
  assert.equal(modello.audit[0].after, null);
  assert.deepEqual(db.users.map((entry) => entry.id), ["user-admin"]);
});

test("[BE][P0] users.save protegge l'account attivo e il permesso gestione utenti", async () => {
  const casi = [
    [
      [
        {
          username: "altro",
          fullName: "Altro",
          role: "admin",
          roleLabel: "Admin",
          permissions: ["manage_users"],
          pin: "1111",
        },
      ],
      "Non puoi rimuovere il tuo utente durante una sessione attiva.",
    ],
    [
      [{ ...ADMIN_PAYLOAD, permissions: [] }],
      "Non puoi rimuovere il permesso gestione utenti dal tuo account attivo.",
    ],
  ];

  for (const [users, messaggio] of casi) {
    const { admin, db } = saveFixture();
    const modello = createSaveModelUnderTest({ db, admin });

    await assert.rejects(modello.saveUsersList({ users }), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.message, messaggio);
      return true;
    });
    assert.deepEqual(modello.scritture, []);
    assert.deepEqual(db.users.map((entry) => entry.id), ["user-admin"]);
  }
});

test("[BE][P0] users.save deriva permessi e stanze dai gruppi filtrando le sale non abilitate", async () => {
  const gruppo = {
    id: "group-sala",
    name: "Sala",
    permissions: ["manage_users", "print_orders"],
    enabledRoomIds: ["room_sala"],
    authorizedRoomIds: ["room_sala", "room_terrazza"],
    workstationIds: ["ws_bar"],
  };
  const { admin, db } = saveFixture();
  const modello = createSaveModelUnderTest({ db, admin, groups: [gruppo] });

  await modello.saveUsersList({
    groups: [{ id: "group-sala" }],
    users: [{ ...ADMIN_PAYLOAD, permissions: [], groupIds: ["group-sala"] }],
  });

  const salvato = db.users[0];
  assert.deepEqual(salvato.permissions, ["manage_users", "print_orders"]);
  assert.deepEqual(salvato.enabledRoomIds, ["room_sala"]);
  // room_terrazza arriva dal gruppo ma non e abilitata: va filtrata.
  assert.deepEqual(salvato.authorizedRoomIds, ["room_sala"]);
  assert.deepEqual(salvato.workstationIds, ["ws_bar"]);
  assert.deepEqual(db.userGroups, [gruppo]);
});

test("[BE][P0] users.save rifiuta il salvataggio se la cache sessioni non conferma la revoca", async () => {
  const sessione = {
    id: "session-vecchia",
    userId: "user-vecchio",
    deviceUuid: "device-1",
    clientApp: "cassa-frontend",
  };
  const { admin, db } = saveFixture({ sessions: [sessione] });
  db.users = [admin, { id: "user-vecchio", username: "vecchio", permissions: [], pinHash: "hash-vecchio" }];
  const modello = createSaveModelUnderTest({ db, admin, deleteAuthSessionsOk: false });

  await assert.rejects(modello.saveUsersList({ users: [ADMIN_PAYLOAD] }), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "SESSION_CACHE_INVALIDATION_UNAVAILABLE");
    return true;
  });
  assert.deepEqual(modello.scritture, []);
  assert.deepEqual(db.sessions, [sessione]);
  assert.deepEqual(db.users.map((entry) => entry.id), ["user-admin", "user-vecchio"]);
});

test("[BE][P0] users.save scrive una sola volta con la sincronizzazione sessioni e senza metrica", async () => {
  const { admin, db } = saveFixture();
  const modello = createSaveModelUnderTest({ db, admin });

  await modello.saveUsersList({ users: [ADMIN_PAYLOAD] });

  assert.equal(modello.scritture.length, 1);
  assert.deepEqual(modello.scritture[0], { sessionsSync: { deleteMissing: true } });
  assert.equal("metricLabel" in modello.scritture[0], false);
});

test("[BE][P0] users.save rifiuta una lista vuota prima di leggere l'app-state", async () => {
  const { admin, db } = saveFixture();
  let letture = 0;
  const { saveUsersList } = createUsersSaveWriteModel({
    HttpError: TestHttpError,
    readDb: async () => {
      letture += 1;
      return db;
    },
    validateSessionContext: () => ({ user: admin }),
  });

  await assert.rejects(saveUsersList({ users: [] }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.message, "Lista utenti non valida.");
    return true;
  });
  assert.equal(letture, 0);
});

test("[BE][P0] il handler users.save delega al write model senza leggere l'app-state", async () => {
  const inviati = [];
  const chiamate = [];
  const handlers = createUsersHandlers({
    readJsonBody: async () => ({ users: [ADMIN_PAYLOAD] }),
    saveUsersList: async (payload) => {
      chiamate.push(payload);
      return { ok: true, users: [] };
    },
    sendJson: (_res, status, body) => inviati.push([status, body]),
  });

  await handlers.handleSavePosSettingsUsers({}, {});

  assert.equal(chiamate.length, 1);
  assert.deepEqual(chiamate[0].users, [ADMIN_PAYLOAD]);
  assert.deepEqual(inviati, [[200, { ok: true, users: [] }]]);
});
