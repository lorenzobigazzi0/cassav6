import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  normalizeRelationalConfig,
  openRelationalConnection,
} from "../db/relational/index.js";
import { createSaleSessionsRepository } from "../modules/sales-sessions/index.js";
import { apiPost, authPayload, createTempRunDir, loginJson, readJson, startBackend } from "./helpers/test-server.mjs";

function primarySaleSessionsEnv(relationalPath, domains = "saleSessions") {
  return {
    BACKEND_RELATIONAL_ENABLED: "1",
    BACKEND_RELATIONAL_MODE: "primary",
    BACKEND_RELATIONAL_PRIMARY_DOMAINS: domains,
    BACKEND_RELATIONAL_DB_PATH: relationalPath,
  };
}

const SALE_SESSION_TEST_NOW = new Date();

function pad2(value) {
  return String(value).padStart(2, "0");
}

function localDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localDateAt(dayOffset, hour, minute) {
  const date = new Date(SALE_SESSION_TEST_NOW);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function previousLocalDateKey(date) {
  const previous = new Date(date);
  previous.setDate(previous.getDate() - 1);
  return localDateKey(previous);
}

function recentOpenSaleStart() {
  return new Date(SALE_SESSION_TEST_NOW.getTime() - 60 * 60 * 1000);
}

function currentOvernightStart() {
  const startedAt = new Date(SALE_SESSION_TEST_NOW);
  startedAt.setHours(1, 30, 0, 0);
  if (startedAt.getTime() > SALE_SESSION_TEST_NOW.getTime()) {
    startedAt.setDate(startedAt.getDate() - 1);
  }
  return startedAt;
}

function seedSaleSessionsState(state) {
  const openStartedAt = recentOpenSaleStart();
  const closedStartedAt = localDateAt(-1, 20, 0);
  const closedEndedAt = localDateAt(0, 4, 0);
  const closedSolarClosedAt = localDateAt(0, 4, 5);
  const openBusinessDate = localDateKey(openStartedAt);
  const closedBusinessDate = localDateKey(closedStartedAt);
  state.saleSessions = [
    {
      id: "sale_open_seed",
      templateId: "shift_day",
      templateName: "Diurna",
      scheduledStart: "08:00",
      scheduledEnd: "20:00",
      businessDate: openBusinessDate,
      startedAt: openStartedAt.toISOString(),
      startedByUserId: "u_admin",
      startedByUsername: "admin_test",
      endedAt: null,
      endedByUserId: null,
      endedByUsername: null,
    },
    {
      id: "sale_closed_seed",
      templateId: "shift_night",
      templateName: "Notturna",
      scheduledStart: "20:00",
      scheduledEnd: "04:00",
      businessDate: closedBusinessDate,
      startedAt: closedStartedAt.toISOString(),
      startedByUserId: "u_cashier",
      startedByUsername: "cashier",
      endedAt: closedEndedAt.toISOString(),
      endedByUserId: "u_manager",
      endedByUsername: "manager",
    },
  ];
  state.solarClosures = [
    {
      id: `solar_${closedBusinessDate.replace(/-/g, "")}`,
      key: closedBusinessDate,
      transmittedAt: closedSolarClosedAt.toISOString(),
      closedAt: closedSolarClosedAt.toISOString(),
      printerStatus: "accepted",
      printerResponseCode: "RT_OK",
      printerResponseMessage: "OK",
      totalSaleSessions: 1,
      saleSessionIds: ["sale_closed_seed"],
    },
  ];
}

function seedOvernightSaleSessionState(state) {
  seedSaleSessionsState(state);
  const startedAt = currentOvernightStart();
  const businessDate = previousLocalDateKey(startedAt);
  state.saleSessions = [
    {
      id: "sale_overnight",
      templateId: "shift_night",
      templateName: "Notturna",
      scheduledStart: "20:00",
      scheduledEnd: "04:00",
      businessDate,
      startedAt: startedAt.toISOString(),
      startedByUserId: "u_admin",
      startedByUsername: "admin_test",
      endedAt: null,
      endedByUserId: null,
      endedByUsername: null,
    },
  ];
  state.solarClosures = [];
}

async function startSeededBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "rel-sale-primary");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    stateOverrides: options.stateOverrides ?? seedSaleSessionsState,
    env: options.env ?? {},
  });
  return { ...server, relationalPath, runDir };
}

