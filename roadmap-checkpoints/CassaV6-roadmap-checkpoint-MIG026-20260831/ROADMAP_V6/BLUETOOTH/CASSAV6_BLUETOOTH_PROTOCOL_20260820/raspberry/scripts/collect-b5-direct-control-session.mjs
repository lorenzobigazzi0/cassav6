#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DeviceRegistryV2 } from "../../shared/provisioning/device-registry-v2.mjs";
import {
  B5AccountDeviceCommitmentError,
  b5AccountDeviceBindingFromPrivateBaseline,
  createB5AccountDeviceCommitmentSha256,
  parseB5AccountDeviceBinding,
  validB5AccountDeviceBindingFixture
} from "../../scripts/b5-account-device-commitment.mjs";
import {
  parsePrivateBaseline
} from "../../scripts/run-b5-android-continuity-monitor.mjs";
import { loadBluezNodeConfig } from "../dist/config/NodeConfig.js";
import {
  runPhysicalDirectControlSmoke,
  runSelfTest as runDirectControlSelfTest
} from "./run-b5-direct-control-smoke.mjs";
import {
  B5HundredSessionGateError,
  B5_REQUIRED_SESSION_REPORTS,
  assertAggregateReportRedacted,
  parseEvidenceManifest,
  validPhysicalReportFixture,
  validatePhysicalSessionReport
} from "./run-b5-hundred-session-gate.mjs";

export const B5_SESSION_COLLECTOR_VERSION = "1.2.0";
export const API31_STAGING_HARNESS_VERSION = "1.0.0";

const STATE_MODE = "PHYSICAL_HUNDRED_SESSION_COLLECTION";
const STATE_SCHEMA_VERSION = 3;
const PREVIOUS_STATE_SCHEMA_VERSION = 2;
const PREVIOUS_COLLECTOR_VERSION = "1.1.0";
const LEGACY_STATE_SCHEMA_VERSION = 1;
const LEGACY_COLLECTOR_VERSION = "1.0.0";
const MANIFEST_GATE = "B5_HUNDRED_ANDROID_RASPBERRY_SESSIONS";
const PHYSICAL_RUNNER = "B5_DIRECT_CONTROL_SMOKE_V1";
const SERVER_CAPABILITIES = 72;
const DEFAULT_HOLD_MS = 60_000;
const RADIO_LOCK_DIRECTORY = "/var/lib/cassav6-bluetooth";
const RADIO_LOCK_PREFIX = ".b5-direct-control-radio-";
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_STAGING_REGISTRY_BYTES = 256 * 1024;
const MAX_CLOCK_SKEW_MS = 5_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ADAPTER_PATTERN = /^hci[0-9]+$/u;
const NODE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const execFileAsync = promisify(execFile);
const API31_STAGING_MODES = new Set([
  "API31_STAGING_REGISTRY_COPY",
  "API31_STAGING_PREFLIGHT",
  "API31_STAGING_SESSION"
]);

const STATE_FIELDS = [
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

const PREVIOUS_STATE_FIELDS = STATE_FIELDS.filter(
  (field) => field !== "accountDeviceCommitmentSha256"
);

const LEGACY_STATE_FIELDS = PREVIOUS_STATE_FIELDS.filter(
  (field) => field !== "lastCaptureBootId"
);

const RECORD_FIELDS = [
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

const PREVIOUS_RECORD_FIELDS = RECORD_FIELDS.filter(
  (field) => field !== "accountDeviceCommitmentSha256"
);

const JOURNAL_FIELDS = [
  "schemaVersion",
  "harnessVersion",
  "product",
  "phase",
  "mode",
  "campaignRunId",
  "record"
];

export class B5SessionCollectionError extends Error {
  constructor(code, message, exitCode = 1, options = undefined) {
    super(message, options);
    this.name = "B5SessionCollectionError";
    this.code = code;
    this.exitCode = exitCode;
    this.cleanupVerified = options?.cleanupVerified === true;
  }
}

function fail(code, message, exitCode = 1, options = undefined) {
  throw new B5SessionCollectionError(code, message, exitCode, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactFields(value, expected, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be a JSON object`);
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

function requireEqual(actual, expected, code, message) {
  if (actual !== expected) fail(code, message);
  return actual;
}

function requireInteger(value, minimum, maximum, code, message) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
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

function requireUuid(value, code, message) {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    fail(code, message);
  }
  return value;
}

function parseJsonObject(raw, code, message) {
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) fail(code, message);
    return parsed;
  } catch (error) {
    if (error instanceof B5SessionCollectionError) throw error;
    fail(code, message);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalSlot(sequence) {
  return String(sequence).padStart(3, "0");
}

function collectionCommitment(records) {
  return sha256(records.map((record) => record.reportSha256).join("\n"));
}

function assertNoSymlinkComponents(location, code) {
  const resolved = path.resolve(location);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const status = fs.lstatSync(current);
      if (status.isSymbolicLink()) {
        fail(code, "Private artifact paths must not contain symbolic links");
      }
      if (index < parts.length - 1 && !status.isDirectory()) {
        fail(code, "Private artifact parent is not a directory");
      }
    } catch (error) {
      if (error?.code === "ENOENT") return resolved;
      if (error instanceof B5SessionCollectionError) throw error;
      fail(code, "Private artifact path cannot be inspected safely");
    }
  }
  return resolved;
}

function ensurePrivateDirectory(directory) {
  const resolved = assertNoSymlinkComponents(
    directory,
    "PRIVATE_DIRECTORY_INVALID"
  );
  try {
    let existed = true;
    try {
      fs.lstatSync(resolved);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      existed = false;
    }
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const status = fs.lstatSync(resolved);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      fail("PRIVATE_DIRECTORY_INVALID", "Private artifact directory is invalid");
    }
    if (fs.realpathSync(resolved) !== resolved) {
      fail("PRIVATE_DIRECTORY_INVALID", "Private artifact directory is not canonical");
    }
    if (process.platform === "linux") {
      if (existed && (status.mode & 0o777) !== 0o700) {
        fail(
          "PRIVATE_DIRECTORY_NOT_PRIVATE",
          "Private artifact directory must use owner-only mode 0700"
        );
      }
      if (!existed) fs.chmodSync(resolved, 0o700);
    }
    return resolved;
  } catch (error) {
    if (error instanceof B5SessionCollectionError) throw error;
    fail("PRIVATE_DIRECTORY_INVALID", "Private artifact directory is unavailable");
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    fail(
      "DURABILITY_SYNC_FAILED",
      "Private artifact directory could not be synchronized",
      1,
      { cause: error }
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertWritableDestination(destination, allowExisting) {
  assertNoSymlinkComponents(destination, "OUTPUT_PATH_INVALID");
  try {
    const status = fs.lstatSync(destination);
    if (!status.isFile() || status.isSymbolicLink()) {
      fail("OUTPUT_PATH_INVALID", "Output destination is not a regular file");
    }
    if (!allowExisting) {
      fail("OUTPUT_ALREADY_EXISTS", "Output destination already exists");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error instanceof B5SessionCollectionError) throw error;
    fail("OUTPUT_PATH_INVALID", "Output destination is invalid");
  }
}

function atomicWrite(destination, content, { allowExisting = true } = {}) {
  const parent = ensurePrivateDirectory(path.dirname(destination));
  assertWritableDestination(destination, allowExisting);
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    if (process.platform === "linux") fs.chmodSync(destination, 0o600);
    fsyncDirectory(parent);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function preflightPublicOutput(destination) {
  if (destination === null) return;
  assertWritableDestination(destination, true);
  const parent = ensurePrivateDirectory(path.dirname(destination));
  const probe = `${destination}.preflight-${process.pid}-${crypto.randomUUID()}`;
  let descriptor;
  try {
    descriptor = fs.openSync(probe, "wx", 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.unlinkSync(probe);
    fsyncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      descriptor = undefined;
    }
    fs.rmSync(probe, { force: true });
    if (error instanceof B5SessionCollectionError) throw error;
    fail("OUTPUT_PATH_INVALID", "Output destination is not writable", 1, {
      cause: error
    });
  }
}

function readBoundedRegularFile(
  location,
  maximumBytes,
  code,
  label,
  { privateMode = false, singleLink = false } = {}
) {
  assertNoSymlinkComponents(location, code);
  const noFollow = process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0;
  const nonBlock = process.platform === "linux" ? fs.constants.O_NONBLOCK ?? 0 : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(
      location,
      fs.constants.O_RDONLY | noFollow | nonBlock
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) {
      fail(code, `${label} is not a bounded regular file`);
    }
    if (
      privateMode &&
      process.platform === "linux" &&
      (before.mode & 0o777) !== 0o600
    ) {
      fail(code, `${label} must use owner-only mode 0600`);
    }
    if (singleLink && before.nlink !== 1) {
      fail(code, `${label} must not use hard links`);
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
      fail(code, `${label} changed while it was being read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof B5SessionCollectionError) throw error;
    fail(code, `${label} cannot be read safely`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeExclusivePrivateSnapshot(destination, content) {
  const parent = ensurePrivateDirectory(path.dirname(destination));
  assertWritableDestination(destination, false);
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor;
  let linked = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, destination);
    linked = true;
    fs.unlinkSync(temporary);
    if (process.platform === "linux") fs.chmodSync(destination, 0o600);
    const status = fs.lstatSync(destination);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      (process.platform === "linux" && (status.mode & 0o777) !== 0o600)
    ) {
      fail(
        "STAGING_REGISTRY_WRITE_FAILED",
        "Staging snapshot did not commit as a private regular file"
      );
    }
    fsyncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      descriptor = undefined;
    }
    fs.rmSync(temporary, { force: true });
    if (linked) fs.rmSync(destination, { force: true });
    if (error instanceof B5SessionCollectionError) throw error;
    if (error?.code === "EEXIST") {
      fail(
        "STAGING_REGISTRY_CONFLICT",
        "Staging snapshot destination already exists"
      );
    }
    fail(
      "STAGING_REGISTRY_WRITE_FAILED",
      "Staging snapshot could not be committed safely",
      1,
      { cause: error }
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function requireApi31StagingLocation(location, label) {
  if (
    typeof location !== "string" ||
    !path.isAbsolute(location) ||
    !location.toLowerCase().includes("cassav6")
  ) {
    fail(
      "STAGING_REGISTRY_PATH_INVALID",
      `${label} must be an absolute isolated V6 location`
    );
  }
  return path.resolve(location);
}

function validateApi31RegistryInspection(value) {
  const inspection = requireExactFields(
    value,
    [
      "schemaVersion",
      "kind",
      "createdAt",
      "updatedAt",
      "devices",
      "enrollmentTokens"
    ],
    "STAGING_REGISTRY_INVALID",
    "Staging registry inspection"
  );
  requireEqual(
    inspection.schemaVersion,
    2,
    "STAGING_REGISTRY_INVALID",
    "Staging registry must use schema version 2"
  );
  requireEqual(
    inspection.kind,
    "cassav6.bluetooth.device-registry",
    "STAGING_REGISTRY_INVALID",
    "Staging registry kind is invalid"
  );
  if (!Array.isArray(inspection.devices) || !Array.isArray(inspection.enrollmentTokens)) {
    fail("STAGING_REGISTRY_INVALID", "Staging registry inventory is invalid");
  }

  const activeDevices = inspection.devices.filter(
    (device) => isRecord(device) && device.revokedAt === null
  );
  const activeP256Devices = activeDevices.filter(
    (device) => device.publicKeyAlgorithm === "EC-P256"
  );
  const consumedV2Nodes = new Set(
    inspection.enrollmentTokens
      .filter(
        (token) =>
          isRecord(token) &&
          token.protocolVersion === 2 &&
          token.status === "CONSUMED" &&
          token.consumedAt !== null &&
          typeof token.consumedByNodeId === "string"
      )
      .map((token) => token.consumedByNodeId)
  );
  const boundP256Devices = activeP256Devices.filter((device) =>
    consumedV2Nodes.has(device.nodeId)
  );
  if (activeP256Devices.length === 0 || boundP256Devices.length === 0) {
    fail(
      "STAGING_P256_IDENTITY_UNAVAILABLE",
      "Staging registry has no active P-256 identity bound to enrollment v2"
    );
  }
  return Object.freeze({
    schemaVersion: 2,
    activeIdentityCount: activeDevices.length,
    activeP256IdentityCount: activeP256Devices.length,
    boundEnrollmentV2IdentityCount: boundP256Devices.length
  });
}

export async function inspectApi31StagingRegistry(
  registryPath,
  runtime = {}
) {
  const resolved = requireApi31StagingLocation(
    registryPath,
    "Staging registry"
  );
  const readRegistry =
    runtime.readRegistry ??
    ((location) =>
      readBoundedRegularFile(
        location,
        MAX_STAGING_REGISTRY_BYTES,
        "STAGING_REGISTRY_INVALID",
        "Staging registry",
        { privateMode: true, singleLink: true }
      ));
  const before = readRegistry(resolved);
  const registry = runtime.registry ?? new DeviceRegistryV2(resolved);
  let inspection;
  try {
    inspection = await registry.inspect();
  } catch (error) {
    fail(
      "STAGING_REGISTRY_INVALID",
      "Staging registry cannot be inspected safely",
      1,
      { cause: error }
    );
  }
  const summary = validateApi31RegistryInspection(inspection);
  const after = readRegistry(resolved);
  if (!Buffer.from(before).equals(Buffer.from(after))) {
    fail(
      "STAGING_REGISTRY_CHANGED",
      "Staging registry changed during read-only inspection"
    );
  }
  return summary;
}

function api31StagingRegistryReport(summary, created, generatedAt) {
  const report = Object.freeze({
    schemaVersion: 1,
    harnessVersion: API31_STAGING_HARNESS_VERSION,
    product: "V6",
    phase: "B5.7",
    generatedAt,
    mode: "API31_STAGING_REGISTRY_COPY",
    verdict: "READY",
    checks: Object.freeze({
      byteExactSnapshot: "PASS",
      ownerOnlyMode: "PASS",
      symlinkAndHardlinkProtection: "PASS",
      registrySchemaV2: "PASS",
      activeP256EnrollmentV2Identity: "PASS",
      overwriteProtection: "PASS"
    }),
    registry: Object.freeze({
      schemaVersion: summary.schemaVersion,
      activeIdentityCount: summary.activeIdentityCount,
      activeP256IdentityCount: summary.activeP256IdentityCount,
      boundEnrollmentV2IdentityCount:
        summary.boundEnrollmentV2IdentityCount,
      snapshotCreated: created
    }),
    physicalRadioAccessed: false,
    physicalEvidenceConsumed: false,
    authoritativeB5GateExecuted: false,
    b5GatePromoted: false,
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
      sourceReportDetailsIncluded: false
    }),
    v6ProductionServiceChanges: false
  });
  assertAggregateReportRedacted(report);
  return report;
}

export async function prepareApi31StagingRegistrySnapshot(
  sourceRegistryPath,
  stagingRegistryPath,
  runtime = {}
) {
  const source = requireApi31StagingLocation(
    sourceRegistryPath,
    "Source registry"
  );
  const destination = requireApi31StagingLocation(
    stagingRegistryPath,
    "Staging registry"
  );
  if (normalizedPath(source) === normalizedPath(destination)) {
    fail(
      "STAGING_REGISTRY_PATH_INVALID",
      "Source and staging registry must use distinct locations"
    );
  }
  const readSource =
    runtime.readSource ??
    ((location) =>
      readBoundedRegularFile(
        location,
        MAX_STAGING_REGISTRY_BYTES,
        "STAGING_REGISTRY_SOURCE_INVALID",
        "Source registry",
        { privateMode: true, singleLink: true }
      ));
  const sourceBytes = Buffer.from(readSource(source));
  let created = false;
  try {
    if (fileExistsWithoutFollowing(destination)) {
      const existing = readBoundedRegularFile(
        destination,
        MAX_STAGING_REGISTRY_BYTES,
        "STAGING_REGISTRY_CONFLICT",
        "Existing staging registry",
        { privateMode: true, singleLink: true }
      );
      if (!sourceBytes.equals(existing)) {
        fail(
          "STAGING_REGISTRY_CONFLICT",
          "Existing staging registry differs from the source snapshot"
        );
      }
    } else {
      const writer = runtime.writeSnapshot ?? writeExclusivePrivateSnapshot;
      writer(destination, sourceBytes);
      created = true;
    }
    const inspector =
      runtime.inspectStagingRegistry ?? inspectApi31StagingRegistry;
    const summary = await inspector(destination);
    const copiedBytes = readBoundedRegularFile(
      destination,
      MAX_STAGING_REGISTRY_BYTES,
      "STAGING_REGISTRY_INVALID",
      "Copied staging registry",
      { privateMode: true, singleLink: true }
    );
    if (!sourceBytes.equals(copiedBytes)) {
      fail(
        "STAGING_REGISTRY_CHANGED",
        "Staging registry is not a byte-exact source snapshot"
      );
    }
    const generatedAt = runtime.now?.() ?? new Date().toISOString();
    requireTimestamp(
      generatedAt,
      "STAGING_CLOCK_INVALID",
      "Staging clock returned an invalid timestamp"
    );
    return api31StagingRegistryReport(summary, created, generatedAt);
  } catch (error) {
    if (created) {
      removePrivateFile(destination, "STAGING_REGISTRY_CLEANUP_FAILED");
    }
    throw error;
  }
}

function removePrivateFile(location, code) {
  try {
    const status = fs.lstatSync(location);
    if (!status.isFile() || status.isSymbolicLink()) {
      fail(code, "Private transaction artifact is invalid");
    }
    fs.unlinkSync(location);
    fsyncDirectory(path.dirname(location));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error instanceof B5SessionCollectionError) throw error;
    fail(code, "Private transaction artifact cannot be removed safely");
  }
}

function translateGateError(error) {
  if (error instanceof B5SessionCollectionError) return error;
  if (error instanceof B5AccountDeviceCommitmentError) {
    return new B5SessionCollectionError(error.code, error.message, 1, {
      cause: error
    });
  }
  if (
    isRecord(error) &&
    error.code === "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT"
  ) {
    return new B5SessionCollectionError(
      "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
      "Physical capture ended before a clean direct-control close",
      1,
      { cause: error, cleanupVerified: error.cleanupVerified === true }
    );
  }
  if (isRecord(error) && error.code === "PHYSICAL_CAPTURE_ABORTED") {
    return new B5SessionCollectionError(
      "CAPTURE_ABORTED",
      "Physical collection was interrupted",
      130,
      { cause: error }
    );
  }
  if (error instanceof B5HundredSessionGateError) {
    return new B5SessionCollectionError(error.code, error.message, 1, {
      cause: error
    });
  }
  return new B5SessionCollectionError(
    "B5_SESSION_COLLECTION_FAILED",
    "B5 physical-session collection failed",
    1,
    { cause: error }
  );
}

function validateStateRecord(record, sequence, { bound = true } = {}) {
  requireExactFields(
    record,
    bound ? RECORD_FIELDS : PREVIOUS_RECORD_FIELDS,
    "STATE_INVALID",
    `private state record ${canonicalSlot(sequence)}`
  );
  requireInteger(
    record.sequence,
    1,
    B5_REQUIRED_SESSION_REPORTS,
    "STATE_INVALID",
    "Private state record sequence is invalid"
  );
  requireEqual(
    record.sequence,
    sequence,
    "STATE_INVALID",
    "Private state sequences must be contiguous"
  );
  requireEqual(
    record.slot,
    canonicalSlot(sequence),
    "STATE_INVALID",
    "Private state slots must be canonical"
  );
  requireUuid(
    record.evidenceRecordId,
    "STATE_INVALID",
    "Private evidence record identifier is invalid"
  );
  requireEqual(
    record.runner,
    PHYSICAL_RUNNER,
    "STATE_INVALID",
    "Private evidence runner is invalid"
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
      fail("STATE_INVALID", `Private state field ${field} is invalid`);
    }
  }
  const generatedAtMs = requireTimestamp(
    record.generatedAt,
    "STATE_INVALID",
    "Private report timestamp is invalid"
  );
  const captureStartedAtMs = requireTimestamp(
    record.captureStartedAt,
    "STATE_INVALID",
    "Private capture start is invalid"
  );
  const captureCompletedAtMs = requireTimestamp(
    record.captureCompletedAt,
    "STATE_INVALID",
    "Private capture completion is invalid"
  );
  const sessionStartedAtMs = requireTimestamp(
    record.sessionStartedAt,
    "STATE_INVALID",
    "Private session start is invalid"
  );
  const durationMs = requireInteger(
    record.durationMs,
    1,
    Number.MAX_SAFE_INTEGER,
    "STATE_INVALID",
    "Private session duration is invalid"
  );
  if (sessionStartedAtMs !== generatedAtMs - durationMs) {
    fail("STATE_INVALID", "Private session window is inconsistent");
  }
  if (
    captureCompletedAtMs < captureStartedAtMs ||
    generatedAtMs < captureStartedAtMs - MAX_CLOCK_SKEW_MS ||
    generatedAtMs > captureCompletedAtMs + MAX_CLOCK_SKEW_MS
  ) {
    fail("STATE_INVALID", "Private runner provenance window is inconsistent");
  }
  requireInteger(
    record.pingsSent,
    4,
    Number.MAX_SAFE_INTEGER,
    "STATE_INVALID",
    "Private PING count is invalid"
  );
  requireInteger(
    record.pongsVerified,
    4,
    Number.MAX_SAFE_INTEGER,
    "STATE_INVALID",
    "Private PONG count is invalid"
  );
  requireInteger(
    record.heartbeatMisses,
    0,
    Number.MAX_SAFE_INTEGER,
    "STATE_INVALID",
    "Private heartbeat miss count is invalid"
  );
  if (record.pongsVerified > record.pingsSent) {
    fail("STATE_INVALID", "Private heartbeat counters are inconsistent");
  }
  return Object.freeze({
    generatedAtMs,
    captureStartedAtMs,
    captureCompletedAtMs,
    sessionStartedAtMs
  });
}

