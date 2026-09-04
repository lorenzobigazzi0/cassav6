export const V6_MAX_HANDHELDS = 25;
export const V6_MAX_STATIONS = 5;
export const V6_OPERATIONS_SCHEDULER_CONTRACT_VERSION = 2;
export const V6_DEVICE_ACTION_INTERVAL_MS = 3_000;
export const V6_COMMAND_AVERAGE_INTERVAL_MS = 7_500;
export const V6_COMMAND_INTERVAL_MIN_MS = 7_000;
export const V6_COMMAND_INTERVAL_MAX_MS = 8_000;
export const V6_COMMAND_CADENCE_JITTER_MS = 10;

export const V6_MOBILE_OPERATION_TYPES = Object.freeze([
  "order.sync.ready",
  "payment.amount_free",
  "table.move",
  "order.correct",
  "notification.ready",
  "workspace.tables_counter_switch",
  "order.sync.delivered",
  "table.group.merge",
  "payment.roman",
  "order.comp",
  "room.change",
  "print.order",
  "order.storno",
  "table.occupancy",
  "reservation.lifecycle",
  "payment.article",
  "order.cancel",
  "table.room_move_request",
  "notification.waiter",
  "order.line_split",
  "counter.collect",
  "table.group.split",
  "payment.single_cash",
  "order.price_override",
  "waiter.pause_resume",
  "print.preconto",
  "order.bar_replacement",
  "search.all",
  "order.transfer.force",
  "payment.single_pos",
  "layout.get",
  "settings.search_history_battery",
  "order.transfer.request_resolve",
  "station.states.get",
]);

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} deve essere un intero positivo.`);
  }
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} deve essere un intero non negativo.`);
  }
  return parsed;
}

export function validateV6OperationsConfig({
  handheldCount,
  stationCount,
  actionsPerDevice,
  actionIntervalMs = V6_DEVICE_ACTION_INTERVAL_MS,
}) {
  const handhelds = nonNegativeInteger(handheldCount, "handheldCount");
  const stations = nonNegativeInteger(stationCount, "stationCount");
  const actions = positiveInteger(actionsPerDevice, "actionsPerDevice");
  const intervalMs = positiveInteger(actionIntervalMs, "actionIntervalMs");
  if (handhelds + stations === 0) {
    throw new Error("Serve almeno un Palmare o una Postazione.");
  }
  if (handhelds > V6_MAX_HANDHELDS) {
    throw new Error(`handheldCount supera il massimo ${V6_MAX_HANDHELDS}.`);
  }
  if (stations > V6_MAX_STATIONS) {
    throw new Error(`stationCount supera il massimo ${V6_MAX_STATIONS}.`);
  }
  if (intervalMs !== V6_DEVICE_ACTION_INTERVAL_MS) {
    throw new Error(
      `actionIntervalMs deve restare ${V6_DEVICE_ACTION_INTERVAL_MS} ms.`,
    );
  }
  return Object.freeze({
    handheldCount: handhelds,
    stationCount: stations,
    actionsPerDevice: actions,
    actionIntervalMs: intervalMs,
  });
}

export function isV6CommandOrdinal(ordinal) {
  const safeOrdinal = positiveInteger(ordinal, "ordinal");
  const position = (safeOrdinal - 1) % 5;
  return position === 0 || position === 2;
}

export function countV6Commands(actionsPerDevice) {
  const total = positiveInteger(actionsPerDevice, "actionsPerDevice");
  const completeCycles = Math.floor(total / 5);
  const remainder = total % 5;
  return (
    completeCycles * 2 + (remainder >= 1 ? 1 : 0) + (remainder >= 3 ? 1 : 0)
  );
}

function nonCommandOrdinal(ordinal) {
  let count = 0;
  for (let current = 1; current <= ordinal; current += 1) {
    if (!isV6CommandOrdinal(current)) count += 1;
  }
  return count;
}

export function v6MobileActionType(deviceIndex, ordinal) {
  const safeDeviceIndex = Math.max(0, Math.trunc(Number(deviceIndex) || 0));
  const safeOrdinal = positiveInteger(ordinal, "ordinal");
  if (isV6CommandOrdinal(safeOrdinal)) return "order.create";
  const operationOrdinal = nonCommandOrdinal(safeOrdinal);
  const offset =
    (safeDeviceIndex * 11 + operationOrdinal - 1) %
    V6_MOBILE_OPERATION_TYPES.length;
  return V6_MOBILE_OPERATION_TYPES[offset];
}

