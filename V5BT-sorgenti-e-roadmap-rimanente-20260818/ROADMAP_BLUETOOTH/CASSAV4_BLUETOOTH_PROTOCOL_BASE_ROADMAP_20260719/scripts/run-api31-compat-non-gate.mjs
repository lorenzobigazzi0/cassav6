#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const API31_COMPAT_NON_GATE_RUNNER_VERSION = "1.0.0";
export const API31_COMPAT_PHYSICAL_REPORT_VERSION = "2.0.0";
export const API31_COMPAT_PACKAGE_ID =
  "com.sentrapa.postazione.advanced.partial";
export const API31_COMPAT_VERSION_NAME = "2.0.23-api31compat";
export const API31_COMPAT_VERSION_CODE = 25;
export const API31_COMPAT_DISCOVERY_MIN_ANDROID_API = 31;
export const API31_COMPAT_CONTROLS = Object.freeze([
  "scan",
  "advertise",
  "gattClient",
  "gattServer",
  "scanAdvertiseConcurrent",
  "wifiBleCoexistence",
  "backgroundForeground"
]);
export const API31_COMPAT_PHYSICAL_CONTROLS = Object.freeze([
  "enrollmentV2",
  "scanCapability",
  "scanRuntime",
  "advertiseCapability",
  "advertiseRuntime",
  "gattClientCapability",
  "gattClientRuntime",
  "gattServerCapability",
  "gattServerRuntime",
  "scanAdvertiseConcurrent",
  "wifiBleCoexistence",
  "backgroundForeground",
  "androidContinuity",
  "raspberryContinuity",
  "stagingContinuity",
  "batteryCadence"
]);
export const API31_COMPAT_BATTERY_INTERVAL_MS = 120_000;
export const API31_COMPAT_CONTINUITY_POLL_INTERVAL_MS = 2_000;
export const API31_COMPAT_CONTINUITY_MAX_GAP_MS = 10_000;

const INPUT_SOURCE = "V5BT_API31_COMPAT_PRIVATE_CAPTURE";
const REPORT_SOURCE = "V5BT_API31_COMPAT_NON_GATE_REPORT";
const PROFILE = "API31_COMPAT_NON_GATE";
const ENDPOINT_EVIDENCE = "TEST_CONFIGURATION_ONLY";
const PHYSICAL_CAPTURE_CLASS = "PHYSICAL_DIAGNOSTIC";
const PHYSICAL_ENROLLMENT_EVIDENCE = "PHYSICAL_STAGING_V2_ACCEPTED";
const STATUS_VALUES = new Set(["PASS", "FAIL", "NOT_RUN"]);
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

export class Api31CompatNonGateError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "Api31CompatNonGateError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1) {
  throw new Api31CompatNonGateError(code, message, exitCode);
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail("CONTRACT_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index])
  ) {
    fail("CONTRACT_INVALID", `${label} contains missing or unexpected fields`);
  }
}

function exactValue(actual, expected, label) {
  if (actual !== expected) {
    fail("CONTRACT_INVALID", `${label} does not match the API 31 non-gate profile`);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeControls(controls) {
  exactKeys(controls, API31_COMPAT_CONTROLS, "controls");
  return Object.fromEntries(
    API31_COMPAT_CONTROLS.map((control) => {
      const status = controls[control];
      if (!STATUS_VALUES.has(status)) {
        fail("CONTRACT_INVALID", `controls.${control} is invalid`);
      }
      return [control, status];
    })
  );
}

function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("CONTRACT_INVALID", `${label} must be a non-negative safe integer`);
  }
  return value;
}

function exactBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail("CONTRACT_INVALID", `${label} must be boolean`);
  }
  return value;
}

function nullableSafeCount(value, label) {
  if (value === null) return null;
  return safeCount(value, label);
}

function parseJsonObject(raw) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") < 2 ||
    Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES
  ) {
    fail("CAPTURE_INVALID", "capture has an invalid size");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("CAPTURE_INVALID", "capture is not valid JSON");
  }
  if (!isRecord(value)) fail("CAPTURE_INVALID", "capture must be an object");
  return value;
}

export function parseApi31CompatCapture(raw) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") < 2 ||
    Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES
  ) {
    fail("CAPTURE_INVALID", "capture has an invalid size");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("CAPTURE_INVALID", "capture is not valid JSON");
  }
  exactKeys(value, ["schemaVersion", "source", "product", "profile", "controls"], "capture");
  exactValue(value.schemaVersion, 1, "capture.schemaVersion");
  exactValue(value.source, INPUT_SOURCE, "capture.source");
  exactValue(value.product, "V5BT", "capture.product");
  exactKeys(
    value.profile,
    [
      "applicationId",
      "versionName",
      "versionCode",
      "androidApi",
      "partialNonGateBuild",
      "api31CompatNonGateBuild",
      "discoveryProfile",
      "discoveryMinimumAndroidApi",
      "formalGateEligible",
      "enrollmentTransport",
      "enrollmentEndpointPath",
      "enrollmentSpkiPinned",
      "endpointEvidence"
    ],
    "capture.profile"
  );
  const profile = value.profile;
  exactValue(profile.applicationId, API31_COMPAT_PACKAGE_ID, "profile.applicationId");
  exactValue(profile.versionName, API31_COMPAT_VERSION_NAME, "profile.versionName");
  exactValue(profile.versionCode, API31_COMPAT_VERSION_CODE, "profile.versionCode");
  if (!Number.isSafeInteger(profile.androidApi) || profile.androidApi < 31) {
    fail("CONTRACT_INVALID", "profile.androidApi is below the compatibility floor");
  }
  exactValue(profile.partialNonGateBuild, true, "profile.partialNonGateBuild");
  exactValue(
    profile.api31CompatNonGateBuild,
    true,
    "profile.api31CompatNonGateBuild"
  );
  exactValue(profile.discoveryProfile, PROFILE, "profile.discoveryProfile");
  exactValue(
    profile.discoveryMinimumAndroidApi,
    API31_COMPAT_DISCOVERY_MIN_ANDROID_API,
    "profile.discoveryMinimumAndroidApi"
  );
  exactValue(profile.formalGateEligible, false, "profile.formalGateEligible");
  exactValue(profile.enrollmentTransport, "HTTPS_PINNED_V2", "profile.enrollmentTransport");
  exactValue(profile.enrollmentEndpointPath, "/v2/enroll", "profile.enrollmentEndpointPath");
  exactValue(profile.enrollmentSpkiPinned, true, "profile.enrollmentSpkiPinned");
  exactValue(profile.endpointEvidence, ENDPOINT_EVIDENCE, "profile.endpointEvidence");

  return deepFreeze({
    schemaVersion: 1,
    source: INPUT_SOURCE,
    product: "V5BT",
    profile: {
      applicationId: API31_COMPAT_PACKAGE_ID,
      versionName: API31_COMPAT_VERSION_NAME,
      versionCode: API31_COMPAT_VERSION_CODE,
      androidApi: profile.androidApi,
      partialNonGateBuild: true,
      api31CompatNonGateBuild: true,
      discoveryProfile: PROFILE,
      discoveryMinimumAndroidApi: API31_COMPAT_DISCOVERY_MIN_ANDROID_API,
      formalGateEligible: false,
      enrollmentTransport: "HTTPS_PINNED_V2",
      enrollmentEndpointPath: "/v2/enroll",
      enrollmentSpkiPinned: true,
      endpointEvidence: ENDPOINT_EVIDENCE
    },
    controls: normalizeControls(value.controls)
  });
}

