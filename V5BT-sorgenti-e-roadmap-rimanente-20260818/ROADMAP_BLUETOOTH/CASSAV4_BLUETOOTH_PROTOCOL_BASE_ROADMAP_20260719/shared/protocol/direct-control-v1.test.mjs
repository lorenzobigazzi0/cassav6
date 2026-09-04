import assert from "node:assert/strict";
import {
  createHmac,
  createPrivateKey,
  createPublicKey
} from "node:crypto";
import test from "node:test";

import {
  DIRECT_CONTROL_V1_AUTH_BYTES,
  DIRECT_CONTROL_V1_CLIENT_KEY_CONFIRM_WIRE_BYTES,
  DIRECT_CONTROL_V1_CLIENT_KEY_SHARE_WIRE_BYTES,
  DIRECT_CONTROL_V1_CLOSE_REASONS,
  DIRECT_CONTROL_V1_CLOSE_WIRE_BYTES,
  DIRECT_CONTROL_V1_CONTEXTS,
  DIRECT_CONTROL_V1_HEARTBEAT_WIRE_BYTES,
  DIRECT_CONTROL_V1_MESSAGE_TYPES,
  DIRECT_CONTROL_V1_MINIMUM_MTU,
  DIRECT_CONTROL_V1_PROTOCOL_VERSION,
  DIRECT_CONTROL_V1_SERVER_KEY_SHARE_WIRE_BYTES,
  DIRECT_CONTROL_V1_X25519_SPKI_BYTES,
  DIRECT_CONTROL_V1_X25519_SPKI_PREFIX_HEX,
  DirectControlV1Error,
  buildClientKeyConfirmationMessageV1,
  buildClientKeyShareBinderMessageV1,
  buildServerKeyConfirmationMessageV1,
  buildSessionKeyBinderMessageV1,
  buildSessionTranscriptHashV1,
  clearDirectControlKeysV1,
  createClientKeyConfirmationV1,
  createServerKeyConfirmationV1,
  decodeClientKeyConfirmV1,
  decodeClientKeyShareV1,
  decodeCloseV1,
  decodeHeartbeatV1,
  decodeServerKeyShareV1,
  deriveDirectControlKeysV1,
  deriveX25519SharedSecretV1,
  encodeClientKeyConfirmV1,
  encodeClientKeyShareV1,
  encodeCloseV1,
  encodeHeartbeatV1,
  encodeServerKeyShareV1,
  generateX25519KeyPairV1,
  normalizeX25519PublicKeySpkiV1,
  verifyClientKeyConfirmationV1,
  verifyServerKeyConfirmationV1
} from "./direct-control-v1.mjs";

const SESSION_ID = "AbCdEfGhIjKlMnOpQrStUg";
const BINDING = Object.freeze({
  clientHello: Object.freeze({
    protocolVersion: 1,
    sessionId: SESSION_ID,
    nodeId: "550e8400-e29b-41d4-a716-446655440000",
    bootId: 17,
    capabilities: 47,
    nonce: "AAECAwQFBgcICQoLDA0ODw"
  }),
  serverHello: Object.freeze({
    protocolVersion: 1,
    sessionId: SESSION_ID,
    nodeId: "123e4567-e89b-12d3-a456-426614174000",
    bootId: 54,
    capabilities: 72,
    nonce: "ICEiIyQlJicoKSorLC0uLw"
  }),
  deviceCertificateId: "f47ac10b-58cc-4372-a567-0e02b2c3d479"
});

const ALIAS_KEY = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex"
);
const X25519_SPKI_PREFIX = Buffer.from(
  DIRECT_CONTROL_V1_X25519_SPKI_PREFIX_HEX,
  "hex"
);
const X25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b656e04220420",
  "hex"
);
const CLIENT_PRIVATE_RAW = Buffer.from(
  "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  "hex"
);
const CLIENT_PUBLIC_SPKI = Buffer.concat([
  X25519_SPKI_PREFIX,
  Buffer.from(
    "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
    "hex"
  )
]);
const SERVER_PRIVATE_RAW = Buffer.from(
  "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
  "hex"
);
const SERVER_PUBLIC_SPKI = Buffer.concat([
  X25519_SPKI_PREFIX,
  Buffer.from(
    "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
    "hex"
  )
]);

