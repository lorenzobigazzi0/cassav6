import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  buildRuntimeMetricsDashboard,
  createRuntimeMetrics,
} from "../modules/runtime-metrics.js";
import { authHeaders, loginJson, startBackend } from "./helpers/test-server.mjs";

async function fetchRuntimeMetrics(baseUrl, session, deviceUuid = "metrics-admin-device") {
  const response = await fetch(`${baseUrl}/api/monitor/runtime-metrics`, {
    headers: authHeaders(session, deviceUuid),
  });
  const body = await response.json();
  return { response, body };
}

async function startRuntimeMetricsPeer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.close();
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

test("runtime metrics snapshot and reset are available behind admin auth", async (t) => {
  const deviceUuid = "metrics-admin-device";
  const { baseUrl } = await startBackend(t, {
    env: {
      RUNTIME_METRICS: "1",
      RUNTIME_METRICS_QUEUE_SAMPLE_LIMIT: "20",
    },
  });
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid,
    clientApp: "cassa-frontend",
  });

  let response = await fetch(`${baseUrl}/api/monitor/runtime-metrics`);
  assert.equal(response.status, 401);

  let result = await fetchRuntimeMetrics(baseUrl, admin, deviceUuid);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.runtimeMetrics.enabled, true);
  assert.equal(result.body.runtimeMetrics.process.role, "monolith");
  assert.ok(result.body.runtimeMetrics.process.pid > 0);
  assert.ok(result.body.runtimeMetrics.process.sampledAtMs > 0);
  assert.ok(result.body.runtimeMetrics.process.uptimeSec >= 0);
  assert.ok(result.body.runtimeMetrics.process.memory.rssBytes > 0);
  assert.ok(result.body.runtimeMetrics.process.memory.heapTotalBytes > 0);
  assert.ok(result.body.runtimeMetrics.process.cpu.totalMicros >= 0);
  assert.equal(result.body.runtimeMetrics.featureProfile.features.waiterPauseTelemetry.requested, true);
  assert.equal(result.body.runtimeMetrics.featureProfile.features.waiterPauseTelemetry.effective, true);
  assert.equal(result.body.runtimeMetrics.featureProfile.features.waiterPauseTelemetry.source, "env");
  assert.deepEqual(result.body.runtimeMetrics.workerCollection, {
    enabled: false,
    expected: 0,
    collected: 0,
    failed: 0,
  });
  assert.deepEqual(result.body.runtimeMetrics.workers, []);
  assert.ok(result.body.runtimeMetrics.counters.requests >= 1);
  assert.ok(result.body.runtimeMetrics.counters.readDb >= 1);
  assert.equal(result.body.runtimeMetrics.counters.reservationLaneEnqueued, 0);
  assert.equal(result.body.runtimeMetrics.counters.notificationLaneEnqueued, 0);
  assert.equal(result.body.runtimeMetrics.counters.eventOutboxPublished, 0);
  assert.equal(result.body.runtimeMetrics.counters.eventOutboxRetentionDeleted, 0);
  assert.equal(result.body.runtimeMetrics.counters.integrationOrdersFastCacheHits, 0);
  assert.equal(result.body.runtimeMetrics.counters.integrationOrdersFastCacheMisses, 0);
  assert.equal(result.body.runtimeMetrics.counters.orderTerminalDuplicateSyncNoops, 0);
  assert.equal(result.body.runtimeMetrics.counters.orderTerminalDuplicateSyncPreLaneNoops, 0);
  assert.equal(result.body.runtimeMetrics.counters.orderSyncTableStateChanged, 0);
  assert.equal(result.body.runtimeMetrics.counters.orderSyncTableStateNoops, 0);
  assert.equal(result.body.runtimeMetrics.counters.orderSyncQueueReconcileFastSkips, 0);
  assert.equal(result.body.runtimeMetrics.counters.orderCreateFinancialDeltaBeforeSnapshotHits, 0);
  assert.equal(result.body.runtimeMetrics.counters.orderCreateFinancialDeltaBeforeSnapshotFallbacks, 0);
  assert.equal(result.body.runtimeMetrics.counters.orderCancelFinancialDeltaBeforeSnapshotHits, 0);
  assert.equal(result.body.runtimeMetrics.counters.orderCancelFinancialDeltaBeforeSnapshotFallbacks, 0);
  assert.equal(result.body.runtimeMetrics.counters.printSpoolDisabledFastAppends, 0);
  assert.equal(result.body.runtimeMetrics.counters.printSpoolAutoPrintRemoteOwnerTimeouts, 0);
  assert.equal(result.body.runtimeMetrics.counters.printSpoolAutoPrintRemoteOwnerForwardedJobs, 0);
  assert.equal(result.body.runtimeMetrics.counters.printSpoolAutoPrintRemoteOwnerConfirmedJobs, 0);
  assert.equal(result.body.runtimeMetrics.counters.printSpoolAutoPrintRemoteOwnerAcceptedJobs, 0);
  assert.equal(result.body.runtimeMetrics.counters.printSpoolAutoPrintRemoteOwnerDuplicateJobs, 0);
  assert.equal(result.body.runtimeMetrics.counters.printSpoolAutoPrintRemoteOwnerResultMismatches, 0);
  assert.equal(result.body.runtimeMetrics.counters.authSessionFastWrites, 0);
  assert.equal(result.body.runtimeMetrics.counters.authSessionFastFallbacks, 0);
  assert.equal(result.body.runtimeMetrics.counters.stationStatePresenceFastWrites, 0);
  assert.equal(result.body.runtimeMetrics.counters.stationStatePresenceFastFallbacks, 0);
  assert.equal(result.body.runtimeMetrics.counters.stationStateHeartbeatPersistenceWrites, 0);
  assert.equal(result.body.runtimeMetrics.counters.stationStateHeartbeatPersistenceSkipped, 0);
  assert.equal(result.body.runtimeMetrics.counters.tableRoomMoveRequestAppStateFastWrites, 0);
  assert.equal(result.body.runtimeMetrics.counters.tableRoomMoveRequestAppStateFastFallbacks, 0);
  assert.equal(result.body.runtimeMetrics.counters.redisCacheInvalidationCoalesced, 0);
  assert.equal(result.body.runtimeMetrics.counters.ordersAsyncFlushEmptyAuditSkipped, 0);
  assert.equal(result.body.runtimeMetrics.counters.ordersAsyncFlushMysqlLockContentionDeferrals, 0);
  assert.equal(result.body.runtimeMetrics.counters.ordersAsyncFlushDetachedLastWriteAtWrites, 0);
  assert.equal(result.body.runtimeMetrics.counters.ordersAsyncFlushDetachedSequenceWrites, 0);
  assert.equal(result.body.runtimeMetrics.counters.ordersAsyncFlushRemoteOwnerForwarded, 0);
  assert.equal(result.body.runtimeMetrics.counters.ordersAsyncFlushRemoteOwnerAccepted, 0);
  assert.equal(result.body.runtimeMetrics.counters.ordersAsyncFlushRemoteOwnerFallbacks, 0);
  assert.equal(result.body.runtimeMetrics.counters.ordersAsyncFlushRemoteOwnerHandled, 0);
  assert.equal(result.body.runtimeMetrics.counters.ordersAsyncFlushRemoteOwnerDeferred, 0);
  assert.equal(result.body.runtimeMetrics.counters.ordersAsyncFlushRemoteOwnerSyncFallbacks, 0);
  assert.equal(result.body.runtimeMetrics.counters.idempotencyStoreClaims, 0);
  assert.equal(result.body.runtimeMetrics.counters.relationalReadPrimaryFallbacks, 0);
  assert.equal(result.body.runtimeMetrics.gauges.eventOutboxUnpublished, 0);
  assert.equal(result.body.runtimeMetrics.gauges.eventOutboxLagMs, 0);
  assert.equal(result.body.runtimeMetrics.gauges.eventOutboxPublishedRows, 0);
  assert.equal(result.body.runtimeMetrics.gauges.mysqlPoolActiveConnections, 0);
  assert.equal(result.body.runtimeMetrics.gauges.mysqlPoolPendingAcquires, 0);
  assert.equal(result.body.runtimeMetrics.dashboard.realtimeBackbone.outboxLagMs, 0);
  assert.equal(result.body.runtimeMetrics.dashboard.realtimeBackbone.streamClients, 0);
  assert.equal(result.body.runtimeMetrics.dashboard.realtimeBackbone.filteredClients, 0);
  assert.equal(result.body.runtimeMetrics.dashboard.realtimeBackbone.serializedFrames, 0);
  assert.equal(result.body.runtimeMetrics.dashboard.idempotency.hitRate, 0);
  assert.deepEqual(
    result.body.runtimeMetrics.queues.reservationLane.waitMsByLabel,
    {},
  );
  assert.deepEqual(
    result.body.runtimeMetrics.queues.reservationLane.runMsByLabel,
    {},
  );
  assert.deepEqual(
    result.body.runtimeMetrics.queues.notificationLane.waitMsByLabel,
    {},
  );
  assert.deepEqual(
    result.body.runtimeMetrics.queues.notificationLane.runMsByLabel,
    {},
  );
  assert.ok(result.body.runtimeMetrics.appState.readRunMs.count >= 1);

  response = await fetch(`${baseUrl}/api/monitor/runtime-metrics/reset`, {
    method: "POST",
    headers: authHeaders(admin, deviceUuid),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const resetBody = await response.json();
  assert.equal(resetBody.ok, true);
  assert.equal(resetBody.reset, true);
  assert.equal(resetBody.runtimeMetrics.workerCollection.enabled, false);
  assert.equal(resetBody.runtimeMetrics.counters.requests, 0);
  assert.equal(resetBody.runtimeMetrics.counters.reservationLaneEnqueued, 0);
  assert.equal(resetBody.runtimeMetrics.counters.notificationLaneEnqueued, 0);
  assert.equal(resetBody.runtimeMetrics.counters.eventOutboxPublished, 0);
  assert.equal(resetBody.runtimeMetrics.counters.integrationOrdersFastCacheHits, 0);
  assert.equal(resetBody.runtimeMetrics.counters.orderTerminalDuplicateSyncNoops, 0);
  assert.equal(resetBody.runtimeMetrics.counters.orderTerminalDuplicateSyncPreLaneNoops, 0);
  assert.equal(resetBody.runtimeMetrics.counters.orderSyncTableStateChanged, 0);
  assert.equal(resetBody.runtimeMetrics.counters.orderSyncTableStateNoops, 0);
  assert.equal(resetBody.runtimeMetrics.gauges.eventOutboxUnpublished, 0);
  assert.equal(resetBody.runtimeMetrics.gauges.mysqlPoolActiveConnections, 0);
  assert.equal(resetBody.runtimeMetrics.gauges.mysqlPoolPendingAcquires, 0);

  result = await fetchRuntimeMetrics(baseUrl, admin, deviceUuid);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.runtimeMetrics.counters.requests >= 1, true);
});

