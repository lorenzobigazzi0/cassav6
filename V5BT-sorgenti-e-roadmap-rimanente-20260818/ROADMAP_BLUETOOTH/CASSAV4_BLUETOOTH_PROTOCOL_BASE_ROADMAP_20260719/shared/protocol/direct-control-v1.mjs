import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  timingSafeEqual
} from "node:crypto";

import { encodeHelloV1 } from "./hello-v1.mjs";
import {
  MUTUAL_AUTH_V1_MINIMUM_MTU,
  normalizeMutualAuthBindingV1
} from "./mutual-auth-v1.mjs";

export const DIRECT_CONTROL_V1_PROTOCOL_VERSION = 1;
export const DIRECT_CONTROL_V1_SESSION_ID_BYTES = 16;
export const DIRECT_CONTROL_V1_X25519_SPKI_BYTES = 44;
export const DIRECT_CONTROL_V1_AUTH_BYTES = 32;
export const DIRECT_CONTROL_V1_HEADER_BYTES = 18;
export const DIRECT_CONTROL_V1_CLIENT_KEY_SHARE_WIRE_BYTES = 94;
export const DIRECT_CONTROL_V1_SERVER_KEY_SHARE_WIRE_BYTES = 94;
export const DIRECT_CONTROL_V1_CLIENT_KEY_CONFIRM_WIRE_BYTES = 50;
export const DIRECT_CONTROL_V1_HEARTBEAT_WIRE_BYTES = 54;
export const DIRECT_CONTROL_V1_CLOSE_WIRE_BYTES = 55;
export const DIRECT_CONTROL_V1_MINIMUM_MTU = MUTUAL_AUTH_V1_MINIMUM_MTU;
export const DIRECT_CONTROL_V1_MAX_SEQUENCE = 0xffff_ffff;
export const DIRECT_CONTROL_V1_X25519_SPKI_PREFIX_HEX =
  "302a300506032b656e032100";

export const DIRECT_CONTROL_V1_MESSAGE_TYPES = Object.freeze({
  CLIENT_KEY_SHARE: 4,
  SERVER_KEY_SHARE: 5,
  CLIENT_KEY_CONFIRM: 6,
  PING: 7,
  PONG: 8,
  CLOSE: 9,
  CLOSE_ACK: 10
});

export const DIRECT_CONTROL_V1_CLOSE_REASONS = Object.freeze({
  NORMAL: 1,
  HEARTBEAT_TIMEOUT: 2,
  SERVICE_STOP: 3,
  PROTOCOL_ERROR: 4
});

export const DIRECT_CONTROL_V1_CONTEXTS = Object.freeze({
  CLIENT_KEY_SHARE: "CASSAV5BT-BT-KEY-CLIENT-SHARE-V1\0",
  SESSION_KEY_BINDER: "CASSAV5BT-BT-KEY-SALT-V1\0",
  SESSION_TRANSCRIPT: "CASSAV5BT-BT-KEY-TRANSCRIPT-V1\0",
  HKDF_INFO: "CASSAV5BT-BT-KEYS-V1\0",
  SERVER_CONFIRMATION: "CASSAV5BT-BT-KEY-SERVER-CONFIRM-V1\0",
  CLIENT_CONFIRMATION: "CASSAV5BT-BT-KEY-CLIENT-CONFIRM-V1\0",
  AUTHENTICATED_CONTROL: "CASSAV5BT-BT-CONTROL-V1\0"
});

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const X25519_SPKI_PREFIX = Buffer.from(
  DIRECT_CONTROL_V1_X25519_SPKI_PREFIX_HEX,
  "hex"
);
const CONTEXT_BYTES = Object.freeze(
  Object.fromEntries(
    Object.entries(DIRECT_CONTROL_V1_CONTEXTS).map(([name, value]) => [
      name,
      Buffer.from(value, "utf8")
    ])
  )
);
const HEARTBEAT_TYPES = new Set([
  DIRECT_CONTROL_V1_MESSAGE_TYPES.PING,
  DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG
]);
const CLOSE_TYPES = new Set([
  DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE,
  DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE_ACK
]);
const CLOSE_REASONS = new Set(
  Object.values(DIRECT_CONTROL_V1_CLOSE_REASONS)
);

