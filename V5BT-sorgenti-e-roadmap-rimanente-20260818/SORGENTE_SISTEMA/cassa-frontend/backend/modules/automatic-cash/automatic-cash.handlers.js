import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  appendCashExchangeAuditEvent,
  buildAutomaticCashPreflight,
  buildAutomaticCashSettingsPayload,
  buildCashExchangeAvailableDenominations,
  buildCashExchangeStatePayload,
  CASH_EXCHANGE_DENOMINATION_CENTS,
  createAutomaticCashConfigSet,
  createAutomaticCashReserveConfigSet,
  getActiveAutomaticCashWorkflow,
  getActiveCashExchange,
  publicAutomaticCashWorkflow,
  publicCashExchange,
  resolveAutomaticCashSettlementFeedback,
  resolveAutomaticCashBusinessEveningKey,
  sanitizeAutomaticCashSettlementRecord,
  sanitizeAutomaticCashSettings,
  selectAutomaticCashCombination,
  transitionCashExchange,
  transitionAutomaticCashWorkflow,
  validateCashExchangePieces,
} from "./automatic-cash.domain.js";
import { getActiveCashMovement } from "./cash-movement.domain.js";
import { createCashMovementHandlers } from "./cash-movement.handlers.js";

const DEFAULT_100_CASH_FLOAT_CONFIG_PATH = fileURLToPath(
  new URL("../../fixtures/fondo_cassa_100_combinazioni.json", import.meta.url),
);

function userDisplayId(user) {
  return String(user?.username ?? user?.id ?? "").trim() || "system";
}

function userDisplayName(user) {
  return (
    String(
      user?.fullName ?? user?.name ?? user?.username ?? user?.id ?? "",
    ).trim() || "Operatore"
  );
}

function canManageAutomaticCash(user, { hasPermission, isPosPrivilegedRole }) {
  return (
    isPosPrivilegedRole(user?.role) ||
    hasPermission(user, "automatic_cash_admin") ||
    hasPermission(user, "manage_settings")
  );
}

function resolveLastWriteAt(db, resolveSettingsLastWriteAt) {
  if (typeof resolveSettingsLastWriteAt === "function") {
    return resolveSettingsLastWriteAt(db?.meta);
  }
  return String(
    db?.meta?.settingsLastWriteAt ?? db?.meta?.lastWriteAt ?? "",
  ).trim();
}

function resolveVersion(db, resolveSettingsVersion) {
  if (typeof resolveSettingsVersion === "function") {
    return resolveSettingsVersion(db?.meta);
  }
  const version = new Date(resolveLastWriteAt(db)).getTime();
  return Number.isFinite(version) ? version : Date.now();
}

function buildResponse(db, automaticCash, helpers, extra = {}) {
  return buildAutomaticCashSettingsPayload(automaticCash, {
    lastWriteAt: resolveLastWriteAt(db, helpers.resolveSettingsLastWriteAt),
    version: resolveVersion(db, helpers.resolveSettingsVersion),
    ...extra,
  });
}

