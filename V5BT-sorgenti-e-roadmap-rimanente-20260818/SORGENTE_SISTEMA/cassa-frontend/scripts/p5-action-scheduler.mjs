const DEFAULT_WINDOW_MS = 1_000;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  return Math.max(1, Math.trunc(positiveNumber(value, fallback)));
}

export function calculateP5Schedule({
  deviceCount,
  actionsPerDevice,
  actionsPerSecond,
}) {
  const safeDeviceCount = positiveInteger(deviceCount, 1);
  const safeActionsPerDevice = positiveInteger(actionsPerDevice, 1);
  const safeActionsPerSecond = positiveInteger(actionsPerSecond, 1);
  const totalActions = safeDeviceCount * safeActionsPerDevice;
  const startIntervalMs = Math.ceil(DEFAULT_WINDOW_MS / safeActionsPerSecond);
  return {
    deviceCount: safeDeviceCount,
    actionsPerDevice: safeActionsPerDevice,
    actionsPerSecond: safeActionsPerSecond,
    totalActions,
    minimumStartWindowMs: (totalActions - 1) * startIntervalMs + 1,
    startIntervalMs,
  };
}

export function p5ActionSlotOffsetMs(actionIndex, actionsPerSecond = 3) {
  const safeIndex = Math.max(0, Math.trunc(Number(actionIndex) || 0));
  const rate = positiveInteger(actionsPerSecond, 3);
  return safeIndex * Math.ceil(DEFAULT_WINDOW_MS / rate);
}

