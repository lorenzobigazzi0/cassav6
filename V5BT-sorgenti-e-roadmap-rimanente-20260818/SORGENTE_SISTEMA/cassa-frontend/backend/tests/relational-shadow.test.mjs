import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { hashPin } from "../auth/password.js";
import { createAppStateRepository } from "../db/app-state/index.js";
import {
  createRelationalRuntime,
  openRelationalConnection,
  runRelationalMigrations,
  syncAuditEventsFromAppState,
  syncRelationalShadowAfterAppStateWrite,
  syncSaleSessionsFromAppState,
  syncSessionsFromAppState,
  syncUsersFromAppState,
  SaleSessionsRelationalRepository,
  SessionsRelationalRepository,
  UsersRelationalRepository,
} from "../db/relational/index.js";
import { closeRelationalConnection } from "../db/relational/connection.js";
import { RELATIONAL_MIGRATIONS } from "../db/relational/migrations.js";
import { createAuthRepository } from "../modules/auth/auth.repository.js";
import {
  buildTestState,
  createTempRunDir,
  readJson,
  startBackend,
  TEST_TOKEN_SECRET,
} from "./helpers/test-server.mjs";

const expectedMigrationVersions = RELATIONAL_MIGRATIONS.map((migration) => migration.version);

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function isValidState(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.users) &&
    Array.isArray(data.sessions) &&
    data.meta &&
    typeof data.meta === "object"
  );
}

function nowIso() {
  return "2026-05-13T10:00:00.000Z";
}

function relationalConfig(dbPath) {
  return {
    enabled: true,
    mode: "shadow",
    dbPath,
  };
}

function hashTestSessionToken(token) {
  return createHmac("sha256", TEST_TOKEN_SECRET).update(token).digest("hex");
}

function activeRelationalSessionTimestamps() {
  const now = Date.now();
  return {
    createdAt: new Date(now - 60_000).toISOString(),
    lastSeenAt: new Date(now - 30_000).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
  };
}

async function openMigratedDb(dbPath) {
  const db = await openRelationalConnection(relationalConfig(dbPath));
  await runRelationalMigrations(db, { nowIso });
  return db;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function indexExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
}

function buildAuditState() {
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-05-13T10:10:00.000Z";
  state.auditEvents = [
    {
      id: "evt_a",
      occurredAt: "2026-05-13T10:01:00.000Z",
      actorUserId: "u_admin",
      actorRole: "ADMIN",
      roomId: "room_pedana",
      deviceId: "device-a",
      action: "order.created",
      entityType: "order",
      entityId: "ord_1",
      correlationId: "corr-a",
      payload: { total: 12, tags: ["shadow"] },
      before: { due: 0 },
      after: { due: 12 },
      deletedAt: null,
      deletedBy: null,
      deleteReason: null,
    },
    {
      id: "evt_b",
      occurredAt: "2026-05-13T10:02:00.000Z",
      actorUserId: "u_admin",
      actorRole: "ADMIN",
      roomId: null,
      deviceId: null,
      action: "security.admin_delete",
      entityType: "audit_event",
      entityId: "evt_old",
      correlationId: null,
      payload: { reason: "cleanup" },
      before: null,
      after: { deleted: true },
      deletedAt: "2026-05-13T10:03:00.000Z",
      deletedBy: "u_admin",
      deleteReason: "cleanup test",
    },
  ];
  return state;
}

function buildUsersState() {
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-05-13T11:10:00.000Z";
  state.users = state.users.map((user) => ({ ...user }));
  state.users[0] = {
    ...state.users[0],
    active: true,
    defaultRoomId: "room_pedana",
    lastSelectedRoomId: "room_sala",
    lastSelectedRoomName: "Sala",
    lastSelectedRoomAt: "2026-05-13T11:00:00.000Z",
    lastSelectedRoomDeviceUuid: "device-admin",
    allowedPaymentMethodIds: ["pay_cash", "pay_card"],
    favoriteColor: "verde",
    pin: "1111",
  };
  state.users[1] = {
    ...state.users[1],
    active: false,
    allowedPaymentMethodIds: ["pay_cash"],
  };
  return state;
}

function buildSessionsState() {
  const state = buildUsersState();
  state.meta.lastWriteAt = "2026-05-13T12:10:00.000Z";
  state.sessions = [
    {
      id: "sess_active",
      userId: "u_admin",
      tokenHash: "hash_active",
      deviceUuid: "device-active",
      clientApp: "cassa-frontend",
      createdAt: "2026-05-13T12:00:00.000Z",
      lastSeenAt: "2026-05-13T12:01:00.000Z",
      expiresAt: "2026-05-14T12:00:00.000Z",
      roomId: "room_pedana",
      extraNote: "sessione attiva",
      token: "clear-active-token",
    },
    {
      id: "sess_revoked",
      userId: "u_cashier",
      tokenHash: "hash_revoked",
      deviceUuid: "device-revoked",
      clientApp: "mobile-frontend",
      createdAt: "2026-05-13T11:00:00.000Z",
      lastSeenAt: "2026-05-13T11:05:00.000Z",
      expiresAt: "2026-05-14T11:00:00.000Z",
      revokedAt: "2026-05-13T11:06:00.000Z",
    },
    {
      id: "sess_expired",
      userId: "u_admin",
      token: "legacy-expired-token",
      deviceUuid: "device-expired",
      clientApp: "postazione",
      createdAt: "2026-05-12T08:00:00.000Z",
      lastSeenAt: "2026-05-12T08:10:00.000Z",
      expiresAt: "2026-05-12T09:00:00.000Z",
    },
  ];
  return state;
}

