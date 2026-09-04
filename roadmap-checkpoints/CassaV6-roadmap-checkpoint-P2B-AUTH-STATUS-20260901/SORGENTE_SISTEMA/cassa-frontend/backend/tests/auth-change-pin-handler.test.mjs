import assert from "node:assert/strict";
import test from "node:test";

import { createAuthHandlers } from "../auth/auth.handlers.js";
import { createChangePinWriteModel } from "../auth/change-pin-write-model.js";

class TestHttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.status = status;
    this.code = options.code;
  }
}

function changePinFixture() {
  const user = {
    id: "user-waiter",
    username: "cameriere",
    fullName: "Cameriere",
    pinHash: "hash-1234",
    updatedAt: "2026-08-01T08:00:00.000Z",
  };
  const session = { id: "session-palmare", userId: user.id, clientApp: "mobile-frontend" };
  return {
    user,
    session,
    db: {
      users: [user],
      sessions: [session],
      auditEvents: [],
      meta: { lastWriteAt: "2026-08-01T08:00:00.000Z" },
    },
  };
}

function createModelUnderTest({
  db,
  user,
  session,
  pinCorretto = true,
  validateSessionContext = null,
  onReadDb = () => {},
}) {
  const audit = [];
  const writes = [];
  const model = createChangePinWriteModel({
    appendAuditEvent: (nextDb, event) => {
      nextDb.auditEvents.push(event);
      audit.push(event);
    },
    buildAuditActor: (actor) => ({ actorId: actor.id }),
    hashPin: (pin) => `hash-${pin}`,
    normalizeClientApp: (clientApp) => String(clientApp ?? ""),
    nowIso: () => "2026-09-01T12:00:00.000Z",
    readDb: async (options) => {
      onReadDb(options);
      return db;
    },
    validateSessionContext:
      validateSessionContext ?? (() => ({ user, session })),
    verifyPin: () => pinCorretto,
    writeDb: async (_nextDb, options) => writes.push(options),
  });
  return { ...model, audit, writes };
}

test("[BE][P0] auth.changePin applica il nuovo PIN e registra l'audit del cambio", async () => {
  const { db, user, session } = changePinFixture();
  const { changeUserPin, audit, writes } = createModelUnderTest({ db, user, session });

  const esito = await changeUserPin({
    payload: { token: "t", deviceUuid: "d" },
    currentPin: "1234",
    newPin: "5678",
  });

  assert.equal(esito.outcome, "changed");
  assert.equal(db.users[0].pinHash, "hash-5678");
  assert.equal(db.users[0].updatedAt, "2026-09-01T12:00:00.000Z");
  assert.equal(db.meta.lastWriteAt, "2026-09-01T12:00:00.000Z");
  assert.deepEqual(audit.map((event) => event.action), ["auth.pin_changed"]);
  assert.deepEqual(audit[0].payload, {
    sessionId: "session-palmare",
    clientApp: "mobile-frontend",
  });
  assert.equal(audit[0].entityId, "user-waiter");
  assert.deepEqual(writes, [
    { metricLabel: "auth.pinChange.appStateWrite", splitDomains: ["users", "auditEvents"] },
  ]);
});

test("[BE][P0] auth.changePin con PIN attuale errato scrive solo l'audit del tentativo", async () => {
  const { db, user, session } = changePinFixture();
  const { changeUserPin, audit, writes } = createModelUnderTest({
    db,
    user,
    session,
    pinCorretto: false,
  });

  const esito = await changeUserPin({
    payload: { token: "t", deviceUuid: "d" },
    currentPin: "0000",
    newPin: "5678",
  });

  assert.equal(esito.outcome, "invalid_current_pin");
  assert.equal(db.users[0].pinHash, "hash-1234");
  assert.equal(db.users[0].updatedAt, "2026-08-01T08:00:00.000Z");
  assert.equal(db.meta.lastWriteAt, "2026-09-01T12:00:00.000Z");
  assert.deepEqual(audit.map((event) => event.action), ["auth.pin_change_failed"]);
  assert.equal(audit[0].payload.reason, "invalid_current_pin");
  assert.deepEqual(writes, [
    { metricLabel: "auth.pinChange.failed.appStateWrite", splitDomains: ["auditEvents"] },
  ]);
});

