import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes
} from "node:crypto";

export const PEER_TRUST_DIRECTORY_VERSION = 1;
export const PEER_TRUST_DIRECTORY_KIND =
  "cassav6.bluetooth.peer-trust-directory";
export const PEER_TRUST_DIRECTORY_SIGNATURE_ALGORITHM =
  "ECDSA-P256-SHA256-P1363";
export const PEER_TRUST_DIRECTORY_CONTEXT =
  "CASSA_V6-BT-PEER-TRUST-DIRECTORY-V1\0";
export const PEER_TRUST_ID_CONTEXT = "CASSA_V6-BT-PEER-TRUST-ID-V1\0";
export const PEER_TRUST_ID_PATTERN = /^[0-9a-f]{64}$/;
export const PEER_TRUST_DIRECTORY_MAX_LIFETIME_MS = 86_400_000;
export const PEER_TRUST_DIRECTORY_FUTURE_SKEW_MS = 300_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISSUER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALIAS_PATTERN = /^[0-9a-f]{12}$/;
const KEY_ID_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;
const P256_SPKI_BYTES = 91;
const ED25519_SPKI_BYTES = 44;
const SIGNATURE_BYTES = 64;

export class PeerTrustDirectoryV1Error extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "PeerTrustDirectoryV1Error";
    this.code = code;
  }
}

