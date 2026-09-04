import assert from "node:assert/strict";
import test from "node:test";

import { createAuthHandlers } from "../auth/auth.handlers.js";
import { createLogoutWriteModel } from "../auth/logout-write-model.js";
import { createVolatileSessionCache } from "../auth/volatile-session-cache.js";

// Senza store Redis la cache condivisa conferma la revoca senza side effect,
// come faceva la funzione interna prima di essere estratta.
const { forgetVolatileSessions } = createVolatileSessionCache({
  normalizeClientApp: (value) => String(value ?? ""),
});

test("logout mobile applica, persiste e pubblica l'handoff prima della risposta", async () => {
  const events = [];
  const user = {
    id: "u_waiter",
    username: "waiter",
    fullName: "Waiter Test",
  };
  const session = {
    id: "session-mobile",
    userId: user.id,
    deviceUuid: "device-mobile",
    clientApp: "mobile-frontend",
  };
  const notification = {
    id: "ntf-ready",
    meta: { eventType: "order_ready" },
  };
  const handoffResult = {
    mobileLogout: true,
    changed: true,
    notificationIds: [notification.id],
    notifications: [notification],
  };
  const db = {
    sessions: [session],
    integration: { notifications: [notification] },
    auditEvents: [],
    meta: {},
  };
  const responses = [];
  const { logout } = createLogoutWriteModel({
    forgetVolatileSessions,
    appendAuditEvent(_db, event) {
      events.push("audit");
      assert.deepEqual(event.payload.handedOffNotificationIds, [notification.id]);
      return { id: "audit-logout" };
    },
    applyMobileLogoutNotificationHandoff(nextDb, context) {
      events.push("apply");
      assert.equal(nextDb.sessions.length, 0);
      assert.equal(context.session, session);
      return handoffResult;
    },
    buildAuditActor: () => ({}),
    normalizeClientApp: (value) => String(value ?? ""),
    nowIso: () => "2026-07-21T10:00:00.000Z",
    publishMobileLogoutNotificationHandoff(result) {
      events.push("publish");
      assert.equal(result, handoffResult);
    },
    readDb: async () => db,
    validateSessionContext: () => ({ user, session }),
    async writeMobileLogoutFastDb(nextDb, options) {
      events.push("write");
      assert.equal(nextDb.sessions.length, 0);
      assert.equal(options.mobileLogoutResult, handoffResult);
      assert.deepEqual(options.deletedSessionIds, [session.id]);
      assert.deepEqual(options.auditEventIds, ["audit-logout"]);
      return true;
    },
    writeDb: async () => {
      throw new Error("fallback completo inatteso");
    },
  });
  const handlers = createAuthHandlers({
    logout,
    readJsonBody: async () => ({
      token: "token",
      userId: user.id,
      deviceUuid: session.deviceUuid,
    }),
    sendJson(_res, status, body) {
      events.push("send");
      responses.push({ status, body });
    },
  });

  await handlers.handleLogout({}, {});

  assert.deepEqual(events, ["apply", "audit", "write", "publish", "send"]);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.loggedOut, true);
});
