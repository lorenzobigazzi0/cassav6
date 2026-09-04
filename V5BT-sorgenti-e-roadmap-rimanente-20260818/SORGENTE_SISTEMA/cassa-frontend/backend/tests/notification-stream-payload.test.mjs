import assert from "node:assert/strict";
import test from "node:test";

import {
  apiPost,
  authHeaders,
  authPayload,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

async function readSseEvent(response, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const readResult = await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout SSE")), remainingMs),
      ),
    ]);
    if (readResult.done) break;
    buffer += decoder.decode(readResult.value, { stream: true });
    const parts = buffer.split(/\n\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = { event: "message", data: "" };
      for (const line of part.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          event.event = line.slice("event:".length).trim();
        }
        if (line.startsWith("data:")) {
          event.data += line.slice("data:".length).trim();
        }
      }
      if (predicate(event)) return event;
    }
  }
  throw new Error("Evento SSE atteso non ricevuto");
}

test("pull e stream mobile rifiutano identita assenti o contraddittorie", async (t) => {
  const { baseUrl } = await startBackend(t);
  await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "identity-device-a",
    clientApp: "mobile-frontend",
  });
  await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "identity-device-b",
    clientApp: "mobile-frontend",
  });

  const missingStream = await fetch(
    `${baseUrl}/api/integration/notifications/stream?clientApp=mobile-frontend&userId=u_waiter`,
  );
  assert.equal(missingStream.status, 401);
  assert.equal(
    (await missingStream.json()).code,
    "NOTIFICATION_IDENTITY_REQUIRED",
  );

  const spoofedStream = await fetch(
    `${baseUrl}/api/integration/notifications/stream?clientApp=mobile-frontend&userId=u_waiter&username=cashier&deviceUuid=identity-device-a`,
  );
  assert.equal(spoofedStream.status, 401);
  assert.equal(
    (await spoofedStream.json()).code,
    "NOTIFICATION_SESSION_REVOKED",
  );

  const missingPull = await fetch(
    `${baseUrl}/api/integration/notifications/pull?consumer=mobile-missing&clientApp=mobile-frontend`,
  );
  assert.equal(missingPull.status, 200);
  assert.deepEqual((await missingPull.json()).items, []);

  const spoofedPull = await fetch(
    `${baseUrl}/api/integration/notifications/pull?consumer=mobile-spoof&clientApp=mobile-frontend&userId=u_waiter&username=cashier&deviceUuid=identity-device-a`,
  );
  assert.equal(spoofedPull.status, 200);
  assert.deepEqual((await spoofedPull.json()).items, []);
});

test("notifications stream emette payload tipizzato quando SSE_EVENT_PAYLOAD e attivo", async (t) => {
  const { baseUrl } = await startBackend(t, {
    env: {
      SSE_EVENT_PAYLOAD: "1",
      RUNTIME_METRICS: "1",
    },
  });
  const streamController = new AbortController();
  t.after(() => streamController.abort());
  const waiter = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "sse-payload-waiter",
    clientApp: "mobile-frontend",
  });

  const streamResponse = await fetch(
    `${baseUrl}/api/integration/notifications/stream?consumer=test-payload&clientApp=mobile-frontend&userId=${waiter.user.id}&username=${waiter.user.username}&deviceUuid=sse-payload-waiter`,
    { signal: streamController.signal },
  );
  assert.equal(streamResponse.status, 200);

  const orderId = `ord_payload_${Date.now()}`;
  const payloadPromise = readSseEvent(
    streamResponse,
    (event) => {
      if (event.event !== "payload") return false;
      const parsed = JSON.parse(event.data || "{}");
      return (
        parsed.type === "notification" &&
        parsed.reason === "notification_publish" &&
        parsed.detail?.orderId === orderId
      );
    },
    { timeoutMs: 8_000 },
  );

  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid: "sse-payload-admin",
    clientApp: "cassa-frontend",
  });
  const publishResponse = await fetch(
    `${baseUrl}/api/integration/notifications/publish`,
    {
      method: "POST",
      headers: authHeaders(admin, "sse-payload-admin"),
      body: JSON.stringify({
        type: "bell",
        title: "Comanda pronta",
        description: "Payload SSE test",
        meta: {
          orderId,
          targetClientApp: "mobile-frontend",
        },
      }),
    },
  );
  assert.equal(publishResponse.status, 200);

  const event = await payloadPromise;
  const parsed = JSON.parse(event.data);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.type, "notification");
  assert.equal(parsed.detail.orderId, orderId);
  assert.equal(parsed.detail.notification.meta.orderId, orderId);
});

