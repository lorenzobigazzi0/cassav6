#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  B5_HUNDRED_SESSION_HARNESS_VERSION,
  parseCollectorCampaignState
} from "./run-b5-hundred-session-gate.mjs";
import {
  parseB5CampaignSupervisorLedger
} from "./run-b5-campaign-supervisor.mjs";
import {
  parseB5AndroidContinuityAttestation
} from "../../scripts/run-b5-android-continuity-monitor.mjs";
import {
  parseB5RaspberryContinuityAttestation
} from "../../scripts/run-b5-raspberry-continuity-monitor.mjs";
import {
  B5CampaignGovernanceError,
  parseB5CampaignAuthorization,
  parseB5ReviewAttestation,
  sha256Hex
} from "../../scripts/b5-campaign-governance.mjs";
import {
  B5TechnicalReceiptError,
  parseB5TechnicalReceipt,
  technicalReceiptSha256
} from "../../scripts/b5-technical-receipt.mjs";

export const B5_PROMOTION_GATE_VERSION = "1.3.0";

const MAX_INPUT_BYTES = 512 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const NO_FOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = fs.constants.O_DIRECTORY ?? 0;
const MATRIX_PATH = fileURLToPath(
  new URL("../../configs/advanced-certification-targets.json", import.meta.url)
);

export class B5PromotionGateError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "B5PromotionGateError";
    this.code = code;
  }
}

function fail(code, message, options = undefined) {
  throw new B5PromotionGateError(code, message, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, code, message) {
  if (!isRecord(value)) fail(code, message);
  return value;
}

function requireExactFields(value, expectedFields, code, label) {
  const record = requireRecord(value, code, `${label} must be an object`);
  const actual = Object.keys(record).sort();
  const expected = [...expectedFields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(code, `${label} has an invalid field set`);
  }
  return record;
}

function requireEqual(actual, expected, code, message) {
  if (actual !== expected) fail(code, message);
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

function requireSafeInteger(value, minimum, maximum, code, message) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(code, message);
  }
  return value;
}

function inputBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  return Buffer.from(JSON.stringify(value));
}

function assertNoSymlinkComponents(location) {
  const resolved = path.resolve(location);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep)) {
    if (component.length === 0) continue;
    current = path.join(current, component);
    let status;
    try {
      status = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT" && current === resolved) return resolved;
      fail("EVIDENCE_INVALID", "private evidence path cannot be inspected", {
        cause: error
      });
    }
    if (status.isSymbolicLink()) {
      fail("EVIDENCE_INVALID", "private evidence path traverses a symbolic link");
    }
  }
  return resolved;
}

