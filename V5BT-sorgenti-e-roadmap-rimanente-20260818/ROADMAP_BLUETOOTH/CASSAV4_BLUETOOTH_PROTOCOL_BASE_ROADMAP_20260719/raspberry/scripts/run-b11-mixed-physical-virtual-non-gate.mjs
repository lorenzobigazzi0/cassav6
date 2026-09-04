#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from "../../scripts/advanced-certification-targets.mjs";
import {
  B11_HYBRID_NON_GATE_MODE,
  B11_HYBRID_TOTAL_ACTOR_COUNT,
  B11_OFFICIAL_PROGRESS_PERCENT,
  validateB11SoftwareNonGateReport
} from "./run-b11-software-non-gate.mjs";

export const B11_MIXED_NON_GATE_VERSION = "3.0.0";
export const B11_MIXED_NON_GATE_MODE =
  "MAXIMUM_MIXED_PHYSICAL_VIRTUAL_SYSTEM_NON_GATE";
export const B11_MIXED_PROFILE = "mixed-physical";
export const B11_MIXED_ATTESTATION_MAX_AGE_MS = 15 * 60 * 1_000;
export const B11_MIXED_REQUIRED_REAL_REAL_LINKS = 6;
export const B11_MIXED_REQUIRED_PHYSICAL_CYCLES = 600;
export const B11_MIXED_REQUIRED_CROSS_DOMAIN_SOFTWARE_CYCLES = 4_000;
export const B11_MIXED_REQUIRED_VIRTUAL_ONLY_SOFTWARE_CYCLES = 4_500;
export const B11_MIXED_REQUIRED_PHYSICAL_ACTIONS = 600;
export const B11_MIXED_REQUIRED_PHYSICAL_HANDHELD_COMMANDS = 160;
export const B11_MIXED_REQUIRED_PHYSICAL_SOAK_MS = 7_200_000;

const PHYSICAL_ATTESTATION_MODE = "B11_MIXED_PHYSICAL_ATTESTATION";
const PHYSICAL_ATTESTATION_VERSION = "1.0.0";
const FUTURE_TOLERANCE_MS = 30_000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
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
const ATTESTATION_KEYS = Object.freeze([
  "schemaVersion", "harnessVersion", "product", "phase", "mode",
  "captureMode", "fixtureUsed", "generatedAt", "readinessStatus",
  "stationSigningPolicy", "stationSigningVerified", "gateEligible",
  "configuredPhysicalActors", "observedPhysicalActors",
  "physicalPresenceComplete", "functionalReadinessComplete", "captureScope",
  "hardwareAccess", "adbExecuted", "sshExecuted", "readOnly",
  "inventoryEncoding", "inventorySha256", "inventory", "radioWorkload",
  "physicalBusiness", "continuityMonitoring", "physicalSoak",
  "campaignEvidenceCommitment", "attestationDigest"
]);
const REPORT_KEYS = Object.freeze([
  "schemaVersion", "harnessVersion", "phase", "mode", "profile",
  "evidenceClass", "verdict", "gateImpact", "promotionAllowed",
  "officialEvidence", "statusMutationAllowed", "officialProgressPercent",
  "b11Gate", "composedAt", "timeBasis", "composerHardwareAccess",
  "physicalEvidenceConsumed", "actorInventory", "sourceBindings",
  "physicalPresence", "physicalFunctionalCoverage", "coveragePartition",
  "simulatedScaleCoverage", "virtualPeripherals", "limitations", "checks",
  "reportDigest"
]);
const CHECK_KEYS = Object.freeze([
  "exactMixedActorInventory", "physicalAttestationFresh",
  "physicalAttestationRedacted", "physicalRoleConfigurationExact",
  "physicalPresenceComplete", "physicalRuntimeReadinessComplete",
  "stationSigningPolicySatisfied", "physicalRadioWorkloadComplete",
  "physicalBusinessWorkloadComplete", "continuityMonitoringComplete",
  "physicalWallClockSoakComplete", "simulatedScaleReportValid",
  "simulatedCoveragePartitionComplete", "virtualPeripheralsOnly",
  "attributionSeparated", "antiPromotionLocked"
]);

export class B11MixedPhysicalVirtualError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "B11MixedPhysicalVirtualError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new B11MixedPhysicalVirtualError(
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
    fail("INVALID_EVIDENCE", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail("INVALID_EVIDENCE", `${label} has a non-canonical field set`);
  }
}

function sha256Equal(actual, expected, label) {
  if (!SHA256_PATTERN.test(actual ?? "") || !SHA256_PATTERN.test(expected ?? "")) {
    fail("INVALID_EVIDENCE", `${label} is not canonical SHA-256`);
  }
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  try {
    if (!timingSafeEqual(actualBytes, expectedBytes)) {
      fail("EVIDENCE_DIGEST_MISMATCH", `${label} does not match`);
    }
  } finally {
    actualBytes.fill(0);
    expectedBytes.fill(0);
  }
}

function canonicalIso(value, label) {
  if (typeof value !== "string") fail("INVALID_EVIDENCE", `${label} is invalid`);
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
    fail("INVALID_EVIDENCE", `${label} is not canonical ISO-8601`);
  }
  return epochMs;
}

function isBoolean(value) {
  return value === true || value === false;
}

