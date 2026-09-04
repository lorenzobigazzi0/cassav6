import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ADVERTISEMENT_SEQUENCE_RELATIONS,
  GATT_SERVICE_UUID,
  LEGACY_ADVERTISEMENT_BUDGET,
  bytesToHex,
  compareAdvertisementSequence,
  decodeLegacyAdvertisingData,
  decodeNodeAdvertisement,
  encodeLegacyAdvertisingData,
  encodeNodeAdvertisement
} from "../shared/protocol/advertisement-v1.mjs";
import {
  ROTATING_ALIAS_EPOCH_BYTES,
  ROTATING_ALIAS_NODE_ID_UTF8_BYTES,
  buildRotatingAliasMessage,
  deriveRotatingAlias,
  rotatingAliasEpoch
} from "../shared/protocol/rotating-alias-v1.mjs";
import {
  CASSA_GATT_CHARACTERISTICS,
  CASSA_GATT_CHARACTERISTIC_UUIDS,
  CASSA_GATT_PROFILE_VERSION,
  CASSA_GATT_SERVICE_UUID
} from "../shared/protocol/gatt-profile-v1.mjs";
import {
  MAX_PEER_STREAMS,
  MAX_NEW_STREAM_ATTEMPTS_PER_WINDOW,
  PEER_AGING_THROUGH_MS,
  PEER_FRESH_BEFORE_MS,
  PEER_NEW_STREAM_WINDOW_MS,
  PEER_PRUNE_INTERVAL_MS,
  PEER_REPLACEMENT_RSSI_MARGIN_DB,
  PEER_RSSI_FLOOR_DBM
} from "../shared/discovery/peer-directory-v1.mjs";
import {
  DEFAULT_SCAN_WINDOW_POLICY_V1,
  validateScanWindowPolicyV1
} from "../shared/discovery/scan-window-policy-v1.mjs";
import {
  HELLO_V1_MINIMUM_MTU,
  HELLO_V1_WIRE_BYTES,
  decodeHelloV1,
  encodeHelloV1
} from "../shared/protocol/hello-v1.mjs";
import {
  DEFAULT_HEARTBEAT_MISSES_BEFORE_CLOSE,
  DEFAULT_PREFERRED_GATT_MTU,
  DIRECT_SESSION_ID_PATTERN_SOURCE,
  DIRECT_SESSION_PROTOCOL_VERSION,
  DIRECT_SESSION_ROLES,
  MAXIMUM_GATT_MTU,
  MINIMUM_GATT_MTU
} from "../shared/session/direct-session-v1.mjs";

const rootArgIndex = process.argv.indexOf("--root");
const root = path.resolve(rootArgIndex >= 0 ? process.argv[rootArgIndex + 1] : ".");
const contractsDir = path.join(root, "contracts");
const files = fs.readdirSync(contractsDir).filter((file) => file.endsWith(".json"));
const contracts = new Map();

for (const file of files) {
  contracts.set(file, JSON.parse(fs.readFileSync(path.join(contractsDir, file), "utf8")));
}

function fromHex(value, label) {
  assert.equal(typeof value, "string", `${label} must be a hex string`);
  assert.match(value, /^(?:[0-9a-f]{2})+$/i, `${label} must contain whole hexadecimal bytes`);
  return Uint8Array.from(Buffer.from(value, "hex"));
}

const vectors = contracts.get("PROTOCOL_TEST_VECTORS.json");
const helloWire = vectors?.helloWire;
assert.ok(helloWire, "missing HELLO wire protocol vector");
const encodedHello = encodeHelloV1(helloWire.request);
assert.equal(encodedHello.byteLength, HELLO_V1_WIRE_BYTES);
assert.equal(helloWire.wireBytes, HELLO_V1_WIRE_BYTES);
assert.equal(helloWire.minimumGattMtu, HELLO_V1_MINIMUM_MTU);
assert.equal(
  encodedHello.toString("hex"),
  helloWire.requestHex,
  "HELLO wire vector mismatch"
);
assert.deepEqual(decodeHelloV1(encodedHello), helloWire.request);
const advertisement = vectors?.advertisement;
assert.ok(advertisement, "missing advertisement protocol vector");

