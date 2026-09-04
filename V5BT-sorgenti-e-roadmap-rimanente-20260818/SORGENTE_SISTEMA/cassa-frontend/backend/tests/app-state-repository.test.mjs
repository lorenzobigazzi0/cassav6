import assert from "node:assert/strict";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createAppStateRepository,
  normalizeAppStateDirtyTrackingMode,
  createAuditEventsSplitRepository,
  createDeviceStatusSplitRepository,
  createOrdersSplitRepository,
  createPaymentsFiscalSplitRepository,
  createPrintSpoolJobsSplitRepository,
  createTableLocksSplitRepository,
  createTableStateSplitRepository,
  createMysqlAppStateDomainsSplitRepository,
  AppStateMysqlRepository,
} from "../db/app-state/index.js";
import { sanitizeAuditEvent } from "../modules/audit/audit.mapper.js";
import { buildTestState, createTempRunDir } from "./helpers/test-server.mjs";

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function isValidState(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.users) &&
    Array.isArray(data.sessions) &&
    data.meta &&
    typeof data.meta === "object"
  );
}

function createRepositoryOptions({ mode, dbPath, overrides = {} }) {
  return {
    mode,
    dbPath,
    dbTmpPath: `${dbPath}.tmp`,
    defaultJsonDbPath: dbPath,
    legacyJsonDbPath: "",
    sqliteImportJsonPath: "",
    buildInitialState: buildTestState,
    isValidState,
    migrateState: () => false,
    cloneJson,
    nowIso: () => new Date().toISOString(),
    safePathExists: existsSync,
    canInitializeMissingDb: () => true,
    canInitializeExistingEmptyDb: () => true,
    buildEmptyDbInitDeniedMessage: (kind, targetPath) =>
      `${kind} init denied: ${targetPath}`,
    logger: { warn() {} },
    ...overrides,
  };
}

function readSplitStateRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT domain, mode, row_count, checksum, synced_at FROM app_state_split_state ORDER BY domain",
      )
      .all();
    return new Map(rows.map((row) => [String(row.domain), row]));
  } finally {
    db.close();
  }
}

test("app-state repository JSON read/write roundtrip", async () => {
  const runDir = await createTempRunDir("app-state-repo-json");
  const dbPath = path.join(runDir, "app-state.json");
  const state = buildTestState();
  state.meta.repositoryRoundtrip = "json";

  const writer = createAppStateRepository(
    createRepositoryOptions({ mode: "json", dbPath }),
  );
  await writer.writeDb(state);

  const reader = createAppStateRepository(
    createRepositoryOptions({ mode: "json", dbPath }),
  );
  const reread = await reader.readDb({ allowMigrations: false });

  assert.equal(reread.meta.repositoryRoundtrip, "json");
  assert.equal(
    reread.users.some((user) => user.id === "u_cashier"),
    true,
  );
});

test("app-state MySQL repository espone metriche pressione pool", async () => {
  const metricsLog = [];
  const gaugeLog = [];
  const connection = {
    beginTransaction: async () => {},
    query: async () => [[]],
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
  const pool = {
    query: async () => [[{ ok: 1 }]],
    getConnection: async () => connection,
  };
  const repository = new AppStateMysqlRepository({
    mysql: {
      createPool: () => pool,
    },
    tableName: "app_state",
    buildInitialState: buildTestState,
    isValidState,
    nowIso: () => "2026-07-03T00:00:00.000Z",
    canInitializeMissingDb: () => true,
    canInitializeExistingEmptyDb: () => true,
    buildEmptyDbInitDeniedMessage: () => "denied",
    poolMetricsEnabled: true,
    runtimeMetrics: {
      recordOperation(kind, label, durationMs) {
        metricsLog.push({ kind, label, durationMs });
      },
      setGauge(name, value) {
        gaugeLog.push({ name, value });
      },
    },
  });

  const rows = await repository.query("SELECT 1");
  await repository.writeRow("{}", "2026-07-03T00:00:00.000Z");

  assert.equal(rows[0]?.ok, 1);
  assert.equal(
    [
      "pool.create",
      "query.select",
      "connection.acquire",
      "connection.hold",
    ].every((label) =>
      metricsLog.some(
        (entry) =>
          entry.kind === "appStateMysql" &&
          entry.label === label &&
          Number.isFinite(entry.durationMs),
      ),
    ),
    true,
  );
  assert.equal(
    gaugeLog.some(
      (entry) =>
        entry.name === "mysqlPoolPendingAcquires" && entry.value === 1,
    ),
    true,
  );
  assert.equal(
    gaugeLog.some(
      (entry) =>
        entry.name === "mysqlPoolActiveConnections" && entry.value === 1,
    ),
    true,
  );
  assert.deepEqual(gaugeLog.slice(-2), [
    { name: "mysqlPoolActiveConnections", value: 0 },
    { name: "mysqlPoolPendingAcquires", value: 0 },
  ]);

  const defaultOffMetricsLog = [];
  const defaultOffPool = {
    query: async () => [[{ ok: 1 }]],
    getConnection: async () => connection,
  };
  const defaultOffRepository = new AppStateMysqlRepository({
    mysql: {
      createPool: () => defaultOffPool,
    },
    tableName: "app_state",
    buildInitialState: buildTestState,
    isValidState,
    nowIso: () => "2026-07-03T00:00:00.000Z",
    canInitializeMissingDb: () => true,
    canInitializeExistingEmptyDb: () => true,
    buildEmptyDbInitDeniedMessage: () => "denied",
    runtimeMetrics: {
      recordOperation(kind, label, durationMs) {
        defaultOffMetricsLog.push({ kind, label, durationMs });
      },
    },
  });

  await defaultOffRepository.query("SELECT 1");
  assert.deepEqual(defaultOffMetricsLog, []);
});

test("app-state repository SQLite read/write roundtrip", async () => {
  const runDir = await createTempRunDir("app-state-repo-sqlite");
  const dbPath = path.join(runDir, "backend.sqlite");
  const state = buildTestState();
  state.meta.repositoryRoundtrip = "sqlite";

  const writer = createAppStateRepository(
    createRepositoryOptions({ mode: "sqlite", dbPath }),
  );
  await writer.writeDb(state);
  writer.close();

  const reader = createAppStateRepository(
    createRepositoryOptions({ mode: "sqlite", dbPath }),
  );
  const reread = await reader.readDb({ allowMigrations: false });
  reader.close();

  assert.equal(reread.meta.repositoryRoundtrip, "sqlite");
  assert.equal(
    reread.users.some((user) => user.id === "u_cashier"),
    true,
  );
});

test("app-state repository strutturato rispetta forceReload oltre la cache di processo", async () => {
  const runDir = await createTempRunDir("app-state-repo-sqlite-force-reload");
  const dbPath = path.join(runDir, "backend.sqlite");
  const initialState = buildTestState();
  initialState.meta.crossProcessMarker = "prima";

  const writer = createAppStateRepository(
    createRepositoryOptions({ mode: "sqlite", dbPath }),
  );
  const reader = createAppStateRepository(
    createRepositoryOptions({ mode: "sqlite", dbPath }),
  );

  try {
    await writer.writeDb(initialState);

    const firstRead = await reader.readDb();
    assert.equal(firstRead.meta.crossProcessMarker, "prima");

    const updatedState = cloneJson(initialState);
    updatedState.meta.crossProcessMarker = "dopo";
    await writer.writeDb(updatedState);

    const cachedRead = await reader.readDb();
    assert.equal(cachedRead.meta.crossProcessMarker, "prima");

    const reloadedRead = await reader.readDb({ forceReload: true });
    assert.equal(reloadedRead.meta.crossProcessMarker, "dopo");
  } finally {
    writer.close();
    reader.close();
  }
});

test("app-state repository strutturato invalida la cache se updated_at remoto avanza", async () => {
  const runDir = await createTempRunDir("app-state-repo-sqlite-remote-version");
  const dbPath = path.join(runDir, "backend.sqlite");
  const initialState = buildTestState();
  initialState.meta.lastWriteAt = "2026-07-07T10:00:00.000Z";
  initialState.meta.crossProcessMarker = "prima";

  const writer = createAppStateRepository(
    createRepositoryOptions({ mode: "sqlite", dbPath }),
  );
  const reader = createAppStateRepository(
    createRepositoryOptions({
      mode: "sqlite",
      dbPath,
      overrides: { structuredCacheValidationIntervalMs: 0 },
    }),
  );

  try {
    await writer.writeDb(initialState);

    const firstRead = await reader.readDb();
    assert.equal(firstRead.meta.crossProcessMarker, "prima");

    const updatedState = cloneJson(initialState);
    updatedState.meta.lastWriteAt = "2026-07-07T10:00:01.000Z";
    updatedState.meta.crossProcessMarker = "dopo";
    await writer.writeDb(updatedState);

    const reloadedRead = await reader.readDb();
    assert.equal(reloadedRead.meta.crossProcessMarker, "dopo");
  } finally {
    writer.close();
    reader.close();
  }
});

test("app-state repository MySQL usa il repository strutturato senza scrivere JSON", async () => {
  const runDir = await createTempRunDir("app-state-repo-mysql");
  const dbPath = path.join(runDir, "app-state.json");
  const state = buildTestState();
  state.meta.repositoryRoundtrip = "mysql";
  let stored = null;
  let writeCalls = 0;
  let closed = false;
  const mysqlRepository = {
    ensure: async () => ({ seededState: null, serialized: "", updatedAt: "" }),
    read: async () => {
      if (!stored) throw new Error("missing mysql state");
      const serialized = JSON.stringify(stored);
      return {
        state: cloneJson(stored, stored),
        serialized,
        updatedAt: stored.meta?.lastWriteAt ?? "",
      };
    },
    readReadonly: async () => {
      if (!stored) throw new Error("missing mysql state");
      const serialized = JSON.stringify(stored);
      return {
        state: cloneJson(stored, stored),
        serialized,
        updatedAt: stored.meta?.lastWriteAt ?? "",
      };
    },
    write: async (next) => {
      writeCalls += 1;
      stored = cloneJson(next, next);
      return {
        serialized: JSON.stringify(stored),
        updatedAt: stored.meta?.lastWriteAt ?? "",
      };
    },
    close: () => {
      closed = true;
    },
  };

  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "mysql",
      dbPath,
      overrides: { mysqlRepository },
    }),
  );
  await repository.writeDb(state);
  const reread = await repository.readDb({ allowMigrations: false });
  repository.close();

  assert.equal(writeCalls, 1);
  assert.equal(closed, true);
  assert.equal(existsSync(dbPath), false);
  assert.equal(reread.meta.repositoryRoundtrip, "mysql");
  assert.equal(
    reread.users.some((user) => user.id === "u_cashier"),
    true,
  );
});

test("app-state repository MySQL ritenta writeDb sugli errori transient", async () => {
  const runDir = await createTempRunDir("app-state-repo-mysql-deadlock");
  const dbPath = path.join(runDir, "app-state.json");
  const state = buildTestState();
  state.meta.repositoryRoundtrip = "mysql-deadlock-retry";
  let beforeWriteCalls = 0;
  let writeCalls = 0;
  let stored = null;
  const warnings = [];
  const metricsLog = [];
  const retryEvents = [];
  const mysqlRepository = {
    ensure: async () => ({ seededState: null, serialized: "", updatedAt: "" }),
    read: async () => {
      const serialized = JSON.stringify(stored ?? state);
      return {
        state: cloneJson(stored ?? state, state),
        serialized,
        updatedAt: stored?.meta?.lastWriteAt ?? state.meta?.lastWriteAt ?? "",
      };
    },
    readReadonly: async () => {
      const serialized = JSON.stringify(stored ?? state);
      return {
        state: cloneJson(stored ?? state, state),
        serialized,
        updatedAt: stored?.meta?.lastWriteAt ?? state.meta?.lastWriteAt ?? "",
      };
    },
    write: async (next) => {
      writeCalls += 1;
      stored = cloneJson(next, next);
      return {
        serialized: JSON.stringify(stored),
        updatedAt: stored.meta?.lastWriteAt ?? "",
      };
    },
    close: () => {},
  };
  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "mysql",
      dbPath,
      overrides: {
        mysqlRepository,
        beforeWriteRequired: true,
        beforeWrite: async () => {
          beforeWriteCalls += 1;
          if (beforeWriteCalls === 1) {
            const error = new Error(
              "Deadlock found when trying to get lock; try restarting transaction",
            );
            error.code = "ER_LOCK_DEADLOCK";
            error.errno = 1213;
            throw error;
          }
          if (beforeWriteCalls === 2) {
            const error = new Error(
              "Record has changed since last read in table 'app_state_domain_records'",
            );
            error.code = "ER_CHECKREAD";
            error.errno = 1020;
            throw error;
          }
        },
        runtimeMetrics: {
          recordOperation(kind, label, durationMs) {
            metricsLog.push({ kind, label, durationMs });
          },
        },
        onWriteRetry(event) {
          retryEvents.push(event);
        },
        logger: {
          warn(message) {
            warnings.push(String(message));
          },
        },
      },
    }),
  );

  await repository.writeDb(state);
  repository.close();

  assert.equal(beforeWriteCalls, 3);
  assert.equal(writeCalls, 1);
  assert.equal(stored.meta.repositoryRoundtrip, "mysql-deadlock-retry");
  assert.deepEqual(
    retryEvents.map((event) => [event.code, event.stage, event.label]),
    [
      ["ER_LOCK_DEADLOCK", "beforeWrite", "full"],
      ["ER_CHECKREAD", "beforeWrite", "full"],
    ],
  );
  assert.equal(
    warnings.some((message) =>
      message.includes("Write app-state MySQL in retry"),
    ),
    true,
  );
  for (const label of [
    "beforeWrite.failure.transientDbError",
    "full.beforeWrite.failure.transientDbError",
  ]) {
    assert.equal(
      metricsLog.some(
        (entry) =>
          entry.kind === "appStateWriteHook" &&
          entry.label === label &&
          Number.isFinite(entry.durationMs),
      ),
      true,
      `metrica hook mancante: ${label}`,
    );
  }
  for (const label of [
    "stage.beforeWrite.transientDbError",
    "full.stage.beforeWrite.transientDbError",
  ]) {
    assert.equal(
      metricsLog.filter(
        (entry) =>
          entry.kind === "appStateWriteRetry" &&
          entry.label === label &&
          Number.isFinite(entry.durationMs),
      ).length,
      2,
      `metrica retry mancante: ${label}`,
    );
  }
});

test("app-state MySQL valida il nome tabella", () => {
  assert.throws(
    () => new AppStateMysqlRepository({ tableName: "app_state;drop" }),
    /Identificatore MySQL/,
  );
});

test("app-state dirty tracking salta la primary write per domini esternalizzati", async () => {
  const runDir = await createTempRunDir("app-state-dirty-externalized");
  const dbPath = path.join(runDir, "app-state.json");
  const state = buildTestState();
  state.integration = {
    ...(state.integration ?? {}),
    orders: [
      {
        id: "ord_dirty_a",
        tableId: "room_pedana_t05",
        workflowStatus: "prep",
        items: [{ lineId: "line_dirty_a", name: "Caffe", qty: 1 }],
      },
    ],
  };
  let stored = null;
  let writeCalls = 0;
  let syncCalls = 0;
  const dirtyTrackingEvents = [];
  const mysqlRepository = {
    ensure: async () => ({}),
    read: async () => {
      if (!stored) throw new Error("missing mysql state");
      const serialized = JSON.stringify(stored);
      return {
        state: cloneJson(stored, stored),
        serialized,
        updatedAt: stored.meta?.lastWriteAt ?? "",
      };
    },
    readReadonly: async () => {
      if (!stored) throw new Error("missing mysql state");
      const serialized = JSON.stringify(stored);
      return {
        state: cloneJson(stored, stored),
        serialized,
        updatedAt: stored.meta?.lastWriteAt ?? "",
      };
    },
    write: async (next) => {
      writeCalls += 1;
      stored = cloneJson(next, next);
      return {
        serialized: JSON.stringify(stored),
        updatedAt: stored.meta?.lastWriteAt ?? "",
      };
    },
    close: () => {},
  };
  const stripIntegration = (appState) => {
    const next = cloneJson(appState, appState);
    next.integration = {};
    return next;
  };
  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "mysql",
      dbPath,
      overrides: {
        mysqlRepository,
        dirtyTrackingEnabled: true,
        fullyExternalizedDomains: ["integration"],
        onDirtyTrackingEvent: (event) => dirtyTrackingEvents.push(event),
        beforeWrite: async () => {
          syncCalls += 1;
        },
        prepareWriteState: stripIntegration,
        prepareComparableState: stripIntegration,
      },
    }),
  );

  await repository.writeDb(state);
  assert.equal(writeCalls, 1);
  assert.equal(syncCalls, 1);
  assert.deepEqual(stored.integration, {});

  const nextState = cloneJson(state, state);
  nextState.integration.orders[0].workflowStatus = "ready";
  nextState.integration.orders[0].items[0].done = true;
  await repository.writeDb(nextState, { splitDomains: ["integration"] });

  assert.equal(writeCalls, 1);
  assert.equal(syncCalls, 2);
  assert.deepEqual(stored.integration, {});
  assert.equal(dirtyTrackingEvents.at(-1)?.persistedFastPath, true);
  assert.equal(dirtyTrackingEvents.at(-1)?.fullStateFallbackUsed, false);
  const reread = await repository.readDb({ allowMigrations: false });
  assert.equal(reread.integration.orders[0].workflowStatus, "ready");
});

