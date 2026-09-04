import { createHash } from "node:crypto";

export const AUTO_PRINT_OWNER_SCHEMA_VERSION = 1;
export const AUTO_PRINT_OWNER_MAX_PLANS = 64;
export const AUTO_PRINT_OWNER_MAX_PAYLOADS_PER_PLAN = 16;
export const AUTO_PRINT_OWNER_MAX_TEXT_BYTES = 256 * 1024;
export const AUTO_PRINT_OWNER_MAX_PREFERENCES_BYTES = 64 * 1024;
export const AUTO_PRINT_OWNER_MAX_JSON_BYTES = 240 * 1024;

const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_ID_LENGTH = 160;
const MAX_LABEL_LENGTH = 120;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 2_000;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const PLAN_TEXT_FIELDS = Object.freeze({
  activityId: MAX_ID_LENGTH,
  areaId: MAX_ID_LENGTH,
  cashPointId: MAX_ID_LENGTH,
  clientApp: 80,
  deviceId: MAX_ID_LENGTH,
  deviceUuid: MAX_ID_LENGTH,
  fallbackStation: MAX_LABEL_LENGTH,
  kind: 40,
  logicalTableLabel: MAX_LABEL_LENGTH,
  orderId: MAX_ID_LENGTH,
  precontoProfile: 40,
  printerId: MAX_ID_LENGTH,
  roomId: MAX_ID_LENGTH,
  roomLabel: MAX_LABEL_LENGTH,
  roomName: MAX_LABEL_LENGTH,
  station: MAX_LABEL_LENGTH,
  tableId: MAX_ID_LENGTH,
  tableLabel: MAX_LABEL_LENGTH,
  userId: MAX_ID_LENGTH,
  workstationId: MAX_ID_LENGTH,
});

function invalidPayload(message) {
  const error = new TypeError(message);
  error.code = "AUTO_PRINT_OWNER_PAYLOAD_INVALID";
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeRequiredBatchId(value) {
  const batchId = String(value ?? "").trim();
  if (!BATCH_ID_PATTERN.test(batchId)) {
    throw invalidPayload("batchId auto-print non valido.");
  }
  return batchId;
}

function cloneBoundedJson(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw invalidPayload("printPreferences auto-print troppo complesso.");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidPayload("printPreferences auto-print contiene un numero non valido.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneBoundedJson(entry, state, depth + 1));
  }
  if (!isPlainObject(value)) {
    throw invalidPayload("printPreferences auto-print deve contenere solo dati JSON.");
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw invalidPayload("printPreferences auto-print contiene una chiave vietata.");
    }
    if (entry === undefined) continue;
    out[key] = cloneBoundedJson(entry, state, depth + 1);
  }
  return out;
}

function normalizePrintPreferences(value) {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw invalidPayload("printPreferences auto-print non valido.");
  }
  const normalized = cloneBoundedJson(value);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > AUTO_PRINT_OWNER_MAX_PREFERENCES_BYTES) {
    throw invalidPayload("printPreferences auto-print supera il limite consentito.");
  }
  return normalized;
}

