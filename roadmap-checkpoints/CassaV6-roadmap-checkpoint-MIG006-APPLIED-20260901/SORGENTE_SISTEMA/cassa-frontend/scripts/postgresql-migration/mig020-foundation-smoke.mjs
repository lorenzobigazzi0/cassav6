import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import pg from "pg";

import {
  createPostgresqlRuntime,
  discoverPostgresqlMigrations,
  runPostgresqlMigrations,
} from "../../backend/db/postgresql/index.js";

const { Client } = pg;
const verifyOnly = process.argv.includes("--verify-only");
const appUser = String(process.env.MIG020_APP_USER ?? "cassav6_app").trim();
const runtimeRole = String(process.env.MIG020_RUNTIME_ROLE ?? "cassav6_runtime").trim();

function connectionConfig(user, password) {
  return {
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.POSTGRES_PORT ?? "5432", 10),
    database: process.env.POSTGRES_DATABASE ?? "cassav6",
    user,
    password,
    ssl: false,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    application_name: verifyOnly ? "cassav6-mig020-verify" : "cassav6-mig020-smoke",
  };
}

async function expectPgCode(action, code) {
  try {
    await action();
  } catch (error) {
    assert.equal(error?.code, code, error instanceof Error ? error.message : String(error));
    return;
  }
  assert.fail(`L'operazione doveva fallire con codice PostgreSQL ${code}.`);
}

