import assert from "node:assert/strict";
import test from "node:test";

import { createMysqlTableLocksRepository } from "../db/app-state/index.js";

function buildLock(userId = "u1") {
  return {
    tableId: "table-1",
    userId,
    username: userId,
    deviceUuid: `device-${userId}`,
    sessionId: `session-${userId}`,
    purpose: "test",
    acquiredAt: "2026-07-11T00:00:00.000Z",
    heartbeatAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2026-07-11T00:05:00.000Z",
  };
}

function createFakeMysql({ deadlockFirstSelect = false, hasActiveColumn = true } = {}) {
  const calls = [];
  const lifecycle = { begin: 0, commit: 0, rollback: 0, release: 0 };
  let currentRow = null;
  let shouldDeadlock = deadlockFirstSelect;
  let activeColumnExists = hasActiveColumn;
  const connection = {
    async beginTransaction() {
      lifecycle.begin += 1;
    },
    async commit() {
      lifecycle.commit += 1;
    },
    async rollback() {
      lifecycle.rollback += 1;
    },
    release() {
      lifecycle.release += 1;
    },
    async query(sql, params = []) {
      calls.push(String(sql));
      if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }]];
      if (/RELEASE_LOCK/.test(sql)) return [[{ released: 1 }]];
      if (/FOR UPDATE/.test(sql)) {
        if (shouldDeadlock) {
          shouldDeadlock = false;
          throw Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" });
        }
        return [[...(currentRow ? [currentRow] : [])]];
      }
      if (/INSERT INTO/.test(sql)) {
        if (/VALUES\s*\(\?,\s*0,/.test(sql)) {
          if (currentRow) {
            currentRow.app_state_position = params[1];
          } else {
            currentRow = {
              table_id: params[0],
              is_active: 0,
              user_id: "",
              expires_at_ms: 0,
              app_state_position: params[1],
              raw_json: params[3],
            };
          }
        } else if (
          currentRow &&
          /ON DUPLICATE KEY UPDATE\s+app_state_position = VALUES\(app_state_position\)/s.test(
            sql,
          )
        ) {
          currentRow.app_state_position = params[10];
        } else {
          currentRow = {
            table_id: params[0],
            is_active: 1,
            user_id: params[1],
            expires_at_ms: params[9],
            app_state_position: params[10],
            raw_json: params[12],
          };
        }
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE[\s\S]+SET is_active = 0/.test(sql)) {
        if (/WHERE table_id = \?/.test(sql) && currentRow) {
          currentRow = {
            ...currentRow,
            is_active: 0,
            user_id: "",
            expires_at_ms: 0,
            raw_json: params[1],
          };
        }
        return [{ affectedRows: currentRow ? 1 : 0 }];
      }
      if (/DELETE FROM/.test(sql)) {
        currentRow = null;
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };
  return {
    calls,
    lifecycle,
    get currentRow() {
      return currentRow;
    },
    repository: {
      async query(sql) {
        calls.push(String(sql));
        if (/SHOW COLUMNS[\s\S]+is_active/.test(sql)) {
          return activeColumnExists ? [{ Field: "is_active" }] : [];
        }
        if (/ALTER TABLE[\s\S]+ADD COLUMN is_active/.test(sql)) {
          activeColumnExists = true;
          return [];
        }
        if (/SELECT \*/.test(sql)) {
          return currentRow && Number(currentRow.is_active ?? 1) === 1
            ? [currentRow]
            : [];
        }
        return [];
      },
      async getPool() {
        return {
          async getConnection() {
            return connection;
          },
        };
      },
    },
  };
}

function createMetrics() {
  const counters = new Map();
  const operations = [];
  return {
    counters,
    operations,
    runtimeMetrics: {
      incrementCounter(name) {
        counters.set(name, (counters.get(name) ?? 0) + 1);
      },
      recordOperation(group, label, durationMs) {
        operations.push({ group, label, durationMs });
      },
    },
  };
}

test("[BE][P4] repository lock usa named lock nel profilo compatibile", async () => {
  const fake = createFakeMysql();
  const repository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    namedLocksEnabled: true,
    logger: { info() {} },
  });

  const result = await repository.mutateTableLock("table-1", () => ({
    nextLock: buildLock(),
  }));
  assert.equal(result.previousLock, null);
  assert.ok(fake.calls.some((sql) => /GET_LOCK/.test(sql)));
  assert.ok(fake.calls.some((sql) => /RELEASE_LOCK/.test(sql)));
  assert.equal(fake.lifecycle.commit, 1);
});

