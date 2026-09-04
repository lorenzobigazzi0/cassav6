import { constants as fsConstants } from "node:fs";
import {
  createHmac,
  createHash,
  createPublicKey,
  randomBytes as cryptoRandomBytes,
  randomUUID as cryptoRandomUUID,
  timingSafeEqual,
  verify as verifySignature
} from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";

import { deriveRotatingAlias } from "../protocol/rotating-alias-v1.mjs";

export const DEVICE_REGISTRY_SCHEMA_VERSION = 2;
export const DEVICE_REGISTRY_KIND = "cassav5bt.bluetooth.device-registry";
export const ENROLLMENT_QR_VERSION = 2;
export const ALIAS_KEY_BYTES = 32;
export const ENROLLMENT_TOKEN_BYTES = 32;
export const DEFAULT_ENROLLMENT_TTL_SECONDS = 600;
export const MAX_ENROLLMENT_TTL_SECONDS = 86400;
export const ENROLLMENT_RESPONSE_RECOVERY_SECONDS = 600;

const REQUIRED_FILE_MODE = 0o600;
const LEGACY_DEVICE_REGISTRY_SCHEMA_VERSION = 1;
const LEGACY_DEVICE_REGISTRY_KIND = "cassav4.bluetooth.device-registry";
const ED25519_PUBLIC_KEY_ALGORITHM = "Ed25519";
const ECDSA_P256_PUBLIC_KEY_ALGORITHM = "EC-P256";
const SUPPORTED_PUBLIC_KEY_ALGORITHMS = new Set([
  ED25519_PUBLIC_KEY_ALGORITHM,
  ECDSA_P256_PUBLIC_KEY_ALGORITHM
]);
const ENROLLMENT_PROTOCOL_V1 = 1;
const ENROLLMENT_PROTOCOL_V2 = 2;
const SUPPORTED_ENROLLMENT_PROTOCOLS = new Set([
  ENROLLMENT_PROTOCOL_V1,
  ENROLLMENT_PROTOCOL_V2
]);
const TOKEN_PREFIXES = Object.freeze({
  [ENROLLMENT_PROTOCOL_V1]: "c5e1_",
  [ENROLLMENT_PROTOCOL_V2]: "c5e2_"
});
const TOKEN_HASH_CONTEXTS = Object.freeze({
  [ENROLLMENT_PROTOCOL_V1]: "CASSAV4-BT-ENROLLMENT-TOKEN-V1\0",
  [ENROLLMENT_PROTOCOL_V2]: "CASSAV5BT-BT-ENROLLMENT-TOKEN-V2\0"
});
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENROLLMENT_TOKEN_PATTERN =
  /^c5e[12]_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const ED25519_SIGNATURE_BYTES = 64;
const ECDSA_P256_SIGNATURE_BYTES = 64;
const ED25519_SPKI_BYTES = 44;
const ECDSA_P256_SPKI_BYTES = 91;
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;
const AUTH_PROOF_BYTES = 32;
const MAX_AUTH_MESSAGE_BYTES = 4096;

export class DeviceRegistryError extends Error {
  constructor(code, message, options = undefined) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "DeviceRegistryError";
    this.code = code;
    this.registryCommitted = options?.registryCommitted === true;
  }
}

function registryError(
  code,
  message,
  cause = undefined,
  registryCommitted = false
) {
  return new DeviceRegistryError(
    code,
    message,
    { cause, registryCommitted }
  );
}

function clone(value) {
  return structuredClone(value);
}

function normalizeDate(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw registryError("INVALID_CLOCK", "The registry clock returned an invalid date");
  }
  return date;
}

function normalizeUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw registryError("INVALID_NODE_ID", `${field} must be an RFC 4122 UUID`);
  }
  return value.toLowerCase();
}

function assertStoredUuid(value, field) {
  const normalized = normalizeUuid(value, field);
  if (value !== normalized) {
    throw registryError(
      "CORRUPT_REGISTRY",
      `${field} must use canonical lowercase UUID text`
    );
  }
  return normalized;
}

function normalizeEndpointId(value) {
  if (typeof value !== "string" || !ENDPOINT_ID_PATTERN.test(value)) {
    throw registryError(
      "INVALID_ENROLLMENT_ENDPOINT",
      "enrollmentEndpointId must contain 1-128 technical identifier characters"
    );
  }
  return value;
}

function normalizeEnrollmentProtocolVersion(value) {
  if (!SUPPORTED_ENROLLMENT_PROTOCOLS.has(value)) {
    throw registryError(
      "INVALID_ENROLLMENT_PROTOCOL",
      "protocolVersion must be 1 or 2"
    );
  }
  return value;
}

function normalizeToken(value, expectedProtocolVersion = undefined) {
  if (typeof value !== "string" || !ENROLLMENT_TOKEN_PATTERN.test(value)) {
    throw registryError(
      "INVALID_ENROLLMENT_TOKEN",
      "The enrollment token has an invalid format"
    );
  }
  const protocolVersion = Number(value.slice(3, 4));
  if (
    !SUPPORTED_ENROLLMENT_PROTOCOLS.has(protocolVersion) ||
    TOKEN_PREFIXES[protocolVersion] !== value.slice(0, 5) ||
    (
      expectedProtocolVersion !== undefined &&
      protocolVersion !== normalizeEnrollmentProtocolVersion(expectedProtocolVersion)
    )
  ) {
    throw registryError(
      "ENROLLMENT_PROTOCOL_MISMATCH",
      "The enrollment token is bound to another protocol version"
    );
  }
  const encoded = value.slice(5);
  const decoded = Buffer.from(encoded, "base64url");
  if (
    decoded.byteLength !== ENROLLMENT_TOKEN_BYTES ||
    decoded.toString("base64url") !== encoded
  ) {
    decoded.fill(0);
    throw registryError(
      "INVALID_ENROLLMENT_TOKEN",
      "The enrollment token has a non-canonical encoding"
    );
  }
  decoded.fill(0);
  return value;
}

function normalizeTtlSeconds(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_ENROLLMENT_TTL_SECONDS
  ) {
    throw registryError(
      "INVALID_ENROLLMENT_TTL",
      `ttlSeconds must be an integer between 1 and ${MAX_ENROLLMENT_TTL_SECONDS}`
    );
  }
  return value;
}

