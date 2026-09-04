import { createHash } from "node:crypto";

export const PAYMENT_FREE_SPLIT_MIRROR_PAYLOAD_VERSION = 1;

const COLLECTIONS = Object.freeze([
  "payments",
  "paymentContainers",
  "paymentParts",
  "paymentTransactions",
  "paymentProviderTransactions",
  "cashTxDenoms",
  "fiscalReceipts",
  "fiscalEvents",
  "printSpoolJobs",
  "commercialBenefitApplications",
  "commercialBenefitRedemptions",
  "auditEvents",
]);

const ID_FIELDS = Object.freeze({
  payments: ["id", "paymentId", "clientPaymentId", "idempotencyKey"],
  paymentContainers: ["id", "paymentId", "clientPaymentId", "idempotencyKey"],
  paymentParts: ["id", "partId"],
  paymentTransactions: ["id", "transactionId", "txId"],
  paymentProviderTransactions: ["transactionId", "id", "clientPaymentId", "idempotencyKey"],
  cashTxDenoms: ["id", "transactionId", "paymentTxId", "paymentId"],
  fiscalReceipts: ["id", "receiptId", "fiscalRequestId", "idempotencyKey"],
  fiscalEvents: ["id", "eventId", "fiscalEventId"],
  printSpoolJobs: ["id", "jobId"],
  commercialBenefitApplications: ["id", "applicationId"],
  commercialBenefitRedemptions: ["id", "redemptionId"],
  auditEvents: ["id", "eventId"],
  orders: ["id", "orderId"],
  tables: ["id", "tableId"],
});

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function uniqueText(values = []) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function stableHash(value) {
  let serialized = "{}";
  try {
    serialized = JSON.stringify(value ?? {});
  } catch {
    // fallback stabile per record non serializzabile
  }
  return createHash("sha256").update(serialized).digest("hex");
}

function recordIdentity(collection, record) {
  if (!record || typeof record !== "object") return "";
  for (const field of ID_FIELDS[collection] ?? ["id"]) {
    const value = String(record?.[field] ?? "").trim();
    if (value) return value;
  }
  return `hash:${stableHash(record)}`;
}

function recordEnvelope(collection, record, position = null) {
  const value = cloneJson(record, null);
  if (!value || typeof value !== "object") return null;
  const id = recordIdentity(collection, value);
  if (!id) return null;
  return Number.isSafeInteger(position) && position >= 0
    ? { id, position, value }
    : { id, value };
}

function captureCollection(appState, collection, startedAt, explicitIds = []) {
  const source = Array.isArray(appState?.[collection]) ? appState[collection] : [];
  const startIndex = Math.max(0, Math.trunc(Number(startedAt) || 0));
  const requested = new Set(uniqueText(explicitIds));
  const deduplicated = new Map();
  for (let index = startIndex; index < source.length; index += 1) {
    const envelope = recordEnvelope(collection, source[index], index);
    if (envelope) deduplicated.set(envelope.id, envelope);
  }
  if (requested.size > 0) {
    source.forEach((record, index) => {
      const envelope = recordEnvelope(collection, record, index);
      if (envelope && requested.has(envelope.id)) deduplicated.set(envelope.id, envelope);
    });
  }
  return [...deduplicated.values()];
}

function captureObjectArrayEntries(source, collection, ids) {
  const requested = new Set(uniqueText(ids));
  if (requested.size === 0) return [];
  return (Array.isArray(source) ? source : [])
    .map((record, index) => recordEnvelope(collection, record, index))
    .filter((entry) => entry && requested.has(entry.id));
}

function objectFieldPosition(source, fieldName) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return 0;
  const index = Object.keys(source).indexOf(fieldName);
  return index >= 0 ? index : 0;
}

