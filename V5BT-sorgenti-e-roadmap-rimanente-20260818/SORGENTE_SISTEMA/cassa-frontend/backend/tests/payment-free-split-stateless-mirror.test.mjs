import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  closeRelationalConnection,
  FiscalOutboxRepository,
  openRelationalConnection,
  OrdersRelationalRepository,
  PaymentMirrorOutboxRepository,
  PaymentsRelationalRepository,
  runRelationalMigrations,
} from "../db/relational/index.js";
import { createPaymentFreeSplitDurableMirrorRuntime } from "../modules/payments/payment-free-split-durable-mirror.js";
import {
  beginPaymentFreeSplitMirrorCapture,
  buildPaymentFreeSplitMirrorPayload,
} from "../modules/payments/payment-free-split-mirror-payload.js";
import {
  buildPaymentFreeSplitStatelessMirror,
  canUsePaymentFreeSplitStatelessMirror,
} from "../modules/payments/payment-free-split-stateless-mirror.js";
import { createRuntimeMetrics } from "../modules/runtime-metrics.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

function createClock() {
  let currentMs = Date.parse("2026-07-14T10:00:00.000Z");
  return {
    nowIso: () => new Date(currentMs).toISOString(),
    advance(ms) {
      currentMs += ms;
    },
  };
}

function positionedPayload() {
  const state = {
    payments: [{ id: "pay-old-1" }, { id: "pay-old-2" }],
    auditEvents: [{ id: "audit-old" }],
    integration: {
      sequence: 7,
      orders: [
        { id: "order-old", workflowStatus: "delivered" },
        { id: "order-stateless", workflowStatus: "prep" },
      ],
      status: "online",
      lastWriteAt: "2026-07-14T09:59:00.000Z",
    },
    posSettings: {
      rooms: [],
      tables: [{ id: "table-stateless", totalDue: 1.3 }],
    },
  };
  const capture = beginPaymentFreeSplitMirrorCapture(state);
  state.payments.push({ id: "pay-stateless", amount: 1.3 });
  state.auditEvents.push({ id: "audit-stateless", action: "payment.created" });
  return buildPaymentFreeSplitMirrorPayload(state, {
    capture,
    aggregateId: "pay-stateless",
    idempotencyKey: "idem-stateless",
    orderIds: ["order-stateless"],
    tableIds: ["table-stateless"],
    occurredAt: "2026-07-14T10:00:00.000Z",
  });
}

function positionedMutablePayload() {
  const payload = positionedPayload();
  payload.collections.paymentProviderTransactions = [
    {
      id: "provider-stateless",
      position: 0,
      value: {
        transactionId: "provider-stateless",
        status: "settled",
        revision: 1,
        updatedAt: "2026-07-14T10:00:00.000Z",
      },
    },
  ];
  payload.collections.fiscalReceipts = [
    {
      id: "fiscal-stateless",
      position: 0,
      value: {
        id: "fiscal-stateless",
        paymentId: "tx-fiscal-stateless",
        status: "PENDING",
        fiscalStatus: "PENDING",
        attemptCount: 1,
        updatedAt: "2026-07-14T09:59:00.000Z",
      },
    },
  ];
  return payload;
}

function realisticMutablePayload() {
  const state = {
    paymentProviderTransactions: [
      {
        transactionId: "ptx-realistic",
        status: "created",
        revision: 1,
        updatedAt: "2026-07-14T09:58:00.000Z",
      },
    ],
    fiscalReceipts: [],
    auditEvents: [],
    integration: {
      sequence: 7,
      orders: [
        { id: "order-stateless", workflowStatus: "prep", currentRevision: 1 },
      ],
      lastWriteAt: "2026-07-14T09:59:00.000Z",
    },
    posSettings: {
      tables: [{ id: "table-stateless", totalDue: 1.3 }],
    },
  };
  const capture = beginPaymentFreeSplitMirrorCapture(state);
  state.paymentProviderTransactions[0] = {
    ...state.paymentProviderTransactions[0],
    status: "settled",
    revision: 3,
    updatedAt: "2026-07-14T10:01:00.000Z",
  };
  state.fiscalReceipts.push({
    id: "fiscal-realistic",
    paymentId: "tx-fiscal-realistic",
    status: "PENDING",
    fiscalStatus: "PENDING",
    attemptCount: 0,
    updatedAt: "2026-07-14T10:00:00.000Z",
  });
  state.auditEvents.push({ id: "audit-realistic", action: "payment.created" });
  return buildPaymentFreeSplitMirrorPayload(state, {
    capture,
    aggregateId: "pay-realistic",
    idempotencyKey: "idem-realistic",
    orderIds: ["order-stateless"],
    tableIds: ["table-stateless"],
    occurredAt: "2026-07-14T10:01:00.000Z",
    explicitIds: {
      paymentProviderTransactions: ["ptx-realistic"],
    },
  });
}