function buildSaleSessionsState() {
  const state = buildSessionsState();
  state.meta.lastWriteAt = "2026-05-13T13:10:00.000Z";
  state.saleSessions = [
    {
      id: "sale_open",
      templateId: "shift_day",
      templateName: "Diurna",
      scheduledStart: "08:00",
      scheduledEnd: "20:00",
      businessDate: "2026-05-13",
      startedAt: "2026-05-13T08:00:00.000Z",
      startedByUserId: "u_admin",
      startedByUsername: "admin_test",
      endedAt: null,
      endedByUserId: null,
      endedByUsername: null,
      extraNote: "apertura test",
    },
    {
      id: "sale_closed",
      templateId: "shift_night",
      templateName: "Notturna",
      scheduledStart: "20:00",
      scheduledEnd: "04:00",
      businessDate: "2026-05-12",
      startedAt: "2026-05-12T20:00:00.000Z",
      startedByUserId: "u_cashier",
      startedByUsername: "cashier",
      endedAt: "2026-05-13T04:00:00.000Z",
      endedByUserId: "u_manager",
      endedByUsername: "manager",
      closingTotalCents: 12345,
    },
  ];
  state.solarClosures = [
    {
      id: "solar_20260512",
      key: "2026-05-12",
      transmittedAt: "2026-05-13T04:05:00.000Z",
      closedAt: "2026-05-13T04:05:00.000Z",
      printerStatus: "accepted",
      printerResponseCode: "RT_OK",
      totalSaleSessions: 1,
      saleSessionIds: ["sale_closed"],
    },
  ];
  return state;
}

function createRepositoryOptions({ dbPath, afterWrite, logger }) {
  return {
    mode: "json",
    dbPath,
    dbTmpPath: `${dbPath}.tmp`,
    defaultJsonDbPath: dbPath,
    legacyJsonDbPath: "",
    sqliteImportJsonPath: "",
    buildInitialState: buildTestState,
    isValidState,
    migrateState: () => false,
    cloneJson,
    nowIso: () => new Date().toISOString(),
    safePathExists: existsSync,
    canInitializeMissingDb: () => true,
    canInitializeExistingEmptyDb: () => true,
    buildEmptyDbInitDeniedMessage: (kind, targetPath) => `${kind} init denied: ${targetPath}`,
    logger: logger ?? { warn() {} },
    afterWrite,
  };
}

async function login(baseUrl, username = "admin_test", pin = "1111", deviceUuid = "rel-shadow-device") {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, pin, deviceUuid, clientApp: "cassa" }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function updateRelationalUserPin(relationalPath, userId, pin) {
  const db = await openRelationalConnection(relationalConfig(relationalPath));
  try {
    db.prepare("UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?").run(hashPin(pin), nowIso(), userId);
  } finally {
    closeRelationalConnection(db);
  }
}