export class DirectControlV1Error extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "DirectControlV1Error";
    this.code = code;
  }
}

function fail(code, message, cause = undefined) {
  throw new DirectControlV1Error(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateFields(value, required, optional = []) {
  if (!isRecord(value)) {
    fail("INVALID_INPUT", "input must be an object");
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((field) => !Object.hasOwn(value, field)) ||
    keys.some((field) => !allowed.has(field))
  ) {
    fail("INVALID_INPUT_FIELDS", "input has invalid fields");
  }
}

function exactBytes(value, expectedLength, field) {
  if (!(value instanceof Uint8Array)) {
    fail(`INVALID_${field.toUpperCase()}`, `${field} must be a byte array`);
  }
  const copy = Buffer.from(value);
  if (copy.byteLength !== expectedLength) {
    copy.fill(0);
    fail(
      `INVALID_${field.toUpperCase()}`,
      `${field} must contain exactly ${expectedLength} bytes`
    );
  }
  return copy;
}

function sessionIdBytes(value) {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    fail("INVALID_SESSION_ID", "sessionId has an invalid format");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength !== DIRECT_CONTROL_V1_SESSION_ID_BYTES ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    fail(
      "INVALID_SESSION_ID",
      "sessionId must be canonical unpadded base64url"
    );
  }
  return decoded;
}

function sessionIdText(value) {
  const copy = exactBytes(
    value,
    DIRECT_CONTROL_V1_SESSION_ID_BYTES,
    "sessionId"
  );
  try {
    const result = copy.toString("base64url");
    sessionIdBytes(result).fill(0);
    return result;
  } finally {
    copy.fill(0);
  }
}

function uuidBytes(value) {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function validateSequence(value, field = "sequence") {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > DIRECT_CONTROL_V1_MAX_SEQUENCE
  ) {
    fail(
      `INVALID_${field.toUpperCase()}`,
      `${field} must be an unsigned 32-bit integer`
    );
  }
  return value;
}

function validateCloseReason(value) {
  if (!Number.isSafeInteger(value) || !CLOSE_REASONS.has(value)) {
    fail("INVALID_CLOSE_REASON", "close reason is not defined by v1");
  }
  return value;
}

function validateMessageType(value, allowed, field = "messageType") {
  if (!Number.isSafeInteger(value) || !allowed.has(value)) {
    fail(
      "INVALID_MESSAGE_TYPE",
      `${field} is not valid for this control message`
    );
  }
  return value;
}

function decodeWire(value, expectedLength, expectedType) {
  const encoded = exactBytes(value, expectedLength, "wire");
  if (encoded[0] !== DIRECT_CONTROL_V1_PROTOCOL_VERSION) {
    encoded.fill(0);
    fail(
      "PROTOCOL_VERSION_MISMATCH",
      `protocolVersion must be ${DIRECT_CONTROL_V1_PROTOCOL_VERSION}`
    );
  }
  if (encoded[1] !== expectedType) {
    encoded.fill(0);
    fail("MESSAGE_TYPE_MISMATCH", "control message type does not match");
  }
  return encoded;
}

function normalizeBinding(value) {
  try {
    return normalizeMutualAuthBindingV1(value);
  } catch (error) {
    fail("INVALID_AUTH_BINDING", "mutual-auth binding is invalid", error);
  }
}

function authBindingBytes(value) {
  const binding = normalizeBinding(value);
  const clientHello = encodeHelloV1(binding.clientHello);
  const serverHello = encodeHelloV1(binding.serverHello);
  const certificateId = uuidBytes(binding.deviceCertificateId);
  try {
    return Buffer.concat([clientHello, serverHello, certificateId]);
  } finally {
    clientHello.fill(0);
    serverHello.fill(0);
    certificateId.fill(0);
  }
}

function hmacSha256(key, message) {
  const keyCopy = exactBytes(key, DIRECT_CONTROL_V1_AUTH_BYTES, "key");
  try {
    return createHmac("sha256", keyCopy).update(message).digest();
  } finally {
    keyCopy.fill(0);
  }
}

function authenticatedControlTag(authenticationKey, wireWithoutTag) {
  const message = Buffer.concat([
    CONTEXT_BYTES.AUTHENTICATED_CONTROL,
    wireWithoutTag
  ]);
  try {
    return hmacSha256(authenticationKey, message);
  } finally {
    message.fill(0);
  }
}

function equalAuthenticationValue(expected, candidate) {
  const candidateCopy = exactBytes(
    candidate,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "authenticationValue"
  );
  try {
    return timingSafeEqual(expected, candidateCopy);
  } finally {
    candidateCopy.fill(0);
  }
}

export function normalizeX25519PublicKeySpkiV1(value) {
  const encoded = exactBytes(
    value,
    DIRECT_CONTROL_V1_X25519_SPKI_BYTES,
    "publicKeySpki"
  );
  if (!encoded.subarray(0, X25519_SPKI_PREFIX.byteLength).equals(X25519_SPKI_PREFIX)) {
    encoded.fill(0);
    fail(
      "INVALID_X25519_PUBLIC_KEY",
      "publicKeySpki is not the canonical X25519 SPKI encoding"
    );
  }
  return encoded;
}

export function generateX25519KeyPairV1() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const publicKeySpki = normalizeX25519PublicKeySpkiV1(
    publicKey.export({ format: "der", type: "spki" })
  );
  return Object.freeze({ privateKey, publicKeySpki });
}