export function beginPaymentFreeSplitMirrorCapture(appState) {
  return {
    version: PAYMENT_FREE_SPLIT_MIRROR_PAYLOAD_VERSION,
    lengths: Object.fromEntries(
      COLLECTIONS.map((collection) => [
        collection,
        Array.isArray(appState?.[collection]) ? appState[collection].length : 0,
      ]),
    ),
  };
}

export function buildPaymentFreeSplitMirrorPayload(appState, options = {}) {
  const aggregateId = String(
    options.aggregateId ?? options.paymentId ?? options.paymentContainer?.id ?? "",
  ).trim();
  if (!aggregateId) throw new Error("payment mirror aggregateId richiesto.");
  const capture = options.capture && typeof options.capture === "object" ? options.capture : {};
  const explicitIds = options.explicitIds && typeof options.explicitIds === "object"
    ? options.explicitIds
    : {};
  const orderIds = uniqueText(options.orderIds);
  const tableIds = uniqueText(options.tableIds);
  const occurredAt = String(options.occurredAt ?? new Date().toISOString());
  const collections = {};
  for (const collection of COLLECTIONS) {
    const entries = captureCollection(
      appState,
      collection,
      capture?.lengths?.[collection],
      explicitIds[collection],
    );
    if (entries.length > 0) collections[collection] = entries;
  }
  const orders = captureObjectArrayEntries(appState?.integration?.orders, "orders", orderIds);
  const tables = captureObjectArrayEntries(appState?.posSettings?.tables, "tables", tableIds);
  return {
    version: PAYMENT_FREE_SPLIT_MIRROR_PAYLOAD_VERSION,
    kind: "payment.free_split",
    aggregateId,
    idempotencyKey: String(options.idempotencyKey ?? "").trim() || null,
    occurredAt,
    orderIds,
    tableIds,
    auditEventIds: uniqueText(
      (collections.auditEvents ?? []).map((entry) => entry.id),
    ),
    collections,
    integration: {
      orders,
      ordersFieldPosition: objectFieldPosition(appState?.integration, "orders"),
      lastWriteAt: String(appState?.integration?.lastWriteAt ?? occurredAt),
      lastWriteAtFieldPosition: objectFieldPosition(appState?.integration, "lastWriteAt"),
    },
    posSettings: {
      tables,
      tablesFieldPosition: objectFieldPosition(appState?.posSettings, "tables"),
    },
    meta: { lastWriteAt: occurredAt },
  };
}

function numericRevision(record) {
  const value = Math.trunc(
    Number(record?.currentRevision ?? record?.revision ?? record?.aggregateVersion),
  );
  return Number.isFinite(value) && value > 0 ? value : null;
}

