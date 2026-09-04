import assert from "node:assert/strict";
import test from "node:test";

import {
  V5BT_LATENCY_ATTRIBUTION_SCHEMA_VERSION,
  buildV5btLatencyAttribution,
} from "./v5bt-latency-attribution.mjs";

function histogram(count, durationMs = 10) {
  return {
    count,
    sum: count * durationMs,
    avg: durationMs,
    min: durationMs,
    max: durationMs,
    p50: durationMs,
    p95: durationMs,
    p99: durationMs,
    buckets: { 10: count },
    over: 0,
  };
}

function completeEvidence() {
  return {
    enabled: true,
    workerCollection: {
      enabled: true,
      expected: 1,
      collected: 1,
      failed: 0,
    },
    counters: {
      stationStateHeartbeatPersistenceSkipped: 6,
      stationStateHeartbeatPersistenceWrites: 2,
    },
    gauges: {
      mysqlPoolActiveConnections: 0,
      mysqlPoolPendingAcquires: 0,
    },
    requests: {
      runMsByRoute: {
        "POST /api/internal/print-spool/auto-print": histogram(3),
        "POST /api/integration/stations/state": histogram(10),
      },
    },
    queues: {
      printLane: {
        waitMsByLabel: { "owner auto-print batch": histogram(3) },
        runMsByLabel: { "owner auto-print batch": histogram(3) },
      },
      stationStateLane: {
        waitMsByLabel: { "POST /api/integration/stations/state": histogram(2) },
        runMsByLabel: { "POST /api/integration/stations/state": histogram(2) },
      },
    },
    operations: {
      runMsByLabel: {
        "printSpoolOwner:normalizePlans": histogram(3),
        "printSpoolOwner:resolveDb": histogram(3),
        "printSpoolOwner:resolveSettings": histogram(3),
        "printSpoolOwner:enqueueBatch": histogram(3),
        "printSpoolOwner:total": histogram(3),
        "printSpool:acceptBatch": histogram(3),
        "stationStateWorkflow:heartbeatNoop": histogram(6),
        "stationStateWorkflow:mysqlWrite": histogram(2),
        "stationStateWorkflow:writeTotal": histogram(2),
        "appStateDomainSplit:integration.stationStates.entries.total": histogram(2),
      },
    },
    workers: [{
      role: "api-worker",
      runtimeMetrics: {
        counters: {
          printSpoolAutoPrintRemoteOwnerAccepted: 3,
          printSpoolAutoPrintOwnerBatches: 3,
          stationStateHeartbeatPersistenceSkipped: 0,
          stationStateHeartbeatPersistenceWrites: 0,
        },
        gauges: {
          mysqlPoolActiveConnections: 0,
          mysqlPoolPendingAcquires: 0,
        },
        operations: {
          runMsByLabel: {
            "queue:printSpoolAutoPrint.remoteOwner": histogram(3),
            "queue:printSpoolAutoPrintOwner.batch": histogram(3),
            "queue:printSpoolAutoPrintOwner.wait": histogram(3),
            "appStateMysql:connection.acquire": histogram(4),
            "appStateMysql:connection.hold": histogram(4),
            "appStateMysql:query.select": histogram(5),
            "appStateMysql:query.update": histogram(2),
          },
        },
      },
    }],
  };
}

test("il builder produce attribution schema v1 completa e redatta", () => {
  const attribution = buildV5btLatencyAttribution(completeEvidence());

  assert.equal(attribution.schemaVersion, V5BT_LATENCY_ATTRIBUTION_SCHEMA_VERSION);
  assert.equal(attribution.schemaVersion, 1);
  assert.equal(attribution.kind, "v5bt-latency-attribution");
  assert.equal(attribution.status, "COMPLETE");
  assert.equal(attribution.complete, true);
  assert.deepEqual(attribution.incompleteCategories, []);
  assert.deepEqual(Object.keys(attribution.categories), [
    "proxyOwner",
    "appStateMysql",
    "printSpool",
    "stationState",
  ]);
  for (const category of Object.values(attribution.categories)) {
    assert.equal(category.status, "COMPLETE");
    assert.equal(category.complete, true);
  }
});

test("latenze alte restano dati e non introducono soglie arbitrarie", () => {
  const evidence = completeEvidence();
  const metric = evidence.workers[0].runtimeMetrics.operations.runMsByLabel[
    "queue:printSpoolAutoPrint.remoteOwner"
  ];
  metric.sum = 2_999_997;
  metric.avg = 999_999;
  metric.min = 999_999;
  metric.max = 999_999;
  metric.p50 = 999_999;
  metric.p95 = 999_999;
  metric.p99 = 999_999;
  metric.buckets = {};
  metric.over = 3;

  const attribution = buildV5btLatencyAttribution(evidence);
  assert.equal(attribution.status, "COMPLETE");
  assert.equal(
    attribution.categories.proxyOwner.metrics.remoteRoundTrip.maxMs,
    999_999,
  );
});

