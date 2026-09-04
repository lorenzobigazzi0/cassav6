import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createMqttClientOptions,
  createMqttRealtimeBridge,
  normalizeMqttBridgeConfig,
  normalizeMqttCommandGateConfig,
  resolveMqttEventRoute,
} from "../modules/realtime-backbone/mqtt-bridge.js";

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.published = [];
    this.ended = false;
  }

  publish(topic, payload, options, callback) {
    this.published.push({ topic, payload, options });
    callback?.();
  }

  end() {
    this.ended = true;
    this.connected = false;
    this.emit("close");
  }
}

function createMetricsProbe() {
  const counters = new Map();
  const gauges = new Map();
  return {
    counters,
    gauges,
    incrementCounter(name, amount = 1) {
      counters.set(name, (counters.get(name) ?? 0) + amount);
    },
    setGauge(name, value) {
      gauges.set(name, value);
    },
  };
}

test("[BE][STEP14] MQTT bridge config resta spento di default e abilita solo eventi", () => {
  assert.equal(normalizeMqttBridgeConfig({}).enabled, false);
  const config = normalizeMqttBridgeConfig({
    MQTT_ENABLED: "1",
    MQTT_EVENTS_ENABLED: "1",
    MQTT_COMMANDS_ENABLED: "0",
    MQTT_RETAINED_STATE_ENABLED: "1",
    MQTT_URL: "mqtt://broker.local:1883",
    MQTT_STORE_ID: "store/main",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.commandsRequested, false);
  assert.equal(config.commandsEnabled, false);
  assert.equal(config.retainedStateEnabled, true);
  assert.equal(config.url, "mqtt://broker.local:1883");
  assert.equal(config.storeId, "store_main");
});

test("[BE][STEP15] MQTT commands restano bloccati senza command inbox enforce e ack", () => {
  const noInbox = normalizeMqttBridgeConfig({
    MQTT_ENABLED: "1",
    MQTT_EVENTS_ENABLED: "1",
    MQTT_COMMANDS_ENABLED: "1",
  });
  assert.equal(noInbox.commandsRequested, true);
  assert.equal(noInbox.commandsEnabled, false);
  assert.deepEqual(noInbox.commandGate.reasons, ["command_inbox_disabled"]);

  const shadowInbox = normalizeMqttCommandGateConfig({
    MQTT_COMMANDS_ENABLED: "1",
    COMMAND_INBOX_ENABLED: "1",
    COMMAND_INBOX_MODE: "shadow",
  });
  assert.equal(shadowInbox.enabled, false);
  assert.deepEqual(shadowInbox.reasons, ["command_inbox_not_enforcing:shadow"]);

  const noAck = normalizeMqttCommandGateConfig({
    MQTT_COMMANDS_ENABLED: "1",
    COMMAND_INBOX_ENABLED: "1",
    COMMAND_INBOX_MODE: "enforce_pilot",
  });
  assert.equal(noAck.enabled, false);
  assert.deepEqual(noAck.reasons, ["mqtt_command_ack_disabled"]);
});

test("[BE][STEP15] MQTT commands si abilitano solo con gate command-inbox + ack esplicito", () => {
  const gate = normalizeMqttCommandGateConfig({
    MQTT_COMMANDS_ENABLED: "1",
    COMMAND_INBOX_ENABLED: "1",
    COMMAND_INBOX_MODE: "enforce_pilot",
    MQTT_COMMAND_ACK_ENABLED: "1",
  });
  assert.equal(gate.requested, true);
  assert.equal(gate.commandInboxEnforcing, true);
  assert.equal(gate.ackEnabled, true);
  assert.equal(gate.enabled, true);
  assert.deepEqual(gate.reasons, []);
});

test("[BE][STEP14] MQTT topic contract mappa outbox verso topic LAN", () => {
  const config = normalizeMqttBridgeConfig({
    MQTT_ENABLED: "1",
    MQTT_EVENTS_ENABLED: "1",
    MQTT_RETAINED_STATE_ENABLED: "1",
    MQTT_STORE_ID: "restaurant-1",
  });
  assert.deepEqual(
    resolveMqttEventRoute(
      { eventType: "order.created", aggregateType: "order", aggregateId: "order/1" },
      { eventId: 1, type: "order.created", aggregateType: "order", aggregateId: "order/1" },
      config,
    ),
    {
      topic: "pos/restaurant-1/events/orders/order_1",
      qos: 1,
      retain: false,
      bucket: "orders",
    },
  );
  assert.equal(
    resolveMqttEventRoute(
      { eventType: "table.state", aggregateType: "table", aggregateId: "table#1" },
      { eventId: 2, type: "table.state", aggregateType: "table", aggregateId: "table#1" },
      config,
    ).retain,
    true,
  );
  assert.equal(
    resolveMqttEventRoute(
      { eventType: "payment.status", aggregateType: "payment", aggregateId: "pay_1" },
      { eventId: 3, type: "payment.status", aggregateType: "payment", aggregateId: "pay_1" },
      config,
    ).retain,
    false,
  );
  assert.equal(
    resolveMqttEventRoute(
      { eventType: "fiscal.status", aggregateType: "fiscal_receipt", aggregateId: "fiscal_1" },
      { eventId: 4, type: "fiscal.status", aggregateType: "fiscal_receipt", aggregateId: "fiscal_1" },
      config,
    ).retain,
    false,
  );
});

test("[BE][STEP14] MQTT bridge pubblica best-effort senza sorgente di verita alternativa", () => {
  const client = new FakeMqttClient();
  const metrics = createMetricsProbe();
  const bridge = createMqttRealtimeBridge({
    config: normalizeMqttBridgeConfig({
      MQTT_ENABLED: "1",
      MQTT_EVENTS_ENABLED: "1",
      MQTT_RETAINED_STATE_ENABLED: "1",
      MQTT_STORE_ID: "store-a",
    }),
    connect: () => client,
    metrics,
    logger: { warn() {} },
    nowMs: () => 1234,
  });

  bridge.start();
  client.connected = true;
  client.emit("connect");

  const result = bridge.publishEvent(
    {
      eventId: 10,
      type: "print.status",
      aggregateType: "print",
      aggregateId: "job_1",
      payload: { status: "printed" },
      createdAt: "2026-07-07T10:00:00.000Z",
    },
    { eventType: "print.status", aggregateType: "print", aggregateId: "job_1" },
  );

  assert.equal(result.ok, true);
  assert.equal(client.published.length, 1);
  assert.equal(client.published[0].topic, "pos/store-a/events/prints/job_1");
  assert.deepEqual(client.published[0].options, { qos: 1, retain: true });
  assert.equal(JSON.parse(client.published[0].payload).eventId, 10);
  assert.equal(metrics.counters.get("mqttPublishQueued"), 1);
  assert.equal(metrics.counters.get("mqttPublishConfirmed"), 1);
  assert.equal(metrics.gauges.get("mqttConnected"), 1);
  assert.equal(metrics.gauges.get("mqttLastPublishAtMs"), 1234);
});

test("[BE][STEP14] MQTT bridge non lancia errori quando il broker non e connesso", () => {
  const client = new FakeMqttClient();
  const metrics = createMetricsProbe();
  const bridge = createMqttRealtimeBridge({
    config: normalizeMqttBridgeConfig({
      MQTT_ENABLED: "1",
      MQTT_EVENTS_ENABLED: "1",
      MQTT_STORE_ID: "store-a",
    }),
    connect: () => client,
    metrics,
    logger: { warn() {} },
  });

  bridge.start();
  const result = bridge.publishEvent(
    { eventId: 20, type: "order.created", aggregateType: "order", aggregateId: "order_20" },
    { eventType: "order.created", aggregateType: "order", aggregateId: "order_20" },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_connected");
  assert.equal(client.published.length, 0);
  assert.equal(metrics.counters.get("mqttPublishSkipped"), 1);
});

test("[BE][STEP14I] MQTT bridge normalizza TLS per broker mqtts", () => {
  const config = normalizeMqttBridgeConfig({
    MQTT_ENABLED: "1",
    MQTT_EVENTS_ENABLED: "1",
    MQTT_URL: "mqtts://broker.local:8883",
    MQTT_CLIENT_ID: "backend-tls",
    MQTT_USERNAME: "backend",
    MQTT_PASSWORD: "secret",
    MQTT_TLS_CA_PATH: "certs/ca.pem",
    MQTT_TLS_CERT_PATH: "certs/client.pem",
    MQTT_TLS_KEY_PATH: "certs/client-key.pem",
    MQTT_TLS_SERVERNAME: "broker.local",
  });
  assert.equal(config.tlsEnabled, true);
  assert.equal(config.tlsRejectUnauthorized, true);
  assert.equal(config.tlsCaPath, "certs/ca.pem");
  assert.equal(config.tlsServername, "broker.local");

  const loadedPaths = [];
  const options = createMqttClientOptions(config, {
    loadFile(filePath) {
      loadedPaths.push(filePath);
      return Buffer.from(`file:${filePath}`);
    },
  });
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.servername, "broker.local");
  assert.deepEqual(loadedPaths, ["certs/ca.pem", "certs/client.pem", "certs/client-key.pem"]);
  assert.equal(options.ca.toString("utf8"), "file:certs/ca.pem");
  assert.equal(options.cert.toString("utf8"), "file:certs/client.pem");
  assert.equal(options.key.toString("utf8"), "file:certs/client-key.pem");
});

test("[BE][STEP14I] MQTT bridge permette override TLS solo esplicito", () => {
  const secureConfig = normalizeMqttBridgeConfig({
    MQTT_ENABLED: "1",
    MQTT_EVENTS_ENABLED: "1",
    MQTT_URL: "mqtts://broker.local:8883",
  });
  const insecureConfig = normalizeMqttBridgeConfig({
    MQTT_ENABLED: "1",
    MQTT_EVENTS_ENABLED: "1",
    MQTT_URL: "mqtts://broker.local:8883",
    MQTT_TLS_REJECT_UNAUTHORIZED: "0",
  });
  assert.equal(createMqttClientOptions(secureConfig).rejectUnauthorized, true);
  assert.equal(createMqttClientOptions(insecureConfig).rejectUnauthorized, false);
});