function normalizeAuthBytes(value, expectedBytes, field) {
  if (!(value instanceof Uint8Array)) {
    throw registryError("INVALID_AUTH_INPUT", `${field} must be a byte array`);
  }
  const copy = Buffer.from(value);
  const invalidLength =
    expectedBytes === null
      ? copy.byteLength < 1 || copy.byteLength > MAX_AUTH_MESSAGE_BYTES
      : copy.byteLength !== expectedBytes;
  if (invalidLength) {
    copy.fill(0);
    throw registryError(
      "INVALID_AUTH_INPUT",
      expectedBytes === null
        ? `${field} must contain 1-${MAX_AUTH_MESSAGE_BYTES} bytes`
        : `${field} must contain exactly ${expectedBytes} bytes`
    );
  }
  return copy;
}

function secureRandomBytes(randomBytes, length, field) {
  const value = Buffer.from(randomBytes(length));
  if (value.byteLength !== length) {
    throw registryError("INVALID_RANDOM_SOURCE", `${field} must contain ${length} bytes`);
  }
  return value;
}

function hashEnrollmentToken(token, protocolVersion) {
  const normalizedProtocolVersion = normalizeEnrollmentProtocolVersion(protocolVersion);
  return createHash("sha256")
    .update(TOKEN_HASH_CONTEXTS[normalizedProtocolVersion], "utf8")
    .update(token, "utf8")
    .digest();
}

function decodeCanonicalBase64(value, expectedBytes, field) {
  if (typeof value !== "string") {
    throw registryError("CORRUPT_REGISTRY", `${field} must be base64 text`);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength !== expectedBytes ||
    decoded.toString("base64") !== value
  ) {
    throw registryError(
      "CORRUPT_REGISTRY",
      `${field} must be canonical base64 for ${expectedBytes} bytes`
    );
  }
  return decoded;
}

function normalizePublicKeyAlgorithm(value) {
  if (!SUPPORTED_PUBLIC_KEY_ALGORITHMS.has(value)) {
    throw registryError(
      "INVALID_PUBLIC_KEY_ALGORITHM",
      "The public key algorithm is not supported"
    );
  }
  return value;
}

function normalizeDevicePublicKey(publicKey, publicKeyAlgorithm) {
  const algorithm = normalizePublicKeyAlgorithm(publicKeyAlgorithm);
  try {
    if (
      typeof publicKey === "string" &&
      /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(publicKey)
    ) {
      throw registryError(
        "INVALID_PUBLIC_KEY",
        "Private key material is never accepted by the device registry"
      );
    }

    if (publicKey?.type === "private") {
      throw registryError(
        "INVALID_PUBLIC_KEY",
        "Private key objects are never accepted by the device registry"
      );
    }

    const keyObject =
      publicKey?.type === "public"
        ? publicKey
        : typeof publicKey === "string"
          ? createPublicKey(publicKey)
          : createPublicKey({
              key: Buffer.from(publicKey),
              format: "der",
              type: "spki"
            });

    const expectedKeyType =
      algorithm === ED25519_PUBLIC_KEY_ALGORITHM ? "ed25519" : "ec";
    if (keyObject.asymmetricKeyType !== expectedKeyType) {
      throw registryError(
        "INVALID_PUBLIC_KEY",
        `The enrollment public key must match ${algorithm}`
      );
    }

    if (
      algorithm === ECDSA_P256_PUBLIC_KEY_ALGORITHM &&
      keyObject.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      throw registryError(
        "INVALID_PUBLIC_KEY",
        "The EC enrollment public key must use P-256"
      );
    }

    const der = Buffer.from(keyObject.export({ format: "der", type: "spki" }));
    const expectedBytes =
      algorithm === ED25519_PUBLIC_KEY_ALGORITHM
        ? ED25519_SPKI_BYTES
        : ECDSA_P256_SPKI_BYTES;
    if (der.byteLength !== expectedBytes) {
      der.fill(0);
      throw registryError(
        "INVALID_PUBLIC_KEY",
        `The ${algorithm} public key has a non-canonical SPKI length`
      );
    }
    return der.toString("base64");
  } catch (error) {
    if (error instanceof DeviceRegistryError) {
      throw error;
    }
    throw registryError(
      "INVALID_PUBLIC_KEY",
      `The enrollment public key is not a valid ${algorithm} SPKI public key`,
      error
    );
  }
}

function p1363Scalar(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function assertCanonicalP256Signature(signature) {
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
    throw registryError(
      "INVALID_AUTH_INPUT",
      "ECDSA P-256 signatures must contain exactly 64 P1363 bytes"
    );
  }
  const bytes = Buffer.from(signature);
  const r = p1363Scalar(bytes.subarray(0, 32));
  const s = p1363Scalar(bytes.subarray(32, 64));
  if (r <= 0n || r >= P256_ORDER || s <= 0n || s > P256_HALF_ORDER) {
    bytes.fill(0);
    throw registryError(
      "INVALID_AUTH_INPUT",
      "ECDSA P-256 signature must be canonical low-S P1363"
    );
  }
  return bytes;
}

function assertIsoDate(value, field, nullable = false) {
  if (nullable && value === null) {
    return;
  }
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw registryError("CORRUPT_REGISTRY", `${field} must be an ISO-8601 UTC date`);
  }
}

