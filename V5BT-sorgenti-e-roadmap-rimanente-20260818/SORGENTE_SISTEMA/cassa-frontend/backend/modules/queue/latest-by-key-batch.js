function normalizeKey(value) {
  return String(value ?? "").trim();
}

export function createLatestByKeyBatchQueue({
  runBatch,
  runtimeMetrics = null,
  logger = console,
  metricPrefix = "latestByKey",
  intervalMs = 100,
  retryBaseMs = 250,
  retryMaxMs = 5_000,
  maxBatchSize = 250,
  nowMs = () => Date.now(),
} = {}) {
  if (typeof runBatch !== "function") {
    throw new Error("latest-by-key-batch richiede runBatch.");
  }
  const pending = new Map();
  const safeIntervalMs = Math.max(0, Math.trunc(Number(intervalMs) || 0));
  const safeRetryBaseMs = Math.max(1, Math.trunc(Number(retryBaseMs) || 250));
  const safeRetryMaxMs = Math.max(safeRetryBaseMs, Math.trunc(Number(retryMaxMs) || 5_000));
  const safeMaxBatchSize = Math.max(1, Math.trunc(Number(maxBatchSize) || 250));
  let timer = null;
  let running = false;
  let consecutiveFailures = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const counter = (suffix, amount = 1) => runtimeMetrics?.incrementCounter?.(`${metricPrefix}${suffix}`, amount);
  const updateGauges = () => {
    runtimeMetrics?.setGauge?.(`${metricPrefix}PendingDepth`, pending.size);
    runtimeMetrics?.setGauge?.(`${metricPrefix}Running`, running ? 1 : 0);
  };

  function schedule(delayMs = safeIntervalMs) {
    if (running || timer || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flushOnce();
    }, Math.max(0, Math.trunc(Number(delayMs) || 0)));
    timer.unref?.();
  }

  function takeBatch() {
    const batch = [];
    for (const [key, entry] of pending) {
      batch.push({ key, ...entry });
      pending.delete(key);
      if (batch.length >= safeMaxBatchSize) break;
    }
    updateGauges();
    return batch;
  }

  function mergeFailedBatch(batch) {
    for (const entry of batch) {
      if (!pending.has(entry.key)) {
        pending.set(entry.key, {
          value: entry.value,
          enqueuedAt: entry.enqueuedAt,
        });
      }
    }
    updateGauges();
  }

  async function flushOnce() {
    if (running || pending.size === 0) return;
    running = true;
    updateGauges();
    const batch = takeBatch();
    const startedAt = nowMs();
    let retryDelayMs = safeIntervalMs;
    try {
      await runBatch(batch);
      consecutiveFailures = 0;
      counter("Batches");
      counter("Flushed", batch.length);
      runtimeMetrics?.recordOperation?.("queue", `${metricPrefix}.batch`, Math.max(0, nowMs() - startedAt));
      const oldestAt = Math.min(...batch.map((entry) => entry.enqueuedAt));
      runtimeMetrics?.recordOperation?.("queue", `${metricPrefix}.wait`, Math.max(0, startedAt - oldestAt));
    } catch (error) {
      mergeFailedBatch(batch);
      consecutiveFailures += 1;
      counter("Retries");
      retryDelayMs = Math.min(
        safeRetryBaseMs * 2 ** Math.min(consecutiveFailures - 1, 10),
        safeRetryMaxMs,
      );
      logger?.warn?.(
        `[queue:${metricPrefix}] batch fallito, retry tra ${retryDelayMs}ms: ${error?.message ?? error}`,
      );
    } finally {
      running = false;
      updateGauges();
      if (pending.size > 0) schedule(retryDelayMs);
    }
  }

  function enqueue(key, value) {
    const safeKey = normalizeKey(key);
    if (!safeKey) return false;
    const existing = pending.get(safeKey);
    pending.set(safeKey, {
      value,
      enqueuedAt: existing?.enqueuedAt ?? nowMs(),
    });
    counter("Enqueued");
    if (existing) counter("Coalesced");
    updateGauges();
    schedule();
    return true;
  }

  async function drain({ timeoutMs = 5_000 } = {}) {
    const deadline = nowMs() + Math.max(0, Math.trunc(Number(timeoutMs) || 0));
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    while ((running || pending.size > 0) && nowMs() < deadline) {
      if (!running && pending.size > 0) await flushOnce();
      else await sleep(10);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
    if (pending.size > 0 && !running) schedule();
    return { drained: !running && pending.size === 0, remaining: pending.size };
  }

  return {
    drain,
    enqueue,
    pendingDepth: () => pending.size,
  };
}
