import assert from "node:assert/strict";
import test from "node:test";

import { createAuthHandlers } from "../auth/auth.handlers.js";
import { createLogoutWriteModel } from "../auth/logout-write-model.js";

class TestHttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.status = status;
    this.code = options.code;
  }
}

function logoutFixture() {
  const user = { id: "user-cassiere", username: "cassiere" };
  const session = {
    id: "session-1",
    userId: user.id,
    deviceUuid: "device-1",
    clientApp: "mobile-frontend",
  };
  const altra = {
    id: "session-2",
    userId: "user-altro",
    deviceUuid: "device-2",
    clientApp: "cassa-frontend",
  };
  return {
    user,
    session,
    altra,
    db: {
      users: [user],
      sessions: [session, altra],
      integration: { stationStates: [] },
      auditEvents: [],
      meta: { lastWriteAt: "2026-08-01T08:00:00.000Z" },
    },
  };
}

function createModelUnderTest({
  db,
  user,
  session,
  forgetOk = true,
  stationLogoutResult = null,
  mobileLogoutResult = null,
  fastWriteOk = true,
  validateSessionContext = null,
  onReadDb = () => {},
} = {}) {
  const eventi = [];
  const fastWriter = (nome) => async (_nextDb, options) => {
    eventi.push([nome, options.metricLabel ?? null, options.deletedSessionIds, options.auditEventIds]);
    return fastWriteOk;
  };
  const model = createLogoutWriteModel({
    appendAuditEvent: (nextDb, event) => {
      nextDb.auditEvents.push(event);
      eventi.push(["audit", event.action]);
      return { id: "audit-logout" };
    },
    applyMobileLogoutNotificationHandoff: () => mobileLogoutResult,
    applyPostazioneLogoutStationState: () => stationLogoutResult,
    buildAuditActor: (actor) => ({ actorId: actor.id }),
    forgetVolatileSessions: async (entries) => {
      eventi.push(["forget", entries.map((entry) => entry.id)]);
      return forgetOk;
    },
    normalizeClientApp: (clientApp) => String(clientApp ?? ""),
    nowIso: () => "2026-09-02T12:00:00.000Z",
    publishMobileLogoutNotificationHandoff: () => eventi.push(["publishMobile"]),
    publishPostazioneLogoutStationState: () => eventi.push(["publishStation"]),
    readDb: async (options) => {
      onReadDb(options);
      return db;
    },
    validateSessionContext: validateSessionContext ?? (() => ({ user, session })),
    writeAuthSessionFastDb: fastWriter("fastSession"),
    writeMobileLogoutFastDb: fastWriter("fastMobile"),
    writePostazioneLogoutFastDb: fastWriter("fastStation"),
    writeDb: async (_nextDb, options) => {
      eventi.push([
        "writeDb",
        options.metricLabel,
        options.splitDomains.join("|"),
        options.sessionsSync?.deleteMissing,
      ]);
    },
  });
  return { ...model, eventi };
}

test("[BE][P0] auth.logout rimuove la sessione e usa il fast writer di sessione", async () => {
  const { db, user, session, altra } = logoutFixture();
  const modello = createModelUnderTest({ db, user, session });

  const esito = await modello.logout({ payload: { token: "t" } });

  assert.deepEqual(esito, { outcome: "logged_out" });
  assert.deepEqual(db.sessions, [altra]);
  assert.equal(db.meta.lastWriteAt, "2026-09-02T12:00:00.000Z");
  assert.deepEqual(modello.eventi, [
    ["forget", ["session-1"]],
    ["audit", "auth.logout"],
    ["fastSession", "auth.logout.sessionFastWrite", ["session-1"], ["audit-logout"]],
  ]);
  assert.deepEqual(db.auditEvents[0].payload, {
    sessionId: "session-1",
    userId: "user-cassiere",
    username: "cassiere",
    clientApp: "mobile-frontend",
    deactivatedStations: [],
    handedOffNotificationIds: [],
  });
});

