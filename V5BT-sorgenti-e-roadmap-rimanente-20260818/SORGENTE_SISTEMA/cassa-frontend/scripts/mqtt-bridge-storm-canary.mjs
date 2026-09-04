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

const DEFAULT_CLIENTS = 50;
const DEFAULT_CYCLES = 3;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RECONNECT_MS = 150;

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

export function parseMqttBridgeStormCanaryArgs(argv = [], env = process.env) {
  const parsed = {
    clients: normalizeInt(env.MQTT_STORM_CANARY_CLIENTS, DEFAULT_CLIENTS, { min: 1, max: 300 }),
    cycles: normalizeInt(env.MQTT_STORM_CANARY_CYCLES, DEFAULT_CYCLES, { min: 1, max: 20 }),
    timeoutMs: normalizeInt(env.MQTT_STORM_CANARY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, {
      min: 1000,
      max: 180000,
    }),
    reconnectMs: normalizeInt(env.MQTT_STORM_CANARY_RECONNECT_MS, DEFAULT_RECONNECT_MS, {
      min: 50,
      max: 10000,
    }),
    outDir: String(env.MQTT_STORM_CANARY_OUT_DIR || "reports").trim(),
    storeId: topicSegment(
      env.MQTT_STORM_CANARY_STORE_ID || `step14f-${todayStamp()}-${process.pid}`,
      "step14f",
    ),
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "");
    const readNext = () => String(argv[(index += 1)] ?? "");
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--clients") parsed.clients = normalizeInt(readNext(), parsed.clients, { min: 1, max: 300 });
    else if (arg.startsWith("--clients=")) parsed.clients = normalizeInt(arg.slice("--clients=".length), parsed.clients, { min: 1, max: 300 });
    else if (arg === "--cycles") parsed.cycles = normalizeInt(readNext(), parsed.cycles, { min: 1, max: 20 });
    else if (arg.startsWith("--cycles=")) parsed.cycles = normalizeInt(arg.slice("--cycles=".length), parsed.cycles, { min: 1, max: 20 });
    else if (arg === "--timeout-ms") parsed.timeoutMs = normalizeInt(readNext(), parsed.timeoutMs, { min: 1000, max: 180000 });
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = normalizeInt(arg.slice("--timeout-ms=".length), parsed.timeoutMs, { min: 1000, max: 180000 });
    else if (arg === "--reconnect-ms") parsed.reconnectMs = normalizeInt(readNext(), parsed.reconnectMs, { min: 50, max: 10000 });
    else if (arg.startsWith("--reconnect-ms=")) parsed.reconnectMs = normalizeInt(arg.slice("--reconnect-ms=".length), parsed.reconnectMs, { min: 50, max: 10000 });
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
  node scripts/mqtt-bridge-storm-canary.mjs [opzioni]

Canary Step 14F:
  - avvia broker MQTT embedded;
  - collega N subscriber wildcard con reconnect attivo;
  - esegue C restart del broker sulla stessa porta;
  - verifica reconnect storm, publish safe durante down e consegna post-restart.

Opzioni:
  --clients N        subscriber simultanei, default ${DEFAULT_CLIENTS}
  --cycles N         cicli restart broker, default ${DEFAULT_CYCLES}
  --timeout-ms N     timeout verifiche, default ${DEFAULT_TIMEOUT_MS}
  --reconnect-ms N   reconnect period client/bridge, default ${DEFAULT_RECONNECT_MS}
  --out-dir DIR      directory report, default reports
  --store-id ID      storeId MQTT, default step14f-YYYYMMDD-PID
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
  const broker = await Aedes.createBroker({ concurrency: 256, maxClientsIdLength: 64 });
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

function connectMqttClient(url, { clientId, timeoutMs, reconnectMs }) {
  const client = mqtt.connect(url, {
    clientId,
    clean: true,
    connectTimeout: timeoutMs,
    reconnectPeriod: reconnectMs,
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

function buildEvent(eventId, cycle) {
  const createdAt = new Date().toISOString();
  const aggregateId = `order_step14f_${cycle}`;
  const payload = {
    ok: true,
    reason: "order_created",
    atMs: Date.now(),
    detail: { orderId: aggregateId, cycle },
  };
  return {
    envelope: {
      eventId,
      type: "order.created",
      aggregateType: "order",
      aggregateId,
      aggregateVersion: eventId,
      scope: "room_main",
      payload,
      createdAt,
    },
    outboxEvent: {
      id: eventId,
      eventType: "order.created",
      aggregateType: "order",
      aggregateId,
      scope: "room_main",
      payload,
      occurredAt: createdAt,
    },
  };
}

function parseEventId(payload) {
  try {
    return JSON.parse(payload)?.eventId ?? null;
  } catch {
    return null;
  }
}

function eventCount(messages, eventId) {
  return messages.filter((message) => parseEventId(message.payload) === eventId).length;
}

function duplicateKeys(messages) {
  const seen = new Set();
  const duplicates = [];
  for (const message of messages) {
    const eventId = parseEventId(message.payload);
    if (eventId === null) continue;
    const key = `${message.clientId}:${eventId}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  return duplicates;
}

export async function runMqttBridgeStormCanary(options = {}) {
  const startedAt = Date.now();
  let broker = await startBroker(0);
  const clients = [];
  const messages = [];
  const clientStats = new Map();
  const metrics = createMetricsProbe();
  const warnings = [];
  const config = normalizeMqttBridgeConfig({
    MQTT_ENABLED: "1",
    MQTT_EVENTS_ENABLED: "1",
    MQTT_COMMANDS_ENABLED: "0",
    MQTT_RETAINED_STATE_ENABLED: "1",
    MQTT_URL: broker.url,
    MQTT_STORE_ID: options.storeId,
    MQTT_CLIENT_ID: `s14f-bridge-${process.pid}`,
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
    await Promise.all(
      Array.from({ length: options.clients }, async (_, index) => {
        const clientId = `s14f-${process.pid}-${index}`;
        const stats = { connects: 0, reconnects: 0, closes: 0, offline: 0, errors: 0 };
        clientStats.set(clientId, stats);
        const client = await connectMqttClient(broker.url, {
          clientId,
          timeoutMs: options.timeoutMs,
          reconnectMs: options.reconnectMs,
        });
        stats.connects += 1;
        client.on("connect", () => {
          stats.connects += 1;
        });
        client.on("reconnect", () => {
          stats.reconnects += 1;
        });
        client.on("close", () => {
          stats.closes += 1;
        });
        client.on("offline", () => {
          stats.offline += 1;
        });
        client.on("error", () => {
          stats.errors += 1;
        });
        client.on("message", (topic, payload, packet = {}) => {
          messages.push({
            clientId,
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

    bridge.start();
    await waitFor(() => bridge.isReady(), { timeoutMs: options.timeoutMs, label: "bridge iniziale connesso" });

    const cycleResults = [];
    const brokerUrl = broker.url;
    const restartPort = broker.port;
    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
      await broker.close();
      await waitFor(() => !bridge.isReady(), { timeoutMs: options.timeoutMs, label: `bridge offline ciclo ${cycle}` });

      const downEventId = 1490 + cycle;
      const downEvent = buildEvent(downEventId, cycle);
      const downResult = bridge.publishEvent(downEvent.envelope, downEvent.outboxEvent);

      broker = await startBroker(restartPort);
      await waitFor(() => bridge.isReady(), { timeoutMs: options.timeoutMs, label: `bridge riconnesso ciclo ${cycle}` });
      await waitFor(
        () => [...clientStats.values()].every((stats) => stats.connects >= cycle + 1),
        { timeoutMs: options.timeoutMs, label: `client riconnessi ciclo ${cycle}` },
      );

      const eventId = 1500 + cycle;
      const event = buildEvent(eventId, cycle);
      const publishStartedAt = Date.now();
      const publishResult = bridge.publishEvent(event.envelope, event.outboxEvent);
      await waitFor(
        () => eventCount(messages, eventId) >= options.clients,
        { timeoutMs: options.timeoutMs, label: `fanout post storm ciclo ${cycle}` },
      );
      cycleResults.push({
        cycle,
        downEventId,
        eventId,
        downResult,
        publishResult,
        delivered: eventCount(messages, eventId),
        publishFanoutMs: Date.now() - publishStartedAt,
      });
    }

    const duplicates = duplicateKeys(messages);
    const downDelivered = cycleResults.map((cycle) => ({
      cycle: cycle.cycle,
      eventId: cycle.downEventId,
      delivered: eventCount(messages, cycle.downEventId),
    }));
    const stats = [...clientStats.entries()].map(([clientId, value]) => ({ clientId, ...value }));
    const checks = [
      {
        name: "clients connected",
        ok: clients.filter(Boolean).length === options.clients,
        detail: `${clients.filter(Boolean).length}/${options.clients}`,
      },
      {
        name: "all clients reconnected every cycle",
        ok: stats.every((entry) => entry.connects >= options.cycles + 1),
        detail: `${stats.filter((entry) => entry.connects >= options.cycles + 1).length}/${options.clients}`,
      },
      {
        name: "post restart fanout",
        ok: cycleResults.every((cycle) => cycle.delivered === options.clients),
        detail: cycleResults.map((cycle) => `c${cycle.cycle}:${cycle.delivered}/${options.clients}`).join(", "),
      },
      {
        name: "publish down safe",
        ok: cycleResults.every((cycle) => cycle.downResult.ok === false && cycle.downResult.reason === "not_connected"),
        detail: cycleResults.map((cycle) => `c${cycle.cycle}:${cycle.downResult.reason ?? "unknown"}`).join(", "),
      },
      {
        name: "down events not queued in mqtt client",
        ok: downDelivered.every((entry) => entry.delivered === 0),
        detail: downDelivered.map((entry) => `c${entry.cycle}:${entry.delivered}`).join(", "),
      },
      {
        name: "no duplicate per client event",
        ok: duplicates.length === 0,
        detail: `${duplicates.length} duplicati`,
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
        clients: options.clients,
        cycles: options.cycles,
        reconnectMs: options.reconnectMs,
        timeoutMs: options.timeoutMs,
        storeId: config.storeId,
      },
      topics: { wildcardTopic },
      checks,
      cycles: cycleResults,
      downDelivered,
      clientStats: {
        connectedEveryCycle: stats.filter((entry) => entry.connects >= options.cycles + 1).length,
        totalReconnectSignals: stats.reduce((sum, entry) => sum + entry.reconnects, 0),
        totalCloseSignals: stats.reduce((sum, entry) => sum + entry.closes, 0),
        totalErrors: stats.reduce((sum, entry) => sum + entry.errors, 0),
      },
      received: {
        total: messages.length,
        duplicates: duplicates.length,
      },
      metrics: metrics.snapshot(),
      warnings,
    };
  } finally {
    bridge.stop();
    await Promise.all(clients.filter(Boolean).map((client) => endClient(client)));
    await broker.close();
  }
}

export function formatMqttBridgeStormCanaryMarkdown(summary) {
  const lines = ["# MQTT bridge reconnect storm canary", ""];
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Broker: ${summary.broker.url}`);
  lines.push(`Store: ${summary.options.storeId}`);
  lines.push(`Clients: ${summary.options.clients}`);
  lines.push(`Cycles: ${summary.options.cycles}`);
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
  lines.push("## Cycles");
  lines.push("");
  for (const cycle of summary.cycles) {
    lines.push(`- cycle ${cycle.cycle}: event ${cycle.eventId} delivered ${cycle.delivered}, fanout ${cycle.publishFanoutMs}ms`);
  }
  lines.push("");
  lines.push("## Client Stats");
  lines.push("");
  lines.push(`- connected every cycle: ${summary.clientStats.connectedEveryCycle}/${summary.options.clients}`);
  lines.push(`- reconnect signals: ${summary.clientStats.totalReconnectSignals}`);
  lines.push(`- close signals: ${summary.clientStats.totalCloseSignals}`);
  lines.push(`- errors: ${summary.clientStats.totalErrors}`);
  lines.push(`- duplicates: ${summary.received.duplicates}`);
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push("- Publish durante broker down non lancia errori.");
  lines.push("- Il bridge non conserva una coda MQTT alternativa alla event_outbox.");
  lines.push("- MQTT commands restano disabilitati.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeMqttBridgeStormCanaryReport(summary, outDir) {
  const targetDir = path.resolve(String(outDir || "reports").trim() || "reports");
  mkdirSync(targetDir, { recursive: true });
  const jsonPath = path.join(targetDir, "mqtt-bridge-storm-canary.json");
  const mdPath = path.join(targetDir, "mqtt-bridge-storm-canary.md");
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatMqttBridgeStormCanaryMarkdown(summary), "utf8");
  return { jsonPath, mdPath };
}

async function main() {
  const options = parseMqttBridgeStormCanaryArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = await runMqttBridgeStormCanary(options);
  const output = writeMqttBridgeStormCanaryReport(summary, options.outDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, output }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMqttBridgeStormCanaryMarkdown(summary));
    process.stdout.write(`[mqtt-bridge-storm-canary] JSON: ${output.jsonPath}\n`);
    process.stdout.write(`[mqtt-bridge-storm-canary] Markdown: ${output.mdPath}\n`);
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
