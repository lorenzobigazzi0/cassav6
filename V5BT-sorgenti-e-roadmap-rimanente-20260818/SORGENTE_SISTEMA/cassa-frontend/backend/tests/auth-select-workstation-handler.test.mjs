import assert from "node:assert/strict";
import test from "node:test";

import { createAuthHandlers } from "../auth/auth.handlers.js";
import { createSelectWorkstationWriteModel } from "../auth/select-workstation-write-model.js";
import { createVolatileSessionCache } from "../auth/volatile-session-cache.js";

class TestHttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.status = status;
    this.code = options.code;
  }
}

const WORKSTATION = {
  workstationId: "ws-bar",
  name: "Bar",
  stationName: "Postazione Bar",
};

function selectFixture({ sessionClientApp = "postazione", workstationId = "" } = {}) {
  const user = { id: "user-cassiere", username: "cassiere" };
  const session = {
    id: "session-postazione",
    userId: user.id,
    deviceUuid: "device-postazione",
    clientApp: sessionClientApp,
    workstationId,
  };
  return {
    user,
    session,
    db: {
      users: [user],
      sessions: [session],
      posSettings: { workstations: [WORKSTATION] },
      auditEvents: [],
      meta: { lastWriteAt: "2026-08-01T08:00:00.000Z" },
    },
  };
}

function createModelUnderTest({
  db,
  user,
  session,
  fastWriteOk = false,
  writeAuthSessionFastDb = "auto",
  validateSessionContext = null,
  assertWorkstationLoginAvailable = () => {},
  assertUserLoginWorkstationAllowed = () => WORKSTATION,
  onReadDb = () => {},
}) {
  const eventi = [];
  const model = createSelectWorkstationWriteModel({
    appendAuditEvent: (nextDb, event) => {
      nextDb.auditEvents.push(event);
      eventi.push(["audit", event.action]);
      return { id: "audit-1" };
    },
    assertUserLoginWorkstationAllowed,
    assertWorkstationLoginAvailable,
    buildAuditActor: (actor) => ({ actorId: actor.id }),
    normalizeClientApp: (clientApp) => String(clientApp ?? ""),
    nowIso: () => "2026-09-01T12:00:00.000Z",
    readDb: async (options) => {
      onReadDb(options);
      return db;
    },
    rememberVolatileSession: async (nextUser, nextSession, clientApp) => {
      eventi.push(["remember", nextSession.workstationId, clientApp]);
    },
    resolveLoginWorkstationContext: () => ({ workstationId: WORKSTATION.workstationId }),
    validateSessionContext: validateSessionContext ?? (() => ({ user, session })),
    writeAuthSessionFastDb:
      writeAuthSessionFastDb === "auto"
        ? async (_nextDb, options) => {
            eventi.push(["fastWrite", options.metricLabel]);
            return fastWriteOk;
          }
        : writeAuthSessionFastDb,
    writeDb: async (_nextDb, options) => {
      eventi.push(["writeDb", options.metricLabel, options.splitDomains.join("|")]);
    },
  });
  return { ...model, eventi };
}

test("[BE][P0] auth.selectWorkstation assegna la postazione e usa il fast write quando disponibile", async () => {
  const { db, user, session } = selectFixture();
  const { selectWorkstation, eventi } = createModelUnderTest({
    db,
    user,
    session,
    fastWriteOk: true,
  });

  const esito = await selectWorkstation({ payload: { token: "t" }, clientApp: "postazione" });

  assert.deepEqual(esito, {
    outcome: "selected",
    selectedWorkstation: { id: "ws-bar", name: "Bar", stationName: "Postazione Bar" },
  });
  assert.equal(session.workstationId, "ws-bar");
  assert.equal(session.stationName, "Postazione Bar");
  assert.equal(session.lastSeenAt, "2026-09-01T12:00:00.000Z");
  assert.equal(db.meta.lastWriteAt, "2026-09-01T12:00:00.000Z");
  assert.deepEqual(eventi, [
    ["audit", "auth.workstation_selected"],
    ["fastWrite", "auth.workstationSelect.sessionFastWrite"],
    ["remember", "ws-bar", "postazione"],
  ]);
});