export function deriveX25519SharedSecretV1(privateKey, peerPublicKeySpki) {
  if (
    !isRecord(privateKey) ||
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "x25519"
  ) {
    fail(
      "INVALID_X25519_PRIVATE_KEY",
      "privateKey must be a Node X25519 private KeyObject"
    );
  }
  const encoded = normalizeX25519PublicKeySpkiV1(peerPublicKeySpki);
  let sharedSecret;
  try {
    const publicKey = createPublicKey({
      key: encoded,
      format: "der",
      type: "spki"
    });
    if (publicKey.asymmetricKeyType !== "x25519") {
      fail("INVALID_X25519_PUBLIC_KEY", "peer key is not X25519");
    }
    sharedSecret = diffieHellman({ privateKey, publicKey });
    if (
      sharedSecret.byteLength !== DIRECT_CONTROL_V1_AUTH_BYTES ||
      sharedSecret.every((byte) => byte === 0)
    ) {
      sharedSecret.fill(0);
      fail(
        "INVALID_X25519_SHARED_SECRET",
        "X25519 produced an invalid shared secret"
      );
    }
    return sharedSecret;
  } catch (error) {
    sharedSecret?.fill(0);
    if (error instanceof DirectControlV1Error) throw error;
    fail("X25519_DERIVATION_FAILED", "X25519 derivation failed", error);
  } finally {
    encoded.fill(0);
  }
}

export function buildClientKeyShareBinderMessageV1(
  binding,
  clientPublicKeySpki
) {
  const bindingEncoded = authBindingBytes(binding);
  const clientKey = normalizeX25519PublicKeySpkiV1(clientPublicKeySpki);
  try {
    return Buffer.concat([
      CONTEXT_BYTES.CLIENT_KEY_SHARE,
      bindingEncoded,
      clientKey
    ]);
  } finally {
    bindingEncoded.fill(0);
    clientKey.fill(0);
  }
}

export function buildSessionKeyBinderMessageV1(
  binding,
  clientPublicKeySpki,
  clientBinder,
  serverPublicKeySpki
) {
  const bindingEncoded = authBindingBytes(binding);
  const clientKey = normalizeX25519PublicKeySpkiV1(clientPublicKeySpki);
  const binder = exactBytes(
    clientBinder,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "clientBinder"
  );
  const serverKey = normalizeX25519PublicKeySpkiV1(serverPublicKeySpki);
  try {
    return Buffer.concat([
      CONTEXT_BYTES.SESSION_KEY_BINDER,
      bindingEncoded,
      clientKey,
      binder,
      serverKey
    ]);
  } finally {
    bindingEncoded.fill(0);
    clientKey.fill(0);
    binder.fill(0);
    serverKey.fill(0);
  }
}

