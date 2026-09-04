const CASH_MOVEMENT_TYPES = new Set(["load", "withdrawal"]);
const ACTIVE_CASH_MOVEMENT_STATUSES = new Set([
  "STARTING",
  "ACTIVE",
  "REVIEW_REQUIRED",
  "WAITING_CASH_REMOVAL",
  "WAITING_REPORT",
]);
const TERMINAL_CASH_MOVEMENT_STATUSES = new Set([
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);
const ALLOWED_DENOMINATION_CENTS = new Set([
  2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1,
]);
const CASH_MOVEMENT_TRANSITIONS = {
  load: {
    STARTING: new Set(["ACTIVE", "COMPLETED", "CANCELLED", "FAILED"]),
    ACTIVE: new Set([
      "REVIEW_REQUIRED",
      "WAITING_REPORT",
      "COMPLETED",
      "CANCELLED",
      "FAILED",
    ]),
    REVIEW_REQUIRED: new Set(["WAITING_REPORT", "COMPLETED", "FAILED"]),
    WAITING_REPORT: new Set(["COMPLETED", "FAILED"]),
  },
  withdrawal: {
    STARTING: new Set(["WAITING_CASH_REMOVAL", "COMPLETED", "FAILED"]),
    WAITING_CASH_REMOVAL: new Set([
      "WAITING_REPORT",
      "COMPLETED",
      "FAILED",
    ]),
    WAITING_REPORT: new Set(["COMPLETED", "FAILED"]),
  },
};

export const MAX_CASH_MOVEMENT_RECORDS = 600;
export const MAX_CASH_MOVEMENT_AMOUNT_CENTS = 10_000_000;
export const CASH_MOVEMENT_DENOMINATION_CENTS = Object.freeze([
  2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1,
]);
const MAX_CASH_MOVEMENT_AUDIT_EVENTS = 40;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function toTimestamp(value, fallback = null) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  const fromDate = new Date(String(value ?? "")).getTime();
  return Number.isFinite(fromDate) && fromDate > 0 ? fromDate : fallback;
}

function clampCents(value, fallback = 0) {
  const parsed = toInteger(value);
  if (parsed === null || parsed < 0) return fallback;
  return Math.min(parsed, MAX_CASH_MOVEMENT_AMOUNT_CENTS);
}

export function sanitizeCashMovementPieces(input) {
  if (!isRecord(input)) return {};
  const pieces = {};
  for (const [rawCents, rawQuantity] of Object.entries(input)) {
    const cents = toInteger(rawCents);
    const quantity = toInteger(rawQuantity);
    if (
      !ALLOWED_DENOMINATION_CENTS.has(cents) ||
      quantity === null ||
      quantity <= 0
    ) {
      continue;
    }
    pieces[String(cents)] = (pieces[String(cents)] ?? 0) + quantity;
  }
  return pieces;
}

export function sumCashMovementPieces(pieces) {
  return Object.entries(sanitizeCashMovementPieces(pieces)).reduce(
    (sum, [cents, quantity]) => sum + Number(cents) * quantity,
    0,
  );
}

function sanitizeAuditEvents(input) {
  return (Array.isArray(input) ? input : [])
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const action = normalizeText(entry.action, 100);
      if (!action) return null;
      return {
        action,
        atMs: toTimestamp(entry.atMs, Date.now()),
        details: isRecord(entry.details)
          ? Object.fromEntries(
              Object.entries(entry.details)
                .slice(0, 20)
                .map(([key, value]) => [
                  normalizeText(key, 80),
                  typeof value === "string"
                    ? normalizeText(value, 300)
                    : typeof value === "number" || typeof value === "boolean"
                      ? value
                      : null,
                ])
                .filter(([key]) => key),
            )
          : {},
      };
    })
    .filter(Boolean)
    .slice(-MAX_CASH_MOVEMENT_AUDIT_EVENTS);
}

