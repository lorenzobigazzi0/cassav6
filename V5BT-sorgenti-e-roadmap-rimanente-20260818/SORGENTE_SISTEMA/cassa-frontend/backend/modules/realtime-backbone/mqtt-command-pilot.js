const DEFAULT_STORE_ID = "default";
const DEFAULT_COMMAND_TTL_MS = 10 * 60 * 1000;
const SUPPORTED_COMMAND_TYPES = new Set(["notifications.ack"]);

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function topicSegment(value, fallback = "unknown") {
  const normalized = normalizeText(value, fallback)
    .replace(/[\u0000-\u001f\u007f+#/]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 96);
  return normalized || fallback;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredText(value, fieldName) {
  const normalized = normalizeText(value);
  if (!normalized) {
    const error = new Error(`${fieldName} richiesto.`);
    error.code = "MQTT_COMMAND_INVALID_ENVELOPE";
    throw error;
  }
  return normalized;
}

function parsePayload(rawPayload) {
  const raw = Buffer.isBuffer(rawPayload) ? rawPayload.toString("utf8") : String(rawPayload ?? "");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const error = new Error("Envelope comando MQTT non valido.");
      error.code = "MQTT_COMMAND_INVALID_ENVELOPE";
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error?.code === "MQTT_COMMAND_INVALID_ENVELOPE") throw error;
    const parseError = new Error("Payload comando MQTT non e' JSON valido.");
    parseError.code = "MQTT_COMMAND_INVALID_JSON";
    throw parseError;
  }
}

function resolveNotificationAckPayload(payload = {}) {
  const body = asObject(payload);
  const id = normalizeText(body.id ?? body.notificationId ?? body.notification_id);
  if (!id) {
    const error = new Error("ID notifica richiesto per notifications.ack.");
    error.code = "MQTT_COMMAND_INVALID_PAYLOAD";
    throw error;
  }
  return {
    id,
    action: body.action === "delete" ? "delete" : "ack",
    consumer: normalizeText(body.consumer, "mobile-frontend"),
  };
}

function selectIdempotencyPayload(envelope) {
  if (envelope.commandType === "notifications.ack") {
    return resolveNotificationAckPayload(envelope.payload);
  }
  return asObject(envelope.payload);
}

function resolveAggregate(envelope) {
  if (envelope.commandType === "notifications.ack") {
    const ackPayload = resolveNotificationAckPayload(envelope.payload);
    return {
      aggregateType: "notification",
      aggregateId: ackPayload.id,
    };
  }
  return {
    aggregateType: normalizeText(envelope.aggregateType),
    aggregateId: normalizeText(envelope.aggregateId),
  };
}

function normalizeOptionalInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildExpiresAt(nowIso, ttlMs) {
  const nowMs = Date.parse(nowIso());
  const baseMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  return new Date(baseMs + ttlMs).toISOString();
}

function statusFromRecord(record, fallback = "processing") {
  const normalized = normalizeText(record?.status).toLowerCase();
  return normalized || fallback;
}

function errorCodeFromError(error, fallback) {
  return normalizeText(error?.code, fallback);
}

export function normalizeMqttCommandPilotConfig(input = {}) {
  const env = input.env && typeof input.env === "object" ? input.env : input;
  const storeId = topicSegment(
    input.storeId ??
      env.MQTT_STORE_ID ??
      env.STORE_ID ??
      env.CASSA_STORE_ID ??
      env.CASSAV4_STORE_ID,
    DEFAULT_STORE_ID,
  );
  const commandGate = input.commandGate && typeof input.commandGate === "object" ? input.commandGate : {};
  const commandsEnabled = input.commandsEnabled === true || commandGate.enabled === true;
  return {
    storeId,
    commandsEnabled,
    commandGate,
    commandTopic: normalizeText(input.commandTopic, `pos/${storeId}/commands/#`),
    ackTopicPrefix: normalizeText(input.ackTopicPrefix, `pos/${storeId}/events/commands`),
    commandTtlMs: Math.max(1000, Math.trunc(Number(input.commandTtlMs) || DEFAULT_COMMAND_TTL_MS)),
  };
}

export function resolveMqttCommandAckTopic(envelope = {}, config = {}) {
  const normalizedConfig = normalizeMqttCommandPilotConfig(config);
  return [
    normalizedConfig.ackTopicPrefix.replace(/\/+$/g, ""),
    topicSegment(envelope.deviceId, "device"),
    topicSegment(envelope.requestId, "request"),
  ].join("/");
}

export function normalizeMqttCommandEnvelope(input = {}) {
  const payload = input.payload === undefined ? {} : input.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    const error = new Error("payload comando MQTT deve essere un oggetto.");
    error.code = "MQTT_COMMAND_INVALID_PAYLOAD";
    throw error;
  }
  const envelope = {
    requestId: requiredText(input.requestId ?? input.request_id, "requestId"),
    idempotencyKey: requiredText(input.idempotencyKey ?? input.idempotency_key, "idempotencyKey"),
    deviceId: requiredText(input.deviceId ?? input.device_id, "deviceId"),
    userId: normalizeText(input.userId ?? input.user_id) || null,
    stationId: normalizeText(input.stationId ?? input.station_id) || null,
    commandType: requiredText(input.commandType ?? input.command_type, "commandType"),
    aggregateType: normalizeText(input.aggregateType ?? input.aggregate_type) || null,
    aggregateId: normalizeText(input.aggregateId ?? input.aggregate_id) || null,
    expectedVersion: normalizeOptionalInteger(input.expectedVersion ?? input.expected_version),
    payload,
    createdAt: normalizeText(input.createdAt ?? input.created_at) || null,
    expiresAt: normalizeText(input.expiresAt ?? input.expires_at) || null,
  };
  const aggregate = resolveAggregate(envelope);
  envelope.aggregateType = aggregate.aggregateType || envelope.aggregateType;
  envelope.aggregateId = aggregate.aggregateId || envelope.aggregateId;
  return envelope;
}