function normalizePhysicalProfile(profile) {
  exactKeys(
    profile,
    [
      "applicationId",
      "versionName",
      "versionCode",
      "androidApi",
      "partialNonGateBuild",
      "api31CompatNonGateBuild",
      "discoveryProfile",
      "discoveryMinimumAndroidApi",
      "formalGateEligible"
    ],
    "physical.profile"
  );
  for (const [field, expected] of Object.entries({
    applicationId: API31_COMPAT_PACKAGE_ID,
    versionName: API31_COMPAT_VERSION_NAME,
    versionCode: API31_COMPAT_VERSION_CODE,
    androidApi: 31,
    partialNonGateBuild: true,
    api31CompatNonGateBuild: true,
    discoveryProfile: PROFILE,
    discoveryMinimumAndroidApi: API31_COMPAT_DISCOVERY_MIN_ANDROID_API,
    formalGateEligible: false
  })) exactValue(profile[field], expected, `physical.profile.${field}`);
  return structuredClone(profile);
}

function normalizePhysicalEnrollment(enrollment) {
  exactKeys(
    enrollment,
    [
      "protocolVersion",
      "state",
      "publicKeyAlgorithm",
      "proofAlgorithm",
      "transport",
      "evidence",
      "stagingRegistryAccepted"
    ],
    "physical.enrollment"
  );
  for (const [field, expected] of Object.entries({
    protocolVersion: 2,
    state: "READY",
    publicKeyAlgorithm: "EC-P256",
    proofAlgorithm: "ECDSA-P256-SHA256-P1363",
    transport: "HTTPS_PINNED_V2",
    evidence: PHYSICAL_ENROLLMENT_EVIDENCE,
    stagingRegistryAccepted: true
  })) exactValue(enrollment[field], expected, `physical.enrollment.${field}`);
  return structuredClone(enrollment);
}

function normalizePhysicalBluetooth(bluetooth) {
  exactKeys(
    bluetooth,
    [
      "rawCallbacks",
      "uuidMatches",
      "validObservations",
      "invalidPayloads",
      "scanFailures",
      "advertisementStarts",
      "advertisementFailures",
      "capabilities",
      "runtime"
    ],
    "physical.bluetooth"
  );
  const normalized = {
    rawCallbacks: safeCount(bluetooth.rawCallbacks, "bluetooth.rawCallbacks"),
    uuidMatches: safeCount(bluetooth.uuidMatches, "bluetooth.uuidMatches"),
    validObservations: safeCount(
      bluetooth.validObservations,
      "bluetooth.validObservations"
    ),
    invalidPayloads: safeCount(bluetooth.invalidPayloads, "bluetooth.invalidPayloads"),
    scanFailures: safeCount(bluetooth.scanFailures, "bluetooth.scanFailures"),
    advertisementStarts: safeCount(
      bluetooth.advertisementStarts,
      "bluetooth.advertisementStarts"
    ),
    advertisementFailures: safeCount(
      bluetooth.advertisementFailures,
      "bluetooth.advertisementFailures"
    )
  };
  if (
    normalized.uuidMatches > normalized.rawCallbacks ||
    normalized.validObservations > normalized.uuidMatches ||
    normalized.validObservations + normalized.invalidPayloads > normalized.uuidMatches
  ) {
    fail("CONTRACT_INVALID", "Bluetooth observation counters are inconsistent");
  }

  exactKeys(
    bluetooth.capabilities,
    ["scan", "advertise", "gattClient", "gattServer"],
    "physical.bluetooth.capabilities"
  );
  normalized.capabilities = Object.fromEntries(
    ["scan", "advertise", "gattClient", "gattServer"].map((field) => [
      field,
      exactBoolean(bluetooth.capabilities[field], `bluetooth.capabilities.${field}`)
    ])
  );

  exactKeys(
    bluetooth.runtime,
    [
      "scannerActiveObserved",
      "advertiserActiveObserved",
      "gattClientEnabled",
      "gattClientAttempts",
      "gattClientConnections",
      "gattClientErrors",
      "gattServerEnabled",
      "gattServerActiveObserved",
      "gattServerConnections",
      "gattServerErrors"
    ],
    "physical.bluetooth.runtime"
  );
  normalized.runtime = {
    scannerActiveObserved: exactBoolean(
      bluetooth.runtime.scannerActiveObserved,
      "bluetooth.runtime.scannerActiveObserved"
    ),
    advertiserActiveObserved: exactBoolean(
      bluetooth.runtime.advertiserActiveObserved,
      "bluetooth.runtime.advertiserActiveObserved"
    ),
    gattClientEnabled: exactBoolean(
      bluetooth.runtime.gattClientEnabled,
      "bluetooth.runtime.gattClientEnabled"
    ),
    gattClientAttempts: safeCount(
      bluetooth.runtime.gattClientAttempts,
      "bluetooth.runtime.gattClientAttempts"
    ),
    gattClientConnections: safeCount(
      bluetooth.runtime.gattClientConnections,
      "bluetooth.runtime.gattClientConnections"
    ),
    gattClientErrors: safeCount(
      bluetooth.runtime.gattClientErrors,
      "bluetooth.runtime.gattClientErrors"
    ),
    gattServerEnabled: exactBoolean(
      bluetooth.runtime.gattServerEnabled,
      "bluetooth.runtime.gattServerEnabled"
    ),
    gattServerActiveObserved: exactBoolean(
      bluetooth.runtime.gattServerActiveObserved,
      "bluetooth.runtime.gattServerActiveObserved"
    ),
    gattServerConnections: safeCount(
      bluetooth.runtime.gattServerConnections,
      "bluetooth.runtime.gattServerConnections"
    ),
    gattServerErrors: safeCount(
      bluetooth.runtime.gattServerErrors,
      "bluetooth.runtime.gattServerErrors"
    )
  };
  if (
    normalized.runtime.gattClientConnections > normalized.runtime.gattClientAttempts ||
    normalized.runtime.gattClientErrors > normalized.runtime.gattClientAttempts ||
    (!normalized.runtime.gattClientEnabled &&
      (normalized.runtime.gattClientAttempts > 0 ||
        normalized.runtime.gattClientConnections > 0)) ||
    (!normalized.runtime.gattServerEnabled &&
      (normalized.runtime.gattServerActiveObserved ||
        normalized.runtime.gattServerConnections > 0))
  ) {
    fail("CONTRACT_INVALID", "Bluetooth runtime counters are inconsistent");
  }
  return normalized;
}

