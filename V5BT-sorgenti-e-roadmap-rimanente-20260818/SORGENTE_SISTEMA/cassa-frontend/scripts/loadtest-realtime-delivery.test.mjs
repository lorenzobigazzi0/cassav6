import assert from "node:assert/strict";
import test from "node:test";

import { recordRealtimeDeliverySample } from "./loadtest-realtime-delivery.mjs";

test("recordRealtimeDeliverySample separa il lag SSE per reason", () => {
  const aggregate = {};
  const nowMs = Date.parse("2026-07-13T18:00:00.250Z");

  const started = recordRealtimeDeliverySample(aggregate, {
    type: "notification",
    createdAt: "2026-07-13T18:00:00.100Z",
    payload: { reason: "waiter_pause_started" },
  }, nowMs);
  const stopped = recordRealtimeDeliverySample(aggregate, {
    type: "notification",
    createdAt: "2026-07-13T18:00:00.200Z",
    payload: { reason: "waiter_pause_stopped" },
  }, nowMs);

  assert.deepEqual(started, {
    eventType: "notification",
    reason: "waiter_pause_started",
    lagMs: 150,
  });
  assert.equal(stopped.lagMs, 50);
  assert.deepEqual(aggregate.eventTypeCounts, { notification: 2 });
  assert.deepEqual(aggregate.eventReasonCounts, {
    waiter_pause_started: 1,
    waiter_pause_stopped: 1,
  });
  assert.deepEqual(aggregate.deliveryLagMs, [150, 50]);
  assert.deepEqual(aggregate.deliveryLagMsByReason, {
    waiter_pause_started: [150],
    waiter_pause_stopped: [50],
  });
});

test("recordRealtimeDeliverySample conta eventi senza timestamp senza inventare lag", () => {
  const aggregate = {};
  const sample = recordRealtimeDeliverySample(aggregate, {
    type: "notification",
    payload: { reason: "waiter_pause_started" },
  }, 1234);

  assert.equal(sample.lagMs, null);
  assert.deepEqual(aggregate.eventReasonCounts, { waiter_pause_started: 1 });
  assert.deepEqual(aggregate.deliveryLagMs, []);
  assert.deepEqual(aggregate.deliveryLagMsByReason, {});
});
