import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { createPostgresqlRuntime } from "../../backend/db/postgresql/index.js";

assert.equal(
  process.env.MIG021_ALLOW_SMOKE,
  "1",
  "Impostare MIG021_ALLOW_SMOKE=1 solo sul database temporaneo dedicato.",
);
assert.match(
  String(process.env.POSTGRES_DATABASE ?? ""),
  /^cassav6_mig021_[a-z0-9_]+$/,
  "POSTGRES_DATABASE deve identificare un database temporaneo cassav6_mig021_*.",
);

const counters = new Map();
const operations = [];
const warnings = [];
const callbackRuns = new Map();
const startedAt = performance.now();
const runtime = createPostgresqlRuntime({
  env: { ...process.env, BACKEND_POSTGRES_ENABLED: "1" },
  logger: { warn: (message) => warnings.push(message) },
  runtimeMetrics: {
    incrementCounter(name) {
      counters.set(name, (counters.get(name) ?? 0) + 1);
    },
    recordOperation(kind, label, durationMs) {
      operations.push({
        durationMs: Math.round(Number(durationMs) * 100) / 100,
        kind,
        label,
      });
    },
    setGauge() {},
  },
});

let barrierArrivals = 0;
let releaseBarrier;
let rejectBarrier;
const firstAttemptBarrier = new Promise((resolve, reject) => {
  releaseBarrier = resolve;
  rejectBarrier = reject;
});
const barrierTimeout = setTimeout(() => {
  rejectBarrier(new Error("Timeout della barriera di concorrenza MIG-021."));
}, 5_000);

async function meetFirstAttemptBarrier() {
  barrierArrivals += 1;
  if (barrierArrivals === 2) {
    clearTimeout(barrierTimeout);
    releaseBarrier();
  }
  await firstAttemptBarrier;
}

async function concurrentIncrement(label) {
  return runtime.withTransaction(label, async (client, context) => {
    callbackRuns.set(label, (callbackRuns.get(label) ?? 0) + 1);
    const selected = await client.query(`
      SELECT value
      FROM mig021_smoke.counter
      WHERE id = 1
    `);
    assert.equal(selected.rows.length, 1);
    if (context.attempt === 1) await meetFirstAttemptBarrier();
    const nextValue = Number(selected.rows[0].value) + 1;
    await client.query(`
      UPDATE mig021_smoke.counter
      SET value = $1
      WHERE id = 1
    `, [nextValue]);
    return { attempt: context.attempt, label, nextValue };
  }, {
    baseDelayMs: 5,
    isolationLevel: "SERIALIZABLE",
    maxAttempts: 5,
    maxDelayMs: 20,
  });
}

try {
  const health = await runtime.checkHealth();
  assert.equal(health.ok, true);
  const metadata = await runtime.withConnection("mig021-metadata", async (client) => {
    const result = await client.query(`
      SELECT
        current_database() AS database,
        current_user AS user,
        current_setting('server_version') AS server_version
    `);
    return result.rows[0];
  });
  await runtime.withConnection("mig021-reset-counter", (client) => client.query(`
    UPDATE mig021_smoke.counter
    SET value = 0
    WHERE id = 1
  `));

  const concurrencyStartedAt = performance.now();
  const concurrencyResults = await Promise.all([
    concurrentIncrement("mig021-worker-a"),
    concurrentIncrement("mig021-worker-b"),
  ]);
  const concurrencyDurationMs = Math.round((performance.now() - concurrencyStartedAt) * 100) / 100;
  assert.deepEqual(
    concurrencyResults.map(({ attempt }) => attempt).sort((left, right) => left - right),
    [1, 2],
  );

  const valueAfterConcurrency = await runtime.withConnection(
    "mig021-value-after-concurrency",
    async (client) => Number((await client.query(`
      SELECT value
      FROM mig021_smoke.counter
      WHERE id = 1
    `)).rows[0].value),
  );
  assert.equal(valueAfterConcurrency, 2);

  const rollbackProbeError = new Error("MIG021_ROLLBACK_PROBE");
  await assert.rejects(
    runtime.withTransaction("mig021-rollback-probe", async (client) => {
      await client.query(`
        UPDATE mig021_smoke.counter
        SET value = value + 100
        WHERE id = 1
      `);
      throw rollbackProbeError;
    }),
    (error) => error === rollbackProbeError,
  );
  const valueAfterRollback = await runtime.withConnection(
    "mig021-value-after-rollback",
    async (client) => Number((await client.query(`
      SELECT value
      FROM mig021_smoke.counter
      WHERE id = 1
    `)).rows[0].value),
  );
  assert.equal(valueAfterRollback, 2);

  const retryOperations = operations.filter(({ kind }) => kind === "postgresTransactionRetryDelay");
  assert.equal(counters.get("postgresTransactionRetries"), 1);
  assert.equal(counters.get("postgresTransactionCommits"), 2);
  assert.equal(counters.get("postgresTransactionRollbacks"), 2);
  assert.equal(counters.get("postgresTransactionFailures"), 1);
  assert.deepEqual(retryOperations.map(({ label }) => label), ["40001"]);

  const report = {
    ok: true,
    task: "MIG-021",
    scope: "DEV_ONLY_TEMPORARY_DATABASE",
    metadata,
    concurrency: {
      barrierArrivals,
      callbackRuns: Object.fromEntries(callbackRuns),
      durationMs: concurrencyDurationMs,
      finalValue: valueAfterConcurrency,
      results: concurrencyResults,
      retrySqlStates: retryOperations.map(({ label }) => label),
    },
    rollback: {
      finalValue: valueAfterRollback,
      originalErrorPreserved: true,
    },
    metrics: {
      counters: Object.fromEntries([...counters.entries()].sort(([left], [right]) => left.localeCompare(right))),
      transactionOperations: operations.filter(({ kind }) => kind.startsWith("postgresTransaction")),
    },
    warnings,
    totalDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(barrierTimeout);
  await runtime.close();
}