test("runtime metrics monitor aggrega i peer api-worker via service token", async (t) => {
  const peerRequests = [];
  const peerUrl = await startRuntimeMetricsPeer(t, (req, res) => {
    peerRequests.push({
      method: req.method,
      url: req.url,
      token: req.headers["x-service-token"],
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      runtimeMetrics: {
        enabled: true,
        generatedAtMs: 987654321,
        process: { role: "api-worker", pid: 4242 },
        counters: { requests: 12 },
        operations: {
          runMsByLabel: {
            "orderSyncInternal:financialSync": { count: 2, p95: 25 },
          },
        },
      },
    }));
  });
  const deviceUuid = "metrics-owner-device";
  const { baseUrl } = await startBackend(t, {
    env: {
      RUNTIME_METRICS: "1",
      BACKEND_PROCESS_ROLE: "api-owner",
      BACKEND_RUNTIME_METRICS_PEER_URLS: peerUrl,
      BACKEND_RUNTIME_METRICS_PEER_TIMEOUT_MS: "1000",
      INTEGRATION_SERVICE_TOKEN: "metrics-service-token",
    },
  });
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid,
    clientApp: "cassa-frontend",
  });

  const result = await fetchRuntimeMetrics(baseUrl, admin, deviceUuid);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.runtimeMetrics.process.role, "api-owner");
  assert.deepEqual(result.body.runtimeMetrics.workerCollection, {
    enabled: true,
    expected: 1,
    collected: 1,
    failed: 0,
  });
  assert.equal(result.body.runtimeMetrics.workers.length, 1);
  assert.equal(result.body.runtimeMetrics.workers[0].ok, true);
  assert.equal(result.body.runtimeMetrics.workers[0].role, "api-worker");
  assert.equal(result.body.runtimeMetrics.workers[0].runtimeMetrics.process.pid, 4242);
  assert.equal(peerRequests.length, 1);
  assert.equal(peerRequests[0].method, "GET");
  assert.equal(peerRequests[0].url, "/api/internal/monitor/runtime-metrics");
  assert.equal(peerRequests[0].token, "metrics-service-token");
});