function safeIntegerBetween(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function assertBooleanFields(value, fields, label) {
  for (const field of fields) {
    if (!isBoolean(value[field])) {
      fail("INVALID_EVIDENCE", `${label}.${field} must be boolean`);
    }
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

function assertInventoryShape(inventory) {
  exactKeys(inventory, [
    "schemaVersion", "product", "certificationMatrixSha256", "mode",
    "generatedAt", "status", "readOnly", "commandPolicy", "limitations",
    "redaction", "roleCoverage", "adb", "android", "raspberry", "errors"
  ], "inventory");
  exactKeys(inventory.commandPolicy, [
    "shell", "mutationAllowed", "upsMode", "fixedAllowlist",
    "sshAuthentication", "sudoReadOnly", "passwordRecorded"
  ], "inventory.commandPolicy");
  exactKeys(inventory.redaction, [
    "serialsExcluded", "networkIdentifiersExcluded",
    "registryIdentifiersExcluded", "rawCommandOutputExcluded"
  ], "inventory.redaction");
  exactKeys(inventory.roleCoverage, [
    "requiredRoles", "configuredRoles", "missingRequiredRoles", "complete"
  ], "inventory.roleCoverage");
  exactKeys(inventory.adb, [
    "probeAvailable", "expectedTargets", "connectedDevices",
    "unavailableDevices", "unexpectedConnectedDevices"
  ], "inventory.adb");
  if (!Array.isArray(inventory.android) || inventory.android.length !== 3) {
    fail("PHYSICAL_ROLE_COUNT_INVALID", "inventory must contain three Android targets");
  }
  for (const [index, entry] of inventory.android.entries()) {
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
  exactKeys(inventory.raspberry, [
    "reachable", "architecture", "bluez", "ntpSynchronized", "ups",
    "services", "registry", "enrollmentTransactions", "permissionsSecure"
  ], "inventory.raspberry");
  exactKeys(inventory.raspberry.bluez, [
    "available", "version", "powered", "discovering"
  ], "inventory.raspberry.bluez");
  exactKeys(inventory.raspberry.ups, [
    "discoveryOnly", "probeAvailable", "discoveredDevices",
    "serviceProbeAvailable", "serviceUnitsObserved"
  ], "inventory.raspberry.ups");
  exactKeys(inventory.raspberry.enrollmentTransactions, [
    "files", "allPrivate"
  ], "inventory.raspberry.enrollmentTransactions");
  if (inventory.raspberry.registry !== null) {
    exactKeys(inventory.raspberry.registry, [
      "devices", "activeDevices", "revokedDevices", "enrollmentTokens",
      "pendingTokens"
    ], "inventory.raspberry.registry");
  }
  if (!Array.isArray(inventory.raspberry.services)) {
    fail("INVALID_EVIDENCE", "inventory.raspberry.services must be an array");
  }
  for (const [index, service] of inventory.raspberry.services.entries()) {
    exactKeys(service, [
      "service", "requirement", "expectedState", "observed", "expectationMet",
      "loaded", "active", "subState", "enabled"
    ], `inventory.raspberry.services[${index}]`);
  }
  for (const [label, entries] of [
    ["inventory.limitations", inventory.limitations],
    ["inventory.errors", inventory.errors]
  ]) {
    if (!Array.isArray(entries)) fail("INVALID_EVIDENCE", `${label} must be an array`);
    for (const [index, entry] of entries.entries()) {
      exactKeys(
        entry,
        label.endsWith("errors") ? ["probe", "code"] : ["code"],
        `${label}[${index}]`
      );
    }
  }
}

function assertInventoryValues(inventory) {
  canonicalIso(inventory.generatedAt, "inventory.generatedAt");
  if (
    !INVENTORY_STATUS.has(inventory.status) ||
    inventory.commandPolicy.upsMode !== "DISCOVERY_ONLY" ||
    !new Set(["PUBLIC_KEY", "PASSWORD"]).has(
      inventory.commandPolicy.sshAuthentication
    )
  ) {
    fail("INVALID_EVIDENCE", "inventory bounded provenance values are invalid");
  }
  assertBooleanFields(inventory.commandPolicy, [
    "shell", "mutationAllowed", "fixedAllowlist", "sudoReadOnly",
    "passwordRecorded"
  ], "inventory.commandPolicy");
  assertBooleanFields(inventory.redaction, [
    "serialsExcluded", "networkIdentifiersExcluded",
    "registryIdentifiersExcluded", "rawCommandOutputExcluded"
  ], "inventory.redaction");
  if (
    JSON.stringify(inventory.roleCoverage.requiredRoles) !==
      JSON.stringify(["handheld", "station"]) ||
    JSON.stringify(inventory.roleCoverage.configuredRoles) !==
      JSON.stringify(["handheld", "station"]) ||
    !Array.isArray(inventory.roleCoverage.missingRequiredRoles) ||
    inventory.roleCoverage.missingRequiredRoles.length !== 0 ||
    inventory.roleCoverage.complete !== true
  ) {
    fail("PHYSICAL_ROLE_COUNT_INVALID", "inventory role coverage is not canonical");
  }
  assertBooleanFields(inventory.adb, ["probeAvailable"], "inventory.adb");
  if (
    inventory.adb.expectedTargets !== 3 ||
    !safeIntegerBetween(inventory.adb.connectedDevices, 0, 32) ||
    !safeIntegerBetween(inventory.adb.unavailableDevices, 0, 32) ||
    !safeIntegerBetween(inventory.adb.unexpectedConnectedDevices, 0, 32) ||
    inventory.adb.unexpectedConnectedDevices > inventory.adb.connectedDevices ||
    (inventory.adb.probeAvailable === false &&
      (inventory.adb.connectedDevices !== 0 ||
        inventory.adb.unavailableDevices !== 0 ||
        inventory.adb.unexpectedConnectedDevices !== 0))
  ) {
    fail("INVALID_EVIDENCE", "inventory ADB counters are invalid");
  }
  const expectedRoles = ["handheld", "handheld", "station"];
  if (inventory.android.some((entry, index) => entry.role !== expectedRoles[index])) {
    fail("PHYSICAL_ROLE_COUNT_INVALID", "Android role order is not canonical");
  }
  inventory.android.forEach((entry, index) => {
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
      !(entry.versionName === null || entry.versionName === target.versionName) ||
      !(entry.versionCode === null || entry.versionCode === target.versionCode) ||
      entry.versionNameMatches !== (entry.versionName === target.versionName) ||
      entry.versionCodeMatches !== (entry.versionCode === target.versionCode) ||
      entry.expectedSigningCertificateSha256 !== target.signingCertificateSha256 ||
      !(entry.enrollmentAttempt === null ||
        ENROLLMENT_ATTEMPTS.has(entry.enrollmentAttempt)) ||
      (entry.packageInstalled === false &&
        (entry.packageStopped !== null || entry.versionName !== null ||
          entry.versionCode !== null || entry.versionNameMatches ||
          entry.versionCodeMatches || entry.apkSha256Matches)) ||
      (entry.connected === false &&
        (entry.androidUserMatches || entry.androidApi !== null ||
          entry.packageInstalled || entry.permissionsGranted ||
          entry.authenticatedSession || entry.sessionIdentityDistinct ||
          entry.enrollmentReady || entry.enrollmentIdentityDistinct ||
          entry.registryBindingMatches || entry.enrollmentAttempt !== null))
    ) {
      fail("INVALID_EVIDENCE", `${label} values or correlations are invalid`);
    }
  });
  const raspberry = inventory.raspberry;
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
    raspberry.bluez.available !== (raspberry.bluez.version !== null)
  ) {
    fail("INVALID_EVIDENCE", "Raspberry identity or BlueZ version is invalid");
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
    fail("INVALID_EVIDENCE", "Raspberry UPS counters are invalid");
  }
  const serviceNames = Object.keys(SERVICE_POLICIES);
  if (raspberry.services.length !== serviceNames.length) {
    fail("INVALID_EVIDENCE", "Raspberry service inventory is incomplete");
  }
  raspberry.services.forEach((service, index) => {
    const expectedName = serviceNames[index];
    const policy = SERVICE_POLICIES[expectedName];
    const expectedExpectationMet = policy.requirement === "OBSERVE_ONLY"
      ? service.observed === true
      : service.observed === true && service.loaded === true &&
        service.active === true && service.enabled === true;
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
      service.expectationMet !== expectedExpectationMet ||
      (service.observed === false &&
        (service.expectationMet || service.loaded !== null ||
          service.active !== null || service.subState !== null ||
          service.enabled !== null))
    ) {
      fail("INVALID_EVIDENCE", "Raspberry service evidence is invalid");
    }
  });
  if (raspberry.registry !== null) {
    for (const [field, value] of Object.entries(raspberry.registry)) {
      if (!safeIntegerBetween(value, 0, 1_000_000)) {
        fail("INVALID_EVIDENCE", `Raspberry registry ${field} is invalid`);
      }
    }
    if (
      raspberry.registry.activeDevices + raspberry.registry.revokedDevices >
        raspberry.registry.devices ||
      raspberry.registry.pendingTokens > raspberry.registry.enrollmentTokens
    ) {
      fail("INVALID_EVIDENCE", "Raspberry registry counters are inconsistent");
    }
  }
  assertBooleanFields(raspberry.enrollmentTransactions, ["allPrivate"],
    "inventory.raspberry.enrollmentTransactions");
  if (!safeIntegerBetween(raspberry.enrollmentTransactions.files, 0, 1_000_000)) {
    fail("INVALID_EVIDENCE", "Raspberry transaction count is invalid");
  }
  if (!Array.isArray(inventory.limitations) || inventory.limitations.length > 3) {
    fail("INVALID_EVIDENCE", "inventory limitations are invalid");
  }
  inventory.limitations.forEach((entry) => {
    if (!LIMITATION_CODES.has(entry.code)) {
      fail("INVALID_EVIDENCE", "inventory limitation is outside the allowlist");
    }
  });
  if (!Array.isArray(inventory.errors) || inventory.errors.length > 128) {
    fail("INVALID_EVIDENCE", "inventory errors are invalid");
  }
  inventory.errors.forEach((entry) => {
    if (!ERROR_PROBE_PATTERN.test(entry.probe) || !ERROR_CODES.has(entry.code)) {
      fail("INVALID_EVIDENCE", "inventory error is outside the allowlist");
    }
  });
}

function evaluateInventory(inventory, stationSigningPolicy) {
  assertInventoryShape(inventory);
  assertInventoryValues(inventory);
  if (
    inventory.schemaVersion !== 1 ||
    inventory.product !== "V5BT" ||
    inventory.certificationMatrixSha256 !==
      ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256 ||
    inventory.mode !== "REDACTED_READ_ONLY_BENCH_INVENTORY" ||
    !new Set(["COMPLETE", "INCOMPLETE"]).has(inventory.status) ||
    inventory.readOnly !== true ||
    inventory.commandPolicy.shell !== false ||
    inventory.commandPolicy.mutationAllowed !== false ||
    inventory.commandPolicy.fixedAllowlist !== true ||
    inventory.commandPolicy.passwordRecorded !== false ||
    inventory.redaction.serialsExcluded !== true ||
    inventory.redaction.networkIdentifiersExcluded !== true ||
    inventory.redaction.registryIdentifiersExcluded !== true ||
    inventory.redaction.rawCommandOutputExcluded !== true ||
    inventory.adb.expectedTargets !== 3
  ) {
    fail("INVALID_EVIDENCE", "inventory provenance or redaction is invalid");
  }
  const handhelds = inventory.android.filter((entry) => entry.role === "handheld");
  const stations = inventory.android.filter((entry) => entry.role === "station");
  if (handhelds.length !== 2 || stations.length !== 1) {
    fail(
      "PHYSICAL_ROLE_COUNT_INVALID",
      "inventory must configure two handhelds and one station"
    );
  }
  const station = stations[0];
  const stationSigningVerified =
    station.signingCertificatePinCoveredByCertifiedApk === true;
  const observedHandhelds = handhelds.filter((entry) => entry.connected === true).length;
  const observedStations = stations.filter((entry) => entry.connected === true).length;
  const observedRaspberry = inventory.raspberry.reachable === true ? 1 : 0;
  const observedPhysicalActors =
    observedHandhelds + observedStations + observedRaspberry;
  if (
    inventory.adb.connectedDevices !==
      observedHandhelds + observedStations +
        inventory.adb.unexpectedConnectedDevices
  ) {
    fail("INVALID_EVIDENCE", "ADB counters do not match observed Android actors");
  }
  const servicesReady =
    inventory.raspberry.services.length >= 2 &&
    inventory.raspberry.services.every(
      (entry) => entry.observed === true && entry.expectationMet === true
    );
  const adbReady =
    inventory.adb.probeAvailable === true &&
    inventory.adb.connectedDevices === 3 &&
    inventory.adb.unavailableDevices === 0 &&
    inventory.adb.unexpectedConnectedDevices === 0;
  const raspberryReady =
    inventory.raspberry.reachable === true &&
    inventory.raspberry.bluez.available === true &&
    inventory.raspberry.bluez.powered === true &&
    inventory.raspberry.bluez.discovering === false &&
    inventory.raspberry.ntpSynchronized === true &&
    inventory.raspberry.permissionsSecure === true &&
    Number.isSafeInteger(inventory.raspberry.registry?.activeDevices) &&
    inventory.raspberry.registry.activeDevices >= 3 &&
    servicesReady;
  const stationSigningPolicySatisfied =
    stationSigningVerified || stationSigningPolicy === "WAIVED_NON_GATE";
  const functionalReadinessComplete =
    adbReady &&
    handhelds.every(certifiedAndroidReady) &&
    stationRuntimeReady(station) &&
    stationSigningPolicySatisfied &&
    raspberryReady &&
    inventory.errors.length === 0;
  const certifiedInventoryComplete =
    adbReady &&
    handhelds.every(certifiedAndroidReady) &&
    certifiedAndroidReady(station) &&
    raspberryReady &&
    inventory.errors.length === 0;
  if ((inventory.status === "COMPLETE") !== certifiedInventoryComplete) {
    fail("INVALID_EVIDENCE", "inventory status is inconsistent with observations");
  }
  return Object.freeze({
    observedHandhelds,
    observedStations,
    observedRaspberry,
    observedPhysicalActors,
    physicalPresenceComplete: observedPhysicalActors === 4,
    stationSigningVerified,
    stationSigningPolicySatisfied,
    functionalReadinessComplete,
    readinessStatus: functionalReadinessComplete
      ? stationSigningVerified
        ? "MIXED_READY_CERTIFIED"
        : "MIXED_READY_WITH_NON_GATE_STATION_WAIVER"
      : "MIXED_PHYSICAL_INCOMPLETE"
  });
}

function validateNotRunCampaign(attestation) {
  const { radioWorkload, physicalBusiness, continuityMonitoring, physicalSoak } =
    attestation;
  return (
    attestation.captureScope === "INVENTORY_ONLY" &&
    attestation.campaignEvidenceCommitment === null &&
    radioWorkload.status === "NOT_RUN" &&
    radioWorkload.evidenceSha256 === null &&
    radioWorkload.realRealLinkCount === 6 &&
    radioWorkload.cyclesPerLink === 100 &&
    radioWorkload.expectedCycles === 600 &&
    radioWorkload.completedCycles === 0 &&
    radioWorkload.helloCycles === 0 &&
    radioWorkload.authenticatedCycles === 0 &&
    radioWorkload.bidirectionalDataCycles === 0 &&
    radioWorkload.cleanupCycles === 0 &&
    physicalBusiness.status === "NOT_RUN" &&
    physicalBusiness.evidenceSha256 === null &&
    physicalBusiness.expectedActions === 600 &&
    physicalBusiness.completedActions === 0 &&
    physicalBusiness.expectedHandheldCommands === 160 &&
    physicalBusiness.completedHandheldCommands === 0 &&
    continuityMonitoring.status === "NOT_RUN" &&
    continuityMonitoring.evidenceSha256 === null &&
    continuityMonitoring.expectedActors === 4 &&
    continuityMonitoring.monitoredActors === 0 &&
    continuityMonitoring.continuous === false &&
    physicalSoak.status === "NOT_RUN" &&
    physicalSoak.evidenceSha256 === null &&
    physicalSoak.requiredDurationMs === B11_MIXED_REQUIRED_PHYSICAL_SOAK_MS &&
    physicalSoak.observedDurationMs === 0 &&
    physicalSoak.wallClock === false
  );
}

function assertCampaignShapes(attestation) {
  exactKeys(attestation.radioWorkload, [
    "status", "evidenceSha256", "realRealLinkCount", "cyclesPerLink",
    "expectedCycles", "completedCycles", "helloCycles", "authenticatedCycles",
    "bidirectionalDataCycles", "cleanupCycles"
  ], "attestation.radioWorkload");
  exactKeys(attestation.physicalBusiness, [
    "status", "evidenceSha256", "expectedActions", "completedActions",
    "expectedHandheldCommands", "completedHandheldCommands"
  ], "attestation.physicalBusiness");
  exactKeys(attestation.continuityMonitoring, [
    "status", "evidenceSha256", "expectedActors", "monitoredActors", "continuous"
  ], "attestation.continuityMonitoring");
  exactKeys(attestation.physicalSoak, [
    "status", "evidenceSha256", "requiredDurationMs", "observedDurationMs",
    "wallClock"
  ], "attestation.physicalSoak");
}

export function validateB11MixedPhysicalAttestation(
  attestation,
  { now = new Date() } = {}
) {
  exactKeys(attestation, ATTESTATION_KEYS, "attestation");
  assertCampaignShapes(attestation);
  if (
    attestation.schemaVersion !== 1 ||
    attestation.harnessVersion !== PHYSICAL_ATTESTATION_VERSION ||
    attestation.product !== "V5BT" ||
    attestation.phase !== "B11" ||
    attestation.mode !== PHYSICAL_ATTESTATION_MODE ||
    attestation.captureMode !== "LIVE" ||
    attestation.fixtureUsed !== false ||
    !STATION_SIGNING_POLICIES.has(attestation.stationSigningPolicy) ||
    attestation.gateEligible !== false ||
    attestation.configuredPhysicalActors !== 4 ||
    attestation.hardwareAccess !== true ||
    attestation.adbExecuted !== true ||
    attestation.sshExecuted !== true ||
    attestation.readOnly !== true ||
    attestation.inventoryEncoding !== "JSON_UTF8_COMPACT"
  ) {
    fail("INVALID_EVIDENCE", "physical attestation provenance is invalid");
  }
  const inventoryBytes = Buffer.from(JSON.stringify(attestation.inventory), "utf8");
  try {
    sha256Equal(
      attestation.inventorySha256,
      sha256(inventoryBytes),
      "inventorySha256"
    );
  } finally {
    inventoryBytes.fill(0);
  }
  if (attestation.inventory.generatedAt !== attestation.generatedAt) {
    fail("INVALID_EVIDENCE", "attestation and inventory timestamps differ");
  }
  const generatedAtMs = canonicalIso(attestation.generatedAt, "generatedAt");
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) fail("INVALID_ARGUMENT", "now is invalid");
  const ageMs = nowMs - generatedAtMs;
  if (ageMs < -FUTURE_TOLERANCE_MS) {
    fail("PHYSICAL_ATTESTATION_FROM_FUTURE", "physical attestation is from the future");
  }
  if (ageMs > B11_MIXED_ATTESTATION_MAX_AGE_MS) {
    fail("PHYSICAL_ATTESTATION_STALE", "physical attestation is stale");
  }
  const inventory = evaluateInventory(
    attestation.inventory,
    attestation.stationSigningPolicy
  );
  if (
    attestation.observedPhysicalActors !== inventory.observedPhysicalActors ||
    attestation.physicalPresenceComplete !== inventory.physicalPresenceComplete ||
    attestation.functionalReadinessComplete !==
      inventory.functionalReadinessComplete ||
    attestation.stationSigningVerified !== inventory.stationSigningVerified ||
    attestation.readinessStatus !== inventory.readinessStatus
  ) {
    fail("INVALID_EVIDENCE", "physical readiness declarations are inconsistent");
  }
  if (!validateNotRunCampaign(attestation)) {
    fail(
      "INVALID_EVIDENCE",
      "v3 accepts only inventory evidence with every physical campaign NOT_RUN"
    );
  }
  const { attestationDigest, ...withoutDigest } = attestation;
  sha256Equal(
    attestationDigest,
    sha256(JSON.stringify(withoutDigest)),
    "attestationDigest"
  );
  return Object.freeze({
    attestation,
    ageMs: Math.max(0, ageMs),
    inventory
  });
}

