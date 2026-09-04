import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMysqlAppStateDomainsSplitRepository } from "../db/app-state/mysql-domains-split.repository.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function storedRow(recordId, value, position = 0, kind = "object_entry") {
  const rawJson = JSON.stringify(value);
  return {
    record_id: recordId,
    kind,
    app_state_position: position,
    row_hash: hash(rawJson),
    raw_json: rawJson,
  };
}

function fixture(initialRows = [], options = {}) {
  const rows = new Map(initialRows.map((row) => [row.record_id, row]));
  const inserted = [];
  const transactions = [];
  const queries = [];
  const connection = {
    async beginTransaction() {
      transactions.push("begin");
    },
    async commit() {
      transactions.push("commit");
    },
    async rollback() {
      transactions.push("rollback");
    },
    release() {
      transactions.push("release");
    },
    async query(sql, params = []) {
      queries.push(sql);
      if (/SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]*FOR UPDATE/.test(sql)) {
        if (/FOR UPDATE\s+NOWAIT\b/.test(sql) && options.nowaitError) {
          throw options.nowaitError;
        }
        const selected = params.slice(1).map((id) => rows.get(id)).filter(Boolean);
        return [selected];
      }
      if (/INSERT INTO `station_guard_records`/.test(sql)) {
        for (let index = 0; index < params.length; index += 6) {
          const recordId = params[index + 1];
          const row = {
            record_id: recordId,
            kind: params[index + 2],
            app_state_position: params[index + 3],
            row_hash: params[index + 4],
            raw_json: params[index + 5],
          };
          rows.set(recordId, row);
          inserted.push(recordId);
        }
      }
      return [[]];
    },
  };
  const repository = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "station_guard_records",
    domains: ["integration"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["stationStates"] },
    mysqlRepository: {
      async query() {
        return [];
      },
      async getPool() {
        return { async getConnection() { return connection; } };
      },
    },
    runtimeMetrics: options.runtimeMetrics,
  });
  return { inserted, queries, repository, rows, transactions };
}

test("il guard stationStates impedisce a un heartbeat vecchio di sovrascrivere il nuovo", async () => {
  const marker = storedRow("stationStates", [], 1, "obj_array");
  const current = storedRow(
    "stationStates:station_1",
    { id: "station_1", updatedAtMs: 2_000, active: true },
    0,
    "obj_array_entry",
  );
  const { inserted, repository, rows } = fixture([marker, current]);
  await repository.syncObjectArrayEntriesFromAppState(
    {
      integration: {
        stationStates: [
          { id: "station_1", updatedAtMs: 1_000, active: true },
        ],
      },
    },
    "integration",
    "stationStates",
    ["station_1"],
    { preserveNewerStationStates: true },
  );
  assert.equal(inserted.includes("stationStates:station_1"), false);
  assert.equal(
    JSON.parse(rows.get("stationStates:station_1").raw_json).updatedAtMs,
    2_000,
  );
});

test("il guard stationStates accetta il watermark piu recente", async () => {
  const marker = storedRow("stationStates", [], 1, "obj_array");
  const current = storedRow(
    "stationStates:station_1",
    { id: "station_1", updatedAtMs: 1_000, active: true },
    0,
    "obj_array_entry",
  );
  const { inserted, repository, rows } = fixture([marker, current]);
  await repository.syncObjectArrayEntriesFromAppState(
    {
      integration: {
        stationStates: [
          { id: "station_1", updatedAtMs: 2_000, active: true },
        ],
      },
    },
    "integration",
    "stationStates",
    ["station_1"],
    { preserveNewerStationStates: true },
  );
  assert.equal(inserted.includes("stationStates:station_1"), true);
  assert.equal(
    JSON.parse(rows.get("stationStates:station_1").raw_json).updatedAtMs,
    2_000,
  );
});

test("il writer lastWriteAt e' monotono e conserva app_state_position", async () => {
  const current = storedRow(
    "lastWriteAt",
    "2026-08-07T12:00:02.000Z",
    7,
  );
  const { inserted, queries, repository, rows, transactions } = fixture([current]);
  const preserved = await repository.syncIntegrationLastWriteAt(
    "2026-08-07T12:00:01.000Z",
    { appStatePosition: 7 },
  );
  const advanced = await repository.syncIntegrationLastWriteAt(
    "2026-08-07T12:00:03.000Z",
    { appStatePosition: 7 },
  );
  assert.equal(preserved.changedRows, 0);
  assert.equal(advanced.changedRows, 1);
  assert.equal(inserted.filter((id) => id === "lastWriteAt").length, 1);
  assert.equal(
    JSON.parse(rows.get("lastWriteAt").raw_json),
    "2026-08-07T12:00:03.000Z",
  );
  assert.equal(rows.get("lastWriteAt").app_state_position, 7);
  assert.deepEqual(transactions, [
    "begin",
    "commit",
    "release",
    "begin",
    "commit",
    "release",
  ]);
  assert.ok(queries.some((sql) => /FOR UPDATE\b/.test(sql)));
  assert.ok(queries.every((sql) => !/FOR UPDATE\s+NOWAIT\b/.test(sql)));
});

test("il writer riconosce lo scalare JSON gia decodificato dal driver MySQL", async () => {
  const current = storedRow(
    "lastWriteAt",
    "2026-08-07T12:00:03.000Z",
    7,
  );
  current.raw_json = "2026-08-07T12:00:03.000Z";
  const { inserted, repository, rows } = fixture([current]);
  const result = await repository.syncIntegrationLastWriteAt(
    "2026-08-07T12:00:02.000Z",
    { appStatePosition: 7, lockRowsNowait: true },
  );
  assert.equal(result.changedRows, 0);
  assert.deepEqual(inserted, []);
  assert.equal(
    rows.get("lastWriteAt").raw_json,
    "2026-08-07T12:00:03.000Z",
  );
});

for (const nowaitError of [
  Object.assign(new Error("MySQL NOWAIT"), {
    code: "ER_LOCK_NOWAIT",
    errno: 3_572,
  }),
  Object.assign(new Error("MariaDB NOWAIT"), {
    code: "ER_LOCK_WAIT_TIMEOUT",
    errno: 1_205,
  }),
]) {
  test(`il writer propaga e rollbacka la collisione NOWAIT ${nowaitError.errno}`, async () => {
    const { inserted, queries, repository, transactions } = fixture([], {
      nowaitError,
    });
    await assert.rejects(
      repository.syncIntegrationLastWriteAt("2026-08-07T12:00:03.000Z", {
        appStatePosition: 7,
        lockRowsNowait: true,
      }),
      (error) => error === nowaitError,
    );
    assert.ok(queries.some((sql) => /FOR UPDATE\s+NOWAIT\b/.test(sql)));
    assert.deepEqual(inserted, []);
    assert.deepEqual(transactions, ["begin", "rollback", "release"]);
  });
}

test("il writer lastWriteAt espone tutte le fasi monotone", async () => {
  const operations = [];
  const { repository } = fixture([], {
    runtimeMetrics: {
      recordOperation(kind, label) {
        operations.push(`${kind}:${label}`);
      },
    },
  });
  await repository.syncIntegrationLastWriteAt("2026-08-07T12:00:03.000Z", {
    appStatePosition: 7,
  });
  for (const label of [
    "getPool",
    "getConnection",
    "beginTransaction",
    "stateRead",
    "upsertBatch",
    "commit",
    "outcome.committed",
    "release",
    "total",
  ]) {
    assert.ok(
      operations.includes(
        `appStateDomainSplit:integration.lastWriteAt.monotonic.${label}`,
      ),
      `metrica mancante: ${label}`,
    );
  }
});
