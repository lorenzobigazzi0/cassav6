import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import * as postgresql from "../db/postgresql/index.js";
import {
  createPostgresqlEventOutboxWorker,
  definePostgresqlOutboxConsumer,
} from "../modules/messaging/event-outbox-worker.js";

const {
  createPostgresqlEventOutboxRepository,
  POSTGRESQL_EVENT_OUTBOX_REPOSITORY_CONTRACT,
} = postgresql;

function row(overrides = {}) {
  return {
    id: "evt-1",
    aggregate_type: "order",
    aggregate_id: "order-1",
    event_type: "order.created",
    payload: { orderId: "order-1" },
    created_at: "2026-08-31T10:00:00.000Z",
    available_at: "2026-08-31T10:00:00.000Z",
    attempt_count: 1,
    lease_owner: "worker-a",
    lease_until: "2026-08-31T10:01:00.000Z",
    processed_at: null,
    last_error: null,
    ...overrides,
  };
}

function runtimeHarness(results = []) {
  const queries = [];
  const transactionLabels = [];
  const connectionLabels = [];
  const queue = [...results];
  const client = {
    async query(sql, parameters) {
      queries.push({ parameters, sql });
      return queue.shift() ?? { rowCount: 0, rows: [] };
    },
  };
  return {
    client,
    connectionLabels,
    queries,
    runtime: {
      async withConnection(label, callback) {
        connectionLabels.push(label);
        return callback(client);
      },
      async withTransaction(label, callback) {
        transactionLabels.push(label);
        return callback(client, { attempt: 1, maxAttempts: 3 });
      },
    },
    transactionLabels,
  };
}

function completeWorkerRepository(overrides = {}) {
  return {
    async claimBatch() { return []; },
    async enqueue() { return null; },
    async extendLease() { return null; },
    async getById() { return null; },
    async markProcessed() { return null; },
    async reschedule() { return null; },
    ...overrides,
  };
}

test("MIG-023 esporta un repository conforme con transazioni dichiarate", () => {
  assert.equal(typeof createPostgresqlEventOutboxRepository, "function");
  assert.equal(POSTGRESQL_EVENT_OUTBOX_REPOSITORY_CONTRACT.domain, "messaging.eventOutbox");
  assert.deepEqual(
    POSTGRESQL_EVENT_OUTBOX_REPOSITORY_CONTRACT.methods.map((method) => method.name),
    ["enqueue", "claimBatch", "extendLease", "markProcessed", "reschedule", "getById"],
  );
  assert.deepEqual(
    POSTGRESQL_EVENT_OUTBOX_REPOSITORY_CONTRACT.methods.map((method) => method.transaction),
    ["required", "required", "none", "none", "none", "none"],
  );
});

test("enqueue usa il client transazionale del chiamante senza aprire una seconda transazione", async () => {
  const harness = runtimeHarness([{ rowCount: 1, rows: [row({ attempt_count: 0, lease_owner: null, lease_until: null })] }]);
  const repository = createPostgresqlEventOutboxRepository({ runtime: harness.runtime });

  const event = await repository.enqueue(harness.client, {
    id: "evt-1",
    aggregateType: "order",
    aggregateId: "order-1",
    eventType: "order.created",
    payload: { orderId: "order-1" },
  });

  assert.equal(event.id, "evt-1");
  assert.equal(event.attemptCount, 0);
  assert.deepEqual(harness.transactionLabels, []);
  assert.deepEqual(harness.connectionLabels, []);
  assert.match(harness.queries[0].sql, /INSERT INTO messaging\.event_outbox/i);
  assert.doesNotMatch(harness.queries[0].sql, /\b(?:BEGIN|COMMIT|ROLLBACK)\b/i);
  assert.deepEqual(harness.queries[0].parameters, [
    "evt-1",
    "order",
    "order-1",
    "order.created",
    { orderId: "order-1" },
  ]);
});

