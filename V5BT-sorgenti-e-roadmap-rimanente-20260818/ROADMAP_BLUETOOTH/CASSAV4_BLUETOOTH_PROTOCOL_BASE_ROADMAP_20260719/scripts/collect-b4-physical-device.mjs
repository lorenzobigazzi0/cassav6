#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AdbClient,
  DISCOVERY_STATUS_FILE,
  isValidAdbSerial,
  parseAdbDevices,
  parseDiscoveryStatus,
  runPreflight
} from "./run-b2-android-adb-harness.mjs";
import {
  B4_REQUIRED_PHYSICAL_NODES,
  evaluateNodeLog
} from "../raspberry/scripts/run-b4-raspberry-servicedata-gate.mjs";
import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING,
  buildAdvancedCertificationTargetsBinding,
  loadAdvancedCertificationTargets
} from "./advanced-certification-targets.mjs";
import {
  B4MonitoredSlotGateError,
  buildB4TargetHardwareCommitment,
  buildB4TargetHardwareCommitmentFromDeviceDigest,
  loadB4MonitorAttestationParsers,
  validateB4MonitoredSlotAuthorization
} from "./run-b4-monitored-slot-gate.mjs";

export const B4_COLLECTION_HARNESS_VERSION = "1.0.0";
export const MAX_RASPBERRY_EVIDENCE_AGE_MS = 5 * 60 * 1_000;
export const MAX_ANDROID_EVIDENCE_AGE_MS = 5 * 60 * 1_000;
export const MAX_ANDROID_RASPBERRY_SKEW_MS = 3 * 60 * 1_000;

const MAX_CLOCK_FUTURE_SKEW_MS = 30_000;
const MAX_STATE_BYTES = 256 * 1_024;
const MAX_REPORT_BYTES = 256 * 1_024;
const MAX_LOG_BYTES = 8 * 1_024 * 1_024;
const STATE_MODE = "PHYSICAL_TEN_DEVICE_SEQUENCE";
const STATE_SCHEMA_VERSION = 2;
const COLLECTOR_REPORT_FILE = "collector-final.json";
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STABLE_SERIAL_PATTERN = /^[A-Za-z0-9._:-]{4,128}$/;
const MODEL_PATTERN = /^[\x20-\x7e]{1,128}$/;
const PACKAGE_NODE_KIND = new Map(
  Object.entries(ADVANCED_CERTIFICATION_TARGETS.roles).map(
    ([role, target]) => [target.packageId, role]
  )
);
const IMPORTED_CERTIFICATION_MATRIX_BINDING = JSON.stringify(
  ADVANCED_CERTIFICATION_TARGETS_BINDING
);

export class B4PhysicalCollectionError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "B4PhysicalCollectionError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1) {
  throw new B4PhysicalCollectionError(code, message, exitCode);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactFields(value, expected, code) {
  if (!isRecord(value)) fail(code, "Expected a JSON object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index])
  ) {
    fail(code, "JSON object fields do not match the gate contract");
  }
}

function requireInteger(value, minimum, code) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(code, "Expected a bounded nonnegative integer");
  }
  return value;
}

function requireFiniteNumber(value, minimum, maximum, code) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(code, "Expected a bounded finite number");
  }
  return value;
}

function requireIsoTimestamp(value, code) {
  if (typeof value !== "string") fail(code, "Timestamp is not text");
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
    fail(code, "Timestamp is not canonical ISO-8601");
  }
  return epochMs;
}

function requireSha256(value, code) {
  if (typeof value !== "string" || !HEX_SHA256_PATTERN.test(value)) {
    fail(code, "SHA-256 value is invalid");
  }
  return value;
}

function requireUuid(value, code) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(code, "UUID value is invalid");
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function normalizeCertificationMatrixBinding(value, code) {
  requireExactFields(
    value,
    [
      "schemaVersion",
      "canonicalization",
      "digestAlgorithm",
      "matrixSha256",
      "matrix"
    ],
    code
  );
  let rebuilt;
  try {
    rebuilt = buildAdvancedCertificationTargetsBinding(value.matrix);
  } catch {
    fail(code, "Certification matrix binding is invalid");
  }
  if (
    value.schemaVersion !== rebuilt.schemaVersion ||
    value.canonicalization !== rebuilt.canonicalization ||
    value.digestAlgorithm !== rebuilt.digestAlgorithm ||
    value.matrixSha256 !== rebuilt.matrixSha256
  ) {
    fail(code, "Certification matrix binding is not canonical");
  }
  return rebuilt;
}

export function readCurrentCertificationMatrixBinding() {
  let current;
  try {
    current = buildAdvancedCertificationTargetsBinding(
      loadAdvancedCertificationTargets()
    );
  } catch (error) {
    if (error instanceof B4PhysicalCollectionError) throw error;
    fail(
      "CERTIFICATION_MATRIX_UNAVAILABLE",
      "The canonical certification matrix cannot be read safely"
    );
  }
  if (canonicalJson(current) !== IMPORTED_CERTIFICATION_MATRIX_BINDING) {
    fail(
      "CERTIFICATION_MATRIX_CHANGED_DURING_PROCESS",
      "The certification matrix changed after collector startup"
    );
  }
  return current;
}

export function assertStateCertificationMatrixBinding(
  state,
  currentBinding = readCurrentCertificationMatrixBinding()
) {
  if (!isRecord(state)) fail("STATE_INVALID", "Expected a JSON object");
  const frozen = normalizeCertificationMatrixBinding(
    state.certificationMatrixBinding,
    "STATE_CERTIFICATION_MATRIX_INVALID"
  );
  const current = normalizeCertificationMatrixBinding(
    currentBinding,
    "CERTIFICATION_MATRIX_UNAVAILABLE"
  );
  if (canonicalJson(frozen) !== canonicalJson(current)) {
    fail(
      "CERTIFICATION_MATRIX_BINDING_MISMATCH",
      "The private B4 state is bound to a different certification matrix"
    );
  }
  return frozen;
}

export async function withStableCertificationMatrix(
  state,
  action,
  { readBinding = readCurrentCertificationMatrixBinding } = {}
) {
  if (typeof action !== "function" || typeof readBinding !== "function") {
    fail("CERTIFICATION_MATRIX_CHECK_INVALID", "Matrix check is invalid");
  }
  const before = readBinding();
  assertStateCertificationMatrixBinding(state, before);
  let result;
  let actionError = null;
  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }
  let after;
  try {
    after = readBinding();
  } catch {
    fail(
      "CERTIFICATION_MATRIX_CHANGED_DURING_COLLECTION",
      "The certification matrix changed during the B4 operation"
    );
  }
  const normalizedBefore = normalizeCertificationMatrixBinding(
    before,
    "CERTIFICATION_MATRIX_UNAVAILABLE"
  );
  const normalizedAfter = normalizeCertificationMatrixBinding(
    after,
    "CERTIFICATION_MATRIX_UNAVAILABLE"
  );
  if (canonicalJson(normalizedBefore) !== canonicalJson(normalizedAfter)) {
    fail(
      "CERTIFICATION_MATRIX_CHANGED_DURING_COLLECTION",
      "The certification matrix changed during the B4 operation"
    );
  }
  assertStateCertificationMatrixBinding(state, normalizedAfter);
  if (actionError !== null) throw actionError;
  return result;
}

function readBoundedFile(
  filePath,
  maximumBytes,
  code,
  encoding = null,
  { privateFile = false } = {}
) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | noFollow
    );
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maximumBytes
    ) {
      fail(code, "Evidence file size or type is invalid");
    }
    if (
      privateFile &&
      (
        before.nlink !== 1 ||
        (
          process.platform !== "win32" &&
          (before.mode & 0o777) !== 0o600
        ) ||
        (
          process.platform !== "win32" &&
          typeof process.getuid === "function" &&
          before.uid !== process.getuid()
        )
      )
    ) {
      fail(code, "Private evidence must be owner-only and uniquely linked");
    }
    const content = fs.readFileSync(
      descriptor,
      encoding === null ? undefined : encoding
    );
    const after = fs.fstatSync(descriptor);
    const contentBytes = Buffer.isBuffer(content)
      ? content.byteLength
      : Buffer.byteLength(content, "utf8");
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      contentBytes !== before.size
    ) {
      fail(code, "Evidence file changed while it was read");
    }
    return content;
  } catch (error) {
    if (error instanceof B4PhysicalCollectionError) throw error;
    fail(code, "Evidence file cannot be read safely");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseJson(value, code) {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) fail(code, "JSON root must be an object");
    return parsed;
  } catch (error) {
    if (error instanceof B4PhysicalCollectionError) throw error;
    fail(code, "JSON is malformed");
  }
}

function decodeIdentityKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    fail("STATE_INVALID", "Identity key encoding is invalid");
  }
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== value) {
    key.fill(0);
    fail("STATE_INVALID", "Identity key is not canonical");
  }
  return key;
}