export function buildSessionTranscriptHashV1(
  binding,
  clientPublicKeySpki,
  clientBinder,
  serverPublicKeySpki
) {
  const bindingEncoded = authBindingBytes(binding);
  const clientKey = normalizeX25519PublicKeySpkiV1(clientPublicKeySpki);
  const binder = exactBytes(
    clientBinder,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "clientBinder"
  );
  const serverKey = normalizeX25519PublicKeySpkiV1(serverPublicKeySpki);
  try {
    return createHash("sha256")
      .update(CONTEXT_BYTES.SESSION_TRANSCRIPT)
      .update(bindingEncoded)
      .update(clientKey)
      .update(binder)
      .update(serverKey)
      .digest();
  } finally {
    bindingEncoded.fill(0);
    clientKey.fill(0);
    binder.fill(0);
    serverKey.fill(0);
  }
}

export function deriveDirectControlKeysV1(input) {
  validateFields(input, ["sharedSecret", "sessionKeyBinder", "transcriptHash"]);
  const sharedSecret = exactBytes(
    input.sharedSecret,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "sharedSecret"
  );
  const sessionKeyBinder = exactBytes(
    input.sessionKeyBinder,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "sessionKeyBinder"
  );
  const transcriptHash = exactBytes(
    input.transcriptHash,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "transcriptHash"
  );
  const info = Buffer.concat([CONTEXT_BYTES.HKDF_INFO, transcriptHash]);
  let keyMaterial;
  try {
    if (sharedSecret.every((byte) => byte === 0)) {
      fail(
        "INVALID_X25519_SHARED_SECRET",
        "sharedSecret must not be all zero"
      );
    }
    keyMaterial = Buffer.from(
      hkdfSync(
        "sha256",
        sharedSecret,
        sessionKeyBinder,
        info,
        DIRECT_CONTROL_V1_AUTH_BYTES * 4
      )
    );
    return Object.freeze({
      clientToServerControlKey: Buffer.from(keyMaterial.subarray(0, 32)),
      serverToClientControlKey: Buffer.from(keyMaterial.subarray(32, 64)),
      clientConfirmationKey: Buffer.from(keyMaterial.subarray(64, 96)),
      serverConfirmationKey: Buffer.from(keyMaterial.subarray(96, 128))
    });
  } finally {
    sharedSecret.fill(0);
    sessionKeyBinder.fill(0);
    transcriptHash.fill(0);
    info.fill(0);
    keyMaterial?.fill(0);
  }
}

export function clearDirectControlKeysV1(keys) {
  validateFields(keys, [
    "clientToServerControlKey",
    "serverToClientControlKey",
    "clientConfirmationKey",
    "serverConfirmationKey"
  ]);
  for (const field of [
    "clientToServerControlKey",
    "serverToClientControlKey",
    "clientConfirmationKey",
    "serverConfirmationKey"
  ]) {
    if (!(keys[field] instanceof Uint8Array)) {
      fail("INVALID_KEY_MATERIAL", "session key material is invalid");
    }
    keys[field].fill(0);
  }
}

export function buildServerKeyConfirmationMessageV1(transcriptHash) {
  const hash = exactBytes(
    transcriptHash,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "transcriptHash"
  );
  try {
    return Buffer.concat([CONTEXT_BYTES.SERVER_CONFIRMATION, hash]);
  } finally {
    hash.fill(0);
  }
}

export function createServerKeyConfirmationV1(input) {
  validateFields(input, ["serverConfirmationKey", "transcriptHash"]);
  const message = buildServerKeyConfirmationMessageV1(input.transcriptHash);
  try {
    return hmacSha256(input.serverConfirmationKey, message);
  } finally {
    message.fill(0);
  }
}

export function verifyServerKeyConfirmationV1(input) {
  validateFields(input, [
    "serverConfirmationKey",
    "transcriptHash",
    "confirmation"
  ]);
  const expected = createServerKeyConfirmationV1({
    serverConfirmationKey: input.serverConfirmationKey,
    transcriptHash: input.transcriptHash
  });
  try {
    return equalAuthenticationValue(expected, input.confirmation);
  } finally {
    expected.fill(0);
  }
}