function normalizePhysicalConcurrency(concurrency) {
  exactKeys(
    concurrency,
    ["scanAdvertiseWindows", "validObservationsDuringWindows"],
    "physical.concurrency"
  );
  return {
    scanAdvertiseWindows: safeCount(
      concurrency.scanAdvertiseWindows,
      "concurrency.scanAdvertiseWindows"
    ),
    validObservationsDuringWindows: safeCount(
      concurrency.validObservationsDuringWindows,
      "concurrency.validObservationsDuringWindows"
    )
  };
}

function normalizePhysicalWifi(wifi) {
  exactKeys(
    wifi,
    ["healthProbeCount", "successfulHealthProbeCount", "bluetoothActiveProbeCount"],
    "physical.wifiBleCoexistence"
  );
  const normalized = {
    healthProbeCount: safeCount(wifi.healthProbeCount, "wifi.healthProbeCount"),
    successfulHealthProbeCount: safeCount(
      wifi.successfulHealthProbeCount,
      "wifi.successfulHealthProbeCount"
    ),
    bluetoothActiveProbeCount: safeCount(
      wifi.bluetoothActiveProbeCount,
      "wifi.bluetoothActiveProbeCount"
    )
  };
  if (
    normalized.successfulHealthProbeCount > normalized.healthProbeCount ||
    normalized.bluetoothActiveProbeCount > normalized.healthProbeCount
  ) {
    fail("CONTRACT_INVALID", "Wi-Fi/BLE aggregate counters are inconsistent");
  }
  return normalized;
}

function normalizePhysicalForegroundBackground(observation) {
  exactKeys(
    observation,
    [
      "backgroundDurationMs",
      "reporterSamplesBefore",
      "reporterSamplesAfter",
      "scannerActiveThroughout",
      "advertiserActiveThroughout",
      "foregroundRestored"
    ],
    "physical.foregroundBackground"
  );
  const normalized = {
    backgroundDurationMs: safeCount(
      observation.backgroundDurationMs,
      "foregroundBackground.backgroundDurationMs"
    ),
    reporterSamplesBefore: safeCount(
      observation.reporterSamplesBefore,
      "foregroundBackground.reporterSamplesBefore"
    ),
    reporterSamplesAfter: safeCount(
      observation.reporterSamplesAfter,
      "foregroundBackground.reporterSamplesAfter"
    ),
    scannerActiveThroughout: exactBoolean(
      observation.scannerActiveThroughout,
      "foregroundBackground.scannerActiveThroughout"
    ),
    advertiserActiveThroughout: exactBoolean(
      observation.advertiserActiveThroughout,
      "foregroundBackground.advertiserActiveThroughout"
    ),
    foregroundRestored: exactBoolean(
      observation.foregroundRestored,
      "foregroundBackground.foregroundRestored"
    )
  };
  if (normalized.reporterSamplesAfter < normalized.reporterSamplesBefore) {
    fail("CONTRACT_INVALID", "foreground/background reporter counters regressed");
  }
  return normalized;
}

function normalizeContinuityBase(value, label, faultFields) {
  exactKeys(
    value,
    [
      "sampleCount",
      "durationMs",
      "expectedPollingIntervalMs",
      "maxAllowedGapMs",
      "maxObservedGapMs",
      ...faultFields
    ],
    label
  );
  const normalized = {
    sampleCount: safeCount(value.sampleCount, `${label}.sampleCount`),
    durationMs: safeCount(value.durationMs, `${label}.durationMs`),
    expectedPollingIntervalMs: value.expectedPollingIntervalMs,
    maxAllowedGapMs: value.maxAllowedGapMs,
    maxObservedGapMs: safeCount(value.maxObservedGapMs, `${label}.maxObservedGapMs`)
  };
  exactValue(
    normalized.expectedPollingIntervalMs,
    API31_COMPAT_CONTINUITY_POLL_INTERVAL_MS,
    `${label}.expectedPollingIntervalMs`
  );
  exactValue(
    normalized.maxAllowedGapMs,
    API31_COMPAT_CONTINUITY_MAX_GAP_MS,
    `${label}.maxAllowedGapMs`
  );
  for (const field of faultFields) {
    normalized[field] = safeCount(value[field], `${label}.${field}`);
  }
  if (
    (normalized.sampleCount === 0 &&
      (normalized.durationMs !== 0 || normalized.maxObservedGapMs !== 0)) ||
    (normalized.sampleCount === 1 && normalized.durationMs !== 0) ||
    (normalized.sampleCount >= 2 && normalized.durationMs === 0) ||
    normalized.maxObservedGapMs > normalized.durationMs
  ) {
    fail("CONTRACT_INVALID", `${label} timing aggregates are inconsistent`);
  }
  return normalized;
}

const ANDROID_CONTINUITY_FAULTS = Object.freeze([
  "processRestarts",
  "crashes",
  "anrs",
  "logouts",
  "reporterRestarts",
  "identityChanges",
  "versionChanges"
]);
const RASPBERRY_CONTINUITY_FAULTS = Object.freeze([
  "bootChanges",
  "clockRegressions",
  "mainServiceRestarts",
  "bluetoothServiceRestarts",
  "mainServiceFailures",
  "bluetoothServiceFailures"
]);
const STAGING_CONTINUITY_FAULTS = Object.freeze([
  "serviceRestarts",
  "healthFailures",
  "protocolV2UnavailableSamples",
  "registryIntegrityFailures"
]);

