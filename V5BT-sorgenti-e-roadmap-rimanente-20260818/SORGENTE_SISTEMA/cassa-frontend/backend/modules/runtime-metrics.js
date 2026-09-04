const DEFAULT_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const DEFAULT_BUCKETS_BYTES = [
  512,
  1024,
  4096,
  16_384,
  65_536,
  262_144,
  1_048_576,
  4_194_304,
  16_777_216,
];

function normalizeLabel(value, fallback = "unknown") {
  const label = String(value ?? "").replace(/\s+/g, " ").trim();
  return label || fallback;
}

function normalizeBuckets(values) {
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0))]
    .sort((left, right) => left - right);
}

function createHistogram(buckets) {
  const normalizedBuckets = normalizeBuckets(buckets);
  function percentileBucket(histogram, percentile) {
    if (!histogram.count) return 0;
    const target = Math.max(1, Math.ceil(histogram.count * percentile));
    let seen = 0;
    for (const bucket of normalizedBuckets) {
      seen += histogram.buckets[String(bucket)] ?? 0;
      if (seen >= target) return bucket;
    }
    return histogram.max ?? 0;
  }
  return {
    count: 0,
    sum: 0,
    min: null,
    max: null,
    buckets: Object.fromEntries(normalizedBuckets.map((bucket) => [String(bucket), 0])),
    over: 0,
    record(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) return;
      this.count += 1;
      this.sum += numeric;
      this.min = this.min === null ? numeric : Math.min(this.min, numeric);
      this.max = this.max === null ? numeric : Math.max(this.max, numeric);
      const bucket = normalizedBuckets.find((candidate) => numeric <= candidate);
      if (bucket === undefined) this.over += 1;
      else this.buckets[String(bucket)] += 1;
    },
    snapshot() {
      return {
        count: this.count,
        sum: Math.round(this.sum),
        avg: this.count > 0 ? Math.round((this.sum / this.count) * 100) / 100 : 0,
        min: this.min ?? 0,
        max: this.max ?? 0,
        p50: percentileBucket(this, 0.5),
        p95: percentileBucket(this, 0.95),
        p99: percentileBucket(this, 0.99),
        buckets: { ...this.buckets },
        over: this.over,
      };
    },
    reset() {
      this.count = 0;
      this.sum = 0;
      this.min = null;
      this.max = null;
      Object.keys(this.buckets).forEach((bucket) => {
        this.buckets[bucket] = 0;
      });
      this.over = 0;
    },
  };
}

function computeCrossDomainConcurrencyFamiliesActive(sample = {}) {
  return [
    sample.orderLaneRunning,
    sample.paymentLaneRunning,
    sample.roomLaneRunning,
    sample.reservationLaneRunning,
    sample.notificationLaneRunning,
    sample.printLaneRunning,
    sample.waiterPauseLaneRunning,
    sample.stationStateLaneRunning,
  ].filter((value) => Math.max(0, Math.trunc(Number(value) || 0)) > 0).length;
}

function ensureLabelMetric(map, label, buckets) {
  const key = normalizeLabel(label);
  let metric = map.get(key);
  if (!metric) {
    metric = createHistogram(buckets);
    map.set(key, metric);
  }
  return metric;
}

function isPinnedSnapshotLabel(label) {
  const value = String(label ?? "");
  return (
    /appStateDomainSplit:integration\.orders\.entries\.(error|errorStage|rollback|outcome)\b/.test(
      value,
    ) ||
    /^appStateMysql:/.test(value) ||
    /^printSpool:disabledFastAppend$/.test(value) ||
    /^queue:printSpoolAutoPrintOwner(?:[.:]|$)/.test(value) ||
    /^queue:printSpoolAutoPrint\.remoteOwner/.test(value) ||
    /^printSpoolOwner:/.test(value) ||
    /^stationStateWorkflow:/.test(value) ||
    /^queue:stationStateLastWrite(?:[.:]|$)/.test(value) ||
    /^appStateDomainSplit:integration\.lastWriteAt\.monotonic(?:\.|$)/.test(value) ||
    /^orderWorkflow(?:Step)?:orders\.asyncFlush(?:\.|$)/.test(value) ||
    /^appStateDomainSplit:integration\.(?:bulkEntries|stationStates\.entries)(?:\.|$)/.test(
      value,
    ) ||
    /^orderWorkflow:orders\.(comp|correct|cancel)\.appStateWrite$/.test(value) ||
    /^orderWorkflow:orders\.cancel\.financialDeltaBeforeSnapshot\./.test(value) ||
    /^orderWorkflow:integration\.layout\.relationalOrdersRead$/.test(value) ||
    /^orderWorkflow:orders\.sync\.relationalSnapshotRead$/.test(value) ||
    /^orderWorkflow:orders\.sync\.financialNoopFastPath$/.test(value) ||
    /^readDbInternal:/.test(value) ||
    /^apiWorkerFastPath:/.test(value) ||
    /^orderCreateInternal:/.test(value) ||
    /^orderCreateRead:/.test(value) ||
    /^tableSyncWrite:/.test(value) ||
    /^tableRoomMoveRequestWrite:/.test(value) ||
    /^posRoomChangeRequest:/.test(value) ||
    /^posRoomChangeApprove:/.test(value) ||
    /^posRoomChangeApprovePreLane:/.test(value) ||
    /^waiterPauseWorkflow:/.test(value) ||
    /^paymentFreeSplitWorkflow:/.test(value) ||
    /^paymentWorkflowStep:payments\.freeSplit\./.test(value) ||
    /^paymentMirrorWorker:/.test(value) ||
    /^mysqlNamedLock:/.test(value) ||
    /^counterCollectionWriter:/.test(value) ||
    /^mysqlAtomicSelection:/.test(value) ||
    /^orderCreateAuditPrelude:/.test(value) ||
    /^orderWorkflow:orders\.create\.relationalWrite$/.test(value) ||
    /^orderRelationalWriteInternal:/.test(value) ||
    /^relationalWalCheckpoint:/.test(value) ||
    /^postgresPoolWait:/.test(value) ||
    /^orderSyncInternal:/.test(value) ||
    /^orderCancelInternal:/.test(value) ||
    /^(appStateWriteHook|appStateWriteRetry):/.test(value)
  );
}

