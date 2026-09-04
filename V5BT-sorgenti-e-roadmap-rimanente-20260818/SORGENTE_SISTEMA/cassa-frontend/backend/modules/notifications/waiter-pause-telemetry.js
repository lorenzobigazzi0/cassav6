const OPERATIONS = new Set(["status", "start", "stop"]);

function normalizeOperation(value) {
  const operation = String(value ?? "").trim().toLowerCase();
  return OPERATIONS.has(operation) ? operation : "unknown";
}

function normalizeOutcome(value) {
  const outcome = String(value ?? "").trim().toLowerCase();
  return outcome.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function durationMs(value) {
  return Math.max(0, Number(value) || 0);
}

export function createWaiterPauseTelemetry({
  runtimeMetrics,
  now = () => Date.now(),
  getRequestContext = () => null,
} = {}) {
  return {
    start(operationValue) {
      const operation = normalizeOperation(operationValue);
      const startedAt = now();
      let finished = false;

      function record(label, value) {
        runtimeMetrics?.recordOperation?.(
          "waiterPauseWorkflow",
          `${operation}.${label}`,
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
