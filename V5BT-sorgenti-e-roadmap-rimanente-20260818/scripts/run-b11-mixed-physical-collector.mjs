#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  rm,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  consumePasswordEnvironmentVariable,
  createExecCommandRunner,
  parseBenchInventoryConfig,
  runBenchInventory
} from "./run-v5bt-bench-inventory.mjs";
import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from "../ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/scripts/advanced-certification-targets.mjs";

export const B11_MIXED_PHYSICAL_ATTESTATION_VERSION = "1.0.0";
export const B11_MIXED_PHYSICAL_ATTESTATION_MODE =
  "B11_MIXED_PHYSICAL_ATTESTATION";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SERIAL_PATTERN = /^[A-Za-z0-9._:~-]{1,160}$/u;
const STATION_SIGNING_POLICIES = new Set([
  "CERTIFIED_REQUIRED",
  "WAIVED_NON_GATE"
]);
const INVENTORY_STATUS = new Set(["COMPLETE", "INCOMPLETE"]);
const ENROLLMENT_ATTEMPTS = new Set([
  "IDLE", "BUSY", "INPUT_INVALID", "ENDPOINT_MISMATCH", "IDENTITY_FAILED",
  "CLIENT_FAILED", "IMPORT_FAILED", "READY", "ALREADY_PROVISIONED",
  "STORAGE_FAILED", "INTERRUPTED", "CLOSED"
]);
const LIMITATION_CODES = new Set([
  "UPS_DISCOVERY_UNAVAILABLE",
  "UPS_NO_DEVICES_DISCOVERED",
  "UPS_SERVICE_DISCOVERY_UNAVAILABLE"
]);
const ERROR_CODES = new Set(["TIMEOUT", "UNAVAILABLE", "REQUIRED_ROLE_MISSING"]);
const ERROR_PROBE_PATTERN = /^(?:adb\.devices|android\.roleCoverage|android\.[0-2]\.(?:user|api|package|apkPath|apkSha256|session|identity|enrollmentStatus)|raspberry\.(?:identity|bluez\.(?:show|version)|ntp|ups\.(?:discovery|services)|state\.stat|registry\.(?:stat|read)|transactions\.(?:stat|list)|tlsKey\.stat|tlsCert\.stat|environment\.stat))$/u;
const SERVICE_POLICIES = Object.freeze({
  "cassav5bt.service": Object.freeze({
    requirement: "OPERATIONAL_REQUIRED",
    expectedState: "LOADED_ACTIVE_ENABLED"
  }),
  "bluetooth.service": Object.freeze({
    requirement: "OPERATIONAL_REQUIRED",
    expectedState: "LOADED_ACTIVE_ENABLED"
  }),
  "cassav5bt-bluetooth-node.service": Object.freeze({
    requirement: "OBSERVE_ONLY",
    expectedState: "ANY_OBSERVED_STATE"
  }),
  "cassav5bt-bluetooth-enrollment.service": Object.freeze({
    requirement: "OBSERVE_ONLY",
    expectedState: "ANY_OBSERVED_STATE"
  })
});

export class B11MixedPhysicalCollectorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "B11MixedPhysicalCollectorError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new B11MixedPhysicalCollectorError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ARGUMENT", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail("INVALID_ARGUMENT", `${label} contains missing or unexpected fields`);
  }
}

function allowedKeys(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ARGUMENT", `${label} must be an object`);
  }
  const permitted = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !permitted.has(key));
  if (unexpected !== undefined) {
    fail("INVALID_ARGUMENT", `${label} contains unexpected field ${unexpected}`);
  }
}

function isBoolean(value) {
  return value === true || value === false;
}

function canonicalIso(value) {
  if (typeof value !== "string") return false;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === value;
}

