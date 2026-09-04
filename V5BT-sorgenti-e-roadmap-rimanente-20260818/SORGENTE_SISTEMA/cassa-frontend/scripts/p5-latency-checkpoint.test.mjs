import assert from "node:assert/strict";
import test from "node:test";
import {
  createP5LatencyCheckpointWriter,
  summarizeP5LatencySamples,
} from "./p5-latency-checkpoint.mjs";

test("calcola i percentili richiesti dal checkpoint P5", () => {
  const summary = summarizeP5LatencySamples(
    Array.from({ length: 100 }, (_, index) => ({ durationMs: index + 1 })),
  );
  assert.deepEqual(summary, {
    count: 100,
    p50ms: 50,
    p95ms: 95,
    p98ms: 98,
    p99ms: 99,
    p999ms: 100,
    maxMs: 100,
  });
});

test("persiste solo i nuovi campioni e conserva il riepilogo cumulativo", async () => {
  const httpSamples = [{ sequence: 1, durationMs: 10, type: "health", status: 200 }];
  const actionSamples = [{
    sequence: 1,
    at: Date.UTC(2026, 6, 16, 9, 59, 59),
    durationMs: 20,
    type: "order.create",
    device: "mobile-1",
    ok: true,
    disruptive: false,
  }];
  const lines = [];
  const writer = createP5LatencyCheckpointWriter({
    filePath: "p5-checkpoint.jsonl",
    getHttpSamples: () => httpSamples,
    getActionSamples: () => actionSamples,
    now: () => Date.UTC(2026, 6, 16, 10, 0, 0),
    append: async (_filePath, content) => lines.push(JSON.parse(content)),
  });

  await writer.flush("profile-start");
  httpSamples.push({ sequence: 2, durationMs: 30, type: "orders", status: 200 });
  actionSamples.push({ sequence: 2, durationMs: 40, device: "station-1", ok: true });
  await writer.close("profile-stop");

  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].httpSamples.map((sample) => sample.sequence), [1]);
  assert.deepEqual(lines[1].httpSamples.map((sample) => sample.sequence), [2]);
  assert.deepEqual(lines[1].actionSamples.map((sample) => sample.sequence), [2]);
  assert.equal(lines[0].actionSamples[0].at, Date.UTC(2026, 6, 16, 9, 59, 59));
  assert.equal(lines[0].actionSamples[0].type, "order.create");
  assert.equal(lines[0].actionSamples[0].disruptive, false);
  assert.equal(lines[1].totals.httpSamples, 2);
  assert.equal(lines[1].httpLatencyMs.p95ms, 30);
  assert.equal(lines[1].actionLatencyMs.p99ms, 40);
});

test("non perde campioni quando una append fallisce e viene ritentata", async () => {
  const samples = [{ sequence: 1, durationMs: 15 }];
  const lines = [];
  const errors = [];
  let attempts = 0;
  const writer = createP5LatencyCheckpointWriter({
    filePath: "p5-checkpoint.jsonl",
    getHttpSamples: () => samples,
    getActionSamples: () => [],
    append: async (_filePath, content) => {
      attempts += 1;
      if (attempts === 1) throw new Error("disco temporaneamente non disponibile");
      lines.push(JSON.parse(content));
    },
    onError: (error) => errors.push(error.message),
  });

  await assert.rejects(writer.flush("progress"), /disco temporaneamente/);
  await writer.close("profile-stop");

  assert.deepEqual(errors, ["disco temporaneamente non disponibile"]);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].httpSamples.map((sample) => sample.sequence), [1]);
});
