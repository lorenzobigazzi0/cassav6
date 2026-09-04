import { sanitizeCashMovements } from "./cash-movement.domain.js";

const AUTOMATIC_CASH_MODES = new Set(["fixed", "random_file"]);
const DEFAULT_WARNING_THRESHOLD_CENTS = 1000;
const DEFAULT_DANGER_THRESHOLD_CENTS = 1000;
const LOW_COMBINATION_WARNING_THRESHOLD = 20;
const DEFAULT_OPERATION_LOCK_TTL_MS = 5 * 60 * 1000;
const MAX_SETTLEMENT_RECORDS = 240;
const MAX_CASH_PAYMENT_RECORDS = 240;
const MAX_CASH_EXCHANGE_AUDIT_EVENTS = 120;
const MAX_CASH_EXCHANGE_AUDIT_SNAPSHOT_BYTES = 30_000;
const ALLOWED_DENOMINATION_CENTS = new Set([
  2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1,
]);
export const CASH_EXCHANGE_DENOMINATION_CENTS = [
  2000, 1000, 500, 200, 100, 50, 20, 10, 5,
];
const CASH_EXCHANGE_DENOMINATION_SET = new Set(
  CASH_EXCHANGE_DENOMINATION_CENTS,
);
const ACTIVE_WORKFLOW_STEPS = new Set([
  "RESERVING",
  "WITHDRAWAL_REQUESTED",
  "DISPENSING",
  "WAITING_CASH_REMOVAL",
  "CASH_REMOVED_CONFIRMED",
  "TICKET_READY",
  "PRINTING_TICKET",
  "WAITING_TICKET_IN_POUCH",
]);
const TERMINAL_WORKFLOW_STEPS = new Set([
  "COMPLETED",
  "FAILED_BEFORE_DISPENSE",
  "INCIDENT_REVIEW",
  "CANCELLED",
]);
const WORKFLOW_TRANSITIONS = {
  RESERVING: new Set([
    "WITHDRAWAL_REQUESTED",
    "FAILED_BEFORE_DISPENSE",
    "INCIDENT_REVIEW",
  ]),
  WITHDRAWAL_REQUESTED: new Set([
    "DISPENSING",
    "FAILED_BEFORE_DISPENSE",
    "INCIDENT_REVIEW",
  ]),
  DISPENSING: new Set(["WAITING_CASH_REMOVAL", "INCIDENT_REVIEW"]),
  WAITING_CASH_REMOVAL: new Set([
    "CASH_REMOVED_CONFIRMED",
    "TICKET_READY",
    "INCIDENT_REVIEW",
  ]),
  CASH_REMOVED_CONFIRMED: new Set([
    "TICKET_READY",
    "PRINTING_TICKET",
    "WAITING_TICKET_IN_POUCH",
    "INCIDENT_REVIEW",
  ]),
  TICKET_READY: new Set([
    "PRINTING_TICKET",
    "WAITING_TICKET_IN_POUCH",
    "INCIDENT_REVIEW",
  ]),
  PRINTING_TICKET: new Set([
    "TICKET_READY",
    "WAITING_TICKET_IN_POUCH",
    "INCIDENT_REVIEW",
  ]),
  WAITING_TICKET_IN_POUCH: new Set(["COMPLETED", "INCIDENT_REVIEW"]),
};
const ACTIVE_CASH_EXCHANGE_STATUSES = new Set([
  "CREATED",
  "CHANGE_STARTED",
  "DEPOSIT_STARTED",
  "DEPOSITING",
  "DEPOSIT_CONFIRMED",
  "SELECTING_DENOMINATIONS",
  "CHANGE_REQUESTED",
  "WAITING_CHANGE_REMOVAL",
  "WITHDRAWAL_STARTED",
  "WAITING_CASH_REMOVAL",
]);
const TERMINAL_CASH_EXCHANGE_STATUSES = new Set([
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);
const ACTIVE_CASH_PAYMENT_STATUSES = new Set(["ACTIVE"]);
const TERMINAL_CASH_PAYMENT_STATUSES = new Set([
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);
const CASH_EXCHANGE_TRANSITIONS = {
  CREATED: new Set([
    "CHANGE_STARTED",
    "DEPOSIT_STARTED",
    "DEPOSITING",
    "CANCELLED",
    "FAILED",
  ]),
  CHANGE_STARTED: new Set([
    "DEPOSITING",
    "DEPOSIT_CONFIRMED",
    "CANCELLED",
    "FAILED",
  ]),
  DEPOSIT_STARTED: new Set([
    "DEPOSITING",
    "DEPOSIT_CONFIRMED",
    "CANCELLED",
    "FAILED",
  ]),
  DEPOSITING: new Set(["DEPOSIT_CONFIRMED", "CANCELLED", "FAILED"]),
  DEPOSIT_CONFIRMED: new Set([
    "SELECTING_DENOMINATIONS",
    "CANCELLED",
    "FAILED",
  ]),
  SELECTING_DENOMINATIONS: new Set([
    "CHANGE_REQUESTED",
    "WITHDRAWAL_STARTED",
    "CANCELLED",
    "FAILED",
  ]),
  CHANGE_REQUESTED: new Set(["WAITING_CHANGE_REMOVAL", "FAILED"]),
  WAITING_CHANGE_REMOVAL: new Set(["COMPLETED", "FAILED"]),
  WITHDRAWAL_STARTED: new Set(["WAITING_CASH_REMOVAL", "FAILED"]),
  WAITING_CASH_REMOVAL: new Set(["COMPLETED", "FAILED"]),
};

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function toTimestamp(value, fallback = null) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  const fromDate = new Date(String(value ?? "")).getTime();
  if (Number.isFinite(fromDate) && fromDate > 0) return fromDate;
  return fallback;
}

function normalizeText(value, limit = 200) {
  return String(value ?? "")
    .trim()
    .slice(0, limit);
}

function clampCents(value, fallback) {
  const parsed = toInteger(value);
  if (parsed === null || parsed < 0) return fallback;
  return Math.min(parsed, 999_999_999);
}

function normalizeFeedbackThresholds(input = {}) {
  const warningThresholdCents = clampCents(
    input.warningThresholdCents,
    DEFAULT_WARNING_THRESHOLD_CENTS,
  );
  const dangerThresholdCents = Math.max(
    warningThresholdCents,
    clampCents(input.dangerThresholdCents, DEFAULT_DANGER_THRESHOLD_CENTS),
  );
  return {
    warningThresholdCents,
    dangerThresholdCents,
  };
}

export function resolveAutomaticCashSettlementFeedback(input = {}) {
  const expectedDepositTotalCents = clampCents(
    input.expectedDepositTotalCents,
    0,
  );
  const depositedTotalCents = clampCents(input.depositedTotalCents, 0);
  const thresholds = normalizeFeedbackThresholds(input);
  const differenceCents = Math.abs(
    expectedDepositTotalCents - depositedTotalCents,
  );
  if (differenceCents <= 1) return "happy";
  if (differenceCents <= thresholds.dangerThresholdCents) return "sad";
  return "angry";
}

function normalizeName(config) {
  return String(
    config?.nome || config?.name || "Configurazione fondo cassa",
  ).trim();
}

function buildSummaryId(name) {
  const token = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return `client_${token || "fondo_cassa"}`;
}

function sanitizeSummary(input) {
  if (!isRecord(input)) return null;
  const id = String(input.id ?? "").trim();
  const name = String(input.name ?? input.nome ?? "").trim();
  const currency = String(input.currency ?? input.valuta ?? "")
    .trim()
    .toUpperCase();
  const combinationsCount = toInteger(
    input.combinationsCount ?? input.combinazioni,
  );
  const minTotalCents = toInteger(input.minTotalCents);
  const maxTotalCents = toInteger(input.maxTotalCents);
  if (!id || !name || currency !== "EUR") return null;
  if (
    combinationsCount === null ||
    combinationsCount <= 0 ||
    minTotalCents === null ||
    minTotalCents <= 0 ||
    maxTotalCents === null ||
    maxTotalCents < minTotalCents
  ) {
    return null;
  }
  return {
    id,
    name,
    currency: "EUR",
    combinationsCount,
    minTotalCents,
    maxTotalCents,
    uniquePerUserPerBusinessEvening:
      input.uniquePerUserPerBusinessEvening !== false,
  };
}

function sanitizeConfigSet(input) {
  const summary = sanitizeSummary(input);
  if (!summary) return null;
  return {
    ...summary,
    uploadedAt: String(input.uploadedAt ?? "").trim(),
    uploadedBy: String(input.uploadedBy ?? "").trim(),
    config: isRecord(input.config) ? input.config : null,
  };
}

function publicSummary(configSet) {
  const summary = sanitizeSummary(configSet);
  return summary ? { ...summary } : null;
}

function validateDenominations(value, errors) {
  if (!isRecord(value)) {
    errors.push("denominazioni_centesimi deve essere un oggetto.");
    return null;
  }
  const denominations = {};
  const labelsByCents = new Map();
  for (const [label, rawCents] of Object.entries(value)) {
    const cents = toInteger(rawCents);
    if (cents === null || cents <= 0) {
      errors.push(`Denominazione non valida: ${label}.`);
      continue;
    }
    const existingLabel = labelsByCents.get(cents);
    if (labelsByCents.has(cents)) {
      errors.push(
        `Valore denominazione duplicato: ${label} e ${existingLabel} valgono entrambi ${cents} centesimi.`,
      );
    } else {
      labelsByCents.set(cents, label);
    }
    denominations[label] = cents;
  }
  if (Object.keys(denominations).length === 0) {
    errors.push("denominazioni_centesimi non contiene tagli validi.");
  }
  return denominations;
}

function validateCombination({
  combination,
  index,
  denominations,
  ids,
  totals,
  errors,
}) {
  if (!isRecord(combination)) {
    errors.push(`Combinazione ${index + 1}: oggetto non valido.`);
    return;
  }
  const id = String(combination.id ?? "").trim();
  const label = id || `#${index + 1}`;
  if (!id) {
    errors.push(`Combinazione ${index + 1}: id mancante.`);
  } else if (ids.has(id)) {
    errors.push(`Combinazione duplicata: ${id}.`);
  } else {
    ids.add(id);
  }

  if (!isRecord(combination.tagli)) {
    errors.push(`Combinazione ${label}: tagli mancante o non valido.`);
    return;
  }

  let computedTotalCents = 0;
  let computedPieces = 0;
  for (const [denominationLabel, rawQuantity] of Object.entries(
    combination.tagli,
  )) {
    const cents = denominations[denominationLabel];
    if (!Number.isInteger(cents)) {
      errors.push(
        `Combinazione ${label}: denominazione non riconosciuta ${denominationLabel}.`,
      );
      continue;
    }
    const quantity = toInteger(rawQuantity);
    if (quantity === null || quantity < 0) {
      errors.push(
        `Combinazione ${label}: quantita non valida per ${denominationLabel}.`,
      );
      continue;
    }
    computedTotalCents += cents * quantity;
    computedPieces += quantity;
  }

  const declaredTotal = toInteger(combination.totale_centesimi);
  if (declaredTotal === null || declaredTotal <= 0) {
    errors.push(`Combinazione ${label}: totale_centesimi non valido.`);
  } else {
    totals.push(declaredTotal);
    if (computedTotalCents !== declaredTotal) {
      errors.push(
        `Combinazione ${label}: totale calcolato ${computedTotalCents} diverso da ${declaredTotal}.`,
      );
    }
  }

  const declaredPieces = toInteger(
    combination.pezzi_totali ?? combination.totale_pezzi,
  );
  if (declaredPieces === null || declaredPieces < 0) {
    errors.push(`Combinazione ${label}: pezzi_totali non valido.`);
  } else if (computedPieces !== declaredPieces) {
    errors.push(
      `Combinazione ${label}: pezzi calcolati ${computedPieces} diversi da ${declaredPieces}.`,
    );
  }
}

export function validateAutomaticCashConfigFile(value) {
  const errors = [];
  const warnings = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      config: null,
      summary: null,
      errors: ["Il file deve contenere un oggetto JSON."],
      warnings,
    };
  }

  if (
    String(value.valuta ?? "")
      .trim()
      .toUpperCase() !== "EUR"
  ) {
    errors.push("valuta deve essere EUR.");
  }
  const denominations = validateDenominations(
    value.denominazioni_centesimi,
    errors,
  );
  const combinations = Array.isArray(value.combinazioni)
    ? value.combinazioni
    : [];
  if (combinations.length === 0) {
    errors.push("combinazioni deve essere un array non vuoto.");
  }

  const ids = new Set();
  const totals = [];
  if (denominations) {
    combinations.forEach((combination, index) =>
      validateCombination({
        combination,
        index,
        denominations,
        ids,
        totals,
        errors,
      }),
    );
  }

  if (
    combinations.length > 0 &&
    combinations.length < LOW_COMBINATION_WARNING_THRESHOLD
  ) {
    warnings.push(
      `Il file contiene ${combinations.length} combinazioni: dopo ${combinations.length} fondi cassa nella stessa serata il pool riparte a ciclo.`,
    );
  }

  const minTotalCents = totals.length ? Math.min(...totals) : 0;
  const maxTotalCents = totals.length ? Math.max(...totals) : 0;
  const name = normalizeName(value);
  const summary =
    errors.length === 0
      ? {
          id: buildSummaryId(name),
          name,
          currency: "EUR",
          combinationsCount: combinations.length,
          minTotalCents,
          maxTotalCents,
          uniquePerUserPerBusinessEvening: true,
        }
      : null;

  return {
    ok: errors.length === 0,
    config: errors.length === 0 ? value : null,
    summary,
    errors,
    warnings,
  };
}

