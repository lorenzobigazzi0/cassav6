const MIN_TIMESTAMP_MS = 100_000_000_000;
const MAX_TIMESTAMP_MS = 9_999_999_999_999;
const STRICT_UTC_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function parseNumericTimestamp(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_TIMESTAMP_MS ||
    parsed > MAX_TIMESTAMP_MS
  ) {
    return 0;
  }
  return parsed;
}

export function parseNotificationTimestampMs(value) {
  if (typeof value === "number") return parseNumericTimestamp(value);
  if (typeof value !== "string") return 0;
  const normalized = value.trim();
  if (!normalized) return 0;
  if (/^[1-9]\d{11,15}$/.test(normalized)) {
    return parseNumericTimestamp(normalized);
  }

  const match = STRICT_UTC_ISO_PATTERN.exec(normalized);
  if (!match) return 0;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, fractionRaw = ""] =
    match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = Number(fractionRaw.padEnd(3, "0"));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return 0;
  }
  const parsed = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  const date = new Date(parsed);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) {
    return 0;
  }
  return parseNumericTimestamp(parsed);
}

export function isNotificationTimestampFresh(value, sessionStartedAtMs) {
  const createdAtMs = parseNotificationTimestampMs(value);
  const startedAtMs = parseNotificationTimestampMs(sessionStartedAtMs);
  return createdAtMs > 0 && startedAtMs > 0 && createdAtMs >= startedAtMs;
}

function eventTimestampMs(event, payload) {
  for (const value of [
    event?.createdAt,
    event?.occurredAt,
    event?.atMs,
    payload?.atMs,
  ]) {
    const parsed = parseNotificationTimestampMs(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

export function filterNotificationEventForSession(event, sessionStartedAtMs) {
  const startedAtMs = parseNotificationTimestampMs(sessionStartedAtMs);
  const root = object(event);
  if (!root || startedAtMs <= 0) return null;
  const nestedPayload = object(root.payload);
  const payload = nestedPayload ?? root;
  const detail = object(payload.detail);

  if (!detail) {
    const occurredAtMs = eventTimestampMs(root, payload);
    return occurredAtMs >= startedAtMs ? event : null;
  }

  const hasSingle = Object.prototype.hasOwnProperty.call(detail, "notification");
  const hasBatch = Object.prototype.hasOwnProperty.call(detail, "notifications");
  if (!hasSingle && !hasBatch) {
    const occurredAtMs = eventTimestampMs(root, payload);
    return occurredAtMs >= startedAtMs ? event : null;
  }

  const single = object(detail.notification);
  const singleFresh =
    single && isNotificationTimestampFresh(single.createdAt, startedAtMs)
      ? single
      : null;
  const sourceBatch = Array.isArray(detail.notifications)
    ? detail.notifications
    : [];
  const freshBatch = sourceBatch.filter((entry) => {
    const notification = object(entry);
    return Boolean(
      notification &&
        isNotificationTimestampFresh(notification.createdAt, startedAtMs),
    );
  });
  if (!singleFresh && freshBatch.length === 0) return null;

  const singleUnchanged = !hasSingle || singleFresh === detail.notification;
  const batchUnchanged =
    !hasBatch ||
    (Array.isArray(detail.notifications) &&
      freshBatch.length === detail.notifications.length);
  if (singleUnchanged && batchUnchanged) return event;

  const nextDetail = { ...detail };
  if (hasSingle) {
    if (singleFresh) nextDetail.notification = singleFresh;
    else delete nextDetail.notification;
  }
  if (hasBatch) nextDetail.notifications = freshBatch;
  const nextPayload = { ...payload, detail: nextDetail };
  return nestedPayload ? { ...root, payload: nextPayload } : nextPayload;
}
