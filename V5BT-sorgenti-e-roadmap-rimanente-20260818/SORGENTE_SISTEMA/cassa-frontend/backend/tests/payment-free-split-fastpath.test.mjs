import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentFreeSplitFastPath } from "../modules/payments/payment-free-split-fastpath.js";

function createHarness({ deferResult = true } = {}) {
  const transientError = Object.assign(
    new Error("Record has changed since last read"),
    { code: "ER_CHECKREAD", errno: 1020 },
  );
  const deferred = [];
  const counters = [];
  const writePaymentFreeSplitDb = createPaymentFreeSplitFastPath({
    dbMode: "mysql",
    mysqlAppStateDomainsSplitRepository: { enabled: false },
    writePaymentDb: async () => {
      throw transientError;
    },
    deferTransientMirror: async (...args) => {
      deferred.push(args);
      return deferResult;
    },
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
      recordOperation: () => {},
    },
  });
  return {
    counters,
    deferred,
    transientError,
    writePaymentFreeSplitDb,
  };
}

test("free split conferma il write relazionale quando il mirror transitorio viene differito", async () => {
  const harness = createHarness();
  const db = { payments: [{ id: "pay-1" }] };

  await harness.writePaymentFreeSplitDb(db, {
    metricLabel: "payments.freeSplit.complete.appStateWrite",
  });

  assert.equal(harness.deferred.length, 1);
  assert.equal(harness.deferred[0][0], harness.transientError);
  assert.equal(harness.deferred[0][1], db);
  assert.deepEqual(harness.deferred[0][2].splitDomains, [
    "payments",
    "paymentContainers",
    "paymentParts",
    "paymentTransactions",
    "paymentProviderTransactions",
    "cashTxDenoms",
    "fiscalReceipts",
    "fiscalEvents",
    "commercialBenefitApplications",
    "commercialBenefitRedemptions",
    "integration",
    "posSettings",
    "auditEvents",
  ]);
  assert.deepEqual(harness.counters, [
    "paymentFreeSplitTransientMirrorDeferred",
  ]);
});

test("free split propaga il mirror fallito quando la durabilita primaria non consente il defer", async () => {
  const harness = createHarness({ deferResult: false });

  await assert.rejects(
    harness.writePaymentFreeSplitDb({ payments: [] }),
    (error) => error === harness.transientError,
  );
  assert.equal(harness.deferred.length, 1);
  assert.deepEqual(harness.counters, []);
});

test("free split differisce anche un mirror puntuale fallito con scope completo", async () => {
  const transientError = Object.assign(new Error("Record has changed"), {
    code: "ER_CHECKREAD",
    errno: 1020,
  });
  let paymentRecordsWritten = false;
  let deferredOptions = null;
  const writePaymentFreeSplitDb = createPaymentFreeSplitFastPath({
    dbMode: "mysql",
    mysqlAppStateDomainsSplitRepository: {
      enabled: true,
      syncObjectArrayEntriesAndObjectEntriesFromAppState: async () => {
        throw transientError;
      },
    },
    syncPosSettingsTablesFastPath: async () => {},
    syncOrderAuditEventsFastPath: async () => {},
    writePaymentDb: async () => {
      paymentRecordsWritten = true;
    },
    deferTransientMirror: async (_error, _db, options) => {
      deferredOptions = options;
      return true;
    },
  });

  await writePaymentFreeSplitDb(
    { integration: { orders: [{ id: "order-1" }] } },
    { orderIds: ["order-1"] },
  );

  assert.equal(paymentRecordsWritten, false);
  assert.ok(deferredOptions.splitDomains.includes("integration"));
  assert.ok(deferredOptions.splitDomains.includes("posSettings"));
  assert.ok(deferredOptions.splitDomains.includes("auditEvents"));
  assert.ok(deferredOptions.splitDomains.includes("payments"));
});

