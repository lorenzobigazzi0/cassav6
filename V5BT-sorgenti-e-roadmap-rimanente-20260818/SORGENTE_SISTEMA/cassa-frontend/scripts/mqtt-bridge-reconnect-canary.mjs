#!/usr/bin/env node
import { Aedes } from "aedes";
import mqtt from "mqtt";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMqttRealtimeBridge,
  normalizeMqttBridgeConfig,
} from "../backend/modules/realtime-backbone/mqtt-bridge.js";

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RECONNECT_MS = 250;

function normalizeInt(value, fallback, { min = 1, max = 120000 } = {}) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function todayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function topicSegment(value, fallback = "canary") {
  const normalized = String(value ?? fallback)
    .trim()
    .replace(/[\u0000-\u001f\u007f+#/]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 96);
  return normalized || fallback;
}

export function parseMqttBridgeReconnectCanaryArgs(argv = [], env = process.env) {
  const parsed = {
    timeoutMs: normalizeInt(env.MQTT_RECONNECT_CANARY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, {
      min: 1000,
      max: 120000,
    }),
    reconnectMs: normalizeInt(env.MQTT_RECONNECT_CANARY_RECONNECT_MS, DEFAULT_RECONNECT_MS, {
      min: 100,
      max: 10000,
    }),
    outDir: String(env.MQTT_RECONNECT_CANARY_OUT_DIR || "reports").trim(),
    storeId: topicSegment(
      env.MQTT_RECONNECT_CANARY_STORE_ID || `step14c-${todayStamp()}-${process.pid}`,
      "step14c",
    ),
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "");
    const readNext = () => String(argv[(index += 1)] ?? "");
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--timeout-ms") parsed.timeoutMs = normalizeInt(readNext(), parsed.timeoutMs, { min: 1000, max: 120000 });
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = normalizeInt(arg.slice("--timeout-ms=".length), parsed.timeoutMs, { min: 1000, max: 120000 });
    else if (arg === "--reconnect-ms") parsed.reconnectMs = normalizeInt(readNext(), parsed.reconnectMs, { min: 100, max: 10000 });
    else if (arg.startsWith("--reconnect-ms=")) parsed.reconnectMs = normalizeInt(arg.slice("--reconnect-ms=".length), parsed.reconnectMs, { min: 100, max: 10000 });
    else if (arg === "--out-dir") parsed.outDir = readNext().trim();
    else if (arg.startsWith("--out-dir=")) parsed.outDir = arg.slice("--out-dir=".length).trim();
    else if (arg === "--store-id") parsed.storeId = topicSegment(readNext(), parsed.storeId);
    else if (arg.startsWith("--store-id=")) parsed.storeId = topicSegment(arg.slice("--store-id=".length), parsed.storeId);
  }

  parsed.outDir = path.resolve(parsed.outDir || "reports");
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/mqtt-bridge-reconnect-canary.mjs [opzioni]

Canary Step 14C:
  - avvia broker MQTT embedded;
  - pubblica evento prima del down;
  - spegne il broker;
  - verifica che publish durante down non lanci errori;
  - riavvia il broker sulla stessa porta;
  - verifica reconnect e nuova consegna eventi.

Opzioni:
  --timeout-ms N     timeout verifiche, default ${DEFAULT_TIMEOUT_MS}
  --reconnect-ms N   periodo reconnect client bridge, default ${DEFAULT_RECONNECT_MS}
  --out-dir DIR      directory report, default reports
  --store-id ID      storeId MQTT, default step14c-YYYYMMDD-PID
  --json             stampa JSON
`);
}

function createMetricsProbe() {
  const counters = {};
  const gauges = {};
  return {
    counters,
    gauges,
    incrementCounter(name, amount = 1) {
      counters[name] = Math.max(0, Math.trunc(Number(counters[name]) || 0)) + Math.max(0, Math.trunc(Number(amount) || 0));
    },
    setGauge(name, value) {
      gauges[name] = Math.max(0, Math.trunc(Number(value) || 0));
    },
    snapshot() {
      return { counters: { ...counters }, gauges: { ...gauges } };
    },
  };
}

async function startBroker(port = 0) {
  const broker = await Aedes.createBroker();
  const server = net.createServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const resolvedPort = Math.max(1, Math.trunc(Number(address?.port) || 0));
  return {
    broker,
    server,
    port: resolvedPort,
    url: `mqtt://127.0.0.1:${resolvedPort}`,
    async close() {
      await Promise.allSettled([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => broker.close(resolve)),
      ]);
    },
  };
}

