import { performance } from "node:perf_hooks";

export const POSTGRESQL_RETRYABLE_TRANSACTION_CODES = Object.freeze([
  "40001",
  "40P01",
]);

const RETRYABLE_CODES = new Set(POSTGRESQL_RETRYABLE_TRANSACTION_CODES);
const ISOLATION_LEVELS = new Set([
  "READ COMMITTED",
  "REPEATABLE READ",
  "SERIALIZABLE",
]);
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 250;
const connectionReleaseFailures = new WeakMap();

function normalizeLabel(value) {
  const normalized = String(value ?? "transaction")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
    .slice(0, 80);
  return normalized || "transaction";
}

function normalizeIsolationLevel(value) {
  const isolationLevel = String(value ?? "READ COMMITTED")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
  if (!ISOLATION_LEVELS.has(isolationLevel)) {
    throw new TypeError(`isolationLevel PostgreSQL non supportato: ${isolationLevel || "vuoto"}.`);
  }
  return isolationLevel;
}

function boundedInteger(value, fallback, name, min, max) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new TypeError(`${name} deve essere un intero tra ${min} e ${max}.`);
  }
  return candidate;
}

function normalizeTransactionOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options della transazione deve essere un oggetto.");
  }
  const maxAttempts = boundedInteger(
    options.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
    1,
    MAX_ATTEMPTS,
  );
  const baseDelayMs = boundedInteger(
    options.baseDelayMs,
    DEFAULT_BASE_DELAY_MS,
    "baseDelayMs",
    0,
    5_000,
  );
  const maxDelayMs = boundedInteger(
    options.maxDelayMs,
    DEFAULT_MAX_DELAY_MS,
    "maxDelayMs",
    0,
    30_000,
  );
  if (maxDelayMs < baseDelayMs) {
    throw new TypeError("maxDelayMs deve essere maggiore o uguale a baseDelayMs.");
  }
  return {
    baseDelayMs,
    isolationLevel: normalizeIsolationLevel(options.isolationLevel),
    maxAttempts,
    maxDelayMs,
  };
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function safeInvoke(callback) {
  try {
    callback();
  } catch {
    // L'osservabilita non deve cambiare l'esito della transazione.
  }
}

function safeNow(nowMs) {
  try {
    const value = Number(nowMs());
    if (Number.isFinite(value)) return value;
  } catch {
    // Usa un clock di fallback solo per l'osservabilita.
  }
  return Date.now();
}

function durationSince(nowMs, startedAt) {
  return Math.max(0, safeNow(nowMs) - startedAt);
}

function attachSecondaryError(primaryError, propertyName, secondaryError) {
  if ((typeof primaryError !== "object" || primaryError === null)
    && typeof primaryError !== "function") return;
  try {
    Object.defineProperty(primaryError, propertyName, {
      configurable: true,
      enumerable: false,
      value: secondaryError,
      writable: false,
    });
  } catch {
    // L'errore originale resta comunque quello primario.
  }
}

export function markPostgresqlConnectionReleaseFailure(primaryError, releaseError) {
  if ((typeof primaryError !== "object" || primaryError === null)
    && typeof primaryError !== "function") return;
  connectionReleaseFailures.set(primaryError, releaseError);
  attachSecondaryError(primaryError, "releaseError", releaseError);
}

function postgresqlConnectionReleaseFailure(error) {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return null;
  return connectionReleaseFailures.get(error) ?? error.releaseError ?? null;
}

function safeOperationalErrorCode(error, fallback) {
  const sqlState = postgresqlTransactionErrorCode(error);
  if (sqlState) return sqlState;
  const code = String(error?.code ?? "").trim().toUpperCase();
  return /^[A-Z0-9_]{2,40}$/.test(code) ? code : fallback;
}

export function postgresqlTransactionErrorCode(error) {
  const visited = new Set();
  let current = error;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    if ((typeof current !== "object" && typeof current !== "function") || visited.has(current)) break;
    visited.add(current);
    const code = String(current.code ?? "").trim().toUpperCase();
    if (/^[0-9A-Z]{5}$/.test(code)) return code;
    current = current.cause;
  }
  return null;
}