export function sanitizeCashMovement(input) {
  if (!isRecord(input)) return null;
  const movementId = normalizeText(input.movementId ?? input.id, 120);
  const type = normalizeText(input.type, 40).toLowerCase();
  const status = normalizeText(input.status || "STARTING", 60).toUpperCase();
  if (
    !movementId ||
    !CASH_MOVEMENT_TYPES.has(type) ||
    (!ACTIVE_CASH_MOVEMENT_STATUSES.has(status) &&
      !TERMINAL_CASH_MOVEMENT_STATUSES.has(status))
  ) {
    return null;
  }
  const pieces = sanitizeCashMovementPieces(input.pieces);
  const requestedAmountCents = clampCents(
    input.requestedAmountCents ?? input.amountCents,
    0,
  );
  const amountCents = clampCents(
    input.amountCents,
    type === "withdrawal" ? requestedAmountCents : 0,
  );
  return {
    movementId,
    clientRequestId: normalizeText(input.clientRequestId, 160),
    type,
    status,
    requestedAmountCents,
    amountCents,
    pieces,
    piecesTotalCents: sumCashMovementPieces(pieces),
    justification: normalizeText(input.justification, 500),
    ownerUserId: normalizeText(input.ownerUserId, 120),
    ownerFullName: normalizeText(input.ownerFullName, 160),
    ownerDeviceUuid: normalizeText(input.ownerDeviceUuid, 160),
    ownerSessionId: normalizeText(input.ownerSessionId, 160),
    activityId: normalizeText(input.activityId, 120),
    roomId: normalizeText(input.roomId, 120),
    roomName: normalizeText(input.roomName, 160),
    startedAtMs: toTimestamp(input.startedAtMs, Date.now()),
    updatedAtMs: toTimestamp(input.updatedAtMs, Date.now()),
    completedAtMs: toTimestamp(input.completedAtMs, null),
    preparedAtMs: toTimestamp(input.preparedAtMs, null),
    physicalCompletedAtMs: toTimestamp(input.physicalCompletedAtMs, null),
    cashRemovedAtMs: toTimestamp(input.cashRemovedAtMs, null),
    cancelledAtMs: toTimestamp(input.cancelledAtMs, null),
    reportText: normalizeText(input.reportText, 12_000),
    reportPrintCount: Math.max(
      0,
      Math.min(1000, toInteger(input.reportPrintCount) ?? 0),
    ),
    reportPrintJobId: normalizeText(input.reportPrintJobId, 160) || null,
    reportPrintRequestId:
      normalizeText(input.reportPrintRequestId, 180) || null,
    reportPrintedAtMs: toTimestamp(input.reportPrintedAtMs, null),
    auditEvents: sanitizeAuditEvents(input.auditEvents),
    error: normalizeText(input.error, 500) || null,
  };
}

export function appendCashMovementAuditEvent(
  movement,
  action,
  details = {},
  atMs = Date.now(),
) {
  const safe = sanitizeCashMovement(movement);
  if (!safe) return null;
  return sanitizeCashMovement({
    ...safe,
    auditEvents: [
      ...safe.auditEvents,
      {
        action,
        atMs,
        details,
      },
    ],
    updatedAtMs: atMs,
  });
}

export function sanitizeCashMovements(input, limit = MAX_CASH_MOVEMENT_RECORDS) {
  return (Array.isArray(input) ? input : [])
    .map(sanitizeCashMovement)
    .filter((entry) => entry !== null)
    .sort((left, right) => right.startedAtMs - left.startedAtMs)
    .slice(0, Math.max(1, Number(limit) || MAX_CASH_MOVEMENT_RECORDS));
}

export function isCashMovementActive(movement) {
  const safe = sanitizeCashMovement(movement);
  return Boolean(safe && ACTIVE_CASH_MOVEMENT_STATUSES.has(safe.status));
}

export function getActiveCashMovement(input) {
  return (
    sanitizeCashMovements(input?.cashMovements ?? input).find(
      isCashMovementActive,
    ) ?? null
  );
}

