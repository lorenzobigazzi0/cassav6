import type { OfflineOutboxEntry, OfflineOutboxOwner, OfflineOutboxStatus } from "./offlineStore";

export const OFFLINE_OUTBOX_LEGACY_MIGRATION_VERSION = 1;

const CONFLICT_HTTP_STATUSES = new Set([409, 412, 422]);

export type OfflineReplayHttpFailure = {
  kind: "http_conflict" | "http_rejected";
  status: Extract<OfflineOutboxStatus, "conflict" | "failed">;
};

export type LegacyOfflineRequestMigration = "none" | "preserve-held" | "requeue-fiscal";

type OfflineOutboxOwnerSource = Pick<OfflineOutboxEntry, "body" | "headers"> &
  Partial<OfflineOutboxOwner>;

export type OfflineReplayOwnerContext = {
  userId?: string | null;
  activityId?: string | null;
  deviceUuid?: string | null;
};

export type OfflineReplayOwnershipDecision =
  | { state: "allowed"; owner: OfflineOutboxOwner & { ownerUserId: string } }
  | { state: "unknown-owner"; owner: OfflineOutboxOwner }
  | { state: "different-owner"; owner: OfflineOutboxOwner & { ownerUserId: string } };

const normalizedOwnerValue = (value: unknown) => String(value ?? "").trim();

const headerValue = (headers: Record<string, string>, name: string) => {
  const normalizedName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName);
  return normalizedOwnerValue(entry?.[1]);
};

const ownerBody = (body: string | null) => {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export function deriveOfflineOutboxOwner(source: OfflineOutboxOwnerSource): OfflineOutboxOwner {
  const body = ownerBody(source.body);
  const ownerUserId =
    normalizedOwnerValue(source.ownerUserId) ||
    headerValue(source.headers, "x-user-id") ||
    normalizedOwnerValue(body?.userId);
  const ownerActivityId =
    normalizedOwnerValue(source.ownerActivityId) ||
    headerValue(source.headers, "x-activity-id") ||
    normalizedOwnerValue(body?.activityId);
  const ownerDeviceUuid =
    normalizedOwnerValue(source.ownerDeviceUuid) ||
    headerValue(source.headers, "x-device-uuid") ||
    normalizedOwnerValue(body?.deviceUuid);
  return {
    ...(ownerUserId ? { ownerUserId } : {}),
    ...(ownerActivityId ? { ownerActivityId } : {}),
    ...(ownerDeviceUuid ? { ownerDeviceUuid } : {}),
  };
}

export function completeOfflineOutboxOwner(
  source: OfflineOutboxOwnerSource,
  context: OfflineReplayOwnerContext
): OfflineOutboxOwner {
  const owner = deriveOfflineOutboxOwner(source);
  const ownerUserId = owner.ownerUserId || normalizedOwnerValue(context.userId);
  const ownerActivityId = owner.ownerActivityId || normalizedOwnerValue(context.activityId);
  const ownerDeviceUuid = owner.ownerDeviceUuid || normalizedOwnerValue(context.deviceUuid);
  return {
    ...(ownerUserId ? { ownerUserId } : {}),
    ...(ownerActivityId ? { ownerActivityId } : {}),
    ...(ownerDeviceUuid ? { ownerDeviceUuid } : {}),
  };
}

export function withDerivedOfflineOutboxOwner(entry: OfflineOutboxEntry): OfflineOutboxEntry {
  return { ...entry, ...deriveOfflineOutboxOwner(entry) };
}

export function evaluateOfflineReplayOwnership(
  entry: OfflineOutboxOwnerSource,
  context: OfflineReplayOwnerContext
): OfflineReplayOwnershipDecision {
  const owner = deriveOfflineOutboxOwner(entry);
  if (!owner.ownerUserId) return { state: "unknown-owner", owner };

  const currentUserId = normalizedOwnerValue(context.userId);
  const currentActivityId = normalizedOwnerValue(context.activityId);
  const currentDeviceUuid = normalizedOwnerValue(context.deviceUuid);
  const ownerMatches =
    owner.ownerUserId === currentUserId &&
    (!owner.ownerActivityId || owner.ownerActivityId === currentActivityId) &&
    (!owner.ownerDeviceUuid || owner.ownerDeviceUuid === currentDeviceUuid);
  return ownerMatches
    ? { state: "allowed", owner: { ...owner, ownerUserId: owner.ownerUserId } }
    : { state: "different-owner", owner: { ...owner, ownerUserId: owner.ownerUserId } };
}

export function offlineOutboxEntryMatchesOwner(
  entry: OfflineOutboxOwnerSource,
  filter: OfflineOutboxOwner
) {
  const owner = deriveOfflineOutboxOwner(entry);
  const ownerUserId = normalizedOwnerValue(filter.ownerUserId);
  const ownerActivityId = normalizedOwnerValue(filter.ownerActivityId);
  const ownerDeviceUuid = normalizedOwnerValue(filter.ownerDeviceUuid);
  if (ownerUserId && owner.ownerUserId !== ownerUserId) return false;
  if (ownerActivityId && owner.ownerActivityId !== ownerActivityId) return false;
  if (ownerDeviceUuid && owner.ownerDeviceUuid !== ownerDeviceUuid) return false;
  return Boolean(ownerUserId || ownerActivityId || ownerDeviceUuid);
}

export function classifyOfflineReplayHttpFailure(
  httpStatus: number
): OfflineReplayHttpFailure | null {
  if (httpStatus < 400 || httpStatus >= 500) return null;
  if (CONFLICT_HTTP_STATUSES.has(httpStatus)) {
    return { kind: "http_conflict", status: "conflict" };
  }
  return { kind: "http_rejected", status: "failed" };
}

export function holdOfflineRequestAfterHttpFailure(
  entry: OfflineOutboxEntry,
  httpStatus: number,
  lastError: string,
  now = Date.now()
): OfflineOutboxEntry {
  const failure = classifyOfflineReplayHttpFailure(httpStatus);
  if (!failure) return entry;
  return {
    ...entry,
    attempts: entry.attempts + 1,
    replayMode: "held",
    status: failure.status,
    updatedAt: now,
    nextAttemptAt: 0,
    lastError,
    terminalFailure: {
      kind: failure.kind,
      httpStatus,
      recordedAt: now,
    },
  };
}

export function holdExpiredOfflineRequest(
  entry: OfflineOutboxEntry,
  now = Date.now()
): OfflineOutboxEntry {
  return {
    ...entry,
    replayMode: "held",
    status: "held",
    updatedAt: now,
    nextAttemptAt: 0,
    lastError:
      "Operazione offline oltre la finestra di invio automatico: verifica richiesta, nessun dato eliminato.",
  };
}

export function planLegacyOfflineRequestMigration(input: {
  entry: OfflineOutboxEntry;
  isFiscalReconciliation: boolean;
  now?: number;
}): LegacyOfflineRequestMigration {
  const { entry, isFiscalReconciliation } = input;
  const now = input.now ?? Date.now();
  if (
    entry.terminalFailure ||
    Number(entry.legacyMigrationVersion ?? 0) >= OFFLINE_OUTBOX_LEGACY_MIGRATION_VERSION
  ) {
    return "none";
  }
  const needsAttention =
    entry.replayMode === "held" || ["held", "failed", "conflict"].includes(entry.status);
  if (!needsAttention) return "none";

  const isUnexpired = entry.expiresAt <= 0 || entry.expiresAt > now;
  if (entry.status === "held" && isFiscalReconciliation && isUnexpired) {
    return "requeue-fiscal";
  }
  return "preserve-held";
}
