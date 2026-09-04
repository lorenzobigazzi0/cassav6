import assert from "node:assert/strict";
import test from "node:test";

import { createTableWorkLockHelpers } from "../modules/tables/table-work-lock.domain.js";

const fixedNow = new Date("2026-06-07T10:00:00.000Z");

function createHelpers() {
  return createTableWorkLockHelpers({
    hasPermission: (user, permission) => Array.isArray(user?.permissions) && user.permissions.includes(permission),
    heartbeatWriteMinIntervalMs: 10_000,
    isAdminUser: (user) => user?.role === "admin",
    nowIso: () => fixedNow.toISOString(),
    nowMs: () => fixedNow.getTime(),
    tableLockTtlMs: 120_000,
  });
}

test("sanitizeTableWorkLock rejects incomplete or expired-shape records", () => {
  const { sanitizeTableWorkLock } = createHelpers();

  assert.equal(sanitizeTableWorkLock(null), null);
  assert.equal(sanitizeTableWorkLock({ tableId: "t1", userId: "u1" }), null);
  assert.deepEqual(
    sanitizeTableWorkLock({
      tableId: " t1 ",
      userId: " u1 ",
      expiresAt: "2026-06-07T10:05:00.000Z",
    }),
    {
      tableId: "t1",
      userId: "u1",
      username: "u1",
      deviceUuid: "",
      sessionId: "",
      purpose: "table_mutation",
      acquiredAt: fixedNow.toISOString(),
      heartbeatAt: fixedNow.toISOString(),
      expiresAt: "2026-06-07T10:05:00.000Z",
    }
  );
});

test("isTableWorkLockExpired treats invalid locks as expired", () => {
  const { isTableWorkLockExpired } = createHelpers();
  const now = fixedNow.getTime();

  assert.equal(isTableWorkLockExpired(null, now), true);
  assert.equal(isTableWorkLockExpired({ tableId: "t1", userId: "u1", expiresAt: "2026-06-07T09:59:59.000Z" }, now), true);
  assert.equal(isTableWorkLockExpired({ tableId: "t1", userId: "u1", expiresAt: "2026-06-07T10:00:01.000Z" }, now), false);
});

test("isSameTableLockOwner accepts same session or same device only for same user", () => {
  const { isSameTableLockOwner } = createHelpers();
  const lock = {
    tableId: "t1",
    userId: "u1",
    sessionId: "s1",
    deviceUuid: "d1",
    expiresAt: "2026-06-07T10:05:00.000Z",
  };

  assert.equal(isSameTableLockOwner(lock, { id: "u1" }, { id: "s1", deviceUuid: "other" }), true);
  assert.equal(isSameTableLockOwner(lock, { id: "u1" }, { id: "other", deviceUuid: "d1" }), true);
  assert.equal(isSameTableLockOwner(lock, { id: "u2" }, { id: "s1", deviceUuid: "d1" }), false);
  assert.equal(isSameTableLockOwner(lock, { id: "u1" }, { id: "other", deviceUuid: "other" }), false);
});

test("canOverrideTableWorkLock follows admin and configured permissions", () => {
  const { canOverrideTableWorkLock } = createHelpers();

  assert.equal(canOverrideTableWorkLock({ role: "admin" }), true);
  assert.equal(canOverrideTableWorkLock({ permissions: ["approve_room_change"] }), true);
  assert.equal(canOverrideTableWorkLock({ permissions: ["manage_tables"] }), true);
  assert.equal(canOverrideTableWorkLock({ permissions: ["manage_settings"] }), true);
  assert.equal(canOverrideTableWorkLock({ permissions: ["orders"] }), false);
});

test("buildTableWorkLock normalizes owner and expiration data", () => {
  const { buildTableWorkLock } = createHelpers();
  const lock = buildTableWorkLock({
    tableId: "t1",
    user: { id: "u1", username: "chiara" },
    session: { id: "s1", deviceUuid: "d1" },
    purpose: "payment",
  });

  assert.equal(lock.tableId, "t1");
  assert.equal(lock.userId, "u1");
  assert.equal(lock.username, "chiara");
  assert.equal(lock.sessionId, "s1");
  assert.equal(lock.deviceUuid, "d1");
  assert.equal(lock.purpose, "payment");
  assert.equal(lock.acquiredAt, fixedNow.toISOString());
  assert.equal(lock.heartbeatAt, fixedNow.toISOString());
  assert.equal(lock.expiresAt, new Date(fixedNow.getTime() + 120_000).toISOString());
});

test("shouldReuseRecentTableWorkLock only reuses same-purpose fresh heartbeats", () => {
  const { shouldReuseRecentTableWorkLock } = createHelpers();
  const now = fixedNow.getTime();
  const previousLock = {
    purpose: "payment",
    heartbeatAt: new Date(now - 5_000).toISOString(),
  };

  assert.equal(shouldReuseRecentTableWorkLock(previousLock, "payment", now), true);
  assert.equal(shouldReuseRecentTableWorkLock(previousLock, "order", now), false);
  assert.equal(shouldReuseRecentTableWorkLock({ ...previousLock, heartbeatAt: new Date(now - 11_000).toISOString() }, "payment", now), false);
  assert.equal(shouldReuseRecentTableWorkLock(null, "payment", now), false);
});