function parseCollectorStateValue(
  value,
  {
    fields = STATE_FIELDS,
    schemaVersion = STATE_SCHEMA_VERSION,
    harnessVersion = B5_SESSION_COLLECTOR_VERSION,
    legacy = false,
    bound = true
  } = {}
) {
  const state = typeof value === "string"
    ? parseJsonObject(value, "STATE_INVALID", "Private state is not valid JSON")
    : value;
  requireExactFields(state, fields, "STATE_INVALID", "private state");
  for (const [field, expected] of [
    ["schemaVersion", schemaVersion],
    ["harnessVersion", harnessVersion],
    ["product", "V6"],
    ["phase", "B5"],
    ["mode", STATE_MODE],
    ["requiredSessions", B5_REQUIRED_SESSION_REPORTS]
  ]) {
    requireEqual(
      state[field],
      expected,
      "STATE_INVALID",
      `Private state field ${field} is invalid`
    );
  }
  requireUuid(
    state.campaignRunId,
    "STATE_INVALID",
    "Private campaign identifier is invalid"
  );
  const createdAtMs = requireTimestamp(
    state.createdAt,
    "STATE_INVALID",
    "Private state creation timestamp is invalid"
  );
  const updatedAtMs = requireTimestamp(
    state.updatedAt,
    "STATE_INVALID",
    "Private state update timestamp is invalid"
  );
  if (updatedAtMs < createdAtMs) {
    fail("STATE_INVALID", "Private state update predates creation");
  }
  if (
    typeof state.collectionCommitmentSha256 !== "string" ||
    !SHA256_PATTERN.test(state.collectionCommitmentSha256) ||
    !Array.isArray(state.records) ||
    state.records.length > B5_REQUIRED_SESSION_REPORTS
  ) {
    fail("STATE_INVALID", "Private state collection metadata is invalid");
  }
  if (
    bound &&
    (typeof state.accountDeviceCommitmentSha256 !== "string" ||
      !SHA256_PATTERN.test(state.accountDeviceCommitmentSha256) ||
      /^0{64}$/u.test(state.accountDeviceCommitmentSha256))
  ) {
    fail("STATE_INVALID", "Private account/device commitment is invalid");
  }
  if (legacy && state.records.length > 0) {
    fail(
      "STATE_LEGACY_NONEMPTY",
      "A legacy collector state containing sessions cannot be upgraded"
    );
  }
  if (!legacy) {
    if (
      state.lastCaptureBootId !== null &&
      (!Number.isSafeInteger(state.lastCaptureBootId) ||
        state.lastCaptureBootId < 1 ||
        state.lastCaptureBootId > 255)
    ) {
      fail("STATE_INVALID", "Private capture continuity metadata is invalid");
    }
    if (state.records.length > 0 && state.lastCaptureBootId === null) {
      fail("STATE_INVALID", "Private capture continuity metadata is missing");
    }
  }

  const digests = new Set();
  const timestamps = new Set();
  const recordIds = new Set();
  let firstTarget = null;
  let previous = null;
  state.records.forEach((record, index) => {
    const timing = validateStateRecord(record, index + 1, { bound });
    if (
      digests.has(record.reportSha256) ||
      timestamps.has(record.generatedAt) ||
      recordIds.has(record.evidenceRecordId)
    ) {
      fail("STATE_INVALID", "Private state contains duplicate evidence");
    }
    digests.add(record.reportSha256);
    timestamps.add(record.generatedAt);
    recordIds.add(record.evidenceRecordId);
    if (firstTarget === null) firstTarget = record.targetSignatureSha256;
    if (record.targetSignatureSha256 !== firstTarget) {
      fail("STATE_INVALID", "Private state target changes between sessions");
    }
    if (
      bound &&
      record.accountDeviceCommitmentSha256 !==
        state.accountDeviceCommitmentSha256
    ) {
      fail(
        "STATE_INVALID",
        "Private account/device commitment changes between sessions"
      );
    }
    if (previous !== null) {
      if (timing.generatedAtMs <= previous.generatedAtMs) {
        fail("STATE_INVALID", "Private state timestamps are out of order");
      }
      if (timing.sessionStartedAtMs < previous.generatedAtMs) {
        fail("STATE_INVALID", "Private state session windows overlap");
      }
      if (timing.captureStartedAtMs < previous.captureCompletedAtMs) {
        fail("STATE_INVALID", "Private physical runner invocations overlap");
      }
    }
    previous = timing;
  });
  const expectedUpdatedAt =
    state.records.length === 0
      ? state.createdAt
      : state.records.at(-1).captureCompletedAt;
  if (state.updatedAt !== expectedUpdatedAt) {
    fail(
      "STATE_INVALID",
      "Private state update timestamp is not bound to its record inventory"
    );
  }
  if (state.collectionCommitmentSha256 !== collectionCommitment(state.records)) {
    fail("STATE_INVALID", "Private collection commitment is invalid");
  }
  return state;
}

