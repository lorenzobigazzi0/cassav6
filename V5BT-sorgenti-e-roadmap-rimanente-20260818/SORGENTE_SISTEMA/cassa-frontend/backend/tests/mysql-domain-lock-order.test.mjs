import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMysqlAppStateDomainsSplitRepository,
  sortDomainRowsForLockOrder,
} from "../db/app-state/mysql-domains-split.repository.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function rowsFromBatchParameters(params = []) {
  const rows = [];
  for (let index = 0; index < params.length; index += 6) {
    rows.push({
      domain: params[index],
      recordId: params[index + 1],
      kind: params[index + 2],
      appStatePosition: params[index + 3],
      rowHash: params[index + 4],
      rawJson: params[index + 5],
    });
  }
  return rows;
}

async function captureBulkIntegrationLockSql(options = {}) {
  const queries = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql) {
      queries.push(sql);
      return [[]];
    },
  };
  const repository = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "bulk_lock_mode_records",
    domains: ["integration"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["orders"] },
    mysqlRepository: {
      async query() {
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
  });

  await repository.syncObjectArrayEntriesAndObjectEntriesFromAppState(
    {
      integration: {
        lastWriteAt: "2026-08-06T12:00:00.000Z",
        orders: [{ id: "order_lock_mode" }],
      },
    },
    "integration",
    {
      objectArrayEntries: [
        { fieldName: "orders", entryIds: ["order_lock_mode"] },
      ],
      objectFields: ["lastWriteAt"],
      ...options,
    },
  );

  const lockQueries = queries.filter((sql) =>
    /SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]*FOR UPDATE/.test(sql),
  );
  assert.equal(lockQueries.length, 1);
  return lockQueries[0];
}

test("le righe MySQL vengono ordinate per dominio e record prima dei lock", () => {
  const input = [
    { domain: "posSettings", recordId: "tables::9" },
    { domain: "integration", recordId: "stationStates::2" },
    { domain: "integration", recordId: "orders::8" },
    { domain: "integration", recordId: "orders::1" },
  ];
  const sorted = sortDomainRowsForLockOrder(input);
  assert.deepEqual(
    sorted.map((row) => `${row.domain}/${row.recordId}`),
    [
      "integration/orders::1",
      "integration/orders::8",
      "integration/stationStates::2",
      "posSettings/tables::9",
    ],
  );
  assert.equal(input[0].domain, "posSettings", "l'input non deve essere mutato");
});

test("tutti i writer multi-riga usano l'ordine canonico", () => {
  const source = readFileSync(
    path.join(testDir, "..", "db", "app-state", "mysql-domains-split.repository.js"),
    "utf8",
  );
  assert.match(
    source,
    /async function upsertDomainRows\(connection, rows\) \{\s*for \(const row of sortDomainRowsForLockOrder\(rows\)\)/,
  );
  assert.match(
    source,
    /async function upsertDomainRowsBatch[\s\S]+?const batchRows = sortDomainRowsForLockOrder\(rows\)/,
  );
  assert.match(
    source,
    /async function upsertChangedDomainRows[\s\S]+?lockDomainRowsForWrite[\s\S]+?upsertDomainRowsBatch\(connection, rowsToUpsert, prefix\)/,
  );
});

test("il bulk integration usa FOR UPDATE senza NOWAIT per default", async () => {
  const sql = await captureBulkIntegrationLockSql();
  assert.match(sql, /FOR UPDATE\b/);
  assert.doesNotMatch(sql, /FOR UPDATE\s+NOWAIT\b/);
});

test("il bulk integration aggiunge NOWAIT solo quando lockRowsNowait e' richiesto", async () => {
  const sql = await captureBulkIntegrationLockSql({ lockRowsNowait: true });
  assert.match(sql, /FOR UPDATE\s+NOWAIT\b/);
});

test("la selezione puntuale multi-dominio usa una sola transazione e l'ordine canonico", async () => {
  const inserted = [];
  const transactions = [];
  const connection = {
    async beginTransaction() {
      transactions.push("begin");
    },
    async query(sql, params = []) {
      if (/SELECT record_id, kind, app_state_position, row_hash/.test(sql)) {
        return [[]];
      }
      if (/INSERT INTO `test_domain_records`/.test(sql)) {
        inserted.push(
          ...rowsFromBatchParameters(params).map(
            (row) => `${row.domain}/${row.recordId}`,
          ),
        );
      }
      return [[]];
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
  };
  const mysqlRepository = {
    async query() {
      return [];
    },
    async getPool() {
      return {
        async getConnection() {
          return connection;
        },
      };
    },
  };
  const repository = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "test_domain_records",
    domains: ["payments", "paymentContainers"],
    mysqlRepository,
  });

  const result = await repository.syncSelectedEntriesFromAppState(
    {
      payments: [{ id: "pay_2" }, { id: "pay_1" }],
      paymentContainers: [{ id: "container_1" }],
    },
    {
      domainArrayEntries: [
        { domain: "payments", entryIds: ["pay_2", "pay_1"] },
        { domain: "paymentContainers", entryIds: ["container_1"] },
      ],
    },
  );

  assert.deepEqual(transactions, ["begin", "commit", "release"]);
  assert.deepEqual(inserted, [
    "paymentContainers/container_1",
    "payments/pay_1",
    "payments/pay_2",
  ]);
  assert.equal(result.selectedRows, 3);
  assert.equal(result.changedRows, 3);
});

