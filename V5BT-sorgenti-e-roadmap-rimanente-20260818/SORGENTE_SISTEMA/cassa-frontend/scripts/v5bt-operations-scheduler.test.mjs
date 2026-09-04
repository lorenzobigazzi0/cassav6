import assert from "node:assert/strict";
import test from "node:test";
import {
  V5BT_COMMAND_AVERAGE_INTERVAL_MS,
  V5BT_COMMAND_CADENCE_JITTER_MS,
  V5BT_DEVICE_ACTION_INTERVAL_MS,
  V5BT_MAX_HANDHELDS,
  V5BT_MAX_STATIONS,
  V5BT_MOBILE_OPERATION_TYPES,
  calculateV5btOperationsSchedule,
  countV5btCommands,
  isV5btCommandOrdinal,
  runV5btOperationsSchedule,
  summarizeV5btOperationsCadence,
  v5btMobileActionType,
  validateV5btOperationsConfig,
} from "./v5bt-operations-scheduler.mjs";

test("il profilo ammette al massimo 25 Palmare e 5 Postazioni", () => {
  assert.deepEqual(
    validateV5btOperationsConfig({
      handheldCount: 25,
      stationCount: 5,
      actionsPerDevice: 200,
    }),
    {
      handheldCount: 25,
      stationCount: 5,
      actionsPerDevice: 200,
      actionIntervalMs: 3_000,
    },
  );
  assert.throws(
    () =>
      validateV5btOperationsConfig({
        handheldCount: 26,
        stationCount: 5,
        actionsPerDevice: 200,
      }),
    /massimo 25/,
  );
  assert.throws(
    () =>
      validateV5btOperationsConfig({
        handheldCount: 25,
        stationCount: 6,
        actionsPerDevice: 200,
      }),
    /massimo 5/,
  );
  assert.equal(V5BT_MAX_HANDHELDS, 25);
  assert.equal(V5BT_MAX_STATIONS, 5);
});

test("il profilo ammette una sola categoria di device ma non zero device", () => {
  assert.deepEqual(
    validateV5btOperationsConfig({
      handheldCount: 8,
      stationCount: 0,
      actionsPerDevice: 20,
    }),
    {
      handheldCount: 8,
      stationCount: 0,
      actionsPerDevice: 20,
      actionIntervalMs: 3_000,
    },
  );
  const handheldOnlySchedule = calculateV5btOperationsSchedule({
    handheldCount: 8,
    stationCount: 0,
    actionsPerDevice: 20,
  });
  assert.equal(handheldOnlySchedule.deviceCount, 8);
  assert.equal(handheldOnlySchedule.totalActions, 160);
  assert.equal(handheldOnlySchedule.phaseStepMs, 375);
  assert.equal(handheldOnlySchedule.commandsPerHandheld, 8);
  assert.deepEqual(
    validateV5btOperationsConfig({
      handheldCount: 0,
      stationCount: 5,
      actionsPerDevice: 20,
    }),
    {
      handheldCount: 0,
      stationCount: 5,
      actionsPerDevice: 20,
      actionIntervalMs: 3_000,
    },
  );
  assert.throws(
    () =>
      validateV5btOperationsConfig({
        handheldCount: 0,
        stationCount: 0,
        actionsPerDevice: 20,
      }),
    /almeno un Palmare o una Postazione/,
  );
});

