export type RealtimeRefreshRunContext = {
  signal: AbortSignal;
  supersededCount: number;
};

export type RealtimeRefreshCoordinator<T> = {
  enqueue: (key: string, value: T) => boolean;
  dispose: () => void;
};

type PendingRealtimeRefresh<T> = {
  value: T;
  supersededCount: number;
};

type RealtimeRefreshCoordinatorOptions<T> = {
  run: (value: T, context: RealtimeRefreshRunContext) => void | Promise<void>;
  dedupeWindowMs?: number;
  minimumRunIntervalMs?: number;
  recentKeyLimit?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
};

const DEFAULT_DEDUPE_WINDOW_MS = 5_000;
const DEFAULT_RECENT_KEY_LIMIT = 64;
export const MOBILE_REALTIME_REFRESH_COOLDOWN_MS = 3_000;

const positiveInteger = (value: unknown) => {
  const parsed = Math.trunc(Number(value) || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const recordFrom = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const realtimeRefreshKey = (detail: unknown) => {
  const record = recordFrom(detail);
  const eventId = positiveInteger(record.eventId);
  if (eventId > 0) return `event:${eventId}`;

  const reason = String(record.reason ?? "refresh").trim() || "refresh";
  const atMs = positiveInteger(record.atMs);
  const aggregateType = String(record.aggregateType ?? "").trim();
  const aggregateId = String(record.aggregateId ?? "").trim();
  const aggregateVersion = positiveInteger(record.aggregateVersion);
  return [reason, atMs, aggregateType, aggregateId, aggregateVersion].join(":");
};

export function createRealtimeRefreshCoordinator<T>({
  run,
  dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
  minimumRunIntervalMs = 0,
  recentKeyLimit = DEFAULT_RECENT_KEY_LIMIT,
  now = Date.now,
  onError,
}: RealtimeRefreshCoordinatorOptions<T>): RealtimeRefreshCoordinator<T> {
  const recentKeys = new Map<string, number>();
  const normalizedDedupeWindowMs = Math.max(0, dedupeWindowMs);
  const normalizedMinimumRunIntervalMs = Math.max(0, minimumRunIntervalMs);
  const normalizedRecentKeyLimit = Math.max(1, Math.trunc(recentKeyLimit));
  let disposed = false;
  let activeTask: Promise<void> | null = null;
  let activeController: AbortController | null = null;
  let scheduledStart: ReturnType<typeof setTimeout> | null = null;
  let lastRunStartedAt = Number.NEGATIVE_INFINITY;
  let trailing: PendingRealtimeRefresh<T> | null = null;

  const acceptKey = (rawKey: string) => {
    const key = String(rawKey ?? "").trim();
    if (!key) return false;
    const observedAt = now();
    const previousAt = recentKeys.get(key);
    if (
      previousAt !== undefined &&
      observedAt >= previousAt &&
      observedAt - previousAt <= normalizedDedupeWindowMs
    ) {
      return false;
    }

    recentKeys.delete(key);
    recentKeys.set(key, observedAt);
    while (recentKeys.size > normalizedRecentKeyLimit) {
      const oldestKey = recentKeys.keys().next().value;
      if (typeof oldestKey !== "string") break;
      recentKeys.delete(oldestKey);
    }
    return true;
  };

  const start = (pending: PendingRealtimeRefresh<T>) => {
    if (disposed) return;
    const waitMs = Math.max(0, normalizedMinimumRunIntervalMs - (now() - lastRunStartedAt));
    if (waitMs > 0) {
      trailing = pending;
      scheduledStart = setTimeout(() => {
        scheduledStart = null;
        const next = trailing;
        trailing = null;
        if (next) start(next);
      }, waitMs);
      return;
    }

    lastRunStartedAt = now();
    const controller = new AbortController();
    activeController = controller;
    const task = Promise.resolve()
      .then(async () => {
        if (disposed || controller.signal.aborted) return;
        await run(pending.value, {
          signal: controller.signal,
          supersededCount: pending.supersededCount,
        });
      })
      .catch((error: unknown) => {
        if (!disposed && !controller.signal.aborted) onError?.(error);
      })
      .finally(() => {
        if (activeTask !== task) return;
        activeTask = null;
        activeController = null;
        if (disposed) {
          trailing = null;
          return;
        }
        const next = trailing;
        trailing = null;
        if (next) start(next);
      });
    activeTask = task;
  };

  return {
    enqueue(key, value) {
      if (disposed || !acceptKey(key)) return false;
      if (!activeTask && scheduledStart === null) {
        start({ value, supersededCount: 0 });
        return true;
      }
      trailing = {
        value,
        supersededCount: trailing ? trailing.supersededCount + 1 : 0,
      };
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      trailing = null;
      recentKeys.clear();
      if (scheduledStart !== null) {
        clearTimeout(scheduledStart);
        scheduledStart = null;
      }
      activeController?.abort();
    },
  };
}