export function createAutomaticCashConfigSet({
  config,
  uploadedAt = "",
  uploadedBy = "",
}) {
  const validation = validateAutomaticCashConfigFile(config);
  if (!validation.ok || !validation.summary)
    return { validation, configSet: null };
  return {
    validation,
    configSet: {
      ...validation.summary,
      uploadedAt,
      uploadedBy,
      config,
    },
  };
}

function sanitizeReserveSummary(input) {
  if (!isRecord(input)) return null;
  const id = String(input.id ?? "").trim();
  const name = String(input.name ?? input.nome ?? "").trim();
  const currency = String(input.currency ?? input.valuta ?? "")
    .trim()
    .toUpperCase();
  const denominationsCount = toInteger(input.denominationsCount);
  const minimumPiecesTotal = toInteger(input.minimumPiecesTotal);
  if (!id || !name || currency !== "EUR") return null;
  if (
    denominationsCount === null ||
    denominationsCount <= 0 ||
    minimumPiecesTotal === null ||
    minimumPiecesTotal < 0
  ) {
    return null;
  }
  return {
    id,
    name,
    currency: "EUR",
    enabled: input.enabled !== false,
    missingDenominationPolicy: "reject",
    denominationsCount,
    minimumPiecesTotal,
  };
}

function publicReserveSummary(reserveConfig) {
  const summary = sanitizeReserveSummary(reserveConfig);
  return summary ? { ...summary } : null;
}

function sanitizeReserveConfigSet(input) {
  const summary = sanitizeReserveSummary(input);
  if (!summary) return null;
  return {
    ...summary,
    uploadedAt: String(input.uploadedAt ?? "").trim(),
    uploadedBy: String(input.uploadedBy ?? "").trim(),
    denominazioni_centesimi: isRecord(input.denominazioni_centesimi)
      ? input.denominazioni_centesimi
      : {},
    riserva_minima_pezzi: isRecord(input.riserva_minima_pezzi)
      ? input.riserva_minima_pezzi
      : {},
    config: isRecord(input.config) ? input.config : null,
  };
}