function assertExactKeys(value, expectedKeys, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw registryError("CORRUPT_REGISTRY", `${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw registryError(
      "CORRUPT_REGISTRY",
      `${field} contains missing or unexpected properties`
    );
  }
}

function assertRegistryShape(registry, { legacy = false } = {}) {
  const expectedSchemaVersion = legacy
    ? LEGACY_DEVICE_REGISTRY_SCHEMA_VERSION
    : DEVICE_REGISTRY_SCHEMA_VERSION;
  const expectedKind = legacy ? LEGACY_DEVICE_REGISTRY_KIND : DEVICE_REGISTRY_KIND;
  if (
    registry === null ||
    typeof registry !== "object" ||
    Array.isArray(registry) ||
    registry.schemaVersion !== expectedSchemaVersion ||
    registry.kind !== expectedKind ||
    !Array.isArray(registry.devices) ||
    !Array.isArray(registry.enrollmentTokens)
  ) {
    throw registryError(
      "CORRUPT_REGISTRY",
      `The device registry does not match schema version ${expectedSchemaVersion}`
    );
  }

  assertExactKeys(
    registry,
    [
      "schemaVersion",
      "kind",
      "createdAt",
      "updatedAt",
      "devices",
      "enrollmentTokens"
    ],
    "registry"
  );
  assertIsoDate(registry.createdAt, "createdAt");
  assertIsoDate(registry.updatedAt, "updatedAt");

  const nodeIds = new Set();
  const certificateIds = new Set();
  const publicKeys = new Set();
  for (const [index, device] of registry.devices.entries()) {
    const prefix = `devices[${index}]`;
    assertExactKeys(
      device,
      [
        "nodeId",
        "certificateId",
        "publicKeyAlgorithm",
        "publicKeySpkiDerBase64",
        "aliasKeyBase64url",
        "enrollmentEndpointId",
        "enrolledAt",
        "revokedAt"
      ],
      prefix
    );
    const nodeId = assertStoredUuid(device?.nodeId, `${prefix}.nodeId`);
    const certificateId = assertStoredUuid(
      device?.certificateId,
      `${prefix}.certificateId`
    );
    if (
      !SUPPORTED_PUBLIC_KEY_ALGORITHMS.has(device.publicKeyAlgorithm) ||
      (legacy && device.publicKeyAlgorithm !== ED25519_PUBLIC_KEY_ALGORITHM)
    ) {
      throw registryError(
        "CORRUPT_REGISTRY",
        legacy
          ? `${prefix}.publicKeyAlgorithm must be Ed25519`
          : `${prefix}.publicKeyAlgorithm is unsupported`
      );
    }
    const expectedPublicKeyBytes =
      device.publicKeyAlgorithm === ED25519_PUBLIC_KEY_ALGORITHM
        ? ED25519_SPKI_BYTES
        : ECDSA_P256_SPKI_BYTES;
    const publicKeyDer = decodeCanonicalBase64(
      device.publicKeySpkiDerBase64,
      expectedPublicKeyBytes,
      `${prefix}.publicKeySpkiDerBase64`
    );
    try {
      if (
        normalizeDevicePublicKey(publicKeyDer, device.publicKeyAlgorithm) !==
        device.publicKeySpkiDerBase64
      ) {
        throw new Error("Non-canonical device public key");
      }
    } catch (error) {
      throw registryError(
        "CORRUPT_REGISTRY",
        `${prefix}.publicKeySpkiDerBase64 does not match ${device.publicKeyAlgorithm}`,
        error
      );
    }
    const decodedAliasKey =
      typeof device.aliasKeyBase64url === "string"
        ? Buffer.from(device.aliasKeyBase64url, "base64url")
        : Buffer.alloc(0);
    if (
      typeof device.aliasKeyBase64url !== "string" ||
      !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(
        device.aliasKeyBase64url
      ) ||
      decodedAliasKey.byteLength !== ALIAS_KEY_BYTES ||
      decodedAliasKey.toString("base64url") !== device.aliasKeyBase64url
    ) {
      throw registryError(
        "CORRUPT_REGISTRY",
        `${prefix}.aliasKeyBase64url must encode exactly 32 bytes as unpadded base64url`
      );
    }
    normalizeEndpointId(device.enrollmentEndpointId);
    assertIsoDate(device.enrolledAt, `${prefix}.enrolledAt`);
    assertIsoDate(device.revokedAt, `${prefix}.revokedAt`, true);

    if (nodeIds.has(nodeId)) {
      throw registryError("CORRUPT_REGISTRY", `Duplicate NodeId ${nodeId}`);
    }
    if (certificateIds.has(certificateId)) {
      throw registryError(
        "CORRUPT_REGISTRY",
        `Duplicate certificateId ${certificateId}`
      );
    }
    if (publicKeys.has(device.publicKeySpkiDerBase64)) {
      throw registryError("CORRUPT_REGISTRY", "Duplicate device public key");
    }
    nodeIds.add(nodeId);
    certificateIds.add(certificateId);
    publicKeys.add(device.publicKeySpkiDerBase64);
  }

  const tokenIds = new Set();
  const tokenHashes = new Set();
  for (const [index, token] of registry.enrollmentTokens.entries()) {
    const prefix = `enrollmentTokens[${index}]`;
    const tokenKeys = [
      "tokenId",
      "enrollmentEndpointId",
      "tokenHashAlgorithm",
      "tokenHashBase64",
      "issuedAt",
      "expiresAt",
      "consumedAt",
      "consumedByNodeId"
    ];
    if (!legacy) tokenKeys.push("protocolVersion");
    assertExactKeys(
      token,
      tokenKeys,
      prefix
    );
    const tokenId = assertStoredUuid(token?.tokenId, `${prefix}.tokenId`);
    normalizeEndpointId(token.enrollmentEndpointId);
    if (!legacy) {
      try {
        normalizeEnrollmentProtocolVersion(token.protocolVersion);
      } catch (error) {
        throw registryError(
          "CORRUPT_REGISTRY",
          `${prefix}.protocolVersion is unsupported`,
          error
        );
      }
    }
    if (token.tokenHashAlgorithm !== "SHA-256") {
      throw registryError(
        "CORRUPT_REGISTRY",
        `${prefix}.tokenHashAlgorithm must be SHA-256`
      );
    }
    decodeCanonicalBase64(token.tokenHashBase64, 32, `${prefix}.tokenHashBase64`);
    assertIsoDate(token.issuedAt, `${prefix}.issuedAt`);
    assertIsoDate(token.expiresAt, `${prefix}.expiresAt`);
    assertIsoDate(token.consumedAt, `${prefix}.consumedAt`, true);
    if (token.consumedByNodeId !== null) {
      assertStoredUuid(token.consumedByNodeId, `${prefix}.consumedByNodeId`);
    }
    if ((token.consumedAt === null) !== (token.consumedByNodeId === null)) {
      throw registryError(
        "CORRUPT_REGISTRY",
        `${prefix} consumption fields must both be null or both be set`
      );
    }
    if (tokenIds.has(tokenId) || tokenHashes.has(token.tokenHashBase64)) {
      throw registryError("CORRUPT_REGISTRY", "Duplicate enrollment token record");
    }
    tokenIds.add(tokenId);
    tokenHashes.add(token.tokenHashBase64);
  }

  for (const token of registry.enrollmentTokens) {
    if (
      token.consumedByNodeId !== null &&
      !nodeIds.has(token.consumedByNodeId)
    ) {
      throw registryError(
        "CORRUPT_REGISTRY",
        `Consumed token references unknown NodeId ${token.consumedByNodeId}`
      );
    }
  }
}

function newRegistry(now) {
  const timestamp = now.toISOString();
  return {
    schemaVersion: DEVICE_REGISTRY_SCHEMA_VERSION,
    kind: DEVICE_REGISTRY_KIND,
    createdAt: timestamp,
    updatedAt: timestamp,
    devices: [],
    enrollmentTokens: []
  };
}

function migrateLegacyRegistry(legacyRegistry, now) {
  assertRegistryShape(legacyRegistry, { legacy: true });
  if (now.getTime() < Date.parse(legacyRegistry.updatedAt)) {
    throw registryError(
      "REGISTRY_CLOCK_ROLLBACK",
      "The clock precedes the legacy registry update time"
    );
  }
  const migrated = {
    schemaVersion: DEVICE_REGISTRY_SCHEMA_VERSION,
    kind: DEVICE_REGISTRY_KIND,
    createdAt: legacyRegistry.createdAt,
    updatedAt: now.toISOString(),
    devices: clone(legacyRegistry.devices),
    enrollmentTokens: legacyRegistry.enrollmentTokens.map((token) => ({
      tokenId: token.tokenId,
      enrollmentEndpointId: token.enrollmentEndpointId,
      protocolVersion: ENROLLMENT_PROTOCOL_V1,
      tokenHashAlgorithm: token.tokenHashAlgorithm,
      tokenHashBase64: token.tokenHashBase64,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
      consumedAt: token.consumedAt,
      consumedByNodeId: token.consumedByNodeId
    }))
  };
  assertRegistryShape(migrated);
  return migrated;
}

function publicDeviceRecord(device) {
  const { aliasKeyBase64url: _aliasKeyBase64url, ...publicFields } = device;
  return publicFields;
}

function publicTokenRecord(token, now) {
  const { tokenHashBase64: _tokenHashBase64, ...publicFields } = token;
  return {
    ...publicFields,
    status:
      token.consumedAt !== null
        ? "CONSUMED"
        : Date.parse(token.expiresAt) <= now.getTime()
          ? "EXPIRED"
          : "ACTIVE"
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameFileIdentity(first, second) {
  return (
    first !== undefined &&
    second !== undefined &&
    first.dev === second.dev &&
    first.ino === second.ino
  );
}

export class DeviceRegistryV2 {
  constructor(registryPath, options = {}) {
    if (typeof registryPath !== "string" || registryPath.trim() === "") {
      throw registryError("INVALID_REGISTRY_PATH", "registryPath is required");
    }
    this.registryPath = path.resolve(registryPath);
    this.lockPath = `${this.registryPath}.lock`;
    this.clock = options.clock ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.randomUUID = options.randomUUID ?? cryptoRandomUUID;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.lockRetryMs = options.lockRetryMs ?? 20;
  }

  async initialize() {
    return this.#withExclusiveLock(async () => {
      const current = await this.#readRegistry(
        true,
        { allowLegacy: true }
      );
      if (current !== null) {
        if (current.schemaVersion === LEGACY_DEVICE_REGISTRY_SCHEMA_VERSION) {
          const migrated = migrateLegacyRegistry(
            current,
            normalizeDate(this.clock)
          );
          await this.#writeRegistry(migrated);
        }
        return this.inspect();
      }
      const now = normalizeDate(this.clock);
      const registry = newRegistry(now);
      await this.#writeRegistry(registry);
      return {
        schemaVersion: registry.schemaVersion,
        kind: registry.kind,
        createdAt: registry.createdAt,
        updatedAt: registry.updatedAt,
        devices: [],
        enrollmentTokens: []
      };
    });
  }

  async issueEnrollmentToken({
    enrollmentEndpointId,
    protocolVersion = ENROLLMENT_PROTOCOL_V1,
    ttlSeconds = DEFAULT_ENROLLMENT_TTL_SECONDS,
    onTokenReady = undefined
  }) {
    const endpointId = normalizeEndpointId(enrollmentEndpointId);
    const enrollmentProtocolVersion =
      normalizeEnrollmentProtocolVersion(protocolVersion);
    const ttl = normalizeTtlSeconds(ttlSeconds);
    if (onTokenReady !== undefined && typeof onTokenReady !== "function") {
      throw registryError("INVALID_TOKEN_SINK", "onTokenReady must be a function");
    }
    const tokenBytes = secureRandomBytes(
      this.randomBytes,
      ENROLLMENT_TOKEN_BYTES,
      "enrollment token"
    );
    const token =
      `${TOKEN_PREFIXES[enrollmentProtocolVersion]}` +
      tokenBytes.toString("base64url");
    const tokenHashBase64 =
      hashEnrollmentToken(token, enrollmentProtocolVersion).toString("base64");

    return this.#withExclusiveLock(async () => {
      const registry = await this.#requireRegistry();
      const now = normalizeDate(this.clock);
      const tokenId = normalizeUuid(this.randomUUID(), "tokenId");
      const expiresAt = new Date(now.getTime() + ttl * 1000);

      if (
        registry.enrollmentTokens.some(
          (candidate) => candidate.tokenHashBase64 === tokenHashBase64
        )
      ) {
        throw registryError(
          "RANDOM_COLLISION",
          "The random source generated an existing enrollment token"
        );
      }

      registry.enrollmentTokens.push({
        tokenId,
        enrollmentEndpointId: endpointId,
        protocolVersion: enrollmentProtocolVersion,
        tokenHashAlgorithm: "SHA-256",
        tokenHashBase64,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        consumedAt: null,
        consumedByNodeId: null
      });
      const qr = {
        version: enrollmentProtocolVersion,
        enrollmentEndpointId: endpointId,
        token
      };
      const issued = {
        tokenId,
        expiresAt: expiresAt.toISOString(),
        qr,
        qrPayload: JSON.stringify(qr)
      };
      await onTokenReady?.(clone(issued));
      registry.updatedAt = now.toISOString();
      await this.#writeRegistry(registry);
      return issued;
    });
  }

  async enrollDevice({
    protocolVersion = ENROLLMENT_PROTOCOL_V1,
    enrollmentEndpointId,
    token,
    publicKey,
    publicKeyAlgorithm = ED25519_PUBLIC_KEY_ALGORITHM,
    nodeId,
    onProvisioningReady = undefined
  }) {
    const enrollmentProtocolVersion =
      normalizeEnrollmentProtocolVersion(protocolVersion);
    const endpointId = normalizeEndpointId(enrollmentEndpointId);
    const normalizedToken = normalizeToken(token, enrollmentProtocolVersion);
    const normalizedPublicKeyAlgorithm =
      normalizePublicKeyAlgorithm(publicKeyAlgorithm);
    if (
      (
        enrollmentProtocolVersion === ENROLLMENT_PROTOCOL_V1 &&
        normalizedPublicKeyAlgorithm !== ED25519_PUBLIC_KEY_ALGORITHM
      ) ||
      (
        enrollmentProtocolVersion === ENROLLMENT_PROTOCOL_V2 &&
        normalizedPublicKeyAlgorithm !== ECDSA_P256_PUBLIC_KEY_ALGORITHM
      )
    ) {
      throw registryError(
        "ENROLLMENT_PROTOCOL_MISMATCH",
        "The public key algorithm does not match the enrollment protocol"
      );
    }
    const publicKeySpkiDerBase64 = normalizeDevicePublicKey(
      publicKey,
      normalizedPublicKeyAlgorithm
    );
    const requestedNodeId = normalizeUuid(nodeId, "nodeId");
    if (
      onProvisioningReady !== undefined &&
      typeof onProvisioningReady !== "function"
    ) {
      throw registryError(
        "INVALID_PROVISIONING_SINK",
        "onProvisioningReady must be a function"
      );
    }
    const candidateHash = hashEnrollmentToken(
      normalizedToken,
      enrollmentProtocolVersion
    );

    return this.#withExclusiveLock(async () => {
      const registry = await this.#requireRegistry();
      const now = normalizeDate(this.clock);
      const tokenRecord = registry.enrollmentTokens.find((candidate) => {
        if (
          candidate.enrollmentEndpointId !== endpointId ||
          candidate.protocolVersion !== enrollmentProtocolVersion
        ) {
          return false;
        }
        const storedHash = Buffer.from(candidate.tokenHashBase64, "base64");
        return (
          storedHash.byteLength === candidateHash.byteLength &&
          timingSafeEqual(storedHash, candidateHash)
        );
      });

      if (tokenRecord === undefined) {
        throw registryError(
          "INVALID_ENROLLMENT_TOKEN",
          "The enrollment token is unknown for this endpoint"
        );
      }
      if (tokenRecord.consumedAt !== null) {
        throw registryError(
          "ENROLLMENT_TOKEN_REPLAY",
          "The enrollment token has already been consumed"
        );
      }
      if (now.getTime() < Date.parse(tokenRecord.issuedAt)) {
        throw registryError(
          "REGISTRY_CLOCK_ROLLBACK",
          "The clock precedes enrollment token issuance"
        );
      }
      if (Date.parse(tokenRecord.expiresAt) <= now.getTime()) {
        throw registryError(
          "ENROLLMENT_TOKEN_EXPIRED",
          "The enrollment token has expired"
        );
      }

      const effectiveNodeId = requestedNodeId;
      if (registry.devices.some((device) => device.nodeId === effectiveNodeId)) {
        throw registryError(
          "NODE_ALREADY_ENROLLED",
          `NodeId ${effectiveNodeId} is already enrolled`
        );
      }
      if (
        registry.devices.some(
          (device) => device.publicKeySpkiDerBase64 === publicKeySpkiDerBase64
        )
      ) {
        throw registryError(
          "PUBLIC_KEY_ALREADY_ENROLLED",
          "This device public key is already enrolled"
        );
      }

      const certificateId = normalizeUuid(this.randomUUID(), "certificateId");
      const aliasKey = secureRandomBytes(
        this.randomBytes,
        ALIAS_KEY_BYTES,
        "aliasKey"
      );
      const device = {
        nodeId: effectiveNodeId,
        certificateId,
        publicKeyAlgorithm: normalizedPublicKeyAlgorithm,
        publicKeySpkiDerBase64,
        aliasKeyBase64url: aliasKey.toString("base64url"),
        enrollmentEndpointId: endpointId,
        enrolledAt: now.toISOString(),
        revokedAt: null
      };

      const provisioned = {
        protocolVersion: enrollmentProtocolVersion,
        nodeId: effectiveNodeId,
        certificateId,
        publicKeyAlgorithm: normalizedPublicKeyAlgorithm,
        publicKeySpkiDerBase64,
        aliasKeyAlgorithm: "HMAC-SHA256",
        aliasKeyEncoding: "base64url-unpadded",
        aliasKeyBase64url: device.aliasKeyBase64url,
        enrolledAt: device.enrolledAt
      };
      await onProvisioningReady?.(clone(provisioned));
      registry.devices.push(device);
      tokenRecord.consumedAt = now.toISOString();
      tokenRecord.consumedByNodeId = effectiveNodeId;
      registry.updatedAt = now.toISOString();
      await this.#writeRegistry(registry);
      return provisioned;
    });
  }

  /**
   * Recovers only the response of the exact enrollment transaction that already
   * committed. The HTTPS layer calls this after a replay error and only after
   * verifying the original signed request made by the enrolled Android private
   * key. That captured request remains bearer-equivalent during this bounded
   * recovery window and must never be logged or retained by intermediaries.
   */
  async recoverCommittedEnrollment({
    protocolVersion = ENROLLMENT_PROTOCOL_V1,
    enrollmentEndpointId,
    token,
    publicKey,
    publicKeyAlgorithm = ED25519_PUBLIC_KEY_ALGORITHM,
    nodeId
  }) {
    const enrollmentProtocolVersion =
      normalizeEnrollmentProtocolVersion(protocolVersion);
    const endpointId = normalizeEndpointId(enrollmentEndpointId);
    const normalizedToken = normalizeToken(token, enrollmentProtocolVersion);
    const normalizedPublicKeyAlgorithm =
      normalizePublicKeyAlgorithm(publicKeyAlgorithm);
    if (
      (
        enrollmentProtocolVersion === ENROLLMENT_PROTOCOL_V1 &&
        normalizedPublicKeyAlgorithm !== ED25519_PUBLIC_KEY_ALGORITHM
      ) ||
      (
        enrollmentProtocolVersion === ENROLLMENT_PROTOCOL_V2 &&
        normalizedPublicKeyAlgorithm !== ECDSA_P256_PUBLIC_KEY_ALGORITHM
      )
    ) {
      throw registryError(
        "ENROLLMENT_PROTOCOL_MISMATCH",
        "The public key algorithm does not match the enrollment protocol"
      );
    }
    const publicKeySpkiDerBase64 = normalizeDevicePublicKey(
      publicKey,
      normalizedPublicKeyAlgorithm
    );
    const requestedNodeId = normalizeUuid(nodeId, "nodeId");
    const candidateHash = hashEnrollmentToken(
      normalizedToken,
      enrollmentProtocolVersion
    );
    const registry = await this.#requireRegistry();
    const now = normalizeDate(this.clock);
    const tokenRecord = registry.enrollmentTokens.find((candidate) => {
      if (
        candidate.enrollmentEndpointId !== endpointId ||
        candidate.protocolVersion !== enrollmentProtocolVersion
      ) {
        return false;
      }
      const storedHash = Buffer.from(candidate.tokenHashBase64, "base64");
      return (
        storedHash.byteLength === candidateHash.byteLength &&
        timingSafeEqual(storedHash, candidateHash)
      );
    });
    if (
      tokenRecord === undefined ||
      tokenRecord.consumedAt === null ||
      tokenRecord.consumedByNodeId !== requestedNodeId
    ) {
      throw registryError(
        "ENROLLMENT_RECOVERY_REJECTED",
        "No matching committed enrollment transaction exists"
      );
    }
    const consumedAtMilliseconds = Date.parse(tokenRecord.consumedAt);
    const recoveryDeadline =
      consumedAtMilliseconds +
      ENROLLMENT_RESPONSE_RECOVERY_SECONDS * 1000;
    if (now.getTime() < consumedAtMilliseconds) {
      throw registryError(
        "REGISTRY_CLOCK_ROLLBACK",
        "The clock precedes enrollment token consumption"
      );
    }
    if (now.getTime() > recoveryDeadline) {
      throw registryError(
        "ENROLLMENT_RECOVERY_EXPIRED",
        "The enrollment response recovery window has expired"
      );
    }
    const device = registry.devices.find(
      (candidate) => candidate.nodeId === requestedNodeId
    );
    if (
      device === undefined ||
      device.revokedAt !== null ||
      device.enrollmentEndpointId !== endpointId ||
      device.publicKeyAlgorithm !== normalizedPublicKeyAlgorithm ||
      device.publicKeySpkiDerBase64 !== publicKeySpkiDerBase64
    ) {
      throw registryError(
        "ENROLLMENT_RECOVERY_REJECTED",
        "The committed device does not match the enrollment transaction"
      );
    }
    return {
      protocolVersion: enrollmentProtocolVersion,
      nodeId: device.nodeId,
      certificateId: device.certificateId,
      publicKeyAlgorithm: device.publicKeyAlgorithm,
      publicKeySpkiDerBase64: device.publicKeySpkiDerBase64,
      aliasKeyAlgorithm: "HMAC-SHA256",
      aliasKeyEncoding: "base64url-unpadded",
      aliasKeyBase64url: device.aliasKeyBase64url,
      enrolledAt: device.enrolledAt
    };
  }

  async revokeDevice(nodeId) {
    const normalizedNodeId = normalizeUuid(nodeId, "nodeId");
    return this.#withExclusiveLock(async () => {
      const registry = await this.#requireRegistry();
      const device = registry.devices.find(
        (candidate) => candidate.nodeId === normalizedNodeId
      );
      if (device === undefined) {
        throw registryError("UNKNOWN_NODE", `NodeId ${normalizedNodeId} is unknown`);
      }
      if (device.revokedAt !== null) {
        return publicDeviceRecord(clone(device));
      }
      const now = normalizeDate(this.clock);
      device.revokedAt = now.toISOString();
      registry.updatedAt = now.toISOString();
      await this.#writeRegistry(registry);
      return publicDeviceRecord(clone(device));
    });
  }

  async getAuthorizedDevice(nodeId) {
    const normalizedNodeId = normalizeUuid(nodeId, "nodeId");
    const registry = await this.#requireRegistry();
    const device = registry.devices.find(
      (candidate) => candidate.nodeId === normalizedNodeId
    );
    if (device === undefined) {
      throw registryError("UNKNOWN_NODE", `NodeId ${normalizedNodeId} is unknown`);
    }
    if (device.revokedAt !== null) {
      throw registryError("REVOKED_NODE", `NodeId ${normalizedNodeId} is revoked`);
    }
    return publicDeviceRecord(clone(device));
  }

  async verifyAuthorizedDeviceSignature({
    nodeId,
    certificateId,
    message,
    signature
  }) {
    const credential = await this.#requireAuthorizedCredential(
      nodeId,
      certificateId
    );
    const messageBytes = normalizeAuthBytes(message, null, "message");
    let signatureBytes;
    try {
      if (credential.publicKeyAlgorithm === ED25519_PUBLIC_KEY_ALGORITHM) {
        signatureBytes = normalizeAuthBytes(
          signature,
          ED25519_SIGNATURE_BYTES,
          "signature"
        );
      } else if (
        credential.publicKeyAlgorithm === ECDSA_P256_PUBLIC_KEY_ALGORITHM
      ) {
        signatureBytes = assertCanonicalP256Signature(signature);
      } else {
        throw registryError(
          "CORRUPT_REGISTRY",
          "Authorized device has an unsupported public key algorithm"
        );
      }
      const publicKey = createPublicKey({
        key: Buffer.from(credential.publicKeySpkiDerBase64, "base64"),
        format: "der",
        type: "spki"
      });
      if (credential.publicKeyAlgorithm === ED25519_PUBLIC_KEY_ALGORITHM) {
        return verifySignature(null, messageBytes, publicKey, signatureBytes);
      }
      return verifySignature(
        "sha256",
        messageBytes,
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        signatureBytes
      );
    } catch (error) {
      if (error instanceof DeviceRegistryError) {
        throw error;
      }
      throw registryError(
        "AUTH_CRYPTO_FAILED",
        "Unable to verify the authorized device signature",
        error
      );
    } finally {
      messageBytes.fill(0);
      signatureBytes?.fill(0);
    }
  }

  async createAuthorizedDeviceMac({
    nodeId,
    certificateId,
    message
  }) {
    const credential = await this.#requireAuthorizedCredential(
      nodeId,
      certificateId
    );
    const messageBytes = normalizeAuthBytes(message, null, "message");
    const aliasKey = Buffer.from(credential.aliasKeyBase64url, "base64url");
    try {
      return createHmac("sha256", aliasKey).update(messageBytes).digest();
    } catch (error) {
      throw registryError(
        "AUTH_CRYPTO_FAILED",
        "Unable to create the authorized device proof",
        error
      );
    } finally {
      aliasKey.fill(0);
      messageBytes.fill(0);
    }
  }

  async verifyAuthorizedDeviceMac({
    nodeId,
    certificateId,
    message,
    proof
  }) {
    const candidate = normalizeAuthBytes(proof, AUTH_PROOF_BYTES, "proof");
    let expected;
    try {
      expected = await this.createAuthorizedDeviceMac({
        nodeId,
        certificateId,
        message
      });
      return timingSafeEqual(expected, candidate);
    } finally {
      expected?.fill(0);
      candidate.fill(0);
    }
  }

  async deriveRotatingAliasForNode({
    nodeId,
    timestampSeconds,
    epochSeconds = 60
  }) {
    const normalizedNodeId = normalizeUuid(nodeId, "nodeId");
    const registry = await this.#requireRegistry();
    const device = registry.devices.find(
      (candidate) => candidate.nodeId === normalizedNodeId
    );
    if (device === undefined) {
      throw registryError("UNKNOWN_NODE", `NodeId ${normalizedNodeId} is unknown`);
    }
    if (device.revokedAt !== null) {
      throw registryError("REVOKED_NODE", `NodeId ${normalizedNodeId} is revoked`);
    }
    return deriveRotatingAlias({
      aliasKey: Buffer.from(device.aliasKeyBase64url, "base64url"),
      nodeId: normalizedNodeId,
      timestampSeconds,
      epochSeconds
    });
  }

  async inspect() {
    const registry = await this.#requireRegistry();
    const now = normalizeDate(this.clock);
    return {
      schemaVersion: registry.schemaVersion,
      kind: registry.kind,
      createdAt: registry.createdAt,
      updatedAt: registry.updatedAt,
      devices: registry.devices.map((device) =>
        publicDeviceRecord(clone(device))
      ),
      enrollmentTokens: registry.enrollmentTokens.map((token) =>
        publicTokenRecord(clone(token), now)
      )
    };
  }

  async verifyIssuedTokenCommit({
    tokenId,
    enrollmentEndpointId,
    token,
    protocolVersion = undefined
  }) {
    const normalizedTokenId = normalizeUuid(tokenId, "tokenId");
    const endpointId = normalizeEndpointId(enrollmentEndpointId);
    const inferredProtocolVersion =
      protocolVersion ?? Number(String(token).slice(3, 4));
    const normalizedProtocolVersion =
      normalizeEnrollmentProtocolVersion(inferredProtocolVersion);
    const normalizedToken = normalizeToken(token, normalizedProtocolVersion);
    const candidateHash = hashEnrollmentToken(
      normalizedToken,
      normalizedProtocolVersion
    );
    const registry = await this.#requireRegistry();
    const record = registry.enrollmentTokens.find((candidate) => {
      if (candidate.tokenId === normalizedTokenId) {
        return true;
      }
      const storedHash = Buffer.from(candidate.tokenHashBase64, "base64");
      return (
        storedHash.byteLength === candidateHash.byteLength &&
        timingSafeEqual(storedHash, candidateHash)
      );
    });
    if (record === undefined) {
      return { recordExists: false, matches: false };
    }
    const storedHash = Buffer.from(record.tokenHashBase64, "base64");
    return {
      recordExists: true,
      matches:
        record.tokenId === normalizedTokenId &&
        record.enrollmentEndpointId === endpointId &&
        record.protocolVersion === normalizedProtocolVersion &&
        storedHash.byteLength === candidateHash.byteLength &&
        timingSafeEqual(storedHash, candidateHash)
    };
  }

  async verifyProvisioningCommit({
    protocolVersion = undefined,
    nodeId,
    certificateId,
    publicKeyAlgorithm = ED25519_PUBLIC_KEY_ALGORITHM,
    publicKeySpkiDerBase64,
    aliasKeyBase64url,
    enrolledAt
  }) {
    const normalizedNodeId = normalizeUuid(nodeId, "nodeId");
    const normalizedCertificateId = normalizeUuid(
      certificateId,
      "certificateId"
    );
    if (protocolVersion !== undefined) {
      normalizeEnrollmentProtocolVersion(protocolVersion);
    }
    const normalizedPublicKeyAlgorithm =
      normalizePublicKeyAlgorithm(publicKeyAlgorithm);
    const normalizedPublicKey = normalizeDevicePublicKey(
      Buffer.from(publicKeySpkiDerBase64 ?? "", "base64"),
      normalizedPublicKeyAlgorithm
    );
    const aliasKey =
      typeof aliasKeyBase64url === "string"
        ? Buffer.from(aliasKeyBase64url, "base64url")
        : Buffer.alloc(0);
    if (
      typeof aliasKeyBase64url !== "string" ||
      !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(aliasKeyBase64url) ||
      aliasKey.byteLength !== ALIAS_KEY_BYTES ||
      aliasKey.toString("base64url") !== aliasKeyBase64url
    ) {
      throw registryError(
        "INVALID_PROVISIONING_RECORD",
        "aliasKeyBase64url must encode exactly 32 bytes"
      );
    }
    if (
      typeof enrolledAt !== "string" ||
      !Number.isFinite(Date.parse(enrolledAt)) ||
      new Date(enrolledAt).toISOString() !== enrolledAt
    ) {
      throw registryError(
        "INVALID_PROVISIONING_RECORD",
        "enrolledAt must be an ISO-8601 UTC date"
      );
    }

    const registry = await this.#requireRegistry();
    const device = registry.devices.find(
      (candidate) =>
        candidate.nodeId === normalizedNodeId ||
        candidate.certificateId === normalizedCertificateId ||
        (
          candidate.publicKeyAlgorithm === normalizedPublicKeyAlgorithm &&
          candidate.publicKeySpkiDerBase64 === normalizedPublicKey
        )
    );
    if (device === undefined) {
      return { recordExists: false, matches: false };
    }
    const storedAliasKey = Buffer.from(device.aliasKeyBase64url, "base64url");
    return {
      recordExists: true,
      matches:
        device.nodeId === normalizedNodeId &&
        device.certificateId === normalizedCertificateId &&
        device.publicKeyAlgorithm === normalizedPublicKeyAlgorithm &&
        device.publicKeySpkiDerBase64 === normalizedPublicKey &&
        device.enrolledAt === enrolledAt &&
        storedAliasKey.byteLength === aliasKey.byteLength &&
        timingSafeEqual(storedAliasKey, aliasKey)
    };
  }

  async #requireAuthorizedCredential(nodeId, certificateId) {
    const normalizedNodeId = normalizeUuid(nodeId, "nodeId");
    const normalizedCertificateId = normalizeUuid(
      certificateId,
      "certificateId"
    );
    const registry = await this.#requireRegistry();
    const device = registry.devices.find(
      (candidate) => candidate.nodeId === normalizedNodeId
    );
    if (device === undefined) {
      throw registryError("UNKNOWN_NODE", `NodeId ${normalizedNodeId} is unknown`);
    }
    if (device.revokedAt !== null) {
      throw registryError("REVOKED_NODE", `NodeId ${normalizedNodeId} is revoked`);
    }
    if (device.certificateId !== normalizedCertificateId) {
      throw registryError(
        "CERTIFICATE_BINDING_MISMATCH",
        "certificateId does not belong to the authorized NodeId"
      );
    }
    return device;
  }

  async #requireRegistry() {
    const registry = await this.#readRegistry(false);
    if (registry === null) {
      throw registryError("REGISTRY_NOT_INITIALIZED", "Device registry not initialized");
    }
    return registry;
  }

  async #readRegistry(allowMissing, { allowLegacy = false } = {}) {
    let handle;
    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      handle = await open(this.registryPath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissing) {
        return null;
      }
      if (error?.code === "ENOENT") {
        throw registryError(
          "REGISTRY_NOT_INITIALIZED",
          `Device registry does not exist: ${this.registryPath}`,
          error
        );
      }
      if (error?.code === "ELOOP") {
        throw registryError(
          "INSECURE_REGISTRY_FILE",
          "Device registry must not be a symbolic link",
          error
        );
      }
      throw registryError(
        "REGISTRY_READ_FAILED",
        `Unable to open device registry: ${this.registryPath}`,
        error
      );
    }

    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw registryError(
          "INSECURE_REGISTRY_FILE",
          "Device registry must be a regular file"
        );
      }
      const mode = stat.mode & 0o777;
      if (mode !== REQUIRED_FILE_MODE) {
        throw registryError(
          "INSECURE_REGISTRY_PERMISSIONS",
          `Device registry mode must be 0600, found ${mode.toString(8).padStart(4, "0")}`
        );
      }

      const raw = await handle.readFile({ encoding: "utf8" });
      let registry;
      try {
        registry = JSON.parse(raw);
      } catch (error) {
        throw registryError(
          "CORRUPT_REGISTRY",
          "Device registry is not valid JSON",
          error
        );
      }
      if (
        registry?.schemaVersion === LEGACY_DEVICE_REGISTRY_SCHEMA_VERSION &&
        registry?.kind === LEGACY_DEVICE_REGISTRY_KIND
      ) {
        if (!allowLegacy) {
          throw registryError(
            "REGISTRY_MIGRATION_REQUIRED",
            "Legacy registry must be migrated with initialize() before use"
          );
        }
        assertRegistryShape(registry, { legacy: true });
        return registry;
      }
      assertRegistryShape(registry);
      return registry;
    } finally {
      await handle.close();
    }
  }

  async #writeRegistry(registry) {
    assertRegistryShape(registry);
    const directory = path.dirname(this.registryPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.registryPath}.tmp-${process.pid}-${cryptoRandomBytes(8).toString("hex")}`;
    let handle;
    let temporaryCreated = false;
    let registryRenamed = false;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        REQUIRED_FILE_MODE
      );
      temporaryCreated = true;
      await handle.chmod(REQUIRED_FILE_MODE);
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.registryPath);
      registryRenamed = true;

      let directoryHandle;
      try {
        directoryHandle = await open(directory, fsConstants.O_RDONLY);
        await directoryHandle.sync();
      } finally {
        await directoryHandle?.close();
      }
    } catch (error) {
      if (registryRenamed) {
        throw registryError(
          "REGISTRY_DURABILITY_UNCERTAIN",
          "Registry rename committed, but the directory sync did not complete",
          error,
          true
        );
      }
      throw error;
    } finally {
      await handle?.close();
      if (temporaryCreated && !registryRenamed) {
        await unlink(temporaryPath).catch((error) => {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        });
      }
    }
  }

  async #withExclusiveLock(operation) {
    await mkdir(path.dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    let lockHandle;
    let lockIdentity;

    while (lockHandle === undefined) {
      let candidateHandle;
      let candidateIdentity;
      try {
        candidateHandle = await open(
          this.lockPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
          REQUIRED_FILE_MODE
        );
        await candidateHandle.chmod(REQUIRED_FILE_MODE);
        await candidateHandle.writeFile(
          `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
          "utf8"
        );
        await candidateHandle.sync();
        candidateIdentity = await candidateHandle.stat({ bigint: true });
        if (!candidateIdentity.isFile()) {
          throw registryError(
            "REGISTRY_LOCK_FAILED",
            "The registry lock is not a regular file"
          );
        }
        const pathIdentity = await lstat(this.lockPath, { bigint: true });
        if (!sameFileIdentity(candidateIdentity, pathIdentity)) {
          throw registryError(
            "REGISTRY_LOCK_OWNERSHIP_LOST",
            "The registry lock pathname no longer refers to the acquired lock"
          );
        }
        lockHandle = candidateHandle;
        lockIdentity = candidateIdentity;
      } catch (error) {
        const lockWasCreated = candidateHandle !== undefined;
        let lockSetupCleanupError;
        if (lockWasCreated) {
          try {
            const ownedIdentity =
              candidateIdentity ??
              (await candidateHandle.stat({ bigint: true }));
            await this.#unlinkOwnedLock(candidateHandle, ownedIdentity);
          } catch (cleanupError) {
            lockSetupCleanupError = cleanupError;
          }
          try {
            await candidateHandle.close();
          } catch (cleanupError) {
            lockSetupCleanupError ??= cleanupError;
          }
        }
        if (error?.code !== "EEXIST" || lockWasCreated) {
          throw registryError(
            "REGISTRY_LOCK_FAILED",
            `Unable to lock device registry: ${this.registryPath}`,
            lockSetupCleanupError ?? error
          );
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw registryError(
            "REGISTRY_BUSY",
            `Device registry is locked: ${this.registryPath}`,
            error
          );
        }
        await sleep(this.lockRetryMs);
      }
    }

    let result;
    let operationError;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }

    let cleanupError;
    try {
      await this.#unlinkOwnedLock(lockHandle, lockIdentity);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await lockHandle.close();
    } catch (error) {
      cleanupError ??= error;
    }

    if (operationError !== undefined) {
      if (cleanupError !== undefined) {
        operationError.lockCleanupError = cleanupError;
      }
      throw operationError;
    }
    if (cleanupError !== undefined) {
      throw registryError(
        "REGISTRY_LOCK_CLEANUP_FAILED",
        "Registry operation completed, but its lock cleanup failed",
        cleanupError,
        true
      );
    }
    return result;
  }

  async #unlinkOwnedLock(lockHandle, ownedIdentity) {
    const handleIdentity = await lockHandle.stat({ bigint: true });
    if (
      !handleIdentity.isFile() ||
      !sameFileIdentity(handleIdentity, ownedIdentity)
    ) {
      throw registryError(
        "REGISTRY_LOCK_OWNERSHIP_LOST",
        "The acquired registry lock handle changed identity"
      );
    }

    let pathIdentity;
    try {
      pathIdentity = await lstat(this.lockPath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw registryError(
          "REGISTRY_LOCK_OWNERSHIP_LOST",
          "The acquired registry lock pathname no longer exists",
          error
        );
      }
      throw error;
    }

    if (
      !pathIdentity.isFile() ||
      !sameFileIdentity(pathIdentity, ownedIdentity)
    ) {
      throw registryError(
        "REGISTRY_LOCK_OWNERSHIP_LOST",
        "Refusing to remove a registry lock not owned by this operation"
      );
    }
    await unlink(this.lockPath);
  }
}
