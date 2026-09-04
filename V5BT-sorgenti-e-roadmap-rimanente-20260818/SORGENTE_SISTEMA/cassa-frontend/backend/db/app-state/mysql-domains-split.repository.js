import { createHash } from "node:crypto";

const OBJECT_RECORD_ID = "__object__";
const VALUE_RECORD_ID = "__value__";
const OBJECT_ARRAY_KIND = "obj_array";
const OBJECT_ARRAY_ENTRY_KIND = "obj_array_entry";
const OBJECT_ARRAY_RECORD_SEPARATOR = ":";
const INTEGRATION_DOMAIN = "integration";
const INTEGRATION_ORDERS_FIELD = "orders";
const INTEGRATION_STATION_STATES_FIELD = "stationStates";
const INTEGRATION_LAST_WRITE_AT_FIELD = "lastWriteAt";
const PAYMENT_PROVIDER_TRANSACTIONS_DOMAIN = "paymentProviderTransactions";
const FISCAL_RECEIPTS_DOMAIN = "fiscalReceipts";
const MUTABLE_PAYMENT_MIRROR_DOMAINS = new Set([
  "payments",
  "paymentContainers",
  PAYMENT_PROVIDER_TRANSACTIONS_DOMAIN,
  FISCAL_RECEIPTS_DOMAIN,
]);
const TERMINAL_PROVIDER_STATUSES = new Set([
  "settled",
  "captured",
  "completed",
  "refunded",
  "voided",
  "cancelled",
  "failed",
  "declined",
]);
const TERMINAL_FISCAL_STATUSES = new Set([
  "ISSUED",
  "FAILED",
  "MANUAL_REQUIRED",
  "CANCELLED",
  "VOIDED",
]);
const ORDER_STATION_MATCH_PRIMARY = "primary";
const ORDER_STATION_MATCH_FALLBACK = "fallback";
const ORDER_STATION_MATCH_TRANSFERRED = "transferred";
const TRANSIENT_DB_ERROR_CODES = new Set([
  "ER_CON_COUNT_ERROR",
  "ER_CHECKREAD",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_NOWAIT",
  "ER_LOCK_WAIT_TIMEOUT",
  "ER_LOCK_TABLE_FULL",
  "ER_QUERY_INTERRUPTED",
  "ER_SERVER_SHUTDOWN",
  "ER_TOO_MANY_USER_CONNECTIONS",
  "ECONNRESET",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
]);
const TRANSIENT_DB_ERRNOS = new Set([1020, 1040, 1041, 1042, 1043, 1205, 1213, 1317, 2006, 2013, 3572]);
const TRANSIENT_DB_SQL_STATES = new Set(["40001", "41000", "HY000", "HYT00", "HYT01"]);

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeIdentifier(value, fallback) {
  const identifier = String(value ?? fallback ?? "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(
      `Identificatore MySQL non valido: ${identifier || "(vuoto)"}`,
    );
  }
  return identifier;
}

function normalizeDomain(value) {
  const domain = String(value ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(domain)) {
    throw new Error(`Dominio app-state non valido: ${domain || "(vuoto)"}`);
  }
  return domain;
}

function quoteIdentifier(identifier) {
  return `\`${identifier}\``;
}

