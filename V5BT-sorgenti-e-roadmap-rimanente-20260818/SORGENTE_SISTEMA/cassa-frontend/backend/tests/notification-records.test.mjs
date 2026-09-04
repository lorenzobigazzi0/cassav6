import test from "node:test";
import assert from "node:assert/strict";
import {
  getIntegrationRecentBellClaims,
  normalizeIntegrationNotificationType,
  sanitizeIntegrationBellClaim,
  sanitizeIntegrationNotification,
} from "../modules/notifications/notification-records.js";
import {
  findPendingBellNotificationByOrderId,
  hasOtherAvailableWaiterForNotification,
  isMobilePickupNotificationForOrder,
  maybeEscalateBellNotification,
  notificationMatchesTarget,
  notificationTargetsPausedWaiter,
  removeMobilePickupNotificationsForOrder,
  resolveBellTargetFromActiveSessions,
  resolveNotificationRoomId,
  shouldSuppressNotificationForWaiterPause,
  waiterHintMatchesUser,
  waiterIsPausedForNotifications,
} from "../modules/notifications/notification-targeting.js";

test("notification records normalizza tipo e taglia delivered/acked senza duplicati", () => {
  assert.equal(normalizeIntegrationNotificationType("bell"), "bell");
  assert.equal(normalizeIntegrationNotificationType("unknown"), "general");

  const notification = sanitizeIntegrationNotification(
    {
      id: "ntf-1",
      type: "bell",
      title: "x".repeat(200),
      description: "y".repeat(300),
      createdAt: "1718000000000",
      deliveredTo: Array.from({ length: 30 }, (_, index) => `consumer-${index % 26}`),
      ackedBy: Array.from({ length: 30 }, (_, index) => `ack-${index % 26}`),
      meta: { eventType: "order_ready" },
    },
    "fallback"
  );

  assert.equal(notification.id, "ntf-1");
  assert.equal(notification.type, "bell");
  assert.equal(notification.title.length, 140);
  assert.equal(notification.description.length, 240);
  assert.equal(notification.createdAt, 1718000000000);
  assert.equal(notification.deliveredTo.length, 24);
  assert.equal(notification.ackedBy.length, 24);
  assert.equal(notification.meta.notificationPriority, "ritiro");

  assert.equal(
    sanitizeIntegrationNotification({
      createdAt: "2026-08-05T11:00:00.000Z",
    }).createdAt,
    Date.parse("2026-08-05T11:00:00.000Z"),
  );
  assert.equal(
    sanitizeIntegrationNotification({ createdAt: "2026garbage" }).createdAt,
    0,
  );
});

test("notification records normalizza claim campanello e scarta claim senza id", () => {
  assert.equal(sanitizeIntegrationBellClaim({ waiter: "Giada" }), null);

  const claim = sanitizeIntegrationBellClaim(
    {
      notificationId: "bell-1",
      orderId: "ord-1",
      station: "BAR",
      claimedAtMs: 1718000000000,
      claimedByUsername: "giada",
      claimedByDeviceUuid: "device-a",
    },
    "fallback"
  );

  assert.equal(claim.notificationId, "bell-1");
  assert.equal(claim.orderId, "ord-1");
  assert.equal(claim.claimedAtMs, 1718000000000);
  assert.equal(claim.claimedByFullName, "giada");
  assert.equal(claim.waiter, "giada");

  const recent = getIntegrationRecentBellClaims({
    recentBellClaims: [claim, { waiter: "senza id" }, { notificationId: "bell-2", waiter: "Anna" }],
  });
  assert.deepEqual(
    recent.map((entry) => entry.notificationId),
    ["bell-1", "bell-2"]
  );
});

test("notification targeting consegna squillo palmare per UUID alias o IP", () => {
  const base = {
    type: "general",
    meta: {
      eventType: "handheld_ring",
      targetClientApp: "mobile-frontend",
    },
  };

  assert.equal(
    notificationMatchesTarget(
      {
        ...base,
        meta: {
          ...base.meta,
          targetDeviceIdAliases: ["device-abc"],
        },
      },
      {
        clientApp: "mobile-frontend",
        deviceUuid: "device-abc",
      }
    ),
    true
  );

  assert.equal(
    notificationMatchesTarget(
      {
        ...base,
        meta: {
          ...base.meta,
          targetDeviceUuid: "device-config-id",
          targetClientIp: "192.168.1.77",
        },
      },
      {
        clientApp: "mobile-frontend",
        deviceUuid: "device-real-uuid",
        clientIp: "192.168.1.77",
      }
    ),
    true
  );

  assert.equal(
    notificationMatchesTarget(
      {
        ...base,
        meta: {
          ...base.meta,
          targetDeviceIdAliases: ["device-xyz"],
        },
      },
      {
        clientApp: "mobile-frontend",
        deviceUuid: "device-abc",
      }
    ),
    false
  );
});

