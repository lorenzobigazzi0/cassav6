#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  parseB5AndroidContinuityAttestation,
  parsePrivateBaseline,
  validB5AndroidContinuityAttestationFixture
} from "../../scripts/run-b5-android-continuity-monitor.mjs";
import {
  B5AccountDeviceCommitmentError,
  b5AccountDeviceBindingFromPrivateBaseline,
  b5AccountDeviceSensitiveValues,
  createB5AccountDeviceCommitmentSha256,
  parseB5AccountDeviceBinding,
  validB5AccountDeviceBindingFixture
} from "../../scripts/b5-account-device-commitment.mjs";
import {
  B5CampaignGovernanceError,
  parseB5CampaignAuthorization,
  sha256Hex,
  validB5CampaignAuthorizationFixture
} from "../../scripts/b5-campaign-governance.mjs";
import {
  ADVANCED_CERTIFICATION_TARGETS
} from "../../scripts/advanced-certification-targets.mjs";
import {
  parseB5RaspberryContinuityAttestation,
  validB5RaspberryContinuityAttestationFixture
} from "../../scripts/run-b5-raspberry-continuity-monitor.mjs";
import {
  parseB5CampaignSupervisorLedger,
  validB5CampaignSupervisorLedgerFixture
} from "./run-b5-campaign-supervisor.mjs";
import {
  createB5TechnicalReceipt
} from "../../scripts/b5-technical-receipt.mjs";

export const B5_HUNDRED_SESSION_HARNESS_VERSION = "1.5.0";
export const B5_REQUIRED_SESSION_REPORTS = 100;

const B5_7_HARNESS_VERSION = "1.0.0";
const B5_SESSION_COLLECTOR_VERSION = "1.2.0";
const LEGACY_B5_SESSION_COLLECTOR_VERSION = "1.1.0";
const MANIFEST_GATE = "B5_HUNDRED_ANDROID_RASPBERRY_SESSIONS";
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_CAMPAIGN_STATE_BYTES = 256 * 1024;
const MAX_ATTEMPT_STATE_BYTES = 2 * 1024 * 1024;
const MAX_ANDROID_ATTESTATION_BYTES = 256 * 1024;
const MAX_RASPBERRY_ATTESTATION_BYTES = 256 * 1024;
const MAX_CAMPAIGN_AUTHORIZATION_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ADAPTER_PATTERN = /^hci[0-9]+$/u;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const SAFE_ARCHITECTURE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u;
const CERTIFICATION_MATRIX_PATH = fileURLToPath(
  new URL("../../configs/advanced-certification-targets.json", import.meta.url)
);

const ROOT_FIELDS = [
  "schemaVersion",
  "harnessVersion",
  "product",
  "phase",
  "generatedAt",
  "mode",
  "verdict",
  "target",
  "checks",
  "observed",
  "gate",
  "privacy",
  "physicalRadioAccessed",
  "v5btProductionServiceChanges"
];

const TARGET_FIELDS = [
  "role",
  "architecture",
  "nodeVersion",
  "bluezVersion",
  "adapterName"
];

const CHECK_FIELDS = [
  "bluezPreflight",
  "registryReadOnlyInspection",
  "helloExchange",
  "mutualAuthentication",
  "keyEstablishment",
  "activeStateReached",
  "authenticatedHeartbeat",
  "exactSingleSequentialSession",
  "cleanClose",
  "businessCharacteristics",
  "unregisterApplication",
  "resourceCleanup"
];

const OBSERVED_FIELDS = [
  "finalState",
  "durationMs",
  "managedObjectCount",
  "characteristicCount",
  "helloExchanged",
  "mutualAuthentications",
  "keyEstablishments",
  "activeTransitions",
  "pingsSent",
  "pongsVerified",
  "heartbeatMisses",
  "cleanCloses",
  "activeAfterClose",
  "timersAfterClose",
  "retainedSecretBuffersAfterClose",
  "activeAfterCleanup",
  "timersAfterCleanup",
  "retainedSecretBuffersAfterCleanup",
  "failures"
];

const GATE_FIELDS = [
  "directControl",
  "businessTraffic",
  "hundredSessionCampaign"
];

const PRIVACY_FIELDS = [
  "identifiersIncluded",
  "addressesIncluded",
  "cryptographicMaterialIncluded",
  "messageBodiesIncluded",
  "localLocationsIncluded"
];

const AGGREGATE_PRIVACY_FIELDS = [
  ...PRIVACY_FIELDS,
  "sourceReportDetailsIncluded"
];

const BOUND_AGGREGATE_PRIVACY_FIELDS = [
  ...AGGREGATE_PRIVACY_FIELDS,
  "campaignCommitmentsIncluded",
  "privateRecordIdentifiersIncluded"
];
const PUBLIC_AGGREGATE_COMMITMENT_FIELDS = Object.freeze([
  "accountDeviceCommitmentSha256",
  "attemptLedgerHeadSha256",
  "androidAttestationSha256",
  "raspberryAttestationSha256"
]);

const COLLECTOR_STATE_FIELDS = [
  "schemaVersion",
  "harnessVersion",
  "product",
  "phase",
  "mode",
  "campaignRunId",
  "createdAt",
  "updatedAt",
  "requiredSessions",
  "lastCaptureBootId",
  "accountDeviceCommitmentSha256",
  "collectionCommitmentSha256",
  "records"
];

const LEGACY_COLLECTOR_STATE_FIELDS = COLLECTOR_STATE_FIELDS.filter(
  (field) => field !== "accountDeviceCommitmentSha256"
);

const COLLECTOR_RECORD_FIELDS = [
  "sequence",
  "slot",
  "evidenceRecordId",
  "runner",
  "reportSha256",
  "generatedAt",
  "captureStartedAt",
  "captureCompletedAt",
  "sessionStartedAt",
  "durationMs",
  "pingsSent",
  "pongsVerified",
  "heartbeatMisses",
  "targetSignatureSha256",
  "accountDeviceCommitmentSha256"
];

const LEGACY_COLLECTOR_RECORD_FIELDS = COLLECTOR_RECORD_FIELDS.filter(
  (field) => field !== "accountDeviceCommitmentSha256"
);

export class B5HundredSessionGateError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "B5HundredSessionGateError";
    this.code = code;
  }
}

function fail(code, message, options = undefined) {
  throw new B5HundredSessionGateError(code, message, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, code, message) {
  if (!isRecord(value)) fail(code, message);
  return value;
}

function requireExactFields(value, expectedFields, code, message) {
  const record = requireRecord(value, code, message);
  const actual = Object.keys(record).sort();
  const expected = [...expectedFields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(code, `${message} has an invalid field set`);
  }
  return record;
}

function requireEqual(actual, expected, code, message) {
  if (actual !== expected) fail(code, message);
  return actual;
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

function requireCanonicalTimestamp(value, code, message) {
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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireUuidV4(value, code, message) {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    fail(code, message);
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

function canonicalSlot(sequence) {
  return String(sequence).padStart(3, "0");
}

function collectionCommitment(records) {
  return sha256(records.map((record) => record.reportSha256).join("\n"));
}

function safeAdd(total, value, code = "COUNTERS_INVALID") {
  const result = total + value;
  if (!Number.isSafeInteger(result)) {
    fail(code, "aggregate counter exceeds the safe integer range");
  }
  return result;
}

function parseJsonObject(raw, code, message) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(code, message);
  }
  return requireRecord(parsed, code, message);
}

function requireSafeRelativePath(value, code, message) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 240 ||
    value.includes("\0") ||
    path.isAbsolute(value)
  ) {
    fail(code, message);
  }
  const normalized = path.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    fail(code, message);
  }
  return value;
}