function normalizePhysicalContinuity(continuity) {
  exactKeys(continuity, ["android", "raspberry", "staging"], "physical.continuity");
  return {
    android: normalizeContinuityBase(
      continuity.android,
      "continuity.android",
      ANDROID_CONTINUITY_FAULTS
    ),
    raspberry: normalizeContinuityBase(
      continuity.raspberry,
      "continuity.raspberry",
      RASPBERRY_CONTINUITY_FAULTS
    ),
    staging: normalizeContinuityBase(
      continuity.staging,
      "continuity.staging",
      STAGING_CONTINUITY_FAULTS
    )
  };
}

function normalizePhysicalBattery(battery) {
  exactKeys(
    battery,
    [
      "configuredIntervalMs",
      "observationDurationMs",
      "observedNotificationCount",
      "minimumObservedIntervalMs",
      "maximumObservedIntervalMs"
    ],
    "physical.battery"
  );
  exactValue(
    battery.configuredIntervalMs,
    API31_COMPAT_BATTERY_INTERVAL_MS,
    "battery.configuredIntervalMs"
  );
  const normalized = {
    configuredIntervalMs: API31_COMPAT_BATTERY_INTERVAL_MS,
    observationDurationMs: safeCount(
      battery.observationDurationMs,
      "battery.observationDurationMs"
    ),
    observedNotificationCount: safeCount(
      battery.observedNotificationCount,
      "battery.observedNotificationCount"
    ),
    minimumObservedIntervalMs: nullableSafeCount(
      battery.minimumObservedIntervalMs,
      "battery.minimumObservedIntervalMs"
    ),
    maximumObservedIntervalMs: nullableSafeCount(
      battery.maximumObservedIntervalMs,
      "battery.maximumObservedIntervalMs"
    )
  };
  const hasIntervals = normalized.observedNotificationCount >= 2;
  if (
    (hasIntervals &&
      (normalized.minimumObservedIntervalMs === null ||
        normalized.maximumObservedIntervalMs === null)) ||
    (!hasIntervals &&
      (normalized.minimumObservedIntervalMs !== null ||
        normalized.maximumObservedIntervalMs !== null)) ||
    (hasIntervals &&
      (normalized.minimumObservedIntervalMs > normalized.maximumObservedIntervalMs ||
        normalized.maximumObservedIntervalMs > normalized.observationDurationMs)) ||
    normalized.observedNotificationCount >
      Math.floor(
        normalized.observationDurationMs / API31_COMPAT_BATTERY_INTERVAL_MS
      ) + 1
  ) {
    fail("CONTRACT_INVALID", "battery observation aggregates are inconsistent");
  }
  return normalized;
}

function normalizePhysicalEvidence(evidence) {
  exactKeys(
    evidence,
    [
      "bluetooth",
      "concurrency",
      "wifiBleCoexistence",
      "foregroundBackground",
      "continuity",
      "battery"
    ],
    "physical.evidence"
  );
  const normalized = {
    bluetooth: normalizePhysicalBluetooth(evidence.bluetooth),
    concurrency: normalizePhysicalConcurrency(evidence.concurrency),
    wifiBleCoexistence: normalizePhysicalWifi(evidence.wifiBleCoexistence),
    foregroundBackground: normalizePhysicalForegroundBackground(
      evidence.foregroundBackground
    ),
    continuity: normalizePhysicalContinuity(evidence.continuity),
    battery: normalizePhysicalBattery(evidence.battery)
  };
  if (
    normalized.concurrency.validObservationsDuringWindows >
    normalized.bluetooth.validObservations
  ) {
    fail("CONTRACT_INVALID", "concurrent observations exceed total observations");
  }
  return normalized;
}

export function parseApi31CompatPhysicalCapture(raw) {
  const value = parseJsonObject(raw);
  exactKeys(
    value,
    [
      "schemaVersion",
      "source",
      "product",
      "captureClass",
      "profile",
      "enrollment",
      "evidence"
    ],
    "physical capture"
  );
  exactValue(value.schemaVersion, 2, "physical.schemaVersion");
  exactValue(value.source, INPUT_SOURCE, "physical.source");
  exactValue(value.product, "V5BT", "physical.product");
  exactValue(value.captureClass, PHYSICAL_CAPTURE_CLASS, "physical.captureClass");
  return deepFreeze({
    schemaVersion: 2,
    source: INPUT_SOURCE,
    product: "V5BT",
    captureClass: PHYSICAL_CAPTURE_CLASS,
    profile: normalizePhysicalProfile(value.profile),
    enrollment: normalizePhysicalEnrollment(value.enrollment),
    evidence: normalizePhysicalEvidence(value.evidence)
  });
}

function pendingGates() {
  return {
    b0DeviceCapabilityGate: "PENDING",
    b1EnrollmentGate: "PENDING",
    b2DiscoveryGate: "PENDING",
    b3SoakGate: "PENDING",
    b4TenPhysicalDeviceGate: "PENDING",
    b5HundredSessionGate: "PENDING",
    b6AndroidPairGate: "BLOCKED"
  };
}

export function buildApi31CompatNonGateReport(capture) {
  const normalized = parseApi31CompatCapture(JSON.stringify(capture));
  const passed = API31_COMPAT_CONTROLS.every(
    (control) => normalized.controls[control] === "PASS"
  );
  return normalizeApi31CompatNonGateReport({
    schemaVersion: 1,
    harnessVersion: API31_COMPAT_NON_GATE_RUNNER_VERSION,
    source: REPORT_SOURCE,
    product: "V5BT",
    phase: "API31_COMPAT_PRE_PHYSICAL",
    mode: "API31_COMPAT_TEST_CONFIGURATION_NON_GATE",
    evidenceClass: "NON_GATE_EVIDENCE",
    verdict: passed ? "NON_GATE_PASS" : "NON_GATE_FAIL",
    gateImpact: "NONE",
    profile: {
      applicationId: API31_COMPAT_PACKAGE_ID,
      versionName: API31_COMPAT_VERSION_NAME,
      versionCode: API31_COMPAT_VERSION_CODE,
      minimumAndroidApi: API31_COMPAT_DISCOVERY_MIN_ANDROID_API,
      observedAndroidApi: normalized.profile.androidApi,
      marker: PROFILE,
      enrollmentTransport: "HTTPS_PINNED_V2",
      endpointEvidence: ENDPOINT_EVIDENCE,
      formalGateEligible: false
    },
    controls: normalized.controls,
    gates: pendingGates(),
    authorization: {
      acceptedAsFormalEvidence: false,
      officialCampaignAuthorized: false,
      reasonCode: "API31_COMPAT_TEST_CONFIGURATION_NOT_PHYSICAL"
    },
    effects: {
      authoritativeGateExecuted: false,
      gatePromoted: false,
      roadmapStatusChanged: false
    },
    privacy: {
      adbSerialIncluded: false,
      hardwareIdentifiersIncluded: false,
      enrollmentIdentityIncluded: false,
      networkIdentifiersIncluded: false,
      filesystemLocationsIncluded: false
    }
  });
}