test("notification targeting accetta il destinatario se combacia una identita utente", () => {
  const notification = {
    type: "bell",
    meta: {
      eventType: "order_ready",
      targetClientApp: "mobile-frontend",
      targetUserId: "u_old_session",
      targetUsername: "giada",
      targetFullName: "Giada Sala",
    },
  };

  assert.equal(
    notificationMatchesTarget(notification, {
      clientApp: "mobile-frontend",
      userId: "u_new_session",
      username: "giada",
      fullName: "Giada Sala",
    }),
    true
  );

  assert.equal(
    notificationMatchesTarget(notification, {
      clientApp: "mobile-frontend",
      userId: "u_other",
      username: "lorenzo",
      fullName: "Lorenzo Banco",
    }),
    false
  );
});

test("notification targeting riconosce notifiche pickup mobile per ordine o sorgente", () => {
  assert.equal(
    isMobilePickupNotificationForOrder(
      {
        id: "bell-1",
        type: "bell",
        meta: {
          orderId: "ORD-1",
          targetClientApp: "mobile-frontend",
        },
      },
      { orderId: "ORD-1" }
    ),
    true
  );
  assert.equal(
    isMobilePickupNotificationForOrder(
      {
        id: "ready-1",
        type: "general",
        meta: {
          eventType: "order_ready",
          orderId: "ORD-1",
          targetClientApp: "mobile_frontend",
        },
      },
      { orderId: "ORD-1" }
    ),
    true
  );
  assert.equal(
    isMobilePickupNotificationForOrder(
      {
        id: "claimed-1",
        type: "general",
        meta: {
          eventType: "bell_claimed_by_other",
          sourceNotificationId: "bell-1",
        },
      },
      { sourceNotificationId: "bell-1" }
    ),
    true
  );
  assert.equal(
    isMobilePickupNotificationForOrder(
      {
        id: "wrong-app",
        type: "general",
        meta: {
          eventType: "order_ready",
          orderId: "ORD-1",
          targetClientApp: "cassa-frontend",
        },
      },
      { orderId: "ORD-1" }
    ),
    false
  );
  assert.equal(isMobilePickupNotificationForOrder(null, { orderId: "ORD-1" }), false);
});

test("notification targeting rimuove notifiche pickup correlate mantenendo le altre", () => {
  const notifications = [
    {
      id: "bell-1",
      type: "bell",
      meta: {
        orderId: "ORD-1",
      },
    },
    {
      id: "claimed-1",
      type: "general",
      meta: {
        eventType: "bell_claimed_by_other",
        sourceNotificationId: "bell-1",
      },
    },
    {
      id: "other-order",
      type: "bell",
      meta: {
        orderId: "ORD-2",
      },
    },
  ];

  assert.equal(
    removeMobilePickupNotificationsForOrder(notifications, {
      orderId: "ORD-1",
      sourceNotificationId: "bell-1",
    }),
    2
  );
  assert.deepEqual(
    notifications.map((notification) => notification.id),
    ["other-order"]
  );
  assert.equal(removeMobilePickupNotificationsForOrder(null, { orderId: "ORD-1" }), 0);
});

test("notification targeting trova la bell pendente piu recente per ordine", () => {
  const integration = {
    notifications: [
      {
        id: "bell-old",
        type: "bell",
        meta: { orderId: "ORD-1" },
      },
      {
        id: "general-ready",
        type: "general",
        meta: { orderId: "ORD-1", eventType: "order_ready" },
      },
      {
        id: "bell-other",
        type: "bell",
        meta: { orderId: "ORD-2" },
      },
      {
        id: "bell-new",
        type: "bell",
        meta: { orderId: "ORD-1" },
      },
    ],
  };

  const pending = findPendingBellNotificationByOrderId(integration, " ORD-1 ", {
    sanitizeIntegrationNotification,
    hasBellClaim() {
      return false;
    },
  });
  assert.equal(pending.id, "bell-new");
});

