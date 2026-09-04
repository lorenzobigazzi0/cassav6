import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_POSTGRESQL_MIGRATIONS_DIR = path.join(currentDir, "migrations");
export const POSTGRESQL_MIGRATION_LOCK_KEY = "cassav6:postgresql:schema-migrations:v1";

const MIGRATION_FILE_PATTERN = /^(\d{3,})_([a-z][a-z0-9_]*)\.sql$/;
const TRANSACTION_CONTROL_PATTERN = /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im;

export function checksumPostgresqlMigration(sql) {
  return createHash("sha256").update(String(sql ?? ""), "utf8").digest("hex");
}

function normalizeMigration(migration) {
  const version = String(migration?.version ?? "").trim();
  const name = String(migration?.name ?? "").trim();
  const sql = String(migration?.sql ?? "");
  if (!/^\d{3,}$/.test(version)) {
    throw new Error(`Versione migrazione PostgreSQL non valida: ${version || "vuota"}.`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Nome migrazione PostgreSQL non valido per ${version}: ${name || "vuoto"}.`);
  }
  if (!sql.trim()) throw new Error(`Migrazione PostgreSQL ${version}_${name} vuota.`);
  if (TRANSACTION_CONTROL_PATTERN.test(sql)) {
    throw new Error(
      `Migrazione PostgreSQL ${version}_${name} contiene controllo transazione: BEGIN/COMMIT/ROLLBACK sono gestiti dal runner.`,
    );
  }
  const checksum = checksumPostgresqlMigration(sql);
  if (migration?.checksum && String(migration.checksum).toLowerCase() !== checksum) {
    throw new Error(`Checksum dichiarato non valido per la migrazione PostgreSQL ${version}_${name}.`);
  }
  return {
    version,
    name,
    sql,
    checksum,
    fileName: migration?.fileName ? String(migration.fileName) : `${version}_${name}.sql`,
  };
}

function normalizeMigrationSet(migrations) {
  const normalized = migrations.map(normalizeMigration).sort((left, right) =>
    left.version.localeCompare(right.version, "en", { numeric: true })
      || left.name.localeCompare(right.name),
  );
  const seenVersions = new Set();
  for (const migration of normalized) {
    if (seenVersions.has(migration.version)) {
      throw new Error(`Versione migrazione PostgreSQL duplicata: ${migration.version}.`);
    }
    seenVersions.add(migration.version);
  }
  return normalized;
}

export async function discoverPostgresqlMigrations(migrationsDir = DEFAULT_POSTGRESQL_MIGRATIONS_DIR) {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const sqlEntries = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"));
  const migrations = [];
  for (const entry of sqlEntries) {
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (!match) {
      throw new Error(
        `Nome file migrazione PostgreSQL non valido: ${entry.name}. Formato richiesto: NNN_nome.sql.`,
      );
    }
    migrations.push({
      version: match[1],
      name: match[2],
      fileName: entry.name,
      sql: await fs.readFile(path.join(migrationsDir, entry.name), "utf8"),
    });
  }
  return normalizeMigrationSet(migrations);
}

async function ensureMigrationRegistry(client) {
  await client.query("CREATE SCHEMA IF NOT EXISTS app_meta");
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_meta.schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum text NOT NULL
    )
  `);
}

async function readAppliedMigration(client, version) {
  const result = await client.query(
    "SELECT version, checksum FROM app_meta.schema_migrations WHERE version = $1",
    [version],
  );
  return result.rows?.[0] ?? null;
}

export async function runPostgresqlMigrationsWithClient(client, migrations, options = {}) {
  if (!client?.query) throw new Error("Client PostgreSQL non valido per il migration runner.");
  const normalizedMigrations = normalizeMigrationSet(migrations ?? []);
  if (normalizedMigrations.length === 0) {
    throw new Error("Nessuna migrazione PostgreSQL valida da applicare.");
  }
  const nowMs = options.nowMs ?? (() => performance.now());
  const lockKey = String(options.lockKey ?? POSTGRESQL_MIGRATION_LOCK_KEY);
  const result = { applied: [], skipped: [], total: normalizedMigrations.length };
  let locked = false;
  let primaryError = null;

  try {
    const lockResult = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [lockKey],
    );
    locked = lockResult.rows?.[0]?.locked === true;
    if (!locked) {
      throw new Error("Un altro migration runner PostgreSQL e gia attivo.");
    }
    await ensureMigrationRegistry(client);

    for (const migration of normalizedMigrations) {
      const existing = await readAppliedMigration(client, migration.version);
      if (existing) {
        if (String(existing.checksum).toLowerCase() !== migration.checksum) {
          throw new Error(
            `Checksum drift per migrazione PostgreSQL ${migration.version}_${migration.name}: il file applicato non puo essere modificato.`,
          );
        }
        result.skipped.push({
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
        });
        continue;
      }

      const startedAt = nowMs();
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO app_meta.schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Migrazione PostgreSQL ${migration.version}_${migration.name} fallita: ${reason}`,
          { cause: error },
        );
      }
      result.applied.push({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        durationMs: Math.max(0, Math.round((nowMs() - startedAt) * 100) / 100),
      });
    }
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      } catch (unlockError) {
        if (!primaryError) throw unlockError;
      }
    }
  }
}

export async function runPostgresqlMigrations(runtime, options = {}) {
  if (!runtime?.withConnection) throw new Error("PostgreSQL runtime non valido per il migration runner.");
  const migrations = options.migrations
    ? normalizeMigrationSet(options.migrations)
    : await discoverPostgresqlMigrations(options.migrationsDir ?? DEFAULT_POSTGRESQL_MIGRATIONS_DIR);
  return runtime.withConnection("migrations", (client) =>
    runPostgresqlMigrationsWithClient(client, migrations, options),
  );
}