export function parseEvidenceManifest(raw) {
  const manifest = parseJsonObject(
    raw,
    "MANIFEST_INVALID",
    "B5 evidence manifest is not valid JSON"
  );
  requireExactFields(
    manifest,
    ["schemaVersion", "gate", "reports"],
    "MANIFEST_INVALID",
    "B5 evidence manifest"
  );
  requireEqual(
    manifest.schemaVersion,
    1,
    "MANIFEST_INVALID",
    "B5 evidence manifest schema is invalid"
  );
  requireEqual(
    manifest.gate,
    MANIFEST_GATE,
    "MANIFEST_INVALID",
    "B5 evidence manifest gate is invalid"
  );
  if (
    !Array.isArray(manifest.reports) ||
    manifest.reports.length !== B5_REQUIRED_SESSION_REPORTS
  ) {
    fail(
      "SESSION_COUNT_INVALID",
      `B5 requires exactly ${B5_REQUIRED_SESSION_REPORTS} session reports`
    );
  }

  const reportPaths = new Set();
  const reports = manifest.reports.map((entry, index) => {
    const expectedSequence = index + 1;
    const expectedSlot = String(expectedSequence).padStart(3, "0");
    requireExactFields(
      entry,
      ["slot", "report"],
      "MANIFEST_INVALID",
      `B5 manifest report ${expectedSlot}`
    );
    requireEqual(
      entry.slot,
      expectedSlot,
      "SESSION_SEQUENCE_INVALID",
      "B5 report slots must be the exact sequence 001 through 100"
    );
    const report = requireSafeRelativePath(
      entry.report,
      "MANIFEST_INVALID",
      "B5 report location must remain inside the manifest directory"
    );
    const normalized = path.normalize(report);
    if (reportPaths.has(normalized)) {
      fail("DUPLICATE_EVIDENCE", "B5 manifest reuses a report location");
    }
    reportPaths.add(normalized);
    return Object.freeze({
      slot: expectedSlot,
      sequence: expectedSequence,
      report
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    gate: MANIFEST_GATE,
    reports: Object.freeze(reports)
  });
}

function validateCollectorRecord(record, expectedSequence, { bound }) {
  const slot = canonicalSlot(expectedSequence);
  requireExactFields(
    record,
    bound ? COLLECTOR_RECORD_FIELDS : LEGACY_COLLECTOR_RECORD_FIELDS,
    "CAMPAIGN_STATE_INVALID",
    `collector record ${slot}`
  );
  requireEqual(
    record.sequence,
    expectedSequence,
    "CAMPAIGN_STATE_INVALID",
    "collector record sequence is invalid"
  );
  requireEqual(
    record.slot,
    slot,
    "CAMPAIGN_STATE_INVALID",
    "collector record slot is invalid"
  );
  requireUuidV4(
    record.evidenceRecordId,
    "CAMPAIGN_STATE_INVALID",
    "collector evidence record identifier is invalid"
  );
  requireEqual(
    record.runner,
    "B5_DIRECT_CONTROL_SMOKE_V1",
    "CAMPAIGN_STATE_INVALID",
    "collector record runner is invalid"
  );
  for (const field of [
    "reportSha256",
    "targetSignatureSha256",
    ...(bound ? ["accountDeviceCommitmentSha256"] : [])
  ]) {
    if (
      typeof record[field] !== "string" ||
      !SHA256_PATTERN.test(record[field]) ||
      (field === "accountDeviceCommitmentSha256" && /^0{64}$/u.test(record[field]))
    ) {
      fail("CAMPAIGN_STATE_INVALID", `collector record ${field} is invalid`);
    }
  }
  const generatedAtMs = requireCanonicalTimestamp(
    record.generatedAt,
    "CAMPAIGN_STATE_INVALID",
    "collector record timestamp is invalid"
  );
  const captureStartedAtMs = requireCanonicalTimestamp(
    record.captureStartedAt,
    "CAMPAIGN_STATE_INVALID",
    "collector invocation start is invalid"
  );
  const captureCompletedAtMs = requireCanonicalTimestamp(
    record.captureCompletedAt,
    "CAMPAIGN_STATE_INVALID",
    "collector invocation completion is invalid"
  );
  const sessionStartedAtMs = requireCanonicalTimestamp(
    record.sessionStartedAt,
    "CAMPAIGN_STATE_INVALID",
    "collector session start is invalid"
  );
  requireSafeInteger(
    record.durationMs,
    1,
    Number.MAX_SAFE_INTEGER,
    "CAMPAIGN_STATE_INVALID",
    "collector session duration is invalid"
  );
  for (const field of ["pingsSent", "pongsVerified"]) {
    requireSafeInteger(
      record[field],
      4,
      Number.MAX_SAFE_INTEGER,
      "CAMPAIGN_STATE_INVALID",
      `collector record ${field} is invalid`
    );
  }
  requireSafeInteger(
    record.heartbeatMisses,
    0,
    Number.MAX_SAFE_INTEGER,
    "CAMPAIGN_STATE_INVALID",
    "collector heartbeat miss count is invalid"
  );
  if (
    record.pongsVerified > record.pingsSent ||
    sessionStartedAtMs + record.durationMs !== generatedAtMs ||
    captureCompletedAtMs < captureStartedAtMs ||
    generatedAtMs < captureStartedAtMs - MAX_CLOCK_SKEW_MS ||
    generatedAtMs > captureCompletedAtMs + MAX_CLOCK_SKEW_MS
  ) {
    fail("CAMPAIGN_STATE_INVALID", "collector record timing or counters are inconsistent");
  }
  return Object.freeze({
    record,
    generatedAtMs,
    captureStartedAtMs,
    captureCompletedAtMs,
    sessionStartedAtMs
  });
}

export function parseCollectorCampaignState(raw) {
  const state = typeof raw === "string"
    ? parseJsonObject(
        raw,
        "CAMPAIGN_STATE_INVALID",
        "collector campaign state is not valid JSON"
      )
    : requireRecord(
        raw,
        "CAMPAIGN_STATE_INVALID",
        "collector campaign state must be a JSON object"
      );
  const bound =
    state.schemaVersion === 3 &&
    state.harnessVersion === B5_SESSION_COLLECTOR_VERSION;
  const historical =
    state.schemaVersion === 2 &&
    state.harnessVersion === LEGACY_B5_SESSION_COLLECTOR_VERSION;
  if (!bound && !historical) {
    fail(
      "CAMPAIGN_STATE_INVALID",
      "collector campaign state schema is unsupported"
    );
  }
  requireExactFields(
    state,
    bound ? COLLECTOR_STATE_FIELDS : LEGACY_COLLECTOR_STATE_FIELDS,
    "CAMPAIGN_STATE_INVALID",
    "collector campaign state"
  );
  for (const [field, expected] of [
    ["schemaVersion", bound ? 3 : 2],
    [
      "harnessVersion",
      bound
        ? B5_SESSION_COLLECTOR_VERSION
        : LEGACY_B5_SESSION_COLLECTOR_VERSION
    ],
    ["product", "V5BT"],
    ["phase", "B5"],
    ["mode", "PHYSICAL_HUNDRED_SESSION_COLLECTION"],
    ["requiredSessions", B5_REQUIRED_SESSION_REPORTS]
  ]) {
    requireEqual(
      state[field],
      expected,
      "CAMPAIGN_STATE_INVALID",
      `collector campaign field ${field} is invalid`
    );
  }
  requireUuidV4(
    state.campaignRunId,
    "CAMPAIGN_STATE_INVALID",
    "collector campaign identifier is invalid"
  );
  const createdAtMs = requireCanonicalTimestamp(
    state.createdAt,
    "CAMPAIGN_STATE_INVALID",
    "collector campaign creation timestamp is invalid"
  );
  const updatedAtMs = requireCanonicalTimestamp(
    state.updatedAt,
    "CAMPAIGN_STATE_INVALID",
    "collector campaign update timestamp is invalid"
  );
  requireSafeInteger(
    state.lastCaptureBootId,
    1,
    255,
    "CAMPAIGN_STATE_INVALID",
    "collector capture continuity metadata is invalid"
  );
  if (
    typeof state.collectionCommitmentSha256 !== "string" ||
    !SHA256_PATTERN.test(state.collectionCommitmentSha256) ||
    !Array.isArray(state.records) ||
    state.records.length !== B5_REQUIRED_SESSION_REPORTS
  ) {
    fail(
      "CAMPAIGN_STATE_INVALID",
      "collector campaign must contain exactly 100 committed records"
    );
  }
  if (
    bound &&
    (typeof state.accountDeviceCommitmentSha256 !== "string" ||
      !SHA256_PATTERN.test(state.accountDeviceCommitmentSha256) ||
      /^0{64}$/u.test(state.accountDeviceCommitmentSha256))
  ) {
    fail(
      "CAMPAIGN_STATE_INVALID",
      "collector account/device commitment is invalid"
    );
  }

  const reportDigests = new Set();
  const recordIds = new Set();
  const generatedTimestamps = new Set();
  let targetSignatureSha256 = null;
  let previous = null;
  const records = state.records.map((record, index) => {
    const validated = validateCollectorRecord(record, index + 1, { bound });
    if (
      reportDigests.has(record.reportSha256) ||
      recordIds.has(record.evidenceRecordId) ||
      generatedTimestamps.has(record.generatedAt)
    ) {
      fail("CAMPAIGN_STATE_INVALID", "collector campaign contains duplicate evidence");
    }
    reportDigests.add(record.reportSha256);
    recordIds.add(record.evidenceRecordId);
    generatedTimestamps.add(record.generatedAt);
    if (targetSignatureSha256 === null) {
      targetSignatureSha256 = record.targetSignatureSha256;
    } else if (record.targetSignatureSha256 !== targetSignatureSha256) {
      fail("CAMPAIGN_STATE_INVALID", "collector campaign target changed");
    }
    if (
      bound &&
      !constantTimeHexEqual(
        record.accountDeviceCommitmentSha256,
        state.accountDeviceCommitmentSha256
      )
    ) {
      fail(
        "CAMPAIGN_STATE_INVALID",
        "collector account/device commitment changed between slots"
      );
    }
    if (
      previous !== null &&
      (validated.generatedAtMs <= previous.generatedAtMs ||
        validated.sessionStartedAtMs < previous.generatedAtMs ||
        validated.captureStartedAtMs < previous.captureCompletedAtMs)
    ) {
      fail("CAMPAIGN_STATE_INVALID", "collector campaign windows are not sequential");
    }
    previous = validated;
    return validated;
  });

  const expectedCommitment = collectionCommitment(state.records);
  if (
    !constantTimeHexEqual(state.collectionCommitmentSha256, expectedCommitment) ||
    createdAtMs > records[0].captureStartedAtMs ||
    updatedAtMs !== records.at(-1).captureCompletedAtMs
  ) {
    fail("CAMPAIGN_STATE_INVALID", "collector campaign metadata is inconsistent");
  }

  return Object.freeze({
    state,
    records: Object.freeze(records),
    createdAtMs,
    updatedAtMs,
    campaignRunId: state.campaignRunId,
    campaignIdCommitmentSha256: sha256(Buffer.from(state.campaignRunId, "utf8")),
    collectionCommitmentSha256: expectedCommitment,
    accountDeviceCommitmentSha256:
      state.accountDeviceCommitmentSha256 ?? null,
    accountDeviceBound: bound
  });
}

function resolveEvidencePath(manifestPath, relativePath) {
  const base = path.dirname(path.resolve(manifestPath));
  const resolved = path.resolve(base, relativePath);
  const relative = path.relative(base, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail("MANIFEST_INVALID", "B5 report location escapes the manifest directory");
  }
  return resolved;
}

const NO_FOLLOW_FLAG =
  process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0;
const DIRECTORY_FLAG = fs.constants.O_DIRECTORY ?? 0;
const NONBLOCK_FLAG = fs.constants.O_NONBLOCK ?? 0;

function isUnsafeFilesystemType(error) {
  return error?.code === "ELOOP" || error?.code === "ENOTDIR";
}

function openManifestRoot(manifestPath) {
  const location = path.dirname(path.resolve(manifestPath));
  let descriptor;
  try {
    descriptor = fs.openSync(
      location,
      fs.constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG
    );
    if (!fs.fstatSync(descriptor).isDirectory()) {
      fail(
        "EVIDENCE_INVALID",
        "B5 evidence manifest directory is not a regular directory"
      );
    }
    return Object.freeze({ location, descriptor });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof B5HundredSessionGateError) throw error;
    if (isUnsafeFilesystemType(error)) {
      fail(
        "EVIDENCE_INVALID",
        "B5 evidence manifest directory must not use symbolic links"
      );
    }
    fail("EVIDENCE_UNAVAILABLE", "B5 evidence manifest directory is unavailable");
  }
}

function requireLocationUnderManifestRoot(root, location, label) {
  const relative = path.relative(root.location, path.resolve(location));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail("EVIDENCE_INVALID", `${label} escapes the manifest directory`);
  }
  return relative.split(path.sep);
}

