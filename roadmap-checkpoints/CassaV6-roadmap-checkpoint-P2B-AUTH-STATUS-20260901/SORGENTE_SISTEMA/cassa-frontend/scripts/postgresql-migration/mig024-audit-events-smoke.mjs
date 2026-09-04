import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  createPostgresqlAuditEventsRepository,
  createPostgresqlRuntime,
} from "../../backend/db/postgresql/index.js";

assert.equal(
  process.env.MIG024_ALLOW_SMOKE,
  "1",
  "Impostare MIG024_ALLOW_SMOKE=1 solo sul database temporaneo dedicato.",
);
assert.match(
  String(process.env.POSTGRES_DATABASE ?? ""),
  /^cassav6_mig024_[a-z0-9_]+$/,
  "POSTGRES_DATABASE deve identificare un database temporaneo cassav6_mig024_*.",
);

const startedAt = performance.now();
const runtime = createPostgresqlRuntime({
  env: { ...process.env, BACKEND_POSTGRES_ENABLED: "1" },
  logger: { warn: (message) => console.error(message) },
});
const repository = createPostgresqlAuditEventsRepository({ runtime });

async function expectPgCode(action, code) {
  try {
    await action();
  } catch (error) {
    assert.equal(error?.code, code, error instanceof Error ? error.message : String(error));
    return;
  }
  assert.fail(`L'operazione doveva fallire con codice PostgreSQL ${code}.`);
}

async function probeCounts(businessId, auditId) {
  return runtime.withConnection("mig024-probe-counts", async (client) => {
    const result = await client.query(
      `
        SELECT
          (SELECT count(*)::integer FROM mig024_probe.business_rows WHERE id = $1) AS business_count,
          (SELECT count(*)::integer FROM audit.events WHERE id = $2) AS audit_count
      `,
      [businessId, auditId],
    );
    return result.rows[0];
  });
}