async function startPrimaryBackend(t, options = {}) {
  const runDir = await createTempRunDir(options.prefix ?? "rel-sale-primary");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const server = await startBackend(t, {
    runDir,
    stateOverrides: options.stateOverrides ?? seedSaleSessionsState,
    env: primarySaleSessionsEnv(relationalPath, options.domains),
  });
  return { ...server, relationalPath, runDir };
}

function canonicalStatus(body) {
  return {
    ok: body.ok,
    canManageSaleSessions: body.canManageSaleSessions,
    activeSaleSession: body.activeSaleSession
      ? {
          id: body.activeSaleSession.id,
          templateId: body.activeSaleSession.templateId,
          businessDate: body.activeSaleSession.businessDate,
          startedAt: body.activeSaleSession.startedAt,
          endedAt: body.activeSaleSession.endedAt,
        }
      : null,
    templates: (body.templates ?? []).map((template) => template.id).sort(),
    solarDaySession: body.solarDaySession
      ? {
          kind: body.solarDaySession.kind,
          key: body.solarDaySession.key,
          totalSaleSessions: body.solarDaySession.totalSaleSessions,
          active: body.solarDaySession.active,
          saleSessionIds: [...(body.solarDaySession.saleSessionIds ?? [])].sort(),
        }
      : null,
    businessDaySession: body.businessDaySession
      ? {
          kind: body.businessDaySession.kind,
          key: body.businessDaySession.key,
          totalSaleSessions: body.businessDaySession.totalSaleSessions,
          active: body.businessDaySession.active,
          saleSessionIds: [...(body.businessDaySession.saleSessionIds ?? [])].sort(),
        }
      : null,
    recentSaleSessions: (body.recentSaleSessions ?? [])
      .map((session) => ({
        id: session.id,
        templateId: session.templateId,
        businessDate: session.businessDate,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    recentSolarClosures: (body.recentSolarClosures ?? [])
      .map((closure) => ({
        id: closure.id,
        key: closure.key,
        closedAt: closure.closedAt,
        totalSaleSessions: closure.totalSaleSessions,
        saleSessionIds: [...(closure.saleSessionIds ?? [])].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function responseShape(value) {
  if (Array.isArray(value)) return value.map((entry) => responseShape(entry));
  if (!value || typeof value !== "object") return typeof value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, responseShape(value[key])])
  );
}

async function fetchStatus(baseUrl, username, pin, deviceUuid) {
  const session = await loginJson(baseUrl, username, pin, {
    deviceUuid,
    clientApp: "cassa-frontend",
  });
  const status = await apiPost(baseUrl, "/api/sales/sessions/status", authPayload(session, deviceUuid));
  assert.equal(status.response.status, 200);
  assert.equal(status.body.ok, true);
  return { session, status: status.body };
}

test("BACKEND_RELATIONAL_PRIMARY_DOMAINS accetta saleSessions", () => {
  const config = normalizeRelationalConfig({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "primary",
      BACKEND_RELATIONAL_PRIMARY_DOMAINS: "saleSessions",
      BACKEND_RELATIONAL_DB_PATH: "tmp-rel.sqlite",
    },
  });
  assert.equal(config.primaryDomains.has("saleSessions"), true);
});

test("/api/sales/sessions/status da app-state e relazionale primary sono equivalenti", async (t) => {
  const appStateServer = await startSeededBackend(t, { prefix: "rel-sale-app-state" });
  const primaryServer = await startPrimaryBackend(t, { prefix: "rel-sale-primary-status" });

  const appState = await fetchStatus(appStateServer.baseUrl, "admin_test", "1111", "sale-app-state-status");
  const primary = await fetchStatus(primaryServer.baseUrl, "admin_test", "1111", "sale-primary-status");

  assert.deepEqual(responseShape(primary.status), responseShape(appState.status));
  assert.deepEqual(canonicalStatus(primary.status), canonicalStatus(appState.status));
});

test("open session poi status primary vede aperta e app-state resta fonte scrittura", async (t) => {
  const { baseUrl, dbPath } = await startPrimaryBackend(t, {
    prefix: "rel-sale-open-primary",
    stateOverrides(state) {
      state.saleSessions = [];
      state.solarClosures = [];
    },
  });
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "sale-primary-open-admin",
    clientApp: "cassa-frontend",
  });

  const opened = await apiPost(
    baseUrl,
    "/api/sales/sessions/open",
    authPayload(admin, "sale-primary-open-admin", { templateId: "shift_day" })
  );
  assert.equal(opened.response.status, 200);
  assert.equal(opened.body.activeSaleSession.templateId, "shift_day");

  const status = await apiPost(
    baseUrl,
    "/api/sales/sessions/status",
    authPayload(admin, "sale-primary-open-admin")
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body.activeSaleSession.id, opened.body.activeSaleSession.id);

  const persisted = await readJson(dbPath);
  assert.equal(persisted.saleSessions.filter((session) => !session.endedAt).length, 1);
});

test("close session poi status primary vede chiusa", async (t) => {
  const { baseUrl, dbPath } = await startPrimaryBackend(t, {
    prefix: "rel-sale-close-primary",
    stateOverrides(state) {
      state.saleSessions = [];
      state.solarClosures = [];
    },
  });
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "sale-primary-close-admin",
    clientApp: "cassa-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "sale-primary-close-manager",
    clientApp: "cassa-frontend",
  });

  const opened = await apiPost(
    baseUrl,
    "/api/sales/sessions/open",
    authPayload(admin, "sale-primary-close-admin", { templateId: "shift_day" })
  );
  assert.equal(opened.response.status, 200);

  const closed = await apiPost(
    baseUrl,
    "/api/sales/sessions/close",
    authPayload(manager, "sale-primary-close-manager")
  );
  assert.equal(closed.response.status, 200);
  assert.equal(closed.body.activeSaleSession, null);

  const status = await apiPost(
    baseUrl,
    "/api/sales/sessions/status",
    authPayload(manager, "sale-primary-close-manager")
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body.activeSaleSession, null);
  assert.equal(status.body.recentSaleSessions[0].endedByUserId, "u_manager");

  const persisted = await readJson(dbPath);
  assert.equal(persisted.saleSessions.length, 1);
  assert.equal(persisted.saleSessions[0].endedByUserId, "u_manager");
});

