import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  RELATIONAL_MODES,
  RELATIONAL_READ_PRIMARY_DOMAINS,
  normalizePersistenceDomainName,
  normalizePersistenceMode,
} from "../persistence-mode.js";
import { withRelationalTransaction } from "./transaction.js";

let DatabaseSyncClass = null;

export { RELATIONAL_MODES };
export const RELATIONAL_PRIMARY_DOMAINS = RELATIONAL_READ_PRIMARY_DOMAINS;

function normalizeRelationalPrimaryDomainName(value) {
  return normalizePersistenceDomainName(value);
}

function clampInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeRelationalConfig(options = {}) {
  const env = options.env ?? process.env;
  const persistenceMode = normalizePersistenceMode({
    env,
    failOnUnsupportedWritePrimary: true,
  });
  const defaultDbPath = options.defaultDbPath ?? path.resolve("backend", "backend-relational.sqlite");
  const dbPath = path.resolve(String(env.BACKEND_RELATIONAL_DB_PATH ?? defaultDbPath).trim() || defaultDbPath);
  const walCheckpointEnabled = String(env.BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER ?? "0").trim() === "1";
  const processRole = String(env.BACKEND_PROCESS_ROLE ?? "monolith").trim().toLowerCase();
  const walCheckpointOwner = walCheckpointEnabled && ["api-owner", "monolith", ""].includes(processRole);
  const walCheckpointIntervalMs = clampInteger(env.BACKEND_RELATIONAL_WAL_CHECKPOINT_INTERVAL_MS, 1_000, 250, 300_000);
  const walAutoCheckpointPages = walCheckpointEnabled ? 0 : 1_000;

  if (!persistenceMode.enabled) {
    return {
      enabled: false,
      mode: "off",
      dbPath,
      walAutoCheckpointPages,
      walCheckpointEnabled,
      walCheckpointIntervalMs,
      walCheckpointOwner,
      shadowSyncEnabled: false,
      primaryDomains: new Set(),
      readPrimaryDomains: new Set(),
      requestedWritePrimaryDomains: persistenceMode.requestedWritePrimaryDomains,
      writePrimaryDomains: new Set(),
    };
  }

  return {
    enabled: persistenceMode.enabled,
    mode: persistenceMode.mode,
    dbPath,
    walAutoCheckpointPages,
    walCheckpointEnabled,
    walCheckpointIntervalMs,
    walCheckpointOwner,
    shadowSyncEnabled: String(env.BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED ?? "1").trim() !== "0",
    primaryDomains: persistenceMode.readPrimaryDomains,
    readPrimaryDomains: persistenceMode.readPrimaryDomains,
    requestedWritePrimaryDomains: persistenceMode.requestedWritePrimaryDomains,
    writePrimaryDomains: persistenceMode.writePrimaryDomains,
  };
}

export async function loadRelationalDatabaseSync() {
  if (!DatabaseSyncClass) {
    const sqliteModule = await import("node:sqlite");
    DatabaseSyncClass = sqliteModule.DatabaseSync;
  }
  return DatabaseSyncClass;
}

export async function openRelationalConnection(config) {
  if (!config?.enabled || config.mode === "off") return null;

  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const DatabaseSync = await loadRelationalDatabaseSync();
  const db = new DatabaseSync(config.dbPath);
  const walAutoCheckpointPages = clampInteger(config.walAutoCheckpointPages, 1_000, 0, 1_000_000);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA wal_autocheckpoint = ${walAutoCheckpointPages};
  `);
  return db;
}

export function runRelationalTransaction(db, callback, options = {}) {
  return withRelationalTransaction(db, () => callback(), options);
}

export function closeRelationalConnection(db) {
  try {
    db?.close();
  } catch {
    // noop
  }
}

export { normalizeRelationalPrimaryDomainName };
