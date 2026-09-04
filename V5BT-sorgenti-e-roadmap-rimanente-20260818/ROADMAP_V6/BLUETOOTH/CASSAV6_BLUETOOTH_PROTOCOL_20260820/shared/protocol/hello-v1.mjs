import {
  DIRECT_SESSION_ID_PATTERN_SOURCE,
  DIRECT_SESSION_PROTOCOL_VERSION
} from "../session/direct-session-v1.mjs";

export const HELLO_V1_PROTOCOL_VERSION = DIRECT_SESSION_PROTOCOL_VERSION;
export const HELLO_V1_SESSION_ID_BYTES = 16;
export const HELLO_V1_NONCE_BYTES = 16;
export const HELLO_V1_WIRE_BYTES = 51;
export const HELLO_V1_ATT_HEADER_BYTES = 3;
export const HELLO_V1_MINIMUM_MTU =
  HELLO_V1_WIRE_BYTES + HELLO_V1_ATT_HEADER_BYTES;
export const HELLO_V1_MAX_CAPABILITIES = 0x7f;
export const HELLO_V1_NODE_ID_PATTERN_SOURCE =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const HELLO_V1_NONCE_PATTERN_SOURCE =
  "^[A-Za-z0-9_-]{21}[AQgw]$";

const SESSION_ID_PATTERN = new RegExp(DIRECT_SESSION_ID_PATTERN_SOURCE);
const NODE_ID_PATTERN = new RegExp(HELLO_V1_NODE_ID_PATTERN_SOURCE);
const NONCE_PATTERN = new RegExp(HELLO_V1_NONCE_PATTERN_SOURCE);
const ZERO_NONCE = Buffer.alloc(HELLO_V1_NONCE_BYTES).toString("base64url");
const HELLO_KEYS = Object.freeze([
  "protocolVersion",
  "sessionId",
  "nodeId",
  "bootId",
  "capabilities",
  "nonce"
]);

export class HelloV1Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HelloV1Error";
    this.code = code;
  }
}

function fail(code, message) {
  throw new HelloV1Error(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value) {
  if (!isPlainObject(value)) {
    fail("INVALID_HELLO", "HELLO must be a plain object");
  }
  const keys = Object.keys(value).sort();
  const expected = [...HELLO_KEYS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail("INVALID_HELLO_FIELDS", "HELLO has missing or unexpected fields");
  }
}

function decodeCanonicalBase64Url(value, expectedBytes, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`INVALID_${field.toUpperCase()}`, `${field} has an invalid format`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength !== expectedBytes ||
    decoded.toString("base64url") !== value
  ) {
    fail(
      `INVALID_${field.toUpperCase()}`,
      `${field} must be canonical unpadded base64url`
    );
  }
  return decoded;
}

function normalizeNodeId(value) {
  if (typeof value !== "string" || !NODE_ID_PATTERN.test(value)) {
    fail("INVALID_NODE_ID", "nodeId must be a canonical lowercase UUID");
  }
  return value;
}

function normalizeBoundedInteger(value, minimum, maximum, field) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(
      `INVALID_${field.toUpperCase()}`,
      `${field} must be an integer from ${minimum} to ${maximum}`
    );
  }
  return value;
}

function uuidToBytes(value) {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function bytesToUuid(value) {
  const hex = Buffer.from(value).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

export function normalizeHelloV1(value) {
  assertExactKeys(value);
  if (value.protocolVersion !== HELLO_V1_PROTOCOL_VERSION) {
    fail(
      "PROTOCOL_VERSION_MISMATCH",
      `protocolVersion must be ${HELLO_V1_PROTOCOL_VERSION}`
    );
  }
  const sessionIdBytes = decodeCanonicalBase64Url(
    value.sessionId,
    HELLO_V1_SESSION_ID_BYTES,
    SESSION_ID_PATTERN,
    "sessionId"
  );
  const nonceBytes = decodeCanonicalBase64Url(
    value.nonce,
    HELLO_V1_NONCE_BYTES,
    NONCE_PATTERN,
    "nonce"
  );
  if (value.nonce === ZERO_NONCE) {
    fail("INVALID_NONCE", "nonce must not be all zero");
  }
  const normalized = Object.freeze({
    protocolVersion: HELLO_V1_PROTOCOL_VERSION,
    sessionId: sessionIdBytes.toString("base64url"),
    nodeId: normalizeNodeId(value.nodeId),
    bootId: normalizeBoundedInteger(value.bootId, 1, 255, "bootId"),
    capabilities: normalizeBoundedInteger(
      value.capabilities,
      0,
      HELLO_V1_MAX_CAPABILITIES,
      "capabilities"
    ),
    nonce: nonceBytes.toString("base64url")
  });
  sessionIdBytes.fill(0);
  nonceBytes.fill(0);
  return normalized;
}

export function encodeHelloV1(value) {
  const normalized = normalizeHelloV1(value);
  const sessionId = Buffer.from(normalized.sessionId, "base64url");
  const nonce = Buffer.from(normalized.nonce, "base64url");
  const encoded = Buffer.alloc(HELLO_V1_WIRE_BYTES);
  try {
    encoded[0] = normalized.protocolVersion;
    sessionId.copy(encoded, 1);
    uuidToBytes(normalized.nodeId).copy(encoded, 17);
    encoded[33] = normalized.bootId;
    encoded[34] = normalized.capabilities;
    nonce.copy(encoded, 35);
    return encoded;
  } finally {
    sessionId.fill(0);
    nonce.fill(0);
  }
}

export function decodeHelloV1(value) {
  const encoded = Buffer.from(value);
  if (encoded.byteLength !== HELLO_V1_WIRE_BYTES) {
    fail(
      "INVALID_WIRE_LENGTH",
      `HELLO wire payload must contain ${HELLO_V1_WIRE_BYTES} bytes`
    );
  }
  return normalizeHelloV1({
    protocolVersion: encoded[0],
    sessionId: encoded.subarray(1, 17).toString("base64url"),
    nodeId: bytesToUuid(encoded.subarray(17, 33)),
    bootId: encoded[33],
    capabilities: encoded[34],
    nonce: encoded.subarray(35, 51).toString("base64url")
  });
}

function secureRandomIdentifier(randomBytes, byteLength, field) {
  if (typeof randomBytes !== "function") {
    throw new TypeError("randomBytes must be a function");
  }
  const value = Buffer.from(randomBytes(byteLength));
  if (value.byteLength !== byteLength) {
    value.fill(0);
    fail("INVALID_RANDOM_SOURCE", `${field} random source returned wrong size`);
  }
  const encoded = value.toString("base64url");
  value.fill(0);
  return encoded;
}

export function generateHelloSessionIdV1(randomBytes) {
  return secureRandomIdentifier(
    randomBytes,
    HELLO_V1_SESSION_ID_BYTES,
    "sessionId"
  );
}

export function generateHelloNonceV1(randomBytes) {
  const nonce = secureRandomIdentifier(
    randomBytes,
    HELLO_V1_NONCE_BYTES,
    "nonce"
  );
  if (nonce === ZERO_NONCE) {
    fail("INVALID_RANDOM_SOURCE", "nonce random source returned all zero");
  }
  return nonce;
}