function buildRejectableEnvelope(input = {}) {
  const raw = asObject(input);
  const requestId = normalizeText(raw.requestId ?? raw.request_id);
  const idempotencyKey = normalizeText(raw.idempotencyKey ?? raw.idempotency_key);
  const deviceId = normalizeText(raw.deviceId ?? raw.device_id);
  const commandType = normalizeText(raw.commandType ?? raw.command_type);
  if (!requestId || !idempotencyKey || !deviceId || !commandType) return null;
  return {
    requestId,
    idempotencyKey,
    deviceId,
    userId: normalizeText(raw.userId ?? raw.user_id) || null,
    stationId: normalizeText(raw.stationId ?? raw.station_id) || null,
    commandType,
    aggregateType: normalizeText(raw.aggregateType ?? raw.aggregate_type) || null,
    aggregateId: normalizeText(raw.aggregateId ?? raw.aggregate_id) || null,
    payload: asObject(raw.payload),
  };
}

export function buildMqttCommandAck(envelope = {}, fields = {}) {
  const status = normalizeText(fields.status, "processing").toLowerCase();
  const ok = status === "committed";
  const ack = {
    transport: "mqtt",
    requestId: normalizeText(envelope.requestId),
    idempotencyKey: normalizeText(envelope.idempotencyKey),
    deviceId: normalizeText(envelope.deviceId),
    commandType: normalizeText(envelope.commandType),
    aggregateType: normalizeText(envelope.aggregateType) || null,
    aggregateId: normalizeText(envelope.aggregateId) || null,
    status,
    ok,
    replayed: fields.replayed === true,
    recoverable: fields.recoverable !== false,
    result: fields.result ?? null,
    errorCode: normalizeText(fields.errorCode) || null,
    message: normalizeText(fields.message) || null,
    createdAt: normalizeText(fields.createdAt, new Date().toISOString()),
  };
  if (!ack.errorCode) delete ack.errorCode;
  if (!ack.message) delete ack.message;
  if (ack.result === null) delete ack.result;
  return ack;
}

async function publishAck({ client, envelope, config, ack, logger, metrics }) {
  if (!client || typeof client.publish !== "function") {
    metrics?.incrementCounter?.("mqttCommandAckSkipped");
    return { ok: false, skipped: true, reason: "client_unavailable", ack };
  }
  const topic = resolveMqttCommandAckTopic(envelope, config);
  const payload = JSON.stringify({ ...ack, mqttTopic: topic });
  return await new Promise((resolve) => {
    try {
      client.publish(topic, payload, { qos: 1, retain: false }, (error) => {
        if (error) {
          metrics?.incrementCounter?.("mqttCommandAckFailed");
          logger?.warn?.(`[mqtt-command-pilot] ack publish failed: ${error.message ?? error}`);
          resolve({ ok: false, reason: "publish_failed", error, topic, ack });
          return;
        }
        metrics?.incrementCounter?.("mqttCommandAckPublished");
        resolve({ ok: true, topic, ack });
      });
    } catch (error) {
      metrics?.incrementCounter?.("mqttCommandAckFailed");
      logger?.warn?.(
        `[mqtt-command-pilot] ack publish throw: ${error instanceof Error ? error.message : String(error)}`,
      );
      resolve({ ok: false, reason: "publish_failed", error, topic, ack });
    }
  });
}