test("app-state MySQL viene istanziato solo quando la modalita e mysql", async () => {
  const runDir = await createTempRunDir("app-state-repo-mysql-lazy");
  const dbPath = path.join(runDir, "app-state.json");
  const state = buildTestState();
  state.meta.repositoryRoundtrip = "json-with-unused-mysql-config";
  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: { mysqlTableName: "app_state;drop" },
    }),
  );

  await repository.writeDb(state);
  const reread = await repository.readDb({ allowMigrations: false });

  assert.equal(
    reread.meta.repositoryRoundtrip,
    "json-with-unused-mysql-config",
  );
});

test("app-state repository writeQueue serializza scritture concorrenti", async () => {
  const runDir = await createTempRunDir("app-state-repo-queue");
  const dbPath = path.join(runDir, "app-state.json");
  const calls = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const jsonRepository = {
    ensureJsonStateFile: async () => {},
    readJsonStateFile: async () => {
      throw new Error("unused");
    },
    writeJsonStateFile: async (_dbPath, _tmpPath, state) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      calls.push(`start:${state.meta.sequence}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      calls.push(`end:${state.meta.sequence}`);
      activeWrites -= 1;
      return JSON.stringify(state);
    },
  };
  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: { jsonRepository },
    }),
  );
  const states = [1, 2, 3].map((sequence) => {
    const state = buildTestState();
    state.meta.sequence = sequence;
    return state;
  });

  await Promise.all(states.map((state) => repository.writeDb(state)));

  assert.equal(maxActiveWrites, 1);
  assert.deepEqual(calls, [
    "start:1",
    "end:1",
    "start:2",
    "end:2",
    "start:3",
    "end:3",
  ]);
});

test("app-state repository JSON salta scritture con soli timestamp di versione", async () => {
  const runDir = await createTempRunDir("app-state-repo-timestamp-only");
  const dbPath = path.join(runDir, "app-state.json");
  const calls = [];
  const jsonRepository = {
    ensureJsonStateFile: async () => {},
    readJsonStateFile: async () => {
      throw new Error("unused");
    },
    writeJsonStateFile: async (_dbPath, _tmpPath, state) => {
      calls.push({
        metaLastWriteAt: state.meta?.lastWriteAt,
        lastSecurityMigrationAt: state.meta?.lastSecurityMigrationAt,
        integrationLastWriteAt: state.integration?.lastWriteAt,
      });
      return JSON.stringify(state);
    },
  };
  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: { jsonRepository },
    }),
  );
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-06-21T10:00:00.000Z";
  state.integration = {
    ...(state.integration && typeof state.integration === "object"
      ? state.integration
      : {}),
    lastWriteAt: "2026-06-21T10:00:00.000Z",
  };

  await repository.writeDb(state);
  state.meta.lastWriteAt = "2026-06-21T10:00:01.000Z";
  state.meta.lastSecurityMigrationAt = "2026-06-21T10:00:01.000Z";
  state.integration.lastWriteAt = "2026-06-21T10:00:01.000Z";
  await repository.writeDb(state);

  assert.equal(calls.length, 1);
});

test("app-state repository etichetta le metriche writeDb per label e domini", async () => {
  const runDir = await createTempRunDir("app-state-repo-write-metrics-label");
  const dbPath = path.join(runDir, "app-state.json");
  const writeMetricEvents = [];
  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        runtimeMetrics: {
          enabled: true,
          recordWriteDb: (event) => writeMetricEvents.push(event),
        },
      },
    }),
  );
  const state = buildTestState();
  state.meta.metricProbe = "explicit";

  await repository.writeDb(state, {
    metricLabel: "orders.create.appStateWrite",
    splitDomains: ["integration", "auditEvents"],
  });
  assert.equal(writeMetricEvents.at(-1)?.label, "orders.create.appStateWrite");

  const nextState = cloneJson(state, state);
  nextState.meta.metricProbe = "domains";
  await repository.writeDb(nextState, {
    splitDomains: ["integration", "auditEvents"],
  });
  assert.equal(writeMetricEvents.at(-1)?.label, "domains:integration+auditEvents");
});

test("app-state split metadata aggiorna solo i domini cambiati", async () => {
  const runDir = await createTempRunDir(
    "app-state-split-metadata-changed-only",
  );
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  let tick = 0;
  const nowIso = () =>
    `2026-06-22T10:00:${String(++tick).padStart(2, "0")}.000Z`;
  const commonOptions = {
    mode: "externalized",
    dbPath: splitDbPath,
    logger: { warn() {} },
    nowIso,
    cloneJson,
  };
  const auditSplit = createAuditEventsSplitRepository(commonOptions);
  const printSplit = createPrintSpoolJobsSplitRepository(commonOptions);
  const paymentsSplit = createPaymentsFiscalSplitRepository(commonOptions);
  const state = buildTestState();
  state.auditEvents = [
    {
      id: "evt_meta_a",
      occurredAt: "2026-06-22T10:00:00.000Z",
      action: "meta.audit",
    },
  ];
  state.printSpoolJobs = [
    {
      id: "print_meta_a",
      status: "queued",
      createdAt: "2026-06-22T10:00:00.000Z",
    },
  ];
  state.paymentContainers = [{ id: "payc_meta_a", amount: 12, status: "OPEN" }];
  state.paymentParts = [];
  state.paymentTransactions = [
    { id: "tx_meta_a", amountPaid: 12, method: "cash" },
  ];
  state.paymentProviderTransactions = [];
  state.payments = [];
  state.fiscalReceipts = [];
  state.fiscalEvents = [];
  state.cashTxDenoms = [];
  state.smartNonFiscal = [];

  try {
    await auditSplit.syncFromAppState(state);
    await printSplit.syncFromAppState(state);
    await paymentsSplit.syncFromAppState(state);
    const initialRows = readSplitStateRows(splitDbPath);

    const auditOnly = cloneJson(state, state);
    auditOnly.auditEvents.push({
      id: "evt_meta_b",
      occurredAt: "2026-06-22T10:00:10.000Z",
      action: "meta.audit.changed",
    });
    await auditSplit.syncFromAppState(auditOnly);
    await printSplit.syncFromAppState(auditOnly);
    await paymentsSplit.syncFromAppState(auditOnly);
    const afterAuditRows = readSplitStateRows(splitDbPath);

    assert.notEqual(
      afterAuditRows.get("auditEvents")?.synced_at,
      initialRows.get("auditEvents")?.synced_at,
    );
    assert.equal(
      afterAuditRows.get("printSpoolJobs")?.synced_at,
      initialRows.get("printSpoolJobs")?.synced_at,
    );
    assert.equal(
      afterAuditRows.get("paymentsFiscal")?.synced_at,
      initialRows.get("paymentsFiscal")?.synced_at,
    );

    const paymentOnly = cloneJson(auditOnly, auditOnly);
    paymentOnly.paymentTransactions[0] = {
      ...paymentOnly.paymentTransactions[0],
      amountPaid: 13,
    };
    await auditSplit.syncFromAppState(paymentOnly);
    await printSplit.syncFromAppState(paymentOnly);
    await paymentsSplit.syncFromAppState(paymentOnly);
    const afterPaymentRows = readSplitStateRows(splitDbPath);

    assert.equal(
      afterPaymentRows.get("auditEvents")?.synced_at,
      afterAuditRows.get("auditEvents")?.synced_at,
    );
    assert.equal(
      afterPaymentRows.get("printSpoolJobs")?.synced_at,
      afterAuditRows.get("printSpoolJobs")?.synced_at,
    );
    assert.equal(
      afterPaymentRows.get("paymentContainers")?.synced_at,
      afterAuditRows.get("paymentContainers")?.synced_at,
    );
    assert.notEqual(
      afterPaymentRows.get("paymentTransactions")?.synced_at,
      afterAuditRows.get("paymentTransactions")?.synced_at,
    );
    assert.notEqual(
      afterPaymentRows.get("paymentsFiscal")?.synced_at,
      afterAuditRows.get("paymentsFiscal")?.synced_at,
    );
  } finally {
    auditSplit.close();
    printSplit.close();
    paymentsSplit.close();
  }
});

test("app-state MySQL domain split invia solo record cambiati o posizioni", async () => {
  const queryLog = [];
  const metricsLog = [];
  const storedRows = new Map();
  const connection = {
    beginTransaction: async () => {
      queryLog.push({ sql: "BEGIN" });
    },
    commit: async () => {
      queryLog.push({ sql: "COMMIT" });
    },
    rollback: async () => {
      queryLog.push({ sql: "ROLLBACK" });
    },
    release: () => {},
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT record_id, kind, app_state_position, row_hash/s.test(sql)) {
        return [[...storedRows.values()].map((row) => ({ ...row }))];
      }
      if (/INSERT INTO\s+`app_state_domain_records`/s.test(sql)) {
        const [domain, recordId, kind, appStatePosition, rowHash, rawJson] =
          params;
        storedRows.set(`${domain}:${recordId}`, {
          record_id: recordId,
          kind,
          app_state_position: appStatePosition,
          row_hash: rowHash,
          raw_json: rawJson,
        });
        return [{ affectedRows: 1 }];
      }
      if (/^\s*UPDATE\b[\s\S]*app_state_position/s.test(sql)) {
        const [appStatePosition, domain, recordId] = params;
        const row = storedRows.get(`${domain}:${recordId}`);
        if (row) row.app_state_position = appStatePosition;
        return [{ affectedRows: row ? 1 : 0 }];
      }
      if (/DELETE FROM\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      if (/DELETE FROM\s+`app_state_domain_records`/s.test(sql)) {
        const [domain, ...recordIds] = params;
        for (const recordId of recordIds) {
          storedRows.delete(`${domain}:${recordId}`);
        }
        return [{ affectedRows: recordIds.length }];
      }
      return [[]];
    },
  };
  const mysqlRepository = {
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      return [];
    },
    getPool: async () => ({
      getConnection: async () => connection,
    }),
  };
  const split = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "app_state_domain_records",
    domains: ["menuItems"],
    mysqlRepository,
    logger: { info() {} },
  });
  const state = {
    menuItems: [
      { id: "menu_a", name: "A", price: 1 },
      { id: "menu_b", name: "B", price: 2 },
      { id: "menu_c", name: "C", price: 3 },
    ],
  };

  await split.syncFromAppState(state);
  const firstSelectCount = queryLog.filter((entry) =>
    /SELECT record_id, kind, app_state_position, row_hash/s.test(entry.sql),
  ).length;
  const firstInsertCount = queryLog.filter((entry) =>
    /INSERT INTO/s.test(entry.sql),
  ).length;

  const changed = cloneJson(state, state);
  changed.menuItems[1] = { ...changed.menuItems[1], price: 2.5 };
  await split.syncFromAppState(changed);
  const afterChangeSelectCount = queryLog.filter((entry) =>
    /SELECT record_id, kind, app_state_position, row_hash/s.test(entry.sql),
  ).length;
  const afterChangeInsertCount = queryLog.filter((entry) =>
    /INSERT INTO/s.test(entry.sql),
  ).length;

  assert.equal(firstSelectCount, 1);
  assert.equal(firstInsertCount, 3);
  assert.equal(afterChangeSelectCount, 1);
  assert.equal(afterChangeInsertCount - firstInsertCount, 1);
  assert.match(
    queryLog
      .filter((entry) => /INSERT INTO/s.test(entry.sql))
      .at(-1).params.at(-1),
    /2\.5/,
  );

  const reordered = cloneJson(changed, changed);
  reordered.menuItems = [
    reordered.menuItems[1],
    reordered.menuItems[0],
    reordered.menuItems[2],
  ];
  await split.syncFromAppState(reordered);
  const afterReorderSelectCount = queryLog.filter((entry) =>
    /SELECT record_id, kind, app_state_position, row_hash/s.test(entry.sql),
  ).length;
  const afterReorderInsertCount = queryLog.filter((entry) =>
    /INSERT INTO/s.test(entry.sql),
  ).length;
  const positionUpdateCount = queryLog.filter((entry) =>
    /^\s*UPDATE\b[\s\S]*app_state_position/s.test(entry.sql),
  ).length;

  assert.equal(afterReorderSelectCount, 1);
  assert.equal(afterReorderInsertCount, afterChangeInsertCount);
  assert.equal(positionUpdateCount, 2);
});

test("app-state MySQL domain split aggiorna una voce array top-level", async () => {
  const queryLog = [];
  const storedRows = new Map();
  const connection = {
    beginTransaction: async () => {
      queryLog.push({ sql: "BEGIN" });
    },
    commit: async () => {
      queryLog.push({ sql: "COMMIT" });
    },
    rollback: async () => {
      queryLog.push({ sql: "ROLLBACK" });
    },
    release: () => {},
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT record_id, kind, app_state_position, row_hash/s.test(sql)) {
        const [domain] = params;
        return [
          [...storedRows.entries()]
            .filter(([key]) => key.startsWith(`${domain}:`))
            .map(([, row]) => ({ ...row })),
        ];
      }
      if (/INSERT INTO\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO\s+`app_state_domain_records`/s.test(sql)) {
        const [domain, recordId, kind, appStatePosition, rowHash, rawJson] =
          params;
        storedRows.set(`${domain}:${recordId}`, {
          domain,
          record_id: recordId,
          kind,
          app_state_position: appStatePosition,
          row_hash: rowHash,
          raw_json: rawJson,
        });
        return [{ affectedRows: 1 }];
      }
      if (/^\s*UPDATE\b[\s\S]*app_state_position/s.test(sql)) {
        const [appStatePosition, domain, recordId] = params;
        const row = storedRows.get(`${domain}:${recordId}`);
        if (row) row.app_state_position = appStatePosition;
        return [{ affectedRows: row ? 1 : 0 }];
      }
      if (/DELETE FROM\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      if (/DELETE FROM\s+`app_state_domain_records`/s.test(sql)) {
        const [domain, ...recordIds] = params;
        for (const recordId of recordIds) {
          storedRows.delete(`${domain}:${recordId}`);
        }
        return [{ affectedRows: recordIds.length }];
      }
      return [[]];
    },
  };
  const mysqlRepository = {
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      return [];
    },
    getPool: async () => ({
      getConnection: async () => connection,
    }),
  };
  const split = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "app_state_domain_records",
    domains: ["printSpoolJobs"],
    mysqlRepository,
    logger: { info() {} },
  });
  const state = {
    printSpoolJobs: [
      { id: "print_a", status: "queued", attempts: 0 },
      { id: "print_b", status: "queued", attempts: 0 },
    ],
  };

  await split.syncFromAppState(state);
  const firstInsertCount = queryLog.filter((entry) =>
    /INSERT INTO/s.test(entry.sql),
  ).length;
  assert.equal(firstInsertCount, 2);

  const changed = cloneJson(state, state);
  changed.printSpoolJobs[1] = {
    ...changed.printSpoolJobs[1],
    status: "processing",
    attempts: 1,
  };
  await split.syncDomainArrayEntriesFromAppState(changed, "printSpoolJobs", [
    "print_b",
  ]);
  const afterTargetedInsertCount = queryLog.filter((entry) =>
    /INSERT INTO/s.test(entry.sql),
  ).length;

  assert.equal(afterTargetedInsertCount - firstInsertCount, 1);
  assert.equal(
    JSON.parse(
      storedRows.get("printSpoolJobs:print_a")?.raw_json ?? "null",
    )?.status,
    "queued",
  );
  assert.equal(
    JSON.parse(
      storedRows.get("printSpoolJobs:print_b")?.raw_json ?? "null",
    )?.status,
    "processing",
  );

  await split.syncDomainArrayEntriesFromAppState(changed, "printSpoolJobs", [
    "print_b",
  ]);
  const afterUnchangedTargetedInsertCount = queryLog.filter((entry) =>
    /INSERT INTO/s.test(entry.sql),
  ).length;

  assert.equal(afterUnchangedTargetedInsertCount, afterTargetedInsertCount);
});

test("app-state MySQL domain split legge campi scoped senza idratare tutto il dominio", async () => {
  const queryLog = [];
  const storedRows = new Map();
  const stationIndexRows = [];
  const rowsForDomain = (domain, fieldName = "") =>
    [...storedRows.entries()]
      .filter(([key]) => key.startsWith(`${domain}:`))
      .map(([, row]) => ({ ...row }))
      .filter((row) =>
        fieldName
          ? row.record_id === fieldName || String(row.record_id).startsWith(`${fieldName}:`)
          : true,
      )
      .sort((left, right) => left.app_state_position - right.app_state_position);
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT record_id, kind, app_state_position, row_hash/s.test(sql)) {
        return [rowsForDomain(params[0])];
      }
      if (/INSERT INTO\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        for (let index = 0; index < params.length; index += 6) {
          const [domain, fieldName, station, matchKind, orderRecordId, appStatePosition] =
            params.slice(index, index + 6);
          stationIndexRows.push({
            domain,
            field_name: fieldName,
            station,
            match_kind: matchKind,
            order_record_id: orderRecordId,
            app_state_position: appStatePosition,
          });
        }
        return [{ affectedRows: params.length / 6 }];
      }
      if (/INSERT INTO\s+`app_state_domain_records`/s.test(sql)) {
        const [domain, recordId, kind, appStatePosition, rowHash, rawJson] =
          params;
        storedRows.set(`${domain}:${recordId}`, {
          domain,
          record_id: recordId,
          kind,
          app_state_position: appStatePosition,
          row_hash: rowHash,
          raw_json: rawJson,
        });
        return [{ affectedRows: 1 }];
      }
      if (/DELETE FROM\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        const [domain, fieldName, ...deleteParams] = params;
        const tupleDelete = /\(station,\s*match_kind,\s*order_record_id\)\s+IN/s.test(sql);
        const deleteTuples = [];
        if (tupleDelete) {
          for (let offset = 0; offset < deleteParams.length; offset += 3) {
            deleteTuples.push({
              station: deleteParams[offset],
              match_kind: deleteParams[offset + 1],
              order_record_id: deleteParams[offset + 2],
            });
          }
        }
        for (let index = stationIndexRows.length - 1; index >= 0; index -= 1) {
          const row = stationIndexRows[index];
          if (row.domain !== domain || row.field_name !== fieldName) continue;
          if (tupleDelete) {
            if (
              !deleteTuples.some(
                (entry) =>
                  entry.station === row.station &&
                  entry.match_kind === row.match_kind &&
                  entry.order_record_id === row.order_record_id,
              )
            ) {
              continue;
            }
          } else if (deleteParams.length > 0 && !deleteParams.includes(row.order_record_id)) {
            continue;
          }
          stationIndexRows.splice(index, 1);
        }
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };
  const mysqlRepository = {
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT records\.domain, records\.record_id/s.test(sql)) {
        const [domain, fieldName, station, ...rest] = params;
        const domainParam = rest.at(-1);
        const matchKinds = new Set(rest.slice(0, -1));
        const wanted = stationIndexRows
          .filter(
            (row) =>
              row.domain === domain &&
              row.field_name === fieldName &&
              row.station === station &&
              matchKinds.has(row.match_kind),
          )
          .sort((a, b) => a.app_state_position - b.app_state_position);
        return wanted
          .map((row) => storedRows.get(`${domainParam}:${row.order_record_id}`))
          .filter(Boolean)
          .map((row) => ({ ...row }));
      }
      if (/SELECT order_record_id\s+FROM\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        const [domain, fieldName] = params;
        return stationIndexRows
          .filter((row) => row.domain === domain && row.field_name === fieldName)
          .slice(0, 1);
      }
      if (/SELECT domain, record_id, kind, app_state_position, row_hash, raw_json/s.test(sql)) {
        const rows = rowsForDomain(params[0], params[1]);
        if (/LOWER\(CAST\(raw_json AS CHAR\)\) LIKE LOWER/s.test(sql)) {
          const needle = String(params[3] ?? "")
            .replace(/^%|%$/g, "")
            .toLowerCase();
          return rows.filter(
            (row) =>
              row.record_id === params[1] ||
              String(row.raw_json ?? "").toLowerCase().includes(needle),
          );
        }
        return rows;
      }
      if (/SELECT raw_json/s.test(sql)) {
        const [domain, recordId] = params;
        const row = storedRows.get(`${domain}:${recordId}`);
        return row ? [{ raw_json: row.raw_json }] : [];
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
    domains: ["integration", "posSettings"],
    objectEntryDomains: ["integration", "posSettings"],
    objectArrayEntryFields: { integration: ["orders", "stationStates"] },
    mysqlRepository,
    logger: { info() {} },
  });

  await split.syncFromAppState({
    integration: {
      orders: [
        { id: "order_scoped_a", station: "BAR", total: 99 },
        { id: "order_scoped_b", station: "CUCINA", total: 42 },
        {
          id: "order_scoped_c",
          assignedStationId: "CUCINA",
          items: [{ id: "line_c", routeStations: ["BAR"] }],
          total: 11,
        },
        {
          id: "order_scoped_d",
          items: [{ id: "line_d", routeStations: ["BAR"] }],
          total: 12,
        },
      ],
      orderComps: [{ id: "comp_scoped_a", orderId: "order_scoped_a" }],
      stationStates: [
        { station: "BAR", active: true, deviceUuid: "station-bar" },
        { station: "CUCINA", active: false, deviceUuid: "station-kitchen" },
      ],
    },
    posSettings: {
      workstations: [{ id: "ws_bar", stationName: "BAR", enabled: true }],
      automaticCash: {
        cashExchanges: [{ exchangeId: "exchange-current", status: "DEPOSITING" }],
      },
    },
  });
  queryLog.length = 0;

  const stationStates = await split.readObjectArrayField("integration", "stationStates", []);
  const stationOrders = await split.readIntegrationOrdersForStation("BAR", { includeTransferred: false });
  const singleOrder = await split.readObjectArrayEntry(
    "integration",
    "orders",
    "order_scoped_b",
    null,
  );
  const orderComps = await split.readObjectEntry("integration", "orderComps", []);
  const posSettings = await split.readDomainValue("posSettings", {});

  assert.equal(stationStates.length, 2);
  assert.equal(stationOrders.length, 2);
  assert.deepEqual(
    stationOrders.map((order) => order.id),
    ["order_scoped_a", "order_scoped_d"],
  );
  assert.equal(orderComps[0].id, "comp_scoped_a");
  assert.equal(singleOrder.id, "order_scoped_b");
  assert.equal(singleOrder.total, 42);
  assert.equal(stationStates[0].station, "BAR");
  assert.equal(posSettings.workstations[0].stationName, "BAR");
  assert.equal(posSettings.automaticCash.cashExchanges[0].exchangeId, "exchange-current");
  assert.equal(
    queryLog.some((entry) => String(entry.params?.[1] ?? "") === "stationStates"),
    true,
  );
  assert.equal(
    queryLog.some((entry) => JSON.stringify(entry).includes("order_scoped_a")),
    false,
  );
  assert.equal(
    queryLog.some(
      (entry) =>
        /SELECT raw_json/s.test(entry.sql) &&
        entry.params?.[0] === "integration" &&
        entry.params?.[1] === "orders:order_scoped_b",
    ),
    true,
  );

  await split.syncFromAppState(
    {
      integration: {},
      posSettings: {
        workstations: [{ id: "ws_bar", stationName: "BAR-2", enabled: true }],
        automaticCash: { cashExchanges: [] },
      },
    },
    {
      domains: ["posSettings"],
      preserveObjectEntriesByDomain: { posSettings: ["automaticCash"] },
    },
  );
  const preservedAutomaticCash = await split.readObjectEntry(
    "posSettings",
    "automaticCash",
    null,
  );
  assert.equal(
    preservedAutomaticCash.cashExchanges[0].exchangeId,
    "exchange-current",
  );
  assert.equal(
    queryLog.some(
      (entry) =>
        /SELECT record_id, kind, app_state_position, row_hash/s.test(entry.sql) &&
        /FOR UPDATE/s.test(entry.sql),
    ),
    true,
  );
});

test("app-state MySQL domain split salva integration.orders per singola comanda", async () => {
  const queryLog = [];
  const storedRows = new Map();
  const connection = {
    beginTransaction: async () => {
      queryLog.push({ sql: "BEGIN" });
    },
    commit: async () => {
      queryLog.push({ sql: "COMMIT" });
    },
    rollback: async () => {
      queryLog.push({ sql: "ROLLBACK" });
    },
    release: () => {},
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT record_id, kind, app_state_position, row_hash/s.test(sql)) {
        const [domain] = params;
        return [
          [...storedRows.entries()]
            .filter(([key]) => key.startsWith(`${domain}:`))
            .map(([, row]) => ({ ...row })),
        ];
      }
      if (/INSERT INTO\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO\s+`app_state_domain_records`/s.test(sql)) {
        const [domain, recordId, kind, appStatePosition, rowHash, rawJson] =
          params;
        storedRows.set(`${domain}:${recordId}`, {
          domain,
          record_id: recordId,
          kind,
          app_state_position: appStatePosition,
          row_hash: rowHash,
          raw_json: rawJson,
        });
        return [{ affectedRows: 1 }];
      }
      if (/^\s*UPDATE\b[\s\S]*app_state_position/s.test(sql)) {
        const [appStatePosition, domain, recordId] = params;
        const row = storedRows.get(`${domain}:${recordId}`);
        if (row) row.app_state_position = appStatePosition;
        return [{ affectedRows: row ? 1 : 0 }];
      }
      if (/DELETE FROM\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      if (/DELETE FROM\s+`app_state_domain_records`/s.test(sql)) {
        const [domain, ...recordIds] = params;
        for (const recordId of recordIds) {
          storedRows.delete(`${domain}:${recordId}`);
        }
        return [{ affectedRows: recordIds.length }];
      }
      return [[]];
    },
  };
  const mysqlRepository = {
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT domain, record_id, kind, app_state_position, row_hash, raw_json/s.test(sql)) {
        const [domain] = params;
        return [...storedRows.entries()]
          .filter(([key]) => key.startsWith(`${domain}:`))
          .map(([, row]) => ({ ...row }))
          .sort((a, b) => {
            if (a.app_state_position !== b.app_state_position) {
              return a.app_state_position - b.app_state_position;
            }
            return String(a.record_id).localeCompare(String(b.record_id));
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
    domains: ["integration"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["orders", "notifications"] },
    mysqlRepository,
    logger: { info() {} },
  });
  const state = {
    integration: {
      lastOrderNumber: 2,
      orders: [
        { id: "ord_a", total: 10, items: [{ id: "a1" }] },
        { id: "ord_b", total: 20, items: [{ id: "b1" }] },
      ],
      notifications: [],
    },
  };

  await split.syncFromAppState(state);
  assert.equal(storedRows.get("integration:orders")?.kind, "obj_array");
  assert.equal(storedRows.get("integration:orders:ord_a")?.kind, "obj_array_entry");
  assert.equal(storedRows.get("integration:orders:ord_b")?.kind, "obj_array_entry");
  assert.equal(JSON.parse(storedRows.get("integration:orders")?.raw_json ?? "null").length, 0);

  const firstInsertCount = queryLog.filter((entry) =>
    /INSERT INTO/s.test(entry.sql),
  ).length;
  const changed = cloneJson(state, state);
  changed.integration.orders.push({
    id: "ord_c",
    total: 30,
    items: [{ id: "c1" }],
  });
  await split.syncFromAppState(changed);
  const afterChangeInsertCount = queryLog.filter((entry) =>
    /INSERT INTO/s.test(entry.sql),
  ).length;

  assert.equal(afterChangeInsertCount - firstInsertCount, 1);
  assert.equal(storedRows.get("integration:orders:ord_c")?.kind, "obj_array_entry");

  const targeted = cloneJson(changed, changed);
  targeted.integration.orders[1] = {
    ...targeted.integration.orders[1],
    total: 22,
  };
  await split.syncObjectArrayEntriesFromAppState(
    targeted,
    "integration",
    "orders",
    ["ord_b"],
  );
  const afterTargetedInsertCount = queryLog.filter((entry) =>
    /INSERT INTO/s.test(entry.sql),
  ).length;

  assert.equal(afterTargetedInsertCount - afterChangeInsertCount, 1);
  assert.equal(
    JSON.parse(storedRows.get("integration:orders:ord_b")?.raw_json ?? "null")
      ?.total,
    22,
  );
  assert.equal(
    JSON.parse(storedRows.get("integration:orders:ord_a")?.raw_json ?? "null")
      ?.total,
    10,
  );

  await split.syncObjectArrayEntriesFromAppState(
    targeted,
    "integration",
    "orders",
    ["ord_b"],
  );
  const afterUnchangedTargetedInsertCount = queryLog.filter((entry) =>
    /INSERT INTO/s.test(entry.sql),
  ).length;

  assert.equal(afterUnchangedTargetedInsertCount, afterTargetedInsertCount);

  const hydrated = await split.hydrateAppState({ integration: {} });
  assert.equal(hydrated.integration.orders.length, 3);
  assert.deepEqual(
    hydrated.integration.orders.map((order) => order.id),
    ["ord_a", "ord_b", "ord_c"],
  );
});

test("app-state MySQL domain split accorpa entries e object fields integration", async () => {
  const queryLog = [];
  const storedRows = new Map();
  let getConnectionCount = 0;
  const stationIndexRows = [];
  const connection = {
    beginTransaction: async () => {
      queryLog.push({ sql: "BEGIN" });
    },
    commit: async () => {
      queryLog.push({ sql: "COMMIT" });
    },
    rollback: async () => {
      queryLog.push({ sql: "ROLLBACK" });
    },
    release: () => {
      queryLog.push({ sql: "RELEASE" });
    },
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]*FOR UPDATE/s.test(sql)) {
        const [domain, ...recordIds] = params;
        return [
          recordIds
            .map((recordId) => storedRows.get(`${domain}:${recordId}`))
            .filter(Boolean)
            .map((row) => ({ ...row })),
        ];
      }
      if (/SELECT record_id, kind, app_state_position, row_hash/s.test(sql)) {
        const [domain] = params;
        return [
          [...storedRows.entries()]
            .filter(([key]) => key.startsWith(`${domain}:`))
            .map(([, row]) => ({ ...row })),
        ];
      }
      if (/SELECT record_id\s+FROM\s+`app_state_domain_records`/s.test(sql)) {
        const [domain, fieldName] = params;
        return [[...storedRows.values()]
          .filter((row) =>
            row.domain === domain &&
            (row.record_id === fieldName || row.record_id.startsWith(`${fieldName}:`))
          )
          .map((row) => ({ record_id: row.record_id }))];
      }
      if (/DELETE FROM\s+`app_state_domain_records`\s+WHERE domain = \?/s.test(sql)) {
        const [domain, ...recordIds] = params;
        recordIds.forEach((recordId) => storedRows.delete(`${domain}:${recordId}`));
        return [{ affectedRows: recordIds.length }];
      }
      if (/SELECT station, match_kind, order_record_id, app_state_position/s.test(sql)) {
        return [[]];
      }
      if (/INSERT INTO\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        const chunk = [];
        for (let index = 0; index < params.length; index += 6) {
          chunk.push({
            domain: params[index],
            field_name: params[index + 1],
            station: params[index + 2],
            match_kind: params[index + 3],
            order_record_id: params[index + 4],
            app_state_position: params[index + 5],
          });
        }
        stationIndexRows.push(...chunk);
        return [{ affectedRows: chunk.length }];
      }
      if (/INSERT INTO\s+`app_state_domain_records`/s.test(sql)) {
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
      return [];
    },
    getPool: async () => ({
      getConnection: async () => {
        getConnectionCount += 1;
        return connection;
      },
    }),
  };
  const split = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "app_state_domain_records",
    domains: ["integration"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["orders"] },
    mysqlRepository,
    logger: { info() {}, warn() {} },
  });
  const state = {
    integration: {
      lastWriteAt: "2026-07-03T10:00:00.000Z",
      sequence: 42,
      orders: [
        {
          id: "ord_bulk",
          station: "BAR",
          total: 10,
          items: [{ id: "line_bulk", qty: 1 }],
        },
      ],
      notifications: [
        {
          id: "notif_bulk",
          type: "bell",
          title: "Comanda pronta",
          orderId: "ord_bulk",
        },
        {
          id: "notif_stale",
          type: "general",
          title: "Da eliminare",
        },
      ],
    },
  };

  await split.syncObjectArrayEntriesAndObjectEntriesFromAppState(
    state,
    "integration",
    {
      objectArrayEntries: [
        { fieldName: "orders", entryIds: ["ord_bulk"] },
        { fieldName: "notifications", entryIds: ["notif_bulk", "notif_stale"] },
      ],
      objectFields: ["lastWriteAt", "sequence"],
    },
  );

  const lockQueryIndex = queryLog.findIndex(
    (entry) =>
      /SELECT record_id, kind, app_state_position, row_hash, raw_json/s.test(entry.sql) &&
      /FOR UPDATE/s.test(entry.sql) &&
      entry.params?.[0] === "integration",
  );
  assert.ok(lockQueryIndex >= 0, "lock batch integration non osservato");
  assert.deepEqual(
    queryLog[lockQueryIndex].params,
    [
      "integration",
      "lastWriteAt",
      "notifications",
      "notifications:notif_bulk",
      "notifications:notif_stale",
      "orders",
      "orders:ord_bulk",
      "sequence",
    ],
    "il lock batch deve seguire domain/recordId anche per sequence",
  );

  assert.equal(getConnectionCount, 1);
  assert.equal(storedRows.get("integration:orders:ord_bulk")?.kind, "obj_array_entry");
  assert.equal(storedRows.get("integration:notifications:notif_bulk")?.kind, "obj_array_entry");
  assert.equal(storedRows.get("integration:lastWriteAt")?.kind, "object_entry");
  assert.equal(storedRows.get("integration:sequence")?.kind, "object_entry");
  assert.equal(stationIndexRows[0]?.station, "BAR");

  const ackState = cloneJson(state, state);
  ackState.integration.notifications = [
    { ...ackState.integration.notifications[0], ackedBy: ["mobile:u_waiter"] },
  ];
  await split.syncObjectArrayEntriesAndObjectEntriesFromAppState(
    ackState,
    "integration",
    {
      replaceObjectArrayFields: ["notifications"],
      objectArrayEntries: [
        { fieldName: "orders", entryIds: ["ord_bulk"] },
      ],
      objectFields: ["lastWriteAt", "sequence"],
    },
  );

  assert.equal(getConnectionCount, 2);
  assert.equal(storedRows.has("integration:notifications:notif_stale"), false);
  assert.deepEqual(
    JSON.parse(storedRows.get("integration:notifications:notif_bulk")?.raw_json ?? "null")?.ackedBy,
    ["mobile:u_waiter"],
  );
});

test("app-state MySQL domain split sequence ordini rispetta il floor relazionale", async () => {
  const storedRows = new Map([
    [
      "integration:sequence",
      {
        domain: "integration",
        record_id: "sequence",
        kind: "object_entry",
        app_state_position: 0,
        row_hash: "old",
        raw_json: JSON.stringify({ order: 4, notification: 3 }),
      },
    ],
  ]);
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: async (sql, params = []) => {
      if (/SELECT raw_json FROM\s+`app_state_domain_records`\s+WHERE domain = \? AND record_id = \? FOR UPDATE/s.test(sql)) {
        const [domain, recordId] = params;
        const row = storedRows.get(`${domain}:${recordId}`);
        return [[row ? { raw_json: row.raw_json } : undefined].filter(Boolean)];
      }
      if (/UPDATE\s+`app_state_domain_records`\s+SET raw_json = \?, row_hash = \?/s.test(sql)) {
        const [rawJson, rowHash, domain, recordId] = params;
        const row = storedRows.get(`${domain}:${recordId}`);
        if (row) {
          row.raw_json = rawJson;
          row.row_hash = rowHash;
        }
        return [{ affectedRows: row ? 1 : 0 }];
      }
      return [[]];
    },
  };
  const split = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "app_state_domain_records",
    domains: ["integration"],
    objectEntryDomains: ["integration"],
    mysqlRepository: {
      query: async () => [],
      getPool: async () => ({ getConnection: async () => connection }),
    },
    logger: { info() {}, warn() {} },
  });

  const first = await split.incrementIntegrationOrderSequence(
    { order: 4, notification: 3 },
    { minimumNextOrder: 5 },
  );
  const second = await split.incrementIntegrationOrderSequence(
    { order: 4, notification: 3 },
    { minimumNextOrder: 5 },
  );

  assert.equal(first, 5);
  assert.equal(second, 6);
  assert.deepEqual(JSON.parse(storedRows.get("integration:sequence").raw_json), {
    order: 7,
    notification: 3,
  });
});

test("app-state MySQL domain split evita rewrite indice postazione se la station non cambia", async () => {
  const queryLog = [];
  const metricsLog = [];
  const storedRows = new Map();
  const stationIndexRows = [];
  const upsertStationIndexRow = (row) => {
    const existingIndex = stationIndexRows.findIndex(
      (entry) =>
        entry.domain === row.domain &&
        entry.field_name === row.field_name &&
        entry.station === row.station &&
        entry.match_kind === row.match_kind &&
        entry.order_record_id === row.order_record_id,
    );
    if (existingIndex >= 0) {
      stationIndexRows[existingIndex] = row;
    } else {
      stationIndexRows.push(row);
    }
  };
  const connection = {
    beginTransaction: async () => {
      queryLog.push({ sql: "BEGIN" });
    },
    commit: async () => {
      queryLog.push({ sql: "COMMIT" });
    },
    rollback: async () => {
      queryLog.push({ sql: "ROLLBACK" });
    },
    release: () => {},
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT record_id, kind, app_state_position, row_hash/s.test(sql)) {
        const [domain] = params;
        return [
          [...storedRows.entries()]
            .filter(([key]) => key.startsWith(`${domain}:`))
            .map(([, row]) => ({ ...row })),
        ];
      }
      if (/SELECT station, match_kind, order_record_id, app_state_position/s.test(sql)) {
        const [domain, fieldName, ...recordIds] = params;
        return [
          stationIndexRows
            .filter(
              (row) =>
                row.domain === domain &&
                row.field_name === fieldName &&
                recordIds.includes(row.order_record_id),
            )
            .map((row) => ({ ...row })),
        ];
      }
      if (/INSERT INTO\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        const [domain, fieldName, station, matchKind, orderRecordId, appStatePosition] =
          params;
        upsertStationIndexRow({
          domain,
          field_name: fieldName,
          station,
          match_kind: matchKind,
          order_record_id: orderRecordId,
          app_state_position: appStatePosition,
        });
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO\s+`app_state_domain_records`/s.test(sql)) {
        const [domain, recordId, kind, appStatePosition, rowHash, rawJson] =
          params;
        storedRows.set(`${domain}:${recordId}`, {
          domain,
          record_id: recordId,
          kind,
          app_state_position: appStatePosition,
          row_hash: rowHash,
          raw_json: rawJson,
        });
        return [{ affectedRows: 1 }];
      }
      if (/^\s*UPDATE\b[\s\S]*app_state_position/s.test(sql)) {
        const [appStatePosition, domain, recordId] = params;
        const row = storedRows.get(`${domain}:${recordId}`);
        if (row) row.app_state_position = appStatePosition;
        return [{ affectedRows: row ? 1 : 0 }];
      }
      if (/DELETE FROM\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        const [domain, fieldName, ...deleteParams] = params;
        const tupleDelete = /\(station,\s*match_kind,\s*order_record_id\)\s+IN/s.test(sql);
        const deleteTuples = [];
        if (tupleDelete) {
          for (let offset = 0; offset < deleteParams.length; offset += 3) {
            deleteTuples.push({
              station: deleteParams[offset],
              match_kind: deleteParams[offset + 1],
              order_record_id: deleteParams[offset + 2],
            });
          }
        }
        for (let index = stationIndexRows.length - 1; index >= 0; index -= 1) {
          const row = stationIndexRows[index];
          if (row.domain !== domain || row.field_name !== fieldName) continue;
          if (tupleDelete) {
            if (
              !deleteTuples.some(
                (entry) =>
                  entry.station === row.station &&
                  entry.match_kind === row.match_kind &&
                  entry.order_record_id === row.order_record_id,
              )
            ) {
              continue;
            }
          } else if (deleteParams.length > 0 && !deleteParams.includes(row.order_record_id)) {
            continue;
          }
          stationIndexRows.splice(index, 1);
        }
        return [{ affectedRows: 1 }];
      }
      if (/DELETE FROM\s+`app_state_domain_records`/s.test(sql)) {
        const [domain, ...recordIds] = params;
        for (const recordId of recordIds) {
          storedRows.delete(`${domain}:${recordId}`);
        }
        return [{ affectedRows: recordIds.length }];
      }
      return [[]];
    },
  };
  const mysqlRepository = {
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT order_record_id\s+FROM\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        const [domain, fieldName] = params;
        return stationIndexRows
          .filter((row) => row.domain === domain && row.field_name === fieldName)
          .slice(0, 1);
      }
      if (/SELECT domain, record_id, kind, app_state_position, row_hash, raw_json/s.test(sql)) {
        const [domain] = params;
        return [...storedRows.entries()]
          .filter(([key]) => key.startsWith(`${domain}:`))
          .map(([, row]) => ({ ...row }))
          .sort((a, b) => {
            if (a.app_state_position !== b.app_state_position) {
              return a.app_state_position - b.app_state_position;
            }
            return String(a.record_id).localeCompare(String(b.record_id));
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
    domains: ["integration"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["orders"] },
    mysqlRepository,
    runtimeMetrics: {
      recordOperation(kind, label, durationMs) {
        metricsLog.push({ kind, label, durationMs });
      },
    },
    logger: { info() {} },
  });
  const state = {
    integration: {
      orders: [
        { id: "ord_station", station: "BAR", total: 10, items: [{ id: "a1" }] },
      ],
    },
  };

  await split.syncFromAppState(state);
  const initialIndexInsertCount = queryLog.filter((entry) =>
    /INSERT INTO\s+`app_state_domain_records_order_station_index`/s.test(entry.sql),
  ).length;
  const initialIndexDeleteCount = queryLog.filter((entry) =>
    /DELETE FROM\s+`app_state_domain_records_order_station_index`/s.test(entry.sql),
  ).length;

  assert.equal(initialIndexInsertCount, 1);
  assert.equal(stationIndexRows[0]?.station, "BAR");

  const sameStation = cloneJson(state, state);
  sameStation.integration.orders[0] = {
    ...sameStation.integration.orders[0],
    total: 12,
  };
  await split.syncObjectArrayEntriesFromAppState(
    sameStation,
    "integration",
    "orders",
    ["ord_station"],
  );
  const sameStationIndexInsertCount = queryLog.filter((entry) =>
    /INSERT INTO\s+`app_state_domain_records_order_station_index`/s.test(entry.sql),
  ).length;
  const sameStationIndexDeleteCount = queryLog.filter((entry) =>
    /DELETE FROM\s+`app_state_domain_records_order_station_index`/s.test(entry.sql),
  ).length;

  assert.equal(sameStationIndexInsertCount, initialIndexInsertCount);
  assert.equal(sameStationIndexDeleteCount, initialIndexDeleteCount);
  assert.equal(stationIndexRows[0]?.station, "BAR");

  const changedStation = cloneJson(sameStation, sameStation);
  changedStation.integration.orders[0] = {
    ...changedStation.integration.orders[0],
    station: "CUCINA",
  };
  await split.syncObjectArrayEntriesFromAppState(
    changedStation,
    "integration",
    "orders",
    ["ord_station"],
  );
  const changedStationIndexInsertCount = queryLog.filter((entry) =>
    /INSERT INTO\s+`app_state_domain_records_order_station_index`/s.test(entry.sql),
  ).length;
  const changedStationIndexDeleteCount = queryLog.filter((entry) =>
    /DELETE FROM\s+`app_state_domain_records_order_station_index`/s.test(entry.sql),
  ).length;

  assert.equal(changedStationIndexInsertCount - sameStationIndexInsertCount, 1);
  assert.equal(changedStationIndexDeleteCount - sameStationIndexDeleteCount, 1);
  assert.equal(stationIndexRows.length, 1);
  assert.equal(stationIndexRows[0]?.station, "CUCINA");
  assert.deepEqual(
    [
      "integration.orders.entries.stateRead",
      "integration.orders.entries.upsertChangedRows",
      "integration.orders.entries.total",
      "integration.orders.entries.ensure",
      "integration.orders.entries.getPool",
      "integration.orders.entries.getConnection",
      "integration.orders.entries.beginTransaction",
      "integration.orders.entries.commit",
      "integration.orders.entries.release",
      "integration.orders.index.collect",
      "integration.orders.index.stateRead",
      "integration.orders.index.compare",
      "integration.orders.index.total",
    ].every((label) =>
      metricsLog.some(
        (entry) =>
          entry.kind === "appStateDomainSplit" &&
          entry.label === label &&
          Number.isFinite(entry.durationMs),
      ),
    ),
    true,
  );
});

test("app-state MySQL domain split inserisce indice nuova comanda in batch senza delete vuoto", async () => {
  const queryLog = [];
  const storedRows = new Map();
  const stationIndexRows = [];
  const upsertStationIndexRow = (row) => {
    const existingIndex = stationIndexRows.findIndex(
      (entry) =>
        entry.domain === row.domain &&
        entry.field_name === row.field_name &&
        entry.station === row.station &&
        entry.match_kind === row.match_kind &&
        entry.order_record_id === row.order_record_id,
    );
    if (existingIndex >= 0) {
      stationIndexRows[existingIndex] = row;
    } else {
      stationIndexRows.push(row);
    }
  };
  const connection = {
    beginTransaction: async () => {
      queryLog.push({ sql: "BEGIN" });
    },
    commit: async () => {
      queryLog.push({ sql: "COMMIT" });
    },
    rollback: async () => {
      queryLog.push({ sql: "ROLLBACK" });
    },
    release: () => {
      queryLog.push({ sql: "RELEASE" });
    },
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT record_id, kind, app_state_position, row_hash/s.test(sql)) {
        const [domain] = params;
        return [
          [...storedRows.entries()]
            .filter(([key]) => key.startsWith(`${domain}:`))
            .map(([, row]) => ({ ...row })),
        ];
      }
      if (/SELECT station, match_kind, order_record_id, app_state_position/s.test(sql)) {
        const [domain, fieldName, ...recordIds] = params;
        return [
          stationIndexRows
            .filter(
              (row) =>
                row.domain === domain &&
                row.field_name === fieldName &&
                recordIds.includes(row.order_record_id),
            )
            .map((row) => ({ ...row })),
        ];
      }
      if (/INSERT INTO\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        for (let index = 0; index < params.length; index += 6) {
          const [domain, fieldName, station, matchKind, orderRecordId, appStatePosition] =
            params.slice(index, index + 6);
          upsertStationIndexRow({
            domain,
            field_name: fieldName,
            station,
            match_kind: matchKind,
            order_record_id: orderRecordId,
            app_state_position: appStatePosition,
          });
        }
        return [{ affectedRows: params.length / 6 }];
      }
      if (/INSERT INTO\s+`app_state_domain_records`/s.test(sql)) {
        const [domain, recordId, kind, appStatePosition, rowHash, rawJson] =
          params;
        storedRows.set(`${domain}:${recordId}`, {
          domain,
          record_id: recordId,
          kind,
          app_state_position: appStatePosition,
          row_hash: rowHash,
          raw_json: rawJson,
        });
        return [{ affectedRows: 1 }];
      }
      if (/DELETE FROM\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        const [domain, fieldName, ...deleteParams] = params;
        const tupleDelete = /\(station,\s*match_kind,\s*order_record_id\)\s+IN/s.test(sql);
        const deleteTuples = [];
        if (tupleDelete) {
          for (let offset = 0; offset < deleteParams.length; offset += 3) {
            deleteTuples.push({
              station: deleteParams[offset],
              match_kind: deleteParams[offset + 1],
              order_record_id: deleteParams[offset + 2],
            });
          }
        }
        for (let index = stationIndexRows.length - 1; index >= 0; index -= 1) {
          const row = stationIndexRows[index];
          if (row.domain !== domain || row.field_name !== fieldName) continue;
          if (tupleDelete) {
            if (
              !deleteTuples.some(
                (entry) =>
                  entry.station === row.station &&
                  entry.match_kind === row.match_kind &&
                  entry.order_record_id === row.order_record_id,
              )
            ) {
              continue;
            }
          } else if (deleteParams.length > 0 && !deleteParams.includes(row.order_record_id)) {
            continue;
          }
          stationIndexRows.splice(index, 1);
        }
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };
  const mysqlRepository = {
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT order_record_id\s+FROM\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        return [];
      }
      if (/SELECT domain, record_id, kind, app_state_position, row_hash, raw_json/s.test(sql)) {
        return [];
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
    domains: ["integration"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["orders"] },
    mysqlRepository,
    logger: { info() {}, warn() {} },
  });
  const state = {
    integration: {
      orders: [
        {
          id: "ord_new",
          items: [{ id: "a1", routeStations: ["bar", "cucina"] }],
          tickets: [{ stationId: "pasticceria" }],
          lineRoutes: [{ stationId: "pizza" }],
        },
      ],
    },
  };

  await split.syncObjectArrayEntriesFromAppState(
    state,
    "integration",
    "orders",
    ["ord_new"],
  );

  const indexInsertQueries = queryLog.filter((entry) =>
    /INSERT INTO\s+`app_state_domain_records_order_station_index`/s.test(entry.sql),
  );
  const indexDeleteQueries = queryLog.filter((entry) =>
    /DELETE FROM\s+`app_state_domain_records_order_station_index`/s.test(entry.sql),
  );

  assert.equal(indexInsertQueries.length, 1);
  assert.equal(indexDeleteQueries.length, 0);
  assert.deepEqual(
    stationIndexRows.map((row) => row.station).sort(),
    ["BAR", "CUCINA", "PASTICCERIA", "PIZZA"],
  );

  const deleteCountAfterCreate = indexDeleteQueries.length;
  const reducedState = cloneJson(state, state);
  reducedState.integration.orders[0] = {
    ...reducedState.integration.orders[0],
    items: [{ id: "a1", routeStations: ["bar", "cucina"] }],
    tickets: [],
    lineRoutes: [],
  };

  await split.syncObjectArrayEntriesFromAppState(
    reducedState,
    "integration",
    "orders",
    ["ord_new"],
  );

  const deleteQueriesAfterReduction = queryLog.filter((entry) =>
    /DELETE FROM\s+`app_state_domain_records_order_station_index`/s.test(entry.sql),
  );
  const reductionDeleteQuery = deleteQueriesAfterReduction.at(-1);
  assert.equal(deleteQueriesAfterReduction.length - deleteCountAfterCreate, 1);
  assert.match(
    reductionDeleteQuery.sql,
    /\(station,\s*match_kind,\s*order_record_id\)\s+IN/s,
  );
  assert.equal(reductionDeleteQuery.params.includes("BAR"), false);
  assert.equal(reductionDeleteQuery.params.includes("CUCINA"), false);
  assert.equal(reductionDeleteQuery.params.includes("PASTICCERIA"), true);
  assert.equal(reductionDeleteQuery.params.includes("PIZZA"), true);
  assert.deepEqual(
    stationIndexRows.map((row) => row.station).sort(),
    ["BAR", "CUCINA"],
  );
});

test("app-state MySQL domain split classifica ER_CHECKREAD come transient", async () => {
  const queryLog = [];
  const metricsLog = [];
  const checkread = Object.assign(new Error("Record has changed since last read in table 'app_state_domain_records'"), {
    code: "ER_CHECKREAD",
    errno: 1020,
    sqlState: "HY000",
  });
  const connection = {
    beginTransaction: async () => {
      queryLog.push({ sql: "BEGIN" });
    },
    commit: async () => {
      queryLog.push({ sql: "COMMIT" });
      throw checkread;
    },
    rollback: async () => {
      queryLog.push({ sql: "ROLLBACK" });
    },
    release: () => {
      queryLog.push({ sql: "RELEASE" });
    },
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT record_id, kind, app_state_position, row_hash/s.test(sql)) {
        return [[]];
      }
      if (/SELECT station, match_kind, order_record_id, app_state_position/s.test(sql)) {
        return [[]];
      }
      if (/INSERT INTO\s+`app_state_domain_records`/s.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      if (/DELETE FROM/s.test(sql)) {
        return [{ affectedRows: 0 }];
      }
      return [[]];
    },
  };
  const mysqlRepository = {
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      if (/SELECT order_record_id\s+FROM\s+`app_state_domain_records_order_station_index`/s.test(sql)) {
        return [];
      }
      if (/SELECT domain, record_id, kind, app_state_position, row_hash, raw_json/s.test(sql)) {
        return [];
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
    domains: ["integration"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["orders"] },
    mysqlRepository,
    runtimeMetrics: {
      recordOperation(kind, label, durationMs) {
        metricsLog.push({ kind, label, durationMs });
      },
    },
    logger: { info() {}, warn() {} },
  });
  const state = {
    integration: {
      orders: [
        { id: "ord_deadlock", station: "BAR", total: 10, items: [{ id: "a1" }] },
      ],
    },
  };

  await assert.rejects(
    () =>
      split.syncObjectArrayEntriesFromAppState(
        state,
        "integration",
        "orders",
        ["ord_deadlock"],
      ),
    /Record has changed/,
  );

  assert.equal(queryLog.some((entry) => entry.sql === "ROLLBACK"), true);
  for (const label of [
    "integration.orders.entries.error.transientDbError",
    "integration.orders.entries.errorStage.commit.transientDbError",
    "integration.orders.entries.rollback",
    "integration.orders.entries.rollback.cause.transientDbError",
    "integration.orders.entries.outcome.rolledBack",
    "integration.orders.entries.total",
    "integration.orders.entries.release",
  ]) {
    assert.equal(
      metricsLog.some(
        (entry) =>
          entry.kind === "appStateDomainSplit" &&
          entry.label === label &&
          Number.isFinite(entry.durationMs),
      ),
      true,
      `metrica mancante: ${label}`,
    );
  }
  assert.equal(
    metricsLog.some(
      (entry) =>
        entry.kind === "appStateDomainSplit" &&
        entry.label === "integration.orders.entries.outcome.committed",
    ),
    false,
  );
});

test("app-state split auditEvents shadow non modifica il JSON primario", async () => {
  const runDir = await createTempRunDir("app-state-split-audit-shadow");
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createAuditEventsSplitRepository({
    mode: "shadow",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T10:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.auditEvents = [
    {
      id: "evt_shadow_a",
      occurredAt: "2026-06-22T09:00:00.000Z",
      actorUserId: "u_admin",
      actorRole: "admin",
      action: "order.created",
      entityType: "order",
      entityId: "ord_shadow",
      payload: { total: 12 },
      before: null,
      after: { status: "waiting" },
    },
  ];

  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        beforeWrite: (appState) => split.syncFromAppState(appState),
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
      },
    }),
  );

  try {
    await repository.writeDb(state);
    const persisted = JSON.parse(await fs.readFile(dbPath, "utf-8"));
    const splitEvents = await split.listAuditEvents();

    assert.equal(persisted.auditEvents.length, 1);
    assert.equal(splitEvents.length, 1);
    assert.equal(splitEvents[0].id, "evt_shadow_a");
  } finally {
    repository.close();
    split.close();
  }
});

test("app-state split auditEvents externalized idrata letture e svuota il blocco JSON", async () => {
  const runDir = await createTempRunDir("app-state-split-audit-externalized");
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createAuditEventsSplitRepository({
    mode: "externalized",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T10:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.auditEvents = [
    {
      id: "evt_ext_a",
      occurredAt: "2026-06-22T09:00:00.000Z",
      actorUserId: "u_admin",
      actorRole: "admin",
      action: "payment.completed",
      entityType: "payment",
      entityId: "pay_ext",
      payload: { amount: 25 },
      before: { due: 25 },
      after: { due: 0 },
    },
    {
      id: "evt_ext_b",
      occurredAt: "2026-06-22T09:01:00.000Z",
      actorUserId: "u_admin",
      actorRole: "admin",
      action: "table.settled",
      entityType: "table",
      entityId: "t1",
      payload: {},
      before: null,
      after: null,
    },
  ];

  const writer = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        hydrateReadState: (appState) => split.hydrateAppState(appState),
        hydrateReadRequired: true,
        beforeWrite: (appState) => split.syncFromAppState(appState),
        beforeWriteRequired: true,
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
      },
    }),
  );

  try {
    await writer.writeDb(state);
    writer.close();

    const persistedContent = await fs.readFile(dbPath, "utf-8");
    const persisted = JSON.parse(persistedContent);
    assert.equal(persisted.auditEvents.length, 0);
    assert.equal(
      persisted.meta.appStateSplitDomains.auditEvents.mode,
      "externalized",
    );

    const auditOnlyState = cloneJson(state, state);
    auditOnlyState.auditEvents.push({
      id: "evt_ext_c",
      occurredAt: "2026-06-22T09:02:00.000Z",
      actorUserId: "u_admin",
      actorRole: "admin",
      action: "audit.only",
      entityType: "audit",
      entityId: "evt_ext_c",
      payload: {},
      before: null,
      after: null,
    });
    await writer.writeDb(auditOnlyState);
    assert.equal(await fs.readFile(dbPath, "utf-8"), persistedContent);
    assert.deepEqual(
      (await split.listAuditEvents()).map((event) => event.id),
      ["evt_ext_a", "evt_ext_b", "evt_ext_c"],
    );

    const reader = createAppStateRepository(
      createRepositoryOptions({
        mode: "json",
        dbPath,
        overrides: {
          hydrateReadState: (appState) => split.hydrateAppState(appState),
          hydrateReadRequired: true,
        },
      }),
    );
    const reread = await reader.readDb({ allowMigrations: false });
    reader.close();

    assert.deepEqual(
      reread.auditEvents.map((event) => event.id),
      ["evt_ext_a", "evt_ext_b", "evt_ext_c"],
    );
    assert.equal(reread.auditEvents[0].payload.amount, 25);
  } finally {
    split.close();
  }
});

test("app-state split auditEvents sincronizza solo eventi recenti senza cancellare lo storico", async () => {
  const runDir = await createTempRunDir("app-state-split-audit-recent");
  const split = createAuditEventsSplitRepository({
    mode: "externalized",
    dbPath: path.join(runDir, "app-state-split.sqlite"),
    nowIso: () => "2026-07-03T10:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.auditEvents = ["a", "b", "c"].map((id, index) => ({
    id: `evt_recent_${id}`,
    occurredAt: `2026-07-03T09:0${index}:00.000Z`,
    actorUserId: "u_admin",
    actorRole: "admin",
    action: `audit.${id}`,
    entityType: "audit",
    entityId: id,
    payload: {},
    before: null,
    after: null,
  }));

  try {
    await split.syncFromAppState({ ...state, auditEvents: state.auditEvents.slice(0, 1) });
    await split.syncRecentFromAppState(state, 2);
    assert.deepEqual(
      (await split.listAuditEvents()).map((event) => event.id),
      ["evt_recent_a", "evt_recent_b", "evt_recent_c"],
    );
  } finally {
    split.close();
  }
});

test("app-state split auditEvents sincronizza solo ID espliciti", async () => {
  const runDir = await createTempRunDir("app-state-split-audit-entries");
  const split = createAuditEventsSplitRepository({
    mode: "externalized",
    dbPath: path.join(runDir, "app-state-split.sqlite"),
    nowIso: () => "2026-07-03T10:05:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.auditEvents = ["a", "b", "c"].map((id, index) => ({
    id: `evt_entry_${id}`,
    occurredAt: `2026-07-03T09:1${index}:00.000Z`,
    actorUserId: "u_admin",
    actorRole: "admin",
    action: `audit.entry.${id}`,
    entityType: "audit",
    entityId: id,
    payload: {},
    before: null,
    after: null,
  }));

  try {
    await split.syncFromAppState({ ...state, auditEvents: state.auditEvents.slice(0, 1) });
    await split.syncEntriesFromAppState(state, ["evt_entry_c"]);
    assert.deepEqual(
      (await split.listAuditEvents()).map((event) => event.id),
      ["evt_entry_a", "evt_entry_c"],
    );
  } finally {
    split.close();
  }
});

test("app-state split printSpoolJobs shadow non modifica il JSON primario", async () => {
  const runDir = await createTempRunDir("app-state-split-print-spool-shadow");
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createPrintSpoolJobsSplitRepository({
    mode: "shadow",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T11:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.printSpoolJobs = [
    {
      id: "print_shadow_a",
      status: "queued",
      kind: "order",
      orderId: "ord_shadow",
      printerId: "printer_bar",
      printerName: "Bar",
      requestedAt: "2026-06-22T10:59:00.000Z",
      attempts: 0,
      textPreview: "COMANDA TEST",
    },
  ];

  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        beforeWrite: (appState) => split.syncFromAppState(appState),
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
      },
    }),
  );

  try {
    await repository.writeDb(state);
    const persisted = JSON.parse(await fs.readFile(dbPath, "utf-8"));
    const splitJobs = await split.listPrintSpoolJobs();

    assert.equal(persisted.printSpoolJobs.length, 1);
    assert.equal(splitJobs.length, 1);
    assert.equal(splitJobs[0].id, "print_shadow_a");
    assert.equal(splitJobs[0].textPreview, "COMANDA TEST");
  } finally {
    repository.close();
    split.close();
  }
});

test("app-state split printSpoolJobs externalized idrata letture e salta rewrite JSON su solo spool", async () => {
  const runDir = await createTempRunDir(
    "app-state-split-print-spool-externalized",
  );
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createPrintSpoolJobsSplitRepository({
    mode: "externalized",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T11:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.printSpoolJobs = [
    {
      id: "print_ext_a",
      status: "queued",
      kind: "preconto",
      orderId: "ord_ext",
      printerId: "printer_bar",
      requestedAt: "2026-06-22T10:59:00.000Z",
      attempts: 0,
      textPreview: "PRECONTO TEST",
    },
  ];
  let jsonWrites = 0;
  const jsonRepository = {
    ensureJsonStateFile: async ({ dbPath: targetPath, buildInitialState }) => {
      if (!existsSync(targetPath)) {
        await fs.writeFile(
          targetPath,
          JSON.stringify(buildInitialState(), null, 2),
        );
      }
    },
    readJsonStateFile: async (targetPath) =>
      JSON.parse(await fs.readFile(targetPath, "utf-8")),
    writeJsonStateFile: async (targetPath, tmpPath, appState) => {
      jsonWrites += 1;
      await fs.writeFile(tmpPath, JSON.stringify(appState, null, 2));
      await fs.rename(tmpPath, targetPath);
    },
  };

  const writer = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        jsonRepository,
        hydrateReadState: (appState) => split.hydrateAppState(appState),
        hydrateReadRequired: true,
        beforeWrite: (appState) => split.syncFromAppState(appState),
        beforeWriteRequired: true,
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
        prepareComparableState: (appState) =>
          split.prepareAppStateForPersistenceComparison(appState),
      },
    }),
  );

  try {
    await writer.writeDb(state);
    assert.equal(jsonWrites, 1);
    const persistedContent = await fs.readFile(dbPath, "utf-8");
    const persisted = JSON.parse(persistedContent);
    assert.equal(persisted.printSpoolJobs.length, 0);
    assert.equal(
      persisted.meta.appStateSplitDomains.printSpoolJobs.mode,
      "externalized",
    );

    const spoolOnlyState = cloneJson(state, state);
    spoolOnlyState.printSpoolJobs[0] = {
      ...spoolOnlyState.printSpoolJobs[0],
      status: "printed",
      processedAt: "2026-06-22T11:00:30.000Z",
      attempts: 1,
      lastAttemptAt: "2026-06-22T11:00:30.000Z",
    };
    await writer.writeDb(spoolOnlyState);
    assert.equal(jsonWrites, 1);
    assert.equal(await fs.readFile(dbPath, "utf-8"), persistedContent);

    const splitJobs = await split.listPrintSpoolJobs();
    assert.equal(splitJobs.length, 1);
    assert.equal(splitJobs[0].status, "printed");
    assert.equal(splitJobs[0].attempts, 1);

    const reader = createAppStateRepository(
      createRepositoryOptions({
        mode: "json",
        dbPath,
        overrides: {
          jsonRepository,
          hydrateReadState: (appState) => split.hydrateAppState(appState),
          hydrateReadRequired: true,
        },
      }),
    );
    const reread = await reader.readDb({ allowMigrations: false });
    reader.close();

    assert.equal(reread.printSpoolJobs.length, 1);
    assert.equal(reread.printSpoolJobs[0].id, "print_ext_a");
    assert.equal(reread.printSpoolJobs[0].status, "printed");
  } finally {
    writer.close();
    split.close();
  }
});

test("app-state split deviceStatus shadow non modifica il JSON primario", async () => {
  const runDir = await createTempRunDir("app-state-split-device-status-shadow");
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createDeviceStatusSplitRepository({
    mode: "shadow",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T12:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.sessions = [
    {
      id: "sess_shadow_a",
      userId: "u_cashier",
      username: "cashier",
      tokenHash: "hash-shadow",
      deviceUuid: "device-shadow",
      clientApp: "mobile-frontend",
      createdAt: "2026-06-22T11:55:00.000Z",
      lastSeenAt: "2026-06-22T11:59:00.000Z",
      expiresAt: "2026-06-22T23:59:00.000Z",
    },
  ];
  state.integration.stationStates = [
    {
      station: "BAR-1",
      active: true,
      realStation: true,
      clientApp: "postazione",
      deviceUuid: "station-device-shadow",
      operatorUserId: "u_cashier",
      operatorUsername: "cashier",
      updatedAtMs: 1813665600000,
    },
  ];

  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        beforeWrite: (appState) => split.syncFromAppState(appState),
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
      },
    }),
  );

  try {
    await repository.writeDb(state);
    const persisted = JSON.parse(await fs.readFile(dbPath, "utf-8"));
    const splitSessions = await split.listSessions();
    const splitStationStates = await split.listStationStates();

    assert.equal(persisted.sessions.length, 1);
    assert.equal(persisted.integration.stationStates.length, 1);
    assert.equal(splitSessions.length, 1);
    assert.equal(splitSessions[0].id, "sess_shadow_a");
    assert.equal(splitStationStates.length, 1);
    assert.equal(splitStationStates[0].station, "BAR-1");
  } finally {
    repository.close();
    split.close();
  }
});

test("app-state split deviceStatus externalized idrata letture e salta rewrite JSON su soli heartbeat", async () => {
  const runDir = await createTempRunDir(
    "app-state-split-device-status-externalized",
  );
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createDeviceStatusSplitRepository({
    mode: "externalized",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T12:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.sessions = [
    {
      id: "sess_ext_a",
      userId: "u_cashier",
      username: "cashier",
      tokenHash: "hash-ext",
      deviceUuid: "device-ext",
      clientApp: "mobile-frontend",
      roomId: "room_sala",
      roomName: "Sala",
      createdAt: "2026-06-22T11:55:00.000Z",
      lastSeenAt: "2026-06-22T11:59:00.000Z",
      expiresAt: "2026-06-22T23:59:00.000Z",
    },
  ];
  state.integration.stationStates = [
    {
      station: "BAR-1",
      active: true,
      realStation: true,
      stale: false,
      clientApp: "postazione",
      deviceUuid: "station-device-ext",
      operatorUserId: "u_cashier",
      operatorUsername: "cashier",
      operatorName: "Cashier",
      autoPrintOrders: true,
      updatedAtMs: 1813665600000,
    },
  ];
  let jsonWrites = 0;
  const jsonRepository = {
    ensureJsonStateFile: async ({ dbPath: targetPath, buildInitialState }) => {
      if (!existsSync(targetPath)) {
        await fs.writeFile(
          targetPath,
          JSON.stringify(buildInitialState(), null, 2),
        );
      }
    },
    readJsonStateFile: async (targetPath) =>
      JSON.parse(await fs.readFile(targetPath, "utf-8")),
    writeJsonStateFile: async (targetPath, tmpPath, appState) => {
      jsonWrites += 1;
      await fs.writeFile(tmpPath, JSON.stringify(appState, null, 2));
      await fs.rename(tmpPath, targetPath);
    },
  };

  const writer = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        jsonRepository,
        hydrateReadState: (appState) => split.hydrateAppState(appState),
        hydrateReadRequired: true,
        beforeWrite: (appState) => split.syncFromAppState(appState),
        beforeWriteRequired: true,
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
        prepareComparableState: (appState) =>
          split.prepareAppStateForPersistenceComparison(appState),
      },
    }),
  );

  try {
    await writer.writeDb(state);
    assert.equal(jsonWrites, 1);
    const persistedContent = await fs.readFile(dbPath, "utf-8");
    const persisted = JSON.parse(persistedContent);
    assert.equal(persisted.sessions.length, 0);
    assert.equal(persisted.integration.stationStates.length, 0);
    assert.equal(
      persisted.meta.appStateSplitDomains.deviceStatus.mode,
      "externalized",
    );

    const heartbeatOnlyState = cloneJson(state, state);
    heartbeatOnlyState.sessions[0] = {
      ...heartbeatOnlyState.sessions[0],
      lastSeenAt: "2026-06-22T12:00:30.000Z",
    };
    heartbeatOnlyState.integration.stationStates[0] = {
      ...heartbeatOnlyState.integration.stationStates[0],
      updatedAtMs: 1813665630000,
    };
    heartbeatOnlyState.meta.lastWriteAt = "2026-06-22T12:00:30.000Z";
    heartbeatOnlyState.integration.lastWriteAt = "2026-06-22T12:00:30.000Z";
    await writer.writeDb(heartbeatOnlyState);
    assert.equal(jsonWrites, 1);
    assert.equal(await fs.readFile(dbPath, "utf-8"), persistedContent);

    const splitSessions = await split.listSessions();
    const splitStationStates = await split.listStationStates();
    assert.equal(splitSessions.length, 1);
    assert.equal(splitSessions[0].lastSeenAt, "2026-06-22T12:00:30.000Z");
    assert.equal(splitStationStates.length, 1);
    assert.equal(splitStationStates[0].updatedAtMs, 1813665630000);

    const reader = createAppStateRepository(
      createRepositoryOptions({
        mode: "json",
        dbPath,
        overrides: {
          jsonRepository,
          hydrateReadState: (appState) => split.hydrateAppState(appState),
          hydrateReadRequired: true,
        },
      }),
    );
    const reread = await reader.readDb({ allowMigrations: false });
    reader.close();

    assert.equal(reread.sessions.length, 1);
    assert.equal(reread.sessions[0].id, "sess_ext_a");
    assert.equal(reread.sessions[0].lastSeenAt, "2026-06-22T12:00:30.000Z");
    assert.equal(reread.integration.stationStates.length, 1);
    assert.equal(reread.integration.stationStates[0].station, "BAR-1");
  } finally {
    writer.close();
    split.close();
  }
});

test("app-state split deviceStatus upsert puntuale aggiorna una postazione senza cancellare le altre", async () => {
  const runDir = await createTempRunDir("app-state-split-device-status-upsert");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createDeviceStatusSplitRepository({
    mode: "externalized",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T12:10:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.sessions = [];
  state.integration.stationStates = [
    {
      station: "BAR-1",
      active: true,
      realStation: true,
      stale: false,
      clientApp: "postazione",
      deviceUuid: "station-device-bar",
      operatorUserId: "u_cashier",
      operatorUsername: "cashier",
      updatedAtMs: 1813665600000,
    },
    {
      station: "CUCINA",
      active: true,
      realStation: true,
      stale: false,
      clientApp: "postazione",
      deviceUuid: "station-device-kitchen",
      operatorUserId: "u_manager",
      operatorUsername: "manager",
      updatedAtMs: 1813665600000,
    },
  ];

  try {
    await split.syncFromAppState(state);
    await split.upsertStationState({
      ...state.integration.stationStates[0],
      updatedAtMs: 1813665660000,
      autoPrintOrders: true,
    });

    const stationStates = await split.listStationStates();
    assert.equal(stationStates.length, 2);
    const bar = stationStates.find((entry) => entry.station === "BAR-1");
    const kitchen = stationStates.find((entry) => entry.station === "CUCINA");
    assert.equal(bar.updatedAtMs, 1813665660000);
    assert.equal(bar.autoPrintOrders, true);
    assert.equal(kitchen.deviceUuid, "station-device-kitchen");
  } finally {
    split.close();
  }
});

test("app-state split tableLocks shadow non modifica il JSON primario", async () => {
  const runDir = await createTempRunDir("app-state-split-table-locks-shadow");
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createTableLocksSplitRepository({
    mode: "shadow",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T13:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.posSettings.tables[0].workLock = {
    tableId: state.posSettings.tables[0].id,
    userId: "u_waiter",
    username: "waiter",
    deviceUuid: "device-lock-shadow",
    sessionId: "sess_lock_shadow",
    purpose: "table_mutation",
    acquiredAt: "2026-06-22T12:59:00.000Z",
    heartbeatAt: "2026-06-22T12:59:00.000Z",
    expiresAt: "2026-06-22T13:01:00.000Z",
  };
  state.tableLocks = [
    {
      id: "legacy_lock_shadow",
      tableId: state.posSettings.tables[0].id,
      userId: "u_waiter",
      acquiredAt: "2026-06-22T12:59:00.000Z",
    },
  ];

  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        beforeWrite: (appState) => split.syncFromAppState(appState),
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
      },
    }),
  );

  try {
    await repository.writeDb(state);
    const persisted = JSON.parse(await fs.readFile(dbPath, "utf-8"));
    const splitWorkLocks = await split.listTableWorkLocks();
    const splitLegacyLocks = await split.listLegacyTableLocks();

    assert.equal(persisted.posSettings.tables[0].workLock.userId, "u_waiter");
    assert.equal(persisted.tableLocks.length, 1);
    assert.equal(splitWorkLocks.length, 1);
    assert.equal(splitWorkLocks[0].tableId, state.posSettings.tables[0].id);
    assert.equal(splitWorkLocks[0].lock.userId, "u_waiter");
    assert.equal(splitLegacyLocks.length, 1);
    assert.equal(splitLegacyLocks[0].id, "legacy_lock_shadow");
  } finally {
    repository.close();
    split.close();
  }
});

test("app-state split tableLocks externalized idrata letture e salta rewrite JSON su soli lock", async () => {
  const runDir = await createTempRunDir(
    "app-state-split-table-locks-externalized",
  );
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createTableLocksSplitRepository({
    mode: "externalized",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T13:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  const tableId = state.posSettings.tables[0].id;
  state.posSettings.tables[0].workLock = {
    tableId,
    userId: "u_waiter",
    username: "waiter",
    deviceUuid: "device-lock-ext",
    sessionId: "sess_lock_ext",
    purpose: "table_mutation",
    acquiredAt: "2026-06-22T12:59:00.000Z",
    heartbeatAt: "2026-06-22T12:59:00.000Z",
    expiresAt: "2026-06-22T13:01:00.000Z",
  };
  state.tableLocks = [
    {
      id: "legacy_lock_ext",
      tableId,
      userId: "u_waiter",
      acquiredAt: "2026-06-22T12:59:00.000Z",
    },
  ];
  let jsonWrites = 0;
  const jsonRepository = {
    ensureJsonStateFile: async ({ dbPath: targetPath, buildInitialState }) => {
      if (!existsSync(targetPath)) {
        await fs.writeFile(
          targetPath,
          JSON.stringify(buildInitialState(), null, 2),
        );
      }
    },
    readJsonStateFile: async (targetPath) =>
      JSON.parse(await fs.readFile(targetPath, "utf-8")),
    writeJsonStateFile: async (targetPath, tmpPath, appState) => {
      jsonWrites += 1;
      await fs.writeFile(tmpPath, JSON.stringify(appState, null, 2));
      await fs.rename(tmpPath, targetPath);
    },
  };

  const writer = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        jsonRepository,
        hydrateReadState: (appState) => split.hydrateAppState(appState),
        hydrateReadRequired: true,
        beforeWrite: (appState) => split.syncFromAppState(appState),
        beforeWriteRequired: true,
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
        prepareComparableState: (appState) =>
          split.prepareAppStateForPersistenceComparison(appState),
      },
    }),
  );

  try {
    await writer.writeDb(state);
    assert.equal(jsonWrites, 1);
    const persistedContent = await fs.readFile(dbPath, "utf-8");
    const persisted = JSON.parse(persistedContent);
    assert.equal(persisted.posSettings.tables[0].workLock, null);
    assert.equal(persisted.tableLocks.length, 0);
    assert.equal(
      persisted.meta.appStateSplitDomains.tableLocks.mode,
      "externalized",
    );

    const lockOnlyState = cloneJson(state, state);
    lockOnlyState.posSettings.tables[0].workLock = {
      ...lockOnlyState.posSettings.tables[0].workLock,
      heartbeatAt: "2026-06-22T13:00:30.000Z",
      expiresAt: "2026-06-22T13:02:30.000Z",
    };
    lockOnlyState.tableLocks[0] = {
      ...lockOnlyState.tableLocks[0],
      heartbeatAt: "2026-06-22T13:00:30.000Z",
    };
    lockOnlyState.meta.lastWriteAt = "2026-06-22T13:00:30.000Z";
    lockOnlyState.integration.lastWriteAt = "2026-06-22T13:00:30.000Z";
    await writer.writeDb(lockOnlyState);
    assert.equal(jsonWrites, 1);
    assert.equal(await fs.readFile(dbPath, "utf-8"), persistedContent);

    const splitWorkLocks = await split.listTableWorkLocks();
    const splitLegacyLocks = await split.listLegacyTableLocks();
    assert.equal(splitWorkLocks.length, 1);
    assert.equal(
      splitWorkLocks[0].lock.heartbeatAt,
      "2026-06-22T13:00:30.000Z",
    );
    assert.equal(splitLegacyLocks.length, 1);
    assert.equal(splitLegacyLocks[0].heartbeatAt, "2026-06-22T13:00:30.000Z");

    const reader = createAppStateRepository(
      createRepositoryOptions({
        mode: "json",
        dbPath,
        overrides: {
          jsonRepository,
          hydrateReadState: (appState) => split.hydrateAppState(appState),
          hydrateReadRequired: true,
        },
      }),
    );
    const reread = await reader.readDb({ allowMigrations: false });
    reader.close();

    assert.equal(reread.posSettings.tables[0].workLock.userId, "u_waiter");
    assert.equal(
      reread.posSettings.tables[0].workLock.heartbeatAt,
      "2026-06-22T13:00:30.000Z",
    );
    assert.equal(reread.tableLocks.length, 1);
    assert.equal(reread.tableLocks[0].id, "legacy_lock_ext");
  } finally {
    writer.close();
    split.close();
  }
});

test("app-state split tableStates shadow non modifica il JSON primario", async () => {
  const runDir = await createTempRunDir("app-state-split-table-states-shadow");
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createTableStateSplitRepository({
    mode: "shadow",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T14:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.posSettings.tables[0] = {
    ...state.posSettings.tables[0],
    status: "payment_due",
    guestName: "Tavolo Test",
    covers: 4,
    totalDue: 42.5,
    amountDue: 42.5,
    dueAmount: 42.5,
    customerPhone: "3331234567",
    note: "Compleanno",
    allergens: ["glutine"],
    manualIntolerance: "no arachidi",
    seatedAt: 1813672800000,
    pendingBills: [
      {
        id: "bill_shadow_a",
        orderId: "ord_shadow_a",
        orderIds: ["ord_shadow_a"],
        createdAt: "2026-06-22T13:55:00.000Z",
        subtotal: 42.5,
        lines: [{ name: "Test", qty: 1, unitPrice: 42.5, lineTotal: 42.5 }],
      },
    ],
  };

  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        beforeWrite: (appState) => split.syncFromAppState(appState),
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
      },
    }),
  );

  try {
    await repository.writeDb(state);
    const persisted = JSON.parse(await fs.readFile(dbPath, "utf-8"));
    const splitTables = await split.listTableStates();

    assert.equal(persisted.posSettings.tables[0].status, "payment_due");
    assert.equal(persisted.posSettings.tables[0].pendingBills.length, 1);
    assert.equal(splitTables.length, state.posSettings.tables.length);
    assert.equal(splitTables[0].tableId, state.posSettings.tables[0].id);
    assert.equal(splitTables[0].state.status, "payment_due");
    assert.equal(splitTables[0].state.pendingBills[0].id, "bill_shadow_a");
  } finally {
    repository.close();
    split.close();
  }
});

test("app-state split tableStates externalized idrata letture e salta rewrite JSON su soli tavoli/conto", async () => {
  const runDir = await createTempRunDir(
    "app-state-split-table-states-externalized",
  );
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createTableStateSplitRepository({
    mode: "externalized",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T14:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  const tableId = state.posSettings.tables[0].id;
  state.posSettings.tables[0] = {
    ...state.posSettings.tables[0],
    status: "payment_due",
    guestName: "Tavolo Esterno",
    covers: 2,
    totalDue: 18,
    amountDue: 18,
    dueAmount: 18,
    reservation: null,
    customerPhone: "3331234567",
    note: "note tavolo",
    allergens: ["latte"],
    manualIntolerance: "senza lattosio",
    seatedAt: 1813672800000,
    pendingBills: [
      {
        id: "bill_ext_a",
        orderId: "ord_ext_a",
        orderIds: ["ord_ext_a"],
        createdAt: "2026-06-22T13:55:00.000Z",
        subtotal: 18,
        lines: [{ name: "Bibita", qty: 2, unitPrice: 9, lineTotal: 18 }],
      },
    ],
  };
  let jsonWrites = 0;
  const jsonRepository = {
    ensureJsonStateFile: async ({ dbPath: targetPath, buildInitialState }) => {
      if (!existsSync(targetPath)) {
        await fs.writeFile(
          targetPath,
          JSON.stringify(buildInitialState(), null, 2),
        );
      }
    },
    readJsonStateFile: async (targetPath) =>
      JSON.parse(await fs.readFile(targetPath, "utf-8")),
    writeJsonStateFile: async (targetPath, tmpPath, appState) => {
      jsonWrites += 1;
      await fs.writeFile(tmpPath, JSON.stringify(appState, null, 2));
      await fs.rename(tmpPath, targetPath);
    },
  };

  const writer = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        jsonRepository,
        hydrateReadState: (appState) => split.hydrateAppState(appState),
        hydrateReadRequired: true,
        beforeWrite: (appState) => split.syncFromAppState(appState),
        beforeWriteRequired: true,
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
        prepareComparableState: (appState) =>
          split.prepareAppStateForPersistenceComparison(appState),
      },
    }),
  );

  try {
    await writer.writeDb(state);
    assert.equal(jsonWrites, 1);
    const persistedContent = await fs.readFile(dbPath, "utf-8");
    const persisted = JSON.parse(persistedContent);
    assert.equal(persisted.posSettings.tables[0].status, undefined);
    assert.equal(persisted.posSettings.tables[0].totalDue, undefined);
    assert.equal(persisted.posSettings.tables[0].pendingBills, undefined);
    assert.equal(persisted.posSettings.tables[0].amountDue, undefined);
    assert.equal(
      persisted.meta.appStateSplitDomains.tableStates.mode,
      "externalized",
    );

    const tableOnlyState = cloneJson(state, state);
    tableOnlyState.posSettings.tables[0] = {
      ...tableOnlyState.posSettings.tables[0],
      status: "no_orders",
      covers: 3,
      totalDue: 0,
      amountDue: 0,
      dueAmount: 0,
      pendingBills: [],
      note: "note aggiornata",
    };
    tableOnlyState.meta.lastWriteAt = "2026-06-22T14:00:30.000Z";
    tableOnlyState.integration.lastWriteAt = "2026-06-22T14:00:30.000Z";
    await writer.writeDb(tableOnlyState);
    assert.equal(jsonWrites, 1);
    assert.equal(await fs.readFile(dbPath, "utf-8"), persistedContent);

    const splitTables = await split.listTableStates();
    const splitTable = splitTables.find((entry) => entry.tableId === tableId);
    assert.equal(splitTable.state.status, "no_orders");
    assert.equal(splitTable.state.covers, 3);
    assert.equal(splitTable.state.note, "note aggiornata");
    assert.equal(splitTable.state.pendingBills.length, 0);

    const reader = createAppStateRepository(
      createRepositoryOptions({
        mode: "json",
        dbPath,
        overrides: {
          jsonRepository,
          hydrateReadState: (appState) => split.hydrateAppState(appState),
          hydrateReadRequired: true,
        },
      }),
    );
    const reread = await reader.readDb({ allowMigrations: false });
    reader.close();

    assert.equal(reread.posSettings.tables[0].id, tableId);
    assert.equal(reread.posSettings.tables[0].status, "no_orders");
    assert.equal(reread.posSettings.tables[0].covers, 3);
    assert.equal(reread.posSettings.tables[0].note, "note aggiornata");
  } finally {
    writer.close();
    split.close();
  }
});

test("app-state split tableStates aggiorna una sola riga senza cancellare le altre", async () => {
  const runDir = await createTempRunDir("app-state-split-table-states-entries");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createTableStateSplitRepository({
    mode: "externalized",
    dbPath: splitDbPath,
    nowIso: () => "2026-07-13T12:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.posSettings.tables = [
    { id: "table-target", roomId: "room-1", status: "free", covers: 0 },
    { id: "table-other", roomId: "room-1", status: "reserved", covers: 4 },
  ];

  try {
    await split.syncFromAppState(state);
    const changed = cloneJson(state, state);
    changed.meta.lastWriteAt = "2026-07-13T12:00:01.000Z";
    changed.posSettings.tables[0] = {
      ...changed.posSettings.tables[0],
      status: "no_orders",
      covers: 2,
      note: "aggiornato",
    };

    const targeted = await split.syncEntriesFromAppState(changed, ["table-target"]);
    const rows = await split.listTableStates();
    const target = rows.find((entry) => entry.tableId === "table-target");
    const other = rows.find((entry) => entry.tableId === "table-other");

    assert.equal(targeted.selectedCount, 1);
    assert.equal(targeted.rowCount, 2);
    assert.equal(targeted.upserted, 1);
    assert.equal(targeted.deleted, 0);
    assert.deepEqual(targeted.missingIds, []);
    assert.equal(target.state.status, "no_orders");
    assert.equal(target.state.note, "aggiornato");
    assert.equal(other.state.status, "reserved");
    assert.equal(other.state.covers, 4);

    const full = await split.syncFromAppState(changed);
    assert.equal(full.checksum, targeted.checksum);
    assert.equal(full.upserted, 0);
    assert.equal(full.deleted, 0);
    assert.equal(full.metadataUpdated, false);
  } finally {
    split.close();
  }
});

test("app-state split orders shadow non modifica il JSON primario", async () => {
  const runDir = await createTempRunDir("app-state-split-orders-shadow");
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createOrdersSplitRepository({
    mode: "shadow",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T15:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.integration.orders = [
    {
      id: "ord_shadow_a",
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      tableNumber: 5,
      tableLabel: "Pedana 5",
      waiter: "waiter",
      workflowStatus: "waiting",
      paymentStatus: "unpaid",
      total: 24,
      paidAmount: 0,
      dueAmount: 24,
      revision: 1,
      currentRevision: 1,
      receivedAtMs: 1813676400000,
      items: [
        {
          id: "line_shadow_a",
          lineId: "line_shadow_a",
          productId: "prod_shadow",
          name: "Piatto test",
          qty: 2,
          unitPriceApplied: 12,
          lineTotal: 24,
        },
      ],
      tickets: [
        { id: "tkt_shadow_a", orderId: "ord_shadow_a", ticketStatus: "SENT" },
      ],
      lineRoutes: [],
      createdAt: "2026-06-22T14:55:00.000Z",
      updatedAt: "2026-06-22T14:55:00.000Z",
    },
  ];

  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        beforeWrite: (appState) => split.syncFromAppState(appState),
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
      },
    }),
  );

  try {
    await repository.writeDb(state);
    const persisted = JSON.parse(await fs.readFile(dbPath, "utf-8"));
    const splitOrders = await split.listIntegrationOrders();

    assert.equal(persisted.integration.orders.length, 1);
    assert.equal(splitOrders.length, 1);
    assert.equal(splitOrders[0].id, "ord_shadow_a");
    assert.equal(splitOrders[0].items[0].name, "Piatto test");
  } finally {
    repository.close();
    split.close();
  }
});

test("app-state split orders externalized idrata letture e salta rewrite JSON su sole comande", async () => {
  const runDir = await createTempRunDir("app-state-split-orders-externalized");
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createOrdersSplitRepository({
    mode: "externalized",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T15:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.integration.orders = [
    {
      id: "ord_ext_a",
      tableId: "room_pedana_t06",
      roomId: "room_pedana",
      tableNumber: 6,
      tableLabel: "Pedana 6",
      waiter: "waiter",
      station: "BAR-1",
      workflowStatus: "waiting",
      paymentStatus: "unpaid",
      total: 18,
      paidAmount: 0,
      dueAmount: 18,
      revision: 1,
      currentRevision: 1,
      receivedAtMs: 1813676400000,
      items: [
        {
          id: "line_ext_a",
          lineId: "line_ext_a",
          productId: "prod_ext",
          name: "Bibita test",
          qty: 2,
          doneQty: 0,
          unitPriceApplied: 9,
          lineTotal: 18,
          done: false,
        },
      ],
      tickets: [
        { id: "tkt_ext_a", orderId: "ord_ext_a", ticketStatus: "SENT" },
      ],
      lineRoutes: [
        {
          id: "route_ext_a",
          orderId: "ord_ext_a",
          lineId: "line_ext_a",
          stationId: "BAR-1",
          status: "waiting",
        },
      ],
      createdAt: "2026-06-22T14:55:00.000Z",
      updatedAt: "2026-06-22T14:55:00.000Z",
    },
  ];
  let jsonWrites = 0;
  const jsonRepository = {
    ensureJsonStateFile: async ({ dbPath: targetPath, buildInitialState }) => {
      if (!existsSync(targetPath)) {
        await fs.writeFile(
          targetPath,
          JSON.stringify(buildInitialState(), null, 2),
        );
      }
    },
    readJsonStateFile: async (targetPath) =>
      JSON.parse(await fs.readFile(targetPath, "utf-8")),
    writeJsonStateFile: async (targetPath, tmpPath, appState) => {
      jsonWrites += 1;
      await fs.writeFile(tmpPath, JSON.stringify(appState, null, 2));
      await fs.rename(tmpPath, targetPath);
    },
  };

  const writer = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        jsonRepository,
        hydrateReadState: (appState) => split.hydrateAppState(appState),
        hydrateReadRequired: true,
        beforeWrite: (appState) => split.syncFromAppState(appState),
        beforeWriteRequired: true,
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
        prepareComparableState: (appState) =>
          split.prepareAppStateForPersistenceComparison(appState),
      },
    }),
  );

  try {
    await writer.writeDb(state);
    assert.equal(jsonWrites, 1);
    const persistedContent = await fs.readFile(dbPath, "utf-8");
    const persisted = JSON.parse(persistedContent);
    assert.equal(persisted.integration.orders.length, 0);
    assert.equal(
      persisted.meta.appStateSplitDomains.orders.mode,
      "externalized",
    );

    const orderOnlyState = cloneJson(state, state);
    orderOnlyState.integration.orders[0] = {
      ...orderOnlyState.integration.orders[0],
      workflowStatus: "ready",
      readyAtMs: 1813676430000,
      updatedAt: "2026-06-22T15:00:30.000Z",
      items: [
        {
          ...orderOnlyState.integration.orders[0].items[0],
          doneQty: 2,
          done: true,
        },
      ],
      lineRoutes: [
        {
          ...orderOnlyState.integration.orders[0].lineRoutes[0],
          status: "ready",
          readyAt: "2026-06-22T15:00:30.000Z",
        },
      ],
    };
    orderOnlyState.meta.lastWriteAt = "2026-06-22T15:00:30.000Z";
    orderOnlyState.integration.lastWriteAt = "2026-06-22T15:00:30.000Z";
    await writer.writeDb(orderOnlyState);
    assert.equal(jsonWrites, 1);
    assert.equal(await fs.readFile(dbPath, "utf-8"), persistedContent);

    const splitOrders = await split.listIntegrationOrders();
    assert.equal(splitOrders.length, 1);
    assert.equal(splitOrders[0].id, "ord_ext_a");
    assert.equal(splitOrders[0].workflowStatus, "ready");
    assert.equal(splitOrders[0].items[0].done, true);
    assert.equal(splitOrders[0].lineRoutes[0].status, "ready");

    const reader = createAppStateRepository(
      createRepositoryOptions({
        mode: "json",
        dbPath,
        overrides: {
          jsonRepository,
          hydrateReadState: (appState) => split.hydrateAppState(appState),
          hydrateReadRequired: true,
        },
      }),
    );
    const reread = await reader.readDb({ allowMigrations: false });
    reader.close();

    assert.equal(reread.integration.orders.length, 1);
    assert.equal(reread.integration.orders[0].id, "ord_ext_a");
    assert.equal(reread.integration.orders[0].workflowStatus, "ready");
    assert.equal(reread.integration.orders[0].items[0].doneQty, 2);
  } finally {
    writer.close();
    split.close();
  }
});

test("app-state split orders upsert puntuale aggiorna una comanda senza cancellare le altre", async () => {
  const runDir = await createTempRunDir("app-state-split-orders-upsert");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createOrdersSplitRepository({
    mode: "externalized",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T15:30:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.integration.orders = [
    {
      id: "ord_upsert_a",
      tableId: "room_pedana_t07",
      roomId: "room_pedana",
      tableLabel: "Pedana 7",
      workflowStatus: "waiting",
      paymentStatus: "unpaid",
      total: 10,
      dueAmount: 10,
      items: [{ id: "line_a", name: "Acqua", qty: 1, done: false }],
      lineRoutes: [{ id: "route_a", status: "waiting" }],
      updatedAt: "2026-06-22T15:00:00.000Z",
    },
    {
      id: "ord_upsert_b",
      tableId: "room_pedana_t08",
      roomId: "room_pedana",
      tableLabel: "Pedana 8",
      workflowStatus: "waiting",
      paymentStatus: "unpaid",
      total: 12,
      dueAmount: 12,
      items: [{ id: "line_b", name: "Bibita", qty: 1, done: false }],
      lineRoutes: [{ id: "route_b", status: "waiting" }],
      updatedAt: "2026-06-22T15:00:00.000Z",
    },
  ];

  try {
    await split.syncFromAppState(state);
    const updated = cloneJson(state, state);
    updated.integration.orders[1] = {
      ...updated.integration.orders[1],
      workflowStatus: "ready",
      readyAtMs: 1813678200000,
      items: [{ id: "line_b", name: "Bibita", qty: 1, done: true }],
      lineRoutes: [{ id: "route_b", status: "ready" }],
      updatedAt: "2026-06-22T15:30:00.000Z",
    };

    const result = await split.upsertIntegrationOrdersFromAppState(updated, [
      "ord_upsert_b",
    ]);
    assert.equal(result.rowCount, 2);
    assert.equal(result.orderCount, 1);

    const orders = await split.listIntegrationOrders();
    assert.equal(orders.length, 2);
    assert.equal(
      orders.find((order) => order.id === "ord_upsert_a").workflowStatus,
      "waiting",
    );
    assert.equal(
      orders.find((order) => order.id === "ord_upsert_b").workflowStatus,
      "ready",
    );
    assert.equal(
      orders.find((order) => order.id === "ord_upsert_b").items[0].done,
      true,
    );
  } finally {
    split.close();
  }
});

test("app-state split paymentsFiscal shadow non modifica il JSON primario", async () => {
  const runDir = await createTempRunDir(
    "app-state-split-payments-fiscal-shadow",
  );
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createPaymentsFiscalSplitRepository({
    mode: "shadow",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T16:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.paymentContainers = [
    {
      id: "payc_shadow_a",
      tableId: "room_pedana_t07",
      roomId: "room_pedana",
      orderIds: ["ord_shadow_pay_a"],
      amount: 32,
      status: "COMPLETED",
      splitType: "SINGLE",
      createdAt: "2026-06-22T15:55:00.000Z",
    },
  ];
  state.paymentParts = [
    {
      id: "part_shadow_a",
      paymentId: "payc_shadow_a",
      partNo: 1,
      amountDue: 32,
      status: "PAID",
    },
  ];
  state.paymentTransactions = [
    {
      id: "tx_shadow_a",
      partId: "part_shadow_a",
      method: "CASH",
      amountPaid: 32,
      cashGiven: 40,
      changeGiven: 8,
      createdAt: "2026-06-22T15:55:00.000Z",
    },
  ];
  state.paymentProviderTransactions = [
    {
      transactionId: "ptx_shadow_a",
      clientPaymentId: "client_shadow_a",
      idempotencyKey: "idem_shadow_a",
      status: "settled",
      amount: 32,
      currency: "EUR",
      paymentMethodId: "pay_cash",
      providerType: "cash",
      createdAt: "2026-06-22T15:55:00.000Z",
      updatedAt: "2026-06-22T15:55:01.000Z",
    },
  ];
  state.payments = [
    {
      id: "pay_shadow_a",
      tableId: "room_pedana_t07",
      roomId: "room_pedana",
      orderIds: ["ord_shadow_pay_a"],
      amount: 32,
      methodId: "pay_cash",
      methodLabel: "Contanti",
      paymentContainerId: "payc_shadow_a",
      paymentPartId: "part_shadow_a",
      paymentTxId: "tx_shadow_a",
      createdAt: "2026-06-22T15:55:00.000Z",
    },
  ];
  state.fiscalReceipts = [
    {
      id: "fiscal_shadow_a",
      paymentId: "tx_shadow_a",
      command: "cash_receipt",
      status: "ISSUED",
      fiscalStatus: "ISSUED",
      createdAt: "2026-06-22T15:55:01.000Z",
    },
  ];
  state.fiscalEvents = [
    {
      id: "fiscal_evt_shadow_a",
      command: "cash_receipt",
      createdAt: "2026-06-22T15:55:01.000Z",
      result: "ok",
      message: "Documento fiscale emesso.",
    },
  ];

  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        beforeWrite: (appState) => split.syncFromAppState(appState),
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
      },
    }),
  );

  try {
    await repository.writeDb(state);
    const persisted = JSON.parse(await fs.readFile(dbPath, "utf-8"));
    const splitCollections = await split.listPaymentsFiscalCollections();

    assert.equal(persisted.paymentContainers.length, 1);
    assert.equal(persisted.paymentTransactions.length, 1);
    assert.equal(persisted.fiscalReceipts.length, 1);
    assert.equal(splitCollections.paymentContainers.length, 1);
    assert.equal(splitCollections.paymentTransactions[0].id, "tx_shadow_a");
    assert.equal(splitCollections.fiscalReceipts[0].id, "fiscal_shadow_a");
  } finally {
    repository.close();
    split.close();
  }
});

test("app-state split paymentsFiscal externalized idrata letture e salta rewrite JSON su soli pagamenti/fiscale", async () => {
  const runDir = await createTempRunDir(
    "app-state-split-payments-fiscal-externalized",
  );
  const dbPath = path.join(runDir, "app-state.json");
  const splitDbPath = path.join(runDir, "app-state-split.sqlite");
  const split = createPaymentsFiscalSplitRepository({
    mode: "externalized",
    dbPath: splitDbPath,
    nowIso: () => "2026-06-22T16:00:00.000Z",
    cloneJson,
    logger: { warn() {} },
  });
  const state = buildTestState();
  state.paymentContainers = [
    {
      id: "payc_ext_a",
      tableId: "room_pedana_t08",
      roomId: "room_pedana",
      orderIds: ["ord_ext_pay_a"],
      amount: 27,
      status: "COMPLETED",
      splitType: "FREE_SPLIT",
      splitMode: "article",
      idempotencyKey: "idem_ext_payment_a",
      clientPaymentId: "client_ext_payment_a",
      createdAt: "2026-06-22T15:55:00.000Z",
    },
  ];
  state.paymentParts = [
    {
      id: "part_ext_a",
      paymentId: "payc_ext_a",
      partNo: 1,
      amountDue: 27,
      status: "PAID",
    },
  ];
  state.paymentTransactions = [
    {
      id: "tx_ext_a",
      partId: "part_ext_a",
      method: "POS",
      amountPaid: 27,
      cashGiven: 0,
      changeGiven: 0,
      posProvider: "mobile-pos",
      posTxRef: "EXT-POS-TEST",
      createdAt: "2026-06-22T15:55:00.000Z",
    },
  ];
  state.paymentProviderTransactions = [
    {
      transactionId: "ptx_ext_a",
      clientPaymentId: "client_ext_payment_a:part-1:tx-1",
      idempotencyKey: "idem_provider_ext_a",
      status: "settled",
      amount: 27,
      currency: "EUR",
      paymentMethodId: "pay_card",
      providerType: "card",
      settlementResponse: {
        ok: true,
        paymentId: "payc_ext_a",
        transactionId: "tx_ext_a",
      },
      createdAt: "2026-06-22T15:55:00.000Z",
      updatedAt: "2026-06-22T15:55:01.000Z",
      completedAt: "2026-06-22T15:55:01.000Z",
    },
  ];
  state.payments = [
    {
      id: "pay_ext_a",
      tableId: "room_pedana_t08",
      roomId: "room_pedana",
      orderIds: ["ord_ext_pay_a"],
      amount: 27,
      methodId: "pay_card",
      methodLabel: "Carta",
      fiscal: true,
      source: "free_split_article_payment",
      idempotencyKey: "idem_ext_payment_a",
      clientPaymentId: "client_ext_payment_a",
      paymentContainerId: "payc_ext_a",
      paymentPartId: "part_ext_a",
      paymentTxId: "tx_ext_a",
      receiptId: "fiscal_ext_a",
      createdAt: "2026-06-22T15:55:00.000Z",
    },
  ];
  state.fiscalReceipts = [
    {
      id: "fiscal_ext_a",
      paymentId: "tx_ext_a",
      command: "pos_receipt",
      status: "ISSUED",
      fiscalStatus: "ISSUED",
      fiscalProvider: "pos-fiscal-api",
      fiscalRequestId: "pos_fiscal_tx_ext_a",
      idempotencyKey: "pos_fiscal_tx_ext_a",
      attemptCount: 0,
      createdAt: "2026-06-22T15:55:01.000Z",
      lastAttemptAt: "2026-06-22T15:55:01.000Z",
    },
  ];
  state.fiscalEvents = [
    {
      id: "fiscal_evt_ext_a",
      command: "pos_receipt",
      createdAt: "2026-06-22T15:55:01.000Z",
      createdByUserId: "system",
      createdByUsername: "system",
      result: "ok",
      message: "Documento fiscale emesso.",
    },
  ];
  state.cashTxDenoms = [
    { id: "denom_ext_a", txId: "tx_ext_a", value: 20, count: 1 },
  ];
  state.smartNonFiscal = [
    {
      id: "smart_nf_ext_a",
      kind: "smart_payment",
      description: "Pagamento smart test",
      amount: 5,
      methodId: "pay_card",
      methodLabel: "Carta",
      createdAt: "2026-06-22T15:55:01.000Z",
    },
  ];
  let jsonWrites = 0;
  const jsonRepository = {
    ensureJsonStateFile: async ({ dbPath: targetPath, buildInitialState }) => {
      if (!existsSync(targetPath)) {
        await fs.writeFile(
          targetPath,
          JSON.stringify(buildInitialState(), null, 2),
        );
      }
    },
    readJsonStateFile: async (targetPath) =>
      JSON.parse(await fs.readFile(targetPath, "utf-8")),
    writeJsonStateFile: async (targetPath, tmpPath, appState) => {
      jsonWrites += 1;
      await fs.writeFile(tmpPath, JSON.stringify(appState, null, 2));
      await fs.rename(tmpPath, targetPath);
    },
  };

  const writer = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        jsonRepository,
        hydrateReadState: (appState) => split.hydrateAppState(appState),
        hydrateReadRequired: true,
        beforeWrite: (appState) => split.syncFromAppState(appState),
        beforeWriteRequired: true,
        prepareWriteState: (appState) =>
          split.prepareAppStateForPrimaryWrite(appState),
        prepareComparableState: (appState) =>
          split.prepareAppStateForPersistenceComparison(appState),
      },
    }),
  );

  try {
    await writer.writeDb(state);
    assert.equal(jsonWrites, 1);
    const persistedContent = await fs.readFile(dbPath, "utf-8");
    const persisted = JSON.parse(persistedContent);
    assert.equal(persisted.paymentContainers.length, 0);
    assert.equal(persisted.paymentParts.length, 0);
    assert.equal(persisted.paymentTransactions.length, 0);
    assert.equal(persisted.paymentProviderTransactions.length, 0);
    assert.equal(persisted.payments.length, 0);
    assert.equal(persisted.fiscalReceipts.length, 0);
    assert.equal(persisted.fiscalEvents.length, 0);
    assert.equal(persisted.cashTxDenoms.length, 0);
    assert.equal(persisted.smartNonFiscal.length, 0);
    assert.equal(
      persisted.meta.appStateSplitDomains.paymentsFiscal.mode,
      "externalized",
    );

    const paymentOnlyState = cloneJson(state, state);
    paymentOnlyState.paymentTransactions[0] = {
      ...paymentOnlyState.paymentTransactions[0],
      amountPaid: 28,
      note: "rettifica test",
    };
    paymentOnlyState.fiscalReceipts[0] = {
      ...paymentOnlyState.fiscalReceipts[0],
      attemptCount: 1,
      lastAttemptAt: "2026-06-22T16:00:30.000Z",
    };
    paymentOnlyState.fiscalEvents.push({
      id: "fiscal_evt_ext_b",
      command: "pos_receipt",
      createdAt: "2026-06-22T16:00:30.000Z",
      createdByUserId: "system",
      createdByUsername: "system",
      result: "retry_recorded",
      message: "Retry fiscale tracciato.",
    });
    paymentOnlyState.meta.lastWriteAt = "2026-06-22T16:00:30.000Z";
    paymentOnlyState.integration.lastWriteAt = "2026-06-22T16:00:30.000Z";
    await writer.writeDb(paymentOnlyState);
    assert.equal(jsonWrites, 1);
    assert.equal(await fs.readFile(dbPath, "utf-8"), persistedContent);

    const splitCollections = await split.listPaymentsFiscalCollections();
    assert.equal(splitCollections.paymentTransactions.length, 1);
    assert.equal(splitCollections.paymentTransactions[0].amountPaid, 28);
    assert.equal(splitCollections.fiscalReceipts[0].attemptCount, 1);
    assert.equal(splitCollections.fiscalEvents.length, 2);

    const reader = createAppStateRepository(
      createRepositoryOptions({
        mode: "json",
        dbPath,
        overrides: {
          jsonRepository,
          hydrateReadState: (appState) => split.hydrateAppState(appState),
          hydrateReadRequired: true,
        },
      }),
    );
    const reread = await reader.readDb({ allowMigrations: false });
    reader.close();

    assert.equal(reread.paymentContainers.length, 1);
    assert.equal(reread.paymentTransactions[0].id, "tx_ext_a");
    assert.equal(reread.paymentTransactions[0].amountPaid, 28);
    assert.equal(
      reread.paymentProviderTransactions[0].transactionId,
      "ptx_ext_a",
    );
    assert.equal(reread.fiscalEvents.length, 2);
    assert.equal(reread.smartNonFiscal[0].id, "smart_nf_ext_a");
  } finally {
    writer.close();
    split.close();
  }
});

test("audit.mapper normalizza un audit event valido", () => {
  const event = sanitizeAuditEvent(
    {
      id: "evt_source",
      occurredAt: "2026-05-13T08:00:00.000Z",
      actorUserId: 123,
      actorRole: "admin",
      roomId: 45,
      deviceId: "device-a",
      action: "payment.completed",
      entityType: "payment",
      entityId: 789,
      correlationId: "corr-1",
      payload: { total: 10 },
      before: { due: 10 },
      after: { due: 0 },
    },
    "evt_fallback",
  );

  assert.equal(event.id, "evt_source");
  assert.equal(event.actorUserId, "123");
  assert.equal(event.roomId, "45");
  assert.equal(event.entityId, "789");
  assert.deepEqual(event.payload, { total: 10 });
  assert.deepEqual(event.before, { due: 10 });
  assert.deepEqual(event.after, { due: 0 });
});

test("audit.mapper gestisce payload/before/after null o oggetti", () => {
  const withNulls = sanitizeAuditEvent(
    {
      action: "order.corrected",
      entityType: "order",
      entityId: "ord-1",
      payload: null,
      before: null,
      after: null,
    },
    "evt_nulls",
    { nowIso: () => "2026-05-13T09:00:00.000Z" },
  );
  assert.equal(withNulls.id, "evt_nulls");
  assert.equal(withNulls.occurredAt, "2026-05-13T09:00:00.000Z");
  assert.equal(withNulls.payload, null);
  assert.equal(withNulls.before, null);
  assert.equal(withNulls.after, null);

  const withObjects = sanitizeAuditEvent(
    {
      action: "order.corrected",
      entityType: "order",
      entityId: "ord-2",
      payload: { reason: "test" },
      before: { total: 12 },
      after: { total: 14 },
    },
    "evt_objects",
  );
  assert.deepEqual(withObjects.payload, { reason: "test" });
  assert.deepEqual(withObjects.before, { total: 12 });
  assert.deepEqual(withObjects.after, { total: 14 });
});


test("dirty tracking mode normalizza legacy e rollout mode", () => {
  assert.equal(normalizeAppStateDirtyTrackingMode("shadow"), "shadow");
  assert.equal(normalizeAppStateDirtyTrackingMode("warn"), "warn");
  assert.equal(normalizeAppStateDirtyTrackingMode("enforce"), "enforce");
  assert.equal(normalizeAppStateDirtyTrackingMode("1"), "write");
  assert.equal(normalizeAppStateDirtyTrackingMode("0"), "off");
  assert.equal(normalizeAppStateDirtyTrackingMode("unknown"), "off");
});

test("dirty tracking shadow osserva domini non dichiarati senza cambiare la persistenza", async () => {
  const runDir = await createTempRunDir("app-state-repo-dirty-shadow");
  const dbPath = path.join(runDir, "app-state.json");
  const state = buildTestState();
  const dirtyEvents = [];
  const writeEvents = [];
  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        dirtyTrackingMode: "shadow",
        runtimeMetrics: {
          enabled: true,
          recordReadDb: () => {},
          recordWriteDb: (event) => writeEvents.push(event),
          recordDirtyTracking: (event) => dirtyEvents.push(event),
          recordOperation: () => {},
        },
      },
    }),
  );

  await repository.writeDb(state, { splitDomains: ["users", "sessions"] });
  const nextState = cloneJson(state, state);
  nextState.integration.orders.push({ id: "ord_shadow", tableId: "t1", items: [] });
  await repository.writeDb(nextState, { metricLabel: "test.shadow", splitDomains: ["sessions"] });
  const reread = await repository.readDb({ allowMigrations: false, forceReload: true });

  assert.equal(reread.integration.orders.some((order) => order.id === "ord_shadow"), true);
  const shadowEvent = dirtyEvents.find((event) => event.label === "test.shadow");
  assert.ok(shadowEvent);
  assert.deepEqual(shadowEvent.missingDeclaredDomains, ["integration"]);
  assert.equal(writeEvents.some((event) => event.persisted === true), true);
});

test("dirty tracking warn segnala domini non dichiarati senza bloccare", async () => {
  const runDir = await createTempRunDir("app-state-repo-dirty-warn");
  const dbPath = path.join(runDir, "app-state.json");
  const state = buildTestState();
  const warnings = [];
  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        dirtyTrackingMode: "warn",
        logger: { warn: (message) => warnings.push(String(message)) },
      },
    }),
  );

  await repository.writeDb(state, { splitDomains: ["users", "sessions"] });
  const nextState = cloneJson(state, state);
  nextState.integration.notifications.push({ id: "notif_warn", message: "test" });
  await repository.writeDb(nextState, { metricLabel: "test.warn", splitDomains: ["sessions"] });

  assert.ok(warnings.some((message) => message.includes("domini modificati non dichiarati") && message.includes("integration")));
});

test("dirty tracking enforce blocca domini modificati non dichiarati dopo una baseline", async () => {
  const runDir = await createTempRunDir("app-state-repo-dirty-enforce");
  const dbPath = path.join(runDir, "app-state.json");
  const state = buildTestState();
  const repository = createAppStateRepository(
    createRepositoryOptions({
      mode: "json",
      dbPath,
      overrides: {
        dirtyTrackingMode: "enforce",
      },
    }),
  );

  await repository.writeDb(state, { splitDomains: ["users", "sessions", "integration"] });
  const nextState = cloneJson(state, state);
  nextState.integration.notifications.push({ id: "notif_enforce", message: "test" });

  await assert.rejects(
    () => repository.writeDb(nextState, { metricLabel: "test.enforce", splitDomains: ["sessions"] }),
    /DIRTY_DOMAIN_UNDECLARED.*integration/,
  );
});
