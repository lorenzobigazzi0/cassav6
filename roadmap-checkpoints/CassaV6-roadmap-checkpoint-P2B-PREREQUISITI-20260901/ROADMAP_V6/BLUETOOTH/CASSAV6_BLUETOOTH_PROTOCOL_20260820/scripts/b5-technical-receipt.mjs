import crypto from "node:crypto";

export const B5_TECHNICAL_RECEIPT_VERSION = "1.1.0";
const LEGACY_B5_TECHNICAL_RECEIPT_VERSION = "1.0.0";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RECEIPT_FIELDS = Object.freeze([
  "schemaVersion",
  "receiptVersion",
  "product",
  "phase",
  "mode",
  "issuedAt",
  "technicalAggregateSha256",
  "collectorStateSha256",
  "campaignAuthorizationSha256",
  "certificationMatrixSha256",
  "campaignIdCommitmentSha256",
  "accountDeviceCommitmentSha256",
  "collectionCommitmentSha256",
  "attemptLedgerHeadSha256",
  "prerequisiteEvidenceBundleSha256",
  "operatorCommitmentSha256",
  "androidAttestationSha256",
  "raspberryAttestationSha256",
  "gate",
  "privacy"
]);
const LEGACY_RECEIPT_FIELDS = Object.freeze(
  RECEIPT_FIELDS.filter(
    (field) => field !== "accountDeviceCommitmentSha256"
  )
);
const GATE_FIELDS = Object.freeze([
  "b5TechnicalGate",
  "b5HundredSessionGate",
  "b6"
]);
const PRIVACY_FIELDS = Object.freeze([
  "identifiersIncluded",
  "addressesIncluded",
  "localLocationsIncluded",
  "cryptographicMaterialIncluded",
  "rawCampaignIdIncluded",
  "commitmentsIncluded"
]);
const COMMITMENT_FIELDS = Object.freeze([
  "technicalAggregateSha256",
  "collectorStateSha256",
  "campaignAuthorizationSha256",
  "certificationMatrixSha256",
  "campaignIdCommitmentSha256",
  "accountDeviceCommitmentSha256",
  "collectionCommitmentSha256",
  "attemptLedgerHeadSha256",
  "prerequisiteEvidenceBundleSha256",
  "operatorCommitmentSha256",
  "androidAttestationSha256",
  "raspberryAttestationSha256"
]);

export class B5TechnicalReceiptError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "B5TechnicalReceiptError";
    this.code = code;
  }
}

function fail(code, message, options = undefined) {
  throw new B5TechnicalReceiptError(code, message, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactFields(value, expected, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index])
  ) {
    fail(code, `${label} has an invalid field set`);
  }
  return value;
}

function requireTimestamp(value, code, label) {
  if (typeof value !== "string") fail(code, `${label} is invalid`);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail(code, `${label} is invalid`);
  }
  return milliseconds;
}

