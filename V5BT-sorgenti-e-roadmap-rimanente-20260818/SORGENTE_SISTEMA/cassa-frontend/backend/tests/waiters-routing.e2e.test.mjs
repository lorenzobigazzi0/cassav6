import test from "node:test";
import assert from "node:assert/strict";
import {
  apiPost,
  authHeaders,
  authPayload,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

async function touchWaiterRoom(baseUrl, session) {
  const params = new URLSearchParams({
    consumer: "mobile:u_waiter:routing",
    clientApp: "mobile-frontend",
    userId: session.user.id,
    username: session.user.username,
    fullName: session.user.fullName,
    deviceUuid: "waiter-routing-device",
    roomId: "room_pedana",
    roomName: "Pedana",
  });
  const response = await fetch(
    `${baseUrl}/api/integration/notifications/pull?${params}`,
  );
  assert.equal(response.status, 200);
}

async function publishRoomNotification(baseUrl, params) {
  const { response, body } = await apiPost(
    baseUrl,
    "/api/integration/notifications/publish",
    {
      type: "general",
      title: params.title,
      description: "Routing test",
      meta: {
        targetClientApp: "mobile-frontend",
        targetRoomId: params.roomId,
        notificationPriority: params.priority,
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(body?.ok, true);
  return body.notification;
}

async function pullWaiterNotifications(baseUrl, session) {
  const params = new URLSearchParams({
    consumer: "mobile:u_waiter:routing-pull",
    ackConsumer: "mobile:u_waiter:routing-pull",
    clientApp: "mobile-frontend",
    userId: session.user.id,
    username: session.user.username,
    fullName: session.user.fullName,
    deviceUuid: "waiter-routing-device",
  });
  const response = await fetch(
    `${baseUrl}/api/integration/notifications/pull?${params}`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body?.ok, true);
  return body.items ?? [];
}

test("pausa cameriere start/stop usa lane presenza e non coda globale", async (t) => {
  const deviceUuid = "waiter-pause-lane-device";
  const { baseUrl } = await startBackend(t, {
    env: { RUNTIME_METRICS: "1" },
    stateOverrides(state) {
      const admin = state.users.find((entry) => entry.username === "admin_test");
      admin.waiterPauseSettings = { enabled: true, durationMinutes: 15, renewalMinutes: 120 };
    },
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const reset = await apiPost(
    baseUrl,
    "/api/monitor/runtime-metrics/reset",
    authPayload(session, deviceUuid, { clientApp: "mobile-frontend" }),
  );
  assert.equal(reset.response.status, 200);

  for (const action of ["start", "stop"]) {
    const result = await apiPost(
      baseUrl,
      `/api/mobile/waiter-pause/${action}`,
      authPayload(session, deviceUuid, {
        clientApp: "mobile-frontend",
        roomId: "room_pedana",
        roomName: "Pedana",
      }),
    );
    assert.equal(result.response.status, 200);
  }

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(session, deviceUuid),
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.runtimeMetrics.counters.dbMutationEnqueued, 0);
  assert.equal(
    metrics.runtimeMetrics.counters.waiterPauseLaneEnqueued +
    metrics.runtimeMetrics.counters.notificationLaneEnqueued +
      metrics.runtimeMetrics.counters.stationStateLaneEnqueued,
    2,
  );
  const operations = metrics.runtimeMetrics.operations.runMsByLabel;
  for (const label of [
    "waiterPauseWorkflow:start.state.transition",
    "waiterPauseWorkflow:start.state.appStateWrite",
    "waiterPauseWorkflow:start.realtime.publish",
    "waiterPauseWorkflow:start.total.started",
    "waiterPauseWorkflow:stop.deferred.tableRoomMoveFlush",
    "waiterPauseWorkflow:stop.deferred.waiterFlush",
    "waiterPauseWorkflow:stop.state.appStateWrite",
    "waiterPauseWorkflow:stop.realtime.publish",
    "waiterPauseWorkflow:stop.total.stopped",
  ]) {
    assert.equal(operations[label]?.count, 1, label);
  }
});

test("pausa cameriere concorrente e' idempotente e attribuisce la lane alla richiesta", async (t) => {
  const deviceUuid = "waiter-pause-idempotent-device";
  const { baseUrl, dbPath } = await startBackend(t, {
    env: { RUNTIME_METRICS: "1" },
    stateOverrides(state) {
      const admin = state.users.find((entry) => entry.username === "admin_test");
      admin.waiterPauseSettings = { enabled: true, durationMinutes: 15, renewalMinutes: 120 };
    },
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const reset = await apiPost(
    baseUrl,
    "/api/monitor/runtime-metrics/reset",
    authPayload(session, deviceUuid, { clientApp: "mobile-frontend" }),
  );
  assert.equal(reset.response.status, 200);

  const requestAction = (action) => apiPost(
    baseUrl,
    `/api/mobile/waiter-pause/${action}`,
    authPayload(session, deviceUuid, {
      clientApp: "mobile-frontend",
      roomId: "room_pedana",
      roomName: "Pedana",
    }),
  );
  const starts = await Promise.all([requestAction("start"), requestAction("start")]);
  const stops = await Promise.all([requestAction("stop"), requestAction("stop")]);
  for (const result of [...starts, ...stops]) assert.equal(result.response.status, 200);

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(session, deviceUuid),
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = (await metricsResponse.json()).runtimeMetrics;
  assert.equal(
    metrics.counters.waiterPauseLaneEnqueued +
      metrics.counters.stationStateLaneEnqueued,
    4,
  );
  assert.equal(metrics.counters.writeDb, 2);

  const operations = metrics.operations.runMsByLabel;
  for (const [label, count] of [
    ["waiterPauseWorkflow:start.total.started", 1],
    ["waiterPauseWorkflow:start.total.already_paused", 1],
    ["waiterPauseWorkflow:start.state.appStateWrite", 1],
    ["waiterPauseWorkflow:start.realtime.publish", 1],
    ["waiterPauseWorkflow:stop.total.stopped", 1],
    ["waiterPauseWorkflow:stop.total.already_active", 1],
    ["waiterPauseWorkflow:stop.state.appStateWrite", 1],
    ["waiterPauseWorkflow:stop.realtime.publish", 1],
  ]) {
    assert.equal(operations[label]?.count, count, label);
  }

  const queueKind = metrics.counters.waiterPauseLaneEnqueued > 0
    ? "waiterPauseLane"
    : "stationStateLane";
  const startLaneWait =
    (operations["waiterPauseWorkflow:start.laneWait.started"]?.sum ?? 0) +
    (operations["waiterPauseWorkflow:start.laneWait.already_paused"]?.sum ?? 0);
  const stopLaneWait =
    (operations["waiterPauseWorkflow:stop.laneWait.stopped"]?.sum ?? 0) +
    (operations["waiterPauseWorkflow:stop.laneWait.already_active"]?.sum ?? 0);
  assert.equal(
    startLaneWait,
    metrics.queues[queueKind].waitMsByLabel[
      "POST /api/mobile/waiter-pause/start"
    ]?.sum ?? 0,
  );
  assert.equal(
    stopLaneWait,
    metrics.queues[queueKind].waitMsByLabel[
      "POST /api/mobile/waiter-pause/stop"
    ]?.sum ?? 0,
  );
  assert.equal(
    metrics.requests.writeDbCountByRoute["POST /api/mobile/waiter-pause/start"]?.sum,
    1,
  );
  assert.equal(
    metrics.requests.writeDbCountByRoute["POST /api/mobile/waiter-pause/stop"]?.sum,
    1,
  );

  const persisted = await readJson(dbPath);
  assert.equal(
    persisted.auditEvents.filter((entry) => entry.action === "waiter.pause_started").length,
    1,
  );
  assert.equal(
    persisted.auditEvents.filter((entry) => entry.action === "waiter.pause_stopped").length,
    1,
  );
});

test("pausa cameriere status resta read-only e fuori dalle lane mutative", async (t) => {
  const deviceUuid = "waiter-pause-status-device";
  const { baseUrl } = await startBackend(t, {
    env: { RUNTIME_METRICS: "1" },
    stateOverrides(state) {
      const admin = state.users.find((entry) => entry.username === "admin_test");
      admin.waiterPauseSettings = { enabled: true, durationMinutes: 15, renewalMinutes: 120 };
    },
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const reset = await apiPost(
    baseUrl,
    "/api/monitor/runtime-metrics/reset",
    authPayload(session, deviceUuid, { clientApp: "mobile-frontend" }),
  );
  assert.equal(reset.response.status, 200);

  const status = await apiPost(
    baseUrl,
    "/api/mobile/waiter-pause/status",
    authPayload(session, deviceUuid, {
      clientApp: "mobile-frontend",
      roomId: "room_pedana",
      roomName: "Pedana",
    }),
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body?.ok, true);

  const metricsResponse = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(session, deviceUuid),
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.runtimeMetrics.counters.writeDb, 0);
  assert.equal(metrics.runtimeMetrics.counters.waiterPauseLaneEnqueued, 0);
  assert.equal(metrics.runtimeMetrics.counters.notificationLaneEnqueued, 0);
  assert.equal(metrics.runtimeMetrics.counters.stationStateLaneEnqueued, 0);
  const operations = metrics.runtimeMetrics.operations.runMsByLabel;
  assert.equal(operations["waiterPauseWorkflow:status.readDb.handler"]?.count, 1);
  assert.equal(operations["waiterPauseWorkflow:status.state.resolve"]?.count, 1);
  assert.equal(operations["waiterPauseWorkflow:status.total.ok"]?.count, 1);
});

test("waiters endpoint espone sala assegnata e priorita operative", async (t) => {
  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      const waiter = state.users.find((user) => user.id === "u_waiter");
      waiter.notificationPriorities = ["ritiro", "consegna"];
      state.posSettings.areas = [
        {
          id: "room_pedana",
          name: "Pedana",
          waiterUserIds: ["u_waiter"],
          menuIds: [],
          printerIds: [],
          cashPoints: [],
          workstations: [],
        },
      ];
    },
  });
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-routing-device",
    clientApp: "mobile-frontend",
  });
  await touchWaiterRoom(baseUrl, session);

  const response = await fetch(
    `${baseUrl}/api/integration/waiters?source=mobile-frontend&activeMs=60000`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body?.ok, true);
  const waiter = body.waiters.find((entry) => entry.userId === "u_waiter");

  assert.ok(waiter);
  assert.equal(waiter.assignedRoomIds.includes("room_pedana"), true);
  assert.equal(waiter.assignedToCurrentRoom, true);
  assert.deepEqual(waiter.notificationPriorities, ["ritiro", "consegna"]);
});

test("cameriere mobile resta rilevabile per sala anche se la sessione non porta roomId", async (t) => {
  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      const waiter = state.users.find((user) => user.id === "u_waiter");
      waiter.enabledRoomIds = ["room_pedana"];
      waiter.authorizedRoomIds = ["room_pedana"];
      state.posSettings.areas = [
        {
          id: "room_pedana",
          name: "Pedana",
          waiterUserIds: [],
          menuIds: [],
          printerIds: [],
          cashPoints: [],
          workstations: [],
        },
      ];
    },
  });
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-routing-device",
    clientApp: "mobile-frontend",
  });

  const waiterResponse = await fetch(
    `${baseUrl}/api/integration/waiters?source=mobile-frontend&activeMs=300000`,
  );
  assert.equal(waiterResponse.status, 200);
  const waiterBody = await waiterResponse.json();
  const waiter = waiterBody.waiters.find(
    (entry) => entry.userId === session.user.id,
  );
  assert.ok(waiter);
  assert.equal(waiter.assignedRoomIds.includes("room_pedana"), true);

  const { response, body } = await apiPost(
    baseUrl,
    "/api/integration/notifications/publish",
    {
      type: "bell",
      title: "Comanda pronta",
      description: "Routing stanza via permessi",
      meta: {
        sourceApp: "cassa-frontend",
        orderSource: "cassa-frontend",
        roomId: "room_pedana",
        roomName: "Pedana",
        orderId: "00077",
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(body?.ok, true);
  assert.equal(body.notification.meta.waiterDispatchMode, "room_first_confirm");
  assert.equal(body.notification.meta.targetRoomId, "room_pedana");
});

test("pull notifiche usa sale assegnate e priorita abilitate del cameriere", async (t) => {
  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      const waiter = state.users.find((user) => user.id === "u_waiter");
      waiter.notificationPriorities = ["ritiro"];
      state.posSettings.areas = [
        {
          id: "room_pedana",
          name: "Pedana",
          waiterUserIds: ["u_waiter"],
          menuIds: [],
          printerIds: [],
          cashPoints: [],
          workstations: [],
        },
        {
          id: "room_sala",
          name: "Sala",
          waiterUserIds: [],
          menuIds: [],
          printerIds: [],
          cashPoints: [],
          workstations: [],
        },
      ];
    },
  });
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-routing-device",
    clientApp: "mobile-frontend",
  });
  const allowed = await publishRoomNotification(baseUrl, {
    title: "Ritiro Pedana",
    roomId: "room_pedana",
    priority: "ritiro",
  });
  const wrongPriority = await publishRoomNotification(baseUrl, {
    title: "Ordine Pedana",
    roomId: "room_pedana",
    priority: "ordine",
  });
  const wrongRoom = await publishRoomNotification(baseUrl, {
    title: "Ritiro Sala",
    roomId: "room_sala",
    priority: "ritiro",
  });

  const items = await pullWaiterNotifications(baseUrl, session);
  const ids = new Set(items.map((item) => item.id));

  assert.equal(ids.has(allowed.id), true);
  assert.equal(ids.has(wrongPriority.id), false);
  assert.equal(ids.has(wrongRoom.id), false);
});