export function cashMovementOwnerMatchesContext(movement, context = {}) {
  const safe = sanitizeCashMovement(movement);
  if (!safe) return false;
  const userId = normalizeText(context.user?.id ?? context.userId, 120);
  const deviceUuid = normalizeText(
    context.session?.deviceUuid ?? context.deviceUuid,
    160,
  );
  const sessionId = normalizeText(
    context.session?.id ?? context.sessionId,
    160,
  );
  return Boolean(
    (safe.ownerSessionId && sessionId && safe.ownerSessionId === sessionId) ||
      (safe.ownerDeviceUuid &&
        deviceUuid &&
        safe.ownerDeviceUuid === deviceUuid) ||
      (safe.ownerUserId && userId && safe.ownerUserId === userId),
  );
}

export function publicCashMovement(movement, context = {}) {
  const safe = sanitizeCashMovement(movement);
  if (!safe) return null;
  const economicallyCompleted = ["WAITING_REPORT", "COMPLETED"].includes(
    safe.status,
  );
  const effectiveAmountCents =
    safe.type === "withdrawal"
      ? safe.requestedAmountCents || safe.amountCents
      : safe.amountCents;
  return {
    ...safe,
    signedAmountCents: economicallyCompleted
      ? safe.type === "withdrawal"
        ? -effectiveAmountCents
        : effectiveAmountCents
      : 0,
    resumableByCurrentUser:
      isCashMovementActive(safe) &&
      (cashMovementOwnerMatchesContext(safe, context) ||
        context.canManageAutomaticCash === true),
  };
}

export function transitionCashMovement(movement, nextStatus, patch = {}) {
  const safe = sanitizeCashMovement(movement);
  if (!safe) throw new Error("Movimento cassa non valido.");
  const target = normalizeText(nextStatus, 60).toUpperCase();
  if (safe.status === target) return safe;
  const allowed = CASH_MOVEMENT_TRANSITIONS[safe.type]?.[safe.status];
  if (!allowed?.has(target)) {
    const error = new Error(
      `Transizione movimento cassa non valida: ${safe.status} -> ${target}.`,
    );
    error.code = "CASH_MOVEMENT_STEP_CONFLICT";
    throw error;
  }
  const nowMs = toTimestamp(patch.updatedAtMs, Date.now());
  return sanitizeCashMovement({
    ...safe,
    ...patch,
    status: target,
    updatedAtMs: nowMs,
    completedAtMs:
      target === "COMPLETED"
        ? toTimestamp(patch.completedAtMs, nowMs)
        : safe.completedAtMs,
    cancelledAtMs:
      target === "CANCELLED"
        ? toTimestamp(patch.cancelledAtMs, nowMs)
        : safe.cancelledAtMs,
  });
}

function reserveByCents(settings = {}) {
  const reserveConfigs = Array.isArray(settings.reserveConfigs)
    ? settings.reserveConfigs
    : [];
  const active =
    reserveConfigs.find(
      (entry) =>
        normalizeText(entry?.id, 120) ===
        normalizeText(settings.reserveConfigId, 120),
    ) ??
    settings.reserveConfig ??
    reserveConfigs[0] ??
    null;
  if (!active?.enabled) return new Map();
  const denominations = isRecord(active.denominazioni_centesimi)
    ? active.denominazioni_centesimi
    : {};
  const minimumPieces = isRecord(active.riserva_minima_pezzi)
    ? active.riserva_minima_pezzi
    : {};
  const result = new Map();
  for (const [label, rawCents] of Object.entries(denominations)) {
    const cents = toInteger(rawCents);
    const pieces = toInteger(minimumPieces[label]);
    if (
      !ALLOWED_DENOMINATION_CENTS.has(cents) ||
      pieces === null ||
      pieces <= 0
    ) {
      continue;
    }
    result.set(cents, (result.get(cents) ?? 0) + pieces);
  }
  return result;
}

