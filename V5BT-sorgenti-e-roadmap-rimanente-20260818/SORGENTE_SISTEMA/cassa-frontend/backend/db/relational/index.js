import {
  closeRelationalConnection,
  normalizeRelationalPrimaryDomainName,
  normalizeRelationalConfig,
  openRelationalConnection,
} from "./connection.js";
import { isDomainReadPrimary, isDomainWritePrimary } from "../persistence-mode.js";
import { runRelationalMigrations } from "./migrations.js";
import { syncAuditEventsFromAppState } from "./sync-audit-events.js";
import { syncMenuSettingsFromAppState } from "./sync-menu-settings.js";
import { syncOrdersFromAppState } from "./sync-orders.js";
import { syncPaymentsFromAppState } from "./sync-payments.js";
import { syncReservationsFromAppState } from "./sync-reservations.js";
import { syncSaleSessionsFromAppState } from "./sync-sale-sessions.js";
import { syncSessionsFromAppState } from "./sync-sessions.js";
import { syncTablesBillsFromAppState } from "./sync-tables-bills.js";
import { syncUsersFromAppState } from "./sync-users.js";
import { compareDomain, RELATIONAL_EQUIVALENCE_DOMAINS } from "./equivalence.js";
import { createRelationalWalCheckpointScheduler } from "./wal-checkpoint.js";

export {
  closeRelationalConnection,
  normalizeRelationalPrimaryDomainName,
  normalizeRelationalConfig,
  openRelationalConnection,
  runRelationalMigrations,
  syncAuditEventsFromAppState,
  syncMenuSettingsFromAppState,
  syncOrdersFromAppState,
  syncPaymentsFromAppState,
  syncReservationsFromAppState,
  syncSaleSessionsFromAppState,
  syncSessionsFromAppState,
  syncTablesBillsFromAppState,
  syncUsersFromAppState,
};
export { createDomainStore, createDomainStoreRegistry } from "../domain-store.js";
export {
  assertPrimaryRelationalAvailable,
  getRelationalMode,
  isDomainReadPrimary,
  isDomainWritePrimary,
  isRelationalEnabled,
  normalizePersistenceDomainName,
  normalizePersistenceMode,
  parsePersistenceDomainList,
  RELATIONAL_DOMAINS,
  RELATIONAL_MODES,
  RELATIONAL_READ_PRIMARY_DOMAINS,
} from "../persistence-mode.js";
export { withRelationalTransaction } from "./transaction.js";
export { AuditEventsRelationalRepository } from "./audit-events.repo.js";
export {
  AGGREGATE_LAST_EVENT_REPOSITORY_CONTRACT,
  bindAggregateLastEventId,
  createAggregateLastEventRepository,
  resolveAggregateLastEventBinding,
} from "./aggregate-last-event.repository.js";
export { MenuSettingsRelationalRepository } from "./menu-settings.repo.js";
export { OrdersRelationalRepository } from "./orders.repo.js";
export { PaymentsRelationalRepository } from "./payments.repo.js";
export {
  buildPaymentsReportReadDb,
  buildPaymentsReportReadModelFromRelational,
} from "./payments-report-read-model.js";
export { ReservationsRelationalRepository } from "./reservations.repo.js";
export { SaleSessionsRelationalRepository } from "./sale-sessions.repo.js";
export { SessionsRelationalRepository } from "./sessions.repo.js";
export { TablesBillsRelationalRepository } from "./tables-bills.repo.js";
export { UsersRelationalRepository } from "./users.repo.js";
export { CommandInboxRepository, createCommandEnvelope, hashCommandPayload } from "./command-inbox.repo.js";
export { FiscalOutboxRepository, FISCAL_OUTBOX_STATUSES } from "./fiscal-outbox.repo.js";
export { PrintSpoolRepository } from "./print-spool.repo.js";
export {
  PaymentMirrorOutboxRepository,
  PAYMENT_MIRROR_OUTBOX_STATUSES,
} from "./payment-mirror-outbox.repo.js";
export {
  EventOutboxRepository,
  IdempotencyKeysRepository,
  hashIdempotencyRequest,
  stableStringify,
  withTransactionalOutboxEvent,
} from "./realtime-backbone.repo.js";
export {
  compareDomain,
  computeAppStateDomainChecksum,
  computeRelationalDomainChecksum,
  RELATIONAL_EQUIVALENCE_DOMAINS,
} from "./equivalence.js";
export { syncRelationalShadowAfterAppStateWrite } from "./sync-audit-events.js";