test("notifications stream consegna una sola volta ai client eleggibili per sala", async (t) => {
  const { baseUrl } = await startBackend(t, {
    env: {
      SSE_EVENT_PAYLOAD: "1",
      SSE_LEGACY_REFRESH: "0",
      BACKEND_REALTIME_SCOPED_DELIVERY: "1",
      RUNTIME_METRICS: "1",
    },
  });
  const adminDeviceUuid = "sse-scoped-admin";
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid: adminDeviceUuid,
    clientApp: "cassa-frontend",
  });
  await Promise.all([
    loginJson(baseUrl, "waiter", "3333", {
      deviceUuid: "device_a1",
      clientApp: "mobile-frontend",
    }),
    loginJson(baseUrl, "ultra_waiter", "3333", {
      deviceUuid: "device_a2",
      clientApp: "mobile-frontend",
    }),
    loginJson(baseUrl, "cashier", "2222", {
      deviceUuid: "device_b",
      clientApp: "mobile-frontend",
    }),
  ]);
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  t.after(() => controllers.forEach((controller) => controller.abort()));
  const streamUrls = [
    `${baseUrl}/api/integration/notifications/stream?consumer=room-a-1&clientApp=postazione&roomId=room_a&userId=u_waiter&deviceUuid=device_a1`,
    `${baseUrl}/api/integration/notifications/stream?consumer=room-a-2&clientApp=postazione&roomId=room_a&userId=u_ultra_waiter&deviceUuid=device_a2`,
    `${baseUrl}/api/integration/notifications/stream?consumer=room-b&clientApp=postazione&roomId=room_b&userId=u_cashier&deviceUuid=device_b`,
  ];
  const streams = await Promise.all(streamUrls.map((url, index) => fetch(url, {
    signal: controllers[index].signal,
  })));
  streams.forEach((response) => assert.equal(response.status, 200));

  const metricsHeaders = authHeaders(admin, adminDeviceUuid);
  const beforeResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, { headers: metricsHeaders });
  const before = (await beforeResponse.json()).runtimeMetrics.counters;
  const notificationMarker = `scoped-${Date.now()}`;
  const payloadPromise = readSseEvent(
    streams[0],
    (event) => {
      if (event.event !== "payload") return false;
      const parsed = JSON.parse(event.data || "{}");
      return parsed.detail?.notification?.meta?.marker === notificationMarker;
    },
  );

  const publishResponse = await fetch(`${baseUrl}/api/integration/notifications/publish`, {
    method: "POST",
    headers: metricsHeaders,
    body: JSON.stringify({
      type: "general",
      title: "Evento sala",
      description: "Consegna scoped",
      meta: { roomId: "room_a", marker: notificationMarker },
    }),
  });
  assert.equal(publishResponse.status, 200);
  await payloadPromise;

  const afterResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, { headers: metricsHeaders });
  const after = (await afterResponse.json()).runtimeMetrics.counters;
  assert.equal(after.realtimeBusinessEvents - before.realtimeBusinessEvents, 1);
  assert.equal(after.realtimeEligibleRecipients - before.realtimeEligibleRecipients, 2);
  assert.equal(after.realtimeDeliveredRecipients - before.realtimeDeliveredRecipients, 2);
  assert.equal(after.realtimeFilteredClients - before.realtimeFilteredClients, 1);
  assert.equal(after.realtimeSseFramesSerialized - before.realtimeSseFramesSerialized, 1);
  assert.ok(after.realtimeDeliveryBytes - before.realtimeDeliveryBytes > 0);
});

