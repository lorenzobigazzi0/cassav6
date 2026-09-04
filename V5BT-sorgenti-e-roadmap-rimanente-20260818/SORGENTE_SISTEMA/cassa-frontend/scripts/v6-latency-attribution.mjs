import { mergeHistogramSnapshots } from "./loadtest-runtime-metrics.mjs";

export const V6_LATENCY_ATTRIBUTION_SCHEMA_VERSION = 1;

const PROXY_OWNER_ROUTE = "POST /api/internal/print-spool/auto-print";
const STATION_STATE_ROUTE = "POST /api/integration/stations/state";

const ALLOWED_LABELS = Object.freeze({
  proxyOwnerOperations: new Set([
    "queue:printSpoolAutoPrint.remoteOwner",
    "queue:printSpoolAutoPrint.remoteOwnerError",
    "queue:printSpoolAutoPrintOwner.batch",
    "queue:printSpoolAutoPrintOwner.wait",
  ]),
  proxyOwnerPrintLane: new Set([
    "owner auto-print",
    "owner auto-print batch",
  ]),
  appStateMysql: new Set([
    "appStateMysql:pool.create",
    "appStateMysql:connection.acquire",
    "appStateMysql:connection.acquire.error",
    "appStateMysql:connection.hold",
    "appStateMysql:query.select",
    "appStateMysql:query.select.error",
    "appStateMysql:query.insert",
    "appStateMysql:query.insert.error",
    "appStateMysql:query.update",
    "appStateMysql:query.update.error",
    "appStateMysql:query.delete",
    "appStateMysql:query.delete.error",
    "appStateMysql:query.create",
    "appStateMysql:query.create.error",
    "appStateMysql:query.other",
    "appStateMysql:query.other.error",
  ]),
  printSpool: new Set([
    "printSpool:accept",
    "printSpool:acceptBatch",
    "printSpool:claim",
    "printSpool:disabledFastAppend",
    "printSpoolOwner:normalizePlans",
    "printSpoolOwner:resolveDb",
    "printSpoolOwner:resolveSettings",
    "printSpoolOwner:enqueueBatch",
    "printSpoolOwner:error",
    "printSpoolOwner:total",
  ]),
  stationState: new Set([
    "stationStateWorkflow:error",
    "stationStateWorkflow:heartbeatNoop",
    "stationStateWorkflow:mysqlWrite",
    "stationStateWorkflow:writeTotal",
  ]),
});

function own(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function runtimeSnapshots(runtimeMetrics) {
  const root = runtimeMetrics && typeof runtimeMetrics === "object"
    ? [runtimeMetrics]
    : [];
  const workers = (Array.isArray(runtimeMetrics?.workers) ? runtimeMetrics.workers : [])
    .map((entry) => entry?.runtimeMetrics)
    .filter((entry) => entry && typeof entry === "object");
  return [...root, ...workers];
}

function validHistogram(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const { count, sum } = snapshot;
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isFinite(sum) || sum < 0) {
    return false;
  }
  if (count === 0) return true;
  return Number.isFinite(snapshot.min) && Number.isFinite(snapshot.max);
}

function collectHistogram(snapshots, mapReader, label) {
  const observed = snapshots
    .map((snapshot) => mapReader(snapshot))
    .filter((map) => map && typeof map === "object" && own(map, label))
    .map((map) => map[label]);
  const present = observed.length > 0;
  const valid = present && observed.every(validHistogram);
  const merged = valid ? mergeHistogramSnapshots(observed) : null;
  return {
    present,
    valid,
    observed: valid && merged.count > 0,
    count: merged?.count ?? 0,
    avgMs: merged?.avg ?? null,
    p50Ms: merged?.p50 ?? null,
    p95Ms: merged?.p95 ?? null,
    p99Ms: merged?.p99 ?? null,
    maxMs: merged?.max ?? null,
  };
}

function operationMetric(snapshots, label) {
  return collectHistogram(
    snapshots,
    (snapshot) => snapshot?.operations?.runMsByLabel,
    label,
  );
}

function requestMetric(snapshots, label) {
  return collectHistogram(
    snapshots,
    (snapshot) => snapshot?.requests?.runMsByRoute,
    label,
  );
}

function queueMetric(snapshots, queue, collection, label) {
  return collectHistogram(
    snapshots,
    (snapshot) => snapshot?.queues?.[queue]?.[collection],
    label,
  );
}

