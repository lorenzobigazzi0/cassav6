import {
  createPostgresqlRuntime,
  runPostgresqlMigrations,
} from "../../backend/db/postgresql/index.js";

const baseMigrations = [
  {
    version: "900001",
    name: "mig012_smoke_schema",
    sql: "CREATE SCHEMA mig012_smoke;",
  },
  {
    version: "900002",
    name: "mig012_smoke_table",
    sql: `
      CREATE TABLE mig012_smoke.runner_values (
        id integer PRIMARY KEY,
        value text NOT NULL
      );
      INSERT INTO mig012_smoke.runner_values (id, value) VALUES (1, 'ok');
    `,
  },
];

const runtime = createPostgresqlRuntime({
  env: { ...process.env, BACKEND_POSTGRES_ENABLED: "1" },
  logger: { warn: (message) => console.error(message) },
});

try {
  const first = await runPostgresqlMigrations(runtime, { migrations: baseMigrations });
  const second = await runPostgresqlMigrations(runtime, { migrations: baseMigrations });

  let driftBlocked = false;
  try {
    await runPostgresqlMigrations(runtime, {
      migrations: [{ ...baseMigrations[0], sql: "CREATE SCHEMA mig012_smoke_changed;" }],
    });
  } catch (error) {
    driftBlocked = /Checksum drift/.test(error instanceof Error ? error.message : String(error));
  }

  let rollbackObserved = false;
  try {
    await runPostgresqlMigrations(runtime, {
      migrations: [
        ...baseMigrations,
        {
          version: "900003",
          name: "mig012_smoke_rollback",
          sql: "CREATE TABLE mig012_smoke.must_rollback(id integer); SELECT 1 / 0;",
        },
      ],
    });
  } catch (error) {
    rollbackObserved = /900003_mig012_smoke_rollback fallita/.test(
      error instanceof Error ? error.message : String(error),
    );
  }

  const verification = await runtime.withConnection("mig012-smoke-verification", async (client) => {
    const result = await client.query(`
      SELECT
        (SELECT count(*)::integer FROM app_meta.schema_migrations) AS migration_count,
        (SELECT count(*)::integer FROM mig012_smoke.runner_values) AS value_count,
        to_regclass('mig012_smoke.must_rollback') IS NULL AS rollback_table_absent,
        NOT EXISTS (
          SELECT 1 FROM app_meta.schema_migrations WHERE version = '900003'
        ) AS rollback_registry_absent
    `);
    return result.rows[0];
  });

  const report = {
    ok:
      first.applied.length === 2
      && second.skipped.length === 2
      && driftBlocked
      && rollbackObserved
      && verification.migration_count === 2
      && verification.value_count === 1
      && verification.rollback_table_absent === true
      && verification.rollback_registry_absent === true,
    first,
    second,
    driftBlocked,
    rollbackObserved,
    verification,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await runtime.close();
}

