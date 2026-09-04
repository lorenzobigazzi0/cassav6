export const INVALID_PRINT_STATE_TRANSITION_CODE = "INVALID_PRINT_STATE_TRANSITION";

export const PRINT_STATE_MACHINE_STATES = Object.freeze([
  "queued",
  "claimed",
  "sent",
  "confirmed",
  "failed_retryable",
  "failed_final",
]);

const PRINT_STATE_SET = new Set(PRINT_STATE_MACHINE_STATES);

export const PRINT_STATE_MACHINE_TRANSITIONS = Object.freeze({
  queued: new Set(["claimed", "failed_final"]),
  claimed: new Set(["sent", "failed_retryable", "failed_final"]),
  sent: new Set(["confirmed", "failed_retryable", "failed_final"]),
  confirmed: new Set([]),
  failed_retryable: new Set(["queued", "failed_final"]),
  failed_final: new Set([]),
});

function normalizePrintStateKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizePrintStateCandidate(value) {
  const normalized = normalizePrintStateKey(value);
  if (PRINT_STATE_SET.has(normalized)) return normalized;
  if (["processing", "in_progress", "locked"].includes(normalized)) return "claimed";
  if (["printed", "ok", "success", "issued"].includes(normalized)) return "confirmed";
  if (["failed", "retryable", "failed_retry"].includes(normalized)) return "failed_retryable";
  if (
    [
      "failed_configuration",
      "failed_config",
      "failed_permanent",
      "cancelled",
      "canceled",
      "disabled",
      "unknown_after_crash",
      "expired",
    ].includes(normalized)
  ) {
    return "failed_final";
  }
  return null;
}

export function isPrintState(value) {
  return PRINT_STATE_SET.has(normalizePrintStateKey(value));
}

export function normalizePrintState(value, fallback = "queued") {
  const candidate = normalizePrintStateCandidate(value);
  if (candidate) return candidate;
  const safeFallback = normalizePrintStateKey(fallback);
  return PRINT_STATE_SET.has(safeFallback) ? safeFallback : "queued";
}

export function canTransitionPrintState(fromState, toState, context = {}) {
  const from = normalizePrintState(fromState);
  const to = normalizePrintStateCandidate(toState);
  if (!to) return false;
  if (from === to) return true;
  if (from === "failed_retryable" && to === "queued") {
    return context.allowRetry === true || context.retry === true;
  }
  if (context.allowOverride === true) {
    return Boolean(String(context.overrideReason ?? "").trim());
  }
  return PRINT_STATE_MACHINE_TRANSITIONS[from]?.has(to) === true;
}

export function getPrintStateTransitionViolation(fromState, toState, context = {}) {
  if (canTransitionPrintState(fromState, toState, context)) return null;
  const from = normalizePrintState(fromState);
  const toCandidate = normalizePrintStateCandidate(toState);
  return {
    code: INVALID_PRINT_STATE_TRANSITION_CODE,
    message: `Transizione stampa non ammessa: ${from} -> ${
      toCandidate
        ? toCandidate
        : String(toState ?? "").trim() || "(vuoto)"
    }`,
    details: {
      previousState: from,
      nextState: toCandidate,
    },
  };
}

export function assertPrintStateTransitionAllowed(fromState, toState, context = {}) {
  const violation = getPrintStateTransitionViolation(fromState, toState, context);
  if (!violation) return true;
  const error = new Error(violation.message);
  error.code = violation.code;
  error.details = violation.details;
  throw error;
}

function normalizePrintStatePath(path, fallbackState) {
  const safePath = (Array.isArray(path) ? path : [])
    .map((entry) => normalizePrintStateCandidate(entry))
    .filter((entry) => entry !== null);
  if (safePath.length > 0) return safePath;
  return [normalizePrintState(fallbackState)];
}

export function resolvePrintRuntimeState(job = {}, context = {}) {
  if (!job || typeof job !== "object") {
    const state = normalizePrintState(job);
    return { printState: state, path: [state] };
  }
  const explicitState = isPrintState(job.printState)
    ? normalizePrintState(job.printState)
    : null;
  if (explicitState) {
    return {
      printState: explicitState,
      path: normalizePrintStatePath(job.printStatePath, explicitState),
    };
  }

  const status = normalizePrintStateKey(job.status);
  if (status === "queued") return { printState: "queued", path: ["queued"] };
  if (status === "processing") return { printState: "claimed", path: ["queued", "claimed"] };
  if (status === "sent") return { printState: "sent", path: ["queued", "claimed", "sent"] };
  if (status === "printed" || status === "confirmed") {
    return {
      printState: "confirmed",
      path: ["queued", "claimed", "sent", "confirmed"],
    };
  }
  if (status === "failed") {
    const retryable =
      context.retryable === true ||
      Boolean(String(job.nextRetryAt ?? "").trim());
    return {
      printState: retryable ? "failed_retryable" : "failed_final",
      path: [
        "queued",
        "claimed",
        "sent",
        retryable ? "failed_retryable" : "failed_final",
      ],
    };
  }
  const state = normalizePrintState(status, "queued");
  if (state === "failed_final") {
    return { printState: state, path: ["queued", "claimed", "sent", state] };
  }
  return { printState: state, path: [state] };
}

function resolveCurrentPrintState(job) {
  if (!job || typeof job !== "object") return normalizePrintState(job);
  return resolvePrintRuntimeState(job).printState;
}

export function applyPrintStateTransition(job, toState, context = {}) {
  const previousState = resolveCurrentPrintState(job);
  assertPrintStateTransitionAllowed(previousState, toState, context);
  const nextState = normalizePrintState(toState, previousState);
  if (!job || typeof job !== "object") return nextState;
  const previousPath = resolvePrintRuntimeState(job).path;
  const nextPath =
    previousPath[previousPath.length - 1] === nextState
      ? previousPath
      : [...previousPath, nextState];
  const now =
    typeof context.nowIso === "function"
      ? context.nowIso()
      : typeof context.now === "function"
        ? context.now()
        : new Date().toISOString();
  return {
    ...job,
    printState: nextState,
    printStatePath: nextPath,
    printStateUpdatedAt: now,
  };
}

export function createPrintStateMachine(options = {}) {
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

  function assertTransitionAllowed(fromState, toState, context = {}) {
    if (!enabled) return true;
    const violation = getPrintStateTransitionViolation(fromState, toState, context);
    if (violation) throw createTransitionError(violation);
    return true;
  }

  function applyTransition(job, toState, context = {}) {
    if (!enabled) {
      return applyPrintStateTransition(job, toState, {
        ...context,
        allowOverride: true,
        overrideReason: context.overrideReason || "print_state_machine_disabled",
      });
    }
    const previousState = resolveCurrentPrintState(job);
    assertTransitionAllowed(previousState, toState, context);
    return applyPrintStateTransition(job, toState, context);
  }

  return {
    applyTransition,
    assertTransitionAllowed,
    canTransition: canTransitionPrintState,
    getPrintStateTransitionViolation,
    isPrintState,
    normalizePrintState,
    resolvePrintRuntimeState,
  };
}