function parseJsonBytes(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    fail("INVALID_ARGUMENT", `${label} bytes are required`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("INVALID_EVIDENCE", `${label} is not valid JSON`, error);
  }
}

function buildMixedReport({
  physicalBytes,
  simulatedBytes,
  physical,
  simulated,
  composedAt
}) {
  const physicalAttestation = physical.attestation;
  const inventory = physical.inventory;
  const campaign = physicalAttestation;
  const checks = Object.freeze({
    exactMixedActorInventory: true,
    physicalAttestationFresh: physical.ageMs <= B11_MIXED_ATTESTATION_MAX_AGE_MS,
    physicalAttestationRedacted: true,
    physicalRoleConfigurationExact: true,
    physicalPresenceComplete: inventory.physicalPresenceComplete,
    physicalRuntimeReadinessComplete: inventory.functionalReadinessComplete,
    stationSigningPolicySatisfied: inventory.stationSigningPolicySatisfied,
    physicalRadioWorkloadComplete: false,
    physicalBusinessWorkloadComplete: false,
    continuityMonitoringComplete: false,
    physicalWallClockSoakComplete: false,
    simulatedScaleReportValid: true,
    simulatedCoveragePartitionComplete:
      B11_MIXED_REQUIRED_CROSS_DOMAIN_SOFTWARE_CYCLES +
        B11_MIXED_REQUIRED_VIRTUAL_ONLY_SOFTWARE_CYCLES ===
      8_500,
    virtualPeripheralsOnly: true,
    attributionSeparated: true,
    antiPromotionLocked: true
  });
  const withoutDigest = {
    schemaVersion: 3,
    harnessVersion: B11_MIXED_NON_GATE_VERSION,
    phase: "B11",
    mode: B11_MIXED_NON_GATE_MODE,
    profile: B11_MIXED_PROFILE,
    evidenceClass: "MIXED_NON_GATE_EVIDENCE",
    verdict: "MIXED_NON_GATE_INCOMPLETE",
    gateImpact: "NONE",
    promotionAllowed: false,
    officialEvidence: false,
    statusMutationAllowed: false,
    officialProgressPercent: B11_OFFICIAL_PROGRESS_PERCENT,
    b11Gate: "PENDING",
    composedAt,
    timeBasis: "WALL_CLOCK_ATTESTATION_PLUS_DETERMINISTIC_SIMULATION",
    composerHardwareAccess: false,
    physicalEvidenceConsumed: true,
    actorInventory: {
      totalActors: 16,
      physicalActors: 4,
      virtualActors: 12,
      roles: {
        HANDHELD: { total: 10, physical: 2, virtual: 8 },
        STATION: { total: 3, physical: 1, virtual: 2 },
        RASPBERRY: { total: 1, physical: 1, virtual: 0 },
        AUTOMATIC_CASH: { total: 1, physical: 0, virtual: 1 },
        FISCAL_RT: { total: 1, physical: 0, virtual: 1 }
      }
    },
    sourceBindings: {
      physicalAttestationSha256: sha256(physicalBytes),
      physicalAttestationDigest: physicalAttestation.attestationDigest,
      physicalInventorySha256: physicalAttestation.inventorySha256,
      simulatedReportSha256: sha256(simulatedBytes),
      simulatedReportDigest: simulated.reportDigest
    },
    physicalPresence: {
      requiredPhysicalActors: 4,
      observedPhysicalActors: inventory.observedPhysicalActors,
      requiredHandhelds: 2,
      observedHandhelds: inventory.observedHandhelds,
      requiredStations: 1,
      observedStations: inventory.observedStations,
      requiredRaspberry: 1,
      observedRaspberry: inventory.observedRaspberry,
      complete: inventory.physicalPresenceComplete,
      virtualSubstitutionAllowed: false
    },
    physicalFunctionalCoverage: {
      readinessStatus: physicalAttestation.readinessStatus,
      stationSigningPolicy: physicalAttestation.stationSigningPolicy,
      stationSigningVerified: physicalAttestation.stationSigningVerified,
      gateEligible: false,
      inventoryReadinessComplete: inventory.functionalReadinessComplete,
      radioWorkloadStatus: campaign.radioWorkload.status,
      physicalCyclesCompleted: campaign.radioWorkload.completedCycles,
      physicalBusinessStatus: campaign.physicalBusiness.status,
      physicalActionsCompleted: campaign.physicalBusiness.completedActions,
      physicalHandheldCommandsCompleted:
        campaign.physicalBusiness.completedHandheldCommands,
      continuityStatus: campaign.continuityMonitoring.status,
      monitoredPhysicalActors: campaign.continuityMonitoring.monitoredActors,
      physicalSoakStatus: campaign.physicalSoak.status,
      physicalSoakObservedMs: campaign.physicalSoak.observedDurationMs,
      physicalSoakWallClock: campaign.physicalSoak.wallClock,
      campaignEvidenceCommitment: campaign.campaignEvidenceCommitment
    },
    coveragePartition: {
      cyclesPerLink: 100,
      realReal: {
        linkCount: 6,
        requiredCycles: 600,
        completedPhysicalCycles: campaign.radioWorkload.completedCycles,
        attribution: "PHYSICAL_CAMPAIGN_ONLY"
      },
      logicalCrossDomain: {
        linkCount: 40,
        requiredCycles: 4_000,
        completedSoftwareCycles: 4_000,
        attribution: "SOFTWARE_MODEL_ONLY"
      },
      virtualOnly: {
        linkCount: 45,
        requiredCycles: 4_500,
        completedSoftwareCycles: 4_500,
        attribution: "SOFTWARE_MODEL_ONLY"
      },
      totalLogicalLinks: 91,
      totalRequiredCycles: 9_100
    },
    simulatedScaleCoverage: {
      sourceMode: simulated.mode,
      logicalActorsModeled: simulated.actors.totalActors,
      logicalBluetoothNodesModeled: simulated.topology.nodeCount,
      logicalLinksModeled: simulated.topology.usefulPairCount,
      softwareModelCompletedCycles:
        simulated.workload.completedConnectDisconnectCycles,
      softwareAttributedCycles: 8_500,
      physicalSlotSurrogateCyclesExcluded: 600,
      softwareModelBusinessActions: simulated.businessWorkload.completedActions,
      softwareAttributedVirtualActions: 2_000,
      physicalSlotSurrogateActionsExcluded: 600,
      attribution: "SOFTWARE_MODEL_ONLY"
    },
    virtualPeripherals: {
      automaticCashInstances: 1,
      fiscalRtInstances: 1,
      realInstances: 0
    },
    limitations: {
      mixedProfileIsOfficialGateEvidence: false,
      simulatedCyclesAttributedToPhysicalActors: false,
      simulatedBusinessActionsAttributedToPhysicalActors: false,
      physicalPassRequiresSeparateCampaignEvidence: true,
      stationSignatureWaiverCanPromoteGate: false
    },
    checks
  };
  return Object.freeze({
    ...withoutDigest,
    reportDigest: sha256(JSON.stringify(withoutDigest))
  });
}