function compactId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function nowMsFromIso(nowIso) {
  const iso =
    typeof nowIso === "function" ? nowIso() : new Date().toISOString();
  const parsed = new Date(iso).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeText(value, limit = 200) {
  return String(value ?? "")
    .trim()
    .slice(0, limit);
}

function toInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function centsFromValue(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  return Math.max(0, Math.round(Number(fallback) || 0));
}

function buildQrPayload(workflow) {
  const payload = {
    schema: "automatic_cash_float_v1",
    cashFloatId: workflow.cashFloatId,
    workflowId: workflow.workflowId,
    assignmentId: workflow.assignmentId,
    combinationId: workflow.combinationId,
    businessEveningKey: workflow.businessEveningKey,
    totalCents: workflow.totalCents,
    createdAtMs: workflow.startedAtMs,
  };
  return `FCA:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function parseQrPayload(rawPayload) {
  const text = normalizeText(rawPayload, 12000);
  if (!text) return null;
  try {
    if (text.startsWith("FCA:")) {
      return JSON.parse(
        Buffer.from(text.slice(4), "base64url").toString("utf8"),
      );
    }
    if (text.startsWith("{")) {
      return JSON.parse(text);
    }
  } catch {
    return null;
  }
  return null;
}

function preflightStatusCode(reasonCode) {
  switch (reasonCode) {
    case "FCA_ACTIVE_WORKFLOW":
      return 409;
    case "FCA_CONFIG_POOL_EXHAUSTED":
    case "FCA_NO_FEASIBLE_CONFIGURATION":
      return 409;
    case "FCA_GATEWAY_UNREACHABLE":
    case "FCA_INVENTORY_UNAVAILABLE":
      return 503;
    case "AUTOMATIC_CASH_NOT_CONFIGURED":
    case "AUTOMATIC_CASH_DISABLED":
    case "FCA_RESERVE_CONFIG_INVALID":
      return 400;
    default:
      return 400;
  }
}

function throwPreflightError(HttpError, preflight) {
  throw new HttpError(
    preflightStatusCode(preflight.reasonCode),
    preflight.message || "Creazione fondo cassa automatico non disponibile.",
    {
      code: preflight.reasonCode,
      details: preflight,
    },
  );
}

function replaceById(items, key, nextItem) {
  const id = String(nextItem?.[key] ?? "").trim();
  if (!id) return items;
  const replaced = [];
  let found = false;
  for (const item of items) {
    if (String(item?.[key] ?? "").trim() === id) {
      replaced.push(nextItem);
      found = true;
    } else {
      replaced.push(item);
    }
  }
  if (!found) replaced.push(nextItem);
  return replaced;
}

function findWorkflow(settings, payload = {}) {
  const workflowId = normalizeText(payload.workflowId, 120);
  const operationId = normalizeText(payload.operationId, 120);
  const cashFloatId = normalizeText(payload.cashFloatId, 120);
  const directMatch =
    settings.workflows.find((workflow) => {
      if (workflowId && workflow.workflowId === workflowId) return true;
      if (operationId && workflow.operationId === operationId) return true;
      if (cashFloatId && workflow.cashFloatId === cashFloatId) return true;
      return false;
    }) ?? null;
  if (directMatch) return directMatch;

  const activeWorkflows = settings.workflows.filter((workflow) =>
    ["WITHDRAWAL_REQUESTED", "DISPENSING", "WAITING_CASH_REMOVAL", "TICKET_READY", "PRINTING_TICKET", "WAITING_TICKET_IN_POUCH"].includes(
      workflow?.step,
    ),
  );
  return activeWorkflows.length === 1 ? activeWorkflows[0] : null;
}

function findCashExchange(settings, payload = {}) {
  const exchangeId = normalizeText(payload.exchangeId, 120);
  const operationId = normalizeText(payload.operationId, 120);
  return (
    settings.cashExchanges.find((exchange) => {
      if (exchangeId && exchange.exchangeId === exchangeId) return true;
      if (operationId && exchange.operationId === operationId) return true;
      return false;
    }) ?? null
  );
}

function findCashPayment(settings, payload = {}) {
  const operationId = normalizeText(payload.operationId, 120);
  if (!operationId) return null;
  return (
    settings.cashPayments.find((payment) => payment.operationId === operationId) ??
    null
  );
}

function getActiveCashPayment(settings) {
  return (
    settings.cashPayments.find((payment) => payment.status === "ACTIVE") ??
    null
  );
}

function buildCashFloatGenerateResponseFromWorkflow(workflow, extra = {}) {
  const workflowId = normalizeText(workflow?.workflowId, 120);
  const operationId = normalizeText(workflow?.operationId, 120);
  const cashFloatId = normalizeText(workflow?.cashFloatId, 120);
  const assignmentId = normalizeText(workflow?.assignmentId, 120);
  const businessEveningKey = normalizeText(workflow?.businessEveningKey, 40);
  const combinationId = normalizeText(workflow?.combinationId, 120);
  const configSetId = normalizeText(workflow?.configSetId, 120);
  const qrPayload = normalizeText(workflow?.qrPayload, 12000);
  const totalCents = Number(workflow?.totalCents);
  const createdAtMs = Number(workflow?.createdAtMs ?? workflow?.startedAtMs);
  if (
    !workflowId ||
    !operationId ||
    !cashFloatId ||
    !assignmentId ||
    !businessEveningKey ||
    !combinationId ||
    !configSetId ||
    !qrPayload ||
    !Number.isFinite(totalCents) ||
    !Number.isFinite(createdAtMs)
  ) {
    return null;
  }
  return {
    ok: true,
    workflowId,
    operationId,
    cashFloatId,
    assignmentId,
    businessEveningKey,
    combinationId,
    configSetId,
    reserveConfigId: workflow.reserveConfigId ?? null,
    pieces: workflow.pieces ?? {},
    gatewayPieces: workflow.gatewayPieces ?? {},
    totalCents,
    createdAtMs,
    qrPayload,
    step: workflow.step,
    ...extra,
  };
}

function buildPublicWorkflowOperationLock(lock) {
  if (!lock) return null;
  return {
    ownerUserId: normalizeText(lock.ownerUserId, 120),
    ownerFullName: normalizeText(lock.ownerFullName, 160),
    ownerDeviceUuid: normalizeText(lock.ownerDeviceUuid, 160),
    ownerCanManageAutomaticCash: lock.ownerCanManageAutomaticCash === true,
    reason: normalizeText(lock.reason, 120),
    acquiredAtMs: lock.acquiredAtMs ?? null,
    expiresAtMs: lock.expiresAtMs ?? null,
  };
}

function canReadSettlementRecord(record, context, permissionHelpers) {
  if (canManageAutomaticCash(context.user, permissionHelpers)) return true;
  const userId = normalizeText(context.user?.id, 120);
  const deviceUuid = normalizeText(context.session?.deviceUuid, 160);
  if (record.userId && userId && record.userId === userId) return true;
  if (record.deviceUuid && deviceUuid && record.deviceUuid === deviceUuid)
    return true;
  return false;
}

function visibleSettlementRecords(records, context, permissionHelpers) {
  return records
    .filter((record) =>
      canReadSettlementRecord(record, context, permissionHelpers),
    )
    .sort((left, right) => right.completedAtMs - left.completedAtMs);
}

function findActiveCashFloat(settings, payload = {}, context = {}) {
  const cashFloatId = normalizeText(payload.cashFloatId, 120);
  const userId = normalizeText(context.user?.id, 120);
  const deviceUuid = normalizeText(
    context.session?.deviceUuid ?? payload.deviceUuid,
    160,
  );
  return (
    settings.cashFloats.find((cashFloat) => {
      if (cashFloat.status !== "ACTIVE") return false;
      if (cashFloatId && cashFloat.cashFloatId !== cashFloatId) return false;
      const matchesOwnerUser = Boolean(
        userId && cashFloat.ownerUserId && cashFloat.ownerUserId === userId,
      );
      if (
        !cashFloatId &&
        userId &&
        cashFloat.ownerUserId &&
        !matchesOwnerUser
      )
        return false;
      if (
        !cashFloatId &&
        !matchesOwnerUser &&
        deviceUuid &&
        cashFloat.ownerDeviceUuid &&
        cashFloat.ownerDeviceUuid !== deviceUuid
      )
        return false;
      return true;
    }) ?? null
  );
}

function publicActiveCashFloat(cashFloat) {
  if (!cashFloat) return null;
  return {
    mode: "auto",
    status: cashFloat.status,
    cashFloatId: cashFloat.cashFloatId,
    totalCents: cashFloat.totalCents,
    loadedAtMs: cashFloat.loadedAtMs,
    assignmentId: cashFloat.assignmentId ?? null,
    combinationId: cashFloat.combinationId ?? null,
    businessEveningKey: cashFloat.businessEveningKey ?? null,
    qrPayload: cashFloat.qrPayload ?? "",
  };
}

export function createAutomaticCashHandlers({
  automaticCashGateway = null,
  automaticCashRuntimeDefaults = null,
  enqueuePrintSpoolJob = null,
  HttpError,
  hasPermission,
  isPosPrivilegedRole,
  nowIso,
  readDb,
  readJsonBody,
  resolveSettingsLastWriteAt,
  resolveSettingsVersion,
  sanitizePosSettings,
  sendJson,
  touchSettingsMetadata,
  validateSessionContext,
  writeAutomaticCashDb = null,
  writeDb,
}) {
  const helpers = {
    resolveSettingsLastWriteAt,
    resolveSettingsVersion,
  };
  const permissionHelpers = {
    hasPermission,
    isPosPrivilegedRole,
  };
  const workflowOperationLockTtlMs = 5 * 60 * 1000;
  let cashFloatCriticalSectionInFlight = false;

  function sanitizeDbSettings(db) {
    const settings = sanitizePosSettings(db.posSettings, {
      menuItems: db.menuItems,
      users: db.users,
    });
    if (!automaticCashRuntimeDefaults) return settings;

    const current = sanitizeAutomaticCashSettings(settings.automaticCash);
    const defaults = sanitizeAutomaticCashSettings(automaticCashRuntimeDefaults);
    return {
      ...settings,
      automaticCash: sanitizeAutomaticCashSettings({
        ...defaults,
        ...current,
        enabled: current.enabled || defaults.enabled,
        gatewayConfigured:
          current.gatewayConfigured ||
          defaults.gatewayConfigured ||
          automaticCashGateway?.configured === true,
        configSetId: current.configSetId || defaults.configSetId,
        configSet: current.configSet ?? defaults.configSet,
        configSets: current.configSets.length ? current.configSets : defaults.configSets,
        reserveConfigId: current.reserveConfigId || defaults.reserveConfigId,
        reserveConfig: current.reserveConfig ?? defaults.reserveConfig,
        reserveConfigs: current.reserveConfigs.length
          ? current.reserveConfigs
          : defaults.reserveConfigs,
        workflows: current.workflows,
        assignments: current.assignments,
        cashFloats: current.cashFloats,
        deposits: current.deposits,
        cashExchanges: current.cashExchanges,
        cashMovements: current.cashMovements,
        settlementRecords: current.settlementRecords,
      }),
    };
  }

  function requireManager(user) {
    if (!canManageAutomaticCash(user, permissionHelpers)) {
      throw new HttpError(
        403,
        "Utente non autorizzato alla configurazione fondo cassa automatico.",
        {
          code: "AUTOMATIC_CASH_PERMISSION_DENIED",
        },
      );
    }
  }

  function requestContext(req, db, payload = {}) {
    if (req?.__authContext?.user && req?.__authContext?.session) {
      return req.__authContext;
    }
    return validateSessionContext(db, payload);
  }

  function workflowVisibilityContext(context, extra = {}) {
    return {
      ...context,
      user: context.user,
      userId: context.user?.id,
      canManageAutomaticCash: canManageAutomaticCash(
        context.user,
        permissionHelpers,
      ),
      ...extra,
    };
  }

  function throwCashFloatBusy(lock = null) {
    throw new HttpError(
      423,
      "Operazione fondo cassa gia in gestione da un altro operatore.",
      {
        code: "AUTOMATIC_CASH_LOCKED",
        details: {
          lock: buildPublicWorkflowOperationLock(lock),
        },
      },
    );
  }

  function throwCashExchangeBusy(lock = null) {
    throw new HttpError(423, "Cambio gia in gestione da un altro operatore.", {
      code: "CASH_EXCHANGE_ACTIVE",
      details: {
        lock: buildPublicWorkflowOperationLock(lock),
      },
    });
  }

  async function runCashFloatCriticalSection(action) {
    if (cashFloatCriticalSectionInFlight) {
      throwCashFloatBusy();
    }
    cashFloatCriticalSectionInFlight = true;
    try {
      return await action();
    } finally {
      cashFloatCriticalSectionInFlight = false;
    }
  }

  function workflowLockOwnerMatchesContext(lock, context) {
    const ownerSessionId = normalizeText(lock?.ownerSessionId, 160);
    const ownerDeviceUuid = normalizeText(lock?.ownerDeviceUuid, 160);
    const ownerUserId = normalizeText(lock?.ownerUserId, 120);
    const currentSessionId = normalizeText(context.session?.id, 160);
    const currentDeviceUuid = normalizeText(context.session?.deviceUuid, 160);
    const currentUserId = normalizeText(context.user?.id, 120);
    return Boolean(
      (ownerSessionId && currentSessionId && ownerSessionId === currentSessionId) ||
        (ownerDeviceUuid &&
          currentDeviceUuid &&
          ownerDeviceUuid === currentDeviceUuid) ||
        (ownerUserId && currentUserId && ownerUserId === currentUserId),
    );
  }

  function applyWorkflowOperationLock(
    workflow,
    context,
    reason,
    nowMs = nowMsFromIso(nowIso),
  ) {
    const lock = workflow?.operationLock ?? null;
    const lockActive = Number(lock?.expiresAtMs) > nowMs;
    const lockHeldByManager = lock?.ownerCanManageAutomaticCash === true;
    const currentCanManage = canManageAutomaticCash(
      context.user,
      permissionHelpers,
    );
    if (
      lockActive &&
      !workflowLockOwnerMatchesContext(lock, context) &&
      (!currentCanManage || lockHeldByManager)
    ) {
      throwCashFloatBusy(lock);
    }
    return {
      ...workflow,
      operationLock: {
        ownerUserId: normalizeText(context.user?.id, 120),
        ownerFullName: userDisplayName(context.user),
        ownerDeviceUuid: normalizeText(context.session?.deviceUuid, 160),
        ownerSessionId: normalizeText(context.session?.id, 160),
        ownerCanManageAutomaticCash: currentCanManage,
        reason: normalizeText(reason, 120) || "cash_float_workflow",
        acquiredAtMs: nowMs,
        expiresAtMs: nowMs + workflowOperationLockTtlMs,
      },
      updatedAtMs: nowMs,
    };
  }

  async function claimWorkflowOperation(
    db,
    settings,
    workflow,
    context,
    reason,
    nowMs = nowMsFromIso(nowIso),
  ) {
    const lockedWorkflow = applyWorkflowOperationLock(
      workflow,
      context,
      reason,
      nowMs,
    );
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date(nowMs).toISOString();
    const saved = await persistAutomaticCash(
      db,
      {
        ...settings,
        workflows: replaceById(
          settings.workflows,
          "workflowId",
          lockedWorkflow,
        ),
      },
      updatedAt,
    );
    return {
      settings: saved,
      workflow: lockedWorkflow,
    };
  }

  async function refreshGatewayInventory(settings, { required = false } = {}) {
    if (automaticCashGateway?.configured === true) {
      try {
        return await automaticCashGateway.refreshInventory();
      } catch (error) {
        if (required) {
          throw new HttpError(
            503,
            "Inventario cassa automatica non disponibile.",
            {
              code: "FCA_INVENTORY_UNAVAILABLE",
              details: { message: error?.message ?? String(error) },
            },
          );
        }
        return {
          ok: false,
          inventory: {
            ok: false,
            error:
              error?.message ?? "Inventario cassa automatica non disponibile.",
            listCassette: [],
          },
          activeOperation: null,
          updatedAtMs: Date.now(),
        };
      }
    }
    if (
      required &&
      settings.gatewayConfigured &&
      settings.gatewayInventory?.inventory?.listCassette?.length === 0
    ) {
      throw new HttpError(503, "Inventario cassa automatica non disponibile.", {
        code: "FCA_INVENTORY_UNAVAILABLE",
      });
    }
    return settings.gatewayInventory;
  }

  async function readGatewayState(settings) {
    if (automaticCashGateway?.configured === true) {
      try {
        return await automaticCashGateway.getState();
      } catch (error) {
        return {
          ok: false,
          inventory: {
            ok: false,
            error: error?.message ?? "Stato gateway non disponibile.",
            listCassette: [],
          },
          activeOperation: null,
          updatedAtMs: Date.now(),
        };
      }
    }
    return settings.gatewayInventory;
  }

  function withRuntimeGateway(settings, gatewayInventory = null) {
    return sanitizeAutomaticCashSettings({
      ...settings,
      gatewayConfigured:
        settings.gatewayConfigured || automaticCashGateway?.configured === true,
      gatewayInventory: gatewayInventory ?? settings.gatewayInventory,
    });
  }

  function toGatewayPieces(combination) {
    const result = {};
    for (const [label, quantity] of Object.entries(combination?.pieces ?? {})) {
      const cents = Number(combination?.denominationCentsByLabel?.[label]);
      if (
        Number.isInteger(cents) &&
        cents > 0 &&
        Number.isInteger(Number(quantity)) &&
        Number(quantity) > 0
      ) {
        result[String(cents)] = Number(quantity);
      }
    }
    return result;
  }

  function parseGatewayTimestampMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = new Date(String(value ?? "").trim()).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function readDepositedTotalCents(payload, state, fallbackCents, options = {}) {
    const minCachedAtMs = Math.max(0, Number(options.minCachedAtMs) || 0);
    const stateEntries = Array.isArray(state) ? state : [state];
    const roots = [
      payload,
      payload?.Values,
      payload?.deposit,
      payload?.deposit?.Values,
      ...stateEntries.flatMap((entry) => {
        const deposit = entry?.deposit;
        const depositCachedAtMs = parseGatewayTimestampMs(deposit?.cachedAt);
        if (
          minCachedAtMs > 0 &&
          depositCachedAtMs > 0 &&
          depositCachedAtMs < minCachedAtMs
        ) {
          return [];
        }
        return [
          deposit,
          deposit?.raw,
          deposit?.raw?.Values,
        ];
      }),
    ].filter((entry) => entry && typeof entry === "object");
    const candidates = [];
    const pushCents = (value) => {
      if (typeof value !== "number" && typeof value !== "string") return;
      const normalized =
        typeof value === "string"
          ? value.replace(/\s/g, "").replace(",", ".")
          : value;
      const parsed = Number(normalized);
      if (Number.isFinite(parsed) && parsed >= 0) {
        candidates.push(Math.round(parsed));
      }
    };
    const pushMajorUnits = (value) => {
      if (typeof value !== "number" && typeof value !== "string") return;
      const normalized =
        typeof value === "string"
          ? value.replace(/\s/g, "").replace(",", ".")
          : value;
      const parsed = Number(normalized);
      if (Number.isFinite(parsed) && parsed >= 0) {
        candidates.push(Math.round(parsed * 100));
      }
    };
    const sumReplenishmentRows = (rows) => {
      if (!Array.isArray(rows)) return null;
      let total = 0;
      for (const rawRow of rows) {
        const row = rawRow && typeof rawRow === "object" ? rawRow : {};
        const cents = Number(
          row.Value_Money ??
            row.ValueMoney ??
            row.denominationCents ??
            row.cents,
        );
        const quantity = Number(
          row.ReplenishmentStock ??
            row.replenishmentStock ??
            row.DepositedStock ??
            row.depositedStock ??
            row.DepositStock ??
            row.depositStock ??
            row.InsertedStock ??
            row.insertedStock,
        );
        if (
          Number.isFinite(cents) &&
          cents > 0 &&
          Number.isFinite(quantity) &&
          quantity > 0
        ) {
          total += Math.round(cents) * Math.round(quantity);
        }
      }
      return total > 0 ? total : null;
    };
    const visit = (node, depth = 0) => {
      if (!node || typeof node !== "object" || depth > 5) return;
      [
        node.depositedTotalCents,
        node.depositedCents,
        node.totalCents,
        node.total_cents,
        node.TotalCents,
        node.amountCents,
        node.AmountCents,
      ].forEach(pushCents);
      if (typeof node.deposit === "number" || typeof node.deposit === "string") {
        pushMajorUnits(node.deposit);
      }
      [node.depositedTotal, node.deposited, node.amount, node.total].forEach(pushMajorUnits);
      [
        node.cassettesMonitor,
        node.CassettesMonitor,
      ].forEach((rows) => {
        const total = sumReplenishmentRows(rows);
        if (total !== null) candidates.push(total);
      });
      Object.values(node).forEach((value) => {
        if (value && typeof value === "object") visit(value, depth + 1);
      });
    };
    roots.forEach((root) => visit(root));
    const positive = candidates.find((candidate) => candidate > 0);
    if (positive !== undefined) return positive;
    if (candidates.some((candidate) => candidate === 0)) return 0;
    return Math.max(0, Math.round(Number(fallbackCents) || 0));
  }

  async function persistAutomaticCash(db, automaticCash, updatedAt) {
    db.posSettings = sanitizePosSettings(
      {
        ...db.posSettings,
        automaticCash: sanitizeAutomaticCashSettings(automaticCash),
      },
      {
        menuItems: db.menuItems,
        users: db.users,
      },
    );
    touchSettingsMetadata(db, updatedAt);
    const persist =
      typeof writeAutomaticCashDb === "function"
        ? writeAutomaticCashDb
        : writeDb;
    await persist(db);
    return db.posSettings.automaticCash;
  }

  async function handleSettings(req, res) {
    const db = await readDb();
    const settings = sanitizeDbSettings(db);
    sendJson(res, 200, buildResponse(db, settings.automaticCash, helpers));
  }

  async function handleSaveSettings(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user } = requestContext(req, db, payload);
    requireManager(user);

    const currentSettings = sanitizeDbSettings(db);
    const current = sanitizeAutomaticCashSettings(
      currentSettings.automaticCash,
    );
    const configSetId =
      payload.configSetId === null
        ? null
        : typeof payload.configSetId === "string"
          ? payload.configSetId.trim()
          : current.configSetId;
    const hasConfigSet =
      configSetId === null ||
      current.configSets.some((entry) => entry.id === configSetId);
    if (!hasConfigSet) {
      throw new HttpError(400, "Configurazione fondo cassa non trovata.", {
        code: "AUTOMATIC_CASH_CONFIG_NOT_FOUND",
      });
    }
    const reserveConfigId =
      payload.reserveConfigId === null
        ? null
        : typeof payload.reserveConfigId === "string"
          ? payload.reserveConfigId.trim()
          : current.reserveConfigId;
    const hasReserveConfig =
      reserveConfigId === null ||
      current.reserveConfigs.some((entry) => entry.id === reserveConfigId);
    if (!hasReserveConfig) {
      throw new HttpError(400, "Configurazione riserva minima non trovata.", {
        code: "FCA_RESERVE_CONFIG_INVALID",
      });
    }

    const automaticCash = sanitizeAutomaticCashSettings({
      ...current,
      enabled:
        typeof payload.enabled === "boolean"
          ? payload.enabled
          : current.enabled,
      gatewayConfigured:
        typeof payload.gatewayConfigured === "boolean"
          ? payload.gatewayConfigured
          : current.gatewayConfigured,
      gatewayInventory: payload.gatewayInventory ?? current.gatewayInventory,
      feedbackEnabled:
        typeof payload.feedbackEnabled === "boolean"
          ? payload.feedbackEnabled
          : current.feedbackEnabled,
      warningThresholdCents:
        payload.warningThresholdCents ?? current.warningThresholdCents,
      dangerThresholdCents:
        payload.dangerThresholdCents ?? current.dangerThresholdCents,
      autoCashFloatMode: payload.autoCashFloatMode ?? current.autoCashFloatMode,
      configSetId,
      reserveConfigId,
    });
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    const saved = await persistAutomaticCash(db, automaticCash, updatedAt);

    sendJson(res, 200, buildResponse(db, saved, helpers));
  }

  async function handleUploadConfigSet(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user } = requestContext(req, db, payload);
    requireManager(user);

    const uploadedAt =
      typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    const { validation, configSet } = createAutomaticCashConfigSet({
      config: payload.config,
      uploadedAt,
      uploadedBy: userDisplayId(user),
    });
    if (!validation.ok || !configSet) {
      throw new HttpError(400, "Configurazione fondo cassa non valida.", {
        code: "AUTOMATIC_CASH_CONFIG_INVALID",
        details: {
          errors: validation.errors,
          warnings: validation.warnings,
        },
      });
    }

    const currentSettings = sanitizeDbSettings(db);
    const current = sanitizeAutomaticCashSettings(
      currentSettings.automaticCash,
    );
    const configSets = [
      ...current.configSets.filter((entry) => entry.id !== configSet.id),
      configSet,
    ];
    const automaticCash = sanitizeAutomaticCashSettings({
      ...current,
      enabled: true,
      autoCashFloatMode: "random_file",
      configSetId: configSet.id,
      configSet,
      configSets,
    });
    const saved = await persistAutomaticCash(db, automaticCash, uploadedAt);

    sendJson(
      res,
      200,
      buildResponse(db, saved, helpers, {
        warnings: validation.warnings,
      }),
    );
  }

  async function handleUploadDefaultConfigSet(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user } = requestContext(req, db, payload);
    requireManager(user);

    let config = null;
    try {
      config = JSON.parse(await readFile(DEFAULT_100_CASH_FLOAT_CONFIG_PATH, "utf8"));
    } catch (error) {
      throw new HttpError(
        500,
        "File preset 100 fondi cassa non configurato.",
        {
          code: "AUTOMATIC_CASH_CONFIG_NOT_FOUND",
          details: { message: error?.message ?? String(error) },
        },
      );
    }

    const uploadedAt =
      typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    const { validation, configSet } = createAutomaticCashConfigSet({
      config,
      uploadedAt,
      uploadedBy: userDisplayId(user),
    });
    if (!validation.ok || !configSet) {
      throw new HttpError(400, "Preset 100 fondi cassa non valido.", {
        code: "AUTOMATIC_CASH_CONFIG_INVALID",
        details: {
          errors: validation.errors,
          warnings: validation.warnings,
        },
      });
    }

    const currentSettings = sanitizeDbSettings(db);
    const current = sanitizeAutomaticCashSettings(
      currentSettings.automaticCash,
    );
    const configSets = [
      ...current.configSets.filter((entry) => entry.id !== configSet.id),
      configSet,
    ];
    const automaticCash = sanitizeAutomaticCashSettings({
      ...current,
      enabled: true,
      autoCashFloatMode: "random_file",
      configSetId: configSet.id,
      configSet,
      configSets,
    });
    const saved = await persistAutomaticCash(db, automaticCash, uploadedAt);

    sendJson(
      res,
      200,
      buildResponse(db, saved, helpers, {
        warnings: validation.warnings,
        preset: "fondo_cassa_100_combinazioni",
      }),
    );
  }

  async function handleUploadReserveConfig(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user } = requestContext(req, db, payload);
    requireManager(user);

    const uploadedAt =
      typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    const { validation, reserveConfig } = createAutomaticCashReserveConfigSet({
      config: payload.config,
      uploadedAt,
      uploadedBy: userDisplayId(user),
    });
    if (!validation.ok || !reserveConfig) {
      throw new HttpError(400, "Configurazione riserva minima non valida.", {
        code: "FCA_RESERVE_CONFIG_INVALID",
        details: {
          errors: validation.errors,
          warnings: validation.warnings,
        },
      });
    }

    const currentSettings = sanitizeDbSettings(db);
    const current = sanitizeAutomaticCashSettings(
      currentSettings.automaticCash,
    );
    const reserveConfigs = [
      ...current.reserveConfigs.filter(
        (entry) => entry.id !== reserveConfig.id,
      ),
      reserveConfig,
    ];
    const automaticCash = sanitizeAutomaticCashSettings({
      ...current,
      reserveConfigId: reserveConfig.id,
      reserveConfig,
      reserveConfigs,
    });
    const saved = await persistAutomaticCash(db, automaticCash, uploadedAt);

    sendJson(
      res,
      200,
      buildResponse(db, saved, helpers, {
        warnings: validation.warnings,
      }),
    );
  }

  async function handleStatus(req, res) {
    const db = await readDb();
    const context = requestContext(req, db, req.__authPayload ?? {});
    const settings = withRuntimeGateway(sanitizeDbSettings(db).automaticCash);
    const activeWorkflow = getActiveAutomaticCashWorkflow(settings);
    const activeExchange = getActiveCashExchange(settings);
    const activeMovement = getActiveCashMovement(settings);
    const cashFloat = findActiveCashFloat(settings, {}, context);
    sendJson(res, 200, {
      ok: true,
      enabled: settings.enabled,
      gatewayConfigured: settings.gatewayConfigured,
      feedbackEnabled: settings.feedbackEnabled,
      cashFloatMode: cashFloat ? "auto" : "none",
      currentCashFloatId: cashFloat?.cashFloatId ?? null,
      cashFloat: publicActiveCashFloat(cashFloat),
      activeOperationId:
        activeWorkflow?.operationId ??
        activeExchange?.operationId ??
        activeMovement?.movementId ??
        null,
      activeOperationType: activeWorkflow
        ? "cash_float"
        : activeExchange
          ? "cash_exchange"
          : activeMovement
            ? "cash_movement"
            : null,
      activeWorkflow: publicAutomaticCashWorkflow(
        activeWorkflow,
        workflowVisibilityContext(context),
      ),
      settlementAllowed: Boolean(cashFloat),
      lastSyncAtMs: Date.now(),
    });
  }

  async function handleGatewayState(req, res) {
    const db = await readDb();
    requestContext(req, db, req.__authPayload ?? {});
    const baseSettings = sanitizeDbSettings(db).automaticCash;
    const gatewayState = await readGatewayState(baseSettings);
    const settings = withRuntimeGateway(baseSettings, gatewayState);
    const activeWorkflow = getActiveAutomaticCashWorkflow(settings);
    const activeExchange = getActiveCashExchange(settings);
    const activeMovement = getActiveCashMovement(settings);
    const inventory = settings.gatewayInventory?.inventory ?? {};
    const gatewayEndpointListening =
      settings.gatewayConfigured === true && settings.gatewayInventory?.ok === true;
    const inventoryReady =
      gatewayEndpointListening &&
      inventory.ok !== false &&
      Array.isArray(inventory.listCassette) &&
      inventory.listCassette.length > 0;
    sendJson(res, 200, {
      ok: true,
      configured: settings.gatewayConfigured,
      reachable: gatewayEndpointListening,
      mode: settings.gatewayInventory?.mode ?? null,
      inventoryReady,
      busy: Boolean(activeWorkflow || activeExchange || activeMovement),
      operationId:
        activeWorkflow?.operationId ??
        activeExchange?.operationId ??
        activeMovement?.movementId ??
        null,
      operationType: activeWorkflow
        ? "cash_float"
        : activeExchange
          ? "cash_exchange"
          : activeMovement
            ? "cash_movement"
            : null,
      deviceId: null,
      inventory,
      updatedAtMs: settings.gatewayInventory?.updatedAtMs ?? null,
      error: gatewayEndpointListening
        ? null
        : inventory.error || "Endpoint gateway cassa automatica non raggiungibile.",
    });
  }

  async function handleGatewayCommand(req, res, command) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    requireManager(context.user);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const activeWorkflow = getActiveAutomaticCashWorkflow(current);
    const activeExchange = getActiveCashExchange(current);
    const activePayment = getActiveCashPayment(current);
    const activeDeposit =
      current.deposits.find((deposit) => deposit.status === "ACTIVE") ?? null;
    const activeMovement = getActiveCashMovement(current);
    if (
      activeWorkflow ||
      activeExchange ||
      activePayment ||
      activeDeposit ||
      activeMovement
    ) {
      throw new HttpError(
        409,
        "Cassa automatica occupata: chiudi l'operazione in corso prima di procedere.",
        {
          code: "CASH_GATEWAY_LOCKED",
          details: {
            operationType: activeWorkflow
              ? "cash_float"
              : activeExchange
                ? "cash_exchange"
                : activePayment
                  ? "cash_payment"
                  : activeDeposit
                    ? "deposit"
                    : "cash_movement",
            operationId:
              activeWorkflow?.operationId ??
              activeExchange?.operationId ??
              activePayment?.operationId ??
              activeDeposit?.operationId ??
              activeMovement?.movementId ??
              null,
          },
        },
      );
    }
    const gatewayMethod =
      command === "restart"
        ? automaticCashGateway?.restartMachine
        : automaticCashGateway?.resetMachine;
    if (automaticCashGateway?.configured !== true || typeof gatewayMethod !== "function") {
      throw new HttpError(503, "Gateway cassa automatica non configurato.", {
        code: "CASH_GATEWAY_UNREACHABLE",
      });
    }
    const requestedAtMs = Date.now();
    const gatewayResponse = await gatewayMethod({
      reason: normalizeText(payload.reason, 160),
      requestedBy: userDisplayName(context.user),
    }).catch((error) => {
      throw new HttpError(
        503,
        command === "restart"
          ? "Riavvio cassa automatica non riuscito."
          : "Reset cassa automatica non riuscito.",
        {
          code: "CASH_GATEWAY_UNREACHABLE",
          details: { message: error?.message ?? String(error) },
        },
      );
    });
    sendJson(res, 200, {
      ok: true,
      command,
      gatewayResponse,
      requestedAtMs,
    });
  }

  async function handleGatewayRestart(req, res) {
    return runCashFloatCriticalSection(() =>
      handleGatewayCommand(req, res, "restart"),
    );
  }

  async function handleGatewayReset(req, res) {
    return runCashFloatCriticalSection(() =>
      handleGatewayCommand(req, res, "reset"),
    );
  }

  async function handleCashFloatPreflight(req, res) {
    const db = await readDb();
    const context = requestContext(req, db, req.__authPayload ?? {});
    const baseSettings = sanitizeDbSettings(db).automaticCash;
    const gatewayInventory = await refreshGatewayInventory(baseSettings);
    const settings = withRuntimeGateway(baseSettings, gatewayInventory);
    sendJson(
      res,
      200,
      buildAutomaticCashPreflight(
        settings,
        workflowVisibilityContext(context, {
          nowMs: Date.now(),
          gatewayInventory,
        }),
      ),
    );
  }

  async function handleActiveCashFloatWorkflow(req, res) {
    const db = await readDb();
    const context = requestContext(req, db, req.__authPayload ?? {});
    const settings = sanitizeDbSettings(db).automaticCash;
    const activeWorkflow = getActiveAutomaticCashWorkflow(settings);
    sendJson(res, 200, {
      ok: true,
      activeWorkflow: publicAutomaticCashWorkflow(
        activeWorkflow,
        workflowVisibilityContext(context),
      ),
    });
  }

  async function handleGenerateCashFloat(req, res) {
    return runCashFloatCriticalSection(() =>
      handleGenerateCashFloatInner(req, res),
    );
  }

  async function handleGenerateCashFloatInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const currentSettings = sanitizeDbSettings(db);
    const baseCurrent = sanitizeAutomaticCashSettings(
      currentSettings.automaticCash,
    );
    const nowMs = nowMsFromIso(nowIso);
    const businessEveningKey = resolveAutomaticCashBusinessEveningKey(nowMs);
    const activeWorkflow = getActiveAutomaticCashWorkflow(baseCurrent);
    if (activeWorkflow) {
      const activePreflight = buildAutomaticCashPreflight(
        baseCurrent,
        workflowVisibilityContext(context, {
          nowMs,
          businessEveningKey,
        }),
      );
      if (
        payload.preferExistingAssignmentForEvening === true &&
        activePreflight.activeWorkflow?.resumableByCurrentUser
      ) {
        const claimed = await claimWorkflowOperation(
          db,
          baseCurrent,
          activeWorkflow,
          context,
          "cash_float_resume",
          nowMs,
        );
        const resumed = buildCashFloatGenerateResponseFromWorkflow(
          claimed.workflow,
          { resumed: true },
        );
        if (resumed) {
          sendJson(res, 200, resumed);
          return;
        }
      }
      if (activePreflight.activeWorkflow?.blockedByOperationLock) {
        throwCashFloatBusy(activePreflight.activeWorkflow.operationLock);
      }
      throwPreflightError(HttpError, activePreflight);
    }
    const gatewayInventory = await refreshGatewayInventory(baseCurrent, {
      required: true,
    });
    const current = withRuntimeGateway(baseCurrent, gatewayInventory);
    const { preflight, combination } = selectAutomaticCashCombination(current, {
      user: context.user,
      userId: context.user?.id,
      nowMs,
      businessEveningKey,
      gatewayInventory,
    });
    if (!preflight.canCreate || !combination) {
      throwPreflightError(HttpError, preflight);
    }
    const gatewayPieces = toGatewayPieces(combination);
    if (Object.keys(gatewayPieces).length === 0) {
      throw new HttpError(
        409,
        "Configurazione fondo cassa senza tagli erogabili.",
        {
          code: "FCA_NO_FEASIBLE_CONFIGURATION",
        },
      );
    }

    const workflowId = compactId("fcw");
    const operationId = compactId("op");
    const cashFloatId = `FCA-${preflight.businessEveningKey.replace(/-/g, "")}-${String(current.assignments.length + 1).padStart(4, "0")}`;
    const assignmentId = compactId("assign");
    const workflow = {
      workflowId,
      operationId,
      cashFloatId,
      assignmentId,
      ownerUserId: context.user?.id ?? "",
      ownerFullName: userDisplayName(context.user),
      ownerDeviceUuid: context.session?.deviceUuid ?? payload.deviceUuid ?? "",
      ownerSessionId: context.session?.id ?? "",
      activityId: payload.activityId ?? "",
      roomId: payload.roomId ?? "",
      reason: payload.reason ?? "operator_cash_float",
      step: "WITHDRAWAL_REQUESTED",
      startedAtMs: nowMs,
      updatedAtMs: nowMs,
      businessEveningKey: preflight.businessEveningKey,
      combinationId: combination.id,
      configSetId: combination.configSetId,
      reserveConfigId: combination.reserveConfigId,
      pieces: combination.pieces,
      gatewayPieces,
      totalCents: combination.totalCents,
      qrPayload: "",
      operationLock: {
        ownerUserId: context.user?.id ?? "",
        ownerFullName: userDisplayName(context.user),
        ownerDeviceUuid:
          context.session?.deviceUuid ?? payload.deviceUuid ?? "",
        ownerSessionId: context.session?.id ?? "",
        ownerCanManageAutomaticCash: canManageAutomaticCash(
          context.user,
          permissionHelpers,
        ),
        reason: "cash_float_generate",
        acquiredAtMs: nowMs,
        expiresAtMs: nowMs + workflowOperationLockTtlMs,
      },
      ticket: null,
    };
    workflow.qrPayload = buildQrPayload(workflow);
    const assignment = {
      assignmentId,
      workflowId,
      cashFloatId,
      ownerUserId: context.user?.id ?? "",
      ownerDeviceUuid: context.session?.deviceUuid ?? payload.deviceUuid ?? "",
      businessEveningKey: preflight.businessEveningKey,
      combinationId: combination.id,
      configSetId: combination.configSetId,
      reserveConfigId: combination.reserveConfigId,
      status: "assigned",
      createdAtMs: nowMs,
    };
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date(nowMs).toISOString();
    await persistAutomaticCash(
      db,
      {
        ...current,
        gatewayInventory,
        workflows: [...current.workflows, workflow],
        assignments: [...current.assignments, assignment],
      },
      updatedAt,
    );
    let workingWorkflow = workflow;
    try {
      if (automaticCashGateway?.configured === true) {
        await automaticCashGateway.executeWithdrawal({
          pieces: gatewayPieces,
          note: `Fondo cassa ${cashFloatId}`,
        });
      }
      const dispensing = transitionAutomaticCashWorkflow(
        workingWorkflow,
        "DISPENSING",
        {
          nowMs: nowMsFromIso(nowIso),
        },
      );
      if (!dispensing.ok) {
        throw new Error(dispensing.error);
      }
      const waiting = transitionAutomaticCashWorkflow(
        dispensing.workflow,
        "WAITING_CASH_REMOVAL",
        {
          nowMs: nowMsFromIso(nowIso),
        },
      );
      if (!waiting.ok) {
        throw new Error(waiting.error);
      }
      workingWorkflow = waiting.workflow;
      await persistAutomaticCash(
        db,
        {
          ...current,
          gatewayInventory,
          workflows: replaceById(
            [...current.workflows, workflow],
            "workflowId",
            workingWorkflow,
          ),
          assignments: [...current.assignments, assignment],
        },
        typeof nowIso === "function" ? nowIso() : new Date().toISOString(),
      );
    } catch (error) {
      const failedAtMs = nowMsFromIso(nowIso);
      const failed = transitionAutomaticCashWorkflow(
        workingWorkflow,
        "FAILED_BEFORE_DISPENSE",
        {
          nowMs: failedAtMs,
          patch: {
            error: normalizeText(error?.message ?? error, 240),
          },
        },
      );
      const failedWorkflow = failed.ok
        ? failed.workflow
        : {
            ...workingWorkflow,
            step: "FAILED_BEFORE_DISPENSE",
            updatedAtMs: failedAtMs,
            error: normalizeText(error?.message ?? error, 240),
          };
      await persistAutomaticCash(
        db,
        {
          ...current,
          gatewayInventory,
          workflows: replaceById(
            [...current.workflows, workflow],
            "workflowId",
            failedWorkflow,
          ),
          assignments: replaceById(
            [...current.assignments, assignment],
            "assignmentId",
            {
              ...assignment,
              status: "failed",
            },
          ),
        },
        typeof nowIso === "function"
          ? nowIso()
          : new Date(failedAtMs).toISOString(),
      );
      throw new HttpError(503, "Erogazione fondo cassa non riuscita.", {
        code: "FCA_GATEWAY_UNREACHABLE",
        details: {
          message: failedWorkflow.error,
        },
      });
    }

    sendJson(res, 200, {
      ok: true,
      workflowId,
      operationId,
      cashFloatId,
      assignmentId,
      businessEveningKey: preflight.businessEveningKey,
      combinationId: combination.id,
      configSetId: combination.configSetId,
      reserveConfigId: combination.reserveConfigId,
      pieces: combination.pieces,
      gatewayPieces,
      totalCents: combination.totalCents,
      createdAtMs: nowMs,
      qrPayload: workflow.qrPayload,
      step: workingWorkflow.step,
    });
  }

  async function updateWorkflowStep({
    req,
    res,
    payload,
    nextStep,
    patch = {},
    okBody = {},
  }) {
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const workflow = findWorkflow(current, payload);
    if (!workflow) {
      throw new HttpError(404, "Workflow fondo cassa non trovato.", {
        code: "FCA_WORKFLOW_NOT_FOUND",
      });
    }
    const nowMs = nowMsFromIso(nowIso);
    const lockedWorkflow = applyWorkflowOperationLock(
      workflow,
      context,
      `cash_float_${nextStep.toLowerCase()}`,
      nowMs,
    );
    const transitioned = transitionAutomaticCashWorkflow(
      lockedWorkflow,
      nextStep,
      {
        nowMs,
        patch,
      },
    );
    if (!transitioned.ok) {
      if (workflow.step === nextStep || workflow.step === "COMPLETED") {
        sendJson(res, 200, { ok: true, workflow, ...okBody });
        return { db, settings: current, workflow };
      }
      throw new HttpError(409, transitioned.error, {
        code: "FCA_WORKFLOW_STEP_CONFLICT",
      });
    }
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    const saved = await persistAutomaticCash(
      db,
      {
        ...current,
        workflows: replaceById(
          current.workflows,
          "workflowId",
          transitioned.workflow,
        ),
      },
      updatedAt,
    );
    sendJson(res, 200, {
      ok: true,
      workflow: transitioned.workflow,
      settingsVersion: resolveVersion(db, helpers.resolveSettingsVersion),
      ...okBody,
    });
    return { db, settings: saved, workflow: transitioned.workflow };
  }

  async function handleConfirmCashFloatRemoved(req, res) {
    return runCashFloatCriticalSection(() =>
      handleConfirmCashFloatRemovedInner(req, res),
    );
  }

  async function handleConfirmCashFloatRemovedInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const workflow = findWorkflow(current, payload);
    if (!workflow) {
      throw new HttpError(404, "Workflow fondo cassa non trovato.", {
        code: "FCA_WORKFLOW_NOT_FOUND",
      });
    }
    const claimed = await claimWorkflowOperation(
      db,
      current,
      workflow,
      context,
      "cash_float_confirm_removed",
      nowMsFromIso(nowIso),
    );
    if (
      [
        "TICKET_READY",
        "PRINTING_TICKET",
        "WAITING_TICKET_IN_POUCH",
        "COMPLETED",
      ].includes(claimed.workflow.step)
    ) {
      sendJson(res, 200, { ok: true, workflow: claimed.workflow });
      return;
    }
    if (automaticCashGateway?.configured === true) {
      try {
        await automaticCashGateway.confirmWithdrawalRemoved();
      } catch (error) {
        throw new HttpError(503, "Conferma ritiro fondo cassa non riuscita.", {
          code: "FCA_GATEWAY_UNREACHABLE",
          details: { message: error?.message ?? String(error) },
        });
      }
    }
    const nowMs = nowMsFromIso(nowIso);
    const transitioned = transitionAutomaticCashWorkflow(
      claimed.workflow,
      "TICKET_READY",
      { nowMs },
    );
    if (!transitioned.ok) {
      throw new HttpError(409, transitioned.error, {
        code: "FCA_WORKFLOW_STEP_CONFLICT",
      });
    }
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date(nowMs).toISOString();
    await persistAutomaticCash(
      db,
      {
        ...claimed.settings,
        workflows: replaceById(
          claimed.settings.workflows,
          "workflowId",
          transitioned.workflow,
        ),
      },
      updatedAt,
    );
    sendJson(res, 200, {
      ok: true,
      workflow: transitioned.workflow,
      settingsVersion: resolveVersion(db, helpers.resolveSettingsVersion),
    });
  }

  async function handleCashFloatTicketPrinted(req, res) {
    return runCashFloatCriticalSection(() =>
      handleCashFloatTicketPrintedInner(req, res),
    );
  }

  async function handleCashFloatTicketPrintedInner(req, res) {
    const payload = await readJsonBody(req);
    const printJobId =
      normalizeText(payload.printJobId, 160) || compactId("print");
    const printedAtMs = Number.isFinite(Number(payload.printedAtMs))
      ? Math.trunc(Number(payload.printedAtMs))
      : Date.now();
    await updateWorkflowStep({
      req,
      res,
      payload,
      nextStep: "WAITING_TICKET_IN_POUCH",
      patch: {
        ticket: {
          printed: true,
          printJobId,
          printedAtMs,
        },
      },
      okBody: {
        printJobId,
        printedAtMs,
      },
    });
  }

  async function handleConfirmCashFloatTicketInPouch(req, res) {
    return runCashFloatCriticalSection(() =>
      handleConfirmCashFloatTicketInPouchInner(req, res),
    );
  }

  async function handleConfirmCashFloatTicketInPouchInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const workflow = findWorkflow(current, payload);
    if (!workflow) {
      throw new HttpError(404, "Workflow fondo cassa non trovato.", {
        code: "FCA_WORKFLOW_NOT_FOUND",
      });
    }
    const nowMs = nowMsFromIso(nowIso);
    let workingWorkflow = applyWorkflowOperationLock(
      workflow,
      context,
      "cash_float_confirm_ticket_in_pouch",
      nowMs,
    );
    if (
      workingWorkflow.step !== "COMPLETED" &&
      workingWorkflow.ticket?.printed !== true
    ) {
      throw new HttpError(
        409,
        "Conferma finale non disponibile senza una stampa scontrino accettata.",
        {
          code: "FCA_WORKFLOW_STEP_CONFLICT",
        },
      );
    }
    if (workingWorkflow.step !== "COMPLETED") {
      const transitioned = transitionAutomaticCashWorkflow(
        workingWorkflow,
        "COMPLETED",
        {
          nowMs,
        },
      );
      if (!transitioned.ok) {
        throw new HttpError(409, transitioned.error, {
          code: "FCA_WORKFLOW_STEP_CONFLICT",
        });
      }
      workingWorkflow = transitioned.workflow;
    }
    const loadAsActiveCashFloat = payload.loadAsActiveCashFloat === true;
    const cashFloat = {
      cashFloatId: workingWorkflow.cashFloatId,
      workflowId: workingWorkflow.workflowId,
      assignmentId: workingWorkflow.assignmentId,
      combinationId: workingWorkflow.combinationId,
      businessEveningKey: workingWorkflow.businessEveningKey,
      ownerUserId: context.user?.id ?? workingWorkflow.ownerUserId,
      ownerDeviceUuid:
        context.session?.deviceUuid ?? workingWorkflow.ownerDeviceUuid,
      totalCents: workingWorkflow.totalCents,
      qrPayload: workingWorkflow.qrPayload,
      mode: "auto",
      status: "ACTIVE",
      loadedAtMs: nowMs,
    };
    const updatedAssignments = current.assignments.map((assignment) =>
      assignment.assignmentId === workingWorkflow.assignmentId
        ? {
            ...assignment,
            status: loadAsActiveCashFloat
              ? "active"
              : assignment.status === "active"
                ? "active"
                : "issued",
          }
        : assignment,
    );
    const nextAutomaticCash = {
      ...current,
      workflows: replaceById(
        current.workflows,
        "workflowId",
        workingWorkflow,
      ),
      assignments: updatedAssignments,
      cashFloats: loadAsActiveCashFloat
        ? replaceById(current.cashFloats, "cashFloatId", cashFloat)
        : current.cashFloats,
    };
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date(nowMs).toISOString();
    const saved = await persistAutomaticCash(
      db,
      nextAutomaticCash,
      updatedAt,
    );
    sendJson(res, 200, {
      ok: true,
      workflow: workingWorkflow,
      cashFloat: loadAsActiveCashFloat ? cashFloat : null,
      cashFloatId: cashFloat.cashFloatId,
      totalCents: cashFloat.totalCents,
      qrPayload: cashFloat.qrPayload,
      settlementAllowed: loadAsActiveCashFloat,
      settingsVersion: resolveVersion(db, helpers.resolveSettingsVersion),
    });
    return saved;
  }

  async function handleLoadCashFloatFromQr(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const parsed = parseQrPayload(payload.qrPayload);
    const cashFloatId = normalizeText(parsed?.cashFloatId, 120);
    if (!cashFloatId) {
      throw new HttpError(400, "QR fondo cassa non valido.", {
        code: "AUTOMATIC_CASH_QR_INVALID",
      });
    }
    const existing = current.cashFloats.find(
      (cashFloat) => cashFloat.cashFloatId === cashFloatId,
    );
    if (existing?.status === "ARCHIVED") {
      throw new HttpError(409, "QR non valido", {
        code: "AUTOMATIC_CASH_QR_USED",
      });
    }
    if (
      existing &&
      existing.ownerUserId &&
      existing.ownerUserId !== context.user?.id
    ) {
      throw new HttpError(409, "Fondo cassa assegnato a un altro operatore.", {
        code: "FCA_ACTIVE_WORKFLOW",
      });
    }
    const workflow =
      current.workflows.find((entry) => entry.cashFloatId === cashFloatId) ??
      null;
    if (!existing && workflow?.step !== "COMPLETED") {
      throw new HttpError(409, "Workflow fondo cassa non ancora completato.", {
        code: "FCA_WORKFLOW_STEP_CONFLICT",
      });
    }
    const nowMs = nowMsFromIso(nowIso);
    const cashFloat = existing ?? {
      cashFloatId,
      workflowId: workflow.workflowId,
      assignmentId: workflow.assignmentId,
      combinationId: workflow.combinationId,
      businessEveningKey: workflow.businessEveningKey,
      ownerUserId: context.user?.id ?? workflow.ownerUserId,
      ownerDeviceUuid: context.session?.deviceUuid ?? payload.deviceUuid ?? "",
      totalCents: workflow.totalCents,
      qrPayload: payload.qrPayload,
      mode: "auto",
      status: "ACTIVE",
      loadedAtMs: nowMs,
    };
    const updatedCashFloat = {
      ...cashFloat,
      ownerUserId: context.user?.id ?? cashFloat.ownerUserId,
      ownerDeviceUuid:
        context.session?.deviceUuid ??
        payload.deviceUuid ??
        cashFloat.ownerDeviceUuid,
      status: "ACTIVE",
    };
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date(nowMs).toISOString();
    await persistAutomaticCash(
      db,
      {
        ...current,
        cashFloats: replaceById(
          current.cashFloats,
          "cashFloatId",
          updatedCashFloat,
        ),
      },
      updatedAt,
    );
    sendJson(res, 200, {
      cashFloatId: updatedCashFloat.cashFloatId,
      businessEveningKey: updatedCashFloat.businessEveningKey,
      assignmentId: updatedCashFloat.assignmentId,
      combinationId: updatedCashFloat.combinationId,
      totalCents: updatedCashFloat.totalCents,
      createdAtMs: updatedCashFloat.loadedAtMs,
      qrPayload: updatedCashFloat.qrPayload,
      valid: true,
    });
  }

  async function handleSaveSettlementRecord(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const feedbackKind = resolveAutomaticCashSettlementFeedback({
      expectedDepositTotalCents: payload.expectedDepositTotalCents,
      depositedTotalCents: payload.depositedTotalCents,
      warningThresholdCents: current.warningThresholdCents,
      dangerThresholdCents: current.dangerThresholdCents,
    });
    const record = sanitizeAutomaticCashSettlementRecord({
      ...payload,
      feedbackKind,
      userId: payload.userId ?? context.user?.id,
      deviceUuid: payload.deviceUuid ?? context.session?.deviceUuid,
      operatorName: payload.operatorName ?? userDisplayName(context.user),
    });
    if (!record) {
      throw new HttpError(400, "Dettaglio scarico automatico non valido.", {
        code: "BAD_REQUEST",
      });
    }
    if (!canReadSettlementRecord(record, context, permissionHelpers)) {
      throw new HttpError(
        403,
        "Utente non autorizzato allo scarico automatico.",
        {
          code: "AUTOMATIC_CASH_PERMISSION_DENIED",
        },
      );
    }
    const nextRecords = [
      record,
      ...current.settlementRecords.filter((entry) => entry.id !== record.id),
    ].slice(0, 240);
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    await persistAutomaticCash(
      db,
      {
        ...current,
        settlementRecords: nextRecords,
      },
      updatedAt,
    );
    sendJson(res, 200, {
      ok: true,
      record,
      settingsVersion: resolveVersion(db, helpers.resolveSettingsVersion),
    });
  }

  async function handleListSettlementRecords(req, res) {
    const db = await readDb();
    const context = requestContext(req, db, {});
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const records = visibleSettlementRecords(
      current.settlementRecords,
      context,
      permissionHelpers,
    );
    sendJson(res, 200, {
      ok: true,
      records: records.slice(0, 120),
      count: records.length,
    });
  }

  async function handleLatestSettlementRecord(req, res) {
    const db = await readDb();
    const context = requestContext(req, db, {});
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const record =
      visibleSettlementRecords(
        current.settlementRecords,
        context,
        permissionHelpers,
      )[0] ?? null;
    sendJson(res, 200, {
      ok: true,
      record,
    });
  }

  function assertCashExchangeReady(settings) {
    if (!settings.enabled) {
      throw new HttpError(400, "Fondo cassa automatico non abilitato.", {
        code: "AUTOMATIC_CASH_DISABLED",
      });
    }
    if (!settings.gatewayConfigured) {
      throw new HttpError(400, "Gateway cassa automatica non configurato.", {
        code: "AUTOMATIC_CASH_NOT_CONFIGURED",
      });
    }
    const inventory = settings.gatewayInventory?.inventory ?? {};
    const reachable =
      settings.gatewayInventory?.ok !== false &&
      inventory.ok !== false &&
      Array.isArray(inventory.listCassette) &&
      inventory.listCassette.length > 0;
    if (!reachable) {
      throw new HttpError(503, "Cassa automatica non raggiungibile.", {
        code: "CASH_GATEWAY_UNREACHABLE",
      });
    }
  }

  function assertCashExchangeAccess(
    exchange,
    context,
    nowMs = nowMsFromIso(nowIso),
  ) {
    const visible = publicCashExchange(
      exchange,
      workflowVisibilityContext(context, { nowMs }),
    );
    if (visible?.blockedByOperationLock) {
      throwCashExchangeBusy(visible.operationLock);
    }
    if (!visible?.resumableByCurrentUser) {
      throwCashExchangeBusy(exchange?.operationLock ?? null);
    }
    return visible;
  }

  function assertCashExchangeTransition(exchange, nextStatus, patch, nowMs) {
    const transitioned = transitionCashExchange(exchange, nextStatus, {
      nowMs,
      patch,
    });
    if (!transitioned.ok) {
      throw new HttpError(409, transitioned.error, {
        code: "CASH_EXCHANGE_STEP_CONFLICT",
      });
    }
    return transitioned.exchange;
  }

  function normalizedCashExchangeError(error) {
    return {
      message: normalizeText(error?.message ?? String(error), 240),
      code: normalizeText(error?.code, 80) || null,
      status: Number.isInteger(error?.status) ? error.status : null,
    };
  }

  function isGatewayEndpointNotFoundError(error) {
    const status = Number(error?.status ?? error?.statusCode);
    if (status !== 404) return false;
    const message = normalizeText(
      error?.body?.message ?? error?.body?.error ?? error?.message ?? String(error),
      500,
    ).toLowerCase();
    return (
      message.includes("endpoint non trovato") ||
      message.includes("endpoint not found") ||
      message.includes("not found")
    );
  }

  function cashExchangeAuditActor(context) {
    return {
      actorUserId: normalizeText(context.user?.id, 120),
      actorFullName: userDisplayName(context.user),
      actorRole: normalizeText(context.user?.role, 80),
      deviceUuid: normalizeText(context.session?.deviceUuid, 160),
      sessionId: normalizeText(context.session?.id, 160),
    };
  }

  function auditCashExchange(
    exchange,
    action,
    context,
    event = {},
    nowMs = nowMsFromIso(nowIso),
  ) {
    return appendCashExchangeAuditEvent(
      exchange,
      action,
      {
        ...cashExchangeAuditActor(context),
        ...event,
      },
      { nowMs },
    );
  }

  async function persistCashExchange(
    db,
    settings,
    exchange,
    nowMs = nowMsFromIso(nowIso),
  ) {
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date(nowMs).toISOString();
    const saved = await persistAutomaticCash(
      db,
      {
        ...settings,
        cashExchanges: replaceById(
          settings.cashExchanges,
          "exchangeId",
          exchange,
        ),
      },
      updatedAt,
    );
    return {
      settings: saved,
      exchange:
        saved.cashExchanges.find(
          (entry) => entry.exchangeId === exchange.exchangeId,
        ) ?? exchange,
    };
  }

  async function persistCashPayment(
    db,
    settings,
    payment,
    nowMs = nowMsFromIso(nowIso),
  ) {
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date(nowMs).toISOString();
    const saved = await persistAutomaticCash(
      db,
      {
        ...settings,
        cashPayments: replaceById(
          settings.cashPayments,
          "operationId",
          payment,
        ),
      },
      updatedAt,
    );
    return {
      settings: saved,
      payment:
        saved.cashPayments.find(
          (entry) => entry.operationId === payment.operationId,
        ) ?? payment,
    };
  }

  function buildCashPaymentResponse(payment, extra = {}) {
    const expectedTotalCents = centsFromValue(payment?.expectedTotalCents, 0);
    const depositedTotalCents = centsFromValue(payment?.depositedTotalCents, 0);
    const changeDueCents = centsFromValue(
      payment?.changeDueCents,
      Math.max(0, depositedTotalCents - expectedTotalCents),
    );
    return {
      ok: true,
      operationId: normalizeText(payment?.operationId, 120),
      status: normalizeText(payment?.status || "ACTIVE", 40).toUpperCase(),
      expectedTotalCents,
      depositedTotalCents,
      changeDueCents,
      readyToComplete:
        expectedTotalCents > 0 && depositedTotalCents >= expectedTotalCents,
      startedAtMs: payment?.startedAtMs ?? null,
      updatedAtMs: payment?.updatedAtMs ?? Date.now(),
      completedAtMs: payment?.completedAtMs ?? null,
      ...extra,
    };
  }

  function getActiveReserveConfigForSettings(settings) {
    const reserveConfigId = normalizeText(settings.reserveConfigId, 120);
    return (
      settings.reserveConfigs.find((entry) => entry.id === reserveConfigId) ??
      settings.reserveConfigs[0] ??
      null
    );
  }

  function cashExchangeReserveByCents(settings) {
    const reserveConfig = getActiveReserveConfigForSettings(settings);
    if (!reserveConfig?.enabled) return new Map();
    const denominations = reserveConfig.denominazioni_centesimi ?? {};
    const minimumPieces = reserveConfig.riserva_minima_pezzi ?? {};
    const reserveByCents = new Map();
    for (const [label, rawCents] of Object.entries(denominations)) {
      const cents = toInteger(rawCents);
      const pieces = toInteger(minimumPieces[label]);
      if (cents === null || cents <= 0 || pieces === null || pieces <= 0)
        continue;
      reserveByCents.set(cents, (reserveByCents.get(cents) ?? 0) + pieces);
    }
    return reserveByCents;
  }

  function cashExchangeHasAuditAction(exchange, action) {
    return (exchange?.auditEvents ?? []).some((event) => event?.action === action);
  }

  function isLegacyCashExchangeDeposit(exchange) {
    if (exchange?.status === "DEPOSIT_STARTED") return true;
    return (
      cashExchangeHasAuditAction(exchange, "cash_exchange.deposit_started") &&
      !cashExchangeHasAuditAction(exchange, "cash_exchange.change_started")
    );
  }

  function resolveCashExchangeAvailableDenominations(settings, gatewayReturnChange = null) {
    const gatewayAvailability = Array.isArray(gatewayReturnChange?.availableDenominations)
      ? gatewayReturnChange.availableDenominations
      : [];
    if (gatewayAvailability.length > 0) return gatewayAvailability;
    return buildCashExchangeAvailableDenominations(settings);
  }

  function assertCashExchangeInventory(settings, pieces) {
    const rows = Array.isArray(
      settings.gatewayInventory?.inventory?.listCassette,
    )
      ? settings.gatewayInventory.inventory.listCassette
      : [];
    if (rows.length === 0) {
      throw new HttpError(503, "Inventario cassa automatica non disponibile.", {
        code: "CASH_GATEWAY_UNREACHABLE",
      });
    }
    const availableByCents = new Map();
    for (const row of rows) {
      if (row?.IsExist === false || row?.IsEmpty === true) continue;
      const cents = Number(row?.Value_Money);
      const stock = Number(row?.Stock);
      if (
        !Number.isInteger(cents) ||
        !Number.isInteger(stock) ||
        cents <= 0 ||
        stock <= 0
      )
        continue;
      availableByCents.set(cents, (availableByCents.get(cents) ?? 0) + stock);
    }
    const reserveByCents = cashExchangeReserveByCents(settings);
    for (const [rawCents, quantity] of Object.entries(pieces)) {
      const cents = Number(rawCents);
      const availablePieces = availableByCents.get(cents) ?? 0;
      const minimumReservePieces = reserveByCents.get(cents) ?? 0;
      const remainingPieces = availablePieces - quantity;
      if (remainingPieces < minimumReservePieces) {
        throw new HttpError(409, "Tagli non disponibili in cassa automatica.", {
          code: "CASH_EXCHANGE_INVENTORY_INSUFFICIENT",
          details: {
            denominationCents: cents,
            requestedPieces: quantity,
            availablePieces,
            minimumReservePieces,
            remainingPieces,
          },
        });
      }
    }
  }

  async function handleActiveCashExchange(req, res) {
    const db = await readDb();
    const context = requestContext(req, db, req.__authPayload ?? {});
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const activeExchange = getActiveCashExchange(current);
    sendJson(res, 200, {
      ok: true,
      activeExchange: publicCashExchange(
        activeExchange,
        workflowVisibilityContext(context),
      ),
    });
  }

  async function handleStartCashPayment(req, res) {
    return runCashFloatCriticalSection(() =>
      handleStartCashPaymentInner(req, res),
    );
  }

  async function handleStartCashPaymentInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    if (automaticCashGateway?.configured !== true) {
      throw new HttpError(503, "Cassa automatica non raggiungibile.", {
        code: "CASH_GATEWAY_UNREACHABLE",
      });
    }
    const expectedTotalCents = centsFromValue(payload.expectedTotalCents, 0);
    if (expectedTotalCents <= 0) {
      throw new HttpError(400, "Importo incasso cassa automatica non valido.", {
        code: "BAD_REQUEST",
      });
    }
    const activeWorkflow = getActiveAutomaticCashWorkflow(current);
    const activeExchange = getActiveCashExchange(current);
    const activePayment = getActiveCashPayment(current);
    const activeDeposit = current.deposits.find((deposit) => deposit.status === "ACTIVE") ?? null;
    const gatewayState = await readGatewayState(current);
    if (
      activeWorkflow ||
      activeExchange ||
      activePayment ||
      activeDeposit ||
      gatewayState?.activeOperation
    ) {
      throw new HttpError(409, "Cassa automatica occupata.", {
        code: "CASH_GATEWAY_LOCKED",
        details: {
          operationId:
            activeWorkflow?.operationId ??
            activeExchange?.operationId ??
            activePayment?.operationId ??
            activeDeposit?.operationId ??
            gatewayState?.activeOperation?.id ??
            null,
        },
      });
    }
    const operationId = compactId("paycash");
    const nowMs = nowMsFromIso(nowIso);
    const note =
      normalizeText(payload.note, 160) || `Pagamento contanti ${operationId}`;
    await automaticCashGateway
      .startCashinPayment({
        operationId,
        userId: context.user?.id ?? "",
        note,
        expectedTotalCents,
        activityId: normalizeText(payload.activityId, 120),
        roomId: normalizeText(payload.roomId, 120),
      })
      .catch((error) => {
        throw new HttpError(503, "Avvio incasso cassa automatica non riuscito.", {
          code: "CASH_GATEWAY_UNREACHABLE",
          details: { message: error?.message ?? String(error) },
        });
      });
    const saved = await persistCashPayment(
      db,
      current,
      {
        operationId,
        ownerUserId: context.user?.id ?? "",
        ownerFullName: userDisplayName(context.user),
        ownerDeviceUuid: normalizeText(
          context.session?.deviceUuid ?? payload.deviceUuid,
          160,
        ),
        ownerSessionId: normalizeText(context.session?.id, 160),
        activityId: normalizeText(payload.activityId, 120),
        roomId: normalizeText(payload.roomId, 120),
        note,
        status: "ACTIVE",
        expectedTotalCents,
        depositedTotalCents: 0,
        changeDueCents: 0,
        startedAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      nowMs,
    );
    sendJson(res, 200, buildCashPaymentResponse(saved.payment, {
      operationId,
    }));
  }

  async function handleCashPaymentState(req, res) {
    const db = await readDb();
    requestContext(req, db, req.__authPayload ?? {});
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const operationId = normalizeText(req.params?.operationId, 120);
    if (!operationId) {
      throw new HttpError(400, "Operazione pagamento cassa automatica non valida.", {
        code: "BAD_REQUEST",
      });
    }
    if (automaticCashGateway?.configured !== true) {
      throw new HttpError(503, "Cassa automatica non raggiungibile.", {
        code: "CASH_GATEWAY_UNREACHABLE",
      });
    }
    const gatewayDeposit = await automaticCashGateway
      .getCashinDeposit({ operationId })
      .catch((error) => {
        throw new HttpError(503, "Lettura incasso cassa automatica non riuscita.", {
          code: "CASH_GATEWAY_UNREACHABLE",
          details: { message: error?.message ?? String(error) },
        });
      });
    const depositedTotalCents = readDepositedTotalCents(
      gatewayDeposit?.payload,
      [gatewayDeposit?.state],
      0,
    );
    const payment = findCashPayment(current, { operationId });
    const expectedTotalCents = centsFromValue(payment?.expectedTotalCents, 0);
    const statePayment = {
      ...(payment ?? {}),
      operationId,
      status: payment?.status ?? "ACTIVE",
      expectedTotalCents,
      depositedTotalCents,
      changeDueCents: Math.max(0, depositedTotalCents - expectedTotalCents),
      updatedAtMs: Date.now(),
    };
    sendJson(res, 200, buildCashPaymentResponse(statePayment, {
      gatewayDeposit,
    }));
  }

  async function handleCompleteCashPayment(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const operationId = normalizeText(req.params?.operationId || payload.operationId, 120);
    if (!operationId) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (automaticCashGateway?.configured !== true) {
      throw new HttpError(503, "Cassa automatica non raggiungibile.", {
        code: "CASH_GATEWAY_UNREACHABLE",
      });
    }
    const payment = findCashPayment(current, { operationId });
    const expectedTotalCents = centsFromValue(
      payment?.expectedTotalCents ?? payload.expectedTotalCents,
      0,
    );
    const fallbackDepositedTotalCents = centsFromValue(
      payment?.depositedTotalCents ?? payload.depositedTotalCents,
      0,
    );
    const gatewayDeposit = await automaticCashGateway
      .getCashinDeposit({ operationId })
      .catch((error) => {
        throw new HttpError(503, "Lettura incasso cassa automatica non riuscita.", {
          code: "CASH_GATEWAY_UNREACHABLE",
          details: { message: error?.message ?? String(error) },
        });
      });
    const depositedTotalCents = readDepositedTotalCents(
      gatewayDeposit?.payload,
      [gatewayDeposit?.state],
      fallbackDepositedTotalCents,
    );
    const computedChangeDueCents = Math.max(
      0,
      depositedTotalCents - expectedTotalCents,
    );
    const payloadChangeDueCents = centsFromValue(payload.changeDueCents, 0);
    const changeDueCents = Math.max(
      computedChangeDueCents,
      payloadChangeDueCents,
    );
    if (expectedTotalCents > 0 && depositedTotalCents < expectedTotalCents) {
      throw new HttpError(409, "Incasso cassa automatica incompleto.", {
        code: "CASH_PAYMENT_INCOMPLETE",
        details: buildCashPaymentResponse({
          ...(payment ?? {}),
          operationId,
          expectedTotalCents,
          depositedTotalCents,
          changeDueCents,
        }),
      });
    }
    let gatewayResponse = null;
    gatewayResponse = await automaticCashGateway
      .completeCashinPayment({
        operationId,
        expectedTotalCents,
        depositedTotalCents,
        changeDueCents,
      })
      .catch((error) => {
        throw new HttpError(503, "Chiusura incasso cassa automatica non riuscita.", {
          code: "CASH_GATEWAY_UNREACHABLE",
          details: { message: error?.message ?? String(error) },
        });
      });
    const nowMs = nowMsFromIso(nowIso);
    const completedPayment = {
      ...(payment ?? {}),
      operationId,
      status: "COMPLETED",
      expectedTotalCents,
      depositedTotalCents,
      changeDueCents,
      updatedAtMs: nowMs,
      completedAtMs: nowMs,
    };
    const saved = await persistCashPayment(db, current, completedPayment, nowMs);
    sendJson(res, 200, buildCashPaymentResponse(saved.payment, {
      gatewayDeposit,
      gatewayResponse,
    }));
  }

  async function handleCancelCashPayment(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const operationId = normalizeText(req.params?.operationId || payload.operationId, 120);
    if (!operationId) {
      sendJson(res, 200, { ok: true });
      return;
    }
    const payment = findCashPayment(current, { operationId });
    if (payment && payment.status !== "ACTIVE") {
      sendJson(res, 200, buildCashPaymentResponse(payment));
      return;
    }
    let gatewayResponse = null;
    if (automaticCashGateway?.configured === true) {
      gatewayResponse = await automaticCashGateway.cancelCashinPayment({ operationId }).catch((error) => {
        throw new HttpError(503, "Annullamento incasso cassa automatica non riuscito.", {
          code: "CASH_GATEWAY_UNREACHABLE",
          details: { message: error?.message ?? String(error) },
        });
      });
    }
    if (payment) {
      const nowMs = nowMsFromIso(nowIso);
      const saved = await persistCashPayment(
        db,
        current,
        {
          ...payment,
          status: "CANCELLED",
          updatedAtMs: nowMs,
          completedAtMs: nowMs,
        },
        nowMs,
      );
      sendJson(res, 200, buildCashPaymentResponse(saved.payment, {
        gatewayResponse,
      }));
      return;
    }
    sendJson(res, 200, {
      ok: true,
      operationId,
      status: "CANCELLED",
      gatewayResponse,
    });
  }

  async function handleStartCashExchange(req, res) {
    return runCashFloatCriticalSection(() =>
      handleStartCashExchangeInner(req, res),
    );
  }

  async function handleStartCashExchangeInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const baseCurrent = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const activeWorkflow = getActiveAutomaticCashWorkflow(baseCurrent);
    if (activeWorkflow) {
      throw new HttpError(409, "Fondo cassa automatico in corso.", {
        code: "FCA_ACTIVE_WORKFLOW",
      });
    }
    const activeExchange = getActiveCashExchange(baseCurrent);
    if (activeExchange) {
      const visible = publicCashExchange(
        activeExchange,
        workflowVisibilityContext(context),
      );
      if (!visible?.resumableByCurrentUser || visible?.blockedByOperationLock) {
        throwCashExchangeBusy(
          visible?.operationLock ?? activeExchange.operationLock,
        );
      }
      const nowMs = nowMsFromIso(nowIso);
      const claimed = applyWorkflowOperationLock(
        activeExchange,
        context,
        "cash_exchange_resume",
        nowMs,
      );
      const saved = await persistCashExchange(db, baseCurrent, claimed, nowMs);
      sendJson(res, 200, buildCashExchangeStatePayload(saved.exchange));
      return;
    }
    const gatewayInventory = await refreshGatewayInventory(baseCurrent, {
      required: true,
    });
    const current = withRuntimeGateway(baseCurrent, gatewayInventory);
    assertCashExchangeReady(current);
    const nowMs = nowMsFromIso(nowIso);
    let exchange = {
      exchangeId: compactId("exch"),
      operationId: compactId("chgop"),
      ownerUserId: context.user?.id ?? "",
      ownerFullName: userDisplayName(context.user),
      ownerDeviceUuid: normalizeText(
        context.session?.deviceUuid ?? payload.deviceUuid,
        160,
      ),
      ownerSessionId: normalizeText(context.session?.id, 160),
      activityId: normalizeText(payload.activityId, 120),
      roomId: normalizeText(payload.roomId, 120),
      status: "CREATED",
      depositedCents: 0,
      selectedPieces: {},
      selectedTotalCents: 0,
      allowedDenominationsCents: CASH_EXCHANGE_DENOMINATION_CENTS,
      startedAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    exchange = auditCashExchange(
      exchange,
      "cash_exchange.created",
      context,
      {
        snapshot: {
          gatewayInventory: current.gatewayInventory,
          allowedDenominationsCents: CASH_EXCHANGE_DENOMINATION_CENTS,
        },
      },
      nowMs,
    );
    exchange = applyWorkflowOperationLock(
      exchange,
      context,
      "cash_exchange_start",
      nowMs,
    );
    if (automaticCashGateway?.configured === true) {
      try {
        await automaticCashGateway.startCashinChange({
          operationId: exchange.operationId,
          userId: context.user?.id ?? "",
          note: `Cambio denaro ${exchange.exchangeId}`,
        });
      } catch (error) {
        if (isGatewayEndpointNotFoundError(error)) {
          try {
            await automaticCashGateway.startReplenishment();
          } catch (fallbackError) {
            const failureNowMs = nowMsFromIso(nowIso);
            const failedTransition = assertCashExchangeTransition(
              exchange,
              "FAILED",
              {
                error: fallbackError?.message ?? String(fallbackError),
              },
              failureNowMs,
            );
            const failed = auditCashExchange(
              failedTransition,
              "cash_exchange.failed",
              context,
              {
                error: fallbackError?.message ?? String(fallbackError),
                snapshot: {
                  phase: "legacy_replenishment_start",
                  nativeStartError: normalizedCashExchangeError(error),
                  error: normalizedCashExchangeError(fallbackError),
                },
              },
              failureNowMs,
            );
            await persistCashExchange(db, current, failed, failureNowMs);
            throw new HttpError(503, "Avvio deposito cambio non riuscito.", {
              code: "CASH_GATEWAY_UNREACHABLE",
              details: { message: fallbackError?.message ?? String(fallbackError) },
            });
          }
          const depositStarted = auditCashExchange(
            assertCashExchangeTransition(
              exchange,
              "DEPOSIT_STARTED",
              {},
              nowMs,
            ),
            "cash_exchange.deposit_started",
            context,
            {
              snapshot: {
                operationLock: exchange.operationLock,
                gatewayInventory: current.gatewayInventory,
                nativeStartError: normalizedCashExchangeError(error),
              },
            },
            nowMs,
          );
          const saved = await persistCashExchange(
            db,
            current,
            depositStarted,
            nowMs,
          );
          sendJson(res, 200, buildCashExchangeStatePayload(saved.exchange));
          return;
        }
        const failureNowMs = nowMsFromIso(nowIso);
        const failedTransition = assertCashExchangeTransition(
          exchange,
          "FAILED",
          {
            error: error?.message ?? String(error),
          },
          failureNowMs,
        );
        const failed = auditCashExchange(
          failedTransition,
          "cash_exchange.failed",
          context,
          {
            error: error?.message ?? String(error),
            snapshot: {
              phase: "cashin_change_start",
              error: normalizedCashExchangeError(error),
            },
          },
          failureNowMs,
        );
        await persistCashExchange(db, current, failed, failureNowMs);
        throw new HttpError(503, "Avvio deposito cambio non riuscito.", {
          code: "CASH_GATEWAY_UNREACHABLE",
          details: { message: error?.message ?? String(error) },
        });
      }
    }
    exchange = assertCashExchangeTransition(
      exchange,
      "CHANGE_STARTED",
      {},
      nowMs,
    );
    exchange = auditCashExchange(
      exchange,
      "cash_exchange.change_started",
      context,
      {
        snapshot: {
          operationLock: exchange.operationLock,
          gatewayInventory: current.gatewayInventory,
        },
      },
      nowMs,
    );
    const persisted = await persistCashExchange(db, current, exchange, nowMs);
    const depositing = assertCashExchangeTransition(
      persisted.exchange,
      "DEPOSITING",
      {},
      nowMs,
    );
    const saved = await persistCashExchange(
      db,
      persisted.settings,
      depositing,
      nowMs,
    );
    sendJson(res, 200, buildCashExchangeStatePayload(saved.exchange));
  }

  async function handleCashExchangeState(req, res) {
    const db = await readDb();
    const context = requestContext(req, db, req.__authPayload ?? {});
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const exchange = findCashExchange(current, req.params);
    if (!exchange) {
      throw new HttpError(404, "Cambio denaro non trovato.", {
        code: "AUTOMATIC_CASH_OPERATION_NOT_FOUND",
      });
    }
    assertCashExchangeAccess(exchange, context);
    let nextExchange = exchange;
    if (
      ["CHANGE_STARTED", "DEPOSIT_STARTED", "DEPOSITING"].includes(exchange.status) &&
      automaticCashGateway?.configured === true
    ) {
      const gatewayDeposit = isLegacyCashExchangeDeposit(exchange)
        ? {
            payload: null,
            state: await automaticCashGateway.getState().catch((error) => {
              throw new HttpError(503, "Lettura deposito cambio non riuscita.", {
                code: "CASH_GATEWAY_UNREACHABLE",
                details: { message: error?.message ?? String(error) },
              });
            }),
          }
        : await automaticCashGateway.getCashinDeposit({
            operationId: exchange.operationId,
          }).catch((error) => {
        throw new HttpError(503, "Lettura deposito cambio non riuscita.", {
          code: "CASH_GATEWAY_UNREACHABLE",
          details: { message: error?.message ?? String(error) },
        });
      });
      const depositedCents = readDepositedTotalCents(
        gatewayDeposit?.payload,
        gatewayDeposit?.state,
        exchange.depositedCents,
        { minCachedAtMs: exchange.startedAtMs },
      );
      if (depositedCents !== exchange.depositedCents) {
        const pollNowMs = nowMsFromIso(nowIso);
        nextExchange = auditCashExchange(
          {
            ...exchange,
            depositedCents,
            updatedAtMs: pollNowMs,
          },
          "cash_exchange.deposit_poll",
          context,
          {
            depositedCents,
            snapshot: {
              gatewayDeposit,
              gatewayState: gatewayDeposit?.state ?? null,
            },
          },
          pollNowMs,
        );
        const saved = await persistCashExchange(
          db,
          current,
          nextExchange,
          pollNowMs,
        );
        nextExchange = saved.exchange;
      }
    }
    sendJson(res, 200, buildCashExchangeStatePayload(nextExchange));
  }

  async function handleCancelCashExchange(req, res) {
    return runCashFloatCriticalSection(() =>
      handleCancelCashExchangeInner(req, res),
    );
  }

  async function handleCancelCashExchangeInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const exchange = findCashExchange(current, { ...req.params, ...payload });
    if (
      !exchange ||
      ["COMPLETED", "CANCELLED", "FAILED"].includes(exchange.status)
    ) {
      sendJson(res, 200, { ok: true });
      return;
    }
    assertCashExchangeAccess(exchange, context);
    if (automaticCashGateway?.configured === true) {
      const cancelDepositStatus = ["CHANGE_STARTED", "DEPOSIT_STARTED", "DEPOSITING"].includes(
        exchange.status,
      );
      if (cancelDepositStatus && isLegacyCashExchangeDeposit(exchange)) {
        await automaticCashGateway.cancelReplenishment().catch((error) => {
          throw new HttpError(503, "Annullamento deposito cambio non riuscito.", {
            code: "CASH_GATEWAY_UNREACHABLE",
            details: { message: error?.message ?? String(error) },
          });
        });
      } else if (
        cancelDepositStatus ||
        ["CHANGE_REQUESTED", "WAITING_CHANGE_REMOVAL"].includes(exchange.status)
      ) {
        await automaticCashGateway
          .cancelCashinChange({ operationId: exchange.operationId })
          .catch((error) => {
            throw new HttpError(503, "Annullamento cambio non riuscito.", {
              code: "CASH_GATEWAY_UNREACHABLE",
              details: { message: error?.message ?? String(error) },
            });
          });
      }
    }
    const nowMs = nowMsFromIso(nowIso);
    const cancelled = assertCashExchangeTransition(
      exchange,
      "CANCELLED",
      {
        error: normalizeText(payload.reason, 120),
      },
      nowMs,
    );
    const audited = auditCashExchange(
      cancelled,
      "cash_exchange.deposit_cancelled",
      context,
      {
        error: normalizeText(payload.reason, 120),
        snapshot: {
          reason: normalizeText(payload.reason, 120),
        },
      },
      nowMs,
    );
    await persistCashExchange(db, current, audited, nowMs);
    sendJson(res, 200, { ok: true });
  }

  async function handleConfirmCashExchangeDeposit(req, res) {
    return runCashFloatCriticalSection(() =>
      handleConfirmCashExchangeDepositInner(req, res),
    );
  }

  async function handleConfirmCashExchangeDepositInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const exchange = findCashExchange(current, { ...req.params, ...payload });
    if (!exchange) {
      throw new HttpError(404, "Cambio denaro non trovato.", {
        code: "AUTOMATIC_CASH_OPERATION_NOT_FOUND",
      });
    }
    assertCashExchangeAccess(exchange, context);
    if (!["CHANGE_STARTED", "DEPOSIT_STARTED", "DEPOSITING"].includes(exchange.status)) {
      throw new HttpError(
        409,
        "Il deposito cambio non e' confermabile in questo stato.",
        {
          code: "CASH_EXCHANGE_STEP_CONFLICT",
        },
      );
    }
    const gatewayDeposit =
      automaticCashGateway?.configured === true
        ? isLegacyCashExchangeDeposit(exchange)
          ? await automaticCashGateway.closeReplenishment().catch((error) => {
              throw new HttpError(503, "Chiusura deposito cambio non riuscita.", {
                code: "CASH_GATEWAY_UNREACHABLE",
                details: { message: error?.message ?? String(error) },
              });
            })
          : await automaticCashGateway
              .getCashinDeposit({ operationId: exchange.operationId })
              .catch((error) => {
                throw new HttpError(503, "Lettura deposito cambio non riuscita.", {
                  code: "CASH_GATEWAY_UNREACHABLE",
                  details: { message: error?.message ?? String(error) },
                });
              })
        : null;
    const depositedCents =
      automaticCashGateway?.configured === true
        ? readDepositedTotalCents(
            gatewayDeposit?.payload,
            gatewayDeposit?.state,
            exchange.depositedCents,
            { minCachedAtMs: exchange.startedAtMs },
          )
        : Number.isFinite(Number(payload.depositedCents))
          ? Math.max(0, Math.round(Number(payload.depositedCents)))
          : exchange.depositedCents;
    if (depositedCents <= 0 || depositedCents % 5 !== 0) {
      throw new HttpError(
        400,
        "Importo cambio non rappresentabile con i tagli disponibili.",
        {
          code: "CASH_EXCHANGE_AMOUNT_NOT_REPRESENTABLE",
        },
      );
    }
    const gatewayReturnChange =
      automaticCashGateway?.configured === true && !isLegacyCashExchangeDeposit(exchange)
        ? await automaticCashGateway
            .getReturnChange({
              totalToChangeCents: depositedCents,
              operationId: exchange.operationId,
            })
            .catch((error) => {
              throw new HttpError(503, "Disponibilita tagli cambio non riuscita.", {
                code: "CASH_GATEWAY_UNREACHABLE",
                details: { message: error?.message ?? String(error) },
              });
            })
        : null;
    const availableDenominations = resolveCashExchangeAvailableDenominations(
      current,
      gatewayReturnChange,
    );
    const nowMs = nowMsFromIso(nowIso);
    const confirmed = assertCashExchangeTransition(
      exchange,
      "DEPOSIT_CONFIRMED",
      {
        depositedCents,
        allowedDenominationsCents: CASH_EXCHANGE_DENOMINATION_CENTS,
        availableDenominations,
      },
      nowMs,
    );
    const auditedConfirmed = auditCashExchange(
      confirmed,
      "cash_exchange.deposit_confirmed",
      context,
      {
        depositedCents,
        snapshot: {
          gatewayDeposit,
          gatewayState: gatewayDeposit?.state ?? null,
          gatewayReturnChange,
          availableDenominations,
        },
      },
      nowMs,
    );
    const selecting = assertCashExchangeTransition(
      auditedConfirmed,
      "SELECTING_DENOMINATIONS",
      {},
      nowMs,
    );
    const saved = await persistCashExchange(db, current, selecting, nowMs);
    sendJson(res, 200, buildCashExchangeStatePayload(saved.exchange));
  }

  async function handleExecuteCashExchange(req, res) {
    return runCashFloatCriticalSection(() =>
      handleExecuteCashExchangeInner(req, res),
    );
  }

  async function handleExecuteCashExchangeInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const baseCurrent = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const exchange = findCashExchange(baseCurrent, {
      ...req.params,
      ...payload,
    });
    if (!exchange) {
      throw new HttpError(404, "Cambio denaro non trovato.", {
        code: "AUTOMATIC_CASH_OPERATION_NOT_FOUND",
      });
    }
    assertCashExchangeAccess(exchange, context);
    if (exchange.status !== "SELECTING_DENOMINATIONS") {
      throw new HttpError(409, "Il cambio non e' erogabile in questo stato.", {
        code: "CASH_EXCHANGE_STEP_CONFLICT",
      });
    }
    const validation = validateCashExchangePieces(
      payload.pieces,
      exchange.depositedCents,
    );
    if (!validation.ok) {
      throw new HttpError(400, validation.error, {
        code: validation.code,
      });
    }
    const gatewayInventory = await refreshGatewayInventory(baseCurrent, {
      required: true,
    });
    const current = withRuntimeGateway(baseCurrent, gatewayInventory);
    assertCashExchangeInventory(current, validation.pieces);
    const nowMs = nowMsFromIso(nowIso);
    const legacyCashExchange = isLegacyCashExchangeDeposit(exchange);
    let started = assertCashExchangeTransition(
      exchange,
      legacyCashExchange ? "WITHDRAWAL_STARTED" : "CHANGE_REQUESTED",
      {
        selectedPieces: validation.pieces,
        selectedTotalCents: validation.selectedTotalCents,
      },
      nowMs,
    );
    started = auditCashExchange(
      started,
      "cash_exchange.denominations_selected",
      context,
      {
        selectedPieces: validation.pieces,
        snapshot: {
          pieces: validation.pieces,
          selectedTotalCents: validation.selectedTotalCents,
        },
      },
      nowMs,
    );
    started = auditCashExchange(
      started,
      legacyCashExchange
        ? "cash_exchange.withdrawal_execute_requested"
        : "cash_exchange.change_execute_requested",
      context,
      {
        selectedPieces: validation.pieces,
        snapshot: {
          pieces: validation.pieces,
          selectedTotalCents: validation.selectedTotalCents,
          gatewayInventory: current.gatewayInventory,
        },
      },
      nowMs,
    );
    const persisted = await persistCashExchange(db, current, started, nowMs);
    let gatewayResponse = null;
    if (automaticCashGateway?.configured === true) {
      try {
        gatewayResponse = legacyCashExchange
          ? await automaticCashGateway.executeWithdrawal({
              pieces: validation.pieces,
              note: `Cambio denaro ${exchange.exchangeId}`,
            })
          : await automaticCashGateway.executeNativeChange({
              pieces: validation.pieces,
              operationId: exchange.operationId,
              note: `Cambio denaro ${exchange.exchangeId}`,
            });
      } catch (error) {
        const failureNowMs = nowMsFromIso(nowIso);
        const failedTransition = assertCashExchangeTransition(
          persisted.exchange,
          "FAILED",
          {
            error: error?.message ?? String(error),
          },
          failureNowMs,
        );
        const failed = auditCashExchange(
          failedTransition,
          "cash_exchange.failed",
          context,
          {
            error: error?.message ?? String(error),
            selectedPieces: validation.pieces,
            snapshot: {
              phase: "native_change_execute",
              legacyCashExchange,
              pieces: validation.pieces,
              error: normalizedCashExchangeError(error),
            },
          },
          failureNowMs,
        );
        await persistCashExchange(db, persisted.settings, failed, failureNowMs);
        throw new HttpError(503, "Erogazione cambio non riuscita.", {
          code: "CASH_GATEWAY_UNREACHABLE",
          details: { message: error?.message ?? String(error) },
        });
      }
    }
    const waitingTransition = assertCashExchangeTransition(
      persisted.exchange,
      legacyCashExchange ? "WAITING_CASH_REMOVAL" : "WAITING_CHANGE_REMOVAL",
      {},
      nowMs,
    );
    const waiting = auditCashExchange(
      waitingTransition,
      legacyCashExchange
        ? "cash_exchange.withdrawal_started"
        : "cash_exchange.change_waiting_removal",
      context,
      {
        selectedPieces: validation.pieces,
        snapshot: {
          gatewayResponse,
          gatewayConfigured: automaticCashGateway?.configured === true,
          legacyCashExchange,
        },
      },
      nowMs,
    );
    const saved = await persistCashExchange(
      db,
      persisted.settings,
      waiting,
      nowMs,
    );
    sendJson(res, 200, buildCashExchangeStatePayload(saved.exchange));
  }

  async function handleConfirmCashExchangeRemoved(req, res) {
    return runCashFloatCriticalSection(() =>
      handleConfirmCashExchangeRemovedInner(req, res),
    );
  }

  async function handleConfirmCashExchangeRemovedInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const exchange = findCashExchange(current, { ...req.params, ...payload });
    if (!exchange) {
      throw new HttpError(404, "Cambio denaro non trovato.", {
        code: "AUTOMATIC_CASH_OPERATION_NOT_FOUND",
      });
    }
    assertCashExchangeAccess(exchange, context);
    let currentSettings = current;
    let removableExchange = exchange;
    if (exchange.status === "CHANGE_REQUESTED") {
      const recoveryNowMs = nowMsFromIso(nowIso);
      const waitingTransition = assertCashExchangeTransition(
        exchange,
        "WAITING_CHANGE_REMOVAL",
        {},
        recoveryNowMs,
      );
      const recoveredWaiting = auditCashExchange(
        waitingTransition,
        "cash_exchange.change_waiting_removal",
        context,
        {
          selectedPieces: exchange.selectedPieces,
          snapshot: {
            gatewayConfigured: automaticCashGateway?.configured === true,
            recoveredFrom: "CHANGE_REQUESTED",
          },
        },
        recoveryNowMs,
      );
      const saved = await persistCashExchange(
        db,
        current,
        recoveredWaiting,
        recoveryNowMs,
      );
      currentSettings = saved.settings;
      removableExchange = saved.exchange;
    } else if (exchange.status === "WITHDRAWAL_STARTED") {
      const recoveryNowMs = nowMsFromIso(nowIso);
      const waitingTransition = assertCashExchangeTransition(
        exchange,
        "WAITING_CASH_REMOVAL",
        {},
        recoveryNowMs,
      );
      const recoveredWaiting = auditCashExchange(
        waitingTransition,
        "cash_exchange.withdrawal_started",
        context,
        {
          selectedPieces: exchange.selectedPieces,
          snapshot: {
            gatewayConfigured: automaticCashGateway?.configured === true,
            recoveredFrom: "WITHDRAWAL_STARTED",
          },
        },
        recoveryNowMs,
      );
      const saved = await persistCashExchange(
        db,
        current,
        recoveredWaiting,
        recoveryNowMs,
      );
      currentSettings = saved.settings;
      removableExchange = saved.exchange;
    }
    if (!["WAITING_CHANGE_REMOVAL", "WAITING_CASH_REMOVAL"].includes(removableExchange.status)) {
      throw new HttpError(
        409,
        "Il ritiro cambio non e' confermabile in questo stato.",
        {
          code: "CASH_EXCHANGE_STEP_CONFLICT",
        },
      );
    }
    let removedResponse = null;
    if (automaticCashGateway?.configured === true) {
      const removedOperation =
        removableExchange.status === "WAITING_CASH_REMOVAL"
          ? automaticCashGateway.confirmWithdrawalRemoved()
          : automaticCashGateway.getChangeRemoved({
              operationId: removableExchange.operationId,
            });
      removedResponse = await removedOperation.catch((error) => {
          throw new HttpError(503, "Conferma ritiro cambio non riuscita.", {
            code: "CASH_GATEWAY_UNREACHABLE",
            details: { message: error?.message ?? String(error) },
          });
        });
    }
    const nowMs = nowMsFromIso(nowIso);
    let completed = assertCashExchangeTransition(
      removableExchange,
      "COMPLETED",
      {},
      nowMs,
    );
    completed = auditCashExchange(
      completed,
      removableExchange.status === "WAITING_CASH_REMOVAL"
        ? "cash_exchange.cash_removed_confirmed"
        : "cash_exchange.change_removed_confirmed",
      context,
      {
        snapshot: {
          gatewayResponse: removedResponse,
          gatewayConfigured: automaticCashGateway?.configured === true,
        },
      },
      nowMs,
    );
    completed = auditCashExchange(
      completed,
      "cash_exchange.completed",
      context,
      {},
      nowMs,
    );
    await persistCashExchange(db, currentSettings, completed, nowMs);
    sendJson(res, 200, {
      ok: true,
      exchangeId: completed.exchangeId,
      status: completed.status,
    });
  }

  async function handleStartDeposit(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const cashFloat = findActiveCashFloat(current, payload, context);
    if (!cashFloat) {
      throw new HttpError(
        400,
        "Nessun fondo cassa automatico attivo per lo scarico.",
        {
          code: "AUTOMATIC_CASH_NOT_CONFIGURED",
        },
      );
    }
    const existingDeposit = current.deposits.find(
      (deposit) =>
        deposit.cashFloatId === cashFloat.cashFloatId &&
        deposit.status === "ACTIVE",
    );
    if (existingDeposit) {
      sendJson(res, 200, {
        operationId: existingDeposit.operationId,
        startedAtMs: existingDeposit.startedAtMs,
      });
      return;
    }
    const nowMs = nowMsFromIso(nowIso);
    const deposit = {
      operationId: compactId("dep"),
      cashFloatId: cashFloat.cashFloatId,
      ownerUserId: context.user?.id ?? cashFloat.ownerUserId,
      ownerDeviceUuid: context.session?.deviceUuid ?? cashFloat.ownerDeviceUuid,
      status: "ACTIVE",
      startedAtMs: nowMs,
      depositedTotalCents: 0,
    };
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date(nowMs).toISOString();
    await persistAutomaticCash(
      db,
      {
        ...current,
        deposits: [...current.deposits, deposit],
      },
      updatedAt,
    );
    if (automaticCashGateway?.configured === true) {
      try {
        await automaticCashGateway.startReplenishment();
      } catch (error) {
        await persistAutomaticCash(
          db,
          {
            ...current,
            deposits: replaceById(
              [...current.deposits, deposit],
              "operationId",
              {
                ...deposit,
                status: "CANCELLED",
              },
            ),
          },
          typeof nowIso === "function" ? nowIso() : new Date().toISOString(),
        );
        throw new HttpError(503, "Avvio scarico automatico non riuscito.", {
          code: "FCA_GATEWAY_UNREACHABLE",
          details: { message: error?.message ?? String(error) },
        });
      }
    }
    sendJson(res, 200, {
      operationId: deposit.operationId,
      startedAtMs: deposit.startedAtMs,
    });
  }

  async function handleCloseDeposit(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const operationId = normalizeText(payload.operationId, 120);
    const deposit =
      current.deposits.find((entry) => entry.operationId === operationId) ??
      null;
    if (!deposit) {
      throw new HttpError(404, "Operazione scarico automatico non trovata.", {
        code: "AUTOMATIC_CASH_OPERATION_NOT_FOUND",
      });
    }
    const cashFloat =
      current.cashFloats.find(
        (entry) => entry.cashFloatId === deposit.cashFloatId,
      ) ?? null;
    const nowMs = nowMsFromIso(nowIso);
    const gatewayPreCloseState =
      automaticCashGateway?.configured === true
        ? await automaticCashGateway.getState().catch(() => null)
        : null;
    const gatewayClose =
      automaticCashGateway?.configured === true
        ? await automaticCashGateway.closeReplenishment().catch((error) => {
            throw new HttpError(
              503,
              "Chiusura scarico automatico non riuscita.",
              {
                code: "FCA_GATEWAY_UNREACHABLE",
                details: { message: error?.message ?? String(error) },
              },
            );
          })
        : null;
    const depositedTotalCents =
      automaticCashGateway?.configured === true
        ? readDepositedTotalCents(
            gatewayClose?.payload,
            [gatewayPreCloseState, gatewayClose?.state],
            cashFloat?.totalCents,
            { minCachedAtMs: deposit.startedAtMs },
          )
        : Number.isFinite(Number(payload.depositedTotalCents))
          ? Math.max(0, Math.round(Number(payload.depositedTotalCents)))
          : Math.max(0, Number(cashFloat?.totalCents) || 0);
    const nextDeposit = {
      ...deposit,
      status: "CLOSED",
      closedAtMs: nowMs,
      depositedTotalCents,
    };
    const nextCashFloat = cashFloat
      ? {
          ...cashFloat,
          status: "ARCHIVED",
          archivedAtMs: nowMs,
        }
      : null;
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date(nowMs).toISOString();
    await persistAutomaticCash(
      db,
      {
        ...current,
        deposits: replaceById(current.deposits, "operationId", nextDeposit),
        cashFloats: nextCashFloat
          ? replaceById(current.cashFloats, "cashFloatId", nextCashFloat)
          : current.cashFloats,
      },
      updatedAt,
    );
    sendJson(res, 200, {
      operationId,
      depositedTotalCents,
      closedAtMs: nowMs,
    });
  }

  async function handleCancelDeposit(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    requestContext(req, db, payload);
    const current = sanitizeAutomaticCashSettings(
      sanitizeDbSettings(db).automaticCash,
    );
    const operationId = normalizeText(payload.operationId, 120);
    const deposit =
      current.deposits.find((entry) => entry.operationId === operationId) ??
      null;
    if (!deposit) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (automaticCashGateway?.configured === true) {
      try {
        await automaticCashGateway.cancelReplenishment();
      } catch (error) {
        throw new HttpError(
          503,
          "Annullamento scarico automatico non riuscito.",
          {
            code: "FCA_GATEWAY_UNREACHABLE",
            details: { message: error?.message ?? String(error) },
          },
        );
      }
    }
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    await persistAutomaticCash(
      db,
      {
        ...current,
        deposits: replaceById(current.deposits, "operationId", {
          ...deposit,
          status: "CANCELLED",
        }),
      },
      updatedAt,
    );
    sendJson(res, 200, { ok: true });
  }

  const cashMovementHandlers = createCashMovementHandlers({
    automaticCashGateway,
    enqueuePrintSpoolJob,
    HttpError,
    canManageAutomaticCash: (user) =>
      canManageAutomaticCash(user, permissionHelpers),
    hasPermission,
    nowIso,
    persistAutomaticCash,
    readDb,
    readDepositedTotalCents,
    readJsonBody,
    refreshGatewayInventory,
    requestContext,
    sanitizeDbSettings,
    sendJson,
    withRuntimeGateway,
  });

  return {
    "automaticCash.settings": handleSettings,
    "automaticCash.saveSettings": handleSaveSettings,
    "automaticCash.uploadConfigSet": handleUploadConfigSet,
    "automaticCash.uploadDefaultConfigSet": handleUploadDefaultConfigSet,
    "automaticCash.uploadReserveConfig": handleUploadReserveConfig,
    "automaticCash.status": handleStatus,
    "automaticCash.gatewayState": handleGatewayState,
    "automaticCash.gatewayRestart": handleGatewayRestart,
    "automaticCash.gatewayReset": handleGatewayReset,
    "automaticCash.cashFloatPreflight": handleCashFloatPreflight,
    "automaticCash.activeCashFloatWorkflow": handleActiveCashFloatWorkflow,
    "automaticCash.generateCashFloat": handleGenerateCashFloat,
    "automaticCash.confirmCashFloatRemoved": handleConfirmCashFloatRemoved,
    "automaticCash.cashFloatTicketPrinted": handleCashFloatTicketPrinted,
    "automaticCash.confirmCashFloatTicketInPouch":
      handleConfirmCashFloatTicketInPouch,
    "automaticCash.loadCashFloatFromQr": handleLoadCashFloatFromQr,
    "automaticCash.saveSettlementRecord": handleSaveSettlementRecord,
    "automaticCash.listSettlementRecords": handleListSettlementRecords,
    "automaticCash.latestSettlementRecord": handleLatestSettlementRecord,
    "automaticCash.startDeposit": handleStartDeposit,
    "automaticCash.closeDeposit": handleCloseDeposit,
    "automaticCash.cancelDeposit": handleCancelDeposit,
    "automaticCash.activeCashExchange": handleActiveCashExchange,
    "automaticCash.startCashPayment": handleStartCashPayment,
    "automaticCash.cashPaymentState": handleCashPaymentState,
    "automaticCash.completeCashPayment": handleCompleteCashPayment,
    "automaticCash.cancelCashPayment": handleCancelCashPayment,
    "automaticCash.startCashExchange": handleStartCashExchange,
    "automaticCash.cashExchangeState": handleCashExchangeState,
    "automaticCash.cancelCashExchange": handleCancelCashExchange,
    "automaticCash.confirmCashExchangeDeposit":
      handleConfirmCashExchangeDeposit,
    "automaticCash.executeCashExchange": handleExecuteCashExchange,
    "automaticCash.confirmCashExchangeRemoved":
      handleConfirmCashExchangeRemoved,
    ...cashMovementHandlers,
  };
}