test("[BE][P4] repository lock transazionale salta named lock", async () => {
  const fake = createFakeMysql();
  const metrics = createMetrics();
  const repository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    namedLocksEnabled: false,
    runtimeMetrics: metrics.runtimeMetrics,
    logger: { info() {} },
  });

  await repository.mutateTableLock("table-1", () => ({
    nextLock: buildLock(),
  }));
  assert.equal(fake.calls.some((sql) => /GET_LOCK|RELEASE_LOCK/.test(sql)), false);
  assert.equal(metrics.counters.get("tableLockMysqlNamedLockSkips"), 1);
  const operationLabels = new Set(
    metrics.operations
      .filter((entry) => entry.group === "tableLockMysql")
      .map((entry) => entry.label),
  );
  for (const label of [
    "connection.wait",
    "connection.hold",
    "attempt.total",
    "transaction.begin",
    "row.selectForUpdate",
    "callback",
    "row.write",
    "transaction.commit",
    "transaction.total",
    "mutation.total",
  ]) {
    assert.equal(operationLabels.has(label), true, `metrica mancante: ${label}`);
  }
});

test("[BE][P4] repository puo saltare named lock per una singola mutazione", async () => {
  const fake = createFakeMysql();
  const repository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    namedLocksEnabled: true,
    logger: { info() {} },
  });

  await repository.mutateTableLock(
    "table-1",
    () => ({ nextLock: buildLock() }),
    { namedLock: false },
  );
  assert.equal(fake.calls.some((sql) => /GET_LOCK|RELEASE_LOCK/.test(sql)), false);
});

test("[BE][P4] repository transazionale ritenta un deadlock senza perdere la mutazione", async () => {
  const fake = createFakeMysql({ deadlockFirstSelect: true });
  const metrics = createMetrics();
  const repository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    namedLocksEnabled: false,
    runtimeMetrics: metrics.runtimeMetrics,
    logger: { info() {} },
  });

  const result = await repository.mutateTableLock("table-1", () => ({
    nextLock: buildLock(),
  }));
  assert.equal(result.nextLock.userId, "u1");
  assert.equal(fake.lifecycle.begin, 2);
  assert.equal(fake.lifecycle.rollback, 1);
  assert.equal(fake.lifecycle.commit, 1);
  assert.equal(metrics.counters.get("tableLockMysqlRetries"), 1);
  assert.equal(metrics.counters.get("tableLockMysqlErrors") ?? 0, 0);
  assert.equal(
    metrics.operations.filter((entry) => entry.label === "connection.wait").length,
    2,
  );
  assert.equal(
    metrics.operations.filter((entry) => entry.label === "connection.hold").length,
    2,
  );
  assert.equal(
    metrics.operations.filter((entry) => entry.label === "attempt.total").length,
    2,
  );
  assert.equal(
    metrics.operations.filter((entry) => entry.label === "retry.backoff").length,
    1,
  );
});

test("[BE][P4] schema lock aggiunge is_active alle installazioni esistenti", async () => {
  const fake = createFakeMysql({ hasActiveColumn: false });
  const repository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    logger: { info() {} },
  });

  assert.equal(await repository.getLock("table-1"), null);
  assert.ok(fake.calls.some((sql) => /SHOW COLUMNS[\s\S]+is_active/.test(sql)));
  assert.ok(
    fake.calls.some((sql) => /ALTER TABLE[\s\S]+ADD COLUMN is_active/.test(sql)),
  );
});

test("[BE][P4] tombstone mantiene la riga e consente la riacquisizione", async () => {
  const fake = createFakeMysql();
  const metrics = createMetrics();
  const repository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    namedLocksEnabled: false,
    tombstonesEnabled: true,
    runtimeMetrics: metrics.runtimeMetrics,
    logger: { info() {} },
  });

  await repository.mutateTableLock("table-1", () => ({
    nextLock: buildLock("u1"),
  }));
  await repository.mutateTableLock("table-1", (currentLock) => {
    assert.equal(currentLock?.userId, "u1");
    return { delete: true, released: true };
  });

  assert.equal(fake.currentRow?.is_active, 0);
  assert.equal(await repository.getLock("table-1"), null);
  assert.equal(
    fake.calls.some((sql) => /DELETE FROM[\s\S]+WHERE table_id = \?/.test(sql)),
    false,
  );
  assert.equal(metrics.counters.get("tableLockMysqlTombstoneWrites"), 1);

  await repository.mutateTableLock("table-1", (currentLock) => {
    assert.equal(currentLock, null);
    return { nextLock: buildLock("u2") };
  });
  assert.equal(fake.currentRow?.is_active, 1);
  assert.equal((await repository.getLock("table-1"))?.userId, "u2");
});