test("notification targeting ignora bell gia claimata e input incompleti", () => {
  const integration = {
    notifications: [
      {
        id: "bell-claimed",
        type: "bell",
        meta: { orderId: "ORD-1" },
      },
      {
        id: "bell-pending",
        type: "bell",
        meta: { orderId: "ORD-1" },
      },
    ],
  };

  const pending = findPendingBellNotificationByOrderId(integration, "ORD-1", {
    sanitizeIntegrationNotification,
    hasBellClaim(_integration, notificationId) {
      return notificationId === "bell-pending";
    },
  });
  assert.equal(pending.id, "bell-claimed");
  assert.equal(findPendingBellNotificationByOrderId(integration, "", { sanitizeIntegrationNotification }), null);
  assert.equal(findPendingBellNotificationByOrderId(null, "ORD-1", { sanitizeIntegrationNotification }), null);
  assert.equal(findPendingBellNotificationByOrderId(integration, "ORD-1", {}), null);
});

test("notification targeting valuta pausa cameriere senza consegnare se c'e alternativa", () => {
  const notification = {
    type: "bell",
    meta: {
      targetRoomId: "room-gazebo",
    },
  };
  const requester = {
    userId: "user-1",
    deviceUuid: "device-1",
    roomId: "room-gazebo",
  };
  const dependencies = {
    collectActiveWaitersInRoom(_db, roomId, options = {}) {
      assert.equal(roomId, "room-gazebo");
      assert.equal(options.availableForNotifications, true);
      assert.equal(options.excludeUserId, "user-1");
      return [{ userId: "user-2", pauseStatus: { active: false } }];
    },
    resolveWaiterPauseState() {
      return { active: true, graceActive: false };
    },
  };

  assert.equal(waiterIsPausedForNotifications({ pauseStatus: { active: true } }), true);
  assert.equal(waiterIsPausedForNotifications({ pauseStatus: { graceActive: true } }), true);
  assert.equal(waiterIsPausedForNotifications({ pauseStatus: { active: false } }), false);
  assert.equal(notificationTargetsPausedWaiter(notification), true);
  assert.equal(resolveNotificationRoomId(notification, requester), "room-gazebo");
  assert.equal(hasOtherAvailableWaiterForNotification({}, notification, requester, dependencies), true);
  assert.equal(
    shouldSuppressNotificationForWaiterPause({}, notification, requester, { id: "user-1" }, dependencies),
    true
  );
});

test("notification targeting non sopprime urgenze o pause senza altri camerieri", () => {
  const requester = {
    userId: "user-1",
    deviceUuid: "device-1",
  };
  const dependencies = {
    activeWaiterWindowMs: 300000,
    collectLoggedInWaiters(_db, options = {}) {
      assert.equal(options.clientApp, "mobile-frontend");
      assert.equal(options.activeWithinMs, 300000);
      return [
        { userId: "user-1", deviceUuid: "device-1", pauseStatus: { active: true } },
        { userId: "user-2", deviceUuid: "device-2", pauseStatus: { active: true } },
      ];
    },
    resolveWaiterPauseState() {
      return { active: true, graceActive: false };
    },
  };

  assert.equal(notificationTargetsPausedWaiter({ type: "bell", meta: { urgent: true } }), false);
  assert.equal(
    hasOtherAvailableWaiterForNotification({}, { type: "waiter", meta: {} }, requester, dependencies),
    false
  );
  assert.equal(
    shouldSuppressNotificationForWaiterPause(
      {},
      { type: "waiter", meta: {} },
      requester,
      { id: "user-1" },
      dependencies
    ),
    false
  );
});

