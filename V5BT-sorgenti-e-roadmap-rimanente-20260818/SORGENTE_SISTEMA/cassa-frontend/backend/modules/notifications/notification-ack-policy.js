function getNotificationMeta(notification) {
  return notification?.meta && typeof notification.meta === "object" ? notification.meta : {};
}

function hasExplicitNotificationTarget(meta) {
  return Boolean(
    meta.targetUserId ||
      (Array.isArray(meta.targetUserIds) && meta.targetUserIds.length > 0) ||
      meta.targetUsername ||
      meta.targetFullName ||
      meta.targetDeviceUuid
  );
}

export function isNotificationGloballyAcknowledged(notification) {
  const meta = getNotificationMeta(notification);
  const acknowledgedAtMs = Number(meta.acknowledgedAtMs);
  return (
    (Number.isFinite(acknowledgedAtMs) && acknowledgedAtMs > 0) ||
    Boolean(meta.acknowledgedAt)
  );
}

export function shouldGloballyAcknowledgeNotification(notification) {
  const meta = getNotificationMeta(notification);
  if (meta.keepAfterAck === true) return false;
  if (meta.globalAck === true) return true;
  if (notification?.type === "waiter") return true;
  return hasExplicitNotificationTarget(meta);
}

export function markNotificationGloballyAcknowledged(notification, context = {}) {
  if (!notification || typeof notification !== "object") return false;
  if (isNotificationGloballyAcknowledged(notification)) return false;

  const nowMs = Number(context.nowMs);
  const acknowledgedAtMs =
    Number.isFinite(nowMs) && nowMs > 0 ? Math.trunc(nowMs) : Date.now();
  const requester =
    context.requester && typeof context.requester === "object" ? context.requester : {};
  notification.meta = {
    ...getNotificationMeta(notification),
    acknowledgedAtMs,
    acknowledgedAt: new Date(acknowledgedAtMs).toISOString(),
    acknowledgedByConsumer: String(context.consumer ?? "").trim(),
    acknowledgedByUserId: String(requester.userId ?? "").trim(),
    acknowledgedByUsername: String(requester.username ?? "").trim(),
    acknowledgedByFullName: String(requester.fullName ?? "").trim(),
    acknowledgedByDeviceUuid: String(requester.deviceUuid ?? "").trim(),
  };
  return true;
}
