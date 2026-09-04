function metricKey(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

export function recordRealtimeDeliverySample(aggregate, envelope, nowMs = Date.now()) {
  const eventType = metricKey(envelope?.type ?? envelope?.reason, "unknown");
  const reason = metricKey(
    envelope?.payload?.reason ?? envelope?.reason,
    eventType,
  );
  aggregate.eventTypeCounts ??= {};
  aggregate.eventReasonCounts ??= {};
  aggregate.deliveryLagMs ??= [];
  aggregate.deliveryLagMsByReason ??= {};
  increment(aggregate.eventTypeCounts, eventType);
  increment(aggregate.eventReasonCounts, reason);

  const createdMs = Date.parse(
    String(envelope?.createdAt ?? envelope?.payload?.createdAt ?? ""),
  );
  if (!Number.isFinite(createdMs)) return { eventType, reason, lagMs: null };

  const lagMs = Math.max(0, Number(nowMs) - createdMs);
  aggregate.deliveryLagMs.push(lagMs);
  aggregate.deliveryLagMsByReason[reason] ??= [];
  aggregate.deliveryLagMsByReason[reason].push(lagMs);
  return { eventType, reason, lagMs };
}