export function composeB11MixedPhysicalVirtualReport({
  physicalAttestationBytes,
  simulatedReportBytes,
  now = new Date()
}) {
  const physicalAttestation = parseJsonBytes(
    physicalAttestationBytes,
    "physical attestation"
  );
  const simulatedReport = parseJsonBytes(simulatedReportBytes, "simulated report");
  const physical = validateB11MixedPhysicalAttestation(physicalAttestation, { now });
  try {
    validateB11SoftwareNonGateReport(simulatedReport);
  } catch (error) {
    fail("SIMULATED_REPORT_INVALID", "simulated scale report is invalid", error);
  }
  if (
    simulatedReport.schemaVersion !== 2 ||
    simulatedReport.mode !== B11_HYBRID_NON_GATE_MODE ||
    simulatedReport.verdict !== "NON_GATE_PASS" ||
    simulatedReport.actors.totalActors !== B11_HYBRID_TOTAL_ACTOR_COUNT ||
    simulatedReport.workload.completedConnectDisconnectCycles !== 9_100 ||
    simulatedReport.businessWorkload.completedActions !== 2_600
  ) {
    fail("SIMULATED_REPORT_INVALID", "simulated scale coverage is incomplete");
  }
  const composedAtMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(composedAtMs)) fail("INVALID_ARGUMENT", "now is invalid");
  const report = buildMixedReport({
    physicalBytes: physicalAttestationBytes,
    simulatedBytes: simulatedReportBytes,
    physical,
    simulated: simulatedReport,
    composedAt: new Date(composedAtMs).toISOString()
  });
  validateB11MixedPhysicalVirtualReport(report);
  return report;
}

