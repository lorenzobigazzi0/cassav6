import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import mysql from "mysql2/promise";

import {
  createPostgresqlIdentityRepository,
  createPostgresqlRuntime,
  identityRowsFromAppState,
} from "../../backend/db/postgresql/index.js";

function requiredEnv(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} obbligatoria.`);
  return value;
}

function integerEnv(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} non valida.`);
  }
  return value;
}

function parseRawJson(value, label) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
    return parsed;
  } catch {
    throw new Error(`Record identity legacy non valido: ${label}.`);
  }
}

export function buildIdentityImportPlan(rows = []) {
  const collections = { users: [], userGroups: [] };
  for (const row of rows) {
    const domain = String(row?.domain ?? "").trim();
    if (!Object.hasOwn(collections, domain)) continue;
    const record = parseRawJson(row.raw_json, `${domain}/${String(row.record_id ?? "").trim() || "?"}`);
    collections[domain].push({
      record,
      position: Math.max(0, Math.trunc(Number(row.app_state_position) || 0)),
    });
  }
  const users = collections.users.sort((a, b) => a.position - b.position).map(({ record }) => record);
  const userGroups = collections.userGroups.sort((a, b) => a.position - b.position).map(({ record }) => record);
  if (users.length === 0) throw new Error("Import MIG-040 rifiutato: MariaDB non contiene utenti.");
  const adminCount = users.filter((user) => (
    String(user.role ?? "").trim() === "admin"
    || (Array.isArray(user.permissions) && user.permissions.includes("manage_users"))
  )).length;
  if (adminCount === 0) throw new Error("Import MIG-040 rifiutato: nessun amministratore nel sorgente.");
  return { users, userGroups, adminCount };
}

function identityDigest(state) {
  const rows = identityRowsFromAppState(state);
  const projection = {
    users: (rows.users ?? []).map(({ id, rowHash }) => ({ id, rowHash })).sort((a, b) => a.id.localeCompare(b.id)),
    userGroups: (rows.userGroups ?? []).map(({ id, rowHash }) => ({ id, rowHash })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

export function reconcileIdentityImport(source, target) {
  const sourceDigest = identityDigest(source);
  const targetDigest = identityDigest(target);
  return {
    ok: sourceDigest === targetDigest,
    source: { users: source.users.length, userGroups: source.userGroups.length, digest: sourceDigest },
    target: { users: target.users.length, userGroups: target.userGroups.length, digest: targetDigest },
  };
}

export async function importMysqlIdentity(env = process.env, options = {}) {
  const mysqlConnection = options.mysqlConnection ?? await mysql.createConnection({
    host: requiredEnv(env, "BACKEND_MYSQL_HOST"),
    port: integerEnv(env, "BACKEND_MYSQL_PORT", 3306),
    user: requiredEnv(env, "BACKEND_MYSQL_USER"),
    password: requiredEnv(env, "BACKEND_MYSQL_PASSWORD"),
    database: requiredEnv(env, "BACKEND_MYSQL_DATABASE"),
  });
  const ownsMysqlConnection = !options.mysqlConnection;
  const runtime = options.postgresqlRuntime ?? createPostgresqlRuntime({
    env: { ...env, BACKEND_POSTGRES_ENABLED: "1" },
    logger: options.logger ?? console,
  });
  const ownsPostgresqlRuntime = !options.postgresqlRuntime;
  try {
    const [rows] = await mysqlConnection.execute(
      "SELECT domain, record_id, app_state_position, raw_json FROM app_state_domain_records WHERE domain IN ('users','userGroups') ORDER BY domain, app_state_position, record_id",
    );
    const plan = buildIdentityImportPlan(rows);
    const repository = createPostgresqlIdentityRepository({ runtime });
    const canonical = identityRowsFromAppState(plan);
    const sync = await runtime.withTransaction(
      "mig040:initial-import",
      (client) => repository.syncFromAppState(client, {
        users: canonical.users,
        userGroups: canonical.userGroups,
        options: {},
      }),
      { isolationLevel: "SERIALIZABLE", maxAttempts: 3 },
    );
    const target = {
      users: await repository.listUsers(),
      userGroups: await repository.listUserGroups(),
    };
    const reconciliation = reconcileIdentityImport(plan, target);
    assert.equal(reconciliation.ok, true, "Riconciliazione identity MariaDB/PostgreSQL fallita.");
    const administratorCount = await repository.countAdministrators();
    assert.ok(administratorCount > 0, "PostgreSQL non contiene amministratori dopo l'import.");
    return {
      ok: true,
      importedAt: new Date().toISOString(),
      administrators: administratorCount,
      reconciliation,
      sync,
    };
  } finally {
    if (ownsMysqlConnection) await mysqlConnection.end();
    if (ownsPostgresqlRuntime) await runtime.close();
  }
}

function parseArgs(argv) {
  const options = { output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") options.output = path.resolve(argv[++index] ?? "");
    else throw new Error(`Argomento non riconosciuto: ${argv[index]}`);
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await importMysqlIdentity(process.env);
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) {
      await fs.mkdir(path.dirname(options.output), { recursive: true });
      await fs.writeFile(options.output, output, "utf8");
    }
    process.stdout.write(output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

