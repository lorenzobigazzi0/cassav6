import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CommandInboxRepository,
  closeRelationalConnection,
  normalizeRelationalConfig,
  openRelationalConnection,
  runRelationalMigrations,
} from "../db/relational/index.js";
import {
  createMqttCommandPilot,
  normalizeMqttCommandEnvelope,
  normalizeMqttCommandPilotConfig,
  resolveMqttCommandAckTopic,
} from "../modules/realtime-backbone/mqtt-command-pilot.js";

const FIXED_NOW = "2026-07-07T10:00:00.000Z";

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.published = [];
    this.subscribed = [];
  }

  publish(topic, payload, options, callback) {
    this.published.push({ topic, payload, options });
    callback?.();
  }

  subscribe(topic, options, callback) {
    this.subscribed.push({ topic, options });
    callback?.();
  }

  lastAck() {
    const entry = this.published.at(-1);
    return entry ? { ...entry, json: JSON.parse(entry.payload) } : null;
  }
}

async function withRepo(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cassav4-mqtt-command-pilot-"));
  const dbPath = path.join(dir, "relational.sqlite");
  const config = normalizeRelationalConfig({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: dbPath,
    },
    defaultDbPath: dbPath,
  });
  const db = await openRelationalConnection(config);
  try {
    await runRelationalMigrations(db, { nowIso: () => FIXED_NOW });
    const repo = new CommandInboxRepository(db, { nowIso: () => FIXED_NOW });
    return await fn(repo);
  } finally {
    closeRelationalConnection(db);
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseEnvelope(overrides = {}) {
  return {
    requestId: "req-001",
    idempotencyKey: "device-1:ack-1",
    deviceId: "device-1",
    userId: "lorenzo",
    commandType: "notifications.ack",
    payload: { id: "ntf-1", action: "ack", consumer: "mobile-frontend" },
    ...overrides,
  };
}

function buildPilot(repo, options = {}) {
  const client = options.client ?? new FakeMqttClient();
  const calls = { notificationsAck: 0 };
  const metrics = {
    counters: new Map(),
    incrementCounter(name, amount = 1) {
      this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
    },
  };
  const pilot = createMqttCommandPilot({
    config: {
      commandsEnabled: options.commandsEnabled ?? true,
      storeId: "store-a",
      commandTtlMs: 60_000,
    },
    client,
    getRepository: async () => repo,
    nowIso: () => FIXED_NOW,
    metrics,
    logger: { warn() {} },
    handlers: {
      "notifications.ack": async (envelope) => {
        calls.notificationsAck += 1;
        return {
          ok: true,
          acknowledged: true,
          id: envelope.payload.id,
          invocation: calls.notificationsAck,
        };
      },
    },
  });
  return { pilot, client, calls, metrics };
}

test("[BE][STEP17] config comando MQTT resta spento salvo gate esplicito", () => {
  assert.equal(normalizeMqttCommandPilotConfig({}).commandsEnabled, false);
  assert.equal(
    normalizeMqttCommandPilotConfig({
      storeId: "main/store",
      commandGate: { enabled: true },
    }).commandTopic,
    "pos/main_store/commands/#",
  );
});

test("[BE][STEP17] envelope notifications.ack normalizza aggregate e ack topic", () => {
  const envelope = normalizeMqttCommandEnvelope(baseEnvelope());
  assert.equal(envelope.aggregateType, "notification");
  assert.equal(envelope.aggregateId, "ntf-1");
  assert.equal(
    resolveMqttCommandAckTopic(envelope, { storeId: "store-a", commandsEnabled: true }),
    "pos/store-a/events/commands/device-1/req-001",
  );
});

test("[BE][STEP17] gate off: messaggio valido saltato senza toccare inbox ne handler", async () => {
  await withRepo(async (repo) => {
    const { pilot, client, calls } = buildPilot(repo, { commandsEnabled: false });
    const result = await pilot.handleMessage("pos/store-a/commands/device-1", JSON.stringify(baseEnvelope()));

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "commands_disabled");
    assert.equal(calls.notificationsAck, 0);
    assert.equal(client.published.length, 0);
    assert.equal(repo.countSummary().committed, 0);
  });
});

test("[BE][STEP17] notifications.ack created: handler eseguito, inbox committed, ack pubblicato", async () => {
  await withRepo(async (repo) => {
    const { pilot, client, calls } = buildPilot(repo);
    const result = await pilot.handleMessage("pos/store-a/commands/device-1", JSON.stringify(baseEnvelope()));

    assert.equal(result.ok, true);
    assert.equal(calls.notificationsAck, 1);
    assert.equal(repo.countSummary().committed, 1);
    const ack = client.lastAck();
    assert.equal(ack.topic, "pos/store-a/events/commands/device-1/req-001");
    assert.equal(ack.options.qos, 1);
    assert.equal(ack.options.retain, false);
    assert.equal(ack.json.status, "committed");
    assert.equal(ack.json.ok, true);
    assert.equal(ack.json.result.acknowledged, true);
  });
});