test("ogni famiglia diventa INCOMPLETE quando manca una metrica obbligatoria", () => {
  const cases = [
    ["proxyOwner", (evidence) => {
      delete evidence.workers[0].runtimeMetrics.operations.runMsByLabel[
        "queue:printSpoolAutoPrintOwner.wait"
      ];
    }, "batchWait"],
    ["appStateMysql", (evidence) => {
      delete evidence.workers[0].runtimeMetrics.operations.runMsByLabel[
        "appStateMysql:query.update"
      ];
    }, "queryUpdate"],
    ["printSpool", (evidence) => {
      delete evidence.operations.runMsByLabel["printSpool:acceptBatch"];
    }, "acceptBatch"],
    ["stationState", (evidence) => {
      delete evidence.operations.runMsByLabel[
        "appStateDomainSplit:integration.stationStates.entries.total"
      ];
    }, "domainWriteTotal"],
  ];

  for (const [categoryName, mutate, missingMetric] of cases) {
    const evidence = completeEvidence();
    mutate(evidence);
    const attribution = buildV5btLatencyAttribution(evidence);
    const category = attribution.categories[categoryName];
    assert.equal(attribution.status, "INCOMPLETE", categoryName);
    assert.equal(category.status, "INCOMPLETE", categoryName);
    assert.ok(category.missingMetrics.includes(missingMetric), categoryName);
  }
});

test("mismatch cardinali rendono incompleta la rispettiva famiglia", () => {
  const cases = [
    ["proxyOwner", (evidence) => {
      evidence.queues.printLane.runMsByLabel["owner auto-print batch"] = histogram(2);
    }, "ownerLaneWaitMatchesRun"],
    ["appStateMysql", (evidence) => {
      evidence.workers[0].runtimeMetrics.operations.runMsByLabel[
        "appStateMysql:connection.hold"
      ] = histogram(3);
    }, "acquiresMatchReleasedAndActive"],
    ["printSpool", (evidence) => {
      evidence.operations.runMsByLabel["printSpoolOwner:enqueueBatch"] = histogram(2);
    }, "enqueueBatchMatchesTotal"],
    ["stationState", (evidence) => {
      evidence.requests.runMsByRoute["POST /api/integration/stations/state"] = histogram(11);
    }, "routeCoverage"],
  ];

  for (const [categoryName, mutate, mismatch] of cases) {
    const evidence = completeEvidence();
    mutate(evidence);
    const attribution = buildV5btLatencyAttribution(evidence);
    const category = attribution.categories[categoryName];
    assert.equal(category.status, "INCOMPLETE", categoryName);
    assert.ok(category.cardinalityMismatches.includes(mismatch), categoryName);
  }
});

test("label dinamiche sono rifiutate senza esportarne il contenuto", () => {
  const evidence = completeEvidence();
  const privateLabel = "queue:printSpoolAutoPrintOwner.batch private-device-123";
  evidence.workers[0].runtimeMetrics.operations.runMsByLabel[privateLabel] = histogram(1);

  const attribution = buildV5btLatencyAttribution(evidence);
  assert.equal(attribution.status, "INCOMPLETE");
  assert.equal(attribution.categories.proxyOwner.status, "INCOMPLETE");
  assert.equal(
    attribution.categories.proxyOwner.labelCardinality.ownerOperations.unexpectedLabels,
    1,
  );
  assert.ok(
    attribution.categories.proxyOwner.unstableLabelFamilies.includes("ownerOperations"),
  );
  assert.equal(JSON.stringify(attribution).includes(privateLabel), false);
  assert.equal(JSON.stringify(attribution).includes("private-device-123"), false);
});

test("istogrammi e contatori malformati non vengono normalizzati in un PASS", () => {
  const invalidHistogram = completeEvidence();
  invalidHistogram.operations.runMsByLabel["printSpoolOwner:total"].count = "3";
  let attribution = buildV5btLatencyAttribution(invalidHistogram);
  assert.equal(attribution.categories.printSpool.status, "INCOMPLETE");
  assert.ok(attribution.categories.printSpool.invalidMetrics.includes("workflowTotal"));

  const invalidCounter = completeEvidence();
  invalidCounter.workers[0].runtimeMetrics.counters[
    "printSpoolAutoPrintRemoteOwnerAccepted"
  ] = -1;
  attribution = buildV5btLatencyAttribution(invalidCounter);
  assert.equal(attribution.categories.proxyOwner.status, "INCOMPLETE");
  assert.ok(
    attribution.categories.proxyOwner.invalidIntegers.includes(
      "successfulRemoteRequests",
    ),
  );
});

test("una raccolta worker parziale lascia l'attribution INCOMPLETE", () => {
  const evidence = completeEvidence();
  evidence.workerCollection.expected = 2;
  evidence.workerCollection.failed = 1;

  const attribution = buildV5btLatencyAttribution(evidence);
  assert.equal(attribution.status, "INCOMPLETE");
  assert.equal(attribution.collection.status, "INCOMPLETE");
  assert.equal(attribution.collection.complete, false);
  assert.equal(
    attribution.collection.comparisons.find(
      (entry) => entry.name === "expectedWorkersCollected",
    ).ok,
    false,
  );
  assert.deepEqual(attribution.incompleteCategories, []);
});