test("sessione oltre mezzanotte mantiene businessDate coerente in primary", async (t) => {
  const { baseUrl } = await startPrimaryBackend(t, {
    prefix: "rel-sale-overnight-primary",
    stateOverrides: seedOvernightSaleSessionState,
  });

  const { status } = await fetchStatus(baseUrl, "admin_test", "1111", "sale-primary-overnight");
  assert.equal(status.activeSaleSession.id, "sale_overnight");
  assert.equal(status.activeSaleSession.businessDate, previousLocalDateKey(currentOvernightStart()));
  assert.equal(status.businessDaySession.key, previousLocalDateKey(currentOvernightStart()));
  assert.deepEqual(status.businessDaySession.saleSessionIds, ["sale_overnight"]);
});

test("saleSessions primary non attivo continua a leggere app-state", async (t) => {
  const runDir = await createTempRunDir("rel-sale-primary-off");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    stateOverrides: seedSaleSessionsState,
    env: primarySaleSessionsEnv(relationalPath, "users"),
  });
  const session = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "sale-primary-off",
    clientApp: "cassa-frontend",
  });

  const db = await openRelationalConnection({ enabled: true, mode: "primary", dbPath: relationalPath });
  try {
    db.prepare("DELETE FROM sale_sessions").run();
  } finally {
    closeRelationalConnection(db);
  }

  const status = await apiPost(
    baseUrl,
    "/api/sales/sessions/status",
    authPayload(session, "sale-primary-off")
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.body.activeSaleSession.id, "sale_open_seed");
});

test("errore relazionale primary saleSessions produce messaggio chiaro", () => {
  const repository = createSaleSessionsRepository({
    relationalRuntime: {
      db: null,
      isPrimaryDomain(domain) {
        return domain === "saleSessions";
      },
    },
  });
  assert.throws(
    () => repository.buildStatusSource({ saleSessions: [], solarClosures: [] }),
    /DB relazionale primary non disponibile per saleSessions/i
  );
});