export function parseCollectorState(value) {
  const state = typeof value === "string"
    ? parseJsonObject(value, "STATE_INVALID", "Private state is not valid JSON")
    : value;
  if (
    state?.schemaVersion === PREVIOUS_STATE_SCHEMA_VERSION &&
    state?.harnessVersion === PREVIOUS_COLLECTOR_VERSION
  ) {
    return parseCollectorStateValue(state, {
      fields: PREVIOUS_STATE_FIELDS,
      schemaVersion: PREVIOUS_STATE_SCHEMA_VERSION,
      harnessVersion: PREVIOUS_COLLECTOR_VERSION,
      bound: false
    });
  }
  if (
    state?.schemaVersion === LEGACY_STATE_SCHEMA_VERSION &&
    state?.harnessVersion === LEGACY_COLLECTOR_VERSION
  ) {
    return parseCollectorStateValue(state, {
      fields: LEGACY_STATE_FIELDS,
      schemaVersion: LEGACY_STATE_SCHEMA_VERSION,
      harnessVersion: LEGACY_COLLECTOR_VERSION,
      legacy: true,
      bound: false
    });
  }
  return parseCollectorStateValue(state);
}

function collectorStateHasAccountDeviceBinding(state) {
  return (
    state.schemaVersion === STATE_SCHEMA_VERSION &&
    state.harnessVersion === B5_SESSION_COLLECTOR_VERSION
  );
}

function parseCollectorStateCandidate(value) {
  const state = typeof value === "string"
    ? parseJsonObject(value, "STATE_INVALID", "Private state is not valid JSON")
    : value;
  const parsed = parseCollectorState(state);
  return Object.freeze({
    state: parsed,
    migrationRequired: false,
    legacyUnbound: !collectorStateHasAccountDeviceBinding(parsed)
  });
}

export function createInitialCollectorState(
  {
    now = new Date().toISOString(),
    campaignRunId = undefined,
    accountDeviceBinding
  } = {}
) {
  let binding;
  try {
    binding = parseB5AccountDeviceBinding(accountDeviceBinding);
  } catch (error) {
    throw translateGateError(error);
  }
  campaignRunId ??= binding.campaignId;
  requireTimestamp(now, "STATE_INVALID", "Initial state timestamp is invalid");
  requireUuid(
    campaignRunId,
    "STATE_INVALID",
    "Initial campaign identifier is invalid"
  );
  if (campaignRunId !== binding.campaignId) {
    fail(
      "ACCOUNT_DEVICE_CAMPAIGN_MISMATCH",
      "Initial collector campaign does not match its account/device binding"
    );
  }
  const accountDeviceCommitmentSha256 =
    createB5AccountDeviceCommitmentSha256(binding);
  const records = Object.freeze([]);
  return Object.freeze({
    schemaVersion: STATE_SCHEMA_VERSION,
    harnessVersion: B5_SESSION_COLLECTOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: STATE_MODE,
    campaignRunId,
    createdAt: now,
    updatedAt: now,
    requiredSessions: B5_REQUIRED_SESSION_REPORTS,
    lastCaptureBootId: null,
    accountDeviceCommitmentSha256,
    collectionCommitmentSha256: collectionCommitment(records),
    records
  });
}

export function reserveCaptureBootId(
  currentState,
  { randomInt = crypto.randomInt } = {}
) {
  const state = assertCollectionAcceptsCapture(currentState);
  let bootId;
  do {
    bootId = randomInt(1, 256);
    requireInteger(
      bootId,
      1,
      255,
      "BOOT_ID_GENERATION_FAILED",
      "The capture boot identifier generator returned an invalid value"
    );
  } while (bootId === state.lastCaptureBootId);
  const nextState = Object.freeze({
    ...state,
    lastCaptureBootId: bootId
  });
  parseCollectorState(nextState);
  return Object.freeze({ state: nextState, bootId });
}

function validateReportBytes(bytes, sequence) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1) {
    fail("REPORT_INVALID", "Physical runner did not return a report");
  }
  if (bytes.byteLength > MAX_REPORT_BYTES) {
    fail("REPORT_INVALID", "Physical runner report exceeds the size limit");
  }
  const reportSha256 = sha256(bytes);
  const report = parseJsonObject(
    bytes.toString("utf8"),
    "REPORT_SCHEMA_INVALID",
    "Physical runner report is not valid JSON"
  );
  try {
    const validated = validatePhysicalSessionReport({
      sequence,
      sourceReportSha256: reportSha256,
      report
    });
    return Object.freeze({ reportSha256, report, validated });
  } catch (error) {
    throw translateGateError(error);
  }
}

function evidenceMetadata(
  validated,
  provenance,
  accountDeviceCommitmentSha256
) {
  const captureStartedAtMs = requireTimestamp(
    provenance.captureStartedAt,
    "RUNNER_PROVENANCE_INVALID",
    "Physical runner start timestamp is invalid"
  );
  const captureCompletedAtMs = requireTimestamp(
    provenance.captureCompletedAt,
    "RUNNER_PROVENANCE_INVALID",
    "Physical runner completion timestamp is invalid"
  );
  if (
    captureCompletedAtMs < captureStartedAtMs ||
    validated.generatedAtMs < captureStartedAtMs - MAX_CLOCK_SKEW_MS ||
    validated.generatedAtMs > captureCompletedAtMs + MAX_CLOCK_SKEW_MS
  ) {
    fail(
      "RUNNER_PROVENANCE_INVALID",
      "Physical report was not created by the current runner invocation"
    );
  }
  return Object.freeze({
    sequence: validated.sequence,
    slot: canonicalSlot(validated.sequence),
    evidenceRecordId: provenance.evidenceRecordId,
    runner: PHYSICAL_RUNNER,
    reportSha256: validated.sourceReportSha256,
    generatedAt: validated.generatedAt,
    captureStartedAt: provenance.captureStartedAt,
    captureCompletedAt: provenance.captureCompletedAt,
    sessionStartedAt: new Date(validated.captureStartMs).toISOString(),
    durationMs: validated.durationMs,
    pingsSent: validated.pingsSent,
    pongsVerified: validated.pongsVerified,
    heartbeatMisses: validated.heartbeatMisses,
    targetSignatureSha256: sha256(validated.targetSignature),
    accountDeviceCommitmentSha256
  });
}

function assertEvidenceMatchesRecord(record, validated) {
  const comparable = {
    sequence: validated.sequence,
    slot: canonicalSlot(validated.sequence),
    reportSha256: validated.sourceReportSha256,
    generatedAt: validated.generatedAt,
    sessionStartedAt: new Date(validated.captureStartMs).toISOString(),
    durationMs: validated.durationMs,
    pingsSent: validated.pingsSent,
    pongsVerified: validated.pongsVerified,
    heartbeatMisses: validated.heartbeatMisses,
    targetSignatureSha256: sha256(validated.targetSignature)
  };
  for (const [field, value] of Object.entries(comparable)) {
    if (record[field] !== value) {
      fail(
        "STATE_EVIDENCE_MISMATCH",
        "Staged evidence no longer matches the private collector state"
      );
    }
  }
}

function assertEvidenceDigest(bytes, record) {
  if (sha256(bytes) !== record.reportSha256) {
    fail("PRIVATE_EVIDENCE_HASH_MISMATCH", "Private staged evidence was modified");
  }
}

function appendCapturedSession(currentState, reportBytes, provenance) {
  const state = parseCollectorState(currentState);
  if (state.records.length === B5_REQUIRED_SESSION_REPORTS) {
    fail("COLLECTION_COMPLETE", "The B5 collection already contains 100 sessions", 2);
  }
  requireUuid(
    provenance.evidenceRecordId,
    "RUNNER_PROVENANCE_INVALID",
    "Physical evidence record identifier is invalid"
  );
  const candidate = validateReportBytes(reportBytes, state.records.length + 1);
  const record = evidenceMetadata(
    candidate.validated,
    provenance,
    state.accountDeviceCommitmentSha256
  );
  const previous = state.records.at(-1) ?? null;
  if (state.records.some((entry) => entry.reportSha256 === record.reportSha256)) {
    fail("DUPLICATE_EVIDENCE", "B5 collection reuses a physical report");
  }
  if (state.records.some((entry) => entry.generatedAt === record.generatedAt)) {
    fail("DUPLICATE_EVIDENCE", "B5 collection reuses a physical timestamp");
  }
  if (
    previous !== null &&
    record.targetSignatureSha256 !== state.records[0].targetSignatureSha256
  ) {
    fail("CAMPAIGN_TARGET_CHANGED", "B5 collection target changed between sessions");
  }
  if (previous !== null) {
    if (Date.parse(record.generatedAt) <= Date.parse(previous.generatedAt)) {
      fail("SESSION_SEQUENCE_INVALID", "B5 session timestamps are out of order");
    }
    if (Date.parse(record.sessionStartedAt) < Date.parse(previous.generatedAt)) {
      fail("SESSION_WINDOWS_OVERLAP", "B5 physical session windows overlap");
    }
    if (Date.parse(record.captureStartedAt) < Date.parse(previous.captureCompletedAt)) {
      fail("RUNNER_INVOCATIONS_OVERLAP", "B5 physical runner invocations overlap");
    }
  }
  const records = [...state.records, record];
  const nextState = {
    ...state,
    updatedAt: record.captureCompletedAt,
    collectionCommitmentSha256: collectionCommitment(records),
    records
  };
  parseCollectorState(nextState);
  return Object.freeze({
    state: Object.freeze(nextState),
    record,
    reportBytes
  });
}

export function buildProgressReport(
  currentState,
  { generatedAt = new Date().toISOString(), operation = "STATUS" } = {}
) {
  const state = parseCollectorState(currentState);
  const accountDeviceBound = collectorStateHasAccountDeviceBinding(state);
  requireTimestamp(
    generatedAt,
    "PROGRESS_INVALID",
    "Progress timestamp is invalid"
  );
  const collected = state.records.length;
  const complete = collected === B5_REQUIRED_SESSION_REPORTS;
  const report = Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_SESSION_COLLECTOR_VERSION,
    product: "V6",
    phase: "B5",
    generatedAt,
    mode: STATE_MODE,
    operation,
    verdict: complete && accountDeviceBound ? "READY" : "PENDING",
    progress: Object.freeze({
      requiredSessions: B5_REQUIRED_SESSION_REPORTS,
      collectedSessions: collected,
      remainingSessions: B5_REQUIRED_SESSION_REPORTS - collected,
      nextSlot: complete ? null : canonicalSlot(collected + 1)
    }),
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
      sourceReportDetailsIncluded: false
    }),
    physicalEvidenceConsumed: collected > 0,
    authoritativeB5GateExecuted: false,
    b5GatePromoted: false,
    v6ProductionServiceChanges: false
  });
  try {
    assertAggregateReportRedacted(report);
  } catch (error) {
    throw translateGateError(error);
  }
  return report;
}

export function buildPreflightReport(
  currentState,
  {
    generatedAt = new Date().toISOString(),
    migrationRequired = false,
    legacyUnbound = false
  } = {}
) {
  const state = parseCollectorState(currentState);
  requireTimestamp(
    generatedAt,
    "PREFLIGHT_INVALID",
    "Preflight timestamp is invalid"
  );
  const collected = state.records.length;
  const report = Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_SESSION_COLLECTOR_VERSION,
    product: "V6",
    phase: "B5",
    generatedAt,
    mode: "PREFLIGHT",
    verdict: legacyUnbound ? "PENDING" : "PASS",
    checks: Object.freeze({
      privateStateReadable: "PASS",
      stateSchema: migrationRequired
        ? "LEGACY_EMPTY_MIGRATABLE"
        : legacyUnbound
          ? "LEGACY_READ_ONLY"
          : "PASS",
      accountDeviceBinding: legacyUnbound ? "MISSING" : "PASS",
      pendingRecovery: "NONE",
      evidenceInventory: "PASS",
      stagedEvidenceIntegrity: "PASS",
      filesystemMutation: "NONE"
    }),
    progress: Object.freeze({
      requiredSessions: B5_REQUIRED_SESSION_REPORTS,
      collectedSessions: collected,
      remainingSessions: B5_REQUIRED_SESSION_REPORTS - collected,
      nextSlot:
        collected === B5_REQUIRED_SESSION_REPORTS
          ? null
          : canonicalSlot(collected + 1)
    }),
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
      sourceReportDetailsIncluded: false
    }),
    physicalEvidenceConsumed: false,
    privateStateWritten: false,
    authoritativeB5GateExecuted: false,
    b5GatePromoted: false,
    v6ProductionServiceChanges: false
  });
  try {
    assertAggregateReportRedacted(report);
  } catch (error) {
    throw translateGateError(error);
  }
  return report;
}

function evidenceDirectoryForState(statePath) {
  return `${statePath}.evidence`;
}

function evidencePathForSlot(statePath, sequence) {
  return path.join(
    evidenceDirectoryForState(statePath),
    `session-${canonicalSlot(sequence)}.json`
  );
}

function journalPathForState(statePath) {
  return `${statePath}.pending`;
}

function readCollectorStateCandidate(statePath) {
  return parseCollectorStateCandidate(
    readBoundedRegularFile(
      statePath,
      MAX_STATE_BYTES,
      "STATE_READ_FAILED",
      "Private collector state",
      { privateMode: true }
    ).toString("utf8")
  );
}