const encodedPayload = encodeNodeAdvertisement(advertisement.fields);
assert.equal(
  bytesToHex(encodedPayload),
  advertisement.payloadHex,
  "advertisement payload vector mismatch"
);
assert.equal(encodedPayload.byteLength, advertisement.payloadBytes);
assert.deepEqual(decodeNodeAdvertisement(encodedPayload), advertisement.fields);

const encodedLegacyAdvertisingData = encodeLegacyAdvertisingData(advertisement.fields);
const bluezObservedAdvertisingData = fromHex(
  advertisement.bluezObservedAdvDataHex,
  "advertisement.bluezObservedAdvDataHex"
);
assert.equal(
  bytesToHex(encodedLegacyAdvertisingData),
  advertisement.legacyAdvertisingHex,
  "complete legacy advertising vector mismatch"
);
assert.equal(
  encodedLegacyAdvertisingData.byteLength,
  advertisement.legacyAdvertisingBytes
);
assert.equal(
  encodedLegacyAdvertisingData.byteLength,
  LEGACY_ADVERTISEMENT_BUDGET.maximumBytes
);
assert.deepEqual(
  decodeLegacyAdvertisingData(encodedLegacyAdvertisingData),
  advertisement.fields
);
assert.equal(
  bluezObservedAdvertisingData.byteLength,
  advertisement.legacyAdvertisingBytes,
  "BlueZ-observed AdvData budget mismatch"
);
assert.equal(
  bytesToHex(bluezObservedAdvertisingData),
  bytesToHex(
    Uint8Array.from([
      ...encodedLegacyAdvertisingData.subarray(3),
      ...encodedLegacyAdvertisingData.subarray(0, 3)
    ])
  ),
  "BlueZ-observed AdvData must be the exact Service Data-first permutation"
);
assert.deepEqual(
  decodeLegacyAdvertisingData(bluezObservedAdvertisingData),
  advertisement.fields,
  "BlueZ-observed Service Data-first AdvData must decode"
);
assert.throws(
  () => decodeLegacyAdvertisingData(encodedLegacyAdvertisingData.subarray(0, 30)),
  (error) => error?.code === "INVALID_ADVERTISING_DATA_LENGTH",
  "short AdvData must be rejected"
);
assert.throws(
  () =>
    decodeLegacyAdvertisingData(
      Uint8Array.from([...encodedLegacyAdvertisingData, 0x00])
    ),
  (error) => error?.code === "ADVERTISING_BUDGET_EXCEEDED",
  "AdvData with a trailing byte must be rejected"
);
const duplicateFlags = Uint8Array.from(encodedLegacyAdvertisingData);
duplicateFlags.set(encodedLegacyAdvertisingData.subarray(0, 3), 3);
assert.throws(
  () => decodeLegacyAdvertisingData(duplicateFlags),
  (error) => error?.code === "DUPLICATE_FLAGS",
  "duplicate Flags must be rejected"
);
const duplicateServiceData = Uint8Array.from(bluezObservedAdvertisingData);
duplicateServiceData.set(bluezObservedAdvertisingData.subarray(0, 3), 28);
assert.throws(
  () => decodeLegacyAdvertisingData(duplicateServiceData),
  (error) => error?.code === "DUPLICATE_SERVICE_DATA",
  "duplicate Service Data must be rejected"
);

const wrappedAdvertisement = {
  ...advertisement.fields,
  sequence: 0
};
const beforeWrapAdvertisement = {
  ...advertisement.fields,
  sequence: 255
};
assert.equal(
  compareAdvertisementSequence(wrappedAdvertisement, beforeWrapAdvertisement),
  ADVERTISEMENT_SEQUENCE_RELATIONS.NEWER,
  "advertisement serial comparison must accept 255 -> 0 wrap"
);
assert.equal(
  compareAdvertisementSequence(
    { ...wrappedAdvertisement, bootId: wrappedAdvertisement.bootId + 1 },
    beforeWrapAdvertisement
  ),
  ADVERTISEMENT_SEQUENCE_RELATIONS.INCOMPARABLE,
  "advertisements from different boot incarnations must not be serially ordered"
);

