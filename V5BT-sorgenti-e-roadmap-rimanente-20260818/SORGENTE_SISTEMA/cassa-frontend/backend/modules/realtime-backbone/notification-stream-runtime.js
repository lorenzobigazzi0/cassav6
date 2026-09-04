import { Buffer } from "node:buffer";

import {
  buildRealtimeSubscription,
  isRealtimeSubscriptionEligible,
  resolveRealtimeAudience,
} from "./realtime-audience.js";
import {
  filterNotificationEventForSession,
  parseNotificationTimestampMs,
} from "../notifications/notification-session-policy.js";

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_BOOTSTRAP_PADDING_BYTES = 2_048;
const MAX_DELIVERED_EVENT_IDS_PER_STREAM = 1_024;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function frame(eventName, payload = null, options = {}) {
  const lines = [];
  const eventId = Math.trunc(Number(options.eventId ?? options.id) || 0);
  if (eventId > 0) lines.push(`id: ${eventId}`);
  if (eventName) lines.push(`event: ${eventName}`);
  if (payload !== null && payload !== undefined) {
    JSON.stringify(payload).split(/\r?\n/).forEach((line) => lines.push(`data: ${line}`));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function write(client, eventName, payload = null, options = {}) {
  if (!client?.res || client.res.writableEnded || client.res.destroyed) return false;
  const serializedFrame = typeof options.serializedFrame === "string"
    ? options.serializedFrame
    : frame(eventName, payload, options);
  try {
    client.res.write(serializedFrame);
    client.res.flush?.();
    client.res.socket?.setNoDelay?.(true);
    return true;
  } catch {
    return false;
  }
}

function rememberDeliveredEventId(client, value) {
  const eventId = Math.max(0, Math.trunc(Number(value) || 0));
  if (eventId <= 0 || !(client?.deliveredEventIds instanceof Set)) return;
  client.deliveredEventIds.add(eventId);
  while (client.deliveredEventIds.size > MAX_DELIVERED_EVENT_IDS_PER_STREAM) {
    const oldest = client.deliveredEventIds.values().next().value;
    client.deliveredEventIds.delete(oldest);
  }
}

export function createIntegrationNotificationStreamRuntime(options = {}) {
  const clients = new Map();
  const metrics = options.runtimeMetrics;
  const heartbeatMs = boundedInteger(
    options.heartbeatMs,
    DEFAULT_HEARTBEAT_MS,
    1_000,
    60_000,
  );
  const bootstrapPaddingBytes = boundedInteger(
    options.bootstrapPaddingBytes,
    DEFAULT_BOOTSTRAP_PADDING_BYTES,
    0,
    8_192,
  );
  let sequence = 1;

  const increment = (name, amount = 1) => metrics?.incrementCounter?.(name, amount);
  const gauge = (name, value) => metrics?.setGauge?.(name, value);
  const record = (kind, label, value) => metrics?.recordOperation?.(kind, label, value);
  const getCoordinator = () => options.getOutboxCoordinator?.() ?? null;

  function nextId() {
    const current = Math.max(1, Math.trunc(Number(sequence) || 1));
    sequence = current + 1;
    return `stream_${String(current).padStart(6, "0")}`;
  }

  function remove(streamId, removeOptions = {}) {
    const existing = clients.get(streamId);
    if (!existing) return;
    if (existing.heartbeatTimer) clearInterval(existing.heartbeatTimer);
    clients.delete(streamId);
    gauge("realtimeStreamClients", clients.size);
    if (
      removeOptions.end === true &&
      existing.res &&
      !existing.res.writableEnded &&
      !existing.res.destroyed
    ) {
      try {
        existing.res.end();
      } catch {
        // The stream is already detached from the runtime.
      }
    }
  }

  function subscriptionIntersects(left = [], right = []) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    const values = new Set(left);
    return right.some((entry) => values.has(entry));
  }

  function disconnect(criteria = {}) {
    const target = buildRealtimeSubscription(criteria);
    const targetSessionId = String(
      criteria.sessionId ?? criteria.id ?? "",
    ).trim();
    const requireClientApp = target.clientApps.length > 0;
    const requireUser = target.userIds.length > 0;
    const requireDevice = target.deviceIds.length > 0;
    if (!targetSessionId && (!requireUser || !requireDevice)) return 0;

    const streamIds = [];
    for (const [streamId, client] of clients.entries()) {
      const subscription = client.subscription ?? {};
      if (targetSessionId && client.sessionId !== targetSessionId) continue;
      if (
        requireClientApp &&
        !subscriptionIntersects(subscription.clientApps, target.clientApps)
      ) {
        continue;
      }
      if (
        requireUser &&
        !subscriptionIntersects(subscription.userIds, target.userIds)
      ) {
        continue;
      }
      if (
        requireDevice &&
        !subscriptionIntersects(subscription.deviceIds, target.deviceIds)
      ) {
        continue;
      }
      streamIds.push(streamId);
    }
    streamIds.forEach((streamId) => remove(streamId, { end: true }));
    if (streamIds.length > 0) {
      increment("realtimeStreamsDisconnectedByLogout", streamIds.length);
    }
    return streamIds.length;
  }

  function prepareEligibleEvent(client, event) {
    const sessionStartedAtMs = parseNotificationTimestampMs(
      client?.sessionStartedAtMs,
    );
    const preparedEvent = sessionStartedAtMs > 0
      ? filterNotificationEventForSession(event, sessionStartedAtMs)
      : event;
    if (!preparedEvent) return null;
    if (!isRealtimeSubscriptionEligible(
      client.subscription,
      resolveRealtimeAudience(preparedEvent),
      { enabled: options.scopedDelivery === true },
    )) {
      return null;
    }
    return preparedEvent;
  }

  function publish(payload = {}, outboxEvent = null) {
    options.clearPullCache?.();
    if (clients.size === 0) return false;

    const safePayload = options.buildPayload(payload.reason, payload.detail);
    safePayload.atMs = Number.isFinite(Number(payload.atMs))
      ? Number(payload.atMs)
      : safePayload.atMs;
    const envelope = outboxEvent ? options.toEnvelope(outboxEvent) : null;
    const eventId = Math.max(0, Math.trunc(Number(envelope?.eventId) || 0));
    const payloadEvent = options.eventPayload === true
      ? envelope ?? { ...safePayload, type: options.resolveEventType(safePayload.reason) }
      : null;
    const lagMs = options.resolvePublishLagMs?.(outboxEvent);
    if (lagMs !== null && lagMs !== undefined) {
      record("realtime", "eventPublishLagMs", lagMs);
      gauge("eventPublishLagMs", lagMs);
    }

    const audienceEvent = payloadEvent ?? safePayload;
    const eligibleClients = [];
    let filteredClients = 0;
    for (const entry of clients.entries()) {
      const client = entry[1];
      const preparedEvent = prepareEligibleEvent(client, audienceEvent);
      if (preparedEvent && !(eventId > 0 && client.deliveredEventIds?.has(eventId))) {
        const preparedRefresh = payloadEvent
          ? prepareEligibleEvent(client, safePayload)
          : preparedEvent;
        eligibleClients.push({
          streamId: entry[0],
          client,
          payloadEvent: payloadEvent ? preparedEvent : null,
          refreshPayload: preparedRefresh,
        });
      }
      else filteredClients += 1;
    }

    const eventOptions = eventId > 0 ? { eventId } : {};
    const serializedFrames = new Map();
    const getSerializedFrame = (eventName, event) => {
      if (!event) return null;
      const key = `${eventName}:${eventId}:${JSON.stringify(event)}`;
      if (!serializedFrames.has(key)) {
        serializedFrames.set(key, frame(eventName, event, eventOptions));
        increment("realtimeSseFramesSerialized");
      }
      return serializedFrames.get(key);
    };
    increment("realtimeBusinessEvents");
    increment("realtimeEligibleRecipients", eligibleClients.length);
    increment("realtimeFilteredClients", filteredClients);
    record("realtime", "eligibleRecipients", eligibleClients.length);
    record("realtime", "filteredClients", filteredClients);

    let delivered = false;
    for (const { streamId, client, payloadEvent: clientPayload, refreshPayload } of eligibleClients) {
      let deliveredToClient = false;
      if (clientPayload) {
        const payloadFrame = getSerializedFrame("payload", clientPayload);
        if (!write(client, "payload", clientPayload, { ...eventOptions, serializedFrame: payloadFrame })) {
          remove(streamId);
          continue;
        }
        delivered = true;
        deliveredToClient = true;
        rememberDeliveredEventId(client, eventId);
        increment("realtimeDeliveryBytes", Buffer.byteLength(payloadFrame));
      }
      if (options.legacyRefresh !== true) {
        if (deliveredToClient) increment("realtimeDeliveredRecipients");
        continue;
      }
      const refreshFrame = getSerializedFrame("refresh", refreshPayload);
      if (!refreshFrame) {
        if (deliveredToClient) increment("realtimeDeliveredRecipients");
        continue;
      }
      if (!write(client, "refresh", refreshPayload, { ...eventOptions, serializedFrame: refreshFrame })) {
        if (deliveredToClient) increment("realtimeDeliveredRecipients");
        remove(streamId);
        continue;
      }
      delivered = true;
      deliveredToClient = true;
      increment("realtimeDeliveryBytes", Buffer.byteLength(refreshFrame));
      increment("realtimeDeliveredRecipients");
    }
    return delivered;
  }

  function replay(client, afterEventId) {
    if (options.replayEnabled !== true || afterEventId <= 0) {
      return { replayed: 0, recoveryRequired: false };
    }
    const result = getCoordinator()?.replay?.({ afterEventId, limit: 500 });
    if (!result) return { replayed: 0, recoveryRequired: false };
    if (result.recoveryRequired) {
      increment("replayGapCount");
      increment("realtimeReplayRecoveries");
      write(client, "recovery", {
        ok: true,
        recoveryRequired: true,
        minEventId: result.bounds.minId,
        maxEventId: result.bounds.maxId,
        lastEventId: afterEventId,
      });
      return { replayed: 0, recoveryRequired: true };
    }
    let replayed = 0;
    for (const event of result.events) {
      const envelope = options.toEnvelope(event);
      const preparedEnvelope = prepareEligibleEvent(client, envelope);
      if (!preparedEnvelope) {
        increment("realtimeReplayFilteredEvents");
        continue;
      }
      if (!write(client, "payload", preparedEnvelope, { eventId: envelope.eventId })) {
        return { replayed, recoveryRequired: false, disconnected: true };
      }
      rememberDeliveredEventId(client, envelope.eventId);
      replayed += 1;
    }
    if (replayed > 0) {
      increment("realtimeReplayRuns");
      increment("realtimeReplayEvents", replayed);
    }
    return { replayed, recoveryRequired: false };
  }

  function queryList(requestUrl, ...names) {
    return names.flatMap((name) =>
      requestUrl.searchParams.getAll(name).flatMap((value) => String(value ?? "").split(",")),
    );
  }

  function handle(req, res, requestUrl, context = {}) {
    const streamId = nextId();
    const headerLastEventId = String(options.readHeaderValue(req, "last-event-id") ?? "").trim();
    const queryLastEventId = String(
      requestUrl.searchParams.get("lastEventId") ??
      requestUrl.searchParams.get("afterEventId") ??
      "",
    ).trim();
    const lastEventId = Math.max(0, Math.trunc(Number(headerLastEventId || queryLastEventId) || 0));
    const consumer = String(requestUrl.searchParams.get("consumer") ?? "").trim();
    const rawClientApp = String(requestUrl.searchParams.get("clientApp") ?? "").trim();
    const clientApp = options.normalizeClientApp(rawClientApp || consumer || "mobile-frontend");
    const sessionId = String(context.sessionId ?? "").trim();
    const sessionBound = Boolean(sessionId);
    const streamClient = {
      id: streamId,
      res,
      consumer: consumer || "mobile-frontend",
      clientApp,
      sessionId,
      sessionStartedAtMs: parseNotificationTimestampMs(
        context.sessionStartedAtMs,
      ),
      sessionValidationInFlight: false,
      deliveredEventIds: new Set(),
      subscription: buildRealtimeSubscription({
        clientApp,
        storeIds: queryList(requestUrl, "storeId", "storeIds"),
        roomIds: sessionBound
          ? [context.roomId, context.roomName]
          : queryList(requestUrl, "roomId", "roomIds", "roomName"),
        stationIds: queryList(requestUrl, "station", "stationId", "stationIds", "stationName"),
        deviceIds: sessionBound
          ? [context.deviceUuid]
          : queryList(requestUrl, "deviceUuid", "deviceId", "deviceIds"),
        userIds: sessionBound
          ? [context.userId, context.username, context.fullName]
          : queryList(requestUrl, "userId", "userIds", "username", "fullName"),
        roles: queryList(requestUrl, "role", "roles"),
        departments: queryList(requestUrl, "department", "departments"),
      }),
      heartbeatTimer: null,
    };

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    if (res.socket) {
      res.socket.setTimeout(0);
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true);
    }
    if (bootstrapPaddingBytes > 0) {
      // Some Android WebView / HTTPS proxy combinations buffer very small SSE
      // chunks until another packet arrives. A one-off comment padding forces
      // the stream through without changing the EventSource event contract.
      res.write(`:${" ".repeat(bootstrapPaddingBytes)}\n\n`);
      res.flush?.();
    }

    clients.set(streamId, streamClient);
    gauge("realtimeStreamClients", clients.size);
    const validateAndHeartbeat = async () => {
      if (res.writableEnded || res.destroyed) {
        remove(streamId);
        return;
      }
      if (streamClient.sessionValidationInFlight) return;
      streamClient.sessionValidationInFlight = true;
      try {
        if (
          streamClient.sessionId &&
          typeof options.validateSession === "function" &&
          !(await options.validateSession({
            sessionId: streamClient.sessionId,
            sessionStartedAtMs: streamClient.sessionStartedAtMs,
            clientApp: streamClient.clientApp,
            userId: String(context.userId ?? "").trim(),
            username: String(context.username ?? "").trim(),
            deviceUuid: String(context.deviceUuid ?? "").trim(),
          }))
        ) {
          increment("realtimeStreamsDisconnectedBySessionValidation");
          remove(streamId, { end: true });
          return;
        }
        res.write(": keep-alive\n\n");
        res.flush?.();
      } catch {
        increment("realtimeStreamsDisconnectedBySessionValidation");
        remove(streamId, { end: true });
      } finally {
        streamClient.sessionValidationInFlight = false;
      }
    };
    streamClient.validateAndHeartbeat = validateAndHeartbeat;
    streamClient.heartbeatTimer = setInterval(() => {
      void validateAndHeartbeat();
    }, heartbeatMs);

    write(streamClient, "ready", {
      ok: true,
      streamId,
      consumer: streamClient.consumer,
      clientApp: streamClient.clientApp,
      connectedAtMs: Date.now(),
      lastEventId,
      scopedDelivery: options.scopedDelivery === true,
      scopeRegistered: streamClient.subscription.scoped,
      sessionBound:
        Boolean(streamClient.sessionId) && streamClient.sessionStartedAtMs > 0,
    });
    replay(streamClient, lastEventId);
    getCoordinator()?.publishPending?.();

    const cleanup = () => remove(streamId);
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  return {
    clientCount: () => clients.size,
    disconnect,
    handle,
    publish,
    async validateSessions() {
      await Promise.all(
        [...clients.values()].map((client) => client.validateAndHeartbeat?.()),
      );
      return clients.size;
    },
  };
}