const EXPECTED = Object.freeze({
  sharedSecret:
    "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
  clientBinder:
    "be6ff7e1b669121257329196624b8315af19f0e0b19d2bb201845df0df6aa7bb",
  sessionKeyBinder:
    "3287bae7849756b4d3a179c53a4ee4377fa274535ae6e6e1669adae6812b4d81",
  transcriptHash:
    "f0968786197c17c7126695d99ff6926a3d76b5de0cde34af1397b788d1d8d9d8",
  clientToServerControlKey:
    "1ba6da9e9555d0620fcdb03f62255edd1879f0c51b0f1ce61979338400a4fa15",
  serverToClientControlKey:
    "1e25ad352acfd9f32a1d550a3cf1a77e14644481be6f202921197a17c71c0d1d",
  clientConfirmationKey:
    "48b5e3c4b86192f291974bd2a3e6f6d748376173ed59368d73697c4918164e85",
  serverConfirmationKey:
    "cb3b27e555f2cca349623d72798474abe3e21cf58d637acca48da6a1c1b725c9",
  serverConfirmation:
    "4a5352ddd3e26d98bddf1b375634efa8cb5875af23b136a2037c7257fa6eff3d",
  clientConfirmation:
    "36aac36296254c66c3feb3388e5fb1cf41b97ba18f99da730ac5a4748be2efe6",
  clientShareWire:
    "010401b09d11f1a12232a53273a942b4ad52302a300506032b656e0321008520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6abe6ff7e1b669121257329196624b8315af19f0e0b19d2bb201845df0df6aa7bb",
  serverShareWire:
    "010501b09d11f1a12232a53273a942b4ad52302a300506032b656e032100de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f4a5352ddd3e26d98bddf1b375634efa8cb5875af23b136a2037c7257fa6eff3d",
  clientConfirmWire:
    "010601b09d11f1a12232a53273a942b4ad5236aac36296254c66c3feb3388e5fb1cf41b97ba18f99da730ac5a4748be2efe6",
  pingWire:
    "010701b09d11f1a12232a53273a942b4ad520000000064ea5b55ddaa6a6b19b1118a4a78457bbdf06ea169c306641ac5af0e94040f69",
  pongWire:
    "010801b09d11f1a12232a53273a942b4ad52000000002218d14a100af08ad4cf7c98d179eebed07b0bd9a2d9ceded835755828097686",
  closeWire:
    "010901b09d11f1a12232a53273a942b4ad520000000101b1ffa6d42002104a0cd1d26365ce392acb6cba646db0338387b5406b15d6cb44",
  closeAckWire:
    "010a01b09d11f1a12232a53273a942b4ad52000000010198616a6c3d6761c64134ebac8ece2c8e205fbc889a1d2f1a3ab2a94ba0f73d76"
});

function privateKey(raw) {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8"
  });
}

function mac(key, message) {
  return createHmac("sha256", key).update(message).digest();
}

function vector() {
  const clientBinderMessage = buildClientKeyShareBinderMessageV1(
    BINDING,
    CLIENT_PUBLIC_SPKI
  );
  const clientBinder = mac(ALIAS_KEY, clientBinderMessage);
  clientBinderMessage.fill(0);
  const sessionKeyBinderMessage = buildSessionKeyBinderMessageV1(
    BINDING,
    CLIENT_PUBLIC_SPKI,
    clientBinder,
    SERVER_PUBLIC_SPKI
  );
  const sessionKeyBinder = mac(ALIAS_KEY, sessionKeyBinderMessage);
  sessionKeyBinderMessage.fill(0);
  const transcriptHash = buildSessionTranscriptHashV1(
    BINDING,
    CLIENT_PUBLIC_SPKI,
    clientBinder,
    SERVER_PUBLIC_SPKI
  );
  const sharedSecret = deriveX25519SharedSecretV1(
    privateKey(CLIENT_PRIVATE_RAW),
    SERVER_PUBLIC_SPKI
  );
  const keys = deriveDirectControlKeysV1({
    sharedSecret,
    sessionKeyBinder,
    transcriptHash
  });
  const serverConfirmation = createServerKeyConfirmationV1({
    serverConfirmationKey: keys.serverConfirmationKey,
    transcriptHash
  });
  const clientConfirmation = createClientKeyConfirmationV1({
    clientConfirmationKey: keys.clientConfirmationKey,
    transcriptHash,
    serverConfirmation
  });
  return {
    clientBinder,
    sessionKeyBinder,
    transcriptHash,
    sharedSecret,
    keys,
    serverConfirmation,
    clientConfirmation
  };
}