for (const vector of vectors.invalidAdvertisements) {
  assert.throws(
    () => decodeNodeAdvertisement(fromHex(vector.payloadHex, vector.name)),
    (error) => error?.code === vector.expectedError,
    `invalid advertisement ${vector.name} did not fail with ${vector.expectedError}`
  );
}

const aliasVector = vectors.rotatingAlias;
assert.equal(
  aliasVector.nodeIdSerialization,
  "canonical-lowercase-uuid-utf8-36",
  "rotating alias NodeId serialization is not frozen"
);
assert.equal(
  aliasVector.epochSerialization,
  "uint64-big-endian",
  "rotating alias epoch serialization is not frozen"
);
assert.equal(ROTATING_ALIAS_NODE_ID_UTF8_BYTES, 36);
assert.equal(ROTATING_ALIAS_EPOCH_BYTES, 8);
const aliasKey = fromHex(aliasVector.aliasKeyHex, "rotatingAlias.aliasKeyHex");
const aliasEpoch = rotatingAliasEpoch(
  aliasVector.timestampSeconds,
  aliasVector.epochSeconds
);
assert.equal(aliasEpoch, aliasVector.epoch, "rotating alias epoch mismatch");
assert.equal(
  bytesToHex(buildRotatingAliasMessage({ nodeId: aliasVector.nodeId, epoch: aliasEpoch })),
  aliasVector.messageHex,
  "rotating alias HMAC message mismatch"
);
assert.equal(
  createHmac("sha256", aliasKey)
    .update(buildRotatingAliasMessage({ nodeId: aliasVector.nodeId, epoch: aliasEpoch }))
    .digest("hex"),
  aliasVector.hmacSha256Hex,
  "rotating alias HMAC digest mismatch"
);
assert.equal(
  deriveRotatingAlias({
    aliasKey,
    nodeId: aliasVector.nodeId,
    timestampSeconds: aliasVector.timestampSeconds,
    epochSeconds: aliasVector.epochSeconds
  }),
  aliasVector.expectedAlias,
  "rotating alias result mismatch"
);

const gattUuids = JSON.parse(
  fs.readFileSync(path.join(root, "configs", "gatt-uuids.json"), "utf8")
);
const protocolDefaults = JSON.parse(
  fs.readFileSync(path.join(root, "configs", "protocol-defaults.json"), "utf8")
);
const discoveryPolicy = JSON.parse(
  fs.readFileSync(path.join(root, "configs", "discovery-policy.json"), "utf8")
);
const securityPolicy = JSON.parse(
  fs.readFileSync(path.join(root, "configs", "security-policy.json"), "utf8")
);
const advertisementSchema = contracts.get("node-advertisement-v1.schema.json");
const deviceRegistrySchema = contracts.get("device-registry-v1.schema.json");
const enrollmentQrSchema = contracts.get("enrollment-qr-v1.schema.json");
const enrollmentResponseSchema = contracts.get(
  "enrollment-response-v1.schema.json"
);
const helloSchema = contracts.get("hello-v1.schema.json");
const authChallengeSchema = contracts.get("auth-challenge-v1.schema.json");
const authResponseSchema = contracts.get("auth-response-v1.schema.json");
const authServerProofSchema = contracts.get(
  "auth-server-proof-v1.schema.json"
);
const authFinishSchema = contracts.get("auth-finish-v1.schema.json");
const ackSchema = contracts.get("ack-v1.schema.json");
const transportFrameSchema = contracts.get("transport-frame-v1.schema.json");
const directSessionVector = vectors?.directSession;
const canonicalUuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const canonicalUtcDatePattern =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";

