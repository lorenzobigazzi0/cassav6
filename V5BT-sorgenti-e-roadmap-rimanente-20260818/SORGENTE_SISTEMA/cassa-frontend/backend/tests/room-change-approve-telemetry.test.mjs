import assert from "node:assert/strict";
import test from "node:test";

import { createPosRoomChangeApproveTelemetry } from "../modules/pos-rooms/room-change-approve-telemetry.js";

function createHarness(context = {}) {
  let currentTime = 2_000;
  const events = [];
  const telemetry = createPosRoomChangeApproveTelemetry({
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
    start: () => telemetry.start(),
    advance(durationMs) {
      currentTime += durationMs;
    },
  };
}

test("room-change approve telemetry separa autorizzazione delete e mirror", async () => {
  const harness = createHarness({
    laneWaitMs: 71,
    queueWaitMs: 4,
    readDbMs: 13,
    writeDbMs: 42,
  });
  const trace = harness.start();

  trace.measureSync("authorization.pinVerify", () => harness.advance(180));
  await trace.measure("pending.relationalDelete", async () => harness.advance(2));
  await trace.measure("state.appStateWrite", async () => harness.advance(40));
  trace.finish("approved");
  trace.finish("error");

  assert.deepEqual(harness.events, [
    { kind: "posRoomChangeApprove", label: "authorization.pinVerify", durationMs: 180 },
    { kind: "posRoomChangeApprove", label: "pending.relationalDelete", durationMs: 2 },
    { kind: "posRoomChangeApprove", label: "state.appStateWrite", durationMs: 40 },
    { kind: "posRoomChangeApprove", label: "laneWait.approved", durationMs: 71 },
    { kind: "posRoomChangeApprove", label: "dbQueueWait.approved", durationMs: 4 },
    { kind: "posRoomChangeApprove", label: "readDbTotal.approved", durationMs: 13 },
    { kind: "posRoomChangeApprove", label: "writeDbTotal.approved", durationMs: 42 },
    { kind: "posRoomChangeApprove", label: "total.approved", durationMs: 222 },
  ]);
});

test("room-change approve telemetry registra errori di stage e outcome", async () => {
  const harness = createHarness();
  const trace = harness.start();

  await assert.rejects(
    trace.measure("pending.relationalDelete", async () => {
      harness.advance(6);
      throw new Error("delete failed");
    }),
    /delete failed/,
  );
  trace.finish("error");

  assert.equal(harness.events[0].label, "pending.relationalDelete");
  assert.equal(harness.events[0].durationMs, 6);
  assert.equal(harness.events.at(-1).label, "total.error");
});
