import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  createPostgresqlRetentionRepository,
  createPostgresqlRuntime,
} from "../../backend/db/postgresql/index.js";

assert.equal(
  process.env.MIG026_ALLOW_SMOKE,
  "1",
  "Impostare MIG026_ALLOW_SMOKE=1 solo sul database temporaneo dedicato.",
);
assert.match(
  String(process.env.POSTGRES_DATABASE ?? ""),
  /^cassav6_mig026_[a-z0-9_]+$/,
  "POSTGRES_DATABASE deve identificare un database temporaneo cassav6_mig026_*.",
);

const startedAt = performance.now();
const runtime = createPostgresqlRuntime({
  env: { ...process.env, BACKEND_POSTGRES_ENABLED: "1" },
  logger: { warn: (message) => console.error(message) },
});
const repository = createPostgresqlRetentionRepository({ runtime });

async function expectPgCode(action, code) {
  try {
    await action();
  } catch (error) {
    assert.equal(error?.code, code, error instanceof Error ? error.message : String(error));
    return;
  }
  assert.fail(`L'operazione doveva fallire con codice PostgreSQL ${code}.`);
}

try {
  const health = await runtime.checkHealth();
  assert.equal(health.ok, true);
  const metadata = await runtime.withConnection("mig026-metadata", async (client) => {
    const result = await client.query(`
      SELECT
        current_database() AS database,
        current_user AS user,
        current_setting('server_version') AS server_version
    `);
    return result.rows[0];
  });

  const policies = await repository.listPolicies();
  const operationalPolicies = policies.filter(({ legallyRequired }) => !legallyRequired);
  const protectedPolicies = policies.filter(({ legallyRequired }) => legallyRequired);
  assert.equal(policies.length, 13);
  assert.equal(operationalPolicies.length, 8);
  assert.equal(protectedPolicies.length, 5);
  assert.equal(operationalPolicies.every(({ enabled, decisionRef }) => !enabled && decisionRef === "RET-01:TODO"), true);
  assert.equal(protectedPolicies.every(({ enabled, strategy, retentionDays }) => (
    !enabled && strategy === "none" && retentionDays === null
  )), true);

  const growth = await repository.getTableGrowth({ limit: 100 });
  const growthTargets = new Set(growth.map(({ schemaName, tableName }) => `${schemaName}.${tableName}`));
  for (const target of [
    "audit.events",
    "messaging.event_outbox",
    "messaging.idempotency_keys",
    "messaging.command_inbox",
  ]) {
    assert.equal(growthTargets.has(target), true, `Vista crescita priva di ${target}.`);
  }
  assert.equal(growth.every(({ totalBytes }) => Number.isFinite(totalBytes) && totalBytes >= 0), true);

  const candidates = await repository.getRetentionCandidates();
  assert.deepEqual(candidates.map(({ target }) => target), [
    "audit.events",
    "messaging.event_outbox",
    "messaging.idempotency_keys",
  ]);
  assert.equal(candidates.every(({ enabled, eligibleRows }) => !enabled && eligibleRows === 0), true);

  const privileges = await runtime.withConnection("mig026-privileges", async (client) => {
    const result = await client.query(`
      SELECT
        has_table_privilege(current_user, 'app_meta.retention_policies', 'SELECT') AS policy_select,
        has_table_privilege(current_user, 'app_meta.retention_policies', 'UPDATE') AS policy_update,
        has_table_privilege(current_user, 'app_meta.v_table_growth', 'SELECT') AS growth_select,
        has_function_privilege(current_user, 'app_meta.purge_processed_outbox(integer, boolean)', 'EXECUTE') AS outbox_purge_execute,
        has_function_privilege(current_user, 'app_meta.purge_expired_idempotency(integer, boolean)', 'EXECUTE') AS idempotency_purge_execute
    `);
    return result.rows[0];
  });
  assert.deepEqual(privileges, {
    policy_select: true,
    policy_update: false,
    growth_select: true,
    outbox_purge_execute: false,
    idempotency_purge_execute: false,
  });

  await expectPgCode(
    () => runtime.withConnection("mig026-runtime-policy-update-denied", (client) => client.query(`
      UPDATE app_meta.retention_policies SET enabled = true WHERE target = 'messaging.event_outbox'
    `)),
    "42501",
  );
  await expectPgCode(
    () => runtime.withConnection("mig026-runtime-purge-denied", (client) => client.query(
      "SELECT app_meta.purge_processed_outbox(10, true)",
    )),
    "42501",
  );

  const mainCounts = await runtime.withConnection("mig026-final-counts", async (client) => {
    const result = await client.query(`
      SELECT
        (SELECT count(*)::integer FROM audit.events) AS audit_rows,
        (SELECT count(*)::integer FROM messaging.event_outbox) AS outbox_rows,
        (SELECT count(*)::integer FROM messaging.idempotency_keys) AS idempotency_rows,
        (SELECT count(*)::integer FROM messaging.command_inbox) AS inbox_rows
    `);
    return result.rows[0];
  });
  assert.deepEqual(mainCounts, {
    audit_rows: 0,
    outbox_rows: 0,
    idempotency_rows: 0,
    inbox_rows: 0,
  });

  console.log(JSON.stringify({
    ok: true,
    task: "MIG-026",
    scope: "DEV_ONLY_TEMPORARY_DATABASE",
    mode: "CONTROL_PLANE_DISABLED",
    hardware: {
      hostname: process.env.MIG026_HOSTNAME ?? null,
      architecture: process.env.MIG026_ARCHITECTURE ?? null,
      storageDevice: process.env.MIG026_STORAGE_DEVICE ?? null,
      storageFilesystem: process.env.MIG026_STORAGE_FILESYSTEM ?? null,
    },
    metadata,
    policies: {
      total: policies.length,
      proposedDisabled: operationalPolicies.length,
      legallyProtected: protectedPolicies.length,
      enabled: policies.filter(({ enabled }) => enabled).length,
    },
    observability: {
      growthRelations: growth.length,
      candidateTargets: candidates.length,
      eligibleRowsAfterOwnerCleanup: candidates.reduce((sum, entry) => sum + entry.eligibleRows, 0),
    },
    privileges,
    runtimeGuards: {
      policyUpdateSqlState: "42501",
      purgeExecuteSqlState: "42501",
    },
    ownerTemporaryProbe: {
      disabledPolicySqlState: process.env.MIG026_OWNER_DISABLED_SQLSTATE ?? null,
      protectedPolicySqlState: process.env.MIG026_OWNER_PROTECTED_SQLSTATE ?? null,
      outboxDryRun: Number(process.env.MIG026_OUTBOX_DRY_RUN ?? -1),
      outboxDeleted: Number(process.env.MIG026_OUTBOX_DELETED ?? -1),
      outboxSecondPass: Number(process.env.MIG026_OUTBOX_SECOND_PASS ?? -1),
      idempotencyDryRun: Number(process.env.MIG026_IDEMPOTENCY_DRY_RUN ?? -1),
      idempotencyDeleted: Number(process.env.MIG026_IDEMPOTENCY_DELETED ?? -1),
      idempotencySecondPass: Number(process.env.MIG026_IDEMPOTENCY_SECOND_PASS ?? -1),
      preservedOutboxRows: Number(process.env.MIG026_PRESERVED_OUTBOX_ROWS ?? -1),
      preservedIdempotencyRows: Number(process.env.MIG026_PRESERVED_IDEMPOTENCY_ROWS ?? -1),
      resetToDisabled: process.env.MIG026_RESET_DISABLED === "true",
    },
    finalCounts: mainCounts,
    productionRetentionAuthorized: false,
    totalDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  }, null, 2));
} finally {
  await runtime.close();
}