test("la cadenza comande alterna 6 e 9 secondi per una media di 7,5", () => {
  const ordinals = Array.from({ length: 20 }, (_, index) => index + 1).filter(
    isV5btCommandOrdinal,
  );
  assert.deepEqual(ordinals, [1, 3, 6, 8, 11, 13, 16, 18]);
  assert.equal(countV5btCommands(200), 80);
  const starts = ordinals.map(
    (ordinal) => (ordinal - 1) * V5BT_DEVICE_ACTION_INTERVAL_MS,
  );
  const gaps = starts.slice(1).map((value, index) => value - starts[index]);
  assert.deepEqual(
    gaps.slice(0, 6),
    [6_000, 9_000, 6_000, 9_000, 6_000, 9_000],
  );
  const fullStarts = Array.from({ length: 200 }, (_, index) => index + 1)
    .filter(isV5btCommandOrdinal)
    .map((ordinal) => (ordinal - 1) * V5BT_DEVICE_ACTION_INTERVAL_MS);
  const fullGaps = fullStarts
    .slice(1)
    .map((value, index) => value - fullStarts[index]);
  const averageMs =
    fullGaps.reduce((sum, value) => sum + value, 0) / fullGaps.length;
  assert.equal(Math.round(averageMs), 7_481);
  assert.ok(Math.abs(averageMs - V5BT_COMMAND_AVERAGE_INTERVAL_MS) < 25);
});

test("il piano 25+5 produce 10 start al secondo e 3 secondi per device", () => {
  const schedule = calculateV5btOperationsSchedule({
    handheldCount: 25,
    stationCount: 5,
    actionsPerDevice: 200,
  });
  assert.equal(schedule.deviceCount, 30);
  assert.equal(schedule.totalActions, 6_000);
  assert.equal(schedule.aggregateStartsPerSecond, 10);
  assert.equal(schedule.phaseStepMs, 100);
  assert.equal(schedule.commandsPerHandheld, 80);
});

test("il catalogo operativo viene interamente pianificato", () => {
  const planned = new Set();
  for (let device = 0; device < 25; device += 1) {
    for (let ordinal = 1; ordinal <= 200; ordinal += 1) {
      planned.add(v5btMobileActionType(device, ordinal));
    }
  }
  assert.equal(planned.has("order.create"), true);
  for (const type of V5BT_MOBILE_OPERATION_TYPES)
    assert.equal(planned.has(type), true, type);

  const microPlanned = new Set();
  for (let device = 0; device < 25; device += 1) {
    for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
      microPlanned.add(v5btMobileActionType(device, ordinal));
    }
  }
  assert.equal(microPlanned.has("order.create"), true);
  for (const type of V5BT_MOBILE_OPERATION_TYPES) {
    assert.equal(microPlanned.has(type), true, `micro: ${type}`);
  }

  for (let device = 0; device < 25; device += 1) {
    const paymentActions = Array.from({ length: 10 }, (_, index) =>
      v5btMobileActionType(device, index + 1),
    ).filter((type) => type.startsWith("payment."));
    assert.ok(
      paymentActions.length <= 1,
      `mobile-${device + 1}: ${paymentActions}`,
    );
  }
});

test("il riepilogo distingue cadenza azioni e cadenza comande", () => {
  const samples = [];
  for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
    samples.push({
      deviceId: "mobile-1",
      kind: "handheld",
      ordinal,
      actionType: v5btMobileActionType(0, ordinal),
      startedAt: (ordinal - 1) * 3_000,
    });
  }
  const summary = summarizeV5btOperationsCadence(samples);
  assert.equal(summary.mobileActionAverageGapMs, 3_000);
  assert.equal(Math.round(summary.commandAverageGapMs), 7_286);
  assert.equal(summary.mobileActionCadenceOk, true);
  assert.equal(summary.commandCadenceOk, true);
  assert.equal(summary.earlyActionGaps, 0);
  assert.equal(summary.cadenceBasis, "dispatch");
});

test("il riepilogo valuta il dispatch reale e conserva il piano come diagnostica", () => {
  const summary = summarizeV5btOperationsCadence([
    {
      deviceId: "mobile-1",
      kind: "handheld",
      actionType: "layout.get",
      plannedAt: 0,
      startedAt: 1_000,
    },
    {
      deviceId: "mobile-1",
      kind: "handheld",
      actionType: "layout.get",
      plannedAt: 3_000,
      startedAt: 3_000,
    },
  ]);

  assert.equal(summary.cadenceBasis, "dispatch");
  assert.equal(summary.mobileActionAverageGapMs, 2_000);
  assert.equal(summary.devices[0].plannedActionAverageGapMs, 3_000);
  assert.equal(summary.earlyActionGaps, 1);
  assert.equal(summary.earlyDispatchActionGaps, 1);
  assert.equal(summary.mobileActionCadenceOk, false);
});

