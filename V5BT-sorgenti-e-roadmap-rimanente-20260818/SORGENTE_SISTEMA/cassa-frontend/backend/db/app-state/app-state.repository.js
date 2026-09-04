import { promises as fs } from "node:fs";
import { AppStateMysqlRepository } from "./app-state-mysql.repository.js";
import { AppStateSqliteRepository } from "./app-state-sqlite.repository.js";
import {
  ensureJsonStateFile,
  readJsonStateFile,
  writeJsonStateFile,
} from "./app-state-json.repository.js";

function bufferSize(serialized) {
  return Buffer.byteLength(String(serialized ?? ""), "utf-8");
}

const TRANSIENT_MYSQL_WRITE_ERROR_CODES = new Set([
  "ER_CHECKREAD",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
]);

const APP_STATE_WRITE_RETRY_ATTEMPTS = 4;
const APP_STATE_WRITE_RETRY_BASE_DELAY_MS = 35;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNonNegativeInteger(value, fallback) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function isTransientMysqlWriteError(error) {
  const code = String(error?.code ?? "").trim();
  if (TRANSIENT_MYSQL_WRITE_ERROR_CODES.has(code)) return true;
  const errno = Number(error?.errno);
  if (errno === 1020 || errno === 1205 || errno === 1213) return true;
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("record has changed since last read") ||
    message.includes("deadlock found") ||
    message.includes("try restarting transaction") ||
    message.includes("lock wait timeout")
  );
}

function normalizeWriteRetryCause(error) {
  return isTransientMysqlWriteError(error) ? "transientDbError" : "unknown";
}

function normalizeDomainList(values) {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => /^[A-Za-z][A-Za-z0-9_]*$/.test(entry)),
    ),
  ];
}

function normalizeDirtyDomains(options = {}) {
  return normalizeDomainList(options.splitDomains ?? options.domains ?? []);
}


const DIRTY_TRACKING_MODES = new Set(["off", "shadow", "warn", "enforce", "write"]);

export function normalizeAppStateDirtyTrackingMode(value, fallback = "off") {
  const normalizedFallback = DIRTY_TRACKING_MODES.has(String(fallback ?? "").trim().toLowerCase())
    ? String(fallback).trim().toLowerCase()
    : "off";
  if (value === true) return "enforce";
  if (value === false || value === null || value === undefined) return normalizedFallback;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled", "write"].includes(text)) return "write";
  if (["0", "false", "no", "off", "disabled", ""].includes(text)) return "off";
  return text === "write" ? "enforce" : DIRTY_TRACKING_MODES.has(text) ? text : normalizedFallback;
}

function unionDomainLists(...lists) {
  return normalizeDomainList(lists.flatMap((values) => Array.isArray(values) ? values : []));
}

function differenceDomains(left = [], right = []) {
  const rightSet = new Set(normalizeDomainList(right));
  return normalizeDomainList(left).filter((domain) => !rightSet.has(domain));
}

function buildWriteMetricLabel(options = {}, dirtyDomains = []) {
  const explicit = String(options.metricLabel ?? options.metricsLabel ?? "").replace(/\s+/g, " ").trim();
  if (explicit) return explicit.slice(0, 120);
  const domains = normalizeDomainList(dirtyDomains);
  return domains.length > 0 ? `domains:${domains.join("+")}` : "full";
}

