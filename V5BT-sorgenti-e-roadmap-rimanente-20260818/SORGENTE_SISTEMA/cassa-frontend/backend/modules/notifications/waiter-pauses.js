export const DEFAULT_WAITER_PAUSE_DURATION_MINUTES = 15;
export const DEFAULT_WAITER_PAUSE_RENEWAL_MINUTES = 120;
export const WAITER_PAUSE_RESUME_GRACE_MS = 3000;

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

export function normalizeWaiterPauseSettings(user = {}) {
  const raw =
    user.waiterPauseSettings && typeof user.waiterPauseSettings === "object"
      ? user.waiterPauseSettings
      : user.pauseSettings && typeof user.pauseSettings === "object"
        ? user.pauseSettings
        : {};
  return {
    enabled: raw.enabled === true,
    durationMinutes: clampInteger(
      raw.durationMinutes ?? raw.pauseDurationMinutes,
      1,
      120,
      DEFAULT_WAITER_PAUSE_DURATION_MINUTES
    ),
    renewalMinutes: clampInteger(
      raw.renewalMinutes ?? raw.pauseRenewalMinutes,
      15,
      720,
      DEFAULT_WAITER_PAUSE_RENEWAL_MINUTES
    ),
  };
}

export function sanitizeWaiterPauseRecord(record = {}) {
  return {
    userId: normalizeText(record.userId),
    username: normalizeText(record.username),
    fullName: normalizeText(record.fullName),
    status: record.status === "paused" ? "paused" : "active",
    startedAtMs: Math.max(0, Math.trunc(Number(record.startedAtMs) || 0)),
    endsAtMs: Math.max(0, Math.trunc(Number(record.endsAtMs) || 0)),
    stoppedAtMs: Math.max(0, Math.trunc(Number(record.stoppedAtMs) || 0)),
    nextAvailableAtMs: Math.max(0, Math.trunc(Number(record.nextAvailableAtMs) || 0)),
    remainingAllowanceMs: Math.max(0, Math.trunc(Number(record.remainingAllowanceMs) || 0)),
    reenableAtMs: Math.max(0, Math.trunc(Number(record.reenableAtMs) || 0)),
    updatedAtMs: Math.max(0, Math.trunc(Number(record.updatedAtMs) || 0)),
    updatedByDeviceUuid: normalizeText(record.updatedByDeviceUuid),
  };
}

export function sanitizeWaiterDeferredCall(record = {}) {
  const payload =
    record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? { ...record.payload }
      : {};
  return {
    id: normalizeText(record.id),
    targetUserId: normalizeText(record.targetUserId),
    targetUsername: normalizeText(record.targetUsername),
    targetFullName: normalizeText(record.targetFullName),
    createdAtMs: Math.max(0, Math.trunc(Number(record.createdAtMs) || 0)),
    deliverAfterMs: Math.max(0, Math.trunc(Number(record.deliverAfterMs) || 0)),
    deliveredAtMs: Math.max(0, Math.trunc(Number(record.deliveredAtMs) || 0)),
    payload,
  };
}

export function normalizeWaiterPauseCollections(integration = {}) {
  if (!integration || typeof integration !== "object") return false;
  let changed = false;
  if (Array.isArray(integration.waiterPauses)) {
    const next = integration.waiterPauses
      .map(sanitizeWaiterPauseRecord)
      .filter((entry) => entry.userId || entry.username || entry.fullName)
      .slice(-300);
    if (JSON.stringify(next) !== JSON.stringify(integration.waiterPauses)) changed = true;
    integration.waiterPauses = next;
  } else {
    integration.waiterPauses = [];
    changed = true;
  }
  if (Array.isArray(integration.waiterDeferredCalls)) {
    const next = integration.waiterDeferredCalls
      .map(sanitizeWaiterDeferredCall)
      .filter((entry) => !entry.deliveredAtMs && (entry.targetUserId || entry.targetUsername || entry.targetFullName))
      .slice(-300);
    if (JSON.stringify(next) !== JSON.stringify(integration.waiterDeferredCalls)) changed = true;
    integration.waiterDeferredCalls = next;
  } else {
    integration.waiterDeferredCalls = [];
    changed = true;
  }
  return changed;
}

