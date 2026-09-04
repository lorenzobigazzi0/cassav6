import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  createPostgresqlEventOutboxRepository,
  createPostgresqlRuntime,
} from "../../backend/db/postgresql/index.js";
import {
  createPostgresqlEventOutboxWorker,
  definePostgresqlOutboxConsumer,
} from "../../backend/modules/messaging/event-outbox-worker.js";

assert.equal(
  process.env.MIG023_ALLOW_SMOKE,
  "1",
  "Impostare MIG023_ALLOW_SMOKE=1 solo sul database temporaneo dedicato.",
);
assert.match(
  String(process.env.POSTGRES_DATABASE ?? ""),
  /^cassav6_mig023_[a-z0-9_]+$/,
  "POSTGRES_DATABASE deve identificare un database temporaneo cassav6_mig023_*.",
);

const metricsCounters = new Map();
const startedAt = performance.now();
const runtime = createPostgresqlRuntime({
  env: { ...process.env, BACKEND_POSTGRES_ENABLED: "1" },
  logger: { warn: (message) => console.error(message) },
  runtimeMetrics: {
    incrementCounter(name) {
      metricsCounters.set(name, (metricsCounters.get(name) ?? 0) + 1);
    },
    recordOperation() {},
    setGauge() {},
  },
});
const repository = createPostgresqlEventOutboxRepository({ runtime });

async function enqueue(id, eventType = "probe.claim") {
  return runtime.withTransaction(`mig023-enqueue:${id}`, (client) =>
    repository.enqueue(client, {
      id,
      aggregateType: "mig023_probe",
      aggregateId: `aggregate-${id}`,
      eventType,
      payload: { id },
    }),
  );
}