export function validateAutomaticCashReserveConfigFile(value) {
  const errors = [];
  const warnings = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      config: null,
      summary: null,
      errors: ["Il file riserva deve contenere un oggetto JSON."],
      warnings,
    };
  }
  if (toInteger(value.schema_version) !== 1) {
    errors.push("schema_version deve essere 1.");
  }
  const id = normalizeText(value.id, 120);
  if (!id) errors.push("id mancante.");
  const name = normalizeText(value.nome ?? value.name, 160);
  if (!name) errors.push("nome mancante.");
  if (
    String(value.valuta ?? "")
      .trim()
      .toUpperCase() !== "EUR"
  ) {
    errors.push("valuta deve essere EUR.");
  }
  if (value.enabled !== true) {
    errors.push("La configurazione riserva deve essere abilitata.");
  }
  if (String(value.missing_denomination_policy ?? "").trim() !== "reject") {
    errors.push("missing_denomination_policy deve essere reject.");
  }

  const denominations = isRecord(value.denominazioni_centesimi)
    ? value.denominazioni_centesimi
    : {};
  const reserves = isRecord(value.riserva_minima_pezzi)
    ? value.riserva_minima_pezzi
    : {};
  if (Object.keys(denominations).length === 0) {
    errors.push("denominazioni_centesimi non contiene tagli.");
  }
  if (Object.keys(reserves).length === 0) {
    errors.push("riserva_minima_pezzi non contiene tagli.");
  }
  let minimumPiecesTotal = 0;
  for (const [label, rawCents] of Object.entries(denominations)) {
    const cents = toInteger(rawCents);
    if (!ALLOWED_DENOMINATION_CENTS.has(cents)) {
      errors.push(`Taglio non supportato: ${label}/${rawCents}.`);
    }
    const reserve = toInteger(reserves[label]);
    if (reserve === null || reserve < 0) {
      errors.push(`Riserva non valida per ${label}.`);
    } else {
      minimumPiecesTotal += reserve;
    }
  }
  for (const label of Object.keys(reserves)) {
    if (!Object.prototype.hasOwnProperty.call(denominations, label)) {
      errors.push(`Riserva senza denominazione: ${label}.`);
    }
  }

  const summary =
    errors.length === 0
      ? {
          id,
          name,
          currency: "EUR",
          enabled: true,
          missingDenominationPolicy: "reject",
          denominationsCount: Object.keys(denominations).length,
          minimumPiecesTotal,
        }
      : null;
  return {
    ok: errors.length === 0,
    config: errors.length === 0 ? value : null,
    summary,
    errors,
    warnings,
  };
}

export function createAutomaticCashReserveConfigSet({
  config,
  uploadedAt = "",
  uploadedBy = "",
}) {
  const validation = validateAutomaticCashReserveConfigFile(config);
  if (!validation.ok || !validation.summary)
    return { validation, reserveConfig: null };
  return {
    validation,
    reserveConfig: {
      ...validation.summary,
      uploadedAt,
      uploadedBy,
      denominazioni_centesimi: config.denominazioni_centesimi,
      riserva_minima_pezzi: config.riserva_minima_pezzi,
      config,
    },
  };
}

function sanitizeGatewayInventory(input) {
  const raw = isRecord(input) ? input : {};
  const inventory = isRecord(raw.inventory) ? raw.inventory : raw;
  const listCassette = Array.isArray(inventory.listCassette)
    ? inventory.listCassette
    : Array.isArray(inventory.cassettes)
      ? inventory.cassettes
      : [];
  return {
    ok: raw.ok !== false,
    mode: normalizeText(raw.mode, 40).toUpperCase() || null,
    inventory: {
      ok: inventory.ok !== false,
      error: normalizeText(inventory.error, 240) || null,
      listCassette: listCassette
        .map((entry) => {
          const value = toInteger(
            entry?.Value_Money ??
              entry?.valueMoney ??
              entry?.value ??
              entry?.denominationCents,
          );
          const stock = toInteger(
            entry?.Stock ?? entry?.stock ?? entry?.pieces,
          );
          if (value === null || stock === null || value <= 0 || stock < 0)
            return null;
          return {
            Value_Money: value,
            Stock: stock,
            IsExist: entry?.IsExist !== false,
            IsEmpty: entry?.IsEmpty === true || stock === 0,
          };
        })
        .filter((entry) => entry !== null),
    },
    activeOperation: isRecord(raw.activeOperation) ? raw.activeOperation : null,
    updatedAtMs: toTimestamp(raw.updatedAtMs ?? raw.fetchedAtMs, null),
  };
}

function sanitizeWorkflow(input) {
  if (!isRecord(input)) return null;
  const workflowId = normalizeText(input.workflowId, 120);
  const cashFloatId = normalizeText(input.cashFloatId, 120);
  const step = normalizeText(input.step, 80).toUpperCase();
  if (
    !workflowId ||
    !cashFloatId ||
    (!ACTIVE_WORKFLOW_STEPS.has(step) && !TERMINAL_WORKFLOW_STEPS.has(step))
  ) {
    return null;
  }
  return {
    workflowId,
    operationId: normalizeText(input.operationId, 120),
    cashFloatId,
    assignmentId: normalizeText(input.assignmentId, 120),
    ownerUserId: normalizeText(input.ownerUserId, 120),
    ownerFullName: normalizeText(input.ownerFullName, 160),
    ownerDeviceUuid: normalizeText(input.ownerDeviceUuid, 160),
    ownerSessionId: normalizeText(input.ownerSessionId, 160),
    activityId: normalizeText(input.activityId, 120),
    roomId: normalizeText(input.roomId, 120),
    reason: normalizeText(input.reason, 120),
    step,
    startedAtMs: toTimestamp(input.startedAtMs, Date.now()),
    updatedAtMs: toTimestamp(input.updatedAtMs, Date.now()),
    completedAtMs: toTimestamp(input.completedAtMs, null),
    businessEveningKey: normalizeText(input.businessEveningKey, 40),
    combinationId: normalizeText(input.combinationId, 120),
    configSetId: normalizeText(input.configSetId, 120),
    reserveConfigId: normalizeText(input.reserveConfigId, 120),
    pieces: isRecord(input.pieces) ? { ...input.pieces } : {},
    gatewayPieces: isRecord(input.gatewayPieces)
      ? { ...input.gatewayPieces }
      : {},
    totalCents: clampCents(input.totalCents, 0),
    qrPayload: normalizeText(input.qrPayload, 12000),
    operationLock: sanitizeOperationLock(input.operationLock),
    ticket: isRecord(input.ticket) ? input.ticket : null,
    error: normalizeText(input.error, 240) || null,
  };
}

function sanitizeOperationLock(input) {
  if (!isRecord(input)) return null;
  const ownerUserId = normalizeText(input.ownerUserId, 120);
  const ownerDeviceUuid = normalizeText(input.ownerDeviceUuid, 160);
  const ownerSessionId = normalizeText(input.ownerSessionId, 160);
  const expiresAtMs = toTimestamp(input.expiresAtMs, null);
  if (!ownerUserId || !expiresAtMs) return null;
  return {
    ownerUserId,
    ownerFullName: normalizeText(input.ownerFullName, 160),
    ownerDeviceUuid,
    ownerSessionId,
    ownerCanManageAutomaticCash: input.ownerCanManageAutomaticCash === true,
    reason: normalizeText(input.reason, 120) || "cash_float_workflow",
    acquiredAtMs: toTimestamp(input.acquiredAtMs, Date.now()),
    expiresAtMs,
  };
}

function isOperationLockActive(lock, nowMs = Date.now()) {
  const safe = sanitizeOperationLock(lock);
  return Boolean(safe && safe.expiresAtMs > nowMs);
}

function isOperationLockOwnedByContext(lock, context = {}) {
  const safe = sanitizeOperationLock(lock);
  if (!safe) return false;
  const currentSessionId = normalizeText(
    context.session?.id ?? context.sessionId,
    160,
  );
  const currentDeviceUuid = normalizeText(
    context.session?.deviceUuid ??
      context.deviceUuid ??
      context.payload?.deviceUuid,
    160,
  );
  const currentUserId = normalizeText(context.userId ?? context.user?.id, 120);
  return Boolean(
    (safe.ownerSessionId &&
      currentSessionId &&
      safe.ownerSessionId === currentSessionId) ||
      (safe.ownerDeviceUuid &&
        currentDeviceUuid &&
        safe.ownerDeviceUuid === currentDeviceUuid) ||
      (safe.ownerUserId && currentUserId && safe.ownerUserId === currentUserId),
  );
}

function publicOperationLock(lock) {
  const safe = sanitizeOperationLock(lock);
  if (!safe) return null;
  return {
    ownerUserId: safe.ownerUserId,
    ownerFullName: safe.ownerFullName,
    ownerDeviceUuid: safe.ownerDeviceUuid,
    ownerCanManageAutomaticCash: safe.ownerCanManageAutomaticCash,
    reason: safe.reason,
    acquiredAtMs: safe.acquiredAtMs,
    expiresAtMs: safe.expiresAtMs,
  };
}