export function buildCashWithdrawalAvailability(settings = {}) {
  const rows = Array.isArray(settings.gatewayInventory?.inventory?.listCassette)
    ? settings.gatewayInventory.inventory.listCassette
    : [];
  const availableByCents = new Map();
  for (const row of rows) {
    if (row?.IsExist === false || row?.IsEmpty === true) continue;
    const cents = toInteger(
      row?.Value_Money ??
        row?.ValueMoney ??
        row?.denominationCents ??
        row?.cents,
    );
    const stock = toInteger(
      row?.Stock ?? row?.stock ?? row?.availablePieces ?? row?.quantity,
    );
    if (
      !ALLOWED_DENOMINATION_CENTS.has(cents) ||
      stock === null ||
      stock <= 0
    ) {
      continue;
    }
    availableByCents.set(cents, (availableByCents.get(cents) ?? 0) + stock);
  }
  const reserves = reserveByCents(settings);
  return [...availableByCents.entries()]
    .map(([cents, stock]) => ({
      cents,
      availablePieces: Math.max(0, stock - (reserves.get(cents) ?? 0)),
      reservedPieces: reserves.get(cents) ?? 0,
    }))
    .filter((entry) => entry.availablePieces > 0)
    .sort((left, right) => right.cents - left.cents);
}

export function validateCashWithdrawalPieces(pieces, availability) {
  const selected = sanitizeCashMovementPieces(pieces);
  const totalCents = sumCashMovementPieces(selected);
  if (
    totalCents <= 0 ||
    totalCents > MAX_CASH_MOVEMENT_AMOUNT_CENTS
  ) {
    return {
      ok: false,
      code: "CASH_MOVEMENT_INVALID_PIECES",
      error: "Seleziona almeno un taglio per il prelievo.",
      pieces: {},
      totalCents: 0,
    };
  }
  const availableByCents = new Map(
    (Array.isArray(availability) ? availability : [])
      .map((entry) => [
        toInteger(entry?.cents),
        toInteger(entry?.availablePieces),
      ])
      .filter(
        ([cents, quantity]) =>
          ALLOWED_DENOMINATION_CENTS.has(cents) &&
          quantity !== null &&
          quantity >= 0,
      ),
  );
  if (availableByCents.size === 0) {
    return {
      ok: false,
      code: "CASH_MOVEMENT_INVENTORY_UNAVAILABLE",
      error: "Inventario cassa automatica non disponibile.",
      pieces: {},
      totalCents: 0,
    };
  }
  for (const [rawCents, quantity] of Object.entries(selected)) {
    const cents = Number(rawCents);
    if (quantity > (availableByCents.get(cents) ?? 0)) {
      return {
        ok: false,
        code: "CASH_MOVEMENT_INVENTORY_INSUFFICIENT",
        error: `Taglio da ${(cents / 100).toFixed(2)} EUR non disponibile nella quantita richiesta.`,
        pieces: {},
        totalCents: 0,
      };
    }
  }
  return { ok: true, pieces: selected, totalCents };
}

function readPiecesMapCandidate(input) {
  if (!isRecord(input)) return null;
  const pieces = sanitizeCashMovementPieces(input);
  return Object.keys(pieces).length > 0 ? pieces : null;
}

function readPiecesRowsCandidate(input) {
  if (!Array.isArray(input)) return null;
  const pieces = {};
  for (const rawRow of input) {
    const row = isRecord(rawRow) ? rawRow : {};
    const cents = toInteger(
      row.Value_Money ??
        row.ValueMoney ??
        row.denominationCents ??
        row.cents,
    );
    const quantity = toInteger(
      row.ReplenishmentStock ??
        row.replenishmentStock ??
        row.DepositedStock ??
        row.depositedStock ??
        row.DepositStock ??
        row.depositStock ??
        row.InsertedStock ??
        row.insertedStock ??
        row.quantityInserted ??
        row.insertedPieces,
    );
    if (
      !ALLOWED_DENOMINATION_CENTS.has(cents) ||
      quantity === null ||
      quantity <= 0
    ) {
      continue;
    }
    pieces[String(cents)] = (pieces[String(cents)] ?? 0) + quantity;
  }
  return Object.keys(pieces).length > 0 ? pieces : null;
}

