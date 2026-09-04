function normalizePriority(value, fallback = 40) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTimestamp(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function dbMutationTaskWaitMs(task, nowMs = Date.now()) {
  return Math.max(
    0,
    normalizeTimestamp(nowMs, Date.now()) -
      normalizeTimestamp(task?.enqueuedAt, normalizeTimestamp(nowMs, Date.now())),
  );
}

export function isDbMutationTaskStarved(task, options = {}) {
  const urgentPriority = normalizePriority(options.urgentPriority, 5);
  const maxWaitMs = Math.max(1, Math.trunc(Number(options.maxWaitMs) || 5_000));
  return (
    normalizePriority(task?.priority) > urgentPriority &&
    dbMutationTaskWaitMs(task, options.nowMs) >= maxWaitMs
  );
}

export function hasUrgentOrStarvedDbMutationTask(queue, options = {}) {
  const urgentPriority = normalizePriority(options.urgentPriority, 5);
  return (Array.isArray(queue) ? queue : []).some(
    (task) =>
      normalizePriority(task?.priority) <= urgentPriority ||
      isDbMutationTaskStarved(task, options),
  );
}

export function hasStrictUrgentDbMutationTask(queue, options = {}) {
  const urgentPriority = normalizePriority(options.urgentPriority, 5);
  return (Array.isArray(queue) ? queue : []).some(
    (task) => normalizePriority(task?.priority) <= urgentPriority,
  );
}

function effectivePriority(task, options = {}) {
  const urgentPriority = normalizePriority(options.urgentPriority, 5);
  return isDbMutationTaskStarved(task, options)
    ? urgentPriority
    : normalizePriority(task?.priority);
}

export function takeNextDbMutationTask(queue, options = {}) {
  if (!Array.isArray(queue) || queue.length === 0) return null;
  let selectedIndex = 0;
  for (let index = 1; index < queue.length; index += 1) {
    const candidate = queue[index];
    const selected = queue[selectedIndex];
    const candidatePriority = effectivePriority(candidate, options);
    const selectedPriority = effectivePriority(selected, options);
    if (
      candidatePriority < selectedPriority ||
      (candidatePriority === selectedPriority &&
        normalizeTimestamp(candidate?.sequence) <
          normalizeTimestamp(selected?.sequence))
    ) {
      selectedIndex = index;
    }
  }
  const [task] = queue.splice(selectedIndex, 1);
  if (!task) return null;
  return {
    task,
    promoted: isDbMutationTaskStarved(task, options),
    waitMs: dbMutationTaskWaitMs(task, options.nowMs),
  };
}