test("free split durable mirror aggiorna solo i record catturati", async () => {
  const calls = [];
  let broadWriteCalled = false;
  const counters = [];
  const writePaymentFreeSplitDb = createPaymentFreeSplitFastPath({
    dbMode: "mysql",
    mysqlAppStateDomainsSplitRepository: {
      enabled: true,
      syncObjectArrayEntriesAndObjectEntriesFromAppState: async (
        _db,
        domain,
        selection,
      ) => {
        calls.push(["integration-bulk", domain, selection]);
      },
      syncDomainArrayEntriesFromAppState: async (_db, domain, ids) => {
        calls.push(["domain-array", domain, ids]);
      },
    },
    syncPosSettingsTablesFastPath: async (_db, ids) => {
      calls.push(["tables", ids]);
    },
    syncOrderAuditEventsFastPath: async (_db, ids) => {
      calls.push(["audit", ids]);
    },
    writePaymentDb: async () => {
      broadWriteCalled = true;
    },
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
      recordOperation: () => {},
    },
  });

  await writePaymentFreeSplitDb(
    {
      payments: [{ id: "pay-1" }],
      paymentContainers: [{ id: "container-1" }],
      integration: { orders: [{ id: "order-1" }], lastWriteAt: "now" },
      posSettings: { tables: [{ id: "table-1" }] },
    },
    {
      orderIds: ["order-1"],
      tableIds: ["table-1"],
      auditEventIds: ["audit-1"],
      collectionEntryIds: {
        payments: ["pay-1"],
        paymentContainers: ["container-1"],
        unsupported: ["ignored"],
      },
      allowTransientDefer: false,
    },
  );

  assert.equal(broadWriteCalled, false);
  assert.deepEqual(
    calls.filter(([kind]) => kind === "domain-array"),
    [
      ["domain-array", "payments", ["pay-1"]],
      ["domain-array", "paymentContainers", ["container-1"]],
    ],
  );
  assert.deepEqual(counters, ["paymentFreeSplitPunctualMirrorWrites"]);
});

test("free split raggruppa i record pagamento in una transazione ordinata", async () => {
  const selections = [];
  const writePaymentFreeSplitDb = createPaymentFreeSplitFastPath({
    dbMode: "mysql",
    mysqlAppStateDomainsSplitRepository: {
      enabled: true,
      syncObjectArrayEntriesFromAppState: async () => {},
      syncObjectEntryFromAppState: async () => {},
      syncSelectedEntriesFromAppState: async (_db, selection, execution) => {
        selections.push({ selection, execution });
      },
    },
    syncOrderAuditEventsFastPath: async () => {},
    writePaymentDb: async () => assert.fail("fallback completo inatteso"),
  });

  await writePaymentFreeSplitDb(
    {
      payments: [{ id: "pay-1" }],
      paymentTransactions: [{ id: "tx-1" }],
    },
    {
      collectionEntryIds: {
        payments: ["pay-1"],
        paymentTransactions: ["tx-1"],
      },
    },
  );

  assert.deepEqual(selections, [
    {
      selection: {
        domainArrayEntries: [
          { domain: "payments", entryIds: ["pay-1"] },
          { domain: "paymentTransactions", entryIds: ["tx-1"] },
        ],
      },
      execution: {
        metricPrefix: "paymentFreeSplit.records",
        preserveNewerPaymentMirrorRecords: true,
      },
    },
  ]);
});