test("[BE][P4] rollback legacy riattiva un tombstone e torna al DELETE", async () => {
  const fake = createFakeMysql();
  const tombstoneRepository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    namedLocksEnabled: false,
    tombstonesEnabled: true,
    logger: { info() {} },
  });
  await tombstoneRepository.mutateTableLock("table-1", () => ({
    nextLock: buildLock("u1"),
  }));
  await tombstoneRepository.mutateTableLock("table-1", () => ({ delete: true }));

  const legacyRepository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    namedLocksEnabled: false,
    tombstonesEnabled: false,
    logger: { info() {} },
  });
  await legacyRepository.mutateTableLock("table-1", (currentLock) => {
    assert.equal(currentLock, null);
    return { nextLock: buildLock("u2") };
  });
  assert.equal((await legacyRepository.getLock("table-1"))?.userId, "u2");
  await legacyRepository.mutateTableLock("table-1", () => ({ delete: true }));
  assert.equal(fake.currentRow, null);
});

test("[BE][P4] hydrate tombstone pre-seed i tavoli e non espone lock fantasma", async () => {
  const fake = createFakeMysql();
  const repository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    namedLocksEnabled: false,
    tombstonesEnabled: true,
    logger: { info() {} },
  });

  const hydrated = await repository.hydrateAppState({
    posSettings: { tables: [{ id: "table-1", workLock: null }] },
  });
  assert.equal(fake.currentRow?.is_active, 0);
  assert.equal(hydrated.posSettings.tables[0].workLock, null);
  assert.ok(fake.calls.some((sql) => /VALUES\s*\(\?,\s*0,/.test(sql)));
});

test("[BE][P4] hydrate tombstone non ripete il seed per un inventario invariato", async () => {
  const fake = createFakeMysql();
  const repository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    namedLocksEnabled: false,
    tombstonesEnabled: true,
    logger: { info() {} },
  });
  const state = {
    posSettings: { tables: [{ id: "table-1", workLock: null }] },
  };

  await repository.hydrateAppState(state);
  await repository.hydrateAppState(state);

  assert.equal(
    fake.calls.filter((sql) => /INSERT INTO/.test(sql)).length,
    1,
  );
  assert.equal(fake.lifecycle.begin, 1);
  assert.equal(
    fake.calls.filter((sql) => /expires_at_ms <= \?/.test(sql)).length,
    2,
  );

  await repository.hydrateAppState({
    posSettings: {
      tables: [
        { id: "table-1", workLock: null },
        { id: "table-2", workLock: null },
      ],
    },
  });
  assert.equal(fake.calls.filter((sql) => /INSERT INTO/.test(sql)).length, 3);
  assert.equal(fake.lifecycle.begin, 2);
});

test("[BE][P4] hydrate tombstone non sovrascrive un lock autorevole attivo", async () => {
  const fake = createFakeMysql();
  const repository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    namedLocksEnabled: false,
    tombstonesEnabled: true,
    logger: { info() {} },
  });
  const liveLock = (userId) => {
    const now = new Date();
    return {
      ...buildLock(userId),
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    };
  };
  const staleLock = liveLock("stale-owner");
  const staleAppState = {
    posSettings: {
      tables: [{ id: "table-1", workLock: staleLock }],
    },
  };

  await repository.hydrateAppState(staleAppState);
  await repository.mutateTableLock("table-1", () => ({
    nextLock: liveLock("authoritative-owner"),
  }));

  const hydrated = await repository.hydrateAppState(staleAppState);
  assert.equal((await repository.getLock("table-1"))?.userId, "authoritative-owner");
  assert.equal(
    hydrated.posSettings.tables[0].workLock?.userId,
    "authoritative-owner",
  );
});

test("[BE][P4] hydrate tombstone non resuscita un lock gia rilasciato", async () => {
  const fake = createFakeMysql();
  const repository = createMysqlTableLocksRepository({
    enabled: true,
    mysqlRepository: fake.repository,
    namedLocksEnabled: false,
    tombstonesEnabled: true,
    logger: { info() {} },
  });
  const now = new Date();
  const staleLock = {
    ...buildLock("released-owner"),
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
  };
  const staleAppState = {
    posSettings: {
      tables: [{ id: "table-1", workLock: staleLock }],
    },
  };

  await repository.hydrateAppState(staleAppState);
  await repository.mutateTableLock("table-1", () => ({ delete: true }));

  const hydrated = await repository.hydrateAppState(staleAppState);
  assert.equal(await repository.getLock("table-1"), null);
  assert.equal(hydrated.posSettings.tables[0].workLock, null);
});