test("notification targeting risolve il target bell dalla sessione mobile attiva piu recente", () => {
  const nowMs = Date.parse("2026-06-07T10:00:00.000Z");
  const db = {
    users: [
      { id: "user-1", username: "giada", fullName: "Giada Rossi" },
      { id: "user-2", username: "roberto", fullName: "Roberto Bianchi" },
    ],
    sessions: [
      {
        userId: "user-1",
        clientApp: "mobile-frontend",
        deviceUuid: "device-old",
        lastSeenAt: "2026-06-07T09:58:00.000Z",
      },
      {
        userId: "user-1",
        clientApp: "mobile_frontend",
        deviceUuid: "device-new",
        lastSeenAt: "2026-06-07T09:59:45.000Z",
      },
      {
        userId: "user-2",
        clientApp: "mobile-frontend",
        deviceUuid: "device-roberto",
        lastSeenAt: "2026-06-07T09:59:55.000Z",
      },
    ],
  };

  assert.equal(waiterHintMatchesUser("Giada", db.users[0]), true);
  assert.equal(waiterHintMatchesUser("giada rossi", db.users[0]), true);
  assert.equal(waiterHintMatchesUser("roberto", db.users[0]), false);

  assert.deepEqual(
    resolveBellTargetFromActiveSessions(db, "giada", {
      nowMs,
      activeWindowMs: 300000,
    }),
    {
      targetUserId: "user-1",
      targetUsername: "giada",
      targetFullName: "Giada Rossi",
      targetDeviceUuid: "device-new",
    }
  );
});

test("notification targeting ignora target bell da sessioni stale, non mobile o senza hint", () => {
  const nowMs = Date.parse("2026-06-07T10:00:00.000Z");
  const db = {
    users: [{ id: "user-1", username: "giada", fullName: "Giada Rossi" }],
    sessions: [
      {
        userId: "user-1",
        clientApp: "cassa-frontend",
        deviceUuid: "device-cassa",
        lastSeenAt: "2026-06-07T09:59:59.000Z",
      },
      {
        userId: "user-1",
        clientApp: "mobile-frontend",
        deviceUuid: "device-stale",
        lastSeenAt: "2026-06-07T09:50:00.000Z",
      },
    ],
  };

  assert.equal(resolveBellTargetFromActiveSessions(db, "", { nowMs, activeWindowMs: 300000 }), null);
  assert.equal(resolveBellTargetFromActiveSessions(db, "giada", { nowMs, activeWindowMs: 300000 }), null);
  assert.equal(resolveBellTargetFromActiveSessions({ users: [], sessions: [] }, "giada"), null);
});

test("notification targeting escala bell mirata a tutti solo dopo timeout", () => {
  const notification = {
    id: "bell-1",
    type: "bell",
    createdAt: 1000,
    ackedBy: [],
    meta: {
      targetUserId: "user-1",
      targetUsername: "giada",
      targetFullName: "Giada Rossi",
      targetDeviceUuid: "device-1",
      targetRoomId: "room-1",
      targetRoomName: "Gazebo",
      targetStation: "BAR-1",
      waiter: "Giada",
    },
  };

  assert.equal(
    maybeEscalateBellNotification(notification, {
      nowMs: 1499,
      defaultTargetTimeoutMs: 500,
    }),
    false
  );
  assert.equal(notification.meta.targetUserId, "user-1");

  assert.equal(
    maybeEscalateBellNotification(notification, {
      nowMs: 1500,
      defaultTargetTimeoutMs: 500,
    }),
    true
  );
  assert.equal(notification.meta.targetClientApp, "mobile-frontend");
  assert.equal(notification.meta.escalatedToAllAtMs, 1500);
  assert.equal(notification.meta.originalWaiter, "Giada");
  assert.equal(notification.meta.targetUserId, undefined);
  assert.equal(notification.meta.targetUsername, undefined);
  assert.equal(notification.meta.targetFullName, undefined);
  assert.equal(notification.meta.targetDeviceUuid, undefined);
  assert.equal(notification.meta.targetRoomId, undefined);
  assert.equal(notification.meta.targetRoomName, undefined);
  assert.equal(notification.meta.targetStation, undefined);
  assert.equal(notification.meta.waiter, undefined);
});

test("notification targeting non escala bell gia ackata o senza target", () => {
  assert.equal(
    maybeEscalateBellNotification(
      {
        type: "bell",
        createdAt: 1000,
        ackedBy: ["consumer-1"],
        meta: {
          targetUserId: "user-1",
        },
      },
      {
        nowMs: 2000,
        defaultTargetTimeoutMs: 500,
      }
    ),
    false
  );
  assert.equal(
    maybeEscalateBellNotification(
      {
        type: "bell",
        createdAt: 1000,
        ackedBy: [],
        meta: {},
      },
      {
        nowMs: 2000,
        defaultTargetTimeoutMs: 500,
      }
    ),
    false
  );
  assert.equal(maybeEscalateBellNotification({ type: "general", meta: { targetUserId: "user-1" } }), false);
});
