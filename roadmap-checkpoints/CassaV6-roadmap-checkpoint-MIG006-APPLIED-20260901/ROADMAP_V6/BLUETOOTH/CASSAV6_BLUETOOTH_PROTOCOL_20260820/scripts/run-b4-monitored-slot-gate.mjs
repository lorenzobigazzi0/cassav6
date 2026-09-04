#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const B4_MONITORED_SLOT_GATE_VERSION = "1.0.0";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REQUIRED_RUNNER_DURATION_MS = 90_000;
const MAX_CAPTURE_DURATION_MS = 600_000;
const STABLE_HARDWARE_SERIAL_PATTERN = /^[A-Za-z0-9._:-]{4,128}$/u;

export class B4MonitoredSlotGateError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "B4MonitoredSlotGateError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function loadB4MonitorAttestationParsers() {
  try {
    const [androidModule, raspberryModule] = await Promise.all([
      import(
        new URL(
          "../../../scripts/run-v6-b4-android-continuity-monitor.mjs",
          import.meta.url
        )
      ),
      import(
        new URL(
          "../../../scripts/run-v6-b4-raspberry-continuity-monitor.mjs",
          import.meta.url
        )
      )
    ]);
    const {
      parseB4AndroidContinuityAttestation
    } = androidModule;
    const {
      parseB4RaspberryContinuityAttestation
    } = raspberryModule;
    if (
      typeof parseB4AndroidContinuityAttestation !== "function" ||
      typeof parseB4RaspberryContinuityAttestation !== "function"
    ) {
      fail(
        "MONITOR_PARSER_UNAVAILABLE",
        "B4 monitor attestation parsers are unavailable"
      );
    }
    return Object.freeze({
      parseAndroidAttestation: parseB4AndroidContinuityAttestation,
      parseRaspberryAttestation: parseB4RaspberryContinuityAttestation
    });
  } catch (error) {
    if (error instanceof B4MonitoredSlotGateError) throw error;
    fail(
      "MONITOR_PARSER_UNAVAILABLE",
      "B4 monitor attestation parsers are unavailable"
    );
  }
}

