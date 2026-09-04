import { performance } from "node:perf_hooks";

import { canContinueLaneBurst } from "./domain-lane-fairness.js";

function normalizeLaneKeys(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

export function createSerializedMutationLane(options = {}) {
  const queue = [];
  const activeKeys = new Set();
  let running = 0;
  let sequence = 0;
  let burstCount = 0;
  const enabled = options.enabled === true;
  const concurrency = Math.max(1, Math.trunc(Number(options.concurrency) || 1));
  const burst = Math.max(1, Math.trunc(Number(options.burst) || 1));
  const starvationWaitMs = Math.max(
    0,
    Math.trunc(Number(options.starvationWaitMs) || 0),
  );
  const monotonicNow =
    typeof options.monotonicNow === "function"
      ? options.monotonicNow
      : () => performance.now();
  const nextFairSequence =
    typeof options.nextFairSequence === "function"
      ? options.nextFairSequence
      : null;
  const blockingPriority = Number.isFinite(Number(options.blockingPriority))
    ? Number(options.blockingPriority)
    : 5;
  const kind = String(options.kind ?? "lane");
  const warningPrefix = String(options.warningPrefix ?? `[db:${kind}]`);
  const counterName = String(options.counterName ?? "");
  const fallbackLabel = String(options.fallbackLabel ?? `${kind}_mutation`);

  const runtimeMetrics = options.runtimeMetrics;
  const slowWaitMs = Math.max(0, Math.trunc(Number(options.slowWaitMs) || 0));
  const slowRunMs = Math.max(0, Math.trunc(Number(options.slowRunMs) || 0));
  const clearHotCaches =
    typeof options.clearHotCaches === "function" ? options.clearHotCaches : () => {};
  const recordQueueDepth =
    typeof options.recordQueueDepth === "function" ? options.recordQueueDepth : () => {};
  const scheduleNext =
    typeof options.scheduleNext === "function" ? options.scheduleNext : () => {};
  const onScheduleStart =
    typeof options.onScheduleStart === "function"
      ? options.onScheduleStart
      : () => {};
  const isDbMutationRunning =
    typeof options.isDbMutationRunning === "function"
      ? options.isDbMutationRunning
      : () => false;
  const getDbMutationQueue =
    typeof options.getDbMutationQueue === "function"
      ? options.getDbMutationQueue
      : () => [];
  const hasPeerRunning =
    typeof options.hasPeerRunning === "function" ? options.hasPeerRunning : () => false;
  const getQueuePressureDepth =
    typeof options.getQueuePressureDepth === "function"
      ? options.getQueuePressureDepth
      : () => 0;

  function depth() {
    return queue.length;
  }

  function runningCount() {
    return running;
  }

  function resetBurst() {
    burstCount = 0;
  }

  function hasBlockingDbMutation() {
    return getDbMutationQueue().some((task) => task.priority < blockingPriority);
  }

  function canSchedule() {
    const dbQueue = getDbMutationQueue();
    if (
      !enabled ||
      running >= concurrency ||
      isDbMutationRunning() ||
      hasPeerRunning() ||
      queue.length === 0
    ) {
      return false;
    }
    return canContinueLaneBurst({
      burstCount,
      burstLimit: burst,
      dbQueueDepth: dbQueue.length,
      peerQueueDepth: getQueuePressureDepth(),
      hasBlockingDbMutation: dbQueue.length > 0 && hasBlockingDbMutation(),
    });
  }

  function nextTaskIndex() {
    let priorityIndex = -1;
    let oldestIndex = -1;
    for (let index = 0; index < queue.length; index += 1) {
      const candidate = queue[index];
      const candidateKeys = Array.isArray(candidate.keys)
        ? candidate.keys
        : [candidate.key];
      if (candidateKeys.some((key) => activeKeys.has(key))) continue;
      const priorityTask = priorityIndex >= 0 ? queue[priorityIndex] : null;
      if (
        priorityIndex < 0 ||
        candidate.priority < priorityTask.priority ||
        (candidate.priority === priorityTask.priority &&
          candidate.sequence < priorityTask.sequence)
      ) {
        priorityIndex = index;
      }
      const oldestTask = oldestIndex >= 0 ? queue[oldestIndex] : null;
      if (!oldestTask || candidate.sequence < oldestTask.sequence) {
        oldestIndex = index;
      }
    }
    if (starvationWaitMs > 0 && oldestIndex >= 0) {
      const oldestTask = queue[oldestIndex];
      const waitedMs = Math.max(
        0,
        monotonicNow() - Number(oldestTask.enqueuedMonotonicAt),
      );
      if (waitedMs >= starvationWaitMs) return oldestIndex;
    }
    return priorityIndex;
  }

  function nextTaskMetadata() {
    const selectedIndex = nextTaskIndex();
    if (selectedIndex < 0) return null;
    const task = queue[selectedIndex];
    return {
      enqueuedAt: task.enqueuedAt,
      enqueuedMonotonicAt: task.enqueuedMonotonicAt,
      fairSequence: task.fairSequence,
      label: task.label,
      priority: task.priority,
      sequence: task.sequence,
    };
  }

  function dequeueNextTask() {
    const selectedIndex = nextTaskIndex();
    if (selectedIndex < 0) return null;
    const [task] = queue.splice(selectedIndex, 1);
    return task ?? null;
  }

  function schedule() {
    recordQueueDepth();
    if (!canSchedule()) return false;
    onScheduleStart();
    let startedCount = 0;
    while (running < concurrency) {
      const task = dequeueNextTask();
      if (!task) return startedCount > 0;
      const taskKeys = Array.isArray(task.keys) ? task.keys : [task.key];
      running += 1;
      startedCount += 1;
      taskKeys.forEach((key) => activeKeys.add(key));
      void Promise.resolve()
        .then(async () => {
          const startedAt = monotonicNow();
          const waitMs = Math.max(
            0,
            Math.round(startedAt - task.enqueuedMonotonicAt),
          );
          runtimeMetrics?.recordQueueWait?.(kind, task.metricLabel, waitMs);
          try {
            task.onWait?.(waitMs);
          } catch (error) {
            console.warn(`${warningPrefix} callback attesa fallita per ${task.label}:`, error);
          }
          if (waitMs >= slowWaitMs) {
            console.warn(
              `${warningPrefix} attesa lunga ${waitMs}ms per ${task.label} ` +
                `(coda residua ${queue.length})`,
            );
          }
          try {
            const result = await task.run();
            const runMs = Math.max(0, monotonicNow() - startedAt);
            runtimeMetrics?.recordQueueRun?.(kind, task.metricLabel, runMs);
            if (runMs >= slowRunMs) {
              console.warn(`${warningPrefix} esecuzione lunga ${runMs}ms per ${task.label}`);
            }
            task.resolve(result);
          } catch (error) {
            task.reject(error);
          }
        })
        .finally(() => {
          taskKeys.forEach((key) => activeKeys.delete(key));
          running = Math.max(running - 1, 0);
          burstCount += 1;
          recordQueueDepth();
          scheduleNext();
        });
    }
    return startedCount > 0;
  }

  function enqueue(label, keys, mutator, enqueueOptions = {}) {
    const safeKeys = normalizeLaneKeys(keys);
    if (!enabled || safeKeys.length === 0) {
      return enqueueOptions.fallback();
    }
    const mutationLabel = String(label ?? fallbackLabel).trim() || fallbackLabel;
    const metricLabel =
      String(enqueueOptions.metricLabel ?? mutationLabel).trim() || mutationLabel;
    const priority = Number.isFinite(Number(enqueueOptions.priority))
      ? Number(enqueueOptions.priority)
      : 0;
    const shouldPreserveHotCaches =
      typeof enqueueOptions.shouldPreserveHotCaches === "function"
        ? enqueueOptions.shouldPreserveHotCaches
        : null;
    return new Promise((resolve, reject) => {
      const taskSequence = sequence++;
      queue.push({
        label: mutationLabel,
        metricLabel,
        key: safeKeys[0],
        keys: safeKeys,
        priority,
        sequence: taskSequence,
        enqueuedAt: Date.now(),
        enqueuedMonotonicAt: monotonicNow(),
        fairSequence: nextFairSequence?.() ?? taskSequence,
        onWait:
          typeof enqueueOptions.onWait === "function"
            ? enqueueOptions.onWait
            : null,
        resolve,
        reject,
        run: async () => {
          try {
            const result = await mutator();
            if (!shouldPreserveHotCaches?.()) clearHotCaches();
            return result;
          } catch (error) {
            error.mutationLabel = error.mutationLabel ?? mutationLabel;
            throw error;
          }
        },
      });
      if (counterName) runtimeMetrics?.incrementCounter?.(counterName);
      recordQueueDepth();
      scheduleNext();
    });
  }

  return {
    canSchedule,
    depth,
    enqueue,
    nextTaskMetadata,
    resetBurst,
    runningCount,
    schedule,
  };
}
