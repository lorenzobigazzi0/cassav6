#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  V6_COMMAND_INTERVAL_MAX_MS,
  V6_COMMAND_INTERVAL_MIN_MS,
  V6_DEVICE_ACTION_INTERVAL_MS,
  V6_MAX_HANDHELDS,
  V6_MAX_STATIONS,
} from "./v6-operations-scheduler.mjs";
import {
  V6_ACTION_P95_MAX_MS,
  V6_BATTERY_NOTIFICATION_INTERVAL_MS,
  V6_COMMAND_P95_MAX_MS,
} from "./v6-operations-gates.mjs";

export const V6_OPERATIONS_READINESS_VERSION = "1.0.0";
export const V6_SCHEDULER_CONTRACT_VERSION = 2;

const MAX_MATRIX_BYTES = 16_384;
const MAX_STAGE_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 128 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MATRIX_ROLES = Object.freeze(["handheld", "station"]);
const MATRIX_TARGET_KEYS = Object.freeze([
  "artifactRelativePath",
  "packageId",
  "sha256",
  "signingCertificateSha256",
  "versionCode",
  "versionName",
]);
const CHECK_VALUES = new Set(["PASS", "FAIL", "NOT_EVALUATED"]);
const STAGE_ORDER = Object.freeze(["micro", "smoke", "full"]);
const STAGE_SPECS = Object.freeze({
  micro: Object.freeze({ actionsPerDevice: 10, totalActions: 300 }),
  smoke: Object.freeze({ actionsPerDevice: 40, totalActions: 1_200 }),
  full: Object.freeze({ actionsPerDevice: 200, totalActions: 6_000 }),
});
const RUNTIME_CHECKS = Object.freeze([
  "noEarlyActionBursts",
  "noEarlyDispatchActionBursts",
  "globalInFlightWithinLimit",
  "perDeviceInFlightWithinLimit",
  "actionP95WithinLimit",
  "commandP95WithinLimit",
  "actionMaximumWithinLimit",
  "guiRequestBudgetWithinLimit",
]);
const STAGE_CHECKS = Object.freeze([
  "contractVersion",
  "stageBinding",
  "profileBinding",
  "deviceTopology",
  "workloadQuota",
  "perDeviceQuota",
  "zeroErrors",
  "actionCoverage",
  "dispatchCadenceBasis",
  "noEarlyDispatchBursts",
  "mobileActionCadence",
  "commandCadence",
  "latency",
  "batteryCadence",
  "persistence",
  "audit",
  "cleanup",
  "runtimeGate",
  "runtimeChecksComplete",
  "timestamps",
]);
const STAGE_EXPECTED_FIELDS = Object.freeze([
  "handhelds",
  "stations",
  "actionsPerDevice",
  "totalActions",
]);
const STAGE_OBSERVED_FIELDS = Object.freeze([
  "handhelds",
  "stations",
  "actionsPerDevice",
  "expectedTotalActions",
  "totalStarted",
  "totalCompleted",
  "totalFailed",
  "mobileActionAverageGapMs",
  "commandAverageGapMs",
  "batteryNotificationIntervalMs",
  "persistedDevices",
  "runtimeChecksPassed",
]);

export class V6OperationsReadinessError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "V6OperationsReadinessError";
    this.code = code;
  }
}

function fail(code, message, options = undefined) {
  throw new V6OperationsReadinessError(code, message, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value, fields, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(code, `${label} has an invalid field set`);
  }
  return value;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CANONICAL_JSON_INVALID", "JSON number is not finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  fail("CANONICAL_JSON_INVALID", "Value is not structured JSON");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseJsonBytes(bytes, code) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1) {
    fail(code, "JSON evidence is empty");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(code, "JSON evidence is malformed", { cause: error });
  }
}

function validateCertificationMatrix(matrix) {
  exactFields(matrix, ["roles", "schemaVersion"], "MATRIX_INVALID", "certification matrix");
  if (matrix.schemaVersion !== 3) fail("MATRIX_INVALID", "Certification matrix schema is invalid");
  exactFields(matrix.roles, MATRIX_ROLES, "MATRIX_INVALID", "certification matrix roles");
  const roles = {};
  for (const role of MATRIX_ROLES) {
    const target = matrix.roles[role];
    exactFields(target, MATRIX_TARGET_KEYS, "MATRIX_INVALID", "certification target");
    if (
      typeof target.packageId !== "string" ||
      target.packageId.length > 200 ||
      !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(target.packageId) ||
      typeof target.versionName !== "string" ||
      !/^[0-9]+(?:\.[0-9]+){2}$/u.test(target.versionName) ||
      !Number.isSafeInteger(target.versionCode) ||
      target.versionCode <= 0 ||
      !SHA256_PATTERN.test(target.sha256 ?? "") ||
      /^0{64}$/u.test(target.sha256) ||
      !SHA256_PATTERN.test(target.signingCertificateSha256 ?? "") ||
      /^0{64}$/u.test(target.signingCertificateSha256) ||
      typeof target.artifactRelativePath !== "string" ||
      target.artifactRelativePath.includes("\\") ||
      target.artifactRelativePath.includes("\0") ||
      path.posix.isAbsolute(target.artifactRelativePath) ||
      path.posix.normalize(target.artifactRelativePath) !== target.artifactRelativePath ||
      !target.artifactRelativePath.startsWith("artifacts/") ||
      !target.artifactRelativePath.endsWith(".apk") ||
      target.artifactRelativePath.split("/").some(
        (segment) =>
          segment.length === 0 ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment),
      )
    ) {
      fail("MATRIX_INVALID", "Certification matrix target is invalid");
    }
    roles[role] = Object.fromEntries(
      MATRIX_TARGET_KEYS.map((key) => [key, target[key]]),
    );
  }
  if (
    roles.handheld.packageId === roles.station.packageId ||
    roles.handheld.sha256 === roles.station.sha256 ||
    roles.handheld.artifactRelativePath === roles.station.artifactRelativePath
  ) {
    fail("MATRIX_INVALID", "Certification matrix targets are not distinct");
  }
  return { schemaVersion: 3, roles };
}