function fail(code, message, exitCode = 1) {
  throw new B4MonitoredSlotGateError(code, message, exitCode);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be a JSON object`);
  return value;
}

function requireTimestamp(value, code, label) {
  if (typeof value !== "string") fail(code, `${label} is invalid`);
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
    fail(code, `${label} is invalid`);
  }
  return epochMs;
}

function requireSha256(value, code, label) {
  if (
    typeof value !== "string" ||
    !SHA256_PATTERN.test(value) ||
    /^0{64}$/u.test(value)
  ) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function requireUuidV4(value, code, label) {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireIdentityKey(identityKey) {
  if (!Buffer.isBuffer(identityKey) || identityKey.byteLength !== 32) {
    fail(
      "TARGET_HARDWARE_BINDING_INVALID",
      "B4 target hardware identity key must contain 32 bytes"
    );
  }
  return identityKey;
}

export function buildB4TargetHardwareCommitmentFromDeviceDigest({
  identityKey,
  deviceDigest,
  captureRunId
}) {
  requireIdentityKey(identityKey);
  requireSha256(
    deviceDigest,
    "TARGET_HARDWARE_BINDING_INVALID",
    "B4 private device digest"
  );
  requireUuidV4(
    captureRunId,
    "TARGET_HARDWARE_BINDING_INVALID",
    "Capture run identifier"
  );
  return crypto
    .createHmac("sha256", identityKey)
    .update("V6:B4:TARGET_HARDWARE:", "utf8")
    .update(captureRunId, "utf8")
    .update(":", "utf8")
    .update(deviceDigest, "utf8")
    .digest("hex");
}

export function buildB4TargetHardwareCommitment(
  identityKey,
  stableHardwareSerial,
  captureRunId
) {
  requireIdentityKey(identityKey);
  if (
    typeof stableHardwareSerial !== "string" ||
    !STABLE_HARDWARE_SERIAL_PATTERN.test(stableHardwareSerial)
  ) {
    fail(
      "TARGET_HARDWARE_BINDING_INVALID",
      "Stable Android hardware identity is invalid"
    );
  }
  const deviceDigest = crypto
    .createHmac("sha256", identityKey)
    .update("V6:B4:PHYSICAL-DEVICE:", "utf8")
    .update(stableHardwareSerial, "utf8")
    .digest("hex");
  return buildB4TargetHardwareCommitmentFromDeviceDigest({
    identityKey,
    deviceDigest,
    captureRunId
  });
}

export function buildB4SlotRunCommitments({
  collectionRunId,
  captureRunId
}) {
  requireUuidV4(
    collectionRunId,
    "MONITOR_BINDING_INVALID",
    "Collection run identifier"
  );
  requireUuidV4(
    captureRunId,
    "MONITOR_BINDING_INVALID",
    "Capture run identifier"
  );
  if (collectionRunId === captureRunId) {
    fail(
      "MONITOR_BINDING_INVALID",
      "Collection and capture run identifiers must be distinct"
    );
  }
  return Object.freeze({
    collectionRunCommitmentSha256: sha256(
      Buffer.from(`V6:B4:COLLECTION_RUN:${collectionRunId}`, "utf8")
    ),
    captureRunCommitmentSha256: sha256(
      Buffer.from(`V6:B4:CAPTURE_RUN:${captureRunId}`, "utf8")
    )
  });
}

function collectorContext(state) {
  requireRecord(state, "COLLECTOR_STATE_INVALID", "Collector state");
  if (
    state.schemaVersion !== 2 ||
    state.product !== "V6" ||
    state.phase !== "B4"
  ) {
    fail("COLLECTOR_STATE_INVALID", "Collector state is not a B4 v2 state");
  }
  requireUuidV4(
    state.runId,
    "COLLECTOR_STATE_INVALID",
    "Collector run identifier"
  );
  const binding = requireRecord(
    state.certificationMatrixBinding,
    "COLLECTOR_STATE_INVALID",
    "Collector certification matrix binding"
  );
  const matrix = requireRecord(
    binding.matrix,
    "COLLECTOR_STATE_INVALID",
    "Collector certification matrix"
  );
  if (matrix.schemaVersion !== 3) {
    fail(
      "COLLECTOR_STATE_INVALID",
      "Collector certification matrix schema is not v3"
    );
  }
  const matrixSha256 = requireSha256(
    binding.matrixSha256,
    "COLLECTOR_STATE_INVALID",
    "Collector certification matrix digest"
  );
  const handheld = requireRecord(
    matrix.roles?.handheld,
    "COLLECTOR_STATE_INVALID",
    "Certified handheld target"
  );
  return Object.freeze({
    collectionRunId: state.runId,
    matrixSha256,
    handheld
  });
}

function reportWindow(report) {
  requireRecord(report, "RUNNER_REPORT_INVALID", "B4.3 runner report");
  if (
    report.schemaVersion !== 1 ||
    report.product !== "V6" ||
    report.phase !== "B4.3" ||
    report.mode !== "PHYSICAL_SINGLE_ADVERTISER" ||
    report.verdict !== "PASS"
  ) {
    fail("RUNNER_REPORT_INVALID", "B4.3 runner report did not pass");
  }
  const completedAtMs = requireTimestamp(
    report.generatedAt,
    "RUNNER_REPORT_INVALID",
    "B4.3 runner completion"
  );
  const measurement = requireRecord(
    report.measurement,
    "RUNNER_REPORT_INVALID",
    "B4.3 runner measurement"
  );
  if (
    measurement.requiredDurationSeconds !== 90 ||
    !Number.isSafeInteger(measurement.wallClockDurationMs) ||
    measurement.wallClockDurationMs < REQUIRED_RUNNER_DURATION_MS ||
    measurement.wallClockDurationMs > MAX_CAPTURE_DURATION_MS
  ) {
    fail("RUNNER_REPORT_INVALID", "B4.3 runner duration is invalid");
  }
  return Object.freeze({
    startedAtMs: completedAtMs - measurement.wallClockDurationMs,
    completedAtMs
  });
}

function attestationReport(parsed, label) {
  const report = isRecord(parsed?.report) ? parsed.report : parsed;
  return requireRecord(report, "MONITOR_ATTESTATION_INVALID", label);
}

function validateCommonAttestation(
  report,
  expectedCommitments,
  expectedMatrixSha256,
  label
) {
  if (
    report.schemaVersion !== 1 ||
    report.product !== "V6" ||
    report.phase !== "B4" ||
    report.verdict !== "PASS"
  ) {
    fail("MONITOR_ATTESTATION_INVALID", `${label} did not pass B4`);
  }
  const binding = requireRecord(
    report.binding,
    "MONITOR_ATTESTATION_INVALID",
    `${label} binding`
  );
  for (const [field, expected] of Object.entries({
    ...expectedCommitments,
    certificationMatrixSha256: expectedMatrixSha256
  })) {
    requireSha256(
      binding[field],
      "MONITOR_ATTESTATION_INVALID",
      `${label} ${field}`
    );
    if (binding[field] !== expected) {
      fail(
        field === "certificationMatrixSha256"
          ? "MONITOR_MATRIX_MISMATCH"
          : "MONITOR_BINDING_MISMATCH",
        `${label} is bound to a different run or matrix`
      );
    }
  }
  return binding;
}

function validateHandheldTarget(target, handheld) {
  requireRecord(
    target,
    "MONITOR_TARGET_INVALID",
    "Android monitor target"
  );
  const expected = {
    role: "handheld",
    packageName: handheld.packageId,
    versionName: handheld.versionName,
    versionCode: handheld.versionCode,
    apkSha256: handheld.sha256,
    signingCertificateSha256: handheld.signingCertificateSha256
  };
  for (const [field, value] of Object.entries(expected)) {
    if (target[field] !== value) {
      fail(
        "MONITOR_TARGET_INVALID",
        "Android monitor target is not the certified handheld"
      );
    }
  }
  if (!Number.isSafeInteger(target.androidApi) || target.androidApi < 33) {
    fail("MONITOR_TARGET_INVALID", "Android monitor API level is invalid");
  }
}

function validateCoverage(androidReport, raspberryReport, runnerWindow) {
  const android = requireRecord(
    androidReport.coverage,
    "MONITOR_COVERAGE_INVALID",
    "Android monitor coverage"
  );
  const raspberry = requireRecord(
    raspberryReport.coverage,
    "MONITOR_COVERAGE_INVALID",
    "Raspberry monitor coverage"
  );
  const androidFromMs = requireTimestamp(
    android.monitoredFrom,
    "MONITOR_COVERAGE_INVALID",
    "Android monitor start"
  );
  const androidUntilMs = requireTimestamp(
    android.monitoredUntil,
    "MONITOR_COVERAGE_INVALID",
    "Android monitor completion"
  );
  const raspberryFromMs = requireTimestamp(
    raspberry.monitoredFrom,
    "MONITOR_COVERAGE_INVALID",
    "Raspberry monitor start"
  );
  const runnerObservedAtMs = requireTimestamp(
    raspberry.runnerObservedAt,
    "MONITOR_COVERAGE_INVALID",
    "Raspberry runner observation"
  );
  const cleanupObservedAtMs = requireTimestamp(
    raspberry.cleanupObservedAt,
    "MONITOR_COVERAGE_INVALID",
    "Raspberry cleanup observation"
  );
  const raspberryUntilMs = requireTimestamp(
    raspberry.monitoredUntil,
    "MONITOR_COVERAGE_INVALID",
    "Raspberry monitor completion"
  );
  if (
    androidFromMs > runnerWindow.startedAtMs ||
    raspberryFromMs > runnerWindow.startedAtMs ||
    runnerObservedAtMs < runnerWindow.startedAtMs ||
    runnerObservedAtMs > runnerWindow.completedAtMs ||
    cleanupObservedAtMs < runnerWindow.completedAtMs ||
    cleanupObservedAtMs > raspberryUntilMs ||
    androidUntilMs < cleanupObservedAtMs ||
    androidUntilMs < androidFromMs ||
    raspberryUntilMs < raspberryFromMs
  ) {
    fail(
      "MONITOR_COVERAGE_INCOMPLETE",
      "Monitor attestations do not cover the complete runner and cleanup window"
    );
  }
  return Object.freeze({
    coverageStartedAt: new Date(
      Math.min(androidFromMs, raspberryFromMs)
    ).toISOString(),
    coverageCompletedAt: new Date(
      Math.max(androidUntilMs, raspberryUntilMs)
    ).toISOString()
  });
}

export function validateB4MonitoredSlotAuthorization(
  {
    collectorState,
    captureRunId,
    expectedPackageName,
    raspberryReport,
    androidAttestationText,
    raspberryAttestationText
  },
  {
    parseAndroidAttestation = null,
    parseRaspberryAttestation = null
  } = {}
) {
  if (
    typeof parseAndroidAttestation !== "function" ||
    typeof parseRaspberryAttestation !== "function"
  ) {
    fail(
      "MONITOR_PARSER_UNAVAILABLE",
      "Both canonical B4 monitor parsers are required"
    );
  }
  if (
    typeof androidAttestationText !== "string" ||
    typeof raspberryAttestationText !== "string" ||
    Buffer.byteLength(androidAttestationText, "utf8") < 2 ||
    Buffer.byteLength(raspberryAttestationText, "utf8") < 2
  ) {
    fail(
      "MONITOR_ATTESTATION_INVALID",
      "Both monitor attestation byte streams are required"
    );
  }
  const context = collectorContext(collectorState);
  if (expectedPackageName !== context.handheld.packageId) {
    fail(
      "MONITOR_TARGET_INVALID",
      "The monitored-slot gate only accepts the certified handheld package"
    );
  }
  requireUuidV4(
    captureRunId,
    "MONITOR_BINDING_INVALID",
    "Capture run identifier"
  );
  const commitments = buildB4SlotRunCommitments({
    collectionRunId: context.collectionRunId,
    captureRunId
  });
  let parsedAndroid;
  let parsedRaspberry;
  try {
    parsedAndroid = parseAndroidAttestation(androidAttestationText);
    parsedRaspberry = parseRaspberryAttestation(raspberryAttestationText);
  } catch {
    fail(
      "MONITOR_ATTESTATION_INVALID",
      "A monitor attestation failed its canonical parser"
    );
  }
  const androidReport = attestationReport(
    parsedAndroid,
    "Android monitor attestation"
  );
  const raspberryMonitorReport = attestationReport(
    parsedRaspberry,
    "Raspberry monitor attestation"
  );
  validateCommonAttestation(
    androidReport,
    commitments,
    context.matrixSha256,
    "Android monitor attestation"
  );
  const targetHardwareCommitmentSha256 = requireSha256(
    androidReport.binding?.targetHardwareCommitmentSha256,
    "MONITOR_TARGET_INVALID",
    "Android target hardware commitment"
  );
  validateCommonAttestation(
    raspberryMonitorReport,
    commitments,
    context.matrixSha256,
    "Raspberry monitor attestation"
  );
  validateHandheldTarget(androidReport.target, context.handheld);
  const coverage = validateCoverage(
    androidReport,
    raspberryMonitorReport,
    reportWindow(raspberryReport)
  );
  return Object.freeze({
    ...commitments,
    captureRunId,
    certificationMatrixSha256: context.matrixSha256,
    androidAttestationSha256: sha256(
      Buffer.from(androidAttestationText, "utf8")
    ),
    raspberryAttestationSha256: sha256(
      Buffer.from(raspberryAttestationText, "utf8")
    ),
    targetPackageName: androidReport.target.packageName,
    targetAndroidApi: androidReport.target.androidApi,
    targetHardwareCommitmentSha256,
    ...coverage
  });
}

function optionValue(argv, option) {
  const index = argv.indexOf(option);
  return index === -1 ? null : argv[index + 1] ?? null;
}

function assertWrapperArguments(argv) {
  if (!argv.includes("--record")) {
    fail("INVALID_ARGUMENT", "The monitored-slot wrapper only supports --record", 2);
  }
  for (const option of [
    "--state",
    "--capture-run-id",
    "--android-monitor-attestation",
    "--raspberry-monitor-attestation",
    "--raspberry-report",
    "--raspberry-log",
    "--serial",
    "--package"
  ]) {
    if (optionValue(argv, option) === null) {
      fail("INVALID_ARGUMENT", `${option} is required`, 2);
    }
  }
}

function usage() {
  return [
    "V6 B4 monitored physical-slot gate",
    "",
    "Usage:",
    "  node scripts/run-b4-monitored-slot-gate.mjs --record \\",
    "    --state PRIVATE.json --capture-run-id UUID \\",
    "    --android-monitor-attestation ANDROID.json \\",
    "    --raspberry-monitor-attestation RASPBERRY.json \\",
    "    --adb ADB --serial SERIAL --package HANDHELD_PACKAGE \\",
    "    --raspberry-report REPORT.json --raspberry-log NODE.log",
    "",
    "The collector revalidates both monitor attestations before ADB and record."
  ].join("\n");
}

function writeFailure(error) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    harnessVersion: B4_MONITORED_SLOT_GATE_VERSION,
    product: "V6",
    phase: "B4",
    generatedAt: new Date().toISOString(),
    verdict: "FAIL",
    failure: { code: error.code, message: error.message }
  }, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    assertWrapperArguments(argv);
    const { main: collectorMain } = await import(
      "./collect-b4-physical-device.mjs"
    );
    return collectorMain(argv);
  } catch (error) {
    const safe = error instanceof B4MonitoredSlotGateError
      ? error
      : new B4MonitoredSlotGateError(
          "MONITORED_SLOT_GATE_FAILED",
          "B4 monitored-slot gate failed"
        );
    writeFailure(safe);
    return safe.exitCode;
  }
}

const invokedPath =
  process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (
  invokedPath !== null &&
  fs.existsSync(invokedPath) &&
  fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(invokedPath)
) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