function normalizeApi31CompatPrePhysicalReport(report) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "harnessVersion",
      "source",
      "product",
      "phase",
      "mode",
      "evidenceClass",
      "verdict",
      "gateImpact",
      "profile",
      "controls",
      "gates",
      "authorization",
      "effects",
      "privacy"
    ],
    "report"
  );
  for (const [field, expected] of Object.entries({
    schemaVersion: 1,
    harnessVersion: API31_COMPAT_NON_GATE_RUNNER_VERSION,
    source: REPORT_SOURCE,
    product: "V5BT",
    phase: "API31_COMPAT_PRE_PHYSICAL",
    mode: "API31_COMPAT_TEST_CONFIGURATION_NON_GATE",
    evidenceClass: "NON_GATE_EVIDENCE",
    gateImpact: "NONE"
  })) exactValue(report[field], expected, `report.${field}`);
  if (!new Set(["NON_GATE_PASS", "NON_GATE_FAIL"]).has(report.verdict)) {
    fail("CONTRACT_INVALID", "report.verdict is invalid");
  }

  exactKeys(
    report.profile,
    [
      "applicationId",
      "versionName",
      "versionCode",
      "minimumAndroidApi",
      "observedAndroidApi",
      "marker",
      "enrollmentTransport",
      "endpointEvidence",
      "formalGateEligible"
    ],
    "report.profile"
  );
  for (const [field, expected] of Object.entries({
    applicationId: API31_COMPAT_PACKAGE_ID,
    versionName: API31_COMPAT_VERSION_NAME,
    versionCode: API31_COMPAT_VERSION_CODE,
    minimumAndroidApi: API31_COMPAT_DISCOVERY_MIN_ANDROID_API,
    marker: PROFILE,
    enrollmentTransport: "HTTPS_PINNED_V2",
    endpointEvidence: ENDPOINT_EVIDENCE,
    formalGateEligible: false
  })) exactValue(report.profile[field], expected, `report.profile.${field}`);
  if (
    !Number.isSafeInteger(report.profile.observedAndroidApi) ||
    report.profile.observedAndroidApi < 31
  ) {
    fail("CONTRACT_INVALID", "report.profile.observedAndroidApi is invalid");
  }

  const controls = normalizeControls(report.controls);
  const allPassed = API31_COMPAT_CONTROLS.every(
    (control) => controls[control] === "PASS"
  );
  exactValue(
    report.verdict,
    allPassed ? "NON_GATE_PASS" : "NON_GATE_FAIL",
    "report.verdict"
  );

  const gates = pendingGates();
  exactKeys(report.gates, Object.keys(gates), "report.gates");
  for (const [field, expected] of Object.entries(gates)) {
    exactValue(report.gates[field], expected, `report.gates.${field}`);
  }

  exactKeys(
    report.authorization,
    ["acceptedAsFormalEvidence", "officialCampaignAuthorized", "reasonCode"],
    "report.authorization"
  );
  exactValue(report.authorization.acceptedAsFormalEvidence, false, "authorization.acceptedAsFormalEvidence");
  exactValue(report.authorization.officialCampaignAuthorized, false, "authorization.officialCampaignAuthorized");
  exactValue(
    report.authorization.reasonCode,
    "API31_COMPAT_TEST_CONFIGURATION_NOT_PHYSICAL",
    "authorization.reasonCode"
  );

  exactKeys(
    report.effects,
    ["authoritativeGateExecuted", "gatePromoted", "roadmapStatusChanged"],
    "report.effects"
  );
  for (const field of Object.keys(report.effects)) {
    exactValue(report.effects[field], false, `report.effects.${field}`);
  }

  exactKeys(
    report.privacy,
    [
      "adbSerialIncluded",
      "hardwareIdentifiersIncluded",
      "enrollmentIdentityIncluded",
      "networkIdentifiersIncluded",
      "filesystemLocationsIncluded"
    ],
    "report.privacy"
  );
  for (const field of Object.keys(report.privacy)) {
    exactValue(report.privacy[field], false, `report.privacy.${field}`);
  }

  return deepFreeze(structuredClone(report));
}

function executionStatus(executed, passed) {
  return executed ? (passed ? "PASS" : "FAIL") : "NOT_RUN";
}

function continuityStatus(observation, faultFields) {
  const executed = observation.sampleCount > 0;
  const passed =
    observation.sampleCount >= 2 &&
    observation.durationMs > 0 &&
    observation.maxObservedGapMs <= observation.maxAllowedGapMs &&
    faultFields.every((field) => observation[field] === 0);
  return executionStatus(executed, passed);
}

function batteryObservationClaim(battery) {
  if (battery.observedNotificationCount < 2) return "INTERVAL_NOT_ATTESTED";
  return battery.minimumObservedIntervalMs >= API31_COMPAT_BATTERY_INTERVAL_MS
    ? "INTERVAL_OBSERVED"
    : "INTERVAL_VIOLATION";
}

