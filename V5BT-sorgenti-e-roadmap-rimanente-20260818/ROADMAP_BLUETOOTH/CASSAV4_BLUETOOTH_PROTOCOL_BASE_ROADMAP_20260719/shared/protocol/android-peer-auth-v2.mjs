import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  timingSafeEqual,
  verify as verifySignature
} from "node:crypto";

import { encodeHelloV1, normalizeHelloV1 } from "./hello-v1.mjs";

export const ANDROID_PEER_AUTH_V2_VERSION = 2;
export const ANDROID_PEER_AUTH_V2_MINIMUM_MTU = 193;
export const ANDROID_PEER_AUTH_V2_TYPES = Object.freeze({
  CLIENT_INIT: 1,
  SERVER_REPLY: 2,
  CLIENT_FINISH: 3
});
export const ANDROID_PEER_AUTH_V2_CLIENT_INIT_BYTES = 158;
export const ANDROID_PEER_AUTH_V2_SERVER_REPLY_BYTES = 190;
export const ANDROID_PEER_AUTH_V2_CLIENT_FINISH_BYTES = 50;

export const ANDROID_PEER_AUTH_V2_CONTEXTS = Object.freeze({
  BINDING: "CASSAV5BT-BT-ANDROID-A2-BINDING-V2\0",
  CLIENT_SIGNATURE: "CASSAV5BT-BT-ANDROID-A2-CLIENT-SIGN-V2\0",
  SERVER_SIGNATURE: "CASSAV5BT-BT-ANDROID-A2-SERVER-SIGN-V2\0",
  TRANSCRIPT: "CASSAV5BT-BT-ANDROID-A2-TRANSCRIPT-V2\0",
  HKDF: "CASSAV5BT-BT-ANDROID-A2-KEYS-V2\0",
  SERVER_CONFIRM: "CASSAV5BT-BT-ANDROID-A2-SERVER-CONFIRM-V2\0",
  CLIENT_CONFIRM: "CASSAV5BT-BT-ANDROID-A2-CLIENT-CONFIRM-V2\0"
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALIAS_PATTERN = /^[0-9a-f]{12}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;

export class AndroidPeerAuthV2Error extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "AndroidPeerAuthV2Error";
    this.code = code;
  }
}

function fail(code, message, cause = undefined) {
  throw new AndroidPeerAuthV2Error(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function uuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("INVALID_BINDING", `${field} must be a canonical UUID`);
  }
  return value;
}

function uuidBytes(value, field) {
  return Buffer.from(uuid(value, field).replaceAll("-", ""), "hex");
}

function bytesUuid(value) {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function exactBytes(value, length, field) {
  if (!(value instanceof Uint8Array)) {
    fail("INVALID_WIRE", `${field} must be bytes`);
  }
  const copy = Buffer.from(value);
  if (copy.byteLength !== length) {
    copy.fill(0);
    fail("INVALID_WIRE", `${field} must contain ${length} bytes`);
  }
  return copy;
}

function sessionBytes(value) {
  if (typeof value !== "string" || !SESSION_PATTERN.test(value)) {
    fail("INVALID_SESSION", "sessionId is invalid");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 16 || bytes.toString("base64url") !== value) {
    bytes.fill(0);
    fail("INVALID_SESSION", "sessionId is non-canonical");
  }
  return bytes;
}

function x25519Spki(value, field) {
  const bytes = exactBytes(value, 44, field);
  if (!bytes.subarray(0, 12).equals(X25519_PREFIX)) {
    bytes.fill(0);
    fail("INVALID_EPHEMERAL_KEY", `${field} is not canonical X25519 SPKI`);
  }
  return bytes;
}

function signature(value, field) {
  return exactBytes(value, 64, field);
}

function confirmation(value, field) {
  return exactBytes(value, 32, field);
}

function normalizeBinding(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_BINDING", "binding must be an object");
  }
  const clientHello = normalizeHelloV1(value.clientHello);
  const serverHello = normalizeHelloV1(value.serverHello);
  if (
    clientHello.sessionId !== serverHello.sessionId ||
    clientHello.nodeId === serverHello.nodeId ||
    clientHello.nonce === serverHello.nonce
  ) {
    fail("INVALID_BINDING", "HELLO pair is not one session with distinct peers");
  }
  const clientCertificateId = uuid(value.clientCertificateId, "clientCertificateId");
  const serverCertificateId = uuid(value.serverCertificateId, "serverCertificateId");
  if (clientCertificateId === serverCertificateId) {
    fail("INVALID_BINDING", "peer certificates must differ");
  }
  if (!Number.isSafeInteger(value.aliasEpoch) || value.aliasEpoch < 0) {
    fail("INVALID_BINDING", "aliasEpoch is invalid");
  }
  if (
    typeof value.clientAlias !== "string" ||
    typeof value.serverAlias !== "string" ||
    !ALIAS_PATTERN.test(value.clientAlias) ||
    !ALIAS_PATTERN.test(value.serverAlias) ||
    value.clientAlias === value.serverAlias ||
    value.clientRole !== "CLIENT" ||
    value.serverRole !== "SERVER"
  ) {
    fail("INVALID_BINDING", "alias or role binding is invalid");
  }
  const orderedNodeIds = [clientHello.nodeId, serverHello.nodeId].sort();
  return Object.freeze({
    clientHello,
    serverHello,
    clientCertificateId,
    serverCertificateId,
    aliasEpoch: value.aliasEpoch,
    clientAlias: value.clientAlias,
    serverAlias: value.serverAlias,
    clientRole: "CLIENT",
    serverRole: "SERVER",
    orderedNodeIds: Object.freeze(orderedNodeIds)
  });
}

