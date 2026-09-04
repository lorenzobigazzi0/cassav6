import assert from "node:assert/strict";
import test from "node:test";

import { createAuthHandlers } from "../auth/auth.handlers.js";
import { createLoginWriteModel } from "../auth/login-write-model.js";

class TestHttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.status = status;
    this.code = options.code;
    this.details = options.details;
  }
}

function loginFixture({ sessions = [], posSettings = {} } = {}) {
  const user = {
    id: "user-cassiere",
    username: "cassiere",
    fullName: "Cassiere",
    pinHash: "hash-1234",
    role: "operator",
    roleLabel: "Operatore",
    permissions: [],
    authorizedRoomIds: [],
    enabledRoomIds: [],
  };
  return {
    user,
    db: {
      users: [user],
      sessions,
      posSettings,
      auditEvents: [],
      meta: { lastWriteAt: "2026-08-01T08:00:00.000Z" },
    },
  };
}

function createModelUnderTest({
  db,
  user,
  pinCorretto = true,
  fastWriteOk = false,
  writeAuthSessionFastDb = "auto",
  forgetOk = true,
  hasAdmin = true,
  assertLoginAttemptAllowed = () => {},
  assertUserClientAppAllowed = () => {},
  assertWorkstationLoginAvailable = () => {},
  resolveLoginWorkstationContext = () => null,
  assertUserLoginWorkstationAllowed = (_db, _user, context) => context,
  enforceLoginSessionPolicy = () => 0,
  resolveMobileInitialRoom = () => null,
  resolveUserLoginWorkstations = () => [],
  onReadDb = () => {},
} = {}) {
  const eventi = [];
  const tentativi = [];
  const model = createLoginWriteModel({
    appendAuditEvent: (nextDb, event) => {
      nextDb.auditEvents.push(event);
      eventi.push(["audit", event.action]);
      return { id: "audit-1" };
    },
    assertLoginAttemptAllowed,
    assertUserClientAppAllowed,
    assertUserLoginWorkstationAllowed,
    assertWorkstationLoginAvailable,
    authRepository: {
      getUserByUsername: (nextDb, username) =>
        nextDb.users.find((entry) => entry.username === username),
    },
    buildAuditActor: (actor) => ({ actorId: actor?.id ?? null }),
    buildMissingAdminMessage: () => "Nessun amministratore configurato.",
    buildMobileRoomSettings: () => ({}),
    buildPosRoomListFromSettings: () => [],
    createSession: (userId, deviceUuid, clientApp) => ({
      token: "token-nuovo",
      session: {
        id: "session-nuova",
        userId,
        deviceUuid,
        clientApp,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
    }),
    disconnectMobileNotificationStreams: (identity) => {
      eventi.push(["disconnect", identity.sessionId]);
    },
    enforceLoginSessionPolicy,
    forgetVolatileSessions: async (entries) => {
      eventi.push(["forget", entries.map((entry) => entry.id)]);
      return forgetOk;
    },
    hasAdministrativeUser: () => hasAdmin,
    normalizeClientApp: (clientApp) => String(clientApp ?? ""),
    normalizeUserRole: (role) => role,
    normalizeUsername: (username) => username,
    nowIso: () => "2026-09-01T12:00:00.000Z",
    readDb: async (options) => {
      onReadDb(options);
      return db;
    },
    recordLoginAttempt: (attempt) => tentativi.push(attempt.ok),
    rememberVolatileSession: async (_user, session) => {
      eventi.push(["remember", session.id]);
    },
    resolveDefaultAuthorizedRoomIdsForUser: () => [],
    resolveLoginWorkstationContext,
    resolveMobileInitialRoom,
    resolveUserLoginWorkstations,
    roleLabelFromRole: () => "Operatore",
    sanitizeAuthorizedRoomIds: (value) => value,
    sanitizeEnabledRoomIds: (value) => value,
    sanitizePermissionList: (value) => value ?? [],
    sanitizeUser: (value) => ({ ...value, pinHash: undefined }),
    verifyPin: () => pinCorretto,
    writeAuthSessionFastDb:
      writeAuthSessionFastDb === "auto"
        ? async (_nextDb, options) => {
            eventi.push(["fastWrite", options.metricLabel, options.usersChanged]);
            return fastWriteOk;
          }
        : writeAuthSessionFastDb,
    writeDb: async (_nextDb, options) => {
      eventi.push(["writeDb", options.metricLabel, (options.splitDomains ?? []).join("|")]);
    },
  });
  return { ...model, db, user, eventi, tentativi };
}

const CREDENZIALI = {
  payload: { username: "cassiere" },
  clientApp: "cassa-frontend",
  ipAddress: "10.0.0.1",
  username: "cassiere",
  pin: "1234",
  deviceUuid: "device-cassa",
};

test("[BE][P0] auth.login crea la sessione e usa il fast write quando disponibile", async () => {
  const { db, user } = loginFixture();
  const modello = createModelUnderTest({ db, user, fastWriteOk: true });

  const esito = await modello.login(CREDENZIALI);

  assert.equal(esito.outcome, "logged_in");
  assert.equal(esito.body.ok, true);
  assert.equal(esito.body.token, "token-nuovo");
  assert.equal(esito.body.revokedSessions, 0);
  assert.equal(esito.body.user.pinHash, undefined);
  assert.equal(esito.body.user.id, "user-cassiere");
  assert.equal(esito.body.sessionStartedAt, new Date("2026-09-01T12:00:00.000Z").getTime());
  assert.deepEqual(db.sessions.map((entry) => entry.id), ["session-nuova"]);
  assert.deepEqual(modello.tentativi, [true]);
  assert.deepEqual(modello.eventi, [
    ["forget", []],
    ["audit", "auth.login_success"],
    ["fastWrite", "auth.login.sessionFastWrite", false],
    ["remember", "session-nuova"],
  ]);
});

test("[BE][P0] auth.login ricade su writeDb quando il fast write non scrive", async () => {
  const { db, user } = loginFixture();
  const modello = createModelUnderTest({ db, user, fastWriteOk: false });

  await modello.login(CREDENZIALI);

  assert.deepEqual(modello.eventi, [
    ["forget", []],
    ["audit", "auth.login_success"],
    ["fastWrite", "auth.login.sessionFastWrite", false],
    ["writeDb", "auth.login.appStateWrite", "sessions|users|auditEvents"],
    ["remember", "session-nuova"],
  ]);
});

test("[BE][P0] auth.login revoca le sessioni precedenti e le rimuove dalla cache", async () => {
  const vecchiaMobile = {
    id: "session-vecchia",
    userId: "user-cassiere",
    deviceUuid: "device-cassa",
    clientApp: "mobile-frontend",
  };
  const { db, user } = loginFixture({ sessions: [vecchiaMobile] });
  const modello = createModelUnderTest({
    db,
    user,
    fastWriteOk: true,
    enforceLoginSessionPolicy: (nextDb) => {
      nextDb.sessions = [];
      return 1;
    },
  });

  const esito = await modello.login(CREDENZIALI);

  assert.equal(esito.body.revokedSessions, 1);
  assert.deepEqual(modello.eventi, [
    ["forget", ["session-vecchia"]],
    ["audit", "auth.login_success"],
    ["fastWrite", "auth.login.sessionFastWrite", false],
    ["remember", "session-nuova"],
    ["disconnect", "session-vecchia"],
  ]);
});

test("[BE][P0] auth.login non disconnette gli stream per le revoche non mobile", async () => {
  const vecchiaCassa = {
    id: "session-cassa",
    userId: "user-cassiere",
    deviceUuid: "device-cassa",
    clientApp: "cassa-frontend",
  };
  const { db, user } = loginFixture({ sessions: [vecchiaCassa] });
  const modello = createModelUnderTest({
    db,
    user,
    fastWriteOk: true,
    enforceLoginSessionPolicy: (nextDb) => {
      nextDb.sessions = [];
      return 1;
    },
  });

  await modello.login(CREDENZIALI);

  assert.equal(
    modello.eventi.some(([nome]) => nome === "disconnect"),
    false,
  );
});

test("[BE][P0] auth.login con utente inesistente registra solo l'audit del tentativo", async () => {
  const { db, user } = loginFixture();
  const modello = createModelUnderTest({ db, user });

  const esito = await modello.login({ ...CREDENZIALI, username: "ignoto" });

  assert.deepEqual(esito, {
    outcome: "rejected",
    status: 401,
    error: "Credenziali non valide.",
  });
  assert.deepEqual(modello.tentativi, [false]);
  assert.deepEqual(modello.eventi, [
    ["audit", "auth.login_failed"],
    ["writeDb", "auth.login.failed.appStateWrite", "auditEvents"],
  ]);
  assert.equal(db.auditEvents[0].payload.username, "ignoto");
  assert.equal(db.auditEvents[0].payload.reason, "invalid_credentials");
  assert.equal(db.auditEvents[0].actorId, null);
  assert.deepEqual(db.sessions, []);
});

test("[BE][P0] auth.login con PIN errato registra l'audit con l'attore utente", async () => {
  const { db, user } = loginFixture();
  const modello = createModelUnderTest({ db, user, pinCorretto: false });

  const esito = await modello.login(CREDENZIALI);

  assert.equal(esito.status, 401);
  assert.equal(esito.error, "Credenziali non valide.");
  assert.deepEqual(modello.tentativi, [false]);
  assert.deepEqual(modello.eventi, [
    ["audit", "auth.login_failed"],
    ["writeDb", "auth.login.failed.appStateWrite", "auditEvents"],
  ]);
  assert.equal(db.auditEvents[0].actorId, "user-cassiere");
  assert.equal(db.auditEvents[0].payload.username, "cassiere");
  assert.equal(user.pinHash, "hash-1234");
  assert.deepEqual(db.sessions, []);
});

test("[BE][P0] auth.login senza amministratore risponde 503 senza scrivere", async () => {
  const { db, user } = loginFixture();
  const modello = createModelUnderTest({ db, user, hasAdmin: false });

  const esito = await modello.login(CREDENZIALI);

  assert.deepEqual(esito, {
    outcome: "rejected",
    status: 503,
    error: "Nessun amministratore configurato.",
  });
  assert.deepEqual(modello.eventi, []);
  assert.deepEqual(modello.tentativi, []);
});

test("[BE][P0] auth.login propaga status, code e details del rate limit", async () => {
  const { db, user } = loginFixture();
  const modello = createModelUnderTest({
    db,
    user,
    assertLoginAttemptAllowed: () => {
      throw new TestHttpError(429, "Troppi tentativi.", {
        code: "LOGIN_RATE_LIMITED",
        details: { retryAfterMs: 30000 },
      });
    },
  });

  const esito = await modello.login(CREDENZIALI);

  assert.deepEqual(esito, {
    outcome: "rejected",
    status: 429,
    error: "Troppi tentativi.",
    code: "LOGIN_RATE_LIMITED",
    details: { retryAfterMs: 30000 },
  });
  assert.deepEqual(modello.eventi, []);
});

test("[BE][P0] auth.login usa i default quando l'errore non porta status ne messaggio", async () => {
  const { db, user } = loginFixture();
  const modello = createModelUnderTest({
    db,
    user,
    assertUserClientAppAllowed: () => {
      // Un rifiuto senza status ne messaggio deve ricadere sui default del sito.
      throw {};
    },
  });

  const esito = await modello.login(CREDENZIALI);

  assert.equal(esito.status, 403);
  assert.equal(esito.error, "Utente non abilitato per questa applicazione.");
  assert.deepEqual(modello.eventi, []);
  assert.deepEqual(modello.tentativi, []);
});

test("[BE][P0] auth.login rifiuta la postazione occupata senza scrivere", async () => {
  const { db, user } = loginFixture();
  const modello = createModelUnderTest({
    db,
    user,
    assertWorkstationLoginAvailable: () => {
      throw new TestHttpError(409, "Postazione gia in uso.", {
        code: "WORKSTATION_ALREADY_IN_USE",
      });
    },
  });

  const esito = await modello.login({ ...CREDENZIALI, clientApp: "postazione" });

  assert.equal(esito.status, 409);
  assert.equal(esito.code, "WORKSTATION_ALREADY_IN_USE");
  assert.deepEqual(modello.eventi, []);
  assert.deepEqual(modello.tentativi, [true]);
  assert.deepEqual(db.sessions, []);
});

test("[BE][P0] auth.login ripristina le sessioni se la cache non puo essere invalidata", async () => {
  const vecchia = {
    id: "session-vecchia",
    userId: "user-cassiere",
    deviceUuid: "device-cassa",
    clientApp: "cassa-frontend",
  };
  const { db, user } = loginFixture({ sessions: [vecchia] });
  const modello = createModelUnderTest({
    db,
    user,
    forgetOk: false,
    enforceLoginSessionPolicy: (nextDb) => {
      nextDb.sessions = [];
      return 1;
    },
  });

  const esito = await modello.login(CREDENZIALI);

  assert.deepEqual(esito, {
    outcome: "rejected",
    status: 503,
    error: "Impossibile aggiornare in sicurezza le sessioni. Riprova tra poco.",
    code: "SESSION_CACHE_INVALIDATION_UNAVAILABLE",
  });
  assert.deepEqual(db.sessions, [vecchia]);
  assert.deepEqual(modello.eventi, [["forget", ["session-vecchia"]]]);
});

test("[BE][P0] auth.login Postazione espone selezione, allowlist e postazione scelta", async () => {
  const { db, user } = loginFixture();
  const senzaPostazione = createModelUnderTest({
    db,
    user,
    fastWriteOk: true,
    resolveUserLoginWorkstations: () => [{ id: "ws-bar", name: "Bar" }],
  });

  const primo = await senzaPostazione.login({ ...CREDENZIALI, clientApp: "postazione" });

  assert.equal(primo.body.workstationSelectionRequired, true);
  assert.deepEqual(primo.body.availableWorkstations, [{ id: "ws-bar", name: "Bar" }]);
  assert.equal(primo.body.selectedWorkstation, null);

  const { db: db2, user: user2 } = loginFixture();
  const conPostazione = createModelUnderTest({
    db: db2,
    user: user2,
    fastWriteOk: true,
    resolveLoginWorkstationContext: () => ({ workstationId: "ws-bar", stationName: "BAR_1" }),
    assertUserLoginWorkstationAllowed: () => ({
      workstationId: "ws-bar",
      name: "Bar",
      stationName: "BAR_1",
    }),
  });

  const secondo = await conPostazione.login({ ...CREDENZIALI, clientApp: "postazione" });

  assert.equal(secondo.body.workstationSelectionRequired, false);
  assert.deepEqual(secondo.body.selectedWorkstation, {
    id: "ws-bar",
    name: "Bar",
    stationName: "BAR_1",
  });
  assert.equal(db2.auditEvents[0].payload.workstationId, "ws-bar");
  assert.equal(db2.auditEvents[0].payload.stationName, "BAR_1");
});

test("[BE][P0] auth.login mobile assegna la sala iniziale autorizzata alla sessione", async () => {
  const { db, user } = loginFixture();
  const modello = createModelUnderTest({
    db,
    user,
    fastWriteOk: true,
    resolveMobileInitialRoom: () => ({
      roomId: "room_sala",
      roomName: "Sala",
      authorized: true,
    }),
  });

  const esito = await modello.login({ ...CREDENZIALI, clientApp: "mobile-frontend" });

  assert.deepEqual(esito.body.initialRoom, {
    roomId: "room_sala",
    roomName: "Sala",
    authorized: true,
  });
  assert.equal(db.sessions[0].roomId, "room_sala");
  assert.equal(db.sessions[0].roomName, "Sala");
});

test("[BE][P0] auth.login mobile non entra in una sala che richiede autorizzazione admin", async () => {
  const { db, user } = loginFixture();
  const modello = createModelUnderTest({
    db,
    user,
    fastWriteOk: true,
    resolveMobileInitialRoom: () => ({
      roomId: "room_privata",
      authorized: true,
      requiresAdminAuth: true,
    }),
  });

  await modello.login({ ...CREDENZIALI, clientApp: "mobile-frontend" });

  assert.equal(db.sessions[0].roomId, undefined);
});

test("[BE][P0] auth.login legge l'app-state una sola volta rinfrescando le sessioni esternalizzate", async () => {
  const { db, user } = loginFixture();
  const letture = [];
  const modello = createModelUnderTest({
    db,
    user,
    fastWriteOk: true,
    onReadDb: (options) => letture.push(options),
  });

  await modello.login(CREDENZIALI);

  assert.deepEqual(letture, [{ refreshExternalizedSessions: true }]);
});

function createHandlerUnderTest({ payload, login }) {
  const inviati = [];
  let accessiAppState = 0;
  const handlers = createAuthHandlers({
    getLoginRequestIp: () => "10.0.0.1",
    login,
    readJsonBody: async () => payload,
    readDb: async () => {
      accessiAppState += 1;
      return {};
    },
    resolveClientAppFromRequest: (_req, clientApp) => clientApp,
    sendJson: (_res, status, body) => inviati.push([status, body]),
    writeDb: async () => {
      accessiAppState += 1;
    },
  });
  return { handlers, inviati, accessiAppState: () => accessiAppState };
}

test("[BE][P0] il handler auth.login rifiuta i body non validi senza toccare il modello", async () => {
  const casi = [
    [{ username: "", pin: "1234", deviceUuid: "d" }, "Inserisci il nome utente."],
    [{ username: "mario", pin: "12", deviceUuid: "d" }, "PIN non valido (4-6 cifre)."],
    [{ username: "mario", pin: "1234", deviceUuid: "" }, "Dispositivo non riconosciuto."],
  ];

  for (const [payload, atteso] of casi) {
    const { handlers, inviati, accessiAppState } = createHandlerUnderTest({
      payload,
      login: async () => {
        throw new Error("write model invocato su body non valido");
      },
    });

    await handlers.handleLogin({}, {});

    assert.deepEqual(inviati, [[400, { ok: false, error: atteso }]]);
    assert.equal(accessiAppState(), 0);
  }
});

test("[BE][P0] il handler auth.login mappa esiti e rifiuti senza leggere l'app-state", async () => {
  const attesi = [
    [
      { outcome: "logged_in", body: { ok: true, token: "t" } },
      200,
      { ok: true, token: "t" },
    ],
    [
      { outcome: "rejected", status: 401, error: "Credenziali non valide." },
      401,
      { ok: false, error: "Credenziali non valide." },
    ],
    [
      {
        outcome: "rejected",
        status: 429,
        error: "Troppi tentativi.",
        code: "LOGIN_RATE_LIMITED",
        details: { retryAfterMs: 30000 },
      },
      429,
      {
        ok: false,
        error: "Troppi tentativi.",
        code: "LOGIN_RATE_LIMITED",
        details: { retryAfterMs: 30000 },
      },
    ],
  ];

  for (const [esito, status, body] of attesi) {
    const chiamate = [];
    const { handlers, inviati, accessiAppState } = createHandlerUnderTest({
      payload: {
        username: " mario ",
        pin: " 1234 ",
        deviceUuid: " device-1 ",
        clientApp: "cassa-frontend",
      },
      login: async (intent) => {
        chiamate.push(intent);
        return esito;
      },
    });

    await handlers.handleLogin({}, {});

    assert.equal(chiamate.length, 1);
    assert.equal(chiamate[0].username, "mario");
    assert.equal(chiamate[0].pin, "1234");
    assert.equal(chiamate[0].deviceUuid, "device-1");
    assert.equal(chiamate[0].clientApp, "cassa-frontend");
    assert.equal(chiamate[0].ipAddress, "10.0.0.1");
    assert.deepEqual(inviati, [[status, body]]);
    assert.equal(accessiAppState(), 0);
  }
});
