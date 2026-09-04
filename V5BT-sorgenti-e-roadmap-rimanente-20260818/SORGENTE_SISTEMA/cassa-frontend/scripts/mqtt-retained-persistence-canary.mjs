#!/usr/bin/env node
import mqtt from "mqtt";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMqttClientOptions,
  createMqttRealtimeBridge,
  normalizeMqttBridgeConfig,
} from "../backend/modules/realtime-backbone/mqtt-bridge.js";

const DEFAULT_BROKER_URL = "mqtt://127.0.0.1:1883";
const DEFAULT_TIMEOUT_MS = 8000;

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeInt(value, fallback, { min = 1, max = 120000 } = {}) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function isTruthyFlag(value) {
  return ["1", "true", "yes", "on", "enabled"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

function isFalseyFlag(value) {
  return ["0", "false", "no", "off", "disabled"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
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

function credentialPresence(username, password) {
  return {
    username: normalizeText(username, ""),
    hasPassword: normalizeText(password, "") !== "",
  };
}

export function parseMqttRetainedPersistenceCanaryArgs(argv = [], env = process.env) {
  const parsed = {
    phase: normalizeText(env.MQTT_RETAINED_CANARY_PHASE, "publish").toLowerCase(),
    brokerUrl: normalizeText(
      env.MQTT_RETAINED_CANARY_BROKER_URL || env.MQTT_LIVE_CANARY_BROKER_URL || env.MQTT_URL,
      DEFAULT_BROKER_URL,
    ),
    backendUsername: normalizeText(
      env.MQTT_RETAINED_BACKEND_USERNAME ||
        env.MQTT_LIVE_BACKEND_USERNAME ||
        env.MQTT_BACKEND_USERNAME ||
        env.MQTT_USERNAME,
      "backend",
    ),
    backendPassword: normalizeText(
      env.MQTT_RETAINED_BACKEND_PASSWORD ||
        env.MQTT_LIVE_BACKEND_PASSWORD ||
        env.MQTT_BACKEND_PASSWORD ||
        env.MQTT_PASSWORD,
      "",
    ),
    deviceUsername: normalizeText(
      env.MQTT_RETAINED_DEVICE_USERNAME || env.MQTT_LIVE_DEVICE_USERNAME || env.MQTT_DEVICE_USERNAME,
      "palmare-template",
    ),
    devicePassword: normalizeText(
      env.MQTT_RETAINED_DEVICE_PASSWORD || env.MQTT_LIVE_DEVICE_PASSWORD || env.MQTT_DEVICE_PASSWORD,
      "",
    ),
    storeId: topicSegment(
      env.MQTT_RETAINED_CANARY_STORE_ID ||
        env.MQTT_LIVE_CANARY_STORE_ID ||
        env.MQTT_STORE_ID ||
        `step14h-${todayStamp()}-${process.pid}`,
      "step14h",
    ),
    markerFile: normalizeText(
      env.MQTT_RETAINED_CANARY_MARKER_FILE,
      path.join("reports", "mqtt-retained-persistence-marker.json"),
    ),
    outDir: normalizeText(env.MQTT_RETAINED_CANARY_OUT_DIR || "reports", "reports"),
    timeoutMs: normalizeInt(
      env.MQTT_RETAINED_CANARY_TIMEOUT_MS || env.MQTT_LIVE_CANARY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      { min: 1000, max: 120000 },
    ),
    tlsEnabled: isTruthyFlag(env.MQTT_RETAINED_TLS_ENABLED || env.MQTT_LIVE_TLS_ENABLED || env.MQTT_TLS_ENABLED),
    tlsRejectUnauthorized:
      env.MQTT_RETAINED_TLS_REJECT_UNAUTHORIZED === undefined &&
      env.MQTT_LIVE_TLS_REJECT_UNAUTHORIZED === undefined &&
      env.MQTT_TLS_REJECT_UNAUTHORIZED === undefined
        ? true
        : !isFalseyFlag(
            env.MQTT_RETAINED_TLS_REJECT_UNAUTHORIZED ??
              env.MQTT_LIVE_TLS_REJECT_UNAUTHORIZED ??
              env.MQTT_TLS_REJECT_UNAUTHORIZED,
          ),
    tlsCaPath: normalizeText(env.MQTT_RETAINED_TLS_CA_PATH || env.MQTT_LIVE_TLS_CA_PATH || env.MQTT_TLS_CA_PATH, ""),
    tlsCertPath: normalizeText(
      env.MQTT_RETAINED_TLS_CERT_PATH || env.MQTT_LIVE_TLS_CERT_PATH || env.MQTT_TLS_CERT_PATH,
      "",
    ),
    tlsKeyPath: normalizeText(env.MQTT_RETAINED_TLS_KEY_PATH || env.MQTT_LIVE_TLS_KEY_PATH || env.MQTT_TLS_KEY_PATH, ""),
    tlsServername: normalizeText(
      env.MQTT_RETAINED_TLS_SERVERNAME || env.MQTT_LIVE_TLS_SERVERNAME || env.MQTT_TLS_SERVERNAME,
      "",
    ),
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "");
    const readNext = () => String(argv[(index += 1)] ?? "");
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--phase") parsed.phase = readNext().trim().toLowerCase();
    else if (arg.startsWith("--phase=")) parsed.phase = arg.slice("--phase=".length).trim().toLowerCase();
    else if (arg === "--broker-url") parsed.brokerUrl = readNext().trim();
    else if (arg.startsWith("--broker-url=")) parsed.brokerUrl = arg.slice("--broker-url=".length).trim();
    else if (arg === "--backend-user") parsed.backendUsername = readNext().trim();
    else if (arg.startsWith("--backend-user=")) parsed.backendUsername = arg.slice("--backend-user=".length).trim();
    else if (arg === "--backend-pass") parsed.backendPassword = readNext();
    else if (arg.startsWith("--backend-pass=")) parsed.backendPassword = arg.slice("--backend-pass=".length);
    else if (arg === "--device-user") parsed.deviceUsername = readNext().trim();
    else if (arg.startsWith("--device-user=")) parsed.deviceUsername = arg.slice("--device-user=".length).trim();
    else if (arg === "--device-pass") parsed.devicePassword = readNext();
    else if (arg.startsWith("--device-pass=")) parsed.devicePassword = arg.slice("--device-pass=".length);
    else if (arg === "--store-id") parsed.storeId = topicSegment(readNext(), parsed.storeId);
    else if (arg.startsWith("--store-id=")) parsed.storeId = topicSegment(arg.slice("--store-id=".length), parsed.storeId);
    else if (arg === "--marker-file") parsed.markerFile = readNext().trim();
    else if (arg.startsWith("--marker-file=")) parsed.markerFile = arg.slice("--marker-file=".length).trim();
    else if (arg === "--out-dir") parsed.outDir = readNext().trim();
    else if (arg.startsWith("--out-dir=")) parsed.outDir = arg.slice("--out-dir=".length).trim();
    else if (arg === "--timeout-ms") parsed.timeoutMs = normalizeInt(readNext(), parsed.timeoutMs, { min: 1000, max: 120000 });
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = normalizeInt(arg.slice("--timeout-ms=".length), parsed.timeoutMs, { min: 1000, max: 120000 });
    else if (arg === "--tls") parsed.tlsEnabled = true;
    else if (arg === "--tls-ca") parsed.tlsCaPath = readNext().trim();
    else if (arg.startsWith("--tls-ca=")) parsed.tlsCaPath = arg.slice("--tls-ca=".length).trim();
    else if (arg === "--tls-cert") parsed.tlsCertPath = readNext().trim();
    else if (arg.startsWith("--tls-cert=")) parsed.tlsCertPath = arg.slice("--tls-cert=".length).trim();
    else if (arg === "--tls-key") parsed.tlsKeyPath = readNext().trim();
    else if (arg.startsWith("--tls-key=")) parsed.tlsKeyPath = arg.slice("--tls-key=".length).trim();
    else if (arg === "--tls-servername") parsed.tlsServername = readNext().trim();
    else if (arg.startsWith("--tls-servername=")) parsed.tlsServername = arg.slice("--tls-servername=".length).trim();
    else if (arg === "--tls-insecure") parsed.tlsRejectUnauthorized = false;
  }

  if (!["publish", "verify", "clear"].includes(parsed.phase)) parsed.phase = "publish";
  parsed.brokerUrl = normalizeText(parsed.brokerUrl, DEFAULT_BROKER_URL);
  parsed.backendUsername = topicSegment(parsed.backendUsername, "backend");
  parsed.deviceUsername = topicSegment(parsed.deviceUsername, "palmare-template");
  parsed.markerFile = path.resolve(parsed.markerFile || path.join("reports", "mqtt-retained-persistence-marker.json"));
  parsed.outDir = path.resolve(parsed.outDir || "reports");
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/mqtt-retained-persistence-canary.mjs --phase publish [opzioni]
  node scripts/mqtt-retained-persistence-canary.mjs --phase verify [opzioni]
  node scripts/mqtt-retained-persistence-canary.mjs --phase clear [opzioni]

Canary Step 14H:
  - publish: pubblica table.state retained e payment.status non-retained;
  - riavviare manualmente il broker Mosquitto reale;
  - verify: verifica che table.state sia ancora retained e payment.status no;
  - clear: cancella il retained marker table pubblicando payload vuoto retained.

Opzioni:
  --broker-url URL       default MQTT_URL o ${DEFAULT_BROKER_URL}
  --backend-user USER    default backend
  --backend-pass PASS    password backend da env/CLI
  --device-user USER     default palmare-template
  --device-pass PASS     password device da env/CLI
  --store-id ID          storeId topic
  --marker-file PATH     default reports/mqtt-retained-persistence-marker.json
  --timeout-ms N         timeout verifiche, default ${DEFAULT_TIMEOUT_MS}
  --tls                  forza TLS anche se URL non e' mqtts://
  --tls-ca PATH          CA trust locale
  --tls-cert PATH        certificato client opzionale
  --tls-key PATH         chiave client opzionale
  --tls-servername DNS   servername/SNI
  --tls-insecure         disabilita rejectUnauthorized solo per test locale
  --out-dir DIR          directory report, default reports
  --json                 stampa JSON

Le password non vengono scritte nel marker o nei report.
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

function buildConnectOptions(url, { clientId, username, password, timeoutMs, reconnectPeriod = 0, tls = {} } = {}) {
  const options = createMqttClientOptions(
    normalizeMqttBridgeConfig({
      MQTT_ENABLED: "1",
      MQTT_EVENTS_ENABLED: "1",
      MQTT_URL: url,
      MQTT_CLIENT_ID: clientId,
      MQTT_USERNAME: username,
      MQTT_PASSWORD: password,
      MQTT_CONNECT_TIMEOUT_MS: String(timeoutMs),
      MQTT_RECONNECT_PERIOD_MS: String(Math.max(250, reconnectPeriod)),
      MQTT_TLS_ENABLED: tls.tlsEnabled ? "1" : "",
      MQTT_TLS_REJECT_UNAUTHORIZED: tls.tlsRejectUnauthorized === false ? "0" : "1",
      MQTT_TLS_CA_PATH: tls.tlsCaPath,
      MQTT_TLS_CERT_PATH: tls.tlsCertPath,
      MQTT_TLS_KEY_PATH: tls.tlsKeyPath,
      MQTT_TLS_SERVERNAME: tls.tlsServername,
    }),
  );
  options.reconnectPeriod = reconnectPeriod;
  options.connectTimeout = timeoutMs;
  return options;
}

function connectMqttClient(url, { clientId, username, password, timeoutMs, reconnectPeriod = 0, tls = {} } = {}) {
  const options = buildConnectOptions(url, { clientId, username, password, timeoutMs, reconnectPeriod, tls });
  const client = mqtt.connect(url, options);
  client.on("error", () => {});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MQTT connect timeout: ${clientId}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      client.off("connect", onConnect);
      client.off("error", onError);
      client.off("close", onClose);
    };
    const onConnect = () => {
      cleanup();
      resolve(client);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`MQTT connection closed before connect: ${clientId}`));
    };
    client.once("connect", onConnect);
    client.once("error", onError);
    client.once("close", onClose);
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

function publish(client, topic, payload, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      client.off("close", onClose);
      client.off("error", onError);
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };
    const onClose = () => finish({ callbackOk: false, callbackError: "connection_closed" });
    const onError = (error) =>
      finish({ callbackOk: false, callbackError: String(error?.message ?? error ?? "mqtt_error") });
    const timer = setTimeout(
      () => finish({ callbackOk: false, callbackError: "publish_callback_timeout" }),
      Math.min(timeoutMs, 5000),
    );
    client.once("close", onClose);
    client.once("error", onError);
    try {
      client.publish(topic, payload, options, (error) => {
        finish({
          callbackOk: !error,
          callbackError: error ? String(error.message ?? error) : "",
        });
      });
    } catch (error) {
      finish({ callbackOk: false, callbackError: String(error?.message ?? error) });
    }
  });
}

