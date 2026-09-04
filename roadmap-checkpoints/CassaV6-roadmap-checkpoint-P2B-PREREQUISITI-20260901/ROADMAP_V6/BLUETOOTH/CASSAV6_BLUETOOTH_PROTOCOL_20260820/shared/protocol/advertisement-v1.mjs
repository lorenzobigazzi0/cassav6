export const PROTOCOL_VERSION = 1;
export const GATT_SERVICE_UUID = "3c9734f1-46cb-5672-96e9-e7a03a710f95";
export const AD_TYPE_FLAGS = 0x01;
export const AD_TYPE_SERVICE_DATA_128 = 0x21;
export const LEGACY_FLAGS = 0x06;

export const LEGACY_ADVERTISEMENT_BUDGET = Object.freeze({
  maximumBytes: 31,
  flagsStructureBytes: 3,
  serviceDataStructureOverheadBytes: 18,
  payloadBytes: 10,
  totalBytes: 31
});

export const NODE_KIND_CODES = Object.freeze({
  raspberry: 1,
  handheld: 2,
  station: 3
});

export const CAPABILITY_BITS = Object.freeze({
  SCAN: 0x01,
  ADVERTISE: 0x02,
  GATT_CLIENT: 0x04,
  GATT_SERVER: 0x08,
  CONCURRENT_SCAN_ADVERTISE: 0x10,
  LOCAL_DURABILITY: 0x20,
  BACKEND_BRIDGE: 0x40
});

export const ADVERTISEMENT_SEQUENCE_RELATIONS = Object.freeze({
  INCOMPARABLE: "incomparable",
  DUPLICATE: "duplicate",
  NEWER: "newer",
  OLDER: "older",
  AMBIGUOUS: "ambiguous"
});

const NODE_KINDS_BY_CODE = Object.freeze(
  Object.fromEntries(Object.entries(NODE_KIND_CODES).map(([name, code]) => [code, name]))
);
const ALLOWED_FIELDS = new Set([
  "protocolVersion",
  "nodeKind",
  "rotatingAlias",
  "bootId",
  "capabilities",
  "serverReachable",
  "sequence"
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALIAS_PATTERN = /^[0-9a-f]{12}$/i;

export class ProtocolValidationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProtocolValidationError(code, message);
}

function assertIntegerInRange(value, minimum, maximum, field) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(
      "INVALID_FIELD",
      `${field} must be an integer between ${minimum} and ${maximum}`
    );
  }
}

