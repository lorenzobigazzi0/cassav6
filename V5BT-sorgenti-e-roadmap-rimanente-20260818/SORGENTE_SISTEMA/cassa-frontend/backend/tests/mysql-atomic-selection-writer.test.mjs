import assert from "node:assert/strict";
import test from "node:test";

import { createMysqlAtomicSelectionWriter } from "../db/app-state/mysql-atomic-selection-writer.js";
import { createMysqlAuditEventsSplitRepository } from "../db/app-state/mysql-audit-events-split.repository.js";

function createHarness({ auditError = null } = {}) {
  const events = [];
  const connection = {
    async beginTransaction() {
      events.push("begin");
    },
    async commit() {
      events.push("commit");
    },
    async rollback() {
      events.push("rollback");
    },
    release() {
      events.push("release");
    },
  };
  const domainsRepository = {
    enabled: true,
    async ensureStorage() {
      events.push("ensure-domains");
    },
    async syncSelectedEntriesFromAppState(_state, _selection, options) {
      assert.equal(options.connection, connection);
      events.push("write-domains");
      return { selectedRows: 2, changedRows: 2, domains: ["payments"] };
    },
  };
  const auditEventsRepository = {
    enabled: true,
    async ensureStorage() {
      events.push("ensure-audit");
    },
    async syncEntriesFromAppState(_state, _ids, options) {
      assert.equal(options.connection, connection);
      events.push("write-audit");
      if (auditError) throw auditError;
      return 1;
    },
  };
  const mysqlRepository = {
    async getPool() {
      return {
        async getConnection() {
          return connection;
        },
      };
    },
  };
  return {
    auditEventsRepository,
    connection,
    domainsRepository,
    events,
    mysqlRepository,
  };
}

test("writer atomico salva domini e audit nello stesso commit", async () => {
  const harness = createHarness();
  let refreshed = 0;
  const writer = createMysqlAtomicSelectionWriter({
    enabled: true,
    mysqlRepository: harness.mysqlRepository,
    domainsRepository: harness.domainsRepository,
    auditEventsRepository: harness.auditEventsRepository,
    refreshHealthSnapshot() {
      refreshed += 1;
    },
  });

  const result = await writer.write(
    { payments: [{ id: "pay_1" }], auditEvents: [{ id: "audit_1" }] },
    {
      domainSelection: {
        domainArrayEntries: [{ domain: "payments", entryIds: ["pay_1"] }],
      },
      auditEventIds: ["audit_1"],
    },
  );

  assert.equal(result.written, true);
  assert.equal(result.changedRows, 2);
  assert.equal(result.auditRows, 1);
  assert.equal(refreshed, 1);
  assert.deepEqual(harness.events, [
    "ensure-domains",
    "ensure-audit",
    "begin",
    "write-domains",
    "write-audit",
    "commit",
    "release",
  ]);
});

test("writer atomico inoltra l'intera selezione free-split sulla stessa connessione", async () => {
  const harness = createHarness();
  const originalDomainWrite =
    harness.domainsRepository.syncSelectedEntriesFromAppState.bind(
      harness.domainsRepository,
    );
  let capturedSelection = null;
  let capturedExecution = null;
  harness.domainsRepository.syncSelectedEntriesFromAppState = async (
    state,
    selection,
    options,
  ) => {
    capturedSelection = selection;
    capturedExecution = options;
    return originalDomainWrite(state, selection, options);
  };
  const writer = createMysqlAtomicSelectionWriter({
    enabled: true,
    mysqlRepository: harness.mysqlRepository,
    domainsRepository: harness.domainsRepository,
    auditEventsRepository: harness.auditEventsRepository,
  });
  const domainSelection = {
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
  };

  await writer.write(
    {
      payments: [{ id: "pay_1" }],
      paymentTransactions: [{ id: "tx_1" }],
      integration: {
        orders: [{ id: "order_1" }],
        lastWriteAt: "2026-08-06T08:00:00.000Z",
      },
      auditEvents: [{ id: "audit_1" }],
    },
    {
      metricLabel: "paymentFreeSplit.atomicMirror",
      domainSelection,
      auditEventIds: ["audit_1"],
      preserveNewerIntegrationRecords: true,
      preserveNewerPaymentMirrorRecords: true,
    },
  );

  assert.deepEqual(capturedSelection, domainSelection);
  assert.equal(capturedExecution.connection, harness.connection);
  assert.equal(capturedExecution.metricPrefix, "paymentFreeSplit.atomicMirror");
  assert.equal(capturedExecution.preserveNewerIntegrationRecords, true);
  assert.equal(capturedExecution.preserveNewerPaymentMirrorRecords, true);
  assert.deepEqual(harness.events, [
    "ensure-domains",
    "ensure-audit",
    "begin",
    "write-domains",
    "write-audit",
    "commit",
    "release",
  ]);
});

test("writer atomico rollbacka i domini se fallisce l'audit", async () => {
  const harness = createHarness({ auditError: new Error("audit write failed") });
  const writer = createMysqlAtomicSelectionWriter({
    enabled: true,
    mysqlRepository: harness.mysqlRepository,
    domainsRepository: harness.domainsRepository,
    auditEventsRepository: harness.auditEventsRepository,
  });

  await assert.rejects(
    writer.write(
      { payments: [{ id: "pay_1" }], auditEvents: [{ id: "audit_1" }] },
      {
        domainSelection: {
          domainArrayEntries: [{ domain: "payments", entryIds: ["pay_1"] }],
        },
        auditEventIds: ["audit_1"],
      },
    ),
    /audit write failed/,
  );

  assert.deepEqual(harness.events, [
    "ensure-domains",
    "ensure-audit",
    "begin",
    "write-domains",
    "write-audit",
    "rollback",
    "release",
  ]);
});

test("repository audit usa la connessione esterna senza aprire un secondo commit", async () => {
  const statements = [];
  const externalConnection = {
    async query(sql, params) {
      statements.push({ sql, params });
      return [[]];
    },
  };
  const repository = createMysqlAuditEventsSplitRepository({
    enabled: true,
    tableName: "test_audit_events",
    mysqlRepository: {
      async query() {
        return [];
      },
      async getPool() {
        throw new Error("non deve acquisire una seconda connessione");
      },
    },
    nowIso: () => "2026-07-16T00:00:00.000Z",
  });

  const count = await repository.syncEntriesFromAppState(
    {
      auditEvents: [
        {
          id: "audit_1",
          action: "counter.order_collected",
          occurredAt: "2026-07-16T00:00:00.000Z",
        },
      ],
    },
    ["audit_1"],
    { connection: externalConnection },
  );

  assert.equal(count, 1);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /INSERT INTO `test_audit_events`/);
});
