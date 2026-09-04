import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMqttCommandGateSummary,
  formatMqttCommandGateMarkdown,
  parseMqttCommandGateCheckArgs,
} from "../../scripts/mqtt-command-gate-check.mjs";

test("[BE][STEP15] command gate check passa con comandi MQTT spenti", () => {
  const summary = buildMqttCommandGateSummary({});
  assert.equal(summary.ok, true);
  assert.equal(summary.currentGate.requested, false);
  assert.match(formatMqttCommandGateMarkdown(summary), /RESULT: OK/);
  assert.equal(parseMqttCommandGateCheckArgs(["--out-dir", "tmp/reports"]).outDir.endsWith("tmp/reports"), true);
});

test("[BE][STEP15] command gate check fallisce se i comandi sono richiesti ma non sicuri", () => {
  const summary = buildMqttCommandGateSummary({
    MQTT_COMMANDS_ENABLED: "1",
    COMMAND_INBOX_ENABLED: "1",
    COMMAND_INBOX_MODE: "shadow",
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.currentCheck.ok, false);
  assert.deepEqual(summary.currentGate.reasons, ["command_inbox_not_enforcing:shadow"]);
  assert.match(formatMqttCommandGateMarkdown(summary), /RESULT: FAIL/);
});

test("[BE][STEP15] command gate check passa quando inbox enforce e ack sono espliciti", () => {
  const summary = buildMqttCommandGateSummary({
    MQTT_COMMANDS_ENABLED: "1",
    COMMAND_INBOX_ENABLED: "1",
    COMMAND_INBOX_MODE: "enforce",
    MQTT_COMMAND_ACK_ENABLED: "1",
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.currentGate.enabled, true);
  assert.deepEqual(summary.currentGate.reasons, []);
});
