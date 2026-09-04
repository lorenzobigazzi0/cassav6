import assert from "node:assert/strict";
import test from "node:test";

import { persistSqlPrimaryPrintBatch } from "../modules/print-spool/sql-primary-batch.js";

test("batch SQL-primary persiste tutti i file prima della transazione", async () => {
  const calls = [];
  const ticks = [100, 125];
  const repository = {
    enqueueMany(records) {
      calls.push(["enqueue", records.map((record) => record.id)]);
      assert.deepEqual(records.map((record) => record.payload.id), ["print-order", "print-preconto"]);
    },
  };

  const result = await persistSqlPrimaryPrintBatch({
    payloads: [{ kind: "order" }, { kind: "preconto" }],
    repository,
    buildJob(payload) {
      const job = {
        id: `print-${payload.kind}`,
        kind: payload.kind,
        status: "queued",
      };
      calls.push(["build", job.id]);
      return job;
    },
    async persistJobFile(job) {
      calls.push(["file", job.id]);
    },
    now: () => ticks.shift(),
  });

  assert.deepEqual(calls, [
    ["build", "print-order"],
    ["build", "print-preconto"],
    ["file", "print-order"],
    ["file", "print-preconto"],
    ["enqueue", ["print-order", "print-preconto"]],
  ]);
  assert.deepEqual(result.jobs.map((job) => job.id), ["print-order", "print-preconto"]);
  assert.equal(result.durationMs, 25);
});

test("batch SQL-primary non espone job se la persistenza di un file fallisce", async () => {
  let enqueueCalls = 0;
  await assert.rejects(
    persistSqlPrimaryPrintBatch({
      payloads: [{ kind: "order" }, { kind: "preconto" }],
      repository: {
        enqueueMany() {
          enqueueCalls += 1;
        },
      },
      buildJob: (payload) => ({ id: `print-${payload.kind}` }),
      async persistJobFile(job) {
        if (job.id === "print-preconto") throw new Error("disk full");
      },
    }),
    /disk full/,
  );
  assert.equal(enqueueCalls, 0);
});
