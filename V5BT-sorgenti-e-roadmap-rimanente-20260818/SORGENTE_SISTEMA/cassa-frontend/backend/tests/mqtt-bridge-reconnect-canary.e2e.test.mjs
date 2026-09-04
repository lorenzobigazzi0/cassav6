import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMqttBridgeReconnectCanaryMarkdown,
  parseMqttBridgeReconnectCanaryArgs,
  runMqttBridgeReconnectCanary,
} from "../../scripts/mqtt-bridge-reconnect-canary.mjs";

test("[BE][STEP14C] MQTT bridge si riconnette dopo restart broker", async () => {
  const parsed = parseMqttBridgeReconnectCanaryArgs([
    "--timeout-ms",
    "7000",
    "--reconnect-ms",
    "150",
    "--store-id",
    "test-store/14c",
  ]);
  assert.equal(parsed.storeId, "test-store_14c");
  assert.equal(parsed.reconnectMs, 150);

  const summary = await runMqttBridgeReconnectCanary(parsed);
  assert.equal(summary.ok, true);
  assert.equal(summary.checks.every((check) => check.ok), true);
  assert.deepEqual(summary.received.before, [1431]);
  assert.deepEqual(summary.received.after, [1433]);
  assert.equal(summary.publishResults.duringDown.ok, false);
  assert.equal(summary.publishResults.duringDown.reason, "not_connected");
  assert.match(formatMqttBridgeReconnectCanaryMarkdown(summary), /RESULT: OK/);
});