async function inspectFoundation(runtime, expectedMigrations) {
  return runtime.withConnection("mig020-inspection", async (client) => {
    const schemas = await client.query(`
      SELECT nspname
      FROM pg_namespace
      WHERE nspname IN ('app_meta', 'audit', 'messaging')
      ORDER BY nspname
    `);
    const tables = await client.query(`
      SELECT schemaname, tablename, tableowner
      FROM pg_tables
      WHERE (schemaname, tablename) IN (
        ('app_meta', 'schema_migrations'),
        ('audit', 'event_ids'),
        ('audit', 'events'),
        ('messaging', 'idempotency_keys'),
        ('messaging', 'command_inbox'),
        ('messaging', 'event_outbox')
      )
      ORDER BY schemaname, tablename
    `);
    const indexes = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname IN ('audit', 'messaging')
      ORDER BY indexname
    `);
    const attemptConstraint = await client.query(`
      SELECT count(*)::integer AS count
      FROM pg_constraint
      WHERE conrelid = 'messaging.event_outbox'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ~ 'attempt_count.*>= 0'
    `);
    const auditPartitioning = await client.query(`
      SELECT
        parent.relkind AS parent_kind,
        count(*) FILTER (WHERE tree.isleaf)::integer AS leaf_partitions,
        bool_or(pg_get_expr(child.relpartbound, child.oid) = 'DEFAULT') AS has_default
      FROM pg_class parent
      CROSS JOIN LATERAL pg_partition_tree(parent.oid) tree
      JOIN pg_class child ON child.oid = tree.relid
      WHERE parent.oid = 'audit.events'::regclass
      GROUP BY parent.relkind
    `);
    const registry = await client.query(`
      SELECT version, checksum
      FROM app_meta.schema_migrations
      ORDER BY version
    `);
    const privileges = await client.query(`
      SELECT
        pg_has_role($1, $2, 'MEMBER') AS app_is_runtime_member,
        has_schema_privilege($1, 'app_meta', 'USAGE') AS app_meta_usage,
        has_schema_privilege($1, 'audit', 'USAGE') AS audit_usage,
        has_schema_privilege($1, 'audit', 'CREATE') AS audit_create,
        has_schema_privilege($1, 'messaging', 'USAGE') AS messaging_usage,
        has_schema_privilege($1, 'messaging', 'CREATE') AS messaging_create,
        has_table_privilege($1, 'audit.events', 'SELECT') AS audit_select,
        has_table_privilege($1, 'audit.events', 'INSERT') AS audit_insert,
        has_table_privilege($1, 'audit.events', 'UPDATE') AS audit_update,
        has_table_privilege($1, 'audit.events', 'DELETE') AS audit_delete,
        has_table_privilege($1, 'audit.event_ids', 'SELECT') AS audit_id_select,
        has_table_privilege($1, 'audit.event_ids', 'INSERT') AS audit_id_insert,
        has_function_privilege(
          $1,
          'audit.ensure_event_month_partitions(date, date)',
          'EXECUTE'
        ) AS audit_partition_execute,
        has_table_privilege($1, 'messaging.event_outbox', 'SELECT') AS outbox_select,
        has_table_privilege($1, 'messaging.event_outbox', 'INSERT') AS outbox_insert,
        has_table_privilege($1, 'messaging.event_outbox', 'UPDATE') AS outbox_update,
        has_table_privilege($1, 'messaging.event_outbox', 'DELETE') AS outbox_delete
    `, [appUser, runtimeRole]);
    const roles = await client.query(`
      SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit
      FROM pg_roles
      WHERE rolname IN ($1, $2)
      ORDER BY rolname
    `, [appUser, runtimeRole]);

    assert.deepEqual(schemas.rows.map(({ nspname }) => nspname), ["app_meta", "audit", "messaging"]);
    assert.deepEqual(
      tables.rows.map(({ schemaname, tablename }) => `${schemaname}.${tablename}`),
      [
        "app_meta.schema_migrations",
        "audit.event_ids",
        "audit.events",
        "messaging.command_inbox",
        "messaging.event_outbox",
        "messaging.idempotency_keys",
      ],
    );
    assert.equal(tables.rows.every(({ tableowner }) => tableowner === process.env.POSTGRES_USER), true);
    for (const indexName of [
      "audit_events_aggregate_time_idx",
      "audit_events_id_lookup_idx",
      "audit_events_occurred_at_idx",
      "event_outbox_claimable_idx",
      "event_outbox_lease_idx",
      "idempotency_expiry_idx",
    ]) {
      assert.equal(indexes.rows.some(({ indexname }) => indexname === indexName), true, indexName);
    }
    assert.equal(attemptConstraint.rows[0].count, 1);
    assert.equal(auditPartitioning.rows[0].parent_kind, "p");
    assert.ok(auditPartitioning.rows[0].leaf_partitions >= 16);
    assert.equal(auditPartitioning.rows[0].has_default, true);
    assert.deepEqual(registry.rows, expectedMigrations);
    assert.deepEqual(privileges.rows[0], {
      app_is_runtime_member: true,
      app_meta_usage: true,
      audit_usage: true,
      audit_create: false,
      messaging_usage: true,
      messaging_create: false,
      audit_select: true,
      audit_insert: true,
      audit_update: false,
      audit_delete: false,
      audit_id_select: true,
      audit_id_insert: false,
      audit_partition_execute: false,
      outbox_select: true,
      outbox_insert: true,
      outbox_update: true,
      outbox_delete: false,
    });
    assert.equal(roles.rows.length, 2);
    const appRole = roles.rows.find(({ rolname }) => rolname === appUser);
    const groupRole = roles.rows.find(({ rolname }) => rolname === runtimeRole);
    assert.deepEqual(
      { login: appRole?.rolcanlogin, superuser: appRole?.rolsuper, createdb: appRole?.rolcreatedb, createrole: appRole?.rolcreaterole, inherit: appRole?.rolinherit },
      { login: true, superuser: false, createdb: false, createrole: false, inherit: true },
    );
    assert.deepEqual(
      { login: groupRole?.rolcanlogin, superuser: groupRole?.rolsuper, createdb: groupRole?.rolcreatedb, createrole: groupRole?.rolcreaterole },
      { login: false, superuser: false, createdb: false, createrole: false },
    );

    return {
      schemas: schemas.rows.map(({ nspname }) => nspname),
      tables: tables.rows.map(({ schemaname, tablename }) => `${schemaname}.${tablename}`),
      indexes: indexes.rows.map(({ indexname }) => indexname),
      auditPartitioning: auditPartitioning.rows[0],
      privileges: privileges.rows[0],
      registry: registry.rows,
    };
  });
}

async function exerciseRuntimePrivileges() {
  const password = String(process.env.MIG020_APP_PASSWORD ?? "");
  assert.ok(password, "MIG020_APP_PASSWORD e richiesta per lo smoke mutativo.");
  const client = new Client(connectionConfig(appUser, password));
  await client.connect();
  try {
    await client.query(`
      INSERT INTO audit.events(id, domain, aggregate_type, aggregate_id, action, payload)
      VALUES ('mig020_audit', 'mig020', 'probe', 'probe-1', 'created', '{"ok":true}'::jsonb)
    `);
    await expectPgCode(
      () => client.query(`
        INSERT INTO audit.events(id, domain, aggregate_type, aggregate_id, action, payload)
        VALUES ('mig020_audit', 'mig020', 'probe', 'probe-2', 'duplicated', '{"ok":true}'::jsonb)
      `),
      "23505",
    );
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO messaging.idempotency_keys(scope, key, request_hash, status, expires_at)
        VALUES ('mig020', 'request-1', repeat('a', 64), 'processing', now() + interval '15 minutes')
      `);
      await client.query(`
        UPDATE messaging.idempotency_keys
        SET status = 'completed', response_code = 200, response_json = '{"ok":true}'::jsonb, completed_at = now()
        WHERE scope = 'mig020' AND key = 'request-1'
      `);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    await client.query(`
      INSERT INTO messaging.command_inbox(command_key, command_type, aggregate_type, aggregate_id, status)
      VALUES ('mig020_command', 'probe', 'probe', 'probe-1', 'RECEIVED')
    `);
    await client.query(`
      INSERT INTO messaging.event_outbox(id, aggregate_type, aggregate_id, event_type, payload)
      VALUES ('mig020_event', 'probe', 'probe-1', 'probe.created', '{"ok":true}'::jsonb)
    `);
    await client.query(`
      UPDATE messaging.event_outbox
      SET lease_owner = 'mig020-worker', lease_until = now() + interval '60 seconds', attempt_count = attempt_count + 1
      WHERE id = 'mig020_event'
    `);

    await expectPgCode(
      () => client.query("UPDATE audit.events SET action = 'tampered' WHERE id = 'mig020_audit'"),
      "42501",
    );
    await expectPgCode(
      () => client.query("DELETE FROM audit.events WHERE id = 'mig020_audit'"),
      "42501",
    );
    await expectPgCode(
      () => client.query("DELETE FROM messaging.event_outbox WHERE id = 'mig020_event'"),
      "42501",
    );
    await expectPgCode(
      () => client.query("CREATE TABLE messaging.runtime_must_not_create(id integer)"),
      "42501",
    );
    await expectPgCode(
      () => client.query("SELECT version FROM app_meta.schema_migrations"),
      "42501",
    );
    await expectPgCode(
      () => client.query("SELECT audit.ensure_event_month_partitions(current_date, current_date)"),
      "42501",
    );
    await expectPgCode(
      () => client.query(`
        INSERT INTO messaging.event_outbox(id, aggregate_type, event_type, payload, attempt_count)
        VALUES ('mig020_negative_attempt', 'probe', 'probe.invalid', '{}'::jsonb, -1)
      `),
      "23514",
    );
    await expectPgCode(
      () => client.query(`
        INSERT INTO messaging.idempotency_keys(scope, key, request_hash, status, expires_at)
        VALUES ('mig020', 'request-1', repeat('b', 64), 'processing', now() + interval '15 minutes')
      `),
      "23505",
    );

    const values = await client.query(`
      SELECT
        (SELECT count(*)::integer FROM audit.events WHERE id = 'mig020_audit') AS audit_count,
        (SELECT status FROM messaging.idempotency_keys WHERE scope = 'mig020' AND key = 'request-1') AS idempotency_status,
        (SELECT attempt_count FROM messaging.event_outbox WHERE id = 'mig020_event') AS outbox_attempts
    `);
    assert.deepEqual(values.rows[0], {
      audit_count: 1,
      idempotency_status: "completed",
      outbox_attempts: 1,
    });
    return values.rows[0];
  } finally {
    await client.end();
  }
}

