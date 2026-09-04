import { appendFile } from "node:fs/promises";

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return Math.round(sorted[index]);
}

export function summarizeP5LatencySamples(samples) {
  const values = (Array.isArray(samples) ? samples : [])
    .map((sample) => Number(sample?.durationMs))
    .filter(Number.isFinite);
  return {
    count: values.length,
    p50ms: percentile(values, 0.5),
    p95ms: percentile(values, 0.95),
    p98ms: percentile(values, 0.98),
    p99ms: percentile(values, 0.99),
    p999ms: percentile(values, 0.999),
    maxMs: values.reduce((maximum, value) => Math.max(maximum, value), 0),
  };
}

function checkpointSample(sample) {
  return {
    sequence: Number(sample?.sequence) || 0,
    at: Number(sample?.at) || null,
    durationMs: Number(sample?.durationMs) || 0,
    type: sample?.type ? String(sample.type) : undefined,
    status: sample?.status ?? undefined,
    device: sample?.device ? String(sample.device) : undefined,
    kind: sample?.kind ? String(sample.kind) : undefined,
    ordinal: Number(sample?.ordinal) || undefined,
    ok: typeof sample?.ok === "boolean" ? sample.ok : undefined,
    disruptive:
      typeof sample?.disruptive === "boolean" ? sample.disruptive : undefined,
  };
}

export function createP5LatencyCheckpointWriter({
  filePath,
  getHttpSamples,
  getActionSamples,
  intervalMs = 30_000,
  now = () => Date.now(),
  append = appendFile,
  onError = () => undefined,
}) {
  if (!filePath) throw new Error("P5 checkpoint: filePath obbligatorio.");
  if (typeof getHttpSamples !== "function" || typeof getActionSamples !== "function") {
    throw new Error("P5 checkpoint: provider campioni obbligatori.");
  }

  const safeIntervalMs = Math.max(1_000, Number(intervalMs) || 30_000);
  let httpCursor = 0;
  let actionCursor = 0;
  let timer = null;
  let closePromise = null;
  let queue = Promise.resolve();

  const appendCheckpoint = async (reason) => {
    const httpSamples = [...(getHttpSamples() || [])];
    const actionSamples = [...(getActionSamples() || [])];
    const newHttpSamples = httpSamples.slice(httpCursor).map(checkpointSample);
    const newActionSamples = actionSamples.slice(actionCursor).map(checkpointSample);
    if (
      newHttpSamples.length === 0 &&
      newActionSamples.length === 0 &&
      ["interval", "progress"].includes(reason)
    ) {
      return null;
    }

    const checkpoint = {
      schemaVersion: 1,
      kind: "p5-latency-checkpoint",
      reason,
      at: new Date(now()).toISOString(),
      totals: {
        httpSamples: httpSamples.length,
        actionSamples: actionSamples.length,
      },
      httpLatencyMs: summarizeP5LatencySamples(httpSamples),
      actionLatencyMs: summarizeP5LatencySamples(actionSamples),
      httpSamples: newHttpSamples,
      actionSamples: newActionSamples,
    };
    await append(filePath, `${JSON.stringify(checkpoint)}\n`, "utf8");
    httpCursor = httpSamples.length;
    actionCursor = actionSamples.length;
    return checkpoint;
  };

  const flush = (reason = "manual") => {
    const operation = queue.then(() => appendCheckpoint(reason));
    queue = operation.catch((error) => {
      onError(error);
    });
    return operation;
  };

  const start = () => {
    if (timer !== null) return;
    timer = setInterval(() => {
      void flush("interval").catch(() => undefined);
    }, safeIntervalMs);
    timer.unref?.();
  };

  const close = (reason = "close") => {
    if (closePromise) return closePromise;
    if (timer !== null) clearInterval(timer);
    timer = null;
    closePromise = flush(reason);
    return closePromise;
  };

  return {
    filePath,
    intervalMs: safeIntervalMs,
    start,
    flush,
    close,
  };
}
