import { performance } from "node:perf_hooks";

import {
  createPostgresqlTransactionRunner,
  markPostgresqlConnectionReleaseFailure,
} from "./transactions.js";

function clampInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function normalizeSslMode(value) {
  const mode = String(value ?? "disable").trim().toLowerCase();
  if (["disable", "require", "verify-ca", "verify-full"].includes(mode)) return mode;
  throw new Error(`POSTGRES_SSL_MODE non supportato: ${mode || "vuoto"}.`);
}

function sslOptions(mode) {
  if (mode === "disable") return false;
  return { rejectUnauthorized: mode === "verify-ca" || mode === "verify-full" };
}

export function normalizePostgresqlConfig(options = {}) {
  const env = options.env ?? process.env;
  const enabled = parseEnabled(env.BACKEND_POSTGRES_ENABLED ?? env.POSTGRES_ENABLED);
  const sslMode = normalizeSslMode(env.POSTGRES_SSL_MODE);
  const config = {
    enabled,
    host: String(env.POSTGRES_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    port: clampInteger(env.POSTGRES_PORT, 5432, 1, 65535),
    database: String(env.POSTGRES_DATABASE ?? "cassav6").trim() || "cassav6",
    user: String(env.POSTGRES_USER ?? "cassav6_app").trim() || "cassav6_app",
    password: String(env.POSTGRES_PASSWORD ?? ""),
    sslMode,
    max: clampInteger(env.POSTGRES_POOL_MAX, 6, 1, 20),
    idleTimeoutMs: clampInteger(env.POSTGRES_POOL_IDLE_TIMEOUT_MS, 30_000, 1_000, 300_000),
    connectionTimeoutMs: clampInteger(env.POSTGRES_CONNECTION_TIMEOUT_MS, 3_000, 250, 30_000),
    statementTimeoutMs: clampInteger(env.POSTGRES_STATEMENT_TIMEOUT_MS, 5_000, 100, 300_000),
    lockTimeoutMs: clampInteger(env.POSTGRES_LOCK_TIMEOUT_MS, 1_000, 100, 60_000),
    applicationName: String(env.POSTGRES_APPLICATION_NAME ?? "cassav6-backend").trim() || "cassav6-backend",
  };

  if (enabled && (!config.password || config.password === "CHANGE_ME")) {
    throw new Error("POSTGRES_PASSWORD deve essere valorizzata quando BACKEND_POSTGRES_ENABLED=1.");
  }
  return config;
}

function poolConnectionOptions(config) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: sslOptions(config.sslMode),
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    lock_timeout: config.lockTimeoutMs,
    application_name: config.applicationName,
    allowExitOnIdle: true,
  };
}

async function createPgPool(options) {
  const pgModule = await import("pg");
  const Pool = pgModule.Pool ?? pgModule.default?.Pool;
  if (typeof Pool !== "function") throw new Error("Driver PostgreSQL pg non disponibile.");
  return new Pool(options);
}

function safeErrorCode(error) {
  const code = String(error?.code ?? "POSTGRES_UNAVAILABLE").trim();
  return /^[A-Z0-9_]{2,40}$/.test(code) ? code : "POSTGRES_UNAVAILABLE";
}

function safeObserve(callback) {
  try {
    callback();
  } catch {
    // Metriche e logger non devono cambiare l'esito delle operazioni database.
  }
}