export function summarizeP5ActionStarts(
  timestamps,
  { actionsPerSecond = 3, windowMs = DEFAULT_WINDOW_MS } = {},
) {
  const limit = positiveInteger(actionsPerSecond, 3);
  const safeWindowMs = positiveNumber(windowMs, DEFAULT_WINDOW_MS);
  const starts = (Array.isArray(timestamps) ? timestamps : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const fixedWindows = new Map();
  let slidingStart = 0;
  let maxSlidingWindow = 0;
  let minimumGapMs = null;

  for (let index = 0; index < starts.length; index += 1) {
    const timestamp = starts[index];
    const fixedKey = Math.floor(timestamp / safeWindowMs);
    fixedWindows.set(fixedKey, (fixedWindows.get(fixedKey) ?? 0) + 1);
    while (
      slidingStart < index &&
      timestamp - starts[slidingStart] >= safeWindowMs
    ) {
      slidingStart += 1;
    }
    maxSlidingWindow = Math.max(maxSlidingWindow, index - slidingStart + 1);
    if (index > 0) {
      const gapMs = timestamp - starts[index - 1];
      minimumGapMs = minimumGapMs === null ? gapMs : Math.min(minimumGapMs, gapMs);
    }
  }

  const fixedWindowCounts = [...fixedWindows.values()];
  const maxFixedWindow = fixedWindowCounts.length
    ? Math.max(...fixedWindowCounts)
    : 0;
  const durationMs = starts.length > 1 ? starts.at(-1) - starts[0] : 0;
  const effectiveActionsPerSecond = durationMs > 0
    ? ((starts.length - 1) * DEFAULT_WINDOW_MS) / durationMs
    : starts.length;

  return {
    count: starts.length,
    windowMs: safeWindowMs,
    limit,
    maxFixedWindow,
    maxSlidingWindow,
    minimumGapMs,
    durationMs,
    effectiveActionsPerSecond,
    fixedWindowViolations: fixedWindowCounts.filter((count) => count > limit).length,
    slidingWindowViolation: maxSlidingWindow > limit,
    ok: maxFixedWindow <= limit && maxSlidingWindow <= limit,
  };
}

function nextAvailableDevice(devices, cursor) {
  for (let offset = 0; offset < devices.length; offset += 1) {
    const index = (cursor + offset) % devices.length;
    const device = devices[index];
    if (device.started < device.target && device.active !== true) {
      return { device, index, nextCursor: (index + 1) % devices.length };
    }
  }
  return null;
}

export async function runP5ActionSchedule({
  devices,
  actionsPerDevice = 1_000,
  actionsPerSecond = 3,
  runAction,
  now = () => performance.now(),
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  onActionStarted = () => undefined,
  onActionCompleted = () => undefined,
  onProgress = () => undefined,
  progressIntervalMs = 60_000,
}) {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error("P5 scheduler: almeno un device e obbligatorio.");
  }
  if (typeof runAction !== "function") {
    throw new Error("P5 scheduler: runAction deve essere una funzione.");
  }

  const schedule = calculateP5Schedule({
    deviceCount: devices.length,
    actionsPerDevice,
    actionsPerSecond,
  });
  const runtimeDevices = devices.map((device, index) => ({
    ...device,
    id: String(device?.id ?? `device-${index + 1}`),
    index,
    target: schedule.actionsPerDevice,
    started: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    active: false,
    durationsMs: [],
  }));
  const inFlight = new Set();
  const startTimestamps = [];
  const startedAt = now();
  let scheduleDelayMs = 0;
  let lastProgressAt = startedAt;
  let cursor = 0;
  let totalStarted = 0;

  while (totalStarted < schedule.totalActions) {
    let selected = nextAvailableDevice(runtimeDevices, cursor);
    if (!selected) {
      if (inFlight.size === 0) {
        throw new Error("P5 scheduler bloccato senza azioni in esecuzione.");
      }
      await Promise.race(inFlight);
      continue;
    }

    const slotOffsetMs = p5ActionSlotOffsetMs(
      totalStarted,
      schedule.actionsPerSecond,
    );
    const plannedStartAt = startedAt + slotOffsetMs + scheduleDelayMs;
    const waitMs = plannedStartAt - now();
    if (waitMs > 0) await wait(Math.ceil(waitMs));
    const actualStartedAt = now();
    if (actualStartedAt > plannedStartAt) {
      scheduleDelayMs += actualStartedAt - plannedStartAt;
    }

    const { device } = selected;
    cursor = selected.nextCursor;
    device.active = true;
    device.started += 1;
    totalStarted += 1;
    const actionSequence = totalStarted;
    const ordinal = device.started;
    const relativeStartedAt = actualStartedAt - startedAt;
    startTimestamps.push(relativeStartedAt);
    onActionStarted({
      device,
      ordinal,
      totalStarted: actionSequence,
      totalTarget: schedule.totalActions,
      startedAt: actualStartedAt,
      relativeStartedAt,
    });

    const promise = Promise.resolve()
      .then(() => runAction({ device, ordinal, totalStarted: actionSequence }))
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      )
      .then((result) => {
        const completedAt = now();
        const durationMs = Math.max(0, completedAt - actualStartedAt);
        device.completed += 1;
        device.succeeded += result.ok ? 1 : 0;
        device.failed += result.ok ? 0 : 1;
        device.durationsMs.push(durationMs);
        onActionCompleted({
          device,
          ordinal,
          totalStarted: actionSequence,
          completedAt,
          durationMs,
          ...result,
        });
      })
      .finally(() => {
        device.active = false;
        inFlight.delete(promise);
      });
    inFlight.add(promise);

    if (actualStartedAt - lastProgressAt >= progressIntervalMs) {
      lastProgressAt = actualStartedAt;
      onProgress({
        totalStarted,
        totalTarget: schedule.totalActions,
        elapsedMs: actualStartedAt - startedAt,
        inFlight: inFlight.size,
        devices: runtimeDevices,
      });
    }
  }

  await Promise.allSettled(inFlight);
  const endedAt = now();
  const rate = summarizeP5ActionStarts(startTimestamps, {
    actionsPerSecond: schedule.actionsPerSecond,
  });
  return {
    ...schedule,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    totalStarted,
    totalCompleted: runtimeDevices.reduce((sum, device) => sum + device.completed, 0),
    totalSucceeded: runtimeDevices.reduce((sum, device) => sum + device.succeeded, 0),
    totalFailed: runtimeDevices.reduce((sum, device) => sum + device.failed, 0),
    scheduleDelayMs,
    rate,
    devices: runtimeDevices.map(({ active, ...device }) => device),
  };
}
