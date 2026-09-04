import assert from "node:assert/strict";
import test from "node:test";

import { createWaiterPauseTelemetry } from "../modules/notifications/waiter-pause-telemetry.js";

function createHarness(context = {}) {
  let currentTime = 1_000;
  const events = [];
  const telemetry = createWaiterPauseTelemetry({
    now: () => currentTime,
    getRequestContext: () => context,
    runtimeMetrics: {
      recordOperation(kind, label, durationMs) {
        events.push({ kind, label, durationMs });
      },
    },
  });
  return {
    events,
    start: (operation) => telemetry.start(operation),
    advance(durationMs) {
      currentTime += durationMs;
    },
  };
}

test("waiter pause telemetry separa write, publish e tempi della lane", async () => {
  const harness = createHarness({
    laneWaitMs: 31,
    queueWaitMs: 7,
    readDbMs: 11,
    writeDbMs: 43,
  });
  const trace = harness.start("start");

  trace.measureSync("state.transition", () => harness.advance(3));
  await trace.measure("state.appStateWrite", async () => harness.advance(40));
  trace.measureSync("realtime.publish", () => harness.advance(2));
  trace.finish("started");
  trace.finish("error");

  assert.deepEqual(harness.events, [
    { kind: "waiterPauseWorkflow", label: "start.state.transition", durationMs: 3 },
    { kind: "waiterPauseWorkflow", label: "start.state.appStateWrite", durationMs: 40 },
    { kind: "waiterPauseWorkflow", label: "start.realtime.publish", durationMs: 2 },
    { kind: "waiterPauseWorkflow", label: "start.laneWait.started", durationMs: 31 },
    { kind: "waiterPauseWorkflow", label: "start.dbQueueWait.started", durationMs: 7 },
    { kind: "waiterPauseWorkflow", label: "start.readDbTotal.started", durationMs: 11 },
    { kind: "waiterPauseWorkflow", label: "start.writeDbTotal.started", durationMs: 43 },
    { kind: "waiterPauseWorkflow", label: "start.total.started", durationMs: 45 },
  ]);
});

test("waiter pause telemetry normalizza operazione e outcome di errore", async () => {
  const harness = createHarness();
  const trace = harness.start("invalid-operation");

  await assert.rejects(
    trace.measure("readDb.handler", async () => {
      harness.advance(5);
      throw new Error("read failed");
    }),
    /read failed/,
  );
  trace.finish("DB ERROR");

  assert.equal(harness.events[0].label, "unknown.readDb.handler");
  assert.equal(harness.events[0].durationMs, 5);
  assert.equal(harness.events.at(-1).label, "unknown.total.db_error");
});
