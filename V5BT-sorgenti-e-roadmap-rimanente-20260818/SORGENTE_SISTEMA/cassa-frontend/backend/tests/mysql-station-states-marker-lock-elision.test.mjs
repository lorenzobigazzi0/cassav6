import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createMysqlAppStateDomainsSplitRepository } from "../db/app-state/index.js";

function createStoredRow(domain, recordId, kind, appStatePosition, value) {
  const rawJson = JSON.stringify(value);
  return {
    domain,
    record_id: recordId,
    kind,
    app_state_position: appStatePosition,
    row_hash: createHash("sha256").update(rawJson).digest("hex"),
    raw_json: rawJson,
  };
}

function createStationStatesHarness({
  markerExists = true,
  flag = false,
  probeError = null,
  markerKind = "obj_array",
  markerValue = [],
  markerRowHash = null,
  missingEntryIds = [],
} = {}) {
  const queryLog = [];
  const metricsLog = [];
  const storedRows = new Map();
  if (markerExists) {
    const markerRow = createStoredRow(
      "integration",
      "stationStates",
      markerKind,
      0,
      markerValue,
    );
    if (markerRowHash !== null) markerRow.row_hash = markerRowHash;
    storedRows.set("integration:stationStates", markerRow);
  }
  for (const [index, entry] of [
    { id: "station_a", station: "BAR", active: true, updatedAtMs: 1 },
    { id: "station_b", station: "CUCINA", active: true, updatedAtMs: 1 },
  ].entries()) {
    if (missingEntryIds.includes(entry.id)) continue;
    storedRows.set(
      `integration:stationStates:${entry.id}`,
      createStoredRow(
        "integration",
        `stationStates:${entry.id}`,
        "obj_array_entry",
        index,
        entry,
      ),
    );
  }

  const connection = {
    beginTransaction: async () => {
      queryLog.push({ sql: "BEGIN", params: [] });
    },
    commit: async () => {
      queryLog.push({ sql: "COMMIT", params: [] });
    },
    rollback: async () => {
      queryLog.push({ sql: "ROLLBACK", params: [] });
    },
    release: () => {
      queryLog.push({ sql: "RELEASE", params: [] });
    },
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (
        /SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]+LIMIT 1/s.test(
          sql,
        )
      ) {
        if (probeError) throw probeError;
        const [domain, recordId] = params;
        const row = storedRows.get(`${domain}:${recordId}`);
        return [row ? [{ ...row }] : []];
      }
      if (/SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]+FOR UPDATE/s.test(sql)) {
        const [domain, ...recordIds] = params;
        return [
          recordIds
            .map((recordId) => storedRows.get(`${domain}:${recordId}`))
            .filter(Boolean)
            .map((row) => ({ ...row })),
        ];
      }
      if (/SELECT record_id[\s\S]+FORCE INDEX \(PRIMARY\)[\s\S]+record_id IN/s.test(sql)) {
        const [domain, ...recordIds] = params;
        return [
          recordIds
            .map((recordId) => storedRows.get(`${domain}:${recordId}`))
            .filter(Boolean)
            .map((row) => ({ record_id: row.record_id })),
        ];
      }
      if (/INSERT INTO\s+`app_state_domain_records`\s*\(/s.test(sql)) {
        for (let index = 0; index < params.length; index += 6) {
          const [domain, recordId, kind, appStatePosition, rowHash, rawJson] =
            params.slice(index, index + 6);
          storedRows.set(`${domain}:${recordId}`, {
            domain,
            record_id: recordId,
            kind,
            app_state_position: appStatePosition,
            row_hash: rowHash,
            raw_json: rawJson,
          });
        }
        return [{ affectedRows: params.length / 6 }];
      }
      return [[]];
    },
  };
  const mysqlRepository = {
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT domain, record_id, kind, app_state_position, row_hash, raw_json/s.test(sql)) {
        const [domain] = params;
        return [...storedRows.values()]
          .filter((row) => row.domain === domain)
          .map((row) => ({ ...row }))
          .sort((left, right) => {
            if (left.app_state_position !== right.app_state_position) {
              return left.app_state_position - right.app_state_position;
            }
            return String(left.record_id).localeCompare(String(right.record_id));
          });
      }
      return [];
    },
    getPool: async () => ({
      getConnection: async () => connection,
    }),
  };
  const split = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "app_state_domain_records",
    domains: ["integration", "other"],
    objectEntryDomains: ["integration", "other"],
    objectArrayEntryFields: {
      integration: ["stationStates", "notifications"],
      other: ["stationStates"],
    },
    stationStatesPartialMarkerLockElision: flag,
    mysqlRepository,
    runtimeMetrics: {
      recordOperation(kind, label, durationMs) {
        metricsLog.push({ kind, label, durationMs });
      },
    },
    logger: { info() {}, warn() {} },
  });

  return { metricsLog, queryLog, split, storedRows };
}

