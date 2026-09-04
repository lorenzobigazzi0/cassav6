const METRIC_PREFIX =
  "appStateDomainSplit:integration.stationStates.entries.markerLockElision";

function histogramCount(metrics, suffix) {
  const value = Number(
    metrics?.operations?.runMsByLabel?.[`${METRIC_PREFIX}.${suffix}`]?.count,
  );
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function operationHistogram(metrics, label) {
  const value = metrics?.operations?.runMsByLabel?.[label];
  return value && typeof value === "object" ? value : null;
}

function transactionFailureCount(metrics) {
  const prefixes = [
    "appStateDomainSplit:integration.stationStates.entries.",
    "appStateDomainSplit:integration.bulkEntries.",
  ];
  return Object.entries(metrics?.operations?.runMsByLabel || {}).reduce(
    (total, [label, histogram]) => {
      if (!prefixes.some((prefix) => label.startsWith(prefix))) return total;
      if (
        !label.includes(".error.") &&
        !label.includes(".rollback.") &&
        !label.endsWith(".outcome.rolledBack")
      ) {
        return total;
      }
      const count = Number(histogram?.count);
      return total + (Number.isSafeInteger(count) && count > 0 ? count : 0);
    },
    0,
  );
}

function failedChecks(checks) {
  return Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
}

export function buildStationStateMarkerLockElisionAudit(
  metrics,
  { enabled = false, applicable = true } = {},
) {
  const counts = {
    probe: histogramCount(metrics, "probe"),
    applied: histogramCount(metrics, "applied"),
    canonicalFallback: histogramCount(metrics, "canonicalFallback"),
    transactionFailures: transactionFailureCount(metrics),
  };
  const stateReadHistogram = operationHistogram(
    metrics,
    "appStateDomainSplit:integration.stationStates.entries.stateRead",
  );
  const stateRead = {
    count: Math.max(0, Number(stateReadHistogram?.count) || 0),
    p95Ms: Math.max(0, Number(stateReadHistogram?.p95) || 0),
    maxMs: Math.max(0, Number(stateReadHistogram?.max) || 0),
  };
  const reference = { count: 76, p95Ms: 2_500, maxMs: 6_684 };
  const snapshotAvailable =
    metrics?.ok !== false &&
    metrics?.operations?.runMsByLabel &&
    typeof metrics.operations.runMsByLabel === "object";
  const checks = enabled
    ? {
        snapshotAvailable,
        probeObserved: counts.probe > 0,
        appliedObserved: counts.applied > 0,
        stateReadObserved: stateRead.count > 0,
        branchAccounting:
          counts.probe === counts.applied + counts.canonicalFallback,
        canonicalMarkerIntact: counts.canonicalFallback === 0,
        noTransactionFailures: counts.transactionFailures === 0,
      }
    : {
        snapshotAvailable,
        noDiagnosticProbe: counts.probe === 0,
        noDiagnosticApply: counts.applied === 0,
        noCanonicalFallback: counts.canonicalFallback === 0,
      };
  const failures = failedChecks(checks);
  return {
    schemaVersion: 1,
    applicable: applicable === true,
    configuredEnabled: enabled === true,
    status:
      applicable !== true
        ? "NOT_APPLICABLE"
        : failures.length === 0
          ? "PASS"
          : "FAIL",
    ok: applicable !== true || failures.length === 0,
    counts,
    stateRead,
    reference,
    comparison: {
      countDelta: stateRead.count - reference.count,
      p95DeltaMs: stateRead.p95Ms - reference.p95Ms,
      maxDeltaMs: stateRead.maxMs - reference.maxMs,
    },
    checks,
    failures,
  };
}
