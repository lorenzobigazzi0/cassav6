import assert from "node:assert/strict";
import test from "node:test";

import { createApiWorkerRequestFastPath } from "../modules/auth/api-worker-request-fastpath.js";

function createFixture(overrides = {}) {
  const calls = [];
  const counters = new Map();
  const db = { users: [{ id: "user-1" }], sessions: [] };
  const session = {
    id: "session-1",
    userId: "user-1",
    deviceUuid: "device-1",
    tokenHash: "hash-token-1",
  };
  const options = {
    enabled: true,
    readDb: async () => {
      calls.push("read-db");
      return db;
    },
    sessionsRepository: {
      async findSessionByTokenHash(input) {
        calls.push("mysql-lookup");
        assert.deepEqual(input, {
          tokenHash: "hash-token-1",
          deviceUuid: "device-1",
        });
        return session;
      },
    },
    redisVolatileStore: {
      sessionsEnabled: true,
      async getAuthSession() {
        calls.push("redis-get");
        return { hit: false, skipped: "miss" };
      },
      async storeAuthSession(value) {
        calls.push("redis-store");
        assert.equal(value, session);
        return true;
      },
    },
    redisSessionCacheEnabled: true,
    hashSessionToken: (value) => `hash-${value}`,
    validateResolvedSessionContext(receivedDb, payload, receivedSession) {
      calls.push("validate");
      assert.equal(receivedDb, db);
      assert.equal(payload.token, "token-1");
      return { user: db.users[0], session: receivedSession };
    },
    runtimeMetrics: {
      incrementCounter(name) {
        counters.set(name, (counters.get(name) ?? 0) + 1);
      },
      recordOperation(category, label) {
        calls.push(`metric:${category}:${label}`);
      },
    },
    logger: { warn() {} },
    ...overrides,
  };
  return {
    calls,
    counters,
    db,
    fastPath: createApiWorkerRequestFastPath(options),
    payload: { token: "token-1", deviceUuid: "device-1", userId: "user-1" },
    session,
  };
}

test("[BE][P4] fast auth API usa Redis senza rileggere MySQL", async () => {
  const fixture = createFixture();
  fixture.fastPath = createApiWorkerRequestFastPath({
    enabled: true,
    readDb: async () => {
      fixture.calls.push("read-db");
      return fixture.db;
    },
    sessionsRepository: {
      async findSessionByTokenHash() {
        throw new Error("lookup MySQL inatteso");
      },
    },
    redisVolatileStore: {
      sessionsEnabled: true,
      async getAuthSession() {
        fixture.calls.push("redis-get");
        return { hit: true, value: fixture.session };
      },
    },
    redisSessionCacheEnabled: true,
    hashSessionToken: (value) => `hash-${value}`,
    validateResolvedSessionContext: (_db, _payload, session) => ({ session }),
    runtimeMetrics: {
      incrementCounter: (name) => fixture.counters.set(name, (fixture.counters.get(name) ?? 0) + 1),
      recordOperation: (_category, label) => fixture.calls.push(`metric:${label}`),
    },
  });

  const result = await fixture.fastPath.authenticate(fixture.payload);

  assert.equal(result.context.session, fixture.session);
  assert.deepEqual(fixture.calls, ["read-db", "redis-get", "metric:authCacheHit"]);
  assert.equal(fixture.counters.get("apiWorkerFastAuthCacheHits"), 1);
});

test("[BE][P4] miss Redis usa lookup indicizzato e riscalda la cache", async () => {
  const fixture = createFixture();

  const result = await fixture.fastPath.authenticate(fixture.payload);

  assert.equal(result.context.session, fixture.session);
  assert.deepEqual(
    fixture.calls.filter((entry) => !entry.startsWith("metric:")),
    ["read-db", "redis-get", "mysql-lookup", "redis-store", "validate"],
  );
  assert.equal(fixture.counters.get("apiWorkerFastAuthCacheMisses"), 1);
  assert.equal(fixture.counters.get("apiWorkerFastAuthHits"), 1);
  assert.equal(fixture.counters.get("apiWorkerFastAuthCacheWrites"), 1);
});

test("[BE][P4] errore Redis degrada sul lookup MySQL senza bypass auth", async () => {
  const fixture = createFixture({
    redisVolatileStore: {
      sessionsEnabled: true,
      async getAuthSession() {
        throw new Error("redis offline");
      },
      async storeAuthSession() {
        return false;
      },
    },
  });

  const result = await fixture.fastPath.authenticate(fixture.payload);

  assert.equal(result.context.session, fixture.session);
  assert.equal(fixture.counters.get("apiWorkerFastAuthCacheErrors"), 1);
  assert.equal(fixture.counters.get("apiWorkerFastAuthHits"), 1);
});

test("[BE][P4] errore repository restituisce null per il fallback legacy", async () => {
  const fixture = createFixture({
    redisSessionCacheEnabled: false,
    sessionsRepository: {
      async findSessionByTokenHash() {
        throw new Error("mysql offline");
      },
    },
  });

  const result = await fixture.fastPath.authenticate(fixture.payload);

  assert.equal(result, null);
  assert.equal(fixture.counters.get("apiWorkerFastAuthFallbacks"), 1);
  assert.ok(!fixture.calls.includes("validate"));
});

test("[BE][P4] flag spento non legge stato, Redis o MySQL", async () => {
  const fixture = createFixture({ enabled: false });

  const result = await fixture.fastPath.authenticate(fixture.payload);

  assert.equal(result, null);
  assert.deepEqual(fixture.calls, []);
});
