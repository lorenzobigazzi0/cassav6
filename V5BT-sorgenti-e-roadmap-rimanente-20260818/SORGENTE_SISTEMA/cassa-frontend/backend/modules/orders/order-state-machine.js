export const INTEGRATION_WORKFLOW_RANK = Object.freeze({
  waiting: 0,
  prep: 1,
  ready: 2,
  delivered: 3,
});

export const INVALID_ORDER_STATUS_TRANSITION_CODE = "INVALID_ORDER_STATUS_TRANSITION";
export const INVALID_ORDER_STATE_TRANSITION_CODE = "INVALID_ORDER_STATE_TRANSITION";

export const ORDER_STATE_MACHINE_STATES = Object.freeze([
  "draft",
  "emitted",
  "queued",
  "preparing",
  "ready",
  "delivered",
  "partially_paid",
  "paid",
  "cancelled",
  "corrected",
  "compensated",
]);

const ORDER_STATE_SET = new Set(ORDER_STATE_MACHINE_STATES);

export const ORDER_STATE_MACHINE_TRANSITIONS = Object.freeze({
  draft: new Set(["emitted", "cancelled"]),
  emitted: new Set(["queued", "preparing", "cancelled", "corrected"]),
  queued: new Set(["preparing", "ready", "cancelled", "corrected", "compensated"]),
  preparing: new Set(["ready", "cancelled", "corrected", "compensated"]),
  ready: new Set(["delivered", "cancelled", "corrected", "compensated"]),
  delivered: new Set(["partially_paid", "paid", "corrected", "compensated"]),
  partially_paid: new Set(["paid", "corrected", "compensated"]),
  paid: new Set(["corrected", "compensated"]),
  cancelled: new Set([]),
  corrected: new Set([]),
  compensated: new Set([]),
});

function normalizeWorkflowStatusKey(workflow) {
  return String(workflow ?? "").trim().toLowerCase();
}

function normalizeOrderStateKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function isOrderState(value) {
  return ORDER_STATE_SET.has(normalizeOrderStateKey(value));
}

export function normalizeOrderState(value, fallback = "draft") {
  const normalized = normalizeOrderStateKey(value).replace(/[\s-]+/g, "_");
  if (ORDER_STATE_SET.has(normalized)) return normalized;
  if (["waiting", "wait", "pending", "queue", "in_coda"].includes(normalized)) return "queued";
  if (["prep", "in_preparazione", "preparation"].includes(normalized)) return "preparing";
  if (["done", "consegnato", "consegnata"].includes(normalized)) return "delivered";
  if (["partial", "partially_paid", "pagata_parziale"].includes(normalized)) return "partially_paid";
  if (["paid", "pagata", "settled"].includes(normalized)) return "paid";
  if (["cancelled", "canceled", "annullata", "voided"].includes(normalized)) return "cancelled";
  if (["correct", "correction", "corrected", "rettificata"].includes(normalized)) return "corrected";
  if (["comp", "compensated", "stornata", "reso"].includes(normalized)) return "compensated";
  const safeFallback = normalizeOrderStateKey(fallback);
  return ORDER_STATE_SET.has(safeFallback) ? safeFallback : "draft";
}

export function canTransitionOrderState(fromState, toState, context = {}) {
  const from = normalizeOrderState(fromState);
  const to = normalizeOrderStateKey(toState).replace(/[\s-]+/g, "_");
  if (!ORDER_STATE_SET.has(to)) return false;
  if (from === to) return true;
  if (
    context.allowPreparationDemotion === true &&
    from === "preparing" &&
    to === "queued"
  ) {
    return true;
  }
  if (context.allowOverride === true) {
    return Boolean(String(context.overrideReason ?? "").trim());
  }
  return ORDER_STATE_MACHINE_TRANSITIONS[from]?.has(to) === true;
}

export function getOrderStateTransitionViolation(fromState, toState, context = {}) {
  if (canTransitionOrderState(fromState, toState, context)) return null;
  const from = normalizeOrderState(fromState);
  const toCandidate = normalizeOrderStateKey(toState).replace(/[\s-]+/g, "_");
  return {
    code: INVALID_ORDER_STATE_TRANSITION_CODE,
    message: `Transizione ordine non ammessa: ${from} -> ${
      ORDER_STATE_SET.has(toCandidate)
        ? toCandidate
        : String(toState ?? "").trim() || "(vuoto)"
    }`,
    details: {
      previousState: from,
      nextState: ORDER_STATE_SET.has(toCandidate) ? toCandidate : null,
    },
  };
}

