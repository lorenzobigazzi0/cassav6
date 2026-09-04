import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRealtimeSubscription,
  isRealtimeSubscriptionEligible,
  resolveRealtimeAudience,
} from "../modules/realtime-backbone/realtime-audience.js";

test("audience realtime filtra una sala ma conserva il fallback legacy", () => {
  const roomA = buildRealtimeSubscription({
    clientApp: "mobile-frontend",
    roomId: "room_a",
    userId: "waiter_a",
  });
  const roomB = buildRealtimeSubscription({
    clientApp: "mobile-frontend",
    roomId: "room_b",
    userId: "waiter_b",
  });
  const legacy = buildRealtimeSubscription({ clientApp: "legacy-client" });
  const audience = resolveRealtimeAudience({
    type: "order.created",
    payload: { detail: { roomId: "room_a", station: "BAR" } },
  });

  assert.equal(isRealtimeSubscriptionEligible(roomA, audience, { enabled: true }), true);
  assert.equal(isRealtimeSubscriptionEligible(roomB, audience, { enabled: true }), false);
  assert.equal(isRealtimeSubscriptionEligible(legacy, audience, { enabled: true }), true);
  assert.equal(isRealtimeSubscriptionEligible(roomB, audience, { enabled: false }), true);
});

test("audience realtime indirizzata a utente prevale sullo scope sala", () => {
  const target = buildRealtimeSubscription({
    clientApp: "mobile-frontend",
    roomId: "room_b",
    userId: "waiter_a",
    deviceUuid: "device_a",
  });
  const other = buildRealtimeSubscription({
    clientApp: "mobile-frontend",
    roomId: "room_a",
    userId: "waiter_b",
    deviceUuid: "device_b",
  });
  const audience = resolveRealtimeAudience({
    type: "notification",
    detail: {
      roomId: "room_a",
      notification: {
        meta: {
          targetUserId: "waiter_a",
          targetClientApp: "mobile-frontend",
        },
      },
    },
  });

  assert.equal(isRealtimeSubscriptionEligible(target, audience, { enabled: true }), true);
  assert.equal(isRealtimeSubscriptionEligible(other, audience, { enabled: true }), false);
});

test("audience realtime handoff accetta soltanto gli user id scelti", () => {
  const firstTarget = buildRealtimeSubscription({
    clientApp: "mobile-frontend",
    userId: "waiter_a",
  });
  const secondTarget = buildRealtimeSubscription({
    clientApp: "mobile-frontend",
    userId: "waiter_b",
  });
  const loggedOut = buildRealtimeSubscription({
    clientApp: "mobile-frontend",
    userId: "waiter_offline",
  });
  const audience = resolveRealtimeAudience({
    type: "notification",
    detail: {
      notification: {
        meta: {
          targetUserIds: ["waiter_a", "waiter_b"],
          excludeUserIds: ["waiter_offline"],
          targetClientApp: "mobile-frontend",
        },
      },
    },
  });

  assert.equal(isRealtimeSubscriptionEligible(firstTarget, audience, { enabled: true }), true);
  assert.equal(isRealtimeSubscriptionEligible(secondTarget, audience, { enabled: true }), true);
  assert.equal(isRealtimeSubscriptionEligible(loggedOut, audience, { enabled: true }), false);
});

test("settings.updated resta globale", () => {
  const subscription = buildRealtimeSubscription({ roomId: "room_b", userId: "waiter_b" });
  const audience = resolveRealtimeAudience({
    type: "settings.updated",
    payload: { detail: { roomId: "room_a" } },
  });

  assert.equal(audience.global, true);
  assert.equal(isRealtimeSubscriptionEligible(subscription, audience, { enabled: true }), true);
});