function assertReportShape(report) {
  exactKeys(report, REPORT_KEYS, "report");
  exactKeys(report.actorInventory, [
    "totalActors", "physicalActors", "virtualActors", "roles"
  ], "actorInventory");
  exactKeys(report.actorInventory.roles, [
    "HANDHELD", "STATION", "RASPBERRY", "AUTOMATIC_CASH", "FISCAL_RT"
  ], "actorInventory.roles");
  for (const [role, value] of Object.entries(report.actorInventory.roles)) {
    exactKeys(value, ["total", "physical", "virtual"], `actorInventory.roles.${role}`);
  }
  exactKeys(report.sourceBindings, [
    "physicalAttestationSha256", "physicalAttestationDigest",
    "physicalInventorySha256", "simulatedReportSha256", "simulatedReportDigest"
  ], "sourceBindings");
  exactKeys(report.physicalPresence, [
    "requiredPhysicalActors", "observedPhysicalActors", "requiredHandhelds",
    "observedHandhelds", "requiredStations", "observedStations",
    "requiredRaspberry", "observedRaspberry", "complete",
    "virtualSubstitutionAllowed"
  ], "physicalPresence");
  exactKeys(report.physicalFunctionalCoverage, [
    "readinessStatus", "stationSigningPolicy", "stationSigningVerified",
    "gateEligible", "inventoryReadinessComplete", "radioWorkloadStatus",
    "physicalCyclesCompleted", "physicalBusinessStatus",
    "physicalActionsCompleted", "physicalHandheldCommandsCompleted",
    "continuityStatus", "monitoredPhysicalActors", "physicalSoakStatus",
    "physicalSoakObservedMs", "physicalSoakWallClock",
    "campaignEvidenceCommitment"
  ], "physicalFunctionalCoverage");
  exactKeys(report.coveragePartition, [
    "cyclesPerLink", "realReal", "logicalCrossDomain", "virtualOnly",
    "totalLogicalLinks", "totalRequiredCycles"
  ], "coveragePartition");
  exactKeys(report.coveragePartition.realReal, [
    "linkCount", "requiredCycles", "completedPhysicalCycles", "attribution"
  ], "coveragePartition.realReal");
  for (const key of ["logicalCrossDomain", "virtualOnly"]) {
    exactKeys(report.coveragePartition[key], [
      "linkCount", "requiredCycles", "completedSoftwareCycles", "attribution"
    ], `coveragePartition.${key}`);
  }
  exactKeys(report.simulatedScaleCoverage, [
    "sourceMode", "logicalActorsModeled", "logicalBluetoothNodesModeled",
    "logicalLinksModeled", "softwareModelCompletedCycles",
    "softwareAttributedCycles", "physicalSlotSurrogateCyclesExcluded",
    "softwareModelBusinessActions", "softwareAttributedVirtualActions",
    "physicalSlotSurrogateActionsExcluded", "attribution"
  ], "simulatedScaleCoverage");
  exactKeys(report.virtualPeripherals, [
    "automaticCashInstances", "fiscalRtInstances", "realInstances"
  ], "virtualPeripherals");
  exactKeys(report.limitations, [
    "mixedProfileIsOfficialGateEvidence", "simulatedCyclesAttributedToPhysicalActors",
    "simulatedBusinessActionsAttributedToPhysicalActors",
    "physicalPassRequiresSeparateCampaignEvidence",
    "stationSignatureWaiverCanPromoteGate"
  ], "limitations");
  exactKeys(report.checks, CHECK_KEYS, "checks");
}