function fail(code, message, cause = undefined) {
  throw new PeerTrustDirectoryV1Error(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function exactKeys(value, expected, field) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail("INVALID_STRUCTURE", `${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail("INVALID_STRUCTURE", `${field} has missing or unexpected fields`);
  }
}

function canonicalDate(value, field) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail("INVALID_DATE", `${field} must be canonical UTC with milliseconds`);
  }
  return value;
}

function integer(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_INTEGER", `${field} is outside its canonical range`);
  }
  return value;
}

function uuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("INVALID_UUID", `${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function decodeBase64(value, bytes, field) {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) {
    fail("INVALID_BASE64", `${field} must be canonical padded base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64") !== value) {
    decoded.fill(0);
    fail("INVALID_BASE64", `${field} has an invalid length or encoding`);
  }
  return decoded;
}

function normalizePublicKey(entry, field) {
  const algorithm = entry.publicKeyAlgorithm;
  const expectedBytes =
    algorithm === "EC-P256"
      ? P256_SPKI_BYTES
      : algorithm === "Ed25519"
        ? ED25519_SPKI_BYTES
        : fail("UNSUPPORTED_KEY_ALGORITHM", `${field} uses an unsupported key`);
  const der = decodeBase64(
    entry.publicKeySpkiDerBase64,
    expectedBytes,
    `${field}.publicKeySpkiDerBase64`
  );
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (
      (algorithm === "EC-P256" &&
        (key.asymmetricKeyType !== "ec" ||
          key.asymmetricKeyDetails?.namedCurve !== "prime256v1")) ||
      (algorithm === "Ed25519" && key.asymmetricKeyType !== "ed25519") ||
      !Buffer.from(key.export({ format: "der", type: "spki" })).equals(der)
    ) {
      fail("INVALID_PUBLIC_KEY", `${field} public key is not canonical`);
    }
  } catch (error) {
    if (error instanceof PeerTrustDirectoryV1Error) throw error;
    fail("INVALID_PUBLIC_KEY", `${field} public key is invalid`, error);
  } finally {
    der.fill(0);
  }
  return algorithm;
}

function normalizeEntry(entry, index, aliasEpoch) {
  const field = `devices[${index}]`;
  exactKeys(
    entry,
    [
      "nodeId",
      "certificateId",
      "publicKeyAlgorithm",
      "publicKeySpkiDerBase64",
      "status",
      "currentAlias",
      "nextAlias"
    ],
    field
  );
  const nodeId = uuid(entry.nodeId, `${field}.nodeId`);
  const certificateId = uuid(entry.certificateId, `${field}.certificateId`);
  const publicKeyAlgorithm = normalizePublicKey(entry, field);
  if (entry.status !== "ACTIVE" && entry.status !== "REVOKED") {
    fail("INVALID_STATUS", `${field}.status must be ACTIVE or REVOKED`);
  }
  const active = entry.status === "ACTIVE";
  for (const name of ["currentAlias", "nextAlias"]) {
    const value = entry[name];
    if ((active && (typeof value !== "string" || !ALIAS_PATTERN.test(value))) ||
        (!active && value !== null)) {
      fail(
        "INVALID_ALIAS",
        active
          ? `${field}.${name} must contain a canonical rotating alias`
          : `${field}.${name} must be null for a revoked peer`
      );
    }
  }
  if (active && entry.currentAlias === entry.nextAlias) {
    fail("INVALID_ALIAS", `${field} aliases must differ across epochs`);
  }
  integer(aliasEpoch, 0, Number.MAX_SAFE_INTEGER - 1, "aliasEpoch");
  return Object.freeze({
    nodeId,
    certificateId,
    publicKeyAlgorithm,
    publicKeySpkiDerBase64: entry.publicKeySpkiDerBase64,
    status: entry.status,
    currentAlias: entry.currentAlias,
    nextAlias: entry.nextAlias
  });
}

function normalizeUnsigned(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "issuerId",
      "revision",
      "issuedAt",
      "expiresAt",
      "aliasEpoch",
      "authorityKeyId",
      "signatureAlgorithm",
      "devices"
    ],
    "directory"
  );
  if (
    value.schemaVersion !== PEER_TRUST_DIRECTORY_VERSION ||
    value.kind !== PEER_TRUST_DIRECTORY_KIND ||
    value.signatureAlgorithm !== PEER_TRUST_DIRECTORY_SIGNATURE_ALGORITHM
  ) {
    fail("PROTOCOL_MISMATCH", "peer trust directory version or algorithm mismatch");
  }
  if (typeof value.issuerId !== "string" || !ISSUER_PATTERN.test(value.issuerId)) {
    fail("INVALID_ISSUER", "issuerId has an invalid format");
  }
  const revision = integer(value.revision, 1, Number.MAX_SAFE_INTEGER, "revision");
  const aliasEpoch = integer(
    value.aliasEpoch,
    0,
    Number.MAX_SAFE_INTEGER - 1,
    "aliasEpoch"
  );
  const issuedAt = canonicalDate(value.issuedAt, "issuedAt");
  const expiresAt = canonicalDate(value.expiresAt, "expiresAt");
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  if (
    expiresMs <= issuedMs ||
    expiresMs - issuedMs > PEER_TRUST_DIRECTORY_MAX_LIFETIME_MS
  ) {
    fail("INVALID_LIFETIME", "directory lifetime must be positive and at most 24 hours");
  }
  if (typeof value.authorityKeyId !== "string" || !KEY_ID_PATTERN.test(value.authorityKeyId)) {
    fail("INVALID_AUTHORITY_KEY_ID", "authorityKeyId must be a SHA-256 hex digest");
  }
  if (!Array.isArray(value.devices) || value.devices.length > 256) {
    fail("INVALID_DEVICE_LIST", "devices must contain at most 256 entries");
  }
  const devices = value.devices.map((entry, index) =>
    normalizeEntry(entry, index, aliasEpoch)
  );
  const nodeIds = new Set();
  const certificateIds = new Set();
  const publicKeys = new Set();
  let previous = "";
  for (const entry of devices) {
    if (entry.nodeId <= previous) {
      fail("NON_CANONICAL_ORDER", "devices must be strictly sorted by nodeId");
    }
    previous = entry.nodeId;
    if (
      nodeIds.has(entry.nodeId) ||
      certificateIds.has(entry.certificateId) ||
      publicKeys.has(entry.publicKeySpkiDerBase64)
    ) {
      fail("DUPLICATE_DEVICE", "device identity fields must be unique");
    }
    nodeIds.add(entry.nodeId);
    certificateIds.add(entry.certificateId);
    publicKeys.add(entry.publicKeySpkiDerBase64);
  }
  return Object.freeze({
    schemaVersion: PEER_TRUST_DIRECTORY_VERSION,
    kind: PEER_TRUST_DIRECTORY_KIND,
    issuerId: value.issuerId,
    revision,
    issuedAt,
    expiresAt,
    aliasEpoch,
    authorityKeyId: value.authorityKeyId,
    signatureAlgorithm: PEER_TRUST_DIRECTORY_SIGNATURE_ALGORITHM,
    devices: Object.freeze(devices)
  });
}

export function canonicalPeerTrustDirectoryPayloadV1(value) {
  return JSON.stringify(normalizeUnsigned(value));
}

export function peerTrustDirectorySigningMessageV1(value) {
  return Buffer.concat([
    Buffer.from(PEER_TRUST_DIRECTORY_CONTEXT, "utf8"),
    Buffer.from(canonicalPeerTrustDirectoryPayloadV1(value), "utf8")
  ]);
}

function scalar(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function scalarBytes(value) {
  const output = Buffer.alloc(32);
  let remaining = value;
  for (let index = 31; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function canonicalSignature(value) {
  const signature = Buffer.from(value);
  if (signature.byteLength !== SIGNATURE_BYTES) {
    signature.fill(0);
    fail("INVALID_SIGNATURE", "signature must contain 64 P1363 bytes");
  }
  const r = scalar(signature.subarray(0, 32));
  let s = scalar(signature.subarray(32));
  if (r <= 0n || r >= P256_ORDER || s <= 0n || s >= P256_ORDER) {
    signature.fill(0);
    fail("INVALID_SIGNATURE", "signature contains an invalid P-256 scalar");
  }
  if (s > P256_HALF_ORDER) {
    s = P256_ORDER - s;
    scalarBytes(s).copy(signature, 32);
  }
  return signature;
}

function requireCanonicalSignature(value) {
  const decoded = decodeBase64(value, SIGNATURE_BYTES, "signatureBase64");
  const canonical = canonicalSignature(decoded);
  if (!timingSafeEqual(decoded, canonical)) {
    decoded.fill(0);
    canonical.fill(0);
    fail("NON_CANONICAL_SIGNATURE", "signature must use canonical low-S P1363");
  }
  canonical.fill(0);
  return decoded;
}

function normalizeAuthorityPublicKey(value) {
  const publicKey =
    value instanceof Uint8Array
      ? createPublicKey({ key: Buffer.from(value), format: "der", type: "spki" })
      : value?.type === "public"
        ? value
        : createPublicKey(value);
  const der = Buffer.from(
    publicKey.export({ format: "der", type: "spki" })
  );
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (
      der.byteLength !== P256_SPKI_BYTES ||
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      fail("INVALID_AUTHORITY_KEY", "authority key must be canonical P-256 SPKI");
    }
    return { key, der };
  } catch (error) {
    der.fill(0);
    if (error instanceof PeerTrustDirectoryV1Error) throw error;
    fail("INVALID_AUTHORITY_KEY", "authority public key is invalid", error);
  }
}

export function peerTrustAuthorityKeyIdV1(publicKey) {
  const normalized = normalizeAuthorityPublicKey(publicKey);
  try {
    return createHash("sha256").update(normalized.der).digest("hex");
  } finally {
    normalized.der.fill(0);
  }
}

export function derivePeerTrustIdV1(
  nodeId,
  certificateId,
  publicKeyAlgorithm,
  publicKeySpkiDer
) {
  const node = Buffer.from(uuid(nodeId, "nodeId").replaceAll("-", ""), "hex");
  const certificate = Buffer.from(
    uuid(certificateId, "certificateId").replaceAll("-", ""),
    "hex"
  );
  const spki = Buffer.from(publicKeySpkiDer);
  const expectedLength =
    publicKeyAlgorithm === "EC-P256"
      ? P256_SPKI_BYTES
      : publicKeyAlgorithm === "Ed25519"
        ? ED25519_SPKI_BYTES
        : fail("UNSUPPORTED_KEY_ALGORITHM", "publicKeyAlgorithm is unsupported");
  if (spki.byteLength !== expectedLength) {
    spki.fill(0);
    fail("INVALID_PUBLIC_KEY", "peer trust public key length is invalid");
  }
  normalizePublicKey(
    {
      publicKeyAlgorithm,
      publicKeySpkiDerBase64: spki.toString("base64")
    },
    "peerTrustId"
  );
  const context = Buffer.from(PEER_TRUST_ID_CONTEXT, "utf8");
  const algorithm = Buffer.from(`${publicKeyAlgorithm}\0`, "utf8");
  try {
    return createHash("sha256")
      .update(context)
      .update(node)
      .update(certificate)
      .update(algorithm)
      .update(spki)
      .digest("hex");
  } finally {
    context.fill(0);
    node.fill(0);
    certificate.fill(0);
    algorithm.fill(0);
    spki.fill(0);
  }
}

export function isPeerTrustIdV1(value) {
  return typeof value === "string" && PEER_TRUST_ID_PATTERN.test(value);
}

export function signPeerTrustDirectoryV1(unsignedDirectory, privateKey) {
  let authorityPrivateKey;
  try {
    authorityPrivateKey =
      privateKey?.type === "private" ? privateKey : createPrivateKey(privateKey);
  } catch (error) {
    fail("INVALID_AUTHORITY_KEY", "authority private key is invalid", error);
  }
  if (
    authorityPrivateKey.asymmetricKeyType !== "ec" ||
    authorityPrivateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    fail("INVALID_AUTHORITY_KEY", "authority private key must use P-256");
  }
  const authorityKeyId = peerTrustAuthorityKeyIdV1(
    createPublicKey(authorityPrivateKey)
  );
  const normalized = normalizeUnsigned({ ...unsignedDirectory, authorityKeyId });
  const message = peerTrustDirectorySigningMessageV1(normalized);
  let raw;
  let signature;
  try {
    raw = signBytes("sha256", message, {
      key: authorityPrivateKey,
      dsaEncoding: "ieee-p1363"
    });
    signature = canonicalSignature(raw);
    return Object.freeze({
      ...normalized,
      signatureBase64: signature.toString("base64")
    });
  } finally {
    message.fill(0);
    raw?.fill(0);
    signature?.fill(0);
  }
}

export function encodePeerTrustDirectoryV1(value) {
  exactKeys(
    value,
    [
      "schemaVersion", "kind", "issuerId", "revision", "issuedAt",
      "expiresAt", "aliasEpoch", "authorityKeyId", "signatureAlgorithm",
      "devices", "signatureBase64"
    ],
    "signed directory"
  );
  const { signatureBase64, ...unsigned } = value;
  const normalized = normalizeUnsigned(unsigned);
  const signature = requireCanonicalSignature(value.signatureBase64);
  try {
    return Buffer.from(
      JSON.stringify({ ...normalized, signatureBase64: signature.toString("base64") }),
      "utf8"
    );
  } finally {
    signature.fill(0);
  }
}

export function verifyPeerTrustDirectoryV1(
  wire,
  authorityPublicKey,
  { now = new Date(), minimumRevision = 0 } = {}
) {
  const bytes = Buffer.from(wire);
  if (bytes.byteLength < 1 || bytes.byteLength > 262_144) {
    fail("INVALID_WIRE", "directory payload size is outside its limit");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("INVALID_JSON", "directory payload is not valid JSON", error);
  }
  const canonicalWire = encodePeerTrustDirectoryV1(parsed);
  if (!bytes.equals(canonicalWire)) {
    canonicalWire.fill(0);
    fail("NON_CANONICAL_WIRE", "directory must use the canonical JSON encoding");
  }
  canonicalWire.fill(0);
  const { signatureBase64: _signatureBase64, ...unsigned } = parsed;
  const normalized = normalizeUnsigned(unsigned);
  const instant = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(instant.getTime())) fail("INVALID_CLOCK", "clock is invalid");
  if (Date.parse(normalized.issuedAt) > instant.getTime() + PEER_TRUST_DIRECTORY_FUTURE_SKEW_MS) {
    fail("DIRECTORY_NOT_YET_VALID", "directory issue time is in the future");
  }
  if (Date.parse(normalized.expiresAt) <= instant.getTime()) {
    fail("DIRECTORY_EXPIRED", "directory has expired");
  }
  integer(minimumRevision, 0, Number.MAX_SAFE_INTEGER, "minimumRevision");
  if (normalized.revision < minimumRevision) {
    fail("REVISION_ROLLBACK", "directory revision regressed");
  }
  const authority = normalizeAuthorityPublicKey(authorityPublicKey);
  const expectedKeyId = createHash("sha256").update(authority.der).digest("hex");
  authority.der.fill(0);
  if (normalized.authorityKeyId !== expectedKeyId) {
    fail("AUTHORITY_KEY_MISMATCH", "directory is signed by another authority");
  }
  const signature = requireCanonicalSignature(parsed.signatureBase64);
  const message = peerTrustDirectorySigningMessageV1(normalized);
  try {
    if (!verifyBytes("sha256", message, {
      key: authority.key,
      dsaEncoding: "ieee-p1363"
    }, signature)) {
      fail("SIGNATURE_INVALID", "directory signature is invalid");
    }
  } finally {
    signature.fill(0);
    message.fill(0);
  }
  return Object.freeze({ ...normalized, signatureBase64: parsed.signatureBase64 });
}