const migrations = await discoverPostgresqlMigrations();
assert.deepEqual(
  migrations.map(({ version, name }) => ({ version, name })),
  [
    { version: "001", name: "foundation" },
    { version: "002", name: "event_outbox_lease_contract" },
    { version: "003", name: "audit_events_append_only" },
    { version: "004", name: "idempotency_store_contract" },
    { version: "005", name: "retention_control_plane" },
    { version: "006", name: "audit_events_partitioned_retention" },
  ],
);
const runtime = createPostgresqlRuntime({
  env: { ...process.env, BACKEND_POSTGRES_ENABLED: "1" },
  logger: { warn: (message) => console.error(message) },
});

try {
  const startedAt = performance.now();
  let first = null;
  let second = null;
  if (!verifyOnly) {
    first = await runPostgresqlMigrations(runtime, { migrations });
    second = await runPostgresqlMigrations(runtime, { migrations });
    assert.equal(first.applied.length, migrations.length);
    assert.equal(second.skipped.length, migrations.length);
  }
  const inspection = await inspectFoundation(
    runtime,
    migrations.map(({ version, checksum }) => ({ version, checksum })),
  );
  const runtimeExercise = verifyOnly ? null : await exerciseRuntimePrivileges();
  const report = {
    ok: true,
    mode: verifyOnly ? "verify-only" : "apply-and-exercise",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    first,
    second,
    inspection,
    runtimeExercise,
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runtime.close();
}
