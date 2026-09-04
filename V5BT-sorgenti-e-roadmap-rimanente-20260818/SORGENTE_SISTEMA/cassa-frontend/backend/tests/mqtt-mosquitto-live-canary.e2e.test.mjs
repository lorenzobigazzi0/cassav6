import assert from "node:assert/strict";
import test from "node:test";
import { Aedes } from "aedes";
import net from "node:net";
import {
  formatMqttMosquittoLiveCanaryMarkdown,
  parseMqttMosquittoLiveCanaryArgs,
  runMqttMosquittoLiveCanary,
} from "../../scripts/mqtt-mosquitto-live-canary.mjs";

function mqttTopicMatches(pattern, topic) {
  const patternParts = String(pattern ?? "").split("/");
  const topicParts = String(topic ?? "").split("/");
  for (let index = 0; index < patternParts.length; index += 1) {
    const part = patternParts[index];
    if (part === "#") return index === patternParts.length - 1;
    if (topicParts[index] === undefined) return false;
    if (part !== "+" && part !== topicParts[index]) return false;
  }
  return patternParts.length === topicParts.length;
}

async function startAclBroker({ storeId, credentials }) {
  const broker = await Aedes.createBroker();
  broker.authenticate = (client, username, password, callback) => {
    const user = String(username ?? "");
    const pass = password?.toString("utf8") ?? "";
    client.username = user;
    callback(null, credentials[user] === pass);
  };
  broker.authorizeSubscribe = (client, subscription, callback) => {
    const user = String(client?.username ?? "");
    const topic = subscription.topic;
    const allowed =
      (user === "palmare-template" && mqttTopicMatches(`pos/${storeId}/events/#`, topic)) ||
      (user === "printer-gateway-template" && mqttTopicMatches(`pos/${storeId}/events/prints/#`, topic));
    callback(allowed ? null : new Error("subscribe denied"), subscription);
  };
  broker.authorizePublish = (client, packet, callback) => {
    const user = String(client?.username ?? "");
    const topic = packet.topic;
    const allowed =
      (user === "backend" && mqttTopicMatches(`pos/${storeId}/events/#`, topic)) ||
      (user === "palmare-template" && topic === `pos/${storeId}/devices/palmare-template/presence`) ||
      (user === "printer-gateway-template" && topic === `pos/${storeId}/printers/printer-gateway-template/status`);
    callback(allowed ? null : new Error("publish denied"));
  };

  const server = net.createServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = Number(server.address()?.port);
  return {
    url: `mqtt://127.0.0.1:${port}`,
    async close() {
      await Promise.allSettled([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => broker.close(resolve)),
      ]);
    },
  };
}

test("[BE][STEP14G] MQTT Mosquitto live canary valida ACL broker reale", async () => {
  const parsed = parseMqttMosquittoLiveCanaryArgs([
    "--broker-url",
    "mqtt://127.0.0.1:1883",
    "--backend-user",
    "backend",
    "--backend-pass",
    "backend-pass",
    "--device-user",
    "palmare-template",
    "--device-pass",
    "device-pass",
    "--printer-user",
    "printer-gateway-template",
    "--printer-pass",
    "printer-pass",
    "--store-id",
    "store/live",
    "--timeout-ms",
    "8000",
  ]);
  assert.equal(parsed.storeId, "store_live");
  assert.equal(parsed.backendUsername, "backend");

  const broker = await startAclBroker({
    storeId: parsed.storeId,
    credentials: {
      backend: "backend-pass",
      "palmare-template": "device-pass",
      "printer-gateway-template": "printer-pass",
    },
  });

  try {
    const summary = await runMqttMosquittoLiveCanary({ ...parsed, brokerUrl: broker.url });
    assert.equal(summary.ok, true);
    assert.equal(summary.checks.find((check) => check.name === "anonymous denied")?.ok, true);
    assert.equal(summary.checks.find((check) => check.name === "backend bridge writes events")?.ok, true);
    assert.equal(summary.checks.find((check) => check.name === "device cannot write events")?.ok, true);
    assert.equal(summary.checks.find((check) => check.name === "printer gateway cannot write events")?.ok, true);
    assert.equal(summary.options.credentials.backend.hasPassword, true);
    assert.doesNotMatch(formatMqttMosquittoLiveCanaryMarkdown(summary), /backend-pass|device-pass|printer-pass/);
    assert.match(formatMqttMosquittoLiveCanaryMarkdown(summary), /RESULT: OK/);
  } finally {
    await broker.close();
  }
});

test("[BE][STEP14G] MQTT Mosquitto live canary fallisce senza credenziali richieste", async () => {
  const parsed = parseMqttMosquittoLiveCanaryArgs(["--skip-printer"]);
  const summary = await runMqttMosquittoLiveCanary({
    ...parsed,
    backendPassword: "",
    devicePassword: "",
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.checks[0].name, "credentials configured");
});
