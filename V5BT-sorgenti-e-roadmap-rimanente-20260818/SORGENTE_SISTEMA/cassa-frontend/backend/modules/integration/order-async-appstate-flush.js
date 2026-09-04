const FLUSH_METRIC_LABEL = "orders.asyncFlush.appStateWrite";

function isAppStateRevisionConflict(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  const name = String(error?.name ?? "").trim();
  const status = Number(error?.status ?? error?.statusCode ?? NaN);
  const message = String(error?.message ?? "").toLowerCase();
  return (
    code === "REVISION_CONFLICT" ||
    name === "RevisionConflictError" ||
    status === 409 ||
    message.includes("record has changed since last read") ||
    message.includes("revision conflict")
  );
}

function isMysqlLockContention(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  const errno = Number(error?.errno ?? NaN);
  return (
    code === "ER_LOCK_NOWAIT" ||
    code === "ER_LOCK_WAIT_TIMEOUT" ||
    errno === 3_572 ||
    errno === 1_205
  );
}

function toIdSet(target, values) {
  if (!Array.isArray(values)) return target;
  for (const value of values) {
    const id = String(value ?? "").trim();
    if (id) target.add(id);
  }
  return target;
}

export function partitionOrderAsyncIntegrationObjectFields(
  fields,
  { detachLastWriteAt = false, detachSequence = false } = {},
) {
  const normalized = [
    ...new Set(
      (Array.isArray(fields) ? fields : [])
        .map((field) => String(field ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const detachedFieldNames = new Set();
  if (detachLastWriteAt) detachedFieldNames.add("lastWriteAt");
  if (detachSequence) detachedFieldNames.add("sequence");
  const detachedFields = normalized.filter((field) => detachedFieldNames.has(field));
  if (detachedFields.length === 0) return { bulkFields: normalized, detachedFields: [] };
  return {
    bulkFields: normalized.filter((field) => !detachedFieldNames.has(field)),
    detachedFields,
  };
}

function createPendingBatch() {
  return {
    orderIds: new Set(),
    auditEventIds: new Set(),
    notificationIds: new Set(),
    fulfillmentHistoryIds: new Set(),
    posSettingsTableIds: new Set(),
    integrationObjectFields: new Set(),
    extraSplitDomains: new Set(),
    syncSequence: false,
    syncNotifications: false,
    syncFulfillmentHistory: false,
    fulfillmentHistoryFullSync: false,
    syncPosSettings: false,
    oldestEnqueuedAt: 0,
  };
}

function mergeIntoBatch(batch, options = {}, nowMs = Date.now()) {
  toIdSet(batch.orderIds, options.orderIds);
  toIdSet(batch.auditEventIds, options.auditEventIds);
  toIdSet(batch.notificationIds, options.notificationIds);
  toIdSet(batch.fulfillmentHistoryIds, options.fulfillmentHistoryIds);
  toIdSet(batch.posSettingsTableIds, options.posSettingsTableIds);
  toIdSet(batch.integrationObjectFields, options.integrationObjectFields);
  if (Array.isArray(options.extraSplitDomains)) {
    for (const domain of options.extraSplitDomains) {
      const name = String(domain ?? "").trim();
      if (name) batch.extraSplitDomains.add(name);
    }
  }
  batch.syncSequence = batch.syncSequence || options.syncSequence === true;
  batch.syncNotifications = batch.syncNotifications || options.syncNotifications === true;
  batch.syncFulfillmentHistory = batch.syncFulfillmentHistory || options.syncFulfillmentHistory === true;
  batch.fulfillmentHistoryFullSync = batch.fulfillmentHistoryFullSync || options.fulfillmentHistoryFullSync === true;
  batch.syncPosSettings = batch.syncPosSettings || options.syncPosSettings === true;
  if (!batch.oldestEnqueuedAt) batch.oldestEnqueuedAt = nowMs;
  return batch;
}

function mergeBatchInto(target, source) {
  for (const id of source.orderIds) target.orderIds.add(id);
  for (const id of source.auditEventIds) target.auditEventIds.add(id);
  for (const id of source.notificationIds) target.notificationIds.add(id);
  for (const id of source.fulfillmentHistoryIds) target.fulfillmentHistoryIds.add(id);
  for (const id of source.posSettingsTableIds) target.posSettingsTableIds.add(id);
  for (const fieldName of source.integrationObjectFields) target.integrationObjectFields.add(fieldName);
  for (const domain of source.extraSplitDomains) target.extraSplitDomains.add(domain);
  target.syncSequence = target.syncSequence || source.syncSequence;
  target.syncNotifications = target.syncNotifications || source.syncNotifications;
  target.syncFulfillmentHistory = target.syncFulfillmentHistory || source.syncFulfillmentHistory;
  target.fulfillmentHistoryFullSync = target.fulfillmentHistoryFullSync || source.fulfillmentHistoryFullSync;
  target.syncPosSettings = target.syncPosSettings || source.syncPosSettings;
  const candidates = [target.oldestEnqueuedAt, source.oldestEnqueuedAt].filter((value) => value > 0);
  target.oldestEnqueuedAt = candidates.length ? Math.min(...candidates) : 0;
  return target;
}

function batchHasWork(batch) {
  return batch.orderIds.size > 0 || batch.auditEventIds.size > 0 || batch.notificationIds.size > 0 || batch.fulfillmentHistoryIds.size > 0 || batch.posSettingsTableIds.size > 0;
}

function buildFlushOptions(batch) {
  return {
    orderIds: [...batch.orderIds],
    auditEventIds: [...batch.auditEventIds],
    notificationIds: [...batch.notificationIds],
    fulfillmentHistoryIds: [...batch.fulfillmentHistoryIds],
    posSettingsTableIds: [...batch.posSettingsTableIds],
    integrationObjectFields: [...batch.integrationObjectFields],
    extraSplitDomains: [...batch.extraSplitDomains],
    syncSequence: batch.syncSequence,
    syncNotifications: batch.syncNotifications && batch.notificationIds.size > 0,
    syncFulfillmentHistory: batch.syncFulfillmentHistory && batch.fulfillmentHistoryIds.size > 0,
    fulfillmentHistoryFullSync: batch.fulfillmentHistoryFullSync,
    syncPosSettings: batch.syncPosSettings || batch.extraSplitDomains.has("posSettings"),
    metricLabel: FLUSH_METRIC_LABEL,
  };
}

export function createOrderAsyncAppStateFlushQueue({
  readDb,
  runFlush,
  runtimeMetrics = null,
  logger = console,
  runExclusive = null,
  tryRemoteFlush = null,
  intervalMs = 25,
  maxPendingOrders = 1_000,
  retryBaseMs = 250,
  retryMaxMs = 5_000,
  inlineRevisionRetryAttempts = 2,
  nowMs = () => Date.now(),
} = {}) {
  if (typeof readDb !== "function" || typeof runFlush !== "function") {
    throw new Error("order-async-appstate-flush richiede readDb e runFlush.");
  }
  let pending = createPendingBatch();
  let running = false;
  let consecutiveFailures = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const incrementCounter = (name, amount = 1) => runtimeMetrics?.incrementCounter?.(name, amount);
  const updatePendingGauge = () => runtimeMetrics?.setGauge?.("ordersAsyncFlushPendingDepth", pending.orderIds.size);
  const executeFlush = async (options, context = {}) => {
    if (
      typeof tryRemoteFlush === "function" &&
      (await tryRemoteFlush(options, context)) === true
    ) {
      return;
    }
    const readAndFlush = async () => {
      const attempts = Math.max(0, Math.trunc(Number(inlineRevisionRetryAttempts) || 0));
      for (let attempt = 0; attempt <= attempts; attempt += 1) {
        try {
          const db = await readDb(attempt > 0 ? { forceReload: true } : {});
          return await runFlush(db, options);
        } catch (error) {
          if (attempt >= attempts || !isAppStateRevisionConflict(error)) {
            throw error;
          }
          incrementCounter("ordersAsyncFlushInlineRevisionConflictRetries");
        }
      }
    };
    if (typeof runExclusive === "function") {
      return runExclusive(readAndFlush, { options, ...context });
    }
    return readAndFlush();
  };

  async function drainLoop() {
    running = true;
    try {
      while (batchHasWork(pending)) {
        if (intervalMs > 0) await sleep(intervalMs);
        const batch = pending;
        pending = createPendingBatch();
        updatePendingGauge();
        const queueWaitMs = Math.max(0, nowMs() - batch.oldestEnqueuedAt);
        try {
          await executeFlush(buildFlushOptions(batch), { queueWaitMs });
          consecutiveFailures = 0;
          incrementCounter("ordersAsyncFlushBatches");
          runtimeMetrics?.recordOperation?.("orderWorkflow", "orders.asyncFlush.queueWait", queueWaitMs);
        } catch (error) {
          const freshBatch = pending;
          pending = mergeBatchInto(batch, freshBatch);
          updatePendingGauge();
          consecutiveFailures += 1;
          incrementCounter("ordersAsyncFlushRetries");
          const lockContention = isMysqlLockContention(error);
          if (lockContention) {
            incrementCounter("ordersAsyncFlushMysqlLockContentionDeferrals");
          }
          const backoffMs = Math.min(retryBaseMs * 2 ** Math.min(consecutiveFailures - 1, 10), retryMaxMs);
          if (!lockContention) {
            logger?.warn?.(`[db:orders-async-flush] flush mirror fallito (tentativo ${consecutiveFailures}, retry tra ${backoffMs}ms): ${error?.message ?? error}`);
          }
          await sleep(backoffMs);
        }
      }
    } finally {
      running = false;
      if (batchHasWork(pending)) setImmediate(() => { if (!running) void drainLoop(); });
    }
  }

  function tryDefer(options = {}) {
    if (pending.orderIds.size >= maxPendingOrders) {
      incrementCounter("ordersAsyncFlushBackpressureSync");
      return false;
    }
    const knownBefore = Array.isArray(options.orderIds) && options.orderIds.some((id) => pending.orderIds.has(String(id ?? "").trim()));
    mergeIntoBatch(pending, options, nowMs());
    incrementCounter("ordersAsyncFlushEnqueued");
    if (knownBefore) incrementCounter("ordersAsyncFlushCoalesced");
    updatePendingGauge();
    if (!running) setImmediate(() => { if (!running) void drainLoop(); });
    return true;
  }

  function pendingDepth() {
    return pending.orderIds.size;
  }

  function hasPressure() {
    return running || batchHasWork(pending);
  }

  async function drain({ timeoutMs = 5_000 } = {}) {
    const deadline = nowMs() + Math.max(0, timeoutMs);
    while ((running || batchHasWork(pending)) && nowMs() < deadline) {
      if (!running && batchHasWork(pending)) void drainLoop();
      await sleep(20);
    }
    return { drained: !running && !batchHasWork(pending), remaining: pending.orderIds.size };
  }

  return { tryDefer, pendingDepth, hasPressure, drain };
}
