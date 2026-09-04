export function createTableWorkLockHelpers(options = {}) {
  const nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
  const nowMs = typeof options.nowMs === "function" ? options.nowMs : () => Date.now();
  const isAdminUser = typeof options.isAdminUser === "function" ? options.isAdminUser : () => false;
  const hasPermission = typeof options.hasPermission === "function" ? options.hasPermission : () => false;
  const tableLockTtlMs = Number.isFinite(Number(options.tableLockTtlMs))
    ? Number(options.tableLockTtlMs)
    : 120_000;
  const heartbeatWriteMinIntervalMs = Number.isFinite(Number(options.heartbeatWriteMinIntervalMs))
    ? Number(options.heartbeatWriteMinIntervalMs)
    : 10_000;

  function sanitizeTableWorkLock(lock) {
    if (!lock || typeof lock !== "object") return null;
    const tableId = String(lock.tableId ?? "").trim();
    const userId = String(lock.userId ?? "").trim();
    const sessionId = String(lock.sessionId ?? "").trim();
    const deviceUuid = String(lock.deviceUuid ?? "").trim();
    const expiresAt = String(lock.expiresAt ?? "").trim();
    const expiresAtMs = Date.parse(expiresAt);
    if (!tableId || !userId || !expiresAt || !Number.isFinite(expiresAtMs)) return null;
    return {
      tableId,
      userId,
      username: String(lock.username ?? "").trim() || userId,
      deviceUuid,
      sessionId,
      purpose: String(lock.purpose ?? "table_mutation").trim().slice(0, 80) || "table_mutation",
      acquiredAt: String(lock.acquiredAt ?? nowIso()),
      heartbeatAt: String(lock.heartbeatAt ?? lock.acquiredAt ?? nowIso()),
      expiresAt: new Date(expiresAtMs).toISOString(),
      ...(Number.isFinite(Number(lock.revision)) ? { revision: Math.max(1, Math.trunc(Number(lock.revision))) } : {}),
    };
  }

  function isTableWorkLockExpired(lock, nowMs = Date.now()) {
    const safeLock = sanitizeTableWorkLock(lock);
    if (!safeLock) return true;
    const expiresAtMs = Date.parse(safeLock.expiresAt);
    return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
  }

  function isSameTableLockOwner(lock, user, session, payload = {}) {
    const safeLock = sanitizeTableWorkLock(lock);
    if (!safeLock || !user) return false;
    const userId = String(user.id ?? "").trim();
    const sessionId = String(session?.id ?? payload.sessionId ?? "").trim();
    const deviceUuid = String(session?.deviceUuid ?? payload.deviceUuid ?? "").trim();
    if (safeLock.userId !== userId) return false;
    if (safeLock.sessionId && sessionId && safeLock.sessionId === sessionId) return true;
    if (safeLock.deviceUuid && deviceUuid && safeLock.deviceUuid === deviceUuid) return true;
    return !safeLock.sessionId && !safeLock.deviceUuid;
  }

  function canOverrideTableWorkLock(user) {
    return (
      isAdminUser(user) ||
      hasPermission(user, "approve_room_change") ||
      hasPermission(user, "manage_tables") ||
      hasPermission(user, "manage_settings")
    );
  }

  function buildTableWorkLock({ tableId, user, session, payload = {}, purpose = "table_mutation" }) {
    const now = nowIso();
    return sanitizeTableWorkLock({
      tableId,
      userId: String(user?.id ?? "").trim(),
      username: String(user?.username ?? user?.fullName ?? "").trim(),
      deviceUuid: String(session?.deviceUuid ?? payload.deviceUuid ?? "").trim(),
      sessionId: String(session?.id ?? payload.sessionId ?? "").trim(),
      purpose,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(nowMs() + tableLockTtlMs).toISOString(),
    });
  }

  function shouldReuseRecentTableWorkLock(previousLock, purpose, nowMs = Date.now()) {
    if (!previousLock || heartbeatWriteMinIntervalMs <= 0) return false;
    const normalizedPurpose = String(purpose ?? "table_mutation").trim() || "table_mutation";
    if (String(previousLock.purpose ?? "").trim() !== normalizedPurpose) return false;
    const heartbeatAtMs = new Date(String(previousLock.heartbeatAt ?? previousLock.acquiredAt ?? "")).getTime();
    if (!Number.isFinite(heartbeatAtMs)) return false;
    const ageMs = nowMs - heartbeatAtMs;
    return ageMs >= 0 && ageMs < heartbeatWriteMinIntervalMs;
  }

  return {
    buildTableWorkLock,
    canOverrideTableWorkLock,
    isSameTableLockOwner,
    isTableWorkLockExpired,
    sanitizeTableWorkLock,
    shouldReuseRecentTableWorkLock,
  };
}