async function insertRelationalSession(relationalPath, session) {
  const db = await openRelationalConnection(relationalConfig(relationalPath));
  try {
    db.prepare(
      `
        INSERT INTO sessions (
          id,
          user_id,
          token_hash,
          device_uuid,
          client_app,
          created_at,
          last_seen_at,
          expires_at,
          revoked_at,
          raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      session.id,
      session.userId,
      session.tokenHash,
      session.deviceUuid,
      session.clientApp ?? null,
      session.createdAt,
      session.lastSeenAt ?? null,
      session.expiresAt ?? null,
      session.revokedAt ?? null,
      JSON.stringify(session.raw ?? {})
    );
  } finally {
    closeRelationalConnection(db);
  }
}

test("relational migrations crea schema_migrations", async () => {
  const runDir = await createTempRunDir("rel-migrations-schema");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(tableExists(db, "schema_migrations"), true);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count,
      expectedMigrationVersions.length
    );
  } finally {
    closeRelationalConnection(db);
  }
});

test("relational migrations crea relational_sync_state", async () => {
  const runDir = await createTempRunDir("rel-migrations-sync-state");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(tableExists(db, "relational_sync_state"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("relational migrations crea audit_events", async () => {
  const runDir = await createTempRunDir("rel-migrations-audit");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(tableExists(db, "audit_events"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("relational migrations e idempotente", async () => {
  const runDir = await createTempRunDir("rel-migrations-idempotent");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    await runRelationalMigrations(db, { nowIso });
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    assert.deepEqual(rows.map((row) => row.version), expectedMigrationVersions);
  } finally {
    closeRelationalConnection(db);
  }
});

test("migrazione 003_users crea tutte le tabelle users", async () => {
  const runDir = await createTempRunDir("rel-migrations-users");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(tableExists(db, "users"), true);
    assert.equal(tableExists(db, "user_permissions"), true);
    assert.equal(tableExists(db, "user_enabled_rooms"), true);
    assert.equal(tableExists(db, "user_authorized_rooms"), true);
    assert.equal(tableExists(db, "user_payment_methods"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("migrazione 004_sessions crea sessions e indici", async () => {
  const runDir = await createTempRunDir("rel-migrations-sessions");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(tableExists(db, "sessions"), true);
    assert.equal(indexExists(db, "idx_sessions_token_hash"), true);
    assert.equal(indexExists(db, "idx_sessions_user_device"), true);
    assert.equal(indexExists(db, "idx_sessions_expires_at"), true);
    assert.equal(indexExists(db, "idx_sessions_revoked_at"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("migrazione 005_sale_sessions crea sale_sessions e solar_closures", async () => {
  const runDir = await createTempRunDir("rel-migrations-sale-sessions");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    assert.equal(tableExists(db, "sale_sessions"), true);
    assert.equal(tableExists(db, "solar_closures"), true);
    assert.equal(indexExists(db, "idx_sale_sessions_business_date"), true);
    assert.equal(indexExists(db, "idx_sale_sessions_status"), true);
    assert.equal(indexExists(db, "idx_sale_sessions_opened_at"), true);
    assert.equal(indexExists(db, "idx_solar_closures_business_date"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("BACKEND_RELATIONAL_ENABLED non impostato non crea il DB relazionale", async () => {
  const runDir = await createTempRunDir("rel-disabled");
  const dbPath = path.join(runDir, "backend-relational.sqlite");
  const runtime = createRelationalRuntime({
    env: {},
    defaultDbPath: dbPath,
    logger: { warn() {} },
    nowIso,
  });
  await runtime.initialize();
  runtime.close();
  assert.equal(existsSync(dbPath), false);
});

test("BACKEND_RELATIONAL_ENABLED=1 in shadow crea il DB relazionale", async () => {
  const runDir = await createTempRunDir("rel-enabled");
  const dbPath = path.join(runDir, "backend-relational.sqlite");
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: dbPath,
    },
    defaultDbPath: dbPath,
    logger: { warn() {} },
    nowIso,
  });
  await runtime.initialize();
  runtime.close();
  assert.equal(existsSync(dbPath), true);
});

test("BACKEND_RELATIONAL_MODE=primary abilita solo i domini espliciti", () => {
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users,sessions,menuSettings,saleSessions",
    },
    logger: { warn() {} },
    nowIso,
  });
  assert.equal(runtime.mode, "primary");
  assert.equal(runtime.isPrimaryDomain("users"), true);
  assert.equal(runtime.isPrimaryDomain("sessions"), true);
  assert.equal(runtime.isPrimaryDomain("menuSettings"), true);
  assert.equal(runtime.isPrimaryDomain("saleSessions"), true);
  assert.equal(runtime.isPrimaryDomain("auditEvents"), false);
});

test("errore relazionale in primary mode produce errore chiaro", () => {
  const runtime = {
    db: null,
    mode: "primary",
    isPrimaryDomain(domain) {
      return domain === "users";
    },
  };
  const repository = createAuthRepository({ relationalRuntime: runtime });
  assert.throws(
    () => repository.getUserById({ users: [] }, "u_admin"),
    /DB relazionale primary non disponibile per users/i
  );
});

test("login legge utente da app-state quando primary domains non contiene users", async (t) => {
  const runDir = await createTempRunDir("rel-primary-login-app-state");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "sessions",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
  });
  await updateRelationalUserPin(relationalPath, "u_admin", "9999");

  const rejected = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "admin_test",
      pin: "9999",
      deviceUuid: "primary-app-state-user",
      clientApp: "cassa",
    }),
  });
  assert.equal(rejected.status, 401);

  const accepted = await login(baseUrl, "admin_test", "1111", "primary-app-state-user-ok");
  assert.equal(accepted.user.id, "u_admin");
});

test("login legge utente dal relazionale quando primary domains contiene users", async (t) => {
  const runDir = await createTempRunDir("rel-primary-login-users");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
  });
  await updateRelationalUserPin(relationalPath, "u_admin", "9999");

  const accepted = await login(baseUrl, "admin_test", "9999", "primary-rel-user");
  assert.equal(accepted.user.id, "u_admin");
});

test("session status legge sessione da app-state quando primary domains non contiene sessions", async (t) => {
  const runDir = await createTempRunDir("rel-primary-status-app-state");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
  });
  await insertRelationalSession(relationalPath, {
    id: "sess_rel_only_app_state_status",
    userId: "u_admin",
    tokenHash: hashTestSessionToken("rel-only-status-token"),
    deviceUuid: "rel-only-status-device",
    clientApp: "cassa",
    ...activeRelationalSessionTimestamps(),
  });

  const response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "rel-only-status-token",
      userId: "u_admin",
      deviceUuid: "rel-only-status-device",
      clientApp: "cassa",
    }),
  });
  assert.equal(response.status, 401);
});

test("session status legge sessione dal relazionale quando primary domains contiene sessions", async (t) => {
  const runDir = await createTempRunDir("rel-primary-status-sessions");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "sessions",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
  });
  await insertRelationalSession(relationalPath, {
    id: "sess_rel_only_status",
    userId: "u_admin",
    tokenHash: hashTestSessionToken("rel-only-status-token"),
    deviceUuid: "rel-only-status-device",
    clientApp: "cassa",
    ...activeRelationalSessionTimestamps(),
  });

  const response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "rel-only-status-token",
      userId: "u_admin",
      deviceUuid: "rel-only-status-device",
      clientApp: "cassa",
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.sessionId, "sess_rel_only_status");
});

test("lettura users primary mantiene permessi, stanze e metodi pagamento identici", async (t) => {
  const runDir = await createTempRunDir("rel-primary-users-shape");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { dbPath } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
  });
  const appState = await readJson(dbPath);
  const appUser = appState.users.find((entry) => entry.id === "u_admin");
  const db = await openRelationalConnection(relationalConfig(relationalPath));
  try {
    const relUser = new UsersRelationalRepository(db).getById("u_admin");
    assert.deepEqual(relUser.permissions, appUser.permissions);
    assert.deepEqual(relUser.authorizedRoomIds, appUser.authorizedRoomIds);
    assert.deepEqual(relUser.allowedPaymentMethodIds, appUser.allowedPaymentMethodIds);
  } finally {
    closeRelationalConnection(db);
  }
});

test("deviceUuid binding continua a funzionare con sessions primary", async (t) => {
  const runDir = await createTempRunDir("rel-primary-device-binding");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "sessions",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
  });
  await insertRelationalSession(relationalPath, {
    id: "sess_device_binding",
    userId: "u_admin",
    tokenHash: hashTestSessionToken("device-bound-token"),
    deviceUuid: "device-a",
    clientApp: "cassa",
    ...activeRelationalSessionTimestamps(),
  });

  const response = await fetch(`${baseUrl}/api/auth/session/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "device-bound-token",
      userId: "u_admin",
      deviceUuid: "device-b",
      clientApp: "cassa",
    }),
  });
  assert.equal(response.status, 401);
});