test("claimBatch usa lease e FOR UPDATE SKIP LOCKED in una transazione breve", async () => {
  const harness = runtimeHarness([{
    rowCount: 2,
    rows: [row({ id: "evt-2", created_at: "2026-08-31T10:00:01.000Z" }), row()],
  }]);
  const repository = createPostgresqlEventOutboxRepository({ runtime: harness.runtime });

  const claimed = await repository.claimBatch({ workerId: "worker-a", leaseMs: 60_000, batchSize: 2 });

  assert.deepEqual(claimed.map(({ id }) => id), ["evt-1", "evt-2"]);
  assert.deepEqual(harness.transactionLabels, ["event-outbox:claim"]);
  assert.match(harness.queries[0].sql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(harness.queries[0].sql, /attempt_count\s*=\s*outbox\.attempt_count\s*\+\s*1/i);
  assert.match(harness.queries[0].sql, /lease_until\s*=\s*now\(\)/i);
  assert.deepEqual(harness.queries[0].parameters, ["worker-a", 60_000, 2]);
});

test("completamento, estensione e retry sono owner-bound e rendono visibile il lease perso", async () => {
  const harness = runtimeHarness([
    { rowCount: 1, rows: [row({ processed_at: "2026-08-31T10:00:10.000Z", lease_owner: null, lease_until: null })] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [row({ lease_until: "2026-08-31T10:02:00.000Z" })] },
    { rowCount: 1, rows: [row({ available_at: "2026-08-31T10:00:15.000Z", lease_owner: null, lease_until: null, last_error: "OUTBOX_TIMEOUT" })] },
  ]);
  const repository = createPostgresqlEventOutboxRepository({ runtime: harness.runtime });

  assert.equal((await repository.markProcessed({ id: "evt-1", workerId: "worker-a" })).processedAt, "2026-08-31T10:00:10.000Z");
  assert.equal(await repository.markProcessed({ id: "evt-1", workerId: "stale-worker" }), null);
  assert.equal((await repository.extendLease({ id: "evt-1", workerId: "worker-a", leaseMs: 60_000 })).leaseOwner, "worker-a");
  assert.equal((await repository.reschedule({ id: "evt-1", workerId: "worker-a", delayMs: 5_000, errorCode: "OUTBOX_TIMEOUT" })).lastError, "OUTBOX_TIMEOUT");

  assert.match(harness.queries[0].sql, /lease_owner\s*=\s*\$2/i);
  assert.match(harness.queries[0].sql, /lease_until\s*>\s*now\(\)/i);
  assert.match(harness.queries[2].sql, /lease_until\s*>\s*now\(\)/i);
  assert.match(harness.queries[3].sql, /available_at\s*=\s*now\(\)/i);
  assert.equal(harness.queries.every(({ sql }) => /RETURNING/i.test(sql)), true);
});

test("input non bounded viene rifiutato prima di acquisire connessioni", async () => {
  const harness = runtimeHarness();
  const repository = createPostgresqlEventOutboxRepository({ runtime: harness.runtime });

  await assert.rejects(repository.claimBatch({ workerId: "", batchSize: 1 }), /workerId/);
  await assert.rejects(repository.claimBatch({ workerId: "worker", batchSize: 101 }), /batchSize/);
  await assert.rejects(repository.claimBatch({ workerId: "worker", leaseMs: 99 }), /leaseMs/);
  await assert.rejects(repository.reschedule({ id: "evt-1", workerId: "worker", delayMs: -1 }), /delayMs/);
  await assert.rejects(repository.reschedule({ id: "evt-1", workerId: "worker", errorCode: "messaggio sensibile" }), /errorCode/);
  await assert.rejects(repository.markProcessed({ id: "evt-1", workerId: "bad owner spaces" }), /workerId/);
  await assert.rejects(repository.enqueue(harness.client, {
    id: "evt-invalid",
    aggregateType: "order",
    aggregateId: "order-1",
    eventType: "event type con spazi",
    payload: {},
  }), /eventType/);
  assert.deepEqual(harness.queries, []);
});

test("il worker accetta solo consumer dichiarati con idempotenza event.id", () => {
  assert.throws(
    () => createPostgresqlEventOutboxWorker({
      repository: completeWorkerRepository(),
      workerId: "worker-a",
      consumers: [{ eventTypes: ["order.created"], consume() {} }],
    }),
    /definePostgresqlOutboxConsumer/,
  );

  const consumer = definePostgresqlOutboxConsumer({
    eventTypes: ["order.created"],
    async consume() {},
  });
  assert.equal(consumer.idempotencyKey, "event.id");
  assert.equal(Object.isFrozen(consumer), true);
});

test("il worker esegue I/O dopo il claim e separa successo, retry e lease perso", async () => {
  const calls = [];
  const repository = completeWorkerRepository({
    async claimBatch() {
      calls.push("claim-committed");
      return [row(), row({ id: "evt-2", event_type: "order.failed", attempt_count: 2 })].map((value) => ({
        id: value.id,
        aggregateType: value.aggregate_type,
        aggregateId: value.aggregate_id,
        eventType: value.event_type,
        payload: value.payload,
        attemptCount: value.attempt_count,
      }));
    },
    async markProcessed(input) {
      calls.push(`processed:${input.id}`);
      return input.id === "evt-1" ? { id: input.id } : null;
    },
    async reschedule(input) {
      calls.push(`retry:${input.id}:${input.errorCode}:${input.delayMs}`);
      return input.id === "evt-2" ? { id: input.id } : null;
    },
  });
  const contexts = [];
  const consumer = definePostgresqlOutboxConsumer({
    eventTypes: ["order.created", "order.failed"],
    async consume(event, context) {
      calls.push(`consume:${event.id}`);
      contexts.push(context);
      if (event.id === "evt-2") {
        const error = new Error("payload sensibile da non persistere");
        error.code = "OUTBOX_TIMEOUT";
        throw error;
      }
    },
  });
  const worker = createPostgresqlEventOutboxWorker({
    repository,
    workerId: "worker-a",
    batchSize: 2,
    consumers: [consumer],
    retryDelayMs: ({ attemptCount }) => attemptCount * 100,
  });

  const summary = await worker.runOnce();

  assert.equal(calls[0], "claim-committed");
  assert.equal(calls.indexOf("consume:evt-1") > calls.indexOf("claim-committed"), true);
  assert.deepEqual(summary, { claimed: 2, processed: 1, retried: 1, lostLease: 0 });
  assert.deepEqual(contexts.map(({ idempotencyKey }) => idempotencyKey), ["evt-1", "evt-2"]);
  assert.equal(calls.includes("retry:evt-2:OUTBOX_TIMEOUT:200"), true);
  assert.equal(calls.join("|").includes("payload sensibile"), false);
});

test("una riconsegna dopo crash usa la stessa chiave e il side effect resta idempotente", async () => {
  let attempt = 0;
  let sideEffects = 0;
  const idempotencyLedger = new Set();
  const keys = [];
  const repository = completeWorkerRepository({
    async claimBatch() {
      attempt += 1;
      if (attempt > 2) return [];
      return [{
        id: "evt-crash",
        aggregateType: "order",
        aggregateId: "order-1",
        eventType: "order.created",
        payload: {},
        attemptCount: attempt,
      }];
    },
    async markProcessed() { return { id: "evt-crash" }; },
    async reschedule() { return { id: "evt-crash" }; },
  });
  const consumer = definePostgresqlOutboxConsumer({
    eventTypes: ["order.created"],
    async consume(_event, context) {
      keys.push(context.idempotencyKey);
      if (!idempotencyLedger.has(context.idempotencyKey)) {
        idempotencyLedger.add(context.idempotencyKey);
        sideEffects += 1;
      }
      if (attempt === 1) throw Object.assign(new Error("crash dopo side effect"), { code: "WORKER_CRASH" });
    },
  });
  const worker = createPostgresqlEventOutboxWorker({
    repository,
    workerId: "worker-a",
    consumers: [consumer],
    retryDelayMs: () => 0,
  });

  assert.deepEqual(await worker.runOnce(), { claimed: 1, processed: 0, retried: 1, lostLease: 0 });
  assert.deepEqual(await worker.runOnce(), { claimed: 1, processed: 1, retried: 0, lostLease: 0 });
  assert.deepEqual(keys, ["evt-crash", "evt-crash"]);
  assert.equal(sideEffects, 1);
});

test("migration MIG-023 vincola lease coerente e stato terminale senza lease", async () => {
  const sql = await fs.readFile(new URL("../db/postgresql/migrations/002_event_outbox_lease_contract.sql", import.meta.url), "utf8");
  assert.match(sql, /event_outbox_lease_pair_coherent/i);
  assert.match(sql, /\(lease_owner IS NULL\)\s*=\s*\(lease_until IS NULL\)/i);
  assert.match(sql, /event_outbox_processed_without_lease/i);
  assert.match(sql, /processed_at IS NULL[\s\S]+lease_owner IS NULL[\s\S]+lease_until IS NULL/i);
  assert.match(sql, /NOT VALID[\s\S]+VALIDATE CONSTRAINT/i);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im);
});
