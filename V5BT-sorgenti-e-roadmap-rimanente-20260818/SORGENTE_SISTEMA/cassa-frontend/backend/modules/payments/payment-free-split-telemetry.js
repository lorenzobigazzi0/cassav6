function normalizeOutcome(value) {
  return (
    String(value ?? "unknown")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "unknown"
  );
}

function durationMs(value) {
  return Math.max(0, Number(value) || 0);
}

export function createPaymentFreeSplitTelemetry({
  runtimeMetrics,
  now = () => Date.now(),
  getRequestContext = () => null,
} = {}) {
  return {
    start() {
      const startedAt = now();
      let finished = false;

      function record(label, value) {
        runtimeMetrics?.recordOperation?.(
          "paymentFreeSplitWorkflow",
          label,
          durationMs(value),
        );
      }

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
          const outcome = normalizeOutcome(outcomeValue);
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