test("[BE][P0] auth.logout ricade su writeDb quando il fast writer di sessione non scrive", async () => {
  const { db, user, session } = logoutFixture();
  const modello = createModelUnderTest({ db, user, session, fastWriteOk: false });

  await modello.logout({ payload: {} });

  assert.deepEqual(modello.eventi.at(-1), [
    "writeDb",
    "auth.logout.appStateWrite",
    "sessions|auditEvents",
    true,
  ]);
});

test("[BE][P0] auth.logout Postazione usa il fast writer di stato e pubblica la disattivazione", async () => {
  const { db, user, session } = logoutFixture();
  const modello = createModelUnderTest({
    db,
    user,
    session,
    stationLogoutResult: { changed: true, deactivatedStations: ["BAR_1"] },
  });

  await modello.logout({ payload: {} });

  assert.deepEqual(modello.eventi, [
    ["forget", ["session-1"]],
    ["audit", "auth.logout"],
    ["fastStation", null, ["session-1"], ["audit-logout"]],
    ["publishStation"],
  ]);
  assert.deepEqual(db.auditEvents[0].payload.deactivatedStations, ["BAR_1"]);
});

test("[BE][P0] auth.logout Postazione ricade sul writeDb dedicato allo stato stazione", async () => {
  const { db, user, session } = logoutFixture();
  const modello = createModelUnderTest({
    db,
    user,
    session,
    fastWriteOk: false,
    stationLogoutResult: { changed: true, deactivatedStations: ["BAR_1"] },
  });

  await modello.logout({ payload: {} });

  assert.deepEqual(modello.eventi.at(-2), [
    "writeDb",
    "auth.logout.stationState.appStateWrite",
    "sessions|integration|auditEvents",
    true,
  ]);
});

test("[BE][P0] auth.logout mobile usa il fast writer di handoff e riporta le notifiche cedute", async () => {
  const { db, user, session } = logoutFixture();
  const modello = createModelUnderTest({
    db,
    user,
    session,
    mobileLogoutResult: { changed: true, mobileLogout: true, notificationIds: ["notif-1"] },
  });

  await modello.logout({ payload: {} });

  assert.deepEqual(modello.eventi, [
    ["forget", ["session-1"]],
    ["audit", "auth.logout"],
    ["fastMobile", null, ["session-1"], ["audit-logout"]],
    ["publishMobile"],
  ]);
  assert.deepEqual(db.auditEvents[0].payload.handedOffNotificationIds, ["notif-1"]);
});

test("[BE][P0] auth.logout mobile ricade sul writeDb dedicato all'handoff", async () => {
  const { db, user, session } = logoutFixture();
  const modello = createModelUnderTest({
    db,
    user,
    session,
    fastWriteOk: false,
    mobileLogoutResult: { changed: true, mobileLogout: true, notificationIds: [] },
  });

  await modello.logout({ payload: {} });

  assert.deepEqual(modello.eventi.at(-2), [
    "writeDb",
    "auth.logout.mobileHandoff.appStateWrite",
    "sessions|integration|auditEvents",
    true,
  ]);
});

test("[BE][P0] auth.logout con entrambi i risultati cambiati scrive una sola volta, sul ramo postazione", async () => {
  const { db, user, session } = logoutFixture();
  const modello = createModelUnderTest({
    db,
    user,
    session,
    stationLogoutResult: { changed: true, deactivatedStations: ["BAR_1"] },
    mobileLogoutResult: { changed: true, mobileLogout: true, notificationIds: ["notif-1"] },
  });

  await modello.logout({ payload: {} });

  const scritture = modello.eventi.filter(([nome]) =>
    ["fastStation", "fastMobile", "fastSession", "writeDb"].includes(nome),
  );
  assert.deepEqual(scritture, [["fastStation", null, ["session-1"], ["audit-logout"]]]);
  // Entrambe le pubblicazioni restano dovute: guardano condizioni diverse.
  assert.deepEqual(
    modello.eventi.filter(([nome]) => nome.startsWith("publish")),
    [["publishStation"], ["publishMobile"]],
  );
});

