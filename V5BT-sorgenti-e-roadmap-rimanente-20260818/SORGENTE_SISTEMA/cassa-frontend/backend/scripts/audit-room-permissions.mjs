#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptDir, "..");
const DEFAULT_JSON_DB_PATH = path.join(backendDir, "app-state.json");
const LEGACY_JSON_DB_PATH = path.join(backendDir, "mock-db.json");
const DEFAULT_SQLITE_DB_PATH = path.join(backendDir, "backend.sqlite");
const DEFAULT_TARGET_ROOM_ID = "room_gazebo";
const DEFAULT_TARGET_ROOM_NAME = "Gazebo";

let DatabaseSyncClass = null;

export function parseAuditArgs(argv = []) {
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

function asBooleanFlag(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return !["", "0", "false", "no", "off"].includes(normalized);
}

function toTitle(value) {
  return String(value ?? "")
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeConfigId(value, fallback = "") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function toIntegrationRoomSlug(value, fallback = "sala") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function normalizeRoomIdList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    const roomId = String(entry ?? "").trim();
    if (!roomId || seen.has(roomId)) continue;
    seen.add(roomId);
    out.push(roomId);
  }
  return out;
}

function inferRoomFromType(typeRaw, usedRoomIds = new Set()) {
  const typeLabel = String(typeRaw ?? "").trim() || "Sala";
  const normalized = toIntegrationRoomSlug(typeLabel, "sala");
  const idHints = [
    { id: "sala_main", name: "Sala Principale", test: /(intern|main|princip|sala_main)/ },
    { id: "sala_terrazza", name: "Terrazza", test: /(estern|terraz|outdoor|garden)/ },
    { id: "sala_privata", name: "Sala Privata", test: /(privat|vip)/ },
    { id: "sala_eventi", name: "Sala Eventi", test: /(event|banquet|meeting)/ },
    { id: "sala_bar", name: "Bar", test: /(bar|cocktail|caffett|banco)/ },
  ];
  const matched = idHints.find((entry) => entry.test.test(normalized));
  const baseId = matched ? matched.id : `room_${normalized}`;
  const baseName = matched ? matched.name : toTitle(typeLabel) || "Sala";
  let nextId = baseId;
  let suffix = 2;
  while (usedRoomIds.has(nextId)) {
    nextId = `${baseId}_${suffix}`;
    suffix += 1;
  }
  usedRoomIds.add(nextId);
  return { id: nextId, name: baseName, type: typeLabel };
}

function addRoom(roomsById, room, source) {
  const id = normalizeConfigId(room?.id ?? room?.roomId ?? room?.areaId ?? "", "");
  const name = String(room?.name ?? room?.label ?? room?.roomName ?? room?.areaName ?? id).trim();
  if (!id || !name) return;
  if (!roomsById.has(id)) {
    roomsById.set(id, { id, name, sources: [source] });
    return;
  }
  const existing = roomsById.get(id);
  if (source && !existing.sources.includes(source)) existing.sources.push(source);
}

export function collectConfiguredRooms(posSettings, options = {}) {
  const includeV2DefaultSeeds = options.includeV2DefaultSeeds !== false;
  const roomsById = new Map();
  const usedRoomIds = new Set();
  const settings = posSettings && typeof posSettings === "object" ? posSettings : {};

  for (const area of Array.isArray(settings.areas) ? settings.areas : []) {
    addRoom(roomsById, area, "posSettings.areas");
    const areaId = normalizeConfigId(area?.id ?? area?.roomId ?? "", "");
    if (areaId) usedRoomIds.add(areaId);
  }

  const configuredAreasById = new Map(
    (Array.isArray(settings.areas) ? settings.areas : [])
      .map((area) => [normalizeConfigId(area?.id ?? area?.roomId ?? "", ""), area])
      .filter(([id]) => Boolean(id))
  );

  const tablesByKey = new Set();
  for (const table of Array.isArray(settings.tables) ? settings.tables : []) {
    if (!table || typeof table !== "object") continue;
    const explicitRoomId = normalizeConfigId(table.roomId ?? table.areaId ?? "", "");
    const typeLabel = String(table.type ?? "").trim() || "Sala";
    const key = explicitRoomId || `type:${typeLabel.toLowerCase()}`;
    if (tablesByKey.has(key)) continue;
    tablesByKey.add(key);

    if (explicitRoomId) {
      const configuredArea = configuredAreasById.get(explicitRoomId) ?? null;
      addRoom(
        roomsById,
        {
          id: explicitRoomId,
          name:
            configuredArea?.name ??
            table.roomName ??
            table.areaName ??
            table.type ??
            toTitle(explicitRoomId.replace(/^room_/, "").replace(/^sala_/, "").replace(/_/g, " ")),
        },
        "posSettings.tables"
      );
      usedRoomIds.add(explicitRoomId);
      continue;
    }

    const inferredRoom = inferRoomFromType(typeLabel, usedRoomIds);
    addRoom(roomsById, inferredRoom, "posSettings.tables:type");
  }

  if (includeV2DefaultSeeds) {
    addRoom(roomsById, { id: "room_pedana", name: "Pedana" }, "v2_default_seed");
    addRoom(roomsById, { id: DEFAULT_TARGET_ROOM_ID, name: DEFAULT_TARGET_ROOM_NAME }, "v2_default_seed");
  }

  return [...roomsById.values()].sort((a, b) => a.name.localeCompare(b.name, "it-IT"));
}