function collectInteger(snapshots, collection, name) {
  const values = snapshots
    .map((snapshot) => snapshot?.[collection])
    .filter((metrics) => metrics && typeof metrics === "object" && own(metrics, name))
    .map((metrics) => metrics[name]);
  const present = values.length > 0;
  const valid = present && values.every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  return {
    present,
    valid,
    value: valid ? values.reduce((sum, value) => sum + value, 0) : null,
  };
}

function unexpectedLabelCount(snapshots, mapReader, belongsToFamily, allowed) {
  const labels = new Set();
  for (const snapshot of snapshots) {
    const map = mapReader(snapshot);
    if (!map || typeof map !== "object") continue;
    for (const label of Object.keys(map)) {
      if (belongsToFamily(label) && !allowed.has(label)) labels.add(label);
    }
  }
  return labels.size;
}

function comparison(name, left, right) {
  return {
    name,
    left,
    right,
    ok: Number.isSafeInteger(left) && Number.isSafeInteger(right) && left === right,
  };
}

function buildCategory({ metrics, integers = {}, labelFamilies = {}, comparisons = [] }) {
  const missingMetrics = Object.entries(metrics)
    .filter(([, metric]) =>
      metric.present !== true || (metric.valid === true && metric.observed !== true))
    .map(([name]) => name);
  const invalidMetrics = Object.entries(metrics)
    .filter(([, metric]) => metric.present === true && metric.valid !== true)
    .map(([name]) => name);
  const missingIntegers = Object.entries(integers)
    .filter(([, metric]) => metric.present !== true)
    .map(([name]) => name);
  const invalidIntegers = Object.entries(integers)
    .filter(([, metric]) => metric.present === true && metric.valid !== true)
    .map(([name]) => name);
  const unstableLabelFamilies = Object.entries(labelFamilies)
    .filter(([, count]) => count > 0)
    .map(([name]) => name);
  const cardinalityMismatches = comparisons
    .filter((entry) => entry.ok !== true)
    .map((entry) => entry.name);
  const complete =
    missingMetrics.length === 0 &&
    invalidMetrics.length === 0 &&
    missingIntegers.length === 0 &&
    invalidIntegers.length === 0 &&
    unstableLabelFamilies.length === 0 &&
    cardinalityMismatches.length === 0;

  return {
    status: complete ? "COMPLETE" : "INCOMPLETE",
    complete,
    metrics,
    integers,
    labelCardinality: Object.fromEntries(
      Object.entries(labelFamilies).map(([name, unexpectedLabels]) => [name, {
        unexpectedLabels,
        stable: unexpectedLabels === 0,
      }]),
    ),
    comparisons,
    missingMetrics,
    invalidMetrics,
    missingIntegers,
    invalidIntegers,
    unstableLabelFamilies,
    cardinalityMismatches,
  };
}

function buildCollectionAudit(runtimeMetrics) {
  const source = runtimeMetrics?.workerCollection;
  const workers = Array.isArray(runtimeMetrics?.workers) ? runtimeMetrics.workers : [];
  const expected = source?.expected;
  const collected = source?.collected;
  const failed = source?.failed;
  const valid =
    source && typeof source === "object" &&
    Number.isSafeInteger(expected) && expected >= 0 &&
    Number.isSafeInteger(collected) && collected >= 0 &&
    Number.isSafeInteger(failed) && failed >= 0;
  const comparisons = [
    comparison("expectedWorkersCollected", expected, collected),
    comparison("collectedWorkersExported", collected, workers.length),
    comparison("workerCollectionHasNoFailures", failed, 0),
  ];
  const complete =
    runtimeMetrics?.enabled === true &&
    source?.enabled === true &&
    valid &&
    comparisons.every((entry) => entry.ok);
  return {
    status: complete ? "COMPLETE" : "INCOMPLETE",
    complete,
    runtimeMetricsEnabled: runtimeMetrics?.enabled === true,
    workerCollectionEnabled: source?.enabled === true,
    valid,
    expected: valid ? expected : null,
    collected: valid ? collected : null,
    failed: valid ? failed : null,
    exportedWorkers: workers.length,
    comparisons,
  };
}