export function canonicalCertificationMatrixSha256(matrix) {
  return sha256(JSON.stringify(validateCertificationMatrix(matrix)));
}

function initialChecks(value = "NOT_EVALUATED") {
  return Object.fromEntries(STAGE_CHECKS.map((field) => [field, value]));
}

function stageObserved(spec, overrides = {}) {
  return {
    handhelds: null,
    stations: null,
    actionsPerDevice: null,
    expectedTotalActions: spec.totalActions,
    totalStarted: null,
    totalCompleted: null,
    totalFailed: null,
    mobileActionAverageGapMs: null,
    commandAverageGapMs: null,
    batteryNotificationIntervalMs: null,
    persistedDevices: null,
    runtimeChecksPassed: null,
    ...overrides,
  };
}

function stageShell(stage, status, sourceReportSha256, checks, observed, timing = null) {
  return {
    public: {
      stage,
      status,
      sourceReportSha256,
      expected: {
        handhelds: V6_MAX_HANDHELDS,
        stations: V6_MAX_STATIONS,
        actionsPerDevice: STAGE_SPECS[stage].actionsPerDevice,
        totalActions: STAGE_SPECS[stage].totalActions,
      },
      observed,
      checks,
    },
    timing,
  };
}

function normalizeStageEvidence(input) {
  if (input === null || input === undefined) return { missing: true };
  let bytes;
  let expectedSha256 = null;
  if (Buffer.isBuffer(input)) {
    bytes = Buffer.from(input);
  } else if (isRecord(input) && Buffer.isBuffer(input.bytes)) {
    bytes = Buffer.from(input.bytes);
    expectedSha256 = input.expectedSha256 ?? null;
  } else if (isRecord(input)) {
    bytes = Buffer.from(canonicalJson(input), "utf8");
  } else {
    return { invalid: true, digest: null };
  }
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_STAGE_REPORT_BYTES) {
    return { invalid: true, digest: sha256(bytes) };
  }
  const digest = sha256(bytes);
  if (expectedSha256 !== null && expectedSha256 !== digest) {
    return { invalid: true, digest };
  }
  try {
    return { report: JSON.parse(bytes.toString("utf8")), digest };
  } catch {
    return { invalid: true, digest };
  }
}

