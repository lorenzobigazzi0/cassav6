import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInitialAppState } from "../modules/app-state/index.js";
import { ALL_POS_PERMISSION_IDS } from "../auth/permissions.js";
import { hashPin } from "../auth/password.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptDir, "..");
const dbModeRaw = String(process.env.BACKEND_DB_MODE ?? "json").trim().toLowerCase();
const dbMode = dbModeRaw === "sqlite" ? "sqlite" : "json";
const defaultJsonPath = path.join(backendDir, "app-state.json");
// TODO(refactor): DEPRECATED compatibilita temporanea con vecchi runtime JSON nominati mock-db.
const legacyJsonPath = path.join(backendDir, "mock-db.json");
const defaultSqlitePath = path.join(backendDir, "backend.sqlite");
const dbPath = path.resolve(
  dbMode === "sqlite"
    ? String(process.env.BACKEND_DB_PATH ?? process.env.SQLITE_DB_PATH ?? defaultSqlitePath).trim() ||
        defaultSqlitePath
    : String(process.env.BACKEND_DB_PATH ?? defaultJsonPath).trim() || defaultJsonPath
);
let DatabaseSyncClass = null;

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) continue;
    const key = entry.slice(2);
    const next = argv[index + 1];
    if (typeof next === "string" && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = "1";
    }
  }
  return args;
}

function toTitle(value) {
  return String(value ?? "")
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeUsername(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeUserRole(role) {
  const normalized = String(role ?? "").trim().toLowerCase();
  return ["operator", "responsabile", "admin"].includes(normalized) ? normalized : "operator";
}

function hasBootstrapAdmin(db) {
  const users = Array.isArray(db?.users) ? db.users : [];
  return users.some((user) => {
    const role = normalizeUserRole(user?.role);
    const permissions = Array.isArray(user?.permissions)
      ? user.permissions.map((permission) => String(permission ?? "").trim())
      : [];
    return role === "admin" || permissions.includes("manage_users");
  });
}

function buildUserId(username, users) {
  const usedIds = new Set(
    (Array.isArray(users) ? users : [])
      .map((user) => String(user?.id ?? "").trim())
      .filter(Boolean)
  );
  const base = normalizeUsername(username).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const fallbackBase = base ? `u_${base}` : `u_${Date.now().toString(36)}`;
  let candidate = fallbackBase;
  let counter = 1;
  while (usedIds.has(candidate)) {
    candidate = `${fallbackBase}_${counter}`;
    counter += 1;
  }
  return candidate;
}

async function readJsonState() {
  try {
    const raw = await fs.readFile(dbPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Stato JSON non valido.");
    }
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (!parsed.meta || typeof parsed.meta !== "object") parsed.meta = {};
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      if (dbPath === defaultJsonPath) {
        try {
          const raw = await fs.readFile(legacyJsonPath, "utf-8");
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed.users)) parsed.users = [];
          if (!parsed.meta || typeof parsed.meta !== "object") parsed.meta = {};
          return parsed;
        } catch {
          // Nessuno stato legacy da importare.
        }
      }
      return buildInitialAppState();
    }
    throw error;
  }
}

async function writeJsonState(state) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const tmpPath = `${dbPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, dbPath);
}

async function loadDatabaseSync() {
  if (!DatabaseSyncClass) {
    const sqliteModule = await import("node:sqlite");
    DatabaseSyncClass = sqliteModule.DatabaseSync;
  }
  return DatabaseSyncClass;
}

async function openSqlite() {
  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

async function readState() {
  if (dbMode !== "sqlite") return readJsonState();

  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await openSqlite();
  try {
    const row = sqlite.prepare("SELECT json FROM app_state WHERE id = 1").get();
    if (!row) return buildInitialAppState();
    const parsed = JSON.parse(row.json);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Stato SQLite non valido.");
    }
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (!parsed.meta || typeof parsed.meta !== "object") parsed.meta = {};
    return parsed;
  } finally {
    sqlite.close();
  }
}

async function writeState(state) {
  const updatedAt = String(state.meta?.lastWriteAt ?? nowIso());
  if (dbMode !== "sqlite") {
    await writeJsonState(state);
    return;
  }

  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await openSqlite();
  try {
    sqlite
      .prepare(
        `
          INSERT INTO app_state (id, json, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            json = excluded.json,
            updated_at = excluded.updated_at
        `
      )
      .run(JSON.stringify(state), updatedAt);
  } finally {
    sqlite.close();
  }
}

function createAdminUser({ username, pin, name }, users) {
  const createdAt = nowIso();
  return {
    id: buildUserId(username, users),
    username,
    fullName: name || toTitle(username) || username,
    role: "admin",
    roleLabel: "Amministratore",
    permissions: [...ALL_POS_PERMISSION_IDS],
    authorizedRoomIds: [],
    pinHash: hashPin(pin),
    createdAt,
    updatedAt: createdAt,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = String(args.username ?? process.env.ADMIN_USERNAME ?? process.env.CREATE_ADMIN_USERNAME ?? "")
    .trim();
  const pin = String(args.pin ?? process.env.ADMIN_PIN ?? process.env.CREATE_ADMIN_PIN ?? "").trim();
  const name = String(args.name ?? process.env.ADMIN_NAME ?? process.env.CREATE_ADMIN_NAME ?? "").trim();

  if (!username) {
    throw new Error("Parametro richiesto: --username oppure ADMIN_USERNAME.");
  }
  if (!/^\d{4,6}$/.test(pin)) {
    throw new Error("Parametro richiesto: --pin numerico di 4-6 cifre oppure ADMIN_PIN.");
  }

  const state = await readState();
  if (hasBootstrapAdmin(state)) {
    console.log(JSON.stringify({ ok: true, created: false, reason: "admin_already_exists", dbMode, dbPath }, null, 2));
    return;
  }

  state.users.push(createAdminUser({ username, pin, name }, state.users));
  if (!state.meta || typeof state.meta !== "object") state.meta = {};
  state.meta.lastWriteAt = nowIso();
  state.meta.settingsLastWriteAt = state.meta.lastWriteAt;
  await writeState(state);

  console.log(JSON.stringify({ ok: true, created: true, username, dbMode, dbPath }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
});
