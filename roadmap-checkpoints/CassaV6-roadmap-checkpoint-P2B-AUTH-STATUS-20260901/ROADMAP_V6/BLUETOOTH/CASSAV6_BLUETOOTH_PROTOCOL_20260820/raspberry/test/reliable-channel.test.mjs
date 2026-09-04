import assert from "node:assert/strict";
import test from "node:test";

import {
  RELIABLE_FRAME_TYPES
} from "../dist/protocol/FrameCodec.js";
import {
  InMemoryReliableChannelStoreV1,
  ReliableChannelError,
  ReliableChannelV1
} from "../dist/protocol/ReliableChannel.js";

const KEY_A_TO_B = Buffer.alloc(32, 0x41);
const KEY_B_TO_A = Buffer.alloc(32, 0x42);
const PREFIX_A_TO_B = Buffer.from("0102030405060708", "hex");
const PREFIX_B_TO_A = Buffer.from("1112131415161718", "hex");
const START = 1_800_000_000_000;
const PEER_TRUST_A = "a".repeat(64);
const PEER_TRUST_B = "b".repeat(64);
const PEER_TRUST_C = "c".repeat(64);

function createPair(options = {}) {
  let now = START;
  const aToB = [];
  const bToA = [];
  const deliveredA = [];
  const deliveredB = [];
  const storeA = options.storeA ?? new InMemoryReliableChannelStoreV1();
  const storeB = options.storeB ?? new InMemoryReliableChannelStoreV1();
  const a = new ReliableChannelV1({
    transport: {
      async send(frame) {
        options.onSendA?.(frame, storeA);
        aToB.push(Buffer.from(frame));
      }
    },
    store: storeA,
    peerTrustId: options.peerTrustIdA ?? PEER_TRUST_B,
    mtu: options.mtu ?? 23,
    txKey: KEY_A_TO_B,
    rxKey: KEY_B_TO_A,
    txNoncePrefix: PREFIX_A_TO_B,
    rxNoncePrefix: PREFIX_B_TO_A,
    onMessage: async (message) => {
      deliveredA.push({
        type: message.type,
        payload: Buffer.from(message.payload)
      });
    },
    maxAttempts: options.maxAttempts ?? 3,
    baseRetryMs: options.baseRetryMs ?? 100,
    maxRetryMs: options.maxRetryMs ?? 1_000,
    random: () => 0,
    now: () => now
  });
  const b = new ReliableChannelV1({
    transport: {
      async send(frame) {
        if (options.rejectSendB) throw new Error("ACK transport rejected");
        bToA.push(Buffer.from(frame));
      }
    },
    store: storeB,
    peerTrustId: options.peerTrustIdB ?? PEER_TRUST_A,
    mtu: options.mtu ?? 23,
    txKey: KEY_B_TO_A,
    rxKey: KEY_A_TO_B,
    txNoncePrefix: PREFIX_B_TO_A,
    rxNoncePrefix: PREFIX_A_TO_B,
    onMessage: async (message) => {
      if (options.rejectAtB) throw new Error("rejected by test handler");
      options.onMessageB?.(message);
      deliveredB.push({
        type: message.type,
        payload: Buffer.from(message.payload)
      });
    },
    maxAttempts: options.maxAttempts ?? 3,
    baseRetryMs: options.baseRetryMs ?? 100,
    maxRetryMs: options.maxRetryMs ?? 1_000,
    random: () => 0,
    now: () => now
  });
  return {
    a,
    b,
    aToB,
    bToA,
    deliveredA,
    deliveredB,
    storeA,
    storeB,
    setNow(value) {
      now = value;
    }
  };
}

async function deliver(queue, target) {
  const frames = queue.splice(0);
  let result = null;
  for (const frame of frames) result = await target.receiveFragment(frame);
  return { frames, result };
}

test("durable message commits before transport and clears only after ACK", async () => {
  let observedCommitted = false;
  const pair = createPair({
    onSendA(_frame, store) {
      observedCommitted ||= store.snapshot().outboxDepth === 1;
    }
  });
  const sent = await pair.a.send({
    type: RELIABLE_FRAME_TYPES.SHADOW_DIAGNOSTIC,
    payload: Buffer.from("health"),
    durable: true,
    messageId: "00112233445566778899aabbccddeeff"
  });
  assert.equal(sent.durableCommitted, true);
  assert.equal(observedCommitted, true);
  assert.equal(pair.storeA.snapshot().outboxDepth, 1);

  await deliver(pair.aToB, pair.b);
  assert.deepEqual(pair.deliveredB, [
    {
      type: RELIABLE_FRAME_TYPES.SHADOW_DIAGNOSTIC,
      payload: Buffer.from("health")
    }
  ]);
  assert.equal(pair.storeB.snapshot().inboxDedupDepth, 1);
  await deliver(pair.bToA, pair.a);
  assert.equal(pair.storeA.snapshot().outboxDepth, 0);
  assert.equal(pair.a.snapshot().pendingMessages, 0);
  assert.equal(pair.a.snapshot().acknowledgementsRx, 1);
  pair.a.close();
  pair.b.close();
});

