import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createIntegrationNotificationStreamRuntime } from "../modules/realtime-backbone/notification-stream-runtime.js";

class FakeRequest extends EventEmitter {}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.headers = null;
    this.statusCode = null;
    this.chunks = [];
    this.flushCount = 0;
    this.flushHeadersCount = 0;
    this.socket = {
      setTimeout: () => undefined,
      setNoDelay: () => undefined,
      setKeepAlive: () => undefined,
    };
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  flushHeaders() {
    this.flushHeadersCount += 1;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  flush() {
    this.flushCount += 1;
  }

  end() {
    this.writableEnded = true;
    this.emit("close");
  }
}

function createRuntime(overrides = {}) {
  return createIntegrationNotificationStreamRuntime({
    bootstrapPaddingBytes: 2_048,
    buildPayload: (reason, detail) => ({ ok: true, reason, detail, atMs: Date.now() }),
    eventPayload: true,
    legacyRefresh: false,
    normalizeClientApp: (value) => String(value || "mobile-frontend"),
    readHeaderValue: () => "",
    replayEnabled: false,
    resolveEventType: () => "notification",
    scopedDelivery: false,
    toEnvelope: (event) => event,
    ...overrides,
  });
}

test("lo stream SSE forza il bootstrap e il flush dei frame applicativi", (t) => {
  const runtime = createRuntime();
  const req = new FakeRequest();
  const res = new FakeResponse();
  t.after(() => req.emit("close"));

  runtime.handle(
    req,
    res,
    new URL("http://localhost/api/integration/notifications/stream?clientApp=mobile-frontend"),
  );

  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers?.["Content-Type"]), /text\/event-stream/i);
  assert.equal(res.headers?.["X-Accel-Buffering"], "no");
  assert.equal(res.flushHeadersCount, 1);
  assert.ok(res.chunks[0].startsWith(":"));
  assert.ok(res.chunks[0].length >= 2_048);
  assert.ok(res.chunks.some((chunk) => chunk.includes("event: ready")));
  assert.ok(res.flushCount >= 2, "bootstrap e ready devono essere flushati");

  const beforeFlush = res.flushCount;
  const delivered = runtime.publish({
    reason: "notification_publish",
    detail: { notification: { id: "ntf-1", title: "Chiama cameriere" } },
  });

  assert.equal(delivered, true);
  assert.ok(res.chunks.some((chunk) => chunk.includes("event: payload")));
  assert.ok(res.chunks.some((chunk) => chunk.includes("ntf-1")));
  assert.ok(res.flushCount > beforeFlush, "il payload deve essere flushato immediatamente");
});

test("il padding SSE e configurabile e puo essere disabilitato", (t) => {
  const runtime = createRuntime({ bootstrapPaddingBytes: 0 });
  const req = new FakeRequest();
  const res = new FakeResponse();
  t.after(() => req.emit("close"));

  runtime.handle(
    req,
    res,
    new URL("http://localhost/api/integration/notifications/stream?clientApp=mobile-frontend"),
  );

  assert.equal(res.chunks.some((chunk) => chunk.startsWith(":")), false);
  assert.ok(res.chunks.some((chunk) => chunk.includes("event: ready")));
  assert.ok(res.flushCount >= 1);
});

test("logout chiude solo lo stream con la stessa coppia utente e device", (t) => {
  const runtime = createRuntime();
  const streams = [
    {
      req: new FakeRequest(),
      res: new FakeResponse(),
      url: "http://localhost/api/integration/notifications/stream?clientApp=mobile-frontend&userId=u_waiter&deviceUuid=device_a",
    },
    {
      req: new FakeRequest(),
      res: new FakeResponse(),
      url: "http://localhost/api/integration/notifications/stream?clientApp=mobile-frontend&userId=u_waiter&deviceUuid=device_b",
    },
    {
      req: new FakeRequest(),
      res: new FakeResponse(),
      url: "http://localhost/api/integration/notifications/stream?clientApp=mobile-frontend&userId=u_other&deviceUuid=device_a",
    },
  ];
  t.after(() => streams.forEach(({ req }) => req.emit("close")));
  streams.forEach(({ req, res, url }) => runtime.handle(req, res, new URL(url)));

  assert.equal(runtime.clientCount(), 3);
  assert.equal(
    runtime.disconnect({
      clientApp: "mobile-frontend",
      userId: "u_waiter",
      deviceUuid: "device_a",
    }),
    1,
  );
  assert.equal(streams[0].res.writableEnded, true);
  assert.equal(streams[1].res.writableEnded, false);
  assert.equal(streams[2].res.writableEnded, false);
  assert.equal(runtime.clientCount(), 2);
  assert.equal(runtime.disconnect({ userId: "u_waiter" }), 0);
});