test("runtime metrics campiona famiglie lane concorrenti cross-domain", () => {
  let nowMs = 1000;
  const metrics = createRuntimeMetrics({
    enabled: true,
    now: () => nowMs,
    queueSampleLimit: 4,
  });

  metrics.recordQueueDepth({
    orderLaneRunning: 1,
    reservationLaneRunning: 1,
    notificationLaneRunning: 0,
    fiscalRetryLaneDepth: 2,
    fiscalRetryLaneRunning: 1,
  });
  nowMs += 5;
  metrics.recordQueueDepth({
    orderLaneRunning: 1,
    roomLaneRunning: 1,
    notificationLaneRunning: 1,
  });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.queues.lastSample.crossDomainConcurrencyFamiliesActive, 3);
  assert.equal(snapshot.queues.recentSamples[0].fiscalRetryLaneDepth, 2);
  assert.equal(snapshot.gauges.fiscalRetryLaneDepth, 0);
  assert.equal(snapshot.gauges.crossDomainConcurrencyFamiliesActive, 3);
  assert.equal(snapshot.gauges.crossDomainConcurrencyFamiliesActiveMax, 3);
  assert.equal(snapshot.queues.dbMutation.waitMsByLabel["slow-route"], undefined);
  assert.deepEqual(
    snapshot.queues.recentSamples.map((sample) => sample.crossDomainConcurrencyFamiliesActive),
    [2, 3],
  );

  metrics.reset();
  assert.equal(metrics.snapshot().gauges.crossDomainConcurrencyFamiliesActiveMax, 0);
});

test("runtime metrics limita gli snapshot di coda senza perdere gli istogrammi", () => {
  let nowMs = 1000;
  const metrics = createRuntimeMetrics({
    enabled: true,
    now: () => nowMs,
    queueSampleLimit: 10,
  });

  for (let index = 0; index < 25; index += 1) {
    metrics.recordQueueDepth({ roomLaneDepth: index });
    metrics.recordQueueWait("roomLane", "POST /api/test", index);
    nowMs += 1;
  }

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.queues.recentSamples.length, 10);
  assert.equal(snapshot.queues.recentSamples[0].roomLaneDepth, 15);
  assert.equal(snapshot.queues.lastSample.roomLaneDepth, 24);
  assert.equal(
    snapshot.queues.roomLane.waitMsByLabel["POST /api/test"].count,
    25,
  );
  assert.equal(
    snapshot.queues.roomLane.waitMsByLabel["POST /api/test"].max,
    24,
  );
});

