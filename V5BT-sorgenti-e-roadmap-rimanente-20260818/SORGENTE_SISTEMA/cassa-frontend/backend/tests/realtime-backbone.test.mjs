import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  EventOutboxRepository,
  IdempotencyKeysRepository,
  closeRelationalConnection,
  hashIdempotencyRequest,
  openRelationalConnection,
  runRelationalMigrations,
  stableStringify,
  withTransactionalOutboxEvent,
} from "../db/relational/index.js";
import { normalizeRealtimeBackboneConfig } from "../modules/realtime-backbone/realtime-backbone.config.js";
import { createEventOutboxCoordinator } from "../modules/realtime-backbone/event-outbox.js";
import { createPaymentIdempotencyCoordinator } from "../modules/realtime-backbone/payment-idempotency.js";
import { createRuntimeMetrics } from "../modules/runtime-metrics.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

function nowIso() {
  return "2026-07-01T12:00:00.000Z";
}

function laterIso() {
  return "2026-07-01T13:00:00.000Z";
}

class TestHttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function relationalConfig(dbPath) {
  return {
    enabled: true,
    mode: "shadow",
    dbPath,
  };
}

async function openMigratedDb(name) {
  const runDir = await createTempRunDir(name);
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openRelationalConnection(relationalConfig(dbPath));
  await runRelationalMigrations(db, { nowIso });
  return db;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function indexExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
}