assert.equal(advertisement.serviceUuid.toLowerCase(), GATT_SERVICE_UUID);
assert.equal(gattUuids.service.toLowerCase(), GATT_SERVICE_UUID);
assert.equal(gattUuids.advertisementServiceData.toLowerCase(), GATT_SERVICE_UUID);
assert.equal(CASSA_GATT_PROFILE_VERSION, 1);
assert.equal(CASSA_GATT_SERVICE_UUID, GATT_SERVICE_UUID);
assert.deepEqual(CASSA_GATT_CHARACTERISTIC_UUIDS, {
  hello: gattUuids.hello,
  controlRx: gattUuids.controlRx,
  controlTx: gattUuids.controlTx,
  dataRx: gattUuids.dataRx,
  dataTx: gattUuids.dataTx,
  ackTx: gattUuids.ackTx,
  metrics: gattUuids.metrics
});
assert.deepEqual(
  CASSA_GATT_CHARACTERISTICS.map(({ id, flags }) => [id, [...flags]]),
  [
    ["hello", ["read", "write"]],
    ["controlRx", ["write", "write-without-response"]],
    ["controlTx", ["notify", "indicate"]],
    ["dataRx", ["write", "write-without-response"]],
    ["dataTx", ["notify"]],
    ["ackTx", ["indicate"]],
    ["metrics", ["read", "notify"]]
  ]
);
assert.equal(protocolDefaults.protocolVersion, 1);
assert.equal(
  protocolDefaults.advertisementPayloadBytes,
  LEGACY_ADVERTISEMENT_BUDGET.payloadBytes
);
assert.equal(protocolDefaults.rotatingAliasBits, 48);
assert.equal(protocolDefaults.advertisementBootIdBits, 8);
assert.equal(protocolDefaults.advertisementCapabilityBits, 7);
assert.equal(protocolDefaults.advertisementSequenceBits, 8);
assert.equal(protocolDefaults.advertisementEpochSeconds, aliasVector.epochSeconds);
assert.ok(directSessionVector, "missing direct session protocol vector");
assert.equal(
  directSessionVector.protocolVersion,
  DIRECT_SESSION_PROTOCOL_VERSION
);
assert.equal(
  directSessionVector.sessionIdEncoding,
  "base64url-unpadded-128-bit"
);
assert.match(
  directSessionVector.sessionId,
  new RegExp(DIRECT_SESSION_ID_PATTERN_SOURCE)
);
assert.equal(
  Buffer.from(directSessionVector.sessionId, "base64url").toString("base64url"),
  directSessionVector.sessionId,
  "direct session identifier must use canonical base64url"
);
assert.equal(
  directSessionVector.roles.android,
  DIRECT_SESSION_ROLES.ANDROID_CLIENT
);
assert.equal(
  directSessionVector.roles.raspberry,
  DIRECT_SESSION_ROLES.RASPBERRY_SERVER
);
assert.equal(directSessionVector.minimumGattMtu, MINIMUM_GATT_MTU);
assert.equal(directSessionVector.preferredGattMtu, DEFAULT_PREFERRED_GATT_MTU);
assert.equal(directSessionVector.maximumGattMtu, MAXIMUM_GATT_MTU);
assert.equal(
  directSessionVector.heartbeatMissesBeforeClose,
  DEFAULT_HEARTBEAT_MISSES_BEFORE_CLOSE
);
assert.deepEqual(directSessionVector.androidClientSequence, [
  "GATT_CONNECTED",
  "SERVICES_DISCOVERED",
  "MTU_NEGOTIATED",
  "HELLO_ACCEPTED",
  "AUTH_STARTED",
  "AUTH_VERIFIED",
  "SESSION_KEY_ESTABLISHED",
  "HEARTBEAT_STARTED"
]);
assert.deepEqual(directSessionVector.raspberryServerSequence, [
  "GATT_CONNECTED",
  "MTU_NEGOTIATED",
  "HELLO_ACCEPTED",
  "AUTH_STARTED",
  "AUTH_VERIFIED",
  "SESSION_KEY_ESTABLISHED",
  "HEARTBEAT_STARTED"
]);
for (const schema of [
  helloSchema,
  authChallengeSchema,
  authResponseSchema,
  authServerProofSchema,
  authFinishSchema,
  ackSchema,
  transportFrameSchema
]) {
  assert.equal(
    schema.properties.sessionId.pattern,
    DIRECT_SESSION_ID_PATTERN_SOURCE,
    "all B5 wire schemas must share the frozen 128-bit sessionId encoding"
  );
}
assert.equal(
  protocolDefaults.peerExpiryMs,
  PEER_AGING_THROUGH_MS,
  "peerExpiryMs is the last inclusive aging boundary; expiration is strictly above it"
);
assert.equal(discoveryPolicy.legacyAdvertising.layout, "single-service-data-128");
assert.equal(discoveryPolicy.legacyAdvertising.maxAdvertisementBytes, 31);
assert.deepEqual(
  discoveryPolicy.legacyAdvertising.referenceEncoderStructureOrder,
  ["flags", "service-data-128"]
);
assert.deepEqual(
  discoveryPolicy.legacyAdvertising.acceptedDecoderStructureOrders,
  [
    ["flags", "service-data-128"],
    ["service-data-128", "flags"]
  ]
);
assert.equal(discoveryPolicy.legacyAdvertising.scanResponseRequired, false);
assert.equal(discoveryPolicy.legacyAdvertising.includeLocalName, false);
assert.equal(discoveryPolicy.legacyAdvertising.includeTxPower, false);
assert.equal(discoveryPolicy.legacyAdvertising.includeSeparateServiceUuidList, false);
assert.equal(
  discoveryPolicy.legacyAdvertising.flagsStructureBytes +
    discoveryPolicy.legacyAdvertising.serviceData128OverheadBytes +
    discoveryPolicy.legacyAdvertising.payloadBytes,
  discoveryPolicy.legacyAdvertising.maxAdvertisementBytes
);
assert.deepEqual(discoveryPolicy.peerStreamKeyFields, [
  "rotatingAlias",
  "bootId"
]);
assert.equal(discoveryPolicy.rssiFloorDbm, PEER_RSSI_FLOOR_DBM);
assert.equal(discoveryPolicy.peerFreshBeforeMs, PEER_FRESH_BEFORE_MS);
assert.equal(discoveryPolicy.peerAgingThroughMs, PEER_AGING_THROUGH_MS);
assert.equal(discoveryPolicy.maxPeerStreams, MAX_PEER_STREAMS);
assert.equal(
  discoveryPolicy.peerPruneIntervalMs,
  PEER_PRUNE_INTERVAL_MS
);
assert.equal(
  discoveryPolicy.newStreamAttemptWindowMs,
  PEER_NEW_STREAM_WINDOW_MS
);
assert.equal(
  discoveryPolicy.maxNewStreamAttemptsPerWindow,
  MAX_NEW_STREAM_ATTEMPTS_PER_WINDOW
);
assert.equal(
  discoveryPolicy.capacityReplacementRssiMarginDb,
  PEER_REPLACEMENT_RSSI_MARGIN_DB
);
assert.equal(discoveryPolicy.scanWindowsMustBeNonContinuous, true);
assert.equal(discoveryPolicy.advertisementEstablishesStableIdentity, false);
assert.equal(discoveryPolicy.advertisementEstablishesAuthentication, false);
const validatedScanPolicy = validateScanWindowPolicyV1({
  stable: {
    windowMs: discoveryPolicy.stableScanWindowMs,
    periodMs: discoveryPolicy.stableScanPeriodMs
  },
  failover: {
    windowMs: discoveryPolicy.failoverScanWindowMs,
    periodMs: discoveryPolicy.failoverScanPeriodMs
  }
});
assert.deepEqual(validatedScanPolicy, DEFAULT_SCAN_WINDOW_POLICY_V1);
assert.equal(securityPolicy.advertisementStableIds, false);
assert.equal(securityPolicy.rotatingAlias, true);
assert.equal(securityPolicy.enrollmentRuntimeEnabledByDefault, false);
assert.equal(securityPolicy.enrollmentTokenOneTime, true);
assert.equal(securityPolicy.deviceRegistryFileMode, "0600");
assert.equal(securityPolicy.storeAndroidPrivateKeys, false);
assert.ok(securityPolicy.enrollmentTokenMinimumBits <= 256);
assert.equal(deviceRegistrySchema.$defs.uuid.pattern, canonicalUuidPattern);
assert.equal(
  deviceRegistrySchema.properties.createdAt.pattern,
  canonicalUtcDatePattern
);
assert.equal(
  deviceRegistrySchema.$defs.device.properties.publicKeySpkiDerBase64.pattern,
  "^[A-Za-z0-9+/]{58}[AEIMQUYcgkosw048]=$"
);
assert.equal(
  deviceRegistrySchema.$defs.device.properties.aliasKeyBase64url.pattern,
  "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$"
);
assert.equal(
  deviceRegistrySchema.$defs.enrollmentToken.properties.tokenHashBase64.pattern,
  "^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$"
);
assert.equal(
  enrollmentQrSchema.properties.token.pattern,
  "^c5e1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$"
);
assert.equal(enrollmentResponseSchema.properties.protocolVersion.const, 1);
assert.equal(
  enrollmentResponseSchema.properties.nodeId.pattern,
  canonicalUuidPattern
);
assert.equal(
  enrollmentResponseSchema.properties.publicKeySpkiDerBase64.pattern,
  "^[A-Za-z0-9+/]{58}[AEIMQUYcgkosw048]=$"
);
assert.equal(
  enrollmentResponseSchema.properties.aliasKeyEncoding.const,
  "base64url-unpadded"
);
assert.equal(
  enrollmentResponseSchema.properties.aliasKeyBase64url.pattern,
  "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$"
);
assert.equal(
  enrollmentResponseSchema.properties.enrolledAt.pattern,
  canonicalUtcDatePattern
);
assert.equal(
  advertisementSchema.properties.rotatingAlias.pattern,
  "^[0-9a-fA-F]{12}$"
);
assert.equal(advertisementSchema.properties.bootId.minimum, 1);
assert.equal(advertisementSchema.properties.bootId.maximum, 255);
assert.equal(advertisementSchema.properties.capabilities.maximum, 127);
assert.equal(advertisementSchema.properties.sequence.maximum, 255);
assert.ok(advertisementSchema.required.includes("serverReachable"));