test("logout con sessions primary invalida sessione e sincronizza il relazionale", async (t) => {
  const runDir = await createTempRunDir("rel-primary-logout");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "sessions",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
  });
  await insertRelationalSession(relationalPath, {
    id: "sess_rel_only_logout",
    userId: "u_admin",
    tokenHash: hashTestSessionToken("rel-only-logout-token"),
    deviceUuid: "rel-only-logout-device",
    clientApp: "cassa",
    ...activeRelationalSessionTimestamps(),
  });

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "rel-only-logout-token",
      userId: "u_admin",
      deviceUuid: "rel-only-logout-device",
      clientApp: "cassa",
    }),
  });
  assert.equal(logoutResponse.status, 200);

  const db = await openRelationalConnection(relationalConfig(relationalPath));
  try {
    assert.equal(new SessionsRelationalRepository(db).getById("sess_rel_only_logout"), null);
  } finally {
    closeRelationalConnection(db);
  }
});

test("response shape login resta identica con users primary", async (t) => {
  const appStateRunDir = await createTempRunDir("rel-primary-login-shape-app");
  const appStateServer = await startBackend(t, { runDir: appStateRunDir });
  const appStateLogin = await login(appStateServer.baseUrl, "admin_test", "1111", "shape-app");

  const primaryRunDir = await createTempRunDir("rel-primary-login-shape-primary");
  const relationalPath = path.join(primaryRunDir, "backend-relational.sqlite");
  const primaryServer = await startBackend(t, {
    runDir: primaryRunDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "users",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
  });
  const primaryLogin = await login(primaryServer.baseUrl, "admin_test", "1111", "shape-primary");

  assert.deepEqual(Object.keys(primaryLogin).sort(), Object.keys(appStateLogin).sort());
  assert.deepEqual(Object.keys(primaryLogin.user).sort(), Object.keys(appStateLogin.user).sort());
});

test("syncAuditEventsFromAppState importa eventi validi", async () => {
  const runDir = await createTempRunDir("rel-sync-import");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncAuditEventsFromAppState(db, buildAuditState(), { nowIso });
    const rows = db.prepare("SELECT id, action, app_state_position FROM audit_events ORDER BY app_state_position").all();
    assert.deepEqual(rows.map((row) => row.id), ["evt_a", "evt_b"]);
    assert.equal(rows[0].action, "order.created");
    assert.equal(rows[1].app_state_position, 1);
  } finally {
    closeRelationalConnection(db);
  }
});