function timestampMs(record) {
  for (const field of [
    "updatedAt",
    "fiscalIssuedAt",
    "settledAt",
    "redeemedAt",
    "occurredAt",
    "createdAt",
  ]) {
    const value = Date.parse(String(record?.[field] ?? ""));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function shouldReplaceRecord(current, incoming, { authoritative = false } = {}) {
  if (!current || typeof current !== "object") return true;
  if (authoritative) return true;
  const currentRevision = numericRevision(current);
  const incomingRevision = numericRevision(incoming);
  if (currentRevision !== null || incomingRevision !== null) {
    return (incomingRevision ?? 0) >= (currentRevision ?? 0);
  }
  const currentTimestamp = timestampMs(current);
  const incomingTimestamp = timestampMs(incoming);
  if (currentTimestamp !== null || incomingTimestamp !== null) {
    return (incomingTimestamp ?? 0) >= (currentTimestamp ?? 0);
  }
  return stableHash(current) !== stableHash(incoming);
}

function mergeEnvelopes(target, collection, envelopes, options = {}) {
  const values = Array.isArray(target) ? target : [];
  const indexById = new Map();
  values.forEach((record, index) => {
    const id = recordIdentity(collection, record);
    if (id && !indexById.has(id)) indexById.set(id, index);
  });
  for (const envelope of Array.isArray(envelopes) ? envelopes : []) {
    const id = String(envelope?.id ?? "").trim();
    const incoming = cloneJson(envelope?.value, null);
    if (!id || !incoming || typeof incoming !== "object") continue;
    const index = indexById.get(id);
    if (index === undefined) {
      indexById.set(id, values.length);
      values.push(incoming);
    } else if (shouldReplaceRecord(values[index], incoming, options)) {
      values[index] = incoming;
    }
  }
  return values;
}

function toAuthoritativeEnvelopes(collection, records = []) {
  return (Array.isArray(records) ? records : [])
    .map((record) => recordEnvelope(collection, record))
    .filter(Boolean);
}

export function applyPaymentFreeSplitMirrorPayload(appState, payload, options = {}) {
  if (!appState || typeof appState !== "object") {
    throw new Error("app-state richiesto per applicare payment mirror.");
  }
  if (Number(payload?.version) !== PAYMENT_FREE_SPLIT_MIRROR_PAYLOAD_VERSION) {
    throw new Error(`Versione payment mirror non supportata: ${payload?.version ?? "missing"}.`);
  }
  const latestCollections =
    options.latestCollections && typeof options.latestCollections === "object"
      ? options.latestCollections
      : {};
  for (const collection of COLLECTIONS) {
    const authoritativeRecords = Array.isArray(latestCollections[collection])
      ? latestCollections[collection]
      : [];
    appState[collection] = mergeEnvelopes(
      appState[collection],
      collection,
      authoritativeRecords.length > 0
        ? toAuthoritativeEnvelopes(collection, authoritativeRecords)
        : payload?.collections?.[collection],
      { authoritative: authoritativeRecords.length > 0 },
    );
  }
  if (!appState.integration || typeof appState.integration !== "object") appState.integration = {};
  const latestOrders = Array.isArray(options.latestOrders) && options.latestOrders.length > 0
    ? toAuthoritativeEnvelopes("orders", options.latestOrders)
    : payload?.integration?.orders;
  appState.integration.orders = mergeEnvelopes(
    appState.integration.orders,
    "orders",
    latestOrders,
    { authoritative: Array.isArray(options.latestOrders) && options.latestOrders.length > 0 },
  );
  if (!appState.posSettings || typeof appState.posSettings !== "object") appState.posSettings = {};
  const latestTables = Array.isArray(options.latestTables) && options.latestTables.length > 0
    ? toAuthoritativeEnvelopes("tables", options.latestTables)
    : payload?.posSettings?.tables;
  appState.posSettings.tables = mergeEnvelopes(
    appState.posSettings.tables,
    "tables",
    latestTables,
    { authoritative: Array.isArray(options.latestTables) && options.latestTables.length > 0 },
  );
  const lastWriteAt = String(payload?.meta?.lastWriteAt ?? payload?.occurredAt ?? new Date().toISOString());
  if (!appState.meta || typeof appState.meta !== "object") appState.meta = {};
  appState.meta.lastWriteAt = lastWriteAt;
  appState.integration.lastWriteAt = String(payload?.integration?.lastWriteAt ?? lastWriteAt);
  const collectionEntryIds = Object.fromEntries(
    COLLECTIONS
      .filter((collection) => collection !== "auditEvents" && collection !== "printSpoolJobs")
      .map((collection) => [
        collection,
        uniqueText(
          (Array.isArray(payload?.collections?.[collection])
            ? payload.collections[collection]
            : [])
            .map((entry) => entry?.id),
        ),
      ])
      .filter(([, entryIds]) => entryIds.length > 0),
  );
  return {
    appState,
    mirrorOptions: {
      orderIds: uniqueText(payload?.orderIds),
      tableIds: uniqueText(payload?.tableIds),
      auditEventIds: uniqueText(payload?.auditEventIds),
      collectionEntryIds,
      metricLabel: "payments.freeSplit.durableMirror.appStateWrite",
      allowTransientDefer: false,
    },
  };
}