test("runtime metrics espone il coalescing del mirror stampa", () => {
  const metrics = createRuntimeMetrics({ enabled: true });
  metrics.incrementCounter("printSpoolLegacyMirrorEnqueued", 6);
  metrics.incrementCounter("printSpoolLegacyMirrorCoalesced", 4);
  metrics.incrementCounter("printSpoolLegacyMirrorBatches", 1);
  metrics.incrementCounter("printSpoolLegacyMirrorFlushed", 2);
  metrics.incrementCounter("printSpoolLegacyMirrorRemoteOwnerForwarded", 1);
  metrics.incrementCounter("printSpoolLegacyMirrorRemoteOwnerAccepted", 1);
  metrics.incrementCounter("printSpoolLegacyMirrorRemoteOwnerHandled", 2);
  metrics.incrementCounter("integrationLayoutBuildStarted", 1);
  metrics.incrementCounter("integrationLayoutBuildJoined", 9);
  metrics.incrementCounter("mysqlDomainNamedLockLocalQueued", 3);
  metrics.setGauge("printSpoolLegacyMirrorPendingDepth", 2);
  metrics.setGauge("printSpoolLegacyMirrorRunning", 1);

  let snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.printSpoolLegacyMirrorEnqueued, 6);
  assert.equal(snapshot.counters.printSpoolLegacyMirrorCoalesced, 4);
  assert.equal(snapshot.counters.printSpoolLegacyMirrorBatches, 1);
  assert.equal(snapshot.counters.printSpoolLegacyMirrorFlushed, 2);
  assert.equal(snapshot.counters.printSpoolLegacyMirrorRemoteOwnerForwarded, 1);
  assert.equal(snapshot.counters.printSpoolLegacyMirrorRemoteOwnerAccepted, 1);
  assert.equal(snapshot.counters.printSpoolLegacyMirrorRemoteOwnerHandled, 2);
  assert.equal(snapshot.counters.integrationLayoutBuildStarted, 1);
  assert.equal(snapshot.counters.integrationLayoutBuildJoined, 9);
  assert.equal(snapshot.counters.mysqlDomainNamedLockLocalQueued, 3);
  assert.equal(snapshot.gauges.printSpoolLegacyMirrorPendingDepth, 2);
  assert.equal(snapshot.gauges.printSpoolLegacyMirrorRunning, 1);

  metrics.reset();
  snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.printSpoolLegacyMirrorEnqueued, 0);
  assert.equal(snapshot.counters.mysqlDomainNamedLockLocalQueued, 0);
  assert.equal(snapshot.gauges.printSpoolLegacyMirrorPendingDepth, 0);
  assert.equal(snapshot.gauges.printSpoolLegacyMirrorRunning, 0);
});

test("runtime metrics conserva e azzera i turni del fair scheduler", () => {
  const metrics = createRuntimeMetrics({ enabled: true });
  const counters = [
    "domainLaneFairOrderTurns",
    "domainLaneFairPaymentTurns",
    "domainLaneFairRoomTurns",
    "domainLaneFairReservationTurns",
    "domainLaneFairNotificationTurns",
    "domainLaneFairWaiterPauseTurns",
    "domainLaneFairStationStateTurns",
    "domainLaneNormalTurns",
    "domainLaneAgedPromotions",
    "domainLaneAgedOrderPromotions",
    "domainLaneAgedPaymentPromotions",
    "domainLaneAgedRoomPromotions",
    "domainLaneAgedReservationPromotions",
    "domainLaneAgedNotificationPromotions",
    "domainLaneAgedWaiterPausePromotions",
    "domainLaneAgedStationStatePromotions",
  ];

  counters.forEach((counter, index) => {
    metrics.incrementCounter(counter, index + 1);
  });
  let snapshot = metrics.snapshot();
  counters.forEach((counter, index) => {
    assert.equal(snapshot.counters[counter], index + 1);
  });

  metrics.reset();
  snapshot = metrics.snapshot();
  counters.forEach((counter) => {
    assert.equal(snapshot.counters[counter], 0);
  });
});

test("runtime metrics espone le release MySQL convertite in tombstone", () => {
  const metrics = createRuntimeMetrics({ enabled: true });
  metrics.incrementCounter("tableLockMysqlTombstoneWrites", 7);
  assert.equal(metrics.snapshot().counters.tableLockMysqlTombstoneWrites, 7);
  metrics.reset();
  assert.equal(metrics.snapshot().counters.tableLockMysqlTombstoneWrites, 0);
});

test("runtime metrics conserva e azzera i contatori di persistenza heartbeat", () => {
  const metrics = createRuntimeMetrics({ enabled: true });
  metrics.incrementCounter("stationStateHeartbeatPersistenceWrites", 3);
  metrics.incrementCounter("stationStateHeartbeatPersistenceSkipped", 5);

  let snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.stationStateHeartbeatPersistenceWrites, 3);
  assert.equal(snapshot.counters.stationStateHeartbeatPersistenceSkipped, 5);

  metrics.reset();
  snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.stationStateHeartbeatPersistenceWrites, 0);
  assert.equal(snapshot.counters.stationStateHeartbeatPersistenceSkipped, 0);
});