function derivePhysicalControls(capture) {
  const { bluetooth, concurrency, wifiBleCoexistence, foregroundBackground } =
    capture.evidence;
  const { runtime, capabilities } = bluetooth;
  const controls = {
    enrollmentV2: "PASS",
    scanCapability: capabilities.scan ? "PASS" : "FAIL",
    scanRuntime: executionStatus(
      runtime.scannerActiveObserved || bluetooth.rawCallbacks > 0 || bluetooth.scanFailures > 0,
      runtime.scannerActiveObserved &&
        bluetooth.rawCallbacks > 0 &&
        bluetooth.uuidMatches > 0 &&
        bluetooth.validObservations > 0 &&
        bluetooth.scanFailures === 0
    ),
    advertiseCapability: capabilities.advertise ? "PASS" : "FAIL",
    advertiseRuntime: executionStatus(
      runtime.advertiserActiveObserved ||
        bluetooth.advertisementStarts > 0 ||
        bluetooth.advertisementFailures > 0,
      runtime.advertiserActiveObserved &&
        bluetooth.advertisementStarts > 0 &&
        bluetooth.advertisementFailures === 0
    ),
    gattClientCapability: capabilities.gattClient ? "PASS" : "FAIL",
    gattClientRuntime: executionStatus(
      runtime.gattClientAttempts > 0,
      runtime.gattClientEnabled &&
        runtime.gattClientConnections > 0 &&
        runtime.gattClientErrors === 0
    ),
    gattServerCapability: capabilities.gattServer ? "PASS" : "FAIL",
    gattServerRuntime: executionStatus(
      runtime.gattServerEnabled ||
        runtime.gattServerActiveObserved ||
        runtime.gattServerConnections > 0 ||
        runtime.gattServerErrors > 0,
      runtime.gattServerEnabled &&
        runtime.gattServerActiveObserved &&
        runtime.gattServerErrors === 0
    ),
    scanAdvertiseConcurrent: executionStatus(
      concurrency.scanAdvertiseWindows > 0,
      concurrency.validObservationsDuringWindows > 0 &&
        runtime.scannerActiveObserved &&
        runtime.advertiserActiveObserved
    ),
    wifiBleCoexistence: executionStatus(
      wifiBleCoexistence.healthProbeCount > 0,
      wifiBleCoexistence.successfulHealthProbeCount ===
        wifiBleCoexistence.healthProbeCount &&
        wifiBleCoexistence.bluetoothActiveProbeCount ===
          wifiBleCoexistence.healthProbeCount
    ),
    backgroundForeground: executionStatus(
      foregroundBackground.backgroundDurationMs > 0,
      foregroundBackground.reporterSamplesAfter >
        foregroundBackground.reporterSamplesBefore &&
        foregroundBackground.scannerActiveThroughout &&
        foregroundBackground.advertiserActiveThroughout &&
        foregroundBackground.foregroundRestored
    ),
    androidContinuity: continuityStatus(
      capture.evidence.continuity.android,
      ANDROID_CONTINUITY_FAULTS
    ),
    raspberryContinuity: continuityStatus(
      capture.evidence.continuity.raspberry,
      RASPBERRY_CONTINUITY_FAULTS
    ),
    stagingContinuity: continuityStatus(
      capture.evidence.continuity.staging,
      STAGING_CONTINUITY_FAULTS
    ),
    batteryCadence: executionStatus(
      capture.evidence.battery.observedNotificationCount >= 2,
      batteryObservationClaim(capture.evidence.battery) === "INTERVAL_OBSERVED"
    )
  };
  return Object.fromEntries(
    API31_COMPAT_PHYSICAL_CONTROLS.map((field) => [field, controls[field]])
  );
}

function physicalAssessments(capture, controls) {
  return {
    androidContinuityResult: controls.androidContinuity,
    raspberryContinuityResult: controls.raspberryContinuity,
    stagingContinuityResult: controls.stagingContinuity,
    batteryObservationClaim: batteryObservationClaim(capture.evidence.battery)
  };
}

function validatePhysicalPrivacy(report) {
  const serialized = JSON.stringify(report);
  if (
    /(?:^|[^0-9a-f])(?:[0-9a-f]{2}:){5}[0-9a-f]{2}(?:$|[^0-9a-f])/iu.test(
      serialized
    ) ||
    /"(?:serial|mac|macAddress|nodeId|path|host|hostname|ipAddress)"\s*:/iu.test(
      serialized
    ) ||
    /"(?:\/[^"\n]*|[a-z][a-z0-9+.-]*:\/\/[^"\n]*)"/iu.test(serialized)
  ) {
    fail("PRIVACY_VIOLATION", "physical report is not aggregate-only");
  }
}

export function buildApi31CompatPhysicalReport(capture) {
  const normalized = parseApi31CompatPhysicalCapture(JSON.stringify(capture));
  const controls = derivePhysicalControls(normalized);
  const passed = API31_COMPAT_PHYSICAL_CONTROLS.every(
    (control) => controls[control] === "PASS"
  );
  return normalizeApi31CompatNonGateReport({
    schemaVersion: 2,
    harnessVersion: API31_COMPAT_PHYSICAL_REPORT_VERSION,
    source: REPORT_SOURCE,
    product: "V5BT",
    phase: "API31_COMPAT_PHYSICAL_DIAGNOSTIC",
    mode: PHYSICAL_CAPTURE_CLASS,
    evidenceClass: "NON_GATE_EVIDENCE",
    verdict: passed ? "NON_GATE_PASS" : "NON_GATE_FAIL",
    gateImpact: "NONE",
    officialProgressPercent: 49,
    profile: normalized.profile,
    enrollment: normalized.enrollment,
    evidence: normalized.evidence,
    assessments: physicalAssessments(normalized, controls),
    controls,
    gates: pendingGates(),
    authorization: {
      acceptedAsFormalEvidence: false,
      officialCampaignAuthorized: false,
      reasonCode: "API31_COMPAT_PHYSICAL_DIAGNOSTIC_NON_PROMOTABLE"
    },
    effects: {
      authoritativeGateExecuted: false,
      gatePromoted: false,
      roadmapStatusChanged: false
    },
    privacy: {
      aggregateOnly: true,
      privateIdentifiersIncluded: false,
      redactionValidated: true
    }
  });
}

