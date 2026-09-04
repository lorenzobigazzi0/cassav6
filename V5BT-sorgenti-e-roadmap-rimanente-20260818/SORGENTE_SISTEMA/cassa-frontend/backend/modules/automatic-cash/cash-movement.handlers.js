import { randomUUID } from "node:crypto";
import {
  getActiveAutomaticCashWorkflow,
  getActiveCashExchange,
} from "./automatic-cash.domain.js";
import {
  appendCashMovementAuditEvent,
  buildCashWithdrawalAvailability,
  cashMovementOwnerMatchesContext,
  extractCashMovementPiecesFromGateway,
  getActiveCashMovement,
  publicCashMovement,
  sanitizeCashMovement,
  selectCashWithdrawalPieces,
  sumCashMovementPieces,
  transitionCashMovement,
  validateCashWithdrawalPieces,
} from "./cash-movement.domain.js";
import { buildCashMovementReportText } from "./cash-movement-report.js";

function normalizeText(value, limit = 200) {
  return String(value ?? "")
    .trim()
    .slice(0, limit);
}

function userDisplayName(user) {
  return (
    normalizeText(
      user?.fullName ?? user?.name ?? user?.username ?? user?.id,
      160,
    ) || "Operatore"
  );
}

function nowMsFromIso(nowIso) {
  const value =
    typeof nowIso === "function" ? nowIso() : new Date().toISOString();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function errorDetails(error) {
  return {
    message: normalizeText(
      error?.body?.message ?? error?.body?.error ?? error?.message ?? error,
      500,
    ),
    status: Number.isInteger(error?.status ?? error?.statusCode)
      ? Number(error.status ?? error.statusCode)
      : null,
  };
}

function isTerminalStatus(status) {
  return ["COMPLETED", "CANCELLED", "FAILED"].includes(
    normalizeText(status, 60).toUpperCase(),
  );
}

export function createCashMovementHandlers({
  automaticCashGateway,
  enqueuePrintSpoolJob,
  HttpError,
  canManageAutomaticCash,
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
}) {
  let criticalSectionInFlight = false;

  function canOperate(user) {
    return (
      canManageAutomaticCash(user) ||
      hasPermission(user, "collect_payments")
    );
  }

  function requireOperator(user) {
    if (canOperate(user)) return;
    throw new HttpError(403, "Utente non autorizzato ai movimenti cassa.", {
      code: "CASH_MOVEMENT_PERMISSION_DENIED",
    });
  }

  function publicContext(context) {
    return {
      ...context,
      canManageAutomaticCash: canManageAutomaticCash(context.user),
    };
  }

  function assertMovementAccess(movement, context) {
    if (
      cashMovementOwnerMatchesContext(movement, context) ||
      canManageAutomaticCash(context.user)
    ) {
      return;
    }
    throw new HttpError(
      403,
      "Movimento cassa in gestione da un altro operatore.",
      {
        code: "CASH_MOVEMENT_PERMISSION_DENIED",
      },
    );
  }

  async function runCritical(action) {
    if (criticalSectionInFlight) {
      throw new HttpError(423, "Operazione cassa gia in elaborazione.", {
        code: "CASH_MOVEMENT_ACTIVE",
      });
    }
    criticalSectionInFlight = true;
    try {
      return await action();
    } finally {
      criticalSectionInFlight = false;
    }
  }

  async function persistMovement(
    db,
    settings,
    movement,
    nowMs = nowMsFromIso(nowIso),
  ) {
    const updatedAt =
      typeof nowIso === "function" ? nowIso() : new Date(nowMs).toISOString();
    const nextMovements = [
      movement,
      ...settings.cashMovements.filter(
        (entry) => entry.movementId !== movement.movementId,
      ),
    ];
    const saved = await persistAutomaticCash(
      db,
      {
        ...settings,
        cashMovements: nextMovements,
      },
      updatedAt,
    );
    return (
      saved.cashMovements.find(
        (entry) => entry.movementId === movement.movementId,
      ) ?? movement
    );
  }

  function blockingOperation(settings, ignoredMovementId = "") {
    const activeMovement = getActiveCashMovement(settings);
    if (
      activeMovement &&
      activeMovement.movementId !== normalizeText(ignoredMovementId, 120)
    ) {
      return {
        type: "cash_movement",
        id: activeMovement.movementId,
        movement: activeMovement,
      };
    }
    const workflow = getActiveAutomaticCashWorkflow(settings);
    if (workflow) {
      return { type: "cash_float", id: workflow.operationId, workflow };
    }
    const exchange = getActiveCashExchange(settings);
    if (exchange) {
      return { type: "cash_exchange", id: exchange.operationId, exchange };
    }
    const payment =
      settings.cashPayments.find((entry) => entry.status === "ACTIVE") ?? null;
    if (payment) {
      return { type: "cash_payment", id: payment.operationId, payment };
    }
    const deposit =
      settings.deposits.find((entry) => entry.status === "ACTIVE") ?? null;
    if (deposit) {
      return { type: "deposit", id: deposit.operationId, deposit };
    }
    return null;
  }

  function throwBlocked(blocker) {
    throw new HttpError(
      409,
      "Cassa automatica occupata: completa l'operazione in corso.",
      {
        code:
          blocker?.type === "cash_movement"
            ? "CASH_MOVEMENT_ACTIVE"
            : "CASH_GATEWAY_LOCKED",
        details: {
          operationType: blocker?.type ?? "unknown",
          operationId: blocker?.id ?? null,
        },
      },
    );
  }

  function requireGatewayMethod(method, message) {
    if (
      automaticCashGateway?.configured !== true ||
      typeof automaticCashGateway?.[method] !== "function"
    ) {
      throw new HttpError(503, message, {
        code: "CASH_GATEWAY_UNREACHABLE",
      });
    }
  }

  function buildMovement(payload, context, type, patch = {}) {
    const nowMs = nowMsFromIso(nowIso);
    const movement = sanitizeCashMovement({
      movementId: `cashmov_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      clientRequestId: normalizeText(payload.clientRequestId, 160),
      type,
      status: "STARTING",
      requestedAmountCents:
        type === "withdrawal" ? Number(payload.amountCents) : 0,
      amountCents: type === "withdrawal" ? Number(payload.amountCents) : 0,
      justification: normalizeText(payload.justification, 500),
      ownerUserId: context.user?.id,
      ownerFullName: userDisplayName(context.user),
      ownerDeviceUuid:
        context.session?.deviceUuid ?? normalizeText(payload.deviceUuid, 160),
      ownerSessionId: context.session?.id,
      activityId: payload.activityId,
      roomId: payload.roomId,
      roomName: payload.roomName,
      startedAtMs: nowMs,
      updatedAtMs: nowMs,
      ...patch,
    });
    return (
      appendCashMovementAuditEvent(
        movement,
        "cash_movement.created",
        { type, ownerUserId: context.user?.id ?? "" },
        nowMs,
      ) ?? movement
    );
  }

  function transitionOrConflict(movement, status, patch = {}) {
    try {
      return transitionCashMovement(movement, status, patch);
    } catch (error) {
      throw new HttpError(409, error.message, {
        code: error.code || "CASH_MOVEMENT_STEP_CONFLICT",
      });
    }
  }

  function withAudit(
    movement,
    action,
    details = {},
    atMs = nowMsFromIso(nowIso),
  ) {
    return (
      appendCashMovementAuditEvent(movement, action, details, atMs) ??
      movement
    );
  }

  function findMovement(settings, movementId) {
    return (
      settings.cashMovements.find(
        (entry) => entry.movementId === normalizeText(movementId, 120),
      ) ?? null
    );
  }

  function movementSnapshot(movement, roots = []) {
    const pieces = extractCashMovementPiecesFromGateway(...roots);
    const piecesTotalCents = sumCashMovementPieces(pieces);
    const amountCents =
      piecesTotalCents > 0
        ? piecesTotalCents
        : readDepositedTotalCents(
            roots[0],
            roots.slice(1),
            movement.amountCents,
            { minCachedAtMs: movement.startedAtMs },
          );
    return {
      amountCents: Math.max(0, Number(amountCents) || 0),
      pieces:
        Object.keys(pieces).length > 0 ? pieces : movement.pieces,
    };
  }

  async function closeLoadAtGateway(movement) {
    requireGatewayMethod(
      "closeReplenishment",
      "Chiusura caricamento non disponibile.",
    );
    const preCloseState =
      typeof automaticCashGateway.getState === "function"
        ? await automaticCashGateway.getState().catch(() => null)
        : null;
    let gatewayClose;
    try {
      gatewayClose = await automaticCashGateway.closeReplenishment();
    } catch (error) {
      throw new HttpError(503, "Chiusura caricamento non riuscita.", {
        code: "CASH_GATEWAY_UNREACHABLE",
        details: errorDetails(error),
      });
    }
    return movementSnapshot(movement, [
      gatewayClose?.payload,
      preCloseState,
      gatewayClose?.state,
    ]);
  }

  async function handleStart(req, res) {
    return runCritical(() => handleStartInner(req, res));
  }

  async function handleStartInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    requireOperator(context.user);
    const type = normalizeText(payload.type, 40).toLowerCase();
    if (!["load", "withdrawal"].includes(type)) {
      throw new HttpError(400, "Tipo movimento cassa non valido.", {
        code: "BAD_REQUEST",
      });
    }
    const justification = normalizeText(payload.justification, 500);
    if (justification.length < 3) {
      throw new HttpError(400, "Inserisci una giustificazione.", {
        code: "CASH_MOVEMENT_JUSTIFICATION_REQUIRED",
      });
    }
    const clientRequestId = normalizeText(payload.clientRequestId, 160);
    if (!clientRequestId) {
      throw new HttpError(400, "Identificativo richiesta mancante.", {
        code: "BAD_REQUEST",
      });
    }
    const baseSettings = sanitizeDbSettings(db).automaticCash;
    const existing = baseSettings.cashMovements.find(
      (entry) => entry.clientRequestId === clientRequestId,
    );
    if (existing) {
      assertMovementAccess(existing, context);
      sendJson(res, 200, {
        ok: true,
        resumed: true,
        movement: publicCashMovement(existing, publicContext(context)),
      });
      return;
    }
    const activeMovement = getActiveCashMovement(baseSettings);
    if (activeMovement) {
      if (
        activeMovement.type === type &&
        cashMovementOwnerMatchesContext(activeMovement, context)
      ) {
        sendJson(res, 200, {
          ok: true,
          resumed: true,
          movement: publicCashMovement(
            activeMovement,
            publicContext(context),
          ),
        });
        return;
      }
      throwBlocked({
        type: "cash_movement",
        id: activeMovement.movementId,
        movement: activeMovement,
      });
    }
    const blocker = blockingOperation(baseSettings);
    if (blocker) throwBlocked(blocker);

    if (type === "load") {
      requireGatewayMethod(
        "startReplenishment",
        "Caricamento non disponibile: gateway non raggiungibile.",
      );
      let movement = buildMovement(payload, context, type, {
        justification,
      });
      movement = await persistMovement(db, baseSettings, movement);
      try {
        await automaticCashGateway.startReplenishment();
      } catch (error) {
        const failed = transitionOrConflict(movement, "FAILED", {
          error: errorDetails(error).message,
          updatedAtMs: nowMsFromIso(nowIso),
        });
        await persistMovement(db, baseSettings, failed);
        throw new HttpError(503, "Avvio caricamento non riuscito.", {
          code: "CASH_GATEWAY_UNREACHABLE",
          details: errorDetails(error),
        });
      }
      const activatedAtMs = nowMsFromIso(nowIso);
      const active = withAudit(
        transitionOrConflict(movement, "ACTIVE", {
          updatedAtMs: activatedAtMs,
        }),
        "cash_movement.load_started",
        {},
        activatedAtMs,
      );
      const saved = await persistMovement(db, baseSettings, active);
      sendJson(res, 200, {
        ok: true,
        movement: publicCashMovement(saved, publicContext(context)),
      });
      return;
    }

    const gatewayInventory = await refreshGatewayInventory(baseSettings, {
      required: true,
    });
    const current = withRuntimeGateway(baseSettings, gatewayInventory);
    const availability = buildCashWithdrawalAvailability(current);
    const requestedPieces =
      payload.pieces && typeof payload.pieces === "object"
        ? payload.pieces
        : null;
    const selection = requestedPieces
      ? validateCashWithdrawalPieces(requestedPieces, availability)
      : selectCashWithdrawalPieces(Number(payload.amountCents), availability);
    if (!selection.ok) {
      throw new HttpError(409, selection.error, {
        code: selection.code,
      });
    }
    const amountCents = selection.totalCents;
    requireGatewayMethod(
      "executeWithdrawal",
      "Prelievo non disponibile: gateway non raggiungibile.",
    );
    let movement = buildMovement(payload, context, type, {
      amountCents,
      requestedAmountCents: amountCents,
      pieces: selection.pieces,
      justification,
    });
    movement = await persistMovement(db, current, movement);
    try {
      await automaticCashGateway.executeWithdrawal({
        pieces: selection.pieces,
        note: `Prelievo ${movement.movementId}: ${justification}`,
      });
    } catch (error) {
      const failed = transitionOrConflict(movement, "FAILED", {
        error: errorDetails(error).message,
        updatedAtMs: nowMsFromIso(nowIso),
      });
      await persistMovement(db, current, failed);
      throw new HttpError(503, "Erogazione prelievo non riuscita.", {
        code: "CASH_GATEWAY_UNREACHABLE",
        details: errorDetails(error),
      });
    }
    const waitingAtMs = nowMsFromIso(nowIso);
    const waiting = withAudit(
      transitionOrConflict(movement, "WAITING_CASH_REMOVAL", {
        updatedAtMs: waitingAtMs,
      }),
      "cash_movement.withdrawal_dispensed",
      {
        amountCents,
        piecesCount: Object.values(selection.pieces).reduce(
          (sum, quantity) => sum + Number(quantity),
          0,
        ),
      },
      waitingAtMs,
    );
    const saved = await persistMovement(db, current, waiting);
    sendJson(res, 200, {
      ok: true,
      movement: publicCashMovement(saved, publicContext(context)),
    });
  }

  async function handleComplete(req, res) {
    return runCritical(() => handleCompleteInner(req, res));
  }

  async function handlePrepare(req, res) {
    return runCritical(() => handlePrepareInner(req, res));
  }

  async function handlePrepareInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    requireOperator(context.user);
    const current = sanitizeDbSettings(db).automaticCash;
    const movementId = normalizeText(
      req.params?.movementId ?? payload.movementId,
      120,
    );
    const movement = findMovement(current, movementId);
    if (!movement) {
      throw new HttpError(404, "Movimento cassa non trovato.", {
        code: "AUTOMATIC_CASH_OPERATION_NOT_FOUND",
      });
    }
    assertMovementAccess(movement, context);
    if (movement.type !== "load") {
      throw new HttpError(409, "Il riepilogo e' previsto per il caricamento.", {
        code: "CASH_MOVEMENT_STEP_CONFLICT",
      });
    }
    if (
      ["REVIEW_REQUIRED", "WAITING_REPORT", "COMPLETED"].includes(
        movement.status,
      )
    ) {
      sendJson(res, 200, {
        ok: true,
        resumed: true,
        movement: publicCashMovement(movement, publicContext(context)),
      });
      return;
    }
    if (movement.status !== "ACTIVE") {
      throw new HttpError(409, "Caricamento non pronto per il riepilogo.", {
        code: "CASH_MOVEMENT_STEP_CONFLICT",
      });
    }

    const snapshot = await closeLoadAtGateway(movement);
    const preparedAtMs = nowMsFromIso(nowIso);
    const review = withAudit(
      transitionOrConflict(movement, "REVIEW_REQUIRED", {
        ...snapshot,
        preparedAtMs,
        physicalCompletedAtMs: preparedAtMs,
        updatedAtMs: preparedAtMs,
        error: null,
      }),
      "cash_movement.load_review_ready",
      {
        amountCents: snapshot.amountCents,
        piecesCount: Object.values(snapshot.pieces).reduce(
          (sum, quantity) => sum + Number(quantity),
          0,
        ),
      },
      preparedAtMs,
    );
    const saved = await persistMovement(db, current, review, preparedAtMs);
    sendJson(res, 200, {
      ok: true,
      movement: publicCashMovement(saved, publicContext(context)),
    });
  }

  async function handleCompleteInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    requireOperator(context.user);
    const current = sanitizeDbSettings(db).automaticCash;
    const movementId = normalizeText(
      req.params?.movementId ?? payload.movementId,
      120,
    );
    const movement = findMovement(current, movementId);
    if (!movement) {
      throw new HttpError(404, "Movimento cassa non trovato.", {
        code: "AUTOMATIC_CASH_OPERATION_NOT_FOUND",
      });
    }
    assertMovementAccess(movement, context);
    if (movement.status === "COMPLETED") {
      sendJson(res, 200, {
        ok: true,
        movement: publicCashMovement(movement, publicContext(context)),
      });
      return;
    }
    if (movement.status === "WAITING_REPORT") {
      sendJson(res, 200, {
        ok: true,
        resumed: true,
        movement: publicCashMovement(movement, publicContext(context)),
      });
      return;
    }
    if (isTerminalStatus(movement.status)) {
      throw new HttpError(409, "Il movimento cassa e' gia concluso.", {
        code: "CASH_MOVEMENT_STEP_CONFLICT",
      });
    }

    const awaitingReport = payload.awaitingReport === true;
    const completedAtMs = nowMsFromIso(nowIso);
    let working = movement;
    let amountCents = movement.amountCents;
    if (movement.type === "load") {
      if (working.status === "ACTIVE") {
        const snapshot = await closeLoadAtGateway(working);
        working = transitionOrConflict(working, "REVIEW_REQUIRED", {
          ...snapshot,
          preparedAtMs: completedAtMs,
          physicalCompletedAtMs: completedAtMs,
          updatedAtMs: completedAtMs,
        });
      }
      if (working.status !== "REVIEW_REQUIRED") {
        throw new HttpError(409, "Caricamento non pronto per la conferma.", {
          code: "CASH_MOVEMENT_STEP_CONFLICT",
        });
      }
      amountCents = working.amountCents;
    } else {
      if (working.status !== "WAITING_CASH_REMOVAL") {
        throw new HttpError(409, "Prelievo non pronto per la conferma.", {
          code: "CASH_MOVEMENT_STEP_CONFLICT",
        });
      }
      requireGatewayMethod(
        "confirmWithdrawalRemoved",
        "Conferma prelievo non disponibile.",
      );
      try {
        await automaticCashGateway.confirmWithdrawalRemoved();
      } catch (error) {
        throw new HttpError(503, "Conferma ritiro contanti non riuscita.", {
          code: "CASH_GATEWAY_UNREACHABLE",
          details: errorDetails(error),
        });
      }
      amountCents =
        movement.requestedAmountCents || movement.amountCents;
      working = sanitizeCashMovement({
        ...working,
        cashRemovedAtMs: completedAtMs,
        physicalCompletedAtMs: completedAtMs,
        updatedAtMs: completedAtMs,
      });
    }
    const targetStatus = awaitingReport ? "WAITING_REPORT" : "COMPLETED";
    const reportText = buildCashMovementReportText({
      ...working,
      amountCents,
      physicalCompletedAtMs:
        working.physicalCompletedAtMs ?? completedAtMs,
    });
    const completed = withAudit(
      transitionOrConflict(working, targetStatus, {
        amountCents,
        physicalCompletedAtMs:
          working.physicalCompletedAtMs ?? completedAtMs,
        ...(targetStatus === "COMPLETED" ? { completedAtMs } : {}),
        reportText,
        updatedAtMs: completedAtMs,
        error: null,
      }),
      awaitingReport
        ? "cash_movement.report_pending"
        : "cash_movement.completed",
      { amountCents },
      completedAtMs,
    );
    const saved = await persistMovement(
      db,
      current,
      completed,
      completedAtMs,
    );
    sendJson(res, 200, {
      ok: true,
      movement: publicCashMovement(saved, publicContext(context)),
    });
  }

  async function handleState(req, res) {
    const db = await readDb();
    const context = requestContext(req, db, req.__authPayload ?? {});
    requireOperator(context.user);
    const current = sanitizeDbSettings(db).automaticCash;
    const movement = findMovement(current, req.params?.movementId);
    if (!movement) {
      throw new HttpError(404, "Movimento cassa non trovato.", {
        code: "AUTOMATIC_CASH_OPERATION_NOT_FOUND",
      });
    }
    assertMovementAccess(movement, context);
    let latest = movement;
    let gatewayReachable = true;
    let gatewayError = null;
    if (
      movement.type === "load" &&
      movement.status === "ACTIVE" &&
      typeof automaticCashGateway?.getState === "function"
    ) {
      try {
        const gatewayState = await automaticCashGateway.getState();
        const snapshot = movementSnapshot(movement, [gatewayState]);
        if (
          snapshot.amountCents !== movement.amountCents ||
          JSON.stringify(snapshot.pieces) !== JSON.stringify(movement.pieces)
        ) {
          const observedAtMs = nowMsFromIso(nowIso);
          latest = withAudit(
            sanitizeCashMovement({
              ...movement,
              ...snapshot,
              updatedAtMs: observedAtMs,
            }),
            "cash_movement.load_progress",
            { amountCents: snapshot.amountCents },
            observedAtMs,
          );
          latest = await persistMovement(
            db,
            current,
            latest,
            observedAtMs,
          );
        }
      } catch (error) {
        gatewayReachable = false;
        gatewayError = errorDetails(error).message;
      }
    }
    sendJson(res, 200, {
      ok: true,
      gatewayReachable,
      gatewayError,
      movement: publicCashMovement(latest, publicContext(context)),
    });
  }

  async function handleWithdrawalAvailability(req, res) {
    const db = await readDb();
    const context = requestContext(req, db, req.__authPayload ?? {});
    requireOperator(context.user);
    const baseSettings = sanitizeDbSettings(db).automaticCash;
    const blocker = blockingOperation(baseSettings);
    if (blocker) throwBlocked(blocker);
    const gatewayInventory = await refreshGatewayInventory(baseSettings, {
      required: true,
    });
    const current = withRuntimeGateway(baseSettings, gatewayInventory);
    const denominations = buildCashWithdrawalAvailability(current);
    sendJson(res, 200, {
      ok: true,
      denominations,
      totalAvailableCents: denominations.reduce(
        (sum, entry) => sum + entry.cents * entry.availablePieces,
        0,
      ),
      updatedAtMs: Number(gatewayInventory?.updatedAtMs) || Date.now(),
    });
  }

  async function handlePrint(req, res) {
    return runCritical(() => handlePrintInner(req, res));
  }

  async function handlePrintInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    requireOperator(context.user);
    const current = sanitizeDbSettings(db).automaticCash;
    const movementId = normalizeText(
      req.params?.movementId ?? payload.movementId,
      120,
    );
    const movement = findMovement(current, movementId);
    if (!movement) {
      throw new HttpError(404, "Movimento cassa non trovato.", {
        code: "AUTOMATIC_CASH_OPERATION_NOT_FOUND",
      });
    }
    assertMovementAccess(movement, context);
    if (!["WAITING_REPORT", "COMPLETED"].includes(movement.status)) {
      throw new HttpError(409, "Report non ancora pronto per la stampa.", {
        code: "CASH_MOVEMENT_STEP_CONFLICT",
      });
    }
    const printRequestId = normalizeText(payload.clientRequestId, 180);
    if (!printRequestId) {
      throw new HttpError(400, "Identificativo richiesta stampa mancante.", {
        code: "BAD_REQUEST",
      });
    }
    if (
      movement.reportPrintRequestId === printRequestId &&
      movement.reportPrintJobId
    ) {
      sendJson(res, 200, {
        ok: true,
        deduplicated: true,
        movement: publicCashMovement(movement, publicContext(context)),
        printJob: { id: movement.reportPrintJobId },
      });
      return;
    }
    if (typeof enqueuePrintSpoolJob !== "function") {
      throw new HttpError(503, "Servizio di stampa report non disponibile.", {
        code: "CASH_MOVEMENT_REPORT_PRINT_UNAVAILABLE",
      });
    }

    const reportText =
      movement.reportText || buildCashMovementReportText(movement);
    let printJob;
    try {
      printJob = await enqueuePrintSpoolJob({
        kind: "preconto",
        precontoProfile: "cash",
        orderId: movement.movementId,
        text: reportText,
        userId: context.user?.id,
        deviceUuid:
          context.session?.deviceUuid ?? movement.ownerDeviceUuid,
        clientApp: "mobile-cash-movement",
        activityId: movement.activityId || undefined,
        roomId: movement.roomId || undefined,
        operationalSchemaVersion:
          movement.activityId && movement.roomId ? 2 : undefined,
        ignoreWorkstationRouting: true,
      });
    } catch (error) {
      throw new HttpError(503, "Stampa report movimento non riuscita.", {
        code: "CASH_MOVEMENT_REPORT_PRINT_UNAVAILABLE",
        details: errorDetails(error),
      });
    }
    if (["disabled", "failed_configuration", "failed"].includes(printJob?.status)) {
      throw new HttpError(503, "Stampante report non disponibile.", {
        code: "CASH_MOVEMENT_REPORT_PRINT_UNAVAILABLE",
        details: {
          printJobId: printJob?.id ?? null,
          status: printJob?.status ?? null,
        },
      });
    }

    const printedAtMs = nowMsFromIso(nowIso);
    const wasReprint =
      payload.reprint === true || movement.reportPrintCount > 0;
    const completed =
      movement.status === "WAITING_REPORT"
        ? transitionOrConflict(movement, "COMPLETED", {
            completedAtMs: printedAtMs,
            updatedAtMs: printedAtMs,
          })
        : movement;
    const updated = withAudit(
      sanitizeCashMovement({
        ...completed,
        reportText,
        reportPrintCount: movement.reportPrintCount + 1,
        reportPrintJobId: printJob.id,
        reportPrintRequestId: printRequestId,
        reportPrintedAtMs: printedAtMs,
        updatedAtMs: printedAtMs,
      }),
      wasReprint
        ? "cash_movement.report_reprinted"
        : "cash_movement.report_printed",
      { printJobId: printJob.id },
      printedAtMs,
    );
    const saved = await persistMovement(
      db,
      current,
      updated,
      printedAtMs,
    );
    sendJson(res, 200, {
      ok: true,
      movement: publicCashMovement(saved, publicContext(context)),
      printJob: {
        id: printJob.id,
        status: printJob.status,
        printerId: printJob.printerId,
        printerName: printJob.printerName,
      },
    });
  }

  async function handleCancel(req, res) {
    return runCritical(() => handleCancelInner(req, res));
  }

  async function handleCancelInner(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const context = requestContext(req, db, payload);
    requireOperator(context.user);
    const current = sanitizeDbSettings(db).automaticCash;
    const movementId = normalizeText(
      req.params?.movementId ?? payload.movementId,
      120,
    );
    const movement = findMovement(current, movementId);
    if (!movement) {
      sendJson(res, 200, { ok: true, movement: null });
      return;
    }
    assertMovementAccess(movement, context);
    if (isTerminalStatus(movement.status)) {
      sendJson(res, 200, {
        ok: true,
        movement: publicCashMovement(movement, publicContext(context)),
      });
      return;
    }
    if (movement.type !== "load") {
      throw new HttpError(
        409,
        "Il prelievo erogato deve essere ritirato e confermato.",
        {
          code: "CASH_MOVEMENT_STEP_CONFLICT",
        },
      );
    }
    if (!["STARTING", "ACTIVE"].includes(movement.status)) {
      throw new HttpError(
        409,
        "Il caricamento e' gia stato acquisito e deve essere completato.",
        {
          code: "CASH_MOVEMENT_STEP_CONFLICT",
        },
      );
    }
    requireGatewayMethod(
      "cancelReplenishment",
      "Annullamento caricamento non disponibile.",
    );
    try {
      await automaticCashGateway.cancelReplenishment();
    } catch (error) {
      throw new HttpError(503, "Annullamento caricamento non riuscito.", {
        code: "CASH_GATEWAY_UNREACHABLE",
        details: errorDetails(error),
      });
    }
    const cancelledAtMs = nowMsFromIso(nowIso);
    const cancelled = withAudit(
      transitionOrConflict(movement, "CANCELLED", {
        cancelledAtMs,
        updatedAtMs: cancelledAtMs,
      }),
      "cash_movement.cancelled",
      {},
      cancelledAtMs,
    );
    const saved = await persistMovement(
      db,
      current,
      cancelled,
      cancelledAtMs,
    );
    sendJson(res, 200, {
      ok: true,
      movement: publicCashMovement(saved, publicContext(context)),
    });
  }

  async function handleActive(req, res) {
    const db = await readDb();
    const context = requestContext(req, db, req.__authPayload ?? {});
    requireOperator(context.user);
    const current = sanitizeDbSettings(db).automaticCash;
    const movement = getActiveCashMovement(current);
    sendJson(res, 200, {
      ok: true,
      activeMovement: publicCashMovement(
        movement,
        publicContext(context),
      ),
    });
  }

  function exchangeMovement(exchange) {
    const amountCents = Math.max(
      0,
      Number(exchange.depositedCents ?? exchange.selectedTotalCents) || 0,
    );
    return {
      movementId: `exchange:${exchange.exchangeId}`,
      sourceId: exchange.exchangeId,
      type: "exchange",
      status: exchange.status,
      requestedAmountCents: amountCents,
      amountCents,
      signedAmountCents: 0,
      justification: "Cambio contanti",
      ownerUserId: exchange.ownerUserId,
      ownerFullName: exchange.ownerFullName,
      ownerDeviceUuid: exchange.ownerDeviceUuid,
      activityId: exchange.activityId,
      roomId: exchange.roomId,
      roomName: "",
      startedAtMs: exchange.startedAtMs,
      updatedAtMs: exchange.updatedAtMs,
      completedAtMs: exchange.completedAtMs,
      error: exchange.error ?? null,
      resumableByCurrentUser: false,
    };
  }

  async function handleList(req, res) {
    const db = await readDb();
    const context = requestContext(req, db, req.__authPayload ?? {});
    if (
      !canManageAutomaticCash(context.user) &&
      !hasPermission(context.user, "view_analytics")
    ) {
      throw new HttpError(403, "Utente non autorizzato alle statistiche cassa.", {
        code: "CASH_MOVEMENT_PERMISSION_DENIED",
      });
    }
    const current = sanitizeDbSettings(db).automaticCash;
    const canViewAll =
      canManageAutomaticCash(context.user) ||
      hasPermission(context.user, "view_analytics");
    const explicit = current.cashMovements
      .filter(
        (movement) =>
          canViewAll || cashMovementOwnerMatchesContext(movement, context),
      )
      .map((movement) =>
        publicCashMovement(movement, publicContext(context)),
      )
      .filter(Boolean);
    const exchanges = current.cashExchanges
      .filter((exchange) => exchange.status === "COMPLETED")
      .filter(
        (exchange) =>
          canViewAll ||
          cashMovementOwnerMatchesContext(
            {
              movementId: exchange.exchangeId,
              type: "load",
              status: "COMPLETED",
              ownerUserId: exchange.ownerUserId,
              ownerDeviceUuid: exchange.ownerDeviceUuid,
              ownerSessionId: exchange.ownerSessionId,
              startedAtMs: exchange.startedAtMs,
              updatedAtMs: exchange.updatedAtMs,
            },
            context,
          ),
      )
      .map(exchangeMovement);
    const movements = [...explicit, ...exchanges]
      .sort(
        (left, right) =>
          Number(right.completedAtMs ?? right.startedAtMs) -
          Number(left.completedAtMs ?? left.startedAtMs),
      )
      .slice(0, 300);
    sendJson(res, 200, {
      ok: true,
      movements,
      count: movements.length,
    });
  }

  return {
    "automaticCash.cashMovements": handleList,
    "automaticCash.activeCashMovement": handleActive,
    "automaticCash.cashMovementState": handleState,
    "automaticCash.cashMovementWithdrawalAvailability":
      handleWithdrawalAvailability,
    "automaticCash.startCashMovement": handleStart,
    "automaticCash.prepareCashMovement": handlePrepare,
    "automaticCash.completeCashMovement": handleComplete,
    "automaticCash.printCashMovementReport": handlePrint,
    "automaticCash.cancelCashMovement": handleCancel,
  };
}