test("runtime metrics conserva e azzera telemetria lastWriteAt station-state", () => {
  const metrics = createRuntimeMetrics({ enabled: true });
  const counters = [
    "stationStateLastWriteEnqueued",
    "stationStateLastWriteCoalesced",
    "stationStateLastWriteCoveredByInFlight",
    "stationStateLastWriteBatches",
    "stationStateLastWriteFlushed",
    "stationStateLastWriteRetries",
    "stationStateLastWriteMysqlLockContentionDeferrals",
    "stationStateLastWriteErrors",
    "stationStateLastWriteInvalidCandidates",
    "stationStateLastWriteFutureTimestampRejected",
    "stationStateLastWriteClockRegressions",
    "stationStateLastWriteRecoveryWrites",
    "stationStateLastWriteRecoveryNoops",
  ];
  const gauges = [
    "stationStateLastWritePendingDepth",
    "stationStateLastWriteRunning",
    "stationStateLastWriteOldestAgeMs",
  ];

  counters.forEach((counter, index) => {
    metrics.incrementCounter(counter, index + 1);
  });
  gauges.forEach((gauge, index) => {
    metrics.setGauge(gauge, index + 2);
  });

  let snapshot = metrics.snapshot();
  counters.forEach((counter, index) => {
    assert.equal(snapshot.counters[counter], index + 1);
  });
  gauges.forEach((gauge, index) => {
    assert.equal(snapshot.gauges[gauge], index + 2);
  });

  metrics.reset();
  snapshot = metrics.snapshot();
  counters.forEach((counter) => {
    assert.equal(snapshot.counters[counter], 0);
  });
  gauges.forEach((gauge) => {
    assert.equal(snapshot.gauges[gauge], 0);
  });
});

test("runtime metrics espone percentili stimati dai bucket per route e code", () => {
  const metrics = createRuntimeMetrics({ enabled: true });

  for (const durationMs of [4, 12, 40, 180, 620]) {
    metrics.recordRequest({
      route: "POST /api/auth/session/status",
      durationMs,
      readDbCount: 1,
      writeDbCount: 0,
    });
  }
  metrics.recordQueueWait("stationStateLane", "POST /api/integration/stations/state", 260);
  metrics.recordQueueWait("fiscalRetryLane", "pos_fiscal_receipt_tx_1", 120);
  metrics.recordQueueWait("waiterPauseLane", "POST /api/mobile/waiter-pause/start", 90);
  metrics.recordWriteDb({ label: "orders.create.appStateWrite", durationMs: 320, comparableBytes: 4096, persistedComparableBytes: 2048, persistedBytes: 1024 });
  metrics.recordOperation("orderWorkflow", "orders.create.relationalWrite", 42);

  const snapshot = metrics.snapshot();
  const routeMetric = snapshot.requests.runMsByRoute["POST /api/auth/session/status"];
  assert.equal(routeMetric.count, 5);
  assert.equal(routeMetric.p50, 50);
  assert.equal(routeMetric.p95, 1000);
  assert.equal(routeMetric.p99, 1000);
  assert.equal(
    snapshot.queues.stationStateLane.waitMsByLabel["POST /api/integration/stations/state"].p99,
    500,
  );
  assert.equal(snapshot.queues.waiterPauseLane.waitMsByLabel["POST /api/mobile/waiter-pause/start"].p95, 100);
  assert.equal(snapshot.queues.dbMutation.waitMsByLabel["POST /api/mobile/waiter-pause/start"], undefined);
  assert.equal(snapshot.queues.fiscalRetryLane.waitMsByLabel.pos_fiscal_receipt_tx_1.p95, 250);
  assert.equal(snapshot.appState.writeRunMsByLabel["orders.create.appStateWrite"].p95, 500);
  assert.equal(snapshot.operations.runMsByLabel["orderWorkflow:orders.create.relationalWrite"].count, 1);
});

