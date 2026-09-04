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

const DEFAULT_CLIENTS = 100;
const DEFAULT_EVENTS = 5;
const DEFAULT_TIMEOUT_MS = 20000;

function normalizeInt(value, fallback, { min = 1, max = 1000 } = {}) {
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

export function parseMqttBridgeLoadCanaryArgs(argv = [], env = process.env) {
  const parsed = {
    clients: normalizeInt(env.MQTT_LOAD_CANARY_CLIENTS, DEFAULT_CLIENTS, { min: 1, max: 500 }),
    events: normalizeInt(env.MQTT_LOAD_CANARY_EVENTS, DEFAULT_EVENTS, { min: 1, max: 50 }),
    timeoutMs: normalizeInt(env.MQTT_LOAD_CANARY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, {
      min: 1000,
      max: 120000,
    }),
    outDir: String(env.MQTT_LOAD_CANARY_OUT_DIR || "reports").trim(),
    storeId: topicSegment(
      env.MQTT_LOAD_CANARY_STORE_ID || `step14d-${todayStamp()}-${process.pid}`,
      "step14d",
    ),
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "");
    const readNext = () => String(argv[(index += 1)] ?? "");
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--clients") parsed.clients = normalizeInt(readNext(), parsed.clients, { min: 1, max: 500 });
    else if (arg.startsWith("--clients=")) parsed.clients = normalizeInt(arg.slice("--clients=".length), parsed.clients, { min: 1, max: 500 });
    else if (arg === "--events") parsed.events = normalizeInt(readNext(), parsed.events, { min: 1, max: 50 });
    else if (arg.startsWith("--events=")) parsed.events = normalizeInt(arg.slice("--events=".length), parsed.events, { min: 1, max: 50 });
    else if (arg === "--timeout-ms") parsed.timeoutMs = normalizeInt(readNext(), parsed.timeoutMs, { min: 1000, max: 120000 });
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = normalizeInt(arg.slice("--timeout-ms=".length), parsed.timeoutMs, { min: 1000, max: 120000 });
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
  node scripts/mqtt-bridge-load-canary.mjs [opzioni]

Canary Step 14D:
  - avvia broker MQTT embedded;
  - collega N client subscriber wildcard;
  - pubblica eventi dal bridge MQTT reale;
  - verifica fanout e assenza duplicati per client/eventId.

Opzioni:
  --clients N        subscriber simultanei, default ${DEFAULT_CLIENTS}
  --events N         eventi pubblicati, default ${DEFAULT_EVENTS}
  --timeout-ms N     timeout verifiche, default ${DEFAULT_TIMEOUT_MS}
  --out-dir DIR      directory report, default reports
  --store-id ID      storeId MQTT, default step14d-YYYYMMDD-PID
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

async function startBroker() {
  const broker = await Aedes.createBroker({ concurrency: 256, maxClientsIdLength: 64 });
  const server = net.createServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = Math.max(1, Math.trunc(Number(address?.port) || 0));
  return {
    broker,
    server,
    url: `mqtt://127.0.0.1:${port}`,
    async close() {
      await Promise.allSettled([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => broker.close(resolve)),
      ]);
    },
  };
}

function connectMqttClient(url, { clientId, timeoutMs } = {}) {
  const client = mqtt.connect(url, {
    clientId,
    clean: true,
    connectTimeout: timeoutMs,
    reconnectPeriod: 0,
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

function buildEvent(index) {
  const eventId = 1440 + index;
  const variants = [
    { type: "order.created", aggregateType: "order", aggregateId: `order_step14d_${index}`, detailKey: "orderId" },
    { type: "table.state", aggregateType: "table", aggregateId: `table_step14d_${index}`, detailKey: "tableId" },
    { type: "print.status", aggregateType: "print", aggregateId: `print_step14d_${index}`, detailKey: "jobId" },
    { type: "payment.status", aggregateType: "payment", aggregateId: `payment_step14d_${index}`, detailKey: "paymentId" },
    { type: "fiscal.status", aggregateType: "fiscal_receipt", aggregateId: `fiscal_step14d_${index}`, detailKey: "receiptId" },
  ];
  const variant = variants[(index - 1) % variants.length];
  const createdAt = new Date().toISOString();
  const detail = { [variant.detailKey]: variant.aggregateId };
  const payload = {
    ok: true,
    reason: variant.type.replace(".", "_"),
    atMs: Date.now(),
    detail,
  };
  return {
    envelope: {
      eventId,
      type: variant.type,
      aggregateType: variant.aggregateType,
      aggregateId: variant.aggregateId,
      aggregateVersion: eventId,
      scope: "room_main",
      payload,
      createdAt,
    },
    outboxEvent: {
      id: eventId,
      eventType: variant.type,
      aggregateType: variant.aggregateType,
      aggregateId: variant.aggregateId,
      scope: "room_main",
      payload,
      occurredAt: createdAt,
    },
  };
}

function parseMessage(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function buildFanoutStats(messages, { clients, events }) {
  const expectedEventIds = Array.from({ length: events }, (_, index) => 1441 + index);
  const byEvent = Object.fromEntries(expectedEventIds.map((eventId) => [String(eventId), 0]));
  const duplicates = [];
  const seen = new Set();
  for (const message of messages) {
    const parsed = parseMessage(message.payload);
    const eventId = parsed?.eventId;
    if (eventId === undefined || eventId === null) continue;
    if (Object.prototype.hasOwnProperty.call(byEvent, String(eventId))) {
      byEvent[String(eventId)] += 1;
    }
    const key = `${message.clientId}:${eventId}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  return {
    expectedMessages: clients * events,
    receivedMessages: messages.length,
    byEvent,
    duplicates,
    allEventsDelivered: Object.values(byEvent).every((count) => count === clients),
  };
}

export async function runMqttBridgeLoadCanary(options = {}) {
  const startedAt = Date.now();
  const broker = await startBroker();
  const clients = [];
  const messages = [];
  const metrics = createMetricsProbe();
  const warnings = [];
  const config = normalizeMqttBridgeConfig({
    MQTT_ENABLED: "1",
    MQTT_EVENTS_ENABLED: "1",
    MQTT_COMMANDS_ENABLED: "0",
    MQTT_RETAINED_STATE_ENABLED: "1",
    MQTT_URL: broker.url,
    MQTT_STORE_ID: options.storeId,
    MQTT_CLIENT_ID: `s14d-bridge-${process.pid}`,
  });
  const bridge = createMqttRealtimeBridge({
    config,
    logger: { warn: (message) => warnings.push(String(message)) },
    metrics,
    nowMs: () => Date.now(),
  });

  try {
    const wildcardTopic = `pos/${config.storeId}/events/#`;
    const connectStartedAt = Date.now();
    await Promise.all(
      Array.from({ length: options.clients }, async (_, index) => {
        const client = await connectMqttClient(broker.url, {
          clientId: `s14d-${process.pid}-${index}`,
          timeoutMs: options.timeoutMs,
        });
        client.on("message", (topic, payload, packet = {}) => {
          messages.push({
            clientId: client.options.clientId,
            topic,
            payload: payload.toString("utf8"),
            qos: packet.qos,
            retain: packet.retain === true,
          });
        });
        await subscribe(client, wildcardTopic, { qos: 1 });
        clients[index] = client;
      }),
    );
    const connectDurationMs = Date.now() - connectStartedAt;

    bridge.start();
    await waitFor(() => bridge.isReady(), { timeoutMs: options.timeoutMs, label: "bridge MQTT connesso" });

    const publishStartedAt = Date.now();
    const publishResults = [];
    for (let index = 1; index <= options.events; index += 1) {
      const event = buildEvent(index);
      publishResults.push(bridge.publishEvent(event.envelope, event.outboxEvent));
    }
    await waitFor(
      () => messages.length >= options.clients * options.events,
      { timeoutMs: options.timeoutMs, label: "fanout MQTT 100 client" },
    );
    const publishDurationMs = Date.now() - publishStartedAt;
    const fanout = buildFanoutStats(messages, options);
    const checks = [
      {
        name: "clients connected",
        ok: clients.filter(Boolean).length === options.clients,
        detail: `${clients.filter(Boolean).length}/${options.clients}`,
      },
      {
        name: "fanout delivery",
        ok: fanout.receivedMessages === fanout.expectedMessages && fanout.allEventsDelivered,
        detail: `${fanout.receivedMessages}/${fanout.expectedMessages}`,
      },
      {
        name: "no duplicate per client event",
        ok: fanout.duplicates.length === 0,
        detail: `${fanout.duplicates.length} duplicati`,
      },
      {
        name: "publish qos",
        ok: publishResults.every((result) => result.ok && result.qos === 1),
        detail: publishResults.map((result) => `${result.bucket}:${result.qos}`).join(", "),
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
      broker: { url: broker.url, embedded: true },
      options: {
        clients: options.clients,
        events: options.events,
        timeoutMs: options.timeoutMs,
        storeId: config.storeId,
      },
      timings: { connectDurationMs, publishDurationMs },
      topics: { wildcardTopic },
      checks,
      fanout,
      publishResults,
      metrics: metrics.snapshot(),
      warnings,
    };
  } finally {
    bridge.stop();
    await Promise.all(clients.filter(Boolean).map((client) => endClient(client)));
    await broker.close();
  }
}

export function formatMqttBridgeLoadCanaryMarkdown(summary) {
  const lines = ["# MQTT bridge load canary", ""];
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Broker: ${summary.broker.url}${summary.broker.embedded ? " (embedded)" : ""}`);
  lines.push(`Store: ${summary.options.storeId}`);
  lines.push(`Clients: ${summary.options.clients}`);
  lines.push(`Events: ${summary.options.events}`);
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
  lines.push("## Fanout");
  lines.push("");
  lines.push(`- expected messages: ${summary.fanout.expectedMessages}`);
  lines.push(`- received messages: ${summary.fanout.receivedMessages}`);
  lines.push(`- duplicates: ${summary.fanout.duplicates.length}`);
  for (const [eventId, count] of Object.entries(summary.fanout.byEvent)) {
    lines.push(`- event ${eventId}: ${count}`);
  }
  lines.push("");
  lines.push("## Timings");
  lines.push("");
  lines.push(`- connect clients: ${summary.timings.connectDurationMs}ms`);
  lines.push(`- publish fanout: ${summary.timings.publishDurationMs}ms`);
  lines.push(`- total: ${summary.durationMs}ms`);
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push("- MQTT commands restano disabilitati.");
  lines.push("- Ogni payload include eventId per deduplica client.");
  lines.push("- Il broker embedded serve solo per canary/load locale.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeMqttBridgeLoadCanaryReport(summary, outDir) {
  const targetDir = path.resolve(String(outDir || "reports").trim() || "reports");
  mkdirSync(targetDir, { recursive: true });
  const jsonPath = path.join(targetDir, "mqtt-bridge-load-canary.json");
  const mdPath = path.join(targetDir, "mqtt-bridge-load-canary.md");
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatMqttBridgeLoadCanaryMarkdown(summary), "utf8");
  return { jsonPath, mdPath };
}

async function main() {
  const options = parseMqttBridgeLoadCanaryArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = await runMqttBridgeLoadCanary(options);
  const output = writeMqttBridgeLoadCanaryReport(summary, options.outDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, output }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMqttBridgeLoadCanaryMarkdown(summary));
    process.stdout.write(`[mqtt-bridge-load-canary] JSON: ${output.jsonPath}\n`);
    process.stdout.write(`[mqtt-bridge-load-canary] Markdown: ${output.mdPath}\n`);
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