function openUnderManifestRoot(root, location, label) {
  const components = requireLocationUnderManifestRoot(root, location, label);
  const finalName = components.pop();
  let ownedDirectoryDescriptor;
  let currentDirectoryDescriptor = root.descriptor;
  try {
    if (process.platform === "linux") {
      for (const component of components) {
        const nextDescriptor = fs.openSync(
          `/proc/self/fd/${currentDirectoryDescriptor}/${component}`,
          fs.constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG
        );
        if (!fs.fstatSync(nextDescriptor).isDirectory()) {
          fs.closeSync(nextDescriptor);
          fail(
            "EVIDENCE_INVALID",
            `${label} has an invalid directory component`
          );
        }
        if (ownedDirectoryDescriptor !== undefined) {
          fs.closeSync(ownedDirectoryDescriptor);
        }
        ownedDirectoryDescriptor = nextDescriptor;
        currentDirectoryDescriptor = nextDescriptor;
      }
      return fs.openSync(
        `/proc/self/fd/${currentDirectoryDescriptor}/${finalName}`,
        fs.constants.O_RDONLY | NO_FOLLOW_FLAG | NONBLOCK_FLAG
      );
    }

    let current = root.location;
    for (const component of components) {
      current = path.join(current, component);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(
          "EVIDENCE_INVALID",
          `${label} has an invalid directory component`
        );
      }
    }
    const finalLocation = path.join(current, finalName);
    const finalStat = fs.lstatSync(finalLocation);
    if (finalStat.isSymbolicLink()) {
      fail("EVIDENCE_INVALID", `${label} must not be a symbolic link`);
    }
    return fs.openSync(
      finalLocation,
      fs.constants.O_RDONLY | NO_FOLLOW_FLAG | NONBLOCK_FLAG
    );
  } catch (error) {
    if (error instanceof B5HundredSessionGateError) throw error;
    if (isUnsafeFilesystemType(error)) {
      fail("EVIDENCE_INVALID", `${label} must not use symbolic links`);
    }
    fail("EVIDENCE_UNAVAILABLE", `${label} could not be read`);
  } finally {
    if (ownedDirectoryDescriptor !== undefined) {
      fs.closeSync(ownedDirectoryDescriptor);
    }
  }
}