test("runtime metrics conserva label diagnostiche P3 oltre il limite top operations", () => {
  const metrics = createRuntimeMetrics({ enabled: true });

  for (let index = 0; index < 60; index += 1) {
    metrics.recordOperation("noise", `label_${String(index).padStart(2, "0")}`, 2);
    metrics.recordOperation("noise", `label_${String(index).padStart(2, "0")}`, 3);
  }
  metrics.recordOperation(
    "appStateDomainSplit",
    "integration.orders.entries.errorStage.commit.transientDbError",
    0,
  );
  metrics.recordOperation(
    "appStateWriteRetry",
    "orders.appStateWrite.stage.beforeWrite.transientDbError",
    0,
  );
  metrics.recordOperation("orderSyncInternal", "financialSync", 9);
  metrics.recordOperation("readDbInternal", "refreshTableLocks", 11);
  metrics.recordOperation("orderRelationalWriteInternal", "sync.transaction.beginImmediate", 13);
  metrics.recordOperation("relationalWalCheckpoint", "passive", 17);
  metrics.recordOperation("orderWorkflow", "integration.layout.relationalOrdersRead", 19);
  metrics.recordOperation("orderCreateInternal", "idempotency", 23);
  metrics.recordOperation("orderCreateRead", "refreshStationStates", 21);
  metrics.recordOperation("orderCreateAuditPrelude", "queueReconcile", 29);
  metrics.recordOperation("tableSyncWrite", "total", 37);
  metrics.recordOperation("tableRoomMoveRequestWrite", "total", 41);
  metrics.recordOperation("posRoomChangeRequest", "laneWait.pending", 43);
  metrics.recordOperation("posRoomChangeApprove", "authorization.pinVerify", 47);
  metrics.recordOperation("posRoomChangeApprovePreLane", "pinVerify", 53);
  metrics.recordOperation("waiterPauseWorkflow", "start.state.appStateWrite", 59);
  metrics.recordOperation("paymentFreeSplitWorkflow", "relational.commit", 61);
  metrics.recordOperation("paymentWorkflowStep", "payments.freeSplit.audit", 67);
  metrics.recordOperation("mysqlNamedLock", "paymentDomain.background.localWait", 71);
  metrics.recordOperation("orderWorkflow", "orders.create.relationalWrite", 31);
  metrics.incrementCounter("tableSyncAppStateFastWrites", 3);
  metrics.incrementCounter("tableSyncAppStateFastFallbackRelatedDomain", 1);
  metrics.incrementCounter("tableRoomMoveRequestAppStateFastWrites", 2);
  metrics.incrementCounter("tableRoomMoveRequestAppStateFastFallbackCollectionPruned", 1);
  metrics.incrementCounter("paymentFreeSplitTransientMirrorDeferred", 2);
  metrics.incrementCounter("paymentFreeSplitPunctualMirrorWrites", 3);
  metrics.incrementCounter("paymentMirrorPosSettingsTablesSkipped", 4);
  metrics.incrementCounter("paymentMirrorStatelessClaims", 5);
  metrics.incrementCounter("paymentMirrorStatelessWrites", 5);
  metrics.incrementCounter("paymentMirrorStatelessFallbacks", 1);
  metrics.incrementCounter("paymentMirrorLegacyClaims", 1);
  metrics.incrementCounter("roomSessionPunctualWrites", 2);
  metrics.incrementCounter("reservationPunctualWrites", 3);
  metrics.incrementCounter("tableMovePunctualWrites", 4);
  metrics.incrementCounter("tableGroupsFastWrites", 5);
  metrics.incrementCounter("mysqlDomainNamedLockAcquired", 6);
  for (const label of [
    "orders.comp.appStateWrite",
    "orders.correct.appStateWrite",
    "orders.cancel.appStateWrite",
  ]) {
    metrics.recordOperation("orderWorkflow", label, 7);
  }

  const labels = metrics.snapshot().operations.runMsByLabel;
  assert.equal(Object.keys(labels).length, 63);
  assert.equal(
    labels[
      "appStateDomainSplit:integration.orders.entries.errorStage.commit.transientDbError"
    ].count,
    1,
  );
  assert.equal(
    labels[
      "appStateWriteRetry:orders.appStateWrite.stage.beforeWrite.transientDbError"
    ].count,
    1,
  );
  assert.equal(labels["orderWorkflow:orders.comp.appStateWrite"].count, 1);
  assert.equal(labels["orderWorkflow:orders.correct.appStateWrite"].count, 1);
  assert.equal(labels["orderWorkflow:orders.cancel.appStateWrite"].count, 1);
  assert.equal(labels["orderSyncInternal:financialSync"].count, 1);
  assert.equal(labels["readDbInternal:refreshTableLocks"].count, 1);
  assert.equal(labels["orderRelationalWriteInternal:sync.transaction.beginImmediate"].count, 1);
  assert.equal(labels["relationalWalCheckpoint:passive"].count, 1);
  assert.equal(labels["orderWorkflow:integration.layout.relationalOrdersRead"].count, 1);
  assert.equal(labels["orderCreateInternal:idempotency"].count, 1);
  assert.equal(labels["orderCreateRead:refreshStationStates"].count, 1);
  assert.equal(labels["orderCreateAuditPrelude:queueReconcile"].count, 1);
  assert.equal(labels["tableSyncWrite:total"].count, 1);
  assert.equal(labels["tableRoomMoveRequestWrite:total"].count, 1);
  assert.equal(labels["posRoomChangeRequest:laneWait.pending"].count, 1);
  assert.equal(labels["posRoomChangeApprove:authorization.pinVerify"].count, 1);
  assert.equal(labels["posRoomChangeApprovePreLane:pinVerify"].count, 1);
  assert.equal(labels["waiterPauseWorkflow:start.state.appStateWrite"].count, 1);
  assert.equal(labels["paymentFreeSplitWorkflow:relational.commit"].count, 1);
  assert.equal(labels["paymentWorkflowStep:payments.freeSplit.audit"].count, 1);
  assert.equal(labels["mysqlNamedLock:paymentDomain.background.localWait"].count, 1);
  assert.equal(labels["orderWorkflow:orders.create.relationalWrite"].count, 1);
  assert.equal(metrics.snapshot().counters.tableSyncAppStateFastWrites, 3);
  assert.equal(metrics.snapshot().counters.tableSyncAppStateFastFallbackRelatedDomain, 1);
  assert.equal(metrics.snapshot().counters.tableRoomMoveRequestAppStateFastWrites, 2);
  assert.equal(metrics.snapshot().counters.tableRoomMoveRequestAppStateFastFallbackCollectionPruned, 1);
  assert.equal(metrics.snapshot().counters.paymentFreeSplitTransientMirrorDeferred, 2);
  assert.equal(metrics.snapshot().counters.paymentFreeSplitPunctualMirrorWrites, 3);
  assert.equal(metrics.snapshot().counters.paymentMirrorPosSettingsTablesSkipped, 4);
  assert.equal(metrics.snapshot().counters.paymentMirrorStatelessClaims, 5);
  assert.equal(metrics.snapshot().counters.paymentMirrorStatelessWrites, 5);
  assert.equal(metrics.snapshot().counters.paymentMirrorStatelessFallbacks, 1);
  assert.equal(metrics.snapshot().counters.paymentMirrorLegacyClaims, 1);
  assert.equal(metrics.snapshot().counters.roomSessionPunctualWrites, 2);
  assert.equal(metrics.snapshot().counters.reservationPunctualWrites, 3);
  assert.equal(metrics.snapshot().counters.tableMovePunctualWrites, 4);
  assert.equal(metrics.snapshot().counters.tableGroupsFastWrites, 5);
  assert.equal(metrics.snapshot().counters.mysqlDomainNamedLockAcquired, 6);
});