test("la selezione free-split ordina integration e record pagamento nello stesso commit", async () => {
  const inserted = [];
  const freshnessLocks = [];
  const transactions = [];
  const connection = {
    async beginTransaction() {
      transactions.push("begin");
    },
    async query(sql, params = []) {
      if (/SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]*FOR UPDATE/.test(sql)) {
        freshnessLocks.push(...params.slice(1).map((recordId) => `${params[0]}/${recordId}`));
        return [[]];
      }
      if (/SELECT record_id, kind, app_state_position, row_hash/.test(sql)) {
        return [[]];
      }
      if (/INSERT INTO `free_split_domain_records`/.test(sql)) {
        inserted.push(
          ...rowsFromBatchParameters(params).map(
            (row) => `${row.domain}/${row.recordId}`,
          ),
        );
      }
      return [[]];
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
  };
  const repository = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "free_split_domain_records",
    domains: ["payments", "paymentTransactions", "integration"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["orders"] },
    mysqlRepository: {
      async query() {
        return [];
      },
      async getPool() {
        return { async getConnection() { return connection; } };
      },
    },
  });

  await repository.syncSelectedEntriesFromAppState(
    {
      payments: [{ id: "pay_1" }],
      paymentTransactions: [{ id: "tx_1" }],
      integration: {
        orders: [{ id: "order_1" }],
        lastWriteAt: "2026-08-06T08:00:00.000Z",
      },
    },
    {
      domainArrayEntries: [
        { domain: "payments", entryIds: ["pay_1"] },
        { domain: "paymentTransactions", entryIds: ["tx_1"] },
      ],
      objectArrayEntries: [
        {
          domain: "integration",
          fieldName: "orders",
          entryIds: ["order_1"],
        },
      ],
      objectFields: [
        { domain: "integration", fieldNames: ["lastWriteAt"] },
      ],
    },
    {
      metricPrefix: "paymentFreeSplit.atomicMirror",
      preserveNewerIntegrationRecords: true,
    },
  );

  assert.deepEqual(transactions, ["begin", "commit", "release"]);
  assert.deepEqual(freshnessLocks, [
    "integration/lastWriteAt",
    "integration/orders",
    "integration/orders:order_1",
    "payments/pay_1",
    "paymentTransactions/tx_1",
  ]);
  assert.deepEqual(inserted, [
    "integration/lastWriteAt",
    "integration/orders",
    "integration/orders:order_1",
    "payments/pay_1",
    "paymentTransactions/tx_1",
  ]);
});

