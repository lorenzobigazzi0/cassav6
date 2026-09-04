import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  createPostgresqlIdempotencyKeysRepository,
  createPostgresqlIdempotencyService,
  createPostgresqlRuntime,
  hashPostgresqlIdempotencyRequest,
} from "../../backend/db/postgresql/index.js";

assert.equal(
  process.env.MIG025_ALLOW_SMOKE,
  "1",
  "Impostare MIG025_ALLOW_SMOKE=1 solo sul database temporaneo dedicato.",
);
assert.match(
  String(process.env.POSTGRES_DATABASE ?? ""),
  /^cassav6_mig025_[a-z0-9_]+$/,
  "POSTGRES_DATABASE deve identificare un database temporaneo cassav6_mig025_*.",
);

const startedAt = performance.now();
const runtime = createPostgresqlRuntime({
  env: { ...process.env, BACKEND_POSTGRES_ENABLED: "1", POSTGRES_POOL_MAX: "12" },
  logger: { warn: (message) => console.error(message) },
});
const repository = createPostgresqlIdempotencyKeysRepository({ runtime });
const service = createPostgresqlIdempotencyService({ runtime, repository });

async function expectPgCode(action, code) {
  try {
    await action();
  } catch (error) {
    assert.equal(error?.code, code, error instanceof Error ? error.message : String(error));
    return;
  }
  assert.fail(`L'operazione doveva fallire con codice PostgreSQL ${code}.`);
}

async function countsFor(key) {
  return runtime.withConnection("mig025-counts", async (client) => {
    const result = await client.query(
      `
        SELECT
          (SELECT count(*)::integer FROM mig025_probe.business_rows WHERE idempotency_key = $1) AS business_count,
          (SELECT count(*)::integer FROM messaging.idempotency_keys WHERE key = $1) AS key_count
      `,
      [key],
    );
    return result.rows[0];
  });
}

