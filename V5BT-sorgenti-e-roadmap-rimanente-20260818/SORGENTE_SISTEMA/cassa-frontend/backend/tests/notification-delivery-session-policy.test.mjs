import assert from "node:assert/strict";
import test from "node:test";

import {
  findLatestSessionForNotificationRequester,
  isNotificationSessionActive,
} from "../modules/notifications/notification-delivery.js";
import {
  filterNotificationEventForSession,
  parseNotificationTimestampMs,
} from "../modules/notifications/notification-session-policy.js";

const normalizeClientApp = (value) =>
  String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
const normalizeUsername = (value) =>
  String(value ?? "").trim().toLowerCase();
const nowMs = Date.parse("2026-08-05T11:00:00.000Z");
const serviceOptions = {
  normalizeClientApp,
  normalizeUsername,
  nowMs,
  sessionIdleTimeoutMs: 30 * 60 * 1000,
};

function session(overrides = {}) {
  return {
    id: "session_default",
    userId: "u_waiter",
    deviceUuid: "device-a",
    clientApp: "mobile-frontend",
    createdAt: "2026-08-05T10:30:00.000Z",
    lastSeenAt: "2026-08-05T10:45:00.000Z",
    expiresAt: "2026-08-05T12:00:00.000Z",
    ...overrides,
  };
}

test("parser timestamp accetta millisecondi e ISO UTC rigorosi", () => {
  assert.equal(parseNotificationTimestampMs(nowMs), nowMs);
  assert.equal(
    parseNotificationTimestampMs("2026-08-05T11:00:00.000Z"),
    nowMs,
  );
  assert.equal(parseNotificationTimestampMs(String(nowMs)), nowMs);
  assert.equal(parseNotificationTimestampMs("2026-02-30T11:00:00.000Z"), 0);
  assert.equal(parseNotificationTimestampMs("2026-08-05 11:00:00"), 0);
  assert.equal(parseNotificationTimestampMs("2026garbage"), 0);
  assert.equal(parseNotificationTimestampMs(2026), 0);
});

test("selezione sessione usa createdAt e lastSeenAt solo come spareggio", () => {
  const user = { id: "u_waiter", username: "waiter", fullName: "Waiter" };
  const db = {
    users: [user],
    sessions: [
      session({
        id: "session_old_recently_touched",
        createdAt: "2026-08-05T10:10:00.000Z",
        lastSeenAt: "2026-08-05T10:59:00.000Z",
      }),
      session({
        id: "session_new",
        createdAt: "2026-08-05T10:40:00.000Z",
        lastSeenAt: "2026-08-05T10:45:00.000Z",
      }),
    ],
  };
  const selected = findLatestSessionForNotificationRequester(
    db,
    {
      clientApp: "mobile-frontend",
      userId: user.id,
      username: user.username,
      deviceUuid: "device-a",
    },
    user,
    serviceOptions,
  );
  assert.equal(selected?.id, "session_new");
});

test("sessioni malformed, scadute e idle sono rifiutate", () => {
  assert.equal(isNotificationSessionActive(session(), serviceOptions), true);
  assert.equal(
    isNotificationSessionActive(
      session({ createdAt: "not-a-date" }),
      serviceOptions,
    ),
    false,
  );
  assert.equal(
    isNotificationSessionActive(
      session({ expiresAt: "2026-08-05T10:59:59.999Z" }),
      serviceOptions,
    ),
    false,
  );
  assert.equal(
    isNotificationSessionActive(
      session({
        createdAt: "2026-08-05T09:00:00.000Z",
        lastSeenAt: "2026-08-05T10:29:59.999Z",
      }),
      serviceOptions,
    ),
    false,
  );
});

test("identita contraddittorie non selezionano la sessione", () => {
  const user = { id: "u_waiter", username: "waiter", fullName: "Waiter" };
  const db = { users: [user], sessions: [session()] };
  const selected = findLatestSessionForNotificationRequester(
    db,
    {
      clientApp: "mobile-frontend",
      userId: user.id,
      username: "another-user",
      deviceUuid: "device-a",
    },
    user,
    serviceOptions,
  );
  assert.equal(selected, null);
});

test("batch realtime misto filtra ogni notifica e scarta timestamp malformed", () => {
  const sessionStartedAtMs = Date.parse("2026-08-05T10:30:00.000Z");
  const event = {
    type: "notification",
    createdAt: "2026-08-05T10:40:00.000Z",
    payload: {
      atMs: Date.parse("2026-08-05T10:40:00.000Z"),
      detail: {
        notifications: [
          { id: "stale", createdAt: sessionStartedAtMs - 1 },
          { id: "current-iso", createdAt: "2026-08-05T10:31:00.000Z" },
          { id: "malformed", createdAt: "2026garbage" },
          { id: "current-ms", createdAt: sessionStartedAtMs + 2 },
        ],
      },
    },
  };
  const filtered = filterNotificationEventForSession(event, sessionStartedAtMs);
  assert.deepEqual(
    filtered.payload.detail.notifications.map((entry) => entry.id),
    ["current-iso", "current-ms"],
  );
  assert.equal(event.payload.detail.notifications.length, 4);
});
