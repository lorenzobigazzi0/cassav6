export const PAYMENT_STATE_MACHINE_STATES = Object.freeze([
  "created",
  "pending_provider",
  "authorized",
  "settled",
  "fiscal_queued",
  "fiscal_ok",
  "fiscal_ko_retryable",
  "fiscal_ko_expired",
  "reversed",
]);

export const PAYMENT_STATE_MACHINE_TERMINAL_STATES = new Set([
  "fiscal_ok",
  "fiscal_ko_expired",
  "reversed",
]);

const PAYMENT_STATE_SET = new Set(PAYMENT_STATE_MACHINE_STATES);

export const PAYMENT_STATE_MACHINE_TRANSITIONS = Object.freeze({
  created: new Set(["pending_provider", "authorized", "settled"]),
  pending_provider: new Set(["authorized", "settled", "reversed"]),
  authorized: new Set(["settled", "reversed"]),
  settled: new Set(["fiscal_queued", "reversed"]),
  fiscal_queued: new Set([
    "fiscal_ok",
    "fiscal_ko_retryable",
    "fiscal_ko_expired",
    "reversed",
  ]),
  fiscal_ko_retryable: new Set(["fiscal_queued", "fiscal_ko_expired", "reversed"]),
  fiscal_ko_expired: new Set(["reversed"]),
  fiscal_ok: new Set(["reversed"]),
  reversed: new Set([]),
});

export const INVALID_PAYMENT_STATE_TRANSITION_CODE =
  "INVALID_PAYMENT_STATE_TRANSITION";

function normalizeStateKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function isPaymentState(value) {
  return PAYMENT_STATE_SET.has(normalizeStateKey(value));
}

export function normalizePaymentState(value, fallback = "created") {
  const normalized = normalizeStateKey(value);
  if (PAYMENT_STATE_SET.has(normalized)) return normalized;

  const legacy = normalized.replace(/[\s-]+/g, "_");
  if (["open", "unpaid", "new"].includes(legacy)) return "created";
  if (["pending", "pending_fiscal", "processing", "queued"].includes(legacy)) {
    return "fiscal_queued";
  }
  if (["paid", "completed", "complete", "settled"].includes(legacy)) {
    return "settled";
  }
  if (["issued", "fiscal_issued"].includes(legacy)) return "fiscal_ok";
  if (["retry", "failed_retryable", "requires_retry"].includes(legacy)) {
    return "fiscal_ko_retryable";
  }
  if (["expired", "failed_final", "failed_permanent"].includes(legacy)) {
    return "fiscal_ko_expired";
  }
  if (["voided", "void", "cancelled", "canceled", "refunded"].includes(legacy)) {
    return "reversed";
  }

  const normalizedFallback = normalizeStateKey(fallback);
  return PAYMENT_STATE_SET.has(normalizedFallback) ? normalizedFallback : "created";
}

export function canTransitionPaymentState(fromState, toState, context = {}) {
  const from = normalizePaymentState(fromState);
  const to = normalizeStateKey(toState);
  if (!PAYMENT_STATE_SET.has(to)) return false;
  if (from === to) return true;
  if (context.allowOverride === true) {
    return Boolean(String(context.overrideReason ?? "").trim());
  }
  return PAYMENT_STATE_MACHINE_TRANSITIONS[from]?.has(to) === true;
}

export function getPaymentStateTransitionViolation(fromState, toState, context = {}) {
  if (canTransitionPaymentState(fromState, toState, context)) return null;
  const from = normalizePaymentState(fromState);
  const toCandidate = normalizeStateKey(toState);
  return {
    code: INVALID_PAYMENT_STATE_TRANSITION_CODE,
    message: `Transizione pagamento non ammessa: ${from} -> ${
      PAYMENT_STATE_SET.has(toCandidate)
        ? toCandidate
        : String(toState ?? "").trim() || "(vuoto)"
    }`,
    details: {
      previousState: from,
      nextState: PAYMENT_STATE_SET.has(toCandidate) ? toCandidate : null,
    },
  };
}

export function assertPaymentStateTransitionAllowed(fromState, toState, context = {}) {
  const violation = getPaymentStateTransitionViolation(fromState, toState, context);
  if (!violation) return true;
  const error = new Error(violation.message);
  error.code = violation.code;
  error.details = violation.details;
  throw error;
}