export function buildClientKeyConfirmationMessageV1(
  transcriptHash,
  serverConfirmation
) {
  const hash = exactBytes(
    transcriptHash,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "transcriptHash"
  );
  const server = exactBytes(
    serverConfirmation,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "serverConfirmation"
  );
  try {
    return Buffer.concat([CONTEXT_BYTES.CLIENT_CONFIRMATION, hash, server]);
  } finally {
    hash.fill(0);
    server.fill(0);
  }
}

export function createClientKeyConfirmationV1(input) {
  validateFields(input, [
    "clientConfirmationKey",
    "transcriptHash",
    "serverConfirmation"
  ]);
  const message = buildClientKeyConfirmationMessageV1(
    input.transcriptHash,
    input.serverConfirmation
  );
  try {
    return hmacSha256(input.clientConfirmationKey, message);
  } finally {
    message.fill(0);
  }
}

export function verifyClientKeyConfirmationV1(input) {
  validateFields(input, [
    "clientConfirmationKey",
    "transcriptHash",
    "serverConfirmation",
    "confirmation"
  ]);
  const expected = createClientKeyConfirmationV1({
    clientConfirmationKey: input.clientConfirmationKey,
    transcriptHash: input.transcriptHash,
    serverConfirmation: input.serverConfirmation
  });
  try {
    return equalAuthenticationValue(expected, input.confirmation);
  } finally {
    expected.fill(0);
  }
}

export function encodeClientKeyShareV1(value) {
  validateFields(value, ["sessionId", "publicKeySpki", "clientBinder"]);
  const sessionId = sessionIdBytes(value.sessionId);
  const publicKeySpki = normalizeX25519PublicKeySpkiV1(value.publicKeySpki);
  const clientBinder = exactBytes(
    value.clientBinder,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "clientBinder"
  );
  const encoded = Buffer.alloc(DIRECT_CONTROL_V1_CLIENT_KEY_SHARE_WIRE_BYTES);
  try {
    encoded[0] = DIRECT_CONTROL_V1_PROTOCOL_VERSION;
    encoded[1] = DIRECT_CONTROL_V1_MESSAGE_TYPES.CLIENT_KEY_SHARE;
    sessionId.copy(encoded, 2);
    publicKeySpki.copy(encoded, 18);
    clientBinder.copy(encoded, 62);
    return encoded;
  } finally {
    sessionId.fill(0);
    publicKeySpki.fill(0);
    clientBinder.fill(0);
  }
}

export function decodeClientKeyShareV1(value) {
  const encoded = decodeWire(
    value,
    DIRECT_CONTROL_V1_CLIENT_KEY_SHARE_WIRE_BYTES,
    DIRECT_CONTROL_V1_MESSAGE_TYPES.CLIENT_KEY_SHARE
  );
  try {
    const publicKeySpki = normalizeX25519PublicKeySpkiV1(
      encoded.subarray(18, 62)
    );
    return Object.freeze({
      protocolVersion: DIRECT_CONTROL_V1_PROTOCOL_VERSION,
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLIENT_KEY_SHARE,
      sessionId: sessionIdText(encoded.subarray(2, 18)),
      publicKeySpki,
      clientBinder: Buffer.from(encoded.subarray(62, 94))
    });
  } finally {
    encoded.fill(0);
  }
}

export function encodeServerKeyShareV1(value) {
  validateFields(value, ["sessionId", "publicKeySpki", "confirmation"]);
  const sessionId = sessionIdBytes(value.sessionId);
  const publicKeySpki = normalizeX25519PublicKeySpkiV1(value.publicKeySpki);
  const confirmation = exactBytes(
    value.confirmation,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "confirmation"
  );
  const encoded = Buffer.alloc(DIRECT_CONTROL_V1_SERVER_KEY_SHARE_WIRE_BYTES);
  try {
    encoded[0] = DIRECT_CONTROL_V1_PROTOCOL_VERSION;
    encoded[1] = DIRECT_CONTROL_V1_MESSAGE_TYPES.SERVER_KEY_SHARE;
    sessionId.copy(encoded, 2);
    publicKeySpki.copy(encoded, 18);
    confirmation.copy(encoded, 62);
    return encoded;
  } finally {
    sessionId.fill(0);
    publicKeySpki.fill(0);
    confirmation.fill(0);
  }
}