function safeIntegerBetween(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function assertBooleanFields(value, fields, label) {
  for (const field of fields) {
    if (!isBoolean(value[field])) {
      fail("REDACTION_INVALID", `${label}.${field} must be boolean`);
    }
  }
}

function assertInventoryShape(summary) {
  exactKeys(summary, [
    "schemaVersion", "product", "certificationMatrixSha256", "mode",
    "generatedAt", "status", "readOnly", "commandPolicy", "limitations",
    "redaction", "roleCoverage", "adb", "android", "raspberry", "errors"
  ], "inventory");
  exactKeys(summary.commandPolicy, [
    "shell", "mutationAllowed", "upsMode", "fixedAllowlist",
    "sshAuthentication", "sudoReadOnly", "passwordRecorded"
  ], "inventory.commandPolicy");
  exactKeys(summary.redaction, [
    "serialsExcluded", "networkIdentifiersExcluded",
    "registryIdentifiersExcluded", "rawCommandOutputExcluded"
  ], "inventory.redaction");
  exactKeys(summary.roleCoverage, [
    "requiredRoles", "configuredRoles", "missingRequiredRoles", "complete"
  ], "inventory.roleCoverage");
  exactKeys(summary.adb, [
    "probeAvailable", "expectedTargets", "connectedDevices",
    "unavailableDevices", "unexpectedConnectedDevices"
  ], "inventory.adb");
  if (!Array.isArray(summary.android) || summary.android.length !== 3) {
    fail("PHYSICAL_ROLE_COUNT_INVALID", "inventory must contain three Android targets");
  }
  for (const [index, entry] of summary.android.entries()) {
    exactKeys(entry, [
      "role", "connected", "androidUserMatches", "androidApi",
      "packageInstalled", "packageStopped", "versionName", "versionCode",
      "versionNameMatches", "versionCodeMatches", "apkSha256Matches",
      "expectedSigningCertificateSha256",
      "signingCertificatePinCoveredByCertifiedApk", "permissionsGranted",
      "authenticatedSession", "sessionIdentityDistinct", "enrollmentReady",
      "enrollmentIdentityDistinct", "registryBindingMatches",
      "enrollmentAttempt"
    ], `inventory.android[${index}]`);
  }
  exactKeys(summary.raspberry, [
    "reachable", "architecture", "bluez", "ntpSynchronized", "ups",
    "services", "registry", "enrollmentTransactions", "permissionsSecure"
  ], "inventory.raspberry");
  exactKeys(summary.raspberry.bluez, [
    "available", "version", "powered", "discovering"
  ], "inventory.raspberry.bluez");
  exactKeys(summary.raspberry.ups, [
    "discoveryOnly", "probeAvailable", "discoveredDevices",
    "serviceProbeAvailable", "serviceUnitsObserved"
  ], "inventory.raspberry.ups");
  exactKeys(summary.raspberry.enrollmentTransactions, [
    "files", "allPrivate"
  ], "inventory.raspberry.enrollmentTransactions");
  if (summary.raspberry.registry !== null) {
    exactKeys(summary.raspberry.registry, [
      "devices", "activeDevices", "revokedDevices", "enrollmentTokens",
      "pendingTokens"
    ], "inventory.raspberry.registry");
  }
}

function sanitizeAndValidateInventory(summary) {
  assertInventoryShape(summary);
  if (
    summary.schemaVersion !== 1 ||
    summary.product !== "V5BT" ||
    summary.certificationMatrixSha256 !==
      ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256 ||
    summary.mode !== "REDACTED_READ_ONLY_BENCH_INVENTORY" ||
    !canonicalIso(summary.generatedAt) ||
    !INVENTORY_STATUS.has(summary.status) ||
    summary.readOnly !== true
  ) {
    fail("REDACTION_INVALID", "inventory provenance is invalid");
  }
  const commandPolicy = summary.commandPolicy;
  assertBooleanFields(commandPolicy, [
    "shell", "mutationAllowed", "fixedAllowlist", "sudoReadOnly",
    "passwordRecorded"
  ], "inventory.commandPolicy");
  if (
    commandPolicy.shell !== false ||
    commandPolicy.mutationAllowed !== false ||
    commandPolicy.upsMode !== "DISCOVERY_ONLY" ||
    commandPolicy.fixedAllowlist !== true ||
    !new Set(["PUBLIC_KEY", "PASSWORD"]).has(commandPolicy.sshAuthentication) ||
    commandPolicy.passwordRecorded !== false
  ) {
    fail("REDACTION_INVALID", "inventory command policy is invalid");
  }
  assertBooleanFields(summary.redaction, [
    "serialsExcluded", "networkIdentifiersExcluded",
    "registryIdentifiersExcluded", "rawCommandOutputExcluded"
  ], "inventory.redaction");
  if (Object.values(summary.redaction).some((value) => value !== true)) {
    fail("REDACTION_INVALID", "inventory redaction declarations are incomplete");
  }
  if (
    JSON.stringify(summary.roleCoverage.requiredRoles) !==
      JSON.stringify(["handheld", "station"]) ||
    JSON.stringify(summary.roleCoverage.configuredRoles) !==
      JSON.stringify(["handheld", "station"]) ||
    !Array.isArray(summary.roleCoverage.missingRequiredRoles) ||
    summary.roleCoverage.missingRequiredRoles.length !== 0 ||
    summary.roleCoverage.complete !== true
  ) {
    fail("PHYSICAL_ROLE_COUNT_INVALID", "inventory role coverage is not canonical");
  }
  assertBooleanFields(summary.adb, ["probeAvailable"], "inventory.adb");
  if (
    summary.adb.expectedTargets !== 3 ||
    !safeIntegerBetween(summary.adb.connectedDevices, 0, 32) ||
    !safeIntegerBetween(summary.adb.unavailableDevices, 0, 32) ||
    !safeIntegerBetween(summary.adb.unexpectedConnectedDevices, 0, 32) ||
    summary.adb.unexpectedConnectedDevices > summary.adb.connectedDevices ||
    (summary.adb.probeAvailable === false &&
      (summary.adb.connectedDevices !== 0 ||
        summary.adb.unavailableDevices !== 0 ||
        summary.adb.unexpectedConnectedDevices !== 0))
  ) {
    fail("REDACTION_INVALID", "inventory ADB counters are invalid");
  }

  const roles = summary.android.map((entry) => entry.role);
  if (JSON.stringify(roles) !== JSON.stringify(["handheld", "handheld", "station"])) {
    fail("PHYSICAL_ROLE_COUNT_INVALID", "Android roles must be handheld, handheld, station");
  }
  const sanitizedAndroid = summary.android.map((entry, index) => {
    const label = `inventory.android[${index}]`;
    const target = ADVANCED_CERTIFICATION_TARGETS.roles[entry.role];
    assertBooleanFields(entry, [
      "connected", "androidUserMatches", "packageInstalled",
      "versionNameMatches", "versionCodeMatches", "apkSha256Matches",
      "signingCertificatePinCoveredByCertifiedApk", "permissionsGranted",
      "authenticatedSession", "sessionIdentityDistinct", "enrollmentReady",
      "enrollmentIdentityDistinct", "registryBindingMatches"
    ], label);
    if (
      !(entry.androidApi === null || safeIntegerBetween(entry.androidApi, 24, 99)) ||
      !(entry.packageStopped === null || isBoolean(entry.packageStopped)) ||
      !(entry.enrollmentAttempt === null ||
        ENROLLMENT_ATTEMPTS.has(entry.enrollmentAttempt)) ||
      entry.expectedSigningCertificateSha256 !== target.signingCertificateSha256
    ) {
      fail("REDACTION_INVALID", `${label} contains invalid bounded values`);
    }
    const observedVersionName = entry.versionName === target.versionName
      ? entry.versionName
      : null;
    const observedVersionCode = entry.versionCode === target.versionCode
      ? entry.versionCode
      : null;
    if (
      entry.versionNameMatches !== (observedVersionName === target.versionName) ||
      entry.versionCodeMatches !== (observedVersionCode === target.versionCode) ||
      (entry.packageInstalled === false &&
        (entry.packageStopped !== null || observedVersionName !== null ||
          observedVersionCode !== null || entry.versionNameMatches ||
          entry.versionCodeMatches || entry.apkSha256Matches)) ||
      (entry.connected === false &&
        (entry.androidUserMatches || entry.androidApi !== null ||
          entry.packageInstalled || entry.permissionsGranted ||
          entry.authenticatedSession || entry.sessionIdentityDistinct ||
          entry.enrollmentReady || entry.enrollmentIdentityDistinct ||
          entry.registryBindingMatches || entry.enrollmentAttempt !== null))
    ) {
      fail("REDACTION_INVALID", `${label} state correlations are invalid`);
    }
    return Object.freeze({
      ...entry,
      versionName: observedVersionName,
      versionCode: observedVersionCode
    });
  });

  const raspberry = summary.raspberry;
  assertBooleanFields(raspberry, [
    "reachable", "ntpSynchronized", "permissionsSecure"
  ], "inventory.raspberry");
  assertBooleanFields(raspberry.bluez, [
    "available", "powered", "discovering"
  ], "inventory.raspberry.bluez");
  if (
    !(raspberry.architecture === null ||
      new Set(["aarch64", "armv7l", "armv8l", "x86_64"]).has(
        raspberry.architecture
      )) ||
    !(raspberry.bluez.version === null ||
      (typeof raspberry.bluez.version === "string" &&
        /^[0-9]{1,3}\.[0-9]{1,3}(?:\.[0-9]{1,3})?$/u.test(
          raspberry.bluez.version
        ))) ||
    (raspberry.bluez.available !== (raspberry.bluez.version !== null))
  ) {
    fail("REDACTION_INVALID", "Raspberry identity or BlueZ version is invalid");
  }
  assertBooleanFields(raspberry.ups, [
    "discoveryOnly", "probeAvailable", "serviceProbeAvailable"
  ], "inventory.raspberry.ups");
  if (
    raspberry.ups.discoveryOnly !== true ||
    !safeIntegerBetween(raspberry.ups.discoveredDevices, 0, 128) ||
    !safeIntegerBetween(raspberry.ups.serviceUnitsObserved, 0, 128) ||
    (raspberry.ups.probeAvailable === false &&
      raspberry.ups.discoveredDevices !== 0) ||
    (raspberry.ups.serviceProbeAvailable === false &&
      raspberry.ups.serviceUnitsObserved !== 0)
  ) {
    fail("REDACTION_INVALID", "Raspberry UPS inventory is invalid");
  }
  if (
    !Array.isArray(raspberry.services) ||
    raspberry.services.length !== Object.keys(SERVICE_POLICIES).length
  ) {
    fail("REDACTION_INVALID", "Raspberry service inventory is incomplete");
  }
  raspberry.services.forEach((service, index) => {
    exactKeys(service, [
      "service", "requirement", "expectedState", "observed", "expectationMet",
      "loaded", "active", "subState", "enabled"
    ], `inventory.raspberry.services[${index}]`);
    const expectedName = Object.keys(SERVICE_POLICIES)[index];
    const policy = SERVICE_POLICIES[expectedName];
    assertBooleanFields(service, ["observed", "expectationMet"],
      `inventory.raspberry.services[${index}]`);
    if (
      service.service !== expectedName ||
      service.requirement !== policy.requirement ||
      service.expectedState !== policy.expectedState ||
      !(service.loaded === null || isBoolean(service.loaded)) ||
      !(service.active === null || isBoolean(service.active)) ||
      !(service.enabled === null || isBoolean(service.enabled)) ||
      !(service.subState === null ||
        (typeof service.subState === "string" &&
          /^[a-z][a-z-]{0,31}$/u.test(service.subState))) ||
      (service.observed === false &&
        (service.expectationMet || service.loaded !== null ||
          service.active !== null || service.subState !== null ||
          service.enabled !== null))
    ) {
      fail("REDACTION_INVALID", "Raspberry service state is invalid");
    }
  });
  if (raspberry.registry !== null) {
    for (const [field, value] of Object.entries(raspberry.registry)) {
      if (!safeIntegerBetween(value, 0, 1_000_000)) {
        fail("REDACTION_INVALID", `inventory.raspberry.registry.${field} is invalid`);
      }
    }
    if (
      raspberry.registry.activeDevices + raspberry.registry.revokedDevices >
        raspberry.registry.devices ||
      raspberry.registry.pendingTokens > raspberry.registry.enrollmentTokens
    ) {
      fail("REDACTION_INVALID", "Raspberry registry counters are inconsistent");
    }
  }
  assertBooleanFields(raspberry.enrollmentTransactions, ["allPrivate"],
    "inventory.raspberry.enrollmentTransactions");
  if (!safeIntegerBetween(raspberry.enrollmentTransactions.files, 0, 1_000_000)) {
    fail("REDACTION_INVALID", "Raspberry transaction count is invalid");
  }
  if (!Array.isArray(summary.limitations) || summary.limitations.length > 3) {
    fail("REDACTION_INVALID", "inventory limitations are invalid");
  }
  summary.limitations.forEach((entry, index) => {
    exactKeys(entry, ["code"], `inventory.limitations[${index}]`);
    if (!LIMITATION_CODES.has(entry.code)) {
      fail("REDACTION_INVALID", "inventory limitation code is invalid");
    }
  });
  if (!Array.isArray(summary.errors) || summary.errors.length > 128) {
    fail("REDACTION_INVALID", "inventory errors are invalid");
  }
  summary.errors.forEach((entry, index) => {
    exactKeys(entry, ["probe", "code"], `inventory.errors[${index}]`);
    if (!ERROR_PROBE_PATTERN.test(entry.probe) || !ERROR_CODES.has(entry.code)) {
      fail("REDACTION_INVALID", "inventory error is outside the allowlist");
    }
  });
  return Object.freeze({ ...summary, android: Object.freeze(sanitizedAndroid) });
}

function assertExactMixedRoles(android) {
  if (!Array.isArray(android) || android.length !== 3) {
    fail("PHYSICAL_ROLE_COUNT_INVALID", "exactly three Android targets are required");
  }
  const handhelds = android.filter((entry) => entry?.role === "handheld");
  const stations = android.filter((entry) => entry?.role === "station");
  if (handhelds.length !== 2 || stations.length !== 1) {
    fail(
      "PHYSICAL_ROLE_COUNT_INVALID",
      "the live collector requires two handhelds and one station"
    );
  }
}

function certifiedAndroidReady(entry) {
  const target = ADVANCED_CERTIFICATION_TARGETS.roles[entry?.role];
  return (
    target !== undefined &&
    entry?.connected === true &&
    entry?.androidUserMatches === true &&
    Number.isSafeInteger(entry?.androidApi) &&
    entry.androidApi >= 24 &&
    entry?.packageInstalled === true &&
    entry?.packageStopped === false &&
    entry?.versionNameMatches === true &&
    entry?.versionCodeMatches === true &&
    entry?.apkSha256Matches === true &&
    entry?.versionName === target.versionName &&
    entry?.versionCode === target.versionCode &&
    entry?.expectedSigningCertificateSha256 ===
      target.signingCertificateSha256 &&
    entry?.signingCertificatePinCoveredByCertifiedApk === true &&
    entry?.permissionsGranted === true &&
    entry?.authenticatedSession === true &&
    entry?.sessionIdentityDistinct === true &&
    entry?.enrollmentReady === true &&
    entry?.enrollmentIdentityDistinct === true &&
    entry?.registryBindingMatches === true
  );
}

function stationRuntimeReady(entry) {
  const target = ADVANCED_CERTIFICATION_TARGETS.roles.station;
  return (
    entry?.connected === true &&
    entry?.androidUserMatches === true &&
    Number.isSafeInteger(entry?.androidApi) &&
    entry.androidApi >= 24 &&
    entry?.packageInstalled === true &&
    entry?.packageStopped === false &&
    entry?.versionName === target.versionName &&
    entry?.versionCode === target.versionCode &&
    entry?.versionNameMatches === true &&
    entry?.versionCodeMatches === true &&
    entry?.apkSha256Matches === true &&
    entry?.expectedSigningCertificateSha256 ===
      target.signingCertificateSha256 &&
    entry?.permissionsGranted === true &&
    entry?.authenticatedSession === true &&
    entry?.sessionIdentityDistinct === true &&
    entry?.enrollmentReady === true &&
    entry?.enrollmentIdentityDistinct === true &&
    entry?.registryBindingMatches === true
  );
}

function evaluateFunctionallyReadySummary(summary, stationSigningPolicy) {
  if (!STATION_SIGNING_POLICIES.has(stationSigningPolicy)) {
    fail("INVALID_ARGUMENT", "stationSigningPolicy is invalid");
  }
  assertExactMixedRoles(summary?.android);
  const handhelds = summary.android.filter((entry) => entry.role === "handheld");
  const station = summary.android.find((entry) => entry.role === "station");
  const stationSigningVerified =
    station.signingCertificatePinCoveredByCertifiedApk === true;
  const servicesReady =
    Array.isArray(summary?.raspberry?.services) &&
    summary.raspberry.services.length >= 2 &&
    summary.raspberry.services.every(
      (entry) => entry?.observed === true && entry?.expectationMet === true
    );
  if (
    summary?.schemaVersion !== 1 ||
    summary?.product !== "V5BT" ||
    summary?.mode !== "REDACTED_READ_ONLY_BENCH_INVENTORY" ||
    !new Set(["COMPLETE", "INCOMPLETE"]).has(summary?.status) ||
    summary?.readOnly !== true ||
    summary?.commandPolicy?.shell !== false ||
    summary?.commandPolicy?.mutationAllowed !== false ||
    summary?.commandPolicy?.fixedAllowlist !== true ||
    summary?.commandPolicy?.passwordRecorded !== false ||
    summary?.redaction?.serialsExcluded !== true ||
    summary?.redaction?.networkIdentifiersExcluded !== true ||
    summary?.redaction?.registryIdentifiersExcluded !== true ||
    summary?.redaction?.rawCommandOutputExcluded !== true ||
    !Number.isSafeInteger(summary?.adb?.expectedTargets) ||
    summary.adb.expectedTargets !== 3 ||
    !Number.isSafeInteger(summary?.adb?.connectedDevices) ||
    !Number.isSafeInteger(summary?.adb?.unavailableDevices) ||
    !Number.isSafeInteger(summary?.adb?.unexpectedConnectedDevices) ||
    !Array.isArray(summary?.errors) ||
    !Array.isArray(summary?.raspberry?.services)
  ) {
    fail(
      "PHYSICAL_INVENTORY_INCOMPLETE",
      "the redacted live bench inventory is not complete"
    );
  }
  const adbReady =
    summary.adb.probeAvailable === true &&
    summary.adb.connectedDevices === 3 &&
    summary.adb.unavailableDevices === 0 &&
    summary.adb.unexpectedConnectedDevices === 0;
  const raspberryReady =
    summary.raspberry?.reachable === true &&
    summary.raspberry?.bluez?.available === true &&
    summary.raspberry?.bluez?.powered === true &&
    summary.raspberry?.bluez?.discovering === false &&
    summary.raspberry?.ntpSynchronized === true &&
    summary.raspberry?.permissionsSecure === true &&
    Number.isSafeInteger(summary.raspberry?.registry?.activeDevices) &&
    summary.raspberry.registry.activeDevices >= 3 &&
    servicesReady;
  const handheldsReady = handhelds.every(certifiedAndroidReady);
  const stationReady = stationRuntimeReady(station);
  const signingPolicySatisfied =
    stationSigningVerified || stationSigningPolicy === "WAIVED_NON_GATE";
  const functionalReadinessComplete =
    adbReady &&
    raspberryReady &&
    handheldsReady &&
    stationReady &&
    signingPolicySatisfied &&
    summary.errors.length === 0;
  const observedAndroidActors = summary.android.filter(
    (entry) => entry?.connected === true
  ).length;
  const observedPhysicalActors =
    observedAndroidActors + (summary.raspberry?.reachable === true ? 1 : 0);
  return Object.freeze({
    stationSigningVerified,
    observedPhysicalActors,
    physicalPresenceComplete: observedPhysicalActors === 4,
    functionalReadinessComplete,
    readinessStatus: functionalReadinessComplete
      ? stationSigningVerified
        ? "MIXED_READY_CERTIFIED"
        : "MIXED_READY_WITH_NON_GATE_STATION_WAIVER"
      : "MIXED_PHYSICAL_INCOMPLETE"
  });
}

function buildAttestation(summary, captureMode, stationSigningPolicy) {
  const publicInventory = sanitizeAndValidateInventory(summary);
  const readiness = evaluateFunctionallyReadySummary(
    publicInventory,
    stationSigningPolicy
  );
  if (!new Set(["LIVE", "TEST_FIXTURE"]).has(captureMode)) {
    fail("INVALID_ARGUMENT", "captureMode is invalid");
  }
  const inventoryBytes = Buffer.from(JSON.stringify(publicInventory), "utf8");
  const withoutDigest = {
    schemaVersion: 1,
    harnessVersion: B11_MIXED_PHYSICAL_ATTESTATION_VERSION,
    product: "V5BT",
    phase: "B11",
    mode: B11_MIXED_PHYSICAL_ATTESTATION_MODE,
    captureMode,
    fixtureUsed: captureMode !== "LIVE",
    generatedAt: publicInventory.generatedAt,
    readinessStatus: readiness.readinessStatus,
    stationSigningPolicy,
    stationSigningVerified: readiness.stationSigningVerified,
    gateEligible: false,
    configuredPhysicalActors: 4,
    observedPhysicalActors: readiness.observedPhysicalActors,
    physicalPresenceComplete: readiness.physicalPresenceComplete,
    functionalReadinessComplete: readiness.functionalReadinessComplete,
    captureScope: "INVENTORY_ONLY",
    hardwareAccess: captureMode === "LIVE",
    adbExecuted: captureMode === "LIVE",
    sshExecuted: captureMode === "LIVE",
    readOnly: true,
    inventoryEncoding: "JSON_UTF8_COMPACT",
    inventorySha256: sha256(inventoryBytes),
    inventory: publicInventory,
    radioWorkload: {
      status: "NOT_RUN",
      evidenceSha256: null,
      realRealLinkCount: 6,
      cyclesPerLink: 100,
      expectedCycles: 600,
      completedCycles: 0,
      helloCycles: 0,
      authenticatedCycles: 0,
      bidirectionalDataCycles: 0,
      cleanupCycles: 0
    },
    physicalBusiness: {
      status: "NOT_RUN",
      evidenceSha256: null,
      expectedActions: 600,
      completedActions: 0,
      expectedHandheldCommands: 160,
      completedHandheldCommands: 0
    },
    continuityMonitoring: {
      status: "NOT_RUN",
      evidenceSha256: null,
      expectedActors: 4,
      monitoredActors: 0,
      continuous: false
    },
    physicalSoak: {
      status: "NOT_RUN",
      evidenceSha256: null,
      requiredDurationMs: 7_200_000,
      observedDurationMs: 0,
      wallClock: false
    },
    campaignEvidenceCommitment: null
  };
  const attestationDigest = sha256(JSON.stringify(withoutDigest));
  inventoryBytes.fill(0);
  return Object.freeze({ ...withoutDigest, attestationDigest });
}

// Test captures remain explicitly non-live and are rejected by the v3 composer.
export function buildB11MixedPhysicalTestAttestation(
  summary,
  { stationSigningPolicy = "CERTIFIED_REQUIRED" } = {}
) {
  return buildAttestation(
    summary,
    "TEST_FIXTURE",
    stationSigningPolicy
  );
}

function validateCollectorConfig(config) {
  const parsed = parseBenchInventoryConfig(config);
  assertExactMixedRoles(parsed.android);
  return parsed;
}

export async function runB11MixedPhysicalCollector(config, options = {}) {
  allowedKeys(options, [
    "raspberrySshPassword",
    "raspberrySudoPassword",
    "stationSigningPolicy"
  ], "options");
  const parsed = validateCollectorConfig(config);
  const sshPassword = options.raspberrySshPassword ?? null;
  const sudoPassword = options.raspberrySudoPassword ?? null;
  const stationSigningPolicy =
    options.stationSigningPolicy ?? "CERTIFIED_REQUIRED";
  const runner = createExecCommandRunner({ sshPassword, sudoPassword });
  const result = await runBenchInventory(parsed, {
    runner,
    raspberrySudo: sudoPassword !== null,
    sshAuthentication: sshPassword === null ? "PUBLIC_KEY" : "PASSWORD"
  });
  const attestation = buildAttestation(
    result.summary,
    "LIVE",
    stationSigningPolicy
  );
  return Object.freeze({ privateInventory: result.privateReport, attestation });
}

async function assertSecureParent(parent) {
  const resolved = path.resolve(parent);
  const canonical = await realpath(resolved).catch((error) => {
    fail("OUTPUT_PATH_INVALID", "output parent must already exist", error);
  });
  if (canonical !== resolved) {
    fail("OUTPUT_PATH_INVALID", "output parent must not contain symlinks");
  }
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("OUTPUT_PATH_INVALID", "output parent is not a regular directory");
  }
  return metadata;
}