export function normalizeAndroidPeerAuthBindingV2(value) {
  return normalizeBinding(value);
}

function bindingBytes(value) {
  const binding = normalizeBinding(value);
  const clientHello = encodeHelloV1(binding.clientHello);
  const serverHello = encodeHelloV1(binding.serverHello);
  const clientCertificate = uuidBytes(binding.clientCertificateId, "clientCertificateId");
  const serverCertificate = uuidBytes(binding.serverCertificateId, "serverCertificateId");
  const lowNode = uuidBytes(binding.orderedNodeIds[0], "orderedNodeIds[0]");
  const highNode = uuidBytes(binding.orderedNodeIds[1], "orderedNodeIds[1]");
  const epoch = Buffer.alloc(8);
  epoch.writeBigUInt64BE(BigInt(binding.aliasEpoch));
  const aliases = Buffer.from(binding.clientAlias + binding.serverAlias, "hex");
  const roles = Buffer.from("CLIENT\0SERVER\0", "utf8");
  const context = Buffer.from(ANDROID_PEER_AUTH_V2_CONTEXTS.BINDING, "utf8");
  try {
    return Buffer.concat([
      context, clientHello, serverHello, clientCertificate, serverCertificate,
      lowNode, highNode, epoch, aliases, roles
    ]);
  } finally {
    context.fill(0);
    clientHello.fill(0);
    serverHello.fill(0);
    clientCertificate.fill(0);
    serverCertificate.fill(0);
    lowNode.fill(0);
    highNode.fill(0);
    epoch.fill(0);
    aliases.fill(0);
    roles.fill(0);
  }
}

export function buildAndroidPeerClientSignatureMessageV2(binding, clientEphemeralSpki) {
  const bound = bindingBytes(binding);
  const ephemeral = x25519Spki(clientEphemeralSpki, "clientEphemeralSpki");
  const context = Buffer.from(ANDROID_PEER_AUTH_V2_CONTEXTS.CLIENT_SIGNATURE, "utf8");
  try {
    return Buffer.concat([context, bound, ephemeral]);
  } finally {
    context.fill(0);
    bound.fill(0);
    ephemeral.fill(0);
  }
}

