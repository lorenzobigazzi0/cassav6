import { EventOutboxRepository } from "../../db/relational/index.js";

const DEFAULT_PUBLISH_LIMIT = 100;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_BACKLOG_METRICS_INTERVAL_MS = 5_000;

function normalizeLimit(value, fallback = DEFAULT_PUBLISH_LIMIT) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 1_000);
}

function normalizeIntervalMs(value, fallback = DEFAULT_POLL_INTERVAL_MS) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(25, Math.min(parsed, 60_000));
}

function normalizeBacklogMetricsIntervalMs(
  value,
  fallback = DEFAULT_BACKLOG_METRICS_INTERVAL_MS,
) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  if (parsed === 0) return 0;
  return Math.max(250, Math.min(parsed, 60_000));
}

function normalizeBacklogSummary(summary = {}) {
  return {
    unpublished: Math.max(0, Math.trunc(Number(summary.unpublished) || 0)),
    published: Math.max(0, Math.trunc(Number(summary.published) || 0)),
    failedUnpublished: Math.max(
      0,
      Math.trunc(Number(summary.failedUnpublished) || 0),
    ),
    oldestUnpublishedAt: String(summary.oldestUnpublishedAt ?? "").trim() || null,
  };
}

export function createEventOutboxCoordinator({
  enabled = false,
  relationalRuntime,
  nowIso = () => new Date().toISOString(),
  logger = console,
  metrics = null,
  canPublish = () => true,
  publish,
  afterEnqueue,
  publishLimit = DEFAULT_PUBLISH_LIMIT,
  retentionHours = 24,
  retentionIntervalMs = 60 * 60 * 1000,
  backlogMetricsIntervalMs = DEFAULT_BACKLOG_METRICS_INTERVAL_MS,
} = {}) {
  let pollTimer = null;
  let pollRunning = false;
  let lastRetentionRunMs = 0;
  let lastBacklogMetricsRefreshMs = 0;
  let lastBacklogSummary = null;
  const safeBacklogMetricsIntervalMs =
    normalizeBacklogMetricsIntervalMs(backlogMetricsIntervalMs);

  function incrementCounter(name, amount = 1) {
    metrics?.incrementCounter?.(name, amount);
  }

  function setGauge(name, value) {
    metrics?.setGauge?.(name, value);
  }

  function publishBacklogGauges(summary) {
    if (!metrics) return null;
    const normalized = normalizeBacklogSummary(summary);
    setGauge("eventOutboxUnpublished", normalized.unpublished);
    setGauge("eventOutboxPublishedRows", normalized.published);
    setGauge("eventOutboxFailedUnpublished", normalized.failedUnpublished);
    const oldestMs = Date.parse(String(normalized.oldestUnpublishedAt ?? ""));
    const nowMs = Date.parse(nowIso());
    const lagMs =
      Number.isFinite(oldestMs) &&
      Number.isFinite(nowMs) &&
      normalized.unpublished > 0
        ? Math.max(0, nowMs - oldestMs)
        : 0;
    setGauge("eventOutboxLagMs", lagMs);
    return normalized;
  }

  function applyBacklogMetricDelta({ published = 0, failed = 0 } = {}) {
    if (!metrics || !lastBacklogSummary) return null;
    const publishedDelta = Math.max(0, Math.trunc(Number(published) || 0));
    const failedDelta = Math.max(0, Math.trunc(Number(failed) || 0));
    if (publishedDelta === 0 && failedDelta === 0) return lastBacklogSummary;
    const nextUnpublished = Math.max(
      0,
      Number(lastBacklogSummary.unpublished) - publishedDelta,
    );
    lastBacklogSummary = {
      unpublished: nextUnpublished,
      published: Math.max(
        0,
        Number(lastBacklogSummary.published) + publishedDelta,
      ),
      failedUnpublished: Math.max(
        0,
        Number(lastBacklogSummary.failedUnpublished) + failedDelta,
      ),
      oldestUnpublishedAt:
        nextUnpublished > 0 ? lastBacklogSummary.oldestUnpublishedAt : null,
    };
    return publishBacklogGauges(lastBacklogSummary);
  }

  function refreshBacklogMetrics(repo, options = {}) {
    if (!repo || !metrics) return null;
    const nowMs = Date.now();
    const due =
      safeBacklogMetricsIntervalMs === 0 ||
      lastBacklogSummary === null ||
      nowMs - lastBacklogMetricsRefreshMs >= safeBacklogMetricsIntervalMs;
    if (options.force !== true && !due) {
      incrementCounter("eventOutboxBacklogMetricSkips");
      return lastBacklogSummary;
    }
    lastBacklogSummary = normalizeBacklogSummary(repo.countSummary());
    lastBacklogMetricsRefreshMs = nowMs;
    incrementCounter("eventOutboxBacklogMetricRefreshes");
    return publishBacklogGauges(lastBacklogSummary);
  }

  function retentionCutoffIso(hours) {
    const baseMs = Date.parse(nowIso());
    const safeBaseMs = Number.isFinite(baseMs) ? baseMs : Date.now();
    return new Date(safeBaseMs - Math.max(1, Number(hours) || 1) * 60 * 60 * 1000).toISOString();
  }

  function repository() {
    if (!enabled) return null;
    const db = relationalRuntime?.db ?? null;
    if (!db) {
      throw new Error("Event outbox non disponibile.");
    }
    return new EventOutboxRepository(db, { nowIso });
  }

  function enqueue(event = {}) {
    if (!enabled) return null;
    return repository().enqueue({
      ...event,
      occurredAt: event.occurredAt ?? nowIso(),
      afterEnqueue:
        typeof afterEnqueue === "function"
          ? (queued, db) => afterEnqueue(queued, db, event)
          : undefined,
    });
  }

  function publishPending(options = {}) {
    const summary = { published: 0, failed: 0, skipped: 0 };
    if (!enabled || typeof publish !== "function") return summary;
    if (!canPublish()) {
      summary.skipped = 1;
      return summary;
    }
    let repo = null;
    try {
      repo = repository();
    } catch (error) {
      summary.failed = 1;
      logger?.error?.("[event-outbox] repository unavailable", error);
      return summary;
    }
    const events = repo.listUnpublished({
      limit: normalizeLimit(options.limit, publishLimit),
    });
    if (events.length > 0) incrementCounter("eventOutboxPublishRuns");
    for (const event of events) {
      try {
        const delivered = publish(event.payload, event);
        if (!delivered) {
          summary.skipped += 1;
          break;
        }
        repo.markPublished(event.id);
        summary.published += 1;
        incrementCounter("eventOutboxPublished");
      } catch (error) {
        summary.failed += 1;
        incrementCounter("eventOutboxPublishFailed");
        repo.markPublishFailed(event.id, error);
        logger?.error?.("[event-outbox] publish failed", error);
      }
    }
    applyBacklogMetricDelta(summary);
    refreshBacklogMetrics(repo);
    return summary;
  }

  function enqueueAndPublish(event = {}, options = {}) {
    const queued = enqueue(event);
    return {
      queued,
      publish:
        options.publish === false
          ? { published: 0, failed: 0, skipped: 1, enqueueOnly: true }
          : publishPending(),
    };
  }

  // Replay durabile per Last-Event-ID: ritorna gli eventi con id > afterEventId.
  // recoveryRequired quando il client chiede eventi gia' potati dalla retention
  // (il suo ultimo id e' piu' vecchio del piu' vecchio ancora disponibile).
  function replay({ afterEventId = 0, limit = 200 } = {}) {
    if (!enabled) {
      return { enabled: false, events: [], bounds: { minId: null, maxId: null }, recoveryRequired: false };
    }
    const repo = repository();
    const bounds = repo.getReplayBounds();
    const safeAfter = Math.max(0, Math.trunc(Number(afterEventId) || 0));
    const recoveryRequired =
      bounds.minId !== null && safeAfter > 0 && safeAfter < bounds.minId - 1;
    const events = recoveryRequired ? [] : repo.listAfter(safeAfter, { limit });
    return { enabled: true, events, bounds, recoveryRequired };
  }

  function cleanupPublished(options = {}) {
    const summary = { deleted: 0, failed: 0 };
    if (!enabled) return summary;
    let repo = null;
    try {
      repo = repository();
      summary.deleted = repo.deletePublishedBefore(
        retentionCutoffIso(options.retentionHours ?? retentionHours),
      );
      incrementCounter("eventOutboxRetentionRuns");
      incrementCounter("eventOutboxRetentionDeleted", summary.deleted);
      refreshBacklogMetrics(repo, { force: true });
    } catch (error) {
      summary.failed = 1;
      incrementCounter("eventOutboxRetentionErrors");
      logger?.error?.("[event-outbox] retention failed", error);
    }
    return summary;
  }

  function startPolling(options = {}) {
    if (!enabled || typeof publish !== "function") return null;
    stopPolling();
    const intervalMs = normalizeIntervalMs(options.intervalMs);
    const safeRetentionIntervalMs = normalizeIntervalMs(
      options.retentionIntervalMs ?? retentionIntervalMs,
      retentionIntervalMs,
    );
    pollTimer = setInterval(() => {
      if (pollRunning) return;
      pollRunning = true;
      try {
        publishPending();
        const nowMs = Date.now();
        if (nowMs - lastRetentionRunMs >= safeRetentionIntervalMs) {
          lastRetentionRunMs = nowMs;
          cleanupPublished({ retentionHours: options.retentionHours ?? retentionHours });
        }
      } finally {
        pollRunning = false;
      }
    }, intervalMs);
    pollTimer.unref?.();
    return pollTimer;
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    pollRunning = false;
  }

  return {
    enqueue,
    enqueueAndPublish,
    replay,
    publishPending,
    cleanupPublished,
    startPolling,
    stopPolling,
    get enabled() {
      return enabled;
    },
  };
}
