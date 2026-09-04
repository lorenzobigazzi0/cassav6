export type RealtimeEventEnvelope = {
  eventId: number;
  type: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  aggregateVersion?: number | null;
  scope?: unknown;
  payload?: Record<string, unknown>;
  createdAt?: string | null;
};

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toEventId = (value: unknown) => {
  const parsed = Math.trunc(Number(value) || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export function isRealtimeEventEnvelope(value: unknown): value is RealtimeEventEnvelope {
  const record = toRecord(value);
  return toEventId(record.eventId) > 0 && typeof record.type === "string";
}

export function normalizeRealtimePayload(value: unknown): Record<string, unknown> {
  if (!isRealtimeEventEnvelope(value)) return toRecord(value);
  const payload = toRecord(value.payload);
  return {
    ...payload,
    eventId: value.eventId,
    type: value.type,
    aggregateType: value.aggregateType ?? null,
    aggregateId: value.aggregateId ?? null,
    aggregateVersion: value.aggregateVersion ?? null,
    scope: value.scope ?? null,
    createdAt: value.createdAt ?? null,
  };
}

export function resolveRealtimeEventId(messageEvent: MessageEvent, value: unknown) {
  const fromEnvelope = isRealtimeEventEnvelope(value) ? toEventId(value.eventId) : 0;
  const fromSse = toEventId(messageEvent.lastEventId);
  return fromEnvelope || fromSse;
}

export function rememberRealtimeEventId(
  current: readonly number[],
  eventId: number,
  limit = 200,
) {
  if (eventId <= 0) return { duplicate: false, next: [...current] };
  const duplicate = current.includes(eventId);
  const next = [eventId, ...current.filter((entry) => entry !== eventId)].slice(
    0,
    Math.max(1, limit),
  );
  return { duplicate, next };
}

export function shouldApplyRealtimeEnvelope(
  versions: Map<string, number>,
  value: unknown,
) {
  if (!isRealtimeEventEnvelope(value)) return true;
  const aggregateId = String(value.aggregateId ?? "").trim();
  const aggregateType = String(value.aggregateType ?? "").trim();
  const aggregateVersion = Math.trunc(Number(value.aggregateVersion) || 0);
  if (!aggregateId || !aggregateType || aggregateVersion <= 0) return true;
  const key = `${aggregateType}:${aggregateId}`;
  const currentVersion = versions.get(key) ?? 0;
  if (aggregateVersion < currentVersion) return false;
  versions.set(key, aggregateVersion);
  return true;
}