export function decodeServerKeyShareV1(value) {
  const encoded = decodeWire(
    value,
    DIRECT_CONTROL_V1_SERVER_KEY_SHARE_WIRE_BYTES,
    DIRECT_CONTROL_V1_MESSAGE_TYPES.SERVER_KEY_SHARE
  );
  try {
    const publicKeySpki = normalizeX25519PublicKeySpkiV1(
      encoded.subarray(18, 62)
    );
    return Object.freeze({
      protocolVersion: DIRECT_CONTROL_V1_PROTOCOL_VERSION,
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.SERVER_KEY_SHARE,
      sessionId: sessionIdText(encoded.subarray(2, 18)),
      publicKeySpki,
      confirmation: Buffer.from(encoded.subarray(62, 94))
    });
  } finally {
    encoded.fill(0);
  }
}

export function encodeClientKeyConfirmV1(value) {
  validateFields(value, ["sessionId", "confirmation"]);
  const sessionId = sessionIdBytes(value.sessionId);
  const confirmation = exactBytes(
    value.confirmation,
    DIRECT_CONTROL_V1_AUTH_BYTES,
    "confirmation"
  );
  const encoded = Buffer.alloc(DIRECT_CONTROL_V1_CLIENT_KEY_CONFIRM_WIRE_BYTES);
  try {
    encoded[0] = DIRECT_CONTROL_V1_PROTOCOL_VERSION;
    encoded[1] = DIRECT_CONTROL_V1_MESSAGE_TYPES.CLIENT_KEY_CONFIRM;
    sessionId.copy(encoded, 2);
    confirmation.copy(encoded, 18);
    return encoded;
  } finally {
    sessionId.fill(0);
    confirmation.fill(0);
  }
}

export function decodeClientKeyConfirmV1(value) {
  const encoded = decodeWire(
    value,
    DIRECT_CONTROL_V1_CLIENT_KEY_CONFIRM_WIRE_BYTES,
    DIRECT_CONTROL_V1_MESSAGE_TYPES.CLIENT_KEY_CONFIRM
  );
  try {
    return Object.freeze({
      protocolVersion: DIRECT_CONTROL_V1_PROTOCOL_VERSION,
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLIENT_KEY_CONFIRM,
      sessionId: sessionIdText(encoded.subarray(2, 18)),
      confirmation: Buffer.from(encoded.subarray(18, 50))
    });
  } finally {
    encoded.fill(0);
  }
}

export function encodeHeartbeatV1(value) {
  validateFields(value, [
    "messageType",
    "sessionId",
    "sequence",
    "authenticationKey"
  ]);
  const messageType = validateMessageType(value.messageType, HEARTBEAT_TYPES);
  const sessionId = sessionIdBytes(value.sessionId);
  const sequence = validateSequence(value.sequence);
  const prefix = Buffer.alloc(DIRECT_CONTROL_V1_HEARTBEAT_WIRE_BYTES - 32);
  let tag;
  try {
    prefix[0] = DIRECT_CONTROL_V1_PROTOCOL_VERSION;
    prefix[1] = messageType;
    sessionId.copy(prefix, 2);
    prefix.writeUInt32BE(sequence, 18);
    tag = authenticatedControlTag(value.authenticationKey, prefix);
    return Buffer.concat([prefix, tag]);
  } finally {
    sessionId.fill(0);
    prefix.fill(0);
    tag?.fill(0);
  }
}