function safeJsonStringify(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function safeJsonParse(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex");
}

function checksumDomainValue(value) {
  return sha256(safeJsonStringify(value, null));
}

function positiveRecordRevision(value) {
  const revisions = [
    value?.currentRevision,
    value?.revision,
    value?.aggregateVersion,
  ]
    .map((entry) => Math.trunc(Number(entry)))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  return revisions.length > 0 ? Math.max(...revisions) : null;
}

function recordTimestampMs(value) {
  const timestamps = [
    "updatedAt",
    "fiscalIssuedAt",
    "settledAt",
    "redeemedAt",
    "occurredAt",
    "createdAt",
  ]
    .map((fieldName) => Date.parse(String(value?.[fieldName] ?? "")))
    .filter((timestamp) => Number.isFinite(timestamp));
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function jsonTimestampMs(rawValue, parsedValue) {
  for (const candidate of [parsedValue, rawValue]) {
    const timestamp = Date.parse(String(candidate ?? ""));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return NaN;
}

function newerIntegrationRecordReason(row, existingRow) {
  if (row?.domain !== INTEGRATION_DOMAIN) return null;
  const existingRawJson = existingRow?.raw_json;
  const existingValue = safeJsonParse(existingRawJson, null);
  const incomingValue = safeJsonParse(row?.rawJson, null);
  const existingHash =
    String(existingRow?.row_hash ?? "").trim() || sha256(existingRawJson);
  const incomingHash = String(row?.rowHash ?? "").trim() || sha256(row?.rawJson);
  if (row.recordId === INTEGRATION_LAST_WRITE_AT_FIELD) {
    const existingTimestamp = jsonTimestampMs(existingRawJson, existingValue);
    const incomingTimestamp = jsonTimestampMs(row?.rawJson, incomingValue);
    if (Number.isFinite(existingTimestamp) && !Number.isFinite(incomingTimestamp)) {
      return "lastWriteAt";
    }
    if (!Number.isFinite(existingTimestamp) && Number.isFinite(incomingTimestamp)) {
      return null;
    }
    if (Number.isFinite(existingTimestamp) && Number.isFinite(incomingTimestamp)) {
      if (existingTimestamp > incomingTimestamp) return "lastWriteAt";
      if (existingTimestamp < incomingTimestamp) return null;
    }
    return existingHash !== incomingHash ? "lastWriteAt" : null;
  }
  if (
    !String(row.recordId).startsWith(
      `${INTEGRATION_ORDERS_FIELD}${OBJECT_ARRAY_RECORD_SEPARATOR}`,
    ) ||
    !existingValue ||
    typeof existingValue !== "object" ||
    !incomingValue ||
    typeof incomingValue !== "object"
  ) {
    return null;
  }
  const existingRevision = positiveRecordRevision(existingValue);
  const incomingRevision = positiveRecordRevision(incomingValue);
  if (existingRevision !== null || incomingRevision !== null) {
    if ((existingRevision ?? 0) > (incomingRevision ?? 0)) return "orders";
    if ((existingRevision ?? 0) < (incomingRevision ?? 0)) return null;
  }
  const existingTimestamp = recordTimestampMs(existingValue);
  const incomingTimestamp = recordTimestampMs(incomingValue);
  if (existingTimestamp !== null && incomingTimestamp === null) return "orders";
  if (existingTimestamp === null && incomingTimestamp !== null) return null;
  if (existingTimestamp !== null && incomingTimestamp !== null) {
    if (existingTimestamp > incomingTimestamp) return "orders";
    if (existingTimestamp < incomingTimestamp) return null;
  }
  return existingHash !== incomingHash ? "orders" : null;
}

function newerStationStateRecordReason(row, existingRow) {
  if (
    row?.domain !== INTEGRATION_DOMAIN ||
    !String(row.recordId).startsWith(
      `${INTEGRATION_STATION_STATES_FIELD}${OBJECT_ARRAY_RECORD_SEPARATOR}`,
    )
  ) {
    return null;
  }
  const existingValue = safeJsonParse(existingRow?.raw_json, null);
  const incomingValue = safeJsonParse(row?.rawJson, null);
  const existingTimestamp = Number(existingValue?.updatedAtMs);
  const incomingTimestamp = Number(incomingValue?.updatedAtMs);
  return Number.isSafeInteger(existingTimestamp) &&
    existingTimestamp > 0 &&
    (!Number.isSafeInteger(incomingTimestamp) ||
      incomingTimestamp <= 0 ||
      existingTimestamp > incomingTimestamp)
    ? "stationStates"
    : null;
}

function normalizedRecordStatus(value) {
  return String(value?.fiscalStatus ?? value?.status ?? "").trim();
}

function genericRecordPreservationDecision(
  existingValue,
  incomingValue,
  existingHash,
  incomingHash,
) {
  const existingRevision = positiveRecordRevision(existingValue);
  const incomingRevision = positiveRecordRevision(incomingValue);
  if (existingRevision !== null || incomingRevision !== null) {
    if ((existingRevision ?? 0) > (incomingRevision ?? 0)) return "preserve";
    if ((existingRevision ?? 0) < (incomingRevision ?? 0)) return "allow";
  }
  const existingTimestamp = recordTimestampMs(existingValue);
  const incomingTimestamp = recordTimestampMs(incomingValue);
  if (existingTimestamp !== null && incomingTimestamp === null) return "preserve";
  if (existingTimestamp === null && incomingTimestamp !== null) return "allow";
  if (existingTimestamp !== null && incomingTimestamp !== null) {
    if (existingTimestamp > incomingTimestamp) return "preserve";
    if (existingTimestamp < incomingTimestamp) return "allow";
  }
  return existingHash !== incomingHash ? "preserve" : "same";
}

function newerPaymentMirrorRecordReason(row, existingRow) {
  if (!MUTABLE_PAYMENT_MIRROR_DOMAINS.has(row?.domain)) return null;
  const existingValue = safeJsonParse(existingRow?.raw_json, null);
  const incomingValue = safeJsonParse(row?.rawJson, null);
  if (
    !existingValue ||
    typeof existingValue !== "object" ||
    !incomingValue ||
    typeof incomingValue !== "object"
  ) {
    return existingRow ? row.domain : null;
  }
  const existingStatus = normalizedRecordStatus(existingValue);
  const incomingStatus = normalizedRecordStatus(incomingValue);
  if (row.domain === FISCAL_RECEIPTS_DOMAIN) {
    const existingFiscalStatus = existingStatus.toUpperCase();
    const incomingFiscalStatus = incomingStatus.toUpperCase();
    if (existingFiscalStatus === "ISSUED" && incomingFiscalStatus !== "ISSUED") {
      return FISCAL_RECEIPTS_DOMAIN;
    }
    if (
      TERMINAL_FISCAL_STATUSES.has(existingFiscalStatus) &&
      !TERMINAL_FISCAL_STATUSES.has(incomingFiscalStatus)
    ) {
      return FISCAL_RECEIPTS_DOMAIN;
    }
    const existingAttempts = Math.max(
      0,
      Math.trunc(Number(existingValue.attemptCount) || 0),
    );
    const incomingAttempts = Math.max(
      0,
      Math.trunc(Number(incomingValue.attemptCount) || 0),
    );
    if (existingAttempts > incomingAttempts) {
      if (!TERMINAL_FISCAL_STATUSES.has(incomingFiscalStatus)) {
        return FISCAL_RECEIPTS_DOMAIN;
      }
      incomingValue.attemptCount = existingAttempts;
      row.rawJson = safeJsonStringify(incomingValue, null);
      row.rowHash = sha256(row.rawJson);
    }
    if (existingAttempts < incomingAttempts) return null;
    if (incomingFiscalStatus === "ISSUED" && existingFiscalStatus !== "ISSUED") {
      return null;
    }
  } else {
    const existingProviderStatus = existingStatus.toLowerCase();
    const incomingProviderStatus = incomingStatus.toLowerCase();
    if (
      TERMINAL_PROVIDER_STATUSES.has(existingProviderStatus) &&
      !TERMINAL_PROVIDER_STATUSES.has(incomingProviderStatus)
    ) {
      return row.domain;
    }
  }
  const existingHash =
    String(existingRow?.row_hash ?? "").trim() || sha256(existingRow?.raw_json);
  const incomingHash = String(row?.rowHash ?? "").trim() || sha256(row?.rawJson);
  return genericRecordPreservationDecision(
    existingValue,
    incomingValue,
    existingHash,
    incomingHash,
  ) === "preserve"
    ? row.domain
    : null;
}

function normalizeRecordId(value, fallback) {
  const raw = String(value ?? fallback ?? "").trim();
  const normalized = raw.replace(/[^\w:.-]+/g, "_").slice(0, 180);
  return normalized || String(fallback ?? VALUE_RECORD_ID);
}

function escapeLikeValue(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

function normalizeStationIndexValue(value) {
  const raw = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  const comparable = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (
    !comparable ||
    ["undefined", "null", "nan", "postazione", "station"].includes(comparable)
  ) {
    return "";
  }
  return raw.toUpperCase().slice(0, 96);
}

function addOrderStationIndexEntry(target, value, matchKind) {
  const station = normalizeStationIndexValue(value);
  if (!station) return;
  target.set(`${matchKind}:${station}`, { station, matchKind });
}

function addOrderStationIndexListEntries(target, values, matchKind) {
  for (const value of Array.isArray(values) ? values : []) {
    addOrderStationIndexEntry(target, value, matchKind);
  }
}

function collectOrderStationIndexEntries(order) {
  const entries = new Map();
  if (!order || typeof order !== "object") return [];

  const primaryFields = [
    order.assignedStationId,
    order.ownerStation,
    order.lockedByStationId,
  ].filter((entry) => String(entry ?? "").trim());
  if (primaryFields.length > 0) {
    primaryFields.forEach((entry) =>
      addOrderStationIndexEntry(entries, entry, ORDER_STATION_MATCH_PRIMARY),
    );
  } else if (String(order.station ?? "").trim()) {
    addOrderStationIndexEntry(
      entries,
      order.station,
      ORDER_STATION_MATCH_FALLBACK,
    );
  } else {
    for (const item of Array.isArray(order.items) ? order.items : []) {
      addOrderStationIndexListEntries(
        entries,
        item?.routeStations,
        ORDER_STATION_MATCH_FALLBACK,
      );
    }
    for (const ticket of Array.isArray(order.tickets) ? order.tickets : []) {
      addOrderStationIndexEntry(
        entries,
        ticket?.stationId,
        ORDER_STATION_MATCH_FALLBACK,
      );
    }
    for (const route of Array.isArray(order.lineRoutes) ? order.lineRoutes : []) {
      addOrderStationIndexEntry(
        entries,
        route?.stationId,
        ORDER_STATION_MATCH_FALLBACK,
      );
    }
  }

  [order.transferredFromStation, order.transferredToStation].forEach((entry) =>
    addOrderStationIndexEntry(entries, entry, ORDER_STATION_MATCH_TRANSFERRED),
  );

  return [...entries.values()];
}

function collectOrderStationIndexRows(rows, domain, fieldName) {
  const result = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const kind = String(row?.kind ?? "").trim();
    if (kind !== OBJECT_ARRAY_ENTRY_KIND) continue;
    const recordId = String(row?.recordId ?? row?.record_id ?? "").trim();
    if (!recordId.startsWith(`${fieldName}${OBJECT_ARRAY_RECORD_SEPARATOR}`)) {
      continue;
    }
    const appStatePosition = Number(
      row?.appStatePosition ?? row?.app_state_position ?? 0,
    );
    const order = safeJsonParse(row?.rawJson ?? row?.raw_json, null);
    for (const entry of collectOrderStationIndexEntries(order)) {
      const key = `${domain}:${fieldName}:${entry.station}:${entry.matchKind}:${recordId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        domain,
        fieldName,
        station: entry.station,
        matchKind: entry.matchKind,
        orderRecordId: recordId,
        appStatePosition: Number.isFinite(appStatePosition)
          ? appStatePosition
          : 0,
      });
    }
  }
  return result;
}

function normalizeDomainSplitRollbackCause(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  const errno = Number(error?.errno ?? error?.errorno ?? NaN);
  const sqlState = String(error?.sqlState ?? error?.sqlstate ?? "")
    .trim()
    .toUpperCase();
  const message = String(error?.message ?? "").toLowerCase();
  const status = Number(error?.status ?? error?.statusCode ?? NaN);
  const name = String(error?.name ?? "").trim();

  if (
    code === "REVISION_CONFLICT" ||
    name === "RevisionConflictError" ||
    status === 409
  ) {
    return "revisionConflict";
  }
  if (code === "ER_DUP_ENTRY" || errno === 1062) return "duplicate";
  if (
    TRANSIENT_DB_ERROR_CODES.has(code) ||
    TRANSIENT_DB_ERRNOS.has(errno) ||
    (TRANSIENT_DB_SQL_STATES.has(sqlState) &&
      /(record has changed since last read|deadlock|lock wait|timeout|connection|server has gone away|database is locked)/i.test(
        message,
      )) ||
    /(record has changed since last read|deadlock|lock wait timeout|database is locked|connection lost|server has gone away)/i.test(
      message,
    )
  ) {
    return "transientDbError";
  }
  return "unknown";
}

function nestedArrayRecordId(fieldName, entry, position) {
  const itemId = recordIdFromArrayEntry(fieldName, entry, position);
  return normalizeRecordId(
    `${fieldName}${OBJECT_ARRAY_RECORD_SEPARATOR}${itemId}`,
    `${fieldName}_${position}`,
  );
}

function recordIdFromArrayEntry(domain, entry, position) {
  if (entry && typeof entry === "object") {
    if (domain === "stationStates") {
      const stationKey = [
        entry.station ?? entry.stationName,
        entry.operatorUserId ?? entry.userId,
        entry.operatorUsername ?? entry.username,
        entry.deviceUuid ?? entry.deviceId,
      ]
        .map((part) => String(part ?? "").trim())
        .filter(Boolean)
        .join("|");
      return normalizeRecordId(entry.id ?? stationKey, `${domain}_${position}`);
    }
    return normalizeRecordId(
      entry.id ??
        (domain === "posReservationStates" ? entry.key : null) ??
        entry.sessionId ??
        entry.orderId ??
        entry.paymentId ??
        entry.containerId ??
        entry.partId ??
        entry.transactionId ??
        entry.receiptId ??
        entry.eventId ??
        entry.requestId ??
        entry.lockId ??
        entry.customerId ??
        entry.deviceUuid ??
        entry.tableId,
      `${domain}_${position}`,
    );
  }
  return normalizeRecordId(null, `${domain}_${position}`);
}

function objectFieldPosition(value, fieldName) {
  if (!value || typeof value !== "object") return 0;
  const index = Object.keys(value).indexOf(fieldName);
  return index >= 0 ? index : 0;
}

function normalizeObjectEntryRow(domain, fieldName, value, position = 0) {
  const rawJson = safeJsonStringify(value, null);
  return {
    domain,
    recordId: normalizeRecordId(fieldName, fieldName),
    kind: "object_entry",
    appStatePosition: Number.isFinite(Number(position)) ? Number(position) : 0,
    rawJson,
    rowHash: sha256(rawJson),
  };
}

function normalizeObjectArrayFieldRows(domain, fieldName, value, position = 0) {
  const entries = Array.isArray(value) ? value : [];
  const metaRawJson = safeJsonStringify([], []);
  return [
    {
      domain,
      recordId: normalizeRecordId(fieldName, fieldName),
      kind: OBJECT_ARRAY_KIND,
      appStatePosition: Number.isFinite(Number(position)) ? Number(position) : 0,
      rawJson: metaRawJson,
      rowHash: sha256(metaRawJson),
    },
    ...entries.map((item, itemIndex) => {
      const rawJson = safeJsonStringify(item, null);
      return {
        domain,
        recordId: nestedArrayRecordId(fieldName, item, itemIndex),
        kind: OBJECT_ARRAY_ENTRY_KIND,
        appStatePosition: itemIndex,
        rawJson,
        rowHash: sha256(rawJson),
      };
    }),
  ];
}

function normalizeObjectArrayEntryRows(
  domain,
  fieldName,
  value,
  selectedEntryIds,
  position = 0,
) {
  const entries = Array.isArray(value) ? value : [];
  const wantedIds = new Set(
    (Array.isArray(selectedEntryIds) ? selectedEntryIds : [])
      .map((entry) => normalizeRecordId(entry, entry))
      .filter(Boolean),
  );
  const metaRawJson = safeJsonStringify([], []);
  return [
    {
      domain,
      recordId: normalizeRecordId(fieldName, fieldName),
      kind: OBJECT_ARRAY_KIND,
      appStatePosition: Number.isFinite(Number(position)) ? Number(position) : 0,
      rawJson: metaRawJson,
      rowHash: sha256(metaRawJson),
    },
    ...entries.flatMap((item, itemIndex) => {
      const itemId = recordIdFromArrayEntry(fieldName, item, itemIndex);
      if (wantedIds.size > 0 && !wantedIds.has(itemId)) return [];
      const rawJson = safeJsonStringify(item, null);
      return {
        domain,
        recordId: nestedArrayRecordId(fieldName, item, itemIndex),
        kind: OBJECT_ARRAY_ENTRY_KIND,
        appStatePosition: itemIndex,
        rawJson,
        rowHash: sha256(rawJson),
      };
    }),
  ];
}

function normalizeDomainArrayEntryRows(domain, value, selectedEntryIds) {
  const selectedIds = new Set(
    (Array.isArray(selectedEntryIds) ? selectedEntryIds : [])
      .map((entry) => normalizeRecordId(entry, entry))
      .filter(Boolean),
  );
  if (selectedIds.size === 0) return [];
  return normalizeDomainValue(domain, value).filter(
    (row) => row.kind === "array" && selectedIds.has(row.recordId),
  );
}

function normalizeDomainValue(domain, value, options = {}) {
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const rawJson = safeJsonStringify(entry, null);
      return {
        domain,
        recordId: recordIdFromArrayEntry(domain, entry, index),
        kind: "array",
        appStatePosition: index,
        rawJson,
        rowHash: sha256(rawJson),
      };
    });
  }

  if (value && typeof value === "object") {
    if (options.objectAsEntries === true) {
      const objectArrayEntryFields = new Set(
        (Array.isArray(options.objectArrayEntryFields)
          ? options.objectArrayEntryFields
          : []
        )
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean),
      );
      return Object.entries(value).flatMap(([key, entry], index) => {
        if (objectArrayEntryFields.has(key) && Array.isArray(entry)) {
          const metaRawJson = safeJsonStringify([], []);
          return [
            {
              domain,
              recordId: normalizeRecordId(key, `${domain}_${index}`),
              kind: OBJECT_ARRAY_KIND,
              appStatePosition: index,
              rawJson: metaRawJson,
              rowHash: sha256(metaRawJson),
            },
            ...entry.map((item, itemIndex) => {
              const rawJson = safeJsonStringify(item, null);
              return {
                domain,
                recordId: nestedArrayRecordId(key, item, itemIndex),
                kind: OBJECT_ARRAY_ENTRY_KIND,
                appStatePosition: itemIndex,
                rawJson,
                rowHash: sha256(rawJson),
              };
            }),
          ];
        }
        const rawJson = safeJsonStringify(entry, null);
        return {
          domain,
          recordId: normalizeRecordId(key, `${domain}_${index}`),
          kind: "object_entry",
          appStatePosition: index,
          rawJson,
          rowHash: sha256(rawJson),
        };
      });
    }
    const rawJson = safeJsonStringify(value, {});
    return [
      {
        domain,
        recordId: OBJECT_RECORD_ID,
        kind: "object",
        appStatePosition: 0,
        rawJson,
        rowHash: sha256(rawJson),
      },
    ];
  }

  const rawJson = safeJsonStringify(value, null);
  return [
    {
      domain,
      recordId: VALUE_RECORD_ID,
      kind: "value",
      appStatePosition: 0,
      rawJson,
      rowHash: sha256(rawJson),
    },
  ];
}

function rowsToDomainValue(rows, fallback) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (normalizedRows.length === 0) return fallback;
  const firstKind = String(normalizedRows[0]?.kind ?? "");
  if (firstKind === "object") {
    return safeJsonParse(normalizedRows[0]?.raw_json, {});
  }
  if (
    normalizedRows.some((row) =>
      ["object_entry", OBJECT_ARRAY_KIND, OBJECT_ARRAY_ENTRY_KIND].includes(
        String(row?.kind ?? ""),
      ),
    )
  ) {
    const objectValue = {};
    const nestedArrays = new Map();
    normalizedRows.forEach((row) => {
      const kind = String(row?.kind ?? "");
      const recordId = String(row?.record_id ?? "").trim();
      if (!recordId) return;
      if (kind === "object_entry") {
        objectValue[recordId] = safeJsonParse(row?.raw_json, null);
        return;
      }
      if (kind === OBJECT_ARRAY_KIND) {
        objectValue[recordId] = [];
        if (!nestedArrays.has(recordId)) nestedArrays.set(recordId, []);
        return;
      }
      if (kind === OBJECT_ARRAY_ENTRY_KIND) {
        const separatorIndex = recordId.indexOf(OBJECT_ARRAY_RECORD_SEPARATOR);
        if (separatorIndex <= 0) return;
        const fieldName = recordId.slice(0, separatorIndex);
        if (!nestedArrays.has(fieldName)) nestedArrays.set(fieldName, []);
        nestedArrays.get(fieldName).push(row);
      }
    });
    nestedArrays.forEach((arrayRows, fieldName) => {
      objectValue[fieldName] = [...arrayRows]
        .sort((left, right) => {
          const leftPosition = Number(left?.app_state_position ?? 0);
          const rightPosition = Number(right?.app_state_position ?? 0);
          if (leftPosition !== rightPosition) return leftPosition - rightPosition;
          return String(left?.record_id ?? "").localeCompare(
            String(right?.record_id ?? ""),
          );
        })
        .map((row) => safeJsonParse(row?.raw_json, null))
        .filter((entry) => entry !== null && entry !== undefined);
    });
    return objectValue;
  }
  if (firstKind === "value") {
    return safeJsonParse(normalizedRows[0]?.raw_json, null);
  }
  return normalizedRows
    .map((row) => safeJsonParse(row?.raw_json, null))
    .filter((entry) => entry !== null && entry !== undefined);
}

function defaultEmptyValue(value) {
  if (Array.isArray(value)) return [];
  if (value && typeof value === "object") return {};
  return null;
}

function buildRecordState(rows) {
  const state = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const recordId = String(row.recordId ?? row.record_id ?? "").trim();
    if (!recordId) continue;
    state.set(recordId, {
      appStatePosition: Number(row.appStatePosition ?? row.app_state_position ?? 0),
      kind: String(row.kind ?? ""),
      rowHash: String(row.rowHash ?? row.row_hash ?? ""),
    });
  }
  return state;
}

function normalizeDomainSelection(value) {
  if (!Array.isArray(value)) return null;
  const selected = new Set(
    value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
      .map(normalizeDomain),
  );
  return selected.size > 0 ? selected : null;
}

export function sortDomainRowsForLockOrder(rows) {
  return [...(Array.isArray(rows) ? rows : [])]
    .filter((row) => row?.domain && row?.recordId)
    .sort((left, right) => {
      const domainOrder = String(left.domain).localeCompare(String(right.domain));
      if (domainOrder !== 0) return domainOrder;
      return String(left.recordId).localeCompare(String(right.recordId));
    });
}

function dedupeDomainRowsForWrite(rows) {
  const rowsByKey = new Map();
  for (const row of sortDomainRowsForLockOrder(rows)) {
    if (!row?.domain || !row?.recordId) continue;
    rowsByKey.set(`${row.domain}\u0000${row.recordId}`, row);
  }
  return sortDomainRowsForLockOrder([...rowsByKey.values()]);
}

async function deleteDomainRecords(connection, tableSql, domain, recordIds) {
  const ids = [...new Set(Array.isArray(recordIds) ? recordIds.filter(Boolean) : [])]
    .sort((left, right) => String(left).localeCompare(String(right)));
  const chunkSize = 100;
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    await connection.query(
      `DELETE FROM ${tableSql} WHERE domain = ? AND record_id IN (${placeholders})`,
      [domain, ...chunk],
    );
  }
}

export function createMysqlAppStateDomainsSplitRepository(options = {}) {
  const enabled = normalizeBoolean(options.enabled, false);
  const tableName = normalizeIdentifier(
    options.tableName,
    "app_state_domain_records",
  );
  const tableSql = quoteIdentifier(tableName);
  const orderStationIndexTableName = normalizeIdentifier(
    options.orderStationIndexTableName,
    `${tableName}_order_station_index`,
  );
  const orderStationIndexTableSql = quoteIdentifier(orderStationIndexTableName);
  const logger = options.logger ?? console;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const mysqlRepository = options.mysqlRepository;
  const runtimeMetrics =
    options.runtimeMetrics &&
    typeof options.runtimeMetrics.recordOperation === "function"
      ? options.runtimeMetrics
      : null;
  const orderEntryBatchUpsert = normalizeBoolean(options.orderEntryBatchUpsert, false);
  const stationStatesPartialMarkerLockElision = normalizeBoolean(
    options.stationStatesPartialMarkerLockElision,
    false,
  );
  const domains = Array.from(
    new Set(
      (Array.isArray(options.domains) ? options.domains : []).map(
        normalizeDomain,
      ),
    ),
  );
  const objectEntryDomains = new Set(
    (Array.isArray(options.objectEntryDomains)
      ? options.objectEntryDomains
      : []
    ).map(normalizeDomain),
  );
  const objectArrayEntryFieldsByDomain = new Map();
  if (
    options.objectArrayEntryFields &&
    typeof options.objectArrayEntryFields === "object"
  ) {
    for (const [rawDomain, rawFields] of Object.entries(
      options.objectArrayEntryFields,
    )) {
      const domain = normalizeDomain(rawDomain);
      const fields = (Array.isArray(rawFields) ? rawFields : [])
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean);
      if (fields.length > 0) {
        objectArrayEntryFieldsByDomain.set(domain, fields);
      }
    }
  }
  let ensured = false;
  const lastDomainChecksums = new Map();
  const lastDomainRecordStates = new Map();

  function recordDomainSplitMetricValue(label, durationMs = 0) {
    runtimeMetrics?.recordOperation?.(
      "appStateDomainSplit",
      label,
      Math.max(0, Number.isFinite(Number(durationMs)) ? Number(durationMs) : 0),
    );
  }

  function recordDomainSplitMetric(label, startedAt) {
    recordDomainSplitMetricValue(label, Date.now() - startedAt);
  }

  async function applyStationStatesPartialMarkerLockElision(
    connection,
    rows,
    { eligible = false } = {},
  ) {
    if (!stationStatesPartialMarkerLockElision || !eligible) return rows;
    const metricPrefix =
      `${INTEGRATION_DOMAIN}.${INTEGRATION_STATION_STATES_FIELD}.entries`;
    const markerProbeStartedAt = Date.now();
    const [markerRows] = await connection.query(
      `
        SELECT record_id, kind, app_state_position, row_hash, raw_json
        FROM ${tableSql}
        WHERE domain = ? AND record_id = ?
        LIMIT 1
      `,
      [INTEGRATION_DOMAIN, INTEGRATION_STATION_STATES_FIELD],
    );
    recordDomainSplitMetric(
      `${metricPrefix}.markerLockElision.probe`,
      markerProbeStartedAt,
    );
    const expectedMarker = rows.find(
      (row) =>
        row.domain === INTEGRATION_DOMAIN &&
        row.recordId === INTEGRATION_STATION_STATES_FIELD &&
        row.kind === OBJECT_ARRAY_KIND,
    );
    const markerRow = (Array.isArray(markerRows) ? markerRows : []).find(
      (row) =>
        String(row?.record_id ?? "").trim() ===
        INTEGRATION_STATION_STATES_FIELD,
    );
    const markerRawJson =
      typeof markerRow?.raw_json === "string"
        ? markerRow.raw_json
        : safeJsonStringify(markerRow?.raw_json, null);
    const markerValue = safeJsonParse(markerRawJson, null);
    const markerIsCanonical =
      expectedMarker &&
      markerRow?.kind === OBJECT_ARRAY_KIND &&
      Number(markerRow?.app_state_position) === expectedMarker.appStatePosition &&
      Array.isArray(markerValue) &&
      markerValue.length === 0 &&
      String(markerRow?.row_hash ?? "").trim() === sha256(markerRawJson);
    if (!markerIsCanonical) {
      recordDomainSplitMetricValue(
        `${metricPrefix}.markerLockElision.canonicalFallback`,
        0,
      );
      if (!expectedMarker) return rows;

      // Creazione/riparazione separata: il marker diventa il punto di
      // serializzazione prima dei lock sulle entry ancora assenti. Inserirlo
      // nello stesso batch delle entry puo' creare un ciclo tra PRIMARY e
      // l'indice secondario domain/position durante il bootstrap concorrente.
      const markerRepairStartedAt = Date.now();
      await upsertDomainRowsBatch(connection, [expectedMarker], metricPrefix);
      recordDomainSplitMetric(
        `${metricPrefix}.markerLockElision.canonicalRepair`,
        markerRepairStartedAt,
      );
      return rows.filter((row) => row !== expectedMarker);
    }

    const entryRecordIds = [
      ...new Set(
        rows
          .filter(
            (row) =>
              row.domain === INTEGRATION_DOMAIN &&
              row.kind === OBJECT_ARRAY_ENTRY_KIND &&
              row.recordId.startsWith(
                `${INTEGRATION_STATION_STATES_FIELD}${OBJECT_ARRAY_RECORD_SEPARATOR}`,
              ),
          )
          .map((row) => row.recordId),
      ),
    ].sort((left, right) => left.localeCompare(right));
    if (entryRecordIds.length > 0) {
      const placeholders = entryRecordIds.map(() => "?").join(", ");
      const entryProbeStartedAt = Date.now();
      const [existingEntryRows] = await connection.query(
        `
          SELECT record_id
          FROM ${tableSql} FORCE INDEX (PRIMARY)
          WHERE domain = ? AND record_id IN (${placeholders})
          ORDER BY record_id ASC
        `,
        [INTEGRATION_DOMAIN, ...entryRecordIds],
      );
      recordDomainSplitMetric(
        `${metricPrefix}.markerLockElision.entryProbe`,
        entryProbeStartedAt,
      );
      const existingEntryIds = new Set(
        (Array.isArray(existingEntryRows) ? existingEntryRows : [])
          .map((row) => String(row?.record_id ?? "").trim())
          .filter(Boolean),
      );
      if (entryRecordIds.some((recordId) => !existingEntryIds.has(recordId))) {
        const serializationStartedAt = Date.now();
        // Il no-op canonico acquisisce il marker prima dei gap lock sulle
        // entry assenti. Solo la creazione viene serializzata; gli heartbeat
        // di entry gia' presenti continuano a non condividere questo lock.
        await upsertDomainRowsBatch(connection, [expectedMarker], metricPrefix);
        recordDomainSplitMetric(
          `${metricPrefix}.markerLockElision.entryBootstrapSerialization`,
          serializationStartedAt,
        );
      }
    }
    recordDomainSplitMetricValue(
      `${metricPrefix}.markerLockElision.applied`,
      0,
    );
    return rows.filter(
      (row) =>
        !(
          row.domain === INTEGRATION_DOMAIN &&
          row.recordId === INTEGRATION_STATION_STATES_FIELD &&
          row.kind === OBJECT_ARRAY_KIND
        ),
    );
  }

  async function query(sql, params = []) {
    if (!mysqlRepository || typeof mysqlRepository.query !== "function") {
      throw new Error("Repository MySQL non disponibile per split domini.");
    }
    return mysqlRepository.query(sql, params);
  }

  async function withConnection(callback, options = {}) {
    const metricPrefix =
      typeof options.metricPrefix === "string" && options.metricPrefix.trim()
        ? options.metricPrefix.trim()
        : "";
    const poolStartedAt = Date.now();
    const pool = await mysqlRepository.getPool();
    if (metricPrefix) recordDomainSplitMetric(`${metricPrefix}.getPool`, poolStartedAt);
    const connectionStartedAt = Date.now();
    const connection = await pool.getConnection();
    if (metricPrefix) recordDomainSplitMetric(`${metricPrefix}.getConnection`, connectionStartedAt);
    try {
      return await callback(connection);
    } finally {
      const releaseStartedAt = Date.now();
      connection.release();
      if (metricPrefix) recordDomainSplitMetric(`${metricPrefix}.release`, releaseStartedAt);
    }
  }

  async function ensure() {
    if (!enabled || ensured) return;
    await query(`
      CREATE TABLE IF NOT EXISTS ${tableSql} (
        domain VARCHAR(96) NOT NULL,
        record_id VARCHAR(191) NOT NULL,
        kind VARCHAR(16) NOT NULL,
        app_state_position INT NOT NULL DEFAULT 0,
        row_hash CHAR(64) NOT NULL,
        raw_json JSON NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (domain, record_id),
        INDEX idx_app_state_domain_records_domain_position (domain, app_state_position),
        INDEX idx_app_state_domain_records_hash (domain, row_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS ${orderStationIndexTableSql} (
        domain VARCHAR(96) NOT NULL,
        field_name VARCHAR(96) NOT NULL,
        station VARCHAR(96) NOT NULL,
        match_kind VARCHAR(16) NOT NULL,
        order_record_id VARCHAR(191) NOT NULL,
        app_state_position INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (domain, field_name, station, match_kind, order_record_id),
        INDEX idx_order_station_lookup (domain, field_name, station, match_kind, app_state_position),
        INDEX idx_order_station_record (domain, field_name, order_record_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    ensured = true;
    try {
      await backfillIntegrationOrderStationIndexIfNeeded();
    } catch (error) {
      logger.warn?.(
        `[backend] Indice ordini/postazioni non backfillato: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function listDomainRows(domain) {
    if (!enabled) return [];
    await ensure();
    return query(
      `
        SELECT domain, record_id, kind, app_state_position, row_hash, raw_json
        FROM ${tableSql}
        WHERE domain = ?
        ORDER BY app_state_position ASC, record_id ASC
      `,
      [domain],
    );
  }

  async function readDomainValue(domain, fallback = null) {
    if (!enabled) return fallback;
    const normalizedDomain = normalizeDomain(domain);
    return rowsToDomainValue(await listDomainRows(normalizedDomain), fallback);
  }

  async function readObjectEntry(domain, fieldName, fallback = null) {
    if (!enabled) return fallback;
    await ensure();
    const normalizedDomain = normalizeDomain(domain);
    const normalizedFieldName = String(fieldName ?? "").trim();
    if (!normalizedFieldName) return fallback;
    const rows = await query(
      `
        SELECT raw_json
        FROM ${tableSql}
        WHERE domain = ? AND record_id = ?
        LIMIT 1
      `,
      [normalizedDomain, normalizedFieldName],
    );
    return safeJsonParse(rows?.[0]?.raw_json, fallback);
  }

  async function readObjectArrayEntry(
    domain,
    fieldName,
    entryId,
    fallback = null,
  ) {
    if (!enabled) return fallback;
    await ensure();
    const normalizedDomain = normalizeDomain(domain);
    const normalizedFieldName = String(fieldName ?? "").trim();
    const normalizedEntryId = normalizeRecordId(entryId, "");
    if (!normalizedFieldName || !normalizedEntryId) return fallback;
    const recordId = normalizeRecordId(
      `${normalizedFieldName}${OBJECT_ARRAY_RECORD_SEPARATOR}${normalizedEntryId}`,
      "",
    );
    if (!recordId) return fallback;
    const rows = await query(
      `
        SELECT raw_json
        FROM ${tableSql}
        WHERE domain = ? AND record_id = ?
        LIMIT 1
      `,
      [normalizedDomain, recordId],
    );
    return safeJsonParse(rows?.[0]?.raw_json, fallback);
  }

  // Allocatore atomico cross-processo per il contatore ordini: serializza le
  // allocazioni tra owner e pool di api-worker con un row-lock sul record
  // integration/sequence. Ritorna il valore allocato (semantica "next id").
  async function incrementIntegrationOrderSequence(seedSequence = null, options = {}) {
    if (!enabled) return null;
    const minimumNextOrder = Math.max(
      0,
      Math.trunc(Number(
        typeof options === "number" ? options : options?.minimumNextOrder,
      ) || 0),
    );
    await ensure();
    return withConnection(async (connection) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await connection.beginTransaction();
        try {
          const [rows] = await connection.query(
            `SELECT raw_json FROM ${tableSql} WHERE domain = ? AND record_id = ? FOR UPDATE`,
            ["integration", "sequence"],
          );
          const sequence = safeJsonParse(rows?.[0]?.raw_json, null);
          if (!sequence || typeof sequence !== "object") {
            await connection.rollback();
            // Il record puo' non esistere ancora (seed appena importato): lo si
            // inizializza dal contatore del chiamante e si riprova il row-lock.
            if (attempt > 0 || ((!seedSequence || typeof seedSequence !== "object") && minimumNextOrder <= 0)) return null;
            const seededOrder = Math.max(
              1,
              Math.trunc(Number(seedSequence?.order) || 1),
              minimumNextOrder,
            );
            const seedRawJson = safeJsonStringify({ ...(seedSequence && typeof seedSequence === "object" ? seedSequence : {}), order: seededOrder }, null);
            if (!seedRawJson) return null;
            await connection.query(
              `INSERT IGNORE INTO ${tableSql} (domain, record_id, kind, app_state_position, row_hash, raw_json) VALUES (?, ?, ?, ?, ?, ?)`,
              ["integration", "sequence", "object_entry", 0, sha256(seedRawJson), seedRawJson],
            );
            continue;
          }
          const current = Math.max(
            1,
            Math.trunc(Number(sequence.order) || 1),
            minimumNextOrder,
          );
          const nextSequence = { ...sequence, order: current + 1 };
          const rawJson = safeJsonStringify(nextSequence, null);
          await connection.query(
            `UPDATE ${tableSql} SET raw_json = ?, row_hash = ? WHERE domain = ? AND record_id = ?`,
            [rawJson, sha256(rawJson), "integration", "sequence"],
          );
          await connection.commit();
          return current;
        } catch (error) {
          try {
            await connection.rollback();
          } catch {
            // ignora: la connessione viene comunque rilasciata da withConnection
          }
          throw error;
        }
      }
      return null;
    });
  }

  async function readObjectArrayField(domain, fieldName, fallback = []) {
    if (!enabled) return fallback;
    await ensure();
    const normalizedDomain = normalizeDomain(domain);
    const normalizedFieldName = String(fieldName ?? "").trim();
    if (!normalizedFieldName) return fallback;
    const rows = await query(
      `
        SELECT domain, record_id, kind, app_state_position, row_hash, raw_json
        FROM ${tableSql}
        WHERE domain = ?
          AND (record_id = ? OR record_id LIKE ?)
        ORDER BY app_state_position ASC, record_id ASC
      `,
      [
        normalizedDomain,
        normalizedFieldName,
        `${normalizedFieldName}${OBJECT_ARRAY_RECORD_SEPARATOR}%`,
      ],
    );
    const value = rowsToDomainValue(rows, { [normalizedFieldName]: fallback })?.[normalizedFieldName];
    return Array.isArray(value) ? value : fallback;
  }

  async function readObjectArrayFieldMatchingText(domain, fieldName, searchText, fallback = []) {
    if (!enabled) return fallback;
    await ensure();
    const normalizedDomain = normalizeDomain(domain);
    const normalizedFieldName = String(fieldName ?? "").trim();
    const needle = String(searchText ?? "").trim();
    if (!normalizedFieldName || !needle) return fallback;
    const rows = await query(
      `
        SELECT domain, record_id, kind, app_state_position, row_hash, raw_json
        FROM ${tableSql}
        WHERE domain = ?
          AND (
            record_id = ?
            OR (
              record_id LIKE ?
              AND LOWER(CAST(raw_json AS CHAR)) LIKE LOWER(?) ESCAPE '\\\\'
            )
          )
        ORDER BY app_state_position ASC, record_id ASC
      `,
      [
        normalizedDomain,
        normalizedFieldName,
        `${normalizedFieldName}${OBJECT_ARRAY_RECORD_SEPARATOR}%`,
        `%${escapeLikeValue(needle)}%`,
      ],
    );
    const value = rowsToDomainValue(rows, { [normalizedFieldName]: fallback })?.[normalizedFieldName];
    return Array.isArray(value) ? value : fallback;
  }

  async function readIntegrationOrdersForStation(station, options = {}) {
    if (!enabled) return options.fallback ?? null;
    await ensure();
    const normalizedStation = normalizeStationIndexValue(station);
    if (!normalizedStation) return options.fallback ?? null;
    const includeTransferred = normalizeBoolean(options.includeTransferred, false);
    const matchKinds = includeTransferred
      ? [
          ORDER_STATION_MATCH_PRIMARY,
          ORDER_STATION_MATCH_FALLBACK,
          ORDER_STATION_MATCH_TRANSFERRED,
        ]
      : [ORDER_STATION_MATCH_PRIMARY, ORDER_STATION_MATCH_FALLBACK];
    const matchKindPlaceholders = matchKinds.map(() => "?").join(", ");
    const rows = await query(
      `
        SELECT records.domain, records.record_id, records.kind,
          records.app_state_position, records.row_hash, records.raw_json
        FROM ${tableSql} records
        INNER JOIN (
          SELECT order_record_id, MIN(app_state_position) AS app_state_position
          FROM ${orderStationIndexTableSql}
          WHERE domain = ?
            AND field_name = ?
            AND station = ?
            AND match_kind IN (${matchKindPlaceholders})
          GROUP BY order_record_id
        ) station_orders
          ON station_orders.order_record_id = records.record_id
        WHERE records.domain = ?
        ORDER BY station_orders.app_state_position ASC, records.record_id ASC
      `,
      [
        INTEGRATION_DOMAIN,
        INTEGRATION_ORDERS_FIELD,
        normalizedStation,
        ...matchKinds,
        INTEGRATION_DOMAIN,
      ],
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      const markerRows = await query(
        `
          SELECT order_record_id
          FROM ${orderStationIndexTableSql}
          WHERE domain = ? AND field_name = ?
          LIMIT 1
        `,
        [INTEGRATION_DOMAIN, INTEGRATION_ORDERS_FIELD],
      );
      return Array.isArray(markerRows) && markerRows.length > 0
        ? []
        : (options.fallback ?? null);
    }
    const value = rowsToDomainValue(rows, {
      [INTEGRATION_ORDERS_FIELD]: [],
    })?.[INTEGRATION_ORDERS_FIELD];
    return Array.isArray(value) ? value : [];
  }

  async function hydrateAppState(appState) {
    if (!enabled || !appState || typeof appState !== "object") return appState;
    await ensure();
    const hydrated = cloneJson(appState, appState);
    for (const domain of domains) {
      const rows = await listDomainRows(domain);
      if (rows.length === 0) {
        const sourceValue = appState[domain];
        const hasSourceData = Array.isArray(sourceValue)
          ? sourceValue.length > 0
          : sourceValue && typeof sourceValue === "object"
            ? Object.keys(sourceValue).length > 0
            : sourceValue !== undefined && sourceValue !== null;
        if (hasSourceData) {
          await syncDomainFromAppState(appState, domain);
        } else {
          lastDomainChecksums.set(domain, checksumDomainValue(sourceValue));
        }
        continue;
      }
      hydrated[domain] = rowsToDomainValue(rows, hydrated[domain]);
      lastDomainChecksums.set(domain, checksumDomainValue(hydrated[domain]));
      lastDomainRecordStates.set(domain, buildRecordState(rows));
    }
    return hydrated;
  }

  function preservedRecordIdsForDomain(options = {}, domain) {
    const byDomain =
      options.preserveObjectEntriesByDomain ??
      options.preserveRecordIdsByDomain ??
      {};
    const values = byDomain && typeof byDomain === "object" ? byDomain[domain] : [];
    return new Set(
      (Array.isArray(values) ? values : [])
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean),
    );
  }

  async function syncDomainFromAppState(appState, domain, options = {}) {
    const nextChecksum = checksumDomainValue(appState?.[domain]);
    if (lastDomainChecksums.get(domain) === nextChecksum) return;
    const preservedRecordIds = preservedRecordIdsForDomain(options, domain);
    const rows = sortDomainRowsForLockOrder(
      normalizeDomainValue(domain, appState?.[domain], {
        objectAsEntries: objectEntryDomains.has(domain),
        objectArrayEntryFields:
          objectArrayEntryFieldsByDomain.get(domain) ?? [],
      }),
    );
    await withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        let existing = lastDomainRecordStates.get(domain);
        if (!existing || preservedRecordIds.size > 0) {
          const [existingRows] = await connection.query(
            `
              SELECT record_id, kind, app_state_position, row_hash
              FROM ${tableSql}
              WHERE domain = ?
              ${preservedRecordIds.size > 0 ? "FOR UPDATE" : ""}
            `,
            [domain],
          );
          existing = buildRecordState(existingRows);
        }
        const nextIds = new Set(rows.map((row) => row.recordId));
        const deletedIds = [];
        for (const recordId of existing.keys()) {
          if (preservedRecordIds.has(recordId)) continue;
          if (!nextIds.has(recordId)) {
            deletedIds.push(recordId);
          }
        }
        await deleteDomainRecords(connection, tableSql, domain, deletedIds);
        for (const row of rows) {
          if (preservedRecordIds.has(row.recordId)) continue;
          const previous = existing.get(row.recordId);
          if (
            previous &&
            previous.rowHash === row.rowHash &&
            previous.kind === row.kind
          ) {
            if (previous.appStatePosition !== row.appStatePosition) {
              await connection.query(
                `
                  UPDATE ${tableSql}
                  SET app_state_position = ?
                  WHERE domain = ? AND record_id = ? AND app_state_position <> ?
                `,
                [row.appStatePosition, domain, row.recordId, row.appStatePosition],
              );
            }
            continue;
          }
          await connection.query(
            `
              INSERT INTO ${tableSql} (
                domain, record_id, kind, app_state_position, row_hash, raw_json
              )
              VALUES (?, ?, ?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE
                kind = VALUES(kind),
                app_state_position = VALUES(app_state_position),
                row_hash = VALUES(row_hash),
                raw_json = VALUES(raw_json)
            `,
            [
              row.domain,
              row.recordId,
              row.kind,
              row.appStatePosition,
              row.rowHash,
              row.rawJson,
            ],
          );
        }
        await syncOrderStationIndex(
          connection,
          domain,
          INTEGRATION_ORDERS_FIELD,
          rows,
          { replaceAll: true },
        );
        await connection.commit();
        if (preservedRecordIds.size > 0) {
          lastDomainChecksums.delete(domain);
          lastDomainRecordStates.delete(domain);
        } else {
          lastDomainChecksums.set(domain, nextChecksum);
          lastDomainRecordStates.set(domain, buildRecordState(rows));
        }
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // noop
        }
        throw error;
      }
    });
  }

  async function upsertDomainRows(connection, rows) {
    for (const row of sortDomainRowsForLockOrder(rows)) {
      await connection.query(
        `
          INSERT INTO ${tableSql} (
            domain, record_id, kind, app_state_position, row_hash, raw_json
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            kind = VALUES(kind),
            app_state_position = VALUES(app_state_position),
            row_hash = VALUES(row_hash),
            raw_json = VALUES(raw_json)
        `,
        [
          row.domain,
          row.recordId,
          row.kind,
          row.appStatePosition,
          row.rowHash,
          row.rawJson,
        ],
      );
    }
  }

  async function upsertDomainRowsBatch(connection, rows, metricPrefix = "") {
    const batchRows = sortDomainRowsForLockOrder(rows);
    const chunkSize = 100;
    for (let index = 0; index < batchRows.length; index += chunkSize) {
      const chunk = batchRows.slice(index, index + chunkSize);
      if (chunk.length === 0) continue;
      const writeStartedAt = Date.now();
      await connection.query(
        `
          INSERT INTO ${tableSql} (
            domain, record_id, kind, app_state_position, row_hash, raw_json
          )
          VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
          ON DUPLICATE KEY UPDATE
            kind = VALUES(kind),
            app_state_position = VALUES(app_state_position),
            row_hash = VALUES(row_hash),
            raw_json = VALUES(raw_json)
        `,
        chunk.flatMap((row) => [
          row.domain,
          row.recordId,
          row.kind,
          row.appStatePosition,
          row.rowHash,
          row.rawJson,
        ]),
      );
      if (metricPrefix) recordDomainSplitMetric(`${metricPrefix}.upsertBatch`, writeStartedAt);
    }
  }

  function groupOrderStationIndexRowsByRecordId(rows) {
    const grouped = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const orderRecordId = String(row?.orderRecordId ?? row?.order_record_id ?? "").trim();
      if (!orderRecordId) continue;
      if (!grouped.has(orderRecordId)) grouped.set(orderRecordId, []);
      grouped.get(orderRecordId).push({
        station: String(row?.station ?? "").trim(),
        matchKind: String(row?.matchKind ?? row?.match_kind ?? "").trim(),
        appStatePosition: Number(row?.appStatePosition ?? row?.app_state_position ?? 0),
      });
    }
    for (const entries of grouped.values()) {
      entries.sort((left, right) => {
        const leftKey = JSON.stringify([left.station, left.matchKind, left.appStatePosition]);
        const rightKey = JSON.stringify([right.station, right.matchKind, right.appStatePosition]);
        return leftKey.localeCompare(rightKey);
      });
    }
    return grouped;
  }

  function orderStationIndexRowsEqual(leftRows, rightRows) {
    const left = Array.isArray(leftRows) ? leftRows : [];
    const right = Array.isArray(rightRows) ? rightRows : [];
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (
        left[index].station !== right[index].station ||
        left[index].matchKind !== right[index].matchKind ||
        left[index].appStatePosition !== right[index].appStatePosition
      ) {
        return false;
      }
    }
    return true;
  }

  function sortOrderStationIndexRows(rows) {
    return [...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
      const leftKey = [
        left.domain,
        left.fieldName,
        left.station,
        left.matchKind,
        left.orderRecordId,
      ]
        .map((entry) => String(entry ?? ""))
        .join("\u0001");
      const rightKey = [
        right.domain,
        right.fieldName,
        right.station,
        right.matchKind,
        right.orderRecordId,
      ]
        .map((entry) => String(entry ?? ""))
        .join("\u0001");
      return leftKey.localeCompare(rightKey);
    });
  }

  function orderStationIndexPresenceKey(row) {
    return [
      row?.station,
      row?.matchKind ?? row?.match_kind,
    ]
      .map((entry) => String(entry ?? "").trim())
      .join("\u0001");
  }

  function collectStaleOrderStationIndexRows(
    domain,
    fieldName,
    changedRecordIds,
    previousIndexByRecordId,
    nextIndexByRecordId,
  ) {
    const staleRows = [];
    for (const recordId of Array.isArray(changedRecordIds) ? changedRecordIds : []) {
      const previousRows = previousIndexByRecordId.get(recordId);
      if (!Array.isArray(previousRows) || previousRows.length === 0) continue;
      const nextKeys = new Set(
        (nextIndexByRecordId.get(recordId) ?? []).map(orderStationIndexPresenceKey),
      );
      for (const previousRow of previousRows) {
        if (nextKeys.has(orderStationIndexPresenceKey(previousRow))) continue;
        staleRows.push({
          domain,
          fieldName,
          station: previousRow.station,
          matchKind: previousRow.matchKind,
          orderRecordId: recordId,
          appStatePosition: previousRow.appStatePosition,
        });
      }
    }
    return sortOrderStationIndexRows(staleRows);
  }

  async function deleteOrderStationIndexRowsByPrimaryKey(
    connection,
    tableSqlValue,
    rows,
    metricPrefix,
  ) {
    const sortedRows = sortOrderStationIndexRows(rows);
    const chunkSize = 100;
    for (let index = 0; index < sortedRows.length; index += chunkSize) {
      const chunk = sortedRows.slice(index, index + chunkSize);
      if (chunk.length === 0) continue;
      const deleteStartedAt = Date.now();
      await connection.query(
        `
          DELETE FROM ${tableSqlValue}
          WHERE domain = ?
            AND field_name = ?
            AND (station, match_kind, order_record_id) IN (
              ${chunk.map(() => "(?, ?, ?)").join(", ")}
            )
        `,
        [
          chunk[0].domain,
          chunk[0].fieldName,
          ...chunk.flatMap((row) => [row.station, row.matchKind, row.orderRecordId]),
        ],
      );
      recordDomainSplitMetric(`${metricPrefix}.deleteRows`, deleteStartedAt);
    }
  }

  async function insertOrderStationIndexRows(connection, tableSqlValue, rows, metricPrefix) {
    const sortedRows = sortOrderStationIndexRows(rows);
    const chunkSize = 100;
    for (let index = 0; index < sortedRows.length; index += chunkSize) {
      const chunk = sortedRows.slice(index, index + chunkSize);
      if (chunk.length === 0) continue;
      const insertStartedAt = Date.now();
      await connection.query(
        `
          INSERT INTO ${tableSqlValue} (
            domain, field_name, station, match_kind, order_record_id, app_state_position
          )
          VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
          ON DUPLICATE KEY UPDATE
            app_state_position = VALUES(app_state_position)
        `,
        chunk.flatMap((row) => [
          row.domain,
          row.fieldName,
          row.station,
          row.matchKind,
          row.orderRecordId,
          row.appStatePosition,
        ]),
      );
      recordDomainSplitMetric(`${metricPrefix}.insertRows`, insertStartedAt);
    }
  }

  async function listOrderStationIndexState(connection, domain, fieldName, recordIds) {
    const ids = [...new Set((Array.isArray(recordIds) ? recordIds : []).filter(Boolean))];
    const rows = [];
    const chunkSize = 100;
    for (let index = 0; index < ids.length; index += chunkSize) {
      const chunk = ids.slice(index, index + chunkSize);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const [chunkRows] = await connection.query(
        `
          SELECT station, match_kind, order_record_id, app_state_position
          FROM ${orderStationIndexTableSql}
          WHERE domain = ?
            AND field_name = ?
            AND order_record_id IN (${placeholders})
        `,
        [domain, fieldName, ...chunk],
      );
      rows.push(...(Array.isArray(chunkRows) ? chunkRows : []));
    }
    return groupOrderStationIndexRowsByRecordId(rows);
  }

  async function syncOrderStationIndex(
    connection,
    domain,
    fieldName,
    rows,
    options = {},
  ) {
    if (domain !== INTEGRATION_DOMAIN || fieldName !== INTEGRATION_ORDERS_FIELD) {
      return;
    }
    const totalStartedAt = Date.now();
    const metricPrefix = `${domain}.${fieldName}.index`;
    const sourceRows = Array.isArray(rows) ? rows : [];
    const collectStartedAt = Date.now();
    const indexRows = collectOrderStationIndexRows(sourceRows, domain, fieldName);
    recordDomainSplitMetric(`${metricPrefix}.collect`, collectStartedAt);
    let changedRecordIds = null;
    let indexRowsToInsert = indexRows;
    let nextIndexByRecordId = new Map();
    let previousIndexByRecordId = new Map();
    try {
      if (options.replaceAll) {
        const deleteStartedAt = Date.now();
        await connection.query(
          `
            DELETE FROM ${orderStationIndexTableSql}
            WHERE domain = ? AND field_name = ?
          `,
          [domain, fieldName],
        );
        recordDomainSplitMetric(`${metricPrefix}.deleteRows`, deleteStartedAt);
      } else {
        const recordIds = [
          ...new Set(
            sourceRows
              .map((row) =>
                String(row?.recordId ?? row?.record_id ?? "").trim(),
              )
              .filter((recordId) =>
                recordId.startsWith(
                  `${fieldName}${OBJECT_ARRAY_RECORD_SEPARATOR}`,
                ),
              ),
          ),
        ].sort((left, right) => left.localeCompare(right));
        if (recordIds.length === 0) return;

        nextIndexByRecordId = groupOrderStationIndexRowsByRecordId(indexRows);
        const stateReadStartedAt = Date.now();
        previousIndexByRecordId = await listOrderStationIndexState(
          connection,
          domain,
          fieldName,
          recordIds,
        );
        recordDomainSplitMetric(
          `${metricPrefix}.stateRead`,
          stateReadStartedAt,
        );

        const compareStartedAt = Date.now();
        changedRecordIds = recordIds.filter(
          (recordId) =>
            !orderStationIndexRowsEqual(
              previousIndexByRecordId.get(recordId),
              nextIndexByRecordId.get(recordId),
            ),
        );
        recordDomainSplitMetric(`${metricPrefix}.compare`, compareStartedAt);
        if (changedRecordIds.length === 0) return;

        const changedRecordIdSet = new Set(changedRecordIds);
        indexRowsToInsert = indexRows.filter((row) =>
          changedRecordIdSet.has(row.orderRecordId),
        );
      }

      await insertOrderStationIndexRows(
        connection,
        orderStationIndexTableSql,
        indexRowsToInsert,
        metricPrefix,
      );
      if (changedRecordIds) {
        await deleteOrderStationIndexRowsByPrimaryKey(
          connection,
          orderStationIndexTableSql,
          collectStaleOrderStationIndexRows(
            domain,
            fieldName,
            changedRecordIds,
            previousIndexByRecordId,
            nextIndexByRecordId,
          ),
          metricPrefix,
        );
      }
    } finally {
      recordDomainSplitMetric(`${metricPrefix}.total`, totalStartedAt);
    }
  }

  async function backfillIntegrationOrderStationIndexIfNeeded() {
    const markerRows = await query(
      `
        SELECT order_record_id
        FROM ${orderStationIndexTableSql}
        WHERE domain = ? AND field_name = ?
        LIMIT 1
      `,
      [INTEGRATION_DOMAIN, INTEGRATION_ORDERS_FIELD],
    );
    if (Array.isArray(markerRows) && markerRows.length > 0) return;
    const rows = await query(
      `
        SELECT domain, record_id, kind, app_state_position, row_hash, raw_json
        FROM ${tableSql}
        WHERE domain = ?
          AND record_id LIKE ?
        ORDER BY app_state_position ASC, record_id ASC
      `,
      [
        INTEGRATION_DOMAIN,
        `${INTEGRATION_ORDERS_FIELD}${OBJECT_ARRAY_RECORD_SEPARATOR}%`,
      ],
    );
    if (!Array.isArray(rows) || rows.length === 0) return;
    await withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await syncOrderStationIndex(
          connection,
          INTEGRATION_DOMAIN,
          INTEGRATION_ORDERS_FIELD,
          rows,
          { replaceAll: true },
        );
        await connection.commit();
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // noop
        }
        throw error;
      }
    });
  }

  async function lockDomainRowsForWrite(
    connection,
    domain,
    rows,
    { lockRowsNowait = false } = {},
  ) {
    const recordIds = sortDomainRowsForLockOrder(rows)
      .map((row) => row.recordId)
      .filter(Boolean);
    const lockedRows = new Map();
    const chunkSize = 100;
    for (let index = 0; index < recordIds.length; index += chunkSize) {
      const chunk = recordIds.slice(index, index + chunkSize);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const [rows] = await connection.query(
        `
          SELECT record_id, kind, app_state_position, row_hash, raw_json
          FROM ${tableSql}
          WHERE domain = ? AND record_id IN (${placeholders})
          ORDER BY record_id ASC
          FOR UPDATE${lockRowsNowait === true ? " NOWAIT" : ""}
        `,
        [domain, ...chunk],
      );
      for (const row of Array.isArray(rows) ? rows : []) {
        const recordId = String(row?.record_id ?? "").trim();
        if (recordId) lockedRows.set(recordId, row);
      }
    }
    return lockedRows;
  }

  async function upsertChangedDomainRows(connection, rows, options = {}) {
    const rowsByDomain = new Map();
    const changedRows = [];
    const metricPrefix =
      typeof options.metricPrefix === "string" && options.metricPrefix.trim()
        ? options.metricPrefix.trim()
        : "";
    for (const row of sortDomainRowsForLockOrder(rows)) {
      if (!row?.domain || !row?.recordId) continue;
      if (!rowsByDomain.has(row.domain)) rowsByDomain.set(row.domain, []);
      rowsByDomain.get(row.domain).push(row);
    }

    for (const [domain, domainRows] of rowsByDomain.entries()) {
      const prefix = metricPrefix || `${domain}.records`;
      const stateReadStartedAt = Date.now();
      // Il lock include tutte le righe che potranno subire merge o DML. In
      // questo modo MySQL le acquisisce per domain/recordId, anche quando
      // sequence, lastWriteAt e ordini coesistono nella stessa selezione.
      const lockedDomainRows = await lockDomainRowsForWrite(
        connection,
        domain,
        domainRows,
        { lockRowsNowait: options.lockRowsNowait === true },
      );
      const existing = buildRecordState([...lockedDomainRows.values()]);
      recordDomainSplitMetric(`${prefix}.stateRead`, stateReadStartedAt);
      let changedRowsWriteMs = 0;
      let changedRowsWriteCount = 0;
      const rowsToUpsert = [];
      for (const row of domainRows) {
        const integrationFreshnessGuard =
          options.preserveNewerIntegrationRecords === true &&
          row.domain === INTEGRATION_DOMAIN &&
          (row.recordId === INTEGRATION_LAST_WRITE_AT_FIELD ||
            row.recordId.startsWith(
              `${INTEGRATION_ORDERS_FIELD}${OBJECT_ARRAY_RECORD_SEPARATOR}`,
            ));
        const paymentMirrorFreshnessGuard =
          options.preserveNewerPaymentMirrorRecords === true &&
          MUTABLE_PAYMENT_MIRROR_DOMAINS.has(row.domain);
        const stationStateFreshnessGuard =
          options.preserveNewerStationStates === true &&
          row.domain === INTEGRATION_DOMAIN &&
          row.recordId.startsWith(
            `${INTEGRATION_STATION_STATES_FIELD}${OBJECT_ARRAY_RECORD_SEPARATOR}`,
          );
        if (
          integrationFreshnessGuard ||
          paymentMirrorFreshnessGuard ||
          stationStateFreshnessGuard
        ) {
          const lockedRow = lockedDomainRows.get(row.recordId) ?? null;
          const preservationReason = integrationFreshnessGuard
            ? newerIntegrationRecordReason(row, lockedRow)
            : paymentMirrorFreshnessGuard
              ? newerPaymentMirrorRecordReason(row, lockedRow)
              : newerStationStateRecordReason(row, lockedRow);
          if (preservationReason) {
            recordDomainSplitMetricValue(
              `${prefix}.freshnessPreserved.${preservationReason}`,
              0,
            );
            continue;
          }
        }
        // sequence e' condiviso tra processi e va fuso a MAX usando il valore
        // gia' bloccato nel batch canonico del dominio.
        if (row.domain === "integration" && row.recordId === "sequence") {
          const lockedSequenceRow = lockedDomainRows.get("sequence") ?? null;
          const existingSequence = safeJsonParse(
            lockedSequenceRow?.raw_json,
            null,
          );
          const localSequence = safeJsonParse(row.rawJson, null);
          if (
            existingSequence &&
            typeof existingSequence === "object" &&
            localSequence &&
            typeof localSequence === "object"
          ) {
            const merged = { ...existingSequence, ...localSequence };
            for (const [key, value] of Object.entries(existingSequence)) {
              const existingValue = Math.trunc(Number(value));
              const localValue = Math.trunc(Number(localSequence[key]));
              if (Number.isFinite(existingValue) && Number.isFinite(localValue)) {
                merged[key] = Math.max(existingValue, localValue);
              } else if (Number.isFinite(existingValue)) {
                merged[key] = existingValue;
              }
            }
            row.rawJson = safeJsonStringify(merged, null);
            row.rowHash = sha256(row.rawJson);
          }
        }
        const previous = existing.get(row.recordId);
        if (
          previous &&
          previous.rowHash === row.rowHash &&
          previous.kind === row.kind
        ) {
          if (previous.appStatePosition !== row.appStatePosition) {
            rowsToUpsert.push(row);
            changedRows.push(row);
          }
          continue;
        }
        rowsToUpsert.push(row);
        changedRows.push(row);
      }
      if (rowsToUpsert.length > 0) {
        const writeStartedAt = Date.now();
        await upsertDomainRowsBatch(connection, rowsToUpsert, prefix);
        changedRowsWriteMs += Date.now() - writeStartedAt;
        changedRowsWriteCount += rowsToUpsert.length;
      }
      if (changedRowsWriteCount > 0) {
        runtimeMetrics?.recordOperation?.(
          "appStateDomainSplit",
          `${prefix}.upsertChangedRows`,
          changedRowsWriteMs,
        );
      }
    }
    return changedRows;
  }

  async function syncObjectEntryFromAppState(appState, domain, fieldName) {
    if (!enabled || !appState || typeof appState !== "object") return;
    await ensure();
    const normalizedDomain = normalizeDomain(domain);
    const normalizedFieldName = String(fieldName ?? "").trim();
    if (!normalizedFieldName) return;
    const domainValue =
      appState[normalizedDomain] && typeof appState[normalizedDomain] === "object"
        ? appState[normalizedDomain]
        : {};
    const row = normalizeObjectEntryRow(
      normalizedDomain,
      normalizedFieldName,
      domainValue?.[normalizedFieldName],
      objectFieldPosition(domainValue, normalizedFieldName),
    );
    await withConnection(async (connection) => {
      await upsertDomainRows(connection, [row]);
    });
    lastDomainChecksums.delete(normalizedDomain);
    lastDomainRecordStates.delete(normalizedDomain);
  }

  async function syncObjectArrayFieldFromAppState(
    appState,
    domain,
    fieldName,
  ) {
    if (!enabled || !appState || typeof appState !== "object") return;
    await ensure();
    const normalizedDomain = normalizeDomain(domain);
    const normalizedFieldName = String(fieldName ?? "").trim();
    if (!normalizedFieldName) return;
    const domainValue =
      appState[normalizedDomain] && typeof appState[normalizedDomain] === "object"
        ? appState[normalizedDomain]
        : {};
    const rows = normalizeObjectArrayFieldRows(
      normalizedDomain,
      normalizedFieldName,
      domainValue?.[normalizedFieldName],
      objectFieldPosition(domainValue, normalizedFieldName),
    );
    await withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const nextIds = new Set(rows.map((row) => row.recordId));
        const [existingRows] = await connection.query(
          `
            SELECT record_id
            FROM ${tableSql}
            WHERE domain = ?
              AND (record_id = ? OR record_id LIKE ?)
          `,
          [
            normalizedDomain,
            normalizedFieldName,
            `${normalizedFieldName}${OBJECT_ARRAY_RECORD_SEPARATOR}%`,
          ],
        );
        const deletedIds = (Array.isArray(existingRows) ? existingRows : [])
          .map((row) => String(row?.record_id ?? "").trim())
          .filter((recordId) => recordId && !nextIds.has(recordId));
        await deleteDomainRecords(
          connection,
          tableSql,
          normalizedDomain,
          deletedIds,
        );
        await upsertDomainRows(connection, rows);
        await syncOrderStationIndex(
          connection,
          normalizedDomain,
          normalizedFieldName,
          rows,
          { replaceAll: true },
        );
        await connection.commit();
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // noop
        }
        throw error;
      }
    });
    lastDomainChecksums.delete(normalizedDomain);
    lastDomainRecordStates.delete(normalizedDomain);
  }

  async function syncObjectArrayEntriesFromAppState(
    appState,
    domain,
    fieldName,
    entryIds,
    options = {},
  ) {
    const totalStartedAt = Date.now();
    if (!enabled || !appState || typeof appState !== "object") return;
    const selectedEntryIds = Array.isArray(entryIds)
      ? entryIds.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : [];
    if (selectedEntryIds.length === 0) return;
    const normalizedDomain = normalizeDomain(domain);
    const normalizedFieldName = String(fieldName ?? "").trim();
    if (!normalizedFieldName) return;
    const metricPrefix = `${normalizedDomain}.${normalizedFieldName}.entries`;
    const ensureStartedAt = Date.now();
    await ensure();
    recordDomainSplitMetric(`${metricPrefix}.ensure`, ensureStartedAt);
    const domainValue =
      appState[normalizedDomain] && typeof appState[normalizedDomain] === "object"
        ? appState[normalizedDomain]
        : {};
    const rows = normalizeObjectArrayEntryRows(
      normalizedDomain,
      normalizedFieldName,
      domainValue?.[normalizedFieldName],
      selectedEntryIds,
      objectFieldPosition(domainValue, normalizedFieldName),
    );
    const canUseOrderEntryBatch = orderEntryBatchUpsert && normalizedDomain === INTEGRATION_DOMAIN && normalizedFieldName === INTEGRATION_ORDERS_FIELD;
    if (canUseOrderEntryBatch) {
      const entryRows = rows.filter((row) => row.kind === OBJECT_ARRAY_ENTRY_KIND);
      if (entryRows.length === 0) return;
      await withConnection(async (connection) => {
        let transactionStarted = false;
        let transactionStep = "beginTransaction";
        try {
          const beginStartedAt = Date.now();
          await connection.beginTransaction();
          transactionStarted = true;
          recordDomainSplitMetric(`${metricPrefix}.beginTransaction`, beginStartedAt);
          transactionStep = "upsertBatch";
          await upsertDomainRowsBatch(connection, entryRows, metricPrefix);
          transactionStep = "orderStationIndex";
          await syncOrderStationIndex(connection, normalizedDomain, normalizedFieldName, entryRows, { replaceAll: false });
          transactionStep = "commit";
          const commitStartedAt = Date.now();
          await connection.commit();
          transactionStarted = false;
          recordDomainSplitMetric(`${metricPrefix}.commit`, commitStartedAt);
          recordDomainSplitMetricValue(`${metricPrefix}.outcome.committed`, 0);
        } catch (error) {
          const rollbackCause = normalizeDomainSplitRollbackCause(error);
          recordDomainSplitMetricValue(`${metricPrefix}.error.${rollbackCause}`, 0);
          recordDomainSplitMetricValue(`${metricPrefix}.errorStage.${transactionStep}.${rollbackCause}`, 0);
          recordDomainSplitMetricValue(`${metricPrefix}.rollback.cause.${rollbackCause}`, 0);
          if (transactionStarted) {
            try {
              const rollbackStartedAt = Date.now();
              await connection.rollback();
              recordDomainSplitMetric(`${metricPrefix}.rollback`, rollbackStartedAt);
              recordDomainSplitMetricValue(`${metricPrefix}.outcome.rolledBack`, 0);
            } catch {
              recordDomainSplitMetricValue(`${metricPrefix}.rollback.failed`, 0);
            }
          }
          throw error;
        } finally {
          recordDomainSplitMetric(`${metricPrefix}.total`, totalStartedAt);
        }
      }, { metricPrefix });
      lastDomainChecksums.delete(normalizedDomain);
      lastDomainRecordStates.delete(normalizedDomain);
      return;
    }
    await withConnection(async (connection) => {
      let transactionStarted = false;
      let transactionStep = "beginTransaction";
      try {
        const beginStartedAt = Date.now();
        await connection.beginTransaction();
        transactionStarted = true;
        recordDomainSplitMetric(`${metricPrefix}.beginTransaction`, beginStartedAt);
        transactionStep = "markerLockElisionProbe";
        const rowsForWrite = await applyStationStatesPartialMarkerLockElision(
          connection,
          rows,
          {
            eligible:
              normalizedDomain === INTEGRATION_DOMAIN &&
              normalizedFieldName === INTEGRATION_STATION_STATES_FIELD,
          },
        );
        transactionStep = "upsertChangedRows";
        const changedRows = await upsertChangedDomainRows(connection, rowsForWrite, {
          metricPrefix,
          preserveNewerStationStates:
            options.preserveNewerStationStates === true,
        });
        if (changedRows.length > 0) {
          transactionStep = "orderStationIndex";
          await syncOrderStationIndex(
            connection,
            normalizedDomain,
            normalizedFieldName,
            changedRows,
            { replaceAll: false },
          );
        }
        transactionStep = "commit";
        const commitStartedAt = Date.now();
        await connection.commit();
        transactionStarted = false;
        recordDomainSplitMetric(`${metricPrefix}.commit`, commitStartedAt);
        recordDomainSplitMetricValue(`${metricPrefix}.outcome.committed`, 0);
      } catch (error) {
        const rollbackCause = normalizeDomainSplitRollbackCause(error);
        recordDomainSplitMetricValue(`${metricPrefix}.error.${rollbackCause}`, 0);
        recordDomainSplitMetricValue(
          `${metricPrefix}.errorStage.${transactionStep}.${rollbackCause}`,
          0,
        );
        recordDomainSplitMetricValue(
          `${metricPrefix}.rollback.cause.${rollbackCause}`,
          0,
        );
        if (transactionStarted) {
          try {
            const rollbackStartedAt = Date.now();
            await connection.rollback();
            recordDomainSplitMetric(`${metricPrefix}.rollback`, rollbackStartedAt);
            recordDomainSplitMetricValue(`${metricPrefix}.outcome.rolledBack`, 0);
          } catch {
            recordDomainSplitMetricValue(`${metricPrefix}.rollback.failed`, 0);
          }
        }
        throw error;
      } finally {
        recordDomainSplitMetric(
          `${normalizedDomain}.${normalizedFieldName}.entries.total`,
          totalStartedAt,
        );
      }
    }, { metricPrefix });
    lastDomainChecksums.delete(normalizedDomain);
    lastDomainRecordStates.delete(normalizedDomain);
  }

  async function syncIntegrationLastWriteAt(value, options = {}) {
    if (!enabled) return { changedRows: 0 };
    const metricPrefix = "integration.lastWriteAt.monotonic";
    const totalStartedAt = Date.now();
    const timestamp = Date.parse(String(value ?? ""));
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      const error = new Error("integration.lastWriteAt non valido.");
      error.code = "INVALID_INTEGRATION_LAST_WRITE_AT";
      throw error;
    }
    await ensure();
    const row = normalizeObjectEntryRow(
      INTEGRATION_DOMAIN,
      INTEGRATION_LAST_WRITE_AT_FIELD,
      new Date(timestamp).toISOString(),
      Math.max(0, Math.trunc(Number(options.appStatePosition) || 0)),
    );
    let changedRows = [];
    try {
      await withConnection(async (connection) => {
        const beginStartedAt = Date.now();
        await connection.beginTransaction();
        recordDomainSplitMetric(`${metricPrefix}.beginTransaction`, beginStartedAt);
        try {
          changedRows = await upsertChangedDomainRows(connection, [row], {
            metricPrefix,
            lockRowsNowait: options.lockRowsNowait === true,
            preserveNewerIntegrationRecords: true,
          });
          const commitStartedAt = Date.now();
          await connection.commit();
          recordDomainSplitMetric(`${metricPrefix}.commit`, commitStartedAt);
          recordDomainSplitMetricValue(`${metricPrefix}.outcome.committed`, 0);
        } catch (error) {
          try {
            const rollbackStartedAt = Date.now();
            await connection.rollback();
            recordDomainSplitMetric(`${metricPrefix}.rollback`, rollbackStartedAt);
            recordDomainSplitMetricValue(`${metricPrefix}.outcome.rolledBack`, 0);
          } catch {
            recordDomainSplitMetricValue(`${metricPrefix}.rollback.failed`, 0);
          }
          throw error;
        }
      }, { metricPrefix });
    } finally {
      recordDomainSplitMetric(`${metricPrefix}.total`, totalStartedAt);
    }
    lastDomainChecksums.delete(INTEGRATION_DOMAIN);
    lastDomainRecordStates.delete(INTEGRATION_DOMAIN);
    return { changedRows: changedRows.length, timestamp: row.rawJson };
  }

  async function syncObjectArrayEntriesAndObjectEntriesFromAppState(
    appState,
    domain,
    options = {},
  ) {
    const totalStartedAt = Date.now();
    if (!enabled || !appState || typeof appState !== "object") return;
    const normalizedDomain = normalizeDomain(domain);
    const domainValue =
      appState[normalizedDomain] && typeof appState[normalizedDomain] === "object"
        ? appState[normalizedDomain]
        : {};
    const arrayEntries = Array.isArray(options.objectArrayEntries)
      ? options.objectArrayEntries
      : [];
    const replaceObjectArrayFields = [
      ...new Set(
        (Array.isArray(options.replaceObjectArrayFields)
          ? options.replaceObjectArrayFields
          : [])
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const replaceObjectArrayFieldSet = new Set(replaceObjectArrayFields);
    const hasPartialStationStates =
      normalizedDomain === INTEGRATION_DOMAIN &&
      !replaceObjectArrayFieldSet.has(INTEGRATION_STATION_STATES_FIELD) &&
      arrayEntries.some(
        (entry) =>
          String(entry?.fieldName ?? "").trim() ===
            INTEGRATION_STATION_STATES_FIELD &&
          Array.isArray(entry?.entryIds) &&
          entry.entryIds.some((id) => String(id ?? "").trim()),
      );
    const objectFields = [
      ...new Set(
        (Array.isArray(options.objectFields) ? options.objectFields : [])
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const metricPrefix = `${normalizedDomain}.bulkEntries`;
    const ensureStartedAt = Date.now();
    await ensure();
    recordDomainSplitMetric(`${metricPrefix}.ensure`, ensureStartedAt);
    const rows = [];
    const replacementRowsByField = new Map();
    for (const fieldName of replaceObjectArrayFields) {
      const fieldRows = normalizeObjectArrayFieldRows(
        normalizedDomain,
        fieldName,
        domainValue?.[fieldName],
        objectFieldPosition(domainValue, fieldName),
      );
      replacementRowsByField.set(fieldName, fieldRows);
      rows.push(...fieldRows);
    }
    for (const entry of arrayEntries) {
      const fieldName = String(entry?.fieldName ?? "").trim();
      if (replaceObjectArrayFieldSet.has(fieldName)) continue;
      const selectedEntryIds = Array.isArray(entry?.entryIds)
        ? entry.entryIds.map((id) => String(id ?? "").trim()).filter(Boolean)
        : [];
      if (!fieldName || selectedEntryIds.length === 0) continue;
      rows.push(
        ...normalizeObjectArrayEntryRows(
          normalizedDomain,
          fieldName,
          domainValue?.[fieldName],
          selectedEntryIds,
          objectFieldPosition(domainValue, fieldName),
        ),
      );
    }
    for (const fieldName of objectFields) {
      rows.push(
        normalizeObjectEntryRow(
          normalizedDomain,
          fieldName,
          domainValue?.[fieldName],
          objectFieldPosition(domainValue, fieldName),
        ),
      );
    }
    if (rows.length === 0) return;
    await withConnection(async (connection) => {
      let transactionStarted = false;
      let transactionStep = "beginTransaction";
      try {
        const beginStartedAt = Date.now();
        await connection.beginTransaction();
        transactionStarted = true;
        recordDomainSplitMetric(`${metricPrefix}.beginTransaction`, beginStartedAt);
        for (const [fieldName, fieldRows] of replacementRowsByField) {
          transactionStep = `deleteStale.${fieldName}`;
          const nextRecordIds = new Set(fieldRows.map((row) => row.recordId));
          const [existingRows] = await connection.query(
            `
              SELECT record_id
              FROM ${tableSql}
              WHERE domain = ?
                AND (record_id = ? OR record_id LIKE ?)
            `,
            [
              normalizedDomain,
              fieldName,
              `${fieldName}${OBJECT_ARRAY_RECORD_SEPARATOR}%`,
            ],
          );
          const deletedIds = (Array.isArray(existingRows) ? existingRows : [])
            .map((row) => String(row?.record_id ?? "").trim())
            .filter((recordId) => recordId && !nextRecordIds.has(recordId));
          await deleteDomainRecords(
            connection,
            tableSql,
            normalizedDomain,
            deletedIds,
          );
        }
        transactionStep = "markerLockElisionProbe";
        const rowsForWrite = await applyStationStatesPartialMarkerLockElision(
          connection,
          rows,
          { eligible: hasPartialStationStates },
        );
        transactionStep = "upsertChangedRows";
        const changedRows = await upsertChangedDomainRows(connection, rowsForWrite, {
          metricPrefix,
          lockRowsNowait: options.lockRowsNowait === true,
          preserveNewerIntegrationRecords:
            options.preserveNewerIntegrationRecords === true,
        });
        if (replaceObjectArrayFieldSet.has(INTEGRATION_ORDERS_FIELD)) {
          transactionStep = "orderStationIndex";
          await syncOrderStationIndex(
            connection,
            normalizedDomain,
            INTEGRATION_ORDERS_FIELD,
            rows,
            { replaceAll: true },
          );
        } else if (changedRows.length > 0) {
          transactionStep = "orderStationIndex";
          await syncOrderStationIndex(
            connection,
            normalizedDomain,
            INTEGRATION_ORDERS_FIELD,
            changedRows,
            { replaceAll: false },
          );
        }
        transactionStep = "commit";
        const commitStartedAt = Date.now();
        await connection.commit();
        transactionStarted = false;
        recordDomainSplitMetric(`${metricPrefix}.commit`, commitStartedAt);
        recordDomainSplitMetricValue(`${metricPrefix}.outcome.committed`, 0);
      } catch (error) {
        const rollbackCause = normalizeDomainSplitRollbackCause(error);
        recordDomainSplitMetricValue(`${metricPrefix}.error.${rollbackCause}`, 0);
        recordDomainSplitMetricValue(
          `${metricPrefix}.errorStage.${transactionStep}.${rollbackCause}`,
          0,
        );
        recordDomainSplitMetricValue(
          `${metricPrefix}.rollback.cause.${rollbackCause}`,
          0,
        );
        if (transactionStarted) {
          try {
            const rollbackStartedAt = Date.now();
            await connection.rollback();
            recordDomainSplitMetric(`${metricPrefix}.rollback`, rollbackStartedAt);
            recordDomainSplitMetricValue(`${metricPrefix}.outcome.rolledBack`, 0);
          } catch {
            recordDomainSplitMetricValue(`${metricPrefix}.rollback.failed`, 0);
          }
        }
        throw error;
      } finally {
        recordDomainSplitMetric(`${metricPrefix}.total`, totalStartedAt);
      }
    }, { metricPrefix });
    lastDomainChecksums.delete(normalizedDomain);
    lastDomainRecordStates.delete(normalizedDomain);
  }

  async function syncSelectedEntriesFromAppState(
    appState,
    selection = {},
    execution = {},
  ) {
    const totalStartedAt = Date.now();
    if (!enabled || !appState || typeof appState !== "object") {
      return { selectedRows: 0, changedRows: 0, domains: [] };
    }
    await ensure();

    const rows = [];
    const touchedDomains = new Set();
    const domainArrayEntries = Array.isArray(selection.domainArrayEntries)
      ? selection.domainArrayEntries
      : [];
    const objectArrayEntries = Array.isArray(selection.objectArrayEntries)
      ? selection.objectArrayEntries
      : [];
    const objectFields = Array.isArray(selection.objectFields)
      ? selection.objectFields
      : [];

    for (const entry of domainArrayEntries) {
      const domain = normalizeDomain(entry?.domain);
      const entryIds = Array.isArray(entry?.entryIds)
        ? entry.entryIds.map((id) => String(id ?? "").trim()).filter(Boolean)
        : [];
      if (entryIds.length === 0) continue;
      rows.push(
        ...normalizeDomainArrayEntryRows(domain, appState?.[domain], entryIds),
      );
      touchedDomains.add(domain);
    }

    for (const entry of objectArrayEntries) {
      const domain = normalizeDomain(entry?.domain);
      const fieldName = String(entry?.fieldName ?? "").trim();
      const entryIds = Array.isArray(entry?.entryIds)
        ? entry.entryIds.map((id) => String(id ?? "").trim()).filter(Boolean)
        : [];
      if (!fieldName || entryIds.length === 0) continue;
      const domainValue =
        appState[domain] && typeof appState[domain] === "object"
          ? appState[domain]
          : {};
      rows.push(
        ...normalizeObjectArrayEntryRows(
          domain,
          fieldName,
          domainValue?.[fieldName],
          entryIds,
          objectFieldPosition(domainValue, fieldName),
        ),
      );
      touchedDomains.add(domain);
    }

    for (const entry of objectFields) {
      const domain = normalizeDomain(entry?.domain);
      const fieldNames = Array.isArray(entry?.fieldNames)
        ? entry.fieldNames.map((name) => String(name ?? "").trim()).filter(Boolean)
        : [];
      if (fieldNames.length === 0) continue;
      const domainValue =
        appState[domain] && typeof appState[domain] === "object"
          ? appState[domain]
          : {};
      for (const fieldName of fieldNames) {
        rows.push(
          normalizeObjectEntryRow(
            domain,
            fieldName,
            domainValue?.[fieldName],
            objectFieldPosition(domainValue, fieldName),
          ),
        );
      }
      touchedDomains.add(domain);
    }

    const selectedRows = dedupeDomainRowsForWrite(rows);
    if (selectedRows.length === 0) {
      return { selectedRows: 0, changedRows: 0, domains: [] };
    }
    const metricPrefix =
      String(execution.metricPrefix ?? "").trim() || "multiDomainSelection";

    const applySelection = async (connection) => {
      const changedRows = await upsertChangedDomainRows(
        connection,
        selectedRows,
        {
          metricPrefix,
          preserveNewerIntegrationRecords:
            execution.preserveNewerIntegrationRecords === true,
          preserveNewerPaymentMirrorRecords:
            execution.preserveNewerPaymentMirrorRecords === true,
        },
      );
      const changedOrderRows = changedRows.filter(
        (row) =>
          row.domain === INTEGRATION_DOMAIN &&
          row.recordId.startsWith(
            `${INTEGRATION_ORDERS_FIELD}${OBJECT_ARRAY_RECORD_SEPARATOR}`,
          ),
      );
      if (changedOrderRows.length > 0) {
        await syncOrderStationIndex(
          connection,
          INTEGRATION_DOMAIN,
          INTEGRATION_ORDERS_FIELD,
          changedOrderRows,
          { replaceAll: false },
        );
      }
      return changedRows;
    };

    let changedRows;
    if (execution.connection) {
      changedRows = await applySelection(execution.connection);
    } else {
      changedRows = await withConnection(async (connection) => {
        await connection.beginTransaction();
        try {
          const changed = await applySelection(connection);
          await connection.commit();
          return changed;
        } catch (error) {
          try {
            await connection.rollback();
          } catch {
            // noop
          }
          throw error;
        }
      }, { metricPrefix });
    }

    for (const domain of touchedDomains) {
      lastDomainChecksums.delete(domain);
      lastDomainRecordStates.delete(domain);
    }
    recordDomainSplitMetric(`${metricPrefix}.total`, totalStartedAt);
    return {
      selectedRows: selectedRows.length,
      changedRows: changedRows.length,
      domains: [...touchedDomains].sort((left, right) => left.localeCompare(right)),
    };
  }

  async function syncDomainArrayEntriesFromAppState(
    appState,
    domain,
    entryIds,
  ) {
    if (!enabled || !appState || typeof appState !== "object") return;
    const selectedEntryIds = Array.isArray(entryIds)
      ? entryIds.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : [];
    if (selectedEntryIds.length === 0) return;
    await ensure();
    const normalizedDomain = normalizeDomain(domain);
    const rows = normalizeDomainArrayEntryRows(
      normalizedDomain,
      appState?.[normalizedDomain],
      selectedEntryIds,
    );
    if (rows.length === 0) return;
    await withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await upsertChangedDomainRows(connection, rows);
        await connection.commit();
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // noop
        }
        throw error;
      }
    });
    lastDomainChecksums.delete(normalizedDomain);
    lastDomainRecordStates.delete(normalizedDomain);
  }

  async function syncFromAppState(appState, options = {}) {
    if (!enabled || !appState || typeof appState !== "object") return;
    await ensure();
    const selectedDomains = normalizeDomainSelection(
      options.domains ?? options.splitDomains,
    );
    for (const domain of domains) {
      if (selectedDomains && !selectedDomains.has(domain)) continue;
      await syncDomainFromAppState(appState, domain, options);
    }
  }

  function stripDomainsFromAppState(appState, options = {}) {
    if (!enabled || !appState || typeof appState !== "object") return appState;
    const persisted = cloneJson(appState, appState);
    const splitDomains =
      persisted.meta && typeof persisted.meta === "object"
        ? {
            ...(persisted.meta.appStateSplitDomains &&
            typeof persisted.meta.appStateSplitDomains === "object"
              ? persisted.meta.appStateSplitDomains
              : {}),
          }
        : {};

    for (const domain of domains) {
      const originalValue = persisted[domain];
      persisted[domain] = defaultEmptyValue(originalValue);
      splitDomains[domain] = {
        mode: "externalized",
        storage: "mysql",
        table: tableName,
        ...(options.includeUpdatedAt ? { updatedAt: nowIso() } : {}),
      };
    }

    if (persisted.meta && typeof persisted.meta === "object") {
      persisted.meta.appStateSplitDomains = splitDomains;
    }
    return persisted;
  }

  async function prepareAppStateForPrimaryWrite(appState) {
    return stripDomainsFromAppState(appState, { includeUpdatedAt: true });
  }

  async function prepareAppStateForPersistenceComparison(appState) {
    return stripDomainsFromAppState(appState, { includeUpdatedAt: false });
  }

  function logStatus() {
    if (enabled) {
      logger.info?.(
        `[backend] MySQL split domini app-state attivo: tabella ${tableName}, domini ${domains.join(", ")}`,
      );
    }
  }

  return {
    domains,
    enabled,
    hydrateAppState,
    incrementIntegrationOrderSequence,
    logStatus,
    prepareAppStateForPersistenceComparison,
    prepareAppStateForPrimaryWrite,
    readDomainValue,
    readObjectEntry,
    readObjectArrayEntry,
    readObjectArrayField,
    readObjectArrayFieldMatchingText,
    readIntegrationOrdersForStation,
    syncDomainFromAppState,
    syncDomainArrayEntriesFromAppState,
    syncObjectArrayEntriesAndObjectEntriesFromAppState,
    syncObjectArrayEntriesFromAppState,
    syncObjectArrayFieldFromAppState,
    syncObjectEntryFromAppState,
    syncIntegrationLastWriteAt,
    syncSelectedEntriesFromAppState,
    syncFromAppState,
    ensureStorage: ensure,
  };
}