export function v6StationActionType(deviceIndex, ordinal) {
  const types = [
    "station.heartbeat",
    "station.orders.poll",
    "station.order.prep",
    "station.order.ready",
    "station.order.delivered",
    "station.order.transfer",
    "station.print.virtual",
    "station.states.get",
  ];
  const index = Math.max(0, Math.trunc(Number(deviceIndex) || 0));
  const safeOrdinal = positiveInteger(ordinal, "ordinal");
  return types[(index * 3 + safeOrdinal) % types.length];
}

export function calculateV6OperationsSchedule(config) {
  const validated = validateV6OperationsConfig(config);
  const deviceCount = validated.handheldCount + validated.stationCount;
  const phaseStepMs = validated.actionIntervalMs / deviceCount;
  const totalActions = deviceCount * validated.actionsPerDevice;
  return Object.freeze({
    ...validated,
    deviceCount,
    totalActions,
    phaseStepMs,
    aggregateStartsPerSecond:
      (deviceCount * 1_000) / validated.actionIntervalMs,
    minimumStartWindowMs:
      (validated.actionsPerDevice - 1) * validated.actionIntervalMs +
      (deviceCount - 1) * phaseStepMs,
    commandsPerHandheld: countV6Commands(validated.actionsPerDevice),
  });
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

export function summarizeV6OperationsCadence(
  samples,
  actionIntervalMs = V6_DEVICE_ACTION_INTERVAL_MS,
) {
  const grouped = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    const id = String(sample?.deviceId ?? "").trim();
    if (!id) continue;
    const current = grouped.get(id) ?? {
      kind: sample.kind,
      plannedStarts: [],
      plannedCommandStarts: [],
      dispatchStarts: [],
      commandDispatchStarts: [],
    };
    const startedAt = Number(sample.startedAt);
    if (!Number.isFinite(startedAt)) continue;
    const plannedAt = Number(sample.plannedAt);
    const effectivePlannedAt = Number.isFinite(plannedAt) ? plannedAt : startedAt;
    current.plannedStarts.push(effectivePlannedAt);
    current.dispatchStarts.push(startedAt);
    if (sample.actionType === "order.create") {
      current.plannedCommandStarts.push(effectivePlannedAt);
      current.commandDispatchStarts.push(startedAt);
    }
    grouped.set(id, current);
  }

  const deviceSummaries = [];
  const mobileActionGaps = [];
  const commandGaps = [];
  for (const [deviceId, current] of grouped) {
    current.plannedStarts.sort((left, right) => left - right);
    current.plannedCommandStarts.sort((left, right) => left - right);
    current.dispatchStarts.sort((left, right) => left - right);
    current.commandDispatchStarts.sort((left, right) => left - right);
    const plannedActionGaps = current.plannedStarts
      .slice(1)
      .map((value, index) => value - current.plannedStarts[index]);
    const plannedCommandGaps = current.plannedCommandStarts
      .slice(1)
      .map((value, index) => value - current.plannedCommandStarts[index]);
    const dispatchActionGaps = current.dispatchStarts
      .slice(1)
      .map((value, index) => value - current.dispatchStarts[index]);
    const dispatchCommandGaps = current.commandDispatchStarts
      .slice(1)
      .map((value, index) => value - current.commandDispatchStarts[index]);
    if (current.kind === "handheld") {
      mobileActionGaps.push(...dispatchActionGaps);
      commandGaps.push(...dispatchCommandGaps);
    }
    deviceSummaries.push({
      deviceId,
      kind: current.kind,
      actionCount: current.dispatchStarts.length,
      commandCount: current.commandDispatchStarts.length,
      actionAverageGapMs: average(dispatchActionGaps),
      actionMinimumGapMs:
        dispatchActionGaps.length > 0 ? Math.min(...dispatchActionGaps) : null,
      actionGapP05Ms: percentile(dispatchActionGaps, 0.05),
      commandAverageGapMs: average(dispatchCommandGaps),
      earlyActionGaps: dispatchActionGaps.filter(
        (gap) => gap < actionIntervalMs * 0.8,
      ).length,
      plannedActionAverageGapMs: average(plannedActionGaps),
      plannedCommandAverageGapMs: average(plannedCommandGaps),
      dispatchActionAverageGapMs: average(dispatchActionGaps),
      dispatchActionMinimumGapMs:
        dispatchActionGaps.length > 0 ? Math.min(...dispatchActionGaps) : null,
      dispatchCommandAverageGapMs: average(dispatchCommandGaps),
      earlyDispatchActionGaps: dispatchActionGaps.filter(
        (gap) => gap < actionIntervalMs * 0.8,
      ).length,
    });
  }

  const mobileActionAverageGapMs = average(mobileActionGaps);
  const commandAverageGapMs = average(commandGaps);
  const mobileDevices = deviceSummaries.filter(
    (device) => device.kind === "handheld",
  );
  const mobileActionCadenceOk =
    mobileDevices.length > 0 &&
    mobileDevices.every(
      (device) =>
        device.actionAverageGapMs !== null &&
        device.actionAverageGapMs >= actionIntervalMs - 5 &&
        device.actionAverageGapMs <= actionIntervalMs + 300 &&
        device.earlyActionGaps === 0,
    );
  const commandCadenceOk =
    mobileDevices.length > 0 &&
    mobileDevices.every(
      (device) =>
        device.commandAverageGapMs !== null &&
        device.commandAverageGapMs >=
          V6_COMMAND_INTERVAL_MIN_MS - V6_COMMAND_CADENCE_JITTER_MS &&
        device.commandAverageGapMs <=
          V6_COMMAND_INTERVAL_MAX_MS + V6_COMMAND_CADENCE_JITTER_MS,
    );
  return {
    cadenceBasis: "dispatch",
    targetActionIntervalMs: actionIntervalMs,
    targetCommandAverageIntervalMs: V6_COMMAND_AVERAGE_INTERVAL_MS,
    commandCadenceJitterMs: V6_COMMAND_CADENCE_JITTER_MS,
    mobileActionAverageGapMs,
    commandAverageGapMs,
    earlyActionGaps: deviceSummaries.reduce(
      (sum, item) => sum + item.earlyActionGaps,
      0,
    ),
    earlyDispatchActionGaps: deviceSummaries.reduce(
      (sum, item) => sum + item.earlyDispatchActionGaps,
      0,
    ),
    mobileActionCadenceOk,
    commandCadenceOk,
    devices: deviceSummaries,
  };
}