export function createMqttCommandPilot({
  config = normalizeMqttCommandPilotConfig(),
  client = null,
  getRepository,
  handlers = {},
  logger = console,
  metrics = null,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const pilotConfig = normalizeMqttCommandPilotConfig(config);
  let started = false;
  let boundHandler = null;

  if (typeof getRepository !== "function") {
    throw new Error("createMqttCommandPilot richiede getRepository().");
  }

  function incrementCounter(name, amount = 1) {
    metrics?.incrementCounter?.(name, amount);
  }

  function resolveHandler(commandType) {
    if (handlers instanceof Map) return handlers.get(commandType);
    return handlers?.[commandType];
  }

  async function sendAck(envelope, fields) {
    const ack = buildMqttCommandAck(envelope, {
      ...fields,
      createdAt: nowIso(),
    });
    return await publishAck({
      client,
      envelope,
      config: pilotConfig,
      ack,
      logger,
      metrics,
    });
  }

  async function processEnvelope(envelope) {
    incrementCounter("mqttCommandReceived");
    if (!pilotConfig.commandsEnabled) {
      incrementCounter("mqttCommandSkipped");
      return { ok: true, skipped: true, reason: "commands_disabled" };
    }

    const repo = await getRepository();
    if (!repo || typeof repo.begin !== "function") {
      incrementCounter("mqttCommandFailed");
      return await sendAck(envelope, {
        status: "failed",
        errorCode: "COMMAND_INBOX_UNAVAILABLE",
        message: "Command inbox non disponibile.",
        recoverable: true,
      });
    }

    let claim;
    try {
      claim = repo.begin({
        requestId: envelope.requestId,
        idempotencyKey: envelope.idempotencyKey,
        deviceId: envelope.deviceId,
        userId: envelope.userId,
        stationId: envelope.stationId,
        commandType: envelope.commandType,
        aggregateType: envelope.aggregateType,
        aggregateId: envelope.aggregateId,
        expectedVersion: envelope.expectedVersion,
        payload: selectIdempotencyPayload(envelope),
        createdAt: envelope.createdAt || nowIso(),
        expiresAt: envelope.expiresAt || buildExpiresAt(nowIso, pilotConfig.commandTtlMs),
      });
    } catch (error) {
      incrementCounter("mqttCommandRejected");
      return await sendAck(envelope, {
        status: "rejected",
        errorCode: errorCodeFromError(error, "COMMAND_INBOX_BEGIN_FAILED"),
        message: error?.message,
        recoverable: false,
      });
    }

    if (claim.state === "conflict") {
      incrementCounter("mqttCommandRejected");
      return await sendAck(envelope, {
        status: "rejected",
        errorCode: "COMMAND_PAYLOAD_CONFLICT",
        message: "Stessa idempotency key con payload diverso.",
        recoverable: false,
      });
    }

    if (claim.state !== "created") {
      incrementCounter("mqttCommandReplay");
      return await sendAck(envelope, {
        status: statusFromRecord(claim.record, claim.state),
        result: claim.result ?? claim.record?.result ?? null,
        errorCode: claim.errorCode ?? claim.record?.errorCode ?? null,
        replayed: true,
        recoverable: claim.state === "processing",
      });
    }

    if (!SUPPORTED_COMMAND_TYPES.has(envelope.commandType)) {
      const result = {
        ok: false,
        errorCode: "MQTT_COMMAND_UNSUPPORTED",
        commandType: envelope.commandType,
      };
      try {
        repo.reject(envelope.requestId, result.errorCode, result);
      } catch (error) {
        logger?.warn?.(`[mqtt-command-pilot] reject unsupported failed: ${error?.message || error}`);
      }
      incrementCounter("mqttCommandRejected");
      return await sendAck(envelope, {
        status: "rejected",
        result,
        errorCode: result.errorCode,
        message: "Comando MQTT non supportato dal pilot.",
        recoverable: false,
      });
    }

    const handler = resolveHandler(envelope.commandType);
    if (typeof handler !== "function") {
      const result = {
        ok: false,
        errorCode: "MQTT_COMMAND_HANDLER_MISSING",
        commandType: envelope.commandType,
      };
      try {
        repo.fail(envelope.requestId, result.errorCode, result);
      } catch (error) {
        logger?.warn?.(`[mqtt-command-pilot] fail missing handler failed: ${error?.message || error}`);
      }
      incrementCounter("mqttCommandFailed");
      return await sendAck(envelope, {
        status: "failed",
        result,
        errorCode: result.errorCode,
        message: "Handler comando MQTT non configurato.",
        recoverable: true,
      });
    }

    try {
      const result = (await handler(envelope, { commandSource: "mqtt" })) ?? { ok: true };
      const record = repo.commit(envelope.requestId, result);
      incrementCounter("mqttCommandCommitted");
      return await sendAck(envelope, {
        status: "committed",
        result: record?.result ?? result,
        recoverable: false,
      });
    } catch (error) {
      const status = Number(error?.status);
      const rejected = Number.isFinite(status) && status >= 400 && status < 500;
      const errorCode = errorCodeFromError(error, rejected ? "MQTT_COMMAND_REJECTED" : "MQTT_COMMAND_FAILED");
      const result = {
        ok: false,
        errorCode,
        message: error?.message || "Comando MQTT fallito.",
      };
      try {
        if (rejected) repo.reject(envelope.requestId, errorCode, result);
        else repo.fail(envelope.requestId, errorCode, result);
      } catch (memoError) {
        logger?.warn?.(`[mqtt-command-pilot] memo errore handler fallita: ${memoError?.message || memoError}`);
      }
      incrementCounter(rejected ? "mqttCommandRejected" : "mqttCommandFailed");
      return await sendAck(envelope, {
        status: rejected ? "rejected" : "failed",
        result,
        errorCode,
        message: result.message,
        recoverable: !rejected,
      });
    }
  }

  async function handleMessage(topic, payload) {
    let raw;
    let envelope;
    try {
      raw = parsePayload(payload);
      envelope = normalizeMqttCommandEnvelope(raw);
    } catch (error) {
      incrementCounter("mqttCommandRejected");
      logger?.warn?.(`[mqtt-command-pilot] comando scartato da ${topic}: ${error?.message || error}`);
      const fallbackEnvelope = buildRejectableEnvelope(raw);
      if (pilotConfig.commandsEnabled && fallbackEnvelope) {
        return await sendAck(fallbackEnvelope, {
          status: "rejected",
          errorCode: errorCodeFromError(error, "MQTT_COMMAND_INVALID_ENVELOPE"),
          message: error?.message,
          recoverable: false,
        });
      }
      return {
        ok: false,
        status: "rejected",
        errorCode: errorCodeFromError(error, "MQTT_COMMAND_INVALID_ENVELOPE"),
      };
    }
    return await processEnvelope(envelope);
  }

  function start() {
    if (started) return { ok: true, started: false, reason: "already_started" };
    if (!pilotConfig.commandsEnabled) {
      return { ok: true, started: false, reason: "commands_disabled" };
    }
    if (!client || typeof client.subscribe !== "function" || typeof client.on !== "function") {
      return { ok: false, started: false, reason: "client_unavailable" };
    }
    boundHandler = (topic, payload) => {
      if (!String(topic ?? "").startsWith(`pos/${pilotConfig.storeId}/commands/`)) return;
      void handleMessage(topic, payload);
    };
    client.subscribe(pilotConfig.commandTopic, { qos: 1 }, (error) => {
      if (error) {
        incrementCounter("mqttCommandSubscribeFailed");
        logger?.warn?.(`[mqtt-command-pilot] subscribe failed: ${error.message ?? error}`);
        return;
      }
      incrementCounter("mqttCommandSubscribed");
    });
    client.on("message", boundHandler);
    started = true;
    return { ok: true, started: true, topic: pilotConfig.commandTopic };
  }

  function stop() {
    if (boundHandler && client && typeof client.off === "function") {
      client.off("message", boundHandler);
    }
    boundHandler = null;
    started = false;
  }

  return {
    start,
    stop,
    handleMessage,
    processEnvelope,
    get enabled() {
      return pilotConfig.commandsEnabled === true;
    },
    get commandTopic() {
      return pilotConfig.commandTopic;
    },
  };
}
