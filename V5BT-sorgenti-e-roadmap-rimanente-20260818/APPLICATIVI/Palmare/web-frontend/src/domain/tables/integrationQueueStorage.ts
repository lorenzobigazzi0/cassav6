import {
  readLocalStorageString,
  writeLocalStorageString,
} from "../../shared/storage/storageAdapter";
import type { IntegrationQueueOwner, PendingIntegrationAction } from "./integrationTypes";

export const INTEGRATION_QUEUE_STORAGE_KEY = "POS_INTEGRATION_QUEUE_V1";

const normalize = (value: unknown) => String(value ?? "").trim();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const resolveOwnerFromRecords = (
  ...records: Array<Record<string, unknown> | null>
): IntegrationQueueOwner | null => {
  const explicitOwner = records.map((record) => asRecord(record?.owner)).find(Boolean) ?? null;
  const candidates = [explicitOwner, ...records].filter(
    (record): record is Record<string, unknown> => record !== null
  );
  const pick = (...keys: string[]) => {
    for (const record of candidates) {
      for (const key of keys) {
        const value = normalize(record[key]);
        if (value) return value;
      }
    }
    return "";
  };
  const userId = pick("userId", "createdByUserId");
  const activityId = pick("activityId", "operationalActivityId");
  const deviceUuid = pick("deviceUuid");
  if (!userId || !activityId || !deviceUuid) return null;
  return { userId, activityId, deviceUuid };
};

export const integrationQueueOwnersEqual = (
  left: IntegrationQueueOwner,
  right: IntegrationQueueOwner
) =>
  left.userId === right.userId &&
  left.activityId === right.activityId &&
  left.deviceUuid === right.deviceUuid;

export const isIntegrationQueueActionOwnedBy = (
  action: PendingIntegrationAction,
  owner: IntegrationQueueOwner
) => integrationQueueOwnersEqual(action.owner, owner);

const withoutPersistedToken = (payload: Record<string, unknown>) => {
  const safePayload = { ...payload };
  delete safePayload.token;
  return safePayload;
};

const withoutPersistedCredentials = (
  action: PendingIntegrationAction
): PendingIntegrationAction => {
  if (action.kind === "layout_sync") {
    return {
      ...action,
      payload: {
        basePayload: withoutPersistedToken(action.payload.basePayload),
        payloadWithSession: action.payload.payloadWithSession
          ? withoutPersistedToken(action.payload.payloadWithSession)
          : null,
      },
    };
  }
  return {
    ...action,
    payload: withoutPersistedToken(action.payload),
  };
};

export const loadIntegrationQueueFromStorage = (): PendingIntegrationAction[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = readLocalStorageString(INTEGRATION_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const next: PendingIntegrationAction[] = [];
    parsed.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const source = entry as Record<string, unknown>;
      const kind = String(source.kind ?? "").trim();
      const queuedAtRaw = Number(source.queuedAtMs);
      const queuedAtMs = Number.isFinite(queuedAtRaw)
        ? Math.max(0, Math.trunc(queuedAtRaw))
        : Date.now();
      if (kind === "order_create") {
        const roomId = String(source.roomId ?? "").trim();
        const tableId = String(source.tableId ?? "").trim();
        const localOrderId = String(source.localOrderId ?? "").trim();
        const payload = asRecord(source.payload);
        const owner = resolveOwnerFromRecords(source, payload);
        if (!roomId || !tableId || !localOrderId || !payload || !owner) return;
        next.push({
          kind: "order_create",
          owner,
          roomId,
          tableId,
          localOrderId,
          payload: withoutPersistedToken(payload),
          queuedAtMs,
        });
        return;
      }
      if (kind === "order_sync") {
        const orderId = String(source.orderId ?? "").trim();
        const payload = asRecord(source.payload);
        const owner = resolveOwnerFromRecords(source, payload);
        if (!orderId || !payload || !owner) return;
        next.push({
          kind: "order_sync",
          owner,
          orderId,
          payload: withoutPersistedToken(payload),
          queuedAtMs,
        });
        return;
      }
      if (kind === "layout_sync") {
        const tableId = String(source.tableId ?? "").trim();
        const payloadSource = asRecord(source.payload);
        const basePayload = asRecord(payloadSource?.basePayload);
        const payloadWithSession = asRecord(payloadSource?.payloadWithSession);
        const owner = resolveOwnerFromRecords(source, payloadWithSession, basePayload);
        if (!tableId || !payloadSource || !basePayload || !owner) return;
        next.push({
          kind: "layout_sync",
          owner,
          tableId,
          payload: {
            basePayload: withoutPersistedToken(basePayload),
            payloadWithSession: payloadWithSession
              ? withoutPersistedToken(payloadWithSession)
              : null,
          },
          queuedAtMs,
        });
      }
    });
    return next;
  } catch {
    return [];
  }
};

export const saveIntegrationQueueToStorage = (queue: PendingIntegrationAction[]) => {
  if (typeof window === "undefined") return;
  try {
    writeLocalStorageString(
      INTEGRATION_QUEUE_STORAGE_KEY,
      JSON.stringify(queue.map(withoutPersistedCredentials))
    );
  } catch {
    // ignore storage errors
  }
};