function roundPercent(part, total) {
  const numerator = Math.max(0, Number(part) || 0);
  const denominator = Math.max(0, Number(total) || 0);
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function topHistogramEntries(entries = {}, limit = 8) {
  return Object.entries(entries)
    .map(([label, metric]) => ({
      label,
      count: Math.max(0, Math.trunc(Number(metric?.count) || 0)),
      p50: Math.max(0, Math.trunc(Number(metric?.p50) || 0)),
      p95: Math.max(0, Math.trunc(Number(metric?.p95) || 0)),
      p99: Math.max(0, Math.trunc(Number(metric?.p99) || 0)),
      max: Math.max(0, Math.trunc(Number(metric?.max) || 0)),
    }))
    .filter((entry) => entry.count > 0)
    .sort(
      (left, right) =>
        right.p99 - left.p99 ||
        right.p95 - left.p95 ||
        right.max - left.max ||
        right.count - left.count ||
        left.label.localeCompare(right.label),
    )
    .slice(0, Math.max(1, Math.trunc(Number(limit) || 8)));
}

export function buildRuntimeMetricsDashboard(snapshot = {}) {
  const counters = snapshot?.counters ?? {};
  const gauges = snapshot?.gauges ?? {};
  const queues = snapshot?.queues ?? {};
  const requests = snapshot?.requests ?? {};
  const idempotencyAttempts = Math.max(
    0,
    Math.trunc(Number(counters.idempotencyStoreClaims) || 0),
  );
  const idempotencyHits = Math.max(
    0,
    Math.trunc(Number(counters.idempotencyStoreHits) || 0),
  );
  const commandInboxClaims = Math.max(
    0,
    Math.trunc(Number(counters.commandInboxClaims) || 0),
  );
  const commandInboxReplays = Math.max(
    0,
    Math.trunc(Number(counters.commandInboxReplays) || 0),
  );
  const relationalAttempts = Math.max(
    0,
    Math.trunc(Number(counters.relationalReadPrimaryAttempts) || 0),
  );
  const relationalFallbacks = Math.max(
    0,
    Math.trunc(Number(counters.relationalReadPrimaryFallbacks) || 0),
  );
  const queueWaitEntries = Object.entries(queues)
    .filter(([name, value]) => name !== "recentSamples" && name !== "lastSample" && value?.waitMsByLabel)
    .flatMap(([name, value]) =>
      topHistogramEntries(value.waitMsByLabel, 20).map((entry) => ({
        ...entry,
        lane: name,
      })),
    )
    .sort(
      (left, right) =>
        right.p99 - left.p99 ||
        right.p95 - left.p95 ||
        right.count - left.count ||
        `${left.lane}:${left.label}`.localeCompare(`${right.lane}:${right.label}`),
    )
    .slice(0, 10);

  return {
    enabled: snapshot?.enabled === true,
    generatedAtMs: Math.max(0, Math.trunc(Number(snapshot?.generatedAtMs) || 0)),
    realtimeBackbone: {
      outboxLagMs: Math.max(0, Math.trunc(Number(gauges.eventOutboxLagMs) || 0)),
      outboxUnpublished: Math.max(0, Math.trunc(Number(gauges.eventOutboxUnpublished) || 0)),
      outboxFailedUnpublished: Math.max(
        0,
        Math.trunc(Number(gauges.eventOutboxFailedUnpublished) || 0),
      ),
      outboxPublishedRows: Math.max(0, Math.trunc(Number(gauges.eventOutboxPublishedRows) || 0)),
      outboxPublishFailures: Math.max(
        0,
        Math.trunc(Number(counters.eventOutboxPublishFailed) || 0),
      ),
      pilotEventsEmitted: Math.max(0, Math.trunc(Number(counters.realtimePilotEventsEmitted) || 0)),
      pilotEventsFailed: Math.max(0, Math.trunc(Number(counters.realtimePilotEventsFailed) || 0)),
      replayRuns: Math.max(0, Math.trunc(Number(counters.realtimeReplayRuns) || 0)),
      replayEvents: Math.max(0, Math.trunc(Number(counters.realtimeReplayEvents) || 0)),
      replayRecoveries: Math.max(0, Math.trunc(Number(counters.realtimeReplayRecoveries) || 0)),
      replayFilteredEvents: Math.max(0, Math.trunc(Number(counters.realtimeReplayFilteredEvents) || 0)),
      streamClients: Math.max(0, Math.trunc(Number(gauges.realtimeStreamClients) || 0)),
      businessEvents: Math.max(0, Math.trunc(Number(counters.realtimeBusinessEvents) || 0)),
      eligibleRecipients: Math.max(0, Math.trunc(Number(counters.realtimeEligibleRecipients) || 0)),
      deliveredRecipients: Math.max(0, Math.trunc(Number(counters.realtimeDeliveredRecipients) || 0)),
      filteredClients: Math.max(0, Math.trunc(Number(counters.realtimeFilteredClients) || 0)),
      serializedFrames: Math.max(0, Math.trunc(Number(counters.realtimeSseFramesSerialized) || 0)),
      deliveredBytes: Math.max(0, Math.trunc(Number(counters.realtimeDeliveryBytes) || 0)),
    },
    mqttBridge: {
      connected: Math.max(0, Math.trunc(Number(gauges.mqttConnected) || 0)),
      lastPublishAtMs: Math.max(0, Math.trunc(Number(gauges.mqttLastPublishAtMs) || 0)),
      connects: Math.max(0, Math.trunc(Number(counters.mqttConnects) || 0)),
      publishQueued: Math.max(0, Math.trunc(Number(counters.mqttPublishQueued) || 0)),
      publishConfirmed: Math.max(0, Math.trunc(Number(counters.mqttPublishConfirmed) || 0)),
      publishFailed: Math.max(0, Math.trunc(Number(counters.mqttPublishFailed) || 0)),
      publishSkipped: Math.max(0, Math.trunc(Number(counters.mqttPublishSkipped) || 0)),
      errors: Math.max(0, Math.trunc(Number(counters.mqttErrors) || 0)),
    },
    printSpool: {
      claimed: Math.max(0, Math.trunc(Number(counters.printSpoolClaimed) || 0)),
      confirmed: Math.max(0, Math.trunc(Number(counters.printSpoolConfirmed) || 0)),
      failed: Math.max(0, Math.trunc(Number(counters.printSpoolFailed) || 0)),
      reclaimed: Math.max(0, Math.trunc(Number(counters.printSpoolReclaimed) || 0)),
      printerTimeouts: Math.max(0, Math.trunc(Number(counters.printerTimeouts) || 0)),
      queueDepth: Math.max(0, Math.trunc(Number(gauges.printSpoolQueueDepth) || 0)),
      queueLagMs: Math.max(0, Math.trunc(Number(gauges.printSpoolQueueLagMs) || 0)),
      circuitOpen: Math.max(0, Math.trunc(Number(gauges.printerCircuitOpen) || 0)),
      orphanFiles: Math.max(0, Math.trunc(Number(gauges.printSpoolOrphanFiles) || 0)),
    },
    idempotency: {
      attempts: idempotencyAttempts,
      hits: idempotencyHits,
      hitRate: roundPercent(idempotencyHits, idempotencyAttempts),
      conflicts: Math.max(0, Math.trunc(Number(counters.idempotencyStoreConflicts) || 0)),
      inProgress: Math.max(0, Math.trunc(Number(counters.idempotencyStoreInProgress) || 0)),
      failedReplays: Math.max(0, Math.trunc(Number(counters.idempotencyStoreFailedReplays) || 0)),
    },
    commandInbox: {
      attempts: commandInboxClaims,
      created: Math.max(0, Math.trunc(Number(counters.commandInboxCreated) || 0)),
      replays: commandInboxReplays,
      replayRate: roundPercent(commandInboxReplays, commandInboxClaims),
      conflicts: Math.max(0, Math.trunc(Number(counters.commandInboxConflicts) || 0)),
      inProgress: Math.max(0, Math.trunc(Number(counters.commandInboxInProgress) || 0)),
      committed: Math.max(0, Math.trunc(Number(counters.commandInboxCommitted) || 0)),
      rejected: Math.max(0, Math.trunc(Number(counters.commandInboxRejected) || 0)),
      failed: Math.max(0, Math.trunc(Number(counters.commandInboxFailed) || 0)),
    },
    relational: {
      readPrimaryAttempts: relationalAttempts,
      fallbackCount: relationalFallbacks,
      fallbackRate: roundPercent(relationalFallbacks, relationalAttempts),
      errors: Math.max(0, Math.trunc(Number(counters.relationalReadPrimaryErrors) || 0)),
      walCheckpointRuns: Math.max(0, Math.trunc(Number(counters.relationalWalCheckpointRuns) || 0)),
      walCheckpointBusyRuns: Math.max(0, Math.trunc(Number(counters.relationalWalCheckpointBusy) || 0)),
      walCheckpointErrors: Math.max(0, Math.trunc(Number(counters.relationalWalCheckpointErrors) || 0)),
      walCheckpointPages: Math.max(0, Math.trunc(Number(counters.relationalWalCheckpointPages) || 0)),
      walAutoCheckpointPages: Math.max(0, Math.trunc(Number(gauges.relationalWalAutoCheckpointPages) || 0)),
      walCheckpointRunning: Math.max(0, Math.trunc(Number(gauges.relationalWalCheckpointRunning) || 0)),
      walBusy: Math.max(0, Math.trunc(Number(gauges.relationalWalCheckpointBusy) || 0)),
      walLogPages: Math.max(0, Math.trunc(Number(gauges.relationalWalLogPages) || 0)),
      walCheckpointedPages: Math.max(0, Math.trunc(Number(gauges.relationalWalCheckpointedPages) || 0)),
      walBacklogPages: Math.max(0, Math.trunc(Number(gauges.relationalWalBacklogPages) || 0)),
      walLastCheckpointAtMs: Math.max(0, Math.trunc(Number(gauges.relationalWalLastCheckpointAtMs) || 0)),
    },
    redis: {
      cacheHits: Math.max(0, Math.trunc(Number(counters.redisCacheHits) || 0)),
      cacheMisses: Math.max(0, Math.trunc(Number(counters.redisCacheMisses) || 0)),
      cacheSets: Math.max(0, Math.trunc(Number(counters.redisCacheSets) || 0)),
      cacheInvalidations: Math.max(0, Math.trunc(Number(counters.redisCacheInvalidations) || 0)),
      cacheInvalidationCoalesced: Math.max(
        0,
        Math.trunc(Number(counters.redisCacheInvalidationCoalesced) || 0),
      ),
      hitRate: roundPercent(
        counters.redisCacheHits,
        (Number(counters.redisCacheHits) || 0) + (Number(counters.redisCacheMisses) || 0),
      ),
      errors: Math.max(0, Math.trunc(Number(counters.redisErrors) || 0)),
      presenceTouches: Math.max(0, Math.trunc(Number(counters.redisPresenceTouches) || 0)),
      sessionWrites: Math.max(0, Math.trunc(Number(counters.redisSessionWrites) || 0)),
      authSessionHits: Math.max(0, Math.trunc(Number(counters.redisAuthSessionHits) || 0)),
      authSessionMisses: Math.max(0, Math.trunc(Number(counters.redisAuthSessionMisses) || 0)),
      authSessionWrites: Math.max(0, Math.trunc(Number(counters.redisAuthSessionWrites) || 0)),
      authSessionInvalidations: Math.max(0, Math.trunc(Number(counters.redisAuthSessionInvalidations) || 0)),
      authSessionErrors: Math.max(0, Math.trunc(Number(counters.redisAuthSessionErrors) || 0)),
      clientPoolSize: Math.max(0, Math.trunc(Number(gauges.redisClientPoolSize) || 0)),
      clientOpenConnections: Math.max(0, Math.trunc(Number(gauges.redisClientOpenConnections) || 0)),
      clientConnectionsOpened: Math.max(0, Math.trunc(Number(gauges.redisClientConnectionsOpened) || 0)),
      clientReconnects: Math.max(0, Math.trunc(Number(gauges.redisClientReconnects) || 0)),
      clientQueued: Math.max(0, Math.trunc(Number(gauges.redisClientQueued) || 0)),
      clientCommands: Math.max(0, Math.trunc(Number(gauges.redisClientCommands) || 0)),
    },
    lanes: {
      crossDomainConcurrencyFamiliesActive: Math.max(
        0,
        Math.trunc(Number(gauges.crossDomainConcurrencyFamiliesActive) || 0),
      ),
      crossDomainConcurrencyFamiliesActiveMax: Math.max(
        0,
        Math.trunc(Number(gauges.crossDomainConcurrencyFamiliesActiveMax) || 0),
      ),
      dbMutationOldestWaitMs: Math.max(
        0,
        Math.trunc(Number(gauges.dbMutationOldestWaitMs) || 0),
      ),
      dbMutationStarvationPromotions: Math.max(
        0,
        Math.trunc(Number(counters.dbMutationStarvationPromotions) || 0),
      ),
      overlapDetected:
        Math.max(0, Math.trunc(Number(gauges.crossDomainConcurrencyFamiliesActiveMax) || 0)) > 1,
      waiterPauseDepth: Math.max(0, Math.trunc(Number(gauges.waiterPauseLaneDepth) || 0)),
      waiterPauseRunning: Math.max(0, Math.trunc(Number(gauges.waiterPauseLaneRunning) || 0)),
      fiscalRetryDepth: Math.max(0, Math.trunc(Number(gauges.fiscalRetryLaneDepth) || 0)),
      fiscalRetryRunning: Math.max(0, Math.trunc(Number(gauges.fiscalRetryLaneRunning) || 0)),
      printDepth: Math.max(0, Math.trunc(Number(gauges.printLaneDepth) || 0)),
      printRunning: Math.max(0, Math.trunc(Number(gauges.printLaneRunning) || 0)),
      queueWaitTop: queueWaitEntries,
    },
    routes: {
      p99Top: topHistogramEntries(requests.runMsByRoute ?? {}, 10),
      readDbTop: topHistogramEntries(requests.readDbCountByRoute ?? {}, 8),
      writeDbTop: topHistogramEntries(requests.writeDbCountByRoute ?? {}, 8),
    },
  };
}

export function createRuntimeMetrics(options = {}) {
  const enabled = options.enabled === true;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  let startedAtMs = now();
  const queueSamples = [];
  const queueSampleLimit = Math.max(10, Math.trunc(Number(options.queueSampleLimit) || 600));
  const dbMutationWaitByLabel = new Map();
  const dbMutationRunByLabel = new Map();
  const orderLaneWaitByLabel = new Map();
  const orderLaneRunByLabel = new Map();
  const paymentLaneWaitByLabel = new Map();
  const paymentLaneRunByLabel = new Map();
  const roomLaneWaitByLabel = new Map();
  const roomLaneRunByLabel = new Map();
  const reservationLaneWaitByLabel = new Map();
  const reservationLaneRunByLabel = new Map();
  const notificationLaneWaitByLabel = new Map();
  const notificationLaneRunByLabel = new Map();
  const printLaneWaitByLabel = new Map();
  const printLaneRunByLabel = new Map();
  const waiterPauseLaneWaitByLabel = new Map();
  const waiterPauseLaneRunByLabel = new Map();
  const stationStateLaneWaitByLabel = new Map();
  const stationStateLaneRunByLabel = new Map();
  const fiscalRetryLaneWaitByLabel = new Map();
  const fiscalRetryLaneRunByLabel = new Map();
  const requestRunByRoute = new Map();
  const requestReadDbByRoute = new Map();
  const requestWriteDbByRoute = new Map();
  const operationRunByLabel = new Map();
  const appStateWriteRunByLabel = new Map();
  const dirtyTrackingByLabel = new Map();
  const dirtyTrackingMissingByLabel = new Map();
  const dirtyTrackingChangedDomains = createHistogram([0, 1, 2, 3, 5, 8, 13, 21, 34]);
  const dirtyTrackingDeclaredDomains = createHistogram([0, 1, 2, 3, 5, 8, 13, 21, 34]);
  const dirtyTrackingSamples = [];
  const dirtyTrackingSampleLimit = Math.max(10, Math.trunc(Number(options.dirtyTrackingSampleLimit) || 200));
  const writeComparableBytes = createHistogram(DEFAULT_BUCKETS_BYTES);
  const writePersistedComparableBytes = createHistogram(DEFAULT_BUCKETS_BYTES);
  const writePersistedBytes = createHistogram(DEFAULT_BUCKETS_BYTES);
  const writeRunMs = createHistogram(DEFAULT_BUCKETS_MS);
  const readRunMs = createHistogram(DEFAULT_BUCKETS_MS);
  const counters = {
    requests: 0,
    readDb: 0,
    writeDb: 0,
    writeDbNoopComparable: 0,
    writeDbNoopPersistedComparable: 0,
    writeDbDirtyExternalized: 0,
    writeDbPersisted: 0,
    writeDbFullStateFallback: 0,
    appStateDirtyTrackingObservations: 0,
    appStateDirtyTrackingMissing: 0,
    appStateDirtyTrackingOverDeclared: 0,
    dbMutationEnqueued: 0,
    dbMutationStarvationPromotions: 0,
    orderLaneEnqueued: 0,
    paymentLaneEnqueued: 0,
    domainLaneFairOrderTurns: 0,
    domainLaneFairPaymentTurns: 0,
    domainLaneFairRoomTurns: 0,
    domainLaneFairReservationTurns: 0,
    domainLaneFairNotificationTurns: 0,
    domainLaneFairWaiterPauseTurns: 0,
    domainLaneFairStationStateTurns: 0,
    domainLaneNormalTurns: 0,
    domainLaneAgedPromotions: 0,
    domainLaneAgedOrderPromotions: 0,
    domainLaneAgedPaymentPromotions: 0,
    domainLaneAgedRoomPromotions: 0,
    domainLaneAgedReservationPromotions: 0,
    domainLaneAgedNotificationPromotions: 0,
    domainLaneAgedWaiterPausePromotions: 0,
    domainLaneAgedStationStatePromotions: 0,
    paymentFreeSplitTransientMirrorDeferred: 0,
    paymentMirrorEnqueued: 0,
    paymentMirrorClaims: 0,
    paymentMirrorCompleted: 0,
    paymentMirrorRetries: 0,
    paymentMirrorFailedFinal: 0,
    paymentMirrorReclaimed: 0,
    paymentMirrorWorkerErrors: 0,
    paymentMirrorForegroundDeferrals: 0,
    paymentMirrorForegroundAgedDeferrals: 0,
    paymentMirrorForegroundPressureErrors: 0,
    paymentMirrorForegroundIdleWakes: 0,
    paymentMirrorForegroundGraceDeferrals: 0,
    paymentMirrorWakeCoalesced: 0,
    paymentMirrorSyncFallbacks: 0,
    paymentMirrorStatelessClaims: 0,
    paymentMirrorStatelessWrites: 0,
    paymentMirrorStatelessFallbacks: 0,
    paymentMirrorRelationalOrderSnapshotMisses: 0,
    paymentMirrorRelationalRecordSnapshotMisses: 0,
    paymentMirrorFiscalReceiptTerminalPrecedence: 0,
    paymentMirrorLegacyClaims: 0,
    paymentMirrorRetentionRuns: 0,
    paymentMirrorRetentionDeleted: 0,
    paymentMirrorRetentionCompletedDeleted: 0,
    paymentMirrorRetentionFailedDeleted: 0,
    paymentMirrorRetentionErrors: 0,
    paymentFreeSplitPunctualMirrorWrites: 0,
    paymentFreeSplitAtomicMirrorWrites: 0,
    paymentFreeSplitAtomicMirrorFallbacks: 0,
    paymentFreeSplitAtomicMirrorErrors: 0,
    paymentMirrorPosSettingsTablesSkipped: 0,
    waiterPauseRecoveryIntegrationWriteSkips: 0,
    waiterPausePartialCommitRecoveries: 0,
    roomLaneEnqueued: 0,
    tableSyncAppStateFastWrites: 0,
    tableSyncAppStateFastFallbacks: 0,
    tableSyncAppStateFastFallbackRelatedDomain: 0,
    tableSyncAppStateFastFallbackTableWriterUnavailable: 0,
    tableSyncAppStateFastFallbackTableStateWriterUnavailable: 0,
    tableSyncAppStateFastFallbackAuditWriterUnavailable: 0,
    tableRoomMoveRequestAppStateFastWrites: 0,
    tableRoomMoveRequestAppStateFastFallbacks: 0,
    tableRoomMoveRequestAppStateFastFallbackCollectionPruned: 0,
    tableRoomMoveRequestAppStateFastFallbackInvalidScope: 0,
    tableRoomMoveRequestAppStateFastFallbackRequestWriterUnavailable: 0,
    tableRoomMoveRequestAppStateFastFallbackIntegrationWriterUnavailable: 0,
    reservationLaneEnqueued: 0,
    notificationLaneEnqueued: 0,
    notificationPunctualWrites: 0,
    notificationPunctualFullReplacements: 0,
    notificationPunctualSessionWrites: 0,
    notificationPunctualSessionFallbacks: 0,
    notificationPunctualFallbacks: 0,
    roomSessionPunctualWrites: 0,
    reservationPunctualWrites: 0,
    tableMovePunctualWrites: 0,
    tableGroupsFastWrites: 0,
    tableGroupsFastFallbacks: 0,
    mysqlDomainNamedLockAcquired: 0,
    mysqlDomainNamedLockLocalQueued: 0,
    mysqlDomainNamedLockReleaseErrors: 0,
    counterCollectionAtomicWrites: 0,
    counterCollectionAtomicFallbacks: 0,
    counterCollectionAtomicErrors: 0,
    mysqlAtomicSelectionWrites: 0,
    mysqlAtomicSelectionFallbacks: 0,
    mysqlAtomicSelectionErrors: 0,
    mysqlAtomicSelectionRollbacks: 0,
    mysqlAtomicSelectionRollbackErrors: 0,
    printLaneEnqueued: 0,
    waiterPauseLaneEnqueued: 0,
    stationStateLaneEnqueued: 0,
    fiscalRetryLaneEnqueued: 0,
    printSpoolRetentionRuns: 0,
    printSpoolRetentionDeletedFiles: 0,
    printSpoolRetentionErrors: 0,
    printSpoolClaimed: 0,
    printSpoolConfirmed: 0,
    printSpoolFailed: 0,
    printSpoolReclaimed: 0,
    printSpoolDisabledFastAppends: 0,
    printSpoolIntermediateEventsSkipped: 0,
    printSpoolInitialEventsSkipped: 0,
    printSpoolPreSendProbeSkipped: 0,
    printSpoolLegacyMirrorSkipped: 0,
    printSpoolLegacyMirrorEnqueued: 0,
    printSpoolLegacyMirrorCoalesced: 0,
    printSpoolLegacyMirrorBatches: 0,
    printSpoolLegacyMirrorFlushed: 0,
    printSpoolLegacyMirrorRetries: 0,
    printSpoolLegacyMirrorRemoteOwnerForwarded: 0,
    printSpoolLegacyMirrorRemoteOwnerAccepted: 0,
    printSpoolLegacyMirrorRemoteOwnerFallbacks: 0,
    printSpoolLegacyMirrorRemoteOwnerHandled: 0,
    printSpoolAutoPrintOwnerEnqueued: 0,
    printSpoolAutoPrintOwnerCoalesced: 0,
    printSpoolAutoPrintOwnerBatches: 0,
    printSpoolAutoPrintOwnerFlushed: 0,
    printSpoolAutoPrintOwnerRetries: 0,
    printSpoolAutoPrintOwnerDuplicates: 0,
    printSpoolAutoPrintRemoteOwnerForwarded: 0,
    printSpoolAutoPrintRemoteOwnerAccepted: 0,
    printSpoolAutoPrintRemoteOwnerErrors: 0,
    printSpoolAutoPrintRemoteOwnerTimeouts: 0,
    printSpoolAutoPrintRemoteOwnerForwardedPlans: 0,
    printSpoolAutoPrintRemoteOwnerForwardedJobs: 0,
    printSpoolAutoPrintRemoteOwnerConfirmedPlans: 0,
    printSpoolAutoPrintRemoteOwnerConfirmedJobs: 0,
    printSpoolAutoPrintRemoteOwnerAcceptedJobs: 0,
    printSpoolAutoPrintRemoteOwnerDuplicateJobs: 0,
    printSpoolAutoPrintRemoteOwnerResultMismatches: 0,
    printSpoolAutoPrintRemoteOwnerInvalidPayloads: 0,
    printSpoolAutoPrintRemoteOwnerMisconfigured: 0,
    printSpoolAutoPrintRemoteOwnerHandled: 0,
    printerTimeouts: 0,
    eventOutboxPublishRuns: 0,
    eventOutboxPublished: 0,
    eventOutboxPublishFailed: 0,
    eventOutboxBacklogMetricRefreshes: 0,
    eventOutboxBacklogMetricSkips: 0,
    eventOutboxRetentionRuns: 0,
    eventOutboxRetentionDeleted: 0,
    eventOutboxRetentionErrors: 0,
    realtimePilotEventsEmitted: 0,
    realtimePilotEventsFailed: 0,
    realtimeReplayRuns: 0,
    realtimeReplayEvents: 0,
    realtimeReplayRecoveries: 0,
    realtimeReplayFilteredEvents: 0,
    realtimeBusinessEvents: 0,
    realtimeEligibleRecipients: 0,
    realtimeDeliveredRecipients: 0,
    realtimeFilteredClients: 0,
    realtimeSseFramesSerialized: 0,
    realtimeDeliveryBytes: 0,
    mqttConnects: 0,
    mqttPublishQueued: 0,
    mqttPublishConfirmed: 0,
    mqttPublishFailed: 0,
    mqttPublishSkipped: 0,
    mqttErrors: 0,
    integrationOrdersFastCacheHits: 0,
    integrationOrdersFastCacheMisses: 0,
    integrationOrdersReadOnlyPrunes: 0,
    orderTerminalDuplicateSyncNoops: 0,
    orderTerminalDuplicateSyncPreLaneNoops: 0,
    orderCreateFinancialDeltaFastPathHits: 0,
    orderCreateFinancialDeltaFastPathFallbacks: 0,
    orderCreateFinancialDeltaBeforeSnapshotHits: 0,
    orderCreateFinancialDeltaBeforeSnapshotFallbacks: 0,
    orderCancelFinancialDeltaBeforeSnapshotHits: 0,
    orderCancelFinancialDeltaBeforeSnapshotFallbacks: 0,
    orderCreateQueueReconcileFastSkips: 0,
    orderCreateQueueReconcileFastFallbacks: 0,
    orderSyncTableStateChanged: 0,
    orderSyncTableStateNoops: 0,
    orderSyncQueueReconcileFastSkips: 0,
    integrationLayoutRelationalTablesApplied: 0,
    integrationLayoutRelationalTablesFallback: 0,
    integrationLayoutBuildStarted: 0,
    integrationLayoutBuildJoined: 0,
    integrationLayoutFinancialOverlayOnly: 0,
    integrationLayoutRefreshWrites: 0,
    integrationLayoutRefreshWriteSkipped: 0,
    idempotencyStoreClaims: 0,
    idempotencyStoreHits: 0,
    idempotencyStoreConflicts: 0,
    idempotencyStoreInProgress: 0,
    idempotencyStoreFailedReplays: 0,
    idempotencyStoreCompleted: 0,
    idempotencyStoreFailed: 0,
    commandInboxClaims: 0,
    commandInboxCreated: 0,
    commandInboxReplays: 0,
    commandInboxConflicts: 0,
    commandInboxInProgress: 0,
    commandInboxCommitted: 0,
    commandInboxRejected: 0,
    commandInboxFailed: 0,
    relationalReadPrimaryAttempts: 0,
    relationalReadPrimaryFallbacks: 0,
    relationalReadPrimaryErrors: 0,
    relationalWalCheckpointRuns: 0,
    relationalWalCheckpointBusy: 0,
    relationalWalCheckpointErrors: 0,
    relationalWalCheckpointPages: 0,
    postgresPoolAcquires: 0,
    postgresPoolAcquireErrors: 0,
    postgresPoolErrors: 0,
    postgresQueryErrors: 0,
    postgresHealthChecks: 0,
    postgresHealthCheckFailures: 0,
    postgresEventOutboxRuns: 0,
    postgresEventOutboxProcessed: 0,
    postgresEventOutboxRetries: 0,
    postgresEventOutboxLostLeases: 0,
    redisCacheHits: 0,
    redisCacheMisses: 0,
    redisCacheSets: 0,
    redisCacheInvalidations: 0,
    redisCacheInvalidationCoalesced: 0,
    redisErrors: 0,
    redisPresenceTouches: 0,
    redisSessionDeletes: 0,
    redisSessionWrites: 0,
    redisAuthSessionHits: 0,
    redisAuthSessionMisses: 0,
    redisAuthSessionWrites: 0,
    redisAuthSessionInvalidations: 0,
    redisAuthSessionErrors: 0,
    authSessionFastWrites: 0,
    authSessionFastFallbacks: 0,
    tableLockFastAuthHits: 0,
    tableLockFastAuthMisses: 0,
    tableLockFastAuthFallbacks: 0,
    tableLockFastAuthCacheHits: 0,
    tableLockFastAuthCacheMisses: 0,
    tableLockFastAuthCacheErrors: 0,
    tableLockContextCacheHits: 0,
    tableLockContextCacheMisses: 0,
    tableLockTargetRefreshHits: 0,
    tableLockTargetRefreshMisses: 0,
    tableLockTargetRefreshAssigned: 0,
    tableLockTargetRefreshCleared: 0,
    tableLockMysqlMutations: 0,
    tableLockMysqlRetries: 0,
    tableLockMysqlNamedLockSkips: 0,
    tableLockMysqlTombstoneWrites: 0,
    tableLockMysqlErrors: 0,
    stationStatePresenceFastWrites: 0,
    stationStatePresenceFastFallbacks: 0,
    stationStateHeartbeatPersistenceWrites: 0,
    stationStateHeartbeatPersistenceSkipped: 0,
    stationStateLastWriteEnqueued: 0,
    stationStateLastWriteCoalesced: 0,
    stationStateLastWriteCoveredByInFlight: 0,
    stationStateLastWriteBatches: 0,
    stationStateLastWriteFlushed: 0,
    stationStateLastWriteRetries: 0,
    stationStateLastWriteMysqlLockContentionDeferrals: 0,
    stationStateLastWriteErrors: 0,
    stationStateLastWriteInvalidCandidates: 0,
    stationStateLastWriteFutureTimestampRejected: 0,
    stationStateLastWriteClockRegressions: 0,
    stationStateLastWriteRecoveryWrites: 0,
    stationStateLastWriteRecoveryNoops: 0,
    postazioneLogoutFastWrites: 0,
    postazioneLogoutFastFallbacks: 0,
    postazioneLogoutFastErrors: 0,
    ordersAsyncFlushEnqueued: 0,
    ordersAsyncFlushCoalesced: 0,
    ordersAsyncFlushBatches: 0,
    ordersAsyncFlushRetries: 0,
    ordersAsyncFlushMysqlLockContentionDeferrals: 0,
    ordersAsyncFlushDetachedLastWriteAtWrites: 0,
    ordersAsyncFlushDetachedSequenceWrites: 0,
    ordersAsyncFlushBackpressureSync: 0,
    ordersAsyncFlushPosSettingsTablesSkipped: 0,
    ordersAsyncFlushEmptyAuditSkipped: 0,
    ordersAsyncFlushRemoteOwnerForwarded: 0,
    ordersAsyncFlushRemoteOwnerAccepted: 0,
    ordersAsyncFlushRemoteOwnerFallbacks: 0,
    ordersAsyncFlushRemoteOwnerHandled: 0,
    ordersAsyncFlushRemoteOwnerDeferred: 0,
    ordersAsyncFlushRemoteOwnerSyncFallbacks: 0,
    ordersStartupReconciled: 0,
  };
  const gauges = {
    dbMutationOldestWaitMs: 0,
    printSpoolOrphanFiles: 0,
    printSpoolQueueDepth: 0,
    printSpoolQueueLagMs: 0,
    printerCircuitOpen: 0,
    eventOutboxUnpublished: 0,
    eventOutboxPublishedRows: 0,
    eventOutboxFailedUnpublished: 0,
    eventOutboxLagMs: 0,
    realtimeStreamClients: 0,
    mqttConnected: 0,
    mqttLastPublishAtMs: 0,
    fiscalRetryLaneDepth: 0,
    fiscalRetryLaneRunning: 0,
    waiterPauseLaneDepth: 0,
    waiterPauseLaneRunning: 0,
    printLaneDepth: 0,
    printLaneRunning: 0,
    printSpoolLegacyMirrorPendingDepth: 0,
    printSpoolLegacyMirrorRunning: 0,
    printSpoolAutoPrintOwnerPendingDepth: 0,
    printSpoolAutoPrintOwnerRunning: 0,
    crossDomainConcurrencyFamiliesActive: 0,
    crossDomainConcurrencyFamiliesActiveMax: 0,
    ordersAsyncFlushPendingDepth: 0,
    stationStateLastWritePendingDepth: 0,
    stationStateLastWriteRunning: 0,
    stationStateLastWriteOldestAgeMs: 0,
    paymentMirrorPendingDepth: 0,
    paymentMirrorFailedDepth: 0,
    paymentMirrorPendingRows: 0,
    paymentMirrorProcessingRows: 0,
    paymentMirrorCompletedRows: 0,
    paymentMirrorFailedRows: 0,
    paymentMirrorOldestPendingAgeMs: 0,
    paymentMirrorForegroundPressure: 0,
    paymentMirrorForegroundDeferralOverdue: 0,
    paymentMirrorForegroundGraceActive: 0,
    mysqlPoolActiveConnections: 0,
    mysqlPoolPendingAcquires: 0,
    postgresPoolTotalConnections: 0,
    postgresPoolIdleConnections: 0,
    postgresPoolWaitingAcquires: 0,
    postgresEventOutboxClaimed: 0,
    relationalWalAutoCheckpointPages: 0,
    relationalWalCheckpointRunning: 0,
    relationalWalCheckpointBusy: 0,
    relationalWalLogPages: 0,
    relationalWalCheckpointedPages: 0,
    relationalWalBacklogPages: 0,
    relationalWalLastCheckpointAtMs: 0,
    redisClientPoolSize: 0,
    redisClientOpenConnections: 0,
    redisClientConnectionsOpened: 0,
    redisClientReconnects: 0,
    redisClientQueued: 0,
    redisClientCommands: 0,
  };

  function recordQueueDepth(sample = {}) {
    if (!enabled) return;
    const normalizedSample = {
      atMs: now(),
      dbDepth: Math.max(0, Math.trunc(Number(sample.dbDepth) || 0)),
      dbRunning: sample.dbRunning === true,
      dbOldestWaitMs: Math.max(
        0,
        Math.trunc(Number(sample.dbOldestWaitMs) || 0),
      ),
      orderLaneDepth: Math.max(0, Math.trunc(Number(sample.orderLaneDepth) || 0)),
      orderLaneRunning: Math.max(0, Math.trunc(Number(sample.orderLaneRunning) || 0)),
      paymentLaneDepth: Math.max(0, Math.trunc(Number(sample.paymentLaneDepth) || 0)),
      paymentLaneRunning: Math.max(0, Math.trunc(Number(sample.paymentLaneRunning) || 0)),
      roomLaneDepth: Math.max(0, Math.trunc(Number(sample.roomLaneDepth) || 0)),
      roomLaneRunning: Math.max(0, Math.trunc(Number(sample.roomLaneRunning) || 0)),
      reservationLaneDepth: Math.max(0, Math.trunc(Number(sample.reservationLaneDepth) || 0)),
      reservationLaneRunning: Math.max(0, Math.trunc(Number(sample.reservationLaneRunning) || 0)),
      notificationLaneDepth: Math.max(0, Math.trunc(Number(sample.notificationLaneDepth) || 0)),
      notificationLaneRunning: Math.max(0, Math.trunc(Number(sample.notificationLaneRunning) || 0)),
      printLaneDepth: Math.max(0, Math.trunc(Number(sample.printLaneDepth) || 0)),
      printLaneRunning: Math.max(0, Math.trunc(Number(sample.printLaneRunning) || 0)),
      waiterPauseLaneDepth: Math.max(0, Math.trunc(Number(sample.waiterPauseLaneDepth) || 0)),
      waiterPauseLaneRunning: Math.max(0, Math.trunc(Number(sample.waiterPauseLaneRunning) || 0)),
      stationStateLaneDepth: Math.max(0, Math.trunc(Number(sample.stationStateLaneDepth) || 0)),
      stationStateLaneRunning: Math.max(0, Math.trunc(Number(sample.stationStateLaneRunning) || 0)),
      fiscalRetryLaneDepth: Math.max(0, Math.trunc(Number(sample.fiscalRetryLaneDepth) || 0)),
      fiscalRetryLaneRunning: Math.max(0, Math.trunc(Number(sample.fiscalRetryLaneRunning) || 0)),
    };
    gauges.fiscalRetryLaneDepth = normalizedSample.fiscalRetryLaneDepth;
    gauges.dbMutationOldestWaitMs = normalizedSample.dbOldestWaitMs;
    gauges.fiscalRetryLaneRunning = normalizedSample.fiscalRetryLaneRunning;
    gauges.waiterPauseLaneDepth = normalizedSample.waiterPauseLaneDepth;
    gauges.waiterPauseLaneRunning = normalizedSample.waiterPauseLaneRunning;
    gauges.printLaneDepth = normalizedSample.printLaneDepth;
    gauges.printLaneRunning = normalizedSample.printLaneRunning;
    normalizedSample.crossDomainConcurrencyFamiliesActive =
      computeCrossDomainConcurrencyFamiliesActive(normalizedSample);
    gauges.crossDomainConcurrencyFamiliesActive =
      normalizedSample.crossDomainConcurrencyFamiliesActive;
    gauges.crossDomainConcurrencyFamiliesActiveMax = Math.max(
      gauges.crossDomainConcurrencyFamiliesActiveMax,
      normalizedSample.crossDomainConcurrencyFamiliesActive,
    );
    queueSamples.push(normalizedSample);
    while (queueSamples.length > queueSampleLimit) queueSamples.shift();
  }

  function recordQueueWait(kind, label, waitMs) {
    if (!enabled) return;
    const map =
      kind === "orderLane"
        ? orderLaneWaitByLabel
        : kind === "paymentLane"
          ? paymentLaneWaitByLabel
          : kind === "roomLane"
            ? roomLaneWaitByLabel
            : kind === "reservationLane"
            ? reservationLaneWaitByLabel
            : kind === "notificationLane"
              ? notificationLaneWaitByLabel
              : kind === "printLane"
                ? printLaneWaitByLabel
              : kind === "waiterPauseLane"
                ? waiterPauseLaneWaitByLabel
              : kind === "stationStateLane"
                ? stationStateLaneWaitByLabel
                : kind === "fiscalRetryLane"
                  ? fiscalRetryLaneWaitByLabel
                : dbMutationWaitByLabel;
    ensureLabelMetric(map, label, DEFAULT_BUCKETS_MS).record(waitMs);
  }

  function recordQueueRun(kind, label, runMs) {
    if (!enabled) return;
    const map =
      kind === "orderLane"
        ? orderLaneRunByLabel
        : kind === "paymentLane"
          ? paymentLaneRunByLabel
          : kind === "roomLane"
            ? roomLaneRunByLabel
            : kind === "reservationLane"
            ? reservationLaneRunByLabel
            : kind === "notificationLane"
              ? notificationLaneRunByLabel
              : kind === "printLane"
                ? printLaneRunByLabel
              : kind === "waiterPauseLane"
                ? waiterPauseLaneRunByLabel
              : kind === "stationStateLane"
                ? stationStateLaneRunByLabel
                : kind === "fiscalRetryLane"
                  ? fiscalRetryLaneRunByLabel
                : dbMutationRunByLabel;
    ensureLabelMetric(map, label, DEFAULT_BUCKETS_MS).record(runMs);
  }

  function recordRequest(context) {
    if (!enabled || !context) return;
    counters.requests += 1;
    const label = normalizeLabel(context.route ?? `${context.method ?? "GET"} ${context.path ?? "/"}`);
    ensureLabelMetric(requestRunByRoute, label, DEFAULT_BUCKETS_MS).record(context.durationMs);
    ensureLabelMetric(requestReadDbByRoute, label, [0, 1, 2, 3, 5, 8, 13, 21, 34]).record(context.readDbCount);
    ensureLabelMetric(requestWriteDbByRoute, label, [0, 1, 2, 3, 5, 8, 13, 21, 34]).record(context.writeDbCount);
  }

  function recordReadDb(durationMs) {
    if (!enabled) return;
    counters.readDb += 1;
    readRunMs.record(durationMs);
  }

  function recordWriteDb(event = {}) {
    if (!enabled) return;
    counters.writeDb += 1;
    if (event.skipped === "comparable") counters.writeDbNoopComparable += 1;
    if (event.skipped === "persistedComparable") counters.writeDbNoopPersistedComparable += 1;
    if (event.skipped === "dirtyExternalized") counters.writeDbDirtyExternalized += 1;
    if (event.persisted === true) counters.writeDbPersisted += 1;
    if (event.fullStateFallbackUsed === true) counters.writeDbFullStateFallback += 1;
    writeRunMs.record(event.durationMs);
    ensureLabelMetric(appStateWriteRunByLabel, event.label ?? "writeDb", DEFAULT_BUCKETS_MS).record(event.durationMs);
    writeComparableBytes.record(event.comparableBytes);
    writePersistedComparableBytes.record(event.persistedComparableBytes);
    writePersistedBytes.record(event.persistedBytes);
  }


  function recordDirtyTracking(event = {}) {
    if (!enabled) return;
    counters.appStateDirtyTrackingObservations += 1;
    const label = normalizeLabel(event.label ?? "appStateWrite");
    const durationMs = Math.max(0, Number(event.durationMs) || 0);
    const declaredDomains = Array.isArray(event.declaredDomains) ? event.declaredDomains : [];
    const changedDomains = Array.isArray(event.changedDomains) ? event.changedDomains : [];
    const missingDeclaredDomains = Array.isArray(event.missingDeclaredDomains) ? event.missingDeclaredDomains : [];
    const overDeclaredDomains = Array.isArray(event.overDeclaredDomains) ? event.overDeclaredDomains : [];
    ensureLabelMetric(dirtyTrackingByLabel, label, DEFAULT_BUCKETS_MS).record(durationMs);
    if (missingDeclaredDomains.length > 0) {
      counters.appStateDirtyTrackingMissing += 1;
      ensureLabelMetric(dirtyTrackingMissingByLabel, label, DEFAULT_BUCKETS_MS).record(durationMs);
    }
    if (overDeclaredDomains.length > 0) counters.appStateDirtyTrackingOverDeclared += 1;
    dirtyTrackingChangedDomains.record(changedDomains.length);
    dirtyTrackingDeclaredDomains.record(declaredDomains.length);
    dirtyTrackingSamples.push({
      atMs: now(),
      label,
      mode: String(event.mode ?? "off"),
      declaredDomains,
      changedDomains,
      missingDeclaredDomains,
      overDeclaredDomains,
      fullyExternalized: event.fullyExternalized === true,
      persistedFastPath: event.persistedFastPath === true,
      fullStateFallbackUsed: event.fullStateFallbackUsed === true,
      comparableBytes: Math.max(0, Math.trunc(Number(event.comparableBytes) || 0)),
      durationMs,
    });
    while (dirtyTrackingSamples.length > dirtyTrackingSampleLimit) dirtyTrackingSamples.shift();
  }

  function recordOperation(kind, label, durationMs) {
    if (!enabled) return;
    ensureLabelMetric(operationRunByLabel, `${normalizeLabel(kind, "operation")}:${normalizeLabel(label)}`, DEFAULT_BUCKETS_MS).record(durationMs);
  }

  function snapshotMap(map, limit = 40) {
    const sortedEntries = [...map.entries()].sort(
      (left, right) =>
        right[1].count - left[1].count || left[0].localeCompare(right[0]),
    );
    const selected = new Map(sortedEntries.slice(0, limit));
    for (const [label, histogram] of sortedEntries) {
      if (isPinnedSnapshotLabel(label)) selected.set(label, histogram);
    }
    return Object.fromEntries(
      [...selected.entries()]
        .map(([label, histogram]) => [label, histogram.snapshot()]),
    );
  }

  function snapshot() {
    const result = {
      enabled,
      startedAtMs,
      generatedAtMs: now(),
      counters: { ...counters },
      queues: {
        recentSamples: queueSamples.slice(-queueSampleLimit),
        lastSample: queueSamples.length ? queueSamples[queueSamples.length - 1] : null,
        dbMutation: {
          waitMsByLabel: snapshotMap(dbMutationWaitByLabel),
          runMsByLabel: snapshotMap(dbMutationRunByLabel),
        },
        orderLane: {
          waitMsByLabel: snapshotMap(orderLaneWaitByLabel),
          runMsByLabel: snapshotMap(orderLaneRunByLabel),
        },
        paymentLane: {
          waitMsByLabel: snapshotMap(paymentLaneWaitByLabel),
          runMsByLabel: snapshotMap(paymentLaneRunByLabel),
        },
        roomLane: {
          waitMsByLabel: snapshotMap(roomLaneWaitByLabel),
          runMsByLabel: snapshotMap(roomLaneRunByLabel),
        },
        reservationLane: {
          waitMsByLabel: snapshotMap(reservationLaneWaitByLabel),
          runMsByLabel: snapshotMap(reservationLaneRunByLabel),
        },
        notificationLane: {
          waitMsByLabel: snapshotMap(notificationLaneWaitByLabel),
          runMsByLabel: snapshotMap(notificationLaneRunByLabel),
        },
        printLane: {
          waitMsByLabel: snapshotMap(printLaneWaitByLabel),
          runMsByLabel: snapshotMap(printLaneRunByLabel),
        },
        waiterPauseLane: {
          waitMsByLabel: snapshotMap(waiterPauseLaneWaitByLabel),
          runMsByLabel: snapshotMap(waiterPauseLaneRunByLabel),
        },
        stationStateLane: {
          waitMsByLabel: snapshotMap(stationStateLaneWaitByLabel),
          runMsByLabel: snapshotMap(stationStateLaneRunByLabel),
        },
        fiscalRetryLane: {
          waitMsByLabel: snapshotMap(fiscalRetryLaneWaitByLabel),
          runMsByLabel: snapshotMap(fiscalRetryLaneRunByLabel),
        },
      },
      requests: {
        runMsByRoute: snapshotMap(requestRunByRoute),
        readDbCountByRoute: snapshotMap(requestReadDbByRoute),
        writeDbCountByRoute: snapshotMap(requestWriteDbByRoute),
      },
      appState: {
        readRunMs: readRunMs.snapshot(),
        writeRunMs: writeRunMs.snapshot(),
        writeRunMsByLabel: snapshotMap(appStateWriteRunByLabel),
        writeComparableBytes: writeComparableBytes.snapshot(),
        writePersistedComparableBytes: writePersistedComparableBytes.snapshot(),
        writePersistedBytes: writePersistedBytes.snapshot(),
        dirtyTracking: {
          observationsByLabel: snapshotMap(dirtyTrackingByLabel),
          missingByLabel: snapshotMap(dirtyTrackingMissingByLabel),
          changedDomains: dirtyTrackingChangedDomains.snapshot(),
          declaredDomains: dirtyTrackingDeclaredDomains.snapshot(),
          recentSamples: dirtyTrackingSamples.slice(-dirtyTrackingSampleLimit),
        },
      },
      operations: {
        runMsByLabel: snapshotMap(operationRunByLabel),
      },
      gauges: { ...gauges },
    };
    result.dashboard = buildRuntimeMetricsDashboard(result);
    return result;
  }

  function reset() {
    startedAtMs = now();
    queueSamples.length = 0;
    [
      dbMutationWaitByLabel,
      dbMutationRunByLabel,
      orderLaneWaitByLabel,
      orderLaneRunByLabel,
      paymentLaneWaitByLabel,
      paymentLaneRunByLabel,
      roomLaneWaitByLabel,
      roomLaneRunByLabel,
      reservationLaneWaitByLabel,
      reservationLaneRunByLabel,
      notificationLaneWaitByLabel,
      notificationLaneRunByLabel,
      printLaneWaitByLabel,
      printLaneRunByLabel,
      waiterPauseLaneWaitByLabel,
      waiterPauseLaneRunByLabel,
      stationStateLaneWaitByLabel,
      stationStateLaneRunByLabel,
      fiscalRetryLaneWaitByLabel,
      fiscalRetryLaneRunByLabel,
      requestRunByRoute,
      requestReadDbByRoute,
      requestWriteDbByRoute,
      operationRunByLabel,
      appStateWriteRunByLabel,
      dirtyTrackingByLabel,
      dirtyTrackingMissingByLabel,
    ].forEach((map) => map.clear());
    Object.keys(counters).forEach((key) => {
      counters[key] = 0;
    });
    Object.keys(gauges).forEach((key) => {
      gauges[key] = 0;
    });
    writeComparableBytes.reset();
    writePersistedComparableBytes.reset();
    writePersistedBytes.reset();
    writeRunMs.reset();
    readRunMs.reset();
    dirtyTrackingChangedDomains.reset();
    dirtyTrackingDeclaredDomains.reset();
    dirtyTrackingSamples.length = 0;
  }

  return {
    enabled,
    recordQueueDepth,
    recordQueueWait,
    recordQueueRun,
    recordRequest,
    recordReadDb,
    recordWriteDb,
    recordDirtyTracking,
    recordOperation,
    incrementCounter(name, amount = 1) {
      if (!enabled || !Object.prototype.hasOwnProperty.call(counters, name)) return;
      const delta = Math.max(0, Math.trunc(Number(amount) || 0));
      counters[name] += delta;
    },
    setGauge(name, value) {
      if (!enabled || !Object.prototype.hasOwnProperty.call(gauges, name)) return;
      gauges[name] = Math.max(0, Math.trunc(Number(value) || 0));
    },
    snapshot,
    reset,
  };
}
