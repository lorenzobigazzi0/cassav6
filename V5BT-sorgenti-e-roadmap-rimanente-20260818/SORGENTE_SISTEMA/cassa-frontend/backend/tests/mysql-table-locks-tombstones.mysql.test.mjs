import assert from "node:assert/strict";
import test from "node:test";

import mysql from "mysql2/promise";

import { createMysqlTableLocksRepository } from "../db/app-state/index.js";

const dbConfig = {
  host: process.env.BACKEND_MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.BACKEND_MYSQL_PORT || 3306),
  user: process.env.BACKEND_MYSQL_USER || "cassa_app",
  password: process.env.BACKEND_MYSQL_PASSWORD || "amalia2026",
  database: process.env.BACKEND_MYSQL_DATABASE || "cassa",
};

function buildLock(tableId, userId) {
  const now = new Date();
  return {
    tableId,
    userId,
    username: userId,
    deviceUuid: `device-${userId}`,
    sessionId: `session-${userId}`,
    purpose: "tombstone-mysql-test",
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
  };
}

function createRuntimeMetrics() {
  const counters = new Map();
  return {
    counters,
    incrementCounter(name) {
      counters.set(name, (counters.get(name) ?? 0) + 1);
    },
    recordOperation() {},
  };
}

function createMysqlAdapter(pool) {
  return {
    async getPool() {
      return pool;
    },
    async query(sql, params = []) {
      const [rows] = await pool.query(sql, params);
      return rows;
    },
  };
}

async function createTestPool() {
  const pool = mysql.createPool({
    ...dbConfig,
    connectionLimit: 8,
    waitForConnections: true,
    queueLimit: 0,
  });
  try {
    await pool.query("SELECT 1");
    return pool;
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
}

async function runLockCycle(repository, tableIds, round) {
  await Promise.all(
    tableIds.map((tableId) =>
      repository.mutateTableLock(tableId, () => ({
        nextLock: buildLock(tableId, `user-${round}`),
      })),
    ),
  );
  await Promise.all(
    tableIds.map((tableId) =>
      repository.mutateTableLock(tableId, (currentLock) => ({
        nextLock: {
          ...currentLock,
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      })),
    ),
  );
  await Promise.all(
    tableIds.map((tableId) =>
      repository.mutateTableLock(tableId, () => ({ delete: true })),
    ),
  );
}

test(
  "[BE][P4][MYSQL] tombstone elimina gap churn e conserva il CAS dopo restart",
  { timeout: 60_000 },
  async (t) => {
    const pool = await createTestPool();
    if (!pool) {
      t.skip("MySQL non disponibile per il test tombstone reale.");
      return;
    }

    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const controlTable = `test_table_locks_delete_${suffix}`;
    const tombstoneTable = `test_table_locks_tombstone_${suffix}`;
    const mysqlRepository = createMysqlAdapter(pool);
    t.after(async () => {
      await pool.query(`DROP TABLE IF EXISTS \`${controlTable}\``).catch(() => {});
      await pool.query(`DROP TABLE IF EXISTS \`${tombstoneTable}\``).catch(() => {});
      await pool.end().catch(() => {});
    });

    const tableIds = Array.from({ length: 56 }, (_, index) => `table-${index + 1}`);
    const migrationTableIndex = 17;
    const migrationTableId = tableIds[migrationTableIndex];
    const staleInitialLock = buildLock(migrationTableId, "stale-owner");
    const appState = {
      posSettings: {
        tables: tableIds.map((id, index) => ({
          id,
          workLock: index === migrationTableIndex ? staleInitialLock : null,
        })),
      },
    };
    const controlMetrics = createRuntimeMetrics();
    const tombstoneMetrics = createRuntimeMetrics();
    const control = createMysqlTableLocksRepository({
      enabled: true,
      tableName: controlTable,
      mysqlRepository,
      namedLocksEnabled: false,
      tombstonesEnabled: false,
      runtimeMetrics: controlMetrics,
      logger: { info() {} },
    });
    const tombstones = createMysqlTableLocksRepository({
      enabled: true,
      tableName: tombstoneTable,
      mysqlRepository,
      namedLocksEnabled: false,
      tombstonesEnabled: true,
      runtimeMetrics: tombstoneMetrics,
      logger: { info() {} },
    });

    await tombstones.hydrateAppState(appState);
    assert.equal((await tombstones.getLock(migrationTableId))?.userId, "stale-owner");
    const [[seededRow]] = await pool.query(
      `SELECT app_state_position FROM \`${tombstoneTable}\` WHERE table_id = ?`,
      [migrationTableId],
    );
    assert.equal(Number(seededRow.app_state_position), migrationTableIndex);
    await tombstones.mutateTableLock(migrationTableId, () => ({
      nextLock: buildLock(migrationTableId, "authoritative-owner"),
    }));
    let hydrated = await tombstones.hydrateAppState(appState);
    assert.equal(
      hydrated.posSettings.tables[migrationTableIndex].workLock?.userId,
      "authoritative-owner",
    );
    await tombstones.mutateTableLock(migrationTableId, () => ({ delete: true }));
    hydrated = await tombstones.hydrateAppState(appState);
    assert.equal(hydrated.posSettings.tables[migrationTableIndex].workLock, null);

    for (let round = 0; round < 3; round += 1) {
      await runLockCycle(control, tableIds, round);
      await runLockCycle(tombstones, tableIds, round);
    }

    const [[controlCount]] = await pool.query(
      `SELECT COUNT(*) AS total FROM \`${controlTable}\``,
    );
    const [[tombstoneCount]] = await pool.query(
      `SELECT COUNT(*) AS total, SUM(is_active) AS active FROM \`${tombstoneTable}\``,
    );
    assert.equal(Number(controlCount.total), 0);
    assert.equal(Number(tombstoneCount.total), tableIds.length);
    assert.equal(Number(tombstoneCount.active), 0);
    assert.deepEqual(await tombstones.listTableWorkLocks(), []);

    const restarted = createMysqlTableLocksRepository({
      enabled: true,
      tableName: tombstoneTable,
      mysqlRepository,
      namedLocksEnabled: false,
      tombstonesEnabled: true,
      logger: { info() {} },
    });
    hydrated = await restarted.hydrateAppState(appState);
    assert.equal(
      hydrated.posSettings.tables.some((table) => table.workLock),
      false,
    );

    const contenders = Array.from({ length: 20 }, (_, index) => `cas-${index + 1}`);
    const outcomes = await Promise.all(
      contenders.map((userId) =>
        restarted.mutateTableLock(tableIds[0], (currentLock) => {
          if (currentLock) return { won: false };
          return {
            won: true,
            nextLock: buildLock(tableIds[0], userId),
          };
        }),
      ),
    );
    assert.equal(outcomes.filter((outcome) => outcome.won).length, 1);
    await restarted.mutateTableLock(tableIds[0], () => ({ delete: true }));
    assert.equal(await restarted.getLock(tableIds[0]), null);

    t.diagnostic(
      `retry delete=${controlMetrics.counters.get("tableLockMysqlRetries") ?? 0}, tombstone=${tombstoneMetrics.counters.get("tableLockMysqlRetries") ?? 0}`,
    );
  },
);