function evaluateCurrentStage(stage, report, digest) {
  const spec = STAGE_SPECS[stage];
  const config = report.config;
  const profile = report.v6OperationsProfile;
  const checks = initialChecks("FAIL");
  const configVersion = safeInteger(config?.v6SchedulerContractVersion);
  const profileVersion = safeInteger(profile?.schedulerContractVersion);
  const configStage = config?.v6OperationsStage;
  const profileStage = profile?.stage;
  const markersMissing =
    configVersion === null ||
    profileVersion === null ||
    typeof configStage !== "string" ||
    typeof profileStage !== "string";
  if (markersMissing || configVersion < V6_SCHEDULER_CONTRACT_VERSION) {
    return stageShell(
      stage,
      "STALE",
      digest,
      initialChecks(),
      stageObserved(spec),
    );
  }

  checks.contractVersion =
    configVersion === V6_SCHEDULER_CONTRACT_VERSION &&
    profileVersion === V6_SCHEDULER_CONTRACT_VERSION
      ? "PASS"
      : "FAIL";
  checks.stageBinding =
    configStage === stage && profileStage === stage && configStage !== "custom"
      ? "PASS"
      : "FAIL";
  checks.profileBinding =
    config?.profile === "v6-operations-30" &&
    config?.laneCrossExclusionOrdersEnabled === false &&
    config?.laneCrossExclusionTablesEnabled === false &&
    config?.laneCrossExclusionPaymentsEnabled === false &&
    config?.laneCrossExclusionPresenceEnabled === false &&
    config?.paymentLaneConcurrency === 2 &&
    config?.v6OperationsEvidenceClass === "QUALIFYING_PROFILE" &&
    config?.v6OperationsPromotionEligibility === "READINESS_ELIGIBLE" &&
    config?.v6OperationsDiagnosticPaymentLaneConcurrency === null &&
    config?.v6OperationsDiagnostic === false &&
    config?.printLaneConcurrency === 1 &&
    config?.ordersAsyncFlushIntervalMs === 500 &&
    config?.hostPressurePreflight?.schemaVersion === 2 &&
    config?.hostPressurePreflight?.status === "PASS" &&
    config?.hostPressurePreflight?.enforced === true &&
    config?.hostPressurePreflight?.sufficient === true &&
    config?.hostPressurePreflight?.checks?.schedulerLoad?.ok === true
      ? "PASS"
      : "FAIL";

  const handhelds = safeInteger(config?.handHeldCount);
  const stations = safeInteger(config?.stationCount);
  const actionsPerDevice = safeInteger(config?.v6OperationsActionsPerDevice);
  const totalStarted = safeInteger(profile?.totalStarted);
  const totalCompleted = safeInteger(profile?.totalCompleted);
  const totalSucceeded = safeInteger(profile?.totalSucceeded);
  const totalFailed = safeInteger(profile?.totalFailed);
  const devices = Array.isArray(profile?.devices) ? profile.devices : [];
  const handheldDeviceCount = devices.filter((device) => device?.kind === "handheld").length;
  const stationDeviceCount = devices.filter((device) => device?.kind === "station").length;
  checks.deviceTopology =
    handhelds === V6_MAX_HANDHELDS &&
    stations === V6_MAX_STATIONS &&
    profile?.handheldCount === V6_MAX_HANDHELDS &&
    profile?.stationCount === V6_MAX_STATIONS &&
    profile?.deviceCount === V6_MAX_HANDHELDS + V6_MAX_STATIONS &&
    devices.length === V6_MAX_HANDHELDS + V6_MAX_STATIONS &&
    handheldDeviceCount === V6_MAX_HANDHELDS &&
    stationDeviceCount === V6_MAX_STATIONS
      ? "PASS"
      : "FAIL";
  checks.workloadQuota =
    actionsPerDevice === spec.actionsPerDevice &&
    config?.v6OperationsTotalActions === spec.totalActions &&
    profile?.actionsPerDevice === spec.actionsPerDevice &&
    profile?.totalActions === spec.totalActions &&
    totalStarted === spec.totalActions &&
    totalCompleted === spec.totalActions &&
    totalSucceeded === spec.totalActions
      ? "PASS"
      : "FAIL";
  checks.perDeviceQuota =
    devices.length === V6_MAX_HANDHELDS + V6_MAX_STATIONS &&
    devices.every(
      (device) =>
        device?.started === spec.actionsPerDevice &&
        device?.completed === spec.actionsPerDevice &&
        device?.succeeded === spec.actionsPerDevice &&
        device?.failed === 0 &&
        device?.pendingAtEnd === 0,
    )
      ? "PASS"
      : "FAIL";
  checks.zeroErrors =
    totalFailed === 0 &&
    Array.isArray(report.recorder?.failures) &&
    report.recorder.failures.length === 0
      ? "PASS"
      : "FAIL";
  checks.actionCoverage =
    Array.isArray(profile?.missingMobileActionTypes) &&
    profile.missingMobileActionTypes.length === 0 &&
    Array.isArray(profile?.mobileActionTypesWithoutSuccess) &&
    profile.mobileActionTypesWithoutSuccess.length === 0
      ? "PASS"
      : "FAIL";

  const cadence = profile?.cadence;
  const mobileAverage = finiteNumber(cadence?.mobileActionAverageGapMs);
  const commandAverage = finiteNumber(cadence?.commandAverageGapMs);
  checks.dispatchCadenceBasis = cadence?.cadenceBasis === "dispatch" ? "PASS" : "FAIL";
  checks.noEarlyDispatchBursts =
    cadence?.earlyActionGaps === 0 &&
    cadence?.earlyDispatchActionGaps === 0 &&
    profile?.runtimeGate?.checks?.noEarlyActionBursts === true &&
    profile?.runtimeGate?.checks?.noEarlyDispatchActionBursts === true
      ? "PASS"
      : "FAIL";
  checks.mobileActionCadence =
    cadence?.mobileActionCadenceOk === true &&
    mobileAverage !== null &&
    mobileAverage >= V6_DEVICE_ACTION_INTERVAL_MS - 5 &&
    mobileAverage <= V6_DEVICE_ACTION_INTERVAL_MS + 300
      ? "PASS"
      : "FAIL";
  checks.commandCadence =
    cadence?.commandCadenceOk === true &&
    commandAverage !== null &&
    commandAverage >= V6_COMMAND_INTERVAL_MIN_MS &&
    commandAverage <= V6_COMMAND_INTERVAL_MAX_MS
      ? "PASS"
      : "FAIL";
  checks.latency =
    finiteNumber(profile?.actionLatencyMs?.p95ms) !== null &&
    profile.actionLatencyMs.p95ms <= V6_ACTION_P95_MAX_MS &&
    finiteNumber(profile?.commandLatencyMs?.p95ms) !== null &&
    profile.commandLatencyMs.p95ms <= V6_COMMAND_P95_MAX_MS
      ? "PASS"
      : "FAIL";

  const battery = report.mockIoMetrics?.battery;
  const batteryDeviceCount = Array.isArray(battery?.body?.devices)
    ? battery.body.devices.length
    : null;
  checks.batteryCadence =
    config?.batteryNotificationIntervalMs === V6_BATTERY_NOTIFICATION_INTERVAL_MS &&
    battery?.ok === true &&
    battery?.body?.notificationIntervalMs === V6_BATTERY_NOTIFICATION_INTERVAL_MS &&
    batteryDeviceCount === V6_MAX_HANDHELDS
      ? "PASS"
      : "FAIL";
  const persistedDevices = safeInteger(profile?.devicesMeetingPersistedOrderTarget);
  checks.persistence =
    profile?.persistedOrderTargetOk === true &&
    profile?.persistedOrderGate?.ok === true &&
    persistedDevices === V6_MAX_HANDHELDS
      ? "PASS"
      : "FAIL";

  const audit = report.relationalAudit;
  checks.audit =
    audit?.drained === true &&
    [
      "eventOutboxUnpublished",
      "printSpoolPending",
      "fiscalOutboxPending",
      "paymentMirrorPending",
      "printSpoolFailedFinal",
      "fiscalOutboxProblem",
      "paymentMirrorFailed",
      "fiscalReceiptsNotIssued",
      "duplicatePaymentIdempotencyKeys",
      "duplicateFiscalAttemptScopes",
    ].every((field) => audit?.[field] === 0)
      ? "PASS"
      : "FAIL";
  checks.cleanup =
    report.cleanup?.sessions?.ok === true &&
    report.cleanup?.processes?.verified === true &&
    report.cleanup?.processes?.remaining === 0 &&
    report.cleanup?.logs?.verified === true &&
    report.cleanup?.logs?.openHandles === 0
      ? "PASS"
      : "FAIL";
  const runtimeChecks = profile?.runtimeGate?.checks;
  const runtimePassed = RUNTIME_CHECKS.filter((field) => runtimeChecks?.[field] === true).length;
  checks.runtimeChecksComplete = runtimePassed === RUNTIME_CHECKS.length ? "PASS" : "FAIL";
  checks.runtimeGate = profile?.runtimeGate?.ok === true ? "PASS" : "FAIL";

  const startedAtMs = canonicalTimestamp(report.recorder?.startedAt);
  const endedAtMs = canonicalTimestamp(report.recorder?.endedAt);
  checks.timestamps =
    startedAtMs !== null && endedAtMs !== null && endedAtMs >= startedAtMs
      ? "PASS"
      : "FAIL";
  const status = Object.values(checks).every((value) => value === "PASS")
    ? "PASS"
    : "FAIL";
  return stageShell(
    stage,
    status,
    digest,
    checks,
    stageObserved(spec, {
      handhelds,
      stations,
      actionsPerDevice,
      totalStarted,
      totalCompleted,
      totalFailed,
      mobileActionAverageGapMs: mobileAverage,
      commandAverageGapMs: commandAverage,
      batteryNotificationIntervalMs:
        safeInteger(battery?.body?.notificationIntervalMs) ??
        safeInteger(config?.batteryNotificationIntervalMs),
      persistedDevices,
      runtimeChecksPassed: runtimePassed,
    }),
    startedAtMs === null || endedAtMs === null ? null : { startedAtMs, endedAtMs },
  );
}

