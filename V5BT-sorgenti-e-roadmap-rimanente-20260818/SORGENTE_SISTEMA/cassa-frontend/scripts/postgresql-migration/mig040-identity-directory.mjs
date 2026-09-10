import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createPostgresqlIdentityDirectoryRepository,
  createPostgresqlRuntime,
} from "../../backend/db/postgresql/index.js";
import { runPostgresqlSchemaMigration } from "../../backend/scripts/migrate-postgresql.mjs";

const APP_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_SOURCE = path.join(APP_ROOT, "backend", "app-state.json");

function uniqueSorted(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value ?? "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function canonicalUser(user = {}) {
  return {
    id: String(user.id ?? "").trim(),
    username: String(user.username ?? "").trim(),
    fullName: String(user.fullName ?? "").trim() || null,
    role: String(user.role ?? "operator").trim() || "operator",
    roleLabel: String(user.roleLabel ?? "").trim() || null,
    pinHash: String(user.pinHash ?? "").trim() || null,
    active: user.active !== false && user.enabled !== false,
    permissions: uniqueSorted(user.permissions),
    groupIds: uniqueSorted(user.groupIds),
  };
}

function canonicalGroup(group = {}) {
  return {
    id: String(group.id ?? "").trim(),
    name: String(group.name ?? group.label ?? "").trim(),
    enabled: group.enabled !== false,
    permissions: uniqueSorted(group.permissions),
  };
}

export function canonicalIdentityDirectory(input = {}) {
  return {
    users: (Array.isArray(input.users) ? input.users : [])
      .map(canonicalUser)
      .sort((left, right) => left.id.localeCompare(right.id)),
    groups: (Array.isArray(input.groups) ? input.groups : [])
      .map(canonicalGroup)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function reconcileIdentityDirectories(source, target) {
  const canonicalSource = canonicalIdentityDirectory(source);
  const canonicalTarget = canonicalIdentityDirectory(target);
  const sourceDigest = digest(canonicalSource);
  const targetDigest = digest(canonicalTarget);
  return {
    ok: sourceDigest === targetDigest,
    source: {
      users: canonicalSource.users.length,
      groups: canonicalSource.groups.length,
      digest: sourceDigest,
    },
    target: {
      users: canonicalTarget.users.length,
      groups: canonicalTarget.groups.length,
      digest: targetDigest,
    },
  };
}

function parseArgs(argv) {
  const options = { source: DEFAULT_SOURCE, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--source") options.source = path.resolve(argv[++index] ?? "");
    else if (argv[index] === "--output") options.output = path.resolve(argv[++index] ?? "");
    else throw new Error(`Argomento non riconosciuto: ${argv[index]}`);
  }
  return options;
}

export async function migrateIdentityDirectory(env = process.env, options = {}) {
  const sourcePath = path.resolve(options.source ?? DEFAULT_SOURCE);
  const snapshot = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  const source = {
    users: Array.isArray(snapshot.users) ? snapshot.users : [],
    groups: Array.isArray(snapshot.userGroups) ? snapshot.userGroups : [],
  };
  if (source.users.length === 0) throw new Error("Import identity rifiutato: nessun utente nel sorgente.");

  const schema = await runPostgresqlSchemaMigration(env, { logger: options.logger ?? console });
  const runtime = createPostgresqlRuntime({
    env: { ...env, BACKEND_POSTGRES_ENABLED: "1" },
    logger: options.logger ?? console,
  });
  try {
    const repository = createPostgresqlIdentityDirectoryRepository({ runtime });
    await repository.replaceDirectory(source);
    const target = await repository.listDirectory();
    const reconciliation = reconcileIdentityDirectories(source, target);
    assert.equal(reconciliation.ok, true, "Riconciliazione identity legacy/PostgreSQL non riuscita.");
    return {
      ok: true,
      sourcePath,
      schema: { applied: schema.applied.length, skipped: schema.skipped.length },
      reconciliation,
    };
  } finally {
    await runtime.close();
  }
}

function isDirectExecution(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  return pathToFileURL(path.resolve(argvPath)).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await migrateIdentityDirectory(process.env, options);
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) {
      await fs.mkdir(path.dirname(options.output), { recursive: true });
      await fs.writeFile(options.output, serialized, "utf8");
    }
    process.stdout.write(serialized);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