function stationState(id, station, updatedAtMs) {
  return { id, station, active: true, updatedAtMs };
}

function markerProbeQueries(queryLog) {
  return queryLog.filter((entry) =>
    /SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]+LIMIT 1/s.test(
      entry.sql,
    ),
  );
}

function lockQueries(queryLog) {
  return queryLog.filter((entry) =>
    /SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]+FOR UPDATE/s.test(
      entry.sql,
    ),
  );
}

test("stationStates marker lock elision resta disattivata per default", async () => {
  const { queryLog, split } = createStationStatesHarness();

  await split.syncObjectArrayEntriesFromAppState(
    {
      integration: {
        stationStates: [stationState("station_a", "BAR", 2)],
      },
    },
    "integration",
    "stationStates",
    ["station_a"],
  );

  assert.equal(markerProbeQueries(queryLog).length, 0);
  assert.deepEqual(lockQueries(queryLog).at(-1)?.params, [
    "integration",
    "stationStates",
    "stationStates:station_a",
  ]);
});

test("stationStates marker esistente non entra nel lock o upsert parziale", async () => {
  const { metricsLog, queryLog, split } = createStationStatesHarness({
    flag: true,
  });

  for (const [id, station, updatedAtMs] of [
    ["station_a", "BAR", 2],
    ["station_a", "BAR", 3],
    ["station_b", "CUCINA", 2],
  ]) {
    await split.syncObjectArrayEntriesFromAppState(
      { integration: { stationStates: [stationState(id, station, updatedAtMs)] } },
      "integration",
      "stationStates",
      [id],
    );
  }

  assert.equal(markerProbeQueries(queryLog).length, 3);
  assert.deepEqual(
    lockQueries(queryLog).map((entry) => entry.params),
    [
      ["integration", "stationStates:station_a"],
      ["integration", "stationStates:station_a"],
      ["integration", "stationStates:station_b"],
    ],
  );
  const appStateUpserts = queryLog.filter((entry) =>
    /INSERT INTO\s+`app_state_domain_records`\s*\(/s.test(entry.sql),
  );
  assert.equal(
    appStateUpserts.some((entry) =>
      entry.params.some((value, index) => index % 6 === 1 && value === "stationStates"),
    ),
    false,
  );
  assert.equal(
    metricsLog.filter(
      (entry) =>
        entry.kind === "appStateDomainSplit" &&
        entry.label ===
          "integration.stationStates.entries.markerLockElision.applied",
    ).length,
    3,
  );
  assert.equal(
    metricsLog.some((entry) =>
      entry.label.endsWith("markerLockElision.canonicalFallback"),
    ),
    false,
  );

  const hydrated = await split.hydrateAppState({ integration: {} });
  assert.deepEqual(
    hydrated.integration.stationStates.map((entry) => [entry.id, entry.updatedAtMs]),
    [
      ["station_a", 3],
      ["station_b", 2],
    ],
  );
});

test("stationStates marker mancante ripiega sul percorso canonico completo", async () => {
  const { metricsLog, queryLog, split, storedRows } =
    createStationStatesHarness({ markerExists: false, flag: true });

  await split.syncObjectArrayEntriesFromAppState(
    {
      integration: {
        stationStates: [stationState("station_a", "BAR", 2)],
      },
    },
    "integration",
    "stationStates",
    ["station_a"],
  );

  assert.equal(markerProbeQueries(queryLog).length, 1);
  assert.deepEqual(lockQueries(queryLog).at(-1)?.params, [
    "integration",
    "stationStates:station_a",
  ]);
  assert.equal(storedRows.get("integration:stationStates")?.kind, "obj_array");
  assert.equal(
    metricsLog.some(
      (entry) =>
        entry.label ===
        "integration.stationStates.entries.markerLockElision.canonicalFallback",
    ),
    true,
  );
  assert.equal(
    metricsLog.some((entry) =>
      entry.label.endsWith("markerLockElision.canonicalRepair"),
    ),
    true,
  );
  assert.equal(
    metricsLog.some((entry) =>
      entry.label.endsWith("markerLockElision.applied"),
    ),
    false,
  );

  const hydrated = await split.hydrateAppState({ integration: {} });
  assert.equal(hydrated.integration.stationStates[0].updatedAtMs, 2);
});

test("stationStates serializza soltanto la creazione di una entry mancante", async () => {
  const { metricsLog, queryLog, split, storedRows } =
    createStationStatesHarness({ flag: true, missingEntryIds: ["station_a"] });

  await split.syncObjectArrayEntriesFromAppState(
    {
      integration: {
        stationStates: [stationState("station_a", "BAR", 2)],
      },
    },
    "integration",
    "stationStates",
    ["station_a"],
  );

  assert.deepEqual(lockQueries(queryLog).at(-1)?.params, [
    "integration",
    "stationStates:station_a",
  ]);
  assert.equal(storedRows.has("integration:stationStates:station_a"), true);
  assert.equal(
    metricsLog.some((entry) =>
      entry.label.endsWith("markerLockElision.entryBootstrapSerialization"),
    ),
    true,
  );
  assert.equal(
    metricsLog.some((entry) =>
      entry.label.endsWith("markerLockElision.canonicalFallback"),
    ),
    false,
  );
});

test("errore del marker probe esegue rollback senza commit o upsert", async () => {
  const probeError = Object.assign(new Error("marker probe failed"), {
    code: "ER_QUERY_INTERRUPTED",
  });
  const { queryLog, split } = createStationStatesHarness({
    flag: true,
    probeError,
  });
  await split.ensureStorage();
  queryLog.length = 0;

  await assert.rejects(
    () =>
      split.syncObjectArrayEntriesFromAppState(
        {
          integration: {
            stationStates: [stationState("station_a", "BAR", 2)],
          },
        },
        "integration",
        "stationStates",
        ["station_a"],
      ),
    /marker probe failed/,
  );

  assert.equal(queryLog.some((entry) => entry.sql === "ROLLBACK"), true);
  assert.equal(queryLog.some((entry) => entry.sql === "COMMIT"), false);
  assert.equal(
    queryLog.some((entry) =>
      /INSERT INTO\s+`app_state_domain_records`\s*\(/s.test(entry.sql),
    ),
    false,
  );
});

test("marker stationStates non canonico viene riparato dal fallback", async (t) => {
  for (const scenario of [
    { name: "kind", markerKind: "object_entry" },
    { name: "raw_json", markerValue: { corrupt: true } },
    { name: "row_hash", markerRowHash: "0".repeat(64) },
  ]) {
    await t.test(scenario.name, async () => {
      const { metricsLog, queryLog, split, storedRows } =
        createStationStatesHarness({ flag: true, ...scenario });

      await split.syncObjectArrayEntriesFromAppState(
        {
          integration: {
            stationStates: [stationState("station_a", "BAR", 2)],
          },
        },
        "integration",
        "stationStates",
        ["station_a"],
      );

      assert.equal(lockQueries(queryLog).at(-1)?.params.includes("stationStates"), false);
      const repairedMarker = storedRows.get("integration:stationStates");
      assert.equal(repairedMarker?.kind, "obj_array");
      assert.deepEqual(JSON.parse(repairedMarker?.raw_json ?? "null"), []);
      assert.equal(
        repairedMarker?.row_hash,
        createHash("sha256").update("[]").digest("hex"),
      );
      assert.equal(
        metricsLog.some(
          (entry) =>
            entry.label ===
            "integration.stationStates.entries.markerLockElision.canonicalFallback",
        ),
        true,
      );
      assert.equal(
        metricsLog.some((entry) =>
          entry.label.endsWith("markerLockElision.canonicalRepair"),
        ),
        true,
      );
    });
  }
});

test("bulk parziale stationStates omette il marker ma conserva le altre righe", async () => {
  const { metricsLog, queryLog, split, storedRows } =
    createStationStatesHarness({ flag: true });

  await split.syncObjectArrayEntriesAndObjectEntriesFromAppState(
    {
      integration: {
        stationStates: [stationState("station_a", "BAR", 4)],
        lastWriteAt: "2026-08-06T12:00:00.000Z",
      },
    },
    "integration",
    {
      objectArrayEntries: [
        { fieldName: "stationStates", entryIds: ["station_a"] },
      ],
      objectFields: ["lastWriteAt"],
    },
  );

  const lockParams = lockQueries(queryLog).at(-1)?.params ?? [];
  assert.equal(lockParams.includes("stationStates"), false);
  assert.equal(lockParams.includes("stationStates:station_a"), true);
  assert.equal(lockParams.includes("lastWriteAt"), true);
  assert.equal(storedRows.has("integration:lastWriteAt"), true);
  assert.equal(
    metricsLog.some(
      (entry) =>
        entry.label ===
        "integration.stationStates.entries.markerLockElision.applied",
    ),
    true,
  );

  const hydrated = await split.hydrateAppState({ integration: {} });
  assert.equal(hydrated.integration.stationStates[0].updatedAtMs, 4);
  assert.equal(hydrated.integration.lastWriteAt, "2026-08-06T12:00:00.000Z");
});

test("bulk parziale stationStates senza marker mantiene il percorso canonico", async () => {
  const { metricsLog, queryLog, split, storedRows } =
    createStationStatesHarness({ markerExists: false, flag: true });

  await split.syncObjectArrayEntriesAndObjectEntriesFromAppState(
    {
      integration: {
        stationStates: [stationState("station_b", "CUCINA", 5)],
      },
    },
    "integration",
    {
      objectArrayEntries: [
        { fieldName: "stationStates", entryIds: ["station_b"] },
      ],
    },
  );

  assert.deepEqual(lockQueries(queryLog).at(-1)?.params, [
    "integration",
    "stationStates:station_b",
  ]);
  assert.equal(storedRows.get("integration:stationStates")?.kind, "obj_array");
  assert.equal(
    metricsLog.some(
      (entry) =>
        entry.label ===
        "integration.stationStates.entries.markerLockElision.canonicalFallback",
    ),
    true,
  );
});

test("marker probe non viene eseguito per altri domain o field", async () => {
  const { queryLog, split } = createStationStatesHarness({ flag: true });

  await split.syncObjectArrayEntriesFromAppState(
    { integration: { notifications: [{ id: "notification_a", read: false }] } },
    "integration",
    "notifications",
    ["notification_a"],
  );
  await split.syncObjectArrayEntriesFromAppState(
    { other: { stationStates: [stationState("other_a", "ALTRO", 1)] } },
    "other",
    "stationStates",
    ["other_a"],
  );
  await split.syncObjectArrayEntriesAndObjectEntriesFromAppState(
    {
      integration: {
        stationStates: [stationState("station_a", "BAR", 6)],
      },
    },
    "integration",
    { replaceObjectArrayFields: ["stationStates"] },
  );

  assert.equal(markerProbeQueries(queryLog).length, 0);
});