test("syncAuditEventsFromAppState preserva payload/before/after", async () => {
  const runDir = await createTempRunDir("rel-sync-json-fields");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncAuditEventsFromAppState(db, buildAuditState(), { nowIso });
    const row = db.prepare("SELECT payload_json, before_json, after_json FROM audit_events WHERE id = 'evt_a'").get();
    assert.deepEqual(JSON.parse(row.payload_json), { total: 12, tags: ["shadow"] });
    assert.deepEqual(JSON.parse(row.before_json), { due: 0 });
    assert.deepEqual(JSON.parse(row.after_json), { due: 12 });
  } finally {
    closeRelationalConnection(db);
  }
});

test("syncAuditEventsFromAppState preserva deletedAt/deletedBy/deleteReason", async () => {
  const runDir = await createTempRunDir("rel-sync-delete-fields");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncAuditEventsFromAppState(db, buildAuditState(), { nowIso });
    const row = db
      .prepare("SELECT deleted_at, deleted_by, delete_reason FROM audit_events WHERE id = 'evt_b'")
      .get();
    assert.equal(row.deleted_at, "2026-05-13T10:03:00.000Z");
    assert.equal(row.deleted_by, "u_admin");
    assert.equal(row.delete_reason, "cleanup test");
  } finally {
    closeRelationalConnection(db);
  }
});

test("syncAuditEventsFromAppState aggiorna relational_sync_state", async () => {
  const runDir = await createTempRunDir("rel-sync-state");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const result = syncAuditEventsFromAppState(db, buildAuditState(), { nowIso });
    const row = db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'auditEvents'").get();
    assert.equal(row.source_last_write_at, "2026-05-13T10:10:00.000Z");
    assert.equal(row.row_count, 2);
    assert.equal(row.checksum, result.checksum);
    assert.equal(row.synced_at, "2026-05-13T10:00:00.000Z");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync users importa utenti", async () => {
  const runDir = await createTempRunDir("rel-users-import");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildUsersState();
    syncUsersFromAppState(db, state, { nowIso });
    const rows = db.prepare("SELECT id, username, role FROM users ORDER BY username").all();
    assert.equal(rows.length, state.users.length);
    assert.equal(rows.some((row) => row.id === "u_admin" && row.username === "admin_test"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync users importa permissions", async () => {
  const runDir = await createTempRunDir("rel-users-permissions");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncUsersFromAppState(db, buildUsersState(), { nowIso });
    const rows = db
      .prepare("SELECT permission FROM user_permissions WHERE user_id = 'u_admin' ORDER BY permission")
      .all();
    assert.equal(rows.some((row) => row.permission === "manage_users"), true);
    assert.equal(rows.some((row) => row.permission === "collect_payments"), true);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync users importa enabled rooms", async () => {
  const runDir = await createTempRunDir("rel-users-enabled-rooms");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildUsersState();
    syncUsersFromAppState(db, state, { nowIso });
    const expectedRoomIds = state.users
      .find((user) => user.id === "u_cashier")
      .enabledRoomIds
      .slice()
      .sort();
    const rows = db
      .prepare("SELECT room_id FROM user_enabled_rooms WHERE user_id = 'u_cashier' ORDER BY room_id")
      .all();
    assert.deepEqual(rows.map((row) => row.room_id), expectedRoomIds);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync users importa authorized rooms", async () => {
  const runDir = await createTempRunDir("rel-users-authorized-rooms");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildUsersState();
    syncUsersFromAppState(db, state, { nowIso });
    const expectedRoomIds = state.users
      .find((user) => user.id === "u_manager")
      .authorizedRoomIds
      .slice()
      .sort();
    const rows = db
      .prepare("SELECT room_id FROM user_authorized_rooms WHERE user_id = 'u_manager' ORDER BY room_id")
      .all();
    assert.deepEqual(rows.map((row) => row.room_id), expectedRoomIds);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync users importa payment methods", async () => {
  const runDir = await createTempRunDir("rel-users-payment-methods");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncUsersFromAppState(db, buildUsersState(), { nowIso });
    const rows = db
      .prepare("SELECT payment_method_id FROM user_payment_methods WHERE user_id = 'u_admin' ORDER BY payment_method_id")
      .all();
    assert.deepEqual(rows.map((row) => row.payment_method_id), ["pay_card", "pay_cash"]);
  } finally {
    closeRelationalConnection(db);
  }
});

test("users repository getByUsername funziona", async () => {
  const runDir = await createTempRunDir("rel-users-get-username");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncUsersFromAppState(db, buildUsersState(), { nowIso });
    const user = new UsersRelationalRepository(db).getByUsername("admin_test");
    assert.equal(user.id, "u_admin");
    assert.deepEqual(user.paymentMethodIds, ["pay_cash", "pay_card"]);
    assert.deepEqual(user.allowedPaymentMethodIds, ["pay_cash", "pay_card"]);
  } finally {
    closeRelationalConnection(db);
  }
});

