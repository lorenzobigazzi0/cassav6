import mqtt from "mqtt";
import { readFileSync } from "node:fs";

const DEFAULT_MQTT_URL = "mqtt://127.0.0.1:1883";
const DEFAULT_STORE_ID = "default";
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_RECONNECT_PERIOD_MS = 2000;
const COMMAND_INBOX_COMMAND_MODES = new Set(["write", "enforce", "enforce_pilot"]);

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

function normalizePositiveInt(value, fallback, { min = 0, max = 60_000 } = {}) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeCommandInboxMode(value, fallback = "off") {
  const normalized = normalizeText(value, fallback).toLowerCase();
  if (["off", "shadow", "write", "enforce", "enforce_pilot"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function topicSegment(value, fallback = "unknown") {
  const normalized = normalizeText(value, fallback)
    .replace(/[\u0000-\u001f\u007f+#/]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 96);
  return normalized || fallback;
}

export function normalizeMqttCommandGateConfig(env = process.env) {
  const requested = isTruthyFlag(env.MQTT_COMMANDS_ENABLED);
  const commandInboxEnabled = isTruthyFlag(env.COMMAND_INBOX_ENABLED);
  const commandInboxMode = normalizeCommandInboxMode(
    env.COMMAND_INBOX_MODE,
    commandInboxEnabled ? "shadow" : "off",
  );
  const commandInboxEnforcing = commandInboxEnabled && COMMAND_INBOX_COMMAND_MODES.has(commandInboxMode);
  const ackEnabled = isTruthyFlag(env.MQTT_COMMAND_ACK_ENABLED);
  const reasons = [];
  if (!requested) reasons.push("mqtt_commands_disabled");
  if (requested && !commandInboxEnabled) reasons.push("command_inbox_disabled");
  if (requested && commandInboxEnabled && !commandInboxEnforcing) {
    reasons.push(`command_inbox_not_enforcing:${commandInboxMode}`);
  }
  if (requested && commandInboxEnforcing && !ackEnabled) reasons.push("mqtt_command_ack_disabled");
  return {
    requested,
    enabled: requested && commandInboxEnforcing && ackEnabled,
    ackEnabled,
    commandInboxEnabled,
    commandInboxMode,
    commandInboxEnforcing,
    reasons,
  };
}

export function normalizeMqttBridgeConfig(env = process.env) {
  const enabled = isTruthyFlag(env.MQTT_ENABLED) && isTruthyFlag(env.MQTT_EVENTS_ENABLED);
  const url = normalizeText(env.MQTT_URL, DEFAULT_MQTT_URL);
  const tlsEnabled = isTruthyFlag(env.MQTT_TLS_ENABLED) || url.startsWith("mqtts://");
  const commandGate = normalizeMqttCommandGateConfig(env);
  return {
    enabled,
    eventsEnabled: isTruthyFlag(env.MQTT_EVENTS_ENABLED),
    commandsRequested: commandGate.requested,
    commandsEnabled: commandGate.enabled,
    commandGate,
    retainedStateEnabled: isTruthyFlag(env.MQTT_RETAINED_STATE_ENABLED),
    url,
    storeId: topicSegment(
      env.MQTT_STORE_ID || env.STORE_ID || env.CASSA_STORE_ID || env.CASSAV4_STORE_ID,
      DEFAULT_STORE_ID,
    ),
    clientId: topicSegment(
      env.MQTT_CLIENT_ID || `cassav4-backend-${process.pid}`,
      `cassav4-backend-${process.pid}`,
    ),
    username: normalizeText(env.MQTT_USERNAME, ""),
    password: normalizeText(env.MQTT_PASSWORD, ""),
    tlsEnabled,
    tlsRejectUnauthorized: env.MQTT_TLS_REJECT_UNAUTHORIZED === undefined
      ? true
      : !isFalseyFlag(env.MQTT_TLS_REJECT_UNAUTHORIZED),
    tlsCaPath: normalizeText(env.MQTT_TLS_CA_PATH, ""),
    tlsCertPath: normalizeText(env.MQTT_TLS_CERT_PATH, ""),
    tlsKeyPath: normalizeText(env.MQTT_TLS_KEY_PATH, ""),
    tlsServername: normalizeText(env.MQTT_TLS_SERVERNAME, ""),
    connectTimeoutMs: normalizePositiveInt(
      env.MQTT_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
      { min: 1000, max: 60_000 },
    ),
    reconnectPeriodMs: normalizePositiveInt(
      env.MQTT_RECONNECT_PERIOD_MS,
      DEFAULT_RECONNECT_PERIOD_MS,
      { min: 250, max: 60_000 },
    ),
  };
}

export function createMqttClientOptions(config = {}, { loadFile = readFileSync } = {}) {
  const options = {
    clientId: config.clientId,
    clean: true,
    connectTimeout: config.connectTimeoutMs,
    reconnectPeriod: config.reconnectPeriodMs,
  };
  if (config.username) options.username = config.username;
  if (config.password) options.password = config.password;
  const hasTlsMaterial = Boolean(config.tlsCaPath || config.tlsCertPath || config.tlsKeyPath || config.tlsServername);
  if (config.tlsEnabled === true || hasTlsMaterial) {
    options.rejectUnauthorized = config.tlsRejectUnauthorized !== false;
    if (config.tlsServername) options.servername = config.tlsServername;
    if (config.tlsCaPath) options.ca = loadFile(config.tlsCaPath);
    if (config.tlsCertPath) options.cert = loadFile(config.tlsCertPath);
    if (config.tlsKeyPath) options.key = loadFile(config.tlsKeyPath);
  }
  return options;
}

function eventAggregateType(event = {}, envelope = {}) {
  return normalizeText(
    event.aggregateType || envelope.aggregateType || envelope.type?.split(".")?.[0],
    "system",
  ).toLowerCase();
}

function eventAggregateId(event = {}, envelope = {}, fallback = "event") {
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const detail = payload.detail && typeof payload.detail === "object" ? payload.detail : {};
  return normalizeText(
    event.aggregateId ||
      envelope.aggregateId ||
      detail.paymentId ||
      detail.paymentContainerId ||
      detail.receiptId ||
      detail.documentId ||
      detail.jobId ||
      detail.printerId ||
      detail.orderId ||
      detail.tableId ||
      detail.roomId ||
      envelope.eventId,
    fallback,
  );
}

function eventRoomId(event = {}, envelope = {}) {
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const detail = payload.detail && typeof payload.detail === "object" ? payload.detail : {};
  return normalizeText(event.scope || envelope.scope || detail.roomId || detail.room || "", "");
}

function topicBucketForEvent(event = {}, envelope = {}) {
  const aggregateType = eventAggregateType(event, envelope);
  const eventType = normalizeText(event.eventType || envelope.type, "").toLowerCase();
  if (aggregateType === "order" || eventType.startsWith("order.")) return "orders";
  if (aggregateType === "table" || eventType.startsWith("table.")) return "tables";
  if (aggregateType === "room" || eventType.startsWith("room.")) return "rooms";
  if (aggregateType === "payment" || eventType.startsWith("payment.")) return "payments";
  if (aggregateType === "print" || eventType.startsWith("print.")) return "prints";
  if (aggregateType === "fiscal" || aggregateType === "fiscal_receipt" || eventType.startsWith("fiscal.")) return "fiscal";
  if (aggregateType === "notification" || eventType.startsWith("notification.")) return "notifications";
  if (aggregateType === "station" || eventType.startsWith("station.")) return "stations";
  if (aggregateType === "settings" || eventType.startsWith("settings.")) return "settings";
  return "system";
}

export function resolveMqttEventRoute(event = {}, envelope = {}, config = {}) {
  const storeId = topicSegment(config.storeId, DEFAULT_STORE_ID);
  const bucket = topicBucketForEvent(event, envelope);
  const id =
    bucket === "rooms"
      ? eventRoomId(event, envelope) || eventAggregateId(event, envelope, bucket)
      : eventAggregateId(event, envelope, bucket);
  const topic = `pos/${storeId}/events/${bucket}/${topicSegment(id, bucket)}`;
  const retainedBuckets = new Set(["tables", "prints", "settings"]);
  const retain = config.retainedStateEnabled === true && retainedBuckets.has(bucket);
  return {
    topic,
    qos: bucket === "system" ? 0 : 1,
    retain,
    bucket,
  };
}

export function createMqttRealtimeBridge({
  config = normalizeMqttBridgeConfig(),
  connect = mqtt.connect,
  logger = console,
  metrics = null,
  nowMs = () => Date.now(),
} = {}) {
  let client = null;
  let started = false;
  let connected = false;
  let lastErrorMessage = "";

  function incrementCounter(name, amount = 1) {
    metrics?.incrementCounter?.(name, amount);
  }

  function setGauge(name, value) {
    metrics?.setGauge?.(name, value);
  }

  function updateConnected(value) {
    connected = value === true;
    setGauge("mqttConnected", connected ? 1 : 0);
  }

  function start() {
    if (!config.enabled || started) return client;
    started = true;
    try {
      const options = createMqttClientOptions(config);
      client = connect(config.url, options);
      client?.on?.("connect", () => {
        incrementCounter("mqttConnects");
        updateConnected(true);
      });
      client?.on?.("reconnect", () => updateConnected(false));
      client?.on?.("offline", () => updateConnected(false));
      client?.on?.("close", () => updateConnected(false));
      client?.on?.("end", () => updateConnected(false));
      client?.on?.("error", (error) => {
        incrementCounter("mqttErrors");
        updateConnected(false);
        const message = String(error?.message ?? error ?? "mqtt error");
        if (message !== lastErrorMessage) {
          lastErrorMessage = message;
          logger?.warn?.(`[mqtt-bridge] ${message}`);
        }
      });
    } catch (error) {
      incrementCounter("mqttErrors");
      updateConnected(false);
      logger?.warn?.(
        `[mqtt-bridge] avvio fallito: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return client;
  }

  function stop() {
    try {
      client?.end?.(true);
    } catch {
      // best-effort shutdown
    }
    client = null;
    started = false;
    updateConnected(false);
  }

  function isReady() {
    return config.enabled === true && client !== null && (connected || client.connected === true);
  }

  function publishEvent(envelope = {}, event = {}) {
    if (!config.enabled) return { ok: true, skipped: true, reason: "disabled" };
    if (!started) start();
    if (!isReady()) {
      incrementCounter("mqttPublishSkipped");
      return { ok: false, skipped: true, reason: "not_connected" };
    }
    const route = resolveMqttEventRoute(event, envelope, config);
    const payload = JSON.stringify({
      ...envelope,
      transport: "mqtt",
      mqttTopic: route.topic,
    });
    try {
      client.publish(route.topic, payload, { qos: route.qos, retain: route.retain }, (error) => {
        if (error) {
          incrementCounter("mqttPublishFailed");
          logger?.warn?.(`[mqtt-bridge] publish failed: ${error.message ?? error}`);
          return;
        }
        incrementCounter("mqttPublishConfirmed");
      });
      incrementCounter("mqttPublishQueued");
      setGauge("mqttLastPublishAtMs", nowMs());
      return { ok: true, published: true, ...route };
    } catch (error) {
      incrementCounter("mqttPublishFailed");
      logger?.warn?.(
        `[mqtt-bridge] publish throw: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, reason: "publish_failed", error };
    }
  }

  return {
    start,
    stop,
    isReady,
    publishEvent,
    get enabled() {
      return config.enabled === true;
    },
    get connected() {
      return isReady();
    },
  };
}
