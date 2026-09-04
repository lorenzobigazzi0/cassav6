const API_WORKER_COUNTERS = Object.freeze({
  enqueued: "printSpoolAutoPrintOwnerEnqueued",
  coalesced: "printSpoolAutoPrintOwnerCoalesced",
  batches: "printSpoolAutoPrintOwnerBatches",
  flushed: "printSpoolAutoPrintOwnerFlushed",
  retries: "printSpoolAutoPrintOwnerRetries",
  forwarded: "printSpoolAutoPrintRemoteOwnerForwarded",
  accepted: "printSpoolAutoPrintRemoteOwnerAccepted",
  errors: "printSpoolAutoPrintRemoteOwnerErrors",
  timeouts: "printSpoolAutoPrintRemoteOwnerTimeouts",
  forwardedPlans: "printSpoolAutoPrintRemoteOwnerForwardedPlans",
  forwardedJobs: "printSpoolAutoPrintRemoteOwnerForwardedJobs",
  confirmedPlans: "printSpoolAutoPrintRemoteOwnerConfirmedPlans",
  confirmedJobs: "printSpoolAutoPrintRemoteOwnerConfirmedJobs",
  acceptedJobs: "printSpoolAutoPrintRemoteOwnerAcceptedJobs",
  duplicateJobs: "printSpoolAutoPrintRemoteOwnerDuplicateJobs",
  resultMismatches: "printSpoolAutoPrintRemoteOwnerResultMismatches",
  invalidPayloads: "printSpoolAutoPrintRemoteOwnerInvalidPayloads",
  misconfigured: "printSpoolAutoPrintRemoteOwnerMisconfigured",
  localPrintLaneEnqueued: "printLaneEnqueued",
});

const API_WORKER_GAUGES = Object.freeze({
  pendingDepth: "printSpoolAutoPrintOwnerPendingDepth",
  running: "printSpoolAutoPrintOwnerRunning",
});

function nonNegativeMetric(collection, name) {
  const value = Number(collection?.[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function readApiWorkerMetrics(entry, index) {
  const runtimeMetrics = entry?.runtimeMetrics;
  const worker = { index: index + 1 };
  for (const [field, metricName] of Object.entries(API_WORKER_COUNTERS)) {
    worker[field] = nonNegativeMetric(runtimeMetrics?.counters, metricName);
  }
  for (const [field, metricName] of Object.entries(API_WORKER_GAUGES)) {
    worker[field] = nonNegativeMetric(runtimeMetrics?.gauges, metricName);
  }
  return worker;
}

function sumWorkers(workers) {
  const totals = {};
  for (const field of [
    ...Object.keys(API_WORKER_COUNTERS),
    ...Object.keys(API_WORKER_GAUGES),
  ]) {
    totals[field] = workers.reduce((sum, worker) => sum + worker[field], 0);
  }
  return totals;
}

function failedChecks(checks) {
  return Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
}

export function buildAutoPrintOwnerAudit(
  metrics,
  { applicable = true, expectedApiWorkers = 0 } = {},
) {
  const safeExpectedApiWorkers = Math.max(0, Math.trunc(Number(expectedApiWorkers) || 0));
  const apiWorkers = (Array.isArray(metrics?.workers) ? metrics.workers : [])
    .filter((entry) => entry?.role === "api-worker")
    .map(readApiWorkerMetrics);
  const totals = sumWorkers(apiWorkers);
  const owner = {
    handled: nonNegativeMetric(
      metrics?.counters,
      "printSpoolAutoPrintRemoteOwnerHandled",
    ),
    duplicates: nonNegativeMetric(
      metrics?.counters,
      "printSpoolAutoPrintOwnerDuplicates",
    ),
  };
  const recoveredRemoteTimeout = totals.errors > 0;
  const ownerObservedJobs = owner.handled + owner.duplicates;
  const checks = {
    expectedApiWorkers: apiWorkers.length === safeExpectedApiWorkers,
    workObserved: totals.enqueued > 0 && totals.confirmedJobs > 0,
    enqueueFlushMatch: totals.enqueued === totals.flushed,
    noCoalescedPlans: totals.coalesced === 0,
    successfulBatchMatch: totals.batches === totals.accepted,
    forwardAttemptsAccounted: totals.forwarded === totals.accepted + totals.errors,
    everyErrorRetried: totals.retries === totals.errors,
    remoteTimeoutsOnly: totals.timeouts === totals.errors,
    confirmedPlanCardinality: totals.confirmedPlans === totals.flushed,
    confirmedJobCardinality:
      totals.confirmedJobs === totals.acceptedJobs + totals.duplicateJobs,
    forwardedPlanCoverage: totals.forwardedPlans >= totals.confirmedPlans,
    forwardedJobCoverage: totals.forwardedJobs >= totals.confirmedJobs,
    exactlyOnceOwnerWrites: owner.handled === totals.confirmedJobs,
    dedupWithinForwardedAttempts: ownerObservedJobs <= totals.forwardedJobs,
    noUnexpectedDedup:
      recoveredRemoteTimeout || (owner.duplicates === 0 && totals.duplicateJobs === 0),
    noInvalidPayloads: totals.invalidPayloads === 0,
    noResultMismatches: totals.resultMismatches === 0,
    correctlyConfigured: totals.misconfigured === 0,
    noApiWorkerLocalWrites: totals.localPrintLaneEnqueued === 0,
    queuesDrained: totals.pendingDepth === 0 && totals.running === 0,
  };
  const failures = failedChecks(checks);
  return {
    schemaVersion: 2,
    applicable: applicable === true,
    ok: applicable !== true || failures.length === 0,
    evidenceMode: recoveredRemoteTimeout
      ? "RECOVERED_REMOTE_TIMEOUT"
      : "DIRECT_OWNER_ACK",
    expectedApiWorkers: safeExpectedApiWorkers,
    apiWorkers,
    totals,
    owner,
    checks,
    failures,
  };
}
