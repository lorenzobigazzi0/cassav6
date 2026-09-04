import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  closeRelationalConnection,
  openRelationalConnection,
  runRelationalMigrations,
} from "../db/relational/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptDir, "..");
const DEFAULT_RELATIONAL_DB_PATH = path.join(backendDir, "backend-relational.sqlite");

function resolveRelationalPath(env = process.env) {
  return path.resolve(
    String(env.BACKEND_RELATIONAL_DB_PATH ?? DEFAULT_RELATIONAL_DB_PATH).trim() || DEFAULT_RELATIONAL_DB_PATH,
  );
}

function countAppliedMigrations(db) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count ?? 0);
}

export async function runRelationalSchemaMigration(env = process.env) {
  const relationalDbPath = resolveRelationalPath(env);
  let db = null;
  try {
    db = await openRelationalConnection({
      enabled: true,
      mode: "shadow",
      dbPath: relationalDbPath,
    });
    await runRelationalMigrations(db);
    return {
      relationalDbPath,
      appliedMigrations: countAppliedMigrations(db),
      ok: true,
    };
  } finally {
    closeRelationalConnection(db);
  }
}

function printResult(result) {
  console.log(`Path DB relazionale: ${result.relationalDbPath}`);
  console.log(`Migrazioni registrate: ${result.appliedMigrations}`);
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
    const result = await runRelationalSchemaMigration(process.env);
    printResult(result);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("Esito finale: errore");
    console.error(reason);
    process.exitCode = 1;
  }
}
