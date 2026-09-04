import assert from "node:assert/strict";
import test from "node:test";
import { Aedes } from "aedes";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import {
  formatMqttRetainedPersistenceCanaryMarkdown,
  parseMqttRetainedPersistenceCanaryArgs,
  runMqttRetainedPersistenceCanary,
} from "../../scripts/mqtt-retained-persistence-canary.mjs";

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
    const allowed = user === "palmare-template" && mqttTopicMatches(`pos/${storeId}/events/#`, topic);
    callback(allowed ? null : new Error("subscribe denied"), subscription);
  };
  broker.authorizePublish = (client, packet, callback) => {
    const user = String(client?.username ?? "");
    const topic = packet.topic;
    const allowed = user === "backend" && mqttTopicMatches(`pos/${storeId}/events/#`, topic);
    callback(allowed ? null : new Error("publish denied"));
  };
  const server = net.createServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `mqtt://127.0.0.1:${Number(server.address()?.port)}`,
    async close() {
      await Promise.allSettled([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => broker.close(resolve)),
      ]);
    },
  };
}

test("[BE][STEP14H] MQTT retained persistence canary pubblica verifica e pulisce marker", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cassav4-s14h-"));
  const markerFile = path.join(tempDir, "marker.json");
  const outDir = path.join(tempDir, "reports");
  const parsed = parseMqttRetainedPersistenceCanaryArgs([
    "--phase",
    "publish",
    "--backend-user",
    "backend",
    "--backend-pass",
    "backend-pass",
    "--device-user",
    "palmare-template",
    "--device-pass",
    "device-pass",
    "--store-id",
    "store/retained",
    "--marker-file",
    markerFile,
    "--out-dir",
    outDir,
    "--timeout-ms",
    "8000",
  ]);
  assert.equal(parsed.storeId, "store_retained");

  const broker = await startAclBroker({
    storeId: parsed.storeId,
    credentials: {
      backend: "backend-pass",
      "palmare-template": "device-pass",
    },
  });

  try {
    const publishSummary = await runMqttRetainedPersistenceCanary({ ...parsed, brokerUrl: broker.url });
    assert.equal(publishSummary.ok, true);
    assert.equal(existsSync(markerFile), true);
    assert.equal(publishSummary.checks.find((check) => check.name === "table publish retained")?.ok, true);
    assert.equal(publishSummary.checks.find((check) => check.name === "payment publish not retained")?.ok, true);
    assert.doesNotMatch(readFileSync(markerFile, "utf8"), /backend-pass|device-pass/);
    assert.doesNotMatch(formatMqttRetainedPersistenceCanaryMarkdown(publishSummary), /backend-pass|device-pass/);

    const verifySummary = await runMqttRetainedPersistenceCanary({
      ...parsed,
      brokerUrl: broker.url,
      phase: "verify",
    });
    assert.equal(verifySummary.ok, true);
    assert.equal(verifySummary.checks.find((check) => check.name === "table retained survived")?.ok, true);
    assert.equal(verifySummary.checks.find((check) => check.name === "payment retained absent")?.ok, true);
    assert.match(formatMqttRetainedPersistenceCanaryMarkdown(verifySummary), /RESULT: OK/);

    const clearSummary = await runMqttRetainedPersistenceCanary({
      ...parsed,
      brokerUrl: broker.url,
      phase: "clear",
    });
    assert.equal(clearSummary.ok, true);
    assert.equal(clearSummary.checks.find((check) => check.name === "table retained cleared")?.ok, true);
  } finally {
    await broker.close();
  }
});

test("[BE][STEP14H] MQTT retained persistence canary richiede credenziali", async () => {
  const parsed = parseMqttRetainedPersistenceCanaryArgs(["--phase", "publish"]);
  const summary = await runMqttRetainedPersistenceCanary({
    ...parsed,
    backendPassword: "",
    devicePassword: "",
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.checks[0].name, "credentials configured");
});