export function waiterPauseIdentity(user = {}, session = {}) {
  return {
    userId: normalizeText(user.id ?? session.userId),
    username: normalizeText(user.username ?? session.username),
    fullName: normalizeText(user.fullName ?? session.fullName),
  };
}

function pauseRecordMatches(record, identity) {
  if (!record || !identity) return false;
  if (identity.userId && normalizeText(record.userId) === identity.userId) return true;
  if (identity.username && normalizeText(record.username).toLowerCase() === identity.username.toLowerCase()) return true;
  if (identity.fullName && normalizeText(record.fullName).toLowerCase() === identity.fullName.toLowerCase()) return true;
  return false;
}

export function findWaiterPauseRecord(integration = {}, identity = {}) {
  normalizeWaiterPauseCollections(integration);
  return integration.waiterPauses.find((entry) => pauseRecordMatches(entry, identity)) ?? null;
}

export function resolveWaiterPauseState(integration = {}, user = {}, session = {}, options = {}) {
  const nowMs = Math.max(0, Math.trunc(Number(options.nowMs) || Date.now()));
  const settings = normalizeWaiterPauseSettings(user);
  const identity = waiterPauseIdentity(user, session);
  const record = findWaiterPauseRecord(integration, identity);
  const startedAtMs = record?.startedAtMs ?? 0;
  const endsAtMs = record?.endsAtMs ?? 0;
  const reenableAtMs = record?.reenableAtMs ?? 0;
  const durationMs = settings.durationMinutes * 60_000;
  const renewalMs = settings.renewalMinutes * 60_000;
  const expiredPaused = settings.enabled && record?.status === "paused" && endsAtMs > 0 && endsAtMs <= nowMs;
  const effectiveReenableAtMs = expiredPaused ? endsAtMs + WAITER_PAUSE_RESUME_GRACE_MS : reenableAtMs;
  const active = settings.enabled && record?.status === "paused" && !expiredPaused && endsAtMs > nowMs;
  const graceActive = settings.enabled && !active && effectiveReenableAtMs > nowMs;
  const cycleAnchor = startedAtMs || record?.stoppedAtMs || 0;
  const nextCycleAtMs = cycleAnchor > 0 ? cycleAnchor + renewalMs : 0;
  const cycleExpired = !cycleAnchor || nowMs >= nextCycleAtMs;
  const remainingAllowanceMs = active
    ? Math.max(0, endsAtMs - nowMs)
    : expiredPaused
      ? 0
    : cycleExpired
      ? durationMs
      : Math.max(0, record?.remainingAllowanceMs ?? 0);
  const available =
    settings.enabled &&
    !active &&
    !graceActive &&
    (cycleExpired || !record || remainingAllowanceMs > 0);
  return {
    enabled: settings.enabled,
    durationMinutes: settings.durationMinutes,
    renewalMinutes: settings.renewalMinutes,
    active,
    graceActive,
    status: active ? "paused" : graceActive ? "resuming" : "active",
    startedAtMs,
    endsAtMs,
    remainingMs: active || available || graceActive ? remainingAllowanceMs : 0,
    nextAvailableAtMs: active ? endsAtMs : available ? nowMs : Math.max(nextCycleAtMs, record?.nextAvailableAtMs ?? 0),
    available,
    reenableAtMs: effectiveReenableAtMs,
  };
}