async function secureWriteJsonNoOverwrite(destination, value) {
  const absolute = path.resolve(destination);
  const parent = path.dirname(absolute);
  const parentBefore = await assertSecureParent(parent);
  const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (serialized.byteLength < 2 || serialized.byteLength > MAX_OUTPUT_BYTES) {
    serialized.fill(0);
    fail("OUTPUT_INVALID", "output is outside the allowed size");
  }
  const temporary = path.join(
    parent,
    `.${path.basename(absolute)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`
  );
  let temporaryHandle;
  let targetHandle;
  try {
    temporaryHandle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600
    );
    await temporaryHandle.writeFile(serialized);
    await temporaryHandle.sync();
    const temporaryMetadata = await temporaryHandle.stat();
    if (
      !temporaryMetadata.isFile() ||
      temporaryMetadata.nlink !== 1 ||
      (temporaryMetadata.mode & 0o777) !== 0o600
    ) {
      fail("OUTPUT_PATH_INVALID", "temporary output metadata is unsafe");
    }
    await link(temporary, absolute);
    targetHandle = await open(
      absolute,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
    const linkedMetadata = await targetHandle.stat();
    if (
      linkedMetadata.dev !== temporaryMetadata.dev ||
      linkedMetadata.ino !== temporaryMetadata.ino ||
      linkedMetadata.nlink !== 2
    ) {
      fail("OUTPUT_PATH_INVALID", "published output identity changed");
    }
    await unlink(temporary);
    await targetHandle.chmod(0o600);
    const finalMetadata = await targetHandle.stat();
    const parentAfter = await lstat(parent);
    if (
      finalMetadata.nlink !== 1 ||
      (finalMetadata.mode & 0o777) !== 0o600 ||
      parentAfter.dev !== parentBefore.dev ||
      parentAfter.ino !== parentBefore.ino
    ) {
      fail("OUTPUT_PATH_INVALID", "final output metadata is unsafe");
    }
    await targetHandle.sync();
  } catch (error) {
    if (error instanceof B11MixedPhysicalCollectorError) throw error;
    if (error?.code === "EEXIST") {
      fail("OUTPUT_EXISTS", "output already exists", error);
    }
    fail("OUTPUT_WRITE_FAILED", "unable to publish collector output", error);
  } finally {
    serialized.fill(0);
    await temporaryHandle?.close().catch(() => undefined);
    await targetHandle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writeB11MixedPhysicalCollectorOutputs(
  result,
  privateOutput,
  attestationOutput
) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    fail("INVALID_ARGUMENT", "collector result must be an object");
  }
  const attestation = result.attestation;
  if (attestation === null || typeof attestation !== "object") {
    fail("INVALID_ARGUMENT", "collector attestation is required");
  }
  const rebuilt = buildAttestation(
    attestation.inventory,
    attestation.captureMode,
    attestation.stationSigningPolicy
  );
  if (JSON.stringify(rebuilt) !== JSON.stringify(attestation)) {
    fail("REDACTION_INVALID", "public attestation is not canonical or redacted");
  }
  if (
    typeof privateOutput !== "string" ||
    typeof attestationOutput !== "string" ||
    privateOutput.length === 0 ||
    attestationOutput.length === 0
  ) {
    fail("INVALID_ARGUMENT", "both output paths are required");
  }
  const privateAbsolute = path.resolve(privateOutput);
  const attestationAbsolute = path.resolve(attestationOutput);
  if (privateAbsolute === attestationAbsolute) {
    fail("INVALID_ARGUMENT", "private and attestation outputs must differ");
  }
  await secureWriteJsonNoOverwrite(privateAbsolute, result.privateInventory);
  try {
    await secureWriteJsonNoOverwrite(attestationAbsolute, result.attestation);
  } catch (error) {
    await rm(privateAbsolute, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseTarget(value, label, role) {
  const parts = String(value).split(",");
  if (
    parts.length !== 2 ||
    !SERIAL_PATTERN.test(parts[0]) ||
    !/^(?:0|[1-9][0-9]{0,3})$/u.test(parts[1])
  ) {
    fail("INVALID_ARGUMENT", `${role} must use SERIAL,USER_ID`);
  }
  return {
    label,
    role,
    serial: parts[0],
    expectedUserId: Number(parts[1])
  };
}

export function parseB11MixedPhysicalCollectorArguments(argv) {
  const values = {
    raspberryHost: null,
    raspberryUser: "admin",
    sshPort: 22,
    handheld: [],
    station: null,
    stationSigningPolicy: "CERTIFIED_REQUIRED",
    raspberrySshPasswordEnv: null,
    raspberrySudoPasswordEnv: null,
    privateOutput: null,
    attestationOutput: null,
    help: false
  };
  const singleton = new Set();
  const next = (index, argument) => {
    if (index + 1 >= argv.length) {
      fail("INVALID_ARGUMENT", `${argument} requires a value`);
    }
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      values.help = true;
      continue;
    }
    if (argument === "--fixture") {
      fail("FIXTURE_FORBIDDEN", "the physical collector has no fixture mode");
    }
    if (argument === "--handheld") {
      const raw = next(index, argument);
      index += 1;
      values.handheld.push(raw);
      continue;
    }
    const fields = new Map([
      ["--raspberry-host", "raspberryHost"],
      ["--raspberry-user", "raspberryUser"],
      ["--ssh-port", "sshPort"],
      ["--station", "station"],
      ["--station-signing-policy", "stationSigningPolicy"],
      ["--raspberry-ssh-password-env", "raspberrySshPasswordEnv"],
      ["--raspberry-sudo-password-env", "raspberrySudoPasswordEnv"],
      ["--private-output", "privateOutput"],
      ["--attestation-output", "attestationOutput"]
    ]);
    const field = fields.get(argument);
    if (field === undefined || singleton.has(argument)) {
      fail("INVALID_ARGUMENT", `unsupported or duplicate argument: ${argument}`);
    }
    singleton.add(argument);
    values[field] = next(index, argument);
    index += 1;
  }
  if (values.help) return Object.freeze({ help: true });
  if (
    values.raspberryHost === null ||
    values.handheld.length !== 2 ||
    values.station === null ||
    values.privateOutput === null ||
    values.attestationOutput === null
  ) {
    fail("INVALID_ARGUMENT", "live targets and both output paths are required");
  }
  values.sshPort = Number(values.sshPort);
  const android = [
    parseTarget(values.handheld[0], "handheld-1", "handheld"),
    parseTarget(values.handheld[1], "handheld-2", "handheld"),
    parseTarget(values.station, "station-1", "station")
  ];
  const config = validateCollectorConfig({
    schemaVersion: 1,
    raspberryHost: values.raspberryHost,
    raspberryUser: values.raspberryUser,
    sshPort: values.sshPort,
    android
  });
  return Object.freeze({
    help: false,
    config,
    raspberrySshPasswordEnv: values.raspberrySshPasswordEnv,
    raspberrySudoPasswordEnv: values.raspberrySudoPasswordEnv,
    stationSigningPolicy: values.stationSigningPolicy,
    privateOutput: path.resolve(values.privateOutput),
    attestationOutput: path.resolve(values.attestationOutput)
  });
}

function usage() {
  return [
    "Usage:",
    "  node scripts/run-b11-mixed-physical-collector.mjs \\",
    "    --raspberry-host HOST [--raspberry-user USER] [--ssh-port PORT] \\",
    "    --handheld SERIAL,USER_ID --handheld SERIAL,USER_ID \\",
    "    --station SERIAL,USER_ID \\",
    "    [--station-signing-policy CERTIFIED_REQUIRED|WAIVED_NON_GATE] \\",
    "    --private-output PRIVATE.json --attestation-output ATTESTATION.json",
    "",
    "This collector is live-only. It has no fixture mode."
  ].join("\n");
}

async function main() {
  try {
    const options = parseB11MixedPhysicalCollectorArguments(
      process.argv.slice(2)
    );
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    let sshPassword = null;
    let sudoPassword = null;
    if (
      options.raspberrySshPasswordEnv !== null &&
      options.raspberrySshPasswordEnv === options.raspberrySudoPasswordEnv
    ) {
      sshPassword = consumePasswordEnvironmentVariable(
        options.raspberrySshPasswordEnv,
        "SSH"
      );
      sudoPassword = sshPassword;
    } else {
      if (options.raspberrySshPasswordEnv !== null) {
        sshPassword = consumePasswordEnvironmentVariable(
          options.raspberrySshPasswordEnv,
          "SSH"
        );
      }
      if (options.raspberrySudoPasswordEnv !== null) {
        sudoPassword = consumePasswordEnvironmentVariable(
          options.raspberrySudoPasswordEnv,
          "sudo"
        );
      }
    }
    const result = await runB11MixedPhysicalCollector(options.config, {
      raspberrySshPassword: sshPassword,
      raspberrySudoPassword: sudoPassword,
      stationSigningPolicy: options.stationSigningPolicy
    });
    await writeB11MixedPhysicalCollectorOutputs(
      result,
      options.privateOutput,
      options.attestationOutput
    );
    process.stdout.write(`${JSON.stringify({
      status: "COMPLETE",
      attestationDigest: result.attestation.attestationDigest
    })}\n`);
  } catch (error) {
    const code = error instanceof B11MixedPhysicalCollectorError
      ? error.code
      : "COLLECTOR_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "FAILED", code })}\n`);
    process.exitCode = code === "INVALID_ARGUMENT" ? 2 : 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