test("il guard di freschezza usa una sola lettura lockata e un solo upsert per dominio", async () => {
  const queries = [];
  const metrics = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]*FOR UPDATE/.test(sql)) {
        return [[]];
      }
      if (/SELECT record_id, kind, app_state_position, row_hash/.test(sql)) {
        return [[]];
      }
      return [[]];
    },
  };
  const repository = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "batched_freshness_records",
    domains: ["integration"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["orders"] },
    runtimeMetrics: {
      recordOperation(kind, label, durationMs) {
        metrics.push({ kind, label, durationMs });
      },
    },
    mysqlRepository: {
      async query() {
        return [];
      },
      async getPool() {
        return { async getConnection() { return connection; } };
      },
    },
  });

  await repository.syncSelectedEntriesFromAppState(
    {
      integration: {
        orders: [{ id: "z" }, { id: "a" }, { id: "m" }],
        lastWriteAt: "2026-08-06T12:00:00.000Z",
      },
    },
    {
      objectArrayEntries: [
        { domain: "integration", fieldName: "orders", entryIds: ["z", "a", "m"] },
      ],
      objectFields: [{ domain: "integration", fieldNames: ["lastWriteAt"] }],
    },
    {
      metricPrefix: "batchFreshness",
      preserveNewerIntegrationRecords: true,
    },
  );

  const lockQueries = queries.filter(({ sql }) => /raw_json[\s\S]*FOR UPDATE/.test(sql));
  const domainStateQueries = queries.filter(({ sql }) =>
    /SELECT record_id, kind, app_state_position, row_hash[\s\S]*FROM `batched_freshness_records`/.test(sql),
  );
  const upsertQueries = queries.filter(({ sql }) => /INSERT INTO `batched_freshness_records`/.test(sql));
  assert.equal(domainStateQueries.length, 1);
  assert.equal(/FOR UPDATE/.test(domainStateQueries[0].sql), true);
  assert.equal(lockQueries.length, 1);
  assert.equal(
    metrics.filter(({ label }) => label === "batchFreshness.stateRead").length,
    1,
  );
  assert.equal(
    metrics.filter(({ label }) => label === "batchFreshness.upsertBatch").length,
    1,
  );
  assert.match(lockQueries[0].sql, /record_id IN \(\?, \?, \?, \?, \?\)/);
  assert.match(lockQueries[0].sql, /ORDER BY record_id ASC[\s\S]*FOR UPDATE/);
  assert.deepEqual(lockQueries[0].params, [
    "integration",
    "lastWriteAt",
    "orders",
    "orders:a",
    "orders:m",
    "orders:z",
  ]);
  assert.equal(upsertQueries.length, 1);
  assert.deepEqual(
    rowsFromBatchParameters(upsertQueries[0].params).map(
      (row) => `${row.domain}/${row.recordId}`,
    ),
    [
      "integration/lastWriteAt",
      "integration/orders",
      "integration/orders:a",
      "integration/orders:m",
      "integration/orders:z",
    ],
  );
});

