function payloadFromRequest(req) {
  return req?.__jsonBodyPayload && typeof req.__jsonBodyPayload === "object"
    ? req.__jsonBodyPayload
    : {};
}

function objectField(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeStringList(value, maxItems = 32, maxLength = 120) {
  const source = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      source
        .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
        .map((entry) => String(entry ?? "").trim().slice(0, maxLength))
        .filter(Boolean),
    ),
  ].slice(0, maxItems);
}

export function normalizeLaneKeyList(...values) {
  return [
    ...new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

export function resolvePaymentLaneKeyFromRequest(req, pathname) {
  const payload = payloadFromRequest(req);
  const safePath = String(pathname ?? "").trim();
  const tableId = String(payload.tableId ?? "").trim();
  if (
    [
      "/api/payments/table",
      "/api/payments/free-split",
      "/api/tables/counter/orders/collect",
    ].includes(safePath) &&
    tableId
  )
    return `table:${tableId}`;
  const movementId = String(payload.paymentId ?? payload.movementId ?? payload.recordId ?? payload.id ?? "").trim();
  if (safePath === "/api/reports/payment-movement/reprint" && movementId) return `movement:${movementId}`;
  const fiscalKey = String(payload.paymentId ?? payload.receiptId ?? payload.fiscalReceiptId ?? payload.fiscalMovementId ?? "").trim();
  if (safePath === "/api/fiscal/command" && fiscalKey) return `fiscal:${fiscalKey}`;
  const orderKey = String(payload.orderId ?? payload.billId ?? "").trim();
  if (orderKey) return `order:${orderKey}`;
  const clientKey = String(payload.idempotencyKey ?? payload.clientPaymentId ?? payload.paymentClientId ?? "").trim();
  if (clientKey) return `client:${clientKey}`;
  const deviceKey = String(payload.deviceUuid ?? payload.userId ?? "").trim();
  return `${safePath}:${deviceKey || "global"}`;
}

export function canDeferPaymentNamedLockAdmission(pathname, options = {}) {
  const safePath = String(pathname ?? "").trim();
  return (
    safePath === "/api/payments/free-split" &&
    options.relationalWritePrimary === true &&
    options.durableMirror === true &&
    options.statelessMirror === true
  );
}

export function resolveRoomLaneKeysFromRequest(req, pathname) {
  const payload = payloadFromRequest(req);
  const safePath = String(pathname ?? "").trim();
  const requestId = String(payload.requestId ?? "").trim();
  if (requestId) return [`request:${requestId}`];
  if (safePath === "/api/integration/table-groups/save") {
    return ["table-groups:global"];
  }
  if (safePath === "/api/integration/layout/table/sync") {
    const tableId = String(payload.tableId ?? "").trim();
    if (tableId) return [`table:${tableId}`];
  }
  if (safePath === "/api/integration/layout/table/move") {
    const fromTableId = String(payload.fromTableId ?? payload.tableId ?? "").trim();
    const toTableId = String(payload.toTableId ?? payload.targetTableId ?? "").trim();
    const tableKeys = normalizeLaneKeyList(fromTableId ? `table:${fromTableId}` : "", toTableId ? `table:${toTableId}` : "");
    if (tableKeys.length > 0) return tableKeys;
  }
  if (safePath === "/api/integration/layout/table/room-move/request") {
    const fromTableId = String(payload.fromTableId ?? payload.tableId ?? "").trim();
    const targetTableIds = normalizeStringList(payload.targetTableIds ?? payload.toTableIds, 24, 80);
    const targetRoomId = String(payload.targetRoomId ?? "").trim();
    const tableKeys = normalizeLaneKeyList(fromTableId ? `table:${fromTableId}` : "", targetTableIds.map((tableId) => `table:${tableId}`), targetRoomId ? `room:${targetRoomId}` : "");
    if (tableKeys.length > 0) return tableKeys;
  }
  if (safePath === "/api/integration/layout/table/room-move/pending") {
    const roomId = String(payload.roomId ?? "").trim();
    if (roomId) return [`room:${roomId}`];
  }
  if (safePath.startsWith("/api/pos/room-change/")) {
    const targetRoomId = String(payload.targetRoomId ?? payload.roomId ?? "").trim();
    const userKey = String(payload.userId ?? payload.deviceUuid ?? payload.sessionId ?? "").trim();
    return normalizeLaneKeyList(targetRoomId ? `room:${targetRoomId}` : "", userKey ? `user:${userKey}` : "");
  }
  const fallback = String(payload.tableId ?? payload.fromTableId ?? payload.targetRoomId ?? payload.roomId ?? payload.deviceUuid ?? payload.userId ?? "").trim();
  return [`${safePath}:${fallback || "global"}`];
}

export function resolveReservationLaneKeysFromRequest(req, pathname) {
  const payload = payloadFromRequest(req);
  const patch = objectField(payload.patch);
  const reservation = objectField(payload.reservation);
  const patchReservation = objectField(patch.reservation);
  const safePath = String(pathname ?? "").trim();
  const reservationId = String(payload.reservationId ?? payload.id ?? reservation.id ?? patch.reservationId ?? patch.id ?? patchReservation.id ?? "").trim();
  const lockId = String(payload.lockId ?? patch.lockId ?? "").trim();
  const roomId = String(payload.roomId ?? patch.roomId ?? reservation.roomId ?? patchReservation.roomId ?? "").trim();
  const serviceDate = String(payload.serviceDate ?? payload.date ?? patch.serviceDate ?? patch.date ?? reservation.serviceDate ?? patchReservation.serviceDate ?? "").trim();
  const tableIds = normalizeLaneKeyList(payload.assignedTableIds, payload.assignedTableId, payload.tableIds, payload.tableId, patch.assignedTableIds, patch.assignedTableId, patch.tableIds, patch.tableId, reservation.assignedTableIds, reservation.assignedTableId, patchReservation.assignedTableIds, patchReservation.assignedTableId);
  const userKey = String(payload.deviceUuid ?? payload.userId ?? payload.sessionId ?? payload.customerPhone ?? "").trim();
  const keys = normalizeLaneKeyList(reservationId ? `reservation:${reservationId}` : "", lockId ? `reservation-lock:${reservationId || lockId}:${lockId}` : "", roomId && serviceDate ? `reservation-room:${roomId}:${serviceDate}` : "", roomId && !serviceDate ? `reservation-room:${roomId}` : "", !roomId && serviceDate ? `reservation-date:${serviceDate}` : "", tableIds.map((tableId) => `table:${tableId}`));
  if (keys.length > 0) return keys;
  return [`${safePath}:${userKey || "global"}`];
}

export function resolveNotificationLaneKeyFromRequest(req, pathname) {
  const payload = payloadFromRequest(req);
  const meta = objectField(payload.meta);
  const safePath = String(pathname ?? "").trim();
  const notificationId = String(payload.id ?? payload.notificationId ?? meta.notificationId ?? "").trim();
  if (notificationId) return `notification:${notificationId}`;
  const orderId = String(payload.orderId ?? meta.orderId ?? meta.sourceOrderId ?? "").trim();
  if (orderId) return `order:${orderId}`;
  const targetKey = String(meta.targetConsumer ?? meta.targetDeviceUuid ?? meta.targetUserId ?? meta.targetUsername ?? meta.targetFullName ?? meta.targetStation ?? meta.station ?? "").trim();
  if (targetKey) return `target:${targetKey}`;
  const type = String(payload.type ?? meta.eventType ?? "").trim();
  const deviceKey = String(payload.deviceUuid ?? payload.userId ?? "").trim();
  return `${safePath}:${type || deviceKey || "global"}`;
}

export function resolvePrintLaneKeysFromRequest(req, pathname) {
  const payload = payloadFromRequest(req);
  const safePath = String(pathname ?? "").trim();
  const targetKey = String(payload.printerId ?? payload.targetPrinterId ?? payload.target ?? payload.printerHost ?? payload.station ?? payload.workstationId ?? "").trim();
  const orderId = String(payload.orderId ?? payload.billId ?? "").trim();
  const kind = String(payload.kind ?? "print").trim().toLowerCase();
  const deviceKey = String(payload.deviceUuid ?? payload.userId ?? payload.sessionId ?? "").trim();
  return normalizeLaneKeyList(
    targetKey ? `print:${targetKey}` : "",
    orderId ? `order:${orderId}` : "",
    `${safePath}:${kind || deviceKey || "global"}`,
  );
}