function readAccountDeviceBinding(androidBaselinePath) {
  let parsed;
  try {
    parsed = parsePrivateBaseline(
      readBoundedRegularFile(
        androidBaselinePath,
        MAX_STATE_BYTES,
        "ACCOUNT_DEVICE_BASELINE_INVALID",
        "Private B5 Android baseline",
        { privateMode: true }
      ).toString("utf8")
    );
    return b5AccountDeviceBindingFromPrivateBaseline(parsed.baseline);
  } catch (error) {
    if (error instanceof B5SessionCollectionError) throw error;
    if (error instanceof B5AccountDeviceCommitmentError) {
      throw translateGateError(error);
    }
    fail(
      "ACCOUNT_DEVICE_BASELINE_INVALID",
      "Private B5 Android baseline is invalid"
    );
  } finally {
    parsed?.sessionKey?.fill(0);
  }
}

function readCollectorState(statePath) {
  const candidate = readCollectorStateCandidate(statePath);
  return candidate.state;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function removeMatchingPrivateTemporaries(directory, patterns) {
  try {
    const status = fs.lstatSync(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      fail("STATE_RECOVERY_CONFLICT", "Private temporary directory is invalid");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error instanceof B5SessionCollectionError) throw error;
    fail("STATE_RECOVERY_CONFLICT", "Private temporary directory cannot be inspected");
  }
  ensurePrivateDirectory(directory);
  for (const name of fs.readdirSync(directory)) {
    if (!patterns.some((pattern) => pattern.test(name))) continue;
    removePrivateFile(
      path.join(directory, name),
      "STATE_RECOVERY_CONFLICT"
    );
  }
}

function cleanupCollectorTemporaries(statePath) {
  const stateName = escapeRegularExpression(path.basename(statePath));
  const suffix = String.raw`\.tmp-[0-9]+-[0-9a-f-]{36}`;
  removeMatchingPrivateTemporaries(path.dirname(statePath), [
    new RegExp(`^${stateName}${suffix}$`, "u"),
    new RegExp(`^${stateName}\\.pending${suffix}$`, "u")
  ]);
  removeMatchingPrivateTemporaries(evidenceDirectoryForState(statePath), [
    new RegExp(`^session-[0-9]{3}\\.json${suffix}$`, "u")
  ]);
}

function assertPrivateDirectoryReadOnly(directory, { allowMissing = false } = {}) {
  const resolved = assertNoSymlinkComponents(
    directory,
    "PREFLIGHT_PRIVATE_DIRECTORY_INVALID"
  );
  try {
    const status = fs.lstatSync(resolved);
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      fs.realpathSync(resolved) !== resolved ||
      (process.platform === "linux" && (status.mode & 0o777) !== 0o700)
    ) {
      fail(
        "PREFLIGHT_PRIVATE_DIRECTORY_INVALID",
        "Private collector directories must be canonical and owner-only"
      );
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return false;
    if (error instanceof B5SessionCollectionError) throw error;
    fail(
      "PREFLIGHT_PRIVATE_DIRECTORY_INVALID",
      "Private collector directory cannot be inspected safely"
    );
  }
}

function assertNoCollectorTemporaries(statePath) {
  const stateName = escapeRegularExpression(path.basename(statePath));
  const suffix = String.raw`\.tmp-[0-9]+-[0-9a-f-]{36}`;
  const locations = [
    {
      directory: path.dirname(statePath),
      patterns: [
        new RegExp(`^${stateName}${suffix}$`, "u"),
        new RegExp(`^${stateName}\\.pending${suffix}$`, "u")
      ]
    },
    {
      directory: evidenceDirectoryForState(statePath),
      patterns: [new RegExp(`^session-[0-9]{3}\\.json${suffix}$`, "u")]
    }
  ];
  for (const { directory, patterns } of locations) {
    if (!assertPrivateDirectoryReadOnly(directory, { allowMissing: true })) {
      continue;
    }
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch {
      fail(
        "PREFLIGHT_RECOVERY_REQUIRED",
        "Private collector temporaries cannot be inspected"
      );
    }
    if (names.some((name) => patterns.some((pattern) => pattern.test(name)))) {
      fail(
        "PREFLIGHT_RECOVERY_REQUIRED",
        "Private collector recovery must complete before capture"
      );
    }
  }
}

function inspectCollectorPreflight(statePath) {
  assertPrivateDirectoryReadOnly(path.dirname(statePath));
  const candidate = readCollectorStateCandidate(statePath);
  if (fileExistsWithoutFollowing(journalPathForState(statePath))) {
    fail(
      "PREFLIGHT_RECOVERY_REQUIRED",
      "Private collector recovery must complete before capture"
    );
  }
  assertNoCollectorTemporaries(statePath);
  verifyStagedEvidence(candidate.state, statePath);
  return buildPreflightReport(candidate.state, {
    migrationRequired: candidate.migrationRequired,
    legacyUnbound: candidate.legacyUnbound
  });
}

function expectedEvidenceNames(state) {
  return new Set(
    state.records.map((record) => `session-${record.slot}.json`)
  );
}

function assertEvidenceInventory(state, statePath) {
  const directory = evidenceDirectoryForState(statePath);
  try {
    const status = fs.lstatSync(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      fail("PRIVATE_EVIDENCE_INVALID", "Private evidence directory is invalid");
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (state.records.length === 0) return;
      fail("PRIVATE_EVIDENCE_MISSING", "Private evidence directory is missing");
    }
    if (error instanceof B5SessionCollectionError) throw error;
    fail("PRIVATE_EVIDENCE_INVALID", "Private evidence directory cannot be inspected");
  }
  ensurePrivateDirectory(directory);
  const expected = expectedEvidenceNames(state);
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    fail("PRIVATE_EVIDENCE_INVALID", "Private evidence directory cannot be read");
  }
  if (
    names.length !== expected.size ||
    names.some((name) => !expected.has(name))
  ) {
    fail("PRIVATE_EVIDENCE_CONFLICT", "Private evidence slots do not match state");
  }
}

export function verifyStagedEvidence(currentState, statePath) {
  const state = parseCollectorState(currentState);
  assertEvidenceInventory(state, statePath);
  const candidates = [];
  for (const record of state.records) {
    const bytes = readBoundedRegularFile(
      evidencePathForSlot(statePath, record.sequence),
      MAX_REPORT_BYTES,
      "PRIVATE_EVIDENCE_INVALID",
      "Private staged B5.7 evidence",
      { privateMode: true }
    );
    assertEvidenceDigest(bytes, record);
    const candidate = validateReportBytes(bytes, record.sequence);
    assertEvidenceMatchesRecord(record, candidate.validated);
    candidates.push(candidate);
  }
  return Object.freeze(candidates);
}

function writeOrVerifyEvidence(destination, bytes, expectedDigest) {
  ensurePrivateDirectory(path.dirname(destination));
  if (fs.existsSync(destination)) {
    const existing = readBoundedRegularFile(
      destination,
      MAX_REPORT_BYTES,
      "PRIVATE_EVIDENCE_CONFLICT",
      "Private staged B5.7 evidence",
      { privateMode: true }
    );
    if (sha256(existing) !== expectedDigest || !existing.equals(bytes)) {
      fail("PRIVATE_EVIDENCE_CONFLICT", "Private staged session contains different bytes");
    }
    return;
  }
  atomicWrite(destination, bytes, { allowExisting: false });
  const stored = readBoundedRegularFile(
    destination,
    MAX_REPORT_BYTES,
    "PRIVATE_EVIDENCE_WRITE_FAILED",
    "Private staged B5.7 evidence",
    { privateMode: true }
  );
  if (sha256(stored) !== expectedDigest) {
    fail("PRIVATE_EVIDENCE_WRITE_FAILED", "Private staged evidence failed its hash check");
  }
}

function buildJournal(state, record) {
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_SESSION_COLLECTOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: "PHYSICAL_CAPTURE_COMMIT",
    campaignRunId: state.campaignRunId,
    record
  });
}

function parseJournal(value) {
  const journal =
    typeof value === "string"
      ? parseJsonObject(value, "STATE_RECOVERY_CONFLICT", "Private journal is invalid")
      : value;
  requireExactFields(
    journal,
    JOURNAL_FIELDS,
    "STATE_RECOVERY_CONFLICT",
    "private transaction journal"
  );
  for (const [field, expected] of [
    ["schemaVersion", 1],
    ["harnessVersion", B5_SESSION_COLLECTOR_VERSION],
    ["product", "V6"],
    ["phase", "B5"],
    ["mode", "PHYSICAL_CAPTURE_COMMIT"]
  ]) {
    requireEqual(
      journal[field],
      expected,
      "STATE_RECOVERY_CONFLICT",
      "Private transaction journal is incompatible"
    );
  }
  requireUuid(
    journal.campaignRunId,
    "STATE_RECOVERY_CONFLICT",
    "Private transaction campaign is invalid"
  );
  validateStateRecord(journal.record, journal.record?.sequence);
  return journal;
}

function persistCapture(statePath, currentState, capture) {
  const journalPath = journalPathForState(statePath);
  const journal = buildJournal(currentState, capture.record);
  atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
    allowExisting: false
  });
  writeOrVerifyEvidence(
    evidencePathForSlot(statePath, capture.record.sequence),
    capture.reportBytes,
    capture.record.reportSha256
  );
  atomicWrite(statePath, `${JSON.stringify(capture.state, null, 2)}\n`);
  removePrivateFile(journalPath, "STATE_RECOVERY_CONFLICT");
}

function fileExistsWithoutFollowing(location) {
  try {
    const status = fs.lstatSync(location);
    if (status.isSymbolicLink()) {
      fail("STATE_RECOVERY_CONFLICT", "Private recovery artifact is a symbolic link");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error instanceof B5SessionCollectionError) throw error;
    fail("STATE_RECOVERY_CONFLICT", "Private recovery artifact cannot be inspected");
  }
}

function recoverPendingCapture(statePath, currentState) {
  const journalPath = journalPathForState(statePath);
  if (!fileExistsWithoutFollowing(journalPath)) return currentState;
  const state = parseCollectorState(currentState);
  const journal = parseJournal(
    readBoundedRegularFile(
      journalPath,
      MAX_STATE_BYTES,
      "STATE_RECOVERY_CONFLICT",
      "Private transaction journal",
      { privateMode: true }
    ).toString("utf8")
  );
  if (journal.campaignRunId !== state.campaignRunId) {
    fail("STATE_RECOVERY_CONFLICT", "Private transaction belongs to another campaign");
  }
  const record = journal.record;
  const evidencePath = evidencePathForSlot(statePath, record.sequence);
  const committed = state.records[record.sequence - 1];
  if (committed !== undefined) {
    if (JSON.stringify(committed) !== JSON.stringify(record)) {
      fail("STATE_RECOVERY_CONFLICT", "Committed state conflicts with private journal");
    }
    const bytes = readBoundedRegularFile(
      evidencePath,
      MAX_REPORT_BYTES,
      "STATE_RECOVERY_CONFLICT",
      "Private staged recovery evidence",
      { privateMode: true }
    );
    if (sha256(bytes) !== record.reportSha256) {
      fail("STATE_RECOVERY_CONFLICT", "Committed recovery evidence is inconsistent");
    }
    assertEvidenceMatchesRecord(
      record,
      validateReportBytes(bytes, record.sequence).validated
    );
    removePrivateFile(journalPath, "STATE_RECOVERY_CONFLICT");
    return state;
  }
  if (record.sequence !== state.records.length + 1) {
    fail("STATE_RECOVERY_CONFLICT", "Private journal slot is not the next state slot");
  }
  // A session is authoritative only after the collector committed its state.
  // Pre-commit crash artifacts are discarded and the physical slot is repeated.
  if (fileExistsWithoutFollowing(evidencePath)) {
    removePrivateFile(evidencePath, "STATE_RECOVERY_CONFLICT");
  }
  removePrivateFile(journalPath, "STATE_RECOVERY_CONFLICT");
  return state;
}

