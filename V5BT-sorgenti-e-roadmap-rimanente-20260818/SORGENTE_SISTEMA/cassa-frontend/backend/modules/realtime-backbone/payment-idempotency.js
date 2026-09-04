import { IdempotencyKeysRepository } from "../../db/relational/index.js";

const DEFAULT_TTL_HOURS = 24;
const AUTH_PAYLOAD_KEYS = new Set([
  "accessToken",
  "authToken",
  "authorization",
  "sessionToken",
  "token",
]);

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function addHoursIso(nowIso, hours) {
  const baseMs = Date.parse(String(nowIso ?? ""));
  const safeBaseMs = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(safeBaseMs + hours * 60 * 60 * 1000).toISOString();
}

function cloneWithoutAuthSecrets(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneWithoutAuthSecrets(entry));
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      if (AUTH_PAYLOAD_KEYS.has(key)) return acc;
      acc[key] = cloneWithoutAuthSecrets(value[key]);
      return acc;
    }, {});
}

function buildPaymentRequestFingerprint({ endpoint, key, payload, user, session }) {
  return {
    endpoint: normalizeText(endpoint, "payment"),
    idempotencyKey: normalizeText(key),
    userId: normalizeText(user?.id ?? payload?.userId),
    deviceUuid: normalizeText(session?.deviceUuid ?? payload?.deviceUuid),
    clientApp: normalizeText(session?.clientApp ?? payload?.clientApp),
    payload: cloneWithoutAuthSecrets(payload ?? {}),
  };
}

function errorToStoredResponse(error) {
  return {
    ok: false,
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : 500,
    error: error instanceof Error ? error.message : String(error ?? "Errore pagamento."),
    ...(error?.code ? { code: String(error.code) } : {}),
    ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
  };
}

export function createPaymentIdempotencyCoordinator({
  enabled = false,
  relationalRuntime,
  nowIso = () => new Date().toISOString(),
  ttlHours = DEFAULT_TTL_HOURS,
  HttpError = Error,
  metrics = null,
} = {}) {
  const safeTtlHours = normalizePositiveNumber(ttlHours, DEFAULT_TTL_HOURS);

  function incrementCounter(name, amount = 1) {
    metrics?.incrementCounter?.(name, amount);
  }

  function repository() {
    if (!enabled) return null;
    const db = relationalRuntime?.db ?? null;
    if (!db) {
      throw new HttpError(503, "Idempotency store non disponibile.", {
        code: "IDEMPOTENCY_STORE_UNAVAILABLE",
      });
    }
    return new IdempotencyKeysRepository(db, { nowIso });
  }

  function begin({ key, scope, endpoint, payload, user, session } = {}) {
    const safeKey = normalizeText(key);
    if (!enabled || !safeKey) return null;
    const repo = repository();
    incrementCounter("idempotencyStoreClaims");
    const request = buildPaymentRequestFingerprint({
      endpoint,
      key: safeKey,
      payload,
      user,
      session,
    });
    const result = repo.begin({
      key: safeKey,
      scope: normalizeText(scope, "payment"),
      request,
      expiresAt: addHoursIso(nowIso(), safeTtlHours),
    });

    if (result.state === "conflict") {
      incrementCounter("idempotencyStoreConflicts");
      throw new HttpError(409, "Idempotency key gia usata con una richiesta diversa.", {
        code: "IDEMPOTENCY_KEY_CONFLICT",
        details: {
          scope,
          idempotencyKey: safeKey,
        },
      });
    }

    if (result.state === "completed") {
      incrementCounter("idempotencyStoreHits");
      return {
        key: safeKey,
        replayed: true,
        response: {
          ...(result.response && typeof result.response === "object" ? result.response : {}),
          ok: result.response?.ok !== false,
          idempotent: true,
          idempotencyStore: true,
        },
      };
    }

    if (result.state === "failed") {
      incrementCounter("idempotencyStoreFailedReplays");
      const stored = result.response && typeof result.response === "object" ? result.response : {};
      throw new HttpError(
        Number.isFinite(Number(stored.status)) ? Number(stored.status) : 409,
        normalizeText(stored.error, "Richiesta pagamento precedente fallita."),
        {
          code: normalizeText(stored.code, "IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED"),
          details: {
            ...(stored.details && typeof stored.details === "object" ? stored.details : {}),
            idempotencyKey: safeKey,
            scope,
          },
        },
      );
    }

    if (result.state === "processing") {
      incrementCounter("idempotencyStoreInProgress");
      throw new HttpError(409, "Pagamento gia in elaborazione.", {
        code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        details: {
          scope,
          idempotencyKey: safeKey,
        },
      });
    }

    return {
      key: safeKey,
      repo,
      replayed: false,
    };
  }

  function complete(claim, response) {
    if (!claim?.key || claim.replayed) return null;
    incrementCounter("idempotencyStoreCompleted");
    return claim.repo.complete(claim.key, response);
  }

  function fail(claim, error) {
    if (!claim?.key || claim.replayed) return null;
    incrementCounter("idempotencyStoreFailed");
    return claim.repo.fail(claim.key, errorToStoredResponse(error));
  }

  return {
    begin,
    complete,
    fail,
    get enabled() {
      return enabled;
    },
  };
}
