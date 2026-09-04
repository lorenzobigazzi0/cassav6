const DEFAULT_WORKER_ID = "fiscal-outbox-worker";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

const RESULT_STATUS_ALIASES = new Map([
  ["ok", "issued"],
  ["success", "issued"],
  ["succeeded", "issued"],
  ["issued", "issued"],
  ["retry", "retrying"],
  ["retrying", "retrying"],
  ["failed", "failed"],
  ["failure", "failed"],
  ["manual", "manual_required"],
  ["manual_required", "manual_required"],
]);

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizePositiveInt(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function addMsIso(baseIso, ms) {
  const parsedBaseMs = Date.parse(String(baseIso ?? ""));
  const safeBaseMs = Number.isFinite(parsedBaseMs) ? parsedBaseMs : Date.now();
  const safeMs = Math.max(0, Math.trunc(Number(ms) || 0));
  return new Date(safeBaseMs + safeMs).toISOString();
}

function normalizeResultStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return RESULT_STATUS_ALIASES.get(normalized) ?? null;
}

function errorMessageFrom(error, fallback = "Fiscal outbox processor failed.") {
  return normalizeText(error?.message, fallback).slice(0, 1_000);
}

function shouldStopRetrying(entry, maxAttempts) {
  const attemptCount = normalizePositiveInt(entry?.attemptCount, 0, { min: 0 });
  return attemptCount + 1 >= maxAttempts;
}

function normalizeRetryAt(result, nowIso, retryDelayMs) {
  const explicitNextAttemptAt = normalizeText(result?.nextAttemptAt);
  if (explicitNextAttemptAt) return explicitNextAttemptAt;
  const explicitRetryDelayMs = result?.retryDelayMs ?? result?.delayMs;
  return addMsIso(nowIso, explicitRetryDelayMs ?? retryDelayMs);
}

export function normalizeFiscalOutboxWorkerResult(result, entry, options = {}) {
  const nowIso =
    typeof options.nowIso === "function"
      ? options.nowIso()
      : normalizeText(options.nowIso, new Date().toISOString());
  const retryDelayMs = normalizePositiveInt(
    options.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS,
    { min: 0 },
  );
  const maxAttempts = normalizePositiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);

  if (result === true || result?.ok === true) {
    return {
      status: "issued",
      payload: result?.payload,
      issuedAt: result?.issuedAt ?? nowIso,
    };
  }

  const status = normalizeResultStatus(result?.status);
  if (status === "issued") {
    return {
      status,
      payload: result?.payload,
      issuedAt: result?.issuedAt ?? nowIso,
    };
  }

  const errorCode = normalizeText(
    result?.errorCode,
    status ? "FISCAL_OUTBOX_PROCESSOR_ERROR" : "FISCAL_OUTBOX_INVALID_WORKER_RESULT",
  );
  const errorMessage = normalizeText(
    result?.errorMessage,
    status ? "Fiscal outbox processor returned a failure." : "Invalid fiscal outbox worker result.",
  );

  if (status === "manual_required") {
    return {
      status,
      errorCode,
      errorMessage,
      manualRequired: true,
      nextAttemptAt: null,
    };
  }

  if (status === "retrying") {
    const manualRequired = shouldStopRetrying(entry, maxAttempts);
    return {
      status: manualRequired ? "manual_required" : "retrying",
      errorCode,
      errorMessage,
      manualRequired,
      nextAttemptAt: manualRequired ? null : normalizeRetryAt(result, nowIso, retryDelayMs),
    };
  }

  if (status === "failed") {
    return {
      status,
      errorCode,
      errorMessage,
      manualRequired: false,
      nextAttemptAt: null,
    };
  }

  return {
    status: "manual_required",
    errorCode,
    errorMessage,
    manualRequired: true,
    nextAttemptAt: null,
  };
}

export function normalizeFiscalOutboxWorkerError(error, entry, options = {}) {
  const nowIso =
    typeof options.nowIso === "function"
      ? options.nowIso()
      : normalizeText(options.nowIso, new Date().toISOString());
  const retryDelayMs = normalizePositiveInt(
    options.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS,
    { min: 0 },
  );
  const maxAttempts = normalizePositiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const manualRequired = shouldStopRetrying(entry, maxAttempts);
  return {
    status: manualRequired ? "manual_required" : "retrying",
    errorCode: normalizeText(error?.code, "FISCAL_OUTBOX_PROCESSOR_ERROR"),
    errorMessage: errorMessageFrom(error),
    manualRequired,
    nextAttemptAt: manualRequired ? null : addMsIso(nowIso, retryDelayMs),
  };
}

export function createFiscalOutboxWorker(options = {}) {
  if (!options.repository) {
    throw new Error("FiscalOutboxRepository richiesto.");
  }
  if (typeof options.processClaim !== "function") {
    throw new Error("processClaim richiesto.");
  }

  const repository = options.repository;
  const processClaim = options.processClaim;
  const workerId = normalizeText(options.workerId, DEFAULT_WORKER_ID);
  const leaseMs = normalizePositiveInt(options.leaseMs, DEFAULT_LEASE_MS);
  const retryDelayMs = normalizePositiveInt(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, {
    min: 0,
  });
  const maxAttempts = normalizePositiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const nowIso =
    typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();

  async function runOnce(runOptions = {}) {
    const claimed = repository.claimNext({
      workerId,
      leaseMs: runOptions.leaseMs ?? leaseMs,
      nowIso: nowIso(),
    });
    if (!claimed) {
      return { claimed: false, status: "idle" };
    }

    let result;
    try {
      result = normalizeFiscalOutboxWorkerResult(
        await processClaim(claimed),
        claimed,
        {
          nowIso,
          retryDelayMs,
          maxAttempts,
        },
      );
    } catch (error) {
      result = normalizeFiscalOutboxWorkerError(error, claimed, {
        nowIso,
        retryDelayMs,
        maxAttempts,
      });
    }

    if (result.status === "issued") {
      const updated = repository.markIssued(claimed.fiscalId, {
        issuedAt: result.issuedAt ?? nowIso(),
        payload: result.payload === undefined ? claimed.payload : result.payload,
      });
      return { claimed: true, status: updated.status, entry: updated };
    }

    const updated = repository.markFailed(claimed.fiscalId, {
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      nextAttemptAt: result.nextAttemptAt,
      manualRequired: result.manualRequired === true,
      payload: result.payload,
    });
    return { claimed: true, status: updated.status, entry: updated };
  }

  async function runBatch(batchOptions = {}) {
    const limit = normalizePositiveInt(batchOptions.limit, 1, { min: 1, max: 1_000 });
    const results = [];
    for (let index = 0; index < limit; index += 1) {
      const result = await runOnce(batchOptions);
      results.push(result);
      if (!result.claimed) break;
    }
    return {
      processed: results.filter((entry) => entry.claimed).length,
      results,
    };
  }

  return {
    runBatch,
    runOnce,
    workerId,
  };
}