function sanitizeAssignment(input) {
  if (!isRecord(input)) return null;
  const assignmentId = normalizeText(input.assignmentId ?? input.id, 120);
  const cashFloatId = normalizeText(input.cashFloatId, 120);
  const combinationId = normalizeText(input.combinationId, 120);
  const businessEveningKey = normalizeText(input.businessEveningKey, 40);
  if (!assignmentId || !cashFloatId || !combinationId || !businessEveningKey)
    return null;
  return {
    assignmentId,
    cashFloatId,
    workflowId: normalizeText(input.workflowId, 120),
    ownerUserId: normalizeText(input.ownerUserId, 120),
    ownerDeviceUuid: normalizeText(input.ownerDeviceUuid, 160),
    businessEveningKey,
    combinationId,
    configSetId: normalizeText(input.configSetId, 120),
    reserveConfigId: normalizeText(input.reserveConfigId, 120),
    status: normalizeText(input.status || "assigned", 40) || "assigned",
    createdAtMs: toTimestamp(input.createdAtMs, Date.now()),
  };
}

function sanitizeCashFloat(input) {
  if (!isRecord(input)) return null;
  const cashFloatId = normalizeText(input.cashFloatId, 120);
  if (!cashFloatId) return null;
  const status = normalizeText(input.status || "ACTIVE", 40).toUpperCase();
  return {
    cashFloatId,
    workflowId: normalizeText(input.workflowId, 120),
    assignmentId: normalizeText(input.assignmentId, 120),
    combinationId: normalizeText(input.combinationId, 120),
    businessEveningKey: normalizeText(input.businessEveningKey, 40),
    ownerUserId: normalizeText(input.ownerUserId, 120),
    ownerDeviceUuid: normalizeText(input.ownerDeviceUuid, 160),
    totalCents: clampCents(input.totalCents, 0),
    qrPayload: normalizeText(input.qrPayload, 12000),
    mode: "auto",
    status:
      status === "ARCHIVED" || status === "CLOSED" ? "ARCHIVED" : "ACTIVE",
    loadedAtMs: toTimestamp(input.loadedAtMs, Date.now()),
    archivedAtMs: toTimestamp(input.archivedAtMs, null),
  };
}

function sanitizeDeposit(input) {
  if (!isRecord(input)) return null;
  const operationId = normalizeText(input.operationId, 120);
  const cashFloatId = normalizeText(input.cashFloatId, 120);
  if (!operationId || !cashFloatId) return null;
  const status = normalizeText(input.status || "ACTIVE", 40).toUpperCase();
  return {
    operationId,
    cashFloatId,
    ownerUserId: normalizeText(input.ownerUserId, 120),
    ownerDeviceUuid: normalizeText(input.ownerDeviceUuid, 160),
    status: status === "CLOSED" || status === "CANCELLED" ? status : "ACTIVE",
    startedAtMs: toTimestamp(input.startedAtMs, Date.now()),
    closedAtMs: toTimestamp(input.closedAtMs, null),
    depositedTotalCents: clampCents(input.depositedTotalCents, 0),
  };
}

function sanitizeCashPayment(input) {
  if (!isRecord(input)) return null;
  const operationId = normalizeText(input.operationId ?? input.id, 120);
  if (!operationId) return null;
  const rawStatus = normalizeText(input.status || "ACTIVE", 40).toUpperCase();
  const status =
    ACTIVE_CASH_PAYMENT_STATUSES.has(rawStatus) ||
    TERMINAL_CASH_PAYMENT_STATUSES.has(rawStatus)
      ? rawStatus
      : "ACTIVE";
  const expectedTotalCents = clampCents(
    input.expectedTotalCents ?? input.totalDueCents ?? input.amountDueCents,
    0,
  );
  const depositedTotalCents = clampCents(
    input.depositedTotalCents ?? input.totalInsertedCents,
    0,
  );
  const changeDueCents = clampCents(
    input.changeDueCents,
    Math.max(0, depositedTotalCents - expectedTotalCents),
  );
  return {
    operationId,
    ownerUserId: normalizeText(input.ownerUserId, 120),
    ownerFullName: normalizeText(input.ownerFullName, 160),
    ownerDeviceUuid: normalizeText(input.ownerDeviceUuid, 160),
    ownerSessionId: normalizeText(input.ownerSessionId, 160),
    activityId: normalizeText(input.activityId, 120),
    roomId: normalizeText(input.roomId, 120),
    note: normalizeText(input.note, 240),
    status,
    expectedTotalCents,
    depositedTotalCents,
    changeDueCents,
    startedAtMs: toTimestamp(input.startedAtMs, Date.now()),
    updatedAtMs: toTimestamp(input.updatedAtMs, Date.now()),
    completedAtMs: toTimestamp(input.completedAtMs, null),
    error: normalizeText(input.error, 240) || null,
  };
}

export function sanitizeCashExchangePieces(input) {
  if (!isRecord(input)) return {};
  const pieces = {};
  for (const [rawCents, rawQuantity] of Object.entries(input)) {
    const cents = toInteger(rawCents);
    const quantity = toInteger(rawQuantity);
    if (
      !CASH_EXCHANGE_DENOMINATION_SET.has(cents) ||
      quantity === null ||
      quantity <= 0
    )
      continue;
    pieces[String(cents)] = (pieces[String(cents)] ?? 0) + quantity;
  }
  return pieces;
}

export function sumCashExchangePieces(input) {
  return Object.entries(sanitizeCashExchangePieces(input)).reduce(
    (sum, [cents, quantity]) => sum + Number(cents) * quantity,
    0,
  );
}

function sanitizeCashExchangeAllowedDenominations(input) {
  if (!Array.isArray(input)) return CASH_EXCHANGE_DENOMINATION_CENTS;
  const allowed = [];
  for (const value of input) {
    const cents = toInteger(value);
    if (CASH_EXCHANGE_DENOMINATION_SET.has(cents) && !allowed.includes(cents)) {
      allowed.push(cents);
    }
  }
  return allowed.length ? allowed : CASH_EXCHANGE_DENOMINATION_CENTS;
}

function formatDenominationLabel(cents) {
  const major = Math.trunc(cents / 100);
  const minor = String(Math.abs(cents % 100)).padStart(2, "0");
  return `${major},${minor} EUR`;
}

function sanitizeCashExchangeAvailableDenominations(input) {
  if (!Array.isArray(input)) return [];
  const byCents = new Map();
  for (const raw of input) {
    const entry = isRecord(raw) ? raw : {};
    const cents = toInteger(
      entry.cents ??
        entry.Value_Money ??
        entry.ValueMoney ??
        entry.Value ??
        entry.value ??
        entry.denominationCents,
    );
    const availablePieces = toInteger(
      entry.availablePieces ??
        entry.Stock ??
        entry.stock ??
        entry.pieces ??
        entry.quantity ??
        entry.Quantity ??
        entry.count ??
        entry.Count,
    );
    if (
      !CASH_EXCHANGE_DENOMINATION_SET.has(cents) ||
      availablePieces === null ||
      availablePieces < 0
    ) {
      continue;
    }
    const reservedPieces = Math.max(0, toInteger(entry.reservedPieces) ?? 0);
    byCents.set(cents, {
      cents,
      label: normalizeText(entry.label, 80) || formatDenominationLabel(cents),
      availablePieces: Math.max(0, availablePieces),
      reservedPieces,
    });
  }
  return [...byCents.values()].sort((left, right) => right.cents - left.cents);
}

function sanitizeCashExchangeAuditSnapshot(input) {
  if (input === undefined || input === null) return null;
  try {
    const encoded = JSON.stringify(input);
    if (!encoded) return null;
    if (encoded.length > MAX_CASH_EXCHANGE_AUDIT_SNAPSHOT_BYTES) {
      return {
        truncated: true,
        bytes: encoded.length,
      };
    }
    return JSON.parse(encoded);
  } catch {
    return {
      truncated: true,
      reason: "snapshot_not_serializable",
    };
  }
}

function sanitizeCashExchangeAuditEvent(input) {
  if (!isRecord(input)) return null;
  const action = normalizeText(input.action, 120);
  if (!action) return null;
  const selectedPieces = sanitizeCashExchangePieces(input.selectedPieces);
  return {
    action,
    atMs: toTimestamp(input.atMs, Date.now()),
    status: normalizeText(input.status, 80).toUpperCase(),
    actorUserId: normalizeText(input.actorUserId, 120),
    actorFullName: normalizeText(input.actorFullName, 160),
    actorRole: normalizeText(input.actorRole, 80),
    deviceUuid: normalizeText(input.deviceUuid, 160),
    sessionId: normalizeText(input.sessionId, 160),
    activityId: normalizeText(input.activityId, 120),
    roomId: normalizeText(input.roomId, 120),
    depositedCents: clampCents(input.depositedCents, 0),
    selectedPieces,
    selectedTotalCents: sumCashExchangePieces(selectedPieces),
    error: normalizeText(input.error, 240) || null,
    snapshot: sanitizeCashExchangeAuditSnapshot(input.snapshot),
  };
}