function evaluateStage(stage, input) {
  const evidence = normalizeStageEvidence(input);
  if (evidence.missing) {
    return stageShell(
      stage,
      "MISSING",
      null,
      initialChecks(),
      stageObserved(STAGE_SPECS[stage]),
    );
  }
  if (evidence.invalid || !isRecord(evidence.report)) {
    return stageShell(
      stage,
      "FAIL",
      evidence.digest ?? null,
      initialChecks("FAIL"),
      stageObserved(STAGE_SPECS[stage]),
    );
  }
  return evaluateCurrentStage(stage, evidence.report, evidence.digest);
}

function assertRedacted(receipt) {
  const forbiddenFields = [
    /(?:^|_)(?:path|run.?id|serial|account|user|pid|hostname)(?:$|_)/iu,
    /device.?id/iu,
  ];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isRecord(value)) return;
    for (const [field, nested] of Object.entries(value)) {
      if (forbiddenFields.some((pattern) => pattern.test(field))) {
        fail("RECEIPT_PRIVACY_INVALID", "Receipt contains a forbidden field");
      }
      visit(nested);
    }
  };
  visit(receipt);
  const encoded = JSON.stringify(receipt);
  for (const pattern of [
    /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/iu,
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu,
    /\/(?:home|tmp|var|etc|run)\//u,
    /-----BEGIN [A-Z ]+-----/u,
  ]) {
    if (pattern.test(encoded)) fail("RECEIPT_PRIVACY_INVALID", "Receipt leaks private data");
  }
  return true;
}

function receiptWithoutCommitment(receipt) {
  const { receiptCommitmentSha256: _ignored, ...base } = receipt;
  return base;
}