test("ack mobile di chiamata cameriere consegna feedback alla postazione chiamante", async (t) => {
  const { baseUrl } = await startBackend(t);
  const session = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-routing-device",
    clientApp: "mobile-frontend",
  });
  const requesterFeedbackConsumer =
    "postazione-waiter-call-feedback:bar_1:device_1";

  const { response, body } = await apiPost(
    baseUrl,
    "/api/integration/notifications/publish",
    {
      type: "waiter",
      title: "BAR-1",
      description: "Richiesta da Roberto - Cameriere: Waiter Test",
      meta: {
        station: "BAR-1",
        targetStation: "BAR-1",
        requestedBy: "Roberto",
        requesterFeedbackConsumer,
        waiter: "Waiter Test",
        targetUserId: session.user.id,
        targetUsername: session.user.username,
        targetFullName: session.user.fullName,
        targetClientApp: "mobile-frontend",
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(body?.ok, true);
  const notificationId = body.notification.id;

  const ack = await apiPost(baseUrl, "/api/integration/notifications/ack", {
    id: notificationId,
    consumer: "mobile:u_waiter:routing-device",
    action: "ack",
    userId: session.user.id,
    username: session.user.username,
    fullName: session.user.fullName,
    deviceUuid: "waiter-routing-device",
    clientApp: "mobile-frontend",
  });
  assert.equal(ack.response.status, 200);
  assert.equal(ack.body?.ok, true);

  const params = new URLSearchParams({
    consumer: requesterFeedbackConsumer,
    ackConsumer: requesterFeedbackConsumer,
    clientApp: "postazione",
    station: "BAR-1",
    deviceUuid: "device_1",
  });
  const feedbackResponse = await fetch(
    `${baseUrl}/api/integration/notifications/pull?${params}`,
  );
  assert.equal(feedbackResponse.status, 200);
  const feedbackBody = await feedbackResponse.json();
  const feedback = feedbackBody.items.find(
    (item) =>
      item.meta?.eventType === "waiter_ack" &&
      item.meta?.sourceNotificationId === notificationId,
  );

  assert.ok(feedback);
  assert.equal(feedback.meta.targetConsumer, requesterFeedbackConsumer);
  assert.equal(feedback.meta.waiter, "Waiter Test");
});

test("cambio sala richiede conferma solo se nella sala destinazione c'e un cameriere disponibile", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      const waiter = state.users.find((user) => user.id === "u_waiter");
      waiter.authorizedRoomIds = ["room_pedana", "room_sala"];
      waiter.enabledRoomIds = ["room_pedana", "room_sala"];
      const cashier = state.users.find((user) => user.id === "u_cashier");
      cashier.waiterPauseSettings = {
        enabled: true,
        durationMinutes: 15,
        renewalMinutes: 120,
      };
    },
  });

  const requester = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "room-move-requester",
    clientApp: "mobile-frontend",
  });
  const targetWaiter = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "room-move-target",
    clientApp: "mobile-frontend",
  });
  const targetRoomLogin = await apiPost(
    baseUrl,
    "/api/pos/room-change/request",
    authPayload(targetWaiter, "room-move-target", {
      targetRoomId: "room_sala",
    }),
  );
  assert.equal(targetRoomLogin.response.status, 200);
  assert.equal(targetRoomLogin.body?.status, "approved");

  const active = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/request",
    authPayload(requester, "room-move-requester", {
      fromRoomId: "room_pedana",
      fromRoomName: "Pedana",
      targetRoomId: "room_sala",
      fromTableId: "room_pedana_t05",
      fromTableLabel: "5",
      targetTableIds: ["room_sala_t01"],
      targetTableLabels: ["1"],
    }),
  );
  assert.equal(active.response.status, 200);
  assert.equal(active.body?.status, "pending");

  const paused = await apiPost(
    baseUrl,
    "/api/mobile/waiter-pause/start",
    authPayload(targetWaiter, "room-move-target", {
      roomId: "room_sala",
      roomName: "Sala",
      clientApp: "mobile-frontend",
    }),
  );
  assert.equal(paused.response.status, 200);
  assert.equal(paused.body?.pause?.active, true);

  const direct = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/request",
    authPayload(requester, "room-move-requester", {
      fromRoomId: "room_pedana",
      fromRoomName: "Pedana",
      targetRoomId: "room_sala",
      fromTableId: "room_pedana_t06",
      fromTableLabel: "6",
      targetTableIds: ["room_sala_t02"],
      targetTableLabels: ["2"],
    }),
  );
  assert.equal(direct.response.status, 200);
  assert.equal(direct.body?.status, "approved");
  assert.equal(direct.body?.direct, true);
  const afterDirect = await readJson(dbPath);
  assert.equal(
    afterDirect.integration.waiterDeferredCalls.some(
      (entry) =>
        entry.payload?.meta?.eventType === "table_room_move_after_pause",
    ),
    true,
  );

  const stopped = await apiPost(
    baseUrl,
    "/api/mobile/waiter-pause/stop",
    authPayload(targetWaiter, "room-move-target", {
      roomId: "room_sala",
      roomName: "Sala",
      clientApp: "mobile-frontend",
    }),
  );
  assert.equal(stopped.response.status, 200);
  assert.equal(
    stopped.body?.pause?.active,
    false,
    JSON.stringify(stopped.body),
  );
  const afterStopped = await readJson(dbPath);
  const afterPauseNotifications = afterStopped.integration.notifications.filter(
    (entry) => entry.meta?.eventType === "table_room_move_after_pause",
  );
  assert.equal(
    afterStopped.integration.waiterDeferredCalls.some(
      (entry) =>
        entry.payload?.meta?.eventType === "table_room_move_after_pause",
    ),
    false,
    JSON.stringify(afterStopped.integration.waiterDeferredCalls),
  );
  assert.equal(
    afterPauseNotifications.length,
    1,
    JSON.stringify(afterStopped.integration.notifications),
  );

  const params = new URLSearchParams({
    consumer: "mobile:cashier:room-move-after-pause",
    ackConsumer: "mobile:cashier:room-move-after-pause",
    clientApp: "mobile-frontend",
    userId: targetWaiter.user.id,
    username: targetWaiter.user.username,
    fullName: targetWaiter.user.fullName,
    deviceUuid: "room-move-target",
    roomId: "room_sala",
    roomName: "Sala",
  });
  const notificationsResponse = await fetch(
    `${baseUrl}/api/integration/notifications/pull?${params}`,
  );
  assert.equal(notificationsResponse.status, 200);
  const notificationsBody = await notificationsResponse.json();
  const deferred = notificationsBody.items.find(
    (item) =>
      item.meta?.eventType === "table_room_move_after_pause" &&
      item.meta?.fromTableId === "room_pedana_t06",
  );
  assert.ok(deferred, JSON.stringify(notificationsBody.items));
  assert.equal(deferred.meta.targetRoomId, "room_sala");
});

