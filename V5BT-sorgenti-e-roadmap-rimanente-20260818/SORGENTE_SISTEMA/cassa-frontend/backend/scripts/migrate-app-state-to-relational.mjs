import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  closeRelationalConnection,
  openRelationalConnection,
  runRelationalMigrations,
  syncAuditEventsFromAppState,
} from "../db/relational/index.js";
import { readJsonStateFile } from "../db/app-state/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptDir, "..");

const DEFAULT_JSON_DB_PATH = path.join(backendDir, "app-state.json");
const LEGACY_JSON_DB_PATH = path.join(backendDir, "mock-db.json");
const DEFAULT_SQLITE_DB_PATH = path.join(backendDir, "backend.sqlite");
const DEFAULT_RELATIONAL_DB_PATH = path.join(backendDir, "backend-relational.sqlite");

function isValidAppState(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.users) &&
    Array.isArray(data.sessions) &&
    data.meta &&
    typeof data.meta === "object"
  );
}

function resolveSourceConfig(env = process.env) {
  const mode = String(env.BACKEND_DB_MODE ?? "json").trim().toLowerCase();
  if (!["json", "sqlite"].includes(mode)) {
    throw new Error(`BACKEND_DB_MODE non valido: '${mode || "(vuoto)"}'. Valori ammessi: json, sqlite.`);
  }

  if (mode === "sqlite") {
    const dbPath = path.resolve(
      String(env.BACKEND_DB_PATH ?? env.SQLITE_DB_PATH ?? DEFAULT_SQLITE_DB_PATH).trim() || DEFAULT_SQLITE_DB_PATH
    );
    return { mode, dbPath };
  }

  const explicitPath = String(env.BACKEND_DB_PATH ?? "").trim();
  if (explicitPath) {
    return { mode, dbPath: path.resolve(explicitPath) };
  }

  const dbPath = existsSync(DEFAULT_JSON_DB_PATH) || !existsSync(LEGACY_JSON_DB_PATH)
    ? DEFAULT_JSON_DB_PATH
    : LEGACY_JSON_DB_PATH;
  return { mode, dbPath };
}

function resolveRelationalPath(env = process.env) {
  return path.resolve(
    String(env.BACKEND_RELATIONAL_DB_PATH ?? DEFAULT_RELATIONAL_DB_PATH).trim() || DEFAULT_RELATIONAL_DB_PATH
  );
}

async function loadDatabaseSync() {
  const sqliteModule = await import("node:sqlite");
  return sqliteModule.DatabaseSync;
}

async function readJsonAppState(dbPath) {
  try {
    const state = await readJsonStateFile(dbPath);
    if (!isValidAppState(state)) {
      throw new Error("shape app-state invalida");
    }
    return state;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`App-state JSON non leggibile o corrotto (${dbPath}): ${reason}`);
  }
}

async function readSqliteDocumentAppState(dbPath) {
  if (!existsSync(dbPath)) {
    throw new Error(`DB SQLite documentale non trovato: ${dbPath}`);
  }

  const DatabaseSync = await loadDatabaseSync();
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const row = db.prepare("SELECT json FROM app_state WHERE id = 1").get();
    if (!row || typeof row.json !== "string") {
      throw new Error("riga app_state id=1 mancante");
    }
    const state = JSON.parse(row.json);
    if (!isValidAppState(state)) {
      throw new Error("shape app-state invalida");
    }
    return state;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`App-state SQLite documentale non leggibile o corrotto (${dbPath}): ${reason}`);
  } finally {
    try {
      db?.close();
    } catch {
      // noop
    }
  }
}

async function readSourceAppState(sourceConfig) {
  if (sourceConfig.mode === "sqlite") {
    return readSqliteDocumentAppState(sourceConfig.dbPath);
  }
  return readJsonAppState(sourceConfig.dbPath);
}

async function openMigratedRelationalDb(dbPath) {
  let db = null;
  try {
    db = await openRelationalConnection({
      enabled: true,
      mode: "shadow",
      dbPath,
    });
    await runRelationalMigrations(db);
    return db;
  } catch (error) {
    closeRelationalConnection(db);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`DB relazionale non scrivibile o non apribile (${dbPath}): ${reason}`);
  }
}

export async function runManualAuditEventsMigration(env = process.env) {
  const sourceConfig = resolveSourceConfig(env);
  const relationalDbPath = resolveRelationalPath(env);
  const appState = await readSourceAppState(sourceConfig);
  const auditEventsCount = Array.isArray(appState.auditEvents) ? appState.auditEvents.length : 0;

  let db = null;
  try {
    db = await openMigratedRelationalDb(relationalDbPath);
    const result = syncAuditEventsFromAppState(db, appState);
    return {
      sourceMode: sourceConfig.mode,
      sourcePath: sourceConfig.dbPath,
      relationalDbPath,
      auditEventsCount,
      importedRows: result.rowCount,
      checksum: result.checksum,
      ok: true,
    };
  } finally {
    closeRelationalConnection(db);
  }
}

function printResult(result) {
  console.log(`Modalita sorgente: ${result.sourceMode}`);
  console.log(`Path sorgente app-state: ${result.sourcePath}`);
  console.log(`Path DB relazionale: ${result.relationalDbPath}`);
  console.log(`AuditEvents trovati: ${result.auditEventsCount}`);
  console.log(`Righe importate: ${result.importedRows}`);
  console.log(`Checksum: ${result.checksum}`);
  console.log("Esito finale: ok");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runManualAuditEventsMigration(process.env);
    printResult(result);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Esito finale: errore`);
    console.error(reason);
    process.exitCode = 1;
  }
}