try {
  const health = await runtime.checkHealth();
  assert.equal(health.ok, true);
  const metadata = await runtime.withConnection("mig024-metadata", async (client) => {
    const result = await client.query(`
      SELECT
        current_database() AS database,
        current_user AS user,
        current_setting('server_version') AS server_version
    `);
    return result.rows[0];
  });
  const privileges = await runtime.withConnection("mig024-privileges", async (client) => {
    const result = await client.query(`
      SELECT
        has_table_privilege(current_user, 'audit.events', 'SELECT') AS can_select,
        has_table_privilege(current_user, 'audit.events', 'INSERT') AS can_insert,
        has_table_privilege(current_user, 'audit.events', 'UPDATE') AS can_update,
        has_table_privilege(current_user, 'audit.events', 'DELETE') AS can_delete,
        has_table_privilege(current_user, 'audit.events', 'TRUNCATE') AS can_truncate
    `);
    return result.rows[0];
  });
  assert.deepEqual(privileges, {
    can_select: true,
    can_insert: true,
    can_update: false,
    can_delete: false,
    can_truncate: false,
  });

  const commitStartedAt = performance.now();
  const committed = await runtime.withTransaction("mig024-atomic-commit", async (client) => {
    await client.query(
      "INSERT INTO mig024_probe.business_rows(id, value) VALUES ($1, $2)",
      ["business-commit", 1],
    );
    return repository.append(client, {
      id: "audit-commit",
      domain: "mig024",
      aggregateType: "probe",
      aggregateId: "business-commit",
      action: "probe.committed",
      actorUserId: "user-1",
      actorUsername: "admin",
      payload: { value: 1 },
    });
  });
  const commitDurationMs = Math.round((performance.now() - commitStartedAt) * 100) / 100;
  assert.equal(committed.id, "audit-commit");
  assert.deepEqual(await probeCounts("business-commit", "audit-commit"), {
    business_count: 1,
    audit_count: 1,
  });

  const rollbackStartedAt = performance.now();
  const rollbackProbe = new Error("MIG024_ROLLBACK_PROBE");
  await assert.rejects(
    runtime.withTransaction("mig024-atomic-rollback", async (client) => {
      await client.query(
        "INSERT INTO mig024_probe.business_rows(id, value) VALUES ($1, $2)",
        ["business-rollback", 2],
      );
      await repository.append(client, {
        id: "audit-rollback",
        domain: "mig024",
        aggregateType: "probe",
        aggregateId: "business-rollback",
        action: "probe.rolled_back",
        payload: { value: 2 },
      });
      throw rollbackProbe;
    }),
    (error) => error === rollbackProbe,
  );
  const rollbackDurationMs = Math.round((performance.now() - rollbackStartedAt) * 100) / 100;
  assert.deepEqual(await probeCounts("business-rollback", "audit-rollback"), {
    business_count: 0,
    audit_count: 0,
  });

  await runtime.withTransaction("mig024-conflict-seed", (client) =>
    repository.append(client, {
      id: "audit-conflict",
      domain: "mig024",
      aggregateType: "probe",
      aggregateId: "conflict-seed",
      action: "probe.seeded",
      payload: {},
    }),
  );
  const auditFailureStartedAt = performance.now();
  await assert.rejects(
    runtime.withTransaction("mig024-audit-required", async (client) => {
      await client.query(
        "INSERT INTO mig024_probe.business_rows(id, value) VALUES ($1, $2)",
        ["business-audit-failure", 3],
      );
      await repository.append(client, {
        id: "audit-conflict",
        domain: "mig024",
        aggregateType: "probe",
        aggregateId: "business-audit-failure",
        action: "probe.must_not_commit",
        payload: {},
      });
    }),
    (error) => error?.code === "23505",
  );
  const auditFailureDurationMs = Math.round((performance.now() - auditFailureStartedAt) * 100) / 100;
  assert.equal(
    (await probeCounts("business-audit-failure", "audit-conflict")).business_count,
    0,
  );

  const loaded = await repository.getById("audit-commit");
  assert.equal(loaded.action, "probe.committed");
  const aggregateEvents = await repository.listByAggregate({
    aggregateType: "probe",
    aggregateId: "business-commit",
    limit: 10,
  });
  assert.deepEqual(aggregateEvents.map(({ id }) => id), ["audit-commit"]);

  await expectPgCode(
    () => runtime.withConnection("mig024-runtime-update-denied", (client) =>
      client.query("UPDATE audit.events SET action = 'tampered' WHERE id = 'audit-commit'")),
    "42501",
  );
  await expectPgCode(
    () => runtime.withConnection("mig024-runtime-delete-denied", (client) =>
      client.query("DELETE FROM audit.events WHERE id = 'audit-commit'")),
    "42501",
  );
  await expectPgCode(
    () => runtime.withConnection("mig024-runtime-truncate-denied", (client) =>
      client.query("TRUNCATE audit.events")),
    "42501",
  );
  await expectPgCode(
    () => runtime.withConnection("mig024-payload-object-constraint", (client) => client.query(`
      INSERT INTO audit.events(id, domain, action, payload)
      VALUES ('audit-array-payload', 'mig024', 'probe.invalid', '[]'::jsonb)
    `)),
    "23514",
  );
  await expectPgCode(
    () => runtime.withConnection("mig024-aggregate-pair-constraint", (client) => client.query(`
      INSERT INTO audit.events(id, domain, aggregate_type, action, payload)
      VALUES ('audit-half-aggregate', 'mig024', 'probe', 'probe.invalid', '{}'::jsonb)
    `)),
    "23514",
  );

  const finalCounts = await runtime.withConnection("mig024-final-counts", async (client) => {
    const result = await client.query(`
      SELECT
        (SELECT count(*)::integer FROM mig024_probe.business_rows) AS business_rows,
        (SELECT count(*)::integer FROM audit.events WHERE domain = 'mig024') AS repository_audit_rows
    `);
    return result.rows[0];
  });
  assert.deepEqual(finalCounts, { business_rows: 1, repository_audit_rows: 2 });

  console.log(JSON.stringify({
    ok: true,
    task: "MIG-024",
    scope: "DEV_ONLY_TEMPORARY_DATABASE",
    hardware: {
      hostname: process.env.MIG024_HOSTNAME ?? null,
      architecture: process.env.MIG024_ARCHITECTURE ?? null,
      storageDevice: process.env.MIG024_STORAGE_DEVICE ?? null,
      storageFilesystem: process.env.MIG024_STORAGE_FILESYSTEM ?? null,
    },
    metadata,
    privileges,
    atomicity: {
      commit: { businessRows: 1, auditRows: 1, durationMs: commitDurationMs },
      rollbackAfterAudit: { businessRows: 0, auditRows: 0, durationMs: rollbackDurationMs },
      auditFailureRollback: { businessRows: 0, sqlState: "23505", durationMs: auditFailureDurationMs },
    },
    appendOnly: {
      runtimeUpdateSqlState: "42501",
      runtimeDeleteSqlState: "42501",
      runtimeTruncateSqlState: "42501",
      ownerUpdateSqlState: process.env.MIG024_OWNER_UPDATE_SQLSTATE ?? null,
      ownerDeleteSqlState: process.env.MIG024_OWNER_DELETE_SQLSTATE ?? null,
      ownerTruncateSqlState: process.env.MIG024_OWNER_TRUNCATE_SQLSTATE ?? null,
    },
    constraints: {
      aggregatePairSqlState: "23514",
      payloadObjectSqlState: "23514",
    },
    finalCounts,
    totalDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  }, null, 2));
} finally {
  await runtime.close();
}

