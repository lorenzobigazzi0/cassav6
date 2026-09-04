const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

function timestampMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function isMysqlLockContention(error) {
  let current = error;
  let depth = 0;
  while (current && depth < 4) {
    const code = String(current?.code ?? "").trim().toUpperCase();
    const errno = Number(current?.errno ?? current?.errorno ?? NaN);
    if (
      code === "ER_LOCK_NOWAIT" ||
      code === "ER_LOCK_WAIT_TIMEOUT" ||
      errno === 3_572 ||
      errno === 1_205
    ) {
      return true;
    }
    current = current?.cause;
    depth += 1;
  }
  return false;
}

function stationTimestampMs(entry) {
  const value = Number(entry?.updatedAtMs);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function lastWritePosition(appState) {
  const integration = appState?.integration;
  if (!integration || typeof integration !== "object") return 0;
  const position = Object.keys(integration).indexOf("lastWriteAt");
  return position >= 0 ? position : Object.keys(integration).length;
}

export function inspectStationLastWriteAt(appState, options = {}) {
  const nowMs = typeof options.nowMs === "function" ? options.nowMs : () => Date.now();
  const maxFutureSkewMs = Math.max(
    0,
    Math.trunc(Number(options.maxFutureSkewMs) || DEFAULT_MAX_FUTURE_SKEW_MS),
  );
  const integration = appState?.integration;
  const markerValue = integration?.lastWriteAt;
  const markerPresent =
    markerValue !== null &&
    markerValue !== undefined &&
    String(markerValue).trim() !== "";
  const markerMs = timestampMs(markerValue);
  const stationValues = Array.isArray(integration?.stationStates)
    ? integration.stationStates.map((entry) => ({
        present:
          entry?.updatedAtMs !== null && entry?.updatedAtMs !== undefined,
        timestampMs: stationTimestampMs(entry),
      }))
    : [];
  const stationMs = Math.max(
    0,
    ...stationValues.map((entry) => entry.timestampMs),
  );
  const candidateMs = Math.max(markerMs, stationMs);
  const futureLimitMs = nowMs() + maxFutureSkewMs;
  return {
    candidateMs,
    markerMs,
    stationMs,
    position: lastWritePosition(appState),
    valid: candidateMs > 0 && candidateMs <= futureLimitMs,
    futureTimestamp: candidateMs > futureLimitMs,
    invalidMarker: markerPresent && markerMs === 0,
    invalidStationTimestamps: stationValues.filter(
      (entry) => entry.present && entry.timestampMs === 0,
    ).length,
    sourcePresent: markerPresent || stationValues.length > 0,
    recoveryRequired: stationMs > markerMs,
  };
}

function maxPayload(left, right) {
  if (!left) return right;
  if (!right) return left;
  const newer = right.timestampMs >= left.timestampMs ? right : left;
  return {
    ...newer,
    logicalCount:
      Math.max(0, Number(left.logicalCount) || 0) +
      Math.max(0, Number(right.logicalCount) || 0),
    oldestEnqueuedAt: Math.min(left.oldestEnqueuedAt, right.oldestEnqueuedAt),
  };
}

export function createStationLastWriteAtFlush(options = {}) {
  const enabled = options.enabled === true;
  const writeTimestamp = options.writeTimestamp;
  if (enabled && typeof writeTimestamp !== "function") {
    throw new Error("station-last-write-at-flush richiede writeTimestamp quando attivo.");
  }
  const runtimeMetrics = options.runtimeMetrics ?? null;
  const logger = options.logger ?? console;
  const nowMs = typeof options.nowMs === "function" ? options.nowMs : () => Date.now();
  const intervalMs = Math.max(0, Math.trunc(Number(options.intervalMs) || 250));
  const retryBaseMs = Math.max(1, Math.trunc(Number(options.retryBaseMs) || 100));
  const retryMaxMs = Math.max(retryBaseMs, Math.trunc(Number(options.retryMaxMs) || 5_000));
  const maxFutureSkewMs = Math.max(
    0,
    Math.trunc(Number(options.maxFutureSkewMs) || DEFAULT_MAX_FUTURE_SKEW_MS),
  );
  let pending = null;
  let inFlight = null;
  let highest = null;
  let timer = null;
  let running = false;
  let consecutiveFailures = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const counter = (suffix, amount = 1) =>
    runtimeMetrics?.incrementCounter?.(`stationStateLastWrite${suffix}`, amount);
  const updateGauges = () => {
    runtimeMetrics?.setGauge?.("stationStateLastWritePendingDepth", pending ? 1 : 0);
    runtimeMetrics?.setGauge?.("stationStateLastWriteRunning", running ? 1 : 0);
    runtimeMetrics?.setGauge?.(
      "stationStateLastWriteOldestAgeMs",
      pending ? Math.max(0, nowMs() - pending.oldestEnqueuedAt) : 0,
    );
  };

  function schedule(delayMs = intervalMs) {
    if (!enabled || running || timer || !pending) return;
    timer = setTimeout(() => {
      timer = null;
      void flushOnce();
    }, Math.max(0, Math.trunc(Number(delayMs) || 0)));
    timer.unref?.();
  }

  function payloadFromAppState(appState) {
    const inspection = inspectStationLastWriteAt(appState, {
      nowMs,
      maxFutureSkewMs,
    });
    if (!inspection.valid) {
      counter(inspection.futureTimestamp ? "FutureTimestampRejected" : "InvalidCandidates");
      return null;
    }
    return {
      timestamp: new Date(inspection.candidateMs).toISOString(),
      timestampMs: inspection.candidateMs,
      position: inspection.position,
      logicalCount: 1,
      oldestEnqueuedAt: nowMs(),
      inspection,
    };
  }

  function enqueueFromAppState(appState) {
    if (!enabled) return false;
    let payload = payloadFromAppState(appState);
    if (!payload) return false;
    counter("Enqueued");
    if (highest && payload.timestampMs < highest.timestampMs) {
      counter("ClockRegressions");
      payload = { ...highest, logicalCount: 1, oldestEnqueuedAt: payload.oldestEnqueuedAt };
    }
    if (!highest || payload.timestampMs >= highest.timestampMs) highest = { ...payload, logicalCount: 0 };
    if (inFlight && payload.timestampMs <= inFlight.timestampMs) {
      inFlight.logicalCount += 1;
      counter("CoveredByInFlight");
      return true;
    }
    if (pending) counter("Coalesced");
    pending = maxPayload(pending, payload);
    updateGauges();
    schedule();
    return true;
  }

  async function flushOnce() {
    if (!enabled || running || !pending) return;
    running = true;
    inFlight = pending;
    pending = null;
    updateGauges();
    const startedAt = nowMs();
    let retryDelayMs = intervalMs;
    try {
      await writeTimestamp(
        {
          timestamp: inFlight.timestamp,
          timestampMs: inFlight.timestampMs,
          position: inFlight.position,
        },
        { lockRowsNowait: true, mode: "flush" },
      );
      consecutiveFailures = 0;
      counter("Batches");
      counter("Flushed", inFlight.logicalCount);
      runtimeMetrics?.recordOperation?.(
        "queue",
        "stationStateLastWrite.batch",
        Math.max(0, nowMs() - startedAt),
      );
      runtimeMetrics?.recordOperation?.(
        "queue",
        "stationStateLastWrite.wait",
        Math.max(0, startedAt - inFlight.oldestEnqueuedAt),
      );
    } catch (error) {
      pending = maxPayload(inFlight, pending);
      consecutiveFailures += 1;
      counter("Retries");
      const lockContention = isMysqlLockContention(error);
      counter(lockContention ? "MysqlLockContentionDeferrals" : "Errors");
      retryDelayMs = Math.min(
        retryBaseMs * 2 ** Math.min(consecutiveFailures - 1, 10),
        retryMaxMs,
      );
      if (lockContention) {
        runtimeMetrics?.recordOperation?.(
          "queue",
          "stationStateLastWrite.contentionDeferral",
          Math.max(0, nowMs() - startedAt),
        );
      } else {
        logger?.warn?.(
          `[station-state:last-write] flush fallito, retry tra ${retryDelayMs}ms: ${error?.message ?? error}`,
        );
      }
    } finally {
      inFlight = null;
      running = false;
      updateGauges();
      if (pending) schedule(retryDelayMs);
    }
  }

  async function recoverFromAppState(appState) {
    if (!enabled) return { recovered: false, reason: "disabled" };
    const inspection = inspectStationLastWriteAt(appState, {
      nowMs,
      maxFutureSkewMs,
    });
    if (!inspection.sourcePresent) {
      counter("RecoveryNoops");
      return { recovered: false, reason: "empty" };
    }
    if (inspection.invalidMarker || inspection.invalidStationTimestamps > 0) {
      counter("InvalidCandidates");
      throw new Error("Recovery lastWriteAt station-state rifiutata: timestamp invalido.");
    }
    const payload = payloadFromAppState(appState);
    if (!payload) throw new Error("Recovery lastWriteAt station-state rifiutata: timestamp invalido o futuro.");
    highest = { ...payload, logicalCount: 0 };
    if (!payload.inspection.recoveryRequired) {
      counter("RecoveryNoops");
      return { recovered: false, reason: "current", timestamp: payload.timestamp };
    }
    await writeTimestamp(payload, { lockRowsNowait: false, mode: "recovery" });
    if (appState?.integration && typeof appState.integration === "object") {
      appState.integration.lastWriteAt = payload.timestamp;
    }
    counter("RecoveryWrites");
    return { recovered: true, timestamp: payload.timestamp };
  }

  async function drain({ timeoutMs = 5_000 } = {}) {
    const deadline = nowMs() + Math.max(0, Math.trunc(Number(timeoutMs) || 0));
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    while ((running || pending) && nowMs() < deadline) {
      if (!running && pending) await flushOnce();
      else await sleep(10);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
    if (pending && !running) schedule();
    updateGauges();
    return { drained: !running && !pending, remaining: running || pending ? 1 : 0 };
  }

  updateGauges();
  return {
    drain,
    enqueueFromAppState,
    flushOnce,
    recoverFromAppState,
    status: () => ({ pending: Boolean(pending), running, highestTimestampMs: highest?.timestampMs ?? 0 }),
  };
}
