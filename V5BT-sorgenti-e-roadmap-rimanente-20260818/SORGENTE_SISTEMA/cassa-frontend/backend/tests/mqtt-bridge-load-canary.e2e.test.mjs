import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMqttBridgeLoadCanaryMarkdown,
  parseMqttBridgeLoadCanaryArgs,
  runMqttBridgeLoadCanary,
} from "../../scripts/mqtt-bridge-load-canary.mjs";

test("[BE][STEP14D] MQTT bridge fanout multi-client senza duplicati", async () => {
  const parsed = parseMqttBridgeLoadCanaryArgs([
    "--clients",
    "20",
    "--events",
    "3",
    "--timeout-ms",
    "10000",
    "--store-id",
    "test-store/14d",
  ]);
  assert.equal(parsed.clients, 20);
  assert.equal(parsed.events, 3);
  assert.equal(parsed.storeId, "test-store_14d");

  const summary = await runMqttBridgeLoadCanary(parsed);
  assert.equal(summary.ok, true);
  assert.equal(summary.fanout.expectedMessages, 60);
  assert.equal(summary.fanout.receivedMessages, 60);
  assert.equal(summary.fanout.duplicates.length, 0);
  assert.equal(Object.values(summary.fanout.byEvent).every((count) => count === 20), true);
  assert.match(formatMqttBridgeLoadCanaryMarkdown(summary), /RESULT: OK/);
});