test("duplicate delivery is suppressed but acknowledged again", async () => {
  const pair = createPair();
  await pair.a.send({
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("once"),
    messageId: "10112233445566778899aabbccddeeff"
  });
  const original = pair.aToB.map(Buffer.from);
  await deliver(pair.aToB, pair.b);
  const firstAckFrames = pair.bToA.length;
  for (const frame of original) pair.aToB.push(Buffer.from(frame));
  const replay = await deliver(pair.aToB, pair.b);
  assert.equal(replay.result.duplicate, true);
  assert.equal(pair.deliveredB.length, 1);
  assert.ok(pair.bToA.length > firstAckFrames);
  assert.equal(pair.b.snapshot().duplicates, 1);
  pair.a.close();
  pair.b.close();
});

test("retry backoff is deterministic and suspends after the configured limit", async () => {
  const pair = createPair({ maxAttempts: 2, baseRetryMs: 100 });
  await pair.a.send({
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("retry"),
    durable: true,
    messageId: "20112233445566778899aabbccddeeff"
  });
  const firstTransmissionFrames = pair.aToB.length;
  pair.setNow(START + 99);
  assert.deepEqual(await pair.a.tick(), {
    retried: 0,
    suspended: 0,
    expired: 0
  });
  pair.setNow(START + 100);
  assert.equal((await pair.a.tick()).retried, 1);
  assert.equal(pair.aToB.length, firstTransmissionFrames * 2);
  pair.setNow(START + 300);
  assert.equal((await pair.a.tick()).suspended, 1);
  assert.equal(pair.a.snapshot().suspendedMessages, 1);
  assert.equal(pair.storeA.snapshot().outboxDepth, 1);
  assert.equal(await pair.a.resumeSuspended(), 1);
  pair.a.close();
  pair.b.close();
});

test("durable outbox is restored into a fresh session without data loss", async () => {
  const store = new InMemoryReliableChannelStoreV1();
  const first = createPair({ storeA: store });
  await first.a.send({
    type: RELIABLE_FRAME_TYPES.ROUTE_ADVERTISEMENT,
    payload: Buffer.from("route"),
    durable: true,
    messageId: "30112233445566778899aabbccddeeff"
  });
  assert.equal(store.snapshot().outboxDepth, 1);
  first.a.close();
  first.b.close();

  const second = createPair({ storeA: store });
  assert.equal(await second.a.restoreDurableOutbox(), 1);
  await deliver(second.aToB, second.b);
  await deliver(second.bToA, second.a);
  assert.equal(store.snapshot().outboxDepth, 0);
  assert.deepEqual(second.deliveredB[0], {
    type: RELIABLE_FRAME_TYPES.ROUTE_ADVERTISEMENT,
    payload: Buffer.from("route")
  });
  second.a.close();
  second.b.close();
});

test("durable outbox and dedup never cross peer trust contexts", async () => {
  const store = new InMemoryReliableChannelStoreV1();
  const first = createPair({ storeA: store, peerTrustIdA: PEER_TRUST_B });
  await first.a.send({
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("peer-b"),
    durable: true,
    messageId: "31112233445566778899aabbccddeeff"
  });
  first.a.close();
  first.b.close();

  const wrongPeer = createPair({ storeA: store, peerTrustIdA: PEER_TRUST_C });
  assert.equal(await wrongPeer.a.restoreDurableOutbox(), 0);
  await wrongPeer.a.send({
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("peer-c"),
    durable: true,
    messageId: "31112233445566778899aabbccddeeff"
  });
  assert.equal(store.snapshot().outboxDepth, 2);
  wrongPeer.a.close();
  wrongPeer.b.close();

  const restored = createPair({ storeA: store, peerTrustIdA: PEER_TRUST_B });
  assert.equal(await restored.a.restoreDurableOutbox(), 1);
  restored.a.close();
  restored.b.close();
});

