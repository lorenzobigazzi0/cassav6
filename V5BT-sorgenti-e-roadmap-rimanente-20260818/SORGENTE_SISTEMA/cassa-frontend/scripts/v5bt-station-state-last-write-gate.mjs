const COUNTER_METRICS = Object.freeze({
  enqueued: "stationStateLastWriteEnqueued",
  coalesced: "stationStateLastWriteCoalesced",
  covered: "stationStateLastWriteCoveredByInFlight",
  batches: "stationStateLastWriteBatches",
  flushed: "stationStateLastWriteFlushed",
  retries: "stationStateLastWriteRetries",
  contentionDeferrals: "stationStateLastWriteMysqlLockContentionDeferrals",
  errors: "stationStateLastWriteErrors",
  invalid: "stationStateLastWriteInvalidCandidates",
  future: "stationStateLastWriteFutureTimestampRejected",
  clockRegression: "stationStateLastWriteClockRegressions",
  recoveryWrites: "stationStateLastWriteRecoveryWrites",
  recoveryNoops: "stationStateLastWriteRecoveryNoops",
});

const GAUGE_METRICS = Object.freeze({
  pending: "stationStateLastWritePendingDepth",
  running: "stationStateLastWriteRunning",
  oldestAgeMs: "stationStateLastWriteOldestAgeMs",
});

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function metricSnapshots(metrics) {
  const snapshots = [];
  if (metrics && typeof metrics === "object") snapshots.push(metrics);
  for (const worker of Array.isArray(metrics?.workers) ? metrics.workers : []) {
    if (worker?.runtimeMetrics && typeof worker.runtimeMetrics === "object") {
      snapshots.push(worker.runtimeMetrics);
    }
  }
  return snapshots;
}

function hasMetricSnapshot(snapshot) {
  return (
    (snapshot?.counters && typeof snapshot.counters === "object") ||
    (snapshot?.gauges && typeof snapshot.gauges === "object")
  );
}

function sumMetrics(snapshots, collectionName, metricNames) {
  return Object.fromEntries(
    Object.entries(metricNames).map(([field, metricName]) => [
      field,
      snapshots.reduce(
        (total, snapshot) =>
          total + nonNegativeInteger(snapshot?.[collectionName]?.[metricName]),
        0,
      ),
    ]),
  );
}

function failedChecks(checks) {
  return Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
}

function disabledChecks(counts, gauges) {
  return {
    noEnqueued: counts.enqueued === 0,
    noCoalesced: counts.coalesced === 0,
    noCovered: counts.covered === 0,
    noBatches: counts.batches === 0,
    noFlushed: counts.flushed === 0,
    noRetries: counts.retries === 0,
    noContentionDeferrals: counts.contentionDeferrals === 0,
    noErrors: counts.errors === 0,
    noInvalidCandidates: counts.invalid === 0,
    noFutureTimestamps: counts.future === 0,
    noClockRegressions: counts.clockRegression === 0,
    noRecoveryWrites: counts.recoveryWrites === 0,
    noRecoveryNoops: counts.recoveryNoops === 0,
    noPending: gauges.pending === 0,
    notRunning: gauges.running === 0,
    noOldestAge: gauges.oldestAgeMs === 0,
  };
}

export function buildStationStateLastWriteAudit(
  metrics,
  { enabled = false, applicable = true, nowaitEnabled = enabled } = {},
) {
  const snapshots = metricSnapshots(metrics);
  const counts = sumMetrics(snapshots, "counters", COUNTER_METRICS);
  const gauges = sumMetrics(snapshots, "gauges", GAUGE_METRICS);
  const snapshotAvailable = metrics?.ok !== false && snapshots.some(hasMetricSnapshot);
  const checks = enabled
    ? {
        snapshotAvailable,
        workObserved: counts.enqueued > 0,
        coalescingObserved: counts.coalesced + counts.covered > 0,
        flushLockModeNowait: nowaitEnabled === true,
        batchesObserved: counts.batches > 0,
        enqueueFlushMatch: counts.enqueued === counts.flushed,
        batchCardinality: counts.batches <= counts.flushed,
        retryAccounting:
          counts.retries === counts.contentionDeferrals + counts.errors,
        noErrors: counts.errors === 0,
        noInvalidCandidates: counts.invalid === 0,
        noFutureTimestamps: counts.future === 0,
        noClockRegressions: counts.clockRegression === 0,
        noPending: gauges.pending === 0,
        notRunning: gauges.running === 0,
        noOldestAge: gauges.oldestAgeMs === 0,
      }
    : disabledChecks(counts, gauges);
  const failures = failedChecks(checks);
  const isApplicable = applicable === true;
  return {
    schemaVersion: 2,
    flushLockMode: enabled
      ? nowaitEnabled === true
        ? "NOWAIT"
        : "BLOCKING"
      : "DISABLED",
    status:
      !isApplicable
        ? "NOT_APPLICABLE"
        : failures.length === 0
          ? "PASS"
          : "FAIL",
    ok: !isApplicable || failures.length === 0,
    counts,
    gauges,
    checks,
    failures,
  };
}