test("[BE][STEP17] replay committed: handler non rieseguito e ACK marcato replayed", async () => {
  await withRepo(async (repo) => {
    const { pilot, client, calls } = buildPilot(repo);
    await pilot.handleMessage("pos/store-a/commands/device-1", JSON.stringify(baseEnvelope()));
    await pilot.handleMessage("pos/store-a/commands/device-1", JSON.stringify(baseEnvelope()));

    assert.equal(calls.notificationsAck, 1);
    assert.equal(client.published.length, 2);
    const replayAck = client.lastAck().json;
    assert.equal(replayAck.status, "committed");
    assert.equal(replayAck.replayed, true);
    assert.equal(replayAck.result.invocation, 1);
  });
});

test("[BE][STEP17] processing: non riesegue handler e pubblica ACK recoverable", async () => {
  await withRepo(async (repo) => {
    repo.begin({
      requestId: "req-001",
      idempotencyKey: "device-1:ack-1",
      deviceId: "device-1",
      commandType: "notifications.ack",
      aggregateType: "notification",
      aggregateId: "ntf-1",
      payload: { id: "ntf-1", action: "ack", consumer: "mobile-frontend" },
    });
    const { pilot, client, calls } = buildPilot(repo);
    await pilot.handleMessage("pos/store-a/commands/device-1", JSON.stringify(baseEnvelope()));

    assert.equal(calls.notificationsAck, 0);
    const ack = client.lastAck().json;
    assert.equal(ack.status, "processing");
    assert.equal(ack.replayed, true);
    assert.equal(ack.recoverable, true);
  });
});

test("[BE][STEP17] conflict: stessa idempotency key con payload diverso viene rigettata", async () => {
  await withRepo(async (repo) => {
    const { pilot, client, calls } = buildPilot(repo);
    await pilot.handleMessage("pos/store-a/commands/device-1", JSON.stringify(baseEnvelope()));
    await pilot.handleMessage(
      "pos/store-a/commands/device-1",
      JSON.stringify(baseEnvelope({ requestId: "req-002", payload: { id: "ntf-1", action: "delete" } })),
    );

    assert.equal(calls.notificationsAck, 1);
    const ack = client.lastAck().json;
    assert.equal(ack.status, "rejected");
    assert.equal(ack.errorCode, "COMMAND_PAYLOAD_CONFLICT");
    assert.equal(ack.recoverable, false);
  });
});

test("[BE][STEP17] comando non pilotato: passa da inbox e viene memoizzato rejected", async () => {
  await withRepo(async (repo) => {
    const { pilot, client } = buildPilot(repo);
    await pilot.handleMessage(
      "pos/store-a/commands/device-1",
      JSON.stringify({
        ...baseEnvelope({
          requestId: "req-unsupported",
          idempotencyKey: "device-1:unsupported-1",
          commandType: "orders.create",
          payload: { tableId: "t1" },
        }),
      }),
    );

    const record = repo.getByRequestId("req-unsupported");
    assert.equal(record.status, "rejected");
    assert.equal(record.errorCode, "MQTT_COMMAND_UNSUPPORTED");
    const ack = client.lastAck().json;
    assert.equal(ack.status, "rejected");
    assert.equal(ack.errorCode, "MQTT_COMMAND_UNSUPPORTED");
  });
});

test("[BE][STEP17] payload invalido: nessun handler e nessun ack senza requestId sicuro", async () => {
  await withRepo(async (repo) => {
    const { pilot, client, calls } = buildPilot(repo);
    const result = await pilot.handleMessage("pos/store-a/commands/device-1", "{nope");

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "MQTT_COMMAND_INVALID_JSON");
    assert.equal(calls.notificationsAck, 0);
    assert.equal(client.published.length, 0);
  });
});

test("[BE][STEP17] envelope riconoscibile ma payload invalido: ACK rejected senza toccare inbox", async () => {
  await withRepo(async (repo) => {
    const { pilot, client, calls } = buildPilot(repo);
    const result = await pilot.handleMessage(
      "pos/store-a/commands/device-1",
      JSON.stringify(baseEnvelope({ requestId: "req-bad-payload", payload: "not-an-object" })),
    );

    assert.equal(result.ok, true);
    assert.equal(calls.notificationsAck, 0);
    assert.equal(repo.countSummary().processing, 0);
    assert.equal(repo.countSummary().committed, 0);
    const ack = client.lastAck().json;
    assert.equal(ack.status, "rejected");
    assert.equal(ack.errorCode, "MQTT_COMMAND_INVALID_PAYLOAD");
    assert.equal(ack.recoverable, false);
  });
});

test("[BE][STEP17] start subscribe solo quando il gate comandi e' aperto", async () => {
  await withRepo(async (repo) => {
    const client = new FakeMqttClient();
    const { pilot } = buildPilot(repo, { client });
    const result = pilot.start();

    assert.equal(result.started, true);
    assert.equal(client.subscribed.length, 1);
    assert.equal(client.subscribed[0].topic, "pos/store-a/commands/#");
    client.emit("message", "pos/store-a/commands/device-1", Buffer.from(JSON.stringify(baseEnvelope())));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.published.length, 1);

    pilot.stop();
    client.emit("message", "pos/store-a/commands/device-1", Buffer.from(JSON.stringify(baseEnvelope({
      requestId: "req-after-stop",
      idempotencyKey: "device-1:ack-after-stop",
    }))));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.published.length, 1);
  });
});
