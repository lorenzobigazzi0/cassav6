import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import path from "node:path";

import {
  apiPost,
  authHeaders,
  authPayload,
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

async function startOutboxBackend(t, prefix = "realtime-event-outbox", extraEnv = {}, options = {}) {
  const runDir = options.runDir ?? (await createTempRunDir(prefix));
  const relationalPath = options.relationalPath ?? path.join(runDir, "backend-relational.sqlite");
  const backend = await startBackend(t, {
    runDir,
    dbPath: options.dbPath,
    preserveDb: options.preserveDb,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      EVENT_OUTBOX_ENABLED: "1",
      SSE_EVENT_PAYLOAD: "1",
      ...extraEnv,
    },
  });
  return { ...backend, relationalPath };
}

async function readOutboxRows(relationalPath, eventType = null) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    if (eventType) {
      return db
        .prepare("SELECT * FROM event_outbox WHERE event_type = ? ORDER BY id ASC")
        .all(eventType);
    }
    return db.prepare("SELECT * FROM event_outbox ORDER BY id ASC").all();
  } finally {
    db.close();
  }
}

async function readOutboxRowById(relationalPath, id) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM event_outbox WHERE id = ?").get(id);
  } finally {
    db.close();
  }
}

async function enqueueOutboxEvent(relationalPath, event = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath);
  try {
    const scope = event.scope ?? null;
    const sequenceRow = scope
      ? db
          .prepare("SELECT COALESCE(MAX(scope_sequence), 0) + 1 AS next_sequence FROM event_outbox WHERE scope = ?")
          .get(scope)
      : db
          .prepare("SELECT COALESCE(MAX(scope_sequence), 0) + 1 AS next_sequence FROM event_outbox WHERE scope IS NULL")
          .get();
    const result = db
      .prepare(
        `
          INSERT INTO event_outbox (
            event_type,
            aggregate_type,
            aggregate_id,
            scope,
            scope_sequence,
            payload_json,
            occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        event.eventType ?? "system.refresh",
        event.aggregateType ?? "system",
        event.aggregateId ?? "manual-event",
        scope,
        Math.max(1, Math.trunc(Number(sequenceRow?.next_sequence) || 1)),
        JSON.stringify(event.payload ?? {}),
        event.occurredAt ?? new Date().toISOString(),
      );
    return result.lastInsertRowid;
  } finally {
    db.close();
  }
}

async function readSseEvent(response, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const readResult = await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout SSE")), remainingMs),
      ),
    ]);
    if (readResult.done) break;
    buffer += decoder.decode(readResult.value, { stream: true });
    const parts = buffer.split(/\n\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = { event: "message", id: "", data: "" };
      for (const line of part.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("id:")) event.id = line.slice("id:".length).trim();
        if (line.startsWith("event:")) event.event = line.slice("event:".length).trim();
        if (line.startsWith("data:")) event.data += line.slice("data:".length).trim();
      }
      if (predicate(event)) return event;
    }
  }
  throw new Error("Evento SSE atteso non ricevuto");
}

async function readSseEventsUntil(response, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const readResult = await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout SSE")), remainingMs),
      ),
    ]);
    if (readResult.done) break;
    buffer += decoder.decode(readResult.value, { stream: true });
    const parts = buffer.split(/\n\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = { event: "message", id: "", data: "" };
      for (const line of part.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("id:")) event.id = line.slice("id:".length).trim();
        if (line.startsWith("event:")) event.event = line.slice("event:".length).trim();
        if (line.startsWith("data:")) event.data += line.slice("data:".length).trim();
      }
      events.push(event);
      if (predicate(event, events)) return events;
    }
  }
  throw new Error("Evento SSE atteso non ricevuto");
}

function parseRealtimeSseData(data) {
  const envelope = JSON.parse(data || "{}");
  const payload =
    envelope.payload && typeof envelope.payload === "object" ? envelope.payload : envelope;
  return { envelope, payload };
}

async function openNotificationStream(t, baseUrl, consumer) {
  const streamController = new AbortController();
  t.after(() => streamController.abort());
  const streamResponse = await fetch(
    `${baseUrl}/api/integration/notifications/stream?consumer=${consumer}&clientApp=postazione`,
    { signal: streamController.signal },
  );
  assert.equal(streamResponse.status, 200);
  return streamResponse;
}

async function lockTableForCancel(baseUrl, session, deviceUuid, tableId) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose: "order.cancel" }),
  );
  assert.equal(locked.response.status, 200);
}

async function lockTableForCorrection(baseUrl, session, deviceUuid, tableId) {
  const locked = await apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, { tableId, purpose: "order.correction" }),
  );
  assert.equal(locked.response.status, 200);
}

test("[BE][P0] event outbox conserva e pubblica order.created su SSE", async (t) => {
  const { baseUrl, relationalPath } = await startOutboxBackend(
    t,
    "realtime-event-outbox-order",
    {
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "outbox-order-device",
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "outbox-order-device",
  });
  assert.equal(created.response.status, 200);
  const orderId = created.body.order.id;

  const rows = await readOutboxRows(relationalPath, "order.created");
  const row = rows.find((entry) => entry.aggregate_id === orderId);
  assert.ok(row);
  assert.equal(row.aggregate_type, "order");
  assert.equal(row.scope, "room_pedana");
  assert.equal(row.published_at, null);
  const queuedPayload = JSON.parse(row.payload_json);
  assert.equal(queuedPayload.detail.orderId, orderId);
  assert.equal(queuedPayload.detail.payloadMode, "lean");
  assert.equal(queuedPayload.detail.order, undefined);
  assert.equal(queuedPayload.detail.table, undefined);

  const streamResponse = await openNotificationStream(t, baseUrl, "outbox-order");
  const event = await readSseEvent(streamResponse, (candidate) => {
    if (candidate.event !== "payload") return false;
    const { envelope, payload } = parseRealtimeSseData(candidate.data);
    return envelope.type === "order.created" && payload.detail?.orderId === orderId;
  });
  const { envelope: parsedEnvelope, payload: parsedPayload } = parseRealtimeSseData(event.data);
  assert.equal(parsedEnvelope.eventId, row.id);
  assert.equal(event.id, String(row.id));
  assert.equal(parsedPayload.reason, "order_created");

  const published = await readOutboxRowById(relationalPath, row.id);
  assert.ok(published.published_at);
});

test("[BE][STEP7] SSE live usa envelope outbox e spegne refresh legacy dietro flag", async (t) => {
  const { baseUrl } = await startOutboxBackend(
    t,
    "realtime-step7-envelope",
    {
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
      REALTIME_REPLAY_ENABLED: "1",
      SSE_LEGACY_REFRESH: "0",
    },
  );
  const streamResponse = await openNotificationStream(t, baseUrl, "step7-envelope");
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "step7-envelope-device",
    clientApp: "mobile-frontend",
  });

  const createdPromise = createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "step7-envelope-device",
  });
  const events = await readSseEventsUntil(streamResponse, (candidate) => {
    if (candidate.event !== "payload") return false;
    const { envelope, payload } = parseRealtimeSseData(candidate.data);
    return envelope.type === "order.created" && Boolean(payload.detail?.orderId);
  });
  const created = await createdPromise;
  const orderId = created.body.order.id;
  const payloadEvent = events.find((event) => {
    if (event.event !== "payload") return false;
    const { payload } = parseRealtimeSseData(event.data);
    return payload.detail?.orderId === orderId;
  });
  assert.ok(payloadEvent, "evento payload order.created ricevuto");
  assert.equal(events.some((event) => event.event === "refresh"), false);
  const { envelope, payload } = parseRealtimeSseData(payloadEvent.data);
  assert.equal(envelope.type, "order.created");
  assert.equal(envelope.eventId, Number(payloadEvent.id));
  assert.equal(envelope.aggregateType, "order");
  assert.equal(envelope.aggregateId, orderId);
  assert.equal(payload.reason, "order_created");
});

test("[BE][STEP7] Last-Event-ID/lastEventId fa replay degli eventi outbox successivi", async (t) => {
  const { baseUrl, relationalPath } = await startOutboxBackend(
    t,
    "realtime-step7-last-event-id",
    {
      REALTIME_REPLAY_ENABLED: "1",
      SSE_LEGACY_REFRESH: "0",
    },
  );
  const firstId = await enqueueOutboxEvent(relationalPath, {
    eventType: "system.refresh",
    aggregateType: "system",
    aggregateId: "first",
    payload: {
      ok: true,
      reason: "first",
      detail: { marker: "first" },
    },
  });
  const targetMarker = `last_event_${Date.now()}`;
  const targetId = await enqueueOutboxEvent(relationalPath, {
    eventType: "system.refresh",
    aggregateType: "system",
    aggregateId: targetMarker,
    payload: {
      ok: true,
      reason: "last_event_replay",
      detail: { marker: targetMarker },
    },
  });

  const streamController = new AbortController();
  t.after(() => streamController.abort());
  const streamResponse = await fetch(
    `${baseUrl}/api/integration/notifications/stream?consumer=step7-replay&clientApp=postazione&lastEventId=${firstId}`,
    { signal: streamController.signal },
  );
  assert.equal(streamResponse.status, 200);
  const event = await readSseEvent(streamResponse, (candidate) => {
    if (candidate.event !== "payload") return false;
    const { payload } = parseRealtimeSseData(candidate.data);
    return payload.detail?.marker === targetMarker;
  });
  const { envelope, payload } = parseRealtimeSseData(event.data);
  assert.equal(event.id, String(targetId));
  assert.equal(envelope.eventId, Number(targetId));
  assert.equal(payload.reason, "last_event_replay");
});

test("[BE][STEP7] il replay outbox non attraversa logout e nuova sessione mobile", async (t) => {
  const { baseUrl, relationalPath } = await startOutboxBackend(
    t,
    "realtime-step7-session-boundary",
    {
      REALTIME_REPLAY_ENABLED: "1",
      SSE_LEGACY_REFRESH: "0",
    },
  );
  const deviceUuid = "step7-session-boundary-device";
  const firstSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const cursorId = await enqueueOutboxEvent(relationalPath, {
    aggregateId: "session-boundary-cursor",
    occurredAt: new Date().toISOString(),
    payload: {
      ok: true,
      reason: "session_boundary_cursor",
      detail: { marker: "cursor" },
    },
  });

  const logout = await apiPost(
    baseUrl,
    "/api/auth/logout",
    authPayload(firstSession, deviceUuid, { clientApp: "mobile-frontend" }),
  );
  assert.equal(logout.response.status, 200);

  const staleCreatedAt = Date.now();
  const staleId = await enqueueOutboxEvent(relationalPath, {
    eventType: "notification",
    aggregateType: "notification",
    aggregateId: "notification-created-while-logged-out",
    occurredAt: new Date(staleCreatedAt).toISOString(),
    payload: {
      ok: true,
      reason: "notification_publish",
      detail: {
        notification: {
          id: "notification-created-while-logged-out",
          type: "bell",
          title: "Comanda pronta obsoleta",
          description: "Non deve attraversare il nuovo login",
          createdAt: staleCreatedAt,
          meta: {
            eventType: "order_ready",
            targetClientApp: "mobile-frontend",
            targetUserId: "u_waiter",
          },
        },
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const secondSession = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const currentCreatedAt = Math.max(Date.now(), secondSession.sessionStartedAt);
  const currentId = await enqueueOutboxEvent(relationalPath, {
    eventType: "notification",
    aggregateType: "notification",
    aggregateId: "notification-current-session",
    occurredAt: new Date(currentCreatedAt).toISOString(),
    payload: {
      ok: true,
      reason: "notification_publish",
      detail: {
        notification: {
          id: "notification-current-session",
          type: "bell",
          title: "Comanda pronta corrente",
          description: "Valida nella nuova sessione",
          createdAt: currentCreatedAt,
          meta: {
            eventType: "order_ready",
            targetClientApp: "mobile-frontend",
            targetUserId: "u_waiter",
          },
        },
      },
    },
  });

  const streamController = new AbortController();
  t.after(() => streamController.abort());
  const params = new URLSearchParams({
    consumer: "step7-session-boundary",
    clientApp: "mobile-frontend",
    userId: secondSession.user.id,
    username: secondSession.user.username,
    deviceUuid,
    lastEventId: String(cursorId),
  });
  const streamResponse = await fetch(
    `${baseUrl}/api/integration/notifications/stream?${params}`,
    { signal: streamController.signal },
  );
  assert.equal(streamResponse.status, 200);
  const events = await readSseEventsUntil(streamResponse, (candidate) => {
    if (candidate.event !== "payload") return false;
    const { payload } = parseRealtimeSseData(candidate.data);
    return payload.detail?.notification?.id === "notification-current-session";
  });
  const payloadIds = events
    .filter((event) => event.event === "payload")
    .map((event) => parseRealtimeSseData(event.data).payload.detail?.notification?.id)
    .filter(Boolean);
  assert.equal(payloadIds.includes("notification-created-while-logged-out"), false);
  assert.equal(payloadIds.includes("notification-current-session"), true);
  assert.ok(staleId > cursorId);
  assert.ok(currentId > staleId);
});

test("[BE][MP-4] orders/sync ready mette order_ready e order_state_changed in outbox", async (t) => {
  const { baseUrl, relationalPath } = await startOutboxBackend(
    t,
    "realtime-event-outbox-order-sync",
    {
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY: "1",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "outbox-sync-cashier",
    clientApp: "mobile-frontend",
  });
  const station = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "outbox-sync-station",
    clientApp: "postazione",
  });
  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "outbox-sync-cashier",
    extraPayload: { idempotencyKey: "outbox-sync-ready" },
  });
  assert.equal(created.response.status, 200);
  const orderId = created.body.order.id;

  const synced = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "outbox-sync-station", {
      id: orderId,
      clientApp: "postazione",
      workflowReason: "station_ready",
      order: {
        ...created.body.order,
        workflowStatus: "ready",
        items: created.body.order.items.map((item) => ({ ...item, done: true })),
      },
    }),
  );
  assert.equal(synced.response.status, 200);

  const rows = await readOutboxRows(relationalPath, "order.status");
  const payloads = rows.map((row) => JSON.parse(row.payload_json));
  const readyPayload = payloads.find(
    (payload) =>
      payload.reason === "order_ready" &&
      payload.detail?.orderId === orderId,
  );
  const statePayload = payloads.find(
    (payload) =>
      payload.reason === "order_state_changed" &&
      payload.detail?.orderId === orderId,
  );

  assert.ok(readyPayload);
  assert.ok(readyPayload.detail.notificationId);
  assert.equal(readyPayload.detail.notification?.meta?.eventType, "order_ready");
  assert.ok(statePayload);
  assert.equal(statePayload.detail.previousStatus, "waiting");
  assert.equal(statePayload.detail.nextStatus, synced.body.order.workflowStatus);
});

test("[BE][MP-4af] orders/cancel mette order_cancelled in outbox", async (t) => {
  const { baseUrl, relationalPath } = await startOutboxBackend(
    t,
    "realtime-event-outbox-order-cancel",
    {
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY: "1",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "outbox-cancel-cashier",
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "outbox-cancel-cashier",
    extraPayload: { idempotencyKey: "outbox-cancel-order" },
  });
  assert.equal(created.response.status, 200);
  const orderId = created.body.order.id;

  await lockTableForCancel(baseUrl, cashier, "outbox-cancel-cashier", created.body.order.tableId);
  const cancelled = await apiPost(
    baseUrl,
    "/api/integration/orders/cancel",
    authPayload(cashier, "outbox-cancel-cashier", {
      orderId,
      tableId: created.body.order.tableId,
      roomId: created.body.order.roomId,
      expectedRevision: created.body.order.revision,
      reason: "Outbox cancel test",
    }),
  );
  assert.equal(cancelled.response.status, 200);

  const rows = await readOutboxRows(relationalPath, "order.status");
  const row = rows.find((entry) => {
    if (entry.aggregate_id !== orderId) return false;
    const payload = JSON.parse(entry.payload_json);
    return payload.reason === "order_cancelled" && payload.detail?.orderId === orderId;
  });
  assert.ok(row);
  assert.equal(row.aggregate_type, "order");

  const streamResponse = await openNotificationStream(t, baseUrl, "outbox-cancel");
  const event = await readSseEvent(streamResponse, (candidate) => {
    if (candidate.event !== "payload") return false;
    const { envelope, payload } = parseRealtimeSseData(candidate.data);
    return envelope.type === "order.status" && payload.reason === "order_cancelled" && payload.detail?.orderId === orderId;
  });
  const { payload: parsed } = parseRealtimeSseData(event.data);
  assert.equal(parsed.detail.tableId, created.body.order.tableId);
});

test("[BE][MP-4an] orders/correct mette order_correction_applied in outbox", async (t) => {
  const { baseUrl, relationalPath } = await startOutboxBackend(
    t,
    "realtime-event-outbox-order-correct",
    {
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY: "1",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  );
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "outbox-correct-cashier",
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(baseUrl, cashier, {
    deviceUuid: "outbox-correct-cashier",
    extraPayload: { idempotencyKey: "outbox-correct-order" },
  });
  assert.equal(created.response.status, 200);
  const orderId = created.body.order.id;

  await lockTableForCorrection(baseUrl, cashier, "outbox-correct-cashier", created.body.order.tableId);
  const corrected = await apiPost(
    baseUrl,
    "/api/integration/orders/correct",
    authPayload(cashier, "outbox-correct-cashier", {
      orderId,
      tableId: created.body.order.tableId,
      roomId: created.body.order.roomId,
      expectedRevision: created.body.order.revision,
      addedItems: [{ productId: "menu_caffetteria_cappuccino", quantity: 1 }],
      reason: "Outbox correct test",
      idempotencyKey: "outbox-correct-applied",
    }),
  );
  assert.equal(corrected.response.status, 200);

  const rows = await readOutboxRows(relationalPath, "order.status");
  const row = rows.find((entry) => {
    if (entry.aggregate_id !== orderId) return false;
    const payload = JSON.parse(entry.payload_json);
    return payload.reason === "order_correction_applied" && payload.detail?.orderId === orderId;
  });
  assert.ok(row);
  assert.equal(row.aggregate_type, "order");

  const streamResponse = await openNotificationStream(t, baseUrl, "outbox-correct");
  const event = await readSseEvent(streamResponse, (candidate) => {
    if (candidate.event !== "payload") return false;
    const { envelope, payload } = parseRealtimeSseData(candidate.data);
    return envelope.type === "order.status" && payload.reason === "order_correction_applied" && payload.detail?.orderId === orderId;
  });
  const { payload: parsed } = parseRealtimeSseData(event.data);
  assert.equal(parsed.detail.correctionId, corrected.body.correction.correctionId);
});

test("[BE][P0] event outbox conserva e pubblica notification su SSE", async (t) => {
  const { baseUrl, relationalPath } = await startOutboxBackend(
    t,
    "realtime-event-outbox-notification",
  );
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid: "outbox-notification-admin",
    clientApp: "cassa-frontend",
  });
  const orderId = `ord_outbox_notification_${Date.now()}`;

  const publishedNotification = await apiPost(
    baseUrl,
    "/api/integration/notifications/publish",
    {
      type: "bell",
      title: "Comanda pronta",
      description: "Outbox notification test",
      meta: {
        orderId,
        targetClientApp: "mobile-frontend",
      },
    },
    { headers: authHeaders(admin, "outbox-notification-admin") },
  );
  assert.equal(publishedNotification.response.status, 200);
  const notificationId = publishedNotification.body.notification.id;

  const rows = await readOutboxRows(relationalPath, "notification");
  const row = rows.find((entry) => entry.aggregate_id === notificationId);
  assert.ok(row);
  assert.equal(row.aggregate_type, "notification");
  assert.equal(row.published_at, null);
  const queuedPayload = JSON.parse(row.payload_json);
  assert.equal(queuedPayload.detail.notification.id, notificationId);
  assert.equal(queuedPayload.detail.orderId, orderId);

  const streamResponse = await openNotificationStream(t, baseUrl, "outbox-notification");
  const event = await readSseEvent(streamResponse, (candidate) => {
    if (candidate.event !== "payload") return false;
    const { envelope, payload } = parseRealtimeSseData(candidate.data);
    return envelope.type === "notification" && payload.detail?.notification?.id === notificationId;
  });
  const { payload: parsed } = parseRealtimeSseData(event.data);
  assert.equal(parsed.reason, "notification_publish");

  const published = await readOutboxRowById(relationalPath, row.id);
  assert.ok(published.published_at);
});

test("[BE][P0] event outbox worker pubblica eventi con stream gia aperto", async (t) => {
  const { baseUrl, relationalPath } = await startOutboxBackend(
    t,
    "realtime-event-outbox-worker",
    { EVENT_OUTBOX_DRAIN_INTERVAL_MS: "50" },
  );
  const streamResponse = await openNotificationStream(t, baseUrl, "outbox-worker");
  const marker = `worker_${Date.now()}`;
  const eventPromise = readSseEvent(
    streamResponse,
    (candidate) => {
      if (candidate.event !== "payload") return false;
      const { payload } = parseRealtimeSseData(candidate.data);
      return payload.detail?.marker === marker;
    },
    { timeoutMs: 8_000 },
  );

  const outboxId = await enqueueOutboxEvent(relationalPath, {
    eventType: "system.refresh",
    aggregateType: "system",
    aggregateId: marker,
    payload: {
      ok: true,
      reason: "worker_drain_test",
      atMs: Date.now(),
      detail: { marker },
    },
  });

  const event = await eventPromise;
  const { payload: parsed } = parseRealtimeSseData(event.data);
  assert.equal(parsed.reason, "worker_drain_test");
  assert.equal(parsed.detail.marker, marker);

  const published = await readOutboxRowById(relationalPath, outboxId);
  assert.ok(published.published_at);
});

test("[BE][P0] event outbox sopravvive a riavvio backend e pubblica evento pendente", async (t) => {
  const first = await startOutboxBackend(t, "realtime-event-outbox-restart");
  const cashier = await loginJson(first.baseUrl, "cashier", "2222", {
    deviceUuid: "outbox-restart-device",
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(first.baseUrl, cashier, {
    deviceUuid: "outbox-restart-device",
  });
  assert.equal(created.response.status, 200);
  const orderId = created.body.order.id;
  const rowsBeforeRestart = await readOutboxRows(first.relationalPath, "order.created");
  const queuedRow = rowsBeforeRestart.find((entry) => entry.aggregate_id === orderId);
  assert.ok(queuedRow);
  assert.equal(queuedRow.published_at, null);

  const exitPromise = once(first.child, "exit");
  first.child.kill("SIGTERM");
  await exitPromise;

  const second = await startOutboxBackend(
    t,
    "realtime-event-outbox-restart",
    {},
    {
      runDir: first.runDir,
      dbPath: first.dbPath,
      relationalPath: first.relationalPath,
      preserveDb: true,
    },
  );
  const streamResponse = await openNotificationStream(t, second.baseUrl, "outbox-restart");
  const event = await readSseEvent(streamResponse, (candidate) => {
    if (candidate.event !== "payload") return false;
    const { envelope, payload } = parseRealtimeSseData(candidate.data);
    return envelope.type === "order.created" && payload.detail?.orderId === orderId;
  });
  const { payload: parsed } = parseRealtimeSseData(event.data);
  assert.equal(parsed.reason, "order_created");

  const published = await readOutboxRowById(first.relationalPath, queuedRow.id);
  assert.ok(published.published_at);
});