const characteristicUuids = Object.entries(gattUuids)
  .filter(([name]) => name !== "advertisementServiceData")
  .map(([, uuid]) => uuid.toLowerCase());
assert.equal(new Set(characteristicUuids).size, characteristicUuids.length);
for (const uuid of characteristicUuids) {
  assert.match(uuid, /^b1c4a500-7d1f-4f32-9a64-4f4b6c41000[1-8]$/);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      jsonContracts: files.length,
      advertisement: {
        payloadBytes: encodedPayload.byteLength,
        completeLegacyAdvertisingBytes: encodedLegacyAdvertisingData.byteLength,
        legacyAdvDataLimitBytes: LEGACY_ADVERTISEMENT_BUDGET.maximumBytes,
        scanResponseRequired: false,
        rotatingAliasBits: protocolDefaults.rotatingAliasBits,
        canonicalDecoder: true,
        referenceEncoderStructureOrder: "flags,service-data-128",
        acceptedDecoderStructureOrders: [
          "flags,service-data-128",
          "service-data-128,flags"
        ],
        sequenceComparison: "modulo-256-half-range"
      },
      rotatingAlias: {
        algorithm: aliasVector.algorithm,
        epochSeconds: aliasVector.epochSeconds,
        nodeIdSerialization: aliasVector.nodeIdSerialization,
        epochSerialization: aliasVector.epochSerialization,
        vectorPassed: true
      },
      gattProfile: {
        protocolVersion: CASSA_GATT_PROFILE_VERSION,
        serviceUuid: CASSA_GATT_SERVICE_UUID,
        characteristicCount: CASSA_GATT_CHARACTERISTICS.length,
        configMatched: true
      },
      directSession: {
        protocolVersion: DIRECT_SESSION_PROTOCOL_VERSION,
        roles: directSessionVector.roles,
        minimumGattMtu: MINIMUM_GATT_MTU,
        preferredGattMtu: DEFAULT_PREFERRED_GATT_MTU,
        maximumGattMtu: MAXIMUM_GATT_MTU,
        heartbeatMissesBeforeClose:
          DEFAULT_HEARTBEAT_MISSES_BEFORE_CLOSE,
        vectorPassed: true
      }
    },
    null,
    2
  )
);