function normalizeApi31CompatPhysicalReport(report) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "harnessVersion",
      "source",
      "product",
      "phase",
      "mode",
      "evidenceClass",
      "verdict",
      "gateImpact",
      "officialProgressPercent",
      "profile",
      "enrollment",
      "evidence",
      "assessments",
      "controls",
      "gates",
      "authorization",
      "effects",
      "privacy"
    ],
    "physical report"
  );
  for (const [field, expected] of Object.entries({
    schemaVersion: 2,
    harnessVersion: API31_COMPAT_PHYSICAL_REPORT_VERSION,
    source: REPORT_SOURCE,
    product: "V5BT",
    phase: "API31_COMPAT_PHYSICAL_DIAGNOSTIC",
    mode: PHYSICAL_CAPTURE_CLASS,
    evidenceClass: "NON_GATE_EVIDENCE",
    gateImpact: "NONE",
    officialProgressPercent: 49
  })) exactValue(report[field], expected, `physical report.${field}`);
  if (!new Set(["NON_GATE_PASS", "NON_GATE_FAIL"]).has(report.verdict)) {
    fail("CONTRACT_INVALID", "physical report.verdict is invalid");
  }

  const capture = deepFreeze({
    schemaVersion: 2,
    source: INPUT_SOURCE,
    product: "V5BT",
    captureClass: PHYSICAL_CAPTURE_CLASS,
    profile: normalizePhysicalProfile(report.profile),
    enrollment: normalizePhysicalEnrollment(report.enrollment),
    evidence: normalizePhysicalEvidence(report.evidence)
  });
  const controls = derivePhysicalControls(capture);
  exactKeys(report.controls, API31_COMPAT_PHYSICAL_CONTROLS, "physical report.controls");
  for (const field of API31_COMPAT_PHYSICAL_CONTROLS) {
    if (!STATUS_VALUES.has(report.controls[field])) {
      fail("CONTRACT_INVALID", `physical report.controls.${field} is invalid`);
    }
    exactValue(report.controls[field], controls[field], `physical report.controls.${field}`);
  }
  exactValue(
    report.verdict,
    API31_COMPAT_PHYSICAL_CONTROLS.every((field) => controls[field] === "PASS")
      ? "NON_GATE_PASS"
      : "NON_GATE_FAIL",
    "physical report.verdict"
  );

  const assessments = physicalAssessments(capture, controls);
  exactKeys(report.assessments, Object.keys(assessments), "physical report.assessments");
  for (const [field, expected] of Object.entries(assessments)) {
    exactValue(report.assessments[field], expected, `physical report.assessments.${field}`);
  }

  const gates = pendingGates();
  exactKeys(report.gates, Object.keys(gates), "physical report.gates");
  for (const [field, expected] of Object.entries(gates)) {
    exactValue(report.gates[field], expected, `physical report.gates.${field}`);
  }
  exactKeys(
    report.authorization,
    ["acceptedAsFormalEvidence", "officialCampaignAuthorized", "reasonCode"],
    "physical report.authorization"
  );
  exactValue(
    report.authorization.acceptedAsFormalEvidence,
    false,
    "physical report.authorization.acceptedAsFormalEvidence"
  );
  exactValue(
    report.authorization.officialCampaignAuthorized,
    false,
    "physical report.authorization.officialCampaignAuthorized"
  );
  exactValue(
    report.authorization.reasonCode,
    "API31_COMPAT_PHYSICAL_DIAGNOSTIC_NON_PROMOTABLE",
    "physical report.authorization.reasonCode"
  );
  exactKeys(
    report.effects,
    ["authoritativeGateExecuted", "gatePromoted", "roadmapStatusChanged"],
    "physical report.effects"
  );
  for (const field of Object.keys(report.effects)) {
    exactValue(report.effects[field], false, `physical report.effects.${field}`);
  }
  exactKeys(
    report.privacy,
    ["aggregateOnly", "privateIdentifiersIncluded", "redactionValidated"],
    "physical report.privacy"
  );
  exactValue(report.privacy.aggregateOnly, true, "physical report.privacy.aggregateOnly");
  exactValue(
    report.privacy.privateIdentifiersIncluded,
    false,
    "physical report.privacy.privateIdentifiersIncluded"
  );
  exactValue(
    report.privacy.redactionValidated,
    true,
    "physical report.privacy.redactionValidated"
  );
  validatePhysicalPrivacy(report);
  return deepFreeze(structuredClone(report));
}

export function normalizeApi31CompatNonGateReport(report) {
  if (
    isRecord(report) &&
    report.schemaVersion === 2 &&
    report.mode === PHYSICAL_CAPTURE_CLASS
  ) {
    return normalizeApi31CompatPhysicalReport(report);
  }
  return normalizeApi31CompatPrePhysicalReport(report);
}

function inspectRegularPrivateFile(filePath, maximumBytes, label) {
  const resolved = path.resolve(filePath);
  let status;
  try {
    status = fs.lstatSync(resolved);
  } catch {
    fail("FILE_INVALID", `${label} is unavailable`);
  }
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    fail("FILE_INVALID", `${label} must be a regular unlinked file`);
  }
  if (
    typeof process.getuid === "function" &&
    status.uid !== process.getuid()
  ) {
    fail("FILE_INVALID", `${label} must be owned by the current user`);
  }
  if (process.platform !== "win32" && (status.mode & 0o777) !== 0o600) {
    fail("FILE_INVALID", `${label} permissions must be 0600`);
  }
  if (status.size < 2 || status.size > maximumBytes) {
    fail("FILE_INVALID", `${label} has an invalid size`);
  }
  return resolved;
}

function readRegularPrivateFile(filePath, maximumBytes, label) {
  const resolved = inspectRegularPrivateFile(filePath, maximumBytes, label);
  const expected = fs.lstatSync(resolved);
  let descriptor;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size !== expected.size ||
      (process.platform !== "win32" && (opened.mode & 0o777) !== 0o600)
    ) {
      fail("FILE_INVALID", `${label} identity changed before it was read`);
    }
    const contents = fs.readFileSync(descriptor, "utf8");
    const afterRead = fs.fstatSync(descriptor);
    if (
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      afterRead.size !== opened.size ||
      afterRead.mtimeMs !== opened.mtimeMs ||
      afterRead.ctimeMs !== opened.ctimeMs
    ) {
      fail("FILE_INVALID", `${label} changed while it was read`);
    }
    return { resolved, contents };
  } catch (error) {
    if (error instanceof Api31CompatNonGateError) throw error;
    fail("FILE_INVALID", `${label} could not be read safely`);
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
  }
}

