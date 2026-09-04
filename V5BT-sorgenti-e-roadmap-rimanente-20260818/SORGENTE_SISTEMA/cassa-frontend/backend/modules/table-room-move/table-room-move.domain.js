export const AUTO_APPROVE_TABLE_ROOM_MOVE_ON_TIMEOUT = true;

function normalizeStringList(value, maxLength = 12, itemMaxLength = 40) {
  const source = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out = [];
  const seen = new Set();
  for (const entry of source) {
    const normalized = String(entry ?? "").trim().slice(0, itemMaxLength);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxLength) break;
  }
  return out;
}

function clampInt(value, min, max, fallback = min) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}

export function createTableRoomMoveHelpers(options = {}) {
  const approvalTimeoutMs = Number.isFinite(Number(options.approvalTimeoutMs))
    ? Number(options.approvalTimeoutMs)
    : 120_000;
  const nowMs = typeof options.nowMs === "function" ? options.nowMs : () => Date.now();

  function sanitizePosTableRoomMoveRequestRecord(entry, availableRoomsById = null) {
    if (!entry || typeof entry !== "object") return null;
    const requestId = String(entry.requestId ?? "").trim();
    const requesterUserId = String(entry.requesterUserId ?? entry.userId ?? "").trim();
    const requesterDeviceUuid = String(entry.requesterDeviceUuid ?? entry.deviceUuid ?? "").trim();
    const targetRoomId = String(entry.targetRoomId ?? entry?.targetRoom?.id ?? "").trim();
    if (!requestId || !requesterUserId || !requesterDeviceUuid || !targetRoomId) return null;
    const targetRoomNameInput = String(entry.targetRoomName ?? entry?.targetRoom?.name ?? "").trim();
    const roomFromSettings =
      availableRoomsById && availableRoomsById instanceof Map
        ? availableRoomsById.get(targetRoomId)
        : null;
    const targetRoomName = roomFromSettings?.name || targetRoomNameInput || targetRoomId;
    const createdAtRaw = Number(entry.createdAt);
    const expiresAtRaw = Number(entry.expiresAt);
    const createdAt = Number.isFinite(createdAtRaw) ? Math.max(0, Math.trunc(createdAtRaw)) : nowMs();
    const expiresAt = Number.isFinite(expiresAtRaw)
      ? Math.max(createdAt, Math.trunc(expiresAtRaw))
      : createdAt + approvalTimeoutMs;
    const statusRaw = String(entry.status ?? "pending").trim().toLowerCase();
    const status =
      statusRaw === "approved" ||
      statusRaw === "rejected" ||
      statusRaw === "timeout_approved"
        ? statusRaw
        : "pending";
    const fromTableId = String(entry.fromTableId ?? entry.tableId ?? "").trim();
    const targetTableIds = normalizeStringList(entry.targetTableIds ?? entry.toTableIds, 24, 80);
    if (!fromTableId || targetTableIds.length === 0) return null;
    return {
      requestId,
      requesterUserId,
      requesterUsername: String(entry.requesterUsername ?? "").trim().slice(0, 64),
      requesterFullName: String(entry.requesterFullName ?? "").trim().slice(0, 80),
      requesterDeviceUuid,
      fromRoomId: String(entry.fromRoomId ?? "").trim(),
      fromRoomName: String(entry.fromRoomName ?? "").trim().slice(0, 80),
      targetRoomId,
      targetRoomName,
      fromTableId,
      fromTableLabel: String(entry.fromTableLabel ?? "").trim().slice(0, 80),
      targetTableIds,
      targetTableLabels: normalizeStringList(entry.targetTableLabels, 24, 80),
      sourceLeafCount: clampInt(entry.sourceLeafCount, 1, 24, 1),
      targetTableCount: clampInt(entry.targetTableCount, 1, 24, targetTableIds.length),
      adjustCoversDelta: clampInt(entry.adjustCoversDelta, -24, 24, 0),
      status,
      approverUserId: String(entry.approverUserId ?? "").trim(),
      approverUsername: String(entry.approverUsername ?? "").trim().slice(0, 64),
      approvedAt: Number.isFinite(Number(entry.approvedAt)) ? Math.max(0, Math.trunc(Number(entry.approvedAt))) : null,
      rejectedAt: Number.isFinite(Number(entry.rejectedAt)) ? Math.max(0, Math.trunc(Number(entry.rejectedAt))) : null,
      revision: clampInt(entry.revision, 1, 1_000_000, 1),
      createdAt,
      expiresAt,
    };
  }

  function buildPosTableRoomMoveResponse(request) {
    const safe = sanitizePosTableRoomMoveRequestRecord(request);
    if (!safe) return null;
    return {
      requestId: safe.requestId,
      status: safe.status,
      requesterUserId: safe.requesterUserId,
      requesterUsername: safe.requesterUsername,
      requesterFullName: safe.requesterFullName,
      fromRoomId: safe.fromRoomId,
      fromRoomName: safe.fromRoomName,
      targetRoomId: safe.targetRoomId,
      targetRoomName: safe.targetRoomName,
      fromTableId: safe.fromTableId,
      fromTableLabel: safe.fromTableLabel,
      targetTableIds: safe.targetTableIds,
      targetTableLabels: safe.targetTableLabels,
      sourceLeafCount: safe.sourceLeafCount,
      targetTableCount: safe.targetTableCount,
      adjustCoversDelta: safe.adjustCoversDelta,
      expiresAt: safe.expiresAt,
      createdAt: safe.createdAt,
      approverUsername: safe.approverUsername,
    };
  }

  function buildPosTableRoomMoveNotificationPayload(request, kind = "request") {
    const safe = sanitizePosTableRoomMoveRequestRecord(request);
    if (!safe) return null;
    const requesterName = safe.requesterFullName || safe.requesterUsername || "Un cameriere";
    const tableLabel = safe.fromTableLabel || safe.fromTableId;
    if (kind === "timeout") {
      return {
        type: "general",
        title: "Cambio sala tavolo",
        description: `${tableLabel} spostato automaticamente in ${safe.targetRoomName}.`,
        meta: {
          eventType: "table_room_move_timeout",
          requestId: safe.requestId,
          targetRoomId: safe.targetRoomId,
          targetRoomName: safe.targetRoomName,
          targetClientApp: "mobile-frontend",
        },
      };
    }
    if (kind === "resolved") {
      return {
        type: "general",
        title: "Cambio sala tavolo",
        description:
          safe.status === "rejected"
            ? `Spostamento ${tableLabel} rifiutato.`
            : `Spostamento ${tableLabel} approvato.`,
        meta: {
          eventType: safe.status === "rejected" ? "table_room_move_rejected" : "table_room_move_approved",
          requestId: safe.requestId,
          targetUserId: safe.requesterUserId,
          targetDeviceUuid: safe.requesterDeviceUuid,
          targetClientApp: "mobile-frontend",
        },
      };
    }
    return {
      type: "general",
      title: safe.targetRoomName,
      description: `${requesterName} chiede di spostare ${tableLabel} in questa sala.`,
      meta: {
        eventType: "table_room_move_request",
        requestId: safe.requestId,
        targetRoomId: safe.targetRoomId,
        targetRoomName: safe.targetRoomName,
        targetClientApp: "mobile-frontend",
        requesterUserId: safe.requesterUserId,
        requesterUsername: safe.requesterUsername,
        requesterFullName: safe.requesterFullName,
        fromTableId: safe.fromTableId,
        fromTableLabel: safe.fromTableLabel,
        targetTableIds: safe.targetTableIds,
        targetTableLabels: safe.targetTableLabels,
        expiresAt: safe.expiresAt,
      },
    };
  }

  function resolvePendingPosTableRoomMoveRequest(db, request, status, approver = null) {
    const safe = sanitizePosTableRoomMoveRequestRecord(request);
    if (!safe || safe.status !== "pending") return { request: safe, changed: false };
    const nextStatus = status === "rejected" ? "rejected" : status === "timeout_approved" ? "timeout_approved" : "approved";
    const resolvedAt = nowMs();
    const next = {
      ...safe,
      status: nextStatus,
      approverUserId: String(approver?.id ?? safe.approverUserId ?? "").trim(),
      approverUsername: String(approver?.username ?? safe.approverUsername ?? "").trim(),
      approvedAt: nextStatus === "approved" || nextStatus === "timeout_approved" ? resolvedAt : safe.approvedAt,
      rejectedAt: nextStatus === "rejected" ? resolvedAt : safe.rejectedAt,
    };
    const index = Array.isArray(db?.posTableRoomMoveRequests)
      ? db.posTableRoomMoveRequests.findIndex((entry) => entry?.requestId === safe.requestId)
      : -1;
    if (index >= 0) db.posTableRoomMoveRequests[index] = next;
    return { request: next, changed: true };
  }

  return {
    buildPosTableRoomMoveNotificationPayload,
    buildPosTableRoomMoveResponse,
    resolvePendingPosTableRoomMoveRequest,
    sanitizePosTableRoomMoveRequestRecord,
  };
}