test("[BE][P0] auth.changePin non scrive nulla se l'utente non e nell'app-state", async () => {
  const { db, user, session } = changePinFixture();
  db.users = [];
  const { changeUserPin, audit, writes } = createModelUnderTest({ db, user, session });

  const esito = await changeUserPin({
    payload: { token: "t", deviceUuid: "d" },
    currentPin: "1234",
    newPin: "5678",
  });

  assert.equal(esito.outcome, "user_not_found");
  assert.deepEqual(writes, []);
  assert.deepEqual(audit, []);
  assert.equal(db.meta.lastWriteAt, "2026-08-01T08:00:00.000Z");
});

test("[BE][P0] auth.changePin propaga invariato l'errore di sessione non valida", async () => {
  const { db, user, session } = changePinFixture();
  const { changeUserPin, writes } = createModelUnderTest({
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
    changeUserPin({ payload: {}, currentPin: "1234", newPin: "5678" }),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "SESSION_EXPIRED");
      return true;
    },
  );
  assert.deepEqual(writes, []);
});

test("[BE][P0] auth.changePin legge l'app-state una sola volta rinfrescando le sessioni esternalizzate", async () => {
  const { db, user, session } = changePinFixture();
  const letture = [];
  const { changeUserPin } = createModelUnderTest({
    db,
    user,
    session,
    onReadDb: (options) => letture.push(options),
  });

  await changeUserPin({ payload: {}, currentPin: "1234", newPin: "5678" });

  assert.deepEqual(letture, [{ refreshExternalizedSessions: true }]);
});

function createHandlerUnderTest({ payload, changeUserPin }) {
  const inviati = [];
  let accessiAppState = 0;
  const handlers = createAuthHandlers({
    changeUserPin,
    readJsonBody: async () => payload,
    readDb: async () => {
      accessiAppState += 1;
      return {};
    },
    writeDb: async () => {
      accessiAppState += 1;
    },
    sendJson: (_res, status, body) => inviati.push([status, body]),
  });
  return { handlers, inviati, accessiAppState: () => accessiAppState };
}

test("[BE][P0] il handler auth.changePin rifiuta i body non validi senza toccare l'app-state", async () => {
  const casi = [
    [{ currentPin: "12", newPin: "5678", confirmPin: "5678" }, "PIN attuale non valido."],
    [{ currentPin: "1234", newPin: "56", confirmPin: "56" }, "Il nuovo PIN deve essere di 4 cifre."],
    [
      { currentPin: "1234", newPin: "5678", confirmPin: "8765" },
      "Il nuovo PIN e la conferma non coincidono.",
    ],
  ];

  for (const [payload, atteso] of casi) {
    const { handlers, inviati, accessiAppState } = createHandlerUnderTest({
      payload,
      changeUserPin: async () => {
        throw new Error("write model invocato su body non valido");
      },
    });

    await handlers.handleChangePin({}, {});

    assert.deepEqual(inviati, [[400, { ok: false, error: atteso }]]);
    assert.equal(accessiAppState(), 0);
  }
});

test("[BE][P0] il handler auth.changePin mappa i tre esiti del write model senza leggere l'app-state", async () => {
  const attesi = [
    ["changed", 200, { ok: true, changed: true }],
    ["invalid_current_pin", 401, { ok: false, error: "PIN attuale non corretto." }],
    ["user_not_found", 404, { ok: false, error: "Utente non trovato." }],
  ];

  for (const [outcome, status, body] of attesi) {
    const chiamate = [];
    const { handlers, inviati, accessiAppState } = createHandlerUnderTest({
      payload: { currentPin: "1234", newPin: "5678", confirmPin: "5678", token: "t" },
      changeUserPin: async (intent) => {
        chiamate.push(intent);
        return { outcome };
      },
    });

    await handlers.handleChangePin({}, {});

    assert.equal(chiamate.length, 1);
    assert.equal(chiamate[0].currentPin, "1234");
    assert.equal(chiamate[0].newPin, "5678");
    assert.equal(chiamate[0].payload.token, "t");
    assert.deepEqual(inviati, [[status, body]]);
    assert.equal(accessiAppState(), 0);
  }
});