function readPrivateFile(location, label) {
  const resolved = assertNoSymlinkComponents(location);
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 2 ||
      before.size > MAX_INPUT_BYTES ||
      (process.platform === "linux" && (before.mode & 0o777) !== 0o600) ||
      (process.platform === "linux" &&
        typeof process.geteuid === "function" &&
        before.uid !== process.geteuid())
    ) {
      fail("EVIDENCE_INVALID", `${label} must be an owned single-link 0600 file`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== before.size
    ) {
      fail("EVIDENCE_INVALID", `${label} changed while it was being read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof B5PromotionGateError) throw error;
    fail("EVIDENCE_INVALID", `${label} cannot be read safely`, { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("EVIDENCE_INVALID", `${label} is not valid JSON`, { cause: error });
  }
}

export function parseTechnicalAggregate(input) {
  const decoded =
    typeof input === "string" || Buffer.isBuffer(input)
      ? parseJson(Buffer.from(input), "technical aggregate")
      : input;
  if (
    decoded?.schemaVersion === 1 &&
    decoded?.harnessVersion === "1.3.0" &&
    !Object.hasOwn(decoded, "accountDeviceCommitmentSha256")
  ) {
    fail(
      "ACCOUNT_DEVICE_COMMITMENT_REQUIRED",
      "historical technical aggregate remains PENDING and cannot be promoted"
    );
  }
  if (
    decoded?.schemaVersion === 1 &&
    decoded?.harnessVersion === "1.4.0" &&
    !Object.hasOwn(decoded, "attemptLedgerHeadSha256")
  ) {
    fail(
      "SOURCE_EVIDENCE_COMMITMENTS_REQUIRED",
      "historical technical aggregate lacks direct source commitments"
    );
  }
  const value = requireExactFields(
    decoded,
    [
      "schemaVersion",
      "harnessVersion",
      "product",
      "phase",
      "generatedAt",
      "mode",
      "verdict",
      "accountDeviceCommitmentSha256",
      "attemptLedgerHeadSha256",
      "androidAttestationSha256",
      "raspberryAttestationSha256",
      "campaign",
      "checks",
      "totals",
      "gate",
      "privacy",
      "physicalEvidenceConsumed",
      "v5btProductionServiceChanges"
    ],
    "TECHNICAL_AGGREGATE_INVALID",
    "technical aggregate"
  );
  for (const [field, expected] of [
    ["schemaVersion", 1],
    ["harnessVersion", B5_HUNDRED_SESSION_HARNESS_VERSION],
    ["product", "V5BT"],
    ["phase", "B5"],
    ["mode", "PHYSICAL_HUNDRED_SESSION_TECHNICAL_AGGREGATE"],
    ["verdict", "TECHNICAL_PASS"],
    ["physicalEvidenceConsumed", true],
    ["v5btProductionServiceChanges", false]
  ]) {
    requireEqual(value[field], expected, "TECHNICAL_AGGREGATE_INVALID", `technical aggregate ${field} is invalid`);
  }
  for (const field of [
    "accountDeviceCommitmentSha256",
    "attemptLedgerHeadSha256",
    "androidAttestationSha256",
    "raspberryAttestationSha256"
  ]) {
    if (
      typeof value[field] !== "string" ||
      !SHA256_PATTERN.test(value[field]) ||
      /^0{64}$/u.test(value[field])
    ) {
      fail(
        "TECHNICAL_AGGREGATE_INVALID",
        `technical aggregate ${field} is invalid`
      );
    }
  }
  const generatedAtMs = requireTimestamp(
    value.generatedAt,
    "TECHNICAL_AGGREGATE_INVALID",
    "technical aggregate timestamp is invalid"
  );
  const campaign = requireExactFields(
    value.campaign,
    [
      "requiredReports",
      "acceptedReports",
      "collectorStateSchemaVersion",
      "attemptLedgerSchemaVersion",
      "campaignAuthorizationSchemaVersion",
      "androidAttestationSchemaVersion",
      "raspberryAttestationSchemaVersion",
      "firstEvidenceAt",
      "finalEvidenceAt"
    ],
    "TECHNICAL_AGGREGATE_INVALID",
    "technical campaign summary"
  );
  for (const [field, expected] of [
    ["requiredReports", 100],
    ["acceptedReports", 100],
    ["collectorStateSchemaVersion", 3],
    ["attemptLedgerSchemaVersion", 1],
    ["campaignAuthorizationSchemaVersion", 1],
    ["androidAttestationSchemaVersion", 1],
    ["raspberryAttestationSchemaVersion", 1]
  ]) {
    requireEqual(
      campaign[field],
      expected,
      "TECHNICAL_AGGREGATE_INVALID",
      `technical campaign ${field} is invalid`
    );
  }
  const firstEvidenceAtMs = requireTimestamp(
    campaign.firstEvidenceAt,
    "TECHNICAL_AGGREGATE_INVALID",
    "technical first evidence timestamp is invalid"
  );
  const finalEvidenceAtMs = requireTimestamp(
    campaign.finalEvidenceAt,
    "TECHNICAL_AGGREGATE_INVALID",
    "technical final evidence timestamp is invalid"
  );
  if (
    firstEvidenceAtMs >= finalEvidenceAtMs ||
    finalEvidenceAtMs > generatedAtMs
  ) {
    fail("TECHNICAL_AGGREGATE_INVALID", "technical campaign timeline is invalid");
  }

  const checks = requireExactFields(
    value.checks,
    [
      "exactReportCount",
      "orderedNonOverlappingSequence",
      "uniqueEvidence",
      "consistentTarget",
      "completeB57Lifecycle",
      "authenticatedHeartbeat",
      "cleanClose",
      "leakFreeCleanup",
      "businessCharacteristicsFailClosed",
      "collectorStateSchema",
      "collectorCollectionCommitment",
      "collectorReportMetadata",
      "accountDeviceCommitment",
      "attemptLedgerIntegrity",
      "attemptCampaignBinding",
      "attemptRetryPolicy",
      "attemptTimelineCoverage",
      "b0B4CampaignAuthorization",
      "authorizationBeforeFirstAttempt",
      "androidCampaignBinding",
      "androidTimelineCoverage",
      "androidHandheldTarget",
      "androidProcessContinuity",
      "androidSessionContinuity",
      "androidCrashAnrContinuity",
      "raspberryCampaignBinding",
      "raspberryTimelineCoverage",
      "raspberryServiceContinuity",
      "raspberryBootClockContinuity"
    ],
    "TECHNICAL_AGGREGATE_INVALID",
    "technical checks"
  );
  if (Object.values(checks).some((entry) => entry !== "PASS")) {
    fail("TECHNICAL_AGGREGATE_INVALID", "technical checks are incomplete");
  }

  const totals = requireExactFields(
    value.totals,
    [
      "sessionsOpened",
      "sessionsActivated",
      "sessionsClosedCleanly",
      "helloExchanges",
      "mutualAuthentications",
      "keyEstablishments",
      "pingsSent",
      "pongsVerified",
      "heartbeatMisses",
      "failures",
      "resourceLeaks",
      "durationMs",
      "minimumSessionDurationMs",
      "maximumSessionDurationMs"
    ],
    "TECHNICAL_AGGREGATE_INVALID",
    "technical totals"
  );
  for (const field of [
    "sessionsOpened",
    "sessionsActivated",
    "sessionsClosedCleanly",
    "helloExchanges",
    "mutualAuthentications",
    "keyEstablishments"
  ]) {
    requireEqual(
      totals[field],
      100,
      "TECHNICAL_AGGREGATE_INVALID",
      `technical total ${field} is invalid`
    );
  }
  for (const field of ["heartbeatMisses", "failures", "resourceLeaks"]) {
    requireEqual(
      totals[field],
      0,
      "TECHNICAL_AGGREGATE_INVALID",
      `technical total ${field} is invalid`
    );
  }
  requireSafeInteger(totals.pingsSent, 400, Number.MAX_SAFE_INTEGER,
    "TECHNICAL_AGGREGATE_INVALID", "technical PING total is invalid");
  requireSafeInteger(totals.pongsVerified, 400, totals.pingsSent,
    "TECHNICAL_AGGREGATE_INVALID", "technical PONG total is invalid");
  requireSafeInteger(totals.minimumSessionDurationMs, 1, Number.MAX_SAFE_INTEGER,
    "TECHNICAL_AGGREGATE_INVALID", "technical minimum duration is invalid");
  requireSafeInteger(
    totals.maximumSessionDurationMs,
    totals.minimumSessionDurationMs,
    Number.MAX_SAFE_INTEGER,
    "TECHNICAL_AGGREGATE_INVALID",
    "technical maximum duration is invalid"
  );
  requireSafeInteger(
    totals.durationMs,
    totals.minimumSessionDurationMs * 100,
    totals.maximumSessionDurationMs * 100,
    "TECHNICAL_AGGREGATE_INVALID",
    "technical campaign duration is invalid"
  );

  const gate = requireExactFields(
    value.gate,
    ["b57PhysicalEvidence", "b5TechnicalGate", "b5HundredSessionGate", "b6"],
    "TECHNICAL_AGGREGATE_INVALID",
    "technical gate"
  );
  requireEqual(gate.b57PhysicalEvidence, "PASS_100_REDACTED_REPORTS", "TECHNICAL_AGGREGATE_INVALID", "physical evidence gate is not PASS");
  requireEqual(gate.b5TechnicalGate, "PASS", "TECHNICAL_AGGREGATE_INVALID", "technical gate is not PASS");
  requireEqual(gate.b5HundredSessionGate, "PENDING_REVIEW", "TECHNICAL_AGGREGATE_INVALID", "technical aggregate prematurely promotes B5");
  requireEqual(gate.b6, "PENDING", "TECHNICAL_AGGREGATE_INVALID", "technical aggregate prematurely promotes B6");

  const privacy = requireExactFields(
    value.privacy,
    [
      "identifiersIncluded",
      "addressesIncluded",
      "cryptographicMaterialIncluded",
      "messageBodiesIncluded",
      "localLocationsIncluded",
      "sourceReportDetailsIncluded",
      "campaignCommitmentsIncluded",
      "privateRecordIdentifiersIncluded"
    ],
    "TECHNICAL_AGGREGATE_INVALID",
    "technical privacy declaration"
  );
  if (
    Object.entries(privacy).some(
      ([field, entry]) =>
        entry !== (field === "campaignCommitmentsIncluded")
    )
  ) {
    fail("TECHNICAL_AGGREGATE_INVALID", "technical aggregate contains private material");
  }
  return Object.freeze({
    value,
    generatedAtMs,
    accountDeviceCommitmentSha256:
      value.accountDeviceCommitmentSha256,
    attemptLedgerHeadSha256: value.attemptLedgerHeadSha256,
    androidAttestationSha256: value.androidAttestationSha256,
    raspberryAttestationSha256: value.raspberryAttestationSha256
  });
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
  return crypto.timingSafeEqual(
    Buffer.from(left, "hex"),
    Buffer.from(right, "hex")
  );
}

function assertPromotedReportRedacted(report, privateValues = []) {
  const encoded = JSON.stringify(report);
  for (const pattern of [
    /\/(?:home|tmp|var|etc|run)\//u,
    /"(?:campaignRunId|campaignIdCommitmentSha256|operatorCommitmentSha256|reviewerCommitmentSha256|serial|deviceSerial|androidUserId|appUid|sessionBindingHmacSha256|pid|hostname|path|nodeId)"/iu
  ]) {
    if (pattern.test(encoded)) {
      fail("PROMOTION_PRIVACY_INVALID", "promotion report contains private material");
    }
  }
  for (const value of privateValues) {
    if (typeof value === "string" && value.length > 0 && encoded.includes(value)) {
      fail("PROMOTION_PRIVACY_INVALID", "promotion report contains private commitments");
    }
  }
  return true;
}

export function promoteTechnicalAggregate({
  technicalAggregateBytes,
  technicalReceipt,
  campaignState,
  attemptState,
  androidAttestation,
  raspberryAttestation,
  campaignAuthorization,
  reviewAttestation,
  certificationMatrixSha256,
  generatedAt = new Date().toISOString()
}) {
  const technicalBytes = Buffer.isBuffer(technicalAggregateBytes)
    ? technicalAggregateBytes
    : Buffer.from(technicalAggregateBytes);
  const technical = parseTechnicalAggregate(technicalBytes);
  const stateBytes = inputBytes(campaignState);
  const authorizationBytes = inputBytes(campaignAuthorization);
  if (
    attemptState === undefined ||
    androidAttestation === undefined ||
    raspberryAttestation === undefined
  ) {
    fail(
      "EVIDENCE_INVALID",
      "attempt ledger and continuity attestations are required"
    );
  }
  const attemptBytes = inputBytes(attemptState);
  const androidBytes = inputBytes(androidAttestation);
  const raspberryBytes = inputBytes(raspberryAttestation);
  const state = parseCollectorCampaignState(
    stateBytes.toString("utf8")
  );
  if (!state.accountDeviceBound) {
    fail(
      "ACCOUNT_DEVICE_COMMITMENT_REQUIRED",
      "historical collector evidence lacks an account/device commitment"
    );
  }
  if (
    !constantTimeHexEqual(
      technical.accountDeviceCommitmentSha256,
      state.accountDeviceCommitmentSha256
    )
  ) {
    fail(
      "ACCOUNT_DEVICE_COMMITMENT_MISMATCH",
      "technical aggregate and collector state account/device commitments differ"
    );
  }
  let attemptLedger;
  let androidContinuity;
  let raspberryContinuity;
  try {
    attemptLedger = parseB5CampaignSupervisorLedger(
      attemptBytes.toString("utf8")
    );
    androidContinuity = parseB5AndroidContinuityAttestation(
      androidBytes.toString("utf8")
    );
    raspberryContinuity = parseB5RaspberryContinuityAttestation(
      raspberryBytes.toString("utf8")
    );
  } catch (error) {
    fail(
      "SOURCE_EVIDENCE_INVALID",
      "promotion source evidence is invalid",
      { cause: error }
    );
  }
  if (!androidContinuity.accountDeviceBound) {
    fail(
      "ACCOUNT_DEVICE_COMMITMENT_REQUIRED",
      "historical Android attestation cannot be promoted"
    );
  }
  if (
    attemptLedger.campaignRunId !== state.campaignRunId ||
    !constantTimeHexEqual(
      androidContinuity.campaignIdCommitmentSha256,
      state.campaignIdCommitmentSha256
    ) ||
    !constantTimeHexEqual(
      raspberryContinuity.campaignIdCommitmentSha256,
      state.campaignIdCommitmentSha256
    ) ||
    !constantTimeHexEqual(
      androidContinuity.accountDeviceCommitmentSha256,
      state.accountDeviceCommitmentSha256
    )
  ) {
    fail(
      "SOURCE_EVIDENCE_BINDING_INVALID",
      "promotion source evidence belongs to another campaign binding"
    );
  }
  const sourceExpected = Object.freeze({
    attemptLedgerHeadSha256: attemptLedger.headSha256,
    androidAttestationSha256: technicalReceiptSha256(androidBytes),
    raspberryAttestationSha256: technicalReceiptSha256(raspberryBytes)
  });
  for (const [field, expected] of Object.entries(sourceExpected)) {
    if (!constantTimeHexEqual(technical[field], expected)) {
      fail(
        "TECHNICAL_AGGREGATE_BINDING_INVALID",
        `technical aggregate ${field} does not match raw campaign evidence`
      );
    }
  }
  let authorization;
  let review;
  let receipt;
  try {
    authorization = parseB5CampaignAuthorization(authorizationBytes, {
      campaignId: state.campaignRunId,
      certificationMatrixSha256
    });
    receipt = parseB5TechnicalReceipt(technicalReceipt, {
      technicalAggregateSha256: technicalReceiptSha256(technicalBytes),
      collectorStateSha256: technicalReceiptSha256(stateBytes),
      campaignAuthorizationSha256: technicalReceiptSha256(authorizationBytes),
      certificationMatrixSha256,
      campaignIdCommitmentSha256: state.campaignIdCommitmentSha256,
      accountDeviceCommitmentSha256:
        state.accountDeviceCommitmentSha256,
      ...sourceExpected,
      collectionCommitmentSha256: state.collectionCommitmentSha256,
      prerequisiteEvidenceBundleSha256:
        authorization.prerequisiteEvidenceBundleSha256,
      operatorCommitmentSha256: authorization.operatorCommitmentSha256,
      minimumIssuedAtMs: technical.generatedAtMs
    });
    review = parseB5ReviewAttestation(reviewAttestation, {
      technicalAggregateSha256: sha256Hex(technicalBytes),
      prerequisiteEvidenceBundleSha256:
        authorization.prerequisiteEvidenceBundleSha256,
      operatorCommitmentSha256: authorization.operatorCommitmentSha256,
      technicalGeneratedAtMs: Math.max(
        technical.generatedAtMs,
        receipt.issuedAtMs
      )
    });
  } catch (error) {
    if (
      error instanceof B5CampaignGovernanceError ||
      error instanceof B5TechnicalReceiptError
    ) {
      fail(error.code, error.message, { cause: error });
    }
    throw error;
  }
  const generatedAtMs = requireTimestamp(
    generatedAt,
    "PROMOTION_TIMESTAMP_INVALID",
    "promotion timestamp is invalid"
  );
  if (generatedAtMs < review.reviewedAtMs) {
    fail("PROMOTION_TIMESTAMP_INVALID", "promotion predates the independent review");
  }
  const technicalAggregateSha256 = sha256Hex(technicalBytes);
  const report = Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_PROMOTION_GATE_VERSION,
    product: "V5BT",
    phase: "B5",
    generatedAt,
    mode: "INDEPENDENT_REVIEW_PROMOTION",
    verdict: "PASS",
    technicalAggregateSha256,
    reviewedAt: review.value.reviewedAt,
    checks: Object.freeze({
      technicalAggregate: "PASS",
      technicalReceipt: "PASS",
      campaignAuthorization: "PASS",
      b0B4Prerequisites: "PASS",
      attemptPolicy: "PASS",
      androidContinuity: "PASS",
      raspberryContinuity: "PASS",
      independentReview: "PASS",
      distinctReviewer: "PASS",
      privacyReview: "PASS"
    }),
    gate: Object.freeze({
      b5HundredSessionGate: "PASS",
      b6: "PENDING"
    }),
    privacy: Object.freeze({
      identifiersIncluded: false,
      addressesIncluded: false,
      localLocationsIncluded: false,
      cryptographicMaterialIncluded: false,
      sourceReportDetailsIncluded: false,
      campaignCommitmentsIncluded: false,
      reviewerIdentityIncluded: false
    }),
    physicalEvidenceConsumed: true,
    v5btProductionServiceChanges: false
  });
  assertPromotedReportRedacted(report, [
    state.campaignRunId,
    state.campaignIdCommitmentSha256,
    state.accountDeviceCommitmentSha256,
    authorization.operatorCommitmentSha256,
    review.value.reviewerCommitmentSha256,
    ...[
      "campaignIdCommitmentSha256",
      "accountDeviceCommitmentSha256",
      "collectionCommitmentSha256",
      "attemptLedgerHeadSha256",
      "prerequisiteEvidenceBundleSha256",
      "operatorCommitmentSha256",
      "androidAttestationSha256",
      "raspberryAttestationSha256"
    ].map((field) => receipt.value[field])
  ]);
  return report;
}

function parseArguments(argv) {
  const options = {
    technicalAggregate: null,
    technicalReceipt: null,
    campaignState: null,
    attemptState: null,
    androidAttestation: null,
    raspberryAttestation: null,
    campaignAuthorization: null,
    reviewAttestation: null,
    output: null,
    help: false
  };
  const allowed = new Map([
    ["--technical-aggregate", "technicalAggregate"],
    ["--technical-receipt", "technicalReceipt"],
    ["--campaign-state", "campaignState"],
    ["--attempt-state", "attemptState"],
    ["--android-attestation", "androidAttestation"],
    ["--raspberry-attestation", "raspberryAttestation"],
    ["--campaign-authorization", "campaignAuthorization"],
    ["--review-attestation", "reviewAttestation"],
    ["--output", "output"]
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!allowed.has(argument) || seen.has(argument)) {
      fail("INVALID_ARGUMENT", "unknown or duplicate argument");
    }
    seen.add(argument);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `${argument} requires a value`);
    }
    options[allowed.get(argument)] = path.resolve(value);
    index += 1;
  }
  if (!options.help && Object.values(options).some((value) => value === null)) {
    fail("INVALID_ARGUMENT", "all promotion input and output paths are required");
  }
  if (!options.help) {
    const paths = [
      options.technicalAggregate,
      options.technicalReceipt,
      options.campaignState,
      options.attemptState,
      options.androidAttestation,
      options.raspberryAttestation,
      options.campaignAuthorization,
      options.reviewAttestation,
      options.output
    ];
    if (new Set(paths).size !== paths.length) {
      fail("INVALID_ARGUMENT", "promotion input and output paths must be distinct");
    }
  }
  return options;
}

function atomicWritePrivate(destination, content) {
  const resolved = assertNoSymlinkComponents(destination);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  let directoryDescriptor;
  let temporaryDescriptor;
  let temporaryLocation;
  try {
    directoryDescriptor = fs.openSync(parent, fs.constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG);
    const directoryLocation = process.platform === "linux"
      ? `/proc/self/fd/${directoryDescriptor}`
      : parent;
    temporaryLocation = path.join(
      directoryLocation,
      `.b5-promotion-${process.pid}-${crypto.randomUUID()}.tmp`
    );
    const publishedLocation = path.join(directoryLocation, path.basename(resolved));
    temporaryDescriptor = fs.openSync(
      temporaryLocation,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW_FLAG,
      0o600
    );
    fs.fchmodSync(temporaryDescriptor, 0o600);
    fs.writeFileSync(temporaryDescriptor, content, "utf8");
    fs.fsyncSync(temporaryDescriptor);
    fs.closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    fs.linkSync(temporaryLocation, publishedLocation);
    fs.fsyncSync(directoryDescriptor);
    fs.unlinkSync(temporaryLocation);
    temporaryLocation = undefined;
    fs.fsyncSync(directoryDescriptor);
  } finally {
    if (temporaryDescriptor !== undefined) fs.closeSync(temporaryDescriptor);
    if (temporaryLocation !== undefined) fs.rmSync(temporaryLocation, { force: true });
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
  }
}

function usage() {
  return [
    "V5BT B5 independent review promotion gate",
    "",
    "Usage:",
    "  node raspberry/scripts/run-b5-promotion-gate.mjs \\",
    "    --technical-aggregate PRIVATE-TECHNICAL.json \\",
    "    --technical-receipt PRIVATE-RECEIPT.json \\",
    "    --campaign-state PRIVATE-COLLECTOR.json \\",
    "    --attempt-state PRIVATE-ATTEMPT-LEDGER.json \\",
    "    --android-attestation PRIVATE-ANDROID-ATTESTATION.json \\",
    "    --raspberry-attestation PRIVATE-RASPBERRY-ATTESTATION.json \\",
    "    --campaign-authorization PRIVATE-AUTHORIZATION.json \\",
    "    --review-attestation PRIVATE-REVIEW.json \\",
    "    --output PRIVATE-PROMOTION.json"
  ].join("\n");
}

function failureReport(error) {
  return {
    schemaVersion: 1,
    harnessVersion: B5_PROMOTION_GATE_VERSION,
    product: "V5BT",
    phase: "B5",
    generatedAt: new Date().toISOString(),
    mode: "INDEPENDENT_REVIEW_PROMOTION",
    verdict: "FAIL",
    failure: { code: error.code, message: error.message },
    gate: { b5HundredSessionGate: "PENDING", b6: "PENDING" },
    privacy: {
      identifiersIncluded: false,
      addressesIncluded: false,
      localLocationsIncluded: false,
      cryptographicMaterialIncluded: false,
      sourceReportDetailsIncluded: false,
      campaignCommitmentsIncluded: false,
      reviewerIdentityIncluded: false
    },
    physicalEvidenceConsumed: false,
    v5btProductionServiceChanges: false
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const technicalBytes = readPrivateFile(options.technicalAggregate, "technical aggregate");
    const receiptBytes = readPrivateFile(options.technicalReceipt, "technical receipt");
    const stateBytes = readPrivateFile(options.campaignState, "campaign state");
    const attemptBytes = readPrivateFile(options.attemptState, "campaign attempt ledger");
    const androidBytes = readPrivateFile(options.androidAttestation, "Android continuity attestation");
    const raspberryBytes = readPrivateFile(options.raspberryAttestation, "Raspberry continuity attestation");
    const authorizationBytes = readPrivateFile(options.campaignAuthorization, "campaign authorization");
    const reviewBytes = readPrivateFile(options.reviewAttestation, "review attestation");
    const report = promoteTechnicalAggregate({
      technicalAggregateBytes: technicalBytes,
      technicalReceipt: receiptBytes,
      campaignState: stateBytes,
      attemptState: attemptBytes,
      androidAttestation: androidBytes,
      raspberryAttestation: raspberryBytes,
      campaignAuthorization: authorizationBytes,
      reviewAttestation: reviewBytes,
      certificationMatrixSha256: sha256Hex(fs.readFileSync(MATRIX_PATH))
    });
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    atomicWritePrivate(options.output, encoded);
    process.stdout.write(encoded);
    return 0;
  } catch (error) {
    const safe = error instanceof B5PromotionGateError
      ? error
      : new B5PromotionGateError(
          "B5_PROMOTION_FAILED",
          "B5 independent review promotion failed",
          { cause: error }
        );
    const report = failureReport(safe);
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    try {
      if (options?.output !== null && options?.output !== undefined) {
        atomicWritePrivate(options.output, encoded);
      }
    } catch {}
    process.stdout.write(encoded);
    return 1;
  }
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (
  invokedPath !== null &&
  fs.existsSync(invokedPath) &&
  fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(invokedPath)
) {
  process.exitCode = await main();
}