export function validateB11MixedPhysicalVirtualReport(report) {
  assertReportShape(report);
  const roles = report.actorInventory.roles;
  const fixedContractValid =
    report.schemaVersion === 3 &&
    report.harnessVersion === B11_MIXED_NON_GATE_VERSION &&
    report.phase === "B11" &&
    report.mode === B11_MIXED_NON_GATE_MODE &&
    report.profile === B11_MIXED_PROFILE &&
    report.evidenceClass === "MIXED_NON_GATE_EVIDENCE" &&
    report.verdict === "MIXED_NON_GATE_INCOMPLETE" &&
    report.gateImpact === "NONE" &&
    report.promotionAllowed === false &&
    report.officialEvidence === false &&
    report.statusMutationAllowed === false &&
    report.officialProgressPercent === B11_OFFICIAL_PROGRESS_PERCENT &&
    report.b11Gate === "PENDING" &&
    report.timeBasis ===
      "WALL_CLOCK_ATTESTATION_PLUS_DETERMINISTIC_SIMULATION" &&
    report.composerHardwareAccess === false &&
    report.physicalEvidenceConsumed === true &&
    report.actorInventory.totalActors === 16 &&
    report.actorInventory.physicalActors === 4 &&
    report.actorInventory.virtualActors === 12 &&
    roles.HANDHELD.total === 10 && roles.HANDHELD.physical === 2 &&
    roles.HANDHELD.virtual === 8 &&
    roles.STATION.total === 3 && roles.STATION.physical === 1 &&
    roles.STATION.virtual === 2 &&
    roles.RASPBERRY.total === 1 && roles.RASPBERRY.physical === 1 &&
    roles.RASPBERRY.virtual === 0 &&
    roles.AUTOMATIC_CASH.total === 1 &&
    roles.AUTOMATIC_CASH.physical === 0 &&
    roles.AUTOMATIC_CASH.virtual === 1 &&
    roles.FISCAL_RT.total === 1 && roles.FISCAL_RT.physical === 0 &&
    roles.FISCAL_RT.virtual === 1 &&
    report.physicalPresence.requiredPhysicalActors === 4 &&
    report.physicalPresence.requiredHandhelds === 2 &&
    report.physicalPresence.requiredStations === 1 &&
    report.physicalPresence.requiredRaspberry === 1 &&
    report.physicalPresence.virtualSubstitutionAllowed === false &&
    report.physicalFunctionalCoverage.gateEligible === false &&
    report.coveragePartition.cyclesPerLink === 100 &&
    report.coveragePartition.realReal.linkCount === 6 &&
    report.coveragePartition.realReal.requiredCycles === 600 &&
    report.coveragePartition.realReal.attribution === "PHYSICAL_CAMPAIGN_ONLY" &&
    report.coveragePartition.logicalCrossDomain.linkCount === 40 &&
    report.coveragePartition.logicalCrossDomain.requiredCycles === 4_000 &&
    report.coveragePartition.logicalCrossDomain.completedSoftwareCycles === 4_000 &&
    report.coveragePartition.logicalCrossDomain.attribution === "SOFTWARE_MODEL_ONLY" &&
    report.coveragePartition.virtualOnly.linkCount === 45 &&
    report.coveragePartition.virtualOnly.requiredCycles === 4_500 &&
    report.coveragePartition.virtualOnly.completedSoftwareCycles === 4_500 &&
    report.coveragePartition.virtualOnly.attribution === "SOFTWARE_MODEL_ONLY" &&
    report.coveragePartition.totalLogicalLinks === 91 &&
    report.coveragePartition.totalRequiredCycles === 9_100 &&
    report.simulatedScaleCoverage.sourceMode === B11_HYBRID_NON_GATE_MODE &&
    report.simulatedScaleCoverage.logicalActorsModeled === 16 &&
    report.simulatedScaleCoverage.logicalBluetoothNodesModeled === 14 &&
    report.simulatedScaleCoverage.logicalLinksModeled === 91 &&
    report.simulatedScaleCoverage.softwareModelCompletedCycles === 9_100 &&
    report.simulatedScaleCoverage.softwareAttributedCycles === 8_500 &&
    report.simulatedScaleCoverage.physicalSlotSurrogateCyclesExcluded === 600 &&
    report.simulatedScaleCoverage.softwareModelBusinessActions === 2_600 &&
    report.simulatedScaleCoverage.softwareAttributedVirtualActions === 2_000 &&
    report.simulatedScaleCoverage.physicalSlotSurrogateActionsExcluded === 600 &&
    report.simulatedScaleCoverage.attribution === "SOFTWARE_MODEL_ONLY" &&
    report.virtualPeripherals.automaticCashInstances === 1 &&
    report.virtualPeripherals.fiscalRtInstances === 1 &&
    report.virtualPeripherals.realInstances === 0 &&
    Object.values(report.limitations).every((value) => value === false) === false &&
    report.limitations.mixedProfileIsOfficialGateEvidence === false &&
    report.limitations.simulatedCyclesAttributedToPhysicalActors === false &&
    report.limitations.simulatedBusinessActionsAttributedToPhysicalActors === false &&
    report.limitations.physicalPassRequiresSeparateCampaignEvidence === true &&
    report.limitations.stationSignatureWaiverCanPromoteGate === false;
  if (!fixedContractValid) {
    fail("PROMOTION_CONTRACT_VIOLATION", "mixed report contract is invalid");
  }
  for (const value of Object.values(report.sourceBindings)) {
    if (!SHA256_PATTERN.test(value ?? "")) {
      fail("INVALID_REPORT", "source binding is not canonical SHA-256");
    }
  }
  const physical = report.physicalFunctionalCoverage;
  const presence = report.physicalPresence;
  const expectedSigningPolicySatisfied =
    physical.stationSigningVerified === true ||
    physical.stationSigningPolicy === "WAIVED_NON_GATE";
  const expectedReadinessStatus = physical.inventoryReadinessComplete
    ? physical.stationSigningVerified
      ? "MIXED_READY_CERTIFIED"
      : "MIXED_READY_WITH_NON_GATE_STATION_WAIVER"
    : "MIXED_PHYSICAL_INCOMPLETE";
  if (
    !safeIntegerBetween(presence.observedHandhelds, 0, 2) ||
    !safeIntegerBetween(presence.observedStations, 0, 1) ||
    !safeIntegerBetween(presence.observedRaspberry, 0, 1) ||
    presence.observedPhysicalActors !==
      presence.observedHandhelds + presence.observedStations +
        presence.observedRaspberry ||
    presence.complete !== (presence.observedPhysicalActors === 4) ||
    !STATION_SIGNING_POLICIES.has(physical.stationSigningPolicy) ||
    !isBoolean(physical.stationSigningVerified) ||
    !isBoolean(physical.inventoryReadinessComplete) ||
    (physical.inventoryReadinessComplete &&
      !expectedSigningPolicySatisfied) ||
    physical.readinessStatus !== expectedReadinessStatus ||
    physical.radioWorkloadStatus !== "NOT_RUN" ||
    physical.physicalCyclesCompleted !== 0 ||
    physical.physicalBusinessStatus !== "NOT_RUN" ||
    physical.physicalActionsCompleted !== 0 ||
    physical.physicalHandheldCommandsCompleted !== 0 ||
    physical.continuityStatus !== "NOT_RUN" ||
    physical.monitoredPhysicalActors !== 0 ||
    physical.physicalSoakStatus !== "NOT_RUN" ||
    physical.physicalSoakObservedMs !== 0 ||
    physical.physicalSoakWallClock !== false ||
    physical.campaignEvidenceCommitment !== null ||
    report.checks.exactMixedActorInventory !== true ||
    report.checks.physicalAttestationFresh !== true ||
    report.checks.physicalAttestationRedacted !== true ||
    report.checks.physicalRoleConfigurationExact !== true ||
    report.checks.physicalPresenceComplete !== presence.complete ||
    report.checks.physicalRuntimeReadinessComplete !==
      physical.inventoryReadinessComplete ||
    report.checks.stationSigningPolicySatisfied !==
      expectedSigningPolicySatisfied ||
    report.checks.physicalRadioWorkloadComplete !== false ||
    report.checks.physicalBusinessWorkloadComplete !== false ||
    report.checks.continuityMonitoringComplete !== false ||
    report.checks.physicalWallClockSoakComplete !== false ||
    report.checks.simulatedScaleReportValid !== true ||
    report.checks.simulatedCoveragePartitionComplete !== true ||
    report.checks.virtualPeripheralsOnly !== true ||
    report.checks.antiPromotionLocked !== true ||
    report.checks.attributionSeparated !== true ||
    report.coveragePartition.realReal.completedPhysicalCycles !==
      physical.physicalCyclesCompleted
  ) {
    fail("INVALID_REPORT", "mixed verdict or coverage checks are inconsistent");
  }
  canonicalIso(report.composedAt, "composedAt");
  const { reportDigest, ...withoutDigest } = report;
  sha256Equal(
    reportDigest,
    sha256(JSON.stringify(withoutDigest)),
    "reportDigest"
  );
  return report;
}