function sameDirectory(first, second) {
  const left = path.resolve(first);
  const right = path.resolve(second);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function normalizedPath(location) {
  const resolved = path.resolve(location);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function conflictsWithPrivateNamespace(candidate, privateRoot) {
  const compared = normalizedPath(candidate);
  const root = normalizedPath(privateRoot);
  return compared === root || compared.startsWith(`${root}.`);
}

function conflictsWithRadioLockNamespace(candidate) {
  const compared = normalizedPath(candidate);
  const directory = normalizedPath(RADIO_LOCK_DIRECTORY);
  return (
    path.dirname(compared) === directory &&
    path.basename(compared).startsWith(RADIO_LOCK_PREFIX)
  );
}

export function buildEvidenceManifest(currentState, statePath, manifestPath) {
  const state = parseCollectorState(currentState);
  if (!collectorStateHasAccountDeviceBinding(state)) {
    fail(
      "ACCOUNT_DEVICE_COMMITMENT_REQUIRED",
      "Historical collector state cannot produce promotable B5 evidence",
      2
    );
  }
  if (state.records.length !== B5_REQUIRED_SESSION_REPORTS) {
    fail(
      "COLLECTION_INCOMPLETE",
      "The B5 collection requires exactly 100 physical sessions",
      2
    );
  }
  if (!sameDirectory(path.dirname(statePath), path.dirname(manifestPath))) {
    fail(
      "MANIFEST_LOCATION_INVALID",
      "The private manifest must remain beside the collector state"
    );
  }
  verifyStagedEvidence(state, statePath);
  const relativeDirectory = path.basename(evidenceDirectoryForState(statePath));
  const manifest = {
    schemaVersion: 1,
    gate: MANIFEST_GATE,
    reports: state.records.map((record) => ({
      slot: record.slot,
      report: path.posix.join(
        relativeDirectory,
        `session-${record.slot}.json`
      )
    }))
  };
  try {
    parseEvidenceManifest(JSON.stringify(manifest));
  } catch (error) {
    throw translateGateError(error);
  }
  return Object.freeze(manifest);
}

async function acquireKernelLock(lockPath, { busyCode, busyMessage }) {
  const parent = ensurePrivateDirectory(path.dirname(lockPath));
  assertNoSymlinkComponents(lockPath, "STATE_LOCK_FAILED");
  const noFollow = process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | noFollow,
      0o600
    );
    let status = fs.fstatSync(descriptor);
    if (!status.isFile() || (process.platform === "linux" && (status.mode & 0o777) !== 0o600)) {
      fail("STATE_LOCK_FAILED", "Collector lock is not a private regular file");
    }
    if (process.platform === "linux" && typeof process.geteuid === "function") {
      const parentStatus = fs.lstatSync(parent);
      const effectiveUid = process.geteuid();
      if (effectiveUid === 0 && status.uid !== parentStatus.uid) {
        fs.fchownSync(descriptor, parentStatus.uid, parentStatus.gid);
        status = fs.fstatSync(descriptor);
      }
      if (effectiveUid !== 0 && status.uid !== effectiveUid) {
        fail("STATE_LOCK_FAILED", "Collector lock belongs to another account");
      }
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof B5SessionCollectionError) throw error;
    fail("STATE_LOCK_FAILED", "Cannot open the private collector lock");
  }

  const token = crypto.randomUUID();
  const child = spawn(
    "/usr/bin/flock",
    ["--exclusive", "--nonblock", "3"],
    { stdio: ["ignore", "ignore", "ignore", descriptor], windowsHide: true }
  );
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new B5SessionCollectionError("STATE_LOCK_FAILED", "Collector lock timed out")),
        5_000
      );
      timer.unref?.();
      child.once("error", (error) => reject(error));
      child.once("close", (code) => {
        if (code === 0) resolve();
        else {
          reject(new B5SessionCollectionError(
            code === 1 ? busyCode : "STATE_LOCK_FAILED",
            code === 1 ? busyMessage : "Cannot acquire the collector lock"
          ));
        }
      });
    });
  } catch (error) {
    child.kill("SIGKILL");
    fs.closeSync(descriptor);
    if (error instanceof B5SessionCollectionError) throw error;
    fail("STATE_LOCK_FAILED", "Cannot acquire the collector lock", 1, { cause: error });
  } finally {
    clearTimeout(timer);
  }

  const metadata = `${JSON.stringify({
    schemaVersion: 2,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    ownerToken: token
  })}\n`;
  try {
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, metadata, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fsyncDirectory(path.dirname(lockPath));
  } catch (error) {
    fs.closeSync(descriptor);
    if (error instanceof B5SessionCollectionError) throw error;
    fail("STATE_LOCK_FAILED", "Cannot persist collector lock metadata", 1, {
      cause: error
    });
  }

  return async () => fs.closeSync(descriptor);
}

async function withStateLock(statePath, action) {
  const release = await acquireKernelLock(`${statePath}.lock`, {
    busyCode: "STATE_BUSY",
    busyMessage: "Private collector state is already in use"
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

async function snapshotRelevantServices() {
  let unitsOutput;
  let unitFilesOutput;
  try {
    [{ stdout: unitsOutput }, { stdout: unitFilesOutput }] = await Promise.all([
      execFileAsync(
        "systemctl",
        ["list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager"],
        { encoding: "utf8", timeout: 10_000, windowsHide: true }
      ),
      execFileAsync(
        "systemctl",
        ["list-unit-files", "--type=service", "--no-legend", "--plain", "--no-pager"],
        { encoding: "utf8", timeout: 10_000, windowsHide: true }
      )
    ]);
  } catch (error) {
    fail("SERVICE_PREFLIGHT_FAILED", "System service state cannot be inspected", 1, {
      cause: error
    });
  }
  const runtimeFields = unitsOutput
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) =>
      fields.length >= 4 &&
      (fields[0] === "bluetooth.service" || /^cassav6.*\.service$/u.test(fields[0]))
    );
  const unitFileFields = unitFilesOutput
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) =>
      fields.length >= 2 &&
      (fields[0] === "bluetooth.service" || /^cassav6.*\.service$/u.test(fields[0]))
    );
  const bluetooth = runtimeFields.find((fields) => fields[0] === "bluetooth.service");
  if (bluetooth?.[2] !== "active" || bluetooth?.[3] !== "running") {
    fail("SERVICE_PREFLIGHT_FAILED", "bluetooth.service must be active and running");
  }
  const competingUnits = new Set([
    "cassav6-bluetooth-node.service",
    "cassav6-bluetooth-enrollment.service"
  ]);
  if (
    runtimeFields.some(
      (fields) => competingUnits.has(fields[0]) && !["inactive", "failed"].includes(fields[2])
    )
  ) {
    fail("SERVICE_PREFLIGHT_FAILED", "Competing V6 Bluetooth services must be stopped");
  }
  const nodeUnitFile = unitFileFields.find(
    (fields) => fields[0] === "cassav6-bluetooth-node.service"
  );
  const nodeRuntime = runtimeFields.find(
    (fields) => fields[0] === "cassav6-bluetooth-node.service"
  );
  if (nodeUnitFile !== undefined || nodeRuntime !== undefined) {
    fail("SERVICE_PREFLIGHT_FAILED", "The production Bluetooth node must not be installed");
  }
  const enrollmentUnitFile = unitFileFields.find(
    (fields) => fields[0] === "cassav6-bluetooth-enrollment.service"
  );
  if (
    enrollmentUnitFile !== undefined &&
    !["disabled", "masked", "masked-runtime"].includes(enrollmentUnitFile[1])
  ) {
    fail("SERVICE_PREFLIGHT_FAILED", "Bluetooth enrollment must be disabled");
  }
  const services = [
    ...runtimeFields.map((fields) => `runtime ${fields.slice(0, 4).join(" ")}`),
    ...unitFileFields.map((fields) => `unit-file ${fields.slice(0, 2).join(" ")}`)
  ].sort();
  return Object.freeze(services);
}

function validateApi31StagingOptions(options) {
  if (!isRecord(options)) {
    fail("STAGING_OPTIONS_INVALID", "API31 staging options are missing");
  }
  const value = options;
  if (!ADAPTER_PATTERN.test(value.adapterName)) {
    fail("STAGING_OPTIONS_INVALID", "Staging adapter must match hci[0-9]+");
  }
  if (!NODE_ID_PATTERN.test(value.serverNodeId)) {
    fail(
      "STAGING_OPTIONS_INVALID",
      "Staging server identity must be a canonical lowercase UUID"
    );
  }
  if (value.holdMs !== DEFAULT_HOLD_MS) {
    fail(
      "STAGING_OPTIONS_INVALID",
      `API31 staging hold must be exactly ${DEFAULT_HOLD_MS} milliseconds`
    );
  }
  return Object.freeze({
    adapterName: value.adapterName,
    serverNodeId: value.serverNodeId,
    holdMs: value.holdMs,
    registryPath: requireApi31StagingLocation(
      value.registryPath,
      "Staging registry"
    )
  });
}

async function runTransientAdvertisementSelfTest() {
  const python = "/usr/bin/python3";
  const script = fileURLToPath(
    new URL("./register_advertisement_v1.py", import.meta.url)
  );
  let stdout;
  try {
    ({ stdout } = await execFileAsync(python, [script, "--self-test"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true
    }));
  } catch (error) {
    fail(
      "ADVERTISEMENT_CONTRACT_INVALID",
      "Transient advertisement contract self-test failed",
      1,
      { cause: error }
    );
  }
  if (
    !/(?:^|\n)SELF_TEST=PASS(?:\r?\n|$)/u.test(stdout) ||
    !/(?:^|\n)PAYLOAD_BYTES=10(?:\r?\n|$)/u.test(stdout) ||
    !/(?:^|\n)LEGACY_ADVDATA_BYTES=31(?:\r?\n|$)/u.test(stdout)
  ) {
    fail(
      "ADVERTISEMENT_CONTRACT_INVALID",
      "Transient advertisement contract self-test was incomplete"
    );
  }
  return true;
}

function api31StagingPreflightReport(summary, generatedAt) {
  const report = Object.freeze({
    schemaVersion: 1,
    harnessVersion: API31_STAGING_HARNESS_VERSION,
    product: "V6",
    phase: "B5.7",
    generatedAt,
    mode: "API31_STAGING_PREFLIGHT",
    verdict: "READY",
    protocol: Object.freeze({
      advertisementVersion: 1,
      helloWireVersion: 1,
      enrollmentVersion: 2,
      identityAlgorithm: "EC-P256",
      mutualAuthentication: "ECDSA-P256",
      keyExchange: "X25519",
      directControlVersion: 1
    }),
    checks: Object.freeze({
      copiedRegistryReadOnly: "PASS",
      registrySchemaV2: "PASS",
      activeP256EnrollmentV2Identity: "PASS",
      advertisementContract: "PASS",
      gattProfileAndDirectControlContract: "PASS",
      noNewProtocol: "PASS"
    }),
    registry: Object.freeze({
      schemaVersion: summary.schemaVersion,
      activeIdentityCount: summary.activeIdentityCount,
      activeP256IdentityCount: summary.activeP256IdentityCount,
      boundEnrollmentV2IdentityCount:
        summary.boundEnrollmentV2IdentityCount
    }),
    physicalRadioAccessed: false,
    physicalEvidenceConsumed: false,
    authoritativeB5GateExecuted: false,
    b5GatePromoted: false,
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
      sourceReportDetailsIncluded: false
    }),
    v6ProductionServiceChanges: false
  });
  assertAggregateReportRedacted(report);
  return report;
}

export async function runApi31StagingPreflight(options, runtime = {}) {
  const validated = validateApi31StagingOptions(options);
  const inspector =
    runtime.inspectStagingRegistry ?? inspectApi31StagingRegistry;
  const advertisementSelfTest =
    runtime.runAdvertisementSelfTest ?? runTransientAdvertisementSelfTest;
  const directControlContractSelfTest =
    runtime.runDirectControlSelfTest ?? runDirectControlSelfTest;
  const summary = await inspector(validated.registryPath);
  await advertisementSelfTest();
  const directReport = await directControlContractSelfTest();
  if (
    directReport?.mode !== "SELF_TEST" ||
    directReport?.verdict !== "PASS" ||
    directReport?.physicalRadioAccessed !== false ||
    directReport?.v6ProductionServiceChanges !== false
  ) {
    fail(
      "DIRECT_CONTROL_CONTRACT_INVALID",
      "GATT direct-control contract self-test was incomplete"
    );
  }
  const generatedAt = runtime.now?.() ?? new Date().toISOString();
  requireTimestamp(
    generatedAt,
    "STAGING_CLOCK_INVALID",
    "Staging clock returned an invalid timestamp"
  );
  return api31StagingPreflightReport(summary, generatedAt);
}