export function buildAndroidPeerServerSignatureMessageV2(
  binding,
  clientEphemeralSpki,
  clientSignature,
  serverEphemeralSpki
) {
  const bound = bindingBytes(binding);
  const clientKey = x25519Spki(clientEphemeralSpki, "clientEphemeralSpki");
  const clientProof = signature(clientSignature, "clientSignature");
  const serverKey = x25519Spki(serverEphemeralSpki, "serverEphemeralSpki");
  const context = Buffer.from(ANDROID_PEER_AUTH_V2_CONTEXTS.SERVER_SIGNATURE, "utf8");
  try {
    return Buffer.concat([context, bound, clientKey, clientProof, serverKey]);
  } finally {
    context.fill(0);
    bound.fill(0);
    clientKey.fill(0);
    clientProof.fill(0);
    serverKey.fill(0);
  }
}

export function buildAndroidPeerAuthTranscriptHashV2(
  binding,
  clientEphemeralSpki,
  clientSignature,
  serverEphemeralSpki,
  serverSignature
) {
  const serverMessage = buildAndroidPeerServerSignatureMessageV2(
    binding,
    clientEphemeralSpki,
    clientSignature,
    serverEphemeralSpki
  );
  const serverProof = signature(serverSignature, "serverSignature");
  const context = Buffer.from(ANDROID_PEER_AUTH_V2_CONTEXTS.TRANSCRIPT, "utf8");
  try {
    return createHash("sha256")
      .update(context)
      .update(serverMessage)
      .update(serverProof)
      .digest();
  } finally {
    context.fill(0);
    serverMessage.fill(0);
    serverProof.fill(0);
  }
}

function encodeCommon(value, type, size, key, proof, confirm = null) {
  const bindingSession = sessionBytes(value.sessionId);
  const clientCertificate = uuidBytes(value.clientCertificateId, "clientCertificateId");
  const serverCertificate = uuidBytes(value.serverCertificateId, "serverCertificateId");
  const ephemeral = x25519Spki(key, "ephemeralSpki");
  const signatureBytes = signature(proof, "signature");
  const confirmationBytes = confirm === null ? null : confirmation(confirm, "confirmation");
  const output = Buffer.alloc(size);
  try {
    output[0] = ANDROID_PEER_AUTH_V2_VERSION;
    output[1] = type;
    bindingSession.copy(output, 2);
    clientCertificate.copy(output, 18);
    serverCertificate.copy(output, 34);
    ephemeral.copy(output, 50);
    signatureBytes.copy(output, 94);
    confirmationBytes?.copy(output, 158);
    return output;
  } finally {
    bindingSession.fill(0);
    clientCertificate.fill(0);
    serverCertificate.fill(0);
    ephemeral.fill(0);
    signatureBytes.fill(0);
    confirmationBytes?.fill(0);
  }
}

export function encodeAndroidPeerClientInitV2(value) {
  return encodeCommon(
    value,
    ANDROID_PEER_AUTH_V2_TYPES.CLIENT_INIT,
    ANDROID_PEER_AUTH_V2_CLIENT_INIT_BYTES,
    value.clientEphemeralSpki,
    value.clientSignature
  );
}

export function encodeAndroidPeerServerReplyV2(value) {
  return encodeCommon(
    value,
    ANDROID_PEER_AUTH_V2_TYPES.SERVER_REPLY,
    ANDROID_PEER_AUTH_V2_SERVER_REPLY_BYTES,
    value.serverEphemeralSpki,
    value.serverSignature,
    value.serverConfirmation
  );
}

function decodeCommon(value, expectedType, expectedSize, server) {
  const wire = exactBytes(value, expectedSize, "wire");
  if (wire[0] !== ANDROID_PEER_AUTH_V2_VERSION || wire[1] !== expectedType) {
    fail("PROTOCOL_MISMATCH", "A2 message version or type mismatch");
  }
  const sessionId = wire.subarray(2, 18).toString("base64url");
  sessionBytes(sessionId).fill(0);
  const output = {
    protocolVersion: ANDROID_PEER_AUTH_V2_VERSION,
    sessionId,
    clientCertificateId: uuid(bytesUuid(wire.subarray(18, 34)), "clientCertificateId"),
    serverCertificateId: uuid(bytesUuid(wire.subarray(34, 50)), "serverCertificateId")
  };
  return Object.freeze(server
    ? {
        ...output,
        serverEphemeralSpki: Buffer.from(wire.subarray(50, 94)),
        serverSignature: Buffer.from(wire.subarray(94, 158)),
        serverConfirmation: Buffer.from(wire.subarray(158, 190))
      }
    : {
        ...output,
        clientEphemeralSpki: Buffer.from(wire.subarray(50, 94)),
        clientSignature: Buffer.from(wire.subarray(94, 158))
      });
}