test("users repository getById funziona", async () => {
  const runDir = await createTempRunDir("rel-users-get-id");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncUsersFromAppState(db, buildUsersState(), { nowIso });
    const user = new UsersRelationalRepository(db).getById("u_cashier");
    assert.equal(user.username, "cashier");
    assert.equal(user.active, false);
    assert.deepEqual(user.permissions, ["collect_payments", "print_orders", "view_analytics", "create_bar_replacement"]);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync users normalizza active a 0/1", async () => {
  const runDir = await createTempRunDir("rel-users-active");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncUsersFromAppState(db, buildUsersState(), { nowIso });
    const rows = db.prepare("SELECT id, active FROM users ORDER BY id").all();
    assert.equal(rows.find((row) => row.id === "u_admin").active, 1);
    assert.equal(rows.find((row) => row.id === "u_cashier").active, 0);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync users non salva mai PIN in chiaro", async () => {
  const runDir = await createTempRunDir("rel-users-pin");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncUsersFromAppState(db, buildUsersState(), { nowIso });
    const row = db.prepare("SELECT pin_hash, raw_json FROM users WHERE id = 'u_admin'").get();
    const raw = JSON.parse(row.raw_json);
    assert.notEqual(row.pin_hash, "1111");
    assert.equal(row.raw_json.includes('"pin"'), false);
    assert.equal(Object.hasOwn(raw, "pin"), false);
    assert.equal(Object.hasOwn(raw, "plainPin"), false);
    assert.equal(Object.hasOwn(raw, "pinCode"), false);
    assert.equal(raw.pinHash === "1111", false);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync users raw_json preserva campi non mappati", async () => {
  const runDir = await createTempRunDir("rel-users-raw");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    syncUsersFromAppState(db, buildUsersState(), { nowIso });
    const row = db.prepare("SELECT raw_json FROM users WHERE id = 'u_admin'").get();
    assert.equal(JSON.parse(row.raw_json).favoriteColor, "verde");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync users aggiorna relational_sync_state", async () => {
  const runDir = await createTempRunDir("rel-users-sync-state");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildUsersState();
    const result = syncUsersFromAppState(db, state, { nowIso });
    const row = db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'users'").get();
    assert.equal(row.source_last_write_at, "2026-05-13T11:10:00.000Z");
    assert.equal(row.row_count, state.users.length);
    assert.equal(row.checksum, result.checksum);
    assert.equal(row.synced_at, "2026-05-13T10:00:00.000Z");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync sessions importa sessioni attive", async () => {
  const runDir = await createTempRunDir("rel-sessions-active");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSessionsState();
    syncUsersFromAppState(db, state, { nowIso });
    syncSessionsFromAppState(db, state, { nowIso, tokenSecret: "session-secret" });
    const active = new SessionsRelationalRepository(db).list({
      activeOnly: true,
      nowIso: () => "2026-05-13T12:02:00.000Z",
    });
    assert.deepEqual(active.map((session) => session.id), ["sess_active"]);
    assert.equal(active[0].deviceUuid, "device-active");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync sessions importa sessioni revocate e scadute se presenti", async () => {
  const runDir = await createTempRunDir("rel-sessions-revoked-expired");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSessionsState();
    syncUsersFromAppState(db, state, { nowIso });
    syncSessionsFromAppState(db, state, { nowIso, tokenSecret: "session-secret" });
    const sessions = new SessionsRelationalRepository(db).list({ includeRevoked: true });
    assert.deepEqual(sessions.map((session) => session.id), ["sess_expired", "sess_revoked", "sess_active"]);
    assert.equal(sessions.find((session) => session.id === "sess_revoked").revokedAt, "2026-05-13T11:06:00.000Z");
    assert.equal(sessions.find((session) => session.id === "sess_expired").expiresAt, "2026-05-12T09:00:00.000Z");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sessions repository getByTokenHash funziona", async () => {
  const runDir = await createTempRunDir("rel-sessions-token-hash");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSessionsState();
    syncUsersFromAppState(db, state, { nowIso });
    syncSessionsFromAppState(db, state, { nowIso, tokenSecret: "session-secret" });
    const session = new SessionsRelationalRepository(db).getByTokenHash("hash_active");
    assert.equal(session.id, "sess_active");
    assert.equal(session.userId, "u_admin");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sessions repository listByUserId funziona", async () => {
  const runDir = await createTempRunDir("rel-sessions-user-id");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSessionsState();
    syncUsersFromAppState(db, state, { nowIso });
    syncSessionsFromAppState(db, state, { nowIso, tokenSecret: "session-secret" });
    const sessions = new SessionsRelationalRepository(db).listByUserId("u_admin");
    assert.deepEqual(sessions.map((session) => session.id), ["sess_expired", "sess_active"]);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync sessions non salva token in chiaro nel DB relazionale", async () => {
  const runDir = await createTempRunDir("rel-sessions-no-clear-token");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSessionsState();
    syncUsersFromAppState(db, state, { nowIso });
    syncSessionsFromAppState(db, state, { nowIso, tokenSecret: "session-secret" });
    const columns = db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name);
    assert.equal(columns.includes("token"), false);
    const rows = db.prepare("SELECT token_hash, raw_json FROM sessions ORDER BY id").all();
    assert.equal(rows.some((row) => row.token_hash === "clear-active-token"), false);
    assert.equal(rows.some((row) => String(row.raw_json).includes("clear-active-token")), false);
    assert.equal(rows.some((row) => String(row.raw_json).includes("legacy-expired-token")), false);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync sessions raw_json preserva campi extra", async () => {
  const runDir = await createTempRunDir("rel-sessions-raw");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSessionsState();
    syncUsersFromAppState(db, state, { nowIso });
    syncSessionsFromAppState(db, state, { nowIso, tokenSecret: "session-secret" });
    const row = db.prepare("SELECT raw_json FROM sessions WHERE id = 'sess_active'").get();
    assert.equal(JSON.parse(row.raw_json).extraNote, "sessione attiva");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync sessions aggiorna relational_sync_state", async () => {
  const runDir = await createTempRunDir("rel-sessions-sync-state");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSessionsState();
    syncUsersFromAppState(db, state, { nowIso });
    const result = syncSessionsFromAppState(db, state, { nowIso, tokenSecret: "session-secret" });
    const row = db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'sessions'").get();
    assert.equal(row.source_last_write_at, "2026-05-13T12:10:00.000Z");
    assert.equal(row.row_count, 3);
    assert.equal(row.checksum, result.checksum);
    assert.equal(row.synced_at, "2026-05-13T10:00:00.000Z");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync sale sessions importa sessione aperta", async () => {
  const runDir = await createTempRunDir("rel-sale-sessions-open");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSaleSessionsState();
    syncSaleSessionsFromAppState(db, state, { nowIso });
    const row = db.prepare("SELECT * FROM sale_sessions WHERE id = 'sale_open'").get();
    assert.equal(row.business_date, "2026-05-13");
    assert.equal(row.opened_at, "2026-05-13T08:00:00.000Z");
    assert.equal(row.opened_by_user_id, "u_admin");
    assert.equal(row.closed_at, null);
    assert.equal(row.status, "open");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync sale sessions importa sessione chiusa", async () => {
  const runDir = await createTempRunDir("rel-sale-sessions-closed");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSaleSessionsState();
    syncSaleSessionsFromAppState(db, state, { nowIso });
    const row = db.prepare("SELECT * FROM sale_sessions WHERE id = 'sale_closed'").get();
    assert.equal(row.business_date, "2026-05-12");
    assert.equal(row.closed_at, "2026-05-13T04:00:00.000Z");
    assert.equal(row.closed_by_user_id, "u_manager");
    assert.equal(row.status, "closed");
    assert.equal(row.closing_total_cents, 12345);
    const closure = db.prepare("SELECT * FROM solar_closures WHERE id = 'solar_20260512'").get();
    assert.equal(closure.business_date, "2026-05-12");
    assert.deepEqual(JSON.parse(closure.totals_json).saleSessionIds, ["sale_closed"]);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sale sessions repository getOpenSession funziona", async () => {
  const runDir = await createTempRunDir("rel-sale-sessions-open-repo");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSaleSessionsState();
    syncSaleSessionsFromAppState(db, state, { nowIso });
    const session = new SaleSessionsRelationalRepository(db).getOpenSession();
    assert.equal(session.id, "sale_open");
    assert.equal(session.startedByUserId, "u_admin");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sale sessions repository getByBusinessDate funziona", async () => {
  const runDir = await createTempRunDir("rel-sale-sessions-business-date");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSaleSessionsState();
    syncSaleSessionsFromAppState(db, state, { nowIso });
    const sessions = new SaleSessionsRelationalRepository(db).getByBusinessDate("2026-05-12");
    assert.deepEqual(sessions.map((session) => session.id), ["sale_closed"]);
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync sale sessions raw_json preserva campi extra", async () => {
  const runDir = await createTempRunDir("rel-sale-sessions-raw");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSaleSessionsState();
    syncSaleSessionsFromAppState(db, state, { nowIso });
    const row = db.prepare("SELECT raw_json FROM sale_sessions WHERE id = 'sale_open'").get();
    assert.equal(JSON.parse(row.raw_json).extraNote, "apertura test");
  } finally {
    closeRelationalConnection(db);
  }
});