export function createAppStateRepository(options = {}) {
  const mode = options.mode;
  const dbPath = options.dbPath;
  const dbTmpPath = options.dbTmpPath;
  const defaultJsonDbPath = options.defaultJsonDbPath;
  const legacyJsonDbPath = options.legacyJsonDbPath ?? "";
  const buildInitialState = options.buildInitialState;
  const isValidState = options.isValidState;
  const migrateState = options.migrateState ?? (() => false);
  const cloneJson = options.cloneJson;
  const nowIso = options.nowIso;
  const safePathExists = options.safePathExists;
  const canInitializeMissingDb = options.canInitializeMissingDb;
  const canInitializeExistingEmptyDb = options.canInitializeExistingEmptyDb;
  const buildEmptyDbInitDeniedMessage = options.buildEmptyDbInitDeniedMessage;
  const logger = options.logger ?? console;
  const afterWrite =
    typeof options.afterWrite === "function"
      ? options.afterWrite
      : async () => {};
  const afterWriteRequired = options.afterWriteRequired === true;
  const jsonRepository = options.jsonRepository ?? {
    ensureJsonStateFile,
    readJsonStateFile,
    writeJsonStateFile,
  };
  const hydrateReadState =
    typeof options.hydrateReadState === "function"
      ? options.hydrateReadState
      : async (state) => state;
  const hydrateReadRequired = options.hydrateReadRequired === true;
	  const beforeWrite =
	    typeof options.beforeWrite === "function"
	      ? options.beforeWrite
	      : async () => {};
  const beforeWriteRequired = options.beforeWriteRequired === true;
  const prepareWriteState =
    typeof options.prepareWriteState === "function"
      ? options.prepareWriteState
      : async (state) => state;
	  const prepareComparableState =
	    typeof options.prepareComparableState === "function"
	      ? options.prepareComparableState
	      : async (state) => state;
	  const runtimeMetrics =
	    options.runtimeMetrics && typeof options.runtimeMetrics === "object"
	      ? options.runtimeMetrics
	      : null;
  const onWriteRetry =
    typeof options.onWriteRetry === "function" ? options.onWriteRetry : () => {};
  const dirtyTrackingMode = normalizeAppStateDirtyTrackingMode(
    options.dirtyTrackingMode ??
      options.appStateDirtyTrackingMode ??
      options.dirtyTrackingEnabled ??
      options.appStateDirtyTracking,
    "off",
  );
  const dirtyTrackingShadowEnabled = dirtyTrackingMode === "shadow";
  const dirtyTrackingWarnEnabled = dirtyTrackingMode === "warn";
  const dirtyTrackingEnforceEnabled = dirtyTrackingMode === "enforce";
  const dirtyTrackingWriteEnabled = dirtyTrackingMode === "write" || dirtyTrackingMode === "enforce";
  const dirtyTrackingEnabled = dirtyTrackingMode !== "off";
  const onDirtyTrackingEvent =
    typeof options.onDirtyTrackingEvent === "function"
      ? options.onDirtyTrackingEvent
      : () => {};
  /**
   * L'audit dei domini sporchi serializza l'intero stato a ogni scrittura per scoprire
   * quali domini sono cambiati davvero. Quando la scrittura passa dal percorso veloce
   * esternalizzato il risultato viene scartato per tutti i domini non dichiarati: resta
   * solo telemetria, ma il costo cresce con lo stato (con qualche centinaio di comande
   * sono megabyte serializzati per ogni pagamento).
   *
   * Lo campioniamo: una scrittura ogni N mantiene la rete di sicurezza contro i domini
   * non dichiarati, che è un difetto sistematico e quindi emerge comunque in fretta.
   * In modalita "enforce" l'osservazione solleva eccezione, quindi li non si campiona mai.
   */
  const dirtyTrackingAuditSampleRate = Math.max(
    1,
    normalizeNonNegativeInteger(options.dirtyTrackingAuditSampleRate, 20) || 1,
  );
  let dirtyTrackingAuditCounter = 0;
  const fullyExternalizedDomains = new Set(
    normalizeDomainList(options.fullyExternalizedDomains),
  );
  const structuredCacheValidationIntervalMs = normalizeNonNegativeInteger(
    options.structuredCacheValidationIntervalMs,
    1000,
  );

  let dbCache = null;
  let dbCacheMtimeMs = 0;
  let dbCacheSize = 0;
  let dbCacheUpdatedAtRaw = "";
  let dbCacheValidatedAtMs = 0;
  let dbCacheComparableSerialized = "";
  let dbCachePersistedComparableSerialized = "";
  const dbCacheDomainComparableSerialized = new Map();
  let writeQueue = Promise.resolve();

  function cloneComparableValue(value) {
    const cloned = cloneJson(value, value);
    return cloned === undefined ? null : cloned;
  }

  function normalizeComparableDomainValue(domain, state) {
    const key = String(domain ?? "").trim();
    if (key === "meta") {
      const cloned = cloneComparableValue(state?.meta ?? {});
      if (cloned && typeof cloned === "object") {
        delete cloned.lastWriteAt;
        delete cloned.lastSecurityMigrationAt;
      }
      return cloned;
    }
    if (key === "integration") {
      const cloned = cloneComparableValue(state?.integration ?? {});
      if (cloned && typeof cloned === "object") {
        delete cloned.lastWriteAt;
      }
      return cloned;
    }
    return cloneComparableValue(state?.[key]);
  }

  function serializeComparableDomain(state, domain) {
    return JSON.stringify(normalizeComparableDomainValue(domain, state));
  }

  function serializeComparableDomains(state, domains) {
    const entries = normalizeDomainList(domains).map((domain) => [
      domain,
      normalizeComparableDomainValue(domain, state),
    ]);
    return JSON.stringify(Object.fromEntries(entries));
  }

  function refreshDomainComparableCache(state, domains) {
    normalizeDomainList(domains).forEach((domain) => {
      dbCacheDomainComparableSerialized.set(
        domain,
        serializeComparableDomain(state, domain),
      );
    });
  }


  function listKnownComparableDomains(state) {
    return normalizeDomainList([
      ...Object.keys(state ?? {}),
      ...dbCacheDomainComparableSerialized.keys(),
    ]);
  }

  function detectChangedComparableDomains(state) {
    const changed = [];
    const serializedByDomain = new Map();
    for (const domain of listKnownComparableDomains(state)) {
      const serialized = serializeComparableDomain(state, domain);
      serializedByDomain.set(domain, serialized);
      if (dbCacheDomainComparableSerialized.get(domain) !== serialized) {
        changed.push(domain);
      }
    }
    return { changedDomains: normalizeDomainList(changed), serializedByDomain, audited: true };
  }

  /**
   * Variante economica: serializza solo i domini dichiarati, che sono gli unici il cui
   * risultato viene poi usato per aggiornare la baseline. Non produce `changedDomains`,
   * quindi chi la usa deve saltare il confronto dichiarati/modificati.
   */
  function serializeDeclaredComparableDomains(state, domains) {
    const serializedByDomain = new Map();
    for (const domain of normalizeDomainList(domains)) {
      serializedByDomain.set(domain, serializeComparableDomain(state, domain));
    }
    return { changedDomains: [], serializedByDomain, audited: false };
  }

  function shouldAuditDirtyDomains(canUseFastPath) {
    // Fuori dal percorso veloce la serializzazione completa serve comunque.
    if (!canUseFastPath || dirtyTrackingEnforceEnabled) return true;
    dirtyTrackingAuditCounter = (dirtyTrackingAuditCounter + 1) % dirtyTrackingAuditSampleRate;
    return dirtyTrackingAuditCounter === 0;
  }

  function recordDirtyTrackingObservation({
    label,
    declaredDomains = [],
    changedDomains = [],
    comparableBytes = 0,
    mode = dirtyTrackingMode,
    persistedFastPath = false,
    hasComparableBaseline = true,
    audited = true,
    startedAt = Date.now(),
  } = {}) {
    // Senza audit completo `changedDomains` e vuoto per costruzione: confrontarlo con i
    // dichiarati produrrebbe un mismatch inventato su ogni scrittura campionata fuori.
    const canCompareDomains = hasComparableBaseline === true && audited === true;
    const missingDeclaredDomains = canCompareDomains
      ? differenceDomains(changedDomains, declaredDomains)
      : [];
    const overDeclaredDomains = canCompareDomains
      ? differenceDomains(declaredDomains, changedDomains)
      : [];
    const fullyExternalized = dirtyDomainsAreFullyExternalized(declaredDomains);
    const payload = {
      label: String(label ?? "appStateWrite"),
      mode,
      declaredDomains: normalizeDomainList(declaredDomains),
      changedDomains: normalizeDomainList(changedDomains),
      missingDeclaredDomains,
      overDeclaredDomains,
      fullyExternalized,
      audited: audited === true,
      persistedFastPath: persistedFastPath === true,
      fullStateFallbackUsed: persistedFastPath !== true,
      hasComparableBaseline: hasComparableBaseline === true,
      comparableBytes,
      durationMs: Date.now() - startedAt,
    };
    runtimeMetrics?.recordDirtyTracking?.(payload);
    runtimeMetrics?.recordOperation?.("appStateDirtyTracking", `mode.${mode}`, payload.durationMs);
    if (missingDeclaredDomains.length > 0) {
      runtimeMetrics?.recordOperation?.("appStateDirtyTrackingMismatch", `missing.${payload.label}`, payload.durationMs);
    }
    if (mode === "warn" && missingDeclaredDomains.length > 0) {
      logger.warn(
        `[app-state:dirty-tracking] ${payload.label}: domini modificati non dichiarati: ${missingDeclaredDomains.join(", ")} (dichiarati: ${payload.declaredDomains.join(", ") || "nessuno"})`,
      );
    }
    try {
      onDirtyTrackingEvent(payload);
    } catch {
      // Diagnostics callback must never alter persistence semantics.
    }
    if (mode === "enforce" && missingDeclaredDomains.length > 0) {
      throw new Error(
        `DIRTY_DOMAIN_UNDECLARED ${payload.label}: ${missingDeclaredDomains.join(", ")}`,
      );
    }
    return payload;
  }

  function dirtyDomainsAreFullyExternalized(domains) {
    const normalized = normalizeDomainList(domains);
    return (
      normalized.length > 0 &&
      normalized.every((domain) => fullyExternalizedDomains.has(domain))
    );
  }

  function serializeComparableState(state) {
    const cloned = cloneJson(state, state);
    if (cloned?.meta && typeof cloned.meta === "object") {
      delete cloned.meta.lastWriteAt;
      delete cloned.meta.lastSecurityMigrationAt;
    }
    if (cloned?.integration && typeof cloned.integration === "object") {
      delete cloned.integration.lastWriteAt;
    }
    return JSON.stringify(cloned);
  }

  async function loadSeedStateFromJsonFile(filePath) {
    try {
      const parsed = await jsonRepository.readJsonStateFile(filePath);
      if (!isValidState(parsed)) {
        throw new Error("Invalid app state shape");
      }
      migrateState(parsed);
      return hydrateStateForRead(parsed, "seed-json");
    } catch {
      return null;
    }
  }

  const sqliteRepository =
    options.sqliteRepository ??
    new AppStateSqliteRepository({
      dbPath,
      importJsonPath: options.sqliteImportJsonPath ?? "",
      buildInitialState,
      isValidState,
      loadSeedState: loadSeedStateFromJsonFile,
      nowIso,
      safePathExists,
      canInitializeMissingDb,
      canInitializeExistingEmptyDb,
      buildEmptyDbInitDeniedMessage,
    });
  let mysqlRepository = options.mysqlRepository ?? null;

  function getMysqlRepository() {
    if (mysqlRepository) return mysqlRepository;
    mysqlRepository = new AppStateMysqlRepository({
      connectionUri: options.mysqlConnectionUri,
      host: options.mysqlHost,
      port: options.mysqlPort,
      user: options.mysqlUser,
      password: options.mysqlPassword,
      database: options.mysqlDatabase,
      tableName: options.mysqlTableName,
      importJsonPath: options.mysqlImportJsonPath ?? "",
      buildInitialState,
      isValidState,
      loadSeedState: loadSeedStateFromJsonFile,
      nowIso,
      canInitializeMissingDb,
      canInitializeExistingEmptyDb,
      buildEmptyDbInitDeniedMessage,
      poolMetricsEnabled: process.env.BACKEND_MYSQL_POOL_METRICS === "1",
      runtimeMetrics,
    });
    return mysqlRepository;
  }

  function getStructuredRepository() {
    if (mode === "sqlite") return sqliteRepository;
    if (mode === "mysql") return getMysqlRepository();
    return null;
  }

  function getStructuredLabel() {
    return mode === "mysql" ? "MySQL" : "SQLite";
  }

  function recordWriteOperation(kind, label, durationMs = 0) {
    runtimeMetrics?.recordOperation?.(kind, label, durationMs);
  }

  async function runAppStateWriteWithRetry(operation, context = {}) {
    for (let attempt = 1; attempt <= APP_STATE_WRITE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          mode !== "mysql" ||
          !isTransientMysqlWriteError(error) ||
          attempt >= APP_STATE_WRITE_RETRY_ATTEMPTS
        ) {
          throw error;
        }
        const stage = String(context.stage ?? "unknown").trim() || "unknown";
        const label =
          String(context.label ?? "").replace(/\s+/g, " ").trim() || "writeDb";
        const cause = normalizeWriteRetryCause(error);
        recordWriteOperation(
          "appStateWriteRetry",
          `stage.${stage}.${cause}`,
          0,
        );
        recordWriteOperation(
          "appStateWriteRetry",
          `${label}.stage.${stage}.${cause}`,
          0,
        );
        const message = error instanceof Error ? error.message : String(error);
        const delayMs =
          APP_STATE_WRITE_RETRY_BASE_DELAY_MS * attempt +
          Math.floor(Math.random() * APP_STATE_WRITE_RETRY_BASE_DELAY_MS);
        const retryEvent = {
          attempt,
          maxAttempts: APP_STATE_WRITE_RETRY_ATTEMPTS - 1,
          stage,
          label,
          cause,
          code: String(error?.code ?? "").trim() || null,
          message,
          delayMs,
        };
        try {
          onWriteRetry(retryEvent);
        } catch (callbackError) {
          logger.warn(
            `[backend] Callback retry app-state fallita: ${
              callbackError instanceof Error
                ? callbackError.message
                : String(callbackError)
            }`,
          );
        }
        logger.warn(
          `[backend] Write app-state MySQL in retry route=${label} stage=${stage} ` +
            `cause=${cause} code=${retryEvent.code ?? "unknown"} ` +
            `attempt=${attempt}/${APP_STATE_WRITE_RETRY_ATTEMPTS - 1}: ${message}`,
        );
        await sleep(delayMs);
      }
    }
  }

  async function hydrateStateForRead(state, sourceLabel) {
    try {
      const hydrated = await hydrateReadState(state);
      return hydrated && typeof hydrated === "object" ? hydrated : state;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[backend] Hydration app-state fallita (${sourceLabel}): ${reason}`,
      );
      if (hydrateReadRequired) {
        throw error;
      }
      return state;
    }
  }

  async function runBeforeWriteHook(state, context = {}) {
    try {
      await beforeWrite(state, context);
    } catch (error) {
      const label = buildWriteMetricLabel(
        context,
        normalizeDirtyDomains(context),
      );
      const cause = normalizeWriteRetryCause(error);
      recordWriteOperation(
        "appStateWriteHook",
        `beforeWrite.failure.${cause}`,
        0,
      );
      recordWriteOperation(
        "appStateWriteHook",
        `${label}.beforeWrite.failure.${cause}`,
        0,
      );
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`[backend] Hook pre-write app-state fallito: ${reason}`);
      if (beforeWriteRequired) {
        throw error;
      }
    }
  }

  async function buildStateForPersistence(state) {
    try {
      const prepared = await prepareWriteState(state);
      return prepared && typeof prepared === "object" ? prepared : state;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[backend] Preparazione app-state persistito fallita: ${reason}`,
      );
      if (beforeWriteRequired) {
        throw error;
      }
      return state;
    }
  }

  async function buildStateForPersistenceComparison(state) {
    try {
      const prepared = await prepareComparableState(state);
      return prepared && typeof prepared === "object" ? prepared : state;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[backend] Preparazione confronto app-state persistito fallita: ${reason}`,
      );
      if (beforeWriteRequired) {
        throw error;
      }
      return state;
    }
  }

  async function serializePersistedComparableState(state) {
    return serializeComparableState(
      await buildStateForPersistenceComparison(state),
    );
  }

  async function updateCacheFromSerialized(state, serialized, updatedAt) {
    dbCache = state;
    dbCacheUpdatedAtRaw = String(updatedAt ?? "");
    dbCacheMtimeMs = Date.parse(dbCacheUpdatedAtRaw) || Date.now();
    dbCacheValidatedAtMs = Date.now();
    dbCacheSize = bufferSize(serialized);
    dbCacheComparableSerialized = serializeComparableState(state);
    dbCachePersistedComparableSerialized =
      await serializePersistedComparableState(state);
    refreshDomainComparableCache(state, Object.keys(state ?? {}));
  }

  async function ensureDbFile() {
    const structuredRepository = getStructuredRepository();
    if (structuredRepository) {
      const ensured = await structuredRepository.ensure();
      if (ensured.seededState) {
        await updateCacheFromSerialized(
          ensured.seededState,
          ensured.serialized,
          ensured.updatedAt,
        );
      }
      return;
    }

    await jsonRepository.ensureJsonStateFile({
      dbPath,
      legacyDbPath: dbPath === defaultJsonDbPath ? legacyJsonDbPath : "",
      buildInitialState,
      allowEmptyInit: canInitializeMissingDb(),
    });
  }

  async function readStructuredDb(options = {}) {
    const structuredRepository = getStructuredRepository();
    if (options?.forceReload !== true && dbCache && isValidState(dbCache)) {
      const nowMs = Date.now();
      const shouldValidate =
        structuredCacheValidationIntervalMs === 0 ||
        dbCacheValidatedAtMs <= 0 ||
        nowMs - dbCacheValidatedAtMs >= structuredCacheValidationIntervalMs;
      if (!shouldValidate || typeof structuredRepository?.checkHealth !== "function") {
        return dbCache;
      }
      try {
        const health = await structuredRepository.checkHealth();
        dbCacheValidatedAtMs = nowMs;
        const remoteUpdatedAt = String(health?.updatedAt ?? "");
        if (!remoteUpdatedAt) return dbCache;
        const remoteMtimeMs = Date.parse(remoteUpdatedAt) || 0;
        const localMtimeMs = dbCacheMtimeMs || Date.parse(dbCacheUpdatedAtRaw) || 0;
        const cacheIsFresh =
          remoteMtimeMs > 0 && localMtimeMs > 0
            ? remoteMtimeMs <= localMtimeMs
            : remoteUpdatedAt === dbCacheUpdatedAtRaw;
        if (cacheIsFresh) return dbCache;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[backend] Validazione cache ${getStructuredLabel()} fallita, uso cache in memoria: ${reason}`,
        );
        return dbCache;
      }
    }

    try {
      const { state, serialized, updatedAt } =
        await structuredRepository.read();
      const changed = migrateState(state);
      const hydrated = await hydrateStateForRead(state, mode);
      await updateCacheFromSerialized(hydrated, serialized, updatedAt);

      if (changed) {
        dbCache.meta.lastWriteAt = nowIso();
        await writeDb(dbCache);
      }

      return dbCache;
    } catch (error) {
      if (dbCache && isValidState(dbCache)) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[backend] Lettura ${getStructuredLabel()} fallita, uso cache in memoria: ${reason}`,
        );
        return dbCache;
      }
      throw error;
    }
  }

  async function readStructuredDbSnapshot() {
    const structuredRepository = getStructuredRepository();
    if (dbCache && isValidState(dbCache)) {
      const cached = cloneJson(dbCache, dbCache);
      migrateState(cached);
      return cached;
    }

    if (mode === "sqlite") {
      try {
        await fs.access(dbPath);
      } catch (error) {
        if (!error || typeof error !== "object" || error.code !== "ENOENT") {
          throw error;
        }
        if (canInitializeMissingDb()) {
          await ensureDbFile();
          return readStructuredDbSnapshot();
        }
        throw new Error(
          buildEmptyDbInitDeniedMessage("Database SQLite", dbPath),
        );
      }
    }

    try {
      const { state } = await structuredRepository.readReadonly();
      migrateState(state);
      return hydrateStateForRead(state, `${mode}-snapshot`);
    } catch (error) {
      if (dbCache && isValidState(dbCache)) {
        const cached = cloneJson(dbCache, dbCache);
        migrateState(cached);
        return cached;
      }
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[backend] Lettura snapshot ${getStructuredLabel()} fallita senza cache valida: ${reason}`,
      );
      throw error;
    }
  }

  async function readJsonDbSnapshot() {
    await writeQueue.catch(() => undefined);

    const candidates = [dbPath];
    if (dbPath === defaultJsonDbPath) {
      candidates.push(legacyJsonDbPath);
    }

    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const parsed = await jsonRepository.readJsonStateFile(candidate);
        if (!isValidState(parsed)) {
          throw new Error("Invalid app state shape");
        }
        migrateState(parsed);
        return hydrateStateForRead(parsed, "json-snapshot");
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          continue;
        }
        if (dbCache && isValidState(dbCache)) {
          const cached = cloneJson(dbCache, dbCache);
          migrateState(cached);
          return cached;
        }
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[backend] Lettura snapshot DB fallita senza cache valida: ${reason}`,
        );
        throw error;
      }
    }

    if (dbCache && isValidState(dbCache)) {
      const cached = cloneJson(dbCache, dbCache);
      migrateState(cached);
      return cached;
    }

    if (canInitializeMissingDb()) {
      await jsonRepository.ensureJsonStateFile({
        dbPath,
        legacyDbPath: dbPath === defaultJsonDbPath ? legacyJsonDbPath : "",
        buildInitialState,
        allowEmptyInit: true,
      });
      return readJsonDbSnapshot();
    }

    throw new Error(buildEmptyDbInitDeniedMessage("Database JSON", dbPath));
  }

  async function checkHealth() {
    const structuredRepository = getStructuredRepository();
    if (structuredRepository) {
      if (typeof structuredRepository.checkHealth === "function") {
        return structuredRepository.checkHealth();
      }
      await structuredRepository.readReadonly();
      return { ok: true, mode };
    }

    await writeQueue.catch(() => undefined);
    const parsed = await jsonRepository.readJsonStateFile(dbPath);
    if (!isValidState(parsed)) {
      throw new Error("Invalid JSON app state shape");
    }
    return {
      ok: true,
      mode: "json",
      updatedAt: String(parsed?.meta?.lastWriteAt ?? ""),
    };
  }

	  async function readDb(options = {}) {
	    const startedAt = Date.now();
	    try {
	      const allowPersistentMigrations = options?.allowMigrations !== false;
	      const forceReload =
	        options?.forceReload === true || options?.bypassCache === true;
	      if (options?.preferCache === true && dbCache && isValidState(dbCache)) {
	        return dbCache;
	      }
	      if (!allowPersistentMigrations) {
	        return getStructuredRepository()
	          ? readStructuredDbSnapshot()
	          : readJsonDbSnapshot();
	      }
	
	      if (getStructuredRepository()) {
	        return readStructuredDb({ forceReload });
	      }
	
	      await ensureDbFile();
	      await writeQueue.catch(() => undefined);
	      let fileMtimeMs = 0;
	      let fileSize = 0;
	      try {
	        const stat = await fs.stat(dbPath);
	        fileMtimeMs = Number.isFinite(Number(stat.mtimeMs))
	          ? Number(stat.mtimeMs)
	          : 0;
	        fileSize = Number.isFinite(Number(stat.size)) ? Number(stat.size) : 0;
	      } catch {
	        fileMtimeMs = 0;
	        fileSize = 0;
	      }
	
	      if (
	        !forceReload &&
	        dbCache &&
	        fileMtimeMs > 0 &&
	        dbCacheMtimeMs > 0 &&
	        fileMtimeMs === dbCacheMtimeMs &&
	        fileSize === dbCacheSize
	      ) {
	        return dbCache;
	      }
	
	      try {
	        const parsed = await jsonRepository.readJsonStateFile(dbPath);
	        if (!isValidState(parsed)) {
	          throw new Error("Invalid app state shape");
	        }
	
	        const changed = migrateState(parsed);
	        const hydrated = await hydrateStateForRead(parsed, "json");
	        dbCache = hydrated;
	        dbCacheMtimeMs = fileMtimeMs > 0 ? fileMtimeMs : Date.now();
	        dbCacheSize = fileSize;
	
	        if (changed) {
	          dbCache.meta.lastWriteAt = nowIso();
	          dbCacheComparableSerialized = "";
	          dbCachePersistedComparableSerialized = "";
	          await writeDb(dbCache);
	        } else {
	          dbCacheComparableSerialized = serializeComparableState(hydrated);
	          dbCachePersistedComparableSerialized =
	            await serializePersistedComparableState(hydrated);
	          refreshDomainComparableCache(hydrated, Object.keys(hydrated ?? {}));
	        }
	
	        return dbCache;
	      } catch (error) {
	        if (dbCache && isValidState(dbCache)) {
	          const reason = error instanceof Error ? error.message : String(error);
	          logger.warn(
	            `[backend] Lettura DB fallita, uso cache in memoria: ${reason}`,
	          );
	          return dbCache;
	        }
	        throw error;
	      }
	    } finally {
	      runtimeMetrics?.recordReadDb?.(Date.now() - startedAt);
	    }
	  }

	  async function writeDb(db, options = {}) {
	    const startedAt = Date.now();
	    if (!isValidState(db)) {
	      throw new Error("Invalid app state shape");
	    }
      const dirtyDomains = normalizeDirtyDomains(options);
      const writeMetricLabel = buildWriteMetricLabel(options, dirtyDomains);
      const recordWriteMetric = (event) => runtimeMetrics?.recordWriteDb?.({ label: writeMetricLabel, ...event });
      const dirtyTrackingHasBaseline = dbCacheDomainComparableSerialized.size > 0;
      const canUseExternalizedDirtyFastPath = Boolean(
        dirtyTrackingWriteEnabled &&
        dirtyDomainsAreFullyExternalized(dirtyDomains) &&
        dbCachePersistedComparableSerialized
      );
      const dirtyTrackingObservation = !dirtyTrackingEnabled
        ? { changedDomains: [], serializedByDomain: new Map(), audited: false }
        : shouldAuditDirtyDomains(canUseExternalizedDirtyFastPath)
          ? detectChangedComparableDomains(db)
          : serializeDeclaredComparableDomains(db, dirtyDomains);
	
	    const comparableSerialized = canUseExternalizedDirtyFastPath
        ? JSON.stringify({ dirtyDomains })
        : serializeComparableState(db);
	    const comparableBytes = bufferSize(comparableSerialized);
      if (dirtyTrackingEnabled) {
        recordDirtyTrackingObservation({
          label: writeMetricLabel,
          declaredDomains: dirtyDomains,
          changedDomains: dirtyTrackingObservation.changedDomains,
          comparableBytes,
          persistedFastPath: canUseExternalizedDirtyFastPath,
          hasComparableBaseline: dirtyTrackingHasBaseline,
          audited: dirtyTrackingObservation.audited !== false,
          startedAt,
        });
      }
	    if (
	      !getStructuredRepository() &&
        !canUseExternalizedDirtyFastPath &&
	      dbCacheComparableSerialized &&
	      comparableSerialized === dbCacheComparableSerialized
	    ) {
	      dbCache = db;
	      recordWriteMetric({
	        skipped: "comparable",
	        comparableBytes,
	        durationMs: Date.now() - startedAt,
	      });
	      return;
	    }

    dbCache = db;
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(async () => {
        const retryContext = { label: writeMetricLabel, stage: "beforeWrite" };
        await runAppStateWriteWithRetry(async () => {
          retryContext.stage = "beforeWrite";
          await runBeforeWriteHook(db, options);
          retryContext.stage = "dirtyExternalized";
          if (canUseExternalizedDirtyFastPath) {
            dbCacheComparableSerialized = "";
            for (const [domain, serialized] of dirtyTrackingObservation.serializedByDomain.entries()) {
              if (dirtyDomains.includes(domain)) dbCacheDomainComparableSerialized.set(domain, serialized);
            }
            recordWriteMetric({
              skipped: "dirtyExternalized",
              comparableBytes,
              persistedComparableBytes: 0,
              fullStateFallbackUsed: false,
              dirtyTrackingMode,
              changedDomains: dirtyTrackingObservation.changedDomains,
              durationMs: Date.now() - startedAt,
            });
            return;
          }
          retryContext.stage = "persistedComparison";
          const persistedComparableSerialized =
            await serializePersistedComparableState(db);
          const persistedComparableBytes = bufferSize(
            persistedComparableSerialized,
          );
          if (
            dbCachePersistedComparableSerialized &&
            persistedComparableSerialized === dbCachePersistedComparableSerialized
          ) {
            dbCacheComparableSerialized = comparableSerialized;
            dbCachePersistedComparableSerialized = persistedComparableSerialized;
            if (dirtyTrackingEnabled) {
              for (const [domain, serialized] of dirtyTrackingObservation.serializedByDomain.entries()) {
                dbCacheDomainComparableSerialized.set(domain, serialized);
              }
            }
            recordWriteMetric({
              skipped: "persistedComparable",
              comparableBytes,
              persistedComparableBytes,
              fullStateFallbackUsed: !canUseExternalizedDirtyFastPath,
              dirtyTrackingMode,
              changedDomains: dirtyTrackingObservation.changedDomains,
              durationMs: Date.now() - startedAt,
            });
            return;
          }

          retryContext.stage = "prepareWrite";
          const persistedDb = await buildStateForPersistence(db);
          const structuredRepository = getStructuredRepository();
          if (structuredRepository) {
            retryContext.stage = "structuredWrite";
            const { serialized, updatedAt } =
              await structuredRepository.write(persistedDb);
            dbCacheMtimeMs = Date.parse(updatedAt) || Date.now();
            dbCacheSize = bufferSize(serialized);
            dbCacheComparableSerialized = comparableSerialized;
            dbCachePersistedComparableSerialized = persistedComparableSerialized;
            if (dirtyTrackingEnabled) {
              for (const [domain, serialized] of dirtyTrackingObservation.serializedByDomain.entries()) {
                dbCacheDomainComparableSerialized.set(domain, serialized);
              }
            }
            recordWriteMetric({
              persisted: true,
              comparableBytes,
              persistedComparableBytes,
              persistedBytes: dbCacheSize,
              fullStateFallbackUsed: !canUseExternalizedDirtyFastPath,
              dirtyTrackingMode,
              changedDomains: dirtyTrackingObservation.changedDomains,
              durationMs: Date.now() - startedAt,
            });
            return;
          }

          retryContext.stage = "jsonWrite";
          await jsonRepository.writeJsonStateFile(dbPath, dbTmpPath, persistedDb);
          dbCachePersistedComparableSerialized = persistedComparableSerialized;
          if (dirtyTrackingEnabled) {
            for (const [domain, serialized] of dirtyTrackingObservation.serializedByDomain.entries()) {
              dbCacheDomainComparableSerialized.set(domain, serialized);
            }
          }
          recordWriteMetric({
            persisted: true,
            comparableBytes,
            persistedComparableBytes,
            persistedBytes: runtimeMetrics?.enabled
              ? bufferSize(JSON.stringify(persistedDb))
              : 0,
            fullStateFallbackUsed: !canUseExternalizedDirtyFastPath,
            dirtyTrackingMode,
            changedDomains: dirtyTrackingObservation.changedDomains,
            durationMs: Date.now() - startedAt,
          });
        }, retryContext);
      });
    await writeQueue;

    if (!getStructuredRepository()) {
      try {
        const stat = await fs.stat(dbPath);
        dbCacheMtimeMs = Number.isFinite(Number(stat.mtimeMs))
          ? Number(stat.mtimeMs)
          : Date.now();
        dbCacheSize = Number.isFinite(Number(stat.size))
          ? Number(stat.size)
          : 0;
        dbCacheComparableSerialized = comparableSerialized;
      } catch {
        dbCacheMtimeMs = Date.now();
        dbCacheSize = 0;
        dbCacheComparableSerialized = comparableSerialized;
      }
    }

    try {
      await afterWrite(db, { dirtyDomains });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`[backend] Hook post-write app-state fallito: ${reason}`);
      if (afterWriteRequired) {
        throw error;
      }
    }
  }

  function close() {
    sqliteRepository.close?.();
    mysqlRepository?.close?.();
  }

  return {
    checkHealth,
    close,
    ensureDbFile,
    readDb,
    writeDb,
  };
}