const RELATIONAL_EQUIVALENCE_DOMAIN_ALIASES = new Map([
  ["audit", "auditEvents"],
  ["auditevent", "auditEvents"],
  ["auditevents", "auditEvents"],
  ["event", "auditEvents"],
  ["events", "auditEvents"],
  ["user", "users"],
  ["users", "users"],
  ["session", "sessions"],
  ["sessions", "sessions"],
  ["sale", "saleSessions"],
  ["salesession", "saleSessions"],
  ["salesessions", "saleSessions"],
  ["payment", "payments"],
  ["payments", "payments"],
  ["fiscal", "payments"],
  ["fiscale", "payments"],
  ["fiscalreceipt", "payments"],
  ["fiscalreceipts", "payments"],
  ["receipt", "payments"],
  ["receipts", "payments"],
  ["menu", "menuSettings"],
  ["menusetting", "menuSettings"],
  ["menusettings", "menuSettings"],
  ["order", "orders"],
  ["orders", "orders"],
  ["table", "tablesBills"],
  ["tables", "tablesBills"],
  ["bill", "tablesBills"],
  ["bills", "tablesBills"],
  ["tablesbill", "tablesBills"],
  ["tablesbills", "tablesBills"],
  ["reservation", "reservations"],
  ["reservations", "reservations"],
]);

function normalizeEquivalenceDomainToken(value) {
  return String(value ?? "")
    .trim()
    .replace(/[_\-\s]+/g, "")
    .toLowerCase();
}

export function normalizeRelationalEquivalenceDomains(value) {
  const rawDomains = Array.isArray(value) ? value : String(value ?? "").split(",");
  const tokens = rawDomains.map(normalizeEquivalenceDomainToken).filter(Boolean);
  if (tokens.length === 0) return [];
  if (tokens.includes("*") || tokens.includes("all")) return [...RELATIONAL_EQUIVALENCE_DOMAINS];
  const normalized = [];
  for (const token of tokens) {
    const domain = RELATIONAL_EQUIVALENCE_DOMAIN_ALIASES.get(token);
    if (!domain) {
      throw new Error(`Dominio equivalenza relazionale non supportato: ${token}`);
    }
    if (!normalized.includes(domain)) normalized.push(domain);
  }
  return normalized;
}

function describeRelationalEquivalenceMismatch(comparison) {
  if (comparison?.reason) return comparison.reason;
  const appState = comparison?.appState ?? {};
  const relational = comparison?.relational ?? {};
  return [
    `app-state rows=${appState.rowCount ?? "?"} checksum=${appState.checksum ?? "?"}`,
    `relazionale rows=${relational.rowCount ?? "?"} checksum=${relational.checksum ?? "?"}`,
  ].join("; ");
}

export function assertRelationalEquivalence(appState, relationalDb, domains = []) {
  const normalizedDomains = normalizeRelationalEquivalenceDomains(domains);
  const results = {};
  for (const domain of normalizedDomains) {
    const comparison = compareDomain(appState, relationalDb, domain);
    results[domain] = comparison;
    if (comparison.skipped || comparison.matches !== true) {
      throw new Error(
        `Equivalenza relazionale shadow fallita per ${domain}: ${describeRelationalEquivalenceMismatch(comparison)}`
      );
    }
  }
  return results;
}

// Mappa dominio-relazionale -> domini dirty app-state che lo alimentano. Un
// dominio dirty fuori da questa mappa (e non tra i neutri) forza il full sync.
const SHADOW_DOMAIN_TRIGGERS = {
  auditEvents: ["auditEvents"],
  users: ["users"],
  sessions: ["sessions"],
  saleSessions: ["saleSessions", "solarClosures"],
  payments: ["payments", "paymentContainers", "paymentParts", "paymentTransactions", "paymentProviderTransactions", "fiscalReceipts", "fiscalEvents", "smartNonFiscal"],
  menuSettings: ["menuItems", "posSettings"],
  orders: ["integration"],
  tablesBills: ["posSettings"],
  reservations: ["posRoomChangeRequests", "posTableRoomMoveRequests", "posReservationStates", "posReservationLocks"],
};
const SHADOW_NEUTRAL_DIRTY_DOMAINS = new Set(["printSpoolJobs", "tableLocks"]);
const SHADOW_KNOWN_DIRTY_DOMAINS = new Set([
  ...SHADOW_NEUTRAL_DIRTY_DOMAINS,
  ...Object.values(SHADOW_DOMAIN_TRIGGERS).flat(),
]);