function validateRecord(
  record,
  ordinal,
  {
    collectionRunId,
    certificationMatrixSha256,
    identityKeyBase64Url
  }
) {
  requireExactFields(
    record,
    [
      "ordinal",
      "evidenceRecordId",
      "deviceDigest",
      "nodeKind",
      "packageName",
      "model",
      "androidApi",
      "recordedAt",
      "androidSampledAt",
      "raspberryGeneratedAt",
      "raspberryReportSha256",
      "raspberryLogSha256",
      "monitorEvidence",
      "observationsAccepted",
      "lifecycleDurationMs",
      "wallClockDurationMs",
      "rssiDbm"
    ],
    "STATE_INVALID"
  );
  if (record.ordinal !== ordinal) {
    fail("STATE_INVALID", "Record ordinals are not contiguous");
  }
  requireUuid(record.evidenceRecordId, "STATE_INVALID");
  requireSha256(record.deviceDigest, "STATE_INVALID");
  if (PACKAGE_NODE_KIND.get(record.packageName) !== record.nodeKind) {
    fail("STATE_INVALID", "Package and node kind do not match");
  }
  if (!MODEL_PATTERN.test(record.model)) {
    fail("STATE_INVALID", "Device model is invalid");
  }
  requireInteger(record.androidApi, 33, "STATE_INVALID");
  const recordedAtMs = requireIsoTimestamp(
    record.recordedAt,
    "STATE_INVALID"
  );
  const androidSampledAtMs = requireIsoTimestamp(
    record.androidSampledAt,
    "STATE_INVALID"
  );
  const raspberryGeneratedAtMs = requireIsoTimestamp(
    record.raspberryGeneratedAt,
    "STATE_INVALID"
  );
  requireSha256(record.raspberryReportSha256, "STATE_INVALID");
  requireSha256(record.raspberryLogSha256, "STATE_INVALID");
  validateMonitorEvidence(record.monitorEvidence, "STATE_INVALID");
  const expectedCollectionRunCommitment = sha256(
    Buffer.from(`V5BT:B4:COLLECTION_RUN:${collectionRunId}`, "utf8")
  );
  if (
    record.monitorEvidence.collectionRunCommitmentSha256 !==
      expectedCollectionRunCommitment ||
    record.monitorEvidence.certificationMatrixSha256 !==
      certificationMatrixSha256 ||
    record.monitorEvidence.targetPackageName !== record.packageName ||
    record.monitorEvidence.targetAndroidApi !== record.androidApi
  ) {
    fail("STATE_INVALID", "Monitor evidence binding does not match its record");
  }
  const identityKey = decodeIdentityKey(identityKeyBase64Url);
  try {
    const expectedTargetHardwareCommitment =
      buildB4TargetHardwareCommitmentFromDeviceDigest({
        identityKey,
        deviceDigest: record.deviceDigest,
        captureRunId: record.monitorEvidence.captureRunId
      });
    if (
      record.monitorEvidence.targetHardwareCommitmentSha256 !==
      expectedTargetHardwareCommitment
    ) {
      fail(
        "STATE_INVALID",
        "Monitor hardware commitment does not match its physical device"
      );
    }
  } catch (error) {
    if (error instanceof B4PhysicalCollectionError) throw error;
    fail("STATE_INVALID", "Monitor hardware commitment is invalid");
  } finally {
    identityKey.fill(0);
  }
  requireInteger(record.observationsAccepted, 1, "STATE_INVALID");
  requireFiniteNumber(
    record.lifecycleDurationMs,
    75_000,
    Number.MAX_SAFE_INTEGER,
    "STATE_INVALID"
  );
  requireInteger(record.wallClockDurationMs, 90_000, "STATE_INVALID");
  const coverageStartedAtMs = Date.parse(
    record.monitorEvidence.coverageStartedAt
  );
  const coverageCompletedAtMs = Date.parse(
    record.monitorEvidence.coverageCompletedAt
  );
  const runnerStartedAtMs =
    raspberryGeneratedAtMs - record.wallClockDurationMs;
  if (
    coverageStartedAtMs > runnerStartedAtMs ||
    coverageCompletedAtMs < raspberryGeneratedAtMs ||
    recordedAtMs < coverageCompletedAtMs ||
    recordedAtMs < raspberryGeneratedAtMs ||
    recordedAtMs < androidSampledAtMs
  ) {
    fail("STATE_INVALID", "Monitored-slot record timeline is inconsistent");
  }
  requireExactFields(
    record.rssiDbm,
    ["minimum", "maximum", "samples"],
    "STATE_INVALID"
  );
  const minimum = requireFiniteNumber(
    record.rssiDbm.minimum,
    -127,
    20,
    "STATE_INVALID"
  );
  const maximum = requireFiniteNumber(
    record.rssiDbm.maximum,
    -127,
    20,
    "STATE_INVALID"
  );
  requireInteger(record.rssiDbm.samples, 1, "STATE_INVALID");
  if (minimum > maximum) fail("STATE_INVALID", "RSSI range is inverted");
  return record;
}

function validateMonitorEvidence(value, code) {
  requireExactFields(
    value,
    [
      "collectionRunCommitmentSha256",
      "captureRunCommitmentSha256",
      "captureRunId",
      "certificationMatrixSha256",
      "androidAttestationSha256",
      "raspberryAttestationSha256",
      "targetPackageName",
      "targetAndroidApi",
      "targetHardwareCommitmentSha256",
      "coverageStartedAt",
      "coverageCompletedAt"
    ],
    code
  );
  for (const field of [
    "collectionRunCommitmentSha256",
    "captureRunCommitmentSha256",
    "certificationMatrixSha256",
    "androidAttestationSha256",
    "raspberryAttestationSha256",
    "targetHardwareCommitmentSha256"
  ]) {
    requireSha256(value[field], code);
    if (/^0{64}$/u.test(value[field])) {
      fail(code, "Monitor evidence commitment must be nonzero");
    }
  }
  requireUuid(value.captureRunId, code);
  const expectedCaptureRunCommitment = sha256(
    Buffer.from(`V5BT:B4:CAPTURE_RUN:${value.captureRunId}`, "utf8")
  );
  if (
    value.captureRunCommitmentSha256 !== expectedCaptureRunCommitment
  ) {
    fail(code, "Monitor evidence capture run commitment is invalid");
  }
  if (!PACKAGE_NODE_KIND.has(value.targetPackageName)) {
    fail(code, "Monitor evidence target package is invalid");
  }
  requireInteger(value.targetAndroidApi, 33, code);
  const startedAtMs = requireIsoTimestamp(value.coverageStartedAt, code);
  const completedAtMs = requireIsoTimestamp(value.coverageCompletedAt, code);
  if (completedAtMs < startedAtMs) {
    fail(code, "Monitor evidence coverage is inverted");
  }
  return value;
}

export function parseState(value) {
  const state = typeof value === "string"
    ? parseJson(value, "STATE_INVALID")
    : value;
  if (isRecord(state) && state.schemaVersion === 1) {
    fail(
      "STATE_LEGACY_REJECTED",
      "Legacy B4 state cannot be upgraded or resumed"
    );
  }
  requireExactFields(
    state,
    [
      "schemaVersion",
      "harnessVersion",
      "product",
      "phase",
      "mode",
      "runId",
      "createdAt",
      "updatedAt",
      "identityKeyBase64Url",
      "certificationMatrixBinding",
      "requiredDistinctPhysicalDevices",
      "records"
    ],
    "STATE_INVALID"
  );
  if (
    state.schemaVersion !== STATE_SCHEMA_VERSION ||
    state.harnessVersion !== B4_COLLECTION_HARNESS_VERSION ||
    state.product !== "V5BT" ||
    state.phase !== "B4" ||
    state.mode !== STATE_MODE ||
    state.requiredDistinctPhysicalDevices !== B4_REQUIRED_PHYSICAL_NODES
  ) {
    fail("STATE_INVALID", "State header does not match the B4 gate");
  }
  assertStateCertificationMatrixBinding(state);
  requireUuid(state.runId, "STATE_INVALID");
  const createdAtMs = requireIsoTimestamp(state.createdAt, "STATE_INVALID");
  const updatedAtMs = requireIsoTimestamp(state.updatedAt, "STATE_INVALID");
  if (updatedAtMs < createdAtMs) {
    fail("STATE_INVALID", "State timestamp moved backwards");
  }
  const identityKey = decodeIdentityKey(state.identityKeyBase64Url);
  identityKey.fill(0);
  if (
    !Array.isArray(state.records) ||
    state.records.length > B4_REQUIRED_PHYSICAL_NODES
  ) {
    fail("STATE_INVALID", "Record collection exceeds the B4 gate");
  }
  const digests = new Set();
  const recordIds = new Set();
  const reportHashes = new Set();
  const logHashes = new Set();
  const captureRunCommitments = new Set();
  const androidAttestationHashes = new Set();
  const raspberryAttestationHashes = new Set();
  let previousRecordedAtMs = createdAtMs;
  state.records.forEach((record, index) => {
    validateRecord(record, index + 1, {
      collectionRunId: state.runId,
      certificationMatrixSha256:
        state.certificationMatrixBinding.matrixSha256,
      identityKeyBase64Url: state.identityKeyBase64Url
    });
    const recordedAtMs = Date.parse(record.recordedAt);
    if (recordedAtMs < previousRecordedAtMs) {
      fail("STATE_INVALID", "Record timestamps moved backwards");
    }
    previousRecordedAtMs = recordedAtMs;
    if (digests.has(record.deviceDigest)) {
      fail("STATE_INVALID", "State contains a duplicate physical device");
    }
    if (recordIds.has(record.evidenceRecordId)) {
      fail("STATE_INVALID", "State contains a duplicate evidence ID");
    }
    if (reportHashes.has(record.raspberryReportSha256)) {
      fail("STATE_INVALID", "State reuses a Raspberry report");
    }
    if (logHashes.has(record.raspberryLogSha256)) {
      fail("STATE_INVALID", "State reuses a Raspberry log");
    }
    if (
      captureRunCommitments.has(
        record.monitorEvidence.captureRunCommitmentSha256
      ) ||
      androidAttestationHashes.has(
        record.monitorEvidence.androidAttestationSha256
      ) ||
      raspberryAttestationHashes.has(
        record.monitorEvidence.raspberryAttestationSha256
      )
    ) {
      fail("STATE_INVALID", "State reuses monitored-slot evidence");
    }
    digests.add(record.deviceDigest);
    recordIds.add(record.evidenceRecordId);
    reportHashes.add(record.raspberryReportSha256);
    logHashes.add(record.raspberryLogSha256);
    captureRunCommitments.add(
      record.monitorEvidence.captureRunCommitmentSha256
    );
    androidAttestationHashes.add(
      record.monitorEvidence.androidAttestationSha256
    );
    raspberryAttestationHashes.add(
      record.monitorEvidence.raspberryAttestationSha256
    );
  });
  if (updatedAtMs !== previousRecordedAtMs) {
    fail("STATE_INVALID", "State timestamp is not bound to its last record");
  }
  return state;
}