export function createPostgresqlTransactionRunner(options = {}) {
  if (typeof options.withConnection !== "function") {
    throw new TypeError("withConnection e obbligatorio per il transaction runner PostgreSQL.");
  }
  const withConnection = options.withConnection;
  const runtimeMetrics = options.runtimeMetrics ?? null;
  const logger = options.logger ?? console;
  const nowMs = options.nowMs ?? (() => performance.now());
  const sleep = options.sleep ?? defaultSleep;
  if (typeof sleep !== "function") throw new TypeError("sleep deve essere una funzione.");

  function incrementCounter(name) {
    safeInvoke(() => runtimeMetrics?.incrementCounter?.(name));
  }

  function recordOperation(kind, label, durationMs) {
    safeInvoke(() => runtimeMetrics?.recordOperation?.(kind, label, durationMs));
  }

  function warn(message) {
    safeInvoke(() => logger?.warn?.(message));
  }

  return async function withTransaction(label, callback, transactionOptions = {}) {
    if (typeof callback !== "function") {
      throw new TypeError("callback deve essere una funzione.");
    }
    const normalizedOptions = normalizeTransactionOptions(transactionOptions);
    const normalizedLabel = normalizeLabel(label);
    const totalStartedAt = safeNow(nowMs);
    incrementCounter("postgresTransactions");

    try {
      for (let attempt = 1; attempt <= normalizedOptions.maxAttempts; attempt += 1) {
        const attemptStartedAt = safeNow(nowMs);
        let began = false;
        let committed = false;
        let rollbackError = null;
        incrementCounter("postgresTransactionAttempts");

        try {
          const result = await withConnection(
            `transaction:${normalizedLabel}:attempt:${attempt}`,
            async (client) => {
              if (typeof client?.query !== "function") {
                throw new TypeError("Il client PostgreSQL transazionale non espone query().");
              }
              await client.query(`BEGIN ISOLATION LEVEL ${normalizedOptions.isolationLevel}`);
              began = true;
              try {
                const value = await callback(client, {
                  attempt,
                  maxAttempts: normalizedOptions.maxAttempts,
                });
                await client.query("COMMIT");
                committed = true;
                incrementCounter("postgresTransactionCommits");
                return value;
              } catch (error) {
                if (began && !committed) {
                  try {
                    await client.query("ROLLBACK");
                    incrementCounter("postgresTransactionRollbacks");
                  } catch (caughtRollbackError) {
                    rollbackError = caughtRollbackError;
                    attachSecondaryError(error, "rollbackError", caughtRollbackError);
                    incrementCounter("postgresTransactionRollbackFailures");
                    const rollbackCode = safeOperationalErrorCode(
                      caughtRollbackError,
                      "POSTGRES_ROLLBACK_FAILED",
                    );
                    warn(`[postgresql] rollback transazione ${normalizedLabel} fallito (${rollbackCode}).`);
                  }
                }
                throw error;
              }
            },
          );
          recordOperation(
            "postgresTransactionAttempt",
            normalizedLabel,
            durationSince(nowMs, attemptStartedAt),
          );
          return result;
        } catch (error) {
          recordOperation(
            "postgresTransactionAttempt",
            normalizedLabel,
            durationSince(nowMs, attemptStartedAt),
          );
          const errorCode = postgresqlTransactionErrorCode(error);
          const canRetry = began
            && !committed
            && !rollbackError
            && !postgresqlConnectionReleaseFailure(error)
            && RETRYABLE_CODES.has(errorCode)
            && attempt < normalizedOptions.maxAttempts;
          if (!canRetry) {
            incrementCounter("postgresTransactionFailures");
            throw error;
          }

          const delayMs = Math.min(
            normalizedOptions.maxDelayMs,
            normalizedOptions.baseDelayMs * (2 ** (attempt - 1)),
          );
          incrementCounter("postgresTransactionRetries");
          recordOperation("postgresTransactionRetryDelay", errorCode, delayMs);
          warn(
            `[postgresql] retry transazione ${normalizedLabel} (${errorCode}) `
            + `tentativo ${attempt}/${normalizedOptions.maxAttempts} tra ${delayMs} ms.`,
          );
          await sleep(delayMs);
        }
      }
      throw new Error("Transaction runner PostgreSQL terminato senza esito.");
    } finally {
      recordOperation(
        "postgresTransaction",
        normalizedLabel,
        durationSince(nowMs, totalStartedAt),
      );
    }
  };
}
