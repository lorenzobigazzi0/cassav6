import { CAPABILITY_BITS } from "./advertisement-v1.mjs";
import {
  HELLO_V1_PROTOCOL_VERSION,
  encodeHelloV1,
  normalizeHelloV1
} from "./hello-v1.mjs";

export const MUTUAL_AUTH_V1_PROTOCOL_VERSION = HELLO_V1_PROTOCOL_VERSION;
export const MUTUAL_AUTH_V1_SIGNATURE_BYTES = 64;
export const MUTUAL_AUTH_V1_PROOF_BYTES = 32;
export const MUTUAL_AUTH_V1_CLIENT_PROOF_WIRE_BYTES = 98;
export const MUTUAL_AUTH_V1_SERVER_PROOF_WIRE_BYTES = 66;
export const MUTUAL_AUTH_V1_FINISH_WIRE_BYTES = 50;
export const MUTUAL_AUTH_V1_ATT_HEADER_BYTES = 3;
export const MUTUAL_AUTH_V1_MINIMUM_MTU =
  MUTUAL_AUTH_V1_CLIENT_PROOF_WIRE_BYTES +
  MUTUAL_AUTH_V1_ATT_HEADER_BYTES;

export const MUTUAL_AUTH_V1_MESSAGE_TYPES = Object.freeze({
  CLIENT_PROOF: 1,
  SERVER_PROOF: 2,
  FINISH: 3
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const CLIENT_PROOF_CONTEXT = Buffer.from(
  "CASSA_V6-BT-AUTH-CLIENT-V1\0",
  "utf8"
);
const SERVER_PROOF_CONTEXT = Buffer.from(
  "CASSA_V6-BT-AUTH-SERVER-V1\0",
  "utf8"
);
const FINISH_PROOF_CONTEXT = Buffer.from(
  "CASSA_V6-BT-AUTH-FINISH-V1\0",
  "utf8"
);

export class MutualAuthV1Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MutualAuthV1Error";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MutualAuthV1Error(code, message);
}

function canonicalIdentifierBytes(value, field) {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    fail(`INVALID_${field.toUpperCase()}`, `${field} has an invalid format`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 16 || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    fail(
      `INVALID_${field.toUpperCase()}`,
      `${field} must be canonical unpadded base64url`
    );
  }
  return decoded;
}

function normalizeUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(
      `INVALID_${field.toUpperCase()}`,
      `${field} must be a canonical lowercase UUID`
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

function exactBytes(value, length, field) {
  if (!(value instanceof Uint8Array)) {
    fail(`INVALID_${field.toUpperCase()}`, `${field} must be a byte array`);
  }
  const copy = Buffer.from(value);
  if (copy.byteLength !== length) {
    copy.fill(0);
    fail(
      `INVALID_${field.toUpperCase()}`,
      `${field} must contain exactly ${length} bytes`
    );
  }
  return copy;
}

function validateHeader(payload, expectedLength, expectedType, field) {
  const encoded = Buffer.from(payload);
  if (encoded.byteLength !== expectedLength) {
    fail(
      "INVALID_WIRE_LENGTH",
      `${field} wire payload must contain ${expectedLength} bytes`
    );
  }
  if (encoded[0] !== MUTUAL_AUTH_V1_PROTOCOL_VERSION) {
    fail(
      "PROTOCOL_VERSION_MISMATCH",
      `protocolVersion must be ${MUTUAL_AUTH_V1_PROTOCOL_VERSION}`
    );
  }
  if (encoded[1] !== expectedType) {
    fail("INVALID_MESSAGE_TYPE", `${field} has an invalid message type`);
  }
  return encoded;
}

function normalizeBinding(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_AUTH_BINDING", "auth binding must be an object");
  }
  const clientHello = normalizeHelloV1(value.clientHello);
  const serverHello = normalizeHelloV1(value.serverHello);
  const deviceCertificateId = normalizeUuid(
    value.deviceCertificateId,
    "deviceCertificateId"
  );
  if (
    clientHello.sessionId !== serverHello.sessionId ||
    clientHello.nodeId === serverHello.nodeId ||
    clientHello.nonce === serverHello.nonce ||
    (clientHello.capabilities & CAPABILITY_BITS.GATT_CLIENT) === 0 ||
    (serverHello.capabilities & CAPABILITY_BITS.GATT_SERVER) === 0
  ) {
    fail(
      "AUTH_BINDING_MISMATCH",
      "auth binding does not match one client and one server HELLO"
    );
  }
  return Object.freeze({
    clientHello,
    serverHello,
    deviceCertificateId
  });
}

function transcriptBytes(binding) {
  const normalized = normalizeBinding(binding);
  const clientHello = encodeHelloV1(normalized.clientHello);
  const serverHello = encodeHelloV1(normalized.serverHello);
  const certificateId = uuidToBytes(normalized.deviceCertificateId);
  return { normalized, clientHello, serverHello, certificateId };
}

export function normalizeMutualAuthBindingV1(value) {
  return normalizeBinding(value);
}

export function buildClientAuthProofMessageV1(binding) {
  const transcript = transcriptBytes(binding);
  try {
    return Buffer.concat([
      CLIENT_PROOF_CONTEXT,
      transcript.clientHello,
      transcript.serverHello,
      transcript.certificateId
    ]);
  } finally {
    transcript.clientHello.fill(0);
    transcript.serverHello.fill(0);
    transcript.certificateId.fill(0);
  }
}

export function buildServerAuthProofMessageV1(binding, clientSignature) {
  const signature = exactBytes(
    clientSignature,
    MUTUAL_AUTH_V1_SIGNATURE_BYTES,
    "clientSignature"
  );
  const transcript = transcriptBytes(binding);
  try {
    return Buffer.concat([
      SERVER_PROOF_CONTEXT,
      transcript.clientHello,
      transcript.serverHello,
      transcript.certificateId,
      signature
    ]);
  } finally {
    signature.fill(0);
    transcript.clientHello.fill(0);
    transcript.serverHello.fill(0);
    transcript.certificateId.fill(0);
  }
}

export function buildAuthFinishProofMessageV1(
  binding,
  clientSignature,
  serverProof
) {
  const signature = exactBytes(
    clientSignature,
    MUTUAL_AUTH_V1_SIGNATURE_BYTES,
    "clientSignature"
  );
  const proof = exactBytes(
    serverProof,
    MUTUAL_AUTH_V1_PROOF_BYTES,
    "serverProof"
  );
  const transcript = transcriptBytes(binding);
  try {
    return Buffer.concat([
      FINISH_PROOF_CONTEXT,
      transcript.clientHello,
      transcript.serverHello,
      transcript.certificateId,
      signature,
      proof
    ]);
  } finally {
    signature.fill(0);
    proof.fill(0);
    transcript.clientHello.fill(0);
    transcript.serverHello.fill(0);
    transcript.certificateId.fill(0);
  }
}

export function encodeAuthClientProofV1(value) {
  const sessionId = canonicalIdentifierBytes(value?.sessionId, "sessionId");
  const certificateId = uuidToBytes(
    normalizeUuid(value?.deviceCertificateId, "deviceCertificateId")
  );
  const signature = exactBytes(
    value?.signature,
    MUTUAL_AUTH_V1_SIGNATURE_BYTES,
    "signature"
  );
  const encoded = Buffer.alloc(MUTUAL_AUTH_V1_CLIENT_PROOF_WIRE_BYTES);
  try {
    encoded[0] = MUTUAL_AUTH_V1_PROTOCOL_VERSION;
    encoded[1] = MUTUAL_AUTH_V1_MESSAGE_TYPES.CLIENT_PROOF;
    sessionId.copy(encoded, 2);
    certificateId.copy(encoded, 18);
    signature.copy(encoded, 34);
    return encoded;
  } finally {
    sessionId.fill(0);
    certificateId.fill(0);
    signature.fill(0);
  }
}

export function decodeAuthClientProofV1(value) {
  const encoded = validateHeader(
    value,
    MUTUAL_AUTH_V1_CLIENT_PROOF_WIRE_BYTES,
    MUTUAL_AUTH_V1_MESSAGE_TYPES.CLIENT_PROOF,
    "client proof"
  );
  const sessionId = encoded.subarray(2, 18).toString("base64url");
  canonicalIdentifierBytes(sessionId, "sessionId").fill(0);
  return Object.freeze({
    protocolVersion: MUTUAL_AUTH_V1_PROTOCOL_VERSION,
    sessionId,
    deviceCertificateId: normalizeUuid(
      bytesToUuid(encoded.subarray(18, 34)),
      "deviceCertificateId"
    ),
    signature: Buffer.from(encoded.subarray(34, 98))
  });
}

export function encodeAuthServerProofV1(value) {
  const sessionId = canonicalIdentifierBytes(value?.sessionId, "sessionId");
  const certificateId = uuidToBytes(
    normalizeUuid(value?.deviceCertificateId, "deviceCertificateId")
  );
  const proof = exactBytes(
    value?.proof,
    MUTUAL_AUTH_V1_PROOF_BYTES,
    "proof"
  );
  const encoded = Buffer.alloc(MUTUAL_AUTH_V1_SERVER_PROOF_WIRE_BYTES);
  try {
    encoded[0] = MUTUAL_AUTH_V1_PROTOCOL_VERSION;
    encoded[1] = MUTUAL_AUTH_V1_MESSAGE_TYPES.SERVER_PROOF;
    sessionId.copy(encoded, 2);
    certificateId.copy(encoded, 18);
    proof.copy(encoded, 34);
    return encoded;
  } finally {
    sessionId.fill(0);
    certificateId.fill(0);
    proof.fill(0);
  }
}

export function decodeAuthServerProofV1(value) {
  const encoded = validateHeader(
    value,
    MUTUAL_AUTH_V1_SERVER_PROOF_WIRE_BYTES,
    MUTUAL_AUTH_V1_MESSAGE_TYPES.SERVER_PROOF,
    "server proof"
  );
  const sessionId = encoded.subarray(2, 18).toString("base64url");
  canonicalIdentifierBytes(sessionId, "sessionId").fill(0);
  return Object.freeze({
    protocolVersion: MUTUAL_AUTH_V1_PROTOCOL_VERSION,
    sessionId,
    deviceCertificateId: normalizeUuid(
      bytesToUuid(encoded.subarray(18, 34)),
      "deviceCertificateId"
    ),
    proof: Buffer.from(encoded.subarray(34, 66))
  });
}

export function encodeAuthFinishV1(value) {
  const sessionId = canonicalIdentifierBytes(value?.sessionId, "sessionId");
  const proof = exactBytes(
    value?.proof,
    MUTUAL_AUTH_V1_PROOF_BYTES,
    "proof"
  );
  const encoded = Buffer.alloc(MUTUAL_AUTH_V1_FINISH_WIRE_BYTES);
  try {
    encoded[0] = MUTUAL_AUTH_V1_PROTOCOL_VERSION;
    encoded[1] = MUTUAL_AUTH_V1_MESSAGE_TYPES.FINISH;
    sessionId.copy(encoded, 2);
    proof.copy(encoded, 18);
    return encoded;
  } finally {
    sessionId.fill(0);
    proof.fill(0);
  }
}

export function decodeAuthFinishV1(value) {
  const encoded = validateHeader(
    value,
    MUTUAL_AUTH_V1_FINISH_WIRE_BYTES,
    MUTUAL_AUTH_V1_MESSAGE_TYPES.FINISH,
    "auth finish"
  );
  const sessionId = encoded.subarray(2, 18).toString("base64url");
  canonicalIdentifierBytes(sessionId, "sessionId").fill(0);
  return Object.freeze({
    protocolVersion: MUTUAL_AUTH_V1_PROTOCOL_VERSION,
    sessionId,
    proof: Buffer.from(encoded.subarray(18, 50))
  });
}