function requireSha256(value, code, label) {
  if (
    typeof value !== "string" ||
    !SHA256_PATTERN.test(value) ||
    value === "0".repeat(64)
  ) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function constantTimeHexEqual(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    !SHA256_PATTERN.test(left) ||
    !SHA256_PATTERN.test(right)
  ) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function technicalReceiptSha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function parseB5TechnicalReceipt(input, expected = {}) {
  let value = input;
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    try {
      value = JSON.parse(input.toString());
    } catch (error) {
      fail("TECHNICAL_RECEIPT_INVALID", "technical receipt is not valid JSON", {
        cause: error
      });
    }
  }
  const accountDeviceBound =
    value?.schemaVersion === 1 &&
    value?.receiptVersion === B5_TECHNICAL_RECEIPT_VERSION;
  const historical =
    value?.schemaVersion === 1 &&
    value?.receiptVersion === LEGACY_B5_TECHNICAL_RECEIPT_VERSION;
  if (!accountDeviceBound && !historical) {
    fail(
      "TECHNICAL_RECEIPT_INVALID",
      "technical receipt version is invalid"
    );
  }
  requireExactFields(
    value,
    accountDeviceBound ? RECEIPT_FIELDS : LEGACY_RECEIPT_FIELDS,
    "TECHNICAL_RECEIPT_INVALID",
    "technical receipt"
  );
  for (const [field, required] of [
    ["schemaVersion", 1],
    [
      "receiptVersion",
      accountDeviceBound
        ? B5_TECHNICAL_RECEIPT_VERSION
        : LEGACY_B5_TECHNICAL_RECEIPT_VERSION
    ],
    ["product", "V6"],
    ["phase", "B5"],
    ["mode", "PRIVATE_TECHNICAL_RECEIPT"]
  ]) {
    if (value[field] !== required) {
      fail("TECHNICAL_RECEIPT_INVALID", `technical receipt ${field} is invalid`);
    }
  }
  const issuedAtMs = requireTimestamp(
    value.issuedAt,
    "TECHNICAL_RECEIPT_INVALID",
    "technical receipt timestamp"
  );
  const commitmentFields = accountDeviceBound
    ? COMMITMENT_FIELDS
    : COMMITMENT_FIELDS.filter(
        (field) => field !== "accountDeviceCommitmentSha256"
      );
  for (const field of commitmentFields) {
    requireSha256(
      value[field],
      "TECHNICAL_RECEIPT_INVALID",
      `technical receipt ${field}`
    );
  }
  requireExactFields(
    value.gate,
    GATE_FIELDS,
    "TECHNICAL_RECEIPT_INVALID",
    "technical receipt gate"
  );
  for (const [field, required] of [
    ["b5TechnicalGate", "PASS"],
    ["b5HundredSessionGate", "PENDING_REVIEW"],
    ["b6", "PENDING"]
  ]) {
    if (value.gate[field] !== required) {
      fail("TECHNICAL_RECEIPT_INVALID", `technical receipt gate ${field} is invalid`);
    }
  }
  requireExactFields(
    value.privacy,
    PRIVACY_FIELDS,
    "TECHNICAL_RECEIPT_INVALID",
    "technical receipt privacy"
  );
  for (const field of PRIVACY_FIELDS) {
    const required = field === "commitmentsIncluded";
    if (value.privacy[field] !== required) {
      fail("TECHNICAL_RECEIPT_INVALID", "technical receipt privacy is invalid");
    }
  }
  if (
    !accountDeviceBound &&
    expected.accountDeviceCommitmentSha256 !== undefined
  ) {
    fail(
      "ACCOUNT_DEVICE_COMMITMENT_REQUIRED",
      "historical technical receipt is not promotable"
    );
  }
  for (const field of commitmentFields) {
    if (
      expected[field] !== undefined &&
      !constantTimeHexEqual(value[field], expected[field])
    ) {
      fail(
        "TECHNICAL_RECEIPT_BINDING_INVALID",
        `technical receipt ${field} does not match the supplied campaign evidence`
      );
    }
  }
  if (
    expected.minimumIssuedAtMs !== undefined &&
    issuedAtMs < expected.minimumIssuedAtMs
  ) {
    fail(
      "TECHNICAL_RECEIPT_BINDING_INVALID",
      "technical receipt predates the technical aggregate"
    );
  }
  return Object.freeze({
    value: Object.freeze(value),
    issuedAtMs,
    accountDeviceBound
  });
}

export function createB5TechnicalReceipt({
  issuedAt,
  technicalAggregateBytes,
  collectorStateBytes,
  campaignAuthorizationBytes,
  certificationMatrixBytes,
  campaignIdCommitmentSha256,
  accountDeviceCommitmentSha256,
  collectionCommitmentSha256,
  attemptLedgerHeadSha256,
  prerequisiteEvidenceBundleSha256,
  operatorCommitmentSha256,
  androidAttestationBytes,
  raspberryAttestationBytes,
  technicalGeneratedAtMs
}) {
  const receipt = {
    schemaVersion: 1,
    receiptVersion: B5_TECHNICAL_RECEIPT_VERSION,
    product: "V6",
    phase: "B5",
    mode: "PRIVATE_TECHNICAL_RECEIPT",
    issuedAt,
    technicalAggregateSha256: technicalReceiptSha256(technicalAggregateBytes),
    collectorStateSha256: technicalReceiptSha256(collectorStateBytes),
    campaignAuthorizationSha256: technicalReceiptSha256(campaignAuthorizationBytes),
    certificationMatrixSha256: technicalReceiptSha256(certificationMatrixBytes),
    campaignIdCommitmentSha256,
    accountDeviceCommitmentSha256,
    collectionCommitmentSha256,
    attemptLedgerHeadSha256,
    prerequisiteEvidenceBundleSha256,
    operatorCommitmentSha256,
    androidAttestationSha256: technicalReceiptSha256(androidAttestationBytes),
    raspberryAttestationSha256: technicalReceiptSha256(raspberryAttestationBytes),
    gate: {
      b5TechnicalGate: "PASS",
      b5HundredSessionGate: "PENDING_REVIEW",
      b6: "PENDING"
    },
    privacy: {
      identifiersIncluded: false,
      addressesIncluded: false,
      localLocationsIncluded: false,
      cryptographicMaterialIncluded: false,
      rawCampaignIdIncluded: false,
      commitmentsIncluded: true
    }
  };
  parseB5TechnicalReceipt(receipt, { minimumIssuedAtMs: technicalGeneratedAtMs });
  return Object.freeze(receipt);
}