function endClient(client) {
  return new Promise((resolve) => {
    try {
      client?.end?.(true, {}, resolve);
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

function parseMessagePayload(value) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return {};
  }
}

function expectedTopics({ storeId, markerId }) {
  return {
    tableTopic: `pos/${storeId}/events/tables/table_${markerId}`,
    paymentTopic: `pos/${storeId}/events/payments/payment_${markerId}`,
  };
}

function credentialsOk(options) {
  return Boolean(options.backendUsername && options.backendPassword && options.deviceUsername && options.devicePassword);
}

function safeOptions(options = {}) {
  return {
    phase: options.phase,
    storeId: options.storeId,
    timeoutMs: options.timeoutMs,
    markerFile: options.markerFile,
    tls: {
      enabled: options.tlsEnabled === true || String(options.brokerUrl ?? "").startsWith("mqtts://"),
      rejectUnauthorized: options.tlsRejectUnauthorized !== false,
      hasCaPath: normalizeText(options.tlsCaPath, "") !== "",
      hasCertPath: normalizeText(options.tlsCertPath, "") !== "",
      hasKeyPath: normalizeText(options.tlsKeyPath, "") !== "",
      servername: normalizeText(options.tlsServername, ""),
    },
    credentials: {
      backend: credentialPresence(options.backendUsername, options.backendPassword),
      device: credentialPresence(options.deviceUsername, options.devicePassword),
    },
  };
}

function markerFromOptions(options = {}) {
  const markerId = topicSegment(`s14h-${todayStamp()}-${Date.now()}-${process.pid}`, "s14h");
  const topics = expectedTopics({ storeId: options.storeId, markerId });
  return {
    version: 1,
    markerId,
    storeId: options.storeId,
    brokerUrl: options.brokerUrl,
    createdAt: new Date().toISOString(),
    tableEventId: 1801,
    paymentEventId: 1802,
    ...topics,
  };
}

function readMarker(markerFile) {
  if (!existsSync(markerFile)) {
    throw new Error(`Marker file non trovato: ${markerFile}`);
  }
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));
  const markerId = topicSegment(marker.markerId, "s14h");
  const storeId = topicSegment(marker.storeId, "step14h");
  return {
    ...marker,
    markerId,
    storeId,
    ...expectedTopics({ storeId, markerId }),
  };
}

