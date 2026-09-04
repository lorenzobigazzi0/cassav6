import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createPostgresqlRuntime,
  DEFAULT_POSTGRESQL_MIGRATIONS_DIR,
  discoverPostgresqlMigrations,
  runPostgresqlMigrations,
} from "../db/postgresql/index.js";

export async function runPostgresqlSchemaMigration(env = process.env, options = {}) {
  const migrationsDir = path.resolve(options.migrationsDir ?? DEFAULT_POSTGRESQL_MIGRATIONS_DIR);
  const migrations = options.migrations ?? await discoverPostgresqlMigrations(migrationsDir);
  if (migrations.length === 0) {
    throw new Error(`Nessuna migrazione PostgreSQL trovata in ${migrationsDir}.`);
  }
  if (options.planOnly === true) {
    return {
      ok: true,
      planOnly: true,
      migrationsDir,
      migrations: migrations.map(({ version, name, checksum }) => ({ version, name, checksum })),
    };
  }

  const runtime = createPostgresqlRuntime({
    env: { ...env, BACKEND_POSTGRES_ENABLED: "1" },
    logger: options.logger ?? console,
    runtimeMetrics: options.runtimeMetrics,
  });
  try {
    const result = await runPostgresqlMigrations(runtime, { migrations });
    return { ok: true, planOnly: false, migrationsDir, ...result };
  } finally {
    await runtime.close();
  }
}

function printResult(result) {
  console.log(`Directory migrazioni: ${result.migrationsDir}`);
  if (result.planOnly) {
    console.log(`Migrazioni pianificate: ${result.migrations.length}`);
    for (const migration of result.migrations) {
      console.log(`PLAN ${migration.version}_${migration.name} ${migration.checksum}`);
    }
  } else {
    console.log(`Migrazioni applicate: ${result.applied.length}`);
    console.log(`Migrazioni gia presenti: ${result.skipped.length}`);
    for (const migration of result.applied) {
      console.log(`UP ${migration.version}_${migration.name} ${migration.checksum}`);
    }
  }
  console.log("Esito finale: ok");
}

function isDirectExecution(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === fileURLToPath(import.meta.url);
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(argvPath)).href;
  }
}

if (isDirectExecution()) {
  try {
    const result = await runPostgresqlSchemaMigration(process.env, {
      planOnly: process.argv.includes("--plan"),
    });
    printResult(result);
  } catch (error) {
    console.error("Esito finale: errore");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