export function evaluateV6OperationsReadiness({
  certificationMatrix,
  expectedCertificationMatrixSha256 = null,
  reports = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const generatedAtMs = canonicalTimestamp(generatedAt);
  if (generatedAtMs === null) fail("CLOCK_INVALID", "Receipt timestamp is invalid");
  const matrixSha256 = canonicalCertificationMatrixSha256(certificationMatrix);
  if (
    expectedCertificationMatrixSha256 !== null &&
    !SHA256_PATTERN.test(expectedCertificationMatrixSha256)
  ) {
    fail("MATRIX_DIGEST_INVALID", "Expected matrix digest is invalid");
  }

  const evaluated = STAGE_ORDER.map((stage) => evaluateStage(stage, reports?.[stage]));
  let previousEnd = null;
  for (const entry of evaluated) {
    if (entry.timing === null) continue;
    if (previousEnd !== null && entry.timing.startedAtMs < previousEnd) {
      entry.public.checks.timestamps = "FAIL";
      entry.public.status = "FAIL";
    }
    previousEnd = entry.timing.endedAtMs;
  }
  const sourceReportDigests = evaluated
    .map((entry) => entry.public.sourceReportSha256)
    .filter((value) => typeof value === "string");
  const reportsBound =
    sourceReportDigests.length === STAGE_ORDER.length &&
    new Set(sourceReportDigests).size === STAGE_ORDER.length;
  const sequenceMonotonic =
    evaluated.every((entry) => entry.public.checks.timestamps === "PASS") &&
    previousEnd !== null &&
    generatedAtMs >= previousEnd;
  const matrixBinding =
    expectedCertificationMatrixSha256 === null ||
    expectedCertificationMatrixSha256 === matrixSha256;
  const allStagesPassed = evaluated.every((entry) => entry.public.status === "PASS");
  const verdict =
    matrixBinding && reportsBound && sequenceMonotonic && allStagesPassed
      ? "NON_GATE_PASS"
      : "NOT_READY";
  const reportDigests = Object.fromEntries(
    evaluated.map((entry) => [entry.public.stage, entry.public.sourceReportSha256]),
  );
  const evidenceBindingSha256 = sha256(
    canonicalJson({ certificationMatrixSha256: matrixSha256, reportDigests }),
  );
  const base = {
    schemaVersion: 1,
    harnessVersion: V6_OPERATIONS_READINESS_VERSION,
    product: "V6",
    phase: "OPERATIONS_LOAD_READINESS",
    generatedAt,
    mode: "NON_GATE_READINESS",
    evidenceClass: "NON_GATE_EVIDENCE",
    verdict,
    certificationMatrixSha256: matrixSha256,
    evidenceBindingSha256,
    reportDigests,
    stages: evaluated.map((entry) => entry.public),
    checks: {
      matrixBinding: matrixBinding ? "PASS" : "FAIL",
      threeDistinctReports: reportsBound ? "PASS" : "FAIL",
      stageSequenceAndClock: sequenceMonotonic ? "PASS" : "FAIL",
      allStagesPassed: allStagesPassed ? "PASS" : "FAIL",
    },
    gate: {
      gateImpact: "NONE",
      b4: "PENDING",
      b5: "PENDING",
      b6: "BLOCKED",
      officialProgressChanged: false,
    },
    privacy: {
      pathsIncluded: false,
      executionIdentifiersIncluded: false,
      serialsIncluded: false,
      accountsIncluded: false,
      processIdentifiersIncluded: false,
      hostnamesIncluded: false,
    },
    effects: {
      schedulerExecuted: false,
      physicalHardwareAccessed: false,
      gatePromotionExecuted: false,
    },
  };
  const receipt = Object.freeze({
    ...base,
    receiptCommitmentSha256: sha256(canonicalJson(base)),
  });
  assertRedacted(receipt);
  return receipt;
}

export function parseV6OperationsReadinessReceipt(raw) {
  let receipt;
  try {
    receipt = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    fail("RECEIPT_INVALID", "Readiness receipt is malformed", { cause: error });
  }
  exactFields(
    receipt,
    [
      "schemaVersion",
      "harnessVersion",
      "product",
      "phase",
      "generatedAt",
      "mode",
      "evidenceClass",
      "verdict",
      "certificationMatrixSha256",
      "evidenceBindingSha256",
      "reportDigests",
      "stages",
      "checks",
      "gate",
      "privacy",
      "effects",
      "receiptCommitmentSha256",
    ],
    "RECEIPT_INVALID",
    "readiness receipt",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.harnessVersion !== V6_OPERATIONS_READINESS_VERSION ||
    receipt.product !== "V6" ||
    receipt.phase !== "OPERATIONS_LOAD_READINESS" ||
    receipt.mode !== "NON_GATE_READINESS" ||
    receipt.evidenceClass !== "NON_GATE_EVIDENCE" ||
    !["NON_GATE_PASS", "NOT_READY"].includes(receipt.verdict) ||
    canonicalTimestamp(receipt.generatedAt) === null ||
    !SHA256_PATTERN.test(receipt.certificationMatrixSha256 ?? "") ||
    !SHA256_PATTERN.test(receipt.evidenceBindingSha256 ?? "") ||
    !SHA256_PATTERN.test(receipt.receiptCommitmentSha256 ?? "")
  ) {
    fail("RECEIPT_INVALID", "Readiness receipt header is invalid");
  }
  if (!Array.isArray(receipt.stages) || receipt.stages.length !== 3) {
    fail("RECEIPT_INVALID", "Readiness receipt stage inventory is invalid");
  }
  exactFields(
    receipt.reportDigests,
    STAGE_ORDER,
    "RECEIPT_INVALID",
    "readiness report digests",
  );
  receipt.stages.forEach((stage, index) => {
    exactFields(
      stage,
      ["stage", "status", "sourceReportSha256", "expected", "observed", "checks"],
      "RECEIPT_INVALID",
      "readiness stage",
    );
    exactFields(
      stage.checks,
      STAGE_CHECKS,
      "RECEIPT_INVALID",
      "readiness stage checks",
    );
    exactFields(
      stage.expected,
      STAGE_EXPECTED_FIELDS,
      "RECEIPT_INVALID",
      "readiness stage expected counts",
    );
    exactFields(
      stage.observed,
      STAGE_OBSERVED_FIELDS,
      "RECEIPT_INVALID",
      "readiness stage observed counts",
    );
    const expectedStageCounts = {
      handhelds: V6_MAX_HANDHELDS,
      stations: V6_MAX_STATIONS,
      actionsPerDevice: STAGE_SPECS[STAGE_ORDER[index]].actionsPerDevice,
      totalActions: STAGE_SPECS[STAGE_ORDER[index]].totalActions,
    };
    const observedValuesValid = Object.values(stage.observed).every(
      (value) => value === null || Number.isFinite(value),
    );
    const allStageChecksPass = Object.values(stage.checks).every(
      (value) => value === "PASS",
    );
    if (
      stage?.stage !== STAGE_ORDER[index] ||
      !["PASS", "MISSING", "STALE", "FAIL"].includes(stage?.status) ||
      !Object.values(stage.checks).every((value) => CHECK_VALUES.has(value)) ||
      canonicalJson(stage.expected) !== canonicalJson(expectedStageCounts) ||
      stage.observed.expectedTotalActions !== expectedStageCounts.totalActions ||
      !observedValuesValid ||
      (stage.status === "PASS") !== allStageChecksPass ||
      (stage.status === "MISSING" && stage.sourceReportSha256 !== null) ||
      !(
        stage.sourceReportSha256 === null ||
        SHA256_PATTERN.test(stage.sourceReportSha256 ?? "")
      ) ||
      receipt.reportDigests[stage.stage] !== stage.sourceReportSha256
    ) {
      fail("RECEIPT_INVALID", "Readiness receipt stage is invalid");
    }
  });
  exactFields(
    receipt.checks,
    ["matrixBinding", "threeDistinctReports", "stageSequenceAndClock", "allStagesPassed"],
    "RECEIPT_INVALID",
    "readiness checks",
  );
  if (!Object.values(receipt.checks).every((value) => ["PASS", "FAIL"].includes(value))) {
    fail("RECEIPT_INVALID", "Readiness receipt checks are invalid");
  }
  const expectedVerdict = Object.values(receipt.checks).every((value) => value === "PASS")
    ? "NON_GATE_PASS"
    : "NOT_READY";
  if (
    receipt.verdict !== expectedVerdict ||
    receipt.checks.allStagesPassed !==
      (receipt.stages.every((stage) => stage.status === "PASS") ? "PASS" : "FAIL")
  ) {
    fail("RECEIPT_INVALID", "Readiness verdict is inconsistent");
  }
  const expectedEvidenceBinding = sha256(
    canonicalJson({
      certificationMatrixSha256: receipt.certificationMatrixSha256,
      reportDigests: receipt.reportDigests,
    }),
  );
  if (receipt.evidenceBindingSha256 !== expectedEvidenceBinding) {
    fail("RECEIPT_INVALID", "Readiness evidence binding is invalid");
  }
  const digestValues = STAGE_ORDER.map((stage) => receipt.reportDigests[stage]);
  if (
    digestValues.some(
      (value) => value !== null && !SHA256_PATTERN.test(value ?? ""),
    ) ||
    receipt.checks.threeDistinctReports !==
      (digestValues.every((value) => typeof value === "string") &&
      new Set(digestValues).size === STAGE_ORDER.length
        ? "PASS"
        : "FAIL")
  ) {
    fail("RECEIPT_INVALID", "Readiness report digest inventory is invalid");
  }
  const expectedPrivacy = {
    pathsIncluded: false,
    executionIdentifiersIncluded: false,
    serialsIncluded: false,
    accountsIncluded: false,
    processIdentifiersIncluded: false,
    hostnamesIncluded: false,
  };
  const expectedEffects = {
    schedulerExecuted: false,
    physicalHardwareAccessed: false,
    gatePromotionExecuted: false,
  };
  if (
    canonicalJson(receipt.gate) !==
      canonicalJson({
        gateImpact: "NONE",
        b4: "PENDING",
        b5: "PENDING",
        b6: "BLOCKED",
        officialProgressChanged: false,
      }) ||
    canonicalJson(receipt.privacy) !== canonicalJson(expectedPrivacy) ||
    canonicalJson(receipt.effects) !== canonicalJson(expectedEffects)
  ) {
    fail("RECEIPT_INVALID", "Readiness isolation state is invalid");
  }
  const commitment = sha256(canonicalJson(receiptWithoutCommitment(receipt)));
  if (receipt.receiptCommitmentSha256 !== commitment) {
    fail("RECEIPT_TAMPERED", "Readiness receipt commitment is invalid");
  }
  assertRedacted(receipt);
  return receipt;
}

function safeReadFile(location, maximumBytes, { missingAllowed = false } = {}) {
  let descriptor;
  try {
    const before = fs.lstatSync(location);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      fail("UNSAFE_INPUT", "Evidence input must be one regular unlinked file");
    }
    if (before.size < 1 || before.size > maximumBytes) {
      fail("INPUT_SIZE_INVALID", "Evidence input size is invalid");
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    descriptor = fs.openSync(location, flags);
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      after.nlink !== 1 ||
      bytes.byteLength !== opened.size
    ) {
      fail("INPUT_CHANGED", "Evidence input changed while being read");
    }
    return bytes;
  } catch (error) {
    if (missingAllowed && error?.code === "ENOENT") return null;
    if (error instanceof V6OperationsReadinessError) throw error;
    fail("INPUT_UNAVAILABLE", "Evidence input is unavailable", { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function safeStageInput(location) {
  try {
    return safeReadFile(location, MAX_STAGE_REPORT_BYTES, { missingAllowed: true });
  } catch {
    return Buffer.from("invalid-stage-evidence", "utf8");
  }
}

function ensureOutputParent(outputPath) {
  const parent = path.resolve(path.dirname(outputPath));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const status = fs.lstatSync(parent);
  let realParent;
  try {
    realParent = fs.realpathSync(parent);
  } catch (error) {
    fail("OUTPUT_DIRECTORY_UNSAFE", "Receipt directory is unsafe", { cause: error });
  }
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    realParent !== parent ||
    (process.platform !== "win32" && (status.mode & 0o777) !== 0o700)
  ) {
    fail("OUTPUT_DIRECTORY_UNSAFE", "Receipt directory is unsafe");
  }
  return parent;
}

export function writeImmutableV6OperationsReadinessReceipt(outputPath, receipt) {
  parseV6OperationsReadinessReceipt(receipt);
  const encoded = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (encoded.byteLength > MAX_RECEIPT_BYTES) {
    fail("OUTPUT_SIZE_INVALID", "Readiness receipt exceeds its size limit");
  }
  const resolved = path.resolve(outputPath);
  const parent = ensureOutputParent(resolved);
  try {
    fs.lstatSync(resolved);
    fail("OUTPUT_EXISTS", "Readiness receipt already exists");
  } catch (error) {
    if (error instanceof V6OperationsReadinessError) throw error;
    if (error?.code !== "ENOENT") fail("OUTPUT_UNSAFE", "Receipt destination is unsafe");
  }
  const temporary = path.join(
    parent,
    `.${path.basename(resolved)}.${crypto.randomUUID()}.pending`,
  );
  let descriptor;
  let published = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, encoded);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, resolved);
    published = true;
    fs.unlinkSync(temporary);
    const directoryDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
    const status = fs.lstatSync(resolved);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      fail("OUTPUT_UNSAFE", "Published receipt is unsafe");
    }
    if (process.platform !== "win32" && (status.mode & 0o777) !== 0o600) {
      fail("OUTPUT_PERMISSIONS_INVALID", "Published receipt must use mode 0600");
    }
  } catch (error) {
    if (!published) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
    if (error instanceof V6OperationsReadinessError) throw error;
    if (error?.code === "EEXIST") fail("OUTPUT_EXISTS", "Readiness receipt already exists");
    fail("OUTPUT_WRITE_FAILED", "Readiness receipt could not be published", { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return resolved;
}

export function validV6OperationsStageFixture(
  stage,
  { startedAt, endedAt } = {},
) {
  if (!STAGE_ORDER.includes(stage)) fail("INVALID_STAGE", "Fixture stage is invalid");
  const index = STAGE_ORDER.indexOf(stage);
  const defaultStart = Date.parse("2026-08-06T10:00:00.000Z") + index * 600_000;
  const spec = STAGE_SPECS[stage];
  const devices = Array.from(
    { length: V6_MAX_HANDHELDS + V6_MAX_STATIONS },
    (_, deviceIndex) => ({
      id: `private-device-${deviceIndex + 1}`,
      kind: deviceIndex < V6_MAX_HANDHELDS ? "handheld" : "station",
      started: spec.actionsPerDevice,
      completed: spec.actionsPerDevice,
      succeeded: spec.actionsPerDevice,
      failed: 0,
      pendingAtEnd: 0,
    }),
  );
  return {
    runId: `private-${stage}-run`,
    backendPid: 1234,
    config: {
      profile: "v6-operations-30",
      handHeldCount: V6_MAX_HANDHELDS,
      stationCount: V6_MAX_STATIONS,
      v6OperationsActionsPerDevice: spec.actionsPerDevice,
      v6OperationsTotalActions: spec.totalActions,
      v6SchedulerContractVersion: V6_SCHEDULER_CONTRACT_VERSION,
      v6OperationsStage: stage,
      batteryNotificationIntervalMs: V6_BATTERY_NOTIFICATION_INTERVAL_MS,
      laneCrossExclusionOrdersEnabled: false,
      laneCrossExclusionTablesEnabled: false,
      laneCrossExclusionPaymentsEnabled: false,
      laneCrossExclusionPresenceEnabled: false,
      paymentLaneConcurrency: 2,
      v6OperationsEvidenceClass: "QUALIFYING_PROFILE",
      v6OperationsPromotionEligibility: "READINESS_ELIGIBLE",
      v6OperationsDiagnosticPaymentLaneConcurrency: null,
      v6OperationsDiagnostic: false,
      printLaneConcurrency: 1,
      ordersAsyncFlushIntervalMs: 500,
      hostPressurePreflight: {
        schemaVersion: 2,
        status: "PASS",
        enforced: true,
        sufficient: true,
        checks: { schedulerLoad: { ok: true } },
      },
    },
    v6OperationsProfile: {
      schedulerContractVersion: V6_SCHEDULER_CONTRACT_VERSION,
      stage,
      handheldCount: V6_MAX_HANDHELDS,
      stationCount: V6_MAX_STATIONS,
      deviceCount: V6_MAX_HANDHELDS + V6_MAX_STATIONS,
      actionsPerDevice: spec.actionsPerDevice,
      totalActions: spec.totalActions,
      totalStarted: spec.totalActions,
      totalCompleted: spec.totalActions,
      totalSucceeded: spec.totalActions,
      totalFailed: 0,
      devices,
      missingMobileActionTypes: [],
      mobileActionTypesWithoutSuccess: [],
      cadence: {
        cadenceBasis: "dispatch",
        mobileActionAverageGapMs: V6_DEVICE_ACTION_INTERVAL_MS,
        commandAverageGapMs: 7_500,
        earlyActionGaps: 0,
        earlyDispatchActionGaps: 0,
        mobileActionCadenceOk: true,
        commandCadenceOk: true,
      },
      actionLatencyMs: { p95ms: 2_500 },
      commandLatencyMs: { p95ms: 7_500 },
      persistedOrderTargetOk: true,
      persistedOrderGate: { ok: true },
      devicesMeetingPersistedOrderTarget: V6_MAX_HANDHELDS,
      runtimeGate: {
        ok: true,
        checks: Object.fromEntries(RUNTIME_CHECKS.map((field) => [field, true])),
      },
    },
    recorder: {
      startedAt: startedAt ?? new Date(defaultStart).toISOString(),
      endedAt: endedAt ?? new Date(defaultStart + 540_000).toISOString(),
      failures: [],
    },
    relationalAudit: {
      drained: true,
      eventOutboxUnpublished: 0,
      printSpoolPending: 0,
      fiscalOutboxPending: 0,
      paymentMirrorPending: 0,
      printSpoolFailedFinal: 0,
      fiscalOutboxProblem: 0,
      paymentMirrorFailed: 0,
      fiscalReceiptsNotIssued: 0,
      duplicatePaymentIdempotencyKeys: 0,
      duplicateFiscalAttemptScopes: 0,
    },
    mockIoMetrics: {
      battery: {
        ok: true,
        body: {
          notificationIntervalMs: V6_BATTERY_NOTIFICATION_INTERVAL_MS,
          devices: Array.from({ length: V6_MAX_HANDHELDS }, () => ({})),
        },
      },
    },
    cleanup: {
      sessions: { ok: true },
      processes: { verified: true, remaining: 0 },
      logs: { verified: true, openHandles: 0 },
    },
  };
}

function parseArguments(argv) {
  const options = {
    matrix: null,
    expectedMatrixSha256: null,
    micro: null,
    smoke: null,
    full: null,
    output: null,
    help: false,
  };
  const map = new Map([
    ["--matrix", "matrix"],
    ["--expected-matrix-sha256", "expectedMatrixSha256"],
    ["--micro", "micro"],
    ["--smoke", "smoke"],
    ["--full", "full"],
    ["--output", "output"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!map.has(argument) || seen.has(argument)) {
      fail("INVALID_ARGUMENT", "Readiness arguments are invalid");
    }
    seen.add(argument);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", "Readiness argument value is missing");
    }
    options[map.get(argument)] = value;
  }
  if (options.help) return options;
  for (const field of ["matrix", "micro", "smoke", "full", "output"]) {
    if (options[field] === null) fail("INVALID_ARGUMENT", "Required readiness input is missing");
    options[field] = path.resolve(options[field]);
  }
  if (
    options.expectedMatrixSha256 !== null &&
    !SHA256_PATTERN.test(options.expectedMatrixSha256)
  ) {
    fail("INVALID_ARGUMENT", "Expected matrix digest is invalid");
  }
  return options;
}

function usage() {
  return [
    "V6 operations load readiness receipt (NON_GATE)",
    "",
    "node scripts/v6-operations-readiness.mjs --matrix MATRIX.json \\",
    "  --micro REPORT.json --smoke REPORT.json --full REPORT.json \\",
    "  --output RECEIPT.json [--expected-matrix-sha256 SHA256]",
  ].join("\n");
}

function safeFailure(error) {
  return {
    schemaVersion: 1,
    product: "V6",
    phase: "OPERATIONS_LOAD_READINESS",
    mode: "NON_GATE_READINESS_FAILURE",
    verdict: "NOT_READY",
    failure: {
      code:
        error instanceof V6OperationsReadinessError
          ? error.code
          : "READINESS_UNEXPECTED_FAILURE",
    },
    gate: { gateImpact: "NONE", b4: "PENDING", b5: "PENDING", b6: "BLOCKED" },
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const matrixBytes = safeReadFile(options.matrix, MAX_MATRIX_BYTES);
    const matrix = parseJsonBytes(matrixBytes, "MATRIX_INVALID");
    const receipt = evaluateV6OperationsReadiness({
      certificationMatrix: matrix,
      expectedCertificationMatrixSha256: options.expectedMatrixSha256,
      reports: {
        micro: safeStageInput(options.micro),
        smoke: safeStageInput(options.smoke),
        full: safeStageInput(options.full),
      },
    });
    writeImmutableV6OperationsReadinessReceipt(options.output, receipt);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return receipt.verdict === "NON_GATE_PASS" ? 0 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(safeFailure(error))}\n`);
    return 1;
  }
}

const invoked = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (
  invoked !== null &&
  fs.existsSync(invoked) &&
  fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(invoked)
) {
  process.exitCode = await main();
}