function writeMarker(marker, markerFile) {
  mkdirSync(path.dirname(markerFile), { recursive: true });
  writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

async function collectRetained({ brokerUrl, username, password, timeoutMs, topics, clientId, tls = {} }) {
  const client = await connectMqttClient(brokerUrl, {
    clientId,
    username,
    password,
    timeoutMs,
    tls,
  });
  const messages = [];
  try {
    client.on("message", (topic, payload, packet = {}) => {
      messages.push({
        topic,
        payload: payload.toString("utf8"),
        retain: packet.retain === true,
        qos: packet.qos,
      });
    });
    for (const topic of topics) {
      await subscribe(client, topic, { qos: 1 });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return messages;
  } finally {
    await endClient(client);
  }
}

export async function runMqttRetainedPersistenceCanary(options = {}) {
  const startedAt = Date.now();
  const warnings = [];
  const metrics = createMetricsProbe();
  const credentialCheck = {
    name: "credentials configured",
    ok: credentialsOk(options),
    detail: "backend/device credentials required",
  };
  if (!credentialCheck.ok) {
    return {
      ok: false,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      broker: { url: options.brokerUrl },
      options: safeOptions(options),
      checks: [credentialCheck],
      warnings,
      metrics: metrics.snapshot(),
    };
  }

  if (options.phase === "verify") {
    return runVerifyPhase({ options, startedAt, warnings, metrics });
  }
  if (options.phase === "clear") {
    return runClearPhase({ options, startedAt, warnings, metrics });
  }
  return runPublishPhase({ options, startedAt, warnings, metrics });
}

async function runPublishPhase({ options, startedAt, warnings, metrics }) {
  const marker = markerFromOptions(options);
  const config = normalizeMqttBridgeConfig({
    MQTT_ENABLED: "1",
    MQTT_EVENTS_ENABLED: "1",
    MQTT_COMMANDS_ENABLED: "0",
    MQTT_RETAINED_STATE_ENABLED: "1",
    MQTT_URL: options.brokerUrl,
    MQTT_STORE_ID: marker.storeId,
    MQTT_CLIENT_ID: `s14h-bridge-${process.pid}-${Date.now()}`,
    MQTT_USERNAME: options.backendUsername,
    MQTT_PASSWORD: options.backendPassword,
    MQTT_TLS_ENABLED: options.tlsEnabled ? "1" : "",
    MQTT_TLS_REJECT_UNAUTHORIZED: options.tlsRejectUnauthorized === false ? "0" : "1",
    MQTT_TLS_CA_PATH: options.tlsCaPath,
    MQTT_TLS_CERT_PATH: options.tlsCertPath,
    MQTT_TLS_KEY_PATH: options.tlsKeyPath,
    MQTT_TLS_SERVERNAME: options.tlsServername,
    MQTT_CONNECT_TIMEOUT_MS: String(options.timeoutMs),
    MQTT_RECONNECT_PERIOD_MS: "0",
  });
  const bridge = createMqttRealtimeBridge({
    config,
    logger: { warn: (message) => warnings.push(String(message)) },
    metrics,
    nowMs: () => Date.now(),
  });

  try {
    bridge.start();
    await waitFor(() => bridge.isReady(), { timeoutMs: options.timeoutMs, label: "bridge retained connesso" });
    const tableEvent = buildEvent({
      eventId: marker.tableEventId,
      type: "table.state",
      aggregateType: "table",
      aggregateId: `table_${marker.markerId}`,
      detail: { tableId: `table_${marker.markerId}`, status: "occupied", markerId: marker.markerId },
    });
    const paymentEvent = buildEvent({
      eventId: marker.paymentEventId,
      type: "payment.status",
      aggregateType: "payment",
      aggregateId: `payment_${marker.markerId}`,
      detail: { paymentId: `payment_${marker.markerId}`, status: "settled", markerId: marker.markerId },
    });
    const tablePublish = bridge.publishEvent(tableEvent.envelope, tableEvent.outboxEvent);
    const paymentPublish = bridge.publishEvent(paymentEvent.envelope, paymentEvent.outboxEvent);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const retained = await collectRetained({
      brokerUrl: options.brokerUrl,
      username: options.deviceUsername,
      password: options.devicePassword,
      timeoutMs: options.timeoutMs,
      topics: [marker.tableTopic, marker.paymentTopic],
      clientId: `s14h-publish-verify-${process.pid}-${Date.now()}`,
      tls: options,
    });
    const retainedTable = retained.find((message) => message.topic === marker.tableTopic && message.retain);
    const retainedPayment = retained.find((message) => message.topic === marker.paymentTopic && message.retain);
    writeMarker(marker, options.markerFile);
    const checks = [
      { name: "credentials configured", ok: true, detail: "backend/device credentials present" },
      { name: "bridge connected", ok: bridge.isReady(), detail: options.brokerUrl },
      { name: "table publish retained", ok: tablePublish.ok === true && tablePublish.retain === true, detail: marker.tableTopic },
      { name: "payment publish not retained", ok: paymentPublish.ok === true && paymentPublish.retain === false, detail: marker.paymentTopic },
      {
        name: "immediate retained table visible",
        ok: Boolean(retainedTable && parseMessagePayload(retainedTable.payload).eventId === marker.tableEventId),
        detail: marker.tableTopic,
      },
      {
        name: "immediate payment retained absent",
        ok: !retainedPayment,
        detail: marker.paymentTopic,
      },
      { name: "marker file written", ok: existsSync(options.markerFile), detail: options.markerFile },
      { name: "commands disabled", ok: config.commandsEnabled === false, detail: "MQTT_COMMANDS_ENABLED=0" },
    ];
    return {
      ok: checks.every((check) => check.ok),
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      broker: { url: options.brokerUrl },
      options: safeOptions(options),
      marker,
      checks,
      received: { retained: retained.length },
      metrics: metrics.snapshot(),
      warnings,
      nextStep: "Riavviare il broker Mosquitto reale, poi eseguire --phase verify con lo stesso marker file.",
    };
  } finally {
    bridge.stop();
  }
}

async function runVerifyPhase({ options, startedAt, warnings, metrics }) {
  const marker = readMarker(options.markerFile);
  const retained = await collectRetained({
    brokerUrl: options.brokerUrl,
    username: options.deviceUsername,
    password: options.devicePassword,
    timeoutMs: options.timeoutMs,
    topics: [marker.tableTopic, marker.paymentTopic],
    clientId: `s14h-verify-${process.pid}-${Date.now()}`,
    tls: options,
  });
  const retainedTable = retained.find((message) => message.topic === marker.tableTopic && message.retain);
  const retainedPayment = retained.find((message) => message.topic === marker.paymentTopic && message.retain);
  const tablePayload = parseMessagePayload(retainedTable?.payload);
  const checks = [
    { name: "credentials configured", ok: true, detail: "backend/device credentials present" },
    { name: "marker file loaded", ok: true, detail: options.markerFile },
    {
      name: "table retained survived",
      ok: Boolean(retainedTable && tablePayload.eventId === marker.tableEventId),
      detail: marker.tableTopic,
    },
    {
      name: "payment retained absent",
      ok: !retainedPayment,
      detail: marker.paymentTopic,
    },
  ];
  return {
    ok: checks.every((check) => check.ok),
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    broker: { url: options.brokerUrl },
    options: safeOptions(options),
    marker,
    checks,
    received: { retained: retained.length },
    metrics: metrics.snapshot(),
    warnings,
  };
}

async function runClearPhase({ options, startedAt, warnings, metrics }) {
  const marker = readMarker(options.markerFile);
  const client = await connectMqttClient(options.brokerUrl, {
    clientId: `s14h-clear-${process.pid}-${Date.now()}`,
    username: options.backendUsername,
    password: options.backendPassword,
    timeoutMs: options.timeoutMs,
    tls: options,
  });
  try {
    const clearResult = await publish(client, marker.tableTopic, "", { qos: 1, retain: true }, options.timeoutMs);
    const retained = await collectRetained({
      brokerUrl: options.brokerUrl,
      username: options.deviceUsername,
      password: options.devicePassword,
      timeoutMs: options.timeoutMs,
      topics: [marker.tableTopic],
      clientId: `s14h-clear-verify-${process.pid}-${Date.now()}`,
      tls: options,
    });
    const retainedTable = retained.find((message) => message.topic === marker.tableTopic && message.retain);
    const checks = [
      { name: "credentials configured", ok: true, detail: "backend/device credentials present" },
      { name: "marker file loaded", ok: true, detail: options.markerFile },
      { name: "retained clear publish", ok: clearResult.callbackOk === true, detail: marker.tableTopic },
      { name: "table retained cleared", ok: !retainedTable, detail: marker.tableTopic },
    ];
    return {
      ok: checks.every((check) => check.ok),
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      broker: { url: options.brokerUrl },
      options: safeOptions(options),
      marker,
      checks,
      received: { retained: retained.length },
      metrics: metrics.snapshot(),
      warnings,
    };
  } finally {
    await endClient(client);
  }
}

export function formatMqttRetainedPersistenceCanaryMarkdown(summary) {
  const lines = ["# MQTT retained persistence canary", ""];
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Broker: ${summary.broker.url}`);
  lines.push(`Phase: ${summary.options.phase}`);
  lines.push(`Store: ${summary.options.storeId}`);
  lines.push(`Marker file: ${summary.options.markerFile}`);
  if (summary.marker) {
    lines.push(`Marker: ${summary.marker.markerId}`);
  }
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
  if (summary.marker) {
    lines.push("");
    lines.push("## Topics");
    lines.push("");
    lines.push(`- table: ${summary.marker.tableTopic}`);
    lines.push(`- payment: ${summary.marker.paymentTopic}`);
  }
  lines.push("");
  lines.push("## Credentials");
  lines.push("");
  for (const [name, credential] of Object.entries(summary.options.credentials ?? {})) {
    lines.push(`- ${name}: user=${credential.username || "-"}, password=${credential.hasPassword ? "present" : "missing"}`);
  }
  if (summary.nextStep) {
    lines.push("");
    lines.push("## Next");
    lines.push("");
    lines.push(summary.nextStep);
  }
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push("- Le password non sono scritte nel marker o nel report.");
  lines.push("- Solo table/print/settings possono essere retained: questo canary usa table.");
  lines.push("- Payment deve restare non-retained.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeMqttRetainedPersistenceCanaryReport(summary, outDir) {
  const targetDir = path.resolve(String(outDir || "reports").trim() || "reports");
  mkdirSync(targetDir, { recursive: true });
  const suffix = summary.options.phase || "publish";
  const jsonPath = path.join(targetDir, `mqtt-retained-persistence-canary-${suffix}.json`);
  const mdPath = path.join(targetDir, `mqtt-retained-persistence-canary-${suffix}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatMqttRetainedPersistenceCanaryMarkdown(summary), "utf8");
  return { jsonPath, mdPath };
}

async function main() {
  const options = parseMqttRetainedPersistenceCanaryArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = await runMqttRetainedPersistenceCanary(options);
  const output = writeMqttRetainedPersistenceCanaryReport(summary, options.outDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, output }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMqttRetainedPersistenceCanaryMarkdown(summary));
    process.stdout.write(`[mqtt-retained-persistence-canary] JSON: ${output.jsonPath}\n`);
    process.stdout.write(`[mqtt-retained-persistence-canary] Markdown: ${output.mdPath}\n`);
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
