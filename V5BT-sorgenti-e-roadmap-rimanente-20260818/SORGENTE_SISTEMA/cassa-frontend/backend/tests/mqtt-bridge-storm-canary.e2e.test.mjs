import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMqttBridgeStormCanaryMarkdown,
  parseMqttBridgeStormCanaryArgs,
  runMqttBridgeStormCanary,
} from "../../scripts/mqtt-bridge-storm-canary.mjs";

test("[BE][STEP14F] MQTT bridge regge reconnect storm multi-device", async () => {
  const parsed = parseMqttBridgeStormCanaryArgs([
    "--clients",
    "12",
    "--cycles",
    "2",
    "--timeout-ms",
    "12000",
    "--reconnect-ms",
    "100",
    "--store-id",
    "test-store/14f",
  ]);
  assert.equal(parsed.clients, 12);
  assert.equal(parsed.cycles, 2);
  assert.equal(parsed.storeId, "test-store_14f");

  const summary = await runMqttBridgeStormCanary(parsed);
  assert.equal(summary.ok, true);
  assert.equal(summary.clientStats.connectedEveryCycle, 12);
  assert.equal(summary.cycles.length, 2);
  assert.equal(summary.cycles.every((cycle) => cycle.delivered === 12), true);
  assert.equal(summary.downDelivered.every((entry) => entry.delivered === 0), true);
  assert.equal(summary.received.duplicates, 0);
  assert.match(formatMqttBridgeStormCanaryMarkdown(summary), /RESULT: OK/);
});