function readRegularFile(
  location,
  maximumBytes,
  label,
  manifestRoot,
  { privateFile = false } = {}
) {
  let descriptor;
  try {
    descriptor = openUnderManifestRoot(manifestRoot, location, label);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) {
      fail("EVIDENCE_INVALID", `${label} is not a bounded regular file`);
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      privateFile &&
      (before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 ||
        (currentUid !== null && before.uid !== currentUid))
    ) {
      fail("EVIDENCE_INVALID", `${label} must be a private 0600 regular file`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      !after.isFile() ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      (privateFile &&
        (after.nlink !== 1 ||
          (after.mode & 0o777) !== 0o600 ||
          (currentUid !== null && after.uid !== currentUid))) ||
      bytes.length !== after.size ||
      bytes.length < 1 ||
      bytes.length > maximumBytes
    ) {
      fail("EVIDENCE_INVALID", `${label} changed while it was being read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof B5HundredSessionGateError) throw error;
    if (isUnsafeFilesystemType(error)) {
      fail("EVIDENCE_INVALID", `${label} must not use symbolic links`);
    }
    fail("EVIDENCE_UNAVAILABLE", `${label} could not be read`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertNoIdentifyingMaterial(value, code, message) {
  const encoded = JSON.stringify(value);
  for (const pattern of [
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu,
    /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/iu,
    /\/org\/bluez\//u,
    /\/(?:home|tmp|var|etc|run)\//u,
    /-----BEGIN [A-Z ]+-----/u,
    /"(?:node.?id|certificate.?id|session.?id|campaign.?run.?id|campaign.?id.?commitment(?:sha256)?|collection.?commitment(?:sha256)?|evidence.?record.?id|target.?signature(?:sha256)?|(?:source.?)?report.?sha256|serial|deviceSerial|androidUserId|appUid|sessionBindingHmacSha256|payload|registry.?path|device.?path|report.?path|report.?name|output.?path)"/iu
  ]) {
    if (pattern.test(encoded)) fail(code, message);
  }
  return true;
}

function validateTarget(value) {
  const target = requireExactFields(
    value,
    TARGET_FIELDS,
    "REPORT_TARGET_INVALID",
    "B5.7 report target"
  );
  requireEqual(
    target.role,
    "GATT_SERVER",
    "REPORT_TARGET_INVALID",
    "B5.7 report target role is invalid"
  );
  if (
    typeof target.architecture !== "string" ||
    !SAFE_ARCHITECTURE_PATTERN.test(target.architecture) ||
    typeof target.nodeVersion !== "string" ||
    !SAFE_VERSION_PATTERN.test(target.nodeVersion) ||
    typeof target.bluezVersion !== "string" ||
    !SAFE_VERSION_PATTERN.test(target.bluezVersion) ||
    typeof target.adapterName !== "string" ||
    !ADAPTER_PATTERN.test(target.adapterName)
  ) {
    fail("REPORT_TARGET_INVALID", "B5.7 report target metadata is invalid");
  }
  return target;
}

function validateChecks(value) {
  const checks = requireExactFields(
    value,
    CHECK_FIELDS,
    "REPORT_CHECKS_INVALID",
    "B5.7 report checks"
  );
  for (const field of CHECK_FIELDS) {
    const expected =
      field === "businessCharacteristics" ? "FAIL_CLOSED" : "PASS";
    requireEqual(
      checks[field],
      expected,
      "REPORT_CHECKS_INVALID",
      `B5.7 check ${field} is not complete`
    );
  }
  return checks;
}

function validateObserved(value) {
  const observed = requireExactFields(
    value,
    OBSERVED_FIELDS,
    "REPORT_COUNTERS_INVALID",
    "B5.7 observed counters"
  );
  requireEqual(
    observed.finalState,
    "CLOSED",
    "SESSION_INCOMPLETE",
    "B5.7 session did not finish CLOSED"
  );
  requireSafeInteger(
    observed.durationMs,
    1,
    Number.MAX_SAFE_INTEGER,
    "REPORT_COUNTERS_INVALID",
    "B5.7 duration is invalid"
  );
  for (const [field, expected] of [
    ["managedObjectCount", 8],
    ["characteristicCount", 7],
    ["helloExchanged", 1],
    ["mutualAuthentications", 1],
    ["keyEstablishments", 1],
    ["activeTransitions", 1],
    ["cleanCloses", 1]
  ]) {
    requireEqual(
      observed[field],
      expected,
      "REPORT_COUNTERS_INVALID",
      `B5.7 counter ${field} is invalid`
    );
  }
  requireSafeInteger(
    observed.pingsSent,
    4,
    Number.MAX_SAFE_INTEGER,
    "REPORT_COUNTERS_INVALID",
    "B5.7 PING count is invalid"
  );
  requireSafeInteger(
    observed.pongsVerified,
    4,
    Number.MAX_SAFE_INTEGER,
    "REPORT_COUNTERS_INVALID",
    "B5.7 PONG count is invalid"
  );
  requireSafeInteger(
    observed.heartbeatMisses,
    0,
    Number.MAX_SAFE_INTEGER,
    "REPORT_COUNTERS_INVALID",
    "B5.7 heartbeat miss count is invalid"
  );
  if (observed.pongsVerified > observed.pingsSent) {
    fail("REPORT_COUNTERS_INVALID", "B5.7 heartbeat counters are inconsistent");
  }
  for (const field of [
    "activeAfterClose",
    "timersAfterClose",
    "retainedSecretBuffersAfterClose",
    "activeAfterCleanup",
    "timersAfterCleanup",
    "retainedSecretBuffersAfterCleanup"
  ]) {
    requireEqual(
      observed[field],
      0,
      "SESSION_RESOURCE_LEAK",
      `B5.7 cleanup counter ${field} is not zero`
    );
  }
  requireEqual(
    observed.failures,
    0,
    "SESSION_FAILURE_REPORTED",
    "B5.7 report contains a failure"
  );
  return observed;
}

function validateSourcePrivacy(value) {
  const privacy = requireExactFields(
    value,
    PRIVACY_FIELDS,
    "REPORT_PRIVACY_INVALID",
    "B5.7 report privacy"
  );
  for (const field of PRIVACY_FIELDS) {
    requireEqual(
      privacy[field],
      false,
      "REPORT_PRIVACY_INVALID",
      `B5.7 privacy field ${field} is invalid`
    );
  }
}

export function validatePhysicalSessionReport(record) {
  requireExactFields(
    record,
    ["sequence", "sourceReportSha256", "report"],
    "REPORT_RECORD_INVALID",
    "B5 session evidence record"
  );
  const sequence = requireSafeInteger(
    record.sequence,
    1,
    B5_REQUIRED_SESSION_REPORTS,
    "SESSION_SEQUENCE_INVALID",
    "B5 session sequence is invalid"
  );
  if (
    typeof record.sourceReportSha256 !== "string" ||
    !SHA256_PATTERN.test(record.sourceReportSha256)
  ) {
    fail("REPORT_RECORD_INVALID", "B5 source report digest is invalid");
  }
  const report = requireExactFields(
    record.report,
    ROOT_FIELDS,
    "REPORT_SCHEMA_INVALID",
    "B5.7 physical report"
  );
  for (const [field, expected] of [
    ["schemaVersion", 1],
    ["harnessVersion", B5_7_HARNESS_VERSION],
    ["product", "V5BT"],
    ["phase", "B5.7"],
    ["mode", "PHYSICAL"],
    ["verdict", "PASS"],
    ["physicalRadioAccessed", true],
    ["v5btProductionServiceChanges", false]
  ]) {
    requireEqual(
      report[field],
      expected,
      "REPORT_NOT_PHYSICAL_PASS",
      `B5.7 report field ${field} is invalid`
    );
  }
  const generatedAtMs = requireCanonicalTimestamp(
    report.generatedAt,
    "REPORT_TIMESTAMP_INVALID",
    "B5.7 report timestamp is invalid"
  );
  const target = validateTarget(report.target);
  validateChecks(report.checks);
  const observed = validateObserved(report.observed);
  const gate = requireExactFields(
    report.gate,
    GATE_FIELDS,
    "REPORT_GATE_INVALID",
    "B5.7 report gate"
  );
  for (const [field, expected] of [
    ["directControl", "PASS_ONE_PHYSICAL_TARGET"],
    ["businessTraffic", "NOT_STARTED"],
    ["hundredSessionCampaign", "PENDING"]
  ]) {
    requireEqual(
      gate[field],
      expected,
      "REPORT_GATE_INVALID",
      `B5.7 report gate ${field} is invalid`
    );
  }
  validateSourcePrivacy(report.privacy);
  assertNoIdentifyingMaterial(
    report,
    "REPORT_PRIVACY_INVALID",
    "B5.7 report contains identifying or private material"
  );

  return Object.freeze({
    sequence,
    sourceReportSha256: record.sourceReportSha256,
    generatedAt: report.generatedAt,
    generatedAtMs,
    captureStartMs: generatedAtMs - observed.durationMs,
    targetSignature: JSON.stringify(target),
    targetSignatureSha256: sha256(JSON.stringify(target)),
    durationMs: observed.durationMs,
    pingsSent: observed.pingsSent,
    pongsVerified: observed.pongsVerified,
    heartbeatMisses: observed.heartbeatMisses
  });
}

export function assertAggregateReportRedacted(report, sensitiveValues = []) {
  const privacy = requireRecord(
    report?.privacy,
    "AGGREGATE_PRIVACY_INVALID",
    "B5 aggregate privacy"
  );
  const actualFields = Object.keys(privacy).sort();
  const acceptedFields = [
    AGGREGATE_PRIVACY_FIELDS,
    BOUND_AGGREGATE_PRIVACY_FIELDS
  ].find((fields) => {
    const expected = [...fields].sort();
    return (
      actualFields.length === expected.length &&
      actualFields.every((field, index) => field === expected[index])
    );
  });
  if (acceptedFields === undefined) {
    fail(
      "AGGREGATE_PRIVACY_INVALID",
      "B5 aggregate privacy has an invalid field set"
    );
  }
  for (const field of acceptedFields) {
    const expected =
      field === "campaignCommitmentsIncluded" &&
      Object.hasOwn(report, "accountDeviceCommitmentSha256");
    requireEqual(
      privacy[field],
      expected,
      "AGGREGATE_PRIVACY_INVALID",
      `B5 aggregate privacy field ${field} is invalid`
    );
  }
  for (const field of PUBLIC_AGGREGATE_COMMITMENT_FIELDS) {
    if (
      Object.hasOwn(report, field) &&
      (typeof report[field] !== "string" ||
        !SHA256_PATTERN.test(report[field]) ||
        /^0{64}$/u.test(report[field]))
    ) {
      fail(
        "AGGREGATE_PRIVACY_INVALID",
        `B5 aggregate commitment ${field} is invalid`
      );
    }
  }
  assertNoIdentifyingMaterial(
    report,
    "AGGREGATE_PRIVACY_INVALID",
    "B5 aggregate contains identifying or private material"
  );
  const encoded = JSON.stringify(report);
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.length > 0 && encoded.includes(value)) {
      fail(
        "AGGREGATE_PRIVACY_INVALID",
        "B5 aggregate contains source evidence details"
      );
    }
  }
  return true;
}

function assertCollectorStateMatchesSessions(campaignState, sessions) {
  if (campaignState.records.length !== sessions.length) {
    fail(
      "CAMPAIGN_STATE_EVIDENCE_MISMATCH",
      "collector state does not bind the complete report collection"
    );
  }
  const sessionCommitment = sha256(
    sessions.map((session) => session.sourceReportSha256).join("\n")
  );
  if (
    !constantTimeHexEqual(
      campaignState.collectionCommitmentSha256,
      sessionCommitment
    )
  ) {
    fail(
      "CAMPAIGN_STATE_EVIDENCE_MISMATCH",
      "collector state commitment does not match the report collection"
    );
  }
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    const record = campaignState.records[index].record;
    const expected = {
      sequence: session.sequence,
      slot: canonicalSlot(session.sequence),
      reportSha256: session.sourceReportSha256,
      generatedAt: session.generatedAt,
      sessionStartedAt: new Date(session.captureStartMs).toISOString(),
      durationMs: session.durationMs,
      pingsSent: session.pingsSent,
      pongsVerified: session.pongsVerified,
      heartbeatMisses: session.heartbeatMisses,
      targetSignatureSha256: session.targetSignatureSha256
    };
    if (
      Object.entries(expected).some(([field, value]) => record[field] !== value)
    ) {
      fail(
        "CAMPAIGN_STATE_EVIDENCE_MISMATCH",
        "collector record metadata does not match its physical report"
      );
    }
  }
  return true;
}

function validateAndroidContinuityBinding(
  androidAttestation,
  campaignState,
  attemptLedger,
  aggregateGeneratedAtMs
) {
  let continuity;
  try {
    continuity = parseB5AndroidContinuityAttestation(androidAttestation);
  } catch {
    fail(
      "ANDROID_ATTESTATION_INVALID",
      "Android continuity attestation is invalid"
    );
  }
  if (!continuity.accountDeviceBound) {
    fail(
      "ACCOUNT_DEVICE_COMMITMENT_REQUIRED",
      "Historical Android continuity attestation remains PENDING"
    );
  }
  if (
    !constantTimeHexEqual(
      continuity.campaignIdCommitmentSha256,
      campaignState.campaignIdCommitmentSha256
    )
  ) {
    fail(
      "ANDROID_CAMPAIGN_BINDING_INVALID",
      "Android continuity attestation belongs to a different campaign"
    );
  }
  if (
    continuity.monitoredFromMs > attemptLedger.coverageFromMs ||
    continuity.monitoredUntilMs < attemptLedger.coverageUntilMs
  ) {
    fail(
      "ANDROID_TIMELINE_INCOMPLETE",
      "Android continuity attestation does not cover the physical campaign"
    );
  }
  // The public attestation stays redacted; the private baseline is committed
  // separately before this target is accepted.
  if (continuity.report?.target?.role !== "handheld") {
    fail(
      "ANDROID_TARGET_ROLE_INVALID",
      "Android continuity attestation does not bind the handheld target"
    );
  }
  if (aggregateGeneratedAtMs < continuity.generatedAtMs) {
    fail(
      "AGGREGATE_TIMESTAMP_INVALID",
      "B5 aggregate predates the Android continuity attestation"
    );
  }
  return continuity;
}

function validateAccountDeviceBinding(
  accountDeviceBinding,
  campaignState,
  continuity
) {
  let binding;
  try {
    binding = parseB5AccountDeviceBinding(accountDeviceBinding);
  } catch (error) {
    if (error instanceof B5AccountDeviceCommitmentError) {
      fail(error.code, error.message);
    }
    throw error;
  }
  if (binding.campaignId !== campaignState.campaignRunId) {
    fail(
      "ACCOUNT_DEVICE_CAMPAIGN_MISMATCH",
      "B5 account/device binding belongs to another campaign"
    );
  }
  const commitmentSha256 =
    createB5AccountDeviceCommitmentSha256(binding);
  if (
    !constantTimeHexEqual(
      commitmentSha256,
      campaignState.accountDeviceCommitmentSha256
    ) ||
    !constantTimeHexEqual(
      commitmentSha256,
      continuity.accountDeviceCommitmentSha256
    ) ||
    !constantTimeHexEqual(
      campaignState.accountDeviceCommitmentSha256,
      continuity.accountDeviceCommitmentSha256
    )
  ) {
    fail(
      "ACCOUNT_DEVICE_COMMITMENT_MISMATCH",
      "B5 collector account/device commitment does not match the private baseline"
    );
  }
  const target = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;
  const attested = continuity.report?.target;
  if (
    binding.role !== "handheld" ||
    binding.packageName !== target.packageId ||
    binding.versionName !== target.versionName ||
    binding.versionCode !== target.versionCode ||
    binding.apkSha256 !== target.sha256 ||
    binding.signingCertificateSha256 !==
      target.signingCertificateSha256 ||
    attested?.role !== binding.role ||
    attested?.packageName !== binding.packageName ||
    attested?.versionName !== binding.versionName ||
    attested?.versionCode !== binding.versionCode ||
    attested?.androidApi !== binding.androidApi
  ) {
    fail(
      "ACCOUNT_DEVICE_TARGET_MISMATCH",
      "B5 account/device binding does not match the certified continuity target"
    );
  }
  return Object.freeze({ binding, commitmentSha256 });
}

function exactJsonEvidence(value, suppliedBytes, code, label) {
  const bytes = suppliedBytes === undefined
    ? Buffer.from(
        typeof value === "string" ? value : JSON.stringify(value),
        "utf8"
      )
    : Buffer.isBuffer(suppliedBytes)
      ? Buffer.from(suppliedBytes)
      : Buffer.from(suppliedBytes);
  return Object.freeze({
    bytes,
    value: parseJsonObject(bytes.toString("utf8"), code, `${label} is not valid JSON`)
  });
}

function validateRaspberryContinuityBinding(
  raspberryAttestation,
  campaignState,
  attemptLedger,
  aggregateGeneratedAtMs
) {
  let continuity;
  try {
    continuity = parseB5RaspberryContinuityAttestation(raspberryAttestation);
  } catch {
    fail(
      "RASPBERRY_ATTESTATION_INVALID",
      "Raspberry continuity attestation is invalid"
    );
  }
  if (
    !constantTimeHexEqual(
      continuity.campaignIdCommitmentSha256,
      campaignState.campaignIdCommitmentSha256
    )
  ) {
    fail(
      "RASPBERRY_CAMPAIGN_BINDING_INVALID",
      "Raspberry continuity attestation belongs to a different campaign"
    );
  }
  if (
    continuity.monitoredFromMs > attemptLedger.coverageFromMs ||
    continuity.monitoredUntilMs < attemptLedger.coverageUntilMs
  ) {
    fail(
      "RASPBERRY_TIMELINE_INCOMPLETE",
      "Raspberry continuity attestation does not cover the physical campaign"
    );
  }
  if (aggregateGeneratedAtMs < continuity.generatedAtMs) {
    fail(
      "AGGREGATE_TIMESTAMP_INVALID",
      "B5 aggregate predates the Raspberry continuity attestation"
    );
  }
  return continuity;
}

function validateAttemptLedgerBinding(attemptState, campaignState) {
  let attemptLedger;
  try {
    attemptLedger = parseB5CampaignSupervisorLedger(attemptState);
  } catch {
    fail("ATTEMPT_STATE_INVALID", "B5 campaign attempt ledger is invalid");
  }
  if (attemptLedger.campaignRunId !== campaignState.campaignRunId) {
    fail(
      "ATTEMPT_CAMPAIGN_BINDING_INVALID",
      "B5 attempt ledger belongs to a different campaign"
    );
  }
  if (
    attemptLedger.status !== "COMPLETE" ||
    attemptLedger.committedSessions !== B5_REQUIRED_SESSION_REPORTS ||
    attemptLedger.committedAttemptCount !== B5_REQUIRED_SESSION_REPORTS ||
    attemptLedger.invalidatedAttemptCount !== 0 ||
    attemptLedger.finalConsecutiveTimeouts !== 0
  ) {
    fail(
      "ATTEMPT_POLICY_INVALID",
      "B5 attempt ledger does not prove a complete non-invalidated campaign"
    );
  }
  const committed = attemptLedger.events.filter(
    (event) => event.kind === "ATTEMPT" && event.outcome === "COMMITTED"
  );
  if (committed.length !== campaignState.records.length) {
    fail(
      "ATTEMPT_STATE_EVIDENCE_MISMATCH",
      "B5 attempt ledger does not bind every collector record"
    );
  }
  for (let index = 0; index < committed.length; index += 1) {
    const event = committed[index];
    const record = campaignState.records[index];
    const startedAtMs = Date.parse(event.startedAt);
    const completedAtMs = Date.parse(event.completedAt);
    if (
      event.slot !== canonicalSlot(index + 1) ||
      event.collectorCountBefore !== index ||
      event.collectorCountAfter !== index + 1 ||
      event.cleanupVerified !== true ||
      startedAtMs > record.captureStartedAtMs ||
      completedAtMs < record.captureCompletedAtMs
    ) {
      fail(
        "ATTEMPT_STATE_EVIDENCE_MISMATCH",
        "B5 committed attempt metadata does not match collector evidence"
      );
    }
  }
  if (
    attemptLedger.coverageFromMs > campaignState.records[0].captureStartedAtMs ||
    attemptLedger.coverageUntilMs < campaignState.records.at(-1).captureCompletedAtMs
  ) {
    fail(
      "ATTEMPT_TIMELINE_INCOMPLETE",
      "B5 attempt ledger does not cover the complete collector campaign"
    );
  }
  return attemptLedger;
}

function validateCampaignAuthorizationBinding(
  campaignAuthorization,
  campaignState,
  attemptLedger,
  certificationMatrixSha256
) {
  let authorization;
  try {
    authorization = parseB5CampaignAuthorization(campaignAuthorization, {
      campaignId: campaignState.campaignRunId,
      certificationMatrixSha256
    });
  } catch (error) {
    if (error instanceof B5CampaignGovernanceError) {
      fail(error.code, error.message);
    }
    fail(
      "CAMPAIGN_AUTHORIZATION_INVALID",
      "B0-B4 campaign authorization is invalid"
    );
  }
  if (authorization.issuedAtMs > attemptLedger.coverageFromMs) {
    fail(
      "CAMPAIGN_AUTHORIZATION_TIMELINE_INVALID",
      "B0-B4 authorization was issued after the first campaign attempt started"
    );
  }
  return authorization;
}

export function aggregateValidatedSessionReports(
  records,
  {
    generatedAt = new Date().toISOString(),
    sensitiveValues = [],
    campaignState: campaignStateInput,
    attemptState,
    attemptStateBytes,
    androidAttestation,
    androidAttestationBytes,
    accountDeviceBinding,
    raspberryAttestation,
    raspberryAttestationBytes,
    campaignAuthorization,
    certificationMatrixSha256 = sha256Hex(fs.readFileSync(CERTIFICATION_MATRIX_PATH))
  } = {}
) {
  if (
    !Array.isArray(records) ||
    records.length !== B5_REQUIRED_SESSION_REPORTS
  ) {
    fail(
      "SESSION_COUNT_INVALID",
      `B5 requires exactly ${B5_REQUIRED_SESSION_REPORTS} session reports`
    );
  }
  const generatedAtMs = requireCanonicalTimestamp(
    generatedAt,
    "AGGREGATE_TIMESTAMP_INVALID",
    "B5 aggregate timestamp is invalid"
  );
  const sessions = records.map((record, index) => {
    const session = validatePhysicalSessionReport(record);
    if (session.sequence !== index + 1) {
      fail(
        "SESSION_SEQUENCE_INVALID",
        "B5 session sequence is incomplete or out of order"
      );
    }
    return session;
  });

  const sourceDigests = new Set();
  const timestamps = new Set();
  const firstTarget = sessions[0].targetSignature;
  let previous = null;
  for (const session of sessions) {
    if (sourceDigests.has(session.sourceReportSha256)) {
      fail("DUPLICATE_EVIDENCE", "B5 campaign reuses a physical report");
    }
    sourceDigests.add(session.sourceReportSha256);
    if (timestamps.has(session.generatedAt)) {
      fail("DUPLICATE_EVIDENCE", "B5 campaign reuses a physical timestamp");
    }
    timestamps.add(session.generatedAt);
    if (session.targetSignature !== firstTarget) {
      fail("CAMPAIGN_TARGET_CHANGED", "B5 campaign target changed between sessions");
    }
    if (previous !== null) {
      if (session.generatedAtMs <= previous.generatedAtMs) {
        fail("SESSION_SEQUENCE_INVALID", "B5 session timestamps are out of order");
      }
      if (session.captureStartMs < previous.generatedAtMs) {
        fail("SESSION_WINDOWS_OVERLAP", "B5 physical session windows overlap");
      }
    }
    previous = session;
  }

  if (campaignStateInput === undefined) {
    fail("CAMPAIGN_STATE_REQUIRED", "collector campaign state is required");
  }
  if (androidAttestation === undefined) {
    fail("ANDROID_ATTESTATION_REQUIRED", "Android continuity attestation is required");
  }
  if (accountDeviceBinding === undefined) {
    fail(
      "ACCOUNT_DEVICE_BINDING_REQUIRED",
      "Private B5 account/device binding is required"
    );
  }
  if (attemptState === undefined) {
    fail("ATTEMPT_STATE_REQUIRED", "B5 campaign attempt ledger is required");
  }
  if (raspberryAttestation === undefined) {
    fail(
      "RASPBERRY_ATTESTATION_REQUIRED",
      "Raspberry continuity attestation is required"
    );
  }
  if (campaignAuthorization === undefined) {
    fail(
      "CAMPAIGN_AUTHORIZATION_REQUIRED",
      "B0-B4 campaign authorization is required"
    );
  }
  const attemptEvidence = exactJsonEvidence(
    attemptState,
    attemptStateBytes,
    "ATTEMPT_STATE_INVALID",
    "B5 campaign attempt ledger"
  );
  const androidEvidence = exactJsonEvidence(
    androidAttestation,
    androidAttestationBytes,
    "ANDROID_ATTESTATION_INVALID",
    "Android continuity attestation"
  );
  const raspberryEvidence = exactJsonEvidence(
    raspberryAttestation,
    raspberryAttestationBytes,
    "RASPBERRY_ATTESTATION_INVALID",
    "Raspberry continuity attestation"
  );
  const campaignState = parseCollectorCampaignState(campaignStateInput);
  if (!campaignState.accountDeviceBound) {
    fail(
      "ACCOUNT_DEVICE_COMMITMENT_REQUIRED",
      "Historical collector evidence remains PENDING without an account/device commitment"
    );
  }
  assertCollectorStateMatchesSessions(campaignState, sessions);
  const attemptLedger = validateAttemptLedgerBinding(
    attemptEvidence.value,
    campaignState
  );
  const authorization = validateCampaignAuthorizationBinding(
    campaignAuthorization,
    campaignState,
    attemptLedger,
    certificationMatrixSha256
  );
  const continuity = validateAndroidContinuityBinding(
    androidEvidence.value,
    campaignState,
    attemptLedger,
    generatedAtMs
  );
  const accountDevice = validateAccountDeviceBinding(
    accountDeviceBinding,
    campaignState,
    continuity
  );
  const raspberryContinuity = validateRaspberryContinuityBinding(
    raspberryEvidence.value,
    campaignState,
    attemptLedger,
    generatedAtMs
  );

  let totalDurationMs = 0;
  let pingsSent = 0;
  let pongsVerified = 0;
  let heartbeatMisses = 0;
  for (const session of sessions) {
    totalDurationMs = safeAdd(totalDurationMs, session.durationMs);
    pingsSent = safeAdd(pingsSent, session.pingsSent);
    pongsVerified = safeAdd(pongsVerified, session.pongsVerified);
    heartbeatMisses = safeAdd(heartbeatMisses, session.heartbeatMisses);
  }
  const durations = sessions.map((session) => session.durationMs);
  if (generatedAtMs < sessions.at(-1).generatedAtMs) {
    fail(
      "AGGREGATE_TIMESTAMP_INVALID",
      "B5 aggregate predates its final physical report"
    );
  }

  const report = Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_HUNDRED_SESSION_HARNESS_VERSION,
    product: "V5BT",
    phase: "B5",
    generatedAt,
    mode: "PHYSICAL_HUNDRED_SESSION_TECHNICAL_AGGREGATE",
    verdict: "TECHNICAL_PASS",
    accountDeviceCommitmentSha256: accountDevice.commitmentSha256,
    attemptLedgerHeadSha256: attemptLedger.headSha256,
    androidAttestationSha256: sha256(androidEvidence.bytes),
    raspberryAttestationSha256: sha256(raspberryEvidence.bytes),
    campaign: Object.freeze({
      requiredReports: B5_REQUIRED_SESSION_REPORTS,
      acceptedReports: sessions.length,
      collectorStateSchemaVersion: 3,
      attemptLedgerSchemaVersion: 1,
      campaignAuthorizationSchemaVersion: 1,
      androidAttestationSchemaVersion: 1,
      raspberryAttestationSchemaVersion: 1,
      firstEvidenceAt: sessions[0].generatedAt,
      finalEvidenceAt: sessions.at(-1).generatedAt
    }),
    checks: Object.freeze({
      exactReportCount: "PASS",
      orderedNonOverlappingSequence: "PASS",
      uniqueEvidence: "PASS",
      consistentTarget: "PASS",
      completeB57Lifecycle: "PASS",
      authenticatedHeartbeat: "PASS",
      cleanClose: "PASS",
      leakFreeCleanup: "PASS",
      businessCharacteristicsFailClosed: "PASS",
      collectorStateSchema: "PASS",
      collectorCollectionCommitment: "PASS",
      collectorReportMetadata: "PASS",
      accountDeviceCommitment: "PASS",
      attemptLedgerIntegrity: "PASS",
      attemptCampaignBinding: "PASS",
      attemptRetryPolicy: "PASS",
      attemptTimelineCoverage: "PASS",
      b0B4CampaignAuthorization: "PASS",
      authorizationBeforeFirstAttempt: "PASS",
      androidCampaignBinding: "PASS",
      androidTimelineCoverage: "PASS",
      androidHandheldTarget: "PASS",
      androidProcessContinuity: "PASS",
      androidSessionContinuity: "PASS",
      androidCrashAnrContinuity: "PASS",
      raspberryCampaignBinding: "PASS",
      raspberryTimelineCoverage: "PASS",
      raspberryServiceContinuity: "PASS",
      raspberryBootClockContinuity: "PASS"
    }),
    totals: Object.freeze({
      sessionsOpened: sessions.length,
      sessionsActivated: sessions.length,
      sessionsClosedCleanly: sessions.length,
      helloExchanges: sessions.length,
      mutualAuthentications: sessions.length,
      keyEstablishments: sessions.length,
      pingsSent,
      pongsVerified,
      heartbeatMisses,
      failures: 0,
      resourceLeaks: 0,
      durationMs: totalDurationMs,
      minimumSessionDurationMs: Math.min(...durations),
      maximumSessionDurationMs: Math.max(...durations)
    }),
    gate: Object.freeze({
      b57PhysicalEvidence: "PASS_100_REDACTED_REPORTS",
      b5TechnicalGate: "PASS",
      b5HundredSessionGate: "PENDING_REVIEW",
      b6: "PENDING"
    }),
    privacy: Object.freeze({
      identifiersIncluded: false,
      addressesIncluded: false,
      cryptographicMaterialIncluded: false,
      messageBodiesIncluded: false,
      localLocationsIncluded: false,
      sourceReportDetailsIncluded: false,
      campaignCommitmentsIncluded: true,
      privateRecordIdentifiersIncluded: false
    }),
    physicalEvidenceConsumed: true,
    v5btProductionServiceChanges: false
  });
  const privateValues = [
    ...sensitiveValues,
    campaignState.campaignRunId,
    campaignState.campaignIdCommitmentSha256,
    campaignState.collectionCommitmentSha256,
    authorization.prerequisiteEvidenceBundleSha256,
    authorization.operatorCommitmentSha256,
    continuity.campaignIdCommitmentSha256,
    raspberryContinuity.campaignIdCommitmentSha256,
    ...b5AccountDeviceSensitiveValues(accountDevice.binding),
    ...campaignState.records.flatMap(({ record }) => [
      record.evidenceRecordId,
      record.reportSha256,
      record.targetSignatureSha256
    ]),
    ...attemptLedger.events.map((event) => event.eventId)
  ];
  assertAggregateReportRedacted(report, privateValues);
  return report;
}

export function validPhysicalReportFixture(sequence = 1) {
  const generatedAt = new Date(
    Date.parse("2026-07-21T00:00:00.000Z") + sequence * 61_000
  ).toISOString();
  return {
    schemaVersion: 1,
    harnessVersion: B5_7_HARNESS_VERSION,
    product: "V5BT",
    phase: "B5.7",
    generatedAt,
    mode: "PHYSICAL",
    verdict: "PASS",
    target: {
      role: "GATT_SERVER",
      architecture: "arm64",
      nodeVersion: "v24.15.0",
      bluezVersion: "5.82",
      adapterName: "hci0"
    },
    checks: {
      bluezPreflight: "PASS",
      registryReadOnlyInspection: "PASS",
      helloExchange: "PASS",
      mutualAuthentication: "PASS",
      keyEstablishment: "PASS",
      activeStateReached: "PASS",
      authenticatedHeartbeat: "PASS",
      exactSingleSequentialSession: "PASS",
      cleanClose: "PASS",
      businessCharacteristics: "FAIL_CLOSED",
      unregisterApplication: "PASS",
      resourceCleanup: "PASS"
    },
    observed: {
      finalState: "CLOSED",
      durationMs: 60_000,
      managedObjectCount: 8,
      characteristicCount: 7,
      helloExchanged: 1,
      mutualAuthentications: 1,
      keyEstablishments: 1,
      activeTransitions: 1,
      pingsSent: 4,
      pongsVerified: 4,
      heartbeatMisses: 0,
      cleanCloses: 1,
      activeAfterClose: 0,
      timersAfterClose: 0,
      retainedSecretBuffersAfterClose: 0,
      activeAfterCleanup: 0,
      timersAfterCleanup: 0,
      retainedSecretBuffersAfterCleanup: 0,
      failures: 0
    },
    gate: {
      directControl: "PASS_ONE_PHYSICAL_TARGET",
      businessTraffic: "NOT_STARTED",
      hundredSessionCampaign: "PENDING"
    },
    privacy: {
      identifiersIncluded: false,
      addressesIncluded: false,
      cryptographicMaterialIncluded: false,
      messageBodiesIncluded: false,
      localLocationsIncluded: false
    },
    physicalRadioAccessed: true,
    v5btProductionServiceChanges: false
  };
}

function fixtureRecord(sequence) {
  const report = validPhysicalReportFixture(sequence);
  return {
    sequence,
    sourceReportSha256: sha256(JSON.stringify(report)),
    report
  };
}

export function validCollectorCampaignStateFixture(
  evidenceRecords,
  {
    campaignRunId = "00000000-0000-4000-8000-000000000001",
    accountDeviceBinding = validB5AccountDeviceBindingFixture({
      campaignId: campaignRunId
    })
  } = {}
) {
  const parsedBinding = parseB5AccountDeviceBinding(accountDeviceBinding);
  if (parsedBinding.campaignId !== campaignRunId) {
    fail(
      "ACCOUNT_DEVICE_CAMPAIGN_MISMATCH",
      "Fixture account/device binding belongs to another campaign"
    );
  }
  const accountDeviceCommitmentSha256 =
    createB5AccountDeviceCommitmentSha256(parsedBinding);
  const stateRecords = evidenceRecords.map((entry, index) => {
    const sequence = index + 1;
    const report = entry.report;
    const generatedAtMs = Date.parse(report.generatedAt);
    const sessionStartedAtMs = generatedAtMs - report.observed.durationMs;
    return {
      sequence,
      slot: canonicalSlot(sequence),
      evidenceRecordId:
        `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      runner: "B5_DIRECT_CONTROL_SMOKE_V1",
      reportSha256: entry.sourceReportSha256,
      generatedAt: report.generatedAt,
      captureStartedAt: new Date(sessionStartedAtMs - 250).toISOString(),
      captureCompletedAt: new Date(generatedAtMs + 250).toISOString(),
      sessionStartedAt: new Date(sessionStartedAtMs).toISOString(),
      durationMs: report.observed.durationMs,
      pingsSent: report.observed.pingsSent,
      pongsVerified: report.observed.pongsVerified,
      heartbeatMisses: report.observed.heartbeatMisses,
      targetSignatureSha256: sha256(JSON.stringify(report.target)),
      accountDeviceCommitmentSha256
    };
  });
  return {
    schemaVersion: 3,
    harnessVersion: B5_SESSION_COLLECTOR_VERSION,
    product: "V5BT",
    phase: "B5",
    mode: "PHYSICAL_HUNDRED_SESSION_COLLECTION",
    campaignRunId,
    createdAt: new Date(
      Date.parse(stateRecords[0].captureStartedAt) - 250
    ).toISOString(),
    updatedAt: stateRecords.at(-1).captureCompletedAt,
    requiredSessions: B5_REQUIRED_SESSION_REPORTS,
    lastCaptureBootId: 1,
    accountDeviceCommitmentSha256,
    collectionCommitmentSha256: collectionCommitment(stateRecords),
    records: stateRecords
  };
}