test("sync sale sessions aggiorna relational_sync_state", async () => {
  const runDir = await createTempRunDir("rel-sale-sessions-sync-state");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  try {
    const state = buildSaleSessionsState();
    const result = syncSaleSessionsFromAppState(db, state, { nowIso });
    const row = db.prepare("SELECT * FROM relational_sync_state WHERE domain = 'saleSessions'").get();
    assert.equal(row.source_last_write_at, "2026-05-13T13:10:00.000Z");
    assert.equal(row.row_count, 2);
    assert.equal(row.checksum, result.checksum);
    assert.equal(row.synced_at, "2026-05-13T10:00:00.000Z");
  } finally {
    closeRelationalConnection(db);
  }
});

test("writeDb in shadow mode richiama sync auditEvents dopo scrittura app-state", async () => {
  const runDir = await createTempRunDir("rel-write-hook");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
    defaultDbPath: relationalPath,
    logger: { warn() {} },
    nowIso,
  });
  await runtime.initialize();
  const repository = createAppStateRepository(
    createRepositoryOptions({
      dbPath: appStatePath,
      afterWrite: (appState) => runtime.syncAfterAppStateWrite(appState),
    })
  );

  try {
    await repository.writeDb(buildAuditState());
    const rows = runtime.db.prepare("SELECT id FROM audit_events ORDER BY app_state_position").all();
    assert.deepEqual(rows.map((row) => row.id), ["evt_a", "evt_b"]);
    const users = runtime.db.prepare("SELECT id FROM users ORDER BY id").all();
    assert.equal(users.some((row) => row.id === "u_admin"), true);
  } finally {
    runtime.close();
  }
});

