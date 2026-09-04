import crypto from "node:crypto";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const AUTHORIZATION_FIELDS = [
  "schemaVersion",
  "product",
  "phase",
  "mode",
  "issuedAt",
  "campaignIdCommitmentSha256",
  "certificationMatrixSha256",
  "prerequisiteEvidenceBundleSha256",
  "operatorCommitmentSha256",
  "prerequisites",
  "constraints",
  "gate",
  "privacy"
];

const REVIEW_FIELDS = [
  "schemaVersion",
  "product",
  "phase",
  "mode",
  "reviewedAt",
  "technicalAggregateSha256",
  "prerequisiteEvidenceBundleSha256",
  "operatorCommitmentSha256",
  "reviewerCommitmentSha256",
  "decision",
  "checks",
  "gate",
  "privacy"
];

const PRIVACY_FIELDS = [
  "identifiersIncluded",
  "addressesIncluded",
  "localLocationsIncluded",
  "cryptographicMaterialIncluded"
];

export class B5CampaignGovernanceError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "B5CampaignGovernanceError";
    this.code = code;
  }
}

function fail(code, message, options = undefined) {
  throw new B5CampaignGovernanceError(code, message, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactFields(value, fields, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(code, `${label} has an invalid field set`);
  }
  return value;
}

function requireEqual(value, expected, code, message) {
  if (value !== expected) fail(code, message);
  return value;
}

function requireSha256(value, code, message) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(code, message);
  }
  return value;
}

function requireTimestamp(value, code, message) {
  if (typeof value !== "string") fail(code, message);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail(code, message);
  }
  return milliseconds;
}

function requirePrivacy(value, code) {
  requireExactFields(value, PRIVACY_FIELDS, code, "privacy declaration");
  for (const field of PRIVACY_FIELDS) {
    requireEqual(value[field], false, code, "governance input contains private data");
  }
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

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function campaignIdCommitment(campaignId) {
  if (typeof campaignId !== "string" || !UUID_V4_PATTERN.test(campaignId)) {
    fail("CAMPAIGN_AUTHORIZATION_INVALID", "campaign UUID is invalid");
  }
  return sha256Hex(campaignId);
}

export function parseB5CampaignAuthorization(
  input,
  { campaignId, certificationMatrixSha256 } = {}
) {
  let value = input;
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    try {
      value = JSON.parse(input.toString());
    } catch (error) {
      fail(
        "CAMPAIGN_AUTHORIZATION_INVALID",
        "campaign authorization is not valid JSON",
        { cause: error }
      );
    }
  }
  requireExactFields(
    value,
    AUTHORIZATION_FIELDS,
    "CAMPAIGN_AUTHORIZATION_INVALID",
    "campaign authorization"
  );
  requireEqual(value.schemaVersion, 1, "CAMPAIGN_AUTHORIZATION_INVALID", "authorization schema is invalid");
  requireEqual(value.product, "V6", "CAMPAIGN_AUTHORIZATION_INVALID", "authorization product is invalid");
  requireEqual(value.phase, "B5", "CAMPAIGN_AUTHORIZATION_INVALID", "authorization phase is invalid");
  requireEqual(value.mode, "CAMPAIGN_AUTHORIZATION", "CAMPAIGN_AUTHORIZATION_INVALID", "authorization mode is invalid");
  const issuedAtMs = requireTimestamp(
    value.issuedAt,
    "CAMPAIGN_AUTHORIZATION_INVALID",
    "authorization timestamp is invalid"
  );
  requireSha256(value.campaignIdCommitmentSha256, "CAMPAIGN_AUTHORIZATION_INVALID", "campaign commitment is invalid");
  requireSha256(value.certificationMatrixSha256, "CAMPAIGN_AUTHORIZATION_INVALID", "matrix commitment is invalid");
  requireSha256(value.prerequisiteEvidenceBundleSha256, "CAMPAIGN_AUTHORIZATION_INVALID", "prerequisite evidence commitment is invalid");
  requireSha256(value.operatorCommitmentSha256, "CAMPAIGN_AUTHORIZATION_INVALID", "operator commitment is invalid");
  if (value.operatorCommitmentSha256 === "0".repeat(64)) {
    fail("CAMPAIGN_AUTHORIZATION_INVALID", "operator commitment cannot be zero");
  }
  requireExactFields(
    value.prerequisites,
    ["b0", "b1", "b2", "b3", "b4"],
    "CAMPAIGN_AUTHORIZATION_INVALID",
    "campaign prerequisites"
  );
  for (const field of ["b0", "b1", "b2", "b3", "b4"]) {
    requireEqual(value.prerequisites[field], "PASS", "CAMPAIGN_AUTHORIZATION_INVALID", `${field.toUpperCase()} is not PASS`);
  }
  requireExactFields(
    value.constraints,
    [
      "sameHandheld",
      "sameBuild",
      "sameAccount",
      "continuousAndroidMonitor",
      "continuousRaspberryMonitor",
      "productionServiceMustRemainContinuous",
      "independentReviewRequired"
    ],
    "CAMPAIGN_AUTHORIZATION_INVALID",
    "campaign constraints"
  );
  for (const field of Object.keys(value.constraints)) {
    requireEqual(value.constraints[field], true, "CAMPAIGN_AUTHORIZATION_INVALID", `campaign constraint ${field} is not accepted`);
  }
  requireExactFields(
    value.gate,
    ["b5CampaignAuthorized", "b5HundredSessionGate", "b6"],
    "CAMPAIGN_AUTHORIZATION_INVALID",
    "authorization gate"
  );
  requireEqual(value.gate.b5CampaignAuthorized, "PASS", "CAMPAIGN_AUTHORIZATION_INVALID", "campaign is not authorized");
  requireEqual(value.gate.b5HundredSessionGate, "PENDING", "CAMPAIGN_AUTHORIZATION_INVALID", "authorization cannot promote B5");
  requireEqual(value.gate.b6, "PENDING", "CAMPAIGN_AUTHORIZATION_INVALID", "authorization cannot promote B6");
  requirePrivacy(value.privacy, "CAMPAIGN_AUTHORIZATION_INVALID");

  if (
    campaignId !== undefined &&
    !constantTimeHexEqual(
      value.campaignIdCommitmentSha256,
      campaignIdCommitment(campaignId)
    )
  ) {
    fail("CAMPAIGN_AUTHORIZATION_BINDING_INVALID", "authorization belongs to another campaign");
  }
  if (
    certificationMatrixSha256 !== undefined &&
    !constantTimeHexEqual(
      value.certificationMatrixSha256,
      certificationMatrixSha256
    )
  ) {
    fail("CAMPAIGN_AUTHORIZATION_BINDING_INVALID", "authorization uses another certification matrix");
  }

  return Object.freeze({
    value,
    issuedAtMs,
    prerequisiteEvidenceBundleSha256: value.prerequisiteEvidenceBundleSha256,
    operatorCommitmentSha256: value.operatorCommitmentSha256
  });
}