async function openDb(prefix, clock) {
  const runDir = await createTempRunDir(prefix);
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: path.join(runDir, "relational.sqlite"),
  });
  await runRelationalMigrations(db, { nowIso: clock.nowIso });
  new OrdersRelationalRepository(db).createOrder({
    id: "order-stateless",
    tableId: "table-stateless",
    roomId: "room-stateless",
    workflowStatus: "ready",
    currentRevision: 3,
    items: [],
  });
  return db;
}

function enqueue(db, clock, payload = positionedPayload()) {
  return new PaymentMirrorOutboxRepository(db, { nowIso: clock.nowIso }).enqueue({
    mirrorId: `payment-free-split:${payload.aggregateId}`,
    mirrorKind: "payment.free_split",
    aggregateId: payload.aggregateId,
    idempotencyKey: payload.idempotencyKey,
    payloadVersion: payload.version,
    payload,
  });
}

test("P4.3 consumer stateless conserva posizioni e usa l'ordine relazionale", () => {
  const payload = positionedPayload();
  assert.equal(canUsePaymentFreeSplitStatelessMirror(payload), true);

  const mirror = buildPaymentFreeSplitStatelessMirror(payload, {
    latestOrders: [{ id: "order-stateless", workflowStatus: "ready", currentRevision: 3 }],
  });

  assert.equal(mirror.appState.payments.length, 3);
  assert.equal(0 in mirror.appState.payments, false);
  assert.equal(1 in mirror.appState.payments, false);
  assert.equal(mirror.appState.payments[2].id, "pay-stateless");
  assert.equal(mirror.appState.auditEvents.length, 2);
  assert.equal(0 in mirror.appState.auditEvents, false);
  assert.equal(mirror.appState.auditEvents[1].id, "audit-stateless");
  assert.equal(Object.keys(mirror.appState.integration).indexOf("orders"), 1);
  assert.equal(Object.keys(mirror.appState.integration).indexOf("lastWriteAt"), 3);
  assert.equal(mirror.appState.integration.orders[1].workflowStatus, "ready");
  assert.equal(mirror.appState.integration.orders[1].currentRevision, 3);
  assert.equal(mirror.appState.posSettings, undefined);
  assert.deepEqual(mirror.mirrorOptions.collectionEntryIds, {
    payments: ["pay-stateless"],
  });
  assert.equal(mirror.mirrorOptions.skipPosSettingsTables, true);
  assert.equal(mirror.mirrorOptions.namedLockPriority, "background");
});

test("P4.3 consumer stateless rifiuta payload legacy e domini non puntuali", () => {
  const legacy = positionedPayload();
  delete legacy.collections.payments[0].position;
  assert.equal(canUsePaymentFreeSplitStatelessMirror(legacy), false);

  const printPayload = positionedPayload();
  printPayload.collections.printSpoolJobs = [
    { id: "print-1", position: 0, value: { id: "print-1" } },
  ];
  assert.equal(canUsePaymentFreeSplitStatelessMirror(printPayload), false);
});