test("free split accorpa pagamenti, ordini, lastWriteAt e audit in un solo commit", async () => {
  const atomicCalls = [];
  const secondaryAuditCalls = [];
  const tableCalls = [];
  const counters = [];
  const operationLabels = [];
  const writePaymentFreeSplitDb = createPaymentFreeSplitFastPath({
    dbMode: "mysql",
    mysqlAppStateDomainsSplitRepository: { enabled: true },
    atomicSelectionWriter: {
      enabled: true,
      async write(db, request) {
        atomicCalls.push({ db, request });
        return { written: true, selectedRows: 5, changedRows: 5, auditRows: 1 };
      },
    },
    syncPosSettingsTablesFastPath: async (_db, ids) => tableCalls.push(ids),
    syncOrderAuditEventsFastPath: async () =>
      assert.fail("l'audit non deve aprire una transazione separata"),
    syncSecondaryAuditEventsFastPath: async (db, ids) =>
      secondaryAuditCalls.push({ db, ids }),
    writePaymentDb: async () =>
      assert.fail("il fallback pagamenti non deve essere usato"),
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
      recordOperation: (kind, label) => operationLabels.push(`${kind}:${label}`),
    },
  });
  const db = {
    payments: [{ id: "pay-1" }],
    paymentTransactions: [{ id: "tx-1" }],
    integration: {
      orders: [{ id: "order-1" }],
      lastWriteAt: "2026-08-06T08:00:00.000Z",
    },
    auditEvents: [{ id: "audit-1" }],
  };

  await writePaymentFreeSplitDb(db, {
    orderIds: ["order-1"],
    tableIds: ["table-1"],
    auditEventIds: ["audit-1"],
    collectionEntryIds: {
      payments: ["pay-1"],
      paymentTransactions: ["tx-1"],
    },
  });

  assert.equal(atomicCalls.length, 1);
  assert.equal(atomicCalls[0].db, db);
  assert.deepEqual(atomicCalls[0].request, {
    metricLabel: "paymentFreeSplit.atomicMirror",
    domainSelection: {
      domainArrayEntries: [
        { domain: "payments", entryIds: ["pay-1"] },
        { domain: "paymentTransactions", entryIds: ["tx-1"] },
      ],
      objectArrayEntries: [
        {
          domain: "integration",
          fieldName: "orders",
          entryIds: ["order-1"],
        },
      ],
      objectFields: [
        { domain: "integration", fieldNames: ["lastWriteAt"] },
      ],
    },
    auditEventIds: ["audit-1"],
    preserveNewerIntegrationRecords: true,
    preserveNewerPaymentMirrorRecords: true,
  });
  assert.deepEqual(secondaryAuditCalls, [
    { db, ids: ["audit-1"] },
  ]);
  assert.deepEqual(tableCalls, [["table-1"]]);
  assert.deepEqual(counters, [
    "paymentFreeSplitAtomicMirrorWrites",
  ]);
  assert.ok(
    operationLabels.includes(
      "paymentWorkflowStep:payments.freeSplit.mysql.atomicMirror",
    ),
  );
  assert.ok(
    operationLabels.includes(
      "paymentWorkflowStep:payments.freeSplit.audit.secondary",
    ),
  );
  assert.equal(
    operationLabels.some((label) =>
      /mysql\.(?:orders|lastWriteAt|paymentRecords)|\.audit$/.test(label),
    ),
    false,
  );
});

test("free split include l'aggiornamento provider senza ordini nel commit atomico", async () => {
  const atomicCalls = [];
  const secondaryAuditCalls = [];
  const counters = [];
  const writePaymentFreeSplitDb = createPaymentFreeSplitFastPath({
    dbMode: "mysql",
    mysqlAppStateDomainsSplitRepository: { enabled: true },
    atomicSelectionWriter: {
      enabled: true,
      async write(_db, request) {
        atomicCalls.push(request);
        return { written: true };
      },
    },
    syncPosSettingsTablesFastPath: async () =>
      assert.fail("nessun tavolo da sincronizzare"),
    syncOrderAuditEventsFastPath: async () =>
      assert.fail("l'audit MySQL e' nel commit atomico"),
    syncSecondaryAuditEventsFastPath: async (db, ids) =>
      secondaryAuditCalls.push({ db, ids }),
    writePaymentDb: async () =>
      assert.fail("il fallback pagamenti non deve essere usato"),
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
      recordOperation: () => {},
    },
  });

  const db = {
    paymentProviderTransactions: [{ transactionId: "provider-tx-1" }],
    integration: { lastWriteAt: "2026-08-06T08:00:00.000Z" },
    auditEvents: [{ id: "audit-provider-1" }],
  };

  await writePaymentFreeSplitDb(db, {
    auditEventIds: ["audit-provider-1"],
    collectionEntryIds: {
      paymentProviderTransactions: ["provider-tx-1"],
    },
  });

  assert.deepEqual(atomicCalls, [
    {
      metricLabel: "paymentFreeSplit.atomicMirror",
      domainSelection: {
        domainArrayEntries: [
          {
            domain: "paymentProviderTransactions",
            entryIds: ["provider-tx-1"],
          },
        ],
        objectArrayEntries: [],
        objectFields: [],
      },
      auditEventIds: ["audit-provider-1"],
      preserveNewerIntegrationRecords: true,
      preserveNewerPaymentMirrorRecords: true,
    },
  ]);
  assert.deepEqual(atomicCalls[0].domainSelection.objectArrayEntries, []);
  assert.deepEqual(atomicCalls[0].domainSelection.objectFields, []);
  assert.deepEqual(secondaryAuditCalls, [
    { db, ids: ["audit-provider-1"] },
  ]);
  assert.deepEqual(counters, ["paymentFreeSplitAtomicMirrorWrites"]);
});