export function parseB5ReviewAttestation(
  input,
  {
    technicalAggregateSha256,
    prerequisiteEvidenceBundleSha256,
    operatorCommitmentSha256,
    technicalGeneratedAtMs
  } = {}
) {
  let value = input;
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    try {
      value = JSON.parse(input.toString());
    } catch (error) {
      fail("REVIEW_ATTESTATION_INVALID", "review attestation is not valid JSON", {
        cause: error
      });
    }
  }
  requireExactFields(value, REVIEW_FIELDS, "REVIEW_ATTESTATION_INVALID", "review attestation");
  requireEqual(value.schemaVersion, 1, "REVIEW_ATTESTATION_INVALID", "review schema is invalid");
  requireEqual(value.product, "V6", "REVIEW_ATTESTATION_INVALID", "review product is invalid");
  requireEqual(value.phase, "B5", "REVIEW_ATTESTATION_INVALID", "review phase is invalid");
  requireEqual(value.mode, "INDEPENDENT_REVIEW", "REVIEW_ATTESTATION_INVALID", "review mode is invalid");
  const reviewedAtMs = requireTimestamp(value.reviewedAt, "REVIEW_ATTESTATION_INVALID", "review timestamp is invalid");
  requireSha256(value.technicalAggregateSha256, "REVIEW_ATTESTATION_INVALID", "technical aggregate commitment is invalid");
  requireSha256(value.prerequisiteEvidenceBundleSha256, "REVIEW_ATTESTATION_INVALID", "prerequisite evidence commitment is invalid");
  requireSha256(value.operatorCommitmentSha256, "REVIEW_ATTESTATION_INVALID", "operator commitment is invalid");
  requireSha256(value.reviewerCommitmentSha256, "REVIEW_ATTESTATION_INVALID", "reviewer commitment is invalid");
  if (
    value.reviewerCommitmentSha256 === "0".repeat(64) ||
    constantTimeHexEqual(
      value.operatorCommitmentSha256,
      value.reviewerCommitmentSha256
    )
  ) {
    fail("REVIEW_NOT_INDEPENDENT", "operator and reviewer must be distinct");
  }
  requireEqual(value.decision, "PASS", "REVIEW_ATTESTATION_INVALID", "review decision is not PASS");
  requireExactFields(
    value.checks,
    [
      "evidenceIntegrity",
      "b0B4Authorization",
      "attemptPolicy",
      "androidContinuity",
      "raspberryContinuity",
      "cleanupAndRestorePlan",
      "privacyReview"
    ],
    "REVIEW_ATTESTATION_INVALID",
    "review checks"
  );
  for (const field of Object.keys(value.checks)) {
    requireEqual(value.checks[field], "PASS", "REVIEW_ATTESTATION_INVALID", `review check ${field} is not PASS`);
  }
  requireExactFields(
    value.gate,
    ["b5HundredSessionGate", "b6"],
    "REVIEW_ATTESTATION_INVALID",
    "review gate"
  );
  requireEqual(value.gate.b5HundredSessionGate, "PASS", "REVIEW_ATTESTATION_INVALID", "review does not approve B5");
  requireEqual(value.gate.b6, "PENDING", "REVIEW_ATTESTATION_INVALID", "review cannot promote B6");
  requirePrivacy(value.privacy, "REVIEW_ATTESTATION_INVALID");

  for (const [actual, expected, code, message] of [
    [value.technicalAggregateSha256, technicalAggregateSha256, "REVIEW_BINDING_INVALID", "review belongs to another technical aggregate"],
    [value.prerequisiteEvidenceBundleSha256, prerequisiteEvidenceBundleSha256, "REVIEW_BINDING_INVALID", "review uses another prerequisite evidence bundle"],
    [value.operatorCommitmentSha256, operatorCommitmentSha256, "REVIEW_BINDING_INVALID", "review uses another operator commitment"]
  ]) {
    if (expected !== undefined && !constantTimeHexEqual(actual, expected)) {
      fail(code, message);
    }
  }
  if (
    technicalGeneratedAtMs !== undefined &&
    reviewedAtMs < technicalGeneratedAtMs
  ) {
    fail("REVIEW_BINDING_INVALID", "review predates the technical aggregate");
  }

  return Object.freeze({ value, reviewedAtMs });
}