function validAndroidAttestationForFixture(campaignRunId) {
  return validB5AndroidContinuityAttestationFixture({
    campaignId: campaignRunId,
    monitoredFrom: "2026-07-21T00:00:00.000Z",
    requiredDurationMs: 6_101_000,
    pollIntervalMs: 5_000
  });
}

export function runSelfTest() {
  const records = Array.from(
    { length: B5_REQUIRED_SESSION_REPORTS },
    (_, index) => fixtureRecord(index + 1)
  );
  const campaignState = validCollectorCampaignStateFixture(records);
  const accountDeviceBinding = validB5AccountDeviceBindingFixture({
    campaignId: campaignState.campaignRunId
  });
  const aggregate = aggregateValidatedSessionReports(records, {
    generatedAt: "2026-07-22T00:00:00.000Z",
    campaignState,
    attemptState: validB5CampaignSupervisorLedgerFixture({
      campaignRunId: campaignState.campaignRunId
    }),
    androidAttestation: validAndroidAttestationForFixture(
      campaignState.campaignRunId
    ),
    accountDeviceBinding,
    raspberryAttestation: validB5RaspberryContinuityAttestationFixture({
      campaignId: campaignState.campaignRunId,
      monitoredFrom: "2026-07-21T00:00:00.000Z",
      requiredDurationMs: 6_101_000,
      pollIntervalMs: 5_000
    }),
    campaignAuthorization: validB5CampaignAuthorizationFixture({
      campaignId: campaignState.campaignRunId,
      certificationMatrixSha256: sha256Hex(
        fs.readFileSync(CERTIFICATION_MATRIX_PATH)
      )
    })
  });
  if (
    aggregate.verdict !== "TECHNICAL_PASS" ||
    aggregate.totals.sessionsClosedCleanly !== B5_REQUIRED_SESSION_REPORTS ||
    aggregate.gate.b5TechnicalGate !== "PASS" ||
    aggregate.gate.b5HundredSessionGate !== "PENDING_REVIEW"
  ) {
    fail("SELF_TEST_FAILED", "B5 hundred-session validator self-test failed");
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_HUNDRED_SESSION_HARNESS_VERSION,
    product: "V5BT",
    phase: "B5",
    mode: "SELF_TEST",
    verdict: "PASS",
    syntheticReportsValidated: B5_REQUIRED_SESSION_REPORTS,
    syntheticCollectorStateValidated: true,
    syntheticAttemptLedgerValidated: true,
    syntheticCampaignAuthorizationValidated: true,
    syntheticAndroidAttestationValidated: true,
    syntheticRaspberryAttestationValidated: true,
    physicalEvidenceConsumed: false,
    gate: Object.freeze({
      b5HundredSessionGate: "PENDING",
      b6: "PENDING"
    }),
    privacy: Object.freeze({
      identifiersIncluded: false,
      addressesIncluded: false,
      cryptographicMaterialIncluded: false,
      messageBodiesIncluded: false,
      localLocationsIncluded: false,
      sourceReportDetailsIncluded: false,
      campaignCommitmentsIncluded: false,
      privateRecordIdentifiersIncluded: false
    }),
    v5btProductionServiceChanges: false
  });
}

