#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { ADVANCED_CERTIFICATION_TARGETS } from "./advanced-certification-targets.mjs";

const execFileAsync = promisify(execFile);

export const B3_STATUS_PATH =
  "no_backup/bluetooth-connectivity-agent-status-v1.json";
export const B3_REQUIRED_DURATION_SECONDS = 3_600;
export const B3_REQUIRED_DURATION_MS =
  B3_REQUIRED_DURATION_SECONDS * 1_000;
export const B3_MIN_ANDROID_API = 33;
export const B3_FAILOVER_SERVICE_NAME = "BluetoothFailoverService";
export const B3_FGS_TYPE_DATA_SYNC = 0x00000001;
export const B3_FGS_TYPE_CONNECTED_DEVICE = 0x00000010;
export const B3_RUNTIME_AUDIT_INTERVAL_SECONDS = 60;
export const B3_REQUIRED_FOREGROUND_SERVICE_CHECKS =
  B3_REQUIRED_DURATION_SECONDS / B3_RUNTIME_AUDIT_INTERVAL_SECONDS + 1;
export const B3_STATES = Object.freeze([
  "DISABLED",
  "PERMISSION_REQUIRED",
  "STARTING",
  "DISCOVERING",
  "DIRECT_SERVER",
  "PEER_CONNECTED",
  "DEGRADED",
  "BACKOFF",
  "STOPPED"
]);
export const B3_EXPECTED_TARGETS = Object.freeze({
  handheld: Object.freeze({
    serial: "RFGYA0ZAGFW",
    model: "SM-A165F",
    ...ADVANCED_CERTIFICATION_TARGETS.roles.handheld
  }),
  station: Object.freeze({
    serial: "R9WT50ZN5VZ",
    model: "SM-T503",
    ...ADVANCED_CERTIFICATION_TARGETS.roles.station
  })
});

const DEFAULT_POLL_MS = 5_000;
const STARTUP_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const RUNTIME_AUDIT_INTERVAL_MS =
  B3_RUNTIME_AUDIT_INTERVAL_SECONDS * 1_000;
const STATUS_LIMIT_BYTES = 16_384;
const DEVICE_CLOCK_TOLERANCE_MS = 5_000;
const STATUS_MAX_AGE_MS = 30_000;
const MIN_DISTINCT_SAMPLES = 2;
const BLUETOOTH_PERMISSIONS = Object.freeze([
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.BLUETOOTH_CONNECT"
]);
const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "source",
  "labBuild",
  "diagnosticsEnabled",
  "agentEnabled",
  "sampleSequence",
  "sampledAtEpochMs",
  "reporterStartedAtEpochMs",
  "state",
  "metrics",
  "resources"
]);
const METRIC_KEYS = Object.freeze([
  "startCount",
  "stopCount",
  "backoffCount",
  "transitionCount",
  "duplicateEventCount",
  "invalidTransitionCount"
]);
const RESOURCE_KEYS = Object.freeze([
  "scannerActive",
  "advertiserActive",
  "gattServerActive",
  "gattClientActive",
  "sessionCount"
]);
const FORBIDDEN_KEY_PARTS = Object.freeze([
  "serial",
  "identifier",
  "nodeid",
  "alias",
  "token",
  "secret",
  "privatekey",
  "publickey",
  "certificate",
  "macaddress",
  "bluetoothaddress",
  "enrollment"
]);
const RUNTIME_REDACTION_SECRETS = new Set(
  Object.values(B3_EXPECTED_TARGETS).map((target) => target.serial)
);
const FATAL_APPLICATION_EXIT_REASONS = new Set([4, 5, 6]);

export class B3GateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "B3GateError";
    this.code = code;
  }
}

function usage() {
  return [
    "Usage:",
    "  node scripts/run-b3-android-service-gate.mjs --self-test",
    "  node scripts/run-b3-android-service-gate.mjs --dry-run [options]",
    "  node scripts/run-b3-android-service-gate.mjs \\",
    "    --handheld-serial SERIAL --station-serial SERIAL [options]",
    "",
    "Scope: B3 native Android connectivity-agent foreground-service gate.",
    `The physical measurement duration is fixed at ${B3_REQUIRED_DURATION_SECONDS} seconds.`,
    "",
    "Options:",
    `  --poll-ms N             1000..30000, default ${DEFAULT_POLL_MS}`,
    "  --handheld-serial ID    fixed Palmare Advanced target",
    "  --station-serial ID     fixed Postazione Advanced target",
    "  --adb PATH              default $ADB or adb",
    "  --output FILE           optional redacted JSON report",
    "  --help"
  ].join("\n");
}