test("il mirror free-split ritardato preserva revisioni e timestamp piu recenti", async () => {
  const inserted = [];
  const freshnessLocks = [];
  const metrics = [];
  const incomingOrder = {
    id: "order_incoming",
    currentRevision: 3,
    updatedAt: "2026-08-06T10:06:00.000Z",
  };
  const incomingOrderHash = createHash("sha256")
    .update(JSON.stringify(incomingOrder))
    .digest("hex");
  const storedRows = new Map([
    [
      "integration:lastWriteAt",
      {
        domain: "integration",
        record_id: "lastWriteAt",
        kind: "object_entry",
        app_state_position: 1,
        row_hash: "newer-last-write-at",
        raw_json: JSON.stringify("2026-08-06T10:05:00.000Z"),
      },
    ],
    [
      "integration:orders:order_equal",
      {
        domain: "integration",
        record_id: "orders:order_equal",
        kind: "obj_array_entry",
        app_state_position: 0,
        row_hash: "newer-equal-revision",
        raw_json: JSON.stringify({
          id: "order_equal",
          currentRevision: 3,
          updatedAt: "2026-08-06T10:04:00.000Z",
        }),
      },
    ],
    [
      "integration:orders:order_higher",
      {
        domain: "integration",
        record_id: "orders:order_higher",
        kind: "obj_array_entry",
        app_state_position: 1,
        row_hash: "higher-revision",
        raw_json: JSON.stringify({
          id: "order_higher",
          currentRevision: 3,
          revision: 5,
          aggregateVersion: 4,
          updatedAt: "2026-08-06T09:00:00.000Z",
        }),
      },
    ],
    [
      "integration:orders:order_equal_hash",
      {
        domain: "integration",
        record_id: "orders:order_equal_hash",
        kind: "obj_array_entry",
        app_state_position: 1,
        row_hash: "equal-timestamp-newer-content",
        raw_json: JSON.stringify({
          id: "order_equal_hash",
          currentRevision: 3,
          updatedAt: "2026-08-06T10:04:00.000Z",
          workflowStatus: "ready",
        }),
      },
    ],
    [
      "integration:orders:order_invalid_hash",
      {
        domain: "integration",
        record_id: "orders:order_invalid_hash",
        kind: "obj_array_entry",
        app_state_position: 4,
        row_hash: "invalid-timestamp-newer-content",
        raw_json: JSON.stringify({
          id: "order_invalid_hash",
          currentRevision: 3,
          workflowStatus: "ready",
        }),
      },
    ],
    [
      "integration:orders:order_incoming",
      {
        domain: "integration",
        record_id: "orders:order_incoming",
        kind: "obj_array_entry",
        app_state_position: 2,
        row_hash: "older-revision",
        raw_json: JSON.stringify({
          id: "order_incoming",
          currentRevision: 2,
          updatedAt: "2026-08-06T09:00:00.000Z",
        }),
      },
    ],
  ]);
  const connection = {
    async beginTransaction() {},
    async query(sql, params = []) {
      if (/SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]*FOR UPDATE/.test(sql)) {
        const [domain, ...recordIds] = params;
        freshnessLocks.push(...recordIds.map((recordId) => `${domain}/${recordId}`));
        return [
          recordIds
            .map((recordId) => storedRows.get(`${domain}:${recordId}`))
            .filter(Boolean)
            .map((row) => ({ ...row })),
        ];
      }
      if (/SELECT record_id, kind, app_state_position, row_hash/.test(sql)) {
        const [domain, ...recordIds] = params;
        return [
          recordIds
            .map((recordId) => {
              const row = storedRows.get(`${domain}:${recordId}`);
              if (recordId !== "orders:order_incoming" || !row) return row;
              return {
                ...row,
                app_state_position: 3,
                row_hash: incomingOrderHash,
              };
            })
            .filter(Boolean),
        ];
      }
      if (/INSERT INTO\s+`freshness_domain_records`\s*\(/.test(sql)) {
        for (const row of rowsFromBatchParameters(params)) {
          inserted.push(`${row.domain}/${row.recordId}`);
          storedRows.set(`${row.domain}:${row.recordId}`, {
            domain: row.domain,
            record_id: row.recordId,
            kind: row.kind,
            app_state_position: row.appStatePosition,
            row_hash: row.rowHash,
            raw_json: row.rawJson,
          });
        }
      }
      return [[]];
    },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const repository = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "freshness_domain_records",
    domains: ["integration", "payments"],
    objectEntryDomains: ["integration"],
    objectArrayEntryFields: { integration: ["orders"] },
    mysqlRepository: {
      async query() {
        return [];
      },
      async getPool() {
        return { async getConnection() { return connection; } };
      },
    },
    runtimeMetrics: {
      recordOperation(kind, label) {
        metrics.push(`${kind}:${label}`);
      },
    },
  });

  const result = await repository.syncSelectedEntriesFromAppState(
    {
      payments: [{ id: "pay_1" }],
      integration: {
        orders: [
          {
            id: "order_equal",
            currentRevision: 3,
            updatedAt: "2026-08-06T10:03:00.000Z",
          },
          {
            id: "order_higher",
            currentRevision: 4,
            revision: 4,
            aggregateVersion: 4,
            updatedAt: "2026-08-06T10:06:00.000Z",
          },
          {
            id: "order_equal_hash",
            currentRevision: 3,
            updatedAt: "2026-08-06T10:04:00.000Z",
            workflowStatus: "prep",
          },
          incomingOrder,
          {
            id: "order_invalid_hash",
            currentRevision: 3,
            workflowStatus: "prep",
          },
        ],
        lastWriteAt: "2026-08-06T10:00:00.000Z",
      },
    },
    {
      domainArrayEntries: [{ domain: "payments", entryIds: ["pay_1"] }],
      objectArrayEntries: [
        {
          domain: "integration",
          fieldName: "orders",
          entryIds: [
            "order_equal",
            "order_equal_hash",
            "order_higher",
            "order_incoming",
            "order_invalid_hash",
          ],
        },
      ],
      objectFields: [
        { domain: "integration", fieldNames: ["lastWriteAt"] },
      ],
    },
    {
      metricPrefix: "paymentFreeSplit.atomicMirror",
      preserveNewerIntegrationRecords: true,
    },
  );

  assert.deepEqual(freshnessLocks, [
    "integration/lastWriteAt",
    "integration/orders",
    "integration/orders:order_equal",
    "integration/orders:order_equal_hash",
    "integration/orders:order_higher",
    "integration/orders:order_incoming",
    "integration/orders:order_invalid_hash",
    "payments/pay_1",
  ]);
  assert.deepEqual(inserted, [
    "integration/orders",
    "integration/orders:order_incoming",
    "payments/pay_1",
  ]);
  assert.equal(result.selectedRows, 8);
  assert.equal(result.changedRows, 3);
  assert.equal(
    JSON.parse(storedRows.get("integration:lastWriteAt").raw_json),
    "2026-08-06T10:05:00.000Z",
  );
  assert.equal(
    JSON.parse(storedRows.get("integration:orders:order_equal").raw_json)
      .updatedAt,
    "2026-08-06T10:04:00.000Z",
  );
  assert.equal(
    JSON.parse(storedRows.get("integration:orders:order_higher").raw_json)
      .revision,
    5,
  );
  assert.equal(
    JSON.parse(storedRows.get("integration:orders:order_equal_hash").raw_json)
      .workflowStatus,
    "ready",
  );
  assert.equal(
    JSON.parse(storedRows.get("integration:orders:order_invalid_hash").raw_json)
      .workflowStatus,
    "ready",
  );
  assert.equal(
    JSON.parse(storedRows.get("integration:orders:order_incoming").raw_json)
      .currentRevision,
    3,
  );
  assert.equal(
    metrics.filter((label) => label.endsWith("freshnessPreserved.orders"))
      .length,
    4,
  );
  assert.equal(
    metrics.filter((label) => label.endsWith("freshnessPreserved.lastWriteAt"))
      .length,
    1,
  );

  await repository.syncSelectedEntriesFromAppState(
    {
      integration: { lastWriteAt: "timestamp-non-valido" },
    },
    {
      objectFields: [
        { domain: "integration", fieldNames: ["lastWriteAt"] },
      ],
    },
    {
      metricPrefix: "paymentFreeSplit.atomicMirror",
      preserveNewerIntegrationRecords: true,
    },
  );
  assert.equal(
    JSON.parse(storedRows.get("integration:lastWriteAt").raw_json),
    "2026-08-06T10:05:00.000Z",
  );
  assert.equal(
    metrics.filter((label) => label.endsWith("freshnessPreserved.lastWriteAt"))
      .length,
    2,
  );

  await repository.syncSelectedEntriesFromAppState(
    {
      integration: { lastWriteAt: "2026-08-06T10:06:00.000Z" },
    },
    {
      objectFields: [
        { domain: "integration", fieldNames: ["lastWriteAt"] },
      ],
    },
    {
      metricPrefix: "paymentFreeSplit.atomicMirror",
      preserveNewerIntegrationRecords: true,
    },
  );
  assert.equal(
    JSON.parse(storedRows.get("integration:lastWriteAt").raw_json),
    "2026-08-06T10:06:00.000Z",
  );
});