function parseArguments(argv) {
  const options = {
    manifest: null,
    campaignState: null,
    attemptState: null,
    androidBaseline: null,
    androidAttestation: null,
    raspberryAttestation: null,
    campaignAuthorization: null,
    technicalReceipt: null,
    output: null,
    selfTest: false,
    help: false,
    mode: "PHYSICAL_TECHNICAL_AGGREGATION"
  };
  const valueArguments = new Set([
    "--manifest",
    "--campaign-state",
    "--attempt-state",
    "--android-baseline",
    "--android-attestation",
    "--raspberry-attestation",
    "--campaign-authorization",
    "--technical-receipt",
    "--output"
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) fail("INVALID_ARGUMENT", "duplicate argument");
    seen.add(argument);
    if (argument === "--self-test") {
      options.selfTest = true;
      options.mode = "SELF_TEST";
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!valueArguments.has(argument)) {
      fail("INVALID_ARGUMENT", "unknown argument");
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `${argument} requires a value`);
    }
    index += 1;
    if (argument === "--manifest") options.manifest = path.resolve(value);
    if (argument === "--campaign-state") {
      options.campaignState = path.resolve(value);
    }
    if (argument === "--attempt-state") {
      options.attemptState = path.resolve(value);
    }
    if (argument === "--android-baseline") {
      options.androidBaseline = path.resolve(value);
    }
    if (argument === "--android-attestation") {
      options.androidAttestation = path.resolve(value);
    }
    if (argument === "--raspberry-attestation") {
      options.raspberryAttestation = path.resolve(value);
    }
    if (argument === "--campaign-authorization") {
      options.campaignAuthorization = path.resolve(value);
    }
    if (argument === "--technical-receipt") {
      options.technicalReceipt = path.resolve(value);
    }
    if (argument === "--output") options.output = path.resolve(value);
  }
  if (options.selfTest) {
    if (argv.some((value) => value !== "--self-test")) {
      fail("INVALID_ARGUMENT", "--self-test cannot be combined with other arguments");
    }
  } else if (!options.help) {
    if (
      options.manifest === null ||
      options.campaignState === null ||
      options.attemptState === null ||
      options.androidBaseline === null ||
      options.androidAttestation === null ||
      options.raspberryAttestation === null ||
      options.campaignAuthorization === null ||
      options.technicalReceipt === null ||
      options.output === null
    ) {
      fail(
        "INVALID_ARGUMENT",
        "--manifest, --campaign-state, --attempt-state, --android-baseline, --android-attestation, --raspberry-attestation, --campaign-authorization, --output and --technical-receipt are required"
      );
    }
    const locations = [
      options.manifest,
      options.campaignState,
      options.attemptState,
      options.androidBaseline,
      options.androidAttestation,
      options.raspberryAttestation,
      options.campaignAuthorization,
      options.technicalReceipt,
      options.output
    ];
    if (new Set(locations).size !== locations.length) {
      fail("INVALID_ARGUMENT", "B5 gate input and output files must be distinct");
    }
    if (
      path.dirname(options.output) !== path.dirname(options.technicalReceipt)
    ) {
      fail(
        "INVALID_ARGUMENT",
        "B5 technical aggregate and receipt must use the same private directory"
      );
    }
  }
  return Object.freeze(options);
}

