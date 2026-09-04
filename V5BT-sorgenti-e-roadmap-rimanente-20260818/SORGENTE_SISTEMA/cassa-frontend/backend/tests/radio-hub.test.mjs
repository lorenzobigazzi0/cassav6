import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import {
  buildRadioFrame,
  createRadioHub,
  isRadioSocketBackpressured,
  RADIO_WS_PATH,
} from "../modules/radio/index.js";
import { sanitizeRadioChannels } from "../modules/radio/radio.domain.js";

function buildTestDb() {
  return {
    users: [
      {
        id: "u_alice",
        username: "alice",
        fullName: "Alice Rossi",
        role: "operator",
      },
      {
        id: "u_bruno",
        username: "bruno",
        fullName: "Bruno Verdi",
        role: "operator",
      },
      {
        id: "u_carla",
        username: "carla",
        fullName: "Carla Bianchi",
        role: "operator",
      },
    ],
    menuItems: [],
    posSettings: {
      radioChannels: [
        {
          id: "cucina",
          name: "Cucina",
          enabled: true,
          color: "#ff9f43",
          sortOrder: 10,
        },
        {
          id: "bar",
          name: "Bar",
          enabled: true,
          color: "#00d2ff",
          sortOrder: 20,
        },
        {
          id: "spento",
          name: "Spento",
          enabled: false,
          color: "#ff4757",
          sortOrder: 30,
        },
      ],
    },
  };
}

function sanitizeTestPosSettings(settings) {
  return {
    ...settings,
    radioChannels: sanitizeRadioChannels(settings?.radioChannels),
  };
}

function validateTestSession(db, payload) {
  const userId = String(payload?.userId ?? "").trim();
  const token = String(payload?.token ?? "").trim();
  const deviceUuid = String(payload?.deviceUuid ?? "").trim();
  const user = db.users.find((entry) => entry.id === userId);
  if (!user || token !== `token:${userId}` || !deviceUuid) {
    throw new Error("invalid session");
  }
  return {
    user,
    session: {
      userId,
      deviceUuid,
    },
  };
}

