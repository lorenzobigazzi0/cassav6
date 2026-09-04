function positiveInt(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function addMsIso(baseIso, delayMs) {
  const baseMs = Date.parse(String(baseIso ?? ""));
  const safeBase = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(safeBase + Math.max(0, Math.trunc(Number(delayMs) || 0))).toISOString();
}

function subtractMsIso(baseIso, durationMs) {
  const baseMs = Date.parse(String(baseIso ?? ""));
  const safeBase = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(safeBase - Math.max(1, Math.trunc(Number(durationMs) || 1))).toISOString();
}

function errorCode(error) {
  return String(error?.code ?? error?.name ?? "PAYMENT_MIRROR_FAILED").trim().slice(0, 120);
}

function errorMessage(error) {
  return String(error?.message ?? error ?? "Payment mirror failed.").trim().slice(0, 1_000);
}

export function createPaymentMirrorWorkerRuntime(options = {}) {
  const enabled = options.enabled === true;
  const logger = options.logger ?? console;
  const nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
  const intervalMs = positiveInt(options.intervalMs, 100, { min: 10, max: 300_000 });
  const batchSize = positiveInt(options.batchSize, 5, { min: 1, max: 100 });
  const leaseMs = positiveInt(options.leaseMs, 30_000, { min: 1_000, max: 3_600_000 });
  const retryBaseMs = positiveInt(options.retryBaseMs, 250, { min: 10, max: 300_000 });
  const retryMaxMs = positiveInt(options.retryMaxMs, 30_000, { min: retryBaseMs, max: 3_600_000 });
  const maxAttempts = positiveInt(options.maxAttempts, 100, { min: 1, max: 10_000 });
  const retentionIntervalMs = positiveInt(options.retentionIntervalMs, 60 * 60 * 1000, {
    min: 10,
    max: 7 * 24 * 60 * 60 * 1000,
  });
  const completedRetentionMs = positiveInt(options.completedRetentionMs, 30 * 24 * 60 * 60 * 1000, {
    min: 1,
    max: 10 * 365 * 24 * 60 * 60 * 1000,
  });
  const failedRetentionMs = positiveInt(options.failedRetentionMs, 90 * 24 * 60 * 60 * 1000, {
    min: 1,
    max: 10 * 365 * 24 * 60 * 60 * 1000,
  });
  const cleanupBatchSize = positiveInt(options.cleanupBatchSize, 250, { min: 1, max: 500 });
  const hasForegroundPressure =
    typeof options.hasForegroundPressure === "function"
      ? options.hasForegroundPressure
      : null;
  const foregroundIdleBatchSize = positiveInt(
    options.foregroundIdleBatchSize,
    batchSize,
    { min: 1, max: batchSize },
  );
  const foregroundIdleGraceMs = positiveInt(
    options.foregroundIdleGraceMs,
    3_000,
    { min: 10, max: 300_000 },
  );
  const foregroundDeferralMaxAgeMs = positiveInt(
    options.foregroundDeferralMaxAgeMs,
    15_000,
    { min: 1_000, max: 3_600_000 },
  );
  const workerId = String(options.workerId ?? "backend-owner-payment-mirror").trim();
  let timer = null;
  let scheduled = false;
  let rerunRequested = false;
  let runningPromise = null;
  let lastCleanupAtMs = 0;
  let foregroundIdleTimer = null;
  let foregroundQuietUntilMs = 0;

  async function repository() {
    await options.relationalRuntime?.initialize?.();
    if (!options.relationalRuntime?.db) {
      throw new Error("DB relazionale non disponibile per payment mirror worker.");
    }
    return new options.PaymentMirrorOutboxRepository(options.relationalRuntime.db, { nowIso });
  }

  function pendingAgeMs(summary) {
    const currentMs = Date.parse(nowIso());
    const oldestMs = Date.parse(String(summary?.oldestPendingAt ?? ""));
    if (!Number.isFinite(currentMs) || !Number.isFinite(oldestMs)) return 0;
    return Math.max(0, currentMs - oldestMs);
  }

  function foregroundPressureActive() {
    if (!hasForegroundPressure) return false;
    try {
      return hasForegroundPressure() === true;
    } catch (error) {
      options.runtimeMetrics?.incrementCounter?.(
        "paymentMirrorForegroundPressureErrors",
      );
      logger?.warn?.(
        `[payment-mirror] verifica pressione foreground fallita: ${errorMessage(error)}`,
      );
      return true;
    }
  }

  function foregroundQuietActive() {
    return foregroundQuietUntilMs > Date.now();
  }

  function recordSummary(summary, { foregroundPressure = false } = {}) {
    const oldestAgeMs = pendingAgeMs(summary);
    options.runtimeMetrics?.setGauge?.(
      "paymentMirrorPendingDepth",
      Number(summary?.pending ?? 0) + Number(summary?.processing ?? 0),
    );
    options.runtimeMetrics?.setGauge?.("paymentMirrorFailedDepth", Number(summary?.failed ?? 0));
    options.runtimeMetrics?.setGauge?.("paymentMirrorPendingRows", Number(summary?.pending ?? 0));
    options.runtimeMetrics?.setGauge?.("paymentMirrorProcessingRows", Number(summary?.processing ?? 0));
    options.runtimeMetrics?.setGauge?.("paymentMirrorCompletedRows", Number(summary?.completed ?? 0));
    options.runtimeMetrics?.setGauge?.("paymentMirrorFailedRows", Number(summary?.failed ?? 0));
    options.runtimeMetrics?.setGauge?.("paymentMirrorOldestPendingAgeMs", oldestAgeMs);
    options.runtimeMetrics?.setGauge?.(
      "paymentMirrorForegroundPressure",
      foregroundPressure ? 1 : 0,
    );
    options.runtimeMetrics?.setGauge?.(
      "paymentMirrorForegroundDeferralOverdue",
      foregroundPressure && oldestAgeMs >= foregroundDeferralMaxAgeMs ? 1 : 0,
    );
    return oldestAgeMs;
  }

  function recordForegroundDeferral(repo) {
    const summary = repo.countSummary();
    const oldestAgeMs = recordSummary(summary, { foregroundPressure: true });
    options.runtimeMetrics?.incrementCounter?.("paymentMirrorForegroundDeferrals");
    if (oldestAgeMs >= foregroundDeferralMaxAgeMs) {
      options.runtimeMetrics?.incrementCounter?.(
        "paymentMirrorForegroundAgedDeferrals",
      );
    }
    return { oldestAgeMs, summary };
  }

  async function cleanupTerminal({ force = false, repo: providedRepo = null } = {}) {
    if (!enabled) return { deleted: 0, disabled: true };
    const currentIso = nowIso();
    const currentMs = Date.parse(currentIso);
    const safeCurrentMs = Number.isFinite(currentMs) ? currentMs : Date.now();
    if (!force && lastCleanupAtMs > 0 && safeCurrentMs - lastCleanupAtMs < retentionIntervalMs) {
      return { deleted: 0, skipped: true };
    }
    try {
      const repo = providedRepo ?? await repository();
      const result = repo.deleteTerminalBefore({
        completedBefore: subtractMsIso(currentIso, completedRetentionMs),
        failedBefore: subtractMsIso(currentIso, failedRetentionMs),
        limit: cleanupBatchSize,
      });
      lastCleanupAtMs = result.deleted >= cleanupBatchSize ? 0 : safeCurrentMs;
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorRetentionRuns");
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorRetentionDeleted", result.deleted);
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorRetentionCompletedDeleted", result.completed);
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorRetentionFailedDeleted", result.failed);
      return result;
    } catch (error) {
      lastCleanupAtMs = safeCurrentMs;
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorRetentionErrors");
      logger?.error?.(`[payment-mirror] cleanup retention fallito: ${errorMessage(error)}`);
      return { deleted: 0, error };
    }
  }

  async function processClaim(repo, entry) {
    const startedAt = Date.now();
    options.runtimeMetrics?.incrementCounter?.("paymentMirrorClaims");
    try {
      const action = () => options.processClaim(entry);
      if (typeof options.runExclusive === "function") {
        await options.runExclusive(entry, action);
      } else {
        await action();
      }
      const completed = repo.markCompleted(entry.mirrorId, nowIso());
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorCompleted");
      options.runtimeMetrics?.recordOperation?.(
        "paymentMirrorWorker",
        "payment.freeSplit.completed",
        Date.now() - startedAt,
      );
      return { claimed: true, status: "completed", entry: completed };
    } catch (error) {
      const nextAttempt = Number(entry.attemptCount ?? 0) + 1;
      const terminal = nextAttempt >= maxAttempts;
      const retryDelayMs = Math.min(
        retryBaseMs * 2 ** Math.min(Math.max(0, nextAttempt - 1), 12),
        retryMaxMs,
      );
      const updated = repo.markFailed(entry.mirrorId, {
        terminal,
        nextAttemptAt: terminal ? null : addMsIso(nowIso(), retryDelayMs),
        errorCode: errorCode(error),
        errorMessage: errorMessage(error),
      });
      options.runtimeMetrics?.incrementCounter?.(
        terminal ? "paymentMirrorFailedFinal" : "paymentMirrorRetries",
      );
      options.runtimeMetrics?.recordOperation?.(
        "paymentMirrorWorker",
        terminal ? "payment.freeSplit.failed" : "payment.freeSplit.retrying",
        Date.now() - startedAt,
      );
      logger?.warn?.(
        `[payment-mirror] ${entry.mirrorId} ${terminal ? "fallito definitivamente" : `retry tra ${retryDelayMs}ms`}: ${errorMessage(error)}`,
      );
      return { claimed: true, status: updated.status, entry: updated, error };
    }
  }

  async function runBatch(reason = "scheduled", runOptions = {}) {
    if (!enabled) return { processed: 0, disabled: true };
    if (runningPromise) return { processed: 0, skipped: true };
    const bypassForegroundGate = runOptions.bypassForegroundGate === true;
    if (!bypassForegroundGate && foregroundQuietActive()) {
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorForegroundGraceDeferrals");
      options.runtimeMetrics?.setGauge?.("paymentMirrorForegroundGraceActive", 1);
      return {
        processed: 0,
        deferred: true,
        deferReason: "foreground-idle-grace",
      };
    }
    runningPromise = (async () => {
      const repo = await repository();
      const results = [];
      let foregroundDeferred = null;
      const activeBatchSize =
        hasForegroundPressure && !bypassForegroundGate
          ? Math.min(batchSize, foregroundIdleBatchSize)
          : batchSize;
      for (let index = 0; index < activeBatchSize; index += 1) {
        if (!bypassForegroundGate && foregroundPressureActive()) {
          foregroundQuietUntilMs = Math.max(
            foregroundQuietUntilMs,
            Date.now() + foregroundIdleGraceMs,
          );
          options.runtimeMetrics?.setGauge?.("paymentMirrorForegroundGraceActive", 1);
          foregroundDeferred = recordForegroundDeferral(repo);
          break;
        }
        const entry = repo.claimNext({ workerId, leaseMs, nowIso: nowIso() });
        if (!entry) break;
        results.push(await processClaim(repo, entry));
      }
      const cleanup = foregroundDeferred
        ? { deleted: 0, skipped: true, reason: "foreground-pressure" }
        : await cleanupTerminal({ repo });
      const summary = repo.countSummary();
      recordSummary(summary, {
        foregroundPressure: foregroundDeferred !== null,
      });
      options.runtimeMetrics?.setGauge?.(
        "paymentMirrorForegroundGraceActive",
        foregroundQuietActive() ? 1 : 0,
      );
      if (results.length > 0) {
        logger?.info?.(`[payment-mirror] worker ${reason}: processati=${results.length}`);
      }
      return {
        processed: results.length,
        results,
        cleanup,
        summary,
        ...(foregroundDeferred
          ? {
              deferred: true,
              deferReason: "foreground-pressure",
              oldestPendingAgeMs: foregroundDeferred.oldestAgeMs,
            }
          : {}),
      };
    })();
    try {
      return await runningPromise;
    } catch (error) {
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorWorkerErrors");
      logger?.error?.(`[payment-mirror] worker ${reason} fallito: ${errorMessage(error)}`);
      return { processed: 0, error };
    } finally {
      runningPromise = null;
      flushRerunRequest();
    }
  }

  function flushRerunRequest() {
    if (!rerunRequested || scheduled || runningPromise) return false;
    if (foregroundPressureActive() || foregroundQuietActive()) return false;
    rerunRequested = false;
    return wake("coalesced");
  }

  function wake(reason = "wake") {
    if (!enabled) return false;
    if (scheduled || runningPromise) {
      rerunRequested = true;
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorWakeCoalesced");
      return false;
    }
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      void runBatch(reason).then((result) => {
        if (result?.skipped === true) rerunRequested = true;
        flushRerunRequest();
      });
    });
    return true;
  }

  function notifyForegroundIdle() {
    if (!enabled) return false;
    options.runtimeMetrics?.incrementCounter?.("paymentMirrorForegroundIdleWakes");
    if (foregroundIdleTimer) clearTimeout(foregroundIdleTimer);
    foregroundQuietUntilMs = Date.now() + foregroundIdleGraceMs;
    options.runtimeMetrics?.setGauge?.("paymentMirrorForegroundGraceActive", 1);
    foregroundIdleTimer = setTimeout(() => {
      foregroundIdleTimer = null;
      foregroundQuietUntilMs = 0;
      options.runtimeMetrics?.setGauge?.("paymentMirrorForegroundGraceActive", 0);
      if (foregroundPressureActive()) {
        rerunRequested = true;
        return;
      }
      wake("foreground-idle");
    }, foregroundIdleGraceMs);
    foregroundIdleTimer.unref?.();
    return true;
  }

  async function reclaimStartup() {
    if (!enabled) return 0;
    const repo = await repository();
    const reclaimed = repo.reclaimAllProcessing(nowIso());
    if (reclaimed > 0) {
      options.runtimeMetrics?.incrementCounter?.("paymentMirrorReclaimed", reclaimed);
      logger?.info?.(`[payment-mirror] reclaim all'avvio: ${reclaimed}`);
    }
    await cleanupTerminal({ force: true, repo });
    recordSummary(repo.countSummary());
    return reclaimed;
  }

  function start() {
    if (!enabled || timer) return false;
    timer = setInterval(() => void runBatch("scheduled"), intervalMs);
    timer.unref?.();
    void reclaimStartup().finally(() => wake("startup"));
    logger?.info?.(
      `[payment-mirror] worker abilitato: interval=${intervalMs}ms batch=${batchSize} idleBatch=${foregroundIdleBatchSize} idleGrace=${foregroundIdleGraceMs}ms lease=${leaseMs}ms`,
    );
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (foregroundIdleTimer) clearTimeout(foregroundIdleTimer);
    foregroundIdleTimer = null;
    foregroundQuietUntilMs = 0;
    options.runtimeMetrics?.setGauge?.("paymentMirrorForegroundGraceActive", 0);
  }

  async function drain({ timeoutMs = 5_000 } = {}) {
    stop();
    if (!enabled) return { drained: true, disabled: true };
    const deadline = Date.now() + Math.max(0, Math.trunc(Number(timeoutMs) || 0));
    while (Date.now() < deadline) {
      if (runningPromise) await runningPromise;
      const result = await runBatch("shutdown", {
        bypassForegroundGate: true,
      });
      if (result.processed === 0) {
        const summary = result.summary ?? (await repository()).countSummary();
        recordSummary(summary);
        return {
          drained: Number(summary.pending ?? 0) === 0 && Number(summary.processing ?? 0) === 0,
          summary,
        };
      }
    }
    const summary = (await repository()).countSummary();
    recordSummary(summary);
    return { drained: false, summary };
  }

  return {
    cleanupTerminal,
    drain,
    enabled,
    notifyForegroundIdle,
    reclaimStartup,
    runBatch,
    start,
    stop,
    wake,
  };
}