test("runtime metrics conserva le label stabili V5BT oltre il limite top-40", () => {
  const metrics = createRuntimeMetrics({ enabled: true });
  const pinnedLabels = [
    ["queue", "printSpoolAutoPrintOwner.batch"],
    ["queue", "printSpoolAutoPrintOwner.wait"],
    ["queue", "stationStateLastWrite.batch"],
    ["queue", "stationStateLastWrite.wait"],
    ["appStateDomainSplit", "integration.lastWriteAt.monotonic.total"],
    ["queue", "printSpoolAutoPrint.remoteOwner"],
    ["queue", "printSpoolAutoPrint.remoteOwnerError"],
    ["printSpoolOwner", "normalizePlans"],
    ["stationStateWorkflow", "heartbeatPersist"],
    ["orderWorkflow", "orders.asyncFlush.queueWait"],
    ["orderWorkflowStep", "orders.asyncFlush.mysql.integrationBulk"],
    ["appStateDomainSplit", "integration.bulkEntries.total"],
    ["appStateDomainSplit", "integration.stationStates.entries.stateRead"],
  ];

  for (let index = 0; index < 60; index += 1) {
    const label = `label_${String(index).padStart(2, "0")}`;
    metrics.recordOperation("noise", label, 2);
    metrics.recordOperation("noise", label, 3);
  }
  for (const [kind, label] of pinnedLabels) {
    metrics.recordOperation(kind, label, 7);
  }

  const labels = metrics.snapshot().operations.runMsByLabel;
  assert.equal(Object.keys(labels).length, 40 + pinnedLabels.length);
  for (const [kind, label] of pinnedLabels) {
    assert.equal(labels[`${kind}:${label}`].count, 1);
  }
});

test("runtime metrics espone il writer atomico del fondo cassa", () => {
  const metrics = createRuntimeMetrics({ enabled: true });

  metrics.incrementCounter("counterCollectionAtomicWrites", 3);
  metrics.incrementCounter("counterCollectionAtomicFallbacks", 1);
  metrics.incrementCounter("counterCollectionAtomicErrors", 2);
  metrics.incrementCounter("mysqlAtomicSelectionWrites", 3);
  metrics.incrementCounter("mysqlAtomicSelectionFallbacks", 1);
  metrics.incrementCounter("mysqlAtomicSelectionErrors", 2);
  metrics.incrementCounter("mysqlAtomicSelectionRollbacks", 2);
  metrics.incrementCounter("mysqlAtomicSelectionRollbackErrors", 1);
  metrics.recordOperation("counterCollectionWriter", "atomic", 7);
  metrics.recordOperation("mysqlAtomicSelection", "commit", 5);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.counterCollectionAtomicWrites, 3);
  assert.equal(snapshot.counters.counterCollectionAtomicFallbacks, 1);
  assert.equal(snapshot.counters.counterCollectionAtomicErrors, 2);
  assert.equal(snapshot.counters.mysqlAtomicSelectionWrites, 3);
  assert.equal(snapshot.counters.mysqlAtomicSelectionFallbacks, 1);
  assert.equal(snapshot.counters.mysqlAtomicSelectionErrors, 2);
  assert.equal(snapshot.counters.mysqlAtomicSelectionRollbacks, 2);
  assert.equal(snapshot.counters.mysqlAtomicSelectionRollbackErrors, 1);
  assert.equal(
    snapshot.operations.runMsByLabel["counterCollectionWriter:atomic"].count,
    1,
  );
  assert.equal(
    snapshot.operations.runMsByLabel["mysqlAtomicSelection:commit"].count,
    1,
  );
});