test("errore sync users in shadow non rompe writeDb", async () => {
  const runDir = await createTempRunDir("rel-users-write-error");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const warnings = [];
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
    defaultDbPath: relationalPath,
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
    },
    nowIso,
  });
  const repository = createAppStateRepository(
    createRepositoryOptions({
      dbPath: appStatePath,
      afterWrite: (appState) => syncRelationalShadowAfterAppStateWrite(appState, runtime),
    })
  );
  const state = buildUsersState();
  state.users[1] = {
    ...state.users[1],
    username: state.users[0].username,
  };

  try {
    await repository.writeDb(state);
    const persisted = await readJson(appStatePath);
    assert.equal(persisted.users.length, state.users.length);
    assert.equal(warnings.some((message) => /Sync relazionale shadow app-state fallita/i.test(message)), true);
  } finally {
    runtime.close();
  }
});

test("errore sync sessions in shadow non rompe writeDb", async () => {
  const runDir = await createTempRunDir("rel-sessions-write-error");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const warnings = [];
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
    defaultDbPath: relationalPath,
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
    },
    nowIso,
  });
  const repository = createAppStateRepository(
    createRepositoryOptions({
      dbPath: appStatePath,
      afterWrite: (appState) => syncRelationalShadowAfterAppStateWrite(appState, runtime),
    })
  );
  const state = buildSessionsState();
  state.sessions.push({
    id: "sess_missing_user",
    userId: "u_missing",
    tokenHash: "hash_missing",
    deviceUuid: "device-missing",
    clientApp: "cassa-frontend",
    createdAt: "2026-05-13T12:05:00.000Z",
  });

  try {
    await repository.writeDb(state);
    const persisted = await readJson(appStatePath);
    assert.equal(persisted.sessions.some((session) => session.id === "sess_missing_user"), true);
    assert.equal(warnings.some((message) => /Sync relazionale shadow app-state fallita/i.test(message)), true);
  } finally {
    runtime.close();
  }
});

test("errore sync sale sessions in shadow non rompe writeDb", async () => {
  const runDir = await createTempRunDir("rel-sale-sessions-write-error");
  const appStatePath = path.join(runDir, "app-state.json");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const warnings = [];
  const runtime = createRelationalRuntime({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
    defaultDbPath: relationalPath,
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
    },
    nowIso,
  });
  const repository = createAppStateRepository(
    createRepositoryOptions({
      dbPath: appStatePath,
      afterWrite: (appState) => syncRelationalShadowAfterAppStateWrite(appState, runtime),
    })
  );
  const state = buildSaleSessionsState();
  state.saleSessions.push({
    ...state.saleSessions[0],
    startedAt: "2026-05-13T09:00:00.000Z",
  });

  try {
    await repository.writeDb(state);
    const persisted = await readJson(appStatePath);
    assert.equal(persisted.saleSessions.length, 3);
    assert.equal(warnings.some((message) => /Sync relazionale shadow app-state fallita/i.test(message)), true);
  } finally {
    runtime.close();
  }
});

test("errore relazionale in shadow mode non rompe writeDb", async () => {
  const runDir = await createTempRunDir("rel-write-error");
  const appStatePath = path.join(runDir, "app-state.json");
  const warnings = [];
  const repository = createAppStateRepository(
    createRepositoryOptions({
      dbPath: appStatePath,
      afterWrite: async () => {
        throw new Error("relational boom");
      },
      logger: {
        warn(message) {
          warnings.push(String(message));
        },
      },
    })
  );

  await repository.writeDb(buildAuditState());
  const persisted = await readJson(appStatePath);
  assert.equal(persisted.auditEvents.length, 2);
  assert.equal(warnings.some((message) => message.includes("relational boom")), true);
});

test("le API continuano a leggere dall'app-state", async (t) => {
  const runDir = await createTempRunDir("rel-api-app-state");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
    },
  });

  const session = await login(baseUrl, "admin_test", "1111", "audit-api-device");
  const db = await openRelationalConnection(relationalConfig(relationalPath));
  try {
    db.prepare("DELETE FROM audit_events").run();
  } finally {
    closeRelationalConnection(db);
  }

  const response = await fetch(`${baseUrl}/api/audit/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: session.token,
      userId: session.user.id,
      deviceUuid: "audit-api-device",
      includeDeleted: true,
      limit: 100,
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.events.some((event) => event.action === "auth.login_success"), true);
});