export function startWaiterPause(integration = {}, user = {}, session = {}, options = {}) {
  normalizeWaiterPauseCollections(integration);
  const nowMs = Math.max(0, Math.trunc(Number(options.nowMs) || Date.now()));
  const settings = normalizeWaiterPauseSettings(user);
  const identity = waiterPauseIdentity(user, session);
  if (!settings.enabled || !identity.userId) {
    return { ok: false, reason: "not_enabled", state: resolveWaiterPauseState(integration, user, session, { nowMs }) };
  }
  refreshExpiredWaiterPause(integration, user, session, { nowMs });
  const currentState = resolveWaiterPauseState(integration, user, session, { nowMs });
  if (currentState.active) {
    return { ok: true, reason: "already_paused", state: currentState };
  }
  if (!currentState.available) {
    return { ok: false, reason: "not_available", state: currentState };
  }
  const pauseDurationMs = Math.max(1_000, Math.trunc(Number(currentState.remainingMs) || settings.durationMinutes * 60_000));
  const previousRecord = findWaiterPauseRecord(integration, identity);
  const existingNextAvailableAtMs = Math.max(0, Math.trunc(Number(previousRecord?.nextAvailableAtMs) || 0));
  const sameCycle = existingNextAvailableAtMs > nowMs && previousRecord?.startedAtMs > 0;
  const cycleStartedAtMs = sameCycle ? previousRecord.startedAtMs : nowMs;
  const nextAvailableAtMs = sameCycle ? existingNextAvailableAtMs : nowMs + settings.renewalMinutes * 60_000;
  const record = sanitizeWaiterPauseRecord({
    ...identity,
    status: "paused",
    startedAtMs: cycleStartedAtMs,
    endsAtMs: nowMs + pauseDurationMs,
    stoppedAtMs: 0,
    nextAvailableAtMs,
    remainingAllowanceMs: pauseDurationMs,
    reenableAtMs: 0,
    updatedAtMs: nowMs,
    updatedByDeviceUuid: normalizeText(session.deviceUuid),
  });
  const index = integration.waiterPauses.findIndex((entry) => pauseRecordMatches(entry, identity));
  if (index >= 0) integration.waiterPauses[index] = record;
  else integration.waiterPauses.push(record);
  return { ok: true, reason: "started", state: resolveWaiterPauseState(integration, user, session, { nowMs }) };
}

export function stopWaiterPause(integration = {}, user = {}, session = {}, options = {}) {
  normalizeWaiterPauseCollections(integration);
  const nowMs = Math.max(0, Math.trunc(Number(options.nowMs) || Date.now()));
  const identity = waiterPauseIdentity(user, session);
  const record = findWaiterPauseRecord(integration, identity);
  if (!record || record.status !== "paused" || !record.endsAtMs || record.endsAtMs <= nowMs) {
    return { ok: true, reason: "already_active", state: resolveWaiterPauseState(integration, user, session, { nowMs }) };
  }
  const remainingAllowanceMs =
    record.endsAtMs > nowMs
      ? Math.max(0, record.endsAtMs - nowMs)
      : Math.max(0, record.remainingAllowanceMs ?? 0);
  record.status = "active";
  record.stoppedAtMs = nowMs;
  record.endsAtMs = 0;
  record.remainingAllowanceMs = remainingAllowanceMs;
  record.reenableAtMs = nowMs + WAITER_PAUSE_RESUME_GRACE_MS;
  record.updatedAtMs = nowMs;
  record.updatedByDeviceUuid = normalizeText(session.deviceUuid);
  return { ok: true, reason: "stopped", state: resolveWaiterPauseState(integration, user, session, { nowMs }) };
}

export function refreshExpiredWaiterPause(integration = {}, user = {}, session = {}, options = {}) {
  normalizeWaiterPauseCollections(integration);
  const nowMs = Math.max(0, Math.trunc(Number(options.nowMs) || Date.now()));
  const identity = waiterPauseIdentity(user, session);
  const record = findWaiterPauseRecord(integration, identity);
  if (!record || record.status !== "paused") return false;
  if (!record.endsAtMs || record.endsAtMs > nowMs) return false;
  const endedAtMs = record.endsAtMs;
  record.status = "active";
  record.stoppedAtMs = endedAtMs;
  record.endsAtMs = 0;
  record.remainingAllowanceMs = 0;
  record.reenableAtMs = endedAtMs + WAITER_PAUSE_RESUME_GRACE_MS;
  record.updatedAtMs = nowMs;
  return true;
}