function connectMqttClient(url, { clientId, timeoutMs, reconnectPeriod = 0 } = {}) {
  const client = mqtt.connect(url, {
    clientId,
    clean: true,
    connectTimeout: timeoutMs,
    reconnectPeriod,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MQTT connect timeout: ${clientId}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      client.off("connect", onConnect);
      client.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(client);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    client.once("connect", onConnect);
    client.once("error", onError);
  });
}

function subscribe(client, topic, options = {}) {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, options, (error, granted) => {
      if (error) reject(error);
      else resolve(granted);
    });
  });
}

function endClient(client) {
  return new Promise((resolve) => {
    try {
      client.end(true, {}, resolve);
    } catch {
      resolve();
    }
  });
}

async function waitFor(predicate, { timeoutMs, label }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timeout attesa ${label}`);
}

function buildEvent({ eventId, type, aggregateType, aggregateId, detail = {}, scope = "room_main" }) {
  const createdAt = new Date().toISOString();
  const payload = {
    ok: true,
    reason: type.replace(".", "_"),
    atMs: Date.now(),
    detail,
  };
  return {
    envelope: {
      eventId,
      type,
      aggregateType,
      aggregateId,
      aggregateVersion: eventId,
      scope,
      payload,
      createdAt,
    },
    outboxEvent: {
      id: eventId,
      eventType: type,
      aggregateType,
      aggregateId,
      scope,
      payload,
      occurredAt: createdAt,
    },
  };
}

function receivedEventIds(messages) {
  return messages
    .map((message) => {
      try {
        return JSON.parse(message.payload)?.eventId ?? null;
      } catch {
        return null;
      }
    })
    .filter((value) => value !== null);
}

async function connectSubscriber({ brokerUrl, topic, clientId, timeoutMs }) {
  const messages = [];
  const client = await connectMqttClient(brokerUrl, { clientId, timeoutMs });
  client.on("message", (receivedTopic, payload, packet = {}) => {
    messages.push({
      topic: receivedTopic,
      payload: payload.toString("utf8"),
      qos: packet.qos,
      retain: packet.retain === true,
    });
  });
  await subscribe(client, topic, { qos: 1 });
  return { client, messages };
}

export async function runMqttBridgeReconnectCanary(options = {}) {
  const startedAt = Date.now();
  let broker = await startBroker(0);
  let firstSubscriber = null;
  let secondSubscriber = null;
  const metrics = createMetricsProbe();
  const warnings = [];
  const config = normalizeMqttBridgeConfig({
    MQTT_ENABLED: "1",
    MQTT_EVENTS_ENABLED: "1",
    MQTT_COMMANDS_ENABLED: "0",
    MQTT_RETAINED_STATE_ENABLED: "1",
    MQTT_URL: broker.url,
    MQTT_STORE_ID: options.storeId,
    MQTT_CLIENT_ID: `step14c-bridge-${process.pid}`,
    MQTT_RECONNECT_PERIOD_MS: String(options.reconnectMs),
    MQTT_CONNECT_TIMEOUT_MS: "1000",
  });
  const bridge = createMqttRealtimeBridge({
    config,
    logger: { warn: (message) => warnings.push(String(message)) },
    metrics,
    nowMs: () => Date.now(),
  });

  try {
    const wildcardTopic = `pos/${config.storeId}/events/#`;
    firstSubscriber = await connectSubscriber({
      brokerUrl: broker.url,
      topic: wildcardTopic,
      clientId: `step14c-first-${process.pid}`,
      timeoutMs: options.timeoutMs,
    });

    bridge.start();
    await waitFor(() => bridge.isReady(), { timeoutMs: options.timeoutMs, label: "bridge iniziale connesso" });

    const before = buildEvent({
      eventId: 1431,
      type: "order.created",
      aggregateType: "order",
      aggregateId: "order_step14c_before",
      detail: { orderId: "order_step14c_before" },
    });
    const beforeResult = bridge.publishEvent(before.envelope, before.outboxEvent);
    await waitFor(
      () => receivedEventIds(firstSubscriber.messages).includes(1431),
      { timeoutMs: options.timeoutMs, label: "evento prima del restart" },
    );

    await endClient(firstSubscriber.client);
    firstSubscriber.client = null;
    const restartPort = broker.port;
    const brokerUrl = broker.url;
    await broker.close();
    await waitFor(() => !bridge.isReady(), { timeoutMs: options.timeoutMs, label: "bridge offline dopo broker down" });

    const duringDown = buildEvent({
      eventId: 1432,
      type: "order.created",
      aggregateType: "order",
      aggregateId: "order_step14c_down",
      detail: { orderId: "order_step14c_down" },
    });
    const downResult = bridge.publishEvent(duringDown.envelope, duringDown.outboxEvent);

    broker = await startBroker(restartPort);
    secondSubscriber = await connectSubscriber({
      brokerUrl,
      topic: wildcardTopic,
      clientId: `step14c-second-${process.pid}`,
      timeoutMs: options.timeoutMs,
    });
    await waitFor(() => bridge.isReady(), { timeoutMs: options.timeoutMs, label: "bridge riconnesso dopo broker restart" });

    const after = buildEvent({
      eventId: 1433,
      type: "order.created",
      aggregateType: "order",
      aggregateId: "order_step14c_after",
      detail: { orderId: "order_step14c_after" },
    });
    const afterResult = bridge.publishEvent(after.envelope, after.outboxEvent);
    await waitFor(
      () => receivedEventIds(secondSubscriber.messages).includes(1433),
      { timeoutMs: options.timeoutMs, label: "evento dopo broker restart" },
    );

    const secondIds = receivedEventIds(secondSubscriber.messages);
    const checks = [
      {
        name: "initial delivery",
        ok: beforeResult.ok === true && receivedEventIds(firstSubscriber.messages).includes(1431),
        detail: "eventId 1431 consegnato",
      },
      {
        name: "publish down safe",
        ok: downResult.ok === false && downResult.reason === "not_connected",
        detail: `result=${downResult.reason ?? "unknown"}`,
      },
      {
        name: "reconnect",
        ok: bridge.isReady(),
        detail: `broker restarted on ${brokerUrl}`,
      },
      {
        name: "post restart delivery",
        ok: afterResult.ok === true && secondIds.includes(1433),
        detail: "eventId 1433 consegnato",
      },
      {
        name: "down event not queued in mqtt client",
        ok: !secondIds.includes(1432),
        detail: "eventId 1432 non consegnato dal client MQTT interno",
      },
      {
        name: "commands disabled",
        ok: config.commandsEnabled === false,
        detail: "MQTT_COMMANDS_ENABLED=0",
      },
    ];

    return {
      ok: checks.every((check) => check.ok),
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      broker: { url: brokerUrl, restartPort },
      options: {
        timeoutMs: options.timeoutMs,
        reconnectMs: options.reconnectMs,
        storeId: config.storeId,
      },
      topics: { wildcardTopic },
      checks,
      publishResults: { before: beforeResult, duringDown: downResult, after: afterResult },
      received: {
        before: receivedEventIds(firstSubscriber.messages),
        after: secondIds,
      },
      metrics: metrics.snapshot(),
      warnings,
    };
  } finally {
    bridge.stop();
    if (firstSubscriber?.client) await endClient(firstSubscriber.client);
    if (secondSubscriber?.client) await endClient(secondSubscriber.client);
    await broker.close();
  }
}