export function createInitialState({
  now = new Date().toISOString(),
  runId = crypto.randomUUID(),
  identityKey = crypto.randomBytes(32)
} = {}) {
  if (!Buffer.isBuffer(identityKey) || identityKey.byteLength !== 32) {
    fail("STATE_INIT_INVALID", "Identity HMAC key must contain 32 bytes");
  }
  requireIsoTimestamp(now, "STATE_INIT_INVALID");
  requireUuid(runId, "STATE_INIT_INVALID");
  const certificationMatrixBinding = readCurrentCertificationMatrixBinding();
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    harnessVersion: B4_COLLECTION_HARNESS_VERSION,
    product: "V5BT",
    phase: "B4",
    mode: STATE_MODE,
    runId,
    createdAt: now,
    updatedAt: now,
    identityKeyBase64Url: identityKey.toString("base64url"),
    certificationMatrixBinding: JSON.parse(
      canonicalJson(certificationMatrixBinding)
    ),
    requiredDistinctPhysicalDevices: B4_REQUIRED_PHYSICAL_NODES,
    records: []
  };
  return parseState(state);
}

export function deriveDeviceDigest(identityKey, stableHardwareSerial) {
  if (!Buffer.isBuffer(identityKey) || identityKey.byteLength !== 32) {
    fail("IDENTITY_KEY_INVALID", "Identity HMAC key must contain 32 bytes");
  }
  if (
    typeof stableHardwareSerial !== "string" ||
    !STABLE_SERIAL_PATTERN.test(stableHardwareSerial)
  ) {
    fail("HARDWARE_IDENTITY_INVALID", "Stable hardware identity is invalid");
  }
  return crypto
    .createHmac("sha256", identityKey)
    .update("V5BT:B4:PHYSICAL-DEVICE:", "utf8")
    .update(stableHardwareSerial, "utf8")
    .digest("hex");
}

function validateFreshTimestamp(epochMs, nowMs, maximumAgeMs, code) {
  if (epochMs > nowMs + MAX_CLOCK_FUTURE_SKEW_MS) {
    fail(code, "Evidence timestamp is in the future");
  }
  if (nowMs - epochMs > maximumAgeMs) {
    fail(code, "Evidence is stale");
  }
}

