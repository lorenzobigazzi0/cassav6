export function normalizeScopedReadId(value, maxLength = 160) {
  return String(value ?? "")
    .trim()
    .replace(/^#/, "")
    .slice(0, maxLength);
}

export function resolveScopedReadSourceMeta(source) {
  const normalized = String(source ?? "legacy").trim() || "legacy";
  const scopedRead =
    normalized === "scoped" ||
    normalized === "redis" ||
    normalized === "relational";
  return {
    scopedRead,
    source: normalized,
    fullStateFallbackUsed: !scopedRead,
    redisCacheHit: normalized === "redis",
  };
}

export function findScopedTable(layout, tableId) {
  const id = normalizeScopedReadId(tableId);
  if (!id || !Array.isArray(layout?.tables)) return null;
  return (
    layout.tables.find((table) => normalizeScopedReadId(table?.id) === id) ??
    null
  );
}

export function listScopedRoomTables(layout, roomId) {
  const id = normalizeScopedReadId(roomId);
  if (!id || !Array.isArray(layout?.tables)) return [];
  return layout.tables.filter((table) => normalizeScopedReadId(table?.roomId) === id);
}

export function findScopedOpenOrderForTable(orders, tableId) {
  const id = normalizeScopedReadId(tableId);
  if (!id || !Array.isArray(orders)) return null;
  const orderTimeMs = (order) => {
    const numeric = Number(order?.receivedAtMs ?? order?.createdAtMs);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(String(order?.createdAt ?? ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const openOrders = orders
    .filter((order) => {
      if (normalizeScopedReadId(order?.tableId) !== id) return false;
      const paymentStatus = String(order?.paymentStatus ?? "")
        .trim()
        .toLowerCase();
      const workflowStatus = String(order?.workflowStatus ?? "")
        .trim()
        .toLowerCase();
      const dueAmount = Math.round(Math.max(Number(order?.dueAmount) || 0, 0) * 100) / 100;
      if (paymentStatus === "paid") return false;
      if (["cancelled", "voided", "annullata"].includes(workflowStatus)) return false;
      return dueAmount > 0.009 || ["waiting", "prep", "ready", "delivered"].includes(workflowStatus);
    })
    .sort((left, right) => {
      const leftMs = orderTimeMs(left);
      const rightMs = orderTimeMs(right);
      return rightMs - leftMs || normalizeScopedReadId(right?.id).localeCompare(normalizeScopedReadId(left?.id));
    });
  return openOrders[0] ?? null;
}

export function findScopedPrintJob(jobs, jobId) {
  const id = normalizeScopedReadId(jobId);
  if (!id || !Array.isArray(jobs)) return null;
  return jobs.find((job) => normalizeScopedReadId(job?.id) === id) ?? null;
}

export function listScopedNotifications(notifications, requester, options = {}) {
  const {
    compareNotifications = null,
    isGloballyAcknowledged = null,
    matchesTarget = null,
    sanitizeNotification = (notification) => notification,
  } = options;
  const consumer = normalizeScopedReadId(requester?.consumer || "mobile-frontend");
  const ackConsumer = normalizeScopedReadId(requester?.ackConsumer || consumer);
  const items = (Array.isArray(notifications) ? notifications : [])
    .map((notification, index) =>
      sanitizeNotification(notification, `ntf_${String(index + 1).padStart(7, "0")}`),
    )
    .filter((notification) => notification && typeof notification === "object")
    .filter((notification) => {
      if (typeof isGloballyAcknowledged === "function" && isGloballyAcknowledged(notification)) {
        return false;
      }
      if (Array.isArray(notification?.ackedBy) && notification.ackedBy.includes(ackConsumer)) {
        return false;
      }
      if (typeof matchesTarget !== "function") return true;
      return matchesTarget(notification, requester) === true;
    });
  if (typeof compareNotifications === "function") {
    items.sort(compareNotifications);
  }
  return items.map((notification) => ({
    id: notification.id,
    type: notification.type,
    title: notification.title,
    description: notification.description,
    createdAt: notification.createdAt,
    meta: notification.meta,
  }));
}
