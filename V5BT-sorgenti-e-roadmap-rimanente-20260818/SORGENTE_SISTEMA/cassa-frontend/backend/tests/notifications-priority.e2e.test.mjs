import test from "node:test";
import assert from "node:assert/strict";
import { apiPost, loginJson, startBackend } from "./helpers/test-server.mjs";

async function publishPriorityNotification(baseUrl, priority, title) {
  const { response, body } = await apiPost(baseUrl, "/api/integration/notifications/publish", {
    type: "general",
    title,
    description: `Priorita ${priority}`,
    meta: {
      targetUserId: "u_waiter",
      targetClientApp: "mobile-frontend",
      notificationPriority: priority,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(body?.ok, true);
  return body.notification;
}

async function pullForWaiter(baseUrl, session) {
  const params = new URLSearchParams({
    consumer: "mobile:u_waiter:priority-test",
    ackConsumer: "mobile:u_waiter:priority-test",
    clientApp: "mobile-frontend",
    userId: session.user.id,
    username: session.user.username,
    fullName: session.user.fullName,
    deviceUuid: "waiter-priority-device",
  });
  const response = await fetch(`${baseUrl}/api/integration/notifications/pull?${params}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body?.ok, true);
  return body.items ?? [];
}

test("pull notifiche rispetta priorita operative ritiro, consegna, ordine", async (t) => {
  const { baseUrl } = await startBackend(t);
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-priority-device",
    clientApp: "mobile-frontend",
  });
  const ordine = await publishPriorityNotification(baseUrl, "ordine", "Nuovo ordine");
  const ritiro = await publishPriorityNotification(baseUrl, "ritiro", "Ritiro urgente");
  const consegna = await publishPriorityNotification(baseUrl, "consegna", "Consegna");

  const items = await pullForWaiter(baseUrl, session);
  const ids = items.map((item) => item.id);

  assert.equal(ids.indexOf(ritiro.id) < ids.indexOf(consegna.id), true);
  assert.equal(ids.indexOf(consegna.id) < ids.indexOf(ordine.id), true);
  const ritiroItem = items.find((item) => item.id === ritiro.id);
  assert.equal(ritiroItem?.meta?.notificationPriority, "ritiro");
  assert.equal(ritiroItem?.meta?.notificationPriorityRank, 30);
  assert.equal(ritiroItem?.meta?.notificationPriorityLabel, "Ritiro");
});

test("alias eventType order_ready viene normalizzato come priorita ritiro", async (t) => {
  const { baseUrl } = await startBackend(t);
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-priority-device",
    clientApp: "mobile-frontend",
  });
  const { response, body } = await apiPost(baseUrl, "/api/integration/notifications/publish", {
    type: "bell",
    title: "Comanda pronta",
    description: "Da ritirare",
    meta: {
      targetUserId: "u_waiter",
      targetClientApp: "mobile-frontend",
      orderId: "00001",
      eventType: "order_ready",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(body?.ok, true);

  const items = await pullForWaiter(baseUrl, session);
  const item = items.find((entry) => entry.id === body.notification.id);

  assert.equal(item?.meta?.notificationPriority, "ritiro");
  assert.equal(item?.meta?.notificationPriorityRank, 30);
});

test("pull notifiche mobile mostra le nuove sopra le vecchie a parita di priorita", async (t) => {
  const { baseUrl } = await startBackend(t);
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-priority-device",
    clientApp: "mobile-frontend",
  });
  const older = await publishPriorityNotification(baseUrl, "ordine", "Ordine vecchio");
  const newer = await publishPriorityNotification(baseUrl, "ordine", "Ordine nuovo");

  const items = await pullForWaiter(baseUrl, session);
  const ids = items.map((item) => item.id);

  assert.equal(ids.indexOf(newer.id) < ids.indexOf(older.id), true);
});