function sanitizeCashExchangeAuditEvents(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map(sanitizeCashExchangeAuditEvent)
    .filter((entry) => entry !== null)
    .slice(-MAX_CASH_EXCHANGE_AUDIT_EVENTS);
}

function sanitizeCashExchange(input) {
  if (!isRecord(input)) return null;
  const exchangeId = normalizeText(input.exchangeId ?? input.id, 120);
  if (!exchangeId) return null;
  const status = normalizeText(input.status || "CREATED", 80).toUpperCase();
  if (
    !ACTIVE_CASH_EXCHANGE_STATUSES.has(status) &&
    !TERMINAL_CASH_EXCHANGE_STATUSES.has(status)
  ) {
    return null;
  }
  const selectedPieces = sanitizeCashExchangePieces(
    input.selectedPieces ?? input.pieces,
  );
  const selectedTotalCents = sumCashExchangePieces(selectedPieces);
  return {
    exchangeId,
    operationId: normalizeText(input.operationId, 120),
    ownerUserId: normalizeText(input.ownerUserId, 120),
    ownerFullName: normalizeText(input.ownerFullName, 160),
    ownerDeviceUuid: normalizeText(input.ownerDeviceUuid, 160),
    ownerSessionId: normalizeText(input.ownerSessionId, 160),
    activityId: normalizeText(input.activityId, 120),
    roomId: normalizeText(input.roomId, 120),
    status,
    depositedCents: clampCents(
      input.depositedCents ?? input.depositedTotalCents,
      0,
    ),
    selectedPieces,
    selectedTotalCents,
    allowedDenominationsCents: sanitizeCashExchangeAllowedDenominations(
      input.allowedDenominationsCents,
    ),
    availableDenominations: sanitizeCashExchangeAvailableDenominations(
      input.availableDenominations,
    ),
    operationLock: sanitizeOperationLock(input.operationLock),
    startedAtMs: toTimestamp(input.startedAtMs, Date.now()),
    updatedAtMs: toTimestamp(input.updatedAtMs, Date.now()),
    completedAtMs: toTimestamp(input.completedAtMs, null),
    error: normalizeText(input.error, 240) || null,
    auditEvents: sanitizeCashExchangeAuditEvents(input.auditEvents),
  };
}

function sanitizeSettlementFeedbackKind(
  value,
  expectedDepositTotalCents,
  depositedTotalCents,
  thresholds = {},
) {
  const normalized = normalizeText(value, 20).toLowerCase();
  if (
    normalized === "happy" ||
    normalized === "sad" ||
    normalized === "angry"
  ) {
    return normalized;
  }
  return resolveAutomaticCashSettlementFeedback({
    expectedDepositTotalCents,
    depositedTotalCents,
    ...thresholds,
  });
}

function sanitizeSettlementDetails(input) {
  if (!isRecord(input)) return {};
  try {
    const encoded = JSON.stringify(input);
    if (encoded.length > 60_000) {
      return {
        truncated: true,
        reason: "details_too_large",
      };
    }
    return JSON.parse(encoded);
  } catch {
    return {};
  }
}

export function sanitizeAutomaticCashSettlementRecord(input) {
  if (!isRecord(input)) return null;
  const cashFloatId = normalizeText(input.cashFloatId, 120);
  const completedAtMs = toTimestamp(input.completedAtMs, Date.now());
  const id = normalizeText(input.id, 180) || `${cashFloatId}:${completedAtMs}`;
  if (!id || !cashFloatId) return null;
  const expectedDepositTotalCents = clampCents(
    input.expectedDepositTotalCents,
    0,
  );
  const depositedTotalCents = clampCents(input.depositedTotalCents, 0);
  const differenceCents = clampCents(
    input.differenceCents,
    Math.abs(expectedDepositTotalCents - depositedTotalCents),
  );
  return {
    id,
    operationId: normalizeText(input.operationId, 120),
    cashFloatId,
    assignmentId: normalizeText(input.assignmentId, 120) || null,
    combinationId: normalizeText(input.combinationId, 120) || null,
    businessEveningKey: normalizeText(input.businessEveningKey, 120) || null,
    userId: normalizeText(input.userId, 120) || null,
    deviceUuid: normalizeText(input.deviceUuid, 160) || null,
    operatorName: normalizeText(input.operatorName, 160) || null,
    station: normalizeText(input.station, 160) || null,
    roomId: normalizeText(input.roomId, 120) || null,
    roomName: normalizeText(input.roomName, 160) || null,
    expectedDepositTotalCents,
    depositedTotalCents,
    differenceCents,
    mismatchConfirmed: input.mismatchConfirmed === true,
    feedbackKind: sanitizeSettlementFeedbackKind(
      input.feedbackKind,
      expectedDepositTotalCents,
      depositedTotalCents,
    ),
    printText: normalizeText(input.printText, 14_000),
    details: sanitizeSettlementDetails(input.details),
    completedAtMs,
  };
}

function getActiveConfigSet(settings) {
  const id = normalizeText(settings.configSetId, 120);
  return (
    settings.configSets.find((entry) => entry.id === id) ??
    settings.configSets[0] ??
    null
  );
}

function getActiveReserveConfig(settings) {
  const id = normalizeText(settings.reserveConfigId, 120);
  return (
    settings.reserveConfigs.find((entry) => entry.id === id) ??
    settings.reserveConfigs[0] ??
    null
  );
}

function normalizeCombination(configSet, combination) {
  if (
    !configSet?.config ||
    !isRecord(combination) ||
    !isRecord(combination.tagli)
  )
    return null;
  const denominations = isRecord(configSet.config.denominazioni_centesimi)
    ? configSet.config.denominazioni_centesimi
    : {};
  const id = normalizeText(combination.id, 120);
  const totalCents = toInteger(combination.totale_centesimi);
  if (!id || totalCents === null || totalCents <= 0) return null;
  const pieces = {};
  const denominationCentsByLabel = {};
  for (const [label, rawQuantity] of Object.entries(combination.tagli)) {
    const quantity = toInteger(rawQuantity);
    const cents = toInteger(denominations[label]);
    if (quantity === null || quantity < 0 || cents === null || cents <= 0)
      return null;
    if (quantity > 0) {
      pieces[label] = quantity;
      denominationCentsByLabel[label] = cents;
    }
  }
  return {
    id,
    totalCents,
    pieces,
    denominationCentsByLabel,
    source: combination,
  };
}

function getNormalizedCombinations(configSet) {
  const combinations = Array.isArray(configSet?.config?.combinazioni)
    ? configSet.config.combinazioni
    : [];
  return combinations
    .map((entry) => normalizeCombination(configSet, entry))
    .filter((entry) => entry !== null);
}

function resolveInventoryByCents(settings, context = {}) {
  const gatewayInventory = sanitizeGatewayInventory(
    context.gatewayInventory ?? settings.gatewayInventory,
  );
  const list = gatewayInventory.inventory.listCassette;
  if (!settings.gatewayConfigured) {
    return {
      ok: false,
      error: "Gateway cassa automatica non configurato.",
      checkedAtMs: Date.now(),
      byCents: new Map(),
    };
  }
  if (
    !gatewayInventory.ok ||
    gatewayInventory.inventory.ok === false ||
    list.length === 0
  ) {
    return {
      ok: false,
      error:
        gatewayInventory.inventory.error ||
        "Inventario cassa automatica non disponibile.",
      checkedAtMs: gatewayInventory.updatedAtMs ?? Date.now(),
      byCents: new Map(),
    };
  }
  const byCents = new Map();
  for (const entry of list) {
    if (entry.IsExist === false) continue;
    byCents.set(
      entry.Value_Money,
      (byCents.get(entry.Value_Money) ?? 0) + Math.max(0, entry.Stock),
    );
  }
  return {
    ok: true,
    error: null,
    checkedAtMs: gatewayInventory.updatedAtMs ?? Date.now(),
    byCents,
  };
}

