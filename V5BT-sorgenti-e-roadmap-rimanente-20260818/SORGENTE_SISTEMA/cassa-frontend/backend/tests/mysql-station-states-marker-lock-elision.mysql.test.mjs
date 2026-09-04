import assert from "node:assert/strict";
import test from "node:test";

import mysql from "mysql2/promise";

import { createMysqlAppStateDomainsSplitRepository } from "../db/app-state/index.js";

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

async function createHarness(t, suffix) {
  const tableName = `test_station_marker_${suffix}`;
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
  t.after(async () => {
    await pool
      .query(`DROP TABLE IF EXISTS \`${tableName}_order_station_index\``)
      .catch(() => {});
    await pool.query(`DROP TABLE IF EXISTS \`${tableName}\``).catch(() => {});
    await pool.end().catch(() => {});
  });
  const mysqlRepository = {
    async getPool() {
      return pool;
    },
    async query(sql, params = []) {
      const [rows] = await pool.query(sql, params);
      return rows;
    },
  };
  const repository = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName,
    domains: ["integration"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["stationStates"] },
    stationStatesPartialMarkerLockElision: true,
    mysqlRepository,
    runtimeMetrics: { recordOperation() {} },
    logger: { info() {}, warn() {} },
  });
  return { pool, repository, tableName };
}

function state(id, updatedAtMs) {
  return {
    id,
    station: id === "station_a" ? "BAR" : "CUCINA",
    active: true,
    updatedAtMs,
  };
}

async function writeEntry(repository, id, updatedAtMs, options = {}) {
  await repository.syncObjectArrayEntriesFromAppState(
    { integration: { stationStates: [state(id, updatedAtMs)] } },
    "integration",
    "stationStates",
    [id],
    options,
  );
}

test(
  "[V5BT][MYSQL] ID station-state diversi non condividono il lock marker",
  { timeout: 30_000 },
  async (t) => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const harness = await createHarness(t, suffix);
    if (!harness) {
      t.skip("MySQL locale non disponibile per il test marker station-state.");
      return;
    }
    const { pool, repository, tableName } = harness;
    await repository.syncObjectArrayFieldFromAppState(
      {
        integration: {
          stationStates: [state("station_a", 1), state("station_b", 1)],
        },
      },
      "integration",
      "stationStates",
    );

    const blocker = await pool.getConnection();
    t.after(() => blocker.release());
    await blocker.beginTransaction();
    await blocker.query(
      `SELECT record_id FROM \`${tableName}\` WHERE domain = ? AND record_id = ? FOR UPDATE`,
      ["integration", "stationStates:station_a"],
    );

    let stationACompleted = false;
    const stationAWrite = writeEntry(repository, "station_a", 2).then(() => {
      stationACompleted = true;
    });
    await delay(150);
    assert.equal(stationACompleted, false, "lo stesso ID deve attendere il lock InnoDB");

    const stationBResult = await Promise.race([
      writeEntry(repository, "station_b", 2).then(() => "completed"),
      delay(2_000).then(() => "timeout"),
    ]);
    assert.equal(
      stationBResult,
      "completed",
      "un ID diverso deve completare mentre station_a resta bloccata",
    );
    assert.equal(stationACompleted, false);

    await blocker.commit();
    await stationAWrite;
    const hydrated = await repository.hydrateAppState({ integration: {} });
    assert.deepEqual(
      hydrated.integration.stationStates.map((entry) => [entry.id, entry.updatedAtMs]),
      [
        ["station_a", 2],
        ["station_b", 2],
      ],
    );
  },
);

test(
  "[V5BT][MYSQL] bootstrap concorrente conserva un marker e entrambe le entry",
  { timeout: 30_000 },
  async (t) => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const harness = await createHarness(t, suffix);
    if (!harness) {
      t.skip("MySQL locale non disponibile per il bootstrap station-state.");
      return;
    }
    const { pool, repository, tableName } = harness;
    await repository.ensureStorage();

    for (let attempt = 1; attempt <= 16; attempt += 1) {
      await pool.query(`DELETE FROM \`${tableName}\``);
      await Promise.all([
        writeEntry(repository, "station_a", attempt),
        writeEntry(repository, "station_b", attempt),
      ]);

      const [rows] = await pool.query(
        `SELECT record_id, kind, raw_json FROM \`${tableName}\` WHERE domain = ? ORDER BY record_id`,
        ["integration"],
      );
      assert.deepEqual(
        rows.map((row) => [row.record_id, row.kind]),
        [
          ["stationStates", "obj_array"],
          ["stationStates:station_a", "obj_array_entry"],
          ["stationStates:station_b", "obj_array_entry"],
        ],
        `bootstrap concorrente incompleto al tentativo ${attempt}`,
      );
      const markerValue =
        typeof rows[0].raw_json === "string"
          ? JSON.parse(rows[0].raw_json)
          : rows[0].raw_json;
      assert.deepEqual(markerValue, []);
    }
  },
);

test(
  "[V5BT][MYSQL] marker canonico serializza solo la creazione di nuove entry",
  { timeout: 30_000 },
  async (t) => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const harness = await createHarness(t, suffix);
    if (!harness) {
      t.skip("MySQL locale non disponibile per il bootstrap di nuove entry.");
      return;
    }
    const { pool, repository, tableName } = harness;
    await repository.syncObjectArrayFieldFromAppState(
      { integration: { stationStates: [] } },
      "integration",
      "stationStates",
    );

    for (let attempt = 1; attempt <= 16; attempt += 1) {
      await pool.query(
        `DELETE FROM \`${tableName}\` WHERE domain = ? AND record_id LIKE ?`,
        ["integration", "stationStates:%"],
      );
      await Promise.all([
        writeEntry(repository, "station_a", attempt),
        writeEntry(repository, "station_b", attempt),
      ]);
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total FROM \`${tableName}\` WHERE domain = ? AND (record_id = ? OR record_id LIKE ?)`,
        ["integration", "stationStates", "stationStates:%"],
      );
      assert.equal(Number(countRows[0]?.total), 3);
    }

    await pool.query(
      `DELETE FROM \`${tableName}\` WHERE domain = ? AND record_id LIKE ?`,
      ["integration", "stationStates:%"],
    );
    const newIds = Array.from(
      { length: 25 },
      (_, index) => `station_${String(index + 1).padStart(2, "0")}`,
    );
    await Promise.all(
      newIds.map((id, index) => writeEntry(repository, id, index + 1)),
    );
    const [newEntryCountRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM \`${tableName}\` WHERE domain = ? AND record_id LIKE ?`,
      ["integration", "stationStates:%"],
    );
    assert.equal(Number(newEntryCountRows[0]?.total), 25);

    await pool.query(
      `DELETE FROM \`${tableName}\` WHERE domain = ? AND record_id LIKE ?`,
      ["integration", "stationStates:%"],
    );
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        writeEntry(repository, "station_shared", index + 1, {
          preserveNewerStationStates: true,
        }),
      ),
    );
    const [sharedRows] = await pool.query(
      `SELECT raw_json FROM \`${tableName}\` WHERE domain = ? AND record_id = ?`,
      ["integration", "stationStates:station_shared"],
    );
    const sharedValue =
      typeof sharedRows[0]?.raw_json === "string"
        ? JSON.parse(sharedRows[0].raw_json)
        : sharedRows[0]?.raw_json;
    assert.equal(sharedValue?.updatedAtMs, 25);
  },
);
