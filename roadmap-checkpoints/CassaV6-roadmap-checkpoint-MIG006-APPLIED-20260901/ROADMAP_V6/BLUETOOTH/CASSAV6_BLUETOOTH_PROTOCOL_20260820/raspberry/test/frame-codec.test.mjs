import assert from "node:assert/strict";
import test from "node:test";

import {
  RELIABLE_FRAME_FLAGS,
  RELIABLE_FRAME_HEADER_BYTES,
  RELIABLE_FRAME_MAX_PAYLOAD_BYTES,
  RELIABLE_FRAME_TYPES,
  ReliableFrameError,
  ReliableFrameReassemblerV1,
  decodeReliableFragmentV1,
  decodeReliableMessageV1,
  deriveReliableChannelDirectionMaterialV1,
  encodeReliableMessageV1
} from "../dist/protocol/FrameCodec.js";

const KEY = Buffer.alloc(32, 0x45);
const NONCE_PREFIX = Buffer.from("0102030405060708", "hex");
const MESSAGE_ID = "00112233445566778899aabbccddeeff";
const NOW = 1_800_000_000_000;

function encode(overrides = {}) {
  return encodeReliableMessageV1({
    type: RELIABLE_FRAME_TYPES.DATA,
    flags: RELIABLE_FRAME_FLAGS.DURABLE,
    sequence: 7,
    messageId: MESSAGE_ID,
    expiresAtEpochMs: NOW + 60_000,
    payload: Buffer.from("v6 reliable payload", "utf8"),
    mtu: 247,
    key: KEY,
    noncePrefix: NONCE_PREFIX,
    ...overrides
  });
}

test("AES-256-GCM frame v1 round-trips across ATT MTU fallback sizes", () => {
  const payload = Buffer.alloc(1_337);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = index & 0xff;
  }
  for (const mtu of [23, 64, 247, 517]) {
    const frames = encode({ mtu, payload });
    assert.ok(frames.length >= 1);
    assert.ok(frames.every((frame) => frame.length <= mtu - 3));
    const decoded = decodeReliableMessageV1({
      fragments: [...frames].reverse(),
      key: KEY,
      noncePrefix: NONCE_PREFIX,
      nowEpochMs: NOW
    });
    assert.equal(decoded.type, RELIABLE_FRAME_TYPES.DATA);
    assert.equal(decoded.flags, RELIABLE_FRAME_FLAGS.DURABLE);
    assert.equal(decoded.sequence, 7);
    assert.equal(decoded.messageId, MESSAGE_ID);
    assert.equal(decoded.expiresAtEpochMs, NOW + 60_000);
    assert.deepEqual(decoded.payload, payload);
  }
});

test("authenticated header, ciphertext and nonce binding fail closed", () => {
  const frames = encode();
  const cases = [
    () => {
      const changed = frames.map(Buffer.from);
      changed[0][3] = RELIABLE_FRAME_TYPES.ROUTE_ADVERTISEMENT;
      return changed;
    },
    () => {
      const changed = frames.map(Buffer.from);
      changed.at(-1)[changed.at(-1).length - 1] ^= 0x80;
      return changed;
    }
  ];
  for (const mutate of cases) {
    assert.throws(
      () =>
        decodeReliableMessageV1({
          fragments: mutate(),
          key: KEY,
          noncePrefix: NONCE_PREFIX,
          nowEpochMs: NOW
        }),
      (error) =>
        error instanceof ReliableFrameError &&
        error.code === "AUTHENTICATION_FAILED"
    );
  }
  assert.throws(
    () =>
      decodeReliableMessageV1({
        fragments: frames,
        key: Buffer.alloc(32, 0x46),
        noncePrefix: NONCE_PREFIX,
        nowEpochMs: NOW
      }),
    (error) =>
      error instanceof ReliableFrameError &&
      error.code === "AUTHENTICATION_FAILED"
  );
});