export function createPostgresqlRuntime(options = {}) {
  const config = normalizePostgresqlConfig(options);
  const logger = options.logger ?? console;
  const runtimeMetrics = options.runtimeMetrics ?? null;
  const nowMs = options.nowMs ?? (() => performance.now());
  const poolFactory = options.poolFactory ?? createPgPool;
  let poolPromise = null;
  let pool = null;

  function poolSnapshot() {
    return {
      total: Math.max(0, Math.trunc(Number(pool?.totalCount) || 0)),
      idle: Math.max(0, Math.trunc(Number(pool?.idleCount) || 0)),
      waiting: Math.max(0, Math.trunc(Number(pool?.waitingCount) || 0)),
      max: config.max,
    };
  }

  function publishPoolMetrics() {
    const snapshot = poolSnapshot();
    safeObserve(() => runtimeMetrics?.setGauge?.("postgresPoolTotalConnections", snapshot.total));
    safeObserve(() => runtimeMetrics?.setGauge?.("postgresPoolIdleConnections", snapshot.idle));
    safeObserve(() => runtimeMetrics?.setGauge?.("postgresPoolWaitingAcquires", snapshot.waiting));
    return snapshot;
  }

  async function getPool() {
    if (!config.enabled) throw new Error("PostgreSQL runtime disabilitato.");
    if (!poolPromise) {
      poolPromise = Promise.resolve(poolFactory(poolConnectionOptions(config)))
        .then((createdPool) => {
          pool = createdPool;
          pool?.on?.("error", (error) => {
            safeObserve(() => runtimeMetrics?.incrementCounter?.("postgresPoolErrors"));
            safeObserve(() => logger.warn?.(
              `[postgresql] errore pool non associato a una richiesta (${safeErrorCode(error)}).`,
            ));
            publishPoolMetrics();
          });
          publishPoolMetrics();
          return pool;
        })
        .catch((error) => {
          poolPromise = null;
          throw error;
        });
    }
    return poolPromise;
  }

  async function withConnection(label, callback) {
    const activePool = await getPool();
    const acquireStartedAt = nowMs();
    let client = null;
    try {
      client = await activePool.connect();
    } catch (error) {
      safeObserve(() => runtimeMetrics?.incrementCounter?.("postgresPoolAcquireErrors"));
      publishPoolMetrics();
      throw error;
    }
    const waitMs = Math.max(0, nowMs() - acquireStartedAt);
    safeObserve(() => runtimeMetrics?.incrementCounter?.("postgresPoolAcquires"));
    safeObserve(() => runtimeMetrics?.recordOperation?.("postgresPoolWait", label, waitMs));
    publishPoolMetrics();
    let callbackError = null;
    try {
      return await callback(client);
    } catch (error) {
      callbackError = error;
      safeObserve(() => runtimeMetrics?.incrementCounter?.("postgresQueryErrors"));
      throw error;
    } finally {
      try {
        client?.release?.();
      } catch (releaseError) {
        safeObserve(() => runtimeMetrics?.incrementCounter?.("postgresPoolReleaseErrors"));
        safeObserve(() => logger.warn?.(
          `[postgresql] rilascio connessione fallito (${safeErrorCode(releaseError)}).`,
        ));
        if (callbackError) {
          markPostgresqlConnectionReleaseFailure(callbackError, releaseError);
        } else {
          throw releaseError;
        }
      }
      publishPoolMetrics();
    }
  }

  const withTransaction = createPostgresqlTransactionRunner({
    logger,
    nowMs,
    runtimeMetrics,
    sleep: options.sleep,
    withConnection,
  });

  async function checkHealth() {
    if (!config.enabled) return { enabled: false, ok: true, status: "disabled" };
    const startedAt = nowMs();
    safeObserve(() => runtimeMetrics?.incrementCounter?.("postgresHealthChecks"));
    try {
      await withConnection("health", (client) => client.query("SELECT 1 AS ok"));
      return {
        enabled: true,
        ok: true,
        status: "ready",
        latencyMs: Math.max(0, Math.round((nowMs() - startedAt) * 100) / 100),
        pool: publishPoolMetrics(),
      };
    } catch (error) {
      const errorCode = safeErrorCode(error);
      safeObserve(() => runtimeMetrics?.incrementCounter?.("postgresHealthCheckFailures"));
      safeObserve(() => logger.warn?.(`[postgresql] health check fallito (${errorCode}).`));
      return {
        enabled: true,
        ok: false,
        status: "unavailable",
        errorCode,
        latencyMs: Math.max(0, Math.round((nowMs() - startedAt) * 100) / 100),
        pool: publishPoolMetrics(),
      };
    }
  }

  async function close() {
    const activePool = poolPromise ? await poolPromise.catch(() => null) : null;
    pool = null;
    poolPromise = null;
    if (activePool?.end) await activePool.end();
    publishPoolMetrics();
  }

  return {
    checkHealth,
    close,
    config: { ...config, password: config.password ? "[redacted]" : "" },
    get enabled() {
      return config.enabled;
    },
    poolSnapshot,
    withConnection,
    withTransaction,
  };
}