export function decodeAndroidPeerClientInitV2(value) {
  return decodeCommon(
    value,
    ANDROID_PEER_AUTH_V2_TYPES.CLIENT_INIT,
    ANDROID_PEER_AUTH_V2_CLIENT_INIT_BYTES,
    false
  );
}

export function decodeAndroidPeerServerReplyV2(value) {
  return decodeCommon(
    value,
    ANDROID_PEER_AUTH_V2_TYPES.SERVER_REPLY,
    ANDROID_PEER_AUTH_V2_SERVER_REPLY_BYTES,
    true
  );
}

export function encodeAndroidPeerClientFinishV2(value) {
  const session = sessionBytes(value.sessionId);
  const proof = confirmation(value.clientConfirmation, "clientConfirmation");
  const output = Buffer.alloc(ANDROID_PEER_AUTH_V2_CLIENT_FINISH_BYTES);
  try {
    output[0] = ANDROID_PEER_AUTH_V2_VERSION;
    output[1] = ANDROID_PEER_AUTH_V2_TYPES.CLIENT_FINISH;
    session.copy(output, 2);
    proof.copy(output, 18);
    return output;
  } finally {
    session.fill(0);
    proof.fill(0);
  }
}

export function decodeAndroidPeerClientFinishV2(value) {
  const wire = exactBytes(value, ANDROID_PEER_AUTH_V2_CLIENT_FINISH_BYTES, "wire");
  if (
    wire[0] !== ANDROID_PEER_AUTH_V2_VERSION ||
    wire[1] !== ANDROID_PEER_AUTH_V2_TYPES.CLIENT_FINISH
  ) {
    fail("PROTOCOL_MISMATCH", "A2 client finish version or type mismatch");
  }
  const sessionId = wire.subarray(2, 18).toString("base64url");
  sessionBytes(sessionId).fill(0);
  return Object.freeze({
    protocolVersion: ANDROID_PEER_AUTH_V2_VERSION,
    sessionId,
    clientConfirmation: Buffer.from(wire.subarray(18, 50))
  });
}

export function createAndroidPeerEphemeralV2() {
  const pair = generateKeyPairSync("x25519");
  return Object.freeze({
    privateKey: pair.privateKey,
    publicKeySpki: Buffer.from(pair.publicKey.export({ format: "der", type: "spki" }))
  });
}

export function computeAndroidPeerSharedSecretV2(privateKey, peerPublicKeySpki) {
  const spki = x25519Spki(peerPublicKeySpki, "peerPublicKeySpki");
  try {
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    const secret = Buffer.from(diffieHellman({ privateKey, publicKey }));
    if (secret.byteLength !== 32 || secret.every((value) => value === 0)) {
      secret.fill(0);
      fail("KEY_AGREEMENT_FAILED", "X25519 produced invalid material");
    }
    return secret;
  } catch (error) {
    if (error instanceof AndroidPeerAuthV2Error) throw error;
    fail("KEY_AGREEMENT_FAILED", "X25519 failed", error);
  } finally {
    spki.fill(0);
  }
}

export function verifyAndroidPeerIdentitySignatureV2(
  publicKeyAlgorithm,
  publicKeySpki,
  message,
  signatureValue
) {
  const signatureBytes = signature(signatureValue, "signature");
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(publicKeySpki), format: "der", type: "spki" });
    if (publicKeyAlgorithm === "EC-P256") {
      const r = scalar(signatureBytes.subarray(0, 32));
      const s = scalar(signatureBytes.subarray(32));
      if (
        key.asymmetricKeyType !== "ec" ||
        key.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
        r <= 0n || r >= P256_ORDER || s <= 0n || s > P256_HALF_ORDER
      ) return false;
      return verifySignature("sha256", message, {
        key,
        dsaEncoding: "ieee-p1363"
      }, signatureBytes);
    }
    if (publicKeyAlgorithm === "Ed25519" && key.asymmetricKeyType === "ed25519") {
      return verifySignature(null, message, key, signatureBytes);
    }
    return false;
  } catch {
    return false;
  } finally {
    signatureBytes.fill(0);
  }
}

