import assert from "node:assert/strict";
import test from "node:test";

import { createTableLockWorkerRequestFastPath } from "../modules/tables/table-lock-worker-request-fastpath.js";

function createFixture(overrides = {}) {
  const counters = new Map();
  const operations = [];
  let sanitizeCalls = 0;
  let layoutCalls = 0;
  const db = {
    meta: { settingsVersion: 1, lastWriteAt: "2026-07-11T00:00:00.000Z" },
    menuItems: [],
    users: [{ id: "u1" }],
    posSettings: {
      tables: [
        { id: "t1", number: 1 },
        { id: "t2", number: 2 },
      ],
    },
  };
  const session = {
    id: "s1",
    userId: "u1",
    tokenHash: "hash:token",
    deviceUuid: "device-1",
  };
  const fastPath = createTableLockWorkerRequestFastPath({
    enabled: () => true,
    readDb: async () => db,
    sessionsRepository: {
      findSessionByTokenHash: async () => session,
    },
    hashSessionToken: (value) => `hash:${value}`,
    validateResolvedSessionContext: (_db, _payload, resolved) => ({
      session: resolved,
      user: db.users[0],
    }),
    sanitizePosSettings: (settings) => {
      sanitizeCalls += 1;
      return settings;
    },
    buildIntegrationLayoutFromSettings: (settings) => {
      layoutCalls += 1;
      return {
        tables: settings.tables.map((table) => ({
          ...table,
          roomId: "room-1",
          roomName: "Sala 1",
        })),
      };
    },
    runtimeMetrics: {
      incrementCounter(name) {
        counters.set(name, (counters.get(name) ?? 0) + 1);
      },
      recordOperation(group, label, durationMs) {
        operations.push({ group, label, durationMs });
      },
    },
    logger: { warn() {} },
    ...overrides,
  });
  return {
    counters,
    db,
    fastPath,
    operations,
    session,
    stats: () => ({ sanitizeCalls, layoutCalls }),
  };
}

test("[BE][P4] fast auth worker lock usa lookup puntuale e conserva token/device", async () => {
  const fixture = createFixture();
  const result = await fixture.fastPath.authenticate({
    token: "token",
    deviceUuid: "device-1",
  });

  assert.equal(result.db, fixture.db);
  assert.equal(result.context.session, fixture.session);
  assert.equal(fixture.counters.get("tableLockFastAuthHits"), 1);
  assert.ok(
    fixture.operations.some(
      (entry) =>
        entry.group === "tableLockWorkerFastPath" &&
        entry.label === "authLookup",
    ),
  );
});

test("[BE][P4] errore lookup sessione attiva fallback chiuso", async () => {
  const fixture = createFixture({
    sessionsRepository: {
      findSessionByTokenHash: async () => {
        throw new Error("mysql down");
      },
    },
  });

  assert.equal(
    await fixture.fastPath.authenticate({
      token: "token",
      deviceUuid: "device-1",
    }),
    null,
  );
  assert.equal(fixture.counters.get("tableLockFastAuthFallbacks"), 1);
});

test("[BE][P4] fast auth worker usa Redis senza interrogare MySQL", async () => {
  let mysqlLookups = 0;
  const fixture = createFixture({
    redisSessionCacheEnabled: () => true,
    redisVolatileStore: {
      sessionsEnabled: true,
      async getAuthSession(input) {
        assert.deepEqual(input, {
          deviceUuid: "device-1",
          tokenHash: "hash:token",
        });
        return { hit: true, value: { id: "redis-session", userId: "u1" } };
      },
    },
    sessionsRepository: {
      async findSessionByTokenHash() {
        mysqlLookups += 1;
        return null;
      },
    },
  });

  const result = await fixture.fastPath.authenticate({
    token: "token",
    deviceUuid: "device-1",
  });

  assert.equal(result.context.session.id, "redis-session");
  assert.equal(mysqlLookups, 0);
  assert.equal(fixture.counters.get("tableLockFastAuthCacheHits"), 1);
  assert.ok(fixture.operations.some((entry) => entry.label === "authCacheHit"));
});

test("[BE][P4] miss o errore Redis conserva il fallback autorevole MySQL", async () => {
  for (const response of [{ hit: false, skipped: "miss" }, new Error("redis down")]) {
    let mysqlLookups = 0;
    const fixture = createFixture({
      redisSessionCacheEnabled: () => true,
      redisVolatileStore: {
        sessionsEnabled: true,
        async getAuthSession() {
          if (response instanceof Error) throw response;
          return response;
        },
      },
      sessionsRepository: {
        async findSessionByTokenHash() {
          mysqlLookups += 1;
          return { id: "mysql-session", userId: "u1" };
        },
      },
    });

    const result = await fixture.fastPath.authenticate({ token: "token", deviceUuid: "device-1" });
    assert.equal(result.context.session.id, "mysql-session");
    assert.equal(mysqlLookups, 1);
  }
});

test("[BE][P4] indice tavoli viene riusato e invalidato dalla versione stato", () => {
  const fixture = createFixture();
  const first = fixture.fastPath.resolveTableContext(fixture.db, "t1");
  const second = fixture.fastPath.resolveTableContext(fixture.db, "t2");

  assert.equal(first.roomId, "room-1");
  assert.equal(second.table.number, 2);
  assert.deepEqual(fixture.stats(), { sanitizeCalls: 1, layoutCalls: 1 });
  assert.equal(fixture.counters.get("tableLockContextCacheHits"), 1);

  fixture.db.meta.settingsVersion = 2;
  fixture.fastPath.resolveTableContext(fixture.db, "t1");
  assert.deepEqual(fixture.stats(), { sanitizeCalls: 2, layoutCalls: 2 });
  assert.equal(fixture.counters.get("tableLockContextCacheMisses"), 2);
});