try {
  const health = await runtime.checkHealth();
  assert.equal(health.ok, true);
  const metadata = await runtime.withConnection("mig025-metadata", async (client) => {
    const result = await client.query(`
      SELECT
        current_database() AS database,
        current_user AS user,
        current_setting('server_version') AS server_version
    `);
    return result.rows[0];
  });
  const privileges = await runtime.withConnection("mig025-privileges", async (client) => {
    const result = await client.query(`
      SELECT
        has_table_privilege(current_user, 'messaging.idempotency_keys', 'SELECT') AS can_select,
        has_table_privilege(current_user, 'messaging.idempotency_keys', 'INSERT') AS can_insert,
        has_table_privilege(current_user, 'messaging.idempotency_keys', 'UPDATE') AS can_update,
        has_table_privilege(current_user, 'messaging.idempotency_keys', 'DELETE') AS can_delete,
        has_table_privilege(current_user, 'messaging.idempotency_keys', 'TRUNCATE') AS can_truncate
    `);
    return result.rows[0];
  });
  assert.deepEqual(privileges, {
    can_select: true,
    can_insert: true,
    can_update: true,
    can_delete: false,
    can_truncate: false,
  });

  const request = { orderId: "order-concurrent", lines: [{ quantity: 1, sku: "coffee" }] };
  assert.equal(
    hashPostgresqlIdempotencyRequest(request),
    hashPostgresqlIdempotencyRequest({ lines: [{ sku: "coffee", quantity: 1 }], orderId: "order-concurrent" }),
  );
  let concurrentOperations = 0;
  const concurrencyStartedAt = performance.now();
  const concurrentResults = await Promise.all(
    Array.from({ length: 8 }, (_unused, index) => service.execute({
      scope: "orders.create",
      key: "idem-concurrent",
      request,
      async operation(client) {
        concurrentOperations += 1;
        await client.query("SELECT pg_sleep(0.05)");
        await client.query(
          `
            INSERT INTO mig025_probe.business_rows(id, idempotency_key, value)
            VALUES ($1, $2, $3)
          `,
          ["business-concurrent", "idem-concurrent", index + 1],
        );
        return { responseCode: 201, response: { orderId: "order-concurrent", accepted: true } };
      },
    })),
  );
  const concurrencyDurationMs = Math.round((performance.now() - concurrencyStartedAt) * 100) / 100;
  const concurrentStates = concurrentResults.reduce((summary, result) => {
    summary[result.state] = (summary[result.state] ?? 0) + 1;
    return summary;
  }, {});
  assert.deepEqual(concurrentStates, { executed: 1, replayed: 7 });
  assert.equal(concurrentOperations, 1);
  assert.equal(concurrentResults.every(({ responseCode }) => responseCode === 201), true);
  assert.equal(concurrentResults.every(({ response }) => response.orderId === "order-concurrent"), true);
  assert.deepEqual(await countsFor("idem-concurrent"), { business_count: 1, key_count: 1 });

  let conflictOperations = 0;
  const conflict = await service.execute({
    scope: "orders.create",
    key: "idem-concurrent",
    request: { orderId: "different-order" },
    async operation() {
      conflictOperations += 1;
      return { responseCode: 201, response: {} };
    },
  });
  assert.equal(conflict.state, "conflict");
  assert.equal(conflictOperations, 0);

  const scoped = await service.execute({
    scope: "payments.create",
    key: "idem-concurrent",
    request: { paymentId: "payment-1" },
    async operation(client) {
      await client.query(
        "INSERT INTO mig025_probe.business_rows(id, idempotency_key, value) VALUES ($1, $2, $3)",
        ["business-other-scope", "idem-concurrent", 2],
      );
      return { responseCode: 201, response: { paymentId: "payment-1" } };
    },
  });
  assert.equal(scoped.state, "executed");

  const rollbackError = new Error("MIG025_ROLLBACK_PROBE");
  await assert.rejects(service.execute({
    scope: "orders.create",
    key: "idem-rollback",
    request: { orderId: "rollback" },
    async operation(client) {
      await client.query(
        "INSERT INTO mig025_probe.business_rows(id, idempotency_key, value) VALUES ($1, $2, $3)",
        ["business-rollback", "idem-rollback", 3],
      );
      throw rollbackError;
    },
  }), (error) => error === rollbackError);
  assert.deepEqual(await countsFor("idem-rollback"), { business_count: 0, key_count: 0 });

  const retryAfterRollback = await service.execute({
    scope: "orders.create",
    key: "idem-rollback",
    request: { orderId: "rollback" },
    async operation(client) {
      await client.query(
        "INSERT INTO mig025_probe.business_rows(id, idempotency_key, value) VALUES ($1, $2, $3)",
        ["business-rollback-retry", "idem-rollback", 4],
      );
      return { responseCode: 201, response: { orderId: "rollback", retried: true } };
    },
  });
  assert.equal(retryAfterRollback.state, "executed");
  assert.deepEqual(await countsFor("idem-rollback"), { business_count: 1, key_count: 1 });

  let failedOperations = 0;
  const failedInput = {
    scope: "orders.validate",
    key: "idem-failed",
    request: { orderId: "invalid" },
    async operation() {
      failedOperations += 1;
      return { status: "failed", responseCode: 422, response: { code: "INVALID_ORDER" } };
    },
  };
  const failedFirst = await service.execute(failedInput);
  const failedReplay = await service.execute(failedInput);
  assert.equal(failedFirst.state, "executed");
  assert.equal(failedFirst.outcome, "failed");
  assert.equal(failedReplay.state, "replayed");
  assert.equal(failedReplay.outcome, "failed");
  assert.deepEqual(failedReplay.response, { code: "INVALID_ORDER" });
  assert.equal(failedOperations, 1);

  await expectPgCode(
    () => runtime.withTransaction("mig025-processing-commit-denied", (client) => repository.begin(client, {
      scope: "orders.create",
      key: "idem-unfinished",
      requestHash: hashPostgresqlIdempotencyRequest({ orderId: "unfinished" }),
    })),
    "55000",
  );
  assert.deepEqual(await countsFor("idem-unfinished"), { business_count: 0, key_count: 0 });

  await expectPgCode(
    () => runtime.withConnection("mig025-terminal-update-denied", (client) => client.query(`
      UPDATE messaging.idempotency_keys
      SET response_json = '{"tampered":true}'::jsonb
      WHERE scope = 'orders.create' AND key = 'idem-concurrent'
    `)),
    "55000",
  );
  await expectPgCode(
    () => runtime.withConnection("mig025-runtime-delete-denied", (client) => client.query(
      "DELETE FROM messaging.idempotency_keys WHERE scope = 'orders.create' AND key = 'idem-concurrent'",
    )),
    "42501",
  );
  await expectPgCode(
    () => runtime.withConnection("mig025-runtime-truncate-denied", (client) => client.query(
      "TRUNCATE messaging.idempotency_keys",
    )),
    "42501",
  );
  await expectPgCode(
    () => runtime.withConnection("mig025-invalid-hash", (client) => client.query(`
      INSERT INTO messaging.idempotency_keys(
        scope, key, request_hash, status, response_code, response_json,
        created_at, completed_at, expires_at
      ) VALUES (
        'orders.create', 'idem-invalid-hash', 'invalid', 'completed', 201, '{}'::jsonb,
        now(), now(), now() + interval '1 day'
      )
    `)),
    "23514",
  );

  const finalCounts = await runtime.withConnection("mig025-final-counts", async (client) => {
    const result = await client.query(`
      SELECT
        (SELECT count(*)::integer FROM mig025_probe.business_rows) AS business_rows,
        (SELECT count(*)::integer FROM messaging.idempotency_keys) AS idempotency_rows,
        (SELECT count(*)::integer FROM messaging.idempotency_keys WHERE status = 'processing') AS processing_rows
    `);
    return result.rows[0];
  });
  assert.deepEqual(finalCounts, { business_rows: 3, idempotency_rows: 4, processing_rows: 0 });

  console.log(JSON.stringify({
    ok: true,
    task: "MIG-025",
    scope: "DEV_ONLY_TEMPORARY_DATABASE",
    hardware: {
      hostname: process.env.MIG025_HOSTNAME ?? null,
      architecture: process.env.MIG025_ARCHITECTURE ?? null,
      storageDevice: process.env.MIG025_STORAGE_DEVICE ?? null,
      storageFilesystem: process.env.MIG025_STORAGE_FILESYSTEM ?? null,
    },
    metadata,
    privileges,
    concurrency: {
      callers: concurrentResults.length,
      ...concurrentStates,
      businessExecutions: concurrentOperations,
      deterministicResponses: concurrentResults.length,
      durationMs: concurrencyDurationMs,
    },
    conflict: { state: conflict.state, businessExecutions: conflictOperations },
    scopeIsolation: { sameKeyDifferentScope: scoped.state },
    rollbackRecovery: {
      afterFailure: { businessRows: 0, keyRows: 0 },
      retryState: retryAfterRollback.state,
    },
    terminalFailureReplay: {
      firstState: failedFirst.state,
      replayState: failedReplay.state,
      executions: failedOperations,
      responseCode: failedReplay.responseCode,
    },
    guards: {
      unfinishedCommitSqlState: "55000",
      runtimeTerminalUpdateSqlState: "55000",
      ownerTerminalUpdateSqlState: process.env.MIG025_OWNER_UPDATE_SQLSTATE ?? null,
      runtimeDeleteSqlState: "42501",
      runtimeTruncateSqlState: "42501",
      invalidHashSqlState: "23514",
    },
    finalCounts,
    totalDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  }, null, 2));
} finally {
  await runtime.close();
}