function asBytes(value, field) {
  if (!(value instanceof Uint8Array)) {
    fail("INVALID_BYTES", `${field} must be a Uint8Array`);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function bytesToHex(value) {
  return [...asBytes(value, "value")]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(value, field = "hex") {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    fail("INVALID_HEX", `${field} must contain an even number of hexadecimal characters`);
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function uuid128ToLittleEndian(uuid) {
  if (typeof uuid !== "string" || !UUID_PATTERN.test(uuid)) {
    fail("INVALID_UUID", "uuid must use the canonical 128-bit UUID representation");
  }
  return hexToBytes(uuid.replaceAll("-", ""), "uuid").reverse();
}

export function validateNodeAdvertisement(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ADVERTISEMENT", "advertisement must be an object");
  }

  const extraFields = Object.keys(value).filter((field) => !ALLOWED_FIELDS.has(field));
  if (extraFields.length > 0) {
    fail("UNKNOWN_FIELD", `unknown advertisement field: ${extraFields.join(", ")}`);
  }

  if (value.protocolVersion !== PROTOCOL_VERSION) {
    fail("UNSUPPORTED_VERSION", `protocolVersion must be ${PROTOCOL_VERSION}`);
  }
  if (!Object.hasOwn(NODE_KIND_CODES, value.nodeKind)) {
    fail("INVALID_NODE_KIND", "nodeKind must be raspberry, handheld, or station");
  }
  if (typeof value.rotatingAlias !== "string" || !ALIAS_PATTERN.test(value.rotatingAlias)) {
    fail("INVALID_ALIAS", "rotatingAlias must contain exactly 12 hexadecimal characters");
  }
  assertIntegerInRange(value.bootId, 1, 255, "bootId");
  assertIntegerInRange(value.capabilities, 0, 0x7f, "capabilities");
  if (typeof value.serverReachable !== "boolean") {
    fail("INVALID_FIELD", "serverReachable must be a boolean");
  }
  assertIntegerInRange(value.sequence, 0, 255, "sequence");

  return Object.freeze({
    protocolVersion: value.protocolVersion,
    nodeKind: value.nodeKind,
    rotatingAlias: value.rotatingAlias.toLowerCase(),
    bootId: value.bootId,
    capabilities: value.capabilities,
    serverReachable: value.serverReachable,
    sequence: value.sequence
  });
}

export function encodeNodeAdvertisement(value) {
  const advertisement = validateNodeAdvertisement(value);
  const payload = new Uint8Array(LEGACY_ADVERTISEMENT_BUDGET.payloadBytes);

  payload[0] =
    advertisement.protocolVersion |
    (NODE_KIND_CODES[advertisement.nodeKind] << 3) |
    (advertisement.serverReachable ? 0x20 : 0);
  payload.set(hexToBytes(advertisement.rotatingAlias, "rotatingAlias"), 1);
  payload[7] = advertisement.bootId;
  payload[8] = advertisement.capabilities;
  payload[9] = advertisement.sequence;
  return payload;
}

export function decodeNodeAdvertisement(value) {
  const payload = asBytes(value, "payload");
  if (payload.byteLength !== LEGACY_ADVERTISEMENT_BUDGET.payloadBytes) {
    fail(
      "INVALID_PAYLOAD_LENGTH",
      `v1 advertisement payload must be ${LEGACY_ADVERTISEMENT_BUDGET.payloadBytes} bytes`
    );
  }

  const header = payload[0];
  if ((header & 0xc0) !== 0) {
    fail("RESERVED_HEADER_BITS", "v1 advertisement header reserved bits must be zero");
  }
  if ((payload[8] & 0x80) !== 0) {
    fail("RESERVED_CAPABILITY_BITS", "v1 capability bitmap reserved bit must be zero");
  }

  const protocolVersion = header & 0x07;
  const nodeKindCode = (header >> 3) & 0x03;
  const nodeKind = NODE_KINDS_BY_CODE[nodeKindCode];
  if (protocolVersion !== PROTOCOL_VERSION) {
    fail("UNSUPPORTED_VERSION", `unsupported advertisement protocol version ${protocolVersion}`);
  }
  if (nodeKind === undefined) {
    fail("INVALID_NODE_KIND", `unsupported advertisement node kind ${nodeKindCode}`);
  }

  return validateNodeAdvertisement({
    protocolVersion,
    nodeKind,
    rotatingAlias: bytesToHex(payload.subarray(1, 7)),
    bootId: payload[7],
    capabilities: payload[8],
    serverReachable: (header & 0x20) !== 0,
    sequence: payload[9]
  });
}

export function compareAdvertisementSequence(candidateValue, referenceValue) {
  const candidate = validateNodeAdvertisement(candidateValue);
  const reference = validateNodeAdvertisement(referenceValue);

  if (
    candidate.rotatingAlias !== reference.rotatingAlias ||
    candidate.bootId !== reference.bootId
  ) {
    return ADVERTISEMENT_SEQUENCE_RELATIONS.INCOMPARABLE;
  }

  // Half-range serial arithmetic leaves the exact 128-step distance unordered.
  const forwardDistance = (candidate.sequence - reference.sequence + 256) % 256;
  if (forwardDistance === 0) {
    return ADVERTISEMENT_SEQUENCE_RELATIONS.DUPLICATE;
  }
  if (forwardDistance === 128) {
    return ADVERTISEMENT_SEQUENCE_RELATIONS.AMBIGUOUS;
  }
  if (forwardDistance < 128) {
    return ADVERTISEMENT_SEQUENCE_RELATIONS.NEWER;
  }
  return ADVERTISEMENT_SEQUENCE_RELATIONS.OLDER;
}

export function encodeLegacyAdvertisingData(value) {
  const payload = encodeNodeAdvertisement(value);
  const result = new Uint8Array(LEGACY_ADVERTISEMENT_BUDGET.totalBytes);
  const serviceUuid = uuid128ToLittleEndian(GATT_SERVICE_UUID);

  result.set([0x02, AD_TYPE_FLAGS, LEGACY_FLAGS], 0);
  result[3] = 1 + serviceUuid.byteLength + payload.byteLength;
  result[4] = AD_TYPE_SERVICE_DATA_128;
  result.set(serviceUuid, 5);
  result.set(payload, 5 + serviceUuid.byteLength);
  return result;
}

export function decodeLegacyAdvertisingData(value) {
  const advertisingData = asBytes(value, "advertisingData");
  if (advertisingData.byteLength > LEGACY_ADVERTISEMENT_BUDGET.maximumBytes) {
    fail(
      "ADVERTISING_BUDGET_EXCEEDED",
      `legacy advertising data cannot exceed ${LEGACY_ADVERTISEMENT_BUDGET.maximumBytes} bytes`
    );
  }
  if (advertisingData.byteLength !== LEGACY_ADVERTISEMENT_BUDGET.totalBytes) {
    fail(
      "INVALID_ADVERTISING_DATA_LENGTH",
      `Cassa V6 v1 AdvData must be exactly ${LEGACY_ADVERTISEMENT_BUDGET.totalBytes} bytes`
    );
  }

  const expectedUuid = uuid128ToLittleEndian(GATT_SERVICE_UUID);
  const serviceDataLength =
    1 + expectedUuid.byteLength + LEGACY_ADVERTISEMENT_BUDGET.payloadBytes;
  let offset = 0;
  let structureCount = 0;
  let flagsSeen = false;
  let servicePayload;

  while (offset < advertisingData.byteLength) {
    const structureLength = advertisingData[offset];
    if (structureLength === 0) {
      fail("INVALID_AD_STRUCTURE_LENGTH", "AD structures cannot have zero length");
    }
    if (offset + 1 >= advertisingData.byteLength) {
      fail("TRUNCATED_AD_STRUCTURE", "AD structure is missing its type");
    }

    const structureType = advertisingData[offset + 1];
    if (structureType === AD_TYPE_FLAGS && flagsSeen) {
      fail("DUPLICATE_FLAGS", "Cassa V6 v1 AdvData contains duplicate Flags");
    }
    if (
      structureType === AD_TYPE_SERVICE_DATA_128 &&
      servicePayload !== undefined
    ) {
      fail(
        "DUPLICATE_SERVICE_DATA",
        "Cassa V6 v1 AdvData contains duplicate 128-bit Service Data"
      );
    }
    const structureEnd = offset + 1 + structureLength;
    if (structureEnd > advertisingData.byteLength) {
      fail("TRUNCATED_AD_STRUCTURE", "AD structure extends beyond AdvData");
    }

    structureCount += 1;

    if (structureType === AD_TYPE_FLAGS) {
      flagsSeen = true;
      if (
        structureLength !== 2 ||
        advertisingData[offset + 2] !== LEGACY_FLAGS
      ) {
        fail(
          "NON_CANONICAL_FLAGS",
          "Cassa V6 v1 AdvData requires the exact Flags structure 02 01 06"
        );
      }
    } else if (structureType === AD_TYPE_SERVICE_DATA_128) {
      if (structureLength !== serviceDataLength) {
        fail(
          "NON_CANONICAL_SERVICE_DATA",
          "Cassa V6 v1 AdvData requires one exact 128-bit Service Data structure"
        );
      }

      const uuidOffset = offset + 2;
      const serviceUuid = advertisingData.subarray(
        uuidOffset,
        uuidOffset + expectedUuid.byteLength
      );
      if (bytesToHex(serviceUuid) !== bytesToHex(expectedUuid)) {
        fail(
          "SERVICE_UUID_MISMATCH",
          "Cassa V6 v1 AdvData contains an unexpected Service Data UUID"
        );
      }
      servicePayload = advertisingData.subarray(
        uuidOffset + expectedUuid.byteLength,
        structureEnd
      );
    } else {
      fail(
        "UNEXPECTED_AD_STRUCTURE",
        `Cassa V6 v1 AdvData contains unexpected AD type 0x${structureType
          .toString(16)
          .padStart(2, "0")}`
      );
    }

    offset = structureEnd;
  }

  if (structureCount !== 2) {
    fail(
      "INVALID_AD_STRUCTURE_COUNT",
      "Cassa V6 v1 AdvData must contain exactly two AD structures"
    );
  }
  if (!flagsSeen) {
    fail("MISSING_FLAGS", "Cassa V6 v1 AdvData is missing Flags");
  }
  if (servicePayload === undefined) {
    fail(
      "MISSING_SERVICE_DATA",
      "Cassa V6 v1 AdvData is missing 128-bit Service Data"
    );
  }

  return decodeNodeAdvertisement(servicePayload);
}
