import assert from "node:assert/strict";
import test from "node:test";
import {
  LOADTEST_RUNTIME_QUEUE_SAMPLE_LIMIT_DEFAULT,
  LOADTEST_RUNTIME_QUEUE_SAMPLE_LIMIT_MAX,
  collectWorkerOperationHistograms,
  mergeHistogramSnapshots,
  resolveLoadtestRuntimeQueueSampleLimit,
} from "./loadtest-runtime-metrics.mjs";

test("il limite campioni code del load test e sicuro e configurabile", () => {
  assert.equal(LOADTEST_RUNTIME_QUEUE_SAMPLE_LIMIT_DEFAULT, 600);
  assert.equal(LOADTEST_RUNTIME_QUEUE_SAMPLE_LIMIT_MAX, 5_000);
  assert.equal(resolveLoadtestRuntimeQueueSampleLimit(undefined), 600);
  assert.equal(resolveLoadtestRuntimeQueueSampleLimit("invalid"), 600);
  assert.equal(resolveLoadtestRuntimeQueueSampleLimit("0"), 600);
  assert.equal(resolveLoadtestRuntimeQueueSampleLimit("9"), 10);
  assert.equal(resolveLoadtestRuntimeQueueSampleLimit("240"), 240);
  assert.equal(resolveLoadtestRuntimeQueueSampleLimit("9000"), 5_000);
});

function histogram({ count, sum, min, max, buckets, over = 0 }) {
  return { count, sum, min, max, buckets, over };
}

test("mergeHistogramSnapshots aggrega count, tempi e bucket", () => {
  const merged = mergeHistogramSnapshots([
    histogram({ count: 3, sum: 9, min: 1, max: 5, buckets: { 1: 1, 5: 2, 10: 0 } }),
    histogram({ count: 2, sum: 21, min: 9, max: 12, buckets: { 1: 0, 5: 0, 10: 1 }, over: 1 }),
  ]);

  assert.deepEqual(merged, {
    count: 5,
    sum: 30,
    avg: 6,
    min: 1,
    max: 12,
    p50: 5,
    p95: 12,
    p99: 12,
    buckets: { 1: 1, 5: 2, 10: 1 },
    over: 1,
  });
});

test("collectWorkerOperationHistograms unisce owner e worker", () => {
  const runtimeMetrics = {
    operations: {
      runMsByLabel: {
        "orderCreateRead:refreshSessions": histogram({
          count: 100,
          sum: 1000,
          min: 1,
          max: 50,
          buckets: { 5: 50, 10: 50 },
        }),
      },
    },
    workers: [
      {
        runtimeMetrics: {
          operations: {
            runMsByLabel: {
              "orderCreateRead:refreshSessions": histogram({
                count: 2,
                sum: 8,
                min: 3,
                max: 5,
                buckets: { 5: 2, 10: 0 },
              }),
            },
          },
        },
      },
      {
        runtimeMetrics: {
          operations: {
            runMsByLabel: {
              "orderCreateRead:refreshSessions": histogram({
                count: 3,
                sum: 18,
                min: 4,
                max: 8,
                buckets: { 5: 1, 10: 2 },
              }),
              "other:ignored": histogram({
                count: 1,
                sum: 1,
                min: 1,
                max: 1,
                buckets: { 5: 1, 10: 0 },
              }),
            },
          },
        },
      },
    ],
  };

  const collected = collectWorkerOperationHistograms(runtimeMetrics, "orderCreateRead:");

  assert.deepEqual(Object.keys(collected), ["orderCreateRead:refreshSessions"]);
  assert.equal(collected["orderCreateRead:refreshSessions"].count, 105);
  assert.equal(collected["orderCreateRead:refreshSessions"].sum, 1026);
  assert.equal(collected["orderCreateRead:refreshSessions"].avg, 9.77);
});

test("collectWorkerOperationHistograms conserva label distribuite tra owner e worker", () => {
  const runtimeMetrics = {
    operations: {
      runMsByLabel: {
        "waiterPauseWorkflow:start:total": histogram({
          count: 2,
          sum: 12,
          min: 5,
          max: 7,
          buckets: { 5: 1, 10: 1 },
        }),
        "waiterPauseWorkflow:stop:total": histogram({
          count: 1,
          sum: 4,
          min: 4,
          max: 4,
          buckets: { 5: 1, 10: 0 },
        }),
      },
    },
    workers: [{
      runtimeMetrics: {
        operations: {
          runMsByLabel: {
            "waiterPauseWorkflow:status:total": histogram({
              count: 3,
              sum: 9,
              min: 2,
              max: 4,
              buckets: { 5: 3, 10: 0 },
            }),
          },
        },
      },
    }],
  };

  const collected = collectWorkerOperationHistograms(runtimeMetrics, "waiterPauseWorkflow:");

  assert.deepEqual(Object.keys(collected), [
    "waiterPauseWorkflow:start:total",
    "waiterPauseWorkflow:status:total",
    "waiterPauseWorkflow:stop:total",
  ]);
  assert.equal(collected["waiterPauseWorkflow:start:total"].count, 2);
  assert.equal(collected["waiterPauseWorkflow:status:total"].count, 3);
  assert.equal(collected["waiterPauseWorkflow:stop:total"].count, 1);
});

test("collectWorkerOperationHistograms ripiega sul root quando i worker non hanno il prefisso", () => {
  const rootHistogram = histogram({
    count: 4,
    sum: 20,
    min: 2,
    max: 8,
    buckets: { 5: 2, 10: 2 },
  });
  const collected = collectWorkerOperationHistograms({
    operations: { runMsByLabel: { "orderCreateInternal:readDb": rootHistogram } },
    workers: [{ runtimeMetrics: { operations: { runMsByLabel: {} } } }],
  }, "orderCreateInternal:");

  assert.equal(collected["orderCreateInternal:readDb"].count, 4);
  assert.equal(collected["orderCreateInternal:readDb"].sum, 20);
});