test("free split richiede l'audit secondario prima di promuovere il path atomico", async () => {
  const calls = [];
  const writePaymentFreeSplitDb = createPaymentFreeSplitFastPath({
    dbMode: "mysql",
    atomicSelectionWriter: {
      enabled: true,
      async write() {
        calls.push(["atomic-inatteso"]);
        return { written: true };
      },
    },
    mysqlAppStateDomainsSplitRepository: {
      enabled: true,
      async syncObjectArrayEntriesAndObjectEntriesFromAppState(
        _db,
        domain,
        selection,
      ) {
        calls.push(["integration-bulk", domain, selection]);
      },
      async syncSelectedEntriesFromAppState(_db, selection, execution) {
        calls.push(["payment-bulk", selection, execution]);
      },
    },
    syncPosSettingsTablesFastPath: async () => {},
    syncOrderAuditEventsFastPath: async (_db, ids) => calls.push(["audit", ids]),
    writePaymentDb: async () => assert.fail("fallback completo inatteso"),
  });

  await writePaymentFreeSplitDb(
    {
      payments: [{ id: "pay-1" }],
      integration: {
        orders: [{ id: "order-1" }],
        lastWriteAt: "2026-08-06T08:00:00.000Z",
      },
      auditEvents: [{ id: "audit-1" }],
    },
    {
      orderIds: ["order-1"],
      auditEventIds: ["audit-1"],
      collectionEntryIds: { payments: ["pay-1"] },
    },
  );

  assert.deepEqual(calls[0], [
    "integration-bulk",
    "integration",
    {
      objectArrayEntries: [
        { fieldName: "orders", entryIds: ["order-1"] },
      ],
      objectFields: ["lastWriteAt"],
      preserveNewerIntegrationRecords: true,
    },
  ]);
  assert.deepEqual(calls.slice(1), [
    ["audit", ["audit-1"]],
    [
      "payment-bulk",
      {
        domainArrayEntries: [{ domain: "payments", entryIds: ["pay-1"] }],
      },
      {
        metricPrefix: "paymentFreeSplit.records",
        preserveNewerPaymentMirrorRecords: true,
      },
    ],
  ]);
});

test("free split durable mirror salta il tavolo solo su opzione gia validata", async () => {
  let tableSyncs = 0;
  const counters = [];
  const writePaymentFreeSplitDb = createPaymentFreeSplitFastPath({
    dbMode: "mysql",
    mysqlAppStateDomainsSplitRepository: {
      enabled: true,
      syncObjectArrayEntriesAndObjectEntriesFromAppState: async () => {},
      syncDomainArrayEntriesFromAppState: async () => {},
    },
    syncPosSettingsTablesFastPath: async () => {
      tableSyncs += 1;
    },
    syncOrderAuditEventsFastPath: async () => {},
    writePaymentDb: async () => {},
    runtimeMetrics: {
      incrementCounter: (name) => counters.push(name),
      recordOperation: () => {},
    },
  });

  await writePaymentFreeSplitDb(
    { integration: { orders: [{ id: "order-1" }] } },
    {
      orderIds: ["order-1"],
      tableIds: ["table-1"],
      collectionEntryIds: { payments: ["pay-1"] },
      skipPosSettingsTables: true,
    },
  );

  assert.equal(tableSyncs, 0);
  assert.deepEqual(counters, [
    "paymentMirrorPosSettingsTablesSkipped",
    "paymentFreeSplitPunctualMirrorWrites",
  ]);
});

test("free split propaga la priorita al coordinatore named lock", async () => {
  const lockCalls = [];
  const writePaymentFreeSplitDb = createPaymentFreeSplitFastPath({
    dbMode: "mysql",
    mysqlAppStateDomainsSplitRepository: { enabled: false },
    writePaymentDb: async () => {},
    namedLockCoordinator: {
      enabled: true,
      run: async (label, action, options) => {
        lockCalls.push({ label, options });
        return action();
      },
    },
  });

  await writePaymentFreeSplitDb({ payments: [] }, {
    namedLockPriority: "background",
  });

  assert.deepEqual(lockCalls, [
    { label: "paymentDomain", options: { priority: "background" } },
  ]);
});