function fsyncDirectory(descriptor) {
  fs.fsyncSync(descriptor);
}

function atomicWritePrivateFile(destination, content) {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  let directoryDescriptor;
  let temporaryDescriptor;
  let temporaryLocation;
  try {
    directoryDescriptor = fs.openSync(
      parent,
      fs.constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG
    );
    if (!fs.fstatSync(directoryDescriptor).isDirectory()) {
      fail("EVIDENCE_INVALID", "B5 output parent is not a regular directory");
    }
    const temporaryName = `.b5-output-${process.pid}-${crypto.randomUUID()}.tmp`;
    const directoryLocation =
      process.platform === "linux"
        ? `/proc/self/fd/${directoryDescriptor}`
        : parent;
    temporaryLocation = path.join(directoryLocation, temporaryName);
    const publishedLocation = path.join(
      directoryLocation,
      path.basename(destination)
    );
    temporaryDescriptor = fs.openSync(
      temporaryLocation,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        NO_FOLLOW_FLAG,
      0o600
    );
    fs.fchmodSync(temporaryDescriptor, 0o600);
    fs.writeFileSync(temporaryDescriptor, content, "utf8");
    fs.fsyncSync(temporaryDescriptor);
    fs.closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;

    fs.linkSync(temporaryLocation, publishedLocation);
    fsyncDirectory(directoryDescriptor);
    fs.unlinkSync(temporaryLocation);
    temporaryLocation = undefined;
    fsyncDirectory(directoryDescriptor);
  } finally {
    if (temporaryDescriptor !== undefined) fs.closeSync(temporaryDescriptor);
    if (temporaryLocation !== undefined) {
      fs.rmSync(temporaryLocation, { force: true });
      if (directoryDescriptor !== undefined) {
        fsyncDirectory(directoryDescriptor);
      }
    }
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
  }
}

function atomicWriteTechnicalPair(
  aggregateDestination,
  aggregateContent,
  receiptDestination,
  receiptContent
) {
  const parent = path.dirname(aggregateDestination);
  if (parent !== path.dirname(receiptDestination)) {
    fail("INVALID_ARGUMENT", "B5 technical outputs must share one directory");
  }
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  let directoryDescriptor;
  const temporaryLocations = [];
  const publishedLocations = [];
  try {
    directoryDescriptor = fs.openSync(
      parent,
      fs.constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG
    );
    if (!fs.fstatSync(directoryDescriptor).isDirectory()) {
      fail("EVIDENCE_INVALID", "B5 output parent is not a regular directory");
    }
    const directoryLocation =
      process.platform === "linux"
        ? `/proc/self/fd/${directoryDescriptor}`
        : parent;
    const destinations = [aggregateDestination, receiptDestination].map(
      (location) => path.join(directoryLocation, path.basename(location))
    );
    for (const destination of destinations.slice(0, 1)) {
      try {
        fs.lstatSync(destination);
        fail(
          "TECHNICAL_PUBLICATION_EXISTS",
          "B5 technical aggregate and receipt are immutable and cannot be overwritten"
        );
      } catch (error) {
        if (error instanceof B5HundredSessionGateError) throw error;
        if (error?.code !== "ENOENT") {
          fail("EVIDENCE_INVALID", "B5 technical output cannot be inspected safely");
        }
      }
    }
    const transactionId = `${process.pid}-${crypto.randomUUID()}`;
    const contents = [aggregateContent, receiptContent];
    for (let index = 0; index < contents.length; index += 1) {
      const temporary = path.join(
        directoryLocation,
        `.b5-technical-${transactionId}-${index}.tmp`
      );
      let descriptor;
      try {
        descriptor = fs.openSync(
          temporary,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            NO_FOLLOW_FLAG,
          0o600
        );
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, contents[index], "utf8");
        fs.fsyncSync(descriptor);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
      temporaryLocations.push(temporary);
    }
    for (let index = 0; index < destinations.length; index += 1) {
      try {
        fs.linkSync(temporaryLocations[index], destinations[index]);
      } catch (error) {
        if (error?.code === "EEXIST") {
          fail(
            "TECHNICAL_PUBLICATION_EXISTS",
            "B5 technical aggregate and receipt are immutable and cannot be overwritten"
          );
        }
        throw error;
      }
      publishedLocations.push(destinations[index]);
    }
    fsyncDirectory(directoryDescriptor);
    for (const temporary of temporaryLocations.splice(0)) {
      fs.unlinkSync(temporary);
    }
    fsyncDirectory(directoryDescriptor);
  } catch (error) {
    for (const published of publishedLocations.reverse()) {
      try {
        fs.unlinkSync(published);
      } catch {}
    }
    if (directoryDescriptor !== undefined) {
      try {
        fsyncDirectory(directoryDescriptor);
      } catch {}
    }
    throw error;
  } finally {
    for (const temporary of temporaryLocations) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {}
    }
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
  }
}

function writeReport(report, output = null) {
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (output !== null) {
    atomicWritePrivateFile(output, encoded);
  }
  process.stdout.write(encoded);
}