test("TTL and canonical message identifiers are enforced", () => {
  const frames = encode({ expiresAtEpochMs: NOW + 1 });
  assert.throws(
    () =>
      decodeReliableMessageV1({
        fragments: frames,
        key: KEY,
        noncePrefix: NONCE_PREFIX,
        nowEpochMs: NOW + 1
      }),
    (error) =>
      error instanceof ReliableFrameError && error.code === "MESSAGE_EXPIRED"
  );
  assert.throws(
    () => encode({ messageId: MESSAGE_ID.toUpperCase() }),
    (error) =>
      error instanceof ReliableFrameError &&
      error.code === "INVALID_MESSAGE_ID"
  );
});

test("payload limit and reserved header fields are rejected", () => {
  assert.throws(
    () => encode({ payload: Buffer.alloc(RELIABLE_FRAME_MAX_PAYLOAD_BYTES + 1) }),
    (error) =>
      error instanceof ReliableFrameError && error.code === "PAYLOAD_TOO_LARGE"
  );
  const [frame] = encode({ payload: Buffer.alloc(0), mtu: 517 });
  const reserved = Buffer.from(frame);
  reserved[5] = 1;
  assert.throws(
    () => decodeReliableFragmentV1(reserved),
    (error) =>
      error instanceof ReliableFrameError &&
      error.code === "INVALID_FRAME_RESERVED"
  );
  assert.ok(frame.length > RELIABLE_FRAME_HEADER_BYTES);
});

test("reassembler accepts identical retries and rejects conflicting fragments", () => {
  const frames = encode({ mtu: 23, payload: Buffer.alloc(64, 0x61) });
  const reassembler = new ReliableFrameReassemblerV1();
  assert.equal(reassembler.accept(frames[0], NOW), null);
  assert.equal(reassembler.accept(frames[0], NOW + 1), null);
  const conflict = Buffer.from(frames[0]);
  conflict[conflict.length - 1] ^= 1;
  assert.throws(
    () => reassembler.accept(conflict, NOW + 2),
    (error) =>
      error instanceof ReliableFrameError && error.code === "FRAGMENT_CONFLICT"
  );
  assert.deepEqual(reassembler.snapshot(), {
    openMessages: 0,
    bufferedBytes: 0
  });
});

test("reassembler completes out of order and prunes abandoned state", () => {
  const frames = encode({ mtu: 23, payload: Buffer.alloc(64, 0x62) });
  const reassembler = new ReliableFrameReassemblerV1();
  let completed = null;
  for (const frame of [...frames].reverse()) {
    completed = reassembler.accept(frame, NOW) ?? completed;
  }
  assert.ok(completed);
  assert.deepEqual(
    decodeReliableMessageV1({
      fragments: completed,
      key: KEY,
      noncePrefix: NONCE_PREFIX,
      nowEpochMs: NOW
    }).payload,
    Buffer.alloc(64, 0x62)
  );
  assert.deepEqual(reassembler.snapshot(), {
    openMessages: 0,
    bufferedBytes: 0
  });

  reassembler.accept(frames[0], NOW);
  assert.equal(reassembler.prune(NOW + 30_000), 1);
  assert.deepEqual(reassembler.snapshot(), {
    openMessages: 0,
    bufferedBytes: 0
  });
});

test("sequence-bound nonces produce different authenticated wire", () => {
  const first = encode({ sequence: 1 });
  const second = encode({ sequence: 2 });
  assert.notDeepEqual(Buffer.concat(first), Buffer.concat(second));
  assert.equal(decodeReliableFragmentV1(first[0]).sequence, 1);
  assert.equal(decodeReliableFragmentV1(second[0]).sequence, 2);
});

test("data key and nonce prefix are domain-separated from the control key", () => {
  const material = deriveReliableChannelDirectionMaterialV1(
    Buffer.from([...Array(32).keys()])
  );
  assert.equal(
    material.key.toString("hex"),
    "b4e326395fd563d2f68097a6434498eeb7dc81c98adafcac51771ddce9c2a511"
  );
  assert.equal(material.noncePrefix.toString("hex"), "1b296bcdee534f82");
  assert.notEqual(material.key.subarray(0, 8).toString("hex"), material.noncePrefix.toString("hex"));
  material.key.fill(0);
  material.noncePrefix.fill(0);
});