function writeReportExclusive(outputPath, report) {
  const resolved = path.resolve(outputPath);
  const directory = path.dirname(resolved);
  let directoryStatus;
  try {
    directoryStatus = fs.lstatSync(directory);
  } catch {
    fail("OUTPUT_INVALID", "output directory is unavailable");
  }
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    fail("OUTPUT_INVALID", "output directory is invalid");
  }
  if (fs.existsSync(resolved)) fail("OUTPUT_EXISTS", "output already exists");
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MAX_OUTPUT_BYTES) {
    fail("OUTPUT_INVALID", "report is too large");
  }
  let descriptor;
  let createdIdentity = null;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    );
    createdIdentity = fs.fstatSync(descriptor);
    if (
      !createdIdentity.isFile() ||
      createdIdentity.nlink !== 1 ||
      (
        typeof process.getuid === "function" &&
        createdIdentity.uid !== process.getuid()
      )
    ) {
      fail("OUTPUT_WRITE_FAILED", "new output identity is invalid");
    }
    fs.writeFileSync(descriptor, bytes, "utf8");
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const verification = inspectRegularPrivateFile(
      resolved,
      MAX_OUTPUT_BYTES,
      "output"
    );
    const finalIdentity = fs.lstatSync(verification);
    if (
      finalIdentity.dev !== createdIdentity.dev ||
      finalIdentity.ino !== createdIdentity.ino
    ) {
      fail("OUTPUT_WRITE_FAILED", "output identity changed during publication");
    }
    normalizeApi31CompatNonGateReport(
      JSON.parse(fs.readFileSync(verification, "utf8"))
    );
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    if (createdIdentity !== null) {
      let currentIdentity = null;
      try {
        currentIdentity = fs.lstatSync(resolved);
      } catch {}
      if (
        currentIdentity !== null &&
        currentIdentity.isFile() &&
        !currentIdentity.isSymbolicLink() &&
        currentIdentity.nlink === 1 &&
        currentIdentity.dev === createdIdentity.dev &&
        currentIdentity.ino === createdIdentity.ino
      ) {
        try {
          fs.rmSync(resolved);
        } catch {
          fail("OUTPUT_ROLLBACK_INCOMPLETE", "failed output could not be removed");
        }
      } else if (currentIdentity !== null) {
        fail("OUTPUT_ROLLBACK_INCOMPLETE", "failed output ownership changed");
      }
    }
    fail("OUTPUT_WRITE_FAILED", "report could not be written safely");
  }
}

export function runApi31CompatNonGate(inputPath, outputPath) {
  if (typeof inputPath !== "string" || typeof outputPath !== "string") {
    fail("INVALID_ARGUMENT", "input and output paths are required", 2);
  }
  const input = readRegularPrivateFile(inputPath, MAX_INPUT_BYTES, "capture");
  if (path.resolve(outputPath) === input.resolved) {
    fail("INVALID_ARGUMENT", "output cannot overwrite the capture", 2);
  }
  const raw = input.contents;
  const discriminator = parseJsonObject(raw);
  const report = discriminator.schemaVersion === 2
    ? buildApi31CompatPhysicalReport(parseApi31CompatPhysicalCapture(raw))
    : buildApi31CompatNonGateReport(parseApi31CompatCapture(raw));
  writeReportExclusive(outputPath, report);
  return report;
}

export function buildSelfTestCapture(status = "PASS") {
  return {
    schemaVersion: 1,
    source: INPUT_SOURCE,
    product: "V5BT",
    profile: {
      applicationId: API31_COMPAT_PACKAGE_ID,
      versionName: API31_COMPAT_VERSION_NAME,
      versionCode: API31_COMPAT_VERSION_CODE,
      androidApi: 31,
      partialNonGateBuild: true,
      api31CompatNonGateBuild: true,
      discoveryProfile: PROFILE,
      discoveryMinimumAndroidApi: API31_COMPAT_DISCOVERY_MIN_ANDROID_API,
      formalGateEligible: false,
      enrollmentTransport: "HTTPS_PINNED_V2",
      enrollmentEndpointPath: "/v2/enroll",
      enrollmentSpkiPinned: true,
      endpointEvidence: ENDPOINT_EVIDENCE
    },
    controls: Object.fromEntries(
      API31_COMPAT_CONTROLS.map((control) => [control, status])
    )
  };
}

export function runSelfTest() {
  const report = buildApi31CompatNonGateReport(buildSelfTestCapture());
  return (
    report.verdict === "NON_GATE_PASS" &&
    report.evidenceClass === "NON_GATE_EVIDENCE" &&
    report.gateImpact === "NONE" &&
    report.profile.formalGateEligible === false &&
    report.authorization.acceptedAsFormalEvidence === false &&
    report.effects.gatePromoted === false &&
    Object.values(report.gates).every((value) => value !== "PASS")
  );
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--self-test") {
    return { mode: "SELF_TEST", input: null, output: null };
  }
  if (argv.length !== 5 || argv[0] !== "--evaluate") {
    fail("INVALID_ARGUMENT", "invalid arguments", 2);
  }
  // Accept both documented option orders while rejecting duplicates.
  const options = { input: null, output: null };
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--input", "--output"]).has(name) || !value || options[name.slice(2)] !== null) {
      fail("INVALID_ARGUMENT", "invalid arguments", 2);
    }
    options[name.slice(2)] = value;
  }
  if (options.input === null || options.output === null) {
    fail("INVALID_ARGUMENT", "input and output are required", 2);
  }
  return { mode: "EVALUATE", ...options };
}

function usage() {
  return [
    "V5BT API 31 compatibility diagnostic (prephysical or physical, non-gate only)",
    "",
    "Usage:",
    "  node scripts/run-api31-compat-non-gate.mjs --evaluate --input CAPTURE.json --output REPORT.json",
    "  node scripts/run-api31-compat-non-gate.mjs --self-test"
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.mode === "SELF_TEST") {
      const passed = runSelfTest();
      process.stdout.write(
        `${JSON.stringify({
          source: REPORT_SOURCE,
          mode: "PREPHYSICAL_SELF_TEST",
          evidenceClass: "NON_GATE_EVIDENCE",
          gateImpact: "NONE",
          gatePromoted: false,
          selfTest: passed ? "PASS" : "FAIL"
        })}\n`
      );
      return passed ? 0 : 1;
    }
    const report = runApi31CompatNonGate(options.input, options.output);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const known = error instanceof Api31CompatNonGateError;
    process.stderr.write(
      `${JSON.stringify({
        source: REPORT_SOURCE,
        evidenceClass: "NON_GATE_EVIDENCE",
        gateImpact: "NONE",
        gatePromoted: false,
        error: known ? error.code : "UNEXPECTED_ERROR"
      })}\n${usage()}\n`
    );
    return known ? error.exitCode : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