export function assertOrderStateTransitionAllowed(fromState, toState, context = {}) {
  const violation = getOrderStateTransitionViolation(fromState, toState, context);
  if (!violation) return true;
  const error = new Error(violation.message);
  error.code = violation.code;
  error.details = violation.details;
  throw error;
}

function resolveCurrentOrderState(order) {
  if (!order || typeof order !== "object") return normalizeOrderState(order);
  if (isOrderState(order.orderState)) return normalizeOrderState(order.orderState);
  return resolveOrderRuntimeState(order).orderState;
}

export function applyOrderStateTransition(order, toState, context = {}) {
  const previousState = resolveCurrentOrderState(order);
  assertOrderStateTransitionAllowed(previousState, toState, context);
  const nextState = normalizeOrderState(toState, previousState);
  if (!order || typeof order !== "object") return nextState;
  const now =
    typeof context.nowIso === "function"
      ? context.nowIso()
      : typeof context.now === "function"
        ? context.now()
        : new Date().toISOString();
  return {
    ...order,
    orderState: nextState,
    orderStateUpdatedAt: now,
  };
}

export function resolveOrderRuntimeState(order = {}) {
  if (!order || typeof order !== "object") {
    return { orderState: normalizeOrderState(order), path: [normalizeOrderState(order)] };
  }
  const completedAtNumber = Number(order.completedAtMs);
  const completedAtMs =
    order.completedAtMs === null || order.completedAtMs === undefined
      ? null
      : Number.isFinite(completedAtNumber)
        ? completedAtNumber
        : null;
  const workflowStatus = normalizeIntegrationWorkflowStatus(
    order.workflowStatus ?? order.status,
    order.items,
    completedAtMs,
    { lineRoutes: order.lineRoutes },
  );
  const paymentStatus = String(order.paymentStatus ?? "").trim().toLowerCase();
  const correctionStatus = String(order.correctionStatus ?? "").trim().toLowerCase();
  const operationType = String(
    order.operationType ?? order.requestedOperationType ?? order.financialImpact ?? "",
  ).trim().toLowerCase();

  if (isCancelledIntegrationWorkflowStatus(workflowStatus)) {
    return { orderState: "cancelled", path: ["draft", "emitted", "queued", "cancelled"] };
  }
  if (correctionStatus === "corrected" || operationType.includes("correction")) {
    return { orderState: "corrected", path: ["draft", "emitted", "queued", "corrected"] };
  }
  if (
    correctionStatus === "compensated" ||
    operationType.includes("comp") ||
    operationType.includes("storno") ||
    operationType.includes("reso")
  ) {
    return { orderState: "compensated", path: ["draft", "emitted", "queued", "compensated"] };
  }

  const path = ["draft", "emitted"];
  if (workflowStatus === "waiting") path.push("queued");
  else if (workflowStatus === "prep") path.push("queued", "preparing");
  else if (workflowStatus === "ready") path.push("queued", "preparing", "ready");
  else if (workflowStatus === "delivered") path.push("queued", "preparing", "ready", "delivered");
  else path.push("queued");

  if (paymentStatus === "partial") path.push("partially_paid");
  if (paymentStatus === "paid") {
    if (path[path.length - 1] !== "delivered") path.push("delivered");
    path.push("paid");
  }

  return { orderState: path[path.length - 1], path };
}

export function resolveIntegrationWorkflowRank(workflow) {
  const normalized = normalizeWorkflowStatusKey(workflow);
  return Object.prototype.hasOwnProperty.call(INTEGRATION_WORKFLOW_RANK, normalized)
    ? INTEGRATION_WORKFLOW_RANK[normalized]
    : null;
}

export function getIntegrationWorkflowTransitionViolation(previousWorkflow, nextWorkflow, options = {}) {
  const previous = normalizeWorkflowStatusKey(previousWorkflow);
  const next = normalizeWorkflowStatusKey(nextWorkflow);
  const previousRank = resolveIntegrationWorkflowRank(previous);
  const nextRank = resolveIntegrationWorkflowRank(next);
  if (previousRank === null || nextRank === null || nextRank >= previousRank) return null;

  const allowPreparationDemotion =
    options?.allowPreparationDemotion === true &&
    previous === "prep" &&
    next === "waiting";
  if (allowPreparationDemotion) return null;

  return {
    code: INVALID_ORDER_STATUS_TRANSITION_CODE,
    details: {
      previousStatus: previous,
      nextStatus: next,
    },
    message: "Transizione stato comanda non valida.",
  };
}

export function isIntegrationWorkflowRegression(previousWorkflow, nextWorkflow) {
  const previousRank = resolveIntegrationWorkflowRank(previousWorkflow);
  const nextRank = resolveIntegrationWorkflowRank(nextWorkflow);
  return previousRank !== null && nextRank !== null && nextRank < previousRank;
}