function assertCode(code) {
  return (error) =>
    error instanceof DirectControlV1Error && error.code === code;
}

test("B5.7 constants, message numbers, labels and MTU are frozen", () => {
  assert.equal(DIRECT_CONTROL_V1_PROTOCOL_VERSION, 1);
  assert.equal(DIRECT_CONTROL_V1_X25519_SPKI_BYTES, 44);
  assert.equal(DIRECT_CONTROL_V1_AUTH_BYTES, 32);
  assert.equal(DIRECT_CONTROL_V1_MINIMUM_MTU, 101);
  assert.equal(DIRECT_CONTROL_V1_CLIENT_KEY_SHARE_WIRE_BYTES, 94);
  assert.equal(DIRECT_CONTROL_V1_SERVER_KEY_SHARE_WIRE_BYTES, 94);
  assert.equal(DIRECT_CONTROL_V1_CLIENT_KEY_CONFIRM_WIRE_BYTES, 50);
  assert.equal(DIRECT_CONTROL_V1_HEARTBEAT_WIRE_BYTES, 54);
  assert.equal(DIRECT_CONTROL_V1_CLOSE_WIRE_BYTES, 55);
  assert.deepEqual(DIRECT_CONTROL_V1_MESSAGE_TYPES, {
    CLIENT_KEY_SHARE: 4,
    SERVER_KEY_SHARE: 5,
    CLIENT_KEY_CONFIRM: 6,
    PING: 7,
    PONG: 8,
    CLOSE: 9,
    CLOSE_ACK: 10
  });
  assert.deepEqual(DIRECT_CONTROL_V1_CLOSE_REASONS, {
    NORMAL: 1,
    HEARTBEAT_TIMEOUT: 2,
    SERVICE_STOP: 3,
    PROTOCOL_ERROR: 4
  });
  assert.deepEqual(DIRECT_CONTROL_V1_CONTEXTS, {
    CLIENT_KEY_SHARE: "CASSAV5BT-BT-KEY-CLIENT-SHARE-V1\0",
    SESSION_KEY_BINDER: "CASSAV5BT-BT-KEY-SALT-V1\0",
    SESSION_TRANSCRIPT: "CASSAV5BT-BT-KEY-TRANSCRIPT-V1\0",
    HKDF_INFO: "CASSAV5BT-BT-KEYS-V1\0",
    SERVER_CONFIRMATION: "CASSAV5BT-BT-KEY-SERVER-CONFIRM-V1\0",
    CLIENT_CONFIRMATION: "CASSAV5BT-BT-KEY-CLIENT-CONFIRM-V1\0",
    AUTHENTICATED_CONTROL: "CASSAV5BT-BT-CONTROL-V1\0"
  });
});

test("RFC7748 X25519 agrees in both directions and generated keys are canonical", () => {
  const clientSecret = deriveX25519SharedSecretV1(
    privateKey(CLIENT_PRIVATE_RAW),
    SERVER_PUBLIC_SPKI
  );
  const serverSecret = deriveX25519SharedSecretV1(
    privateKey(SERVER_PRIVATE_RAW),
    CLIENT_PUBLIC_SPKI
  );
  assert.equal(clientSecret.toString("hex"), EXPECTED.sharedSecret);
  assert.deepEqual(serverSecret, clientSecret);

  const generated = generateX25519KeyPairV1();
  assert.equal(generated.privateKey.type, "private");
  assert.equal(generated.privateKey.asymmetricKeyType, "x25519");
  assert.equal(generated.publicKeySpki.byteLength, 44);
  assert.deepEqual(
    createPublicKey(generated.privateKey).export({ format: "der", type: "spki" }),
    generated.publicKeySpki
  );
  clientSecret.fill(0);
  serverSecret.fill(0);
});

