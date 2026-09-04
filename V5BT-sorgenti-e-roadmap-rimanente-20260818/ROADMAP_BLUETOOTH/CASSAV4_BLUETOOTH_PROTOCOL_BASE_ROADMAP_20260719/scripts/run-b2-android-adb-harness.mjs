#!/usr/bin/env node

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnrollmentRequestJson } from
  "../shared/provisioning/enrollment-transport-v1.mjs";
import { ADVANCED_CERTIFICATION_TARGETS } from
  "./advanced-certification-targets.mjs";

export const HARNESS_VERSION = "1.0.1";
export const MIN_ANDROID_API = 33;
export const B2_DISCOVERY_P95_TARGET_MS = 8_000;
export const MAX_QR_BYTES = 512;
export const ENROLLMENT_INPUT_FILE =
  "no_backup/bluetooth-enrollment-qr-v1.json";
export const ENROLLMENT_STATUS_FILE =
  "no_backup/bluetooth-enrollment-status-v1.json";
export const DISCOVERY_STATUS_FILE =
  "no_backup/bluetooth-discovery-status-v1.json";

const ENROLLMENT_PROCESSING_FILE =
  "no_backup/bluetooth-enrollment-qr-v1.processing";
const ENROLLMENT_TEMP_FILE = `${ENROLLMENT_INPUT_FILE}.tmp`;
const DISCOVERY_STATUS_BACKUP_FILE = `${DISCOVERY_STATUS_FILE}.bak`;
const PACKAGE_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SERIAL_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^c5e1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const SSH_TARGET_PATTERN =
  /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const COMPONENT_PATTERN =
  /^[A-Za-z][A-Za-z0-9_.]*\/(?:\.[A-Za-z][A-Za-z0-9_.$]*|[A-Za-z][A-Za-z0-9_.$.]*)$/;
const APK_PATH_PATTERN = /^\/data\/app\/[A-Za-z0-9_./=+~-]+\.apk$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CERTIFICATION_TARGET_BY_PACKAGE = new Map(
  Object.entries(ADVANCED_CERTIFICATION_TARGETS.roles).map(([role, target]) => [
    target.packageId,
    Object.freeze({ role, ...target })
  ])
);

const BLUETOOTH_RUNTIME_PERMISSIONS = Object.freeze([
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.BLUETOOTH_CONNECT"
]);

const ENROLLMENT_STATUSES = new Set([
  "IDLE",
  "BUSY",
  "INPUT_INVALID",
  "ENDPOINT_MISMATCH",
  "IDENTITY_FAILED",
  "CLIENT_FAILED",
  "IMPORT_FAILED",
  "READY",
  "ALREADY_PROVISIONED",
  "STORAGE_FAILED",
  "INTERRUPTED",
  "CLOSED"
]);
const ENROLLMENT_NON_TERMINAL_STATUSES = new Set(["IDLE", "BUSY"]);
const DISCOVERY_READINESS_VALUES = new Set([
  "READY",
  "DISCOVERY_FEATURE_DISABLED",
  "IDENTITY_FEATURE_DISABLED",
  "PLATFORM_UNSUPPORTED",
  "IDENTITY_NOT_READY",
  "BLE_HARDWARE_UNAVAILABLE",
  "PERMISSIONS_REQUIRED",
  "ADAPTER_DISABLED",
  "CAPABILITY_NOT_FULL_NODE"
]);

const ENROLLMENT_STATUS_FIELDS = new Set([
  "version",
  "status",
  "identityStatus",
  "clientStatus",
  "parseCode",
  "httpStatus"
]);
const DISCOVERY_STATUS_FIELDS = new Set([
  "schemaVersion",
  "source",
  "labBuild",
  "diagnosticsEnabled",
  "sampleSequence",
  "sampledAtEpochMs",
  "reporterStartedAtEpochMs",
  "readiness",
  "ready",
  "radioActive",
  "scanProfile",
  "activePeerCount",
  "metrics"
]);
const DISCOVERY_METRIC_FIELDS = new Set([
  "scanWindowsStarted",
  "concurrentScanAdvertiseWindowsStarted",
  "scanWindowsCompleted",
  "scanFailures",
  "advertisementsStarted",
  "advertisementUpdates",
  "advertisementFailures",
  "invalidPayloads",
  "acceptedObservations",
  "scanIngressDropped",
  "peerExpiryCount",
  "firstObservationOffsetP95Ms",
  "peerDirectory"
]);
const PEER_DIRECTORY_METRIC_FIELDS = new Set([
  "added",
  "updated",
  "duplicateRefreshes",
  "belowRssiFloor",
  "olderRejected",
  "ambiguousRejected",
  "conflicts",
  "directoryFull",
  "newStreamAttemptRateRejected",
  "capacityEvicted",
  "clockRegressions",
  "expired",
  "prunePasses",
  "newStreamAttempts",
  "newStreamsAccepted",
  "newStreamAttemptWindowsStarted",
  "capacityHighWatermark"
]);

const PRIVATE_CLEANUP_SCRIPT = [
  "set -eu",
  "umask 077",
  "mkdir -p no_backup",
  `rm -f ${ENROLLMENT_INPUT_FILE}`,
  `rm -f ${ENROLLMENT_PROCESSING_FILE}`,
  `rm -f ${ENROLLMENT_TEMP_FILE}`,
  `rm -f ${ENROLLMENT_STATUS_FILE}`,
  `rm -f ${DISCOVERY_STATUS_FILE}`,
  `rm -f ${DISCOVERY_STATUS_BACKUP_FILE}`
].join("; ");

const DISCOVERY_ONLY_CLEANUP_SCRIPT = [
  "set -eu",
  "umask 077",
  "mkdir -p no_backup",
  `rm -f ${DISCOVERY_STATUS_FILE}`,
  `rm -f ${DISCOVERY_STATUS_BACKUP_FILE}`
].join("; ");

const PRIVATE_STAGE_SCRIPT = [
  "set -eu",
  "umask 077",
  "mkdir -p no_backup",
  `rm -f ${ENROLLMENT_TEMP_FILE}`,
  `trap 'rm -f ${ENROLLMENT_TEMP_FILE}' EXIT HUP INT TERM`,
  `cat > ${ENROLLMENT_TEMP_FILE}`,
  `test -s ${ENROLLMENT_TEMP_FILE}`,
  `chmod 600 ${ENROLLMENT_TEMP_FILE}`,
  `mv ${ENROLLMENT_TEMP_FILE} ${ENROLLMENT_INPUT_FILE}`,
  "trap - EXIT HUP INT TERM"
].join("; ");

function quoteAdbShellArgument(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class HarnessError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1) {
  throw new HarnessError(code, message, exitCode);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactFields(value, expected, code) {
  if (!isPlainObject(value)) {
    fail(code, "Expected a JSON object");
  }
  const fields = Object.keys(value);
  if (
    fields.length !== expected.size ||
    fields.some((field) => !expected.has(field))
  ) {
    fail(code, "Unexpected or missing JSON field");
  }
}

function requireNonNegativeSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, "Expected a non-negative safe integer");
  }
  return value;
}

function parsePositiveInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(String(value ?? ""))) {
    fail("ARGUMENT_INVALID", `${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(
      "ARGUMENT_INVALID",
      `${name} must be between ${minimum} and ${maximum}`
    );
  }
  return parsed;
}

export function parseArguments(argv) {
  const options = {
    adb: "adb",
    enrollmentTimeoutMs: 30_000,
    discoverySeconds: 20,
    pollMs: 500,
    btmonSeconds: null,
    dryRun: false,
    selfTest: false,
    skipEnrollment: false,
    help: false
  };
  const valueOptions = new Map([
    ["--adb", "adb"],
    ["--serial", "serial"],
    ["--package", "packageName"],
    ["--expected-model", "expectedModel"],
    ["--qr-file", "qrFile"],
    ["--output", "output"],
    ["--enrollment-timeout-ms", "enrollmentTimeoutMs"],
    ["--discovery-seconds", "discoverySeconds"],
    ["--poll-ms", "pollMs"],
    ["--btmon-ssh-target", "btmonSshTarget"],
    ["--btmon-seconds", "btmonSeconds"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (argument === "--skip-enrollment") {
      options.skipEnrollment = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const property = valueOptions.get(argument);
    if (property === undefined) {
      fail("ARGUMENT_UNKNOWN", "An unknown argument was provided");
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("ARGUMENT_MISSING", `Missing value for ${argument}`);
    }
    options[property] = value;
    index += 1;
  }
  return options;
}

export function isValidAdbSerial(value) {
  return typeof value === "string" && SERIAL_PATTERN.test(value);
}

export function validateOptions(options) {
  if (options.help || options.selfTest) return options;
  if (
    !isValidAdbSerial(options.serial)
  ) {
    fail("SERIAL_INVALID", "A valid explicit ADB serial is required");
  }
  if (
    typeof options.packageName !== "string" ||
    !PACKAGE_PATTERN.test(options.packageName)
  ) {
    fail("PACKAGE_INVALID", "A valid Android package name is required");
  }
  if (
    options.expectedModel !== undefined &&
    (
      typeof options.expectedModel !== "string" ||
      options.expectedModel.length < 1 ||
      options.expectedModel.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(options.expectedModel)
    )
  ) {
    fail("MODEL_INVALID", "The expected model value is invalid");
  }
  if (
    typeof options.adb !== "string" ||
    options.adb.length < 1 ||
    /[\u0000\r\n]/.test(options.adb)
  ) {
    fail("ADB_PATH_INVALID", "The ADB executable path is invalid");
  }
  options.enrollmentTimeoutMs = parsePositiveInteger(
    options.enrollmentTimeoutMs,
    "--enrollment-timeout-ms",
    1_000,
    300_000
  );
  options.discoverySeconds = parsePositiveInteger(
    options.discoverySeconds,
    "--discovery-seconds",
    1,
    7_200
  );
  options.pollMs = parsePositiveInteger(
    options.pollMs,
    "--poll-ms",
    250,
    5_000
  );
  if (!options.skipEnrollment && typeof options.qrFile !== "string") {
    fail(
      "QR_SOURCE_REQUIRED",
      "--qr-file is required unless --skip-enrollment is used"
    );
  }
  if (options.qrFile !== undefined && options.qrFile.length === 0) {
    fail("QR_SOURCE_INVALID", "The QR source path is invalid");
  }
  if (
    options.btmonSshTarget !== undefined &&
    !SSH_TARGET_PATTERN.test(options.btmonSshTarget)
  ) {
    fail(
      "BTMON_TARGET_INVALID",
      "The btmon SSH target must be user@hostname without credentials"
    );
  }
  if (options.btmonSeconds === null) {
    options.btmonSeconds = options.discoverySeconds + 10;
  } else {
    options.btmonSeconds = parsePositiveInteger(
      options.btmonSeconds,
      "--btmon-seconds",
      1,
      7_300
    );
  }
  return options;
}

export function validateEnrollmentQr(qrBytes) {
  if (
    !Buffer.isBuffer(qrBytes) &&
    !(qrBytes instanceof Uint8Array)
  ) {
    fail("QR_INVALID", "Enrollment QR input must be bytes");
  }
  const bytes = Buffer.from(qrBytes);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_QR_BYTES) {
    fail(
      "QR_SIZE_INVALID",
      `Enrollment QR must contain 1 to ${MAX_QR_BYTES} bytes`
    );
  }
  let qr;
  try {
    qr = parseEnrollmentRequestJson(bytes);
  } catch {
    fail("QR_JSON_INVALID", "Enrollment QR is not strict flat JSON");
  }
  const expectedFields = new Set([
    "version",
    "enrollmentEndpointId",
    "token"
  ]);
  requireExactFields(qr, expectedFields, "QR_STRUCTURE_INVALID");
  if (
    qr.version !== 1 ||
    typeof qr.enrollmentEndpointId !== "string" ||
    !ENDPOINT_ID_PATTERN.test(qr.enrollmentEndpointId) ||
    typeof qr.token !== "string" ||
    !TOKEN_PATTERN.test(qr.token)
  ) {
    fail("QR_CONTRACT_INVALID", "Enrollment QR violates contract v1");
  }
  const tokenPayload = qr.token.slice(5);
  if (
    Buffer.from(tokenPayload, "base64url").toString("base64url") !==
    tokenPayload
  ) {
    fail("QR_TOKEN_NON_CANONICAL", "Enrollment token is not canonical");
  }
  return {
    version: 1,
    enrollmentEndpointId: qr.enrollmentEndpointId,
    token: qr.token,
    byteLength: bytes.byteLength
  };
}

export function parseAdbDevices(output) {
  if (typeof output !== "string") {
    fail("ADB_DEVICES_INVALID", "ADB device output is invalid");
  }
  const devices = [];
  for (const rawLine of output.split(/\r?\n/).slice(1)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("* daemon")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 2) continue;
    const properties = Object.create(null);
    for (const field of fields.slice(2)) {
      const separator = field.indexOf(":");
      if (separator > 0) {
        properties[field.slice(0, separator)] = field.slice(separator + 1);
      }
    }
    devices.push({
      serial: fields[0],
      state: fields[1],
      transportModel: properties.model ?? null,
      transportProduct: properties.product ?? null,
      transportDevice: properties.device ?? null
    });
  }
  return devices;
}

function parseJsonStatus(raw, maximumBytes, code) {
  if (typeof raw !== "string") {
    fail(code, "Status payload is not text");
  }
  if (
    Buffer.byteLength(raw, "utf8") < 2 ||
    Buffer.byteLength(raw, "utf8") > maximumBytes
  ) {
    fail(code, "Status payload size is invalid");
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(code, "Status payload is not valid JSON");
  }
}

function nullableSafeEnum(value, code) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)
  ) {
    fail(code, "Status enum value is invalid");
  }
  return value;
}

export function parseEnrollmentStatus(raw) {
  const value = parseJsonStatus(raw, 4_096, "ENROLLMENT_STATUS_INVALID");
  requireExactFields(
    value,
    ENROLLMENT_STATUS_FIELDS,
    "ENROLLMENT_STATUS_INVALID"
  );
  if (
    value.version !== 1 ||
    typeof value.status !== "string" ||
    !ENROLLMENT_STATUSES.has(value.status)
  ) {
    fail("ENROLLMENT_STATUS_INVALID", "Enrollment status header is invalid");
  }
  const httpStatus =
    value.httpStatus === null
      ? null
      : requireNonNegativeSafeInteger(
          value.httpStatus,
          "ENROLLMENT_STATUS_INVALID"
        );
  if (httpStatus !== null && (httpStatus < 100 || httpStatus > 599)) {
    fail("ENROLLMENT_STATUS_INVALID", "Enrollment HTTP status is invalid");
  }
  return {
    version: 1,
    status: value.status,
    identityStatus: nullableSafeEnum(
      value.identityStatus,
      "ENROLLMENT_STATUS_INVALID"
    ),
    clientStatus: nullableSafeEnum(
      value.clientStatus,
      "ENROLLMENT_STATUS_INVALID"
    ),
    parseCode: nullableSafeEnum(
      value.parseCode,
      "ENROLLMENT_STATUS_INVALID"
    ),
    httpStatus
  };
}

function copyNonNegativeMetrics(value, expectedFields, code) {
  requireExactFields(value, expectedFields, code);
  const result = Object.create(null);
  for (const field of expectedFields) {
    result[field] = requireNonNegativeSafeInteger(value[field], code);
  }
  return result;
}

export function parseDiscoveryStatus(raw) {
  const value = parseJsonStatus(raw, 16_384, "DISCOVERY_STATUS_INVALID");
  requireExactFields(
    value,
    DISCOVERY_STATUS_FIELDS,
    "DISCOVERY_STATUS_INVALID"
  );
  if (
    value.schemaVersion !== 1 ||
    value.source !== "V5BT_ANDROID_DISCOVERY_LAB" ||
    value.labBuild !== true ||
    value.diagnosticsEnabled !== true ||
    typeof value.readiness !== "string" ||
    !DISCOVERY_READINESS_VALUES.has(value.readiness) ||
    typeof value.ready !== "boolean" ||
    value.ready !== (value.readiness === "READY") ||
    typeof value.radioActive !== "boolean" ||
    (value.scanProfile !== "STABLE" && value.scanProfile !== "FAILOVER")
  ) {
    fail("DISCOVERY_STATUS_INVALID", "Discovery status header is invalid");
  }
  const activePeerCount = requireNonNegativeSafeInteger(
    value.activePeerCount,
    "DISCOVERY_STATUS_INVALID"
  );
  if (activePeerCount > 1_024) {
    fail("DISCOVERY_STATUS_INVALID", "Active peer count exceeds the B2 limit");
  }
  requireExactFields(
    value.metrics,
    DISCOVERY_METRIC_FIELDS,
    "DISCOVERY_STATUS_INVALID"
  );
  const metrics = Object.create(null);
  for (const field of DISCOVERY_METRIC_FIELDS) {
    if (field === "firstObservationOffsetP95Ms" || field === "peerDirectory") {
      continue;
    }
    metrics[field] = requireNonNegativeSafeInteger(
      value.metrics[field],
      "DISCOVERY_STATUS_INVALID"
    );
  }
  metrics.firstObservationOffsetP95Ms =
    value.metrics.firstObservationOffsetP95Ms === null
      ? null
      : requireNonNegativeSafeInteger(
          value.metrics.firstObservationOffsetP95Ms,
          "DISCOVERY_STATUS_INVALID"
        );
  metrics.peerDirectory = copyNonNegativeMetrics(
    value.metrics.peerDirectory,
    PEER_DIRECTORY_METRIC_FIELDS,
    "DISCOVERY_STATUS_INVALID"
  );
  return {
    schemaVersion: 1,
    source: value.source,
    labBuild: true,
    diagnosticsEnabled: true,
    sampleSequence: requireNonNegativeSafeInteger(
      value.sampleSequence,
      "DISCOVERY_STATUS_INVALID"
    ),
    sampledAtEpochMs: requireNonNegativeSafeInteger(
      value.sampledAtEpochMs,
      "DISCOVERY_STATUS_INVALID"
    ),
    reporterStartedAtEpochMs: requireNonNegativeSafeInteger(
      value.reporterStartedAtEpochMs,
      "DISCOVERY_STATUS_INVALID"
    ),
    readiness: value.readiness,
    ready: value.ready,
    radioActive: value.radioActive,
    scanProfile: value.scanProfile,
    activePeerCount,
    metrics
  };
}

function runAsUserArgs(currentUser) {
  if (currentUser === undefined) return [];
  if (!Number.isSafeInteger(currentUser) || currentUser < 0) {
    fail("ANDROID_USER_INVALID", "Android user must be a nonnegative integer");
  }
  return ["--user", String(currentUser)];
}

export function buildPrivateCleanupArgs(
  serial,
  packageName,
  skipEnrollment,
  currentUser = undefined
) {
  return [
    "-s",
    serial,
    "exec-out",
    "run-as",
    packageName,
    ...runAsUserArgs(currentUser),
    "sh",
    "-c",
    skipEnrollment
      ? DISCOVERY_ONLY_CLEANUP_SCRIPT
      : PRIVATE_CLEANUP_SCRIPT
  ];
}

export function buildPrivateStageArgs(
  serial,
  packageName,
  currentUser = undefined
) {
  return [
    "-s",
    serial,
    "shell",
    "-T",
    "run-as",
    packageName,
    ...runAsUserArgs(currentUser),
    "sh",
    "-c",
    quoteAdbShellArgument(PRIVATE_STAGE_SCRIPT)
  ];
}

export function buildBtmonPlan(sshTarget, seconds) {
  if (sshTarget === undefined) return null;
  if (!SSH_TARGET_PATTERN.test(sshTarget)) {
    fail("BTMON_TARGET_INVALID", "Invalid credential-free SSH target");
  }
  const duration = parsePositiveInteger(seconds, "btmon seconds", 1, 7_300);
  return {
    executedByHarness: false,
    transport: "ssh",
    argv: [
      "ssh",
      "-T",
      sshTarget,
      "--",
      "sudo",
      "-n",
      "timeout",
      `${duration}s`,
      "btmon"
    ],
    capture: "Redirect stdout to a local, access-controlled evidence file",
    activeV4Changes: false,
    credentialsEmbedded: false
  };
}

export function evaluateDiscoveryEvidence(latest, sawReady) {
  if (latest === null) {
    return {
      status: "FAIL",
      code: "DISCOVERY_STATUS_MISSING"
    };
  }
  if (!sawReady || latest.readiness !== "READY") {
    return {
      status: "FAIL",
      code: "DISCOVERY_NOT_READY",
      readiness: latest.readiness
    };
  }
  if (!latest.radioActive) {
    return {
      status: "FAIL",
      code: "DISCOVERY_RADIO_INACTIVE"
    };
  }
  const metrics = latest.metrics;
  if (
    metrics.scanFailures > 0 ||
    metrics.advertisementFailures > 0 ||
    metrics.scanIngressDropped > 0
  ) {
    return {
      status: "FAIL",
      code: "DISCOVERY_RADIO_FAILURE",
      scanFailures: metrics.scanFailures,
      advertisementFailures: metrics.advertisementFailures,
      scanIngressDropped: metrics.scanIngressDropped
    };
  }
  if (
    metrics.scanWindowsStarted < 1 ||
    metrics.advertisementsStarted < 1
  ) {
    return {
      status: "FAIL",
      code: "DISCOVERY_RADIO_INACTIVE"
    };
  }
  if (
    metrics.acceptedObservations < 1 ||
    metrics.firstObservationOffsetP95Ms === null
  ) {
    return {
      status: "PENDING",
      code: "RECIPROCAL_PEER_NOT_OBSERVED"
    };
  }
  if (
    metrics.firstObservationOffsetP95Ms >
    B2_DISCOVERY_P95_TARGET_MS
  ) {
    return {
      status: "FAIL",
      code: "DISCOVERY_P95_EXCEEDED",
      measuredP95Ms: metrics.firstObservationOffsetP95Ms,
      targetP95Ms: B2_DISCOVERY_P95_TARGET_MS
    };
  }
  return {
    status: "PASS",
    code: "SINGLE_NODE_DISCOVERY_EVIDENCE_PASS",
    measuredP95Ms: metrics.firstObservationOffsetP95Ms,
    targetP95Ms: B2_DISCOVERY_P95_TARGET_MS
  };
}

export function assertReportContainsNoEnrollmentToken(report, token = null) {
  const serialized = JSON.stringify(report);
  if (
    TOKEN_PATTERN.test(serialized) ||
    /c5e1_[A-Za-z0-9_-]{43}/.test(serialized) ||
    (typeof token === "string" && serialized.includes(token))
  ) {
    fail(
      "REPORT_SECRET_DETECTED",
      "Enrollment material was detected in the report"
    );
  }
  return serialized;
}

export class AdbClient {
  constructor(executable, serial, commandTimeoutMs = 15_000) {
    this.executable = executable;
    this.serial = serial;
    this.commandTimeoutMs = commandTimeoutMs;
  }

  run(args, options = {}) {
    const result = childProcess.spawnSync(this.executable, args, {
      encoding: "utf8",
      input: options.input,
      timeout: options.timeoutMs ?? this.commandTimeoutMs,
      maxBuffer: options.maxBuffer ?? 64 * 1024,
      windowsHide: true
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    if (result.error !== undefined) {
      const code =
        result.error.code === "ENOENT" ? "ADB_NOT_FOUND" : "ADB_EXECUTION_FAILED";
      return { ok: false, code, stdout, stderr, status: null };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        code: "ADB_COMMAND_FAILED",
        stdout,
        stderr,
        status: result.status
      };
    }
    return { ok: true, code: null, stdout, stderr, status: 0 };
  }

  require(args, code, options = {}) {
    const result = this.run(args, options);
    if (!result.ok) {
      fail(code, "ADB command failed");
    }
    return result.stdout;
  }

  serialArgs(...args) {
    return ["-s", this.serial, ...args];
  }

  shell(...args) {
    return this.run(this.serialArgs("shell", ...args));
  }

  execOutRunAs(packageName, ...args) {
    return this.run(
      this.serialArgs("exec-out", "run-as", packageName, ...args),
      { maxBuffer: 32 * 1024 }
    );
  }

  execOutRunAsForUser(packageName, currentUser, ...args) {
    if (!Number.isSafeInteger(currentUser) || currentUser < 0) {
      return {
        ok: false,
        code: "ANDROID_USER_INVALID",
        stdout: "",
        stderr: "",
        status: null
      };
    }
    return this.execOutRunAs(
      packageName,
      "--user",
      String(currentUser),
      ...args
    );
  }
}

function check(id, status, detail) {
  return detail === undefined
    ? { id, status }
    : { id, status, detail };
}

function lastComponentLine(output, packageName) {
  const component = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("/"))
    .at(-1);
  if (
    component === undefined ||
    !COMPONENT_PATTERN.test(component) ||
    !component.startsWith(`${packageName}/`)
  ) {
    return null;
  }
  return component;
}

export function packagePermissionGrantedForUser(
  packageDump,
  currentUser,
  permission
) {
  if (
    typeof packageDump !== "string" ||
    !Number.isSafeInteger(currentUser) ||
    currentUser < 0 ||
    typeof permission !== "string"
  ) {
    return false;
  }
  const lines = packageDump.split(/\r?\n/);
  const userHeader = new RegExp(`^\\s*User ${currentUser}:`);
  const anyUserHeader = /^\s*User \d+:/;
  let insideCurrentUser = false;
  for (const line of lines) {
    if (userHeader.test(line)) {
      insideCurrentUser = true;
      continue;
    }
    if (insideCurrentUser && anyUserHeader.test(line)) {
      break;
    }
    if (
      insideCurrentUser &&
      line.includes(permission) &&
      /\bgranted=true\b/.test(line)
    ) {
      return true;
    }
  }
  return false;
}

export function parseCertifiedInstalledVersion(packageDump) {
  if (typeof packageDump !== "string") return null;
  const versionNameMatches = [
    ...packageDump.matchAll(/^\s*versionName=([^\s]+)\s*$/gmu)
  ];
  const versionCodeMatches = [
    ...packageDump.matchAll(/^\s*versionCode=([0-9]+)(?:\s|$)/gmu)
  ];
  if (versionNameMatches.length !== 1 || versionCodeMatches.length !== 1) {
    return null;
  }
  const versionName = versionNameMatches[0][1];
  const versionCode = Number(versionCodeMatches[0][1]);
  if (
    !/^[0-9]+(?:\.[0-9]+){2}$/u.test(versionName) ||
    !Number.isSafeInteger(versionCode) ||
    versionCode <= 0
  ) {
    return null;
  }
  return Object.freeze({ versionName, versionCode });
}

export function parseSingleInstalledApkPath(packagePathOutput) {
  if (typeof packagePathOutput !== "string") return null;
  const lines = packagePathOutput
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith("package:")) return null;
  const apkPath = lines[0].slice("package:".length);
  return APK_PATH_PATTERN.test(apkPath) ? apkPath : null;
}

export function parseBoundInstalledApkSha256(shaOutput, expectedApkPath) {
  if (
    typeof shaOutput !== "string" ||
    typeof expectedApkPath !== "string" ||
    !APK_PATH_PATTERN.test(expectedApkPath)
  ) {
    return null;
  }
  const lines = shaOutput
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return null;
  const match = lines[0].match(/^([0-9a-fA-F]{64})\s+(.+)$/u);
  if (match === null || match[2] !== expectedApkPath) return null;
  const digest = match[1].toLowerCase();
  return SHA256_PATTERN.test(digest) ? digest : null;
}

export async function runPreflight(adb, options) {
  const checks = [];
  const certifiedTarget = CERTIFICATION_TARGET_BY_PACKAGE.get(
    options.packageName
  );
  const target = {
    serial: options.serial,
    model: null,
    androidApi: null,
    currentUser: null,
    bluetoothLeFeature: null,
    bluetoothEnabled: null,
    packageName: options.packageName,
    certificationRole: certifiedTarget?.role ?? null,
    expectedVersionName: certifiedTarget?.versionName ?? null,
    expectedVersionCode: certifiedTarget?.versionCode ?? null,
    versionName: null,
    versionCode: null,
    certifiedVersion: false,
    singleApkLayout: false,
    certifiedApkSha256: false,
    packageInstalled: false,
    runAsAvailable: false,
    launcherComponent: null,
    runtimePermissions: Object.create(null)
  };

  checks.push(
    check(
      "app.package_certified",
      certifiedTarget === undefined ? "FAIL" : "PASS",
      certifiedTarget === undefined
        ? "Package is not present in the certification matrix"
        : `Certified ${certifiedTarget.role} target`
    )
  );
  if (certifiedTarget === undefined) {
    return { passed: false, target, checks };
  }

  const versionResult = adb.run(["version"]);
  checks.push(
    check(
      "adb.available",
      versionResult.ok ? "PASS" : "FAIL",
      versionResult.ok ? "ADB responded" : versionResult.code
    )
  );
  if (!versionResult.ok) {
    return { passed: false, target, checks };
  }

  const devicesResult = adb.run(["devices", "-l"]);
  const devices = devicesResult.ok
    ? parseAdbDevices(devicesResult.stdout)
    : [];
  const selected = devices.find((device) => device.serial === options.serial);
  const deviceReady = selected?.state === "device";
  checks.push(
    check(
      "device.serial_authorized",
      deviceReady ? "PASS" : "FAIL",
      selected === undefined ? "Serial not listed" : `ADB state ${selected.state}`
    )
  );
  if (!deviceReady) {
    return { passed: false, target, checks };
  }

  const modelResult = adb.shell("getprop", "ro.product.model");
  const model = modelResult.ok ? modelResult.stdout.trim() : "";
  target.model = model || null;
  checks.push(
    check(
      "device.model_readable",
      model.length > 0 ? "PASS" : "FAIL",
      model.length > 0 ? model : "Model unavailable"
    )
  );
  if (options.expectedModel !== undefined) {
    checks.push(
      check(
        "device.model_matches_expected",
        model === options.expectedModel ? "PASS" : "FAIL",
        model === options.expectedModel
          ? "Exact model match"
          : "Model does not match expected value"
      )
    );
  }

  const apiResult = adb.shell("getprop", "ro.build.version.sdk");
  const apiText = apiResult.ok ? apiResult.stdout.trim() : "";
  const androidApi = /^\d+$/.test(apiText) ? Number(apiText) : null;
  target.androidApi = androidApi;
  checks.push(
    check(
      "device.android_api",
      androidApi !== null && androidApi >= MIN_ANDROID_API ? "PASS" : "FAIL",
      androidApi === null
        ? "API unavailable"
        : `API ${androidApi}; minimum ${MIN_ANDROID_API}`
    )
  );

  const userResult = adb.shell("am", "get-current-user");
  const userText = userResult.ok ? userResult.stdout.trim() : "";
  const currentUser = /^\d+$/.test(userText) ? Number(userText) : null;
  target.currentUser = currentUser;
  checks.push(
    check(
      "device.current_user",
      currentUser !== null ? "PASS" : "FAIL",
      currentUser === null ? "Current user unavailable" : `User ${currentUser}`
    )
  );

  const featuresResult = adb.shell("pm", "list", "features");
  const bluetoothLeFeature =
    featuresResult.ok &&
    featuresResult.stdout
      .split(/\r?\n/)
      .some((line) => line.trim() === "feature:android.hardware.bluetooth_le");
  target.bluetoothLeFeature = bluetoothLeFeature;
  checks.push(
    check(
      "device.bluetooth_le_feature",
      bluetoothLeFeature ? "PASS" : "FAIL",
      bluetoothLeFeature ? "BLE feature declared" : "BLE feature unavailable"
    )
  );

  const bluetoothResult = adb.shell(
    "settings",
    "get",
    "global",
    "bluetooth_on"
  );
  const bluetoothEnabled =
    bluetoothResult.ok && bluetoothResult.stdout.trim() === "1";
  target.bluetoothEnabled = bluetoothEnabled;
  checks.push(
    check(
      "device.bluetooth_enabled",
      bluetoothEnabled ? "PASS" : "FAIL",
      bluetoothEnabled ? "Adapter setting enabled" : "Adapter setting disabled"
    )
  );

  const packageResult = currentUser === null
    ? { ok: false, stdout: "", code: "ANDROID_USER_UNAVAILABLE" }
    : adb.shell(
        "pm",
        "path",
        "--user",
        String(currentUser),
        options.packageName
      );
  const installedApkPath = packageResult.ok
    ? parseSingleInstalledApkPath(packageResult.stdout)
    : null;
  const packageInstalled = installedApkPath !== null;
  target.packageInstalled = packageInstalled;
  target.singleApkLayout = packageInstalled;
  checks.push(
    check(
      "app.package_installed",
      packageInstalled ? "PASS" : "FAIL",
      packageInstalled ? "Package path resolved" : "Package not installed"
    )
  );
  checks.push(
    check(
      "app.single_apk_layout",
      installedApkPath !== null ? "PASS" : "FAIL",
      installedApkPath !== null
        ? "Exactly one private APK path resolved"
        : "Package path is missing, split, or malformed"
    )
  );

  const runAsResult = currentUser === null
    ? { ok: false, stdout: "", code: "ANDROID_USER_UNAVAILABLE" }
    : adb.execOutRunAsForUser(
        options.packageName,
        currentUser,
        "id",
        "-u"
      );
  const runAsAvailable =
    runAsResult.ok && /^\d+\s*$/.test(runAsResult.stdout);
  target.runAsAvailable = runAsAvailable;
  checks.push(
    check(
      "app.private_run_as",
      runAsAvailable ? "PASS" : "FAIL",
      runAsAvailable
        ? "Private app UID available"
        : "run-as unavailable; install a debuggable Lab APK"
    )
  );

  const launcherResult = adb.shell(
    "cmd",
    "package",
    "resolve-activity",
    "--user",
    currentUser === null ? "-1" : String(currentUser),
    "--brief",
    "--components",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER",
    "-p",
    options.packageName
  );
  const launcherComponent = launcherResult.ok
    ? lastComponentLine(launcherResult.stdout, options.packageName)
    : null;
  target.launcherComponent = launcherComponent;
  checks.push(
    check(
      "app.launcher_resolved",
      launcherComponent !== null ? "PASS" : "FAIL",
      launcherComponent ?? "Launcher activity unavailable"
    )
  );

  const packageDumpResult = adb.run(
    adb.serialArgs("shell", "dumpsys", "package", options.packageName),
    { maxBuffer: 4 * 1024 * 1024, timeoutMs: 30_000 }
  );
  checks.push(
    check(
      "app.package_state_readable",
      packageDumpResult.ok ? "PASS" : "FAIL",
      packageDumpResult.ok
        ? "Package state read"
        : "Package state unavailable"
    )
  );
  const installedVersion = packageDumpResult.ok
    ? parseCertifiedInstalledVersion(packageDumpResult.stdout)
    : null;
  target.versionName = installedVersion?.versionName ?? null;
  target.versionCode = installedVersion?.versionCode ?? null;
  const versionNameCertified =
    installedVersion?.versionName === certifiedTarget.versionName;
  const versionCodeCertified =
    installedVersion?.versionCode === certifiedTarget.versionCode;
  target.certifiedVersion = versionNameCertified && versionCodeCertified;
  checks.push(
    check(
      "app.version_name_certified",
      versionNameCertified ? "PASS" : "FAIL",
      versionNameCertified
        ? "Installed versionName matches the certification matrix"
        : "Installed versionName is missing or uncertified"
    )
  );
  checks.push(
    check(
      "app.version_code_certified",
      versionCodeCertified ? "PASS" : "FAIL",
      versionCodeCertified
        ? "Installed versionCode matches the certification matrix"
        : "Installed versionCode is missing or uncertified"
    )
  );
  const apkShaResult = installedApkPath === null
    ? { ok: false, stdout: "", code: "APK_PATH_INVALID" }
    : adb.shell("sha256sum", installedApkPath);
  const installedApkSha256 = apkShaResult.ok
    ? parseBoundInstalledApkSha256(apkShaResult.stdout, installedApkPath)
    : null;
  const apkSha256Certified = installedApkSha256 === certifiedTarget.sha256;
  target.certifiedApkSha256 = apkSha256Certified;
  checks.push(
    check(
      "app.apk_sha256_certified",
      apkSha256Certified ? "PASS" : "FAIL",
      apkSha256Certified
        ? "Installed APK matches the certified SHA-256"
        : "Installed APK SHA-256 is missing, unbound, or uncertified"
    )
  );
  const packageRecheckResult = currentUser === null
    ? { ok: false, stdout: "", code: "ANDROID_USER_UNAVAILABLE" }
    : adb.shell(
        "pm",
        "path",
        "--user",
        String(currentUser),
        options.packageName
      );
  const installedApkPathAfter = packageRecheckResult.ok
    ? parseSingleInstalledApkPath(packageRecheckResult.stdout)
    : null;
  const packagePathStable =
    installedApkPath !== null && installedApkPathAfter === installedApkPath;
  checks.push(
    check(
      "app.package_path_stable",
      packagePathStable ? "PASS" : "FAIL",
      packagePathStable
        ? "Certified APK path remained stable during preflight"
        : "Installed APK changed while certification was being checked"
    )
  );
  for (const permission of BLUETOOTH_RUNTIME_PERMISSIONS) {
    const granted =
      packageDumpResult.ok &&
      currentUser !== null &&
      packagePermissionGrantedForUser(
        packageDumpResult.stdout,
        currentUser,
        permission
      );
    target.runtimePermissions[permission] = granted;
    checks.push(
      check(
        `app.permission.${permission.slice(permission.lastIndexOf(".") + 1)}`,
        granted ? "PASS" : "FAIL",
        granted ? "Granted" : "Not granted"
      )
    );
  }

  const finalUserResult = adb.shell("am", "get-current-user");
  const finalUserText = finalUserResult.ok
    ? finalUserResult.stdout.trim()
    : "";
  const finalUser = /^\d+$/u.test(finalUserText)
    ? Number(finalUserText)
    : null;
  const currentUserStable =
    currentUser !== null &&
    Number.isSafeInteger(finalUser) &&
    finalUser === currentUser;
  checks.push(
    check(
      "device.current_user_stable",
      currentUserStable ? "PASS" : "FAIL",
      currentUserStable
        ? "Current Android user remained stable during preflight"
        : "Current Android user changed or became unavailable"
    )
  );

  return {
    passed: !checks.some((entry) => entry.status === "FAIL"),
    target,
    checks
  };
}

export function readSecureQrBytes(qrFile) {
  if (qrFile === "-") {
    return fs.readFileSync(0);
  }
  const source = path.resolve(qrFile);
  let descriptor = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    const status = fs.fstatSync(descriptor);
    if (!status.isFile()) {
      fail("QR_FILE_INSECURE", "Enrollment QR source is not a regular file");
    }
    if (
      typeof process.getuid !== "function" ||
      status.uid !== process.getuid()
    ) {
      fail(
        "QR_FILE_INSECURE",
        "Enrollment QR source must be owned by the harness user"
      );
    }
    const mode = status.mode & 0o777;
    if (mode !== 0o400 && mode !== 0o600) {
      fail(
        "QR_FILE_INSECURE",
        "Enrollment QR source mode must be 0400 or 0600"
      );
    }
    if (status.size < 1 || status.size > MAX_QR_BYTES) {
      fail(
        "QR_SIZE_INVALID",
        `Enrollment QR must contain 1 to ${MAX_QR_BYTES} bytes`
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const afterRead = fs.fstatSync(descriptor);
    if (
      afterRead.dev !== status.dev ||
      afterRead.ino !== status.ino ||
      afterRead.size !== status.size ||
      bytes.byteLength !== status.size
    ) {
      bytes.fill(0);
      fail("QR_FILE_CHANGED", "Enrollment QR source changed while reading");
    }
    return bytes;
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
  }
}

function stageEnrollmentInput(adb, options, qrBytes, currentUser) {
  const stopResult = adb.shell("am", "force-stop", options.packageName);
  if (!stopResult.ok) {
    fail("APP_FORCE_STOP_FAILED", "Unable to stop the selected Lab app");
  }
  const cleanupResult = adb.run(
    buildPrivateCleanupArgs(
      options.serial,
      options.packageName,
      options.skipEnrollment,
      currentUser
    )
  );
  if (!cleanupResult.ok) {
    fail("PRIVATE_CLEANUP_FAILED", "Unable to reset private Lab status files");
  }
  if (options.skipEnrollment) {
    return {
      performed: false,
      privateCleanup: true,
      reason: "EXISTING_IDENTITY_MODE",
      secretTransport: null
    };
  }
  const stageResult = adb.run(
    buildPrivateStageArgs(options.serial, options.packageName, currentUser),
    {
      input: qrBytes,
      maxBuffer: 16 * 1024
    }
  );
  if (!stageResult.ok) {
    fail("PRIVATE_STAGE_FAILED", "Unable to stage private enrollment input");
  }
  return {
    performed: true,
    privateCleanup: true,
    secretTransport: "ADB_SHELL_T_RUN_AS_STDIN",
    privateMode: "0600",
    tokenInCommandArguments: false,
    tokenInHarnessOutput: false,
    stagedBytes: qrBytes.byteLength
  };
}

function launchLabApp(adb, target) {
  const result = adb.shell(
    "am",
    "start",
    "-W",
    "-n",
    target.launcherComponent
  );
  if (!result.ok) {
    fail("APP_LAUNCH_FAILED", "Unable to launch the selected Lab app");
  }
  return {
    launched: true,
    component: target.launcherComponent,
    foregroundServiceTrigger:
      "Launcher activity initializes the app-owned non-exported service"
  };
}

function readPrivateStatus(adb, packageName, currentUser, fileName) {
  const result = adb.execOutRunAsForUser(
    packageName,
    currentUser,
    "cat",
    fileName
  );
  if (!result.ok || !result.stdout.trimStart().startsWith("{")) return null;
  return result.stdout;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pollEnrollment(adb, options, currentUser) {
  const deadline = Date.now() + options.enrollmentTimeoutMs;
  const transitions = [];
  let latest = null;
  while (Date.now() <= deadline) {
    const raw = readPrivateStatus(
      adb,
      options.packageName,
      currentUser,
      ENROLLMENT_STATUS_FILE
    );
    if (raw !== null) {
      latest = parseEnrollmentStatus(raw);
      if (transitions.at(-1) !== latest.status) {
        transitions.push(latest.status);
      }
      if (!ENROLLMENT_NON_TERMINAL_STATUSES.has(latest.status)) break;
    }
    await delay(options.pollMs);
  }
  if (latest === null) {
    return {
      status: "FAIL",
      code: "ENROLLMENT_STATUS_MISSING",
      transitions
    };
  }
  if (latest.status !== "READY") {
    return {
      status: "FAIL",
      code:
        latest.status === "ALREADY_PROVISIONED"
          ? "ENROLLMENT_NOT_FRESH"
          : ENROLLMENT_NON_TERMINAL_STATUSES.has(latest.status)
            ? "ENROLLMENT_TIMEOUT"
            : "ENROLLMENT_TERMINAL_FAILURE",
      latest,
      transitions
    };
  }
  return {
    status: "PASS",
    code: "ENROLLMENT_READY",
    latest,
    transitions
  };
}

async function collectDiscovery(adb, options, currentUser) {
  const startedAt = Date.now();
  const deadline = startedAt + options.discoverySeconds * 1_000;
  let latest = null;
  let first = null;
  let firstReadyAtEpochMs = null;
  let sampleCount = 0;
  let lastSequence = null;
  const readinessTransitions = [];
  while (Date.now() <= deadline) {
    const raw = readPrivateStatus(
      adb,
      options.packageName,
      currentUser,
      DISCOVERY_STATUS_FILE
    );
    if (raw !== null) {
      const sample = parseDiscoveryStatus(raw);
      latest = sample;
      if (first === null) first = sample;
      if (sample.sampleSequence !== lastSequence) {
        sampleCount += 1;
        lastSequence = sample.sampleSequence;
      }
      if (readinessTransitions.at(-1) !== sample.readiness) {
        readinessTransitions.push(sample.readiness);
      }
      if (sample.ready && firstReadyAtEpochMs === null) {
        firstReadyAtEpochMs = sample.sampledAtEpochMs;
      }
    }
    await delay(options.pollMs);
  }
  const evidence = evaluateDiscoveryEvidence(
    latest,
    firstReadyAtEpochMs !== null
  );
  return {
    status: evidence.status,
    code: evidence.code,
    durationMs: Date.now() - startedAt,
    sampleCount,
    firstSampleSequence: first?.sampleSequence ?? null,
    lastSampleSequence: latest?.sampleSequence ?? null,
    firstReadyAtEpochMs,
    readinessTransitions,
    latest,
    evidence,
    reciprocalGate:
      "PENDING_UNTIL_TWO_DEVICE_REPORTS_AND_CONTROLLER_CAPTURE_ARE_CORRELATED"
  };
}

function buildDryRunReport(options, qr) {
  const cleanupArgs = buildPrivateCleanupArgs(
    options.serial,
    options.packageName,
    options.skipEnrollment
  );
  const stageArgs = options.skipEnrollment
    ? null
    : buildPrivateStageArgs(options.serial, options.packageName);
  return {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    product: "V5BT",
    generatedAt: new Date().toISOString(),
    mode: "DRY_RUN",
    verdict: "DRY_RUN_PASS",
    target: {
      serial: options.serial,
      expectedModel: options.expectedModel ?? null,
      packageName: options.packageName
    },
    qr: options.skipEnrollment
      ? { required: false }
      : {
          required: true,
          validated: true,
          version: qr.version,
          enrollmentEndpointId: qr.enrollmentEndpointId,
          byteLength: qr.byteLength,
          tokenIncluded: false
        },
    commandPlan: {
      executable: options.adb,
      cleanupArgs,
      stageArgs,
      enrollmentBytesSentOnlyOnStdin: !options.skipEnrollment,
      tokenInArguments: false,
      commandsExecuted: false
    },
    raspberryBtmon: buildBtmonPlan(
      options.btmonSshTarget,
      options.btmonSeconds
    ),
    activeV4Changes: false
  };
}

function writeReport(report, outputPath, forbiddenToken = null) {
  const compact = assertReportContainsNoEnrollmentToken(report, forbiddenToken);
  const formatted = `${JSON.stringify(JSON.parse(compact), null, 2)}\n`;
  if (outputPath !== undefined) {
    const destination = path.resolve(outputPath);
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temporary, formatted, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      fs.renameSync(temporary, destination);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  process.stdout.write(formatted);
}

export function runSelfTest() {
  const token = `c5e1_${Buffer.alloc(32, 0x4a).toString("base64url")}`;
  const qrBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      enrollmentEndpointId: "v5bt-lab",
      token
    }),
    "utf8"
  );
  const qr = validateEnrollmentQr(qrBytes);
  assert.equal(qr.version, 1);
  assert.equal(qr.enrollmentEndpointId, "v5bt-lab");
  const stageArgs = buildPrivateStageArgs(
    "SERIAL123",
    ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId
  );
  assert.deepEqual(stageArgs.slice(2, 6), [
    "shell",
    "-T",
    "run-as",
    ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId
  ]);
  assert.equal(JSON.stringify(stageArgs).includes(token), false);
  assert.deepEqual(
    parseAdbDevices(
      "List of devices attached\nSERIAL123 device product:x model:SM_A165F device:a16\n"
    )[0],
    {
      serial: "SERIAL123",
      state: "device",
      transportModel: "SM_A165F",
      transportProduct: "x",
      transportDevice: "a16"
    }
  );
  assert.equal(
    parseEnrollmentStatus(
      "{\"version\":1,\"status\":\"READY\",\"identityStatus\":\"READY\"," +
        "\"clientStatus\":null,\"parseCode\":null,\"httpStatus\":null}"
    ).status,
    "READY"
  );
  assert.equal(
    parseEnrollmentStatus(
      "{\"version\":1,\"status\":\"ALREADY_PROVISIONED\"," +
        "\"identityStatus\":\"READY\",\"clientStatus\":null," +
        "\"parseCode\":null,\"httpStatus\":null}"
    ).status,
    "ALREADY_PROVISIONED"
  );
  const report = {
    schemaVersion: 1,
    product: "V5BT",
    tokenIncluded: false
  };
  assert.doesNotThrow(() =>
    assertReportContainsNoEnrollmentToken(report, token)
  );
  assert.throws(
    () =>
      assertReportContainsNoEnrollmentToken(
        { schemaVersion: 1, unsafe: token },
        token
      ),
    (error) => error instanceof HarnessError &&
      error.code === "REPORT_SECRET_DETECTED"
  );
  qrBytes.fill(0);
  return {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    product: "V5BT",
    generatedAt: new Date().toISOString(),
    mode: "SELF_TEST",
    verdict: "SELF_TEST_PASS",
    checks: 7,
    physicalDeviceAccessed: false,
    activeV4Changes: false
  };
}

function usage() {
  return `V5BT B2 Android ADB harness

Usage:
  node scripts/run-b2-android-adb-harness.mjs \\
    --serial SERIAL --package APPLICATION_ID --qr-file FILE_OR_DASH [options]

Modes:
  --skip-enrollment       Reuse an enrolled identity; no QR is read or staged
  --dry-run               Validate inputs and print a secret-free command plan
  --self-test             Run local checks without ADB or a physical device

Options:
  --expected-model MODEL
  --adb PATH
  --output REPORT.json
  --enrollment-timeout-ms 30000
  --discovery-seconds 20
  --poll-ms 500
  --btmon-ssh-target user@host
  --btmon-seconds 30
  --help

The optional btmon entry is a command plan only. This harness never opens an
SSH connection and never changes or restarts V4.
`;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  let forbiddenToken = null;
  let qrBytes = null;
  try {
    options = validateOptions(parseArguments(argv));
    if (options.help) {
      process.stdout.write(usage());
      return 0;
    }
    if (options.selfTest) {
      writeReport(runSelfTest());
      return 0;
    }

    let qr = null;
    if (!options.skipEnrollment) {
      try {
        qrBytes = readSecureQrBytes(options.qrFile);
      } catch (error) {
        if (error instanceof HarnessError) throw error;
        fail("QR_READ_FAILED", "Unable to read the enrollment QR source");
      }
      qr = validateEnrollmentQr(qrBytes);
      forbiddenToken = qr.token;
    }
    if (options.dryRun) {
      const report = buildDryRunReport(options, qr);
      writeReport(report, options.output, forbiddenToken);
      return 0;
    }

    const report = {
      schemaVersion: 1,
      harnessVersion: HARNESS_VERSION,
      product: "V5BT",
      generatedAt: new Date().toISOString(),
      mode: "PHYSICAL_SINGLE_NODE",
      verdict: "FAIL",
      scope:
        "Single Android node evidence; reciprocal B2 closure requires two correlated reports",
      preflight: null,
      staging: null,
      launch: null,
      enrollment: null,
      discovery: null,
      raspberryBtmon: buildBtmonPlan(
        options.btmonSshTarget,
        options.btmonSeconds
      ),
      activeV4Changes: false
    };
    const adb = new AdbClient(options.adb, options.serial);
    const preflight = await runPreflight(adb, options);
    report.preflight = preflight;
    if (!preflight.passed) {
      report.verdict = "FAIL";
      report.failure = {
        code: "PREFLIGHT_FAILED",
        message: "One or more physical-device prerequisites failed"
      };
      writeReport(report, options.output, forbiddenToken);
      qrBytes?.fill(0);
      return 1;
    }

    try {
      report.staging = stageEnrollmentInput(
        adb,
        options,
        qrBytes,
        preflight.target.currentUser
      );
    } finally {
      qrBytes?.fill(0);
      qrBytes = null;
    }
    report.launch = launchLabApp(adb, preflight.target);
    report.enrollment = options.skipEnrollment
      ? {
          status: "SKIPPED",
          code: "EXISTING_IDENTITY_MODE",
          qrConsumed: false
        }
      : await pollEnrollment(adb, options, preflight.target.currentUser);
    if (
      !options.skipEnrollment &&
      report.enrollment.status !== "PASS"
    ) {
      report.verdict = "FAIL";
      writeReport(report, options.output, forbiddenToken);
      return 1;
    }

    report.discovery = await collectDiscovery(
      adb,
      options,
      preflight.target.currentUser
    );
    report.verdict = report.discovery.status;
    writeReport(report, options.output, forbiddenToken);
    if (report.verdict === "PASS") return 0;
    if (report.verdict === "PENDING") return 2;
    return 1;
  } catch (error) {
    const safeError =
      error instanceof HarnessError
        ? error
        : new HarnessError("HARNESS_INTERNAL_ERROR", "Harness execution failed");
    const failureReport = {
      schemaVersion: 1,
      harnessVersion: HARNESS_VERSION,
      product: "V5BT",
      generatedAt: new Date().toISOString(),
      mode: options?.dryRun ? "DRY_RUN" : "PHYSICAL_SINGLE_NODE",
      verdict: "FAIL",
      failure: {
        code: safeError.code,
        message: safeError.message
      },
      activeV4Changes: false
    };
    try {
      writeReport(failureReport, options?.output, forbiddenToken);
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          product: "V5BT",
          verdict: "FAIL",
          failure: { code: "REPORT_WRITE_FAILED" },
          activeV4Changes: false
        }, null, 2)}\n`
      );
    }
    return safeError.exitCode;
  } finally {
    qrBytes?.fill(0);
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
