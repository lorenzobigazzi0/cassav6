import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentFreeSplitTelemetry } from "../modules/payments/payment-free-split-telemetry.js";

function createHarness() {
  let clock = 100;
  const records = [];
  const telemetry = createPaymentFreeSplitTelemetry({
    now: () => clock,
    getRequestContext: () => ({
      laneWaitMs: 17,
      queueWaitMs: 3,
      readDbMs: 11,
      writeDbMs: 29,
    }),
    runtimeMetrics: {
      recordOperation(kind, label, durationMs) {
        records.push({ kind, label, durationMs });
      },
    },
  });
  return {
    records,
    telemetry,
    advance(value) {
      clock += value;
    },
  };
}

test("free split telemetry separa stage e tempi request", async () => {
  const harness = createHarness();
  const trace = harness.telemetry.start();

  const result = await trace.measure("relational.commit", async () => {
    harness.advance(23);
    return "ok";
  });
  harness.advance(7);
  trace.finish("completed");

  assert.equal(result, "ok");
  assert.deepEqual(harness.records, [
    {
      kind: "paymentFreeSplitWorkflow",
      label: "relational.commit",
      durationMs: 23,
    },
    {
      kind: "paymentFreeSplitWorkflow",
      label: "laneWait.completed",
      durationMs: 17,
    },
    {
      kind: "paymentFreeSplitWorkflow",
      label: "dbQueueWait.completed",
      durationMs: 3,
    },
    {
      kind: "paymentFreeSplitWorkflow",
      label: "readDbTotal.completed",
      durationMs: 11,
    },
    {
      kind: "paymentFreeSplitWorkflow",
      label: "writeDbTotal.completed",
      durationMs: 29,
    },
    {
      kind: "paymentFreeSplitWorkflow",
      label: "total.completed",
      durationMs: 30,
    },
  ]);
});

test("free split telemetry normalizza l'esito e chiude una sola volta", () => {
  const harness = createHarness();
  const trace = harness.telemetry.start();

  harness.advance(9);
  trace.finish("error PAYMENT_NOT_PAYABLE");
  trace.finish("completed");

  assert.equal(
    harness.records.filter((entry) => entry.label.startsWith("total.")).length,
    1,
  );
  assert.equal(
    harness.records.at(-1).label,
    "total.error_payment_not_payable",
  );
});