function parseInteger(value, name, minimum, maximum) {
  if (!/^(0|[1-9]\d*)$/.test(value ?? "")) {
    throw new B3GateError("INVALID_ARGUMENT", `${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new B3GateError(
      "INVALID_ARGUMENT",
      `${name} must be between ${minimum} and ${maximum}`
    );
  }
  return parsed;
}

function validateSerial(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    /[\s\x00-\x1f\x7f]/.test(value)
  ) {
    throw new B3GateError("INVALID_ARGUMENT", `${name} is invalid`);
  }
  RUNTIME_REDACTION_SECRETS.add(value);
  return value;
}

export function parseArguments(argv) {
  const options = {
    selfTest: false,
    dryRun: false,
    help: false,
    adb: process.env.ADB || "adb",
    pollMs: DEFAULT_POLL_MS,
    handheldSerial: null,
    stationSerial: null,
    output: null
  };
  const flagOptions = new Set(["--self-test", "--dry-run", "--help"]);
  const valueOptions = new Set([
    "--adb",
    "--poll-ms",
    "--handheld-serial",
    "--station-serial",
    "--output"
  ]);
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) {
      throw new B3GateError(
        "INVALID_ARGUMENT",
        `duplicate option: ${argument}`
      );
    }
    if (flagOptions.has(argument)) {
      seen.add(argument);
      if (argument === "--self-test") options.selfTest = true;
      if (argument === "--dry-run") options.dryRun = true;
      if (argument === "--help") options.help = true;
      continue;
    }
    if (!valueOptions.has(argument)) {
      throw new B3GateError(
        "INVALID_ARGUMENT",
        `unknown option: ${argument}`
      );
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new B3GateError(
        "INVALID_ARGUMENT",
        `missing value for ${argument}`
      );
    }
    seen.add(argument);
    index += 1;
    switch (argument) {
      case "--adb":
        if (value.length > 4_096 || /[\x00-\x1f\x7f]/.test(value)) {
          throw new B3GateError("INVALID_ARGUMENT", "--adb is invalid");
        }
        options.adb = value;
        break;
      case "--poll-ms":
        options.pollMs = parseInteger(value, argument, 1_000, 30_000);
        break;
      case "--handheld-serial":
        options.handheldSerial = validateSerial(value, argument);
        break;
      case "--station-serial":
        options.stationSerial = validateSerial(value, argument);
        break;
      case "--output":
        options.output = path.resolve(value);
        break;
      default:
        throw new B3GateError(
          "INVALID_ARGUMENT",
          `unsupported option: ${argument}`
        );
    }
  }

  const selectedModes = [options.selfTest, options.dryRun, options.help].filter(
    Boolean
  ).length;
  if (selectedModes > 1) {
    throw new B3GateError(
      "INVALID_ARGUMENT",
      "--self-test, --dry-run and --help cannot be combined"
    );
  }
  if (options.selfTest && argv.length !== 1) {
    throw new B3GateError(
      "INVALID_ARGUMENT",
      "--self-test cannot be combined with options"
    );
  }
  if (options.help && argv.length !== 1) {
    throw new B3GateError(
      "INVALID_ARGUMENT",
      "--help cannot be combined with options"
    );
  }

  const oneTargetOnly =
    Boolean(options.handheldSerial) !== Boolean(options.stationSerial);
  if (oneTargetOnly) {
    throw new B3GateError(
      "INVALID_ARGUMENT",
      "both fixed target serials must be supplied together"
    );
  }
  if (options.handheldSerial || options.stationSerial) {
    if (
      options.handheldSerial !== B3_EXPECTED_TARGETS.handheld.serial ||
      options.stationSerial !== B3_EXPECTED_TARGETS.station.serial ||
      options.handheldSerial === options.stationSerial
    ) {
      throw new B3GateError(
        "TARGET_ROLE_MISMATCH",
        "ADB targets do not match the fixed Palmare and Postazione roles"
      );
    }
  }
  if (!options.selfTest && !options.dryRun && !options.help) {
    if (!options.handheldSerial || !options.stationSerial) {
      throw new B3GateError(
        "INVALID_ARGUMENT",
        "--handheld-serial and --station-serial are required"
      );
    }
  }
  return options;
}

function exactKeys(value, expected, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new B3GateError("STATUS_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new B3GateError(
      "STATUS_INVALID",
      `${label} contains unexpected fields`
    );
  }
}

function assertNoForbiddenKeys(value, label = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenKeys(entry, `${label}[${index}]`)
    );
    return;
  }
  if (value == null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("_", "");
    if (FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part))) {
      throw new B3GateError(
        "STATUS_NOT_REDACTED",
        `diagnostic status contains a forbidden field at ${label}`
      );
    }
    assertNoForbiddenKeys(entry, `${label}.${key}`);
  }
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new B3GateError(
      "STATUS_INVALID",
      `${label} must be a non-negative integer`
    );
  }
}

export function parseStatus(raw) {
  if (typeof raw !== "string") {
    throw new B3GateError("STATUS_INVALID", "diagnostic status must be text");
  }
  if (Buffer.byteLength(raw, "utf8") > STATUS_LIMIT_BYTES) {
    throw new B3GateError(
      "STATUS_INVALID",
      "diagnostic status exceeds the size limit"
    );
  }
  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    throw new B3GateError(
      "STATUS_INVALID",
      "diagnostic status is not valid JSON"
    );
  }
  assertNoForbiddenKeys(status);
  exactKeys(status, TOP_LEVEL_KEYS, "status");
  exactKeys(status.metrics, METRIC_KEYS, "status.metrics");
  exactKeys(status.resources, RESOURCE_KEYS, "status.resources");

  if (
    status.schemaVersion !== 1 ||
    status.source !== "V5BT_ANDROID_CONNECTIVITY_AGENT" ||
    status.labBuild !== true ||
    status.diagnosticsEnabled !== true ||
    status.agentEnabled !== true
  ) {
    throw new B3GateError(
      "STATUS_INVALID",
      "diagnostic status is not an enabled V5BT B3 Lab report"
    );
  }
  requireNonNegativeInteger(status.sampleSequence, "sampleSequence");
  if (status.sampleSequence === 0) {
    throw new B3GateError(
      "STATUS_INVALID",
      "sampleSequence must start at one"
    );
  }
  requireNonNegativeInteger(status.sampledAtEpochMs, "sampledAtEpochMs");
  requireNonNegativeInteger(
    status.reporterStartedAtEpochMs,
    "reporterStartedAtEpochMs"
  );
  if (status.reporterStartedAtEpochMs === 0) {
    throw new B3GateError(
      "STATUS_INVALID",
      "reporterStartedAtEpochMs must be positive"
    );
  }
  if (!B3_STATES.includes(status.state)) {
    throw new B3GateError("STATUS_INVALID", "state is not a B3 state");
  }
  for (const key of METRIC_KEYS) {
    requireNonNegativeInteger(status.metrics[key], `metrics.${key}`);
  }
  for (const key of RESOURCE_KEYS) {
    if (key === "sessionCount") {
      requireNonNegativeInteger(
        status.resources[key],
        `resources.${key}`
      );
    } else if (typeof status.resources[key] !== "boolean") {
      throw new B3GateError(
        "STATUS_INVALID",
        `resources.${key} must be boolean`
      );
    }
  }
  return status;
}

export function assertB3Scope(status, role = "target") {
  if (status.state === "STOPPED") {
    throw new B3GateError(
      "SERVICE_STOPPED",
      `${role} connectivity agent entered STOPPED`
    );
  }
  if (
    status.state === "DIRECT_SERVER" ||
    status.state === "PEER_CONNECTED"
  ) {
    throw new B3GateError(
      "B3_SCOPE_VIOLATION",
      `${role} entered a direct-session state during B3`
    );
  }
  if (status.metrics.invalidTransitionCount !== 0) {
    throw new B3GateError(
      "INVALID_TRANSITION_REPORTED",
      `${role} reported an invalid state transition`
    );
  }
  if (status.metrics.startCount !== 1) {
    throw new B3GateError(
      "SERVICE_START_COUNT_INVALID",
      `${role} did not retain exactly one service start`
    );
  }
  if (status.metrics.stopCount !== 0) {
    throw new B3GateError(
      "SERVICE_STOP_REPORTED",
      `${role} reported a service stop`
    );
  }
  if (
    status.metrics.stopCount > status.metrics.startCount ||
    status.metrics.backoffCount > status.metrics.transitionCount ||
    status.metrics.invalidTransitionCount > status.metrics.transitionCount
  ) {
    throw new B3GateError(
      "METRICS_INCONSISTENT",
      `${role} reported inconsistent aggregate metrics`
    );
  }
  if (
    status.resources.gattServerActive ||
    status.resources.gattClientActive ||
    status.resources.sessionCount !== 0
  ) {
    throw new B3GateError(
      "B3_GATT_SESSION_ACTIVITY",
      `${role} reported GATT or session activity during B3`
    );
  }
}

export function createStatusTracker() {
  return {
    reporterStartedAtEpochMs: null,
    firstSequence: null,
    lastSequence: null,
    firstSampledAtEpochMs: null,
    lastSampledAtEpochMs: null,
    lastFingerprint: null,
    lastMetrics: null,
    lastStatus: null,
    lastObservedAtPerformanceMs: null,
    distinctSamples: 0,
    statesObserved: new Set(),
    scannerEverActive: false,
    advertiserEverActive: false,
    gattServerEverActive: false,
    gattClientEverActive: false,
    maximumSessionCount: 0
  };
}

export function createRuntimeEvidence() {
  return {
    homeKeyEventSent: false,
    foregroundServiceChecks: 0,
    radioActiveForegroundChecks: 0,
    applicationExitBaselineCaptured: false,
    applicationExitFinalCaptured: false,
    newAnrOrCrashCount: null
  };
}

export function validateFreshSample(
  status,
  tracker,
  clockAnchor,
  nowPerformanceMs,
  role = "target"
) {
  if (
    !Number.isFinite(nowPerformanceMs) ||
    nowPerformanceMs < clockAnchor.capturedAtPerformanceMs
  ) {
    throw new B3GateError(
      "CLOCK_INVALID",
      `${role} monotonic clock is invalid`
    );
  }
  const elapsedFromAnchorMs =
    nowPerformanceMs - clockAnchor.capturedAtPerformanceMs;
  const estimatedDeviceNowMs =
    clockAnchor.epochFloorMs + elapsedFromAnchorMs;
  if (
    status.reporterStartedAtEpochMs < clockAnchor.epochFloorMs ||
    status.sampledAtEpochMs < status.reporterStartedAtEpochMs ||
    status.sampledAtEpochMs >
      estimatedDeviceNowMs + DEVICE_CLOCK_TOLERANCE_MS ||
    status.sampledAtEpochMs < estimatedDeviceNowMs - STATUS_MAX_AGE_MS
  ) {
    throw new B3GateError(
      "STATUS_NOT_FRESH",
      `${role} diagnostic sample is outside the current launch window`
    );
  }

  const fingerprint = JSON.stringify(status);
  if (tracker.lastSequence === null) {
    tracker.reporterStartedAtEpochMs = status.reporterStartedAtEpochMs;
    tracker.firstSequence = status.sampleSequence;
    tracker.lastSequence = status.sampleSequence;
    tracker.firstSampledAtEpochMs = status.sampledAtEpochMs;
    tracker.lastSampledAtEpochMs = status.sampledAtEpochMs;
    tracker.lastFingerprint = fingerprint;
    tracker.lastMetrics = { ...status.metrics };
    tracker.distinctSamples = 1;
  } else {
    if (
      status.reporterStartedAtEpochMs !==
      tracker.reporterStartedAtEpochMs
    ) {
      throw new B3GateError(
        "STATUS_REPORTER_RESTARTED",
        `${role} diagnostic reporter restarted during the gate`
      );
    }
    if (status.sampleSequence < tracker.lastSequence) {
      throw new B3GateError(
        "STATUS_SEQUENCE_REGRESSED",
        `${role} diagnostic sample sequence regressed`
      );
    }
    if (status.sampleSequence === tracker.lastSequence) {
      if (
        status.sampledAtEpochMs !== tracker.lastSampledAtEpochMs ||
        fingerprint !== tracker.lastFingerprint
      ) {
        throw new B3GateError(
          "STATUS_SEQUENCE_REUSED",
          `${role} diagnostic content changed without a sequence increment`
        );
      }
    } else {
      if (status.sampledAtEpochMs <= tracker.lastSampledAtEpochMs) {
        throw new B3GateError(
          "STATUS_TIMESTAMP_REGRESSED",
          `${role} diagnostic timestamp did not increase`
        );
      }
      for (const key of METRIC_KEYS) {
        if (status.metrics[key] < tracker.lastMetrics[key]) {
          throw new B3GateError(
            "STATUS_METRICS_REGRESSED",
            `${role} aggregate metrics regressed`
          );
        }
      }
      tracker.lastSequence = status.sampleSequence;
      tracker.lastSampledAtEpochMs = status.sampledAtEpochMs;
      tracker.lastFingerprint = fingerprint;
      tracker.lastMetrics = { ...status.metrics };
      tracker.distinctSamples += 1;
    }
  }

  tracker.lastStatus = status;
  tracker.lastObservedAtPerformanceMs = nowPerformanceMs;
  tracker.statesObserved.add(status.state);
  tracker.scannerEverActive ||= status.resources.scannerActive;
  tracker.advertiserEverActive ||= status.resources.advertiserActive;
  tracker.gattServerEverActive ||= status.resources.gattServerActive;
  tracker.gattClientEverActive ||= status.resources.gattClientActive;
  tracker.maximumSessionCount = Math.max(
    tracker.maximumSessionCount,
    status.resources.sessionCount
  );
}

export function parseCurrentUser(raw, role = "target") {
  const value = String(raw ?? "").trim();
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new B3GateError(
      "ANDROID_USER_INVALID",
      `${role} current Android user is invalid`
    );
  }
  const userId = Number(value);
  if (!Number.isSafeInteger(userId)) {
    throw new B3GateError(
      "ANDROID_USER_INVALID",
      `${role} current Android user is invalid`
    );
  }
  return userId;
}

export function buildHomeKeyEventArgs() {
  return ["shell", "input", "keyevent", "KEYCODE_HOME"];
}

export function buildForegroundServiceDumpArgs(packageId) {
  return [
    "shell",
    "dumpsys",
    "activity",
    "-a",
    "services",
    packageId
  ];
}

export function parseForegroundServiceDump(
  raw,
  currentUser,
  role = "target"
) {
  if (
    typeof raw !== "string" ||
    !Number.isSafeInteger(currentUser) ||
    currentUser < 0
  ) {
    throw new B3GateError(
      "FOREGROUND_SERVICE_DUMP_INVALID",
      `${role} foreground-service dump is invalid`
    );
  }
  const lines = raw.split(/\r?\n/);
  const serviceHeaders = [];
  const expectedUser = new RegExp(`\\bu${currentUser}\\b`);
  for (let index = 0; index < lines.length; index += 1) {
    if (
      /^\s*\*\s+ServiceRecord\{/.test(lines[index]) &&
      lines[index].includes(B3_FAILOVER_SERVICE_NAME) &&
      expectedUser.test(lines[index])
    ) {
      serviceHeaders.push(index);
    }
  }
  if (serviceHeaders.length === 0) {
    throw new B3GateError(
      "FOREGROUND_SERVICE_MISSING",
      `${role} Bluetooth failover service is missing for the current user`
    );
  }
  if (serviceHeaders.length !== 1) {
    throw new B3GateError(
      "FOREGROUND_SERVICE_DUMP_INVALID",
      `${role} foreground-service dump is ambiguous`
    );
  }

  const start = serviceHeaders[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\*\s+ServiceRecord\{/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const serviceBlock = lines.slice(start, end).join("\n");
  const foregroundMatch = serviceBlock.match(
    /\bisForeground=(true|false)\b/
  );
  const typeMatch = serviceBlock.match(
    /\btypes=(?:0x)?([0-9a-fA-F]{1,8})\b/
  );
  return {
    foreground: foregroundMatch?.[1] === "true",
    typeMask: typeMatch ? Number.parseInt(typeMatch[1], 16) : null
  };
}

export function assertForegroundServiceForStatus(
  service,
  status,
  role = "target"
) {
  if (service?.foreground !== true) {
    throw new B3GateError(
      "FOREGROUND_SERVICE_NOT_ACTIVE",
      `${role} Bluetooth failover service is not foreground`
    );
  }
  if (
    !Number.isSafeInteger(service.typeMask) ||
    service.typeMask < 0
  ) {
    throw new B3GateError(
      "FOREGROUND_SERVICE_TYPE_UNAVAILABLE",
      `${role} foreground-service type is unavailable`
    );
  }
  const hasDataSync =
    (service.typeMask & B3_FGS_TYPE_DATA_SYNC) !== 0;
  if (!hasDataSync) {
    throw new B3GateError(
      "FOREGROUND_SERVICE_TYPE_INVALID",
      `${role} foreground service is missing dataSync`
    );
  }
  const resources = status?.resources;
  const radioActive =
    resources?.scannerActive === true ||
    resources?.advertiserActive === true ||
    resources?.gattServerActive === true ||
    resources?.gattClientActive === true;
  if (
    radioActive &&
    (service.typeMask & B3_FGS_TYPE_CONNECTED_DEVICE) === 0
  ) {
    throw new B3GateError(
      "FOREGROUND_SERVICE_TYPE_INVALID",
      `${role} foreground service is missing connectedDevice while radio resources are active`
    );
  }
  return { radioActive };
}

export function parseApplicationExitInfo(
  raw,
  currentUser,
  role = "target"
) {
  if (
    typeof raw !== "string" ||
    !Number.isSafeInteger(currentUser) ||
    currentUser < 0 ||
    !raw.includes(
      "ACTIVITY MANAGER PROCESS EXIT INFO (dumpsys activity exit-info)"
    )
  ) {
    throw new B3GateError(
      "APPLICATION_EXIT_INFO_INVALID",
      `${role} ApplicationExitInfo dump is invalid`
    );
  }

  const markers = [
    ...raw.matchAll(/^\s*ApplicationExitInfo\s+#[^:\r\n]+:\s*$/gm)
  ];
  const fatalFingerprints = new Set();
  let currentUserRecordCount = 0;
  let fatalRecordCount = 0;
  for (let index = 0; index < markers.length; index += 1) {
    const start = markers[index].index;
    const end =
      index + 1 < markers.length ? markers[index + 1].index : raw.length;
    const block = raw.slice(start, end);
    const userMatch = block.match(/\buser=(\d+)\b/);
    const reasonMatch = block.match(/\breason=(\d+)\b/);
    if (!userMatch || !reasonMatch) {
      throw new B3GateError(
        "APPLICATION_EXIT_INFO_INVALID",
        `${role} ApplicationExitInfo record is incomplete`
      );
    }
    const recordUser = Number(userMatch[1]);
    const reason = Number(reasonMatch[1]);
    if (
      !Number.isSafeInteger(recordUser) ||
      !Number.isSafeInteger(reason)
    ) {
      throw new B3GateError(
        "APPLICATION_EXIT_INFO_INVALID",
        `${role} ApplicationExitInfo record is invalid`
      );
    }
    if (recordUser !== currentUser) continue;
    currentUserRecordCount += 1;
    if (!FATAL_APPLICATION_EXIT_REASONS.has(reason)) continue;

    const timestampMatch = block.match(
      /\btimestamp=([^\r\n]*?)(?=\s+pid=\d+\b|\s*$)/m
    );
    const pidMatch = block.match(/\bpid=(\d+)\b/);
    const processMatch = block.match(
      /\bprocess=([^\r\n]*?)(?=\s+reason=\d+\b|\s*$)/m
    );
    const timestamp = timestampMatch?.[1].trim();
    const processName = processMatch?.[1].trim();
    if (
      !timestamp ||
      !pidMatch ||
      !processName ||
      !/^(0|[1-9]\d*)$/.test(pidMatch[1])
    ) {
      throw new B3GateError(
        "APPLICATION_EXIT_INFO_INVALID",
        `${role} fatal ApplicationExitInfo record is incomplete`
      );
    }
    fatalRecordCount += 1;
    fatalFingerprints.add(
      [recordUser, timestamp, pidMatch[1], reason, processName].join("\u0000")
    );
  }
  return {
    currentUserRecordCount,
    fatalRecordCount,
    fatalFingerprints
  };
}

export function assertNoNewFatalApplicationExits(
  baseline,
  final,
  role = "target"
) {
  if (
    !(baseline?.fatalFingerprints instanceof Set) ||
    !(final?.fatalFingerprints instanceof Set)
  ) {
    throw new B3GateError(
      "APPLICATION_EXIT_INFO_INVALID",
      `${role} ApplicationExitInfo comparison is invalid`
    );
  }
  const newFatalCount = [...final.fatalFingerprints].filter(
    (fingerprint) => !baseline.fatalFingerprints.has(fingerprint)
  ).length;
  if (newFatalCount > 0) {
    throw new B3GateError(
      "NEW_ANR_OR_CRASH",
      `${role} recorded a new ANR or crash during the gate`
    );
  }
  return 0;
}

export function parseInstalledVersion(packageDump, role = "target") {
  const codeMatch = String(packageDump ?? "").match(
    /^\s*versionCode=(\d+)\b/m
  );
  const nameMatch = String(packageDump ?? "").match(
    /^\s*versionName=([^\r\n]+)$/m
  );
  if (!codeMatch || !nameMatch) {
    throw new B3GateError(
      "APP_VERSION_UNAVAILABLE",
      `${role} installed app version is unavailable`
    );
  }
  const versionCode = Number(codeMatch[1]);
  const versionName = nameMatch[1].trim();
  if (!Number.isSafeInteger(versionCode) || versionName.length === 0) {
    throw new B3GateError(
      "APP_VERSION_UNAVAILABLE",
      `${role} installed app version is invalid`
    );
  }
  return { versionCode, versionName };
}

export function parseInstalledApkPath(raw, role = "target") {
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith("package:")) {
    throw new B3GateError(
      "APK_LAYOUT_INVALID",
      `${role} installed APK layout is not the certified single-APK layout`
    );
  }
  const apkPath = lines[0].slice("package:".length);
  if (
    apkPath.length < 5 ||
    apkPath.length > 4_096 ||
    !apkPath.startsWith("/") ||
    !apkPath.endsWith(".apk") ||
    /[\s\x00-\x1f\x7f]/.test(apkPath)
  ) {
    throw new B3GateError(
      "APK_LAYOUT_INVALID",
      `${role} installed APK path is invalid`
    );
  }
  return apkPath;
}

export function parseInstalledApkSha256(raw, role = "target") {
  const match = String(raw ?? "").match(/^([0-9a-fA-F]{64})\s+\S+\s*$/);
  if (!match) {
    throw new B3GateError(
      "APK_SHA256_UNAVAILABLE",
      `${role} installed APK SHA-256 is unavailable`
    );
  }
  return match[1].toLowerCase();
}

export function permissionGrantedForUser(
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
  const currentUserHeader = new RegExp(`^\\s*User ${currentUser}:`);
  const anyUserHeader = /^\s*User \d+:/;
  let insideCurrentUser = false;
  for (const line of packageDump.split(/\r?\n/)) {
    if (currentUserHeader.test(line)) {
      insideCurrentUser = true;
      continue;
    }
    if (insideCurrentUser && anyUserHeader.test(line)) break;
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

export function buildCurrentUserRunAsArgs(packageId, userId, ...command) {
  return [
    "exec-out",
    "run-as",
    packageId,
    "--user",
    String(userId),
    ...command
  ];
}

export function parseAdbDevices(raw) {
  return new Map(
    String(raw ?? "")
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state] = line.split(/\s+/, 2);
        return [serial, state];
      })
  );
}

export function redactText(value, secrets = []) {
  let redacted = String(value ?? "");
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join("[REDACTED_TARGET]");
    }
  }
  return redacted.trim();
}

async function runCommand(executable, args, secrets, timeoutMs = COMMAND_TIMEOUT_MS) {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  } catch (error) {
    const detail = redactText(
      error.stderr || error.stdout || error.message || "command failed",
      secrets
    );
    throw new B3GateError(
      "COMMAND_FAILED",
      detail || "command failed"
    );
  }
}

async function runAdb(options, serial, args, timeoutMs) {
  const prefix = serial ? ["-s", serial] : [];
  return runCommand(
    options.adb,
    [...prefix, ...args],
    [...RUNTIME_REDACTION_SECRETS],
    timeoutMs
  );
}

async function ensureAttached(options, devices) {
  await runAdb(options, null, ["version"]);
  const result = await runAdb(options, null, ["devices"]);
  const states = parseAdbDevices(result.stdout);
  for (const device of devices) {
    if (states.get(device.serial) !== "device") {
      throw new B3GateError(
        "ADB_DEVICE_UNAVAILABLE",
        `${device.role} target is missing, unauthorized or offline`
      );
    }
  }
}

async function preflightDevice(options, device) {
  const target = B3_EXPECTED_TARGETS[device.role];
  if (
    !target ||
    device.serial !== target.serial ||
    device.packageId !== target.packageId
  ) {
    throw new B3GateError(
      "TARGET_ROLE_MISMATCH",
      `${device.role} does not match the fixed B3 target`
    );
  }

  const currentUserResult = await runAdb(options, device.serial, [
    "shell",
    "am",
    "get-current-user"
  ]);
  device.userId = parseCurrentUser(
    currentUserResult.stdout,
    device.role
  );
  const userArgument = String(device.userId);
  const [
    sdkResult,
    modelResult,
    featuresResult,
    bluetoothResult,
    packagePathResult,
    packageDumpResult,
    runAsResult
  ] = await Promise.all([
    runAdb(options, device.serial, [
      "shell",
      "getprop",
      "ro.build.version.sdk"
    ]),
    runAdb(options, device.serial, [
      "shell",
      "getprop",
      "ro.product.model"
    ]),
    runAdb(options, device.serial, [
      "shell",
      "pm",
      "list",
      "features"
    ]),
    runAdb(options, device.serial, [
      "shell",
      "settings",
      "get",
      "global",
      "bluetooth_on"
    ]),
    runAdb(options, device.serial, [
      "shell",
      "pm",
      "path",
      "--user",
      userArgument,
      device.packageId
    ]),
    runAdb(options, device.serial, [
      "shell",
      "dumpsys",
      "package",
      device.packageId
    ]),
    runAdb(
      options,
      device.serial,
      buildCurrentUserRunAsArgs(
        device.packageId,
        device.userId,
        "pwd"
      )
    )
  ]);

  const androidApi = Number(sdkResult.stdout.trim());
  if (!Number.isSafeInteger(androidApi) || androidApi < B3_MIN_ANDROID_API) {
    throw new B3GateError(
      "ANDROID_API_UNSUPPORTED",
      `${device.role} requires Android API ${B3_MIN_ANDROID_API} or newer`
    );
  }
  const model = modelResult.stdout
    .trim()
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, 80);
  if (model !== target.model) {
    throw new B3GateError(
      "TARGET_MODEL_MISMATCH",
      `${device.role} model does not match the fixed B3 target`
    );
  }
  if (!featuresResult.stdout.includes("feature:android.hardware.bluetooth_le")) {
    throw new B3GateError(
      "BLE_FEATURE_MISSING",
      `${device.role} does not expose the BLE feature`
    );
  }
  if (bluetoothResult.stdout.trim() !== "1") {
    throw new B3GateError(
      "BLUETOOTH_DISABLED",
      `${device.role} Bluetooth is disabled`
    );
  }
  if (!packagePathResult.stdout.trim().startsWith("package:")) {
    throw new B3GateError(
      "PACKAGE_MISSING",
      `${device.role} Advanced Lab app is not installed`
    );
  }
  if (!runAsResult.stdout.trim().includes(device.packageId)) {
    throw new B3GateError(
      "RUN_AS_UNAVAILABLE",
      `${device.role} Lab app is not readable with run-as`
    );
  }
  const installedVersion = parseInstalledVersion(
    packageDumpResult.stdout,
    device.role
  );
  if (
    installedVersion.versionCode !== target.versionCode ||
    installedVersion.versionName !== target.versionName
  ) {
    throw new B3GateError(
      "APP_VERSION_MISMATCH",
      `${device.role} app version does not match the fixed B3 target`
    );
  }
  const installedApkPath = parseInstalledApkPath(
    packagePathResult.stdout,
    device.role
  );
  const installedApkSha256 = parseInstalledApkSha256(
    (
      await runAdb(options, device.serial, [
        "shell",
        "sha256sum",
        installedApkPath
      ])
    ).stdout,
    device.role
  );
  if (installedApkSha256 !== target.sha256) {
    throw new B3GateError(
      "APK_SHA256_MISMATCH",
      `${device.role} installed APK does not match the certified artifact`
    );
  }
  const missingPermissions = BLUETOOTH_PERMISSIONS.filter(
    (permission) =>
      !permissionGrantedForUser(
        packageDumpResult.stdout,
        device.userId,
        permission
      )
  );
  if (missingPermissions.length > 0) {
    throw new B3GateError(
      "BLUETOOTH_PERMISSIONS_MISSING",
      `${device.role} lacks a required Bluetooth permission for the current user`
    );
  }

  return {
    role: device.role,
    androidApi,
    currentAndroidUserVerified: true,
    fixedTargetTransportVerified: true,
    fixedTargetModelVerified: true,
    fixedTargetPackageVerified: true,
    fixedTargetVersionVerified: true,
    fixedTargetApkSha256Verified: true,
    bluetoothLeFeature: true,
    bluetoothEnabled: true,
    currentUserBluetoothPermissionsGranted: true,
    privateStatusReadableWithRunAs: true
  };
}

async function assertCurrentUserUnchanged(options, device) {
  const result = await runAdb(options, device.serial, [
    "shell",
    "am",
    "get-current-user"
  ]);
  if (parseCurrentUser(result.stdout, device.role) !== device.userId) {
    throw new B3GateError(
      "ANDROID_USER_CHANGED",
      `${device.role} current Android user changed during the gate`
    );
  }
}

async function forceStop(options, device) {
  await runAdb(options, device.serial, [
    "shell",
    "am",
    "force-stop",
    "--user",
    String(device.userId),
    device.packageId
  ]);
}

async function resetStatus(options, device) {
  await assertCurrentUserUnchanged(options, device);
  await forceStop(options, device);
  await runAdb(
    options,
    device.serial,
    buildCurrentUserRunAsArgs(
      device.packageId,
      device.userId,
      "rm",
      "-f",
      B3_STATUS_PATH,
      `${B3_STATUS_PATH}.bak`,
      `${B3_STATUS_PATH}.new`
    )
  );
}

async function launchDevice(options, device) {
  const result = await runAdb(options, device.serial, [
    "shell",
    "monkey",
    "--user",
    String(device.userId),
    "-p",
    device.packageId,
    "-c",
    "android.intent.category.LAUNCHER",
    "1"
  ]);
  if (
    !result.stdout.includes("Events injected: 1") &&
    !result.stderr.includes("Events injected: 1")
  ) {
    throw new B3GateError(
      "APP_LAUNCH_FAILED",
      `${device.role} launcher did not start`
    );
  }
}

async function sendHome(options, device, evidence) {
  await assertCurrentUserUnchanged(options, device);
  await runAdb(
    options,
    device.serial,
    buildHomeKeyEventArgs()
  );
  evidence.homeKeyEventSent = true;
}

async function readForegroundService(options, device) {
  const result = await runAdb(
    options,
    device.serial,
    buildForegroundServiceDumpArgs(device.packageId)
  );
  return parseForegroundServiceDump(
    result.stdout,
    device.userId,
    device.role
  );
}

async function readApplicationExitInfo(options, device) {
  await assertCurrentUserUnchanged(options, device);
  const result = await runAdb(options, device.serial, [
    "shell",
    "dumpsys",
    "activity",
    "exit-info",
    device.packageId
  ]);
  return parseApplicationExitInfo(
    result.stdout,
    device.userId,
    device.role
  );
}

async function verifyForegroundRuntime(
  options,
  device,
  tracker,
  evidence
) {
  await assertCurrentUserUnchanged(options, device);
  const service = await readForegroundService(options, device);
  const verification = assertForegroundServiceForStatus(
    service,
    tracker.lastStatus,
    device.role
  );
  evidence.foregroundServiceChecks += 1;
  if (verification.radioActive) {
    evidence.radioActiveForegroundChecks += 1;
  }
}

async function readStatus(options, device) {
  try {
    const result = await runAdb(
      options,
      device.serial,
      buildCurrentUserRunAsArgs(
        device.packageId,
        device.userId,
        "cat",
        B3_STATUS_PATH
      )
    );
    return parseStatus(result.stdout);
  } catch (error) {
    if (
      error instanceof B3GateError &&
      error.code === "COMMAND_FAILED" &&
      /no such file|cannot open/i.test(error.message)
    ) {
      return null;
    }
    throw error;
  }
}

async function readDeviceClockAnchor(options, device) {
  const result = await runAdb(options, device.serial, [
    "shell",
    "date",
    "+%s"
  ]);
  const seconds = result.stdout.trim();
  if (!/^(0|[1-9]\d*)$/.test(seconds)) {
    throw new B3GateError(
      "DEVICE_CLOCK_INVALID",
      `${device.role} device clock is invalid`
    );
  }
  const epochFloorMs = Number(seconds) * 1_000;
  if (!Number.isSafeInteger(epochFloorMs) || epochFloorMs <= 0) {
    throw new B3GateError(
      "DEVICE_CLOCK_INVALID",
      `${device.role} device clock is invalid`
    );
  }
  return {
    epochFloorMs,
    capturedAtPerformanceMs: performance.now()
  };
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function sampleDevices(
  options,
  devices,
  trackers,
  clockAnchors
) {
  const statuses = await Promise.all(
    devices.map((device) => readStatus(options, device))
  );
  const sampledAtPerformanceMs = performance.now();
  statuses.forEach((status, index) => {
    if (status == null) return;
    const device = devices[index];
    assertB3Scope(status, device.role);
    validateFreshSample(
      status,
      trackers[index],
      clockAnchors[index],
      sampledAtPerformanceMs,
      device.role
    );
  });
  return { statuses, sampledAtPerformanceMs };
}

async function waitForInitialStatuses(
  options,
  devices,
  trackers,
  clockAnchors
) {
  const startedAt = performance.now();
  while (performance.now() - startedAt <= STARTUP_TIMEOUT_MS) {
    await sampleDevices(options, devices, trackers, clockAnchors);
    if (trackers.every((tracker) => tracker.distinctSamples >= 1)) {
      return performance.now();
    }
    await sleep(Math.min(options.pollMs, 1_000));
  }
  throw new B3GateError(
    "LAB_STATUS_UNAVAILABLE",
    "both B3 Lab status files were not available within the startup window"
  );
}

function assertStatusAvailability(trackers, sampledAtPerformanceMs, devices) {
  trackers.forEach((tracker, index) => {
    if (
      tracker.lastObservedAtPerformanceMs == null ||
      sampledAtPerformanceMs - tracker.lastObservedAtPerformanceMs >
        STATUS_MAX_AGE_MS
    ) {
      throw new B3GateError(
        "LAB_STATUS_STALE",
        `${devices[index].role} stopped publishing fresh B3 status`
      );
    }
  });
}

async function runPhysicalMeasurement(
  options,
  devices,
  preflight
) {
  await Promise.all(devices.map((device) => resetStatus(options, device)));
  const runtimeEvidence = devices.map(() => createRuntimeEvidence());
  const applicationExitBaselines = await Promise.all(
    devices.map((device) => readApplicationExitInfo(options, device))
  );
  runtimeEvidence.forEach((evidence) => {
    evidence.applicationExitBaselineCaptured = true;
  });
  const clockAnchors = await Promise.all(
    devices.map((device) => readDeviceClockAnchor(options, device))
  );
  await Promise.all(devices.map((device) => launchDevice(options, device)));
  const trackers = devices.map(() => createStatusTracker());
  await waitForInitialStatuses(
    options,
    devices,
    trackers,
    clockAnchors
  );
  await Promise.all(
    devices.map((device, index) =>
      sendHome(options, device, runtimeEvidence[index])
    )
  );
  await Promise.all(
    devices.map((device, index) =>
      verifyForegroundRuntime(
        options,
        device,
        trackers[index],
        runtimeEvidence[index]
      )
    )
  );
  const measurementStartedAtPerformanceMs = performance.now();
  let nextRuntimeAuditMs =
    measurementStartedAtPerformanceMs + RUNTIME_AUDIT_INTERVAL_MS;

  while (
    performance.now() - measurementStartedAtPerformanceMs <
    B3_REQUIRED_DURATION_MS
  ) {
    const { sampledAtPerformanceMs } = await sampleDevices(
      options,
      devices,
      trackers,
      clockAnchors
    );
    assertStatusAvailability(
      trackers,
      sampledAtPerformanceMs,
      devices
    );
    if (sampledAtPerformanceMs >= nextRuntimeAuditMs) {
      await Promise.all(
        devices.map((device, index) =>
          verifyForegroundRuntime(
            options,
            device,
            trackers[index],
            runtimeEvidence[index]
          )
        )
      );
      const elapsedSeconds = Math.min(
        B3_REQUIRED_DURATION_SECONDS,
        Math.floor(
          (sampledAtPerformanceMs -
            measurementStartedAtPerformanceMs) /
            1_000
        )
      );
      process.stderr.write(
        `B3 measurement: ${elapsedSeconds}/${B3_REQUIRED_DURATION_SECONDS} seconds\n`
      );
      do {
        nextRuntimeAuditMs += RUNTIME_AUDIT_INTERVAL_MS;
      } while (nextRuntimeAuditMs <= performance.now());
    }
    const remainingMs =
      B3_REQUIRED_DURATION_MS -
      (performance.now() - measurementStartedAtPerformanceMs);
    if (remainingMs > 0) {
      await sleep(Math.min(options.pollMs, remainingMs));
    }
  }

  const finalSample = await sampleDevices(
    options,
    devices,
    trackers,
    clockAnchors
  );
  assertStatusAvailability(
    trackers,
    finalSample.sampledAtPerformanceMs,
    devices
  );
  await Promise.all(
    devices.map((device, index) =>
      verifyForegroundRuntime(
        options,
        device,
        trackers[index],
        runtimeEvidence[index]
      )
    )
  );
  const applicationExitFinals = await Promise.all(
    devices.map((device) => readApplicationExitInfo(options, device))
  );
  applicationExitFinals.forEach((final, index) => {
    assertNoNewFatalApplicationExits(
      applicationExitBaselines[index],
      final,
      devices[index].role
    );
    runtimeEvidence[index].applicationExitFinalCaptured = true;
    runtimeEvidence[index].newAnrOrCrashCount = 0;
  });
  const measuredDurationMs = Math.floor(
    performance.now() - measurementStartedAtPerformanceMs
  );
  return buildPhysicalSummary(
    preflight,
    trackers,
    measuredDurationMs,
    runtimeEvidence
  );
}

function compactTracker(role, tracker, evidence) {
  const finalStatus = tracker.lastStatus;
  const foregroundChecks = Number.isSafeInteger(
    evidence?.foregroundServiceChecks
  )
    ? evidence.foregroundServiceChecks
    : 0;
  const radioActiveChecks = Number.isSafeInteger(
    evidence?.radioActiveForegroundChecks
  )
    ? evidence.radioActiveForegroundChecks
    : 0;
  return {
    role,
    reporterContinuityVerified: true,
    freshMonotonicSamplesVerified:
      tracker.distinctSamples >= MIN_DISTINCT_SAMPLES,
    distinctSamples: tracker.distinctSamples,
    statesObserved: [...tracker.statesObserved].sort(),
    metrics: { ...finalStatus.metrics },
    resources: {
      scannerObservedActive: tracker.scannerEverActive,
      advertiserObservedActive: tracker.advertiserEverActive,
      gattServerAlwaysInactive: !tracker.gattServerEverActive,
      gattClientAlwaysInactive: !tracker.gattClientEverActive,
      maximumSessionCount: tracker.maximumSessionCount
    },
    backgroundLifecycle: {
      homeKeyEventSent: evidence?.homeKeyEventSent === true,
      foregroundServiceChecks: foregroundChecks,
      radioActiveForegroundChecks: radioActiveChecks,
      foregroundServiceAlwaysActive: foregroundChecks > 0,
      dataSyncTypeAlwaysPresent: foregroundChecks > 0,
      connectedDeviceTypeRequirementEnforced: foregroundChecks > 0
    },
    applicationExitInfo: {
      baselineCaptured:
        evidence?.applicationExitBaselineCaptured === true,
      finalCaptured: evidence?.applicationExitFinalCaptured === true,
      newAnrOrCrashCount: Number.isSafeInteger(
        evidence?.newAnrOrCrashCount
      )
        ? evidence.newAnrOrCrashCount
        : null
    }
  };
}

function completePreflight(preflight) {
  if (!Array.isArray(preflight) || preflight.length !== 2) return false;
  return ["handheld", "station"].every((role) => {
    const matches = preflight.filter((entry) => entry?.role === role);
    if (matches.length !== 1) return false;
    const entry = matches[0];
    return (
      entry.currentAndroidUserVerified === true &&
      entry.fixedTargetTransportVerified === true &&
      entry.fixedTargetModelVerified === true &&
      entry.fixedTargetPackageVerified === true &&
      entry.fixedTargetVersionVerified === true &&
      entry.fixedTargetApkSha256Verified === true &&
      entry.bluetoothLeFeature === true &&
      entry.bluetoothEnabled === true &&
      entry.currentUserBluetoothPermissionsGranted === true &&
      entry.privateStatusReadableWithRunAs === true
    );
  });
}

export function buildPhysicalSummary(
  preflight,
  trackers,
  measuredDurationMs,
  runtimeEvidence
) {
  const roles = ["handheld", "station"];
  const trackerSummaries =
    Array.isArray(trackers) && trackers.length === 2
      ? trackers.map((tracker, index) =>
          compactTracker(
            roles[index],
            tracker,
            Array.isArray(runtimeEvidence)
              ? runtimeEvidence[index]
              : undefined
          )
        )
      : [];
  const measurementPass =
    completePreflight(preflight) &&
    Number.isSafeInteger(measuredDurationMs) &&
    measuredDurationMs >= B3_REQUIRED_DURATION_MS &&
    trackerSummaries.length === 2 &&
    trackerSummaries.every(
      (entry) =>
        entry.freshMonotonicSamplesVerified &&
        !entry.statesObserved.includes("STOPPED") &&
        !entry.statesObserved.includes("DIRECT_SERVER") &&
        !entry.statesObserved.includes("PEER_CONNECTED") &&
        entry.metrics.startCount === 1 &&
        entry.metrics.stopCount === 0 &&
        entry.metrics.invalidTransitionCount === 0 &&
        entry.resources.gattServerAlwaysInactive &&
        entry.resources.gattClientAlwaysInactive &&
        entry.resources.maximumSessionCount === 0 &&
        entry.backgroundLifecycle.homeKeyEventSent &&
        entry.backgroundLifecycle.foregroundServiceChecks >=
          B3_REQUIRED_FOREGROUND_SERVICE_CHECKS &&
        entry.backgroundLifecycle.foregroundServiceAlwaysActive &&
        entry.backgroundLifecycle.dataSyncTypeAlwaysPresent &&
        entry.backgroundLifecycle
          .connectedDeviceTypeRequirementEnforced &&
        entry.applicationExitInfo.baselineCaptured &&
        entry.applicationExitInfo.finalCaptured &&
        entry.applicationExitInfo.newAnrOrCrashCount === 0
    );
  return {
    schemaVersion: 1,
    source: "V5BT_B3_ANDROID_SERVICE_GATE_HARNESS",
    scope: "ANDROID_CONNECTIVITY_AGENT_FOREGROUND_SERVICE",
    generatedAt: new Date().toISOString(),
    mode: "PHYSICAL_TWO_TARGET",
    gate: "PENDING",
    gateReason: measurementPass
      ? "PHYSICAL_EVIDENCE_REVIEW_REQUIRED"
      : "PHYSICAL_MEASUREMENT_REQUIREMENTS_NOT_MET",
    localMeasurementVerdict: measurementPass ? "PASS" : "PENDING",
    physicalRunExecuted: true,
    requiredDurationSeconds: B3_REQUIRED_DURATION_SECONDS,
    runtimeAuditIntervalSeconds: B3_RUNTIME_AUDIT_INTERVAL_SECONDS,
    requiredForegroundServiceChecks:
      B3_REQUIRED_FOREGROUND_SERVICE_CHECKS,
    measuredDurationMs,
    exactFixedDurationConfigured: true,
    currentAndroidUserRequired: true,
    minimumAndroidApi: B3_MIN_ANDROID_API,
    reportRedactionVerified: true,
    activeV4Changes: false,
    raspberryCommands: false,
    apkInstallOrPermissionGrantPerformed: false,
    physicalCertificationPassEmittedByHarness: false,
    preflight,
    targets: trackerSummaries
  };
}

export function buildDryRun(options) {
  return {
    schemaVersion: 1,
    source: "V5BT_B3_ANDROID_SERVICE_GATE_HARNESS",
    scope: "ANDROID_CONNECTIVITY_AGENT_FOREGROUND_SERVICE",
    mode: "DRY_RUN",
    gate: "PENDING",
    gateReason: "PHYSICAL_MEASUREMENT_NOT_EXECUTED",
    localMeasurementVerdict: "NOT_RUN",
    physicalRunExecuted: false,
    adbExecuted: false,
    requiredDurationSeconds: B3_REQUIRED_DURATION_SECONDS,
    runtimeAuditIntervalSeconds: B3_RUNTIME_AUDIT_INTERVAL_SECONDS,
    requiredForegroundServiceChecks:
      B3_REQUIRED_FOREGROUND_SERVICE_CHECKS,
    pollMs: options.pollMs,
    exactFixedDurationConfigured: true,
    currentAndroidUserRequired: true,
    minimumAndroidApi: B3_MIN_ANDROID_API,
    bothFixedTargetsConfigured:
      options.handheldSerial === B3_EXPECTED_TARGETS.handheld.serial &&
      options.stationSerial === B3_EXPECTED_TARGETS.station.serial,
    reportRedactionVerified: true,
    activeV4Changes: false,
    raspberryCommands: false,
    apkInstallOrPermissionGrantPerformed: false,
    statusPath: B3_STATUS_PATH,
    checks: [
      "two fixed authorized ADB targets",
      `Android API >= ${B3_MIN_ANDROID_API}`,
      "fixed model, Advanced package and Advanced version",
      "current Android user remains unchanged",
      "BLE enabled and three runtime Bluetooth permissions granted",
      "run-as reads only the app-private B3 status",
      "HOME backgrounds both apps before the fixed measurement starts",
      "periodic current-user foreground-service dumpsys verification",
      "dataSync plus connectedDevice while radio resources are active",
      "baseline/final current-user ApplicationExitInfo with no new ANR or crash",
      "strict redacted status allowlist",
      "fresh monotonic samples from one reporter",
      "exactly one service start and zero service stops",
      "zero STOPPED states and invalid transitions",
      "zero GATT client/server activity and zero sessions",
      `${B3_REQUIRED_DURATION_SECONDS} seconds of continuous observation`
    ]
  };
}

export function statusFixture(overrides = {}) {
  const metrics = {
    startCount: 1,
    stopCount: 0,
    backoffCount: 0,
    transitionCount: 1,
    duplicateEventCount: 0,
    invalidTransitionCount: 0,
    ...(overrides.metrics ?? {})
  };
  const resources = {
    scannerActive: true,
    advertiserActive: true,
    gattServerActive: false,
    gattClientActive: false,
    sessionCount: 0,
    ...(overrides.resources ?? {})
  };
  const topLevelOverrides = Object.fromEntries(
    Object.entries(overrides).filter(
      ([key]) => key !== "metrics" && key !== "resources"
    )
  );
  return {
    schemaVersion: 1,
    source: "V5BT_ANDROID_CONNECTIVITY_AGENT",
    labBuild: true,
    diagnosticsEnabled: true,
    agentEnabled: true,
    sampleSequence: 1,
    sampledAtEpochMs: 1_100,
    reporterStartedAtEpochMs: 1_000,
    state: "DISCOVERING",
    metrics,
    resources,
    ...topLevelOverrides
  };
}

export function assertReportRedacted(report, secrets = []) {
  const inspectKeys = (value, label = "$") => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        inspectKeys(entry, `${label}[${index}]`)
      );
      return;
    }
    if (value == null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll("_", "");
      if (FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part))) {
        throw new B3GateError(
          "OUTPUT_IDENTIFIER_FIELD",
          `report contains a forbidden field at ${label}`
        );
      }
      inspectKeys(entry, `${label}.${key}`);
    }
  };
  inspectKeys(report);
  const payload = JSON.stringify(report);
  for (const secret of secrets) {
    if (secret && payload.includes(secret)) {
      throw new B3GateError(
        "OUTPUT_IDENTIFIER_DETECTED",
        "redacted report contains a target identifier"
      );
    }
  }
  return true;
}

function writeAtomic(outputPath, payload) {
  fs.mkdirSync(path.dirname(outputPath), {
    recursive: true,
    mode: 0o700
  });
  try {
    const existing = fs.lstatSync(outputPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new B3GateError(
        "OUTPUT_PATH_INVALID",
        "output must be a regular file path"
      );
    }
  } catch (error) {
    if (
      error instanceof B3GateError ||
      (error && error.code !== "ENOENT")
    ) {
      throw error;
    }
  }
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL,
      0o600
    );
    fs.writeFileSync(descriptor, payload, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, outputPath);
    fs.chmodSync(outputPath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Best-effort cleanup after a local report write failure.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    if (error instanceof B3GateError) throw error;
    throw new B3GateError(
      "REPORT_WRITE_FAILED",
      "unable to write the redacted report"
    );
  }
}

export function writeResult(outputPath, report, secrets = []) {
  assertReportRedacted(report, secrets);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) writeAtomic(outputPath, payload);
  process.stdout.write(payload);
}

export function runSelfTest() {
  let tests = 0;
  const check = (callback) => {
    callback();
    tests += 1;
  };
  const valid = parseStatus(JSON.stringify(statusFixture()));
  check(() => assert.equal(valid.state, "DISCOVERING"));
  check(() => assertB3Scope(valid, "handheld"));
  check(() =>
    assert.throws(
      () =>
        parseStatus(
          JSON.stringify({ ...statusFixture(), nodeId: "forbidden" })
        ),
      (error) =>
        error instanceof B3GateError &&
        error.code === "STATUS_NOT_REDACTED"
    )
  );
  check(() =>
    assert.throws(
      () =>
        parseStatus(
          JSON.stringify(statusFixture({ state: "NOT_A_STATE" }))
        ),
      (error) =>
        error instanceof B3GateError && error.code === "STATUS_INVALID"
    )
  );
  check(() =>
    assert.throws(
      () => assertB3Scope(statusFixture({ state: "STOPPED" })),
      (error) =>
        error instanceof B3GateError && error.code === "SERVICE_STOPPED"
    )
  );
  check(() =>
    assert.throws(
      () =>
        assertB3Scope(
          statusFixture({
            metrics: { invalidTransitionCount: 1, transitionCount: 1 }
          })
        ),
      (error) =>
        error instanceof B3GateError &&
        error.code === "INVALID_TRANSITION_REPORTED"
    )
  );
  check(() =>
    assert.throws(
      () =>
        assertB3Scope(
          statusFixture({ resources: { gattClientActive: true } })
        ),
      (error) =>
        error instanceof B3GateError &&
        error.code === "B3_GATT_SESSION_ACTIVITY"
    )
  );
  check(() =>
    assert.throws(
      () =>
        assertB3Scope(
          statusFixture({ resources: { sessionCount: 1 } })
        ),
      (error) =>
        error instanceof B3GateError &&
        error.code === "B3_GATT_SESSION_ACTIVITY"
    )
  );

  const tracker = createStatusTracker();
  const anchor = {
    epochFloorMs: 1_000,
    capturedAtPerformanceMs: 0
  };
  check(() =>
    validateFreshSample(valid, tracker, anchor, 200, "handheld")
  );
  const second = parseStatus(
    JSON.stringify(
      statusFixture({
        sampleSequence: 2,
        sampledAtEpochMs: 1_200,
        metrics: { transitionCount: 2 }
      })
    )
  );
  check(() =>
    validateFreshSample(second, tracker, anchor, 300, "handheld")
  );
  check(() => assert.equal(tracker.distinctSamples, 2));
  const reused = structuredClone(second);
  reused.state = "BACKOFF";
  check(() =>
    assert.throws(
      () =>
        validateFreshSample(reused, tracker, anchor, 350, "handheld"),
      (error) =>
        error instanceof B3GateError &&
        error.code === "STATUS_SEQUENCE_REUSED"
    )
  );
  const restarted = structuredClone(second);
  restarted.sampleSequence = 3;
  restarted.sampledAtEpochMs = 1_300;
  restarted.reporterStartedAtEpochMs = 1_250;
  check(() =>
    assert.throws(
      () =>
        validateFreshSample(
          restarted,
          tracker,
          anchor,
          400,
          "handheld"
        ),
      (error) =>
        error instanceof B3GateError &&
        error.code === "STATUS_REPORTER_RESTARTED"
    )
  );
  const regressedMetrics = structuredClone(second);
  regressedMetrics.sampleSequence = 3;
  regressedMetrics.sampledAtEpochMs = 1_300;
  regressedMetrics.metrics.transitionCount = 1;
  check(() =>
    assert.throws(
      () =>
        validateFreshSample(
          regressedMetrics,
          tracker,
          anchor,
          400,
          "handheld"
        ),
      (error) =>
        error instanceof B3GateError &&
        error.code === "STATUS_METRICS_REGRESSED"
    )
  );
  check(() =>
    assert.throws(
      () =>
        validateFreshSample(
          statusFixture({
            reporterStartedAtEpochMs: 999,
            sampledAtEpochMs: 1_100
          }),
          createStatusTracker(),
          anchor,
          200,
          "handheld"
        ),
      (error) =>
        error instanceof B3GateError &&
        error.code === "STATUS_NOT_FRESH"
    )
  );

  const dryOptions = parseArguments(["--dry-run"]);
  const dryRun = buildDryRun(dryOptions);
  check(() => assert.equal(dryRun.adbExecuted, false));
  check(() =>
    assert.equal(
      dryRun.requiredDurationSeconds,
      B3_REQUIRED_DURATION_SECONDS
    )
  );
  check(() => assert.equal(dryRun.gate, "PENDING"));
  check(() =>
    assert.throws(
      () =>
        parseArguments([
          "--dry-run",
          "--duration-seconds",
          "1"
        ]),
      (error) =>
        error instanceof B3GateError &&
        error.code === "INVALID_ARGUMENT"
    )
  );
  check(() =>
    assert.throws(
      () =>
        parseArguments([
          "--handheld-serial",
          B3_EXPECTED_TARGETS.handheld.serial
        ]),
      (error) =>
        error instanceof B3GateError &&
        error.code === "INVALID_ARGUMENT"
    )
  );
  const physicalOptions = parseArguments([
    "--handheld-serial",
    B3_EXPECTED_TARGETS.handheld.serial,
    "--station-serial",
    B3_EXPECTED_TARGETS.station.serial
  ]);
  check(() =>
    assert.equal(
      physicalOptions.stationSerial,
      B3_EXPECTED_TARGETS.station.serial
    )
  );
  check(() => assert.equal(parseCurrentUser("10\n"), 10));
  check(() =>
    assert.deepEqual(
      parseInstalledVersion(
        ` versionCode=${B3_EXPECTED_TARGETS.handheld.versionCode} minSdk=24\n` +
          ` versionName=${B3_EXPECTED_TARGETS.handheld.versionName}\n`
      ),
      {
        versionCode: B3_EXPECTED_TARGETS.handheld.versionCode,
        versionName: B3_EXPECTED_TARGETS.handheld.versionName
      }
    )
  );
  check(() =>
    assert.equal(
      parseInstalledApkPath("package:/data/app/example/base.apk\n"),
      "/data/app/example/base.apk"
    )
  );
  check(() =>
    assert.equal(
      parseInstalledApkSha256(
        `${B3_EXPECTED_TARGETS.handheld.sha256}  /data/app/example/base.apk\n`
      ),
      B3_EXPECTED_TARGETS.handheld.sha256
    )
  );
  const permissionDump = [
    "  User 0:",
    "    android.permission.BLUETOOTH_SCAN: granted=false",
    "  User 10:",
    "    android.permission.BLUETOOTH_SCAN: granted=true"
  ].join("\n");
  check(() =>
    assert.equal(
      permissionGrantedForUser(
        permissionDump,
        10,
        "android.permission.BLUETOOTH_SCAN"
      ),
      true
    )
  );
  check(() =>
    assert.equal(
      permissionGrantedForUser(
        permissionDump,
        0,
        "android.permission.BLUETOOTH_SCAN"
      ),
      false
    )
  );
  check(() =>
    assert.deepEqual(buildHomeKeyEventArgs(), [
      "shell",
      "input",
      "keyevent",
      "KEYCODE_HOME"
    ])
  );
  check(() =>
    assert.deepEqual(
      buildForegroundServiceDumpArgs("com.example"),
      [
        "shell",
        "dumpsys",
        "activity",
        "-a",
        "services",
        "com.example"
      ]
    )
  );
  const serviceDump = [
    "ACTIVITY MANAGER SERVICES (dumpsys activity services)",
    " User 0 active services:",
    " * ServiceRecord{abc u0 com.example/.BluetoothFailoverService}",
    "   isForeground=true foregroundId=1 types=00000001",
    " User 10 active services:",
    " * ServiceRecord{def u10 com.example/.BluetoothFailoverService}",
    "   isForeground=true foregroundId=2 types=0x00000011"
  ].join("\n");
  const foregroundService = parseForegroundServiceDump(
    serviceDump,
    10,
    "handheld"
  );
  check(() => assert.equal(foregroundService.foreground, true));
  check(() => assert.equal(foregroundService.typeMask, 0x11));
  check(() =>
    assert.deepEqual(
      assertForegroundServiceForStatus(
        foregroundService,
        valid,
        "handheld"
      ),
      { radioActive: true }
    )
  );
  check(() =>
    assert.throws(
      () =>
        assertForegroundServiceForStatus(
          { foreground: true, typeMask: B3_FGS_TYPE_DATA_SYNC },
          valid,
          "handheld"
        ),
      (error) =>
        error instanceof B3GateError &&
        error.code === "FOREGROUND_SERVICE_TYPE_INVALID"
    )
  );
  const exitInfoBaselineRaw = [
    "ACTIVITY MANAGER PROCESS EXIT INFO (dumpsys activity exit-info)",
    " package: com.example",
    "  Historical Process Exit for uid=10123",
    "   ApplicationExitInfo #0:",
    "    timestamp=2026-07-19 12:00:00.000 pid=100 realUid=10123 packageUid=10123 definingUid=10123 user=0",
    "    process=com.example reason=4 (APP CRASH(EXCEPTION)) subreason=0 (UNKNOWN) status=0",
    "  Historical Process Exit for uid=1010123",
    "   ApplicationExitInfo #0:",
    "    timestamp=2026-07-19 13:00:00.000 pid=200 realUid=1010123 packageUid=1010123 definingUid=1010123 user=10",
    "    process=com.example reason=4 (APP CRASH(EXCEPTION)) subreason=0 (UNKNOWN) status=0"
  ].join("\n");
  const exitInfoFinalRaw = [
    exitInfoBaselineRaw,
    "   ApplicationExitInfo #1:",
    "    timestamp=2026-07-20 13:00:00.000 pid=201 realUid=1010123 packageUid=1010123 definingUid=1010123 user=10",
    "    process=com.example reason=10 (USER REQUESTED) subreason=0 (UNKNOWN) status=0"
  ].join("\n");
  const exitInfoBaseline = parseApplicationExitInfo(
    exitInfoBaselineRaw,
    10,
    "handheld"
  );
  const exitInfoFinal = parseApplicationExitInfo(
    exitInfoFinalRaw,
    10,
    "handheld"
  );
  check(() => assert.equal(exitInfoBaseline.fatalRecordCount, 1));
  check(() =>
    assert.equal(
      assertNoNewFatalApplicationExits(
        exitInfoBaseline,
        exitInfoFinal,
        "handheld"
      ),
      0
    )
  );
  const exitInfoCrashRaw = [
    exitInfoFinalRaw,
    "   ApplicationExitInfo #2:",
    "    timestamp=2026-07-20 14:00:00.000 pid=202 realUid=1010123 packageUid=1010123 definingUid=1010123 user=10",
    "    process=com.example reason=6 (ANR) subreason=0 (UNKNOWN) status=0"
  ].join("\n");
  check(() =>
    assert.throws(
      () =>
        assertNoNewFatalApplicationExits(
          exitInfoBaseline,
          parseApplicationExitInfo(
            exitInfoCrashRaw,
            10,
            "handheld"
          ),
          "handheld"
        ),
      (error) =>
        error instanceof B3GateError &&
        error.code === "NEW_ANR_OR_CRASH"
    )
  );

  const trackers = ["handheld", "station"].map(() => {
    const current = createStatusTracker();
    current.reporterStartedAtEpochMs = 1_000;
    current.firstSequence = 1;
    current.lastSequence = 2;
    current.firstSampledAtEpochMs = 1_100;
    current.lastSampledAtEpochMs = 1_200;
    current.lastFingerprint = JSON.stringify(second);
    current.lastMetrics = { ...second.metrics };
    current.lastStatus = structuredClone(second);
    current.lastObservedAtPerformanceMs = 300;
    current.distinctSamples = 2;
    current.statesObserved.add("DISCOVERING");
    current.scannerEverActive = true;
    current.advertiserEverActive = true;
    current.maximumSessionCount = 0;
    return current;
  });
  const preflight = ["handheld", "station"].map((role) => ({
    role,
    androidApi: 34,
    currentAndroidUserVerified: true,
    fixedTargetTransportVerified: true,
    fixedTargetModelVerified: true,
    fixedTargetPackageVerified: true,
    fixedTargetVersionVerified: true,
    fixedTargetApkSha256Verified: true,
    bluetoothLeFeature: true,
    bluetoothEnabled: true,
    currentUserBluetoothPermissionsGranted: true,
    privateStatusReadableWithRunAs: true
  }));
  const runtimeEvidence = ["handheld", "station"].map(() => ({
    ...createRuntimeEvidence(),
    homeKeyEventSent: true,
    foregroundServiceChecks: 61,
    radioActiveForegroundChecks: 61,
    applicationExitBaselineCaptured: true,
    applicationExitFinalCaptured: true,
    newAnrOrCrashCount: 0
  }));
  const physicalSummary = buildPhysicalSummary(
    preflight,
    trackers,
    B3_REQUIRED_DURATION_MS,
    runtimeEvidence
  );
  check(() =>
    assert.equal(physicalSummary.localMeasurementVerdict, "PASS")
  );
  check(() => assert.equal(physicalSummary.gate, "PENDING"));
  check(() =>
    assert.equal(
      physicalSummary.physicalCertificationPassEmittedByHarness,
      false
    )
  );
  check(() =>
    assert.equal(
      assertReportRedacted(physicalSummary, [
        B3_EXPECTED_TARGETS.handheld.serial,
        B3_EXPECTED_TARGETS.station.serial
      ]),
      true
    )
  );
  check(() =>
    assert.throws(
      () =>
        assertReportRedacted(
          { accidental: B3_EXPECTED_TARGETS.handheld.serial },
          [B3_EXPECTED_TARGETS.handheld.serial]
        ),
      (error) =>
        error instanceof B3GateError &&
        error.code === "OUTPUT_IDENTIFIER_DETECTED"
    )
  );

  return {
    schemaVersion: 1,
    source: "V5BT_B3_ANDROID_SERVICE_GATE_HARNESS_SELF_TEST",
    result: "PASS",
    gate: "PENDING",
    physicalRunExecuted: false,
    adbExecuted: false,
    activeV4Changes: false,
    tests
  };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.selfTest) {
      writeResult(null, runSelfTest());
      return 0;
    }
    if (options.dryRun) {
      writeResult(
        options.output,
        buildDryRun(options),
        [options.handheldSerial, options.stationSerial]
      );
      return 0;
    }

    const devices = [
      {
        role: "handheld",
        serial: options.handheldSerial,
        packageId: B3_EXPECTED_TARGETS.handheld.packageId,
        userId: null
      },
      {
        role: "station",
        serial: options.stationSerial,
        packageId: B3_EXPECTED_TARGETS.station.packageId,
        userId: null
      }
    ];
    await ensureAttached(options, devices);
    const preflight = await Promise.all(
      devices.map((device) => preflightDevice(options, device))
    );
    let result;
    try {
      result = await runPhysicalMeasurement(
        options,
        devices,
        preflight
      );
    } finally {
      await Promise.all(
        devices.map((device) =>
          forceStop(options, device).catch(() => undefined)
        )
      );
    }
    writeResult(
      options.output,
      result,
      [options.handheldSerial, options.stationSerial]
    );
    return result.localMeasurementVerdict === "PASS" ? 2 : 1;
  } catch (error) {
    const safeError =
      error instanceof B3GateError
        ? error
        : new B3GateError(
            "UNEXPECTED_ERROR",
            "B3 service gate execution failed"
          );
    const safeMessage = redactText(
      safeError.message,
      RUNTIME_REDACTION_SECRETS
    );
    const failure = {
      schemaVersion: 1,
      source: "V5BT_B3_ANDROID_SERVICE_GATE_HARNESS",
      scope: "ANDROID_CONNECTIVITY_AGENT_FOREGROUND_SERVICE",
      generatedAt: new Date().toISOString(),
      mode: options?.dryRun ? "DRY_RUN" : "PHYSICAL_TWO_TARGET",
      gate: "PENDING",
      gateReason: "HARNESS_FAILURE",
      localMeasurementVerdict: "FAIL",
      physicalRunExecuted:
        options != null &&
        !options.dryRun &&
        !options.selfTest &&
        !options.help,
      reportRedactionVerified: true,
      activeV4Changes: false,
      raspberryCommands: false,
      failure: {
        code: safeError.code,
        message: safeMessage
      }
    };
    try {
      writeResult(
        options?.output,
        failure,
        [...RUNTIME_REDACTION_SECRETS]
      );
    } catch {
      process.stderr.write(`${safeError.code}: ${safeMessage}\n`);
    }
    return 1;
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