test("il riepilogo distingue il jitter normale da una raffica anticipata", () => {
  const jitter = summarizeV5btOperationsCadence([
    {
      deviceId: "mobile-1",
      kind: "handheld",
      actionType: "layout.get",
      startedAt: 0,
    },
    {
      deviceId: "mobile-1",
      kind: "handheld",
      actionType: "layout.get",
      startedAt: 2_998,
    },
  ]);
  const burst = summarizeV5btOperationsCadence([
    {
      deviceId: "mobile-1",
      kind: "handheld",
      actionType: "layout.get",
      startedAt: 0,
    },
    {
      deviceId: "mobile-1",
      kind: "handheld",
      actionType: "layout.get",
      startedAt: 2_000,
    },
  ]);
  assert.equal(jitter.earlyActionGaps, 0);
  assert.equal(burst.earlyActionGaps, 1);
  assert.equal(jitter.mobileActionCadenceOk, true);
  assert.equal(burst.mobileActionCadenceOk, false);
  assert.equal(burst.devices[0].actionMinimumGapMs, 2_000);
});

test("la cadenza comande ammette solo 10 ms di jitter del timer", () => {
  const summarize = (lastStart) =>
    summarizeV5btOperationsCadence([
      {
        deviceId: "mobile-1",
        kind: "handheld",
        actionType: "order.create",
        startedAt: 0,
      },
      {
        deviceId: "mobile-1",
        kind: "handheld",
        actionType: "order.create",
        startedAt: lastStart,
      },
    ]);
  assert.equal(V5BT_COMMAND_CADENCE_JITTER_MS, 10);
  assert.equal(summarize(8_010).commandCadenceOk, true);
  assert.equal(summarize(8_011).commandCadenceOk, false);
  assert.equal(summarize(6_990).commandCadenceOk, true);
  assert.equal(summarize(6_989).commandCadenceOk, false);
});

test("lo scheduler mantiene la quota senza sovrapporre azioni veloci dello stesso device", async () => {
  let clock = 0;
  const active = new Set();
  const result = await runV5btOperationsSchedule({
    devices: [
      { id: "mobile-1", kind: "handheld", index: 0 },
      { id: "station-1", kind: "station", index: 0 },
    ],
    actionsPerDevice: 8,
    now: () => clock,
    wait: async (delayMs) => {
      clock += delayMs;
    },
    runAction: async ({ device }) => {
      assert.equal(active.has(device.id), false);
      active.add(device.id);
      active.delete(device.id);
    },
  });
  assert.equal(result.totalStarted, 16);
  assert.equal(result.totalCompleted, 16);
  assert.equal(result.totalFailed, 0);
  assert.equal(
    result.devices.every((device) => device.completed === 8),
    true,
  );
});

test("lo scheduler mantiene la cadenza di dispatch anche con una risposta ancora pendente", async () => {
  let clock = 0;
  let releaseFirstAction;
  const starts = [];
  const scheduled = runV5btOperationsSchedule({
    devices: [
      { id: "mobile-1", kind: "handheld", index: 0 },
      { id: "station-1", kind: "station", index: 0 },
    ],
    actionsPerDevice: 2,
    now: () => clock,
    wait: async (delayMs) => {
      clock += delayMs;
    },
    runAction: async ({ device, ordinal }) => {
      starts.push(`${device.id}:${ordinal}`);
      if (device.id === "mobile-1" && ordinal === 1) {
        await new Promise((resolve) => {
          releaseFirstAction = resolve;
        });
      }
    },
  });

  for (
    let attempt = 0;
    attempt < 20 && !starts.includes("mobile-1:2");
    attempt += 1
  ) {
    await Promise.resolve();
  }
  assert.equal(starts.includes("mobile-1:2"), true);
  releaseFirstAction();
  const result = await scheduled;
  const mobile = result.devices.find((device) => device.id === "mobile-1");
  assert.equal(mobile.maximumInFlight, 2);
  assert.equal(result.cadence.mobileActionAverageGapMs, 3_000);
});