async function readSecureJsonBytes(file, label) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    fail("INVALID_ARGUMENT", `${label} path must be absolute`);
  }
  const parent = path.dirname(file);
  const canonicalParent = await realpath(parent).catch((error) => {
    fail("INPUT_PATH_INVALID", `${label} parent is unavailable`, error);
  });
  if (canonicalParent !== parent) {
    fail("INPUT_PATH_INVALID", `${label} path contains symlinks`);
  }
  const before = await lstat(file).catch((error) => {
    fail("INPUT_MISSING", `${label} is missing`, error);
  });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 2 ||
    before.size > MAX_INPUT_BYTES
  ) {
    fail("INPUT_PATH_INVALID", `${label} metadata is unsafe`);
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("INPUT_PATH_INVALID", `${label} identity changed while opening`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.nlink !== 1
    ) {
      bytes.fill(0);
      fail("INPUT_PATH_INVALID", `${label} changed while reading`);
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertSecureOutputParent(parent) {
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

export async function writeB11MixedPhysicalVirtualReport(outputPath, report) {
  if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
    fail("INVALID_ARGUMENT", "output path must be absolute");
  }
  validateB11MixedPhysicalVirtualReport(report);
  const absolute = path.resolve(outputPath);
  const parent = path.dirname(absolute);
  const parentBefore = await assertSecureOutputParent(parent);
  const serialized = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (serialized.byteLength < 2 || serialized.byteLength > MAX_INPUT_BYTES) {
    serialized.fill(0);
    fail("OUTPUT_INVALID", "report output is outside the allowed size");
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
    if (error instanceof B11MixedPhysicalVirtualError) throw error;
    if (error?.code === "EEXIST") {
      fail("OUTPUT_EXISTS", "output already exists", error);
    }
    fail("OUTPUT_WRITE_FAILED", "unable to publish mixed report", error);
  } finally {
    serialized.fill(0);
    await temporaryHandle?.close().catch(() => undefined);
    await targetHandle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function runB11MixedPhysicalVirtualNonGate({
  physicalAttestationPath,
  simulatedReportPath,
  outputPath,
  now = new Date()
}) {
  const physicalBytes = await readSecureJsonBytes(
    physicalAttestationPath,
    "physical attestation"
  );
  const simulatedBytes = await readSecureJsonBytes(
    simulatedReportPath,
    "simulated report"
  );
  try {
    const report = composeB11MixedPhysicalVirtualReport({
      physicalAttestationBytes: physicalBytes,
      simulatedReportBytes: simulatedBytes,
      now
    });
    await writeB11MixedPhysicalVirtualReport(outputPath, report);
    return report;
  } finally {
    physicalBytes.fill(0);
    simulatedBytes.fill(0);
  }
}

export function parseB11MixedPhysicalVirtualArguments(argv) {
  const output = {
    physicalAttestationPath: null,
    simulatedReportPath: null,
    outputPath: null,
    help: false
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      output.help = true;
      continue;
    }
    if (!new Set([
      "--physical-attestation", "--simulated-report", "--output"
    ]).has(argument)) {
      fail("INVALID_ARGUMENT", `unsupported argument: ${argument}`);
    }
    if (seen.has(argument) || index + 1 >= argv.length) {
      fail("INVALID_ARGUMENT", `duplicate or missing value for ${argument}`);
    }
    seen.add(argument);
    const value = argv[++index];
    if (!path.isAbsolute(value)) {
      fail("INVALID_ARGUMENT", `${argument} must be absolute`);
    }
    if (argument === "--physical-attestation") {
      output.physicalAttestationPath = value;
    } else if (argument === "--simulated-report") {
      output.simulatedReportPath = value;
    } else {
      output.outputPath = value;
    }
  }
  if (output.help) return Object.freeze({ help: true });
  if (
    output.physicalAttestationPath === null ||
    output.simulatedReportPath === null ||
    output.outputPath === null
  ) {
    fail("INVALID_ARGUMENT", "both evidence inputs and --output are required");
  }
  return Object.freeze(output);
}

async function main() {
  try {
    const options = parseB11MixedPhysicalVirtualArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write([
        "Usage:",
        "  node raspberry/scripts/run-b11-mixed-physical-virtual-non-gate.mjs \\",
        "    --physical-attestation /absolute/attestation.json \\",
        "    --simulated-report /absolute/schema2-report.json \\",
        "    --output /absolute/schema3-report.json",
        "",
        "The composer performs no hardware access and never promotes B11."
      ].join("\n") + "\n");
      return;
    }
    const report = await runB11MixedPhysicalVirtualNonGate(options);
    process.stdout.write(`${JSON.stringify({
      verdict: report.verdict,
      reportDigest: report.reportDigest
    })}\n`);
    process.exitCode = 1;
  } catch (error) {
    const code = error instanceof B11MixedPhysicalVirtualError
      ? error.code
      : "MIXED_COMPOSITION_FAILED";
    process.stderr.write(`${JSON.stringify({
      verdict: "MIXED_NON_GATE_INCOMPLETE",
      code
    })}\n`);
    process.exitCode = code === "INVALID_ARGUMENT" ? 2 : 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
