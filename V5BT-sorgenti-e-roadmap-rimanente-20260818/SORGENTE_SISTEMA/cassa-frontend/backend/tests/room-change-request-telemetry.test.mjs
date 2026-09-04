import assert from "node:assert/strict";
import test from "node:test";

import { createPosRoomChangeRequestTelemetry } from "../modules/pos-rooms/room-change-request-telemetry.js";

function createHarness(context = {}) {
  let currentTime = 1_000;
  const events = [];
  const telemetry = createPosRoomChangeRequestTelemetry({
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
    advance: (durationMs) => {
      currentTime += durationMs;
    },
  };
}

test("room-change telemetry separa stage e attese del ramo direct", async () => {
  const harness = createHarness({
    laneWaitMs: 37,
    queueWaitMs: 5,
    readDbMs: 29,
    writeDbMs: 11,
  });
  const trace = harness.start();

  const db = await trace.measure("readDb.handler", async () => {
    harness.advance(7);
    return { ok: true };
  });
  const changed = trace.measureSync("authorization", () => {
    harness.advance(3);
    return db.ok;
  });
  harness.advance(13);
  trace.finish(changed ? "direct" : "rejected");
  trace.finish("pending");

  assert.deepEqual(harness.events, [
    { kind: "posRoomChangeRequest", label: "readDb.handler", durationMs: 7 },
    { kind: "posRoomChangeRequest", label: "authorization", durationMs: 3 },
    { kind: "posRoomChangeRequest", label: "laneWait.direct", durationMs: 37 },
    { kind: "posRoomChangeRequest", label: "dbQueueWait.direct", durationMs: 5 },
    { kind: "posRoomChangeRequest", label: "readDbTotal.direct", durationMs: 29 },
    { kind: "posRoomChangeRequest", label: "writeDbTotal.direct", durationMs: 11 },
    { kind: "posRoomChangeRequest", label: "total.direct", durationMs: 23 },
  ]);
});

test("room-change telemetry registra lo stage anche quando l'azione fallisce", async () => {
  const harness = createHarness();
  const trace = harness.start();

  await assert.rejects(
    trace.measure("pending.relationalWrite", async () => {
      harness.advance(9);
      throw new Error("db unavailable");
    }),
    /db unavailable/,
  );

  assert.deepEqual(harness.events, [
    {
      kind: "posRoomChangeRequest",
      label: "pending.relationalWrite",
      durationMs: 9,
    },
  ]);
});