export function hasIntegrationRouteTimestamp(route, fieldName) {
  return (
    route &&
    typeof route === "object" &&
    typeof route[fieldName] === "string" &&
    route[fieldName].trim().length > 0
  );
}

export function hasIntegrationRouteReadyProgress(route) {
  return (
    hasIntegrationRouteTimestamp(route, "readyAt") ||
    hasIntegrationRouteTimestamp(route, "deliveredAt") ||
    hasIntegrationRouteTimestamp(route, "pickedUpAt")
  );
}

export function isCancelledIntegrationWorkflowStatus(value) {
  return ["cancelled", "annullata", "voided"].includes(String(value ?? "").trim().toLowerCase());
}

export function normalizeIntegrationWorkflowStatus(value, items, completedAtMs, options = {}) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (isCancelledIntegrationWorkflowStatus(raw)) return "cancelled";
  if (raw === "done" || raw === "delivered" || raw === "consegnato" || raw === "paid" || raw === "pagata") {
    return "delivered";
  }
  if (
    raw === "ready" ||
    raw === "da_consegnare" ||
    raw === "da consegnare" ||
    raw === "pronto" ||
    raw === "pronta"
  ) {
    return "ready";
  }
  const rawIsPrep = raw === "prep" || raw === "in_preparazione" || raw === "in preparazione";
  const safeItems = Array.isArray(items) ? items : [];
  const safeRoutes = Array.isArray(options.lineRoutes) ? options.lineRoutes : [];
  const hasOwnerStation = typeof options.ownerStation === "string" && options.ownerStation.trim().length > 0;
  if (completedAtMs !== null || safeRoutes.some((route) => hasIntegrationRouteTimestamp(route, "deliveredAt"))) {
    return "delivered";
  }
  const hasAnyDoneProgress = safeItems.some((item) => {
    const qty = Math.max(Math.trunc(Number(item?.qty) || 0), 0);
    const doneQty = Math.max(Math.trunc(Number(item?.doneQty) || 0), 0);
    return item?.done === true || doneQty > 0 || (qty > 0 && doneQty >= qty);
  });
  const allItemsDone =
    safeItems.length > 0 &&
    safeItems.every((item) => {
      const qty = Math.max(Math.trunc(Number(item?.qty) || 0), 0);
      const doneQty = Math.max(Math.trunc(Number(item?.doneQty) || 0), 0);
      return item?.done === true || (qty > 0 && doneQty >= qty);
    });
  const hasAnyReceivedProgress = safeRoutes.some(
    (route) =>
      hasIntegrationRouteTimestamp(route, "receivedAt") ||
      hasIntegrationRouteTimestamp(route, "pickedUpAt")
  );
  const hasAnyReadyProgress = safeRoutes.some((route) => hasIntegrationRouteTimestamp(route, "readyAt"));
  const allRoutesReady =
    safeRoutes.length > 0 &&
    safeRoutes.every((route) => hasIntegrationRouteReadyProgress(route));
  if (allItemsDone || allRoutesReady) return "ready";
  if (rawIsPrep) return "prep";
  if (hasAnyDoneProgress || hasAnyReceivedProgress || hasAnyReadyProgress || hasOwnerStation) return "prep";
  return "waiting";
}

export function createIntegrationWorkflowStateMachine(options = {}) {
  const enabled = options.enabled !== false;
  const createTransitionError =
    typeof options.createTransitionError === "function"
      ? options.createTransitionError
      : (violation) => {
          const error = new Error(violation.message);
          error.code = violation.code;
          error.details = violation.details;
          return error;
        };

  function assertIntegrationWorkflowTransitionAllowed(previousWorkflow, nextWorkflow, assertOptions = {}) {
    if (!enabled) return true;
    const violation = getIntegrationWorkflowTransitionViolation(previousWorkflow, nextWorkflow, assertOptions);
    if (violation) {
      throw createTransitionError(violation);
    }
    return true;
  }

  return {
    applyTransition: applyOrderStateTransition,
    assertIntegrationWorkflowTransitionAllowed,
    assertTransitionAllowed: assertOrderStateTransitionAllowed,
    canTransition: canTransitionOrderState,
    getIntegrationWorkflowTransitionViolation,
    getOrderStateTransitionViolation,
    hasIntegrationRouteReadyProgress,
    hasIntegrationRouteTimestamp,
    isCancelledIntegrationWorkflowStatus,
    isIntegrationWorkflowRegression,
    normalizeIntegrationWorkflowStatus,
    normalizeOrderState,
    resolveOrderRuntimeState,
    resolveIntegrationWorkflowRank,
  };
}