test("cross-language binder, transcript, HKDF and confirmations match vector", () => {
  const result = vector();
  assert.equal(result.clientBinder.toString("hex"), EXPECTED.clientBinder);
  assert.equal(
    result.sessionKeyBinder.toString("hex"),
    EXPECTED.sessionKeyBinder
  );
  assert.equal(
    result.transcriptHash.toString("hex"),
    EXPECTED.transcriptHash
  );
  for (const field of [
    "clientToServerControlKey",
    "serverToClientControlKey",
    "clientConfirmationKey",
    "serverConfirmationKey"
  ]) {
    assert.equal(result.keys[field].toString("hex"), EXPECTED[field]);
  }
  assert.equal(
    result.serverConfirmation.toString("hex"),
    EXPECTED.serverConfirmation
  );
  assert.equal(
    result.clientConfirmation.toString("hex"),
    EXPECTED.clientConfirmation
  );
  assert.equal(
    verifyServerKeyConfirmationV1({
      serverConfirmationKey: result.keys.serverConfirmationKey,
      transcriptHash: result.transcriptHash,
      confirmation: result.serverConfirmation
    }),
    true
  );
  assert.equal(
    verifyClientKeyConfirmationV1({
      clientConfirmationKey: result.keys.clientConfirmationKey,
      transcriptHash: result.transcriptHash,
      serverConfirmation: result.serverConfirmation,
      confirmation: result.clientConfirmation
    }),
    true
  );
});

test("key share and confirmation codecs match exact frozen wire", () => {
  const result = vector();
  const clientWire = encodeClientKeyShareV1({
    sessionId: SESSION_ID,
    publicKeySpki: CLIENT_PUBLIC_SPKI,
    clientBinder: result.clientBinder
  });
  const serverWire = encodeServerKeyShareV1({
    sessionId: SESSION_ID,
    publicKeySpki: SERVER_PUBLIC_SPKI,
    confirmation: result.serverConfirmation
  });
  const confirmWire = encodeClientKeyConfirmV1({
    sessionId: SESSION_ID,
    confirmation: result.clientConfirmation
  });
  assert.equal(clientWire.toString("hex"), EXPECTED.clientShareWire);
  assert.equal(serverWire.toString("hex"), EXPECTED.serverShareWire);
  assert.equal(confirmWire.toString("hex"), EXPECTED.clientConfirmWire);
  assert.deepEqual(decodeClientKeyShareV1(clientWire), {
    protocolVersion: 1,
    messageType: 4,
    sessionId: SESSION_ID,
    publicKeySpki: CLIENT_PUBLIC_SPKI,
    clientBinder: result.clientBinder
  });
  assert.deepEqual(decodeServerKeyShareV1(serverWire), {
    protocolVersion: 1,
    messageType: 5,
    sessionId: SESSION_ID,
    publicKeySpki: SERVER_PUBLIC_SPKI,
    confirmation: result.serverConfirmation
  });
  assert.deepEqual(decodeClientKeyConfirmV1(confirmWire), {
    protocolVersion: 1,
    messageType: 6,
    sessionId: SESSION_ID,
    confirmation: result.clientConfirmation
  });
});

test("authenticated PING, PONG, CLOSE and CLOSE_ACK match exact wire", () => {
  const result = vector();
  const ping = encodeHeartbeatV1({
    messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING,
    sessionId: SESSION_ID,
    sequence: 0,
    authenticationKey: result.keys.serverToClientControlKey
  });
  const pong = encodeHeartbeatV1({
    messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG,
    sessionId: SESSION_ID,
    sequence: 0,
    authenticationKey: result.keys.clientToServerControlKey
  });
  const close = encodeCloseV1({
    messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE,
    sessionId: SESSION_ID,
    sequence: 1,
    reason: DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL,
    authenticationKey: result.keys.serverToClientControlKey
  });
  const closeAck = encodeCloseV1({
    messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE_ACK,
    sessionId: SESSION_ID,
    sequence: 1,
    reason: DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL,
    authenticationKey: result.keys.clientToServerControlKey
  });
  assert.equal(ping.toString("hex"), EXPECTED.pingWire);
  assert.equal(pong.toString("hex"), EXPECTED.pongWire);
  assert.equal(close.toString("hex"), EXPECTED.closeWire);
  assert.equal(closeAck.toString("hex"), EXPECTED.closeAckWire);
  assert.equal(
    decodeHeartbeatV1(ping, {
      authenticationKey: result.keys.serverToClientControlKey,
      expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING,
      expectedSequence: 0
    }).sequence,
    0
  );
  assert.deepEqual(
    decodeCloseV1(closeAck, {
      authenticationKey: result.keys.clientToServerControlKey,
      expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE_ACK,
      expectedSequence: 1,
      expectedReason: DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL
    }),
    {
      protocolVersion: 1,
      messageType: 10,
      sessionId: SESSION_ID,
      sequence: 1,
      reason: 1
    }
  );
});