function normalizePayload(source) {
  if (!isPlainObject(source)) {
    throw invalidPayload("Piano auto-print non valido.");
  }
  const plan = {};
  for (const [field, maxLength] of Object.entries(PLAN_TEXT_FIELDS)) {
    const value = String(source[field] ?? "").trim();
    if (value) plan[field] = value.slice(0, maxLength);
  }
  if (!plan.kind || !plan.orderId) {
    throw invalidPayload("Ogni piano auto-print richiede kind e orderId.");
  }

  const text = String(source.text ?? "");
  if (!text.trim()) {
    throw invalidPayload("Ogni piano auto-print richiede il testo da stampare.");
  }
  if (Buffer.byteLength(text, "utf8") > AUTO_PRINT_OWNER_MAX_TEXT_BYTES) {
    throw invalidPayload("Testo auto-print oltre il limite consentito.");
  }
  plan.text = text;

  const printPreferences = normalizePrintPreferences(source.printPreferences);
  if (printPreferences !== undefined) plan.printPreferences = printPreferences;
  if (Number(source.operationalSchemaVersion) === 2) {
    plan.operationalSchemaVersion = 2;
  }
  return plan;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestId(prefix, ...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(part)).update("\0");
  return `${prefix}${hash.digest("hex").slice(0, 40)}`;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function invalidOwnerResult(message) {
  const error = new Error(message);
  error.code = "AUTO_PRINT_OWNER_RESULT_MISMATCH";
  return error;
}

function normalizeOwnerResult(body, expectedJobs) {
  const accepted = nonNegativeInteger(body?.accepted);
  const duplicates = nonNegativeInteger(body?.duplicates);
  const skipped = nonNegativeInteger(body?.skipped);
  if (
    accepted === null ||
    duplicates === null ||
    skipped === null ||
    skipped !== 0 ||
    accepted + duplicates + skipped !== expectedJobs
  ) {
    throw invalidOwnerResult("Risposta owner auto-print con cardinalita non coerente.");
  }
  return { accepted, duplicates, skipped };
}

export function isAutoPrintOwnerTimeout(error) {
  const name = String(error?.name ?? "").toUpperCase();
  const code = String(error?.code ?? error?.cause?.code ?? "").toUpperCase();
  const message = String(error?.message ?? "");
  return (
    name === "ABORTERROR" ||
    name === "TIMEOUTERROR" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    /(?:time\s*out|timed\s*out|timeout)/i.test(message)
  );
}

export function buildAutoPrintOwnerBatchId(orderId) {
  const safeOrderId = String(orderId ?? "").trim();
  if (!safeOrderId || safeOrderId.length > MAX_ID_LENGTH) {
    throw invalidPayload("orderId auto-print non valido.");
  }
  return digestId("auto_print_batch_", safeOrderId);
}

export function buildAutoPrintOwnerJobId(batchId, index) {
  const safeBatchId = normalizeRequiredBatchId(batchId);
  const safeIndex = Number(index);
  if (!Number.isInteger(safeIndex) || safeIndex < 0 || safeIndex >= AUTO_PRINT_OWNER_MAX_PAYLOADS_PER_PLAN) {
    throw invalidPayload("Indice job auto-print non valido.");
  }
  return digestId("print_", safeBatchId, safeIndex);
}

export function normalizeAutoPrintOwnerPlans(source) {
  if (!Array.isArray(source)) {
    throw invalidPayload("La lista dei piani auto-print non e valida.");
  }
  const plans = [];
  const seenBatchIds = new Set();
  for (const rawPlan of source) {
    if (!isPlainObject(rawPlan)) {
      throw invalidPayload("Piano owner auto-print non valido.");
    }
    const batchId = normalizeRequiredBatchId(rawPlan.batchId);
    if (seenBatchIds.has(batchId)) continue;
    if (!Array.isArray(rawPlan.payloads) || rawPlan.payloads.length === 0) {
      throw invalidPayload("Il piano auto-print non contiene payload.");
    }

    const payloads = [];
    const seenPayloads = new Set();
    for (const rawPayload of rawPlan.payloads) {
      const payload = normalizePayload(rawPayload);
      const canonicalPayload = stableJson(payload);
      if (seenPayloads.has(canonicalPayload)) continue;
      seenPayloads.add(canonicalPayload);
      payloads.push({
        ...payload,
        jobId: buildAutoPrintOwnerJobId(batchId, payloads.length),
      });
      if (payloads.length >= AUTO_PRINT_OWNER_MAX_PAYLOADS_PER_PLAN) break;
    }
    if (payloads.length === 0) {
      throw invalidPayload("Il piano auto-print non contiene payload validi.");
    }
    seenBatchIds.add(batchId);
    plans.push({ batchId, payloads });
    if (plans.length >= AUTO_PRINT_OWNER_MAX_PLANS) break;
  }
  if (Buffer.byteLength(JSON.stringify({ plans }), "utf8") > AUTO_PRINT_OWNER_MAX_JSON_BYTES) {
    throw invalidPayload("Payload JSON auto-print oltre il limite consentito.");
  }
  return plans;
}

export async function persistAutoPrintOwnerPlanWorkflow({
  plans,
  db,
  settings,
  readDb,
  sanitizeSettings,
  enqueueJobs,
  runtimeMetrics,
} = {}) {
  const startedAt = Date.now();
  const measure = async (label, operation) => {
    const phaseStartedAt = Date.now();
    try {
      return await operation();
    } finally {
      runtimeMetrics?.recordOperation?.("printSpoolOwner", label, Date.now() - phaseStartedAt);
    }
  };
  try {
    const normalizedPlans = await measure("normalizePlans", () => normalizeAutoPrintOwnerPlans(plans));
    const effectiveDb = await measure("resolveDb", () =>
      db && typeof db === "object" ? db : readDb(),
    );
    const effectiveSettings = await measure("resolveSettings", () =>
      settings && typeof settings === "object" ? settings : sanitizeSettings(effectiveDb),
    );
    const payloads = normalizedPlans.flatMap((plan) => plan.payloads);
    const jobIds = payloads.map((payload) => payload.jobId);
    let duplicateCount = 0;
    const jobs = await measure("enqueueBatch", () =>
      enqueueJobs(effectiveDb, payloads, {
        settings: effectiveSettings,
        jobIds,
        onSkippedExisting: (count) => { duplicateCount += count; },
      }),
    );
    return {
      accepted: jobs.length,
      duplicates: duplicateCount,
      skipped: Math.max(0, payloads.length - jobs.length - duplicateCount),
    };
  } catch (error) {
    runtimeMetrics?.recordOperation?.("printSpoolOwner", "error", Date.now() - startedAt);
    throw error;
  } finally {
    runtimeMetrics?.recordOperation?.("printSpoolOwner", "total", Date.now() - startedAt);
  }
}

export function createAutoPrintOwnerForwarder({
  enabled = false,
  getRole = () => "",
  ownerUrl = "",
  serviceToken = "",
  timeoutMs = 1_500,
  fetchWithTimeout,
  runtimeMetrics,
  logger = console,
} = {}) {
  const baseUrl = String(ownerUrl ?? "").trim().replace(/\/+$/, "");
  const token = String(serviceToken ?? "");
  const active = enabled === true && Boolean(baseUrl) && Boolean(token);

  return {
    async forward(plans = []) {
      if (!active || getRole() !== "api-worker") return false;
      const startedAt = Date.now();
      let payload;
      try {
        const normalizedPlans = normalizeAutoPrintOwnerPlans(plans);
        if (normalizedPlans.length === 0) return true;
        payload = { plans: normalizedPlans };
      } catch (error) {
        runtimeMetrics?.incrementCounter?.("printSpoolAutoPrintRemoteOwnerInvalidPayloads");
        runtimeMetrics?.incrementCounter?.("printSpoolAutoPrintRemoteOwnerErrors");
        logger?.warn?.(`[print-spool:auto-print] payload owner non valido: ${error?.message ?? error}`);
        return false;
      }

      const forwardedPlans = payload.plans.length;
      const forwardedJobs = payload.plans.reduce(
        (sum, plan) => sum + plan.payloads.length,
        0,
      );
      runtimeMetrics?.incrementCounter?.("printSpoolAutoPrintRemoteOwnerForwarded");
      runtimeMetrics?.incrementCounter?.(
        "printSpoolAutoPrintRemoteOwnerForwardedPlans",
        forwardedPlans,
      );
      runtimeMetrics?.incrementCounter?.(
        "printSpoolAutoPrintRemoteOwnerForwardedJobs",
        forwardedJobs,
      );
      try {
        const response = await fetchWithTimeout(
          `${baseUrl}/api/internal/print-spool/auto-print`,
          {
            method: "POST",
            timeoutMs,
            headers: {
              "Content-Type": "application/json",
              "X-Service-Token": token,
              "X-V5BT-Internal": "print-spool-auto-print",
            },
            body: JSON.stringify(payload),
          },
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body?.ok !== true) {
          throw new Error(`Owner auto-print HTTP ${response.status}`);
        }
        let result;
        try {
          result = normalizeOwnerResult(body, forwardedJobs);
        } catch (error) {
          runtimeMetrics?.incrementCounter?.("printSpoolAutoPrintRemoteOwnerResultMismatches");
          throw error;
        }
        runtimeMetrics?.incrementCounter?.("printSpoolAutoPrintRemoteOwnerAccepted");
        runtimeMetrics?.incrementCounter?.(
          "printSpoolAutoPrintRemoteOwnerConfirmedPlans",
          forwardedPlans,
        );
        runtimeMetrics?.incrementCounter?.(
          "printSpoolAutoPrintRemoteOwnerConfirmedJobs",
          forwardedJobs,
        );
        runtimeMetrics?.incrementCounter?.(
          "printSpoolAutoPrintRemoteOwnerAcceptedJobs",
          result.accepted,
        );
        runtimeMetrics?.incrementCounter?.(
          "printSpoolAutoPrintRemoteOwnerDuplicateJobs",
          result.duplicates,
        );
        runtimeMetrics?.recordOperation?.(
          "queue",
          "printSpoolAutoPrint.remoteOwner",
          Date.now() - startedAt,
        );
        return true;
      } catch (error) {
        runtimeMetrics?.incrementCounter?.("printSpoolAutoPrintRemoteOwnerErrors");
        if (isAutoPrintOwnerTimeout(error)) {
          runtimeMetrics?.incrementCounter?.("printSpoolAutoPrintRemoteOwnerTimeouts");
        }
        runtimeMetrics?.recordOperation?.(
          "queue",
          "printSpoolAutoPrint.remoteOwnerError",
          Date.now() - startedAt,
        );
        logger?.warn?.(`[print-spool:auto-print] owner remoto non disponibile: ${error?.message ?? error}`);
        return false;
      }
    },
  };
}