test("lo scheduler applica il backpressure senza recuperare slot in raffica", async () => {
  let clock = 0;
  const releases = [];
  const starts = [];
  const scheduled = runV5btOperationsSchedule({
    devices: [
      { id: "mobile-1", kind: "handheld", index: 0 },
      { id: "station-1", kind: "station", index: 0 },
    ],
    actionsPerDevice: 4,
    maxInFlightPerDevice: 2,
    now: () => clock,
    wait: async (delayMs) => {
      clock += delayMs;
    },
    runAction: async ({ device, ordinal }) => {
      starts.push(`${device.id}:${ordinal}`);
      if (device.kind === "handheld" && ordinal <= 2) {
        await new Promise((resolve) => releases.push(resolve));
      }
    },
  });

  for (let attempt = 0; attempt < 30 && releases.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(releases.length, 2);
  assert.equal(starts.includes("mobile-1:3"), false);
  clock += 10_000;
  releases.shift()();
  for (
    let attempt = 0;
    attempt < 30 && !starts.includes("mobile-1:3");
    attempt += 1
  ) {
    await Promise.resolve();
  }
  assert.equal(starts.includes("mobile-1:3"), true);
  releases.shift()();

  const result = await scheduled;
  assert.equal(result.maximumInFlight <= 4, true);
  assert.equal(
    result.devices.every((device) => device.maximumInFlight <= 2),
    true,
  );
  assert.equal(result.backpressure.waitCount > 0, true);
  const mobileStarts = result.samples
    .filter((sample) => sample.deviceId === "mobile-1")
    .map((sample) => sample.startedAt);
  const mobileGaps = mobileStarts
    .slice(1)
    .map((value, index) => value - mobileStarts[index]);
  assert.equal(result.cadence.cadenceBasis, "dispatch");
  assert.equal(mobileGaps.every((gap) => gap >= 3_000), true);
  assert.equal(result.cadence.earlyActionGaps, 0);
  assert.equal(result.cadence.earlyDispatchActionGaps, 0);
});

test("lo scheduler distingue una Promise risolta da un esito business riuscito", async () => {
  let clock = 0;
  const result = await runV5btOperationsSchedule({
    devices: [
      { id: "mobile-1", kind: "handheld", index: 0 },
      { id: "station-1", kind: "station", index: 0 },
    ],
    actionsPerDevice: 1,
    now: () => clock,
    wait: async (delayMs) => {
      clock += delayMs;
    },
    runAction: async ({ device }) => ({
      operationOk: device.kind === "station",
    }),
    isActionSuccessful: (value) => value?.operationOk === true,
  });

  assert.equal(result.totalCompleted, 2);
  assert.equal(result.totalSucceeded, 1);
  assert.equal(result.totalFailed, 1);
});

test("un abort durante l'attesa drena le azioni gia avviate prima di essere rilanciato", async () => {
  const abortError = new Error("workload aborted");
  abortError.name = "AbortError";
  let releaseAction;
  let actionStarted;
  let actionCompleted = false;
  const started = new Promise((resolve) => {
    actionStarted = resolve;
  });

  const scheduled = runV5btOperationsSchedule({
    devices: [
      { id: "mobile-1", kind: "handheld", index: 0 },
      { id: "mobile-2", kind: "handheld", index: 1 },
    ],
    actionsPerDevice: 1,
    now: () => 0,
    wait: async () => {
      throw abortError;
    },
    runAction: async () => {
      actionStarted();
      await new Promise((resolve) => {
        releaseAction = resolve;
      });
    },
    onActionCompleted: () => {
      actionCompleted = true;
    },
  });
  let schedulerSettled = false;
  const observed = scheduled.then(
    (value) => {
      schedulerSettled = true;
      return value;
    },
    (error) => {
      schedulerSettled = true;
      throw error;
    },
  );

  await started;
  await Promise.resolve();
  assert.equal(schedulerSettled, false);
  assert.equal(actionCompleted, false);

  releaseAction();
  await assert.rejects(observed, (error) => error === abortError);
  assert.equal(actionCompleted, true);
});

test("un errore di pianificazione drena le azioni pendenti e conserva l'errore originale", async () => {
  const planningError = new Error("action type resolution failed");
  let releaseAction;
  let actionStarted;
  let completedActions = 0;
  const started = new Promise((resolve) => {
    actionStarted = resolve;
  });

  const scheduled = runV5btOperationsSchedule({
    devices: [
      { id: "mobile-1", kind: "handheld", index: 0 },
      { id: "mobile-2", kind: "handheld", index: 1 },
    ],
    actionsPerDevice: 1,
    now: () => 0,
    wait: async () => undefined,
    resolveActionType: ({ device }) => {
      if (device.id === "mobile-2") throw planningError;
      return "layout.get";
    },
    runAction: async () => {
      actionStarted();
      await new Promise((resolve) => {
        releaseAction = resolve;
      });
    },
    onActionCompleted: () => {
      completedActions += 1;
    },
  });
  let schedulerSettled = false;
  const observed = scheduled.then(
    (value) => {
      schedulerSettled = true;
      return value;
    },
    (error) => {
      schedulerSettled = true;
      throw error;
    },
  );

  await started;
  await Promise.resolve();
  assert.equal(schedulerSettled, false);

  releaseAction();
  await assert.rejects(observed, (error) => error === planningError);
  assert.equal(completedActions, 1);
});

test("anche un valore di errore falsy viene rilanciato dopo il drain", async () => {
  let releaseAction;
  let actionStarted;
  const started = new Promise((resolve) => {
    actionStarted = resolve;
  });

  const scheduled = runV5btOperationsSchedule({
    devices: [
      { id: "mobile-1", kind: "handheld", index: 0 },
      { id: "mobile-2", kind: "handheld", index: 1 },
    ],
    actionsPerDevice: 1,
    now: () => 0,
    wait: async () => {
      throw null;
    },
    runAction: async () => {
      actionStarted();
      await new Promise((resolve) => {
        releaseAction = resolve;
      });
    },
  });
  let schedulerSettled = false;
  const observed = scheduled.then(
    (value) => {
      schedulerSettled = true;
      return value;
    },
    (error) => {
      schedulerSettled = true;
      throw error;
    },
  );

  await started;
  await Promise.resolve();
  assert.equal(schedulerSettled, false);

  releaseAction();
  await assert.rejects(observed, (error) => error === null);
});

test("un errore nella pipeline di completamento attende le altre azioni prima di essere rilanciato", async () => {
  const completionError = new Error("completion callback failed");
  let clock = 0;
  let releaseSecondAction;
  let secondActionStarted;
  const secondStarted = new Promise((resolve) => {
    secondActionStarted = resolve;
  });

  const scheduled = runV5btOperationsSchedule({
    devices: [
      { id: "mobile-1", kind: "handheld", index: 0 },
      { id: "mobile-2", kind: "handheld", index: 1 },
    ],
    actionsPerDevice: 1,
    now: () => clock,
    wait: async (delayMs) => {
      clock += delayMs;
    },
    runAction: async ({ device }) => {
      if (device.id !== "mobile-2") return;
      secondActionStarted();
      await new Promise((resolve) => {
        releaseSecondAction = resolve;
      });
    },
    onActionCompleted: ({ device }) => {
      if (device.id === "mobile-1") throw completionError;
    },
  });
  let schedulerSettled = false;
  const observed = scheduled.then(
    (value) => {
      schedulerSettled = true;
      return value;
    },
    (error) => {
      schedulerSettled = true;
      throw error;
    },
  );

  await secondStarted;
  await Promise.resolve();
  assert.equal(schedulerSettled, false);

  releaseSecondAction();
  await assert.rejects(observed, (error) => error === completionError);
});