export function buildV6LatencyAttribution(runtimeMetrics) {
  const snapshots = runtimeSnapshots(runtimeMetrics);
  const collection = buildCollectionAudit(runtimeMetrics);
  const operationMap = (snapshot) => snapshot?.operations?.runMsByLabel;

  const proxyMetrics = {
    ownerRoute: requestMetric(snapshots, PROXY_OWNER_ROUTE),
    remoteRoundTrip: operationMetric(
      snapshots,
      "queue:printSpoolAutoPrint.remoteOwner",
    ),
    batchWait: operationMetric(snapshots, "queue:printSpoolAutoPrintOwner.wait"),
    batchRun: operationMetric(snapshots, "queue:printSpoolAutoPrintOwner.batch"),
    ownerLaneWait: queueMetric(
      snapshots,
      "printLane",
      "waitMsByLabel",
      "owner auto-print batch",
    ),
    ownerLaneRun: queueMetric(
      snapshots,
      "printLane",
      "runMsByLabel",
      "owner auto-print batch",
    ),
  };
  const proxyIntegers = {
    successfulRemoteRequests: collectInteger(
      snapshots,
      "counters",
      "printSpoolAutoPrintRemoteOwnerAccepted",
    ),
    successfulBatches: collectInteger(
      snapshots,
      "counters",
      "printSpoolAutoPrintOwnerBatches",
    ),
  };
  const proxyOwner = buildCategory({
    metrics: proxyMetrics,
    integers: proxyIntegers,
    labelFamilies: {
      ownerOperations: unexpectedLabelCount(
        snapshots,
        operationMap,
        (label) => label.startsWith("queue:printSpoolAutoPrint"),
        ALLOWED_LABELS.proxyOwnerOperations,
      ),
      printLane: unexpectedLabelCount(
        snapshots,
        (snapshot) => snapshot?.queues?.printLane?.runMsByLabel,
        (label) => label.startsWith("owner auto-print"),
        ALLOWED_LABELS.proxyOwnerPrintLane,
      ) + unexpectedLabelCount(
        snapshots,
        (snapshot) => snapshot?.queues?.printLane?.waitMsByLabel,
        (label) => label.startsWith("owner auto-print"),
        ALLOWED_LABELS.proxyOwnerPrintLane,
      ),
    },
    comparisons: [
      comparison("batchWaitMatchesRun", proxyMetrics.batchWait.count, proxyMetrics.batchRun.count),
      comparison(
        "ownerLaneWaitMatchesRun",
        proxyMetrics.ownerLaneWait.count,
        proxyMetrics.ownerLaneRun.count,
      ),
      comparison(
        "ownerRouteMatchesLaneRun",
        proxyMetrics.ownerRoute.count,
        proxyMetrics.ownerLaneRun.count,
      ),
      comparison(
        "remoteCounterMatchesLatency",
        proxyIntegers.successfulRemoteRequests.value,
        proxyMetrics.remoteRoundTrip.count,
      ),
      comparison(
        "batchCounterMatchesLatency",
        proxyIntegers.successfulBatches.value,
        proxyMetrics.batchRun.count,
      ),
    ],
  });

  const appStateMysqlMetrics = {
    connectionAcquire: operationMetric(snapshots, "appStateMysql:connection.acquire"),
    connectionHold: operationMetric(snapshots, "appStateMysql:connection.hold"),
    querySelect: operationMetric(snapshots, "appStateMysql:query.select"),
    queryUpdate: operationMetric(snapshots, "appStateMysql:query.update"),
  };
  const appStateMysqlIntegers = {
    activeConnections: collectInteger(snapshots, "gauges", "mysqlPoolActiveConnections"),
    pendingAcquires: collectInteger(snapshots, "gauges", "mysqlPoolPendingAcquires"),
  };
  const appStateMysql = buildCategory({
    metrics: appStateMysqlMetrics,
    integers: appStateMysqlIntegers,
    labelFamilies: {
      operations: unexpectedLabelCount(
        snapshots,
        operationMap,
        (label) => label.startsWith("appStateMysql:"),
        ALLOWED_LABELS.appStateMysql,
      ),
    },
    comparisons: [
      comparison(
        "acquiresMatchReleasedAndActive",
        appStateMysqlMetrics.connectionAcquire.count,
        appStateMysqlMetrics.connectionHold.count +
          Number(appStateMysqlIntegers.activeConnections.value),
      ),
      comparison(
        "pendingAcquiresDrained",
        appStateMysqlIntegers.pendingAcquires.value,
        0,
      ),
    ],
  });

  const printSpoolMetrics = {
    normalizePlans: operationMetric(snapshots, "printSpoolOwner:normalizePlans"),
    resolveDb: operationMetric(snapshots, "printSpoolOwner:resolveDb"),
    resolveSettings: operationMetric(snapshots, "printSpoolOwner:resolveSettings"),
    enqueueBatch: operationMetric(snapshots, "printSpoolOwner:enqueueBatch"),
    workflowTotal: operationMetric(snapshots, "printSpoolOwner:total"),
    acceptBatch: operationMetric(snapshots, "printSpool:acceptBatch"),
  };
  const printWorkflowCount = printSpoolMetrics.workflowTotal.count;
  const printSpool = buildCategory({
    metrics: printSpoolMetrics,
    labelFamilies: {
      operations: unexpectedLabelCount(
        snapshots,
        operationMap,
        (label) => label.startsWith("printSpool:") || label.startsWith("printSpoolOwner:"),
        ALLOWED_LABELS.printSpool,
      ),
    },
    comparisons: [
      comparison("normalizePlansMatchesTotal", printSpoolMetrics.normalizePlans.count, printWorkflowCount),
      comparison("resolveDbMatchesTotal", printSpoolMetrics.resolveDb.count, printWorkflowCount),
      comparison("resolveSettingsMatchesTotal", printSpoolMetrics.resolveSettings.count, printWorkflowCount),
      comparison("enqueueBatchMatchesTotal", printSpoolMetrics.enqueueBatch.count, printWorkflowCount),
    ],
  });

  const stationStateMetrics = {
    route: requestMetric(snapshots, STATION_STATE_ROUTE),
    laneWait: queueMetric(
      snapshots,
      "stationStateLane",
      "waitMsByLabel",
      STATION_STATE_ROUTE,
    ),
    laneRun: queueMetric(
      snapshots,
      "stationStateLane",
      "runMsByLabel",
      STATION_STATE_ROUTE,
    ),
    heartbeatNoop: operationMetric(snapshots, "stationStateWorkflow:heartbeatNoop"),
    mysqlWrite: operationMetric(snapshots, "stationStateWorkflow:mysqlWrite"),
    writeTotal: operationMetric(snapshots, "stationStateWorkflow:writeTotal"),
    domainWriteTotal: operationMetric(
      snapshots,
      "appStateDomainSplit:integration.stationStates.entries.total",
    ),
  };
  const stationStateIntegers = {
    persistenceSkipped: collectInteger(
      snapshots,
      "counters",
      "stationStateHeartbeatPersistenceSkipped",
    ),
    persistenceWrites: collectInteger(
      snapshots,
      "counters",
      "stationStateHeartbeatPersistenceWrites",
    ),
  };
  const stationState = buildCategory({
    metrics: stationStateMetrics,
    integers: stationStateIntegers,
    labelFamilies: {
      workflowOperations: unexpectedLabelCount(
        snapshots,
        operationMap,
        (label) => label.startsWith("stationStateWorkflow:"),
        ALLOWED_LABELS.stationState,
      ),
    },
    comparisons: [
      comparison("laneWaitMatchesRun", stationStateMetrics.laneWait.count, stationStateMetrics.laneRun.count),
      comparison(
        "noopCounterMatchesLatency",
        stationStateIntegers.persistenceSkipped.value,
        stationStateMetrics.heartbeatNoop.count,
      ),
      comparison(
        "writeCounterMatchesWorkflow",
        stationStateIntegers.persistenceWrites.value,
        stationStateMetrics.writeTotal.count,
      ),
      comparison("mysqlWriteMatchesTotal", stationStateMetrics.mysqlWrite.count, stationStateMetrics.writeTotal.count),
      comparison(
        "domainWriteMatchesWorkflow",
        stationStateMetrics.domainWriteTotal.count,
        stationStateMetrics.writeTotal.count,
      ),
      comparison(
        "routeCoverage",
        stationStateMetrics.route.count,
        stationStateMetrics.laneRun.count +
          Number(stationStateIntegers.persistenceSkipped.value) +
          Number(stationStateIntegers.persistenceWrites.value),
      ),
    ],
  });

  const categories = { proxyOwner, appStateMysql, printSpool, stationState };
  const incompleteCategories = Object.entries(categories)
    .filter(([, category]) => category.complete !== true)
    .map(([name]) => name);
  const complete = collection.complete && incompleteCategories.length === 0;
  return {
    schemaVersion: V6_LATENCY_ATTRIBUTION_SCHEMA_VERSION,
    kind: "v6-latency-attribution",
    status: complete ? "COMPLETE" : "INCOMPLETE",
    complete,
    collection,
    categories,
    incompleteCategories,
  };
}