test("cambio sala verso sala senza camerieri attivi viene approvato direttamente", async (t) => {
  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      const waiter = state.users.find((user) => user.id === "u_waiter");
      waiter.authorizedRoomIds = ["room_pedana", "room_sala"];
      waiter.enabledRoomIds = ["room_pedana", "room_sala"];
    },
  });
  const requester = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "room-move-alone",
    clientApp: "mobile-frontend",
  });

  const result = await apiPost(
    baseUrl,
    "/api/integration/layout/table/room-move/request",
    authPayload(requester, "room-move-alone", {
      fromRoomId: "room_pedana",
      fromRoomName: "Pedana",
      targetRoomId: "room_sala",
      fromTableId: "room_pedana_t05",
      fromTableLabel: "5",
      targetTableIds: ["room_sala_t01"],
      targetTableLabels: ["1"],
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body?.status, "approved");
  assert.equal(result.body?.direct, true);
});

test("cambio sala sgancia l'operatore dalla sala precedente anche con pull vecchi", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const session = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "room-switch-device",
    clientApp: "mobile-frontend",
  });

  const firstRoom = await apiPost(
    baseUrl,
    "/api/pos/room-change/request",
    authPayload(session, "room-switch-device", {
      targetRoomId: "room_pedana",
    }),
  );
  assert.equal(firstRoom.response.status, 200);
  assert.equal(firstRoom.body?.status, "approved");

  const nextRoom = await apiPost(
    baseUrl,
    "/api/pos/room-change/request",
    authPayload(session, "room-switch-device", {
      targetRoomId: "room_sala",
    }),
  );
  assert.equal(nextRoom.response.status, 200);
  assert.equal(nextRoom.body?.status, "approved");

  const waiterResponse = await fetch(
    `${baseUrl}/api/integration/waiters?source=mobile-frontend&activeMs=300000`,
  );
  assert.equal(waiterResponse.status, 200);
  const waiterBody = await waiterResponse.json();
  const cashier = waiterBody.waiters.find(
    (entry) => entry.userId === session.user.id,
  );
  assert.ok(cashier);
  assert.equal(cashier.roomId, "room_sala");
  assert.deepEqual(cashier.assignedRoomIds, ["room_sala"]);

  const oldRoomNotification = await publishRoomNotification(baseUrl, {
    title: "Pedana vecchia",
    roomId: "room_pedana",
    priority: "ordine",
  });
  const currentRoomNotification = await publishRoomNotification(baseUrl, {
    title: "Sala attuale",
    roomId: "room_sala",
    priority: "ordine",
  });
  const params = new URLSearchParams({
    consumer: "mobile:cashier:room-switch",
    ackConsumer: "mobile:cashier:room-switch",
    clientApp: "mobile-frontend",
    userId: session.user.id,
    username: session.user.username,
    fullName: session.user.fullName,
    deviceUuid: "room-switch-device",
    roomId: "room_pedana",
    roomName: "Pedana",
  });
  const notificationsResponse = await fetch(
    `${baseUrl}/api/integration/notifications/pull?${params}`,
  );
  assert.equal(notificationsResponse.status, 200);
  const notificationsBody = await notificationsResponse.json();
  const ids = new Set((notificationsBody.items ?? []).map((item) => item.id));
  assert.equal(ids.has(oldRoomNotification.id), false);
  assert.equal(ids.has(currentRoomNotification.id), true);

  const state = await readJson(dbPath);
  const persistedSession = state.sessions.find(
    (entry) => entry.deviceUuid === "room-switch-device",
  );
  assert.equal(persistedSession?.roomId, "room_sala");
});