function usage() {
  return [
    "V5BT B5 hundred-session physical evidence gate",
    "",
    "Usage:",
    "  node scripts/run-b5-hundred-session-gate.mjs --self-test",
    "  node scripts/run-b5-hundred-session-gate.mjs \\",
    "    --manifest b5-hundred-session-manifest.json \\",
    "    --campaign-state b5-hundred-session-state.json \\",
    "    --attempt-state b5-campaign-attempts.json \\",
    "    --android-baseline b5-android-baseline.json \\",
    "    --android-attestation b5-android-continuity.json \\",
    "    --raspberry-attestation b5-raspberry-continuity.json \\",
    "    --campaign-authorization b5-campaign-authorization.json \\",
    "    --output b5-hundred-session-gate.json \\",
    "    --technical-receipt b5-technical-receipt.json",
    "",
    "TECHNICAL_PASS requires exactly 100 unique, ordered and non-overlapping B5.7 PHYSICAL reports.",
    "B5 remains PENDING_REVIEW until the independent promotion gate passes.",
    "The aggregate never includes source report paths, per-session details or identifiers."
  ].join("\n");
}

function failureReport(options, error) {
  return {
    schemaVersion: 1,
    harnessVersion: B5_HUNDRED_SESSION_HARNESS_VERSION,
    product: "V5BT",
    phase: "B5",
    generatedAt: new Date().toISOString(),
    mode: options?.mode ?? "UNKNOWN",
    verdict: "FAIL",
    failure: {
      code: error.code,
      message: error.message
    },
    gate: {
      b5HundredSessionGate: "PENDING",
      b6: "PENDING"
    },
    privacy: {
      identifiersIncluded: false,
      addressesIncluded: false,
      cryptographicMaterialIncluded: false,
      messageBodiesIncluded: false,
      localLocationsIncluded: false,
      sourceReportDetailsIncluded: false,
      campaignCommitmentsIncluded: false,
      privateRecordIdentifiersIncluded: false
    },
    physicalEvidenceConsumed: false,
    v5btProductionServiceChanges: false
  };
}

function safeUnexpectedError(error) {
  if (error instanceof B5HundredSessionGateError) return error;
  return new B5HundredSessionGateError(
    "B5_HUNDRED_SESSION_GATE_FAILED",
    "B5 hundred-session evidence aggregation failed",
    { cause: error }
  );
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.selfTest) {
      const report = runSelfTest();
      assertAggregateReportRedacted(report);
      writeReport(report);
      return 0;
    }

    const manifestRoot = openManifestRoot(options.manifest);
    let resolvedReports;
    let records;
    let campaignState;
    let attemptState;
    let accountDeviceBinding;
    let androidAttestation;
    let raspberryAttestation;
    let campaignAuthorization;
    let campaignStateBytes;
    let attemptStateBytes;
    let androidAttestationBytes;
    let raspberryAttestationBytes;
    let campaignAuthorizationBytes;
    try {
      const manifestBytes = readRegularFile(
        options.manifest,
        MAX_MANIFEST_BYTES,
        "B5 evidence manifest",
        manifestRoot
      );
      const manifest = parseEvidenceManifest(manifestBytes.toString("utf8"));
      resolvedReports = manifest.reports.map((entry) => ({
        sequence: entry.sequence,
        location: resolveEvidencePath(options.manifest, entry.report)
      }));
      if (
        resolvedReports.some((entry) =>
          [
            options.manifest,
            options.campaignState,
            options.attemptState,
            options.androidBaseline,
            options.androidAttestation,
            options.raspberryAttestation,
            options.campaignAuthorization,
            options.technicalReceipt,
            options.output
          ].includes(entry.location)
        )
      ) {
        fail("INVALID_ARGUMENT", "B5 gate files must not reuse source evidence");
      }
      records = resolvedReports.map((entry) => {
        const bytes = readRegularFile(
          entry.location,
          MAX_REPORT_BYTES,
          `B5.7 report ${entry.sequence}`,
          manifestRoot
        );
        return {
          sequence: entry.sequence,
          sourceReportSha256: sha256(bytes),
          report: parseJsonObject(
            bytes.toString("utf8"),
            "REPORT_SCHEMA_INVALID",
            `B5.7 report ${entry.sequence} is not valid JSON`
          )
        };
      });
      campaignStateBytes = readRegularFile(
        options.campaignState,
        MAX_CAMPAIGN_STATE_BYTES,
        "B5 collector campaign state",
        manifestRoot,
        { privateFile: true }
      );
      campaignState = parseJsonObject(
        campaignStateBytes.toString("utf8"),
        "CAMPAIGN_STATE_INVALID",
        "collector campaign state is not valid JSON"
      );
      attemptStateBytes = readRegularFile(
          options.attemptState,
          MAX_ATTEMPT_STATE_BYTES,
          "B5 campaign attempt ledger",
          manifestRoot,
          { privateFile: true }
        );
      attemptState = parseJsonObject(
        attemptStateBytes.toString("utf8"),
        "ATTEMPT_STATE_INVALID",
        "B5 campaign attempt ledger is not valid JSON"
      );
      let privateBaseline;
      try {
        privateBaseline = parsePrivateBaseline(
          readRegularFile(
            options.androidBaseline,
            MAX_ANDROID_ATTESTATION_BYTES,
            "B5 private Android baseline",
            manifestRoot,
            { privateFile: true }
          ).toString("utf8")
        );
        accountDeviceBinding =
          b5AccountDeviceBindingFromPrivateBaseline(
            privateBaseline.baseline
          );
      } catch (error) {
        if (error instanceof B5HundredSessionGateError) throw error;
        if (error instanceof B5AccountDeviceCommitmentError) {
          fail(error.code, error.message);
        }
        fail(
          "ACCOUNT_DEVICE_BASELINE_INVALID",
          "B5 private Android baseline is invalid"
        );
      } finally {
        privateBaseline?.sessionKey?.fill(0);
      }
      androidAttestationBytes = readRegularFile(
        options.androidAttestation,
        MAX_ANDROID_ATTESTATION_BYTES,
        "B5 Android continuity attestation",
        manifestRoot,
        { privateFile: true }
      );
      androidAttestation = parseJsonObject(
        androidAttestationBytes.toString("utf8"),
        "ANDROID_ATTESTATION_INVALID",
        "Android continuity attestation is not valid JSON"
      );
      raspberryAttestationBytes = readRegularFile(
        options.raspberryAttestation,
        MAX_RASPBERRY_ATTESTATION_BYTES,
        "B5 Raspberry continuity attestation",
        manifestRoot,
        { privateFile: true }
      );
      raspberryAttestation = parseJsonObject(
        raspberryAttestationBytes.toString("utf8"),
        "RASPBERRY_ATTESTATION_INVALID",
        "Raspberry continuity attestation is not valid JSON"
      );
      campaignAuthorizationBytes = readRegularFile(
        options.campaignAuthorization,
        MAX_CAMPAIGN_AUTHORIZATION_BYTES,
        "B5 campaign authorization",
        manifestRoot,
        { privateFile: true }
      );
      campaignAuthorization = parseJsonObject(
        campaignAuthorizationBytes.toString("utf8"),
        "CAMPAIGN_AUTHORIZATION_INVALID",
        "B5 campaign authorization is not valid JSON"
      );
    } finally {
      fs.closeSync(manifestRoot.descriptor);
    }
    const sensitiveValues = [
      options.manifest,
      options.campaignState,
      options.attemptState,
      options.androidBaseline,
      options.androidAttestation,
      options.raspberryAttestation,
      options.campaignAuthorization,
      options.technicalReceipt,
      options.output,
      ...resolvedReports.map((entry) => entry.location)
    ];
    const report = aggregateValidatedSessionReports(records, {
      sensitiveValues,
      campaignState,
      attemptState,
      attemptStateBytes,
      accountDeviceBinding,
      androidAttestation,
      androidAttestationBytes,
      raspberryAttestation,
      raspberryAttestationBytes,
      campaignAuthorization
    });
    const aggregateContent = `${JSON.stringify(report, null, 2)}\n`;
    const matrixBytes = fs.readFileSync(CERTIFICATION_MATRIX_PATH);
    const parsedCampaignState = parseCollectorCampaignState(campaignState);
    const parsedAttemptLedger = parseB5CampaignSupervisorLedger(attemptState);
    const parsedAuthorization = parseB5CampaignAuthorization(
      campaignAuthorization,
      {
        campaignId: parsedCampaignState.campaignRunId,
        certificationMatrixSha256: sha256Hex(matrixBytes)
      }
    );
    const receipt = createB5TechnicalReceipt({
      issuedAt: report.generatedAt,
      technicalAggregateBytes: Buffer.from(aggregateContent),
      collectorStateBytes: campaignStateBytes,
      campaignAuthorizationBytes,
      certificationMatrixBytes: matrixBytes,
      campaignIdCommitmentSha256:
        parsedCampaignState.campaignIdCommitmentSha256,
      collectionCommitmentSha256:
        parsedCampaignState.collectionCommitmentSha256,
      accountDeviceCommitmentSha256:
        parsedCampaignState.accountDeviceCommitmentSha256,
      attemptLedgerHeadSha256: parsedAttemptLedger.headSha256,
      prerequisiteEvidenceBundleSha256:
        parsedAuthorization.prerequisiteEvidenceBundleSha256,
      operatorCommitmentSha256: parsedAuthorization.operatorCommitmentSha256,
      androidAttestationBytes,
      raspberryAttestationBytes,
      technicalGeneratedAtMs: Date.parse(report.generatedAt)
    });
    const receiptContent = `${JSON.stringify(receipt, null, 2)}\n`;
    atomicWriteTechnicalPair(
      options.output,
      aggregateContent,
      options.technicalReceipt,
      receiptContent
    );
    process.stdout.write(aggregateContent);
    return 0;
  } catch (error) {
    const safeError = safeUnexpectedError(error);
    const report = failureReport(options, safeError);
    assertAggregateReportRedacted(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 1;
  }
}

const invokedPath =
  process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (
  invokedPath !== null &&
  fs.existsSync(invokedPath) &&
  fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(invokedPath)
) {
  process.exitCode = await main();
}
