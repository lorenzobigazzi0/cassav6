function durationMs(value) {
  return Math.max(0, Number(value) || 0);
}

function normalizeOutcome(value, allowedOutcomes) {
  const outcome = String(value ?? "").trim().toLowerCase();
  return allowedOutcomes.has(outcome) ? outcome : "unknown";
}

export function createRoomChangeOperationTelemetry({
  metricKind,
  allowedOutcomes = [],
  runtimeMetrics,
  now = () => Date.now(),
  getRequestContext = () => null,
} = {}) {
  const safeMetricKind = String(metricKind ?? "roomChangeOperation").trim();
  const outcomes = new Set(
    (Array.isArray(allowedOutcomes) ? allowedOutcomes : [])
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter(Boolean),
  );

  function record(label, value) {
    runtimeMetrics?.recordOperation?.(safeMetricKind, label, durationMs(value));
  }

  return {
    start() {
      const startedAt = now();
      let finished = false;

      return {
        async measure(label, action) {
          const stepStartedAt = now();
          try {
            return await action();
          } finally {
            record(label, now() - stepStartedAt);
          }
        },

        measureSync(label, action) {
          const stepStartedAt = now();
          try {
            return action();
          } finally {
            record(label, now() - stepStartedAt);
          }
        },

        record,

        finish(outcomeValue) {
          if (finished) return;
          finished = true;
          const outcome = normalizeOutcome(outcomeValue, outcomes);
          const context = getRequestContext?.() ?? {};
          record(`laneWait.${outcome}`, context.laneWaitMs);
          record(`dbQueueWait.${outcome}`, context.queueWaitMs);
          record(`readDbTotal.${outcome}`, context.readDbMs);
          record(`writeDbTotal.${outcome}`, context.writeDbMs);
          record(`total.${outcome}`, now() - startedAt);
        },
      };
    },
  };
}