function scalar(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export class AndroidPeerAuthKeyScheduleV2 {
  #clientToServer;
  #serverToClient;
  #clientConfirmation;
  #serverConfirmation;
  #transcriptHash;
  #confirmed = false;
  #closed = false;

  constructor(sharedSecret, transcriptHash) {
    const secret = exactBytes(sharedSecret, 32, "sharedSecret");
    const transcript = exactBytes(transcriptHash, 32, "transcriptHash");
    const info = Buffer.concat([
      Buffer.from(ANDROID_PEER_AUTH_V2_CONTEXTS.HKDF, "utf8"),
      transcript
    ]);
    let material;
    try {
      material = Buffer.from(hkdfSync("sha256", secret, transcript, info, 128));
      this.#clientToServer = Buffer.from(material.subarray(0, 32));
      this.#serverToClient = Buffer.from(material.subarray(32, 64));
      this.#clientConfirmation = Buffer.from(material.subarray(64, 96));
      this.#serverConfirmation = Buffer.from(material.subarray(96, 128));
      this.#transcriptHash = transcript;
    } finally {
      secret.fill(0);
      info.fill(0);
      material?.fill(0);
    }
  }

  createServerConfirmation() {
    this.#requireOpen();
    return this.#mac(
      this.#serverConfirmation,
      ANDROID_PEER_AUTH_V2_CONTEXTS.SERVER_CONFIRM,
      this.#transcriptHash
    );
  }

  verifyServerConfirmation(value) {
    this.#requireOpen();
    const candidate = confirmation(value, "serverConfirmation");
    const expected = this.createServerConfirmation();
    try {
      return timingSafeEqual(candidate, expected);
    } finally {
      candidate.fill(0);
      expected.fill(0);
    }
  }

  createClientConfirmation(serverConfirmation) {
    this.#requireOpen();
    const server = confirmation(serverConfirmation, "serverConfirmation");
    let message;
    try {
      message = Buffer.concat([this.#transcriptHash, server]);
      return this.#mac(
        this.#clientConfirmation,
        ANDROID_PEER_AUTH_V2_CONTEXTS.CLIENT_CONFIRM,
        message
      );
    } finally {
      server.fill(0);
      message?.fill(0);
    }
  }

  verifyClientConfirmation(serverConfirmation, clientConfirmation) {
    this.#requireOpen();
    const candidate = confirmation(clientConfirmation, "clientConfirmation");
    const expected = this.createClientConfirmation(serverConfirmation);
    try {
      const valid = timingSafeEqual(candidate, expected);
      if (valid) this.#confirmed = true;
      return valid;
    } finally {
      candidate.fill(0);
      expected.fill(0);
    }
  }

  confirmClientFinishTransmitted() {
    this.#requireOpen();
    this.#confirmed = true;
  }

  exportReliableChannelControlKeys() {
    this.#requireOpen();
    if (!this.#confirmed) {
      fail("CONFIRMATION_REQUIRED", "A2 material is unavailable before confirmation");
    }
    return Object.freeze({
      clientToServerControlKey: Buffer.from(this.#clientToServer),
      serverToClientControlKey: Buffer.from(this.#serverToClient)
    });
  }

  close() {
    if (this.#closed) return;
    for (const key of [
      this.#clientToServer,
      this.#serverToClient,
      this.#clientConfirmation,
      this.#serverConfirmation,
      this.#transcriptHash
    ]) key?.fill(0);
    this.#closed = true;
    this.#confirmed = false;
  }

  #mac(key, context, message) {
    return createHmac("sha256", key)
      .update(context, "utf8")
      .update(message)
      .digest();
  }

  #requireOpen() {
    if (this.#closed) fail("KEY_MATERIAL_CLEARED", "A2 material has been cleared");
  }

  toString() {
    return `AndroidPeerAuthKeyScheduleV2(confirmed=${this.#confirmed}, material=<redacted>)`;
  }
}