test("tampering and directional-key reflection fail authentication", () => {
  const result = vector();
  const ping = Buffer.from(EXPECTED.pingWire, "hex");
  const payloadTamper = Buffer.from(ping);
  payloadTamper[21] ^= 1;
  const tagTamper = Buffer.from(ping);
  tagTamper[53] ^= 1;

  for (const candidate of [payloadTamper, tagTamper]) {
    assert.throws(
      () =>
        decodeHeartbeatV1(candidate, {
          authenticationKey: result.keys.serverToClientControlKey,
          expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING
        }),
      assertCode("AUTHENTICATION_TAG_MISMATCH")
    );
  }
  assert.throws(
    () =>
      decodeHeartbeatV1(ping, {
        authenticationKey: result.keys.clientToServerControlKey,
        expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING
      }),
    assertCode("AUTHENTICATION_TAG_MISMATCH")
  );
  assert.throws(
    () =>
      decodeHeartbeatV1(ping, {
        authenticationKey: result.keys.serverToClientControlKey,
        expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG
      }),
    assertCode("MESSAGE_TYPE_MISMATCH")
  );
});

test("an authenticated old sequence is rejected as replay by expectation", () => {
  const result = vector();
  const ping = Buffer.from(EXPECTED.pingWire, "hex");
  assert.throws(
    () =>
      decodeHeartbeatV1(ping, {
        authenticationKey: result.keys.serverToClientControlKey,
        expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING,
        expectedSequence: 1
      }),
    assertCode("CONTROL_SEQUENCE_MISMATCH")
  );
  const close = Buffer.from(EXPECTED.closeWire, "hex");
  assert.throws(
    () =>
      decodeCloseV1(close, {
        authenticationKey: result.keys.serverToClientControlKey,
        expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE,
        expectedSequence: 2
      }),
    assertCode("CONTROL_SEQUENCE_MISMATCH")
  );
});

test("HELLO, certificate and public-key binding changes alter every key", () => {
  const original = vector();
  const rebound = {
    ...BINDING,
    serverHello: {
      ...BINDING.serverHello,
      nonce: "MDEyMzQ1Njc4OTo7PD0-Pw"
    }
  };
  const clientMessage = buildClientKeyShareBinderMessageV1(
    rebound,
    CLIENT_PUBLIC_SPKI
  );
  const reboundClientBinder = mac(ALIAS_KEY, clientMessage);
  clientMessage.fill(0);
  const binderMessage = buildSessionKeyBinderMessageV1(
    rebound,
    CLIENT_PUBLIC_SPKI,
    reboundClientBinder,
    SERVER_PUBLIC_SPKI
  );
  const reboundBinder = mac(ALIAS_KEY, binderMessage);
  binderMessage.fill(0);
  const reboundHash = buildSessionTranscriptHashV1(
    rebound,
    CLIENT_PUBLIC_SPKI,
    reboundClientBinder,
    SERVER_PUBLIC_SPKI
  );
  const reboundKeys = deriveDirectControlKeysV1({
    sharedSecret: Buffer.from(EXPECTED.sharedSecret, "hex"),
    sessionKeyBinder: reboundBinder,
    transcriptHash: reboundHash
  });
  assert.notDeepEqual(reboundClientBinder, original.clientBinder);
  assert.notDeepEqual(reboundBinder, original.sessionKeyBinder);
  assert.notDeepEqual(reboundHash, original.transcriptHash);
  assert.notDeepEqual(
    reboundKeys.serverConfirmationKey,
    original.keys.serverConfirmationKey
  );
  assert.equal(
    verifyServerKeyConfirmationV1({
      serverConfirmationKey: reboundKeys.serverConfirmationKey,
      transcriptHash: reboundHash,
      confirmation: original.serverConfirmation
    }),
    false
  );
});