async function markAllProcessed(events, owner) {
  return Promise.all(events.map((event) =>
    repository.markProcessed({ id: event.id, workerId: owner }),
  ));
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

try {
  const health = await runtime.checkHealth();
  assert.equal(health.ok, true);
  const metadata = await runtime.withConnection("mig023-metadata", async (client) => {
    const result = await client.query(`
      SELECT
        current_database() AS database,
        current_user AS user,
        current_setting('server_version') AS server_version
    `);
    return result.rows[0];
  });

  const claimIds = Array.from({ length: 12 }, (_, index) =>
    `mig023-claim-${String(index + 1).padStart(2, "0")}`,
  );
  await Promise.all(claimIds.map((id) => enqueue(id)));

  const concurrencyStartedAt = performance.now();
  const [workerAEvents, workerBEvents] = await Promise.all([
    repository.claimBatch({ workerId: "mig023-worker-a", batchSize: 6, leaseMs: 60_000 }),
    repository.claimBatch({ workerId: "mig023-worker-b", batchSize: 6, leaseMs: 60_000 }),
  ]);
  const concurrencyDurationMs = Math.round((performance.now() - concurrencyStartedAt) * 100) / 100;
  const workerAIds = new Set(workerAEvents.map(({ id }) => id));
  const workerBIds = new Set(workerBEvents.map(({ id }) => id));
  assert.equal(workerAEvents.length, 6);
  assert.equal(workerBEvents.length, 6);
  assert.equal([...workerAIds].some((id) => workerBIds.has(id)), false);
  assert.deepEqual([...workerAIds, ...workerBIds].sort(), claimIds);
  assert.equal([...workerAEvents, ...workerBEvents].every(({ attemptCount }) => attemptCount === 1), true);
  assert.equal(
    await repository.markProcessed({ id: workerAEvents[0].id, workerId: "mig023-worker-stale" }),
    null,
  );
  assert.equal((await markAllProcessed(workerAEvents, "mig023-worker-a")).every(Boolean), true);
  assert.equal((await markAllProcessed(workerBEvents, "mig023-worker-b")).every(Boolean), true);

  await enqueue("mig023-expired-lease", "probe.lease");
  const firstLease = await repository.claimBatch({
    workerId: "mig023-crashed-worker",
    batchSize: 1,
    leaseMs: 250,
  });
  assert.deepEqual(firstLease.map(({ id }) => id), ["mig023-expired-lease"]);
  assert.deepEqual(
    await repository.claimBatch({ workerId: "mig023-recovery-worker", batchSize: 1, leaseMs: 60_000 }),
    [],
  );
  const recoveryStartedAt = performance.now();
  await wait(350);
  const recovered = await repository.claimBatch({
    workerId: "mig023-recovery-worker",
    batchSize: 1,
    leaseMs: 60_000,
  });
  const recoveryDurationMs = Math.round((performance.now() - recoveryStartedAt) * 100) / 100;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, "mig023-expired-lease");
  assert.equal(recovered[0].attemptCount, 2);
  assert.equal(
    await repository.markProcessed({ id: recovered[0].id, workerId: "mig023-crashed-worker" }),
    null,
  );
  assert.ok(await repository.markProcessed({ id: recovered[0].id, workerId: "mig023-recovery-worker" }));

  await enqueue("mig023-idempotent-redelivery", "probe.idempotent");
  let deliveryCount = 0;
  const deliveredKeys = [];
  const consumer = definePostgresqlOutboxConsumer({
    eventTypes: ["probe.idempotent"],
    async consume(event, context) {
      deliveryCount += 1;
      deliveredKeys.push(context.idempotencyKey);
      await runtime.withConnection("mig023-idempotent-side-effect", (client) => client.query(
        `
          INSERT INTO mig023_probe.side_effects(event_id, idempotency_key, payload)
          VALUES ($1, $2, $3)
          ON CONFLICT (idempotency_key) DO NOTHING
        `,
        [event.id, context.idempotencyKey, event.payload],
      ));
      if (deliveryCount === 1) {
        throw Object.assign(new Error("crash simulato dopo side effect"), {
          code: "SIMULATED_CRASH_AFTER_SIDE_EFFECT",
        });
      }
    },
  });
  const worker = createPostgresqlEventOutboxWorker({
    repository,
    workerId: "mig023-idempotent-worker",
    batchSize: 1,
    leaseMs: 60_000,
    consumers: [consumer],
    retryDelayMs: () => 0,
    runtimeMetrics: {
      incrementCounter(name) {
        metricsCounters.set(name, (metricsCounters.get(name) ?? 0) + 1);
      },
      setGauge() {},
    },
  });
  assert.deepEqual(
    await worker.runOnce(),
    { claimed: 1, processed: 0, retried: 1, lostLease: 0 },
  );
  assert.deepEqual(
    await worker.runOnce(),
    { claimed: 1, processed: 1, retried: 0, lostLease: 0 },
  );
  assert.deepEqual(deliveredKeys, ["mig023-idempotent-redelivery", "mig023-idempotent-redelivery"]);
  const sideEffect = await runtime.withConnection("mig023-side-effect-count", async (client) => {
    const result = await client.query(`
      SELECT count(*)::integer AS count, min(idempotency_key) AS idempotency_key
      FROM mig023_probe.side_effects
      WHERE event_id = 'mig023-idempotent-redelivery'
    `);
    return result.rows[0];
  });
  assert.deepEqual(sideEffect, {
    count: 1,
    idempotency_key: "mig023-idempotent-redelivery",
  });
  const redeliveredEvent = await repository.getById("mig023-idempotent-redelivery");
  assert.equal(redeliveredEvent.attemptCount, 2);
  assert.ok(redeliveredEvent.processedAt);

  const constraints = await runtime.withConnection("mig023-constraints", async (client) => {
    const result = await client.query(`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conrelid = 'messaging.event_outbox'::regclass
        AND conname IN (
          'event_outbox_lease_pair_coherent',
          'event_outbox_processed_without_lease'
        )
      ORDER BY conname
    `);
    return result.rows;
  });
  assert.deepEqual(constraints, [
    { conname: "event_outbox_lease_pair_coherent", convalidated: true },
    { conname: "event_outbox_processed_without_lease", convalidated: true },
  ]);

  console.log(JSON.stringify({
    ok: true,
    task: "MIG-023",
    scope: "DEV_ONLY_TEMPORARY_DATABASE",
    hardware: {
      hostname: process.env.MIG023_HOSTNAME ?? null,
      architecture: process.env.MIG023_ARCHITECTURE ?? null,
      storageDevice: process.env.MIG023_STORAGE_DEVICE ?? null,
      storageFilesystem: process.env.MIG023_STORAGE_FILESYSTEM ?? null,
      servicesBefore: {
        postgresql: process.env.MIG023_POSTGRES_SERVICE ?? null,
        cassa: process.env.MIG023_CASSA_SERVICE ?? null,
      },
    },
    metadata,
    concurrentClaim: {
      events: claimIds.length,
      workerA: workerAEvents.length,
      workerB: workerBEvents.length,
      duplicateClaims: 0,
      durationMs: concurrencyDurationMs,
    },
    leaseRecovery: {
      eventId: recovered[0].id,
      attempts: recovered[0].attemptCount,
      staleCompletionRejected: true,
      recoveryDurationMs,
    },
    idempotentRedelivery: {
      deliveries: deliveryCount,
      stableIdempotencyKey: deliveredKeys[0],
      durableSideEffects: sideEffect.count,
      attempts: redeliveredEvent.attemptCount,
      processed: Boolean(redeliveredEvent.processedAt),
    },
    constraints,
    metrics: Object.fromEntries([...metricsCounters.entries()].sort(([left], [right]) => left.localeCompare(right))),
    totalDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  }, null, 2));
} finally {
  await runtime.close();
}