test("handoff order_ready push-first raggiunge solo i camerieri scelti nella stessa sala", async (t) => {
  const { baseUrl } = await startBackend(t, {
    env: {
      SSE_EVENT_PAYLOAD: "1",
      SSE_LEGACY_REFRESH: "0",
      BACKEND_REALTIME_SCOPED_DELIVERY: "1",
    },
    stateOverrides(state) {
      const otherRoomUser = state.users.find((entry) => entry.id === "u_cashier");
      otherRoomUser.authorizedRoomIds = ["room_sala"];
      otherRoomUser.enabledRoomIds = ["room_sala"];
    },
  });
  const target = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "sse-handoff-target",
    clientApp: "mobile-frontend",
  });
  await loginJson(baseUrl, "ultra_waiter", "3333", {
    deviceUuid: "sse-handoff-same-room",
    clientApp: "mobile-frontend",
  });
  await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "sse-handoff-other-room",
    clientApp: "mobile-frontend",
  });

  const controllers = [
    new AbortController(),
    new AbortController(),
    new AbortController(),
  ];
  t.after(() => controllers.forEach((controller) => controller.abort()));
  const streamUrls = [
    `${baseUrl}/api/integration/notifications/stream?consumer=handoff-target&clientApp=mobile-frontend&roomId=room_pedana&userId=u_waiter&deviceUuid=sse-handoff-target`,
    `${baseUrl}/api/integration/notifications/stream?consumer=handoff-same-room&clientApp=mobile-frontend&roomId=room_pedana&userId=u_ultra_waiter&deviceUuid=sse-handoff-same-room`,
    `${baseUrl}/api/integration/notifications/stream?consumer=handoff-other-room&clientApp=mobile-frontend&roomId=room_sala&userId=u_cashier&deviceUuid=sse-handoff-other-room`,
  ];
  const streams = await Promise.all(
    streamUrls.map((url, index) => fetch(url, { signal: controllers[index].signal })),
  );
  streams.forEach((response) => assert.equal(response.status, 200));

  const orderId = `handoff-order-${Date.now()}`;
  const publishResponse = await fetch(
    `${baseUrl}/api/integration/notifications/publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "bell",
        title: "Comanda pronta",
        description: "Handoff scoped",
        meta: {
          eventType: "order_ready",
          notificationPriority: "ritiro",
          orderId,
          roomId: "room_pedana",
          roomName: "Pedana",
          targetUserId: "u_waiter",
          targetUsername: "waiter",
          targetFullName: "Waiter Test",
          targetClientApp: "mobile-frontend",
        },
      }),
    },
  );
  assert.equal(publishResponse.status, 200);

  const matchesHandoff = (event) => {
    if (event.event !== "payload") return false;
    const parsed = JSON.parse(event.data || "{}");
    return (
      parsed.reason === "notification_handoff" &&
      parsed.detail?.orderId === orderId
    );
  };
  const targetMustNotReceive = assert.rejects(
    readSseEvent(streams[0], matchesHandoff, { timeoutMs: 8_000 }),
    /Evento SSE atteso non ricevuto/,
  );
  const selectedMustReceive = readSseEvent(streams[1], matchesHandoff, {
    timeoutMs: 8_000,
  });
  const otherRoomMustNotReceive = assert.rejects(
    readSseEvent(streams[2], matchesHandoff, { timeoutMs: 2_000 }),
    /Timeout SSE/,
  );

  const { response: logoutResponse } = await apiPost(
    baseUrl,
    "/api/auth/logout",
    authPayload(target, "sse-handoff-target", {
      clientApp: "mobile-frontend",
    }),
  );
  assert.equal(logoutResponse.status, 200);

  const selectedEvent = JSON.parse((await selectedMustReceive).data);
  assert.deepEqual(
    selectedEvent.detail?.notification?.meta?.targetUserIds,
    ["u_ultra_waiter"],
  );
  assert.equal(selectedEvent.detail?.notifications?.length, 1);
  assert.deepEqual(selectedEvent.detail?.audience?.userIds, ["u_ultra_waiter"]);
  await targetMustNotReceive;
  await otherRoomMustNotReceive;

  const stalePull = new URLSearchParams({
    consumer: "mobile:u_waiter:logged-out",
    ackConsumer: "mobile:u_waiter:logged-out",
    clientApp: "mobile-frontend",
    userId: target.user.id,
    username: target.user.username,
    fullName: target.user.fullName,
    deviceUuid: "sse-handoff-target",
  });
  const staleResponse = await fetch(
    `${baseUrl}/api/integration/notifications/pull?${stalePull}`,
  );
  assert.equal(staleResponse.status, 200);
  assert.deepEqual((await staleResponse.json()).items, []);
});

test("logout chiude lo stream del solo device uscito e conserva l'altra sessione dello stesso utente", async (t) => {
  const { baseUrl } = await startBackend(t, {
    env: {
      SSE_EVENT_PAYLOAD: "1",
      SSE_LEGACY_REFRESH: "0",
      BACKEND_REALTIME_SCOPED_DELIVERY: "1",
    },
  });
  const firstSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "sse-session-device-a",
    clientApp: "mobile-frontend",
  });
  const secondSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "sse-session-device-b",
    clientApp: "mobile-frontend",
  });
  const controllers = [new AbortController(), new AbortController()];
  t.after(() => controllers.forEach((controller) => controller.abort()));
  const streams = await Promise.all([
    fetch(
      `${baseUrl}/api/integration/notifications/stream?consumer=session-a&clientApp=mobile-frontend&userId=u_waiter&deviceUuid=sse-session-device-a`,
      { signal: controllers[0].signal },
    ),
    fetch(
      `${baseUrl}/api/integration/notifications/stream?consumer=session-b&clientApp=mobile-frontend&userId=u_waiter&deviceUuid=sse-session-device-b`,
      { signal: controllers[1].signal },
    ),
  ]);
  streams.forEach((response) => assert.equal(response.status, 200));

  const firstClosed = assert.rejects(
    readSseEvent(streams[0], () => false, { timeoutMs: 8_000 }),
    /Evento SSE atteso non ricevuto/,
  );
  const secondRemainsOpen = assert.rejects(
    readSseEvent(streams[1], () => false, { timeoutMs: 2_000 }),
    /Timeout SSE/,
  );
  const { response: logoutResponse } = await apiPost(
    baseUrl,
    "/api/auth/logout",
    authPayload(firstSession, "sse-session-device-a", {
      clientApp: "mobile-frontend",
    }),
  );
  assert.equal(logoutResponse.status, 200);
  await firstClosed;
  await secondRemainsOpen;

  const { response: secondStatus } = await apiPost(
    baseUrl,
    "/api/auth/session/status",
    authPayload(secondSession, "sse-session-device-b", {
      clientApp: "mobile-frontend",
    }),
  );
  assert.equal(secondStatus.status, 200);

  const revokedStream = await fetch(
    `${baseUrl}/api/integration/notifications/stream?consumer=session-a-reconnect&clientApp=mobile-frontend&userId=u_waiter&deviceUuid=sse-session-device-a`,
  );
  assert.equal(revokedStream.status, 401);
  assert.equal(
    (await revokedStream.json()).code,
    "NOTIFICATION_SESSION_REVOKED",
  );
});

test("nuovo login sullo stesso device chiude lo stream legato alla sessione revocata", async (t) => {
  const { baseUrl } = await startBackend(t, {
    env: {
      SSE_EVENT_PAYLOAD: "1",
      SSE_LEGACY_REFRESH: "0",
    },
  });
  const deviceUuid = "sse-relogin-device";
  const firstSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(
    `${baseUrl}/api/integration/notifications/stream?consumer=relogin&clientApp=mobile-frontend&userId=${firstSession.user.id}&username=${firstSession.user.username}&deviceUuid=${deviceUuid}`,
    { signal: controller.signal },
  );
  assert.equal(stream.status, 200);
  const closed = assert.rejects(
    readSseEvent(stream, () => false, { timeoutMs: 8_000 }),
    /Evento SSE atteso non ricevuto/,
  );

  const secondSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  assert.notEqual(secondSession.token, firstSession.token);
  await closed;

  const replacementController = new AbortController();
  t.after(() => replacementController.abort());
  const replacement = await fetch(
    `${baseUrl}/api/integration/notifications/stream?consumer=relogin-new&clientApp=mobile-frontend&userId=${secondSession.user.id}&username=${secondSession.user.username}&deviceUuid=${deviceUuid}`,
    { signal: replacementController.signal },
  );
  assert.equal(replacement.status, 200);
});