export function formatMqttBridgeReconnectCanaryMarkdown(summary) {
  const lines = ["# MQTT bridge reconnect canary", ""];
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Broker: ${summary.broker.url}`);
  lines.push(`Store: ${summary.options.storeId}`);
  lines.push(`Reconnect: ${summary.options.reconnectMs}ms`);
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push(summary.ok ? "RESULT: OK" : "RESULT: FAIL");
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  for (const check of summary.checks) {
    lines.push(`- [${check.ok ? "OK" : "FAIL"}] ${check.name}: ${check.detail}`);
  }
  lines.push("");
  lines.push("## Received Event Ids");
  lines.push("");
  lines.push(`- before restart: ${summary.received.before.join(", ") || "-"}`);
  lines.push(`- after restart: ${summary.received.after.join(", ") || "-"}`);
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push("- Publish durante broker down non lancia errori.");
  lines.push("- Il bridge non conserva una coda MQTT alternativa alla event_outbox.");
  lines.push("- MQTT commands restano disabilitati.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeMqttBridgeReconnectCanaryReport(summary, outDir) {
  const targetDir = path.resolve(String(outDir || "reports").trim() || "reports");
  mkdirSync(targetDir, { recursive: true });
  const jsonPath = path.join(targetDir, "mqtt-bridge-reconnect-canary.json");
  const mdPath = path.join(targetDir, "mqtt-bridge-reconnect-canary.md");
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatMqttBridgeReconnectCanaryMarkdown(summary), "utf8");
  return { jsonPath, mdPath };
}

async function main() {
  const options = parseMqttBridgeReconnectCanaryArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = await runMqttBridgeReconnectCanary(options);
  const output = writeMqttBridgeReconnectCanaryReport(summary, options.outDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, output }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMqttBridgeReconnectCanaryMarkdown(summary));
    process.stdout.write(`[mqtt-bridge-reconnect-canary] JSON: ${output.jsonPath}\n`);
    process.stdout.write(`[mqtt-bridge-reconnect-canary] Markdown: ${output.mdPath}\n`);
  }
  return summary.ok ? 0 : 2;
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exit(1);
    },
  );
}
