import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { apiPost, authPayload, loginJson, startBackend } from "./helpers/test-server.mjs";

async function publishTargetedNotification(baseUrl, overrides = {}) {
  const { response, body } = await apiPost(baseUrl, "/api/integration/notifications/publish", {
    type: "general",
    title: overrides.title ?? "Avviso cameriere",
    description: overrides.description ?? "Notifica persistente di test",
    meta: {
      targetUserId: "u_waiter",
      targetUsername: "waiter",
      targetClientApp: "mobile-frontend",
      ...overrides.meta,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(body?.ok, true);
  assert.ok(body?.notification?.id);
  return body.notification;
}

async function pullNotifications(baseUrl, session, options = {}) {
  const deviceUuid = options.deviceUuid ?? "waiter-device";
  const consumer = options.consumer ?? `mobile:${session.user.id}`;
  const params = new URLSearchParams({
    consumer,
    ackConsumer: options.ackConsumer ?? consumer,
    clientApp: "mobile-frontend",
    userId: session.user.id,
    username: session.user.username,
    fullName: session.user.fullName,
    deviceUuid,
  });
  const response = await fetch(`${baseUrl}/api/integration/notifications/pull?${params}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body?.ok, true);
  return body.items ?? [];
}

async function ackNotification(baseUrl, notification, session, options = {}) {
  const deviceUuid = options.deviceUuid ?? "waiter-device";
  const consumer = options.consumer ?? `mobile:${session.user.id}`;
  const { response, body } = await apiPost(baseUrl, "/api/integration/notifications/ack", {
    id: notification.id,
    consumer,
    clientApp: "mobile-frontend",
    userId: session.user.id,
    username: session.user.username,
    fullName: session.user.fullName,
    deviceUuid,
  });
  assert.equal(response.status, 200);
  assert.equal(body?.ok, true);
  assert.equal(body?.acknowledged, true);
  return body;
}

test("logout e nuovo login non riproducono una notifica della sessione precedente", async (t) => {
  const { baseUrl } = await startBackend(t);
  const firstSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-device-a",
    clientApp: "mobile-frontend",
  });
  const notification = await publishTargetedNotification(baseUrl, {
    title: "Ritiro comanda",
    meta: {
      eventType: "order_ready",
      notificationPriority: "ritiro",
      orderId: "order-session-previous",
    },
  });
  const firstPull = await pullNotifications(baseUrl, firstSession, {
    deviceUuid: "waiter-device-a",
    consumer: "mobile:u_waiter",
  });
  assert.ok(firstPull.some((item) => item.id === notification.id));

  const { response: logoutResponse } = await apiPost(
    baseUrl,
    "/api/auth/logout",
    authPayload(firstSession, "waiter-device-a", {
      clientApp: "mobile-frontend",
    }),
  );
  assert.equal(logoutResponse.status, 200);

  const offlineNotification = await publishTargetedNotification(baseUrl, {
    title: "Ritiro durante logout",
    meta: {
      eventType: "order_ready",
      notificationPriority: "ritiro",
      orderId: "order-while-logged-out",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const secondSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-device-a",
    clientApp: "mobile-frontend",
  });
  const secondPull = await pullNotifications(baseUrl, secondSession, {
    deviceUuid: "waiter-device-a",
    consumer: "mobile:u_waiter",
  });
  assert.equal(secondPull.some((item) => item.id === notification.id), false);
  assert.equal(
    secondPull.some((item) => item.id === offlineNotification.id),
    false,
  );

  const currentNotification = await publishTargetedNotification(baseUrl, {
    title: "Ritiro sessione corrente",
    meta: {
      eventType: "order_ready",
      notificationPriority: "ritiro",
      orderId: "order-current-session",
    },
  });
  const currentPull = await pullNotifications(baseUrl, secondSession, {
    deviceUuid: "waiter-device-a",
    consumer: "mobile:u_waiter",
  });
  assert.equal(
    currentPull.some((item) => item.id === currentNotification.id),
    true,
  );
});

test("ack mobile senza identita o dopo logout e rifiutato senza mutare la notifica", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "ack-revoked-device",
    clientApp: "mobile-frontend",
  });
  const notification = await publishTargetedNotification(baseUrl, {
    title: "Ack protetto",
  });

  const missingIdentity = await apiPost(
    baseUrl,
    "/api/integration/notifications/ack",
    {
      id: notification.id,
      consumer: "mobile:missing",
      clientApp: "mobile-frontend",
    },
  );
  assert.equal(missingIdentity.response.status, 401);

  const logout = await apiPost(
    baseUrl,
    "/api/auth/logout",
    authPayload(session, "ack-revoked-device", {
      clientApp: "mobile-frontend",
    }),
  );
  assert.equal(logout.response.status, 200);

  const revokedAck = await apiPost(
    baseUrl,
    "/api/integration/notifications/ack",
    {
      id: notification.id,
      consumer: "mobile:revoked",
      clientApp: "mobile-frontend",
      userId: session.user.id,
      username: session.user.username,
      fullName: session.user.fullName,
      deviceUuid: "ack-revoked-device",
    },
  );
  assert.equal(revokedAck.response.status, 401);

  const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const stored = persisted.integration.notifications.find(
    (entry) => entry.id === notification.id,
  );
  assert.deepEqual(stored?.ackedBy ?? [], []);
});

test("notifiche ordine consegna ritiro restano valide nella sessione corrente", async (t) => {
  const { baseUrl } = await startBackend(t);
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-device-a",
    clientApp: "mobile-frontend",
  });
  const notifications = [];
  for (const priority of ["ordine", "consegna", "ritiro"]) {
    notifications.push(
      await publishTargetedNotification(baseUrl, {
        title: `Notifica ${priority}`,
        meta: {
          notificationPriority: priority,
        },
      })
    );
  }

  const firstPull = await pullNotifications(baseUrl, session, {
    deviceUuid: "waiter-device-a",
    consumer: "mobile:u_waiter",
  });
  for (const notification of notifications) {
    assert.ok(firstPull.some((item) => item.id === notification.id));
  }

  const secondPull = await pullNotifications(baseUrl, session, {
    deviceUuid: "waiter-device-a",
    consumer: "mobile:u_waiter",
  });
  for (const notification of notifications) {
    assert.ok(secondPull.some((item) => item.id === notification.id));
  }

  const priorities = new Set(secondPull.map((item) => item.meta?.notificationPriority).filter(Boolean));
  assert.equal(priorities.has("ordine"), true);
  assert.equal(priorities.has("consegna"), true);
  assert.equal(priorities.has("ritiro"), true);
});

test("ack mirato non riappare su un nuovo consumer dello stesso operatore", async (t) => {
  const { baseUrl } = await startBackend(t);
  const notification = await publishTargetedNotification(baseUrl, {
    title: "Consegna pronta",
  });

  const firstSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-device-a",
    clientApp: "mobile-frontend",
  });
  await ackNotification(baseUrl, notification, firstSession, {
    deviceUuid: "waiter-device-a",
    consumer: "mobile:u_waiter:device-a",
  });

  const secondSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-device-b",
    clientApp: "mobile-frontend",
  });
  const secondPull = await pullNotifications(baseUrl, secondSession, {
    deviceUuid: "waiter-device-b",
    consumer: "mobile:u_waiter:device-b",
  });
  assert.equal(secondPull.some((item) => item.id === notification.id), false);
});

test("notifica mirata cade sui mobile online se nessuna sessione corrisponde al target", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const onlineSession = await loginJson(baseUrl, "ultra_waiter", "3333", {
    deviceUuid: "ultra-waiter-online",
    clientApp: "mobile-frontend",
  });
  const notification = await publishTargetedNotification(baseUrl, {
    title: "Comanda pronta senza proprietario online",
    meta: {
      targetUserId: "u_waiter_offline",
      targetUsername: "waiter_offline",
      targetFullName: "Waiter Offline",
      eventType: "order_ready",
      notificationPriority: "ritiro",
    },
  });

  const items = await pullNotifications(baseUrl, onlineSession, {
    deviceUuid: "ultra-waiter-online",
    consumer: "mobile:u_ultra_waiter:fallback",
  });
  const delivered = items.find((item) => item.id === notification.id);

  assert.ok(delivered);
  assert.equal(delivered.meta?.targetFallbackActive, true);
  assert.equal(delivered.meta?.targetFallbackScope, "online_mobile");
  assert.equal(delivered.meta?.targetUserId, undefined);
  assert.equal(delivered.meta?.originalTargetUserId, "u_waiter_offline");
  assert.deepEqual(delivered.meta?.targetUserIds, ["u_ultra_waiter"]);
  const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const persistedNotification = persisted.integration.notifications.find(
    (entry) => entry.id === notification.id,
  );
  assert.deepEqual(persistedNotification?.meta?.targetUserIds, ["u_ultra_waiter"]);
  assert.equal(
    persistedNotification?.meta?.originalTargetUserId,
    "u_waiter_offline",
  );
});

test("notifica mirata resta privata se il target ha una sessione mobile online", async (t) => {
  const { baseUrl } = await startBackend(t);
  const targetSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-target-online",
    clientApp: "mobile-frontend",
  });
  const notification = await publishTargetedNotification(baseUrl, {
    title: "Comanda pronta con proprietario online",
    meta: {
      eventType: "order_ready",
      notificationPriority: "ritiro",
    },
  });

  const otherSession = await loginJson(baseUrl, "ultra_waiter", "3333", {
    deviceUuid: "ultra-waiter-other",
    clientApp: "mobile-frontend",
  });
  const otherItems = await pullNotifications(baseUrl, otherSession, {
    deviceUuid: "ultra-waiter-other",
    consumer: "mobile:u_ultra_waiter:other",
  });
  const targetItems = await pullNotifications(baseUrl, targetSession, {
    deviceUuid: "waiter-target-online",
    consumer: "mobile:u_waiter:target",
  });

  assert.equal(otherItems.some((item) => item.id === notification.id), false);
  assert.equal(targetItems.some((item) => item.id === notification.id), true);
});

test("logout mobile cede subito le order_ready non ackate ai camerieri online della stessa sala", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const targetSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-logout-target",
    clientApp: "mobile-frontend",
  });
  const fallbackSession = await loginJson(baseUrl, "ultra_waiter", "3333", {
    deviceUuid: "waiter-same-room",
    clientApp: "mobile-frontend",
  });
  const notification = await publishTargetedNotification(baseUrl, {
    title: "Comanda da cedere al logout",
    meta: {
      eventType: "order_ready",
      notificationPriority: "ritiro",
      orderId: "order-logout-handoff",
      roomId: "room_pedana",
      roomName: "Pedana",
    },
  });

  const { response: logoutResponse, body: logoutBody } = await apiPost(
    baseUrl,
    "/api/auth/logout",
    authPayload(targetSession, "waiter-logout-target", {
      clientApp: "mobile-frontend",
    }),
  );
  assert.equal(logoutResponse.status, 200);
  assert.equal(logoutBody?.loggedOut, true);

  const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const handedOff = persisted.integration.notifications.find(
    (entry) => entry.id === notification.id,
  );
  assert.deepEqual(handedOff?.meta?.targetUserIds, ["u_ultra_waiter"]);
  assert.equal(handedOff?.meta?.targetRoomId, "room_pedana");
  assert.equal(handedOff?.meta?.originalTargetUserId, "u_waiter");
  assert.equal(handedOff?.meta?.targetFallbackReason, "target_logout");
  assert.equal(handedOff?.meta?.excludeUserIds?.includes("u_waiter"), true);
  assert.equal(
    persisted.sessions.some(
      (entry) => entry.deviceUuid === "waiter-logout-target",
    ),
    false,
  );

  const staleItems = await pullNotifications(baseUrl, targetSession, {
    deviceUuid: "waiter-logout-target",
    consumer: "mobile:u_waiter:logged-out",
  });
  assert.deepEqual(staleItems, []);
  const fallbackItems = await pullNotifications(baseUrl, fallbackSession, {
    deviceUuid: "waiter-same-room",
    consumer: "mobile:u_ultra_waiter:handoff",
  });
  assert.equal(fallbackItems.some((item) => item.id === notification.id), true);

  const waitersResponse = await fetch(
    `${baseUrl}/api/integration/waiters?source=mobile-frontend`,
  );
  assert.equal(waitersResponse.status, 200);
  const waitersBody = await waitersResponse.json();
  assert.equal(
    waitersBody.waiters.some((entry) => entry.userId === "u_waiter"),
    false,
  );
});

test("logout di un device non cede order_ready se lo stesso cameriere resta online altrove", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const firstSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-session-a",
    clientApp: "mobile-frontend",
  });
  await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-session-b",
    clientApp: "mobile-frontend",
  });
  await loginJson(baseUrl, "ultra_waiter", "3333", {
    deviceUuid: "other-waiter-session",
    clientApp: "mobile-frontend",
  });
  const notification = await publishTargetedNotification(baseUrl, {
    meta: {
      eventType: "order_ready",
      notificationPriority: "ritiro",
      orderId: "order-multi-session",
      roomId: "room_pedana",
    },
  });

  const { response } = await apiPost(
    baseUrl,
    "/api/auth/logout",
    authPayload(firstSession, "waiter-session-a", {
      clientApp: "mobile-frontend",
    }),
  );
  assert.equal(response.status, 200);

  const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const retained = persisted.integration.notifications.find(
    (entry) => entry.id === notification.id,
  );
  assert.equal(retained?.meta?.targetUserId, "u_waiter");
  assert.equal(retained?.meta?.targetUserIds, undefined);
  assert.equal(retained?.meta?.originalTargetUserId, undefined);
});

test("pull mobile con user e device senza sessione esatta non consegna e non fa heartbeat", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    env: { SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "1" },
  });
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-valid-device",
    clientApp: "mobile-frontend",
  });
  const notification = await publishTargetedNotification(baseUrl, {
    meta: {
      eventType: "order_ready",
      notificationPriority: "ritiro",
      orderId: "order-invalid-pull-session",
    },
  });
  const before = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const beforeSession = before.sessions.find(
    (entry) => entry.deviceUuid === "waiter-valid-device",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  const invalidItems = await pullNotifications(baseUrl, session, {
    deviceUuid: "waiter-device-without-session",
    consumer: "mobile:u_waiter:invalid-session",
  });
  assert.deepEqual(invalidItems, []);

  const after = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const afterSession = after.sessions.find(
    (entry) => entry.deviceUuid === "waiter-valid-device",
  );
  assert.equal(afterSession?.lastSeenAt, beforeSession?.lastSeenAt);
  const persistedNotification = after.integration.notifications.find(
    (entry) => entry.id === notification.id,
  );
  assert.deepEqual(persistedNotification?.deliveredTo, []);
});

test("chiamata prenotata resta possibile con cameriere mobile stale ma sessione valida", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    env: {
      INTEGRATION_WAITER_ACTIVE_WINDOW_MS: "5000",
    },
  });
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-stale-device",
    clientApp: "mobile-frontend",
  });

  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const createdAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const staleAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  db.sessions = db.sessions.map((entry) =>
    entry?.userId === "u_waiter" && entry?.deviceUuid === "waiter-stale-device"
      ? { ...entry, createdAt, lastSeenAt: staleAt }
      : entry
  );
  db.meta.lastWriteAt = new Date().toISOString();
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");

  const activeResponse = await fetch(`${baseUrl}/api/integration/waiters?source=mobile-frontend&activeMs=5000`);
  assert.equal(activeResponse.status, 200);
  const activeBody = await activeResponse.json();
  assert.equal(activeBody.waiters.some((entry) => entry.userId === "u_waiter"), false);

  const inactiveResponse = await fetch(
    `${baseUrl}/api/integration/waiters?source=mobile-frontend&activeMs=5000&includeInactive=1`
  );
  assert.equal(inactiveResponse.status, 200);
  const inactiveBody = await inactiveResponse.json();
  const inactiveWaiter = inactiveBody.waiters.find((entry) => entry.userId === "u_waiter");
  assert.equal(Boolean(inactiveWaiter), true);
  assert.equal(inactiveWaiter.online, false);

  const { response, body } = await apiPost(baseUrl, "/api/integration/waiter-pause/defer-call", {
    station: "BAR-1",
    requestedBy: "Postazione Test",
    requesterDeviceUuid: "station-test",
    requesterFeedbackConsumer: "postazione:BAR-1",
    targetUserId: "u_waiter",
    targetUsername: "waiter",
    targetFullName: "Waiter Test",
  });
  assert.equal(response.status, 200);
  assert.equal(body?.ok, true);

  const items = await pullNotifications(baseUrl, session, {
    deviceUuid: "waiter-stale-device",
    consumer: "mobile:u_waiter:stale",
  });
  assert.equal(
    items.some((item) => item.meta?.eventType === "waiter_call_after_pause" && item.meta?.targetUserId === "u_waiter"),
    true
  );
});
