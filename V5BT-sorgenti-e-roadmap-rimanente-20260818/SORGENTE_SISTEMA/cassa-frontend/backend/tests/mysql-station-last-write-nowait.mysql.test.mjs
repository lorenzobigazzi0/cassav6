import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import mysql from "mysql2/promise";

import { createMysqlAppStateDomainsSplitRepository } from "../db/app-state/mysql-domains-split.repository.js";
import { createStationLastWriteAtFlush } from "../modules/integration/station-last-write-at-flush.js";

const dbConfig = {
  host: process.env.BACKEND_MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.BACKEND_MYSQL_PORT || 3306),
  user: process.env.BACKEND_MYSQL_USER || "cassa_app",
  password: process.env.BACKEND_MYSQL_PASSWORD || "amalia2026",
  database: process.env.BACKEND_MYSQL_DATABASE || "cassa",
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeRawJson(value) {
  if (Buffer.isBuffer(value)) return decodeRawJson(value.toString("utf8"));
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function contentionError(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  const errno = Number(error?.errno ?? NaN);
  return (
    code === "ER_LOCK_NOWAIT" ||
    code === "ER_LOCK_WAIT_TIMEOUT" ||
    errno === 3_572 ||
    errno === 1_205
  );
}

async function createHarness(t, label) {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const tableName = `test_lastwrite_${label}_${suffix}`;
  const pool = mysql.createPool({
    ...dbConfig,
    connectionLimit: 8,
    waitForConnections: true,
    queueLimit: 0,
  });
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
  const events = [];
  t.after(async () => {
    await pool
      .query(`DROP TABLE IF EXISTS \`${tableName}_order_station_index\``)
      .catch(() => {});
    await pool.query(`DROP TABLE IF EXISTS \`${tableName}\``).catch(() => {});
    await pool.end().catch(() => {});
  });
  const mysqlRepository = {
    async query(sql, params = []) {
      const [rows] = await pool.query(sql, params);
      return rows;
    },
    async getPool() {
      return {
        async getConnection() {
          const connection = await pool.getConnection();
          return {
            async beginTransaction() {
              events.push("begin");
              return connection.beginTransaction();
            },
            async query(sql, params = []) {
              return connection.query(sql, params);
            },
            async commit() {
              events.push("commit");
              return connection.commit();
            },
            async rollback() {
              events.push("rollback");
              return connection.rollback();
            },
            release() {
              events.push("release");
              connection.release();
            },
          };
        },
      };
    },
  };
  const repository = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName,
    domains: ["integration"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["stationStates"] },
    mysqlRepository,
    runtimeMetrics: { recordOperation() {} },
  });
  await repository.ensureStorage();
  return { events, pool, repository, tableName };
}

async function lockMarker(pool, tableName) {
  const blocker = await pool.getConnection();
  await blocker.beginTransaction();
  await blocker.query(
    `SELECT record_id FROM \`${tableName}\` WHERE domain = ? AND record_id = ? FOR UPDATE`,
    ["integration", "lastWriteAt"],
  );
  return blocker;
}

test(
  "[V5BT][MYSQL] lastWriteAt NOWAIT fallisce rapido, rollbacka e ritenta monotono",
  { timeout: 30_000 },
  async (t) => {
    const harness = await createHarness(t, "nowait");
    if (!harness) {
      t.skip("MySQL locale non disponibile per il test NOWAIT lastWriteAt.");
      return;
    }
    const { events, pool, repository, tableName } = harness;
    await repository.syncIntegrationLastWriteAt("2026-08-07T12:00:01.000Z", {
      appStatePosition: 7,
    });
    events.length = 0;

    const blocker = await lockMarker(pool, tableName);
    let blockerReleased = false;
    t.after(async () => {
      if (!blockerReleased) await blocker.rollback().catch(() => {});
      blocker.release();
    });

    const startedAt = performance.now();
    let observedError = null;
    try {
      await repository.syncIntegrationLastWriteAt("2026-08-07T12:00:03.000Z", {
        appStatePosition: 7,
        lockRowsNowait: true,
      });
    } catch (error) {
      observedError = error;
    }
    const elapsedMs = performance.now() - startedAt;
    assert.ok(observedError, "la collisione deve produrre un errore NOWAIT");
    assert.equal(contentionError(observedError), true);
    assert.ok(elapsedMs < 1_000, `collisione troppo lenta: ${elapsedMs} ms`);
    assert.deepEqual(events, ["begin", "rollback", "release"]);

    await blocker.rollback();
    blockerReleased = true;
    events.length = 0;
    await repository.syncIntegrationLastWriteAt("2026-08-07T12:00:03.000Z", {
      appStatePosition: 7,
      lockRowsNowait: true,
    });
    assert.deepEqual(events, ["begin", "commit", "release"]);

    events.length = 0;
    await repository.syncIntegrationLastWriteAt("2026-08-07T12:00:02.000Z", {
      appStatePosition: 7,
      lockRowsNowait: true,
    });
    assert.deepEqual(events, ["begin", "commit", "release"]);
    const [rows] = await pool.query(
      `SELECT app_state_position, raw_json FROM \`${tableName}\` WHERE domain = ? AND record_id = ?`,
      ["integration", "lastWriteAt"],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].app_state_position, 7);
    assert.equal(
      decodeRawJson(rows[0].raw_json),
      "2026-08-07T12:00:03.000Z",
    );
  },
);

test(
  "[V5BT][MYSQL] recovery lastWriteAt resta bloccante e persiste il MAX",
  { timeout: 30_000 },
  async (t) => {
    const harness = await createHarness(t, "recovery");
    if (!harness) {
      t.skip("MySQL locale non disponibile per il test recovery lastWriteAt.");
      return;
    }
    const { pool, repository, tableName } = harness;
    await repository.syncIntegrationLastWriteAt("2026-08-07T12:00:01.000Z", {
      appStatePosition: 7,
    });
    const blocker = await lockMarker(pool, tableName);
    let blockerReleased = false;
    t.after(async () => {
      if (!blockerReleased) await blocker.rollback().catch(() => {});
      blocker.release();
    });

    const contexts = [];
    const queue = createStationLastWriteAtFlush({
      enabled: true,
      nowMs: () => Date.parse("2026-08-07T12:01:00.000Z"),
      writeTimestamp: (payload, context) => {
        contexts.push(context);
        return repository.syncIntegrationLastWriteAt(payload.timestamp, {
          appStatePosition: payload.position,
          lockRowsNowait: context.lockRowsNowait,
        });
      },
    });
    let settled = false;
    const recovery = queue
      .recoverFromAppState({
        integration: {
          lastWriteAt: "2026-08-07T12:00:01.000Z",
          stationStates: [
            { id: "station_a", updatedAtMs: Date.parse("2026-08-07T12:00:03.000Z") },
          ],
        },
      })
      .finally(() => {
        settled = true;
      });
    await delay(150);
    assert.equal(settled, false, "la recovery deve attendere il lock canonico");
    await blocker.rollback();
    blockerReleased = true;
    const result = await recovery;
    assert.equal(result.recovered, true);
    assert.deepEqual(contexts, [{ lockRowsNowait: false, mode: "recovery" }]);

    const [rows] = await pool.query(
      `SELECT raw_json FROM \`${tableName}\` WHERE domain = ? AND record_id = ?`,
      ["integration", "lastWriteAt"],
    );
    assert.equal(
      decodeRawJson(rows[0].raw_json),
      "2026-08-07T12:00:03.000Z",
    );
  },
);