test("il guard free-split non regredisce provider e stato fiscale", async () => {
  const inserted = [];
  const freshnessLocks = [];
  const metrics = [];
  const storedRows = new Map(
    [
      {
        domain: "paymentProviderTransactions",
        record_id: "provider_1",
        kind: "array_entry",
        app_state_position: 0,
        row_hash: "provider-settled",
        raw_json: JSON.stringify({
          transactionId: "provider_1",
          status: "settled",
          revision: 3,
          updatedAt: "2026-08-06T10:05:00.000Z",
        }),
      },
      {
        domain: "payments",
        record_id: "payment_1",
        kind: "array_entry",
        app_state_position: 0,
        row_hash: "payment-fiscal-issued",
        raw_json: JSON.stringify({
          id: "payment_1",
          status: "settled",
          revision: 3,
          updatedAt: "2026-08-06T10:01:00.000Z",
          fiscalIssuedAt: "2026-08-06T10:05:00.000Z",
        }),
      },
      {
        domain: "paymentContainers",
        record_id: "container_1",
        kind: "array_entry",
        app_state_position: 0,
        row_hash: "container-current",
        raw_json: JSON.stringify({
          id: "container_1",
          status: "completed",
          revision: 3,
          updatedAt: "2026-08-06T10:05:00.000Z",
        }),
      },
      {
        domain: "fiscalReceipts",
        record_id: "fiscal_regress",
        kind: "array_entry",
        app_state_position: 0,
        row_hash: "fiscal-issued",
        raw_json: JSON.stringify({
          id: "fiscal_regress",
          status: "ISSUED",
          fiscalStatus: "ISSUED",
          attemptCount: 4,
          updatedAt: "2026-08-06T10:05:00.000Z",
        }),
      },
      {
        domain: "fiscalReceipts",
        record_id: "fiscal_advance",
        kind: "array_entry",
        app_state_position: 1,
        row_hash: "fiscal-retrying",
        raw_json: JSON.stringify({
          id: "fiscal_advance",
          status: "RETRYING",
          fiscalStatus: "RETRYING",
          attemptCount: 4,
          updatedAt: "2026-08-06T10:05:00.000Z",
        }),
      },
    ].map((row) => [`${row.domain}:${row.record_id}`, row]),
  );
  const connection = {
    async beginTransaction() {},
    async query(sql, params = []) {
      if (/SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]*FOR UPDATE/.test(sql)) {
        const [domain, ...recordIds] = params;
        freshnessLocks.push(...recordIds.map((recordId) => `${domain}/${recordId}`));
        return [
          recordIds
            .map((recordId) => storedRows.get(`${domain}:${recordId}`))
            .filter(Boolean)
            .map((row) => ({ ...row })),
        ];
      }
      if (/SELECT record_id, kind, app_state_position, row_hash/.test(sql)) {
        const [domain, ...recordIds] = params;
        return [
          recordIds
            .map((recordId) => storedRows.get(`${domain}:${recordId}`))
            .filter(Boolean),
        ];
      }
      if (/INSERT INTO\s+`mutable_payment_records`\s*\(/.test(sql)) {
        for (const row of rowsFromBatchParameters(params)) {
          inserted.push(`${row.domain}/${row.recordId}`);
          storedRows.set(`${row.domain}:${row.recordId}`, {
            domain: row.domain,
            record_id: row.recordId,
            kind: row.kind,
            app_state_position: row.appStatePosition,
            row_hash: row.rowHash,
            raw_json: row.rawJson,
          });
        }
      }
      return [[]];
    },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const repository = createMysqlAppStateDomainsSplitRepository({
    enabled: true,
    tableName: "mutable_payment_records",
    domains: [
      "payments",
      "paymentContainers",
      "paymentProviderTransactions",
      "fiscalReceipts",
    ],
    mysqlRepository: {
      async query() {
        return [];
      },
      async getPool() {
        return { async getConnection() { return connection; } };
      },
    },
    runtimeMetrics: {
      recordOperation(kind, label) {
        metrics.push(`${kind}:${label}`);
      },
    },
  });

  const result = await repository.syncSelectedEntriesFromAppState(
    {
      paymentProviderTransactions: [
        {
          transactionId: "provider_1",
          status: "created",
          revision: 1,
          updatedAt: "2026-08-06T10:00:00.000Z",
        },
      ],
      payments: [
        {
          id: "payment_1",
          status: "settled",
          revision: 2,
          updatedAt: "2026-08-06T10:04:00.000Z",
          fiscalIssuedAt: "2026-08-06T10:00:00.000Z",
        },
      ],
      paymentContainers: [
        {
          id: "container_1",
          status: "pending",
          revision: 2,
          updatedAt: "2026-08-06T10:00:00.000Z",
        },
      ],
      fiscalReceipts: [
        {
          id: "fiscal_regress",
          status: "PENDING",
          fiscalStatus: "PENDING",
          attemptCount: 1,
          updatedAt: "2026-08-06T10:00:00.000Z",
        },
        {
          id: "fiscal_advance",
          status: "ISSUED",
          fiscalStatus: "ISSUED",
          attemptCount: 1,
          updatedAt: "2026-08-06T10:06:00.000Z",
        },
      ],
    },
    {
      domainArrayEntries: [
        {
          domain: "paymentProviderTransactions",
          entryIds: ["provider_1"],
        },
        { domain: "payments", entryIds: ["payment_1"] },
        { domain: "paymentContainers", entryIds: ["container_1"] },
        {
          domain: "fiscalReceipts",
          entryIds: ["fiscal_regress", "fiscal_advance"],
        },
      ],
    },
    {
      metricPrefix: "paymentFreeSplit.atomicMirror",
      preserveNewerPaymentMirrorRecords: true,
    },
  );

  assert.deepEqual(freshnessLocks, [
    "fiscalReceipts/fiscal_advance",
    "fiscalReceipts/fiscal_regress",
    "paymentContainers/container_1",
    "paymentProviderTransactions/provider_1",
    "payments/payment_1",
  ]);
  assert.deepEqual(inserted, ["fiscalReceipts/fiscal_advance"]);
  assert.equal(result.selectedRows, 5);
  assert.equal(result.changedRows, 1);
  assert.equal(
    JSON.parse(storedRows.get("paymentProviderTransactions:provider_1").raw_json)
      .status,
    "settled",
  );
  assert.equal(
    JSON.parse(storedRows.get("payments:payment_1").raw_json).fiscalIssuedAt,
    "2026-08-06T10:05:00.000Z",
  );
  assert.equal(
    JSON.parse(storedRows.get("paymentContainers:container_1").raw_json).status,
    "completed",
  );
  assert.equal(
    JSON.parse(storedRows.get("fiscalReceipts:fiscal_regress").raw_json)
      .status,
    "ISSUED",
  );
  const advancedFiscal = JSON.parse(
    storedRows.get("fiscalReceipts:fiscal_advance").raw_json,
  );
  assert.equal(advancedFiscal.status, "ISSUED");
  assert.equal(advancedFiscal.attemptCount, 4);
  assert.equal(
    metrics.filter((label) =>
      label.endsWith("freshnessPreserved.paymentProviderTransactions"),
    ).length,
    1,
  );
  assert.equal(
    metrics.filter((label) =>
      label.endsWith("freshnessPreserved.fiscalReceipts"),
    ).length,
    1,
  );
  assert.equal(
    metrics.filter((label) => label.endsWith("freshnessPreserved.payments"))
      .length,
    1,
  );
  assert.equal(
    metrics.filter((label) =>
      label.endsWith("freshnessPreserved.paymentContainers"),
    ).length,
    1,
  );
});
