function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export const LOADTEST_RUNTIME_QUEUE_SAMPLE_LIMIT_DEFAULT = 600;
export const LOADTEST_RUNTIME_QUEUE_SAMPLE_LIMIT_MAX = 5_000;

export function resolveLoadtestRuntimeQueueSampleLimit(value) {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return LOADTEST_RUNTIME_QUEUE_SAMPLE_LIMIT_DEFAULT;
  }
  return Math.max(
    10,
    Math.min(numeric, LOADTEST_RUNTIME_QUEUE_SAMPLE_LIMIT_MAX),
  );
}

function percentileBucket(snapshot, ratio) {
  if (!snapshot.count) return 0;
  const target = Math.ceil(snapshot.count * ratio);
  let seen = 0;
  for (const [bucket, count] of Object.entries(snapshot.buckets)) {
    seen += count;
    if (seen >= target) return Number(bucket);
  }
  return snapshot.max;
}

export function mergeHistogramSnapshots(snapshots = []) {
  const validSnapshots = snapshots.filter((snapshot) => snapshot && typeof snapshot === "object");
  const bucketNames = [...new Set(
    validSnapshots.flatMap((snapshot) => Object.keys(snapshot.buckets || {})),
  )].sort((left, right) => Number(left) - Number(right));
  const merged = {
    count: 0,
    sum: 0,
    min: null,
    max: null,
    buckets: Object.fromEntries(bucketNames.map((bucket) => [bucket, 0])),
    over: 0,
  };

  for (const snapshot of validSnapshots) {
    const count = Math.max(0, Math.trunc(finiteNumber(snapshot.count)));
    merged.count += count;
    merged.sum += finiteNumber(snapshot.sum);
    merged.over += Math.max(0, Math.trunc(finiteNumber(snapshot.over)));
    if (count > 0) {
      const min = finiteNumber(snapshot.min);
      const max = finiteNumber(snapshot.max);
      merged.min = merged.min === null ? min : Math.min(merged.min, min);
      merged.max = merged.max === null ? max : Math.max(merged.max, max);
    }
    for (const bucket of bucketNames) {
      merged.buckets[bucket] += Math.max(
        0,
        Math.trunc(finiteNumber(snapshot.buckets?.[bucket])),
      );
    }
  }

  const result = {
    count: merged.count,
    sum: Math.round(merged.sum),
    avg: merged.count > 0
      ? Math.round((merged.sum / merged.count) * 100) / 100
      : 0,
    min: merged.min ?? 0,
    max: merged.max ?? 0,
    p50: 0,
    p95: 0,
    p99: 0,
    buckets: merged.buckets,
    over: merged.over,
  };
  result.p50 = percentileBucket(result, 0.5);
  result.p95 = percentileBucket(result, 0.95);
  result.p99 = percentileBucket(result, 0.99);
  return result;
}

function matchingWorkerOperationMaps(runtimeMetrics, prefix) {
  return (runtimeMetrics?.workers || [])
    .map((worker) => worker?.runtimeMetrics?.operations?.runMsByLabel)
    .filter((operationMap) => operationMap && typeof operationMap === "object")
    .map((operationMap) => Object.fromEntries(
      Object.entries(operationMap).filter(([label]) => label.startsWith(prefix)),
    ))
    .filter((operationMap) => Object.keys(operationMap).length > 0);
}

export function collectWorkerOperationHistograms(runtimeMetrics, prefix = "") {
  // The root snapshot belongs to the owner process; it is not an aggregate of
  // API workers. Merge both sides because a workflow can span owner and worker.
  const sourceMaps = [
    runtimeMetrics?.operations?.runMsByLabel || {},
    ...matchingWorkerOperationMaps(runtimeMetrics, prefix),
  ];
  const labels = [...new Set(
    sourceMaps.flatMap((operationMap) => Object.keys(operationMap))
      .filter((label) => label.startsWith(prefix)),
  )].sort((left, right) => left.localeCompare(right));

  return Object.fromEntries(labels.map((label) => [
    label,
    mergeHistogramSnapshots(
      sourceMaps.map((operationMap) => operationMap[label]).filter(Boolean),
    ),
  ]));
}
