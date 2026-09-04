import assert from "node:assert/strict";
import test from "node:test";

import { createLatestByKeyBatchQueue } from "../modules/queue/latest-by-key-batch.js";

function fakeMetrics() {
  const counters = {};
  const gauges = {};
  return {
    counters,
    gauges,
    incrementCounter(name, amount = 1) {
      counters[name] = (counters[name] ?? 0) + amount;
    },
    setGauge(name, value) {
      gauges[name] = value;
    },
    recordOperation() {},
  };
}

test("coalesca per chiave conservando solo lo stato piu recente", async () => {
  const batches = [];
  const metrics = fakeMetrics();
  const queue = createLatestByKeyBatchQueue({
    runBatch: async (batch) => {
      assert.equal(metrics.gauges.mirrorRunning, 1);
      batches.push(batch);
    },
    runtimeMetrics: metrics,
    metricPrefix: "mirror",
    intervalMs: 50,
  });
  queue.enqueue("job-1", { status: "queued" });
  queue.enqueue("job-1", { status: "claimed" });
  queue.enqueue("job-1", { status: "confirmed" });
  const result = await queue.drain({ timeoutMs: 1_000 });
  assert.equal(result.drained, true);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.deepEqual(batches[0][0].value, { status: "confirmed" });
  assert.equal(metrics.counters.mirrorEnqueued, 3);
  assert.equal(metrics.counters.mirrorCoalesced, 2);
  assert.equal(metrics.counters.mirrorFlushed, 1);
  assert.equal(metrics.gauges.mirrorPendingDepth, 0);
  assert.equal(metrics.gauges.mirrorRunning, 0);
});

test("suddivide chiavi distinte rispettando maxBatchSize", async () => {
  const batches = [];
  const queue = createLatestByKeyBatchQueue({
    runBatch: async (batch) => batches.push(batch),
    intervalMs: 50,
    maxBatchSize: 2,
  });
  queue.enqueue("a", 1);
  queue.enqueue("b", 2);
  queue.enqueue("c", 3);
  const result = await queue.drain({ timeoutMs: 1_000 });
  assert.equal(result.drained, true);
  assert.deepEqual(batches.map((batch) => batch.map((entry) => entry.key)), [["a", "b"], ["c"]]);
});

test("un retry non sovrascrive uno stato piu nuovo arrivato durante il batch", async () => {
  const values = [];
  let attempts = 0;
  let queue;
  queue = createLatestByKeyBatchQueue({
    runBatch: async (batch) => {
      attempts += 1;
      values.push(batch[0].value.status);
      if (attempts === 1) {
        queue.enqueue("job-1", { status: "confirmed" });
        throw new Error("transient");
      }
    },
    logger: { warn() {} },
    intervalMs: 0,
    retryBaseMs: 1,
    retryMaxMs: 2,
  });
  queue.enqueue("job-1", { status: "claimed" });
  const result = await queue.drain({ timeoutMs: 1_000 });
  assert.equal(result.drained, true);
  assert.deepEqual(values, ["claimed", "confirmed"]);
});

test("rifiuta chiavi vuote e drena subito una coda vuota", async () => {
  const queue = createLatestByKeyBatchQueue({ runBatch: async () => {} });
  assert.equal(queue.enqueue("", {}), false);
  assert.deepEqual(await queue.drain({ timeoutMs: 100 }), { drained: true, remaining: 0 });
});