test("[BE][P0] auth.logout pubblica l'handoff mobile anche senza scrittura dedicata", async () => {
  const { db, user, session } = logoutFixture();
  const modello = createModelUnderTest({
    db,
    user,
    session,
    mobileLogoutResult: { changed: false, mobileLogout: true, notificationIds: [] },
  });

  await modello.logout({ payload: {} });

  assert.deepEqual(modello.eventi, [
    ["forget", ["session-1"]],
    ["audit", "auth.logout"],
    ["fastSession", "auth.logout.sessionFastWrite", ["session-1"], ["audit-logout"]],
    ["publishMobile"],
  ]);
});

test("[BE][P0] auth.logout lascia la sessione valida se la cache non conferma la revoca", async () => {
  const { db, user, session, altra } = logoutFixture();
  const modello = createModelUnderTest({ db, user, session, forgetOk: false });

  const esito = await modello.logout({ payload: {} });

  assert.deepEqual(esito, { outcome: "session_cache_unavailable" });
  assert.deepEqual(db.sessions, [session, altra]);
  assert.deepEqual(db.auditEvents, []);
  assert.equal(db.meta.lastWriteAt, "2026-08-01T08:00:00.000Z");
  assert.deepEqual(modello.eventi, [["forget", ["session-1"]]]);
});

test("[BE][P0] auth.logout propaga invariato l'errore di sessione non valida", async () => {
  const { db, user, session } = logoutFixture();
  const modello = createModelUnderTest({
    db,
    user,
    session,
    validateSessionContext: () => {
      throw new TestHttpError(401, "Sessione login non valida o scaduta.", {
        code: "SESSION_EXPIRED",
      });
    },
  });

  await assert.rejects(modello.logout({ payload: {} }), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, "SESSION_EXPIRED");
    return true;
  });
  assert.deepEqual(modello.eventi, []);
});

test("[BE][P0] auth.logout legge una sola volta rinfrescando sessioni e stati postazione", async () => {
  const { db, user, session } = logoutFixture();
  const letture = [];
  const modello = createModelUnderTest({
    db,
    user,
    session,
    onReadDb: (options) => letture.push(options),
  });

  await modello.logout({ payload: {} });

  assert.deepEqual(letture, [
    { refreshExternalizedSessions: true, refreshExternalizedIntegrationStationStates: true },
  ]);
});

test("[BE][P0] il handler auth.logout mappa i due esiti senza toccare l'app-state", async () => {
  const attesi = [
    [{ outcome: "logged_out" }, 200, { ok: true, loggedOut: true }],
    [
      { outcome: "session_cache_unavailable" },
      503,
      {
        ok: false,
        error: "Impossibile invalidare la sessione. Riprova tra poco.",
        code: "SESSION_CACHE_INVALIDATION_UNAVAILABLE",
      },
    ],
  ];

  for (const [esito, status, body] of attesi) {
    const chiamate = [];
    const inviati = [];
    let accessiAppState = 0;
    const handlers = createAuthHandlers({
      logout: async (intent) => {
        chiamate.push(intent);
        return esito;
      },
      readJsonBody: async () => ({ token: "t", deviceUuid: "d" }),
      readDb: async () => {
        accessiAppState += 1;
        return {};
      },
      sendJson: (_res, nextStatus, nextBody) => inviati.push([nextStatus, nextBody]),
      writeDb: async () => {
        accessiAppState += 1;
      },
    });

    await handlers.handleLogout({}, {});

    assert.equal(chiamate.length, 1);
    assert.equal(chiamate[0].payload.token, "t");
    assert.deepEqual(inviati, [[status, body]]);
    assert.equal(accessiAppState, 0);
  }
});