test("runtime metrics distingue il mirror atomico free-split senza step lastWriteAt", () => {
  const metrics = createRuntimeMetrics({ enabled: true });

  metrics.incrementCounter("paymentFreeSplitAtomicMirrorWrites", 4);
  metrics.incrementCounter("paymentFreeSplitAtomicMirrorFallbacks", 1);
  metrics.incrementCounter("paymentFreeSplitAtomicMirrorErrors", 2);
  metrics.recordOperation(
    "paymentWorkflowStep",
    "payments.freeSplit.mysql.atomicMirror",
    11,
  );

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.paymentFreeSplitAtomicMirrorWrites, 4);
  assert.equal(snapshot.counters.paymentFreeSplitAtomicMirrorFallbacks, 1);
  assert.equal(snapshot.counters.paymentFreeSplitAtomicMirrorErrors, 2);
  assert.equal(
    snapshot.operations.runMsByLabel[
      "paymentWorkflowStep:payments.freeSplit.mysql.atomicMirror"
    ].count,
    1,
  );
  assert.equal(
    snapshot.operations.runMsByLabel[
      "paymentWorkflowStep:payments.freeSplit.mysql.lastWriteAt"
    ],
    undefined,
  );
});

test("runtime metrics dashboard M4 riassume outbox, idempotenza, fallback e p99", () => {
  const metrics = createRuntimeMetrics({ enabled: true });

  metrics.setGauge("eventOutboxLagMs", 6400);
  metrics.setGauge("eventOutboxUnpublished", 3);
  metrics.setGauge("eventOutboxFailedUnpublished", 1);
  metrics.setGauge("crossDomainConcurrencyFamiliesActiveMax", 2);
  metrics.setGauge("fiscalRetryLaneDepth", 4);
  metrics.incrementCounter("idempotencyStoreClaims", 10);
  metrics.incrementCounter("idempotencyStoreHits", 3);
  metrics.incrementCounter("idempotencyStoreConflicts", 1);
  metrics.incrementCounter("orderTerminalDuplicateSyncNoops", 2);
  metrics.incrementCounter("orderTerminalDuplicateSyncPreLaneNoops", 1);
  metrics.incrementCounter("relationalReadPrimaryAttempts", 8);
  metrics.incrementCounter("relationalReadPrimaryFallbacks", 2);
  metrics.incrementCounter("relationalWalCheckpointRuns", 6);
  metrics.incrementCounter("relationalWalCheckpointBusy", 1);
  metrics.incrementCounter("relationalWalCheckpointErrors", 0);
  metrics.incrementCounter("relationalWalCheckpointPages", 240);
  metrics.setGauge("relationalWalAutoCheckpointPages", 0);
  metrics.setGauge("relationalWalLogPages", 44);
  metrics.setGauge("relationalWalCheckpointedPages", 40);
  metrics.setGauge("relationalWalBacklogPages", 4);
  metrics.setGauge("relationalWalLastCheckpointAtMs", 123456);
  metrics.incrementCounter("integrationLayoutRelationalTablesApplied", 3);
  metrics.incrementCounter("integrationLayoutRelationalTablesFallback", 1);
  metrics.recordRequest({
    route: "POST /api/payments/table",
    durationMs: 1430,
    readDbCount: 2,
    writeDbCount: 1,
  });
  metrics.recordQueueWait("paymentLane", "POST /api/payments/table", 775);

  const dashboard = metrics.snapshot().dashboard;
  assert.equal(dashboard.realtimeBackbone.outboxLagMs, 6400);
  assert.equal(metrics.snapshot().counters.orderTerminalDuplicateSyncNoops, 2);
  assert.equal(metrics.snapshot().counters.orderTerminalDuplicateSyncPreLaneNoops, 1);
  assert.equal(metrics.snapshot().counters.integrationLayoutRelationalTablesApplied, 3);
  assert.equal(metrics.snapshot().counters.integrationLayoutRelationalTablesFallback, 1);
  assert.equal(dashboard.realtimeBackbone.outboxUnpublished, 3);
  assert.equal(dashboard.idempotency.hitRate, 30);
  assert.equal(dashboard.idempotency.conflicts, 1);
  assert.equal(dashboard.relational.fallbackRate, 25);
  assert.equal(dashboard.relational.walCheckpointRuns, 6);
  assert.equal(dashboard.relational.walCheckpointBusyRuns, 1);
  assert.equal(dashboard.relational.walCheckpointPages, 240);
  assert.equal(dashboard.relational.walAutoCheckpointPages, 0);
  assert.equal(dashboard.relational.walLogPages, 44);
  assert.equal(dashboard.relational.walCheckpointedPages, 40);
  assert.equal(dashboard.relational.walBacklogPages, 4);
  assert.equal(dashboard.relational.walLastCheckpointAtMs, 123456);
  assert.equal(dashboard.lanes.overlapDetected, true);
  assert.equal(dashboard.lanes.fiscalRetryDepth, 4);
  assert.equal(dashboard.routes.p99Top[0].label, "POST /api/payments/table");
  assert.equal(dashboard.routes.p99Top[0].p99, 2500);
  assert.equal(dashboard.lanes.queueWaitTop[0].lane, "paymentLane");

  assert.deepEqual(
    buildRuntimeMetricsDashboard({ counters: {}, gauges: {}, queues: {}, requests: {} }).routes.p99Top,
    [],
  );
});