async function createRadioTestServer(options = {}) {
  const db = buildTestDb();
  const hub = createRadioHub({
    readDb: async () => db,
    sanitizePosSettings: sanitizeTestPosSettings,
    validateSessionContext: validateTestSession,
    nowIso: () => "2026-06-24T10:00:00.000Z",
    logger: { warn() {} },
    heartbeatIntervalMs: 0,
    helloTimeoutMs: options.helloTimeoutMs ?? 250,
    idleTimeoutMs: options.idleTimeoutMs,
    echoIdleTimeoutMs: options.echoIdleTimeoutMs,
    echoStopFlushMs: options.echoStopFlushMs,
  });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const requestUrl = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    if (requestUrl.pathname !== RADIO_WS_PATH) {
      socket.destroy();
      return;
    }
    hub.handleUpgrade(req, socket, head);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    db,
    url: `ws://127.0.0.1:${port}${RADIO_WS_PATH}`,
    async close() {
      hub.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function openSocket(url, options = {}) {
  const ws = new WebSocket(url, options);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("open timeout")), 1000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

function waitForJson(ws, predicate = () => true, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => cleanup(() => reject(new Error("json message timeout"))),
      timeoutMs,
    );
    function cleanup(done) {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
      done();
    }
    function onClose() {
      cleanup(() => reject(new Error("socket closed")));
    }
    function onError(error) {
      cleanup(() => reject(error));
    }
    function onMessage(data, isBinary) {
      if (isBinary) return;
      const message = JSON.parse(
        Buffer.isBuffer(data) ? data.toString("utf8") : String(data),
      );
      if (predicate(message)) {
        cleanup(() => resolve(message));
      }
    }
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

function waitForBinary(ws, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => cleanup(() => reject(new Error("binary message timeout"))),
      timeoutMs,
    );
    function cleanup(done) {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
      done();
    }
    function onClose() {
      cleanup(() => reject(new Error("socket closed")));
    }
    function onError(error) {
      cleanup(() => reject(error));
    }
    function onMessage(data, isBinary) {
      if (!isBinary) return;
      cleanup(() => resolve(Buffer.from(data)));
    }
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

function waitForBinaryFrames(ws, count, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const timer = setTimeout(
      () =>
        cleanup(() =>
          reject(
            new Error(`binary frames timeout (${frames.length}/${count})`),
          ),
        ),
      timeoutMs,
    );
    function cleanup(done) {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
      done();
    }
    function onClose() {
      cleanup(() => reject(new Error("socket closed")));
    }
    function onError(error) {
      cleanup(() => reject(error));
    }
    function onMessage(data, isBinary) {
      if (!isBinary) return;
      frames.push(Buffer.from(data));
      if (frames.length >= count) {
        cleanup(() => resolve(frames));
      }
    }
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

function waitForNoMessage(ws, timeoutMs = 100) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => cleanup(resolve), timeoutMs);
    function cleanup(done) {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
      done();
    }
    function onClose() {
      cleanup(resolve);
    }
    function onError(error) {
      cleanup(() => reject(error));
    }
    function onMessage() {
      cleanup(() => reject(new Error("unexpected message")));
    }
    ws.once("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

async function sendAndWaitJson(ws, message, predicate = () => true) {
  const waiting = waitForJson(ws, predicate);
  ws.send(JSON.stringify(message));
  return waiting;
}

async function connectClient(
  ctx,
  userId,
  deviceUuid = `${userId}_device`,
  clientApp = "mobile-frontend",
  socketOptions = {},
) {
  const ws = await openSocket(ctx.url, socketOptions);
  const ready = await sendAndWaitJson(
    ws,
    {
      type: "hello",
      token: `token:${userId}`,
      userId,
      deviceUuid,
      clientApp,
      protocolVersion: 1,
    },
    (message) => message.type === "ready",
  );
  assert.equal(ready.protocolVersion, 1);
  assert.equal(typeof ready.clientId, "string");
  return ws;
}

async function subscribe(ws, channelIds) {
  return sendAndWaitJson(
    ws,
    {
      type: "subscribe",
      channelIds,
    },
    (message) => message.type === "subscribed",
  );
}

function closeSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  ws.terminate();
}

test("radio hub rifiuta hello non valido", async () => {
  const ctx = await createRadioTestServer();
  let ws = null;
  try {
    ws = await openSocket(ctx.url);
    const error = await sendAndWaitJson(
      ws,
      {
        type: "hello",
        token: "bad",
        userId: "u_alice",
        deviceUuid: "dev_1",
        protocolVersion: 1,
      },
      (message) => message.type === "error",
    );
    assert.equal(error.code, "unauthorized");
  } finally {
    closeSocket(ws);
    await ctx.close();
  }
});

test("radio hub sottoscrive solo canali esistenti e abilitati", async () => {
  const ctx = await createRadioTestServer();
  let ws = null;
  try {
    ws = await connectClient(ctx, "u_alice");
    const subscribed = await subscribe(ws, [
      "cucina",
      "spento",
      "inesistente",
      "cucina",
    ]);
    assert.deepEqual(subscribed.channelIds, ["cucina"]);
  } finally {
    closeSocket(ws);
    await ctx.close();
  }
});

test("radio hub rifiuta PTT su canale disabilitato", async () => {
  const ctx = await createRadioTestServer();
  let ws = null;
  try {
    ws = await connectClient(ctx, "u_alice");
    const subscribed = await subscribe(ws, ["spento"]);
    assert.deepEqual(subscribed.channelIds, []);

    const error = await sendAndWaitJson(
      ws,
      {
        type: "ptt:start",
        txId: "tx_disabled",
        channelId: "spento",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      },
      (message) => message.type === "error",
    );

    assert.equal(error.code, "channel_not_found");
    assert.equal(error.channelId, "spento");
  } finally {
    closeSocket(ws);
    await ctx.close();
  }
});

test("radio hub considera in backpressure i socket oltre soglia", () => {
  assert.equal(
    isRadioSocketBackpressured(
      { bufferedAmount: 65_537 },
      { maxBufferedBytes: 65_536 },
    ),
    true,
  );
  assert.equal(
    isRadioSocketBackpressured(
      { bufferedAmount: 65_536 },
      { maxBufferedBytes: 65_536 },
    ),
    false,
  );
});

test("radio hub gestisce grant, busy, canali paralleli e relay binario", async () => {
  const ctx = await createRadioTestServer();
  let alice = null;
  let bruno = null;
  let carla = null;
  try {
    alice = await connectClient(ctx, "u_alice");
    bruno = await connectClient(ctx, "u_bruno");
    carla = await connectClient(ctx, "u_carla");
    await subscribe(alice, ["cucina"]);
    await subscribe(bruno, ["cucina"]);
    await subscribe(carla, ["bar"]);

    const aliceGrantWait = waitForJson(
      alice,
      (message) => message.type === "ptt:grant",
    );
    const brunoIncomingWait = waitForJson(
      bruno,
      (message) => message.type === "ptt:incoming-start",
    );
    alice.send(
      JSON.stringify({
        type: "ptt:start",
        txId: "tx_alice",
        channelId: "cucina",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      }),
    );
    const aliceGrant = await aliceGrantWait;
    const brunoIncoming = await brunoIncomingWait;
    assert.equal(aliceGrant.channelId, "cucina");
    assert.equal(brunoIncoming.channelName, "Cucina");
    assert.equal(brunoIncoming.speaker.displayName, "Alice R.");

    const busy = await sendAndWaitJson(
      bruno,
      {
        type: "ptt:start",
        txId: "tx_bruno",
        channelId: "cucina",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      },
      (message) => message.type === "ptt:busy",
    );
    assert.equal(busy.channelId, "cucina");
    assert.equal(busy.activeSpeaker.displayName, "Alice R.");

    const carlaGrant = await sendAndWaitJson(
      carla,
      {
        type: "ptt:start",
        txId: "tx_carla",
        channelId: "bar",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      },
      (message) => message.type === "ptt:grant",
    );
    assert.equal(carlaGrant.channelId, "bar");

    const frame = buildRadioFrame({
      streamId: aliceGrant.streamId,
      seq: 1,
      timestampMs: 20,
      payload: Buffer.alloc(320, 7),
    });
    const relayWait = waitForBinary(bruno);
    alice.send(frame);
    assert.deepEqual(await relayWait, frame);

    bruno.send(frame);
    await waitForNoMessage(alice, 100);
  } finally {
    closeSocket(alice);
    closeSocket(bruno);
    closeSocket(carla);
    await ctx.close();
  }
});

test("radio hub preserva burst e coda finale dei frame PTT in ordine", async () => {
  const ctx = await createRadioTestServer();
  let alice = null;
  let bruno = null;
  try {
    alice = await connectClient(ctx, "u_alice");
    bruno = await connectClient(ctx, "u_bruno");
    await subscribe(alice, ["cucina"]);
    await subscribe(bruno, ["cucina"]);

    const grantWait = waitForJson(
      alice,
      (message) => message.type === "ptt:grant",
    );
    const incomingWait = waitForJson(
      bruno,
      (message) => message.type === "ptt:incoming-start",
    );
    alice.send(
      JSON.stringify({
        type: "ptt:start",
        txId: "tx_alice_burst",
        channelId: "cucina",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      }),
    );
    const grant = await grantWait;
    await incomingWait;

    const frameCount = 8;
    const framesWait = waitForBinaryFrames(bruno, frameCount);
    const stopWait = waitForJson(
      bruno,
      (message) =>
        message.type === "ptt:incoming-stop" &&
        message.streamId === grant.streamId,
    );
    for (let seq = 0; seq < frameCount; seq += 1) {
      alice.send(
        buildRadioFrame({
          streamId: grant.streamId,
          seq,
          timestampMs: seq * 20,
          payload: Buffer.alloc(320, seq),
        }),
      );
    }
    alice.send(JSON.stringify({ type: "ptt:stop", txId: "tx_alice_burst" }));

    const frames = await framesWait;
    await stopWait;
    assert.deepEqual(
      frames.map((frame) => frame.readUInt32BE(8)),
      Array.from({ length: frameCount }, (_, index) => index),
    );
  } finally {
    closeSocket(alice);
    closeSocket(bruno);
    await ctx.close();
  }
});

test("radio hub non reinvia il PTT a un secondo socket dello stesso device", async () => {
  const ctx = await createRadioTestServer();
  let aliceWebview = null;
  let aliceNative = null;
  let bruno = null;
  try {
    aliceWebview = await connectClient(ctx, "u_alice", "device_alice");
    aliceNative = await connectClient(ctx, "u_alice", "device_alice");
    bruno = await connectClient(ctx, "u_bruno", "device_bruno");
    await subscribe(aliceWebview, ["cucina"]);
    await subscribe(aliceNative, ["cucina"]);
    await subscribe(bruno, ["cucina"]);

    const grantWait = waitForJson(
      aliceWebview,
      (message) => message.type === "ptt:grant",
    );
    const brunoIncomingWait = waitForJson(
      bruno,
      (message) => message.type === "ptt:incoming-start",
    );
    aliceWebview.send(
      JSON.stringify({
        type: "ptt:start",
        txId: "tx_alice_same_device",
        channelId: "cucina",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      }),
    );
    const grant = await grantWait;
    assert.equal((await brunoIncomingWait).streamId, grant.streamId);
    await waitForNoMessage(aliceNative, 150);

    const frame = buildRadioFrame({
      streamId: grant.streamId,
      seq: 1,
      timestampMs: 20,
      payload: Buffer.alloc(320, 9),
    });
    const brunoFrameWait = waitForBinary(bruno);
    aliceWebview.send(frame);
    assert.deepEqual(await brunoFrameWait, frame);
    await waitForNoMessage(aliceNative, 150);
  } finally {
    closeSocket(aliceWebview);
    closeSocket(aliceNative);
    closeSocket(bruno);
    await ctx.close();
  }
});

test("radio hub invia una sola ricezione per device preferendo il receiver background quando presente", async () => {
  const ctx = await createRadioTestServer();
  let alice = null;
  let brunoWebview = null;
  let brunoNative = null;
  try {
    alice = await connectClient(ctx, "u_alice", "device_alice");
    brunoNative = await connectClient(
      ctx,
      "u_bruno",
      "device_bruno",
      "android-background-radio",
    );
    brunoWebview = await connectClient(
      ctx,
      "u_bruno",
      "device_bruno",
      "mobile-frontend",
    );
    await subscribe(alice, ["cucina"]);
    await subscribe(brunoNative, ["cucina"]);
    await subscribe(brunoWebview, ["cucina"]);

    const grantWait = waitForJson(
      alice,
      (message) => message.type === "ptt:grant",
    );
    const nativeIncomingWait = waitForJson(
      brunoNative,
      (message) => message.type === "ptt:incoming-start",
    );
    alice.send(
      JSON.stringify({
        type: "ptt:start",
        txId: "tx_alice_receiver_dedupe",
        channelId: "cucina",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      }),
    );
    const grant = await grantWait;
    assert.equal((await nativeIncomingWait).streamId, grant.streamId);
    await waitForNoMessage(brunoWebview, 150);

    const frame = buildRadioFrame({
      streamId: grant.streamId,
      seq: 1,
      timestampMs: 20,
      payload: Buffer.alloc(320, 11),
    });
    const nativeFrameWait = waitForBinary(brunoNative);
    alice.send(frame);
    assert.deepEqual(await nativeFrameWait, frame);
    await waitForNoMessage(brunoWebview, 150);
  } finally {
    closeSocket(alice);
    closeSocket(brunoWebview);
    closeSocket(brunoNative);
    await ctx.close();
  }
});

test("radio hub evita doppio audio anche con receiver legacy sullo stesso device", async () => {
  const ctx = await createRadioTestServer();
  let alice = null;
  let brunoLegacyNative = null;
  let brunoWebview = null;
  try {
    alice = await connectClient(ctx, "u_alice", "device_alice");
    brunoLegacyNative = await connectClient(
      ctx,
      "u_bruno",
      "device_bruno",
      "mobile-frontend",
      { headers: { "User-Agent": "okhttp/4.12.0" } },
    );
    brunoWebview = await connectClient(
      ctx,
      "u_bruno",
      "device_bruno",
      "mobile-frontend",
    );
    await subscribe(alice, ["cucina"]);
    await subscribe(brunoLegacyNative, ["cucina"]);
    await subscribe(brunoWebview, ["cucina"]);

    const grantWait = waitForJson(
      alice,
      (message) => message.type === "ptt:grant",
    );
    const legacyNativeIncomingWait = waitForJson(
      brunoLegacyNative,
      (message) => message.type === "ptt:incoming-start",
    );
    alice.send(
      JSON.stringify({
        type: "ptt:start",
        txId: "tx_alice_legacy_receiver_dedupe",
        channelId: "cucina",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      }),
    );
    const grant = await grantWait;
    assert.equal((await legacyNativeIncomingWait).streamId, grant.streamId);
    await waitForNoMessage(brunoWebview, 150);

    const frame = buildRadioFrame({
      streamId: grant.streamId,
      seq: 1,
      timestampMs: 20,
      payload: Buffer.alloc(320, 13),
    });
    const legacyNativeFrameWait = waitForBinary(brunoLegacyNative);
    alice.send(frame);
    assert.deepEqual(await legacyNativeFrameWait, frame);
    await waitForNoMessage(brunoWebview, 150);
  } finally {
    closeSocket(alice);
    closeSocket(brunoLegacyNative);
    closeSocket(brunoWebview);
    await ctx.close();
  }
});

test("radio hub echo rimanda i frame solo al mittente", async () => {
  const ctx = await createRadioTestServer();
  let alice = null;
  let bruno = null;
  try {
    alice = await connectClient(ctx, "u_alice");
    bruno = await connectClient(ctx, "u_bruno");
    const grant = await sendAndWaitJson(
      alice,
      {
        type: "echo:start",
        txId: "echo_alice",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      },
      (message) => message.type === "echo:grant",
    );

    const frame = buildRadioFrame({
      streamId: grant.streamId,
      seq: 1,
      timestampMs: 20,
      payload: Buffer.alloc(320, 3),
    });
    const echoWait = waitForBinary(alice);
    alice.send(frame);
    assert.deepEqual(await echoWait, frame);
    await waitForNoMessage(bruno, 100);
  } finally {
    closeSocket(alice);
    closeSocket(bruno);
    await ctx.close();
  }
});

test("radio hub echo attende un flush breve prima dello stop", async () => {
  const ctx = await createRadioTestServer({ echoStopFlushMs: 140 });
  let alice = null;
  try {
    alice = await connectClient(ctx, "u_alice");
    const grant = await sendAndWaitJson(
      alice,
      {
        type: "echo:start",
        txId: "echo_flush",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      },
      (message) => message.type === "echo:grant",
    );

    const lateFrame = buildRadioFrame({
      streamId: grant.streamId,
      seq: 2,
      timestampMs: 40,
      payload: Buffer.alloc(320, 5),
    });
    const stopWait = waitForJson(
      alice,
      (message) => message.type === "echo:stop",
      1000,
    );
    alice.send(
      JSON.stringify({
        type: "echo:stop",
        txId: "echo_flush",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    const lateEchoWait = waitForBinary(alice);
    alice.send(lateFrame);
    assert.deepEqual(await lateEchoWait, lateFrame);
    const stop = await stopWait;
    assert.equal(stop.reason, "speaker_stop");
  } finally {
    closeSocket(alice);
    await ctx.close();
  }
});

test("radio hub echo usa un timeout inattivo separato dal lock canale", async () => {
  const ctx = await createRadioTestServer({
    idleTimeoutMs: 80,
    echoIdleTimeoutMs: 600,
  });
  let alice = null;
  try {
    alice = await connectClient(ctx, "u_alice");
    await sendAndWaitJson(
      alice,
      {
        type: "echo:start",
        txId: "echo_alice",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      },
      (message) => message.type === "echo:grant",
    );

    await waitForNoMessage(alice, 350);
    const stop = await waitForJson(
      alice,
      (message) => message.type === "echo:stop",
      1500,
    );
    assert.equal(stop.reason, "idle_timeout");
  } finally {
    closeSocket(alice);
    await ctx.close();
  }
});

test("radio hub close socket libera il lock canale", async () => {
  const ctx = await createRadioTestServer();
  let alice = null;
  let bruno = null;
  try {
    alice = await connectClient(ctx, "u_alice");
    bruno = await connectClient(ctx, "u_bruno");
    await subscribe(alice, ["cucina"]);
    await subscribe(bruno, ["cucina"]);

    const grantWait = waitForJson(
      alice,
      (message) => message.type === "ptt:grant",
    );
    const incomingWait = waitForJson(
      bruno,
      (message) => message.type === "ptt:incoming-start",
    );
    alice.send(
      JSON.stringify({
        type: "ptt:start",
        txId: "tx_alice",
        channelId: "cucina",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      }),
    );
    await grantWait;
    await incomingWait;

    const stopWait = waitForJson(
      bruno,
      (message) => message.type === "ptt:incoming-stop",
    );
    alice.close();
    const stop = await stopWait;
    assert.equal(stop.reason, "socket_closed");

    const brunoGrant = await sendAndWaitJson(
      bruno,
      {
        type: "ptt:start",
        txId: "tx_bruno",
        channelId: "cucina",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      },
      (message) => message.type === "ptt:grant",
    );
    assert.equal(brunoGrant.channelId, "cucina");
  } finally {
    closeSocket(alice);
    closeSocket(bruno);
    await ctx.close();
  }
});

test("radio hub idle timeout libera il lock canale", async () => {
  const ctx = await createRadioTestServer({ idleTimeoutMs: 80 });
  let alice = null;
  let bruno = null;
  try {
    alice = await connectClient(ctx, "u_alice");
    bruno = await connectClient(ctx, "u_bruno");
    await subscribe(alice, ["cucina"]);
    await subscribe(bruno, ["cucina"]);

    const grantWait = waitForJson(
      alice,
      (message) => message.type === "ptt:grant",
    );
    const stopWait = waitForJson(
      bruno,
      (message) => message.type === "ptt:incoming-stop",
      1000,
    );
    alice.send(
      JSON.stringify({
        type: "ptt:start",
        txId: "tx_alice",
        channelId: "cucina",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      }),
    );
    await grantWait;
    const stop = await stopWait;
    assert.equal(stop.reason, "idle_timeout");

    const brunoGrant = await sendAndWaitJson(
      bruno,
      {
        type: "ptt:start",
        txId: "tx_bruno",
        channelId: "cucina",
        codec: "mulaw",
        sampleRate: 16000,
        frameMs: 20,
      },
      (message) => message.type === "ptt:grant",
    );
    assert.equal(brunoGrant.channelId, "cucina");
  } finally {
    closeSocket(alice);
    closeSocket(bruno);
    await ctx.close();
  }
});
