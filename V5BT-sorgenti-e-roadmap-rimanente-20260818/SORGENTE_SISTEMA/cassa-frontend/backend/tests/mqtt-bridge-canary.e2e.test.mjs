import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMqttBridgeCanaryMarkdown,
  parseMqttBridgeCanaryArgs,
  runMqttBridgeCanary,
} from "../../scripts/mqtt-bridge-canary.mjs";

test("[BE][STEP14B] MQTT canary embedded broker consegna eventi e retained ammesso", async () => {
  const parsed = parseMqttBridgeCanaryArgs([
    "--clients",
    "2",
    "--timeout-ms",
    "5000",
    "--store-id",
    "test-store/14b",
  ]);
  assert.equal(parsed.clients, 2);
  assert.equal(parsed.storeId, "test-store_14b");

  const summary = await runMqttBridgeCanary(parsed);
  assert.equal(summary.ok, true);
  assert.equal(summary.checks.every((check) => check.ok), true);
  assert.equal(summary.received.order, 2);
  assert.equal(summary.received.table, 2);
  assert.equal(summary.received.payment, 2);
  assert.equal(summary.received.retainedTable, 1);
  assert.equal(summary.received.retainedPayment, 0);
  assert.match(formatMqttBridgeCanaryMarkdown(summary), /RESULT: OK/);
});