export function validateRaspberryEvidence(
  report,
  rawLog,
  expectedNodeKind,
  {
    nowMs = Date.now(),
    maximumAgeMs = MAX_RASPBERRY_EVIDENCE_AGE_MS,
    rawReportText = null
  } = {}
) {
  if (expectedNodeKind !== "handheld" && expectedNodeKind !== "station") {
    fail("NODE_KIND_INVALID", "Expected Android node kind is invalid");
  }
  if (
    typeof rawLog !== "string" ||
    Buffer.byteLength(rawLog, "utf8") < 1 ||
    Buffer.byteLength(rawLog, "utf8") > MAX_LOG_BYTES
  ) {
    fail("RASPBERRY_LOG_INVALID", "Raspberry source log is invalid");
  }
  if (!isRecord(report)) {
    fail("RASPBERRY_REPORT_INVALID", "Raspberry report is invalid");
  }
  if (rawReportText !== null) {
    if (
      typeof rawReportText !== "string" ||
      Buffer.byteLength(rawReportText, "utf8") < 1 ||
      Buffer.byteLength(rawReportText, "utf8") > MAX_REPORT_BYTES ||
      canonicalJson(parseJson(rawReportText, "RASPBERRY_REPORT_INVALID")) !==
        canonicalJson(report)
    ) {
      fail("RASPBERRY_REPORT_INVALID", "Raspberry report bytes are invalid");
    }
  }
  const reportHash = sha256(
    Buffer.from(
      rawReportText ?? `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    )
  );
  const logHash = sha256(Buffer.from(rawLog, "utf8"));
  if (report.sourceLogSha256 !== logHash) {
    fail("RASPBERRY_LOG_HASH_MISMATCH", "Raspberry log hash does not match");
  }
  const generatedAtMs = requireIsoTimestamp(
    report.generatedAt,
    "RASPBERRY_REPORT_INVALID"
  );
  validateFreshTimestamp(
    generatedAtMs,
    nowMs,
    maximumAgeMs,
    "RASPBERRY_EVIDENCE_STALE"
  );
  if (
    report.schemaVersion !== 1 ||
    report.product !== "V5BT" ||
    report.phase !== "B4.3" ||
    report.mode !== "PHYSICAL_SINGLE_ADVERTISER" ||
    report.verdict !== "PASS"
  ) {
    fail("RASPBERRY_REPORT_INVALID", "Raspberry report header is invalid");
  }
  if (
    report.measurement?.requiredDurationSeconds !== 90 ||
    !Number.isSafeInteger(report.measurement?.wallClockDurationMs) ||
    report.measurement.wallClockDurationMs < 90_000
  ) {
    fail("RASPBERRY_REPORT_INVALID", "Raspberry wall-clock gate is invalid");
  }
  if (
    report.gate?.serviceDataLive !== "PASS" ||
    report.gate?.controlledPhysicalAdvertisers !== 1 ||
    report.gate?.requiredDistinctPhysicalNodes !==
      B4_REQUIRED_PHYSICAL_NODES ||
    report.gate?.b4TenNodeGate !== "PENDING"
  ) {
    fail("RASPBERRY_REPORT_INVALID", "Incremental B4 gate semantics changed");
  }
  if (
    report.privacy?.bluetoothAddressesIncluded !== false ||
    report.privacy?.rotatingAliasesIncluded !== false ||
    report.privacy?.stableNodeIdsIncluded !== false ||
    report.privacy?.rawPayloadsIncluded !== false
  ) {
    fail("RASPBERRY_REPORT_INVALID", "Raspberry report is not redacted");
  }
  if (
    !Array.isArray(report.serviceData?.nodeKinds) ||
    report.serviceData.nodeKinds.length !== 1 ||
    report.serviceData.nodeKinds[0] !== expectedNodeKind
  ) {
    fail(
      "RASPBERRY_NODE_KIND_MISMATCH",
      "Observed node kind does not match the selected Android package"
    );
  }
  const { measurement, ...reportedCore } = report;
  const independentlyEvaluated = evaluateNodeLog(rawLog, {
    generatedAt: report.generatedAt,
    sourceLogSha256: logHash
  });
  if (canonicalJson(reportedCore) !== canonicalJson(independentlyEvaluated)) {
    fail(
      "RASPBERRY_REPORT_LOG_DIVERGENCE",
      "Raspberry report does not reproduce from its source log"
    );
  }
  return Object.freeze({
    reportHash,
    logHash,
    generatedAt: report.generatedAt,
    generatedAtMs,
    observationsAccepted: report.serviceData.observationsAccepted,
    lifecycleDurationMs: report.lifecycle.durationMs,
    wallClockDurationMs: measurement.wallClockDurationMs,
    rssiDbm: {
      minimum: report.serviceData.rssiDbm.minimum,
      maximum: report.serviceData.rssiDbm.maximum,
      samples: report.serviceData.rssiDbm.samples
    }
  });
}

export function validateAndroidRadioStatus(
  status,
  {
    nowMs = Date.now(),
    maximumAgeMs = MAX_ANDROID_EVIDENCE_AGE_MS
  } = {}
) {
  if (!isRecord(status)) {
    fail("ANDROID_RADIO_NOT_READY", "Android discovery radio is not READY");
  }
  if (
    status.ready !== true ||
    status.readiness !== "READY" ||
    status.radioActive !== true
  ) {
    fail("ANDROID_RADIO_NOT_READY", "Android discovery radio is not READY");
  }
  const metrics = status.metrics;
  if (
    !isRecord(metrics) ||
    metrics.advertisementsStarted < 1 ||
    metrics.advertisementFailures !== 0 ||
    metrics.scanFailures !== 0 ||
    metrics.scanIngressDropped !== 0 ||
    metrics.invalidPayloads !== 0
  ) {
    fail(
      "ANDROID_RADIO_EVIDENCE_INVALID",
      "Android radio metrics do not satisfy the physical gate"
    );
  }
  validateFreshTimestamp(
    status.sampledAtEpochMs,
    nowMs,
    maximumAgeMs,
    "ANDROID_EVIDENCE_STALE"
  );
  return Object.freeze({
    sampledAt: new Date(status.sampledAtEpochMs).toISOString(),
    sampleSequence: status.sampleSequence
  });
}

export function validateAndroidEvidence(
  status,
  raspberryGeneratedAtMs,
  {
    nowMs = Date.now(),
    maximumAgeMs = MAX_ANDROID_EVIDENCE_AGE_MS,
    maximumSkewMs = MAX_ANDROID_RASPBERRY_SKEW_MS
  } = {}
) {
  const evidence = validateAndroidRadioStatus(status, {
    nowMs,
    maximumAgeMs
  });
  if (
    Math.abs(status.sampledAtEpochMs - raspberryGeneratedAtMs) >
    maximumSkewMs
  ) {
    fail(
      "ANDROID_RASPBERRY_TIME_MISMATCH",
      "Android and Raspberry evidence are not temporally correlated"
    );
  }
  return evidence;
}

function buildRecord({
  state,
  deviceDigest,
  packageName,
  model,
  androidApi,
  androidEvidence,
  raspberryEvidence,
  monitorEvidence,
  recordedAt,
  evidenceRecordId
}) {
  return {
    ordinal: state.records.length + 1,
    evidenceRecordId,
    deviceDigest,
    nodeKind: PACKAGE_NODE_KIND.get(packageName),
    packageName,
    model,
    androidApi,
    recordedAt,
    androidSampledAt: androidEvidence.sampledAt,
    raspberryGeneratedAt: raspberryEvidence.generatedAt,
    raspberryReportSha256: raspberryEvidence.reportHash,
    raspberryLogSha256: raspberryEvidence.logHash,
    monitorEvidence: { ...monitorEvidence },
    observationsAccepted: raspberryEvidence.observationsAccepted,
    lifecycleDurationMs: raspberryEvidence.lifecycleDurationMs,
    wallClockDurationMs: raspberryEvidence.wallClockDurationMs,
    rssiDbm: { ...raspberryEvidence.rssiDbm }
  };
}

export function recordEvidence(
  currentState,
  {
    deviceDigest,
    packageName,
    model,
    androidApi,
    androidEvidence,
    raspberryEvidence,
    monitorEvidence,
    recordedAt = new Date().toISOString(),
    evidenceRecordId = crypto.randomUUID()
  }
) {
  const state = parseState(currentState);
  requireSha256(deviceDigest, "DEVICE_DIGEST_INVALID");
  if (!PACKAGE_NODE_KIND.has(packageName)) {
    fail("PACKAGE_UNSUPPORTED", "Android package is not a B4 gate target");
  }
  if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
    fail("DEVICE_MODEL_INVALID", "Android model is invalid");
  }
  requireInteger(androidApi, 33, "ANDROID_API_INVALID");
  validateMonitorEvidence(
    monitorEvidence,
    "MONITOR_AUTHORIZATION_INVALID"
  );
  if (
    monitorEvidence.certificationMatrixSha256 !==
    state.certificationMatrixBinding.matrixSha256
  ) {
    fail(
      "MONITOR_MATRIX_MISMATCH",
      "Monitor evidence is bound to a different certification matrix"
    );
  }
  const expectedCollectionRunCommitment = sha256(
    Buffer.from(`V5BT:B4:COLLECTION_RUN:${state.runId}`, "utf8")
  );
  if (
    monitorEvidence.collectionRunCommitmentSha256 !==
    expectedCollectionRunCommitment
  ) {
    fail(
      "MONITOR_BINDING_MISMATCH",
      "Monitor evidence is bound to a different B4 collection run"
    );
  }
  if (
    monitorEvidence.targetPackageName !== packageName ||
    monitorEvidence.targetAndroidApi !== androidApi
  ) {
    fail(
      "MONITOR_TARGET_MISMATCH",
      "Monitor evidence target does not match the collected Android target"
    );
  }
  const recordedAtMs = requireIsoTimestamp(
    recordedAt,
    "RECORD_TIMESTAMP_INVALID"
  );
  if (recordedAtMs < Date.parse(state.updatedAt)) {
    fail("CLOCK_REGRESSION", "Collector clock moved backwards");
  }
  requireUuid(evidenceRecordId, "EVIDENCE_ID_INVALID");

  const sameDevice = state.records.find(
    (record) => record.deviceDigest === deviceDigest
  );
  if (sameDevice !== undefined) {
    if (
      sameDevice.raspberryReportSha256 === raspberryEvidence.reportHash &&
      sameDevice.raspberryLogSha256 === raspberryEvidence.logHash &&
      canonicalJson(sameDevice.monitorEvidence) ===
        canonicalJson(monitorEvidence)
    ) {
      return Object.freeze({
        status: "ALREADY_RECORDED",
        state,
        record: sameDevice
      });
    }
    fail(
      "DEVICE_ALREADY_RECORDED",
      "This physical device already has a different B4 evidence record"
    );
  }
  if (
    state.records.some(
      (record) =>
        record.raspberryReportSha256 === raspberryEvidence.reportHash ||
        record.raspberryLogSha256 === raspberryEvidence.logHash ||
        record.monitorEvidence.captureRunCommitmentSha256 ===
          monitorEvidence.captureRunCommitmentSha256 ||
        record.monitorEvidence.androidAttestationSha256 ===
          monitorEvidence.androidAttestationSha256 ||
        record.monitorEvidence.raspberryAttestationSha256 ===
          monitorEvidence.raspberryAttestationSha256
    )
  ) {
    fail(
      "EVIDENCE_ALREADY_USED",
      "Raspberry evidence is already assigned to another physical device"
    );
  }
  if (state.records.length >= B4_REQUIRED_PHYSICAL_NODES) {
    fail("GATE_ALREADY_COMPLETE", "B4 already contains ten physical devices");
  }
  const record = buildRecord({
    state,
    deviceDigest,
    packageName,
    model,
    androidApi,
    androidEvidence,
    raspberryEvidence,
    monitorEvidence,
    recordedAt,
    evidenceRecordId
  });
  const nextState = parseState({
    ...state,
    updatedAt: recordedAt,
    records: [...state.records, record]
  });
  return Object.freeze({ status: "RECORDED", state: nextState, record });
}

function publicDeviceRecord(record) {
  return {
    ordinal: record.ordinal,
    evidenceRecordId: record.evidenceRecordId,
    nodeKind: record.nodeKind,
    packageName: record.packageName,
    model: record.model,
    androidApi: record.androidApi,
    recordedAt: record.recordedAt,
    androidSampledAt: record.androidSampledAt,
    raspberryGeneratedAt: record.raspberryGeneratedAt,
    raspberryReportSha256: record.raspberryReportSha256,
    raspberryLogSha256: record.raspberryLogSha256,
    observationsAccepted: record.observationsAccepted,
    lifecycleDurationMs: record.lifecycleDurationMs,
    wallClockDurationMs: record.wallClockDurationMs,
    rssiDbm: { ...record.rssiDbm }
  };
}

export function buildProgressReport(
  currentState,
  { generatedAt = new Date().toISOString(), operation = "STATUS" } = {}
) {
  const state = parseState(currentState);
  requireIsoTimestamp(generatedAt, "REPORT_TIMESTAMP_INVALID");
  const count = state.records.length;
  const complete = count === B4_REQUIRED_PHYSICAL_NODES;
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B4_COLLECTION_HARNESS_VERSION,
    product: "V5BT",
    phase: "B4",
    generatedAt,
    mode: STATE_MODE,
    operation,
    verdict: "PENDING",
    gate: {
      requiredDistinctPhysicalDevices: B4_REQUIRED_PHYSICAL_NODES,
      distinctPhysicalDevices: count,
      remainingPhysicalDevices: B4_REQUIRED_PHYSICAL_NODES - count,
      collectionStatus: complete ? "READY" : "PENDING",
      authoritativeB4GateExecuted: false,
      b4TenDeviceGate: "PENDING"
    },
    devices: state.records.map(publicDeviceRecord),
    privacy: {
      hardwareSerialsIncluded: false,
      adbTransportSerialsIncluded: false,
      bluetoothAddressesIncluded: false,
      rotatingAliasesIncluded: false,
      stableNodeIdsIncluded: false,
      deviceDigestsIncluded: false,
      identityHmacKeyIncluded: false
    },
    activeV4Changes: false
  });
}

export function classifyPhysicalCandidate(currentState, deviceDigest) {
  const state = parseState(currentState);
  requireSha256(deviceDigest, "DEVICE_DIGEST_INVALID");
  const existing = state.records.find(
    (record) => record.deviceDigest === deviceDigest
  );
  if (existing !== undefined) {
    return Object.freeze({
      eligible: false,
      reasonCode: "ALREADY_RECORDED",
      requestedSlot:
        state.records.length < B4_REQUIRED_PHYSICAL_NODES
          ? state.records.length + 1
          : null,
      existingSlot: existing.ordinal
    });
  }
  if (state.records.length >= B4_REQUIRED_PHYSICAL_NODES) {
    return Object.freeze({
      eligible: false,
      reasonCode: "COLLECTION_COMPLETE",
      requestedSlot: null,
      existingSlot: null
    });
  }
  return Object.freeze({
    eligible: true,
    reasonCode: "READY_FOR_CAPTURE",
    requestedSlot: state.records.length + 1,
    existingSlot: null
  });
}

export function buildDevicePreflightReport(
  currentState,
  {
    deviceDigest,
    packageName,
    model,
    androidApi,
    androidEvidence,
    canonicalChecks,
    generatedAt = new Date().toISOString()
  }
) {
  const state = parseState(currentState);
  requireIsoTimestamp(generatedAt, "REPORT_TIMESTAMP_INVALID");
  if (!PACKAGE_NODE_KIND.has(packageName)) {
    fail("PACKAGE_UNSUPPORTED", "Android package is not a B4 gate target");
  }
  if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
    fail("DEVICE_MODEL_INVALID", "Android model is invalid");
  }
  requireInteger(androidApi, 33, "ANDROID_API_INVALID");
  if (!isRecord(androidEvidence)) {
    fail("ANDROID_RADIO_EVIDENCE_INVALID", "Android evidence is invalid");
  }
  requireIsoTimestamp(
    androidEvidence.sampledAt,
    "ANDROID_RADIO_EVIDENCE_INVALID"
  );
  requireInteger(
    androidEvidence.sampleSequence,
    0,
    "ANDROID_RADIO_EVIDENCE_INVALID"
  );
  if (
    !isRecord(canonicalChecks) ||
    !Number.isSafeInteger(canonicalChecks.passed) ||
    !Number.isSafeInteger(canonicalChecks.total) ||
    canonicalChecks.passed < 1 ||
    canonicalChecks.passed !== canonicalChecks.total
  ) {
    fail("ANDROID_PREFLIGHT_FAILED", "Canonical Android preflight failed");
  }
  const candidate = classifyPhysicalCandidate(state, deviceDigest);
  const count = state.records.length;
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B4_COLLECTION_HARNESS_VERSION,
    product: "V5BT",
    phase: "B4.4",
    generatedAt,
    mode: STATE_MODE,
    operation: "DEVICE_PREFLIGHT",
    verdict: candidate.eligible ? "PASS" : "NOT_ELIGIBLE",
    candidate: {
      eligibleForNextSlot: candidate.eligible,
      reasonCode: candidate.reasonCode,
      requestedSlot: candidate.requestedSlot,
      existingSlot: candidate.existingSlot,
      nodeKind: PACKAGE_NODE_KIND.get(packageName),
      packageName,
      model,
      androidApi,
      radioReady: true,
      sampledAt: androidEvidence.sampledAt,
      canonicalChecks: { ...canonicalChecks }
    },
    gate: {
      requiredDistinctPhysicalDevices: B4_REQUIRED_PHYSICAL_NODES,
      distinctPhysicalDevices: count,
      remainingPhysicalDevices: B4_REQUIRED_PHYSICAL_NODES - count,
      collectionStatus:
        count === B4_REQUIRED_PHYSICAL_NODES ? "READY" : "PENDING",
      authoritativeB4GateExecuted: false,
      b4TenDeviceGate: "PENDING"
    },
    effects: {
      raspberryEvidenceConsumed: false,
      privateStateWritten: false,
      evidenceStaged: false,
      authoritativeB4GateExecuted: false,
      b4GatePromoted: false
    },
    privacy: {
      hardwareSerialsIncluded: false,
      adbTransportSerialsIncluded: false,
      bluetoothAddressesIncluded: false,
      rotatingAliasesIncluded: false,
      stableNodeIdsIncluded: false,
      deviceDigestsIncluded: false,
      identityHmacKeyIncluded: false
    },
    activeV4Changes: false
  });
}

export function buildManifestReadyReport(
  currentState,
  { generatedAt = new Date().toISOString() } = {}
) {
  const state = parseState(currentState);
  if (state.records.length !== B4_REQUIRED_PHYSICAL_NODES) {
    fail(
      "COLLECTION_INCOMPLETE",
      `The collection requires ${B4_REQUIRED_PHYSICAL_NODES} distinct physical devices`,
      2
    );
  }
  return buildProgressReport(state, {
    generatedAt,
    operation: "MANIFEST_READY"
  });
}

function atomicWrite(destination, content) {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, destination);
    try {
      fs.chmodSync(destination, 0o600);
    } catch {
      // Windows ACLs remain authoritative when POSIX modes are unavailable.
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function assertNoSymlinkPathComponents(location, code) {
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
      if (error?.code === "ENOENT") return;
      fail(code, "Private evidence path cannot be inspected safely");
    }
    if (status.isSymbolicLink()) {
      fail(code, "Private evidence path must not contain symlinks");
    }
  }
}

function requirePrivateEvidenceDirectory(directory) {
  assertNoSymlinkPathComponents(
    directory,
    "PRIVATE_EVIDENCE_DIRECTORY_INVALID"
  );
  let status;
  try {
    status = fs.lstatSync(directory);
  } catch {
    fail(
      "PRIVATE_EVIDENCE_DIRECTORY_INVALID",
      "Private evidence directory is unavailable"
    );
  }
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (
      process.platform !== "win32" &&
      (status.mode & 0o777) !== 0o700
    ) ||
    (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      status.uid !== process.getuid()
    )
  ) {
    fail(
      "PRIVATE_EVIDENCE_DIRECTORY_INVALID",
      "Private evidence directory must be owned and mode 0700"
    );
  }
}

function sameDirectory(first, second) {
  const normalizedFirst = path.resolve(first);
  const normalizedSecond = path.resolve(second);
  return process.platform === "win32"
    ? normalizedFirst.toLowerCase() === normalizedSecond.toLowerCase()
    : normalizedFirst === normalizedSecond;
}

function evidenceDirectoryForState(statePath) {
  return `${statePath}.evidence`;
}

function evidencePathsForSlot(statePath, slot) {
  const suffix = String(slot).padStart(2, "0");
  const directory = evidenceDirectoryForState(statePath);
  return Object.freeze({
    directory,
    report: path.join(directory, `capture-${suffix}.json`),
    log: path.join(directory, `capture-${suffix}.log`),
    androidMonitor: path.join(
      directory,
      `capture-${suffix}.android-monitor.json`
    ),
    raspberryMonitor: path.join(
      directory,
      `capture-${suffix}.raspberry-monitor.json`
    )
  });
}

function writeOrVerifyEvidence(destination, content, expectedSha256) {
  if (fs.existsSync(destination)) {
    const existing = readBoundedFile(
      destination,
      destination.endsWith(".log") ? MAX_LOG_BYTES : MAX_REPORT_BYTES,
      "PRIVATE_EVIDENCE_CONFLICT",
      null,
      { privateFile: true }
    );
    if (sha256(existing) !== expectedSha256) {
      fail(
        "PRIVATE_EVIDENCE_CONFLICT",
        "A staged evidence slot contains different bytes"
      );
    }
    return;
  }
  atomicWrite(destination, content);
  const stored = readBoundedFile(
    destination,
    destination.endsWith(".log") ? MAX_LOG_BYTES : MAX_REPORT_BYTES,
    "PRIVATE_EVIDENCE_WRITE_FAILED",
    null,
    { privateFile: true }
  );
  if (sha256(stored) !== expectedSha256) {
    fail(
      "PRIVATE_EVIDENCE_WRITE_FAILED",
      "Staged evidence failed its post-write hash check"
    );
  }
}

function preflightFinalArtifacts(entries) {
  for (const [destination, , expectedSha256] of entries) {
    if (!fs.existsSync(destination)) continue;
    const existing = readBoundedFile(
      destination,
      MAX_REPORT_BYTES,
      "FINAL_ARTIFACT_CONFLICT",
      null,
      { privateFile: true }
    );
    if (sha256(existing) !== expectedSha256) {
      fail(
        "FINAL_ARTIFACT_CONFLICT",
        "A final B4 artifact already exists with different bytes"
      );
    }
  }
}

export function persistCaptureEvidence(
  statePath,
  record,
  reportText,
  rawLog,
  androidMonitorText,
  raspberryMonitorText,
  { replaceUncommitted = false } = {}
) {
  const paths = evidencePathsForSlot(statePath, record.ordinal);
  assertNoSymlinkPathComponents(
    paths.directory,
    "PRIVATE_EVIDENCE_DIRECTORY_INVALID"
  );
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  requirePrivateEvidenceDirectory(paths.directory);
  const entries = [
    [paths.report, reportText, record.raspberryReportSha256],
    [paths.log, rawLog, record.raspberryLogSha256],
    [
      paths.androidMonitor,
      androidMonitorText,
      record.monitorEvidence.androidAttestationSha256
    ],
    [
      paths.raspberryMonitor,
      raspberryMonitorText,
      record.monitorEvidence.raspberryAttestationSha256
    ]
  ];
  const existing = entries.filter(([destination]) =>
    fs.existsSync(destination)
  );
  if (replaceUncommitted && existing.length > 0) {
    let exact = true;
    for (const [destination, , expectedSha256] of existing) {
      const bytes = readBoundedFile(
        destination,
        destination.endsWith(".log") ? MAX_LOG_BYTES : MAX_REPORT_BYTES,
        "PRIVATE_EVIDENCE_CONFLICT",
        null,
        { privateFile: true }
      );
      if (sha256(bytes) !== expectedSha256) exact = false;
    }
    if (!exact) {
      for (const [destination] of existing) fs.rmSync(destination);
    }
  }
  for (const [destination, content, expectedSha256] of entries) {
    writeOrVerifyEvidence(destination, content, expectedSha256);
  }
}

export function buildEvidenceManifest(
  currentState,
  statePath,
  manifestPath
) {
  const state = parseState(currentState);
  if (state.records.length !== B4_REQUIRED_PHYSICAL_NODES) {
    fail(
      "COLLECTION_INCOMPLETE",
      `The collection requires ${B4_REQUIRED_PHYSICAL_NODES} distinct physical devices`,
      2
    );
  }
  if (
    !sameDirectory(path.dirname(statePath), path.dirname(manifestPath))
  ) {
    fail(
      "MANIFEST_LOCATION_INVALID",
      "The private manifest must remain beside the private collector state"
    );
  }
  const evidenceDirectory = evidenceDirectoryForState(statePath);
  requirePrivateEvidenceDirectory(evidenceDirectory);
  const relativeDirectory = path.basename(evidenceDirectory);
  const captures = state.records.map((record) => {
    const paths = evidencePathsForSlot(statePath, record.ordinal);
    const reportBytes = readBoundedFile(
      paths.report,
      MAX_REPORT_BYTES,
      "PRIVATE_EVIDENCE_MISSING",
      null,
      { privateFile: true }
    );
    const logBytes = readBoundedFile(
      paths.log,
      MAX_LOG_BYTES,
      "PRIVATE_EVIDENCE_MISSING",
      null,
      { privateFile: true }
    );
    const androidMonitorBytes = readBoundedFile(
      paths.androidMonitor,
      MAX_REPORT_BYTES,
      "PRIVATE_EVIDENCE_MISSING",
      null,
      { privateFile: true }
    );
    const raspberryMonitorBytes = readBoundedFile(
      paths.raspberryMonitor,
      MAX_REPORT_BYTES,
      "PRIVATE_EVIDENCE_MISSING",
      null,
      { privateFile: true }
    );
    if (
      sha256(reportBytes) !== record.raspberryReportSha256 ||
      sha256(logBytes) !== record.raspberryLogSha256 ||
      sha256(androidMonitorBytes) !==
        record.monitorEvidence.androidAttestationSha256 ||
      sha256(raspberryMonitorBytes) !==
        record.monitorEvidence.raspberryAttestationSha256
    ) {
      fail(
        "PRIVATE_EVIDENCE_HASH_MISMATCH",
        "Staged evidence no longer matches the collector state"
      );
    }
    const suffix = String(record.ordinal).padStart(2, "0");
    return {
      slot: record.ordinal,
      captureRunId: record.monitorEvidence.captureRunId,
      report: `${relativeDirectory}/capture-${suffix}.json`,
      log: `${relativeDirectory}/capture-${suffix}.log`,
      androidMonitor:
        `${relativeDirectory}/capture-${suffix}.android-monitor.json`,
      androidMonitorSha256:
        record.monitorEvidence.androidAttestationSha256,
      raspberryMonitor:
        `${relativeDirectory}/capture-${suffix}.raspberry-monitor.json`,
      raspberryMonitorSha256:
        record.monitorEvidence.raspberryAttestationSha256
    };
  });
  return Object.freeze({
    schemaVersion: 2,
    gate: "B4_TEN_PHYSICAL_DEVICES",
    collectionRunId: state.runId,
    certificationMatrixSha256:
      state.certificationMatrixBinding.matrixSha256,
    collectorReport: COLLECTOR_REPORT_FILE,
    captures
  });
}

function writeJson(destination, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (destination !== null) atomicWrite(destination, content);
  process.stdout.write(content);
}

export function readStateSnapshot(statePath) {
  assertNoSymlinkPathComponents(statePath, "STATE_READ_FAILED");
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = fs.openSync(
      statePath,
      fs.constants.O_RDONLY | noFollow
    );
    const status = fs.fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      status.size < 1 ||
      status.size > MAX_STATE_BYTES
    ) {
      fail("STATE_READ_FAILED", "Private state file is invalid");
    }
    if (
      process.platform !== "win32" &&
      (status.mode & 0o777) !== 0o600
    ) {
      fail(
        "STATE_NOT_PRIVATE",
        "Private state file must have owner-only mode 0600"
      );
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      status.uid !== process.getuid()
    ) {
      fail("STATE_NOT_PRIVATE", "Private state file must be owned by the collector user");
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (
      status.dev !== after.dev ||
      status.ino !== after.ino ||
      status.size !== after.size ||
      status.mtimeMs !== after.mtimeMs ||
      status.ctimeMs !== after.ctimeMs ||
      Buffer.byteLength(raw, "utf8") !== status.size
    ) {
      fail("STATE_CHANGED_DURING_READ", "Private state changed while it was read");
    }
    return Object.freeze({
      state: parseState(raw),
      fingerprint: Object.freeze({
        dev: status.dev,
        ino: status.ino,
        size: status.size,
        mode: status.mode,
        uid: status.uid,
        nlink: status.nlink,
        mtimeMs: status.mtimeMs,
        ctimeMs: status.ctimeMs,
        sha256: sha256(raw)
      })
    });
  } catch (error) {
    if (error instanceof B4PhysicalCollectionError) throw error;
    fail("STATE_READ_FAILED", "Private state file cannot be read safely");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readState(statePath) {
  return readStateSnapshot(statePath).state;
}

function sameStateFingerprint(left, right) {
  return Object.keys(left).every((field) => left[field] === right[field]);
}

export function assertCollectionStateUnchanged(statePath, expectedFingerprint) {
  let current;
  try {
    current = readStateSnapshot(statePath);
  } catch {
    fail(
      "STATE_CHANGED_DURING_COLLECTION",
      "Private state changed or disappeared during collection"
    );
  }
  if (!sameStateFingerprint(expectedFingerprint, current.fingerprint)) {
    fail(
      "STATE_CHANGED_DURING_COLLECTION",
      "Private state changed during collection"
    );
  }
  return current.state;
}

export async function withStableReadOnlyState(statePath, action) {
  const before = readStateSnapshot(statePath);
  let result;
  let actionError = null;
  try {
    result = await action(before.state);
  } catch (error) {
    actionError = error;
  }
  let after;
  try {
    after = readStateSnapshot(statePath);
  } catch {
    fail(
      "STATE_CHANGED_DURING_PREFLIGHT",
      "Private state changed or disappeared during preflight"
    );
  }
  if (!sameStateFingerprint(before.fingerprint, after.fingerprint)) {
    fail(
      "STATE_CHANGED_DURING_PREFLIGHT",
      "Private state changed during preflight"
    );
  }
  if (actionError !== null) throw actionError;
  return result;
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireStateLock(statePath) {
  const lockPath = `${statePath}.lock`;
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const ownerToken = crypto.randomUUID();
  const content = `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    ownerToken
  })}\n`;
  const attempt = () => {
    const descriptor = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
  };
  try {
    attempt();
  } catch (error) {
    if (error?.code !== "EEXIST") {
      fail("STATE_LOCK_FAILED", "Cannot acquire the private state lock");
    }
    let stale = false;
    try {
      const existing = parseJson(
        fs.readFileSync(lockPath, "utf8"),
        "STATE_BUSY"
      );
      stale =
        existing.hostname === os.hostname() &&
        Number.isSafeInteger(existing.pid) &&
        !processIsRunning(existing.pid);
    } catch {
      stale = false;
    }
    if (!stale) fail("STATE_BUSY", "Private gate state is already in use");
    fs.rmSync(lockPath, { force: true });
    try {
      attempt();
    } catch {
      fail("STATE_BUSY", "Private gate state is already in use");
    }
  }
  return () => {
    try {
      const existing = parseJson(
        fs.readFileSync(lockPath, "utf8"),
        "STATE_LOCK_CHANGED"
      );
      if (existing.ownerToken === ownerToken) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {
      // Never remove a lock whose ownership can no longer be proven.
    }
  };
}

export async function withB4CollectionStateLock(statePath, action) {
  const release = acquireStateLock(statePath);
  try {
    return await action();
  } finally {
    release();
  }
}

function readStableHardwareSerial(adb) {
  const emulator = adb.shell("getprop", "ro.kernel.qemu");
  if (emulator.ok && emulator.stdout.trim() === "1") {
    fail("EMULATOR_NOT_ALLOWED", "The B4 gate requires physical hardware");
  }
  for (const property of ["ro.serialno", "ro.boot.serialno"]) {
    const result = adb.shell("getprop", property);
    const candidate = result.ok ? result.stdout.trim() : "";
    if (STABLE_SERIAL_PATTERN.test(candidate)) return candidate;
  }
  fail(
    "HARDWARE_IDENTITY_UNAVAILABLE",
    "A stable physical hardware identity is unavailable"
  );
}

function readCurrentDiscoveryStatus(adb, packageName, currentUser) {
  const result = adb.execOutRunAsForUser(
    packageName,
    currentUser,
    "cat",
    DISCOVERY_STATUS_FILE
  );
  if (!result.ok) {
    fail(
      "ANDROID_DISCOVERY_STATUS_UNAVAILABLE",
      "Private Android discovery status is unavailable"
    );
  }
  try {
    return parseDiscoveryStatus(result.stdout);
  } catch {
    fail(
      "ANDROID_DISCOVERY_STATUS_INVALID",
      "Private Android discovery status is invalid"
    );
  }
}

export function selectExplicitAdbTarget(devicesOutput, serial) {
  if (!isValidAdbSerial(serial)) {
    fail("ADB_SERIAL_INVALID", "A valid explicit ADB serial is required");
  }
  const matches = parseAdbDevices(devicesOutput).filter(
    (device) => device.serial === serial
  );
  if (matches.length !== 1 || matches[0].state !== "device") {
    fail(
      "ADB_TARGET_UNAVAILABLE",
      "The selected ADB target must be present and authorized"
    );
  }
  return matches[0];
}

function readCurrentAndroidUser(adb) {
  const result = adb.shell("am", "get-current-user");
  const value = result.ok ? result.stdout.trim() : "";
  if (!/^\d+$/u.test(value)) {
    fail("ANDROID_USER_UNAVAILABLE", "Current Android user is unavailable");
  }
  const currentUser = Number(value);
  if (!Number.isSafeInteger(currentUser)) {
    fail("ANDROID_USER_UNAVAILABLE", "Current Android user is unavailable");
  }
  return currentUser;
}

async function inspectPhysicalCandidate(
  options,
  state,
  raspberryGeneratedAtMs,
  captureRunId = null
) {
  const nodeKind = PACKAGE_NODE_KIND.get(options.packageName);
  if (nodeKind === undefined) {
    fail("PACKAGE_UNSUPPORTED", "Android package is not a B4 gate target");
  }
  const discoveryClient = new AdbClient(options.adb, "");
  const devicesResult = discoveryClient.run(["devices", "-l"]);
  if (!devicesResult.ok) {
    fail("ADB_DEVICE_LIST_FAILED", "ADB device inventory is unavailable");
  }
  selectExplicitAdbTarget(devicesResult.stdout, options.serial);
  const transportSerial = options.serial;
  const adb = new AdbClient(options.adb, transportSerial);
  const preflight = await runPreflight(adb, {
    serial: transportSerial,
    packageName: options.packageName,
    expectedModel: options.expectedModel
  });
  if (!preflight.passed) {
    fail("ANDROID_PREFLIGHT_FAILED", "Android physical preflight failed");
  }
  const currentUser = preflight.target.currentUser;
  const status = readCurrentDiscoveryStatus(
    adb,
    options.packageName,
    currentUser
  );
  const androidEvidence =
    raspberryGeneratedAtMs === null
      ? validateAndroidRadioStatus(status)
      : validateAndroidEvidence(status, raspberryGeneratedAtMs);
  const stableHardwareSerial = readStableHardwareSerial(adb);
  if (readCurrentAndroidUser(adb) !== currentUser) {
    fail(
      "ANDROID_USER_CHANGED",
      "Current Android user changed during physical preflight"
    );
  }
  const identityKey = decodeIdentityKey(state.identityKeyBase64Url);
  let deviceDigest;
  let targetHardwareCommitmentSha256 = null;
  try {
    deviceDigest = deriveDeviceDigest(identityKey, stableHardwareSerial);
    if (captureRunId !== null) {
      targetHardwareCommitmentSha256 = buildB4TargetHardwareCommitment(
        identityKey,
        stableHardwareSerial,
        captureRunId
      );
    }
  } finally {
    identityKey.fill(0);
  }
  return Object.freeze({
    deviceDigest,
    packageName: options.packageName,
    model: preflight.target.model,
    androidApi: preflight.target.androidApi,
    androidEvidence,
    canonicalChecks: {
      passed: preflight.checks.filter((check) => check.status === "PASS").length,
      total: preflight.checks.length
    },
    targetHardwareCommitmentSha256
  });
}

async function preflightPhysicalCandidate(options, state) {
  const candidate = await inspectPhysicalCandidate(options, state, null);
  return buildDevicePreflightReport(state, candidate);
}

async function collectPhysicalRecord(options, state) {
  const nodeKind = PACKAGE_NODE_KIND.get(options.packageName);
  if (nodeKind === undefined) {
    fail("PACKAGE_UNSUPPORTED", "Android package is not a B4 gate target");
  }
  const reportText = readBoundedFile(
    options.raspberryReport,
    MAX_REPORT_BYTES,
    "RASPBERRY_REPORT_READ_FAILED",
    "utf8",
    { privateFile: true }
  );
  const androidMonitorText = readBoundedFile(
    options.androidMonitorAttestation,
    MAX_REPORT_BYTES,
    "ANDROID_MONITOR_ATTESTATION_READ_FAILED",
    "utf8",
    { privateFile: true }
  );
  const raspberryMonitorText = readBoundedFile(
    options.raspberryMonitorAttestation,
    MAX_REPORT_BYTES,
    "RASPBERRY_MONITOR_ATTESTATION_READ_FAILED",
    "utf8",
    { privateFile: true }
  );
  const report = parseJson(reportText, "RASPBERRY_REPORT_INVALID");
  let monitorEvidence;
  try {
    const parsers = await loadB4MonitorAttestationParsers();
    monitorEvidence = validateB4MonitoredSlotAuthorization(
      {
        collectorState: state,
        captureRunId: options.captureRunId,
        expectedPackageName: options.packageName,
        raspberryReport: report,
        androidAttestationText: androidMonitorText,
        raspberryAttestationText: raspberryMonitorText
      },
      parsers
    );
  } catch (error) {
    if (error instanceof B4MonitoredSlotGateError) {
      fail(error.code, error.message, error.exitCode);
    }
    fail(
      "MONITOR_AUTHORIZATION_INVALID",
      "B4 monitor authorization could not be validated"
    );
  }
  const rawLog = readBoundedFile(
    options.raspberryLog,
    MAX_LOG_BYTES,
    "RASPBERRY_LOG_READ_FAILED",
    "utf8",
    { privateFile: true }
  );
  const nowMs = Date.now();
  const raspberryEvidence = validateRaspberryEvidence(
    report,
    rawLog,
    nodeKind,
    { nowMs, rawReportText: reportText }
  );

  const candidate = await inspectPhysicalCandidate(
    options,
    state,
    raspberryEvidence.generatedAtMs,
    options.captureRunId
  );
  if (
    candidate.targetHardwareCommitmentSha256 !==
    monitorEvidence.targetHardwareCommitmentSha256
  ) {
    fail(
      "MONITOR_TARGET_HARDWARE_MISMATCH",
      "Android monitor and collector selected different physical hardware"
    );
  }
  const result = recordEvidence(state, {
    deviceDigest: candidate.deviceDigest,
    packageName: options.packageName,
    model: candidate.model,
    androidApi: candidate.androidApi,
    androidEvidence: candidate.androidEvidence,
    raspberryEvidence,
    monitorEvidence
  });
  return Object.freeze({
    result,
    reportText,
    rawLog,
    androidMonitorText,
    raspberryMonitorText
  });
}

function parseArguments(argv) {
  const options = {
    mode: null,
    state: null,
    manifest: null,
    output: null,
    adb: "adb",
    serial: null,
    packageName: null,
    expectedModel: undefined,
    raspberryReport: null,
    raspberryLog: null,
    captureRunId: null,
    androidMonitorAttestation: null,
    raspberryMonitorAttestation: null
  };
  const modes = new Map([
    ["--init", "INIT"],
    ["--preflight", "PREFLIGHT"],
    ["--record", "RECORD"],
    ["--status", "STATUS"],
    ["--finalize", "FINALIZE"],
    ["--self-test", "SELF_TEST"],
    ["--help", "HELP"]
  ]);
  const values = new Map([
    ["--state", "state"],
    ["--manifest", "manifest"],
    ["--output", "output"],
    ["--adb", "adb"],
    ["--serial", "serial"],
    ["--package", "packageName"],
    ["--expected-model", "expectedModel"],
    ["--raspberry-report", "raspberryReport"],
    ["--raspberry-log", "raspberryLog"],
    ["--capture-run-id", "captureRunId"],
    ["--android-monitor-attestation", "androidMonitorAttestation"],
    ["--raspberry-monitor-attestation", "raspberryMonitorAttestation"]
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) fail("INVALID_ARGUMENT", "Duplicate CLI option");
    seen.add(argument);
    if (modes.has(argument)) {
      if (options.mode !== null) {
        fail("INVALID_ARGUMENT", "Select exactly one gate operation");
      }
      options.mode = modes.get(argument);
      continue;
    }
    const field = values.get(argument);
    if (field === undefined) fail("INVALID_ARGUMENT", "Unknown CLI option");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", "CLI option value is missing");
    }
    options[field] = value;
    index += 1;
  }
  return options;
}

function validateOptions(options) {
  if (options.mode === null) {
    fail("INVALID_ARGUMENT", "Select one gate operation");
  }
  if (options.mode === "HELP" || options.mode === "SELF_TEST") {
    return options;
  }
  if (options.state === null) {
    fail("INVALID_ARGUMENT", "--state is required");
  }
  options.state = path.resolve(options.state);
  if (options.manifest !== null) {
    options.manifest = path.resolve(options.manifest);
  }
  if (options.output !== null) options.output = path.resolve(options.output);
  const normalizeComparablePath = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32"
      ? resolved.toLowerCase()
      : resolved;
  };
  const stateComparable = normalizeComparablePath(options.state);
  if (
    options.output !== null &&
    normalizeComparablePath(options.output) === stateComparable
  ) {
    fail(
      "INVALID_ARGUMENT",
      "--output must not overwrite the private collector state"
    );
  }
  if (options.output !== null) {
    const evidenceDirectory = path.resolve(
      evidenceDirectoryForState(options.state)
    );
    const relativeOutput = path.relative(
      evidenceDirectory,
      options.output
    );
    if (
      relativeOutput === "" ||
      (
        !relativeOutput.startsWith(`..${path.sep}`) &&
        relativeOutput !== ".." &&
        !path.isAbsolute(relativeOutput)
      )
    ) {
      fail(
        "INVALID_ARGUMENT",
        "--output must remain outside the private evidence directory"
      );
    }
  }
  if (options.mode === "PREFLIGHT" || options.mode === "RECORD") {
    if (!isValidAdbSerial(options.serial)) {
      fail(
        "INVALID_ARGUMENT",
        `${options.mode === "PREFLIGHT" ? "--preflight" : "--record"} requires a valid explicit serial`
      );
    }
    if (options.packageName === null) {
      fail(
        "INVALID_ARGUMENT",
        `${options.mode === "PREFLIGHT" ? "--preflight" : "--record"} requires package`
      );
    }
    if (!PACKAGE_NODE_KIND.has(options.packageName)) {
      fail("PACKAGE_UNSUPPORTED", "Android package is not a B4 gate target");
    }
    options.adb =
      options.adb === "adb" || path.isAbsolute(options.adb)
        ? options.adb
        : path.resolve(options.adb);
  }
  if (options.mode === "PREFLIGHT") {
    if (
      options.raspberryReport !== null ||
      options.raspberryLog !== null ||
      options.captureRunId !== null ||
      options.androidMonitorAttestation !== null ||
      options.raspberryMonitorAttestation !== null ||
      options.manifest !== null
    ) {
      fail(
        "INVALID_ARGUMENT",
        "--preflight does not accept Raspberry evidence or a manifest"
      );
    }
  }
  if (options.mode === "RECORD") {
    if (
      options.raspberryReport === null ||
      options.raspberryLog === null ||
      options.captureRunId === null ||
      options.androidMonitorAttestation === null ||
      options.raspberryMonitorAttestation === null
    ) {
      fail(
        "INVALID_ARGUMENT",
        "--record requires capture ID, both monitor attestations, package, Raspberry report and Raspberry log"
      );
    }
    requireUuid(options.captureRunId, "INVALID_ARGUMENT");
    options.raspberryReport = path.resolve(options.raspberryReport);
    options.raspberryLog = path.resolve(options.raspberryLog);
    options.androidMonitorAttestation = path.resolve(
      options.androidMonitorAttestation
    );
    options.raspberryMonitorAttestation = path.resolve(
      options.raspberryMonitorAttestation
    );
    const protectedPaths = [
      options.state,
      options.raspberryReport,
      options.raspberryLog,
      options.androidMonitorAttestation,
      options.raspberryMonitorAttestation
    ].map(normalizeComparablePath);
    if (new Set(protectedPaths).size !== protectedPaths.length) {
      fail(
        "INVALID_ARGUMENT",
        "collector state and Raspberry evidence paths must be distinct"
      );
    }
    if (
      options.output !== null &&
      protectedPaths.includes(normalizeComparablePath(options.output))
    ) {
      fail(
        "INVALID_ARGUMENT",
        "--output must not overwrite collector input files"
      );
    }
  }
  if (options.mode === "FINALIZE" && options.manifest === null) {
    fail("INVALID_ARGUMENT", "--finalize requires --manifest");
  }
  if (options.mode === "FINALIZE") {
    const manifestComparable = normalizeComparablePath(options.manifest);
    const collectorReportComparable = normalizeComparablePath(
      path.join(path.dirname(options.manifest), COLLECTOR_REPORT_FILE)
    );
    if (
      stateComparable === manifestComparable ||
      stateComparable === collectorReportComparable ||
      manifestComparable === collectorReportComparable
    ) {
      fail(
        "INVALID_ARGUMENT",
        "collector state, manifest and final report paths must be distinct"
      );
    }
    if (
      options.output !== null &&
      [
        stateComparable,
        manifestComparable,
        collectorReportComparable
      ].includes(normalizeComparablePath(options.output))
    ) {
      fail(
        "INVALID_ARGUMENT",
        "--output must not overwrite private collector artifacts"
      );
    }
  }
  return options;
}

function usage() {
  return [
    "V5BT B4 progressive physical-evidence collector",
    "",
    "Usage:",
    "  node scripts/collect-b4-physical-device.mjs --init --state PRIVATE.json",
    "  node scripts/collect-b4-physical-device.mjs --status --state PRIVATE.json",
    "  node scripts/collect-b4-physical-device.mjs --preflight --state PRIVATE.json \\",
    "    --adb ADB --serial SERIAL --package PACKAGE [--expected-model MODEL] [--output REPORT.json]",
    "  node scripts/collect-b4-physical-device.mjs --record --state PRIVATE.json \\",
    "    --adb ADB --serial SERIAL --package PACKAGE --raspberry-report REPORT.json \\",
    "    --raspberry-log NODE.log --capture-run-id UUID \\",
    "    --android-monitor-attestation ANDROID.json \\",
    "    --raspberry-monitor-attestation RASPBERRY.json \\",
    "    [--expected-model MODEL] [--output REPORT.json]",
    "  node scripts/collect-b4-physical-device.mjs --finalize --state PRIVATE.json \\",
    "    --manifest PRIVATE-MANIFEST.json [--output STATUS.json]",
    "  node scripts/collect-b4-physical-device.mjs --self-test",
    "",
    "Preflight and record require an explicit ADB serial. Other authorized",
    "devices may remain connected, but the collector reads only the selected",
    "target. Preflight never mutates private state or consumes Raspberry evidence."
  ].join("\n");
}

export function runSelfTest() {
  const now = "2026-07-20T00:00:00.000Z";
  let state = createInitialState({
    now,
    runId: "00000000-0000-4000-8000-000000000001",
    identityKey: Buffer.alloc(32, 0x5a)
  });
  const raspberryEvidence = {
    reportHash: "a".repeat(64),
    logHash: "b".repeat(64),
    generatedAt: now,
    generatedAtMs: Date.parse(now),
    observationsAccepted: 1,
    lifecycleDurationMs: 90_000,
    wallClockDurationMs: 90_000,
    rssiDbm: { minimum: -60, maximum: -60, samples: 1 }
  };
  const identityKey = Buffer.alloc(32, 0x5a);
  const digest = deriveDeviceDigest(identityKey, "SELFTEST0001");
  const captureRunId = "00000000-0000-4000-8000-000000000003";
  const monitorEvidence = {
    collectionRunCommitmentSha256: sha256(
      Buffer.from(`V5BT:B4:COLLECTION_RUN:${state.runId}`, "utf8")
    ),
    captureRunCommitmentSha256: sha256(
      Buffer.from(`V5BT:B4:CAPTURE_RUN:${captureRunId}`, "utf8")
    ),
    captureRunId,
    certificationMatrixSha256:
      state.certificationMatrixBinding.matrixSha256,
    androidAttestationSha256: "e".repeat(64),
    raspberryAttestationSha256: "f".repeat(64),
    targetPackageName:
      ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId,
    targetAndroidApi: 35,
    targetHardwareCommitmentSha256:
      buildB4TargetHardwareCommitmentFromDeviceDigest({
        identityKey,
        deviceDigest: digest,
        captureRunId
      }),
    coverageStartedAt: new Date(Date.parse(now) - 90_000).toISOString(),
    coverageCompletedAt: now
  };
  identityKey.fill(0);
  state = recordEvidence(state, {
    deviceDigest: digest,
    packageName: ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId,
    model: "Self Test",
    androidApi: 35,
    androidEvidence: { sampledAt: now, sampleSequence: 1 },
    raspberryEvidence,
    monitorEvidence,
    recordedAt: now,
    evidenceRecordId: "00000000-0000-4000-8000-000000000002"
  }).state;
  const report = buildProgressReport(state, {
    generatedAt: now,
    operation: "SELF_TEST"
  });
  const duplicatePreflight = buildDevicePreflightReport(state, {
    deviceDigest: digest,
    packageName: ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId,
    model: "Self Test",
    androidApi: 35,
    androidEvidence: { sampledAt: now, sampleSequence: 2 },
    canonicalChecks: { passed: 14, total: 14 },
    generatedAt: now
  });
  const nextDigest = deriveDeviceDigest(
    Buffer.alloc(32, 0x5a),
    "SELFTEST0002"
  );
  const nextPreflight = buildDevicePreflightReport(state, {
    deviceDigest: nextDigest,
    packageName: ADVANCED_CERTIFICATION_TARGETS.roles.station.packageId,
    model: "Self Test Station",
    androidApi: 35,
    androidEvidence: { sampledAt: now, sampleSequence: 3 },
    canonicalChecks: { passed: 14, total: 14 },
    generatedAt: now
  });
  if (
    report.verdict !== "PENDING" ||
    report.gate.distinctPhysicalDevices !== 1 ||
    duplicatePreflight.verdict !== "NOT_ELIGIBLE" ||
    duplicatePreflight.candidate.existingSlot !== 1 ||
    nextPreflight.verdict !== "PASS" ||
    nextPreflight.candidate.requestedSlot !== 2 ||
    nextPreflight.effects.privateStateWritten !== false ||
    nextPreflight.effects.raspberryEvidenceConsumed !== false ||
    canonicalJson(report).includes("SELFTEST0001") ||
    canonicalJson(duplicatePreflight).includes(digest) ||
    canonicalJson(nextPreflight).includes(nextDigest) ||
    canonicalJson(report).includes(state.identityKeyBase64Url) ||
    canonicalJson(report).includes(digest)
  ) {
    fail("SELF_TEST_FAILED", "B4 physical-evidence collector self-test failed");
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B4_COLLECTION_HARNESS_VERSION,
    product: "V5BT",
    phase: "B4.4",
    generatedAt: now,
    mode: "SELF_TEST",
    verdict: "PASS",
    checksPassed: 13,
    syntheticRecordsEvaluated: 1,
    physicalEvidenceConsumed: false,
    privateStateWritten: false,
    authoritativeB4GateExecuted: false,
    b4GatePromoted: false,
    activeV4Changes: false
  });
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = validateOptions(parseArguments(argv));
    if (options.mode === "HELP") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.mode === "SELF_TEST") {
      writeJson(null, runSelfTest());
      return 0;
    }
    if (options.mode === "INIT") {
      await withB4CollectionStateLock(options.state, async () => {
        if (fs.existsSync(options.state)) {
          fail("STATE_ALREADY_EXISTS", "Private gate state already exists");
        }
        const state = createInitialState();
        await withStableCertificationMatrix(state, async () => undefined);
        atomicWrite(options.state, `${JSON.stringify(state, null, 2)}\n`);
        writeJson(
          options.output,
          buildProgressReport(state, { operation: "INIT" })
        );
      });
      return 0;
    }
    if (options.mode === "STATUS") {
      writeJson(
        options.output,
        buildProgressReport(readState(options.state))
      );
      return 0;
    }
    if (options.mode === "PREFLIGHT") {
      const report = await withStableReadOnlyState(options.state, async (state) =>
        withStableCertificationMatrix(state, async () =>
          preflightPhysicalCandidate(options, state)
        )
      );
      writeJson(options.output, report);
      return report.candidate.eligibleForNextSlot ? 0 : 2;
    }
    if (options.mode === "FINALIZE") {
      await withB4CollectionStateLock(options.state, async () => {
        const state = readState(options.state);
        const { report, manifest } = await withStableCertificationMatrix(
          state,
          async () => ({
            report: buildManifestReadyReport(state, {
              generatedAt: state.updatedAt
            }),
            manifest: buildEvidenceManifest(
              state,
              options.state,
              options.manifest
            )
          })
        );
        const collectorReportPath = path.join(
          path.dirname(options.manifest),
          COLLECTOR_REPORT_FILE
        );
        const collectorReportText = `${JSON.stringify(report, null, 2)}\n`;
        const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
        const finalArtifacts = [
          [
            collectorReportPath,
            collectorReportText,
            sha256(Buffer.from(collectorReportText, "utf8"))
          ],
          [
            options.manifest,
            manifestText,
            sha256(Buffer.from(manifestText, "utf8"))
          ]
        ];
        preflightFinalArtifacts(finalArtifacts);
        writeOrVerifyEvidence(
          collectorReportPath,
          collectorReportText,
          finalArtifacts[0][2]
        );
        writeOrVerifyEvidence(
          options.manifest,
          manifestText,
          finalArtifacts[1][2]
        );
        writeJson(options.output, report);
      });
      return 0;
    }
    await withB4CollectionStateLock(options.state, async () => {
      const stateSnapshot = readStateSnapshot(options.state);
      const state = stateSnapshot.state;
      const collection = await withStableCertificationMatrix(
        state,
        async () => collectPhysicalRecord(options, state)
      );
      const { result } = collection;
      assertStateCertificationMatrixBinding(state);
      assertCollectionStateUnchanged(
        options.state,
        stateSnapshot.fingerprint
      );
      persistCaptureEvidence(
        options.state,
        result.record,
        collection.reportText,
        collection.rawLog,
        collection.androidMonitorText,
        collection.raspberryMonitorText,
        { replaceUncommitted: result.status === "RECORDED" }
      );
      assertCollectionStateUnchanged(
        options.state,
        stateSnapshot.fingerprint
      );
      if (result.status === "RECORDED") {
        atomicWrite(
          options.state,
          `${JSON.stringify(result.state, null, 2)}\n`
        );
      }
      writeJson(
        options.output,
        buildProgressReport(result.state, { operation: result.status })
      );
    });
    return 0;
  } catch (error) {
    const safeError =
      error instanceof B4PhysicalCollectionError
        ? error
        : new B4PhysicalCollectionError(
            "B4_COLLECTION_FAILED",
            "B4 physical-evidence collector failed"
          );
    writeJson(options?.output ?? null, {
      schemaVersion: 1,
      harnessVersion: B4_COLLECTION_HARNESS_VERSION,
      product: "V5BT",
      phase: "B4",
      generatedAt: new Date().toISOString(),
      mode: STATE_MODE,
      verdict: "FAIL",
      failure: {
        code: safeError.code,
        message: safeError.message
      },
      activeV4Changes: false
    });
    return safeError.exitCode;
  }
}

const invokedPath =
  process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (
  invokedPath !== null &&
  fs.existsSync(invokedPath) &&
  fs.realpathSync(fileURLToPath(import.meta.url)) ===
    fs.realpathSync(invokedPath)
) {
  process.exitCode = await main();
}