function nextRunnableDevice(devices, maxInFlightPerDevice) {
  return (
    devices
      .filter(
        (device) =>
          device.started < device.target &&
          device.inFlight < maxInFlightPerDevice,
      )
      .sort(
        (left, right) =>
          left.nextDueAt - right.nextDueAt || left.index - right.index,
      )[0] ?? null
  );
}

export async function runV6OperationsSchedule({
  devices,
  actionsPerDevice,
  actionIntervalMs = V6_DEVICE_ACTION_INTERVAL_MS,
  runAction,
  resolveActionType = ({ device, ordinal }) =>
    device.kind === "station"
      ? v6StationActionType(device.index, ordinal)
      : v6MobileActionType(device.index, ordinal),
  now = () => performance.now(),
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  onActionStarted = () => undefined,
  onActionCompleted = () => undefined,
  onProgress = () => undefined,
  progressIntervalMs = 60_000,
  maxInFlightPerDevice = 2,
  maxInFlightGlobal = 60,
  isActionSuccessful = () => true,
}) {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error("Scheduler V6: almeno un device e obbligatorio.");
  }
  if (typeof runAction !== "function") {
    throw new Error("Scheduler V6: runAction deve essere una funzione.");
  }
  if (typeof isActionSuccessful !== "function") {
    throw new Error(
      "Scheduler V6: isActionSuccessful deve essere una funzione.",
    );
  }
  const normalizedMaxInFlightPerDevice = positiveInteger(
    maxInFlightPerDevice,
    "maxInFlightPerDevice",
  );
  const normalizedMaxInFlightGlobal = positiveInteger(
    maxInFlightGlobal,
    "maxInFlightGlobal",
  );
  const handheldCount = devices.filter(
    (device) => device.kind === "handheld",
  ).length;
  const stationCount = devices.filter(
    (device) => device.kind === "station",
  ).length;
  const schedule = calculateV6OperationsSchedule({
    handheldCount,
    stationCount,
    actionsPerDevice,
    actionIntervalMs,
  });
  const startedAt = now();
  const runtimeDevices = devices.map((device, index) => ({
    ...device,
    id: String(device?.id ?? `device-${index + 1}`),
    index: Number.isInteger(device?.index) ? device.index : index,
    scheduleIndex: index,
    target: schedule.actionsPerDevice,
    started: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    inFlight: 0,
    maximumInFlight: 0,
    durationsMs: [],
    nextDueAt: startedAt + index * schedule.phaseStepMs,
  }));
  const inFlight = new Set();
  const samples = [];
  let totalStarted = 0;
  let maximumInFlight = 0;
  let lastProgressAt = startedAt;
  let backpressureWaitCount = 0;
  let backpressureWaitMs = 0;

  let schedulingFailed = false;
  let schedulingError;
  let actionPipelineFailed = false;
  let actionPipelineError;
  try {
    while (totalStarted < schedule.totalActions) {
      if (actionPipelineFailed) throw actionPipelineError;
      const globalCapacityAvailable = inFlight.size < normalizedMaxInFlightGlobal;
      const device = globalCapacityAvailable
        ? nextRunnableDevice(runtimeDevices, normalizedMaxInFlightPerDevice)
        : null;
      if (!device) {
        if (inFlight.size > 0) {
          const waitStartedAt = now();
          backpressureWaitCount += 1;
          await Promise.race(inFlight);
          backpressureWaitMs += Math.max(0, now() - waitStartedAt);
          continue;
        }
        throw new Error(
          "Scheduler V6 bloccato prima di avere pianificato tutte le azioni.",
        );
      }
      const waitMs = device.nextDueAt - now();
      if (waitMs > 0) await wait(Math.ceil(waitMs));
      const actionStartedAt = now();
      device.inFlight += 1;
      device.maximumInFlight = Math.max(device.maximumInFlight, device.inFlight);
      device.started += 1;
      totalStarted += 1;
      const ordinal = device.started;
      const actionType = resolveActionType({ device, ordinal });
      const sequence = totalStarted;
      const sample = {
        sequence,
        deviceId: device.id,
        kind: device.kind,
        ordinal,
        actionType,
        plannedAt: device.nextDueAt,
        startedAt: actionStartedAt,
        startLagMs: Math.max(0, actionStartedAt - device.nextDueAt),
      };
      samples.push(sample);
      // A delayed device resumes from the real dispatch, never from overdue slots.
      device.nextDueAt = actionStartedAt + actionIntervalMs;
      onActionStarted({
        device,
        ordinal,
        actionType,
        totalStarted: sequence,
        totalTarget: schedule.totalActions,
      });

      const promise = Promise.resolve()
        .then(() =>
          runAction({ device, ordinal, actionType, totalStarted: sequence }),
        )
        .then(
          (value) => {
            const ok = isActionSuccessful(value) === true;
            return {
              ok,
              value,
              ...(ok
                ? {}
                : {
                    error: new Error(
                      `Azione ${actionType} completata con esito business negativo.`,
                    ),
                  }),
            };
          },
          (error) => ({ ok: false, error }),
        )
        .then((result) => {
          const durationMs = Math.max(0, now() - actionStartedAt);
          device.completed += 1;
          device.succeeded += result.ok ? 1 : 0;
          device.failed += result.ok ? 0 : 1;
          device.durationsMs.push(durationMs);
          Object.assign(sample, { durationMs, ok: result.ok });
          onActionCompleted({
            device,
            ordinal,
            actionType,
            totalStarted: sequence,
            durationMs,
            ...result,
          });
        })
        .catch((error) => {
          if (!actionPipelineFailed) {
            actionPipelineFailed = true;
            actionPipelineError = error;
          }
        })
        .finally(() => {
          device.inFlight -= 1;
          inFlight.delete(promise);
        });
      inFlight.add(promise);
      maximumInFlight = Math.max(maximumInFlight, inFlight.size);

      if (actionStartedAt - lastProgressAt >= progressIntervalMs) {
        lastProgressAt = actionStartedAt;
        onProgress({
          totalStarted,
          totalTarget: schedule.totalActions,
          elapsedMs: actionStartedAt - startedAt,
          inFlight: inFlight.size,
        });
      }
    }
  } catch (error) {
    schedulingFailed = true;
    schedulingError = error;
  } finally {
    await Promise.allSettled(inFlight);
  }
  if (schedulingFailed) throw schedulingError;
  if (actionPipelineFailed) throw actionPipelineError;
  const endedAt = now();
  return {
    ...schedule,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    totalStarted,
    totalCompleted: runtimeDevices.reduce(
      (sum, device) => sum + device.completed,
      0,
    ),
    totalSucceeded: runtimeDevices.reduce(
      (sum, device) => sum + device.succeeded,
      0,
    ),
    totalFailed: runtimeDevices.reduce((sum, device) => sum + device.failed, 0),
    maximumInFlight,
    backpressure: {
      maxInFlightPerDevice: normalizedMaxInFlightPerDevice,
      maxInFlightGlobal: normalizedMaxInFlightGlobal,
      waitCount: backpressureWaitCount,
      waitMs: backpressureWaitMs,
    },
    cadence: summarizeV6OperationsCadence(samples, actionIntervalMs),
    plannedActionTypes: Object.fromEntries(
      [...new Set(samples.map((sample) => sample.actionType))]
        .sort()
        .map((type) => [
          type,
          samples.filter((sample) => sample.actionType === type).length,
        ]),
    ),
    samples,
    devices: runtimeDevices.map(
      ({ inFlight: pending, nextDueAt, ...device }) => ({
        ...device,
        pendingAtEnd: pending,
      }),
    ),
  };
}