export function buildCashExchangeAvailableDenominations(input = {}, context = {}) {
  const settings = sanitizeAutomaticCashSettings(input);
  const inventory = resolveInventoryByCents(settings, context);
  if (!inventory.ok) return [];
  const reserveConfig = getActiveReserveConfig(settings);
  const reserveByCents = new Map();
  if (reserveConfig?.enabled) {
    const denominations = reserveConfig.denominazioni_centesimi ?? {};
    const minimumPieces = reserveConfig.riserva_minima_pezzi ?? {};
    for (const [label, rawCents] of Object.entries(denominations)) {
      const cents = toInteger(rawCents);
      const pieces = toInteger(minimumPieces[label]);
      if (cents === null || pieces === null || cents <= 0 || pieces <= 0) {
        continue;
      }
      reserveByCents.set(cents, (reserveByCents.get(cents) ?? 0) + pieces);
    }
  }
  return CASH_EXCHANGE_DENOMINATION_CENTS.map((cents) => {
    const stockPieces = inventory.byCents.get(cents) ?? 0;
    const reservedPieces = reserveByCents.get(cents) ?? 0;
    return {
      cents,
      label: formatDenominationLabel(cents),
      availablePieces: Math.max(0, stockPieces - reservedPieces),
      reservedPieces,
    };
  });
}

export function sanitizeAutomaticCashSettings(input = {}) {
  const raw = isRecord(input) ? input : {};
  const configSets = (Array.isArray(raw.configSets) ? raw.configSets : [])
    .map(sanitizeConfigSet)
    .filter((entry) => entry !== null);
  const rawConfigSet = sanitizeConfigSet(raw.configSet);
  if (
    rawConfigSet &&
    !configSets.some((entry) => entry.id === rawConfigSet.id)
  ) {
    configSets.push(rawConfigSet);
  }
  const requestedConfigSetId = String(
    raw.configSetId ?? rawConfigSet?.id ?? "",
  ).trim();
  const activeConfigSet =
    configSets.find((entry) => entry.id === requestedConfigSetId) ??
    rawConfigSet ??
    configSets[0] ??
    null;

  const reserveConfigs = (
    Array.isArray(raw.reserveConfigs) ? raw.reserveConfigs : []
  )
    .map(sanitizeReserveConfigSet)
    .filter((entry) => entry !== null);
  const rawReserveConfig = sanitizeReserveConfigSet(raw.reserveConfig);
  if (
    rawReserveConfig &&
    !reserveConfigs.some((entry) => entry.id === rawReserveConfig.id)
  ) {
    reserveConfigs.push(rawReserveConfig);
  }
  const requestedReserveConfigId = String(
    raw.reserveConfigId ?? rawReserveConfig?.id ?? "",
  ).trim();
  const activeReserveConfig =
    reserveConfigs.find((entry) => entry.id === requestedReserveConfigId) ??
    rawReserveConfig ??
    reserveConfigs[0] ??
    null;
  const feedbackThresholds = normalizeFeedbackThresholds(raw);

  return {
    enabled: raw.enabled === true,
    gatewayConfigured: raw.gatewayConfigured === true,
    gatewayInventory: sanitizeGatewayInventory(
      raw.gatewayInventory ?? raw.gatewayState,
    ),
    feedbackEnabled: raw.feedbackEnabled !== false,
    warningThresholdCents: feedbackThresholds.warningThresholdCents,
    dangerThresholdCents: feedbackThresholds.dangerThresholdCents,
    autoCashFloatMode: AUTOMATIC_CASH_MODES.has(raw.autoCashFloatMode)
      ? raw.autoCashFloatMode
      : "random_file",
    configSetId: activeConfigSet?.id ?? null,
    configSet: publicSummary(activeConfigSet),
    configSets,
    reserveConfigId: activeReserveConfig?.id ?? null,
    reserveConfig: publicReserveSummary(activeReserveConfig),
    reserveConfigs,
    workflows: (Array.isArray(raw.workflows) ? raw.workflows : [])
      .map(sanitizeWorkflow)
      .filter((entry) => entry !== null),
    assignments: (Array.isArray(raw.assignments) ? raw.assignments : [])
      .map(sanitizeAssignment)
      .filter((entry) => entry !== null),
    cashFloats: (Array.isArray(raw.cashFloats) ? raw.cashFloats : [])
      .map(sanitizeCashFloat)
      .filter((entry) => entry !== null),
    deposits: (Array.isArray(raw.deposits) ? raw.deposits : [])
      .map(sanitizeDeposit)
      .filter((entry) => entry !== null),
    cashPayments: (Array.isArray(raw.cashPayments) ? raw.cashPayments : [])
      .map(sanitizeCashPayment)
      .filter((entry) => entry !== null)
      .sort((left, right) => right.startedAtMs - left.startedAtMs)
      .slice(0, MAX_CASH_PAYMENT_RECORDS),
    cashExchanges: (Array.isArray(raw.cashExchanges) ? raw.cashExchanges : [])
      .map(sanitizeCashExchange)
      .filter((entry) => entry !== null),
    cashMovements: sanitizeCashMovements(raw.cashMovements),
    settlementRecords: (Array.isArray(raw.settlementRecords)
      ? raw.settlementRecords
      : []
    )
      .map(sanitizeAutomaticCashSettlementRecord)
      .filter((entry) => entry !== null)
      .sort((left, right) => right.completedAtMs - left.completedAtMs)
      .slice(0, MAX_SETTLEMENT_RECORDS),
  };
}

export function buildAutomaticCashSettingsPayload(input = {}, extra = {}) {
  const settings = sanitizeAutomaticCashSettings(input);
  return {
    ok: true,
    enabled: settings.enabled,
    gatewayConfigured: settings.gatewayConfigured,
    feedbackEnabled: settings.feedbackEnabled,
    warningThresholdCents: settings.warningThresholdCents,
    dangerThresholdCents: settings.dangerThresholdCents,
    autoCashFloatMode: settings.autoCashFloatMode,
    configSet: settings.configSet,
    configSets: settings.configSets
      .map(publicSummary)
      .filter((entry) => entry !== null),
    reserveConfig: settings.reserveConfig,
    reserveConfigs: settings.reserveConfigs
      .map(publicReserveSummary)
      .filter((entry) => entry !== null),
    ...extra,
  };
}

