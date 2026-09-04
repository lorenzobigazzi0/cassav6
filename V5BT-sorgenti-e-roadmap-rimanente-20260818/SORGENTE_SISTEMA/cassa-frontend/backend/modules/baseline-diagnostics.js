import { promises as fs } from "node:fs";
import path from "node:path";

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function normalizeSampleRate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  if (parsed <= 0) return 0;
  if (parsed >= 1) return Math.min(Math.trunc(parsed), 10_000);
  return Math.max(0, Math.min(parsed, 1));
}

function shouldSample(rate, counter) {
  if (rate <= 0) return false;
  if (rate >= 1) {
    const interval = Math.max(1, Math.trunc(rate));
    return counter % interval === 0;
  }
  return Math.random() <= rate;
}

function normalizeNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeId(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 160) : undefined;
}

function sanitizeRoute(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || "unknown";
}

function sanitizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))].sort();
}

function sanitizeDomains(value) {
  return sanitizeStringArray(value);
}

export function buildBaselineRequestRecord(context = {}) {
  const responseMs = normalizeNumber(context.responseMs ?? context.durationMs, null);
  return {
    type: "http_request",
    at: new Date().toISOString(),
    requestId: sanitizeId(context.requestId),
    method: sanitizeRoute(context.method ?? "GET"),
    path: sanitizeRoute(context.path ?? "/"),
    route: sanitizeRoute(context.route ?? `${context.method ?? "GET"} ${context.path ?? "/"}`),
    status: normalizeNumber(context.status, null),
    responseMs,
    queueWaitMs: normalizeNumber(context.queueWaitMs, null),
    laneWaitMs: normalizeNumber(context.laneWaitMs, null),
    handlerRunMs: normalizeNumber(context.handlerRunMs, null),
    readDbCount: normalizeNumber(context.readDbCount, 0),
    readDbMs: normalizeNumber(context.readDbMs, 0),
    writeDbCount: normalizeNumber(context.writeDbCount, 0),
    writeDbMs: normalizeNumber(context.writeDbMs, 0),
    serializedBytes: normalizeNumber(context.serializedBytes, null),
    dirtyDomains: sanitizeDomains(context.dirtyDomains),
    detectedDirtyDomains: sanitizeDomains(context.detectedDirtyDomains),
    undeclaredDirtyDomains: sanitizeDomains(context.undeclaredDirtyDomains),
    overDeclaredDirtyDomains: sanitizeDomains(context.overDeclaredDirtyDomains),
    dirtyTrackingMode: sanitizeRoute(context.dirtyTrackingMode ?? "off"),
    queueKinds: sanitizeStringArray(context.queueKinds),
    fullStateFallbackUsed: context.fullStateFallbackUsed === true,
    mysqlRetryCount: normalizeNumber(context.mysqlRetryCount, 0),
    mysqlRetryScopes: sanitizeStringArray(context.mysqlRetryScopes),
    mysqlRetryCodes: sanitizeStringArray(context.mysqlRetryCodes),
    mysqlRetryStages: sanitizeStringArray(context.mysqlRetryStages),
    mysqlRetryLabels: sanitizeStringArray(context.mysqlRetryLabels),
    printEnqueueMs: normalizeNumber(context.printEnqueueMs, null),
    eventOutboxMs: normalizeNumber(context.eventOutboxMs, null),
    eventPublishLagMs: normalizeNumber(context.eventPublishLagMs, null),
    deviceId: sanitizeId(context.deviceId ?? context.deviceUuid),
    stationId: sanitizeId(context.stationId),
    userId: sanitizeId(context.userId),
  };
}

export function createBaselineDiagnostics(options = {}) {
  const enabled = normalizeBoolean(options.enabled, false);
  const logJson = normalizeBoolean(options.logJson, true);
  const sampleRate = normalizeSampleRate(options.sampleRate ?? 1);
  const logPath = String(options.logPath ?? "").trim();
  let counter = 0;
  let initialized = false;
  let writeChain = Promise.resolve();
  let warned = false;

  async function ensureLogDir() {
    if (initialized || !logPath) return;
    initialized = true;
    await fs.mkdir(path.dirname(logPath), { recursive: true });
  }

  function scheduleWrite(line) {
    if (!logPath) return;
    writeChain = writeChain
      .then(async () => {
        await ensureLogDir();
        await fs.appendFile(logPath, `${line}\n`, "utf8");
      })
      .catch((error) => {
        if (!warned) {
          warned = true;
          console.warn(`[diagnostics] baseline log non scrivibile: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
  }

  function recordRequest(context = {}) {
    if (!enabled) return;
    counter += 1;
    if (!shouldSample(sampleRate, counter)) return;
    const record = buildBaselineRequestRecord(context);
    const line = JSON.stringify(record);
    if (logJson) console.log(line);
    scheduleWrite(line);
  }

  async function flush() {
    await writeChain;
  }

  return {
    enabled,
    logPath,
    sampleRate,
    recordRequest,
    flush,
  };
}
