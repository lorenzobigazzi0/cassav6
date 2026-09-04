import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ADVERTISEMENT_SEQUENCE_RELATIONS,
  CAPABILITY_BITS,
  GATT_SERVICE_UUID,
  LEGACY_ADVERTISEMENT_BUDGET,
  ProtocolValidationError,
  bytesToHex,
  compareAdvertisementSequence,
  decodeLegacyAdvertisingData,
  decodeNodeAdvertisement,
  encodeLegacyAdvertisingData,
  encodeNodeAdvertisement,
  uuid128ToLittleEndian
} from "./advertisement-v1.mjs";
import {
  ROTATING_ALIAS_CONTEXT,
  ROTATING_ALIAS_EPOCH_BYTES,
  ROTATING_ALIAS_NODE_ID_UTF8_BYTES,
  buildRotatingAliasMessage,
  deriveRotatingAlias,
  rotatingAliasEpoch
} from "./rotating-alias-v1.mjs";

const vectorsUrl = new URL("../../contracts/PROTOCOL_TEST_VECTORS.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8"));

function fromHex(value) {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

test("legacy AdvData budget is exactly 31 bytes", () => {
  assert.deepEqual(LEGACY_ADVERTISEMENT_BUDGET, {
    maximumBytes: 31,
    flagsStructureBytes: 3,
    serviceDataStructureOverheadBytes: 18,
    payloadBytes: 10,
    totalBytes: 31
  });
  assert.equal(
    LEGACY_ADVERTISEMENT_BUDGET.flagsStructureBytes +
      LEGACY_ADVERTISEMENT_BUDGET.serviceDataStructureOverheadBytes +
      LEGACY_ADVERTISEMENT_BUDGET.payloadBytes,
    LEGACY_ADVERTISEMENT_BUDGET.maximumBytes
  );
});

test("service UUID uses Bluetooth little-endian wire order", () => {
  assert.equal(GATT_SERVICE_UUID, vectors.advertisement.serviceUuid);
  assert.equal(
    bytesToHex(uuid128ToLittleEndian(GATT_SERVICE_UUID)),
    "0100416c4b4f649a324f1f7d00a5c4b1"
  );
});

test("advertisement payload matches the frozen v1 vector", () => {
  const encoded = encodeNodeAdvertisement(vectors.advertisement.fields);
  assert.equal(bytesToHex(encoded), vectors.advertisement.payloadHex);
  assert.deepEqual(decodeNodeAdvertisement(encoded), vectors.advertisement.fields);
});

test("complete legacy advertising data matches the frozen 31-byte vector", () => {
  const encoded = encodeLegacyAdvertisingData(vectors.advertisement.fields);
  assert.equal(encoded.byteLength, vectors.advertisement.legacyAdvertisingBytes);
  assert.equal(bytesToHex(encoded), vectors.advertisement.legacyAdvertisingHex);
  assert.deepEqual(decodeLegacyAdvertisingData(encoded), vectors.advertisement.fields);
});

test("decoder accepts the exact BlueZ-observed Service Data-first order", () => {
  const observed = fromHex(vectors.advertisement.bluezObservedAdvDataHex);
  assert.equal(observed.byteLength, vectors.advertisement.legacyAdvertisingBytes);
  assert.deepEqual(
    decodeLegacyAdvertisingData(observed),
    vectors.advertisement.fields
  );

  const reference = encodeLegacyAdvertisingData(vectors.advertisement.fields);
  assert.equal(
    bytesToHex(observed),
    bytesToHex(
      Uint8Array.from([...reference.subarray(3), ...reference.subarray(0, 3)])
    )
  );
});

test("capability bitmap has independent v1 bits", () => {
  assert.deepEqual(CAPABILITY_BITS, {
    SCAN: 0x01,
    ADVERTISE: 0x02,
    GATT_CLIENT: 0x04,
    GATT_SERVER: 0x08,
    CONCURRENT_SCAN_ADVERTISE: 0x10,
    LOCAL_DURABILITY: 0x20,
    BACKEND_BRIDGE: 0x40
  });
  assert.equal(
    CAPABILITY_BITS.SCAN |
      CAPABILITY_BITS.ADVERTISE |
      CAPABILITY_BITS.GATT_CLIENT |
      CAPABILITY_BITS.GATT_SERVER |
      CAPABILITY_BITS.LOCAL_DURABILITY,
    vectors.advertisement.fields.capabilities
  );
  assert.equal(
    Object.values(CAPABILITY_BITS).reduce((combined, bit) => combined | bit, 0),
    0x7f
  );
});

test("all node kinds and boundary values round-trip", () => {
  for (const nodeKind of ["raspberry", "handheld", "station"]) {
    for (const serverReachable of [false, true]) {
      const fields = {
        protocolVersion: 1,
        nodeKind,
        rotatingAlias: "000000000001",
        bootId: 255,
        capabilities: 0x7f,
        serverReachable,
        sequence: 255
      };
      assert.deepEqual(decodeNodeAdvertisement(encodeNodeAdvertisement(fields)), fields);
    }
  }
});

test("advertisement sequence uses conservative modulo-256 serial comparison", () => {
  const reference = vectors.advertisement.fields;
  const candidate = (fields) => ({ ...reference, ...fields });

  assert.equal(
    compareAdvertisementSequence(candidate({ sequence: 102 }), reference),
    ADVERTISEMENT_SEQUENCE_RELATIONS.DUPLICATE
  );
  assert.equal(
    compareAdvertisementSequence(candidate({ sequence: 103 }), reference),
    ADVERTISEMENT_SEQUENCE_RELATIONS.NEWER
  );
  assert.equal(
    compareAdvertisementSequence(candidate({ sequence: 101 }), reference),
    ADVERTISEMENT_SEQUENCE_RELATIONS.OLDER
  );
  assert.equal(
    compareAdvertisementSequence(candidate({ sequence: 230 }), reference),
    ADVERTISEMENT_SEQUENCE_RELATIONS.AMBIGUOUS
  );
  assert.equal(
    compareAdvertisementSequence(candidate({ sequence: 0 }), candidate({ sequence: 255 })),
    ADVERTISEMENT_SEQUENCE_RELATIONS.NEWER
  );
  assert.equal(
    compareAdvertisementSequence(candidate({ sequence: 255 }), candidate({ sequence: 0 })),
    ADVERTISEMENT_SEQUENCE_RELATIONS.OLDER
  );
  assert.equal(
    compareAdvertisementSequence(candidate({ bootId: 18, sequence: 0 }), reference),
    ADVERTISEMENT_SEQUENCE_RELATIONS.INCOMPARABLE
  );
  assert.equal(
    compareAdvertisementSequence(
      candidate({ rotatingAlias: "aabbccddee00", sequence: 0 }),
      reference
    ),
    ADVERTISEMENT_SEQUENCE_RELATIONS.INCOMPARABLE
  );
});

test("object validation rejects unsafe or ambiguous values", () => {
  const valid = vectors.advertisement.fields;
  const invalid = [
    [{ ...valid, protocolVersion: 2 }, "UNSUPPORTED_VERSION"],
    [{ ...valid, nodeKind: "unknown" }, "INVALID_NODE_KIND"],
    [{ ...valid, rotatingAlias: "aabbccddeeff00" }, "INVALID_ALIAS"],
    [{ ...valid, bootId: 0 }, "INVALID_FIELD"],
    [{ ...valid, capabilities: 128 }, "INVALID_FIELD"],
    [{ ...valid, serverReachable: 1 }, "INVALID_FIELD"],
    [{ ...valid, sequence: 256 }, "INVALID_FIELD"],
    [{ ...valid, extra: true }, "UNKNOWN_FIELD"]
  ];

  for (const [fields, expectedError] of invalid) {
    assert.throws(
      () => encodeNodeAdvertisement(fields),
      (error) =>
        error instanceof ProtocolValidationError && error.code === expectedError
    );
  }
});

test("legacy AdvData decoder rejects malformed, duplicate, extra, or trailing structures", () => {
  const canonical = encodeLegacyAdvertisingData(vectors.advertisement.fields);
  const bluezObserved = fromHex(vectors.advertisement.bluezObservedAdvDataHex);
  const duplicateFlags = Uint8Array.from(canonical);
  duplicateFlags.set(canonical.subarray(0, 3), 3);
  const duplicateServiceData = Uint8Array.from(bluezObserved);
  duplicateServiceData.set(bluezObserved.subarray(0, 3), 28);
  const invalid = [
    [canonical.subarray(0, 30), "INVALID_ADVERTISING_DATA_LENGTH"],
    [Uint8Array.from([...canonical, 0x00]), "ADVERTISING_BUDGET_EXCEEDED"],
    [Uint8Array.from(canonical, (byte, index) => (index === 0 ? 0x00 : byte)), "INVALID_AD_STRUCTURE_LENGTH"],
    [Uint8Array.from(canonical, (byte, index) => (index === 0 ? 0x03 : byte)), "NON_CANONICAL_FLAGS"],
    [Uint8Array.from(canonical, (byte, index) => (index === 1 ? 0xff : byte)), "UNEXPECTED_AD_STRUCTURE"],
    [Uint8Array.from(canonical, (byte, index) => (index === 2 ? 0x04 : byte)), "NON_CANONICAL_FLAGS"],
    [
      Uint8Array.from(canonical, (byte, index) => (index === 3 ? 0x1a : byte)),
      "NON_CANONICAL_SERVICE_DATA"
    ],
    [
      Uint8Array.from(canonical, (byte, index) => (index === 4 ? 0x20 : byte)),
      "UNEXPECTED_AD_STRUCTURE"
    ],
    [
      Uint8Array.from(canonical, (byte, index) => (index === 5 ? byte ^ 0x01 : byte)),
      "SERVICE_UUID_MISMATCH"
    ],
    [duplicateFlags, "DUPLICATE_FLAGS"],
    [duplicateServiceData, "DUPLICATE_SERVICE_DATA"],
    [
      Uint8Array.from(
        bluezObserved,
        (byte, index) => (index === bluezObserved.byteLength - 1 ? 0x04 : byte)
      ),
      "NON_CANONICAL_FLAGS"
    ],
    [
      Uint8Array.from(bluezObserved, (byte, index) => (index === 2 ? byte ^ 0x01 : byte)),
      "SERVICE_UUID_MISMATCH"
    ]
  ];

  for (const [advertisingData, expectedError] of invalid) {
    assert.throws(
      () => decodeLegacyAdvertisingData(advertisingData),
      (error) =>
        error instanceof ProtocolValidationError && error.code === expectedError
    );
  }
});

for (const vector of vectors.invalidAdvertisements) {
  test(`rejects invalid advertisement: ${vector.name}`, () => {
    assert.throws(
      () => decodeNodeAdvertisement(fromHex(vector.payloadHex)),
      (error) =>
        error instanceof ProtocolValidationError && error.code === vector.expectedError
    );
  });
}

test("rotating alias derivation matches the frozen HMAC-SHA256 vector", () => {
  const vector = vectors.rotatingAlias;
  const aliasKey = fromHex(vector.aliasKeyHex);
  const epoch = rotatingAliasEpoch(vector.timestampSeconds, vector.epochSeconds);
  const message = buildRotatingAliasMessage({ nodeId: vector.nodeId, epoch });

  assert.equal(epoch, vector.epoch);
  assert.equal(bytesToHex(message), vector.messageHex);
  assert.equal(
    createHmac("sha256", aliasKey).update(message).digest("hex"),
    vector.hmacSha256Hex
  );
  assert.equal(
    deriveRotatingAlias({
      aliasKey,
      nodeId: vector.nodeId,
      timestampSeconds: vector.timestampSeconds,
      epochSeconds: vector.epochSeconds
    }),
    vector.expectedAlias
  );
});

test("rotating alias HMAC message uses the normative byte serialization", () => {
  const vector = vectors.rotatingAlias;
  const message = buildRotatingAliasMessage({
    nodeId: vector.nodeId,
    epoch: vector.epoch
  });
  const contextBytes = Buffer.from(ROTATING_ALIAS_CONTEXT, "utf8");
  const nodeIdOffset = contextBytes.byteLength;
  const delimiterOffset = nodeIdOffset + ROTATING_ALIAS_NODE_ID_UTF8_BYTES;
  const epochOffset = delimiterOffset + 1;

  assert.equal(
    message.byteLength,
    contextBytes.byteLength +
      ROTATING_ALIAS_NODE_ID_UTF8_BYTES +
      1 +
      ROTATING_ALIAS_EPOCH_BYTES
  );
  assert.equal(
    bytesToHex(message.subarray(0, nodeIdOffset)),
    contextBytes.toString("hex")
  );
  assert.equal(
    Buffer.from(message.subarray(nodeIdOffset, delimiterOffset)).toString("utf8"),
    vector.nodeId
  );
  assert.equal(message[delimiterOffset], 0);
  assert.equal(
    new DataView(message.buffer, message.byteOffset + epochOffset, 8).getBigUint64(
      0,
      false
    ),
    BigInt(vector.epoch)
  );
});

test("rotating alias is stable inside an epoch and changes at the boundary", () => {
  const vector = vectors.rotatingAlias;
  const aliasKey = fromHex(vector.aliasKeyHex);
  const common = {
    aliasKey,
    nodeId: vector.nodeId,
    epochSeconds: vector.epochSeconds
  };

  const beforeBoundary = deriveRotatingAlias({
    ...common,
    timestampSeconds: vector.timestampSeconds + 59
  });
  const atBoundary = deriveRotatingAlias({
    ...common,
    timestampSeconds: vector.timestampSeconds + 60
  });

  assert.equal(beforeBoundary, vector.expectedAlias);
  assert.notEqual(atBoundary, vector.expectedAlias);
});

test("rotating alias rejects invalid keys, node IDs, and time values", () => {
  const vector = vectors.rotatingAlias;
  const validKey = fromHex(vector.aliasKeyHex);
  assert.throws(
    () =>
      deriveRotatingAlias({
        aliasKey: validKey.subarray(0, 31),
        nodeId: vector.nodeId,
        timestampSeconds: vector.timestampSeconds
      }),
    /aliasKey/
  );
  assert.throws(
    () =>
      deriveRotatingAlias({
        aliasKey: validKey,
        nodeId: "not-a-node-id",
        timestampSeconds: vector.timestampSeconds
      }),
    /nodeId/
  );
  assert.throws(
    () =>
      deriveRotatingAlias({
        aliasKey: validKey,
        nodeId: vector.nodeId.toUpperCase(),
        timestampSeconds: vector.timestampSeconds
      }),
    /canonical lowercase/
  );
  assert.throws(
    () =>
      deriveRotatingAlias({
        aliasKey: validKey,
        nodeId: vector.nodeId,
        timestampSeconds: -1
      }),
    /timestampSeconds/
  );
});