test("migrazione 010 crea idempotency_keys ed event_outbox", async () => {
  const db = await openMigratedDb("realtime-backbone-schema");
  try {
    assert.equal(tableExists(db, "idempotency_keys"), true);
    assert.equal(tableExists(db, "event_outbox"), true);
    assert.equal(indexExists(db, "idx_idempotency_keys_scope_expires"), true);
    assert.equal(indexExists(db, "idx_event_outbox_unpublished"), true);
    assert.equal(indexExists(db, "idx_event_outbox_scope_sequence"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("hash idempotenza e stabile rispetto all'ordine dei campi", () => {
  const left = { amount: 10, nested: { b: 2, a: 1 } };
  const right = { nested: { a: 1, b: 2 }, amount: 10 };

  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(hashIdempotencyRequest(left), hashIdempotencyRequest(right));
  assert.match(hashIdempotencyRequest(left), /^[a-f0-9]{64}$/);
});

test("IdempotencyKeysRepository deduplica retry uguali e blocca payload diversi", async () => {
  const db = await openMigratedDb("realtime-backbone-idempotency");
  try {
    const repo = new IdempotencyKeysRepository(db, { nowIso });
    const request = { tableId: "t1", amount: 25 };

    const first = repo.begin({
      key: "pay-t1-once",
      scope: "payment.table",
      request,
      expiresAt: laterIso(),
    });
    const retryWhileProcessing = repo.begin({
      key: "pay-t1-once",
      scope: "payment.table",
      request: { amount: 25, tableId: "t1" },
      expiresAt: laterIso(),
    });

    assert.equal(first.state, "created");
    assert.equal(retryWhileProcessing.state, "processing");

    repo.complete("pay-t1-once", { ok: true, paymentId: "pay_1" });
    const replay = repo.begin({
      key: "pay-t1-once",
      scope: "payment.table",
      request,
      expiresAt: laterIso(),
    });
    const conflict = repo.begin({
      key: "pay-t1-once",
      scope: "payment.table",
      request: { tableId: "t1", amount: 99 },
      expiresAt: laterIso(),
    });

    assert.equal(replay.state, "completed");
    assert.deepEqual(replay.response, { ok: true, paymentId: "pay_1" });
    assert.equal(conflict.state, "conflict");
  } finally {
    closeRelationalConnection(db);
  }
});

test("IdempotencyKeysRepository ricicla chiavi scadute", async () => {
  const db = await openMigratedDb("realtime-backbone-expiry");
  try {
    const repo = new IdempotencyKeysRepository(db, { nowIso });
    repo.begin({
      key: "expired-key",
      scope: "order.create",
      request: { orderId: "old" },
      expiresAt: "2026-07-01T11:00:00.000Z",
    });
    const fresh = repo.begin({
      key: "expired-key",
      scope: "order.create",
      request: { orderId: "new" },
      expiresAt: laterIso(),
    });

    assert.equal(fresh.state, "created");
    assert.equal(fresh.record.requestHash, hashIdempotencyRequest({ orderId: "new" }));
  } finally {
    closeRelationalConnection(db);
  }
});

test("PaymentIdempotencyCoordinator aggiorna metriche hit e conflitti", async () => {
  const db = await openMigratedDb("realtime-backbone-idempotency-metrics");
  try {
    const metrics = createRuntimeMetrics({ enabled: true, now: () => 1 });
    const coordinator = createPaymentIdempotencyCoordinator({
      enabled: true,
      relationalRuntime: { db },
      nowIso,
      metrics,
      HttpError: TestHttpError,
    });
    const payload = { tableId: "t1", amount: 12 };
    const claim = coordinator.begin({
      key: "metric-idem-1",
      scope: "payment.table",
      endpoint: "/api/payments/table",
      payload,
      user: { id: "u_admin" },
      session: { deviceUuid: "device-1", clientApp: "monitor-test" },
    });
    coordinator.complete(claim, { ok: true, paymentId: "pay_metric" });
    const replay = coordinator.begin({
      key: "metric-idem-1",
      scope: "payment.table",
      endpoint: "/api/payments/table",
      payload,
      user: { id: "u_admin" },
      session: { deviceUuid: "device-1", clientApp: "monitor-test" },
    });
    assert.equal(replay.replayed, true);
    assert.throws(
      () =>
        coordinator.begin({
          key: "metric-idem-1",
          scope: "payment.table",
          endpoint: "/api/payments/table",
          payload: { tableId: "t1", amount: 15 },
          user: { id: "u_admin" },
          session: { deviceUuid: "device-1", clientApp: "monitor-test" },
        }),
      /Idempotency key/,
    );

    const snapshot = metrics.snapshot();
    assert.equal(snapshot.counters.idempotencyStoreClaims, 3);
    assert.equal(snapshot.counters.idempotencyStoreCompleted, 1);
    assert.equal(snapshot.counters.idempotencyStoreHits, 1);
    assert.equal(snapshot.counters.idempotencyStoreConflicts, 1);
    assert.equal(snapshot.dashboard.idempotency.hitRate, 33.33);
  } finally {
    closeRelationalConnection(db);
  }
});

test("EventOutboxRepository assegna scope_sequence per scope e gestisce publish/retry", async () => {
  const db = await openMigratedDb("realtime-backbone-outbox");
  try {
    const repo = new EventOutboxRepository(db, { nowIso });
    const first = repo.enqueue({
      eventType: "order.created",
      aggregateType: "order",
      aggregateId: "order_1",
      scope: "room_main",
      payload: { orderId: "order_1" },
    });
    const second = repo.enqueue({
      eventType: "order.updated",
      aggregateType: "order",
      aggregateId: "order_1",
      scope: "room_main",
      payload: { status: "prep" },
    });
    const otherScope = repo.enqueue({
      eventType: "payment.status",
      aggregateType: "payment",
      aggregateId: "pay_1",
      scope: "room_bar",
      payload: { status: "completed" },
    });

    assert.equal(first.scopeSequence, 1);
    assert.equal(second.scopeSequence, 2);
    assert.equal(otherScope.scopeSequence, 1);
    assert.deepEqual(repo.listUnpublished({ limit: 2 }).map((event) => event.id), [first.id, second.id]);

    const failed = repo.markPublishFailed(first.id, new Error("sse closed"));
    assert.equal(failed.publishAttempts, 1);
    assert.equal(failed.lastError, "sse closed");

    const published = repo.markPublished(first.id, "2026-07-01T12:00:01.000Z");
    assert.equal(published.publishedAt, "2026-07-01T12:00:01.000Z");
    assert.equal(published.lastError, null);
    repo.markPublishFailed(second.id, new Error("retry later"));
    assert.equal(repo.countUnpublished(), 2);
    assert.deepEqual(repo.countSummary(), {
      unpublished: 2,
      published: 1,
      failedUnpublished: 1,
      oldestUnpublishedAt: "2026-07-01T12:00:00.000Z",
    });
    assert.equal(repo.deletePublishedBefore("2026-07-01T12:00:00.000Z"), 0);
    assert.equal(repo.deletePublishedBefore("2026-07-01T12:00:02.000Z"), 1);
    assert.deepEqual(repo.countSummary(), {
      unpublished: 2,
      published: 0,
      failedUnpublished: 1,
      oldestUnpublishedAt: "2026-07-01T12:00:00.000Z",
    });
  } finally {
    closeRelationalConnection(db);
  }
});

test("EventOutboxCoordinator puo accodare senza publish inline", async () => {
  const db = await openMigratedDb("realtime-backbone-enqueue-only");
  try {
    let publishCalls = 0;
    const coordinator = createEventOutboxCoordinator({
      enabled: true,
      relationalRuntime: { db },
      nowIso,
      canPublish: () => true,
      publish: () => {
        publishCalls += 1;
        return true;
      },
    });

    const result = coordinator.enqueueAndPublish(
      {
        eventType: "order.created",
        aggregateType: "order",
        aggregateId: "order_enqueue_only",
        scope: "room_main",
        payload: { orderId: "order_enqueue_only" },
      },
      { publish: false },
    );

    assert.equal(result.queued.aggregateId, "order_enqueue_only");
    assert.equal(result.publish.enqueueOnly, true);
    assert.equal(result.publish.skipped, 1);
    assert.equal(publishCalls, 0);
    assert.equal(new EventOutboxRepository(db, { nowIso }).countUnpublished(), 1);
  } finally {
    closeRelationalConnection(db);
  }
});

test("withTransactionalOutboxEvent scrive dominio e outbox nello stesso commit", async () => {
  const db = await openMigratedDb("realtime-backbone-transactional-outbox-success");
  try {
    db.exec("CREATE TABLE payment_write_probe (id TEXT PRIMARY KEY, status TEXT NOT NULL)");

    const result = withTransactionalOutboxEvent(db, {
      nowIso,
      paymentWrite(connection) {
        connection.prepare("INSERT INTO payment_write_probe (id, status) VALUES (?, ?)").run("payment_ok", "settled");
        return { id: "payment_ok", status: "settled" };
      },
      outboxEvent(domainResult) {
        return {
          eventType: "payment.status",
          aggregateType: "payment",
          aggregateId: domainResult.id,
          scope: "payments",
          payload: { status: domainResult.status },
        };
      },
    });

    assert.deepEqual(result.domainResult, { id: "payment_ok", status: "settled" });
    assert.equal(result.outboxEvent.eventType, "payment.status");
    assert.equal(result.outboxEvent.aggregateId, "payment_ok");
    assert.equal(result.outboxEvent.scopeSequence, 1);
    assert.deepEqual(result.outboxEvent.payload, { status: "settled" });
    const domainRow = db.prepare("SELECT * FROM payment_write_probe WHERE id = ?").get("payment_ok");
    assert.equal(domainRow.id, "payment_ok");
    assert.equal(domainRow.status, "settled");
  } finally {
    closeRelationalConnection(db);
  }
});

test("withTransactionalOutboxEvent fa rollback del dominio se fallisce l'insert outbox", async () => {
  const db = await openMigratedDb("realtime-backbone-transactional-outbox-rollback");
  try {
    db.exec(`
      CREATE TABLE payment_write_probe (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TRIGGER fail_event_outbox_insert
      BEFORE INSERT ON event_outbox
      BEGIN
        SELECT RAISE(FAIL, 'forced outbox failure');
      END;
    `);

    assert.throws(
      () =>
        withTransactionalOutboxEvent(db, {
          nowIso,
          paymentWrite(connection) {
            connection.prepare("INSERT INTO payment_write_probe (id, status) VALUES (?, ?)").run("payment_rollback", "settled");
            return { id: "payment_rollback" };
          },
          outboxEvent: {
            eventType: "payment.status",
            aggregateType: "payment",
            aggregateId: "payment_rollback",
            scope: "payments",
            payload: { status: "settled" },
          },
        }),
      /forced outbox failure/
    );

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payment_write_probe").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM event_outbox").get().count, 0);
  } finally {
    closeRelationalConnection(db);
  }
});

test("EventOutboxCoordinator aggiorna metriche runtime publish e retention", async () => {
  const db = await openMigratedDb("realtime-backbone-outbox-metrics");
  try {
    const metrics = createRuntimeMetrics({ enabled: true, now: () => 1 });
    const publishedPayloads = [];
    let shouldPublish = false;
    const coordinator = createEventOutboxCoordinator({
      enabled: true,
      relationalRuntime: { db },
      nowIso,
      metrics,
      canPublish: () => true,
      publish: (payload) => {
        if (!shouldPublish) return false;
        publishedPayloads.push(payload);
        return true;
      },
      retentionHours: 1,
      backlogMetricsIntervalMs: 60_000,
    });

    coordinator.enqueue({
      eventType: "order.created",
      aggregateType: "order",
      aggregateId: "order_metric",
      scope: "room_main",
      occurredAt: "2026-07-01T11:59:54.000Z",
      payload: { orderId: "order_metric" },
    });
    coordinator.publishPending();
    const afterQueued = metrics.snapshot();
    assert.equal(afterQueued.gauges.eventOutboxUnpublished, 1);
    assert.equal(afterQueued.gauges.eventOutboxLagMs, 6000);
    assert.equal(afterQueued.counters.eventOutboxBacklogMetricRefreshes, 1);
    assert.equal(afterQueued.counters.eventOutboxBacklogMetricSkips, 0);

    shouldPublish = true;
    const published = coordinator.publishPending();
    assert.equal(published.published, 1);
    assert.equal(publishedPayloads.length, 1);

    const afterPublish = metrics.snapshot();
    assert.equal(afterPublish.counters.eventOutboxPublishRuns, 2);
    assert.equal(afterPublish.counters.eventOutboxPublished, 1);
    assert.equal(afterPublish.gauges.eventOutboxUnpublished, 0);
    assert.equal(afterPublish.gauges.eventOutboxLagMs, 0);
    assert.equal(afterPublish.gauges.eventOutboxPublishedRows, 1);
    assert.equal(afterPublish.counters.eventOutboxBacklogMetricRefreshes, 1);
    assert.equal(afterPublish.counters.eventOutboxBacklogMetricSkips, 1);

    const cleanup = coordinator.cleanupPublished({ retentionHours: 1 });
    assert.equal(cleanup.deleted, 0);
    const afterCleanup = metrics.snapshot();
    assert.equal(afterCleanup.counters.eventOutboxRetentionRuns, 1);
    assert.equal(afterCleanup.counters.eventOutboxRetentionDeleted, 0);
    assert.equal(afterCleanup.counters.eventOutboxBacklogMetricRefreshes, 2);
  } finally {
    closeRelationalConnection(db);
  }
});

test("flag realtime backbone sono spenti di default e attivabili esplicitamente", () => {
  assert.deepEqual(normalizeRealtimeBackboneConfig({}), {
    idempotencyStoreEnabled: false,
    eventOutboxEnabled: false,
    replayEnabled: false,
  });
  assert.deepEqual(
    normalizeRealtimeBackboneConfig({
      IDEMPOTENCY_STORE_ENABLED: "1",
      EVENT_OUTBOX_ENABLED: "true",
      REALTIME_REPLAY_ENABLED: "1",
    }),
    {
      idempotencyStoreEnabled: true,
      eventOutboxEnabled: true,
      replayEnabled: true,
    }
  );
});