function parseSystemdServiceSnapshot(unit, stdout) {
  const fields = new Map();
  for (const line of stdout.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  for (const field of [
    "LoadState",
    "ActiveState",
    "SubState",
    "MainPID",
    "NRestarts",
    "ActiveEnterTimestampMonotonic",
    "ExecMainStartTimestampMonotonic"
  ]) {
    if (!fields.has(field)) {
      fail(
        "SERVICE_PREFLIGHT_FAILED",
        `Required ${unit} continuity field is unavailable`
      );
    }
  }
  if (
    fields.get("LoadState") !== "loaded" ||
    fields.get("ActiveState") !== "active" ||
    fields.get("SubState") !== "running"
  ) {
    fail(
      "SERVICE_PREFLIGHT_FAILED",
      `${unit} must remain loaded, active and running`
    );
  }
  for (const field of [
    "MainPID",
    "NRestarts",
    "ActiveEnterTimestampMonotonic",
    "ExecMainStartTimestampMonotonic"
  ]) {
    const number = Number(fields.get(field));
    const minimum = field === "NRestarts" ? 0 : 1;
    if (!Number.isSafeInteger(number) || number < minimum) {
      fail(
        "SERVICE_PREFLIGHT_FAILED",
        `${unit} continuity field ${field} is invalid`
      );
    }
  }
  return [
    unit,
    ...[
      "LoadState",
      "ActiveState",
      "SubState",
      "MainPID",
      "NRestarts",
      "ActiveEnterTimestampMonotonic",
      "ExecMainStartTimestampMonotonic"
    ].map((field) => `${field}=${fields.get(field)}`)
  ].join(" ");
}

async function snapshotApi31StagingServices() {
  const inventory = await snapshotRelevantServices();
  const properties = [
    "LoadState",
    "ActiveState",
    "SubState",
    "MainPID",
    "NRestarts",
    "ActiveEnterTimestampMonotonic",
    "ExecMainStartTimestampMonotonic"
  ];
  let snapshots;
  try {
    snapshots = await Promise.all(
      ["bluetooth.service", "cassav6.service"].map(async (unit) => {
        const { stdout } = await execFileAsync(
          "systemctl",
          [
            "show",
            unit,
            "--no-pager",
            ...properties.map((field) => `--property=${field}`)
          ],
          { encoding: "utf8", timeout: 10_000, windowsHide: true }
        );
        return parseSystemdServiceSnapshot(unit, stdout);
      })
    );
  } catch (error) {
    if (error instanceof B5SessionCollectionError) throw error;
    fail(
      "SERVICE_PREFLIGHT_FAILED",
      "Operational service continuity cannot be inspected",
      1,
      { cause: error }
    );
  }
  return Object.freeze([...inventory, ...snapshots].sort());
}

function loadPhysicalConfiguration() {
  let config;
  try {
    config = loadBluezNodeConfig(process.env);
  } catch (error) {
    fail("PHYSICAL_CONFIG_INVALID", "Physical collector environment is invalid", 1, {
      cause: error
    });
  }
  if (
    !config.enabled ||
    config.dryRun ||
    !config.gattServerEnabled ||
    !config.helloExchangeEnabled ||
    !config.mutualAuthEnabled ||
    !config.directControlEnabled
  ) {
    fail(
      "PHYSICAL_CONFIG_INVALID",
      "Physical collector requires the complete direct-control Lab configuration"
    );
  }
  if (
    !ADAPTER_PATTERN.test(config.adapterName) ||
    !NODE_ID_PATTERN.test(config.nodeId) ||
    config.helloCapabilities !== SERVER_CAPABILITIES ||
    !path.isAbsolute(config.deviceRegistryPath) ||
    !config.deviceRegistryPath.toLowerCase().includes("cassav6")
  ) {
    fail("PHYSICAL_CONFIG_INVALID", "Physical collector identity or registry is invalid");
  }
  return Object.freeze(config);
}

function startTransientAdvertisement({ adapterName, bootId, sequence, signal }) {
  const python = "/usr/bin/python3";
  const script = fileURLToPath(
    new URL("./register_advertisement_v1.py", import.meta.url)
  );
  if (!fs.existsSync(python)) {
    fail("ADVERTISEMENT_UNAVAILABLE", "The fixed Python runtime is unavailable");
  }
  if (signal?.aborted) {
    fail("CAPTURE_ABORTED", "Physical collection was interrupted", 130);
  }
  const durationSeconds = Math.max(1, Math.floor((DEFAULT_HOLD_MS - 5_000) / 1_000));
  const aliasBytes = crypto.randomBytes(6);
  const alias = aliasBytes.toString("hex");
  let closed = false;
  const child = spawn(
    python,
    [
      script,
      "--adapter",
      `/org/bluez/${adapterName}`,
      "--duration",
      String(durationSeconds),
      "--node-kind",
      "raspberry",
      "--alias-stdin",
      "--boot-id",
      String(bootId),
      "--capabilities",
      String(SERVER_CAPABILITIES),
      "--sequence",
      String(sequence),
      "--server-reachable"
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  );
  const abort = () => {
    if (!closed) child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", abort);
  if (signal?.aborted) abort();
  child.stdin.on("error", () => {});
  child.stdin.end(`${alias}\n`);
  aliasBytes.fill(0);
  let tail = "";
  let registered = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const completion = new Promise((resolve) => {
    child.once("error", () => {
      closed = true;
      if (!registered) readyReject(new Error("ADVERTISEMENT_START_FAILED"));
      resolve(Object.freeze({ ok: false, code: null }));
    });
    child.once("close", (code, closeSignal) => {
      closed = true;
      if (!registered) readyReject(new Error("ADVERTISEMENT_NOT_REGISTERED"));
      resolve(Object.freeze({ ok: code === 0 && closeSignal === null, code }));
    });
  });
  child.stdout.on("data", (chunk) => {
    tail = `${tail}${chunk.toString("utf8")}`.slice(-512);
    if (!registered && /(?:^|\n)REGISTERED=1(?:\r?\n|$)/u.test(tail)) {
      registered = true;
      tail = "";
      readyResolve();
    }
  });
  child.stderr.on("data", () => {});

  const timeout = setTimeout(() => {
    if (!registered) readyReject(new Error("ADVERTISEMENT_READY_TIMEOUT"));
  }, 10_000);
  timeout.unref?.();
  const awaitCompletion = async (timeoutMs) => {
    let timer;
    try {
      return await Promise.race([
        completion,
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve(Object.freeze({ ok: false, code: null, timedOut: true })),
            timeoutMs
          );
          timer.unref?.();
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const forceClose = async (graceMs) => {
    child.kill("SIGKILL");
    const result = await awaitCompletion(graceMs);
    if (result.timedOut) {
      fail("ADVERTISEMENT_CLEANUP_FAILED", "Transient advertisement did not terminate");
    }
    return result;
  };

  return Object.freeze({
    async waitUntilReady() {
      try {
        await ready;
      } catch (error) {
        abort();
        fail("ADVERTISEMENT_START_FAILED", "Transient advertisement did not register", 1, {
          cause: error
        });
      } finally {
        clearTimeout(timeout);
      }
    },
    async finish() {
      try {
        let result = await awaitCompletion(10_000);
        if (result.timedOut) result = await forceClose(2_000);
        if (!result.ok) {
          fail("ADVERTISEMENT_CLEANUP_FAILED", "Transient advertisement did not close cleanly");
        }
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    async stop() {
      try {
        abort();
        const result = await awaitCompletion(5_000);
        if (result.timedOut) await forceClose(2_000);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    }
  });
}

function assertCollectionAcceptsCapture(currentState) {
  const state = parseCollectorState(currentState);
  if (!collectorStateHasAccountDeviceBinding(state)) {
    fail(
      "ACCOUNT_DEVICE_COMMITMENT_REQUIRED",
      "Historical collector state is read-only without an account/device commitment",
      2
    );
  }
  if (state.records.length >= B5_REQUIRED_SESSION_REPORTS) {
    fail("COLLECTION_COMPLETE", "The B5 collection already contains 100 sessions", 2);
  }
  return state;
}

function assertProvisionedRadioDirectory() {
  const resolved = assertNoSymlinkComponents(
    RADIO_LOCK_DIRECTORY,
    "RADIO_LOCK_UNAVAILABLE"
  );
  try {
    const status = fs.lstatSync(resolved);
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      (process.platform === "linux" && (status.mode & 0o777) !== 0o700)
    ) {
      fail(
        "RADIO_LOCK_UNAVAILABLE",
        "The provisioned V6 state directory must be private"
      );
    }
    if (
      process.platform === "linux" &&
      typeof process.geteuid === "function" &&
      process.geteuid() !== 0 &&
      status.uid !== process.geteuid()
    ) {
      fail(
        "RADIO_LOCK_UNAVAILABLE",
        "The V6 state directory belongs to another account"
      );
    }
    return resolved;
  } catch (error) {
    if (error instanceof B5SessionCollectionError) throw error;
    fail(
      "RADIO_LOCK_UNAVAILABLE",
      "The V6 state directory must be provisioned before physical collection",
      1,
      { cause: error }
    );
  }
}

function radioLockPath(adapterName) {
  const directory = assertProvisionedRadioDirectory();
  return path.join(
    directory,
    `${RADIO_LOCK_PREFIX}${adapterName}.lock`
  );
}

export async function capturePhysicalSession(
  state,
  captureBootId,
  runtime = {}
) {
  state = assertCollectionAcceptsCapture(state);
  requireInteger(
    captureBootId,
    1,
    255,
    "BOOT_ID_RESERVATION_INVALID",
    "The private capture boot identifier is invalid"
  );
  if (captureBootId !== state.lastCaptureBootId) {
    fail(
      "BOOT_ID_RESERVATION_INVALID",
      "The physical capture does not match its private reservation"
    );
  }
  const configurationLoader =
    runtime.loadPhysicalConfiguration ?? loadPhysicalConfiguration;
  const lockAcquirer = runtime.acquireKernelLock ?? acquireKernelLock;
  const serviceSnapshotter =
    runtime.snapshotRelevantServices ?? snapshotRelevantServices;
  const runner =
    runtime.runPhysicalDirectControlSmoke ?? runPhysicalDirectControlSmoke;
  const advertisementStarter =
    runtime.startTransientAdvertisement ?? startTransientAdvertisement;
  const lockPathResolver = runtime.radioLockPath ?? radioLockPath;
  const now = runtime.now ?? (() => new Date().toISOString());
  const timestamp = () => {
    const value = now();
    const encoded = value instanceof Date ? value.toISOString() : value;
    requireTimestamp(
      encoded,
      "RUNNER_PROVENANCE_INVALID",
      "Physical capture clock returned an invalid timestamp"
    );
    return encoded;
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  let advertisement = null;
  let servicesBefore = null;
  let releaseRadioLock = null;
  let primaryError = null;
  const captureStartedAt = timestamp();
  try {
    const config = configurationLoader();
    releaseRadioLock = await lockAcquirer(lockPathResolver(config.adapterName), {
      busyCode: "RADIO_BUSY",
      busyMessage: "The Bluetooth adapter is already used by another B5 collection"
    });
    if (controller.signal.aborted) {
      fail("CAPTURE_ABORTED", "Physical collection was interrupted", 130);
    }
    servicesBefore = await serviceSnapshotter();
    const report = await runner({
      adapterName: config.adapterName,
      holdMs: DEFAULT_HOLD_MS,
      serverNodeId: config.nodeId,
      bootId: captureBootId,
      capabilities: config.helloCapabilities,
      registryPath: config.deviceRegistryPath,
      signal: controller.signal,
      async onRegistered() {
        advertisement = advertisementStarter({
          adapterName: config.adapterName,
          bootId: captureBootId,
          sequence: state.records.length + 1,
          signal: controller.signal
        });
        await advertisement.waitUntilReady();
      }
    });
    if (advertisement === null) {
      fail("ADVERTISEMENT_START_FAILED", "Physical runner never registered advertising");
    }
    if (controller.signal.aborted) {
      fail("CAPTURE_ABORTED", "Physical collection was interrupted", 130);
    }
    await advertisement.finish();
    advertisement = null;
    if (controller.signal.aborted) {
      fail("CAPTURE_ABORTED", "Physical collection was interrupted", 130);
    }
    const captureCompletedAt = timestamp();
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    return appendCapturedSession(state, reportBytes, {
      evidenceRecordId: crypto.randomUUID(),
      captureStartedAt,
      captureCompletedAt
    });
  } catch (error) {
    primaryError = controller.signal.aborted
      ? new B5SessionCollectionError(
          "CAPTURE_ABORTED",
          "Physical collection was interrupted",
          130,
          { cause: error }
        )
      : translateGateError(error);
    throw primaryError;
  } finally {
    let cleanupError = null;
    let advertisementCleanupVerified = advertisement === null;
    let serviceCleanupVerified = false;
    let radioLockCleanupVerified = false;
    try {
      if (advertisement !== null) {
        await advertisement.stop();
        advertisementCleanupVerified = true;
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (servicesBefore !== null) {
        const servicesAfter = await serviceSnapshotter();
        if (JSON.stringify(servicesBefore) !== JSON.stringify(servicesAfter)) {
          fail("PRODUCTION_SERVICE_CHANGED", "A service changed state during the physical capture");
        }
        serviceCleanupVerified = true;
      }
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      if (releaseRadioLock !== null) {
        await releaseRadioLock();
        radioLockCleanupVerified = true;
      }
    } catch (error) {
      cleanupError ??= error;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
    if (controller.signal.aborted && primaryError === null) {
      cleanupError ??= new B5SessionCollectionError(
        "CAPTURE_ABORTED",
        "Physical collection was interrupted",
        130
      );
    }
    if (
      primaryError?.code === "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT"
    ) {
      primaryError.cleanupVerified =
        primaryError.cleanupVerified === true &&
        advertisementCleanupVerified &&
        serviceCleanupVerified &&
        radioLockCleanupVerified &&
        cleanupError === null &&
        !controller.signal.aborted;
    }
    if (cleanupError !== null) {
      if (primaryError === null) throw cleanupError;
      const cleanupCode = translateGateError(cleanupError).code;
      primaryError.message = `${primaryError.message}; cleanup verification also failed (${cleanupCode})`;
    }
  }
}

function validateApi31StagingDirectReport(report) {
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  try {
    validatePhysicalSessionReport({
      sequence: 1,
      sourceReportSha256: sha256(bytes),
      report
    });
  } catch (error) {
    throw translateGateError(error);
  }
  return report;
}

function api31StagingSessionReport(
  directReport,
  preflight,
  generatedAt
) {
  const observed = directReport.observed;
  const report = Object.freeze({
    schemaVersion: 1,
    harnessVersion: API31_STAGING_HARNESS_VERSION,
    product: "V6",
    phase: "B5.7",
    generatedAt,
    mode: "API31_STAGING_PHYSICAL_NON_GATE",
    verdict: "NON_GATE_PASS",
    protocol: preflight.protocol,
    checks: Object.freeze({
      stagingPreflight: "PASS",
      stagingRegistryUnchanged: "PASS",
      operationalServicesUnchanged: "PASS",
      transientAdvertisementRegistered: "PASS",
      gattProfileRegistered: "PASS",
      helloIdentityExchange: "PASS",
      mutualAuthenticationP256: "PASS",
      keyExchange: "PASS",
      activeStateReached: "PASS",
      authenticatedPingPong: "PASS",
      closeAndCloseAck: "PASS",
      advertisementCleanup: "PASS",
      gattCleanup: "PASS",
      radioLockCleanup: "PASS"
    }),
    observed: Object.freeze({
      finalState: observed.finalState,
      durationMs: observed.durationMs,
      helloExchanged: observed.helloExchanged,
      mutualAuthentications: observed.mutualAuthentications,
      keyEstablishments: observed.keyEstablishments,
      activeTransitions: observed.activeTransitions,
      pingsSent: observed.pingsSent,
      pongsVerified: observed.pongsVerified,
      heartbeatMisses: observed.heartbeatMisses,
      cleanCloses: observed.cleanCloses,
      activeAfterCleanup: observed.activeAfterCleanup,
      timersAfterCleanup: observed.timersAfterCleanup,
      retainedSecretBuffersAfterCleanup:
        observed.retainedSecretBuffersAfterCleanup,
      failures: observed.failures
    }),
    physicalRadioAccessed: true,
    physicalEvidenceConsumed: true,
    authoritativeB5GateExecuted: false,
    b5GatePromoted: false,
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
      sourceReportDetailsIncluded: false
    }),
    v6ProductionServiceChanges: false
  });
  assertAggregateReportRedacted(report);
  return report;
}

export async function runApi31StagingDirectControl(
  options,
  runtime = {}
) {
  const validated = validateApi31StagingOptions(options);
  const preflightRunner =
    runtime.runPreflight ?? runApi31StagingPreflight;
  const lockAcquirer = runtime.acquireKernelLock ?? acquireKernelLock;
  const lockPathResolver = runtime.radioLockPath ?? radioLockPath;
  const serviceSnapshotter =
    runtime.snapshotStagingServices ?? snapshotApi31StagingServices;
  const advertisementStarter =
    runtime.startTransientAdvertisement ?? startTransientAdvertisement;
  const directControlRunner =
    runtime.runPhysicalDirectControlSmoke ?? runPhysicalDirectControlSmoke;
  const randomInt = runtime.randomInt ?? crypto.randomInt;
  const now = runtime.now ?? (() => new Date().toISOString());
  const registrySnapshotter =
    runtime.snapshotStagingRegistry ??
    ((location) =>
      readBoundedRegularFile(
        location,
        MAX_STAGING_REGISTRY_BYTES,
        "STAGING_REGISTRY_INVALID",
        "Staging registry",
        { privateMode: true, singleLink: true }
      ));

  const preflight = await preflightRunner(validated);
  if (
    preflight?.mode !== "API31_STAGING_PREFLIGHT" ||
    preflight?.verdict !== "READY" ||
    preflight?.physicalRadioAccessed !== false
  ) {
    fail(
      "STAGING_PREFLIGHT_INVALID",
      "API31 staging preflight did not complete safely"
    );
  }
  const registryBefore = Buffer.from(
    await registrySnapshotter(validated.registryPath)
  );

  const bootId = randomInt(1, 256);
  const sequence = randomInt(0, 256);
  requireInteger(
    bootId,
    1,
    255,
    "BOOT_ID_GENERATION_FAILED",
    "Staging boot identifier generator returned an invalid value"
  );
  requireInteger(
    sequence,
    0,
    255,
    "ADVERTISEMENT_SEQUENCE_INVALID",
    "Staging advertisement sequence generator returned an invalid value"
  );

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  let advertisement = null;
  let advertisementStarted = false;
  let servicesBefore = null;
  let releaseRadioLock = null;
  let directReport = null;
  let primaryError = null;
  let advertisementCleanupVerified = false;
  let registryCleanupVerified = false;
  let serviceCleanupVerified = false;
  let radioLockCleanupVerified = false;
  try {
    releaseRadioLock = await lockAcquirer(
      lockPathResolver(validated.adapterName),
      {
        busyCode: "RADIO_BUSY",
        busyMessage: "The Bluetooth adapter is already used by another V6 harness"
      }
    );
    if (controller.signal.aborted) {
      fail("CAPTURE_ABORTED", "Physical collection was interrupted", 130);
    }
    servicesBefore = await serviceSnapshotter();
    directReport = await directControlRunner({
      adapterName: validated.adapterName,
      holdMs: validated.holdMs,
      serverNodeId: validated.serverNodeId,
      bootId,
      capabilities: SERVER_CAPABILITIES,
      registryPath: validated.registryPath,
      signal: controller.signal,
      async onRegistered() {
        if (advertisementStarted || advertisement !== null) {
          fail(
            "ADVERTISEMENT_START_FAILED",
            "Physical runner invoked advertisement readiness more than once"
          );
        }
        advertisementStarted = true;
        advertisement = advertisementStarter({
          adapterName: validated.adapterName,
          bootId,
          sequence,
          signal: controller.signal
        });
        await advertisement.waitUntilReady();
      }
    });
    validateApi31StagingDirectReport(directReport);
    if (!advertisementStarted || advertisement === null) {
      fail(
        "ADVERTISEMENT_START_FAILED",
        "Physical runner never registered the transient advertisement"
      );
    }
    await advertisement.finish();
    advertisement = null;
    advertisementCleanupVerified = true;
    if (controller.signal.aborted) {
      fail("CAPTURE_ABORTED", "Physical collection was interrupted", 130);
    }
  } catch (error) {
    primaryError = translateGateError(error);
  } finally {
    let cleanupError = null;
    try {
      if (advertisement !== null) {
        await advertisement.stop();
        advertisement = null;
      }
      advertisementCleanupVerified = advertisementStarted;
    } catch (error) {
      cleanupError = error;
    }
    try {
      const registryAfter = Buffer.from(
        await registrySnapshotter(validated.registryPath)
      );
      if (!registryBefore.equals(registryAfter)) {
        fail(
          "STAGING_REGISTRY_CHANGED",
          "Staging registry changed during the physical session"
        );
      }
      registryCleanupVerified = true;
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      if (servicesBefore !== null) {
        const servicesAfter = await serviceSnapshotter();
        if (JSON.stringify(servicesBefore) !== JSON.stringify(servicesAfter)) {
          fail(
            "PRODUCTION_SERVICE_CHANGED",
            "An operational service changed during the staging session"
          );
        }
        serviceCleanupVerified = true;
      }
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      if (releaseRadioLock !== null) {
        await releaseRadioLock();
        radioLockCleanupVerified = true;
      }
    } catch (error) {
      cleanupError ??= error;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
    if (controller.signal.aborted && primaryError === null) {
      primaryError = new B5SessionCollectionError(
        "CAPTURE_ABORTED",
        "Physical collection was interrupted",
        130
      );
    }
    if (primaryError?.code === "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT") {
      primaryError.cleanupVerified =
        primaryError.cleanupVerified === true &&
        advertisementCleanupVerified &&
        registryCleanupVerified &&
        serviceCleanupVerified &&
        radioLockCleanupVerified &&
        cleanupError === null &&
        !controller.signal.aborted;
    }
    if (cleanupError !== null) {
      const translatedCleanup = translateGateError(cleanupError);
      if (primaryError === null) {
        primaryError = translatedCleanup;
      } else {
        primaryError.cleanupVerified = false;
        primaryError.message = `${primaryError.message}; cleanup verification also failed (${translatedCleanup.code})`;
      }
    }
  }
  if (primaryError !== null) throw primaryError;
  const generatedAt = now();
  requireTimestamp(
    generatedAt,
    "STAGING_CLOCK_INVALID",
    "Staging clock returned an invalid timestamp"
  );
  return api31StagingSessionReport(directReport, preflight, generatedAt);
}

function writeJson(destination, value, { operationCommitted = false } = {}) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (destination !== null) {
    try {
      atomicWrite(destination, encoded);
    } catch (error) {
      if (!operationCommitted) throw error;
      process.stderr.write(
        "OUTPUT_WRITE_FAILED: operation committed; authoritative state is unchanged\n"
      );
    }
  }
  process.stdout.write(encoded);
}

function writeExclusiveJson(destination, value) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  writeExclusivePrivateSnapshot(destination, encoded);
  process.stdout.write(encoded);
}

function parseArguments(argv) {
  const options = {
    mode: null,
    state: null,
    androidBaseline: null,
    manifest: null,
    output: null,
    sourceRegistry: null,
    registryPath: null,
    adapterName: "hci0",
    serverNodeId: null
  };
  const modes = new Map([
    ["--init", "INIT"],
    ["--preflight", "PREFLIGHT"],
    ["--status", "STATUS"],
    ["--capture", "CAPTURE"],
    ["--finalize", "FINALIZE"],
    ["--stage-registry", "API31_STAGING_REGISTRY_COPY"],
    ["--staging-preflight", "API31_STAGING_PREFLIGHT"],
    ["--staging-session", "API31_STAGING_SESSION"],
    ["--self-test", "SELF_TEST"],
    ["--help", "HELP"],
    ["-h", "HELP"]
  ]);
  const values = new Map([
    ["--state", "state"],
    ["--android-baseline", "androidBaseline"],
    ["--manifest", "manifest"],
    ["--output", "output"],
    ["--source-registry", "sourceRegistry"],
    ["--registry", "registryPath"],
    ["--adapter", "adapterName"],
    ["--server-node-id", "serverNodeId"]
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) fail("INVALID_ARGUMENT", "Duplicate command argument");
    seen.add(argument);
    if (modes.has(argument)) {
      if (options.mode !== null) fail("INVALID_ARGUMENT", "Choose exactly one collector action");
      options.mode = modes.get(argument);
      continue;
    }
    const field = values.get(argument);
    if (field === undefined) fail("INVALID_ARGUMENT", "Unknown command argument");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `${argument} requires a value`);
    }
    options[field] = [
      "state",
      "androidBaseline",
      "manifest",
      "output",
      "sourceRegistry",
      "registryPath"
    ].includes(field)
      ? path.resolve(value)
      : value;
    index += 1;
  }
  if (options.mode === null) fail("INVALID_ARGUMENT", "Choose one collector action");
  return options;
}

function validateOptions(options) {
  if (options.mode === "HELP" || options.mode === "SELF_TEST") {
    if (
      [
        options.state,
        options.androidBaseline,
        options.manifest,
        options.output,
        options.sourceRegistry,
        options.registryPath,
        options.serverNodeId
      ].some(Boolean) ||
      options.adapterName !== "hci0"
    ) {
      fail(
        "INVALID_ARGUMENT",
        `--${options.mode === "HELP" ? "help" : "self-test"} cannot be combined`
      );
    }
    return options;
  }
  if (API31_STAGING_MODES.has(options.mode)) {
    if (
      options.state !== null ||
      options.androidBaseline !== null ||
      options.manifest !== null
    ) {
      fail(
        "INVALID_ARGUMENT",
        "API31 staging actions cannot use campaign state or manifest"
      );
    }
    if (options.mode === "API31_STAGING_REGISTRY_COPY") {
      if (
        options.sourceRegistry === null ||
        options.registryPath === null ||
        options.output !== null ||
        options.serverNodeId !== null ||
        options.adapterName !== "hci0"
      ) {
        fail(
          "INVALID_ARGUMENT",
          "--stage-registry requires only --source-registry and --registry"
        );
      }
      requireApi31StagingLocation(options.sourceRegistry, "Source registry");
      requireApi31StagingLocation(options.registryPath, "Staging registry");
      return options;
    }
    if (
      options.sourceRegistry !== null ||
      options.registryPath === null ||
      options.serverNodeId === null
    ) {
      fail(
        "INVALID_ARGUMENT",
        "Staging preflight and session require --registry and --server-node-id"
      );
    }
    validateApi31StagingOptions({
      adapterName: options.adapterName,
      serverNodeId: options.serverNodeId,
      holdMs: DEFAULT_HOLD_MS,
      registryPath: options.registryPath
    });
    if (
      options.mode === "API31_STAGING_PREFLIGHT" &&
      options.output !== null
    ) {
      fail(
        "INVALID_ARGUMENT",
        "--staging-preflight does not write output files"
      );
    }
    if (
      options.mode === "API31_STAGING_SESSION" &&
      options.output === null
    ) {
      fail(
        "INVALID_ARGUMENT",
        "--staging-session requires a private --output"
      );
    }
    if (
      options.output !== null &&
      normalizedPath(options.output) === normalizedPath(options.registryPath)
    ) {
      fail(
        "INVALID_ARGUMENT",
        "Staging report and registry must use distinct locations"
      );
    }
    if (
      options.output !== null &&
      conflictsWithRadioLockNamespace(options.output)
    ) {
      fail(
        "INVALID_ARGUMENT",
        "Staging report cannot use the radio-lock namespace"
      );
    }
    return options;
  }
  if (
    options.sourceRegistry !== null ||
    options.registryPath !== null ||
    options.serverNodeId !== null ||
    options.adapterName !== "hci0"
  ) {
    fail(
      "INVALID_ARGUMENT",
      "Staging arguments are accepted only by API31 staging actions"
    );
  }
  if (options.state === null) fail("INVALID_ARGUMENT", "--state is required");
  if (options.mode === "INIT" && options.androidBaseline === null) {
    fail("INVALID_ARGUMENT", "--init requires --android-baseline");
  }
  if (options.mode !== "INIT" && options.androidBaseline !== null) {
    fail(
      "INVALID_ARGUMENT",
      "--android-baseline is accepted only with --init"
    );
  }
  if (options.mode === "PREFLIGHT" && options.output !== null) {
    fail("INVALID_ARGUMENT", "--preflight does not write output files");
  }
  if (options.mode === "FINALIZE" && options.manifest === null) {
    fail("INVALID_ARGUMENT", "--finalize requires --manifest");
  }
  if (options.mode !== "FINALIZE" && options.manifest !== null) {
    fail("INVALID_ARGUMENT", "--manifest is accepted only with --finalize");
  }
  const privatePaths = [
    options.state,
    options.androidBaseline,
    options.manifest
  ].filter(Boolean);
  if (new Set(privatePaths).size !== privatePaths.length) {
    fail("INVALID_ARGUMENT", "Collector private inputs and outputs must use distinct paths");
  }
  if (
    options.androidBaseline !== null &&
    conflictsWithPrivateNamespace(options.androidBaseline, options.state)
  ) {
    fail(
      "INVALID_ARGUMENT",
      "--android-baseline conflicts with the private collector namespace"
    );
  }
  if (
    options.manifest !== null &&
    conflictsWithPrivateNamespace(options.manifest, options.state)
  ) {
    fail("INVALID_ARGUMENT", "--manifest conflicts with the private collector namespace");
  }
  if (
    options.output !== null &&
    (conflictsWithPrivateNamespace(options.output, options.state) ||
      (options.androidBaseline !== null &&
        normalizedPath(options.output) ===
          normalizedPath(options.androidBaseline)) ||
      (options.manifest !== null &&
        conflictsWithPrivateNamespace(options.output, options.manifest)))
  ) {
    fail("INVALID_ARGUMENT", "--output conflicts with private collector artifacts");
  }
  if (
    [...privatePaths, options.output].filter(Boolean).some((location) =>
      conflictsWithRadioLockNamespace(location)
    )
  ) {
    fail("INVALID_ARGUMENT", "Collector artifacts cannot use the radio-lock namespace");
  }
  if (
    options.mode === "FINALIZE" &&
    !sameDirectory(path.dirname(options.state), path.dirname(options.manifest))
  ) {
    fail("MANIFEST_LOCATION_INVALID", "The private manifest must remain beside the collector state");
  }
  return options;
}

function usage() {
  return [
    "V6 B5 resumable physical-session collector",
    "",
    "Usage:",
    "  node scripts/collect-b5-direct-control-session.mjs --init --state PRIVATE.json \\",
    "    --android-baseline PRIVATE-ANDROID-BASELINE.json",
    "  node scripts/collect-b5-direct-control-session.mjs --preflight --state PRIVATE.json",
    "  node scripts/collect-b5-direct-control-session.mjs --status --state PRIVATE.json",
    "  node scripts/collect-b5-direct-control-session.mjs --capture --state PRIVATE.json",
    "  node scripts/collect-b5-direct-control-session.mjs --finalize --state PRIVATE.json \\",
    "    --manifest PRIVATE-MANIFEST.json [--output STATUS.json]",
    "  node scripts/collect-b5-direct-control-session.mjs --stage-registry \\",
    "    --source-registry SOURCE.json --registry STAGING.json",
    "  node scripts/collect-b5-direct-control-session.mjs --staging-preflight \\",
    "    --registry STAGING.json --server-node-id UUID [--adapter hci0]",
    "  node scripts/collect-b5-direct-control-session.mjs --staging-session \\",
    "    --registry STAGING.json --server-node-id UUID --output PRIVATE.json \\",
    "    [--adapter hci0]",
    "  node scripts/collect-b5-direct-control-session.mjs --self-test",
    "",
    "Capture invokes the fixed B5.7 physical runner and transient advertiser directly.",
    "The collector deliberately accepts no report import or alternate runner.",
    "API31 staging is one-shot, non-gate and never writes campaign state."
  ].join("\n");
}

function expectSelfTestFailure(action, expectedCode) {
  try {
    action();
  } catch (error) {
    if (error instanceof B5SessionCollectionError && error.code === expectedCode) {
      return "PASS";
    }
    throw error;
  }
  fail("SELF_TEST_FAILED", `Expected ${expectedCode} during collector self-test`);
}

export function runCollectorSelfTest() {
  const campaignRunId = "00000000-0000-4000-8000-000000000001";
  let state = createInitialCollectorState({
    now: "2026-07-20T00:00:00.000Z",
    campaignRunId,
    accountDeviceBinding: validB5AccountDeviceBindingFixture({ campaignId: campaignRunId })
  });
  let firstBytes = null;
  for (let sequence = 1; sequence <= B5_REQUIRED_SESSION_REPORTS; sequence += 1) {
    const reservation = reserveCaptureBootId(state, {
      randomInt: () => (sequence % 255) + 1
    });
    const report = validPhysicalReportFixture(sequence);
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    if (firstBytes === null) firstBytes = bytes;
    state = appendCapturedSession(reservation.state, bytes, {
      evidenceRecordId: `00000000-0000-4${String(sequence).padStart(3, "0")}-8000-${String(sequence).padStart(12, "0")}`,
      captureStartedAt: new Date(Date.parse(report.generatedAt) - 60_000).toISOString(),
      captureCompletedAt: new Date(Date.parse(report.generatedAt) + 1).toISOString()
    }).state;
  }
  const progress = buildProgressReport(state, {
    generatedAt: "2026-07-22T00:00:00.000Z",
    operation: "SELF_TEST"
  });
  const privateEvidenceTamperRejected = expectSelfTestFailure(
    () =>
      assertEvidenceDigest(
        Buffer.concat([firstBytes, Buffer.from("x")]),
        state.records[0]
      ),
    "PRIVATE_EVIDENCE_HASH_MISMATCH"
  );
  const duplicateTimestamp = validPhysicalReportFixture(99);
  duplicateTimestamp.observed.pingsSent = 5;
  const duplicateGeneratedAtMs = Date.parse(duplicateTimestamp.generatedAt);
  const duplicateTimestampRejected = expectSelfTestFailure(
    () =>
      appendCapturedSession(
        {
          ...state,
          updatedAt: state.records[98].captureCompletedAt,
          records: state.records.slice(0, 99),
          collectionCommitmentSha256: collectionCommitment(
            state.records.slice(0, 99)
          )
        },
        Buffer.from(`${JSON.stringify(duplicateTimestamp, null, 2)}\n`),
        {
          evidenceRecordId: "00000000-0000-4000-8000-000000000101",
          captureStartedAt: new Date(duplicateGeneratedAtMs - 1).toISOString(),
          captureCompletedAt: new Date(duplicateGeneratedAtMs + 1).toISOString()
        }
      ),
    "DUPLICATE_EVIDENCE"
  );
  const completeCollectionRejectedBeforeRunner = expectSelfTestFailure(
    () => assertCollectionAcceptsCapture(state),
    "COLLECTION_COMPLETE"
  );
  const translatedAbort = translateGateError({ code: "PHYSICAL_CAPTURE_ABORTED" });
  if (translatedAbort.code !== "CAPTURE_ABORTED" || translatedAbort.exitCode !== 130) {
    fail("SELF_TEST_FAILED", "Physical abort translation is not fail-closed");
  }
  if (
    progress.verdict !== "READY" ||
    progress.progress.collectedSessions !== B5_REQUIRED_SESSION_REPORTS ||
    progress.gate.b5HundredSessionGate !== "PENDING" ||
    progress.authoritativeB5GateExecuted !== false
  ) {
    fail("SELF_TEST_FAILED", "B5 physical-session collector self-test failed");
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_SESSION_COLLECTOR_VERSION,
    product: "V6",
    phase: "B5",
    generatedAt: "2026-07-22T00:00:00.000Z",
    mode: "SELF_TEST",
    verdict: "PASS",
    checks: Object.freeze({
      exactSyntheticSequence: "PASS",
      privateEvidenceTamperRejected,
      duplicateTimestampRejected,
      completeCollectionRejectedBeforeRunner,
      physicalAbortReturns130: "PASS",
      arbitraryReportImportUnavailable: "PASS",
      alternateRunnerUnavailable: "PASS",
      gateRemainsPending: "PASS"
    }),
    syntheticReportsValidated: B5_REQUIRED_SESSION_REPORTS,
    physicalEvidenceConsumed: false,
    privateStateWritten: false,
    authoritativeB5GateExecuted: false,
    b5GatePromoted: false,
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
      sourceReportDetailsIncluded: false
    }),
    v6ProductionServiceChanges: false
  });
}

function failureReport(options, error) {
  const stagingSession = options?.mode === "API31_STAGING_SESSION";
  return {
    schemaVersion: 1,
    harnessVersion: B5_SESSION_COLLECTOR_VERSION,
    product: "V6",
    phase: stagingSession ? "B5.7" : "B5",
    generatedAt: new Date().toISOString(),
    mode: options?.mode ?? "UNKNOWN",
    verdict: "FAIL",
    failure: {
      code: error.code,
      message: error.message,
      cleanupVerified: error.cleanupVerified === true
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
      sourceReportDetailsIncluded: false
    },
    physicalRadioAccessed: stagingSession,
    physicalEvidenceConsumed: false,
    authoritativeB5GateExecuted: false,
    b5GatePromoted: false,
    v6ProductionServiceChanges: false
  };
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
      writeJson(null, runCollectorSelfTest());
      return 0;
    }
    if (options.mode === "API31_STAGING_REGISTRY_COPY") {
      const report = await prepareApi31StagingRegistrySnapshot(
        options.sourceRegistry,
        options.registryPath
      );
      writeJson(null, report);
      return 0;
    }
    const stagingOptions = API31_STAGING_MODES.has(options.mode)
      ? {
          adapterName: options.adapterName,
          serverNodeId: options.serverNodeId,
          holdMs: DEFAULT_HOLD_MS,
          registryPath: options.registryPath
        }
      : null;
    if (options.mode === "API31_STAGING_PREFLIGHT") {
      writeJson(null, await runApi31StagingPreflight(stagingOptions));
      return 0;
    }
    if (options.mode === "API31_STAGING_SESSION") {
      assertWritableDestination(options.output, false);
      preflightPublicOutput(options.output);
      const report = await runApi31StagingDirectControl(stagingOptions);
      writeExclusiveJson(options.output, report);
      return 0;
    }
    if (options.mode === "PREFLIGHT") {
      writeJson(null, inspectCollectorPreflight(options.state));
      return 0;
    }
    preflightPublicOutput(options.output);
    if (options.mode === "INIT") {
      await withStateLock(options.state, async () => {
        if (
          fileExistsWithoutFollowing(options.state) ||
          fileExistsWithoutFollowing(journalPathForState(options.state)) ||
          fileExistsWithoutFollowing(evidenceDirectoryForState(options.state))
        ) {
          fail("STATE_ALREADY_EXISTS", "Private collector artifacts already exist");
        }
        const accountDeviceBinding = readAccountDeviceBinding(
          options.androidBaseline
        );
        const state = createInitialCollectorState({ accountDeviceBinding });
        atomicWrite(options.state, `${JSON.stringify(state, null, 2)}\n`, {
          allowExisting: false
        });
        writeJson(
          options.output,
          buildProgressReport(state, { operation: "INIT" }),
          { operationCommitted: true }
        );
      });
      return 0;
    }
    await withStateLock(options.state, async () => {
      let state = readCollectorState(options.state);
      cleanupCollectorTemporaries(options.state);
      state = readCollectorState(options.state);
      state = recoverPendingCapture(options.state, state);
      verifyStagedEvidence(state, options.state);
      if (options.mode === "STATUS") {
        writeJson(options.output, buildProgressReport(state));
        return;
      }
      if (options.mode === "FINALIZE") {
        const manifest = buildEvidenceManifest(state, options.state, options.manifest);
        const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
        if (fileExistsWithoutFollowing(options.manifest)) {
          const existing = readBoundedRegularFile(
            options.manifest,
            MAX_STATE_BYTES,
            "MANIFEST_CONFLICT",
            "Private B5 evidence manifest",
            { privateMode: true }
          );
          if (!existing.equals(encoded)) {
            fail("MANIFEST_CONFLICT", "Existing private manifest has different content");
          }
        } else {
          atomicWrite(options.manifest, encoded, { allowExisting: false });
        }
        writeJson(
          options.output,
          buildProgressReport(state, { operation: "MANIFEST_READY" }),
          { operationCommitted: true }
        );
        return;
      }
      const reservation = reserveCaptureBootId(state);
      atomicWrite(
        options.state,
        `${JSON.stringify(reservation.state, null, 2)}\n`
      );
      const capture = await capturePhysicalSession(
        reservation.state,
        reservation.bootId
      );
      persistCapture(options.state, reservation.state, capture);
      writeJson(
        options.output,
        buildProgressReport(capture.state, { operation: "CAPTURED" }),
        { operationCommitted: true }
      );
    });
    return 0;
  } catch (error) {
    const safeError = translateGateError(error);
    const report = failureReport(options, safeError);
    try {
      assertAggregateReportRedacted(report);
    } catch {
      report.failure = {
        code: "B5_SESSION_COLLECTION_FAILED",
        message: "B5 physical-session collection failed"
      };
    }
    try {
      if (
        options?.mode === "API31_STAGING_SESSION" &&
        options.output !== null &&
        !fileExistsWithoutFollowing(options.output)
      ) {
        writeExclusiveJson(options.output, report);
      } else {
        writeJson(
          options?.mode === "API31_STAGING_SESSION"
            ? null
            : options?.output ?? null,
          report
        );
      }
    } catch {
      writeJson(null, report);
    }
    return safeError.exitCode;
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
