import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrderReadyHandoffRealtimeEvents,
  handoffOfflineOrderReadyNotifications,
} from "../modules/notifications/order-ready-handoff.js";
import { shouldGloballyAcknowledgeNotification } from "../modules/notifications/notification-ack-policy.js";
import { notificationMatchesTarget } from "../modules/notifications/notification-targeting.js";

function readyNotification(overrides = {}) {
  return {
    id: "ntf_ready_1",
    type: "bell",
    title: "Comanda pronta",
    description: "Ordine 42",
    createdAt: 1_000,
    deliveredTo: [],
    ackedBy: [],
    meta: {
      eventType: "order_ready",
      orderId: "42",
      roomId: "room_sala",
      roomName: "Sala",
      targetUserId: "waiter_offline",
      targetUsername: "mario",
      targetFullName: "Mario Rossi",
      targetDeviceUuid: "device-offline",
      targetClientApp: "mobile-frontend",
      ...overrides,
    },
  };
}

function waiter(userId, roomId, overrides = {}) {
  return {
    userId,
    username: userId,
    fullName: userId,
    deviceUuid: `${userId}-device`,
    roomId,
    assignedRoomIds: roomId ? [roomId] : [],
    notificationPriorities: ["ordine", "consegna", "ritiro"],
    online: true,
    activeNow: true,
    pauseStatus: { active: false, graceActive: false },
    ...overrides,
  };
}

test("order ready handoff privilegia i camerieri disponibili nella stessa sala", () => {
  const notification = readyNotification();
  const result = handoffOfflineOrderReadyNotifications({
    notifications: [notification],
    activeWaiters: [
      waiter("waiter_same_room", "room_sala"),
      waiter("waiter_other_room", "room_gazebo"),
      waiter("waiter_paused", "room_sala", {
        onPause: true,
        pauseStatus: { active: true, graceActive: false },
      }),
    ],
    reason: "target_logout",
    excludeUserId: "waiter_offline",
    excludeDeviceUuid: "device-offline",
    nowMs: 2_000,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(notification.meta.targetUserIds, ["waiter_same_room"]);
  assert.equal(notification.meta.targetRoomId, "room_sala");
  assert.equal(notification.meta.targetFallbackScope, "same_room");
  assert.equal(notification.meta.originalTargetUserId, "waiter_offline");
  assert.equal(notification.meta.originalTargetUsername, "mario");
  assert.equal(notification.meta.originalTargetDeviceUuid, "device-offline");
  assert.deepEqual(notification.meta.excludeUserIds, ["waiter_offline"]);
  assert.equal(notification.meta.notificationHandoffAtMs, 2_000);
  assert.equal(notification.meta.targetUserId, undefined);
  assert.equal(shouldGloballyAcknowledgeNotification(notification), true);

  assert.equal(
    notificationMatchesTarget(notification, {
      clientApp: "mobile-frontend",
      userId: "waiter_same_room",
      roomId: "room_sala",
      assignedRoomIds: ["room_sala"],
    }),
    true,
  );
  assert.equal(
    notificationMatchesTarget(notification, {
      clientApp: "mobile-frontend",
      userId: "waiter_other_room",
      roomId: "room_gazebo",
    }),
    false,
  );
});

test("order ready handoff usa gli altri camerieri quando la sala non ne ha", () => {
  const notification = readyNotification();
  const result = handoffOfflineOrderReadyNotifications({
    notifications: [notification],
    activeWaiters: [
      waiter("waiter_gazebo", "room_gazebo"),
      waiter("waiter_pedana", "room_pedana"),
      waiter("waiter_paused", "room_sala", {
        pauseStatus: { active: false, graceActive: true },
      }),
    ],
    nowMs: 3_000,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(notification.meta.targetUserIds, [
    "waiter_gazebo",
    "waiter_pedana",
  ]);
  assert.equal(notification.meta.targetRoomId, undefined);
  assert.equal(notification.meta.targetFallbackScope, "online_mobile");

  const events = buildOrderReadyHandoffRealtimeEvents(result);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].detail.notifications, [notification]);
  assert.deepEqual(events[0].detail.audience, {
    clientApps: ["mobile-frontend"],
    userIds: ["waiter_gazebo", "waiter_pedana"],
  });
});

test("order ready non viene ceduta se un'altra sessione del target resta online anche in pausa", () => {
  const notification = readyNotification();
  const result = handoffOfflineOrderReadyNotifications({
    notifications: [notification],
    activeWaiters: [
      waiter("waiter_offline", "room_sala", {
        username: "mario",
        fullName: "Mario Rossi",
        deviceUuid: "device-still-online",
        onPause: true,
        pauseStatus: { active: true, graceActive: false },
      }),
      waiter("waiter_same_room", "room_sala"),
    ],
    onlyTargetIdentity: {
      userId: "waiter_offline",
      deviceUuid: "device-offline",
    },
    mobileLogout: true,
  });

  assert.equal(result.changed, false);
  assert.equal(result.mobileLogout, true);
  assert.equal(notification.meta.targetUserId, "waiter_offline");
  assert.equal(notification.meta.targetUserIds, undefined);
});

test("order ready ackata o destinata a un altro utente non viene ceduta al logout", () => {
  const acknowledged = readyNotification({
    acknowledgedAtMs: 1_500,
  });
  const otherTarget = readyNotification({
    targetUserId: "another_waiter",
    targetUsername: "another",
    targetFullName: "Another Waiter",
  });
  const result = handoffOfflineOrderReadyNotifications({
    notifications: [acknowledged, otherTarget],
    activeWaiters: [waiter("waiter_same_room", "room_sala")],
    onlyTargetIdentity: {
      userId: "waiter_offline",
      username: "mario",
      fullName: "Mario Rossi",
      deviceUuid: "device-offline",
    },
    mobileLogout: true,
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.notificationIds, []);
});

test("un handoff successivo non rimanda la comanda al cameriere originariamente uscito", () => {
  const notification = readyNotification({
    targetUserId: undefined,
    targetUsername: undefined,
    targetFullName: undefined,
    targetDeviceUuid: undefined,
    targetUserIds: ["waiter_previous_handoff"],
    originalTargetUserId: "waiter_offline",
    originalTargetUsername: "mario",
    excludeUserIds: ["waiter_offline"],
    notificationHandoffActive: true,
  });
  const result = handoffOfflineOrderReadyNotifications({
    notifications: [notification],
    activeWaiters: [
      waiter("waiter_offline", "room_sala"),
      waiter("waiter_new", "room_sala"),
    ],
    onlineWaiters: [
      waiter("waiter_offline", "room_sala"),
      waiter("waiter_new", "room_sala"),
    ],
  });

  assert.equal(result.changed, true);
  assert.deepEqual(notification.meta.targetUserIds, ["waiter_new"]);
  assert.equal(notification.meta.originalTargetUserId, "waiter_offline");
  assert.equal(notification.meta.originalTargetUserIds, undefined);
  assert.equal(notification.meta.excludeUserIds.includes("waiter_offline"), true);
});