test("upper-layer failure is not acknowledged and remains retryable", async () => {
  const failing = createPair({ rejectAtB: true });
  await failing.a.send({
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("retry upper layer"),
    messageId: "40112233445566778899aabbccddeeff"
  });
  await assert.rejects(
    () => deliver(failing.aToB, failing.b),
    (error) =>
      error instanceof ReliableChannelError && error.code === "DELIVERY_FAILED"
  );
  assert.equal(failing.bToA.length, 0);
  assert.equal(failing.storeB.snapshot().inboxDedupDepth, 0);
  failing.a.close();
  failing.b.close();
});

test("expired durable messages are removed and never retried", async () => {
  const pair = createPair();
  await pair.a.send({
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("short lived"),
    durable: true,
    ttlMs: 1_000,
    messageId: "50112233445566778899aabbccddeeff"
  });
  pair.setNow(START + 1_000);
  assert.equal((await pair.a.tick()).expired, 1);
  assert.equal(pair.storeA.snapshot().outboxDepth, 0);
  assert.equal(pair.a.snapshot().pendingMessages, 0);
  pair.a.close();
  pair.b.close();
});

test("duplicate pending message ids fail closed without replacing key material", async () => {
  const pair = createPair();
  const messageId = "60112233445566778899aabbccddeeff";
  await pair.a.send({
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("first"),
    messageId
  });
  const framesBefore = pair.aToB.map(Buffer.from);

  await assert.rejects(
    () =>
      pair.a.send({
        type: RELIABLE_FRAME_TYPES.DATA,
        payload: Buffer.from("replacement"),
        messageId
      }),
    (error) =>
      error instanceof ReliableChannelError && error.code === "OUTBOX_CONFLICT"
  );
  assert.deepEqual(pair.aToB, framesBefore);
  assert.equal(pair.a.snapshot().pendingMessages, 1);
  pair.a.close();
  pair.b.close();
});

test("clock regression and user-created ACK fail closed", async () => {
  const pair = createPair();
  pair.setNow(START + 100);
  await pair.a.tick();
  pair.setNow(START + 99);
  await assert.rejects(
    () => pair.a.tick(),
    (error) =>
      error instanceof ReliableChannelError && error.code === "CLOCK_REGRESSION"
  );
  pair.setNow(START + 101);
  await assert.rejects(
    () =>
      pair.a.send({
        type: RELIABLE_FRAME_TYPES.ACK,
        payload: Buffer.alloc(16)
      }),
    (error) =>
      error instanceof ReliableChannelError && error.code === "ACK_RESERVED"
  );
  pair.a.close();
  pair.b.close();
});

test("close waits for the serialized operation before wiping channel state", async () => {
  let releaseTransport;
  let reportTransportStarted;
  const transportStarted = new Promise((resolve) => {
    reportTransportStarted = resolve;
  });
  const transportReleased = new Promise((resolve) => {
    releaseTransport = resolve;
  });
  const channel = new ReliableChannelV1({
    peerTrustId: PEER_TRUST_B,
    transport: {
      async send() {
        reportTransportStarted();
        await transportReleased;
      }
    },
    mtu: 23,
    txKey: KEY_A_TO_B,
    rxKey: KEY_B_TO_A,
    txNoncePrefix: PREFIX_A_TO_B,
    rxNoncePrefix: PREFIX_B_TO_A,
    onMessage() {},
    now: () => START,
    random: () => 0
  });
  const send = channel.send({
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("in flight"),
    messageId: "70112233445566778899aabbccddeeff"
  });
  await transportStarted;
  let closeCompleted = false;
  const close = channel.close().then(() => {
    closeCompleted = true;
  });
  await Promise.resolve();
  assert.equal(closeCompleted, false);
  releaseTransport();
  await send;
  await close;
  assert.equal(channel.snapshot().pendingMessages, 0);
  await assert.rejects(
    () =>
      channel.send({
        type: RELIABLE_FRAME_TYPES.DATA,
        payload: Buffer.alloc(0)
      }),
    (error) =>
      error instanceof ReliableChannelError && error.code === "CHANNEL_CLOSED"
  );
});

test("decoded payload is wiped when ACK transport fails", async () => {
  let deliveredPayload;
  const pair = createPair({
    rejectSendB: true,
    onMessageB(message) {
      deliveredPayload = message.payload;
    }
  });
  await pair.a.send({
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("wipe after ACK failure"),
    messageId: "80112233445566778899aabbccddeeff"
  });
  await assert.rejects(() => deliver(pair.aToB, pair.b), /ACK transport rejected/);
  assert.ok(deliveredPayload.every((value) => value === 0));
  await pair.a.close();
  await pair.b.close();
});