test("confirmation tampering returns false without accepting a prefix", () => {
  const result = vector();
  const serverTamper = Buffer.from(result.serverConfirmation);
  serverTamper[0] ^= 1;
  const clientTamper = Buffer.from(result.clientConfirmation);
  clientTamper[31] ^= 1;
  assert.equal(
    verifyServerKeyConfirmationV1({
      serverConfirmationKey: result.keys.serverConfirmationKey,
      transcriptHash: result.transcriptHash,
      confirmation: serverTamper
    }),
    false
  );
  assert.equal(
    verifyClientKeyConfirmationV1({
      clientConfirmationKey: result.keys.clientConfirmationKey,
      transcriptHash: result.transcriptHash,
      serverConfirmation: result.serverConfirmation,
      confirmation: clientTamper
    }),
    false
  );
  assert.throws(
    () =>
      verifyServerKeyConfirmationV1({
        serverConfirmationKey: result.keys.serverConfirmationKey,
        transcriptHash: result.transcriptHash,
        confirmation: serverTamper.subarray(0, 31)
      }),
    assertCode("INVALID_AUTHENTICATIONVALUE")
  );
});

test("canonical SPKI, exact wire lengths, session and fields fail closed", () => {
  const invalidPrefix = Buffer.from(CLIENT_PUBLIC_SPKI);
  invalidPrefix[0] ^= 1;
  assert.throws(
    () => normalizeX25519PublicKeySpkiV1(invalidPrefix),
    assertCode("INVALID_X25519_PUBLIC_KEY")
  );
  assert.throws(
    () => normalizeX25519PublicKeySpkiV1(CLIENT_PUBLIC_SPKI.subarray(0, 43)),
    assertCode("INVALID_PUBLICKEYSPKI")
  );
  assert.throws(
    () => decodeClientKeyShareV1(Buffer.alloc(93)),
    assertCode("INVALID_WIRE")
  );
  assert.throws(
    () =>
      encodeClientKeyConfirmV1({
        sessionId: `${SESSION_ID}A`,
        confirmation: Buffer.alloc(32)
      }),
    assertCode("INVALID_SESSION_ID")
  );
  assert.throws(
    () =>
      encodeClientKeyConfirmV1({
        sessionId: SESSION_ID,
        confirmation: Buffer.alloc(32),
        privateKey: "forbidden"
      }),
    assertCode("INVALID_INPUT_FIELDS")
  );
});

test("zero shared secret is rejected and derived buffers are clearable", () => {
  assert.throws(
    () =>
      deriveDirectControlKeysV1({
        sharedSecret: Buffer.alloc(32),
        sessionKeyBinder: Buffer.alloc(32, 1),
        transcriptHash: Buffer.alloc(32, 2)
      }),
    assertCode("INVALID_X25519_SHARED_SECRET")
  );
  const result = vector();
  clearDirectControlKeysV1(result.keys);
  for (const key of Object.values(result.keys)) {
    assert.equal(key.every((byte) => byte === 0), true);
  }
});

test("confirmation messages retain exact domain separation and input order", () => {
  const transcriptHash = Buffer.from(EXPECTED.transcriptHash, "hex");
  const serverConfirmation = Buffer.from(EXPECTED.serverConfirmation, "hex");
  const serverMessage = buildServerKeyConfirmationMessageV1(transcriptHash);
  const clientMessage = buildClientKeyConfirmationMessageV1(
    transcriptHash,
    serverConfirmation
  );
  assert.equal(
    serverMessage.subarray(0, -32).toString("utf8"),
    DIRECT_CONTROL_V1_CONTEXTS.SERVER_CONFIRMATION
  );
  assert.equal(
    clientMessage.subarray(0, -(32 + 32)).toString("utf8"),
    DIRECT_CONTROL_V1_CONTEXTS.CLIENT_CONFIRMATION
  );
  assert.deepEqual(clientMessage.subarray(-32), serverConfirmation);
});
