#!/usr/bin/env node
import mqtt from "mqtt";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMqttClientOptions,
  createMqttRealtimeBridge,
  normalizeMqttBridgeConfig,
} from "../backend/modules/realtime-backbone/mqtt-bridge.js";

const DEFAULT_BROKER_URL = "mqtt://127.0.0.1:1883";
const DEFAULT_TIMEOUT_MS = 8000;

function normalizeInt(value, fallback, { min = 1, max = 120000 } = {}) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
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

export function parseMqttMosquittoLiveCanaryArgs(argv = [], env = process.env) {
  const parsed = {
    brokerUrl: normalizeText(
      env.MQTT_LIVE_CANARY_BROKER_URL || env.MQTT_CANARY_BROKER_URL || env.MQTT_URL,
      DEFAULT_BROKER_URL,
    ),
    backendUsername: normalizeText(
      env.MQTT_LIVE_BACKEND_USERNAME || env.MQTT_BACKEND_USERNAME || env.MQTT_USERNAME,
      "backend",
    ),
    backendPassword: normalizeText(
      env.MQTT_LIVE_BACKEND_PASSWORD || env.MQTT_BACKEND_PASSWORD || env.MQTT_PASSWORD,
      "",
    ),
    deviceUsername: normalizeText(env.MQTT_LIVE_DEVICE_USERNAME || env.MQTT_DEVICE_USERNAME, "palmare-template"),
    devicePassword: normalizeText(env.MQTT_LIVE_DEVICE_PASSWORD || env.MQTT_DEVICE_PASSWORD, ""),
    printerUsername: normalizeText(
      env.MQTT_LIVE_PRINTER_USERNAME || env.MQTT_PRINTER_USERNAME,
      "printer-gateway-template",
    ),
    printerPassword: normalizeText(env.MQTT_LIVE_PRINTER_PASSWORD || env.MQTT_PRINTER_PASSWORD, ""),
    storeId: topicSegment(
      env.MQTT_LIVE_CANARY_STORE_ID || env.MQTT_CANARY_STORE_ID || env.MQTT_STORE_ID || `step14g-${todayStamp()}-${process.pid}`,
      "step14g",
    ),
    timeoutMs: normalizeInt(env.MQTT_LIVE_CANARY_TIMEOUT_MS || env.MQTT_CANARY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, {
      min: 1000,
      max: 120000,
    }),
    outDir: normalizeText(env.MQTT_LIVE_CANARY_OUT_DIR || "reports", "reports"),
    skipAnonymous: isTruthyFlag(env.MQTT_LIVE_CANARY_SKIP_ANONYMOUS),
    skipPrinter: isTruthyFlag(env.MQTT_LIVE_CANARY_SKIP_PRINTER),
    tlsEnabled: isTruthyFlag(env.MQTT_LIVE_TLS_ENABLED || env.MQTT_TLS_ENABLED),
    tlsRejectUnauthorized:
      env.MQTT_LIVE_TLS_REJECT_UNAUTHORIZED === undefined && env.MQTT_TLS_REJECT_UNAUTHORIZED === undefined
        ? true
        : !isFalseyFlag(env.MQTT_LIVE_TLS_REJECT_UNAUTHORIZED ?? env.MQTT_TLS_REJECT_UNAUTHORIZED),
    tlsCaPath: normalizeText(env.MQTT_LIVE_TLS_CA_PATH || env.MQTT_TLS_CA_PATH, ""),
    tlsCertPath: normalizeText(env.MQTT_LIVE_TLS_CERT_PATH || env.MQTT_TLS_CERT_PATH, ""),
    tlsKeyPath: normalizeText(env.MQTT_LIVE_TLS_KEY_PATH || env.MQTT_TLS_KEY_PATH, ""),
    tlsServername: normalizeText(env.MQTT_LIVE_TLS_SERVERNAME || env.MQTT_TLS_SERVERNAME, ""),
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
    else if (arg === "--backend-user") parsed.backendUsername = readNext().trim();
    else if (arg.startsWith("--backend-user=")) parsed.backendUsername = arg.slice("--backend-user=".length).trim();
    else if (arg === "--backend-pass") parsed.backendPassword = readNext();
    else if (arg.startsWith("--backend-pass=")) parsed.backendPassword = arg.slice("--backend-pass=".length);
    else if (arg === "--device-user") parsed.deviceUsername = readNext().trim();
    else if (arg.startsWith("--device-user=")) parsed.deviceUsername = arg.slice("--device-user=".length).trim();
    else if (arg === "--device-pass") parsed.devicePassword = readNext();
    else if (arg.startsWith("--device-pass=")) parsed.devicePassword = arg.slice("--device-pass=".length);
    else if (arg === "--printer-user") parsed.printerUsername = readNext().trim();
    else if (arg.startsWith("--printer-user=")) parsed.printerUsername = arg.slice("--printer-user=".length).trim();
    else if (arg === "--printer-pass") parsed.printerPassword = readNext();
    else if (arg.startsWith("--printer-pass=")) parsed.printerPassword = arg.slice("--printer-pass=".length);
    else if (arg === "--store-id") parsed.storeId = topicSegment(readNext(), parsed.storeId);
    else if (arg.startsWith("--store-id=")) parsed.storeId = topicSegment(arg.slice("--store-id=".length), parsed.storeId);
    else if (arg === "--timeout-ms") parsed.timeoutMs = normalizeInt(readNext(), parsed.timeoutMs, { min: 1000, max: 120000 });
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = normalizeInt(arg.slice("--timeout-ms=".length), parsed.timeoutMs, { min: 1000, max: 120000 });
    else if (arg === "--out-dir") parsed.outDir = readNext().trim();
    else if (arg.startsWith("--out-dir=")) parsed.outDir = arg.slice("--out-dir=".length).trim();
    else if (arg === "--skip-anonymous") parsed.skipAnonymous = true;
    else if (arg === "--skip-printer") parsed.skipPrinter = true;
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

  parsed.brokerUrl = normalizeText(parsed.brokerUrl, DEFAULT_BROKER_URL);
  parsed.backendUsername = topicSegment(parsed.backendUsername, "backend");
  parsed.deviceUsername = topicSegment(parsed.deviceUsername, "palmare-template");
  parsed.printerUsername = topicSegment(parsed.printerUsername, "printer-gateway-template");
  parsed.outDir = path.resolve(parsed.outDir || "reports");
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node scripts/mqtt-mosquitto-live-canary.mjs [opzioni]

Canary Step 14G:
  - valida un broker Mosquitto reale/LAN con credenziali esterne;
  - usa il bridge MQTT reale come backend writer;
  - verifica device read-only su events e presence propria;
  - verifica printer gateway se configurato.

Opzioni:
  --broker-url URL      default MQTT_URL o ${DEFAULT_BROKER_URL}
  --backend-user USER   default MQTT_LIVE_BACKEND_USERNAME o backend
  --backend-pass PASS   default MQTT_LIVE_BACKEND_PASSWORD
  --device-user USER    default MQTT_LIVE_DEVICE_USERNAME o palmare-template
  --device-pass PASS    default MQTT_LIVE_DEVICE_PASSWORD
  --printer-user USER   default MQTT_LIVE_PRINTER_USERNAME o printer-gateway-template
  --printer-pass PASS   default MQTT_LIVE_PRINTER_PASSWORD
  --store-id ID         storeId usato nei topic
  --timeout-ms N        timeout verifiche, default ${DEFAULT_TIMEOUT_MS}
  --skip-anonymous      non verifica rifiuto anonymous connect
  --skip-printer        non verifica ruolo printer gateway
  --tls                 forza TLS anche se URL non e' mqtts://
  --tls-ca PATH         CA trust locale
  --tls-cert PATH       certificato client opzionale
  --tls-key PATH        chiave client opzionale
  --tls-servername DNS  servername/SNI
  --tls-insecure        disabilita rejectUnauthorized solo per test locale
  --out-dir DIR         directory report, default reports
  --json                stampa JSON

Le password non vengono scritte nei report.
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

async function connectShouldFail(url, { clientId, timeoutMs, tls = {} }) {
  let client = null;
  try {
    client = await connectMqttClient(url, { clientId, timeoutMs, tls });
    await endClient(client);
    return { ok: false, detail: "anonymous connect accepted" };
  } catch (error) {
    return { ok: true, detail: String(error?.message ?? error ?? "connect rejected") };
  }
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
    if (client.connected !== true) {
      resolve({ callbackOk: false, callbackError: "not_connected" });
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      client.off("close", onClose);
      client.off("error", onError);
    };
    let done = false;
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

function countTopic(messages, topic) {
  return messages.filter((message) => message.topic === topic).length;
}

function credentialsOk(options) {
  return Boolean(
    options.backendUsername &&
      options.backendPassword &&
      options.deviceUsername &&
      options.devicePassword &&
      (options.skipPrinter || (options.printerUsername && options.printerPassword)),
  );
}

export async function runMqttMosquittoLiveCanary(options = {}) {
  const startedAt = Date.now();
  const warnings = [];
  const messages = [];
  const printerMessages = [];
  const clients = [];
  const metrics = createMetricsProbe();
  const credentialCheck = {
    name: "credentials configured",
    ok: credentialsOk(options),
    detail: options.skipPrinter
      ? "backend/device credentials present, printer skipped"
      : "backend/device/printer credentials required",
  };

  if (!credentialCheck.ok) {
    return {
      ok: false,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      broker: { url: options.brokerUrl },
      options: safeOptions(options),
      checks: [credentialCheck],
      received: { events: 0, printer: 0 },
      metrics: metrics.snapshot(),
      warnings,
    };
  }

  const storeId = topicSegment(options.storeId, "step14g");
  const nonce = topicSegment(`s14g-${Date.now()}-${process.pid}`, "s14g");
  const wildcardTopic = `pos/${storeId}/events/#`;
  const orderTopic = `pos/${storeId}/events/orders/order_${nonce}`;
  const deniedDeviceTopic = `pos/${storeId}/events/orders/device_denied_${nonce}`;
  const presenceTopic = `pos/${storeId}/devices/${options.deviceUsername}/presence`;
  const printTopic = `pos/${storeId}/events/prints/print_${nonce}`;
  const deniedPrinterTopic = `pos/${storeId}/events/prints/printer_denied_${nonce}`;
  let bridge = null;

  try {
    const anonymousCheck = options.skipAnonymous
      ? { name: "anonymous denied", ok: true, detail: "skipped by flag" }
      : {
          name: "anonymous denied",
          ...(await connectShouldFail(options.brokerUrl, {
            clientId: `s14g-anon-${process.pid}-${Date.now()}`,
            timeoutMs: options.timeoutMs,
            tls: options,
          })),
        };

    const deviceClient = await connectMqttClient(options.brokerUrl, {
      clientId: `s14g-device-sub-${process.pid}-${Date.now()}`,
      username: options.deviceUsername,
      password: options.devicePassword,
      timeoutMs: options.timeoutMs,
      tls: options,
    });
    clients.push(deviceClient);
    deviceClient.on("message", (topic, payload, packet = {}) => {
      messages.push({
        topic,
        payload: payload.toString("utf8"),
        qos: packet.qos,
        retain: packet.retain === true,
      });
    });
    await subscribe(deviceClient, wildcardTopic, { qos: 1 });

    const config = normalizeMqttBridgeConfig({
      MQTT_ENABLED: "1",
      MQTT_EVENTS_ENABLED: "1",
      MQTT_COMMANDS_ENABLED: "0",
      MQTT_RETAINED_STATE_ENABLED: "1",
      MQTT_URL: options.brokerUrl,
      MQTT_STORE_ID: storeId,
      MQTT_CLIENT_ID: `s14g-bridge-${process.pid}-${Date.now()}`,
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
    bridge = createMqttRealtimeBridge({
      config,
      logger: { warn: (message) => warnings.push(String(message)) },
      metrics,
      nowMs: () => Date.now(),
    });
    bridge.start();
    await waitFor(() => bridge.isReady(), { timeoutMs: options.timeoutMs, label: "bridge Mosquitto live connesso" });

    const orderEvent = buildEvent({
      eventId: 1701,
      type: "order.created",
      aggregateType: "order",
      aggregateId: `order_${nonce}`,
      detail: { orderId: `order_${nonce}` },
    });
    const orderPublish = bridge.publishEvent(orderEvent.envelope, orderEvent.outboxEvent);
    await waitFor(() => countTopic(messages, orderTopic) >= 1, {
      timeoutMs: options.timeoutMs,
      label: "device riceve evento backend",
    });

    const devicePresenceWriter = await connectMqttClient(options.brokerUrl, {
      clientId: `s14g-device-presence-${process.pid}-${Date.now()}`,
      username: options.deviceUsername,
      password: options.devicePassword,
      timeoutMs: options.timeoutMs,
      tls: options,
    });
    clients.push(devicePresenceWriter);
    const presencePublish = await publish(
      devicePresenceWriter,
      presenceTopic,
      JSON.stringify({ ok: true, nonce, at: new Date().toISOString() }),
      { qos: 1, retain: false },
      options.timeoutMs,
    );

    const deviceDeniedWriter = await connectMqttClient(options.brokerUrl, {
      clientId: `s14g-device-denied-${process.pid}-${Date.now()}`,
      username: options.deviceUsername,
      password: options.devicePassword,
      timeoutMs: options.timeoutMs,
      tls: options,
    });
    clients.push(deviceDeniedWriter);
    const deviceDeniedPublish = await publish(
      deviceDeniedWriter,
      deniedDeviceTopic,
      JSON.stringify({ shouldNotArrive: true, nonce }),
      { qos: 1, retain: false },
      options.timeoutMs,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    let printerConnected = false;
    let printerDeniedPublish = { callbackOk: false, callbackError: "skipped" };
    let printPublish = { ok: true, skipped: true };
    if (!options.skipPrinter) {
      const printerClient = await connectMqttClient(options.brokerUrl, {
        clientId: `s14g-printer-sub-${process.pid}-${Date.now()}`,
        username: options.printerUsername,
        password: options.printerPassword,
        timeoutMs: options.timeoutMs,
        tls: options,
      });
      clients.push(printerClient);
      printerConnected = true;
      printerClient.on("message", (topic, payload, packet = {}) => {
        printerMessages.push({
          topic,
          payload: payload.toString("utf8"),
          qos: packet.qos,
          retain: packet.retain === true,
        });
      });
      await subscribe(printerClient, `pos/${storeId}/events/prints/#`, { qos: 1 });
      const printEvent = buildEvent({
        eventId: 1702,
        type: "print.job",
        aggregateType: "print",
        aggregateId: `print_${nonce}`,
        detail: { jobId: `print_${nonce}` },
      });
      printPublish = bridge.publishEvent(printEvent.envelope, printEvent.outboxEvent);
      await waitFor(() => countTopic(printerMessages, printTopic) >= 1, {
        timeoutMs: options.timeoutMs,
        label: "printer riceve evento print",
      });

      const printerDeniedWriter = await connectMqttClient(options.brokerUrl, {
        clientId: `s14g-printer-denied-${process.pid}-${Date.now()}`,
        username: options.printerUsername,
        password: options.printerPassword,
        timeoutMs: options.timeoutMs,
        tls: options,
      });
      clients.push(printerDeniedWriter);
      printerDeniedPublish = await publish(
        printerDeniedWriter,
        deniedPrinterTopic,
        JSON.stringify({ shouldNotArrive: true, nonce }),
        { qos: 1, retain: false },
        options.timeoutMs,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const checks = [
      credentialCheck,
      anonymousCheck,
      {
        name: "backend bridge writes events",
        ok: orderPublish.ok === true && countTopic(messages, orderTopic) >= 1,
        detail: orderTopic,
      },
      {
        name: "device reads events",
        ok: countTopic(messages, orderTopic) >= 1,
        detail: wildcardTopic,
      },
      {
        name: "device writes own presence",
        ok: presencePublish.callbackOk === true,
        detail: presenceTopic,
      },
      {
        name: "device cannot write events",
        ok: countTopic(messages, deniedDeviceTopic) === 0,
        detail: `${deniedDeviceTopic}; callback=${deviceDeniedPublish.callbackOk ? "ok" : deviceDeniedPublish.callbackError}`,
      },
      {
        name: "commands disabled",
        ok: config.commandsEnabled === false,
        detail: "MQTT_COMMANDS_ENABLED=0",
      },
    ];

    if (options.skipPrinter) {
      checks.push({ name: "printer gateway", ok: true, detail: "skipped by flag" });
    } else {
      checks.push(
        {
          name: "printer gateway connected",
          ok: printerConnected,
          detail: options.printerUsername,
        },
        {
          name: "printer gateway reads print events",
          ok: countTopic(printerMessages, printTopic) >= 1 && printPublish.ok === true,
          detail: printTopic,
        },
        {
          name: "printer gateway cannot write events",
          ok: countTopic(printerMessages, deniedPrinterTopic) === 0 && countTopic(messages, deniedPrinterTopic) === 0,
          detail: `${deniedPrinterTopic}; callback=${printerDeniedPublish.callbackOk ? "ok" : printerDeniedPublish.callbackError}`,
        },
      );
    }

    return {
      ok: checks.every((check) => check.ok),
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      broker: { url: options.brokerUrl },
      options: safeOptions(options),
      topics: {
        wildcardTopic,
        orderTopic,
        deniedDeviceTopic,
        presenceTopic,
        printTopic,
        deniedPrinterTopic,
      },
      checks,
      publishResults: {
        orderPublish,
        presencePublish,
        deviceDeniedPublish,
        printPublish,
        printerDeniedPublish,
      },
      received: {
        events: messages.length,
        order: countTopic(messages, orderTopic),
        deniedDevice: countTopic(messages, deniedDeviceTopic),
        printer: printerMessages.length,
        print: countTopic(printerMessages, printTopic),
        deniedPrinter: countTopic(printerMessages, deniedPrinterTopic),
      },
      metrics: metrics.snapshot(),
      warnings,
    };
  } finally {
    bridge?.stop?.();
    await Promise.all(clients.map((client) => endClient(client)));
  }
}

function safeOptions(options = {}) {
  return {
    storeId: options.storeId,
    timeoutMs: options.timeoutMs,
    skipAnonymous: options.skipAnonymous === true,
    skipPrinter: options.skipPrinter === true,
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
      printer: credentialPresence(options.printerUsername, options.printerPassword),
    },
  };
}

export function formatMqttMosquittoLiveCanaryMarkdown(summary) {
  const lines = ["# MQTT Mosquitto live canary", ""];
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Broker: ${summary.broker.url}`);
  lines.push(`Store: ${summary.options.storeId}`);
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
  if (summary.topics) {
    lines.push("");
    lines.push("## Topics");
    lines.push("");
    for (const [name, topic] of Object.entries(summary.topics)) {
      lines.push(`- ${name}: ${topic}`);
    }
  }
  lines.push("");
  lines.push("## Credentials");
  lines.push("");
  for (const [name, credential] of Object.entries(summary.options.credentials ?? {})) {
    lines.push(`- ${name}: user=${credential.username || "-"}, password=${credential.hasPassword ? "present" : "missing"}`);
  }
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push("- Le password non sono scritte nel report.");
  lines.push("- Il bridge usa credenziali backend e MQTT commands resta spento.");
  lines.push("- Device e printer non devono pubblicare su `events/#`.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeMqttMosquittoLiveCanaryReport(summary, outDir) {
  const targetDir = path.resolve(String(outDir || "reports").trim() || "reports");
  mkdirSync(targetDir, { recursive: true });
  const jsonPath = path.join(targetDir, "mqtt-mosquitto-live-canary.json");
  const mdPath = path.join(targetDir, "mqtt-mosquitto-live-canary.md");
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, formatMqttMosquittoLiveCanaryMarkdown(summary), "utf8");
  return { jsonPath, mdPath };
}

async function main() {
  const options = parseMqttMosquittoLiveCanaryArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const summary = await runMqttMosquittoLiveCanary(options);
  const output = writeMqttMosquittoLiveCanaryReport(summary, options.outDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, output }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMqttMosquittoLiveCanaryMarkdown(summary));
    process.stdout.write(`[mqtt-mosquitto-live-canary] JSON: ${output.jsonPath}\n`);
    process.stdout.write(`[mqtt-mosquitto-live-canary] Markdown: ${output.mdPath}\n`);
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