test("[BE][P0] auth.selectWorkstation ricade su writeDb quando il fast write non scrive", async () => {
  const { db, user, session } = selectFixture();
  const { selectWorkstation, eventi } = createModelUnderTest({
    db,
    user,
    session,
    fastWriteOk: false,
  });

  const esito = await selectWorkstation({ payload: {}, clientApp: "postazione" });

  assert.equal(esito.outcome, "selected");
  assert.deepEqual(eventi, [
    ["audit", "auth.workstation_selected"],
    ["fastWrite", "auth.workstationSelect.sessionFastWrite"],
    ["writeDb", "auth.workstationSelect.appStateWrite", "sessions|auditEvents"],
    ["remember", "ws-bar", "postazione"],
  ]);
});

test("[BE][P0] auth.selectWorkstation scrive con writeDb anche senza fast writer configurato", async () => {
  const { db, user, session } = selectFixture();
  const { selectWorkstation, eventi } = createModelUnderTest({
    db,
    user,
    session,
    writeAuthSessionFastDb: null,
  });

  await selectWorkstation({ payload: {}, clientApp: "postazione" });

  assert.deepEqual(eventi, [
    ["audit", "auth.workstation_selected"],
    ["writeDb", "auth.workstationSelect.appStateWrite", "sessions|auditEvents"],
    ["remember", "ws-bar", "postazione"],
  ]);
});

test("[BE][P0] auth.selectWorkstation rifiuta i client diversi da postazione senza scrivere", async () => {
  const casi = [
    ["postazione", "mobile-frontend"],
    ["mobile-frontend", "postazione"],
  ];

  for (const [clientApp, sessionClientApp] of casi) {
    const { db, user, session } = selectFixture({ sessionClientApp });
    const { selectWorkstation, eventi } = createModelUnderTest({ db, user, session });

    const esito = await selectWorkstation({ payload: {}, clientApp });

    assert.deepEqual(esito, { outcome: "client_not_postazione" });
    assert.deepEqual(eventi, []);
    assert.equal(session.workstationId, "");
  }
});

test("[BE][P0] auth.selectWorkstation chiede il logout se la sessione ha gia un'altra postazione", async () => {
  const { db, user, session } = selectFixture({ workstationId: "ws-sala" });
  const { selectWorkstation, eventi } = createModelUnderTest({ db, user, session });

  const esito = await selectWorkstation({ payload: {}, clientApp: "postazione" });

  assert.deepEqual(esito, { outcome: "change_requires_logout" });
  assert.deepEqual(eventi, []);
  assert.equal(session.workstationId, "ws-sala");
});

test("[BE][P0] auth.selectWorkstation riconferma la stessa postazione gia selezionata", async () => {
  const { db, user, session } = selectFixture({ workstationId: WORKSTATION.workstationId });
  const { selectWorkstation, eventi } = createModelUnderTest({
    db,
    user,
    session,
    fastWriteOk: true,
  });

  const esito = await selectWorkstation({ payload: {}, clientApp: "postazione" });

  assert.equal(esito.outcome, "selected");
  assert.deepEqual(eventi, [
    ["audit", "auth.workstation_selected"],
    ["fastWrite", "auth.workstationSelect.sessionFastWrite"],
    ["remember", "ws-bar", "postazione"],
  ]);
});

test("[BE][P0] auth.selectWorkstation propaga invariati gli errori di sessione e di disponibilita", async () => {
  const { db, user, session } = selectFixture();
  const scaduta = createModelUnderTest({
    db,
    user,
    session,
    validateSessionContext: () => {
      throw new TestHttpError(401, "Sessione login non valida o scaduta.", {
        code: "SESSION_EXPIRED",
      });
    },
  });
  await assert.rejects(
    scaduta.selectWorkstation({ payload: {}, clientApp: "postazione" }),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "SESSION_EXPIRED");
      return true;
    },
  );
  assert.deepEqual(scaduta.eventi, []);

  const occupata = createModelUnderTest({
    db,
    user,
    session,
    assertWorkstationLoginAvailable: () => {
      throw new TestHttpError(409, "Postazione gia in uso.", {
        code: "WORKSTATION_BUSY",
      });
    },
  });
  await assert.rejects(
    occupata.selectWorkstation({ payload: {}, clientApp: "postazione" }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "WORKSTATION_BUSY");
      return true;
    },
  );
  assert.deepEqual(occupata.eventi, []);
});

