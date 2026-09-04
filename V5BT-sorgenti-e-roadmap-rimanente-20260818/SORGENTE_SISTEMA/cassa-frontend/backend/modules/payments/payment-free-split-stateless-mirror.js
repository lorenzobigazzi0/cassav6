import { PAYMENT_FREE_SPLIT_MIRROR_PAYLOAD_VERSION } from "./payment-free-split-mirror-payload.js";

const PAYMENT_RECORD_COLLECTIONS = Object.freeze([
  "payments",
  "paymentContainers",
  "paymentParts",
  "paymentTransactions",
  "paymentProviderTransactions",
  "cashTxDenoms",
  "fiscalReceipts",
  "fiscalEvents",
  "commercialBenefitApplications",
  "commercialBenefitRedemptions",
]);
const STATELESS_COLLECTIONS = new Set([...PAYMENT_RECORD_COLLECTIONS, "auditEvents"]);
const MAX_ENTRY_POSITION = 100_000;
const MAX_FIELD_POSITION = 1_000;

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

function validPosition(value, maximum = MAX_ENTRY_POSITION) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function positionedEnvelope(entry) {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      String(entry.id ?? "").trim() &&
      entry.value &&
      typeof entry.value === "object" &&
      validPosition(entry.position),
  );
}

function positionedEnvelopes(value) {
  const entries = Array.isArray(value) ? value : [];
  return entries.every(positionedEnvelope);
}

function containsIds(envelopes, ids) {
  const available = new Set(envelopes.map((entry) => String(entry.id ?? "").trim()));
  return uniqueText(ids).every((id) => available.has(id));
}

function positionedFields(fields) {
  const active = fields.filter((field) => field.enabled !== false);
  const positions = active.map((field) => field.position);
  return positions.every((position) => validPosition(position, MAX_FIELD_POSITION)) &&
    new Set(positions).size === positions.length;
}

function sparseValues(envelopes, replacements = new Map()) {
  const entries = Array.isArray(envelopes) ? envelopes : [];
  if (entries.length === 0) return [];
  const values = new Array(Math.max(...entries.map((entry) => entry.position)) + 1);
  for (const entry of entries) {
    const id = String(entry.id ?? "").trim();
    const value = replacements.has(id) ? replacements.get(id) : entry.value;
    values[entry.position] = cloneJson(value, entry.value);
  }
  return values;
}

function objectWithPositionedFields(fields) {
  const active = fields.filter((field) => field.enabled !== false);
  if (active.length === 0) return {};
  const byPosition = new Map(active.map((field) => [field.position, field]));
  const value = {};
  const lastPosition = Math.max(...byPosition.keys());
  for (let position = 0; position <= lastPosition; position += 1) {
    const field = byPosition.get(position);
    if (field) value[field.name] = field.value;
    else value[`__payment_mirror_slot_${position}`] = null;
  }
  return value;
}

export function canUsePaymentFreeSplitStatelessMirror(payload) {
  if (
    Number(payload?.version) !== PAYMENT_FREE_SPLIT_MIRROR_PAYLOAD_VERSION ||
    payload?.kind !== "payment.free_split"
  ) {
    return false;
  }
  for (const [collection, entries] of Object.entries(payload?.collections ?? {})) {
    if (Array.isArray(entries) && entries.length > 0 && !STATELESS_COLLECTIONS.has(collection)) {
      return false;
    }
    if (!positionedEnvelopes(entries)) return false;
  }
  const orders = Array.isArray(payload?.integration?.orders) ? payload.integration.orders : [];
  const auditEvents = Array.isArray(payload?.collections?.auditEvents)
    ? payload.collections.auditEvents
    : [];
  if (!positionedEnvelopes(orders) || !containsIds(orders, payload?.orderIds)) return false;
  if (!containsIds(auditEvents, payload?.auditEventIds)) return false;
  return positionedFields([
    {
      enabled: orders.length > 0,
      position: payload?.integration?.ordersFieldPosition,
    },
    {
      enabled: orders.length > 0,
      position: payload?.integration?.lastWriteAtFieldPosition,
    },
  ]);
}

export function buildPaymentFreeSplitStatelessMirror(payload, options = {}) {
  if (!canUsePaymentFreeSplitStatelessMirror(payload)) {
    throw new Error("Payload payment mirror non compatibile con il consumer stateless.");
  }
  const latestOrders = new Map(
    (Array.isArray(options.latestOrders) ? options.latestOrders : [])
      .map((order) => [String(order?.id ?? order?.orderId ?? "").trim(), order])
      .filter(([id, order]) => id && order && typeof order === "object"),
  );
  const orderEntries = Array.isArray(payload?.integration?.orders)
    ? payload.integration.orders
    : [];
  const auditEntries = Array.isArray(payload?.collections?.auditEvents)
    ? payload.collections.auditEvents
    : [];
  const collectionEntryIds = {};
  const latestCollections =
    options.latestCollections && typeof options.latestCollections === "object"
      ? options.latestCollections
      : {};
  const appState = {};
  for (const collection of PAYMENT_RECORD_COLLECTIONS) {
    const entries = Array.isArray(payload?.collections?.[collection])
      ? payload.collections[collection]
      : [];
    if (entries.length === 0) continue;
    const replacements = new Map(
      (Array.isArray(latestCollections[collection])
        ? latestCollections[collection]
        : [])
        .map((record) => [
          String(
            record?.transactionId ??
              record?.id ??
              record?.receiptId ??
              record?.fiscalRequestId ??
              "",
          ).trim(),
          record,
        ])
        .filter(([id, record]) => id && record && typeof record === "object"),
    );
    appState[collection] = sparseValues(entries, replacements);
    collectionEntryIds[collection] = uniqueText(entries.map((entry) => entry.id));
  }
  appState.auditEvents = sparseValues(auditEntries);
  appState.integration = objectWithPositionedFields([
    {
      enabled: orderEntries.length > 0,
      name: "orders",
      position: payload?.integration?.ordersFieldPosition,
      value: sparseValues(orderEntries, latestOrders),
    },
    {
      enabled: orderEntries.length > 0,
      name: "lastWriteAt",
      position: payload?.integration?.lastWriteAtFieldPosition,
      value: String(payload?.integration?.lastWriteAt ?? payload?.occurredAt ?? ""),
    },
  ]);
  appState.meta = {
    lastWriteAt: String(payload?.meta?.lastWriteAt ?? payload?.occurredAt ?? ""),
  };
  return {
    appState,
    mirrorOptions: {
      orderIds: uniqueText(orderEntries.map((entry) => entry.id)),
      tableIds: uniqueText(payload?.tableIds),
      auditEventIds: uniqueText(auditEntries.map((entry) => entry.id)),
      collectionEntryIds,
      metricLabel: "payments.freeSplit.durableMirror.statelessWrite",
      allowTransientDefer: false,
      skipPosSettingsTables: true,
      namedLockPriority: "background",
    },
  };
}