export function decodeHeartbeatV1(value, options) {
  validateFields(
    options,
    ["authenticationKey"],
    ["expectedMessageType", "expectedSequence"]
  );
  const encoded = exactBytes(
    value,
    DIRECT_CONTROL_V1_HEARTBEAT_WIRE_BYTES,
    "wire"
  );
  let expectedTag;
  try {
    if (encoded[0] !== DIRECT_CONTROL_V1_PROTOCOL_VERSION) {
      fail("PROTOCOL_VERSION_MISMATCH", "heartbeat protocol version mismatches");
    }
    const messageType = validateMessageType(encoded[1], HEARTBEAT_TYPES);
    if (
      options.expectedMessageType !== undefined &&
      messageType !==
        validateMessageType(options.expectedMessageType, HEARTBEAT_TYPES)
    ) {
      fail("MESSAGE_TYPE_MISMATCH", "heartbeat message type mismatches");
    }
    const sequence = encoded.readUInt32BE(18);
    expectedTag = authenticatedControlTag(
      options.authenticationKey,
      encoded.subarray(0, 22)
    );
    if (!timingSafeEqual(expectedTag, encoded.subarray(22, 54))) {
      fail("AUTHENTICATION_TAG_MISMATCH", "heartbeat tag is invalid");
    }
    if (
      options.expectedSequence !== undefined &&
      sequence !== validateSequence(options.expectedSequence, "expectedSequence")
    ) {
      fail("CONTROL_SEQUENCE_MISMATCH", "heartbeat sequence mismatches");
    }
    return Object.freeze({
      protocolVersion: DIRECT_CONTROL_V1_PROTOCOL_VERSION,
      messageType,
      sessionId: sessionIdText(encoded.subarray(2, 18)),
      sequence
    });
  } finally {
    expectedTag?.fill(0);
    encoded.fill(0);
  }
}

export function encodeCloseV1(value) {
  validateFields(value, [
    "messageType",
    "sessionId",
    "sequence",
    "reason",
    "authenticationKey"
  ]);
  const messageType = validateMessageType(value.messageType, CLOSE_TYPES);
  const sessionId = sessionIdBytes(value.sessionId);
  const sequence = validateSequence(value.sequence);
  const reason = validateCloseReason(value.reason);
  const prefix = Buffer.alloc(DIRECT_CONTROL_V1_CLOSE_WIRE_BYTES - 32);
  let tag;
  try {
    prefix[0] = DIRECT_CONTROL_V1_PROTOCOL_VERSION;
    prefix[1] = messageType;
    sessionId.copy(prefix, 2);
    prefix.writeUInt32BE(sequence, 18);
    prefix[22] = reason;
    tag = authenticatedControlTag(value.authenticationKey, prefix);
    return Buffer.concat([prefix, tag]);
  } finally {
    sessionId.fill(0);
    prefix.fill(0);
    tag?.fill(0);
  }
}

export function decodeCloseV1(value, options) {
  validateFields(
    options,
    ["authenticationKey"],
    ["expectedMessageType", "expectedSequence", "expectedReason"]
  );
  const encoded = exactBytes(
    value,
    DIRECT_CONTROL_V1_CLOSE_WIRE_BYTES,
    "wire"
  );
  let expectedTag;
  try {
    if (encoded[0] !== DIRECT_CONTROL_V1_PROTOCOL_VERSION) {
      fail("PROTOCOL_VERSION_MISMATCH", "close protocol version mismatches");
    }
    const messageType = validateMessageType(encoded[1], CLOSE_TYPES);
    if (
      options.expectedMessageType !== undefined &&
      messageType !== validateMessageType(options.expectedMessageType, CLOSE_TYPES)
    ) {
      fail("MESSAGE_TYPE_MISMATCH", "close message type mismatches");
    }
    const sequence = encoded.readUInt32BE(18);
    const reason = validateCloseReason(encoded[22]);
    expectedTag = authenticatedControlTag(
      options.authenticationKey,
      encoded.subarray(0, 23)
    );
    if (!timingSafeEqual(expectedTag, encoded.subarray(23, 55))) {
      fail("AUTHENTICATION_TAG_MISMATCH", "close tag is invalid");
    }
    if (
      options.expectedSequence !== undefined &&
      sequence !== validateSequence(options.expectedSequence, "expectedSequence")
    ) {
      fail("CONTROL_SEQUENCE_MISMATCH", "close sequence mismatches");
    }
    if (
      options.expectedReason !== undefined &&
      reason !== validateCloseReason(options.expectedReason)
    ) {
      fail("CLOSE_REASON_MISMATCH", "close reason mismatches");
    }
    return Object.freeze({
      protocolVersion: DIRECT_CONTROL_V1_PROTOCOL_VERSION,
      messageType,
      sessionId: sessionIdText(encoded.subarray(2, 18)),
      sequence,
      reason
    });
  } finally {
    expectedTag?.fill(0);
    encoded.fill(0);
  }
}
