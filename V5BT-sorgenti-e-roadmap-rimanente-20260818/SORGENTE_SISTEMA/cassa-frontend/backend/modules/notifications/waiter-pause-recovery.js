import { findWaiterPauseRecord } from "./waiter-pauses.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeTimestamp(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

export function buildWaiterPauseCorrelationId(kind, userId, transitionAtMs) {
  const safeKind = kind === "stop" ? "stop" : kind === "start" ? "start" : "";
  const safeUserId = normalizeText(userId);
  const safeTransitionAtMs = normalizeTimestamp(transitionAtMs);
  if (!safeKind || !safeUserId || safeTransitionAtMs <= 0) return null;
  return `waiter-pause:${safeKind}:${safeUserId}:${safeTransitionAtMs}`;
}

export function findWaiterPauseAuditEvent(auditEvents, correlationId, fallback = {}) {
  const safeCorrelationId = normalizeText(correlationId);
  if (!safeCorrelationId) return null;
  const events = Array.isArray(auditEvents) ? auditEvents : [];
  const correlated = events.find(
      (entry) => normalizeText(entry?.correlationId) === safeCorrelationId,
    ) ?? null;
  if (correlated) return correlated;

  const action = normalizeText(fallback.action);
  const userId = normalizeText(fallback.userId);
  const transitionAtMs = normalizeTimestamp(fallback.transitionAtMs);
  const secondaryAtMs = normalizeTimestamp(fallback.secondaryAtMs);
  if (!action || !userId || transitionAtMs <= 0) return null;
  return (
    events.find((entry) => {
      if (normalizeText(entry?.action) !== action) return false;
      if (normalizeText(entry?.entityId) !== userId) return false;
      const payload = entry?.payload && typeof entry.payload === "object"
        ? entry.payload
        : {};
      const primaryMatches = normalizeTimestamp(
        fallback.kind === "start" ? payload.startedAtMs : payload.stoppedAtMs,
      ) === transitionAtMs;
      if (primaryMatches) return true;
      if (secondaryAtMs <= 0) return false;
      return normalizeTimestamp(
        fallback.kind === "start" ? payload.endsAtMs : payload.reenableAtMs,
      ) === secondaryAtMs;
    }) ?? null
  );
}

export function buildWaiterPauseRecoveryPlan({
  integration,
  auditEvents,
  user,
  session,
  kind,
} = {}) {
  const userId = normalizeText(user?.id ?? session?.userId);
  const record = findWaiterPauseRecord(integration, { userId });
  if (!record || !userId) return null;

  const isStart = kind === "start";
  const isStop = kind === "stop";
  const transitionAtMs = isStart
    ? normalizeTimestamp(record.startedAtMs)
    : isStop
      ? normalizeTimestamp(record.stoppedAtMs)
      : 0;
  const stateMatches = isStart
    ? record.status === "paused" && transitionAtMs > 0
    : isStop
      ? record.status === "active" && transitionAtMs > 0
      : false;
  if (!stateMatches) return null;

  const correlationId = buildWaiterPauseCorrelationId(kind, userId, transitionAtMs);
  if (!correlationId) return null;
  const action = isStart ? "waiter.pause_started" : "waiter.pause_stopped";
  const existingAuditEvent = findWaiterPauseAuditEvent(auditEvents, correlationId, {
    action,
    userId,
    kind,
    transitionAtMs,
    secondaryAtMs: isStart ? record.endsAtMs : record.reenableAtMs,
  });
  return {
    kind,
    action,
    correlationId,
    transitionAtMs,
    record,
    existingAuditEvent,
    recoveryRequired: !existingAuditEvent,
  };
}