test("binding sessionId consente revoca puntuale e rivalidazione heartbeat", async (t) => {
  let active = true;
  const runtime = createRuntime({
    validateSession: async ({ sessionId, userId, deviceUuid }) =>
      active &&
      sessionId === "session-a" &&
      userId === "u_waiter" &&
      deviceUuid === "device-a",
  });
  const req = new FakeRequest();
  const res = new FakeResponse();
  t.after(() => req.emit("close"));
  runtime.handle(
    req,
    res,
    new URL(
      "http://localhost/api/integration/notifications/stream?clientApp=mobile-frontend&userId=spoofed&deviceUuid=spoofed",
    ),
    {
      sessionId: "session-a",
      sessionStartedAtMs: Date.now(),
      userId: "u_waiter",
      username: "waiter",
      deviceUuid: "device-a",
    },
  );

  assert.equal(runtime.clientCount(), 1);
  assert.equal(runtime.disconnect({ sessionId: "another-session" }), 0);
  active = false;
  assert.equal(await runtime.validateSessions(), 0);
  assert.equal(res.writableEnded, true);
});

test("lo stream legato alla sessione scarta notifiche precedenti anche dentro envelope nuovi", (t) => {
  const runtime = createRuntime();
  const req = new FakeRequest();
  const res = new FakeResponse();
  const sessionStartedAtMs = Date.now();
  t.after(() => req.emit("close"));

  runtime.handle(
    req,
    res,
    new URL("http://localhost/api/integration/notifications/stream?clientApp=mobile-frontend"),
    { sessionStartedAtMs },
  );

  const staleDelivered = runtime.publish({
    reason: "notification_handoff",
    atMs: sessionStartedAtMs + 10_000,
    detail: {
      notification: {
        id: "ntf-stale",
        createdAt: sessionStartedAtMs - 1,
      },
    },
  });
  assert.equal(staleDelivered, false);
  assert.equal(res.chunks.some((chunk) => chunk.includes("ntf-stale")), false);

  const currentDelivered = runtime.publish({
    reason: "notification_publish",
    atMs: sessionStartedAtMs + 1,
    detail: {
      notification: {
        id: "ntf-current",
        createdAt: sessionStartedAtMs + 1,
      },
    },
  });
  assert.equal(currentDelivered, true);
  assert.equal(res.chunks.some((chunk) => chunk.includes("ntf-current")), true);
});

test("lo stream filtra elemento per elemento un batch con timestamp misti", (t) => {
  const runtime = createRuntime();
  const req = new FakeRequest();
  const res = new FakeResponse();
  const sessionStartedAtMs = Date.now();
  t.after(() => req.emit("close"));

  runtime.handle(
    req,
    res,
    new URL("http://localhost/api/integration/notifications/stream?clientApp=mobile-frontend"),
    { sessionStartedAtMs },
  );
  assert.equal(
    runtime.publish({
      reason: "notification_handoff",
      atMs: sessionStartedAtMs + 10,
      detail: {
        notifications: [
          { id: "stale-batch", createdAt: sessionStartedAtMs - 1 },
          { id: "malformed-batch", createdAt: "2026garbage" },
          { id: "current-batch", createdAt: sessionStartedAtMs + 1 },
        ],
      },
    }),
    true,
  );

  const payload = res.chunks.find(
    (chunk) => chunk.includes("event: payload") && chunk.includes("current-batch"),
  );
  assert.ok(payload);
  assert.equal(payload.includes("stale-batch"), false);
  assert.equal(payload.includes("malformed-batch"), false);
});

test("replay e flush pending non duplicano lo stesso eventId sullo stream", (t) => {
  const event = {
    eventId: 42,
    type: "notification",
    createdAt: new Date().toISOString(),
    payload: {
      reason: "notification_publish",
      detail: {
        notification: { id: "ntf-once", createdAt: Date.now() },
      },
    },
  };
  let runtime;
  const coordinator = {
    replay: () => ({
      events: [event],
      bounds: { minId: 42, maxId: 42 },
      recoveryRequired: false,
    }),
    publishPending: () => runtime.publish(event.payload, event),
  };
  runtime = createRuntime({
    getOutboxCoordinator: () => coordinator,
    replayEnabled: true,
  });
  const req = new FakeRequest();
  const res = new FakeResponse();
  t.after(() => req.emit("close"));

  runtime.handle(
    req,
    res,
    new URL("http://localhost/api/integration/notifications/stream?clientApp=mobile-frontend&lastEventId=41"),
  );

  const payloadFrames = res.chunks.filter(
    (chunk) => chunk.includes("event: payload") && chunk.includes("ntf-once"),
  );
  assert.equal(payloadFrames.length, 1);
});