export function extractCashMovementPiecesFromGateway(...roots) {
  const candidates = [];
  const visited = new Set();
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 6 || visited.has(node)) {
      return;
    }
    visited.add(node);
    const rowsCandidate = readPiecesRowsCandidate(node);
    if (rowsCandidate) candidates.push(rowsCandidate);
    if (isRecord(node)) {
      [
        node.pieces,
        node.depositedPieces,
        node.insertedPieces,
        node.denominations,
      ].forEach((candidate) => {
        const piecesCandidate = readPiecesMapCandidate(candidate);
        if (piecesCandidate) candidates.push(piecesCandidate);
      });
      Object.values(node).forEach((value) => visit(value, depth + 1));
    } else {
      node.forEach((value) => visit(value, depth + 1));
    }
  };
  roots.forEach((root) => visit(root));
  return (
    candidates.sort(
      (left, right) =>
        sumCashMovementPieces(right) - sumCashMovementPieces(left),
    )[0] ?? {}
  );
}

export function selectCashWithdrawalPieces(amountCents, availability) {
  const amount = toInteger(amountCents);
  if (
    amount === null ||
    amount <= 0 ||
    amount > MAX_CASH_MOVEMENT_AMOUNT_CENTS
  ) {
    return {
      ok: false,
      code: "CASH_MOVEMENT_INVALID_AMOUNT",
      error: "Importo prelievo non valido.",
      pieces: {},
    };
  }
  const entries = (Array.isArray(availability) ? availability : [])
    .map((entry) => ({
      cents: toInteger(entry?.cents),
      availablePieces: toInteger(entry?.availablePieces),
    }))
    .filter(
      (entry) =>
        ALLOWED_DENOMINATION_CENTS.has(entry.cents) &&
        entry.availablePieces !== null &&
        entry.availablePieces > 0,
    )
    .sort((left, right) => right.cents - left.cents);
  if (entries.length === 0) {
    return {
      ok: false,
      code: "CASH_MOVEMENT_INVENTORY_UNAVAILABLE",
      error: "Inventario cassa automatica non disponibile.",
      pieces: {},
    };
  }

  const suffixCapacity = new Array(entries.length + 1).fill(0);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    suffixCapacity[index] =
      suffixCapacity[index + 1] +
      entries[index].cents * entries[index].availablePieces;
  }
  const deadEnds = new Set();
  const solve = (index, remaining) => {
    if (remaining === 0) return {};
    if (
      index >= entries.length ||
      remaining < 0 ||
      suffixCapacity[index] < remaining
    ) {
      return null;
    }
    const key = `${index}:${remaining}`;
    if (deadEnds.has(key)) return null;
    const entry = entries[index];
    const maxPieces = Math.min(
      entry.availablePieces,
      Math.floor(remaining / entry.cents),
    );
    const minimumPieces = Math.max(
      0,
      Math.ceil((remaining - suffixCapacity[index + 1]) / entry.cents),
    );
    for (let quantity = maxPieces; quantity >= minimumPieces; quantity -= 1) {
      const nextRemaining = remaining - quantity * entry.cents;
      const rest = solve(index + 1, nextRemaining);
      if (rest) {
        return quantity > 0
          ? { [String(entry.cents)]: quantity, ...rest }
          : rest;
      }
    }
    deadEnds.add(key);
    return null;
  };

  const pieces = solve(0, amount);
  if (!pieces) {
    return {
      ok: false,
      code: "CASH_MOVEMENT_AMOUNT_NOT_REPRESENTABLE",
      error: "Importo non erogabile con i tagli disponibili.",
      pieces: {},
    };
  }
  return {
    ok: true,
    pieces,
    totalCents: sumCashMovementPieces(pieces),
  };
}