test("[BE][P0] auth.selectWorkstation legge l'app-state una sola volta rinfrescando le sessioni esternalizzate", async () => {
  const { db, user, session } = selectFixture();
  const letture = [];
  const { selectWorkstation } = createModelUnderTest({
    db,
    user,
    session,
    fastWriteOk: true,
    onReadDb: (options) => letture.push(options),
  });

  await selectWorkstation({ payload: {}, clientApp: "postazione" });

  assert.deepEqual(letture, [{ refreshExternalizedSessions: true }]);
});

test("[BE][P0] il handler auth.selectWorkstation mappa i tre esiti senza leggere l'app-state", async () => {
  const attesi = [
    [
      { outcome: "selected", selectedWorkstation: { id: "ws-bar", name: "Bar", stationName: "Postazione Bar" } },
      200,
      {
        ok: true,
        workstationSelectionRequired: false,
        selectedWorkstation: { id: "ws-bar", name: "Bar", stationName: "Postazione Bar" },
      },
    ],
    [
      { outcome: "client_not_postazione" },
      403,
      {
        ok: false,
        error: "Selezione disponibile solo per Postazione Advanced.",
        code: "WORKSTATION_CLIENT_REQUIRED",
      },
    ],
    [
      { outcome: "change_requires_logout" },
      409,
      {
        ok: false,
        error: "Per cambiare postazione esegui prima il logout.",
        code: "WORKSTATION_CHANGE_REQUIRES_LOGOUT",
      },
    ],
  ];

  for (const [esito, status, body] of attesi) {
    const inviati = [];
    const chiamate = [];
    let accessiAppState = 0;
    const handlers = createAuthHandlers({
      normalizeClientApp: (clientApp) => String(clientApp ?? ""),
      readJsonBody: async () => ({ token: "t", clientApp: "postazione" }),
      readDb: async () => {
        accessiAppState += 1;
        return {};
      },
      resolveClientAppFromRequest: (_req, clientApp) => clientApp,
      selectWorkstation: async (intent) => {
        chiamate.push(intent);
        return esito;
      },
      sendJson: (_res, nextStatus, nextBody) => inviati.push([nextStatus, nextBody]),
      writeDb: async () => {
        accessiAppState += 1;
      },
    });

    await handlers.handleSelectWorkstation({}, {});

    assert.equal(chiamate.length, 1);
    assert.equal(chiamate[0].clientApp, "postazione");
    assert.equal(chiamate[0].payload.token, "t");
    assert.deepEqual(inviati, [[status, body]]);
    assert.equal(accessiAppState, 0);
  }
});

test("[BE][P0] la cache volatile estratta conserva payload e ordine delle scritture Redis", async () => {
  const chiamate = [];
  const { rememberVolatileSession } = createVolatileSessionCache({
    normalizeClientApp: (clientApp) => String(clientApp ?? ""),
    redisVolatileStore: {
      storeAuthSession: async (payload) => chiamate.push(["storeAuthSession", payload]),
      storeSession: (payload) => chiamate.push(["storeSession", payload]),
      touchPresence: (payload) => chiamate.push(["touchPresence", payload]),
    },
    requireAuthSessionCacheInvalidation: () => true,
  });

  await rememberVolatileSession(
    { id: "user-cassiere", username: "cassiere" },
    { id: "session-postazione", deviceUuid: "device-postazione", clientApp: "postazione" },
    "postazione",
  );

  assert.deepEqual(chiamate.map(([nome]) => nome), [
    "storeAuthSession",
    "storeSession",
    "touchPresence",
  ]);
  assert.deepEqual(chiamate[0][1], {
    id: "session-postazione",
    clientApp: "postazione",
    deviceUuid: "device-postazione",
    sessionId: "session-postazione",
    userId: "user-cassiere",
    username: "cassiere",
  });
});

test("[BE][P0] la cache volatile salta l'invalidazione auth quando non e richiesta", async () => {
  const chiamate = [];
  const { rememberVolatileSession } = createVolatileSessionCache({
    normalizeClientApp: (clientApp) => String(clientApp ?? ""),
    redisVolatileStore: {
      storeAuthSession: async () => chiamate.push("storeAuthSession"),
      storeSession: () => chiamate.push("storeSession"),
      touchPresence: () => chiamate.push("touchPresence"),
    },
    requireAuthSessionCacheInvalidation: () => false,
  });

  await rememberVolatileSession({ id: "u" }, { id: "s" }, "postazione");

  assert.deepEqual(chiamate, ["storeSession", "touchPresence"]);
});