function normalizeUserRole(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["admin", "responsabile", "operator"].includes(normalized) ? normalized : "operator";
}

function isPrivilegedRole(role) {
  const normalized = normalizeUserRole(role);
  return normalized === "admin" || normalized === "responsabile";
}

function normalizeUsername(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isGiadaImperato(user) {
  const username = normalizeUsername(user?.username);
  const fullName = normalizeUsername(user?.fullName);
  return username === "giada" || username === "giada_imperato" || fullName === "giada imperato";
}

function isInactiveUser(user) {
  return user?.active === false || user?.enabled === false || user?.disabled === true || user?.deleted === true;
}

function userLabel(user, fallbackIndex) {
  return String(user?.username ?? user?.fullName ?? user?.id ?? `user_${fallbackIndex + 1}`).trim();
}

export function auditRoomPermissionsState(state, options = {}) {
  const targetRoomId = normalizeConfigId(options.targetRoomId ?? DEFAULT_TARGET_ROOM_ID, DEFAULT_TARGET_ROOM_ID);
  const targetRoomName = String(options.targetRoomName ?? DEFAULT_TARGET_ROOM_NAME).trim() || targetRoomId;
  const configuredRooms = collectConfiguredRooms(state?.posSettings, options);
  const configuredRoom = configuredRooms.find((room) => room.id === targetRoomId) ?? null;
  const users = Array.isArray(state?.users) ? state.users : [];
  const activeUsers = users.filter((user) => !isInactiveUser(user));
  const findings = [];

  activeUsers.forEach((user, index) => {
    const role = normalizeUserRole(user?.role);
    const privileged = isPrivilegedRole(role);
    const enabledRoomIds = normalizeRoomIdList(user?.enabledRoomIds);
    const authorizedRoomIds = normalizeRoomIdList(user?.authorizedRoomIds);
    const enabledImplicitAll = !Array.isArray(user?.enabledRoomIds) || enabledRoomIds.length === 0;
    const authorizedImplicitAll = privileged || (!Array.isArray(user?.authorizedRoomIds) && isGiadaImperato(user));
    const enabled = privileged || enabledImplicitAll || enabledRoomIds.includes(targetRoomId);
    const authorized = privileged || authorizedImplicitAll || authorizedRoomIds.includes(targetRoomId);
    const status = enabled && authorized ? "ok" : enabled ? "missing_authorized" : "missing_enabled";

    findings.push({
      id: String(user?.id ?? "").trim(),
      username: String(user?.username ?? "").trim(),
      fullName: String(user?.fullName ?? "").trim(),
      label: userLabel(user, index),
      role,
      privileged,
      enabled,
      authorized,
      enabledImplicitAll,
      authorizedImplicitAll,
      enabledRoomIds,
      authorizedRoomIds,
      status,
    });
  });

  const missingEnabled = findings.filter((entry) => entry.status === "missing_enabled");
  const missingAuthorized = findings.filter((entry) => entry.status === "missing_authorized");
  const ok = findings.filter((entry) => entry.status === "ok");

  return {
    targetRoomId,
    targetRoomName,
    configured: Boolean(configuredRoom),
    configuredRoom,
    configuredRooms,
    totals: {
      users: users.length,
      activeUsers: activeUsers.length,
      inactiveUsers: users.length - activeUsers.length,
      privilegedUsers: findings.filter((entry) => entry.privileged).length,
      ok: ok.length,
      missingEnabled: missingEnabled.length,
      missingAuthorized: missingAuthorized.length,
      review: missingEnabled.length + missingAuthorized.length,
    },
    findings,
    missingEnabled,
    missingAuthorized,
  };
}

async function loadDatabaseSync() {
  if (!DatabaseSyncClass) {
    const sqliteModule = await import("node:sqlite");
    DatabaseSyncClass = sqliteModule.DatabaseSync;
  }
  return DatabaseSyncClass;
}

async function readJsonState(dbPath) {
  const raw = await fs.readFile(dbPath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Stato JSON non valido: ${dbPath}`);
  }
  return parsed;
}

async function readSqliteState(dbPath) {
  const DatabaseSync = await loadDatabaseSync();
  const sqlite = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = sqlite.prepare("SELECT json FROM app_state WHERE id = 1").get();
    if (!row?.json) {
      throw new Error(`Stato SQLite privo di app_state id=1: ${dbPath}`);
    }
    const parsed = JSON.parse(row.json);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Stato SQLite non valido: ${dbPath}`);
    }
    return parsed;
  } finally {
    sqlite.close();
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveAuditConfig(args, env = process.env) {
  const dbModeRaw = String(args["db-mode"] ?? env.BACKEND_DB_MODE ?? "json").trim().toLowerCase();
  const dbMode = dbModeRaw === "sqlite" ? "sqlite" : "json";
  const cliDbPath = String(args.db ?? args.path ?? "").trim();
  const envDbPath = String(env.BACKEND_DB_PATH ?? (dbMode === "sqlite" ? env.SQLITE_DB_PATH ?? "" : "")).trim();
  const dbPath = path.resolve(
    cliDbPath || envDbPath || (dbMode === "sqlite" ? DEFAULT_SQLITE_DB_PATH : DEFAULT_JSON_DB_PATH)
  );
  const targetRoomId = normalizeConfigId(args.room ?? args["room-id"] ?? env.AUDIT_ROOM_ID ?? DEFAULT_TARGET_ROOM_ID, DEFAULT_TARGET_ROOM_ID);
  const targetRoomName = String(args["room-name"] ?? env.AUDIT_ROOM_NAME ?? DEFAULT_TARGET_ROOM_NAME).trim() || targetRoomId;
  return {
    dbMode,
    dbPath,
    targetRoomId,
    targetRoomName,
    json: asBooleanFlag(args.json),
    failOnReview: asBooleanFlag(args["fail-on-review"]),
    failOnMissingEnabled: asBooleanFlag(args["fail-on-missing-enabled"]),
    failOnMissingAuthorized: asBooleanFlag(args["fail-on-missing-authorized"]),
    includeV2DefaultSeeds: !asBooleanFlag(args["no-v2-default-seeds"]),
  };
}

async function readStateForConfig(config) {
  if (config.dbMode === "sqlite") {
    return readSqliteState(config.dbPath);
  }
  if (await pathExists(config.dbPath)) {
    return readJsonState(config.dbPath);
  }
  if (config.dbPath === DEFAULT_JSON_DB_PATH && (await pathExists(LEGACY_JSON_DB_PATH))) {
    return readJsonState(LEGACY_JSON_DB_PATH);
  }
  throw new Error(`File stato non trovato: ${config.dbPath}`);
}

function formatFindingLine(entry, targetRoomId) {
  const user = entry.username || entry.fullName || entry.id || entry.label;
  const enabled = entry.enabled ? "enabled=ok" : "enabled=MISSING";
  const authorized = entry.authorized ? "authorized=ok" : "authorized=MISSING";
  const implicit = [entry.enabledImplicitAll ? "enabled implicit-all" : "", entry.authorizedImplicitAll ? "authorized implicit-all" : ""]
    .filter(Boolean)
    .join(", ");
  return `- ${user} (${entry.role}) ${enabled} ${authorized}${implicit ? ` [${implicit}]` : ""}; target=${targetRoomId}`;
}

function printHumanReport(report, config) {
  console.log("Audit permessi stanze POS");
  console.log(`DB: ${config.dbPath} (${config.dbMode})`);
  console.log(`Target: ${report.targetRoomId} (${report.targetRoomName})`);
  console.log(
    `Configurazione stanza: ${report.configured ? "OK" : "NON TROVATA"}` +
      (report.configuredRoom?.sources?.length ? ` [${report.configuredRoom.sources.join(", ")}]` : "")
  );
  console.log(
    `Utenti: ${report.totals.users} totali, ${report.totals.activeUsers} attivi, ${report.totals.privilegedUsers} privilegiati, ` +
      `${report.totals.review} da verificare`
  );

  if (!report.configured) {
    console.log(`\nATTENZIONE: ${report.targetRoomId} non risulta tra le stanze configurate o seed runtime.`);
  }

  if (report.missingEnabled.length > 0) {
    console.log("\nUtenti con stanza non abilitata:");
    report.missingEnabled.forEach((entry) => console.log(formatFindingLine(entry, report.targetRoomId)));
  }

  if (report.missingAuthorized.length > 0) {
    console.log("\nUtenti con stanza abilitata ma non autorizzata:");
    report.missingAuthorized.forEach((entry) => console.log(formatFindingLine(entry, report.targetRoomId)));
  }

  if (report.totals.review === 0 && report.configured) {
    console.log("\nEsito: OK, nessun utente attivo da riallineare per la stanza target.");
    return;
  }

  console.log("\nAzione consigliata:");
  console.log(
    `- aggiungere ${report.targetRoomId} a enabledRoomIds per gli utenti che devono vedere la stanza tra le opzioni;`
  );
  console.log(
    `- aggiungere ${report.targetRoomId} a authorizedRoomIds per gli utenti che devono entrarci senza autorizzazione admin;`
  );
  console.log("- lasciare la riga invariata solo se la restrizione è voluta.");
}

async function main() {
  const args = parseAuditArgs(process.argv.slice(2));
  const config = resolveAuditConfig(args);
  const state = await readStateForConfig(config);
  const report = auditRoomPermissionsState(state, config);

  if (config.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report, config);
  }

  const shouldFail =
    !report.configured ||
    (config.failOnReview && report.totals.review > 0) ||
    (config.failOnMissingEnabled && report.totals.missingEnabled > 0) ||
    (config.failOnMissingAuthorized && report.totals.missingAuthorized > 0);
  if (shouldFail) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