export function validB5CampaignAuthorizationFixture({
  campaignId = "00000000-0000-4000-8000-000000000001",
  certificationMatrixSha256 = "1".repeat(64),
  prerequisiteEvidenceBundleSha256 = "2".repeat(64),
  operatorCommitmentSha256 = "3".repeat(64),
  issuedAt = "2026-07-20T23:59:00.000Z"
} = {}) {
  return {
    schemaVersion: 1,
    product: "V6",
    phase: "B5",
    mode: "CAMPAIGN_AUTHORIZATION",
    issuedAt,
    campaignIdCommitmentSha256: campaignIdCommitment(campaignId),
    certificationMatrixSha256,
    prerequisiteEvidenceBundleSha256,
    operatorCommitmentSha256,
    prerequisites: { b0: "PASS", b1: "PASS", b2: "PASS", b3: "PASS", b4: "PASS" },
    constraints: {
      sameHandheld: true,
      sameBuild: true,
      sameAccount: true,
      continuousAndroidMonitor: true,
      continuousRaspberryMonitor: true,
      productionServiceMustRemainContinuous: true,
      independentReviewRequired: true
    },
    gate: {
      b5CampaignAuthorized: "PASS",
      b5HundredSessionGate: "PENDING",
      b6: "PENDING"
    },
    privacy: {
      identifiersIncluded: false,
      addressesIncluded: false,
      localLocationsIncluded: false,
      cryptographicMaterialIncluded: false
    }
  };
}

export function validB5ReviewAttestationFixture({
  technicalAggregateSha256 = "4".repeat(64),
  prerequisiteEvidenceBundleSha256 = "2".repeat(64),
  operatorCommitmentSha256 = "3".repeat(64),
  reviewerCommitmentSha256 = "5".repeat(64),
  reviewedAt = "2026-07-22T00:01:00.000Z"
} = {}) {
  return {
    schemaVersion: 1,
    product: "V6",
    phase: "B5",
    mode: "INDEPENDENT_REVIEW",
    reviewedAt,
    technicalAggregateSha256,
    prerequisiteEvidenceBundleSha256,
    operatorCommitmentSha256,
    reviewerCommitmentSha256,
    decision: "PASS",
    checks: {
      evidenceIntegrity: "PASS",
      b0B4Authorization: "PASS",
      attemptPolicy: "PASS",
      androidContinuity: "PASS",
      raspberryContinuity: "PASS",
      cleanupAndRestorePlan: "PASS",
      privacyReview: "PASS"
    },
    gate: { b5HundredSessionGate: "PASS", b6: "PENDING" },
    privacy: {
      identifiersIncluded: false,
      addressesIncluded: false,
      localLocationsIncluded: false,
      cryptographicMaterialIncluded: false
    }
  };
}