export function resolveAutomaticCashBusinessEveningKey(nowMs = Date.now()) {
  const date = new Date(nowMs);
  if (!Number.isFinite(date.getTime()))
    return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export function isAutomaticCashWorkflowActive(workflow) {
  return ACTIVE_WORKFLOW_STEPS.has(
    normalizeText(workflow?.step, 80).toUpperCase(),
  );
}

export function getActiveAutomaticCashWorkflow(input = {}) {
  const settings = sanitizeAutomaticCashSettings(input);
  return settings.workflows.find(isAutomaticCashWorkflowActive) ?? null;
}

export function publicAutomaticCashWorkflow(workflow, context = {}) {
  const safe = sanitizeWorkflow(workflow);
  if (!safe) return null;
  const nowMs = toTimestamp(context.nowMs, Date.now());
  const operationLock = sanitizeOperationLock(safe.operationLock);
  const lockHeldByManager = operationLock?.ownerCanManageAutomaticCash === true;
  const currentCanManage = context.canManageAutomaticCash === true;
  const blockedByOperationLock =
    isOperationLockActive(operationLock, nowMs) &&
    !isOperationLockOwnedByContext(operationLock, context) &&
    (!currentCanManage || lockHeldByManager);
  const currentUserId = normalizeText(context.userId ?? context.user?.id, 120);
  const resumableByManager =
    currentCanManage && currentUserId !== safe.ownerUserId;
  const resumableByCurrentUser = Boolean(
    ((currentUserId && currentUserId === safe.ownerUserId) ||
      resumableByManager) &&
    !blockedByOperationLock,
  );
  const base = {
    workflowId: safe.workflowId,
    cashFloatId: safe.cashFloatId,
    ownerUserId: safe.ownerUserId,
    ownerFullName: safe.ownerFullName,
    ownerDeviceUuid: safe.ownerDeviceUuid,
    step: safe.step,
    startedAtMs: safe.startedAtMs,
    updatedAtMs: safe.updatedAtMs,
    resumableByCurrentUser,
    resumableByManager,
    blockedByOperationLock,
    operationLock: publicOperationLock(operationLock),
    ticket: safe.ticket,
  };
  if (!resumableByCurrentUser) return base;
  return {
    ...base,
    operationId: safe.operationId,
    assignmentId: safe.assignmentId,
    combinationId: safe.combinationId,
    businessEveningKey: safe.businessEveningKey,
    configSetId: safe.configSetId,
    reserveConfigId: safe.reserveConfigId,
    activityId: safe.activityId,
    roomId: safe.roomId,
    reason: safe.reason,
    pieces: safe.pieces,
    gatewayPieces: safe.gatewayPieces,
    totalCents: safe.totalCents,
    createdAtMs: safe.startedAtMs,
    qrPayload: safe.qrPayload,
  };
}

export function isCashExchangeActive(exchange) {
  const safe = sanitizeCashExchange(exchange);
  return Boolean(safe && ACTIVE_CASH_EXCHANGE_STATUSES.has(safe.status));
}

export function getActiveCashExchange(input = {}) {
  const settings = sanitizeAutomaticCashSettings(input);
  return settings.cashExchanges.find(isCashExchangeActive) ?? null;
}

export function publicCashExchange(exchange, context = {}) {
  const safe = sanitizeCashExchange(exchange);
  if (!safe) return null;
  const nowMs = toTimestamp(context.nowMs, Date.now());
  const operationLock = sanitizeOperationLock(safe.operationLock);
  const lockHeldByManager = operationLock?.ownerCanManageAutomaticCash === true;
  const currentCanManage = context.canManageAutomaticCash === true;
  const blockedByOperationLock =
    isOperationLockActive(operationLock, nowMs) &&
    !isOperationLockOwnedByContext(operationLock, context) &&
    (!currentCanManage || lockHeldByManager);
  const currentUserId = normalizeText(context.userId ?? context.user?.id, 120);
  const resumableByManager =
    currentCanManage && currentUserId !== safe.ownerUserId;
  const resumableByCurrentUser = Boolean(
    isCashExchangeActive(safe) &&
    ((currentUserId && currentUserId === safe.ownerUserId) ||
      resumableByManager) &&
    !blockedByOperationLock,
  );
  const base = {
    exchangeId: safe.exchangeId,
    status: safe.status,
    ownerUserId: safe.ownerUserId,
    ownerFullName: safe.ownerFullName,
    ownerDeviceUuid: safe.ownerDeviceUuid,
    startedAtMs: safe.startedAtMs,
    updatedAtMs: safe.updatedAtMs,
    completedAtMs: safe.completedAtMs,
    resumableByCurrentUser,
    resumableByManager,
    blockedByOperationLock,
    operationLock: publicOperationLock(operationLock),
  };
  if (!resumableByCurrentUser) return base;
  return {
    ...base,
    operationId: safe.operationId,
    activityId: safe.activityId,
    roomId: safe.roomId,
    depositedCents: safe.depositedCents,
    selectedPieces: safe.selectedPieces,
    selectedTotalCents: safe.selectedTotalCents,
    allowedDenominationsCents: safe.allowedDenominationsCents,
    availableDenominations: safe.availableDenominations,
    error: safe.error,
  };
}

export function buildCashExchangeStatePayload(exchange) {
  const safe = sanitizeCashExchange(exchange);
  if (!safe) return null;
  return {
    ok: true,
    exchangeId: safe.exchangeId,
    operationId: safe.operationId || null,
    status: safe.status,
    depositedCents: safe.depositedCents,
    selectedPieces: safe.selectedPieces,
    selectedTotalCents: safe.selectedTotalCents,
    allowedDenominationsCents: safe.allowedDenominationsCents,
    availableDenominations: safe.availableDenominations,
    updatedAtMs: safe.updatedAtMs,
  };
}

export function appendCashExchangeAuditEvent(
  exchange,
  action,
  event = {},
  options = {},
) {
  const safe = sanitizeCashExchange(exchange);
  if (!safe) return exchange;
  const nowMs = toTimestamp(options.nowMs, Date.now());
  const selectedPieces = isRecord(event.selectedPieces)
    ? event.selectedPieces
    : safe.selectedPieces;
  const auditEvent = sanitizeCashExchangeAuditEvent({
    action,
    atMs: nowMs,
    status: safe.status,
    activityId: safe.activityId,
    roomId: safe.roomId,
    depositedCents: safe.depositedCents,
    selectedPieces,
    actorUserId: event.actorUserId,
    actorFullName: event.actorFullName,
    actorRole: event.actorRole,
    deviceUuid: event.deviceUuid,
    sessionId: event.sessionId,
    error: event.error,
    snapshot: event.snapshot,
  });
  if (!auditEvent) return safe;
  return {
    ...safe,
    auditEvents: [...safe.auditEvents, auditEvent].slice(
      -MAX_CASH_EXCHANGE_AUDIT_EVENTS,
    ),
  };
}

export function validateCashExchangePieces(input, depositedCents) {
  const pieces = sanitizeCashExchangePieces(input);
  const selectedTotalCents = sumCashExchangePieces(pieces);
  const normalizedDepositedCents = clampCents(depositedCents, 0);
  if (normalizedDepositedCents <= 0 || normalizedDepositedCents % 5 !== 0) {
    return {
      ok: false,
      code: "CASH_EXCHANGE_AMOUNT_NOT_REPRESENTABLE",
      error: "Importo cambio non rappresentabile con i tagli disponibili.",
      pieces,
      selectedTotalCents,
    };
  }
  if (Object.keys(pieces).length === 0) {
    return {
      ok: false,
      code: "CASH_EXCHANGE_INVALID_PIECES",
      error: "Tagli cambio mancanti.",
      pieces,
      selectedTotalCents,
    };
  }
  if (selectedTotalCents !== normalizedDepositedCents) {
    return {
      ok: false,
      code: "CASH_EXCHANGE_TOTAL_MISMATCH",
      error:
        "Il totale dei tagli selezionati non coincide con l'importo inserito.",
      pieces,
      selectedTotalCents,
    };
  }
  return {
    ok: true,
    code: "OK",
    error: null,
    pieces,
    selectedTotalCents,
  };
}

function usedCombinationIdsForEvening(settings, businessEveningKey) {
  return new Set(
    settings.assignments
      .filter(
        (entry) =>
          entry.businessEveningKey === businessEveningKey &&
          entry.status !== "cancelled",
      )
      .map((entry) => entry.combinationId)
      .filter(Boolean),
  );
}

function resolveCombinationPoolForEvening(combinations, usedIds) {
  const unused = combinations.filter((entry) => !usedIds.has(entry.id));
  if (unused.length > 0 || combinations.length === 0) {
    return {
      combinations: unused,
      unusedCombinationCount: unused.length,
      cycledCombinationPool: false,
    };
  }
  return {
    combinations,
    unusedCombinationCount: 0,
    cycledCombinationPool: true,
  };
}

function evaluateCombination({ combination, reserveConfig, inventoryByCents }) {
  const blockedDenominations = [];
  const reserveDenominations = reserveConfig?.denominazioni_centesimi ?? {};
  const minimumPieces = reserveConfig?.riserva_minima_pezzi ?? {};
  for (const [label, requestedPieces] of Object.entries(combination.pieces)) {
    const cents = combination.denominationCentsByLabel[label];
    const reserveCents = toInteger(reserveDenominations[label]);
    const minimumReservePieces = toInteger(minimumPieces[label]);
    if (
      reserveCents === null ||
      reserveCents !== cents ||
      minimumReservePieces === null
    ) {
      blockedDenominations.push({
        denominationLabel: label,
        denominationCents: cents,
        availablePieces: 0,
        minimumReservePieces: 0,
        requestedPieces,
        remainingPieces: 0,
        missingPieces: requestedPieces,
        reasonCode: "FCA_RESERVE_CONFIG_INVALID",
      });
      continue;
    }
    const availablePieces = inventoryByCents.get(cents);
    if (!Number.isInteger(availablePieces)) {
      blockedDenominations.push({
        denominationLabel: label,
        denominationCents: cents,
        availablePieces: 0,
        minimumReservePieces,
        requestedPieces,
        remainingPieces: 0,
        missingPieces: requestedPieces + minimumReservePieces,
        reasonCode: "FCA_INVENTORY_UNAVAILABLE",
      });
      continue;
    }
    const remainingPieces = availablePieces - requestedPieces;
    if (remainingPieces < minimumReservePieces) {
      blockedDenominations.push({
        denominationLabel: label,
        denominationCents: cents,
        availablePieces,
        minimumReservePieces,
        requestedPieces,
        remainingPieces,
        missingPieces: minimumReservePieces - remainingPieces,
        reasonCode: "FCA_NO_FEASIBLE_CONFIGURATION",
      });
    }
  }
  return {
    eligible: blockedDenominations.length === 0,
    blockedDenominations,
  };
}

function buildBlockedDenominationSummary(blockedDenominations) {
  const byKey = new Map();
  for (const entry of blockedDenominations) {
    const key = `${entry.denominationLabel}:${entry.denominationCents}`;
    const current = byKey.get(key);
    if (!current || entry.missingPieces > current.missingPieces) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort(
    (left, right) => right.denominationCents - left.denominationCents,
  );
}

export function buildAutomaticCashPreflight(input = {}, context = {}) {
  const settings = sanitizeAutomaticCashSettings(input);
  const nowMs = toTimestamp(context.nowMs, Date.now());
  const businessEveningKey =
    normalizeText(context.businessEveningKey, 40) ||
    resolveAutomaticCashBusinessEveningKey(nowMs);
  const activeWorkflow = getActiveAutomaticCashWorkflow(settings);
  const base = {
    ok: true,
    canCreate: false,
    reasonCode: "UNKNOWN",
    message: "",
    businessEveningKey,
    inventoryCheckedAtMs: nowMs,
    configSetId: settings.configSetId,
    reserveConfigId: settings.reserveConfigId,
    unusedCombinationCount: 0,
    cycledCombinationPool: false,
    eligibleCombinationCount: 0,
    blockedDenominations: [],
    activeWorkflow: publicAutomaticCashWorkflow(activeWorkflow, context),
  };
  if (activeWorkflow) {
    return {
      ...base,
      reasonCode: "FCA_ACTIVE_WORKFLOW",
      message: "Una creazione fondo cassa automatico e gia in corso.",
    };
  }
  if (!settings.enabled) {
    return {
      ...base,
      reasonCode: "AUTOMATIC_CASH_DISABLED",
      message: "Fondo cassa automatico non abilitato.",
    };
  }
  const configSet = getActiveConfigSet(settings);
  if (!configSet?.config) {
    return {
      ...base,
      reasonCode: "AUTOMATIC_CASH_NOT_CONFIGURED",
      message: "File combinazioni fondo cassa non configurato.",
    };
  }
  const reserveConfig = getActiveReserveConfig(settings);
  if (!reserveConfig?.enabled) {
    return {
      ...base,
      reasonCode: "FCA_RESERVE_CONFIG_INVALID",
      message: "File riserva minima tagli mancante o non valido.",
    };
  }
  const inventory = resolveInventoryByCents(settings, context);
  if (!inventory.ok) {
    return {
      ...base,
      reasonCode: settings.gatewayConfigured
        ? "FCA_INVENTORY_UNAVAILABLE"
        : "FCA_GATEWAY_UNREACHABLE",
      message: inventory.error,
      inventoryCheckedAtMs: inventory.checkedAtMs,
    };
  }

  const combinations = getNormalizedCombinations(configSet);
  const usedIds = usedCombinationIdsForEvening(settings, businessEveningKey);
  const combinationPool = resolveCombinationPoolForEvening(
    combinations,
    usedIds,
  );
  const evaluated = combinationPool.combinations.map((combination) => ({
    combination,
    ...evaluateCombination({
      combination,
      reserveConfig,
      inventoryByCents: inventory.byCents,
    }),
  }));
  const eligible = evaluated
    .filter((entry) => entry.eligible)
    .map((entry) => entry.combination);
  const blockedDenominations = buildBlockedDenominationSummary(
    evaluated.flatMap((entry) => entry.blockedDenominations),
  );
  if (eligible.length === 0) {
    return {
      ...base,
      reasonCode: "FCA_NO_FEASIBLE_CONFIGURATION",
      message:
        "Nessuna configurazione disponibile rispetta inventario e riserva minima.",
      inventoryCheckedAtMs: inventory.checkedAtMs,
      unusedCombinationCount: combinationPool.unusedCombinationCount,
      cycledCombinationPool: combinationPool.cycledCombinationPool,
      eligibleCombinationCount: 0,
      blockedDenominations,
    };
  }
  return {
    ...base,
    canCreate: true,
    reasonCode: "OK",
    message: "",
    inventoryCheckedAtMs: inventory.checkedAtMs,
    unusedCombinationCount: combinationPool.unusedCombinationCount,
    cycledCombinationPool: combinationPool.cycledCombinationPool,
    eligibleCombinationCount: eligible.length,
    blockedDenominations: [],
    activeWorkflow: null,
  };
}

export function selectAutomaticCashCombination(input = {}, context = {}) {
  const settings = sanitizeAutomaticCashSettings(input);
  const preflight = buildAutomaticCashPreflight(settings, context);
  if (!preflight.canCreate) {
    return { preflight, combination: null };
  }
  const configSet = getActiveConfigSet(settings);
  const reserveConfig = getActiveReserveConfig(settings);
  const inventory = resolveInventoryByCents(settings, context);
  const combinations = getNormalizedCombinations(configSet);
  const businessEveningKey = preflight.businessEveningKey;
  const usedIds = usedCombinationIdsForEvening(settings, businessEveningKey);
  const combinationPool = resolveCombinationPoolForEvening(
    combinations,
    usedIds,
  );
  const eligible = combinationPool.combinations
    .filter(
      (combination) =>
        evaluateCombination({
          combination,
          reserveConfig,
          inventoryByCents: inventory.byCents,
        }).eligible,
    );
  if (eligible.length === 0) {
    return {
      preflight: {
        ...preflight,
        canCreate: false,
        reasonCode: "FCA_NO_FEASIBLE_CONFIGURATION",
      },
      combination: null,
    };
  }
  const selected =
    eligible[Math.floor(Math.random() * eligible.length)] ?? eligible[0];
  return {
    preflight,
    combination: {
      ...selected,
      configSetId: configSet.id,
      reserveConfigId: reserveConfig.id,
      businessEveningKey,
    },
  };
}

export function transitionAutomaticCashWorkflow(
  workflow,
  nextStep,
  options = {},
) {
  const current = sanitizeWorkflow(workflow);
  const safeNextStep = normalizeText(nextStep, 80).toUpperCase();
  if (!current) {
    return {
      ok: false,
      workflow: null,
      error: "Workflow fondo cassa non valido.",
    };
  }
  if (current.step === safeNextStep) {
    return { ok: true, workflow: current, error: null };
  }
  if (TERMINAL_WORKFLOW_STEPS.has(current.step)) {
    return {
      ok: false,
      workflow: current,
      error: `Workflow gia terminato in stato ${current.step}.`,
    };
  }
  const allowed = WORKFLOW_TRANSITIONS[current.step];
  if (!allowed?.has(safeNextStep)) {
    return {
      ok: false,
      workflow: current,
      error: `Transizione non valida: ${current.step} -> ${safeNextStep}.`,
    };
  }
  const nowMs = toTimestamp(options.nowMs, Date.now());
  const next = {
    ...current,
    ...options.patch,
    step: safeNextStep,
    updatedAtMs: nowMs,
    completedAtMs: safeNextStep === "COMPLETED" ? nowMs : current.completedAtMs,
  };
  return { ok: true, workflow: sanitizeWorkflow(next), error: null };
}

export function transitionCashExchange(exchange, nextStatus, options = {}) {
  const current = sanitizeCashExchange(exchange);
  const safeNextStatus = normalizeText(nextStatus, 80).toUpperCase();
  if (!current) {
    return { ok: false, exchange: null, error: "Cambio denaro non valido." };
  }
  if (current.status === safeNextStatus) {
    return { ok: true, exchange: current, error: null };
  }
  if (TERMINAL_CASH_EXCHANGE_STATUSES.has(current.status)) {
    return {
      ok: false,
      exchange: current,
      error: `Cambio gia terminato in stato ${current.status}.`,
    };
  }
  const allowed = CASH_EXCHANGE_TRANSITIONS[current.status];
  if (!allowed?.has(safeNextStatus)) {
    return {
      ok: false,
      exchange: current,
      error: `Transizione cambio non valida: ${current.status} -> ${safeNextStatus}.`,
    };
  }
  const nowMs = toTimestamp(options.nowMs, Date.now());
  const next = {
    ...current,
    ...options.patch,
    status: safeNextStatus,
    updatedAtMs: nowMs,
    completedAtMs: TERMINAL_CASH_EXCHANGE_STATUSES.has(safeNextStatus)
      ? nowMs
      : current.completedAtMs,
  };
  return { ok: true, exchange: sanitizeCashExchange(next), error: null };
}
