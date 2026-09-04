import { applyNotificationPriorityToMeta } from "./notification-priority.js";
import { parseNotificationTimestampMs } from "./notification-session-policy.js";

export const INTEGRATION_NOTIFICATION_TYPES = new Set(["waiter", "bell", "general"]);

const INTEGRATION_NOTIFICATION_MAX_DELIVERED_TO = 24;
const INTEGRATION_NOTIFICATION_MAX_ACKED_BY = 24;

export function normalizeIntegrationNotificationType(value) {
  return INTEGRATION_NOTIFICATION_TYPES.has(value) ? value : "general";
}

export function sanitizeIntegrationNotification(notification, fallbackId = "ntf_1") {
  const source = notification && typeof notification === "object" ? notification : {};
  const type = normalizeIntegrationNotificationType(source.type);
  const hasCreatedAt = source.createdAt !== undefined && source.createdAt !== null;
  const parsedCreatedAt = parseNotificationTimestampMs(source.createdAt);
  const createdAt = parsedCreatedAt || (hasCreatedAt ? 0 : Date.now());
  const deliveredTo = Array.isArray(source.deliveredTo)
    ? [...new Set(source.deliveredTo.map((item) => String(item).trim()).filter(Boolean))].slice(
        -INTEGRATION_NOTIFICATION_MAX_DELIVERED_TO
      )
    : [];
  const ackedBy = Array.isArray(source.ackedBy)
    ? [...new Set(source.ackedBy.map((item) => String(item).trim()).filter(Boolean))].slice(
        -INTEGRATION_NOTIFICATION_MAX_ACKED_BY
      )
    : [];
  const meta =
    source.meta && typeof source.meta === "object"
      ? JSON.parse(JSON.stringify(source.meta))
      : {};
  applyNotificationPriorityToMeta(meta, type);
  return {
    id: String(source.id ?? fallbackId),
    type,
    title: String(source.title ?? "Notifica").slice(0, 140),
    description: String(source.description ?? "").slice(0, 240),
    createdAt,
    meta,
    deliveredTo,
    ackedBy,
  };
}

export function sanitizeIntegrationBellClaim(record, fallbackNotificationId = "") {
  const source = record && typeof record === "object" ? record : {};
  const notificationId = String(source.notificationId ?? fallbackNotificationId).trim();
  if (!notificationId) return null;
  const claimedAtMsRaw = Number(source.claimedAtMs ?? source.claimedAt ?? Date.now());
  const claimedAtMs =
    Number.isFinite(claimedAtMsRaw) && claimedAtMsRaw > 0
      ? Math.trunc(claimedAtMsRaw)
      : Date.now();
  const claimedByFullName =
    String(
      source.claimedByFullName ??
        source.waiter ??
        source.claimedByUsername ??
        source.claimedByUserId ??
        "Cameriere"
    ).trim() || "Cameriere";
  const statusRaw = String(source.status ?? source.responseStatus ?? "").trim().toLowerCase();
  const status = ["arriving", "answered", "claimed"].includes(statusRaw) ? statusRaw : "arriving";
  return {
    notificationId,
    orderId: String(source.orderId ?? "").trim(),
    station: String(source.station ?? "").trim(),
    roomId: String(source.roomId ?? "").trim(),
    roomName: String(source.roomName ?? "").trim(),
    claimedAtMs,
    claimedAt: new Date(claimedAtMs).toISOString(),
    claimedByConsumer: String(source.claimedByConsumer ?? "").trim(),
    claimedByUserId: String(source.claimedByUserId ?? "").trim(),
    claimedByUsername: String(source.claimedByUsername ?? "").trim(),
    claimedByFullName,
    claimedByDeviceUuid: String(source.claimedByDeviceUuid ?? "").trim(),
    waiter: claimedByFullName,
    status,
    respondedAtMs: claimedAtMs,
    respondedAt: new Date(claimedAtMs).toISOString(),
    respondedByUserId: String(source.respondedByUserId ?? source.claimedByUserId ?? "").trim(),
    respondedByUsername: String(source.respondedByUsername ?? source.claimedByUsername ?? "").trim(),
    respondedByFullName:
      String(source.respondedByFullName ?? source.claimedByFullName ?? claimedByFullName).trim() ||
      claimedByFullName,
    respondedByDeviceUuid: String(source.respondedByDeviceUuid ?? source.claimedByDeviceUuid ?? "").trim(),
  };
}

export function getIntegrationRecentBellClaims(integration) {
  const claims = Array.isArray(integration?.recentBellClaims) ? integration.recentBellClaims : [];
  return claims
    .map((claim) => sanitizeIntegrationBellClaim(claim))
    .filter((claim) => claim !== null);
}