function resolveCurrentPaymentState(payment) {
  if (payment && typeof payment === "object") {
    return normalizePaymentState(
      payment.paymentState ?? payment.state ?? payment.status ?? payment.paymentStatus,
      "created",
    );
  }
  return normalizePaymentState(payment, "created");
}

export function applyPaymentStateTransition(payment, toState, context = {}) {
  const previousState = resolveCurrentPaymentState(payment);
  assertPaymentStateTransitionAllowed(previousState, toState, context);
  const nextState = normalizePaymentState(toState, previousState);
  if (!payment || typeof payment !== "object") return nextState;
  const now =
    typeof context.nowIso === "function"
      ? context.nowIso()
      : typeof context.now === "function"
        ? context.now()
        : new Date().toISOString();
  return {
    ...payment,
    paymentState: nextState,
    paymentStateUpdatedAt: now,
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function normalizeFiscalStatus(value) {
  return String(value ?? "").trim().toUpperCase();
}

function fiscalResultStatus(result) {
  const receipt = result?.receipt && typeof result.receipt === "object"
    ? result.receipt
    : null;
  return normalizeFiscalStatus(
    result?.fiscalStatus ??
      result?.status ??
      receipt?.fiscalStatus ??
      receipt?.status,
  );
}

function hasRetryableFiscalResult(result) {
  return (
    result?.requiresRetry === true ||
    result?.requiresFiscalRetry === true ||
    result?.receipt?.requiresFiscalRetry === true ||
    result?.receipt?.requiresRetry === true
  );
}

function hasPendingFiscalResult(result) {
  if (result?.pending === true) return true;
  return ["PENDING", "PROCESSING", "QUEUED"].includes(fiscalResultStatus(result));
}

export function resolvePaymentFiscalState(fiscalResults = []) {
  const results = asArray(fiscalResults).filter(
    (result) => result && typeof result === "object" && result.skipped !== true,
  );
  if (results.length === 0) return "settled";
  if (results.some(hasPendingFiscalResult)) return "fiscal_queued";
  if (results.some(hasRetryableFiscalResult)) return "fiscal_ko_retryable";
  if (
    results.some((result) =>
      ["EXPIRED", "FAILED_FINAL", "FAILED_PERMANENT"].includes(fiscalResultStatus(result)),
    )
  ) {
    return "fiscal_ko_expired";
  }
  if (
    results.length > 0 &&
    results.every((result) => result.issued === true || fiscalResultStatus(result) === "ISSUED")
  ) {
    return "fiscal_ok";
  }
  return "settled";
}

export function buildPaymentStateProgression({
  providerRequired = false,
  providerAuthorized = false,
  settled = true,
  fiscalResults = [],
  reversed = false,
} = {}) {
  const path = ["created"];
  if (reversed) {
    const reverseFrom = providerRequired && !providerAuthorized ? "pending_provider" : "settled";
    if (reverseFrom !== "created") path.push(reverseFrom);
    path.push("reversed");
    return path;
  }
  if (providerRequired) path.push("pending_provider");
  if (providerAuthorized) path.push("authorized");
  if (settled) path.push("settled");
  const fiscalState = resolvePaymentFiscalState(fiscalResults);
  if (settled && fiscalState !== "settled") {
    path.push("fiscal_queued");
    if (fiscalState !== "fiscal_queued") path.push(fiscalState);
  }
  return path;
}

export function resolvePaymentRuntimeState(options = {}) {
  const path = buildPaymentStateProgression(options);
  for (let index = 1; index < path.length; index += 1) {
    assertPaymentStateTransitionAllowed(path[index - 1], path[index], {
      reason: options.reason ?? "runtime_projection",
    });
  }
  return {
    paymentState: path[path.length - 1],
    path,
  };
}

export function createPaymentStateMachine() {
  return {
    applyTransition: applyPaymentStateTransition,
    assertTransitionAllowed: assertPaymentStateTransitionAllowed,
    canTransition: canTransitionPaymentState,
    resolveRuntimeState: resolvePaymentRuntimeState,
  };
}
