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

const DEFAULT_CLIENTS = 10;
const DEFAULT_TIMEOUT_MS = 8000;

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

export function parseMqttBridgeCanaryArgs(argv = [], env = process.env) {
  const parsed = {
    brokerUrl: String(env.MQTT_CANARY_BROKER_URL || env.MQTT_URL || "").trim(),
    clients: normalizeInt(env.MQTT_CANARY_CLIENTS, DEFAULT_CLIENTS, { min: 1, max: 200 }),
    timeoutMs: normalizeInt(env.MQTT_CANARY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, {
      min: 1000,
      max: 120000,
    }),
    outDir: String(env.MQTT_CANARY_OUT_DIR || "reports").trim(),
    storeId: topicSegment(
      env.MQTT_CANARY_STORE_ID || `step14b-${todayStamp()}-${process.pid}`,
      "step14b",
    ),
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "");
    const readNext = () => String(argv[(index += 1)] ?? "");
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--broker-url") parsed.brokerUrl = readNext().trim();
    else if (arg.startsWith("--broker-url=")) parsed.brokerUrl = arg.slice("--broker-url=".length).trim();
    else if (arg === "--clients") parsed.clients = normalizeInt(readNext(), parsed.clients, { min: 1, max: 200 });
    else if (arg.startsWith("--clients=")) parsed.clients = normalizeInt(arg.slice("--clients=".length), parsed.clients, { min: 1, max: 200 });
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
  node scripts/mqtt-bridge-canary.mjs [opzioni]

Canary Step 14B:
  - avvia un broker MQTT embedded se --broker-url non e' indicato;
  - collega il bridge MQTT reale;
  - verifica wildcard subscribe, topic contract e retained ammesso per tavoli.

Opzioni:
  --broker-url URL   broker MQTT esterno, default broker embedded locale
  --clients N        subscriber simultanei, default ${DEFAULT_CLIENTS}
  --timeout-ms N     timeout verifiche, default ${DEFAULT_TIMEOUT_MS}
  --out-dir DIR      directory report, default reports
  --store-id ID      storeId MQTT, default step14b-YYYYMMDD-PID
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

async function startEmbeddedBroker() {
  const broker = await Aedes.createBroker();
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
    embedded: true,
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

function countTopic(messages, topic) {
  return messages.filter((message) => message.topic === topic).length;
}

export async function runMqttBridgeCanary(options = {}) {
  const startedAt = Date.now();
  const broker = options.brokerUrl
    ? { url: options.brokerUrl, embedded: false, close: async () => {} }
    : await startEmbeddedBroker();
  const clients = [];
  const allMessages = [];
  let retainedClient = null;
  const metrics = createMetricsProbe();
  const loggerMessages = [];
  const config = normalizeMqttBridgeConfig({
    MQTT_ENABLED: "1",
    MQTT_EVENTS_ENABLED: "1",
    MQTT_COMMANDS_ENABLED: "0",
    MQTT_RETAINED_STATE_ENABLED: "1",
    MQTT_URL: broker.url,
    MQTT_STORE_ID: options.storeId,
    MQTT_CLIENT_ID: `step14b-bridge-${process.pid}`,
  });
  const bridge = createMqttRealtimeBridge({
    config,
    logger: { warn: (message) => loggerMessages.push(String(message)) },
    metrics,
    nowMs: () => Date.now(),
  });

  try {
    const wildcardTopic = `pos/${config.storeId}/events/#`;
    for (let index = 0; index < options.clients; index += 1) {
      const client = await connectMqttClient(broker.url, {
        clientId: `step14b-sub-${process.pid}-${index}`,
        timeoutMs: options.timeoutMs,
      });
      client.on("message", (topic, payload, packet = {}) => {
        allMessages.push({
          clientId: client.options.clientId,
          topic,
          payload: payload.toString("utf8"),
          qos: packet.qos,
          retain: packet.retain === true,
        });
      });
      await subscribe(client, wildcardTopic, { qos: 1 });
      clients.push(client);
    }

    bridge.start();
    await waitFor(() => bridge.isReady(), { timeoutMs: options.timeoutMs, label: "bridge MQTT connesso" });

    const order = buildEvent({
      eventId: 1401,
      type: "order.created",
      aggregateType: "order",
      aggregateId: "order_step14b",
      detail: { orderId: "order_step14b" },
    });
    const table = buildEvent({
      eventId: 1402,
      type: "table.state",
      aggregateType: "table",
      aggregateId: "table_step14b",
      detail: { tableId: "table_step14b", status: "occupied" },
    });
    const payment = buildEvent({
      eventId: 1403,
      type: "payment.status",
      aggregateType: "payment",
      aggregateId: "payment_step14b",
      detail: { paymentId: "payment_step14b", status: "settled" },
    });

    const publishResults = [
      bridge.publishEvent(order.envelope, order.outboxEvent),
      bridge.publishEvent(table.envelope, table.outboxEvent),
      bridge.publishEvent(payment.envelope, payment.outboxEvent),
    ];
    const orderTopic = `pos/${config.storeId}/events/orders/order_step14b`;
    const tableTopic = `pos/${config.storeId}/events/tables/table_step14b`;
    const paymentTopic = `pos/${config.storeId}/events/payments/payment_step14b`;
    await waitFor(
      () =>
        countTopic(allMessages, orderTopic) >= options.clients &&
        countTopic(allMessages, tableTopic) >= options.clients &&
        countTopic(allMessages, paymentTopic) >= options.clients,
      { timeoutMs: options.timeoutMs, label: "consegna eventi MQTT ai client" },
    );

    const retainedMessages = [];
    retainedClient = await connectMqttClient(broker.url, {
      clientId: `step14b-retained-${process.pid}`,
      timeoutMs: options.timeoutMs,
    });
    retainedClient.on("message", (topic, payload, packet = {}) => {
      retainedMessages.push({
        topic,
        payload: payload.toString("utf8"),
        qos: packet.qos,
        retain: packet.retain === true,
      });
    });
    await subscribe(retainedClient, tableTopic, { qos: 1 });
    await waitFor(
      () => retainedMessages.some((message) => message.topic === tableTopic && message.retain),
      { timeoutMs: options.timeoutMs, label: "retained table state" },
    );

    const paymentRetainedMessages = [];
    const paymentRetainedClient = await connectMqttClient(broker.url, {
      clientId: `step14b-payment-retained-${process.pid}`,
      timeoutMs: options.timeoutMs,
    });
    clients.push(paymentRetainedClient);
    paymentRetainedClient.on("message", (topic, payload, packet = {}) => {
      paymentRetainedMessages.push({
        topic,
        payload: payload.toString("utf8"),
        qos: packet.qos,
        retain: packet.retain === true,
      });
    });
    await subscribe(paymentRetainedClient, paymentTopic, { qos: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const checks = [
      {
        name: "broker",
        ok: true,
        detail: broker.embedded ? "embedded MQTT broker" : broker.url,
      },
      {
        name: "commands disabled",
        ok: config.commandsEnabled === false,
        detail: `MQTT_COMMANDS_ENABLED=${config.commandsEnabled ? "1" : "0"}`,
      },
      {
        name: "wildcard delivery",
        ok:
          countTopic(allMessages, orderTopic) >= options.clients &&
          countTopic(allMessages, tableTopic) >= options.clients &&
          countTopic(allMessages, paymentTopic) >= options.clients,
        detail: `${allMessages.length} messaggi ricevuti da ${options.clients} client`,
      },
      {
        name: "table retained",
        ok: retainedMessages.some((message) => message.topic === tableTopic && message.retain),
        detail: tableTopic,
      },
      {
        name: "payment not retained",
        ok: paymentRetainedMessages.length === 0,
        detail: paymentTopic,
      },
      {
        name: "publish qos",
        ok: publishResults.every((result) => result.ok && result.qos === 1),
        detail: publishResults.map((result) => `${result.bucket}:${result.qos}`).join(", "),
      },
    ];

    return {
      ok: checks.every((check) => check.ok),
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      broker: { url: broker.url, embedded: broker.embedded },
      options: {
        clients: options.clients,
        timeoutMs: options.timeoutMs,
        storeId: config.storeId,
      },
      topics: { wildcardTopic, orderTopic, tableTopic, paymentTopic },
      checks,
      publishResults,
      received: {
        total: allMessages.length,
        order: countTopic(allMessages, orderTopic),
        table: countTopic(allMessages, tableTopic),
        payment: countTopic(allMessages, paymentTopic),
        retainedTable: retainedMessages.length,
        retainedPayment: paymentRetainedMessages.length,
      },
      metrics: metrics.snapshot(),
      warnings: loggerMessages,
    };
  } finally {
    bridge.stop();
    if (retainedClient) await endClient(retainedClient);
    await Promise.all(clients.map((client) => endClient(client)));
    await broker.close();
  }
}

export function formatMqttBridgeCanaryMarkdown(summary) {
  const lines = ["# MQTT bridge canary", ""];
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Broker: ${summary.broker.url}${summary.broker.embedded ? " (embedded)" : ""}`);
  lines.push(`Store: ${summary.options.storeId}`);
  lines.push(`Clients: ${summary.options.clients}`);
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
  lines.push("## Topics");
  lines.push("");
  lines.push(`- wildcard: ${summary.topics.wildcardTopic}`);
  lines.push(`- order: ${summary.topics.orderTopic}`);
  lines.push(`- table: ${summary.topics.tableTopic}`);
  lines.push(`- payment: ${summary.topics.paymentTopic}`);
  lines.push("");
  lines.push("## Received");
  lines.push("");
  lines.push(`- total: ${summary.received.total}`);
  lines.push(`- order: ${summary.received.order}`);
  lines.push(`- table: ${summary.received.table}`);
  lines.push(`- payment: ${summary.received.payment}`);
  lines.push(`- retained table: ${summary.received.retainedTable}`);
  lines.push(`- retained payment: ${summary.received.retainedPayment}`);
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push("- MQTT pubblica solo eventi derivati da event_outbox.");
  lines.push("- MQTT commands restano disabilitati.");
  lines.push("- Pagamenti non vengono pubblicati retained.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeMqttBridgeCanaryReport(summary, outDir) {
  const targetDir = path.resolve(String(outDir || "reports").trim() || "reports");
  mkdirSync(targetDir, { recursive: true });
  const jsonPath = path.join(targetDir, "mqtt-bridge-canary.json");
  const mdPath = path.join(targetDir, "mqtt-bridge-canary.md");
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatMqttBridgeCanaryMarkdown(summary), "utf8");
  return { jsonPath, mdPath };
}

async function main() {
  const options = parseMqttBridgeCanaryArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = await runMqttBridgeCanary(options);
  const output = writeMqttBridgeCanaryReport(summary, options.outDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, output }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMqttBridgeCanaryMarkdown(summary));
    process.stdout.write(`[mqtt-bridge-canary] JSON: ${output.jsonPath}\n`);
    process.stdout.write(`[mqtt-bridge-canary] Markdown: ${output.mdPath}\n`);
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
