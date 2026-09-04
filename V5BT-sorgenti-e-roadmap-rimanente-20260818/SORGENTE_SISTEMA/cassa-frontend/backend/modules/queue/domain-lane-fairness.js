function depth(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function enabled(value) {
  return value !== false;
}

export function canContinueLaneBurst({
  burstCount,
  burstLimit,
  dbQueueDepth = 0,
  peerQueueDepth = 0,
  hasBlockingDbMutation = false,
} = {}) {
  if (hasBlockingDbMutation) return false;
  if (depth(dbQueueDepth) === 0 && depth(peerQueueDepth) === 0) return true;
  return depth(burstCount) < Math.max(1, depth(burstLimit));
}

function finiteOrder(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function selectOldestSchedulableLane(candidates = []) {
  let selected = null;
  for (const [index, candidate] of (Array.isArray(candidates)
    ? candidates
    : []
  ).entries()) {
    if (!candidate || candidate.canSchedule !== true) continue;
    const fairSequence = finiteOrder(candidate.fairSequence);
    if (fairSequence === null) continue;
    const priority = Number.isFinite(Number(candidate.priority))
      ? Number(candidate.priority)
      : Number.MAX_SAFE_INTEGER;
    const normalized = { ...candidate, fairSequence, priority, index };
    if (
      !selected ||
      normalized.fairSequence < selected.fairSequence ||
      (normalized.fairSequence === selected.fairSequence &&
        normalized.priority < selected.priority) ||
      (normalized.fairSequence === selected.fairSequence &&
        normalized.priority === selected.priority &&
        normalized.index < selected.index)
    ) {
      selected = normalized;
    }
  }
  return selected;
}

export function selectHybridSchedulableLane(candidates = [], options = {}) {
  const nowMonotonicMs = Number(options.nowMonotonicMs);
  const starvationWaitMs = Math.max(
    1,
    Math.trunc(Number(options.starvationWaitMs) || 1),
  );
  const schedulable = (Array.isArray(candidates) ? candidates : [])
    .map((candidate, index) => {
      if (!candidate || candidate.canSchedule !== true) return null;
      const enqueuedMonotonicAt = Number(candidate.enqueuedMonotonicAt);
      const waitMs =
        Number.isFinite(nowMonotonicMs) && Number.isFinite(enqueuedMonotonicAt)
          ? Math.max(0, nowMonotonicMs - enqueuedMonotonicAt)
          : 0;
      return {
        ...candidate,
        index,
        normalPriority: Number.isFinite(Number(candidate.normalPriority))
          ? Number(candidate.normalPriority)
          : Number.MAX_SAFE_INTEGER,
        priority: Number.isFinite(Number(candidate.priority))
          ? Number(candidate.priority)
          : Number.MAX_SAFE_INTEGER,
        waitMs,
      };
    })
    .filter(Boolean);
  if (schedulable.length === 0) return null;

  const promoted =
    options.allowAgedPromotion === false
      ? null
      : selectOldestSchedulableLane(
          schedulable.filter(
            (candidate) => candidate.waitMs >= starvationWaitMs,
          ),
        );
  if (promoted) {
    return {
      ...promoted,
      promoted: true,
      selectionReason: "aged",
    };
  }

  let selected = schedulable[0];
  for (const candidate of schedulable.slice(1)) {
    if (
      candidate.normalPriority < selected.normalPriority ||
      (candidate.normalPriority === selected.normalPriority &&
        candidate.priority < selected.priority) ||
      (candidate.normalPriority === selected.normalPriority &&
        candidate.priority === selected.priority &&
        candidate.index < selected.index)
    ) {
      selected = candidate;
    }
  }
  return {
    ...selected,
    promoted: false,
    selectionReason: "normal",
  };
}

export function domainLanePairConflicts(left, right, flags = {}) {
  const first = String(left ?? "").trim();
  const second = String(right ?? "").trim();
  if (!first || !second || first === second) return false;
  const pair = new Set([first, second]);
  if (pair.has("payment")) return enabled(flags.payments);
  if (pair.has("order")) {
    const peer = first === "order" ? second : first;
    if (["room", "reservation", "notification"].includes(peer)) {
      return enabled(flags.orders);
    }
    return peer === "stationState" && enabled(flags.presence);
  }
  const roomLike = ["room", "reservation", "notification"];
  if (roomLike.includes(first) && roomLike.includes(second)) {
    return enabled(flags.tables);
  }
  const presence = ["waiterPause", "stationState"];
  return (
    ((presence.includes(first) && roomLike.includes(second)) ||
      (presence.includes(second) && roomLike.includes(first))) &&
    enabled(flags.presence)
  );
}

export function selectIdlePeerLaneIds(target, lanes = [], flags = {}) {
  const safeTarget = String(target ?? "").trim();
  return (Array.isArray(lanes) ? lanes : [])
    .filter((lane) => {
      const id = String(lane?.id ?? "").trim();
      const runningCount = Number(lane?.runningCount);
      return (
        id &&
        id !== safeTarget &&
        domainLanePairConflicts(safeTarget, id, flags) &&
        Number.isFinite(runningCount) &&
        runningCount <= 0
      );
    })
    .map((lane) => String(lane.id).trim());
}

export function isDomainLaneSchedulerDrained({
  queueDepth = 0,
  runningCount = 0,
} = {}) {
  return depth(queueDepth) === 0 && depth(runningCount) === 0;
}

export function getLanePeerQueuePressureDepth(
  target,
  depths = {},
  flags = {},
) {
  const queue = {
    order: depth(depths.order),
    payment: depth(depths.payment),
    room: depth(depths.room),
    reservation: depth(depths.reservation),
    notification: depth(depths.notification),
    waiterPause: depth(depths.waiterPause),
    stationState: depth(depths.stationState),
  };
  const safeTarget = String(target ?? "").trim();
  if (!Object.hasOwn(queue, safeTarget)) return 0;
  return Object.entries(queue).reduce(
    (total, [peerId, peerDepth]) =>
      total +
      (domainLanePairConflicts(safeTarget, peerId, flags) ? peerDepth : 0),
    0,
  );
}
