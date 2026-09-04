import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateP5Schedule,
  p5ActionSlotOffsetMs,
  runP5ActionSchedule,
  summarizeP5ActionStarts,
} from "./p5-action-scheduler.mjs";

function virtualClock() {
  let value = 0;
  return {
    now: () => value,
    wait: async (delayMs) => {
      value += Math.max(0, Number(delayMs) || 0);
    },
  };
}

test("calcola 25000 azioni e la durata minima a 3 azioni al secondo", () => {
  const schedule = calculateP5Schedule({
    deviceCount: 25,
    actionsPerDevice: 1_000,
    actionsPerSecond: 3,
  });
  assert.equal(schedule.totalActions, 25_000);
  assert.equal(schedule.minimumStartWindowMs, 8_349_667);
  assert.equal(schedule.startIntervalMs, 334);
});

test("usa tre slot interi e non recupera con burst al secondo successivo", () => {
  assert.deepEqual(
    Array.from({ length: 7 }, (_, index) => p5ActionSlotOffsetMs(index, 3)),
    [0, 334, 668, 1_002, 1_336, 1_670, 2_004],
  );
});

test("distribuisce la stessa quota a ogni device senza superare 3 azioni al secondo", async () => {
  const clock = virtualClock();
  const starts = [];
  const result = await runP5ActionSchedule({
    devices: Array.from({ length: 5 }, (_, index) => ({ id: `device-${index + 1}` })),
    actionsPerDevice: 20,
    actionsPerSecond: 3,
    now: clock.now,
    wait: clock.wait,
    runAction: async () => undefined,
    onActionStarted: ({ device, ordinal, relativeStartedAt }) => {
      starts.push({ deviceId: device.id, ordinal, relativeStartedAt });
    },
  });

  assert.equal(result.totalStarted, 100);
  assert.equal(result.totalCompleted, 100);
  assert.equal(result.totalFailed, 0);
  assert.equal(result.rate.ok, true);
  assert.ok(result.rate.maxFixedWindow <= 3);
  assert.ok(result.rate.maxSlidingWindow <= 3);
  assert.deepEqual(result.devices.map((device) => device.started), [20, 20, 20, 20, 20]);
  assert.deepEqual(result.devices.map((device) => device.completed), [20, 20, 20, 20, 20]);
  assert.equal(new Set(starts.map((entry) => `${entry.deviceId}:${entry.ordinal}`)).size, 100);
});

test("registra i fallimenti senza interrompere le quote successive", async () => {
  const clock = virtualClock();
  const result = await runP5ActionSchedule({
    devices: [{ id: "mobile-1" }, { id: "station-1" }],
    actionsPerDevice: 4,
    actionsPerSecond: 3,
    now: clock.now,
    wait: clock.wait,
    runAction: async ({ ordinal }) => {
      if (ordinal === 2) throw new Error("errore previsto");
    },
  });

  assert.equal(result.totalStarted, 8);
  assert.equal(result.totalCompleted, 8);
  assert.equal(result.totalFailed, 2);
  assert.deepEqual(result.devices.map((device) => device.failed), [1, 1]);
});

test("rileva una violazione in una finestra mobile", () => {
  const summary = summarizeP5ActionStarts([0, 100, 200, 300], {
    actionsPerSecond: 3,
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.maxSlidingWindow, 4);
  assert.equal(summary.slidingWindowViolation, true);
});