function buildShadowDomainPredicate(context = {}, equivalenceDomains = []) {
  const skipDomains = new Set(
    context?.dirtyDomainFilter === true && Array.isArray(context?.skipDomains) ? context.skipDomains : []
  );
  const filterEnabled = context?.dirtyDomainFilter === true && equivalenceDomains.length === 0;
  const dirtyDomains = filterEnabled && Array.isArray(context?.dirtyDomains)
    ? context.dirtyDomains.map((domain) => String(domain ?? "").trim()).filter(Boolean)
    : [];
  const hasUnknownDirtyDomain = dirtyDomains.some((domain) => !SHADOW_KNOWN_DIRTY_DOMAINS.has(domain));
  return (relationalDomain) => {
    if (skipDomains.has(relationalDomain)) return false;
    if (!filterEnabled || dirtyDomains.length === 0 || hasUnknownDirtyDomain) return true;
    const triggers = SHADOW_DOMAIN_TRIGGERS[relationalDomain] ?? [];
    return dirtyDomains.some((domain) => triggers.includes(domain));
  };
}

export function createRelationalRuntime(options = {}) {
  const logger = options.logger ?? console;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const env = options.env ?? process.env;
  const config = normalizeRelationalConfig({
    env,
    defaultDbPath: options.defaultDbPath,
  });
  const equivalenceDomains = normalizeRelationalEquivalenceDomains(
    options.equivalenceDomains ??
      env.BACKEND_RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS ??
      env.RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS ??
      env.BACKEND_RELATIONAL_EQUIVALENCE_DOMAINS ??
      ""
  );

  let db = null;
  let initialized = false;
  const walCheckpoint = createRelationalWalCheckpointScheduler({ enabled: config.walCheckpointOwner, getDb: () => db, intervalMs: config.walCheckpointIntervalMs, autoCheckpointPages: config.walAutoCheckpointPages, runtimeMetrics: options.runtimeMetrics, logger });

  async function initialize() {
    if (initialized) return;
    initialized = true;
    if (!config.enabled || config.mode === "off") return;
    db = await openRelationalConnection(config);
    await runRelationalMigrations(db, { nowIso });
    walCheckpoint.start();
  }

  async function syncAfterAppStateWrite(appState, context = {}) {
    if (!config.enabled || !["shadow", "primary"].includes(config.mode)) return null;
    if (config.shadowSyncEnabled === false) return null;
    await initialize();
    if (!db) return null;
    const shouldSync = buildShadowDomainPredicate(context, equivalenceDomains);
    const result = {
      auditEvents: shouldSync("auditEvents") ? syncAuditEventsFromAppState(db, appState, { nowIso }) : null,
      users: shouldSync("users") ? syncUsersFromAppState(db, appState, { nowIso }) : null,
      sessions: shouldSync("sessions") ? syncSessionsFromAppState(db, appState, { nowIso }) : null,
      saleSessions: shouldSync("saleSessions") ? syncSaleSessionsFromAppState(db, appState, { nowIso }) : null,
      payments: shouldSync("payments") ? syncPaymentsFromAppState(db, appState, { nowIso }) : null,
      menuSettings: shouldSync("menuSettings") ? syncMenuSettingsFromAppState(db, appState, { nowIso }) : null,
      orders: shouldSync("orders") ? syncOrdersFromAppState(db, appState, { nowIso }) : null,
      tablesBills: shouldSync("tablesBills") ? syncTablesBillsFromAppState(db, appState, { nowIso }) : null,
      reservations: shouldSync("reservations") ? syncReservationsFromAppState(db, appState, { nowIso }) : null,
    };
    const equivalenceCheckDomains = equivalenceDomains.filter((domain) => shouldSync(domain));
    if (equivalenceCheckDomains.length > 0) {
      result.equivalence = assertRelationalEquivalence(appState, db, equivalenceCheckDomains);
    }
    return result;
  }

  function close() {
    walCheckpoint.stop();
    closeRelationalConnection(db);
    db = null;
    initialized = false;
  }

  return {
    close,
    get db() {
      return db;
    },
    initialize,
    logger,
    mode: config.enabled ? config.mode : "off",
    primaryDomains: config.primaryDomains,
    readPrimaryDomains: config.readPrimaryDomains,
    requestedWritePrimaryDomains: config.requestedWritePrimaryDomains,
    shadowSyncEnabled: config.shadowSyncEnabled,
    writePrimaryDomains: config.writePrimaryDomains,
    config,
    walCheckpoint,
    isPrimaryDomain(domain) {
      return isDomainReadPrimary(normalizeRelationalPrimaryDomainName(domain), { config });
    },
    isWritePrimaryDomain(domain) {
      return isDomainWritePrimary(normalizeRelationalPrimaryDomainName(domain), { config });
    },
    syncAfterAppStateWrite,
  };
}