test("P4.3 worker stateless non legge dbCache e non entra nella payment lane", async () => {
  const clock = createClock();
  const db = await openDb("p43-payment-stateless-worker", clock);
  try {
    enqueue(db, clock);
    const writes = [];
    let readCalls = 0;
    let laneCalls = 0;
    const metrics = createRuntimeMetrics({ enabled: true });
    const runtime = createPaymentFreeSplitDurableMirrorRuntime({
      enabled: true,
      stateless: true,
      skipPosSettingsTables: true,
      relationalRuntime: { db, initialize: async () => {} },
      readDb: async () => {
        readCalls += 1;
        throw new Error("readDb non consentito");
      },
      withPaymentLaneMutation: async () => {
        laneCalls += 1;
        throw new Error("payment lane non consentita");
      },
      writePaymentFreeSplitDb: async (appState, options) => writes.push({ appState, options }),
      nowIso: clock.nowIso,
      runtimeMetrics: metrics,
      logger: { info() {}, warn() {}, error() {} },
    });

    const result = await runtime.runBatch("stateless");
    assert.equal(result.results[0].status, "completed");
    assert.equal(readCalls, 0);
    assert.equal(laneCalls, 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].appState.integration.orders[1].workflowStatus, "ready");
    assert.equal(writes[0].options.allowTransientDefer, false);
    assert.equal(writes[0].options.namedLockPriority, "background");
    const counters = metrics.snapshot().counters;
    assert.equal(counters.paymentMirrorStatelessClaims, 1);
    assert.equal(counters.paymentMirrorStatelessWrites, 1);
    assert.equal(counters.paymentMirrorStatelessFallbacks, 0);
    assert.equal(counters.paymentMirrorLegacyClaims, 0);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 worker stateless ritenta se manca uno snapshot ordine relazionale", async () => {
  const clock = createClock();
  const db = await openDb("p43-payment-stateless-missing-order", clock);
  try {
    enqueue(db, clock);
    db.prepare("DELETE FROM orders WHERE id = ?").run("order-stateless");
    let writes = 0;
    const metrics = createRuntimeMetrics({ enabled: true });
    const runtime = createPaymentFreeSplitDurableMirrorRuntime({
      enabled: true,
      stateless: true,
      skipPosSettingsTables: true,
      relationalRuntime: { db, initialize: async () => {} },
      readDb: async () => assert.fail("readDb non deve essere invocato"),
      withPaymentLaneMutation: async () =>
        assert.fail("payment lane non deve essere invocata"),
      writePaymentFreeSplitDb: async () => {
        writes += 1;
      },
      nowIso: clock.nowIso,
      runtimeMetrics: metrics,
      logger: { info() {}, warn() {}, error() {} },
    });

    const result = await runtime.runBatch("missing-order");
    assert.equal(result.results[0].status, "retrying");
    assert.equal(
      result.results[0].error?.code,
      "PAYMENT_MIRROR_RELATIONAL_ORDER_SNAPSHOT_INCOMPLETE",
    );
    assert.equal(result.results[0].error?.retryable, true);
    assert.equal(writes, 0);
    const counters = metrics.snapshot().counters;
    assert.equal(counters.paymentMirrorStatelessClaims, 1);
    assert.equal(counters.paymentMirrorStatelessWrites, 0);
    assert.equal(counters.paymentMirrorStatelessFallbacks, 0);
    assert.equal(counters.paymentMirrorLegacyClaims, 0);
    assert.equal(counters.paymentMirrorRelationalOrderSnapshotMisses, 1);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 worker stateless usa provider finale e snapshot fiscale autoritativo", async () => {
  const clock = createClock();
  const db = await openDb("p43-payment-stateless-mutable-snapshots", clock);
  try {
    const payments = new PaymentsRelationalRepository(db);
    payments.createPaymentTransaction({
      id: "tx-fiscal-stateless",
      amountCents: 130,
      status: "settled",
      createdAt: "2026-07-14T09:59:00.000Z",
      rawJson: { id: "tx-fiscal-stateless", status: "settled" },
    });
    payments.createFiscalReceipt({
      id: "fiscal-stateless",
      paymentTransactionId: "tx-fiscal-stateless",
      fiscalProvider: "pos-fiscal-api",
      fiscalStatus: "ISSUED",
      issuedAt: "2026-07-14T10:02:00.000Z",
      rawJson: {
        id: "fiscal-stateless",
        status: "ISSUED",
        fiscalStatus: "ISSUED",
        attemptCount: 2,
        updatedAt: "2026-07-14T10:02:00.000Z",
      },
    });
    new FiscalOutboxRepository(db, { nowIso: clock.nowIso }).enqueue({
      fiscalId: "fiscal_out_fiscal-stateless",
      aggregateType: "fiscal_receipt",
      aggregateId: "fiscal-stateless",
      paymentId: "tx-fiscal-stateless",
      payload: {},
      status: "issued",
      attemptCount: 4,
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:03:00.000Z",
      issuedAt: "2026-07-14T10:03:00.000Z",
    });
    enqueue(db, clock, positionedMutablePayload());
    const writes = [];
    const runtime = createPaymentFreeSplitDurableMirrorRuntime({
      enabled: true,
      stateless: true,
      skipPosSettingsTables: true,
      relationalRuntime: { db, initialize: async () => {} },
      readDb: async () => assert.fail("readDb non deve essere invocato"),
      withPaymentLaneMutation: async () =>
        assert.fail("payment lane non deve essere invocata"),
      writePaymentFreeSplitDb: async (appState) => writes.push(appState),
      nowIso: clock.nowIso,
      runtimeMetrics: createRuntimeMetrics({ enabled: true }),
      logger: { info() {}, warn() {}, error() {} },
    });

    const result = await runtime.runBatch("mutable-snapshots");
    assert.equal(result.results[0].status, "completed");
    assert.equal(writes.length, 1);
    const provider = writes[0].paymentProviderTransactions[0];
    assert.equal(provider.transactionId, "provider-stateless");
    assert.equal(provider.status, "settled");
    assert.equal(provider.revision, 1);
    const fiscal = writes[0].fiscalReceipts[0];
    assert.equal(fiscal.status, "ISSUED");
    assert.equal(fiscal.fiscalStatus, "ISSUED");
    assert.equal(fiscal.attemptCount, 4);
    assert.equal(fiscal.updatedAt, "2026-07-14T10:03:00.000Z");
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 snapshot fiscale non degrada ISSUED durante il passaggio outbox PROCESSING", async () => {
  const clock = createClock();
  const db = await openDb("p43-payment-stateless-fiscal-transition", clock);
  try {
    const payments = new PaymentsRelationalRepository(db);
    payments.createPaymentTransaction({
      id: "tx-fiscal-stateless",
      amountCents: 130,
      status: "settled",
      createdAt: "2026-07-14T09:59:00.000Z",
      rawJson: { id: "tx-fiscal-stateless", status: "settled" },
    });
    payments.createFiscalReceipt({
      id: "fiscal-stateless",
      paymentTransactionId: "tx-fiscal-stateless",
      fiscalProvider: "pos-fiscal-api",
      fiscalStatus: "ISSUED",
      issuedAt: "2026-07-14T10:02:00.000Z",
      rawJson: {
        id: "fiscal-stateless",
        status: "ISSUED",
        fiscalStatus: "ISSUED",
        attemptCount: 2,
        updatedAt: "2026-07-14T10:02:00.000Z",
      },
    });
    new FiscalOutboxRepository(db, { nowIso: clock.nowIso }).enqueue({
      fiscalId: "fiscal_out_fiscal-stateless",
      aggregateType: "fiscal_receipt",
      aggregateId: "fiscal-stateless",
      paymentId: "tx-fiscal-stateless",
      payload: {},
      status: "processing",
      attemptCount: 3,
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:01:00.000Z",
    });
    enqueue(db, clock, positionedMutablePayload());
    const writes = [];
    const metrics = createRuntimeMetrics({ enabled: true });
    const runtime = createPaymentFreeSplitDurableMirrorRuntime({
      enabled: true,
      stateless: true,
      skipPosSettingsTables: true,
      relationalRuntime: { db, initialize: async () => {} },
      readDb: async () => assert.fail("readDb non deve essere invocato"),
      withPaymentLaneMutation: async () =>
        assert.fail("payment lane non deve essere invocata"),
      writePaymentFreeSplitDb: async (appState) => writes.push(appState),
      nowIso: clock.nowIso,
      runtimeMetrics: metrics,
      logger: { info() {}, warn() {}, error() {} },
    });

    const result = await runtime.runBatch("fiscal-transition");
    assert.equal(result.results[0].status, "completed");
    const fiscal = writes[0].fiscalReceipts[0];
    assert.equal(fiscal.status, "ISSUED");
    assert.equal(fiscal.fiscalStatus, "ISSUED");
    assert.equal(fiscal.attemptCount, 3);
    assert.equal(fiscal.updatedAt, "2026-07-14T10:02:00.000Z");
    assert.equal(
      metrics.snapshot().counters.paymentMirrorFiscalReceiptTerminalPrecedence,
      1,
    );
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 percorso realistico conserva provider finale e mapping fiscal_out", async () => {
  const clock = createClock();
  const db = await openDb("p43-payment-stateless-realistic-mapping", clock);
  try {
    const payload = realisticMutablePayload();
    assert.equal(
      payload.collections.paymentProviderTransactions[0].value.status,
      "settled",
    );
    assert.equal(
      payload.collections.paymentProviderTransactions[0].value.revision,
      3,
    );

    const payments = new PaymentsRelationalRepository(db);
    payments.createPaymentTransaction({
      id: "tx-fiscal-realistic",
      amountCents: 130,
      status: "settled",
      createdAt: "2026-07-14T09:59:00.000Z",
      rawJson: { id: "tx-fiscal-realistic", status: "settled" },
    });
    payments.createFiscalReceipt({
      id: "fiscal-realistic",
      paymentTransactionId: "tx-fiscal-realistic",
      fiscalProvider: "pos-fiscal-api",
      fiscalStatus: "ISSUED",
      issuedAt: "2026-07-14T10:02:00.000Z",
      rawJson: {
        id: "fiscal-realistic",
        status: "ISSUED",
        fiscalStatus: "ISSUED",
        attemptCount: 1,
        updatedAt: "2026-07-14T10:02:00.000Z",
      },
    });
    const fiscalOutbox = new FiscalOutboxRepository(db, {
      nowIso: clock.nowIso,
    });
    fiscalOutbox.enqueue({
      fiscalId: "fiscal_out_fiscal-realistic",
      aggregateType: "fiscal_receipt",
      aggregateId: "fiscal-realistic",
      paymentId: "tx-fiscal-realistic",
      payload: { receiptId: "fiscal-realistic" },
      status: "issued",
      attemptCount: 2,
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:03:00.000Z",
      issuedAt: "2026-07-14T10:03:00.000Z",
    });
    assert.equal(
      fiscalOutbox.getByAggregate("fiscal_receipt", "fiscal-realistic")
        ?.fiscalId,
      "fiscal_out_fiscal-realistic",
    );
    enqueue(db, clock, payload);
    const writes = [];
    const runtime = createPaymentFreeSplitDurableMirrorRuntime({
      enabled: true,
      stateless: true,
      skipPosSettingsTables: true,
      relationalRuntime: { db, initialize: async () => {} },
      readDb: async () => assert.fail("readDb non deve essere invocato"),
      withPaymentLaneMutation: async () =>
        assert.fail("payment lane non deve essere invocata"),
      writePaymentFreeSplitDb: async (appState) => writes.push(appState),
      nowIso: clock.nowIso,
      runtimeMetrics: createRuntimeMetrics({ enabled: true }),
      logger: { info() {}, warn() {}, error() {} },
    });

    const result = await runtime.runBatch("realistic-mapping");
    assert.equal(result.results[0].status, "completed");
    assert.equal(
      writes[0].paymentProviderTransactions[0].transactionId,
      "ptx-realistic",
    );
    assert.equal(writes[0].paymentProviderTransactions[0].status, "settled");
    assert.equal(writes[0].paymentProviderTransactions[0].revision, 3);
    assert.equal(writes[0].fiscalReceipts[0].id, "fiscal-realistic");
    assert.equal(writes[0].fiscalReceipts[0].status, "ISSUED");
    assert.equal(writes[0].fiscalReceipts[0].attemptCount, 2);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 worker stateless fallisce prima della write se manca lo snapshot fiscale", async () => {
  const clock = createClock();
  const db = await openDb("p43-payment-stateless-missing-fiscal", clock);
  try {
    enqueue(db, clock, positionedMutablePayload());
    let writes = 0;
    const metrics = createRuntimeMetrics({ enabled: true });
    const runtime = createPaymentFreeSplitDurableMirrorRuntime({
      enabled: true,
      stateless: true,
      skipPosSettingsTables: true,
      relationalRuntime: { db, initialize: async () => {} },
      readDb: async () => assert.fail("readDb non deve essere invocato"),
      withPaymentLaneMutation: async () =>
        assert.fail("payment lane non deve essere invocata"),
      writePaymentFreeSplitDb: async () => {
        writes += 1;
      },
      nowIso: clock.nowIso,
      runtimeMetrics: metrics,
      logger: { info() {}, warn() {}, error() {} },
    });

    const result = await runtime.runBatch("missing-fiscal");
    assert.equal(result.results[0].status, "retrying");
    assert.equal(
      result.results[0].error?.code,
      "PAYMENT_MIRROR_RELATIONAL_FISCAL_SNAPSHOT_INCOMPLETE",
    );
    assert.equal(result.results[0].error?.retryable, true);
    assert.equal(writes, 0);
    assert.equal(
      metrics.snapshot().counters.paymentMirrorRelationalRecordSnapshotMisses,
      1,
    );
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 worker stateless ritenta lo stesso snapshot posizionale", async () => {
  const clock = createClock();
  const db = await openDb("p43-payment-stateless-retry", clock);
  try {
    enqueue(db, clock);
    const observedPositions = [];
    let attempts = 0;
    const runtime = createPaymentFreeSplitDurableMirrorRuntime({
      enabled: true,
      stateless: true,
      skipPosSettingsTables: true,
      relationalRuntime: { db, initialize: async () => {} },
      readDb: async () => assert.fail("readDb non deve essere invocato"),
      withPaymentLaneMutation: async () => assert.fail("payment lane non deve essere invocata"),
      writePaymentFreeSplitDb: async (appState) => {
        attempts += 1;
        observedPositions.push(appState.payments.findIndex((entry) => entry?.id === "pay-stateless"));
        if (attempts === 1) throw Object.assign(new Error("deadlock simulato"), { code: "ER_LOCK_DEADLOCK" });
      },
      retryBaseMs: 10,
      retryMaxMs: 10,
      nowIso: clock.nowIso,
      runtimeMetrics: createRuntimeMetrics({ enabled: true }),
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal((await runtime.runBatch("first")).results[0].status, "retrying");
    clock.advance(11);
    assert.equal((await runtime.runBatch("retry")).results[0].status, "completed");
    assert.deepEqual(observedPositions, [2, 2]);
  } finally {
    closeRelationalConnection(db);
  }
});

test("P4.3 payload legacy usa il fallback protetto dalla payment lane", async () => {
  const clock = createClock();
  const db = await openDb("p43-payment-stateless-legacy", clock);
  try {
    const payload = positionedPayload();
    delete payload.collections.payments[0].position;
    enqueue(db, clock, payload);
    let readCalls = 0;
    let laneCalls = 0;
    const writes = [];
    const metrics = createRuntimeMetrics({ enabled: true });
    const runtime = createPaymentFreeSplitDurableMirrorRuntime({
      enabled: true,
      stateless: true,
      skipPosSettingsTables: true,
      relationalRuntime: { db, initialize: async () => {} },
      readDb: async () => {
        readCalls += 1;
        return {
          integration: { orders: [] },
          posSettings: { tables: [] },
          auditEvents: [],
        };
      },
      withPaymentLaneMutation: async (_label, _key, action) => {
        laneCalls += 1;
        return action();
      },
      writePaymentFreeSplitDb: async (_appState, options) => writes.push(options),
      nowIso: clock.nowIso,
      runtimeMetrics: metrics,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal((await runtime.runBatch("legacy")).results[0].status, "completed");
    assert.equal(readCalls, 1);
    assert.equal(laneCalls, 1);
    assert.equal(writes[0].namedLockPriority, "background");
    const counters = metrics.snapshot().counters;
    assert.equal(counters.paymentMirrorStatelessFallbacks, 1);
    assert.equal(counters.paymentMirrorLegacyClaims, 1);
  } finally {
    closeRelationalConnection(db);
  }
});
