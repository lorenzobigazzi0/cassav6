#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { DeviceRegistryV2 } from "../../shared/provisioning/device-registry-v2.mjs";
import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from
  "../../scripts/advanced-certification-targets.mjs";
import {
  loadB4MonitorAttestationParsers,
  validateB4MonitoredSlotAuthorization
} from "../../scripts/run-b4-monitored-slot-gate.mjs";
import {
  B4_3_MIN_EVIDENCE_DURATION_MS,
  B4_3_REQUIRED_DURATION_SECONDS,
  B4_REQUIRED_PHYSICAL_NODES,
  evaluateNodeLog,
  parseNodeLog
} from "./run-b4-raspberry-servicedata-gate.mjs";

export const B4_4_HARNESS_VERSION = "1.0.0";
export const B4_4_REQUIRED_DISTINCT_DEVICES = B4_REQUIRED_PHYSICAL_NODES;
export const B4_4_ALIAS_EPOCH_SECONDS = 60;
export const B4_4_ALIAS_CLOCK_OFFSETS_SECONDS = Object.freeze([
  -180,
  -120,
  -60,
  0,
  60,
  120
]);

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROTATING_ALIAS_PATTERN = /^[0-9a-f]{12}$/;
const EXPECTED_GATE = "B4_TEN_PHYSICAL_DEVICES";
const COLLECTOR_MODE = "PHYSICAL_TEN_DEVICE_SEQUENCE";
const COLLECTOR_PACKAGES = new Map(
  Object.entries(ADVANCED_CERTIFICATION_TARGETS.roles).map(
    ([role, target]) => [target.packageId, role]
  )
);
const BANNED_REPORT_KEYS = new Set([
  "address",
  "alias",
  "aliaskey",
  "aliaskeybase64url",
  "bluetoothaddress",
  "bootid",
  "deviceid",
  "logpath",
  "mac",
  "macaddress",
  "manifestpath",
  "nodeid",
  "payload",
  "rawlog",
  "rawpayload",
  "registrypath",
  "reportpath",
  "serial",
  "streamkey"
]);

export class B4TenDeviceGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "B4TenDeviceGateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new B4TenDeviceGateError(code, message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, code, message) {
  if (!isRecord(value)) fail(code, message);
  return value;
}

function assertExactKeys(value, expectedKeys, code, field) {
  const record = requireRecord(
    value,
    code,
    `${field} must be an object`
  );
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code, `${field} contains missing or unexpected properties`);
  }
  return record;
}

function requireSafeInteger(value, minimum, code, message) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(code, message);
  }
  return value;
}

function requireFiniteNumber(value, minimum, code, message) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum
  ) {
    fail(code, message);
  }
  return value;
}

function requireSha256(value, code, message) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(code, message);
  }
  return value;
}

function requireUuidV4(value, code, message) {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    fail(code, message);
  }
  return value;
}

function requireIsoUtc(value, code, message) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(code, message);
  }
  return value;
}

function parseJsonObject(raw, code, message) {
  try {
    return requireRecord(JSON.parse(raw), code, message);
  } catch (error) {
    if (error instanceof B4TenDeviceGateError) throw error;
    fail(code, message);
  }
}

function assertSafeRelativePath(value, field) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value !== value.trim() ||
    value.includes("\\") ||
    /[\u0000-\u001f:]/.test(value) ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    fail(
      "MANIFEST_INVALID",
      `${field} must be a portable relative path`
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    fail(
      "MANIFEST_INVALID",
      `${field} must not contain empty, current or parent segments`
    );
  }
  return value;
}

export function parseEvidenceManifest(raw) {
  if (
    typeof raw !== "string" ||
    raw.length < 1 ||
    Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES
  ) {
    fail(
      "MANIFEST_INVALID",
      "evidence manifest is empty or exceeds the size limit"
    );
  }
  const manifest = parseJsonObject(
    raw,
    "MANIFEST_INVALID",
    "evidence manifest is not valid JSON"
  );
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "gate",
      "collectionRunId",
      "certificationMatrixSha256",
      "collectorReport",
      "captures"
    ],
    "MANIFEST_INVALID",
    "manifest"
  );
  if (manifest.schemaVersion !== 2 || manifest.gate !== EXPECTED_GATE) {
    fail(
      "MANIFEST_INVALID",
      "evidence manifest does not match the B4 ten-device schema"
    );
  }
  const collectionRunId = requireUuidV4(
    manifest.collectionRunId,
    "MANIFEST_INVALID",
    "manifest collection run identifier is invalid"
  );
  const certificationMatrixSha256 = requireSha256(
    manifest.certificationMatrixSha256,
    "MANIFEST_INVALID",
    "manifest certification matrix digest is invalid"
  );
  if (
    certificationMatrixSha256 !==
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256
  ) {
    fail(
      "MANIFEST_INVALID",
      "manifest certification matrix is not the current certified matrix"
    );
  }
  if (
    !Array.isArray(manifest.captures) ||
    manifest.captures.length !== B4_4_REQUIRED_DISTINCT_DEVICES
  ) {
    fail(
      "MANIFEST_INVALID",
      `manifest must contain exactly ${B4_4_REQUIRED_DISTINCT_DEVICES} captures`
    );
  }

  const evidencePaths = new Set();
  const collectorReport = assertSafeRelativePath(
    manifest.collectorReport,
    "collectorReport"
  );
  if (!collectorReport.endsWith(".json")) {
    fail(
      "MANIFEST_INVALID",
      "collectorReport extension must be .json"
    );
  }
  evidencePaths.add(collectorReport);
  const captureRunIds = new Set();
  const captures = manifest.captures.map((capture, index) => {
    assertExactKeys(
      capture,
      [
        "slot",
        "captureRunId",
        "report",
        "log",
        "androidMonitor",
        "androidMonitorSha256",
        "raspberryMonitor",
        "raspberryMonitorSha256"
      ],
      "MANIFEST_INVALID",
      `captures[${index}]`
    );
    if (capture.slot !== index + 1) {
      fail(
        "MANIFEST_INVALID",
        "capture slots must be ordered consecutively from 1 to 10"
      );
    }
    const captureRunId = requireUuidV4(
      capture.captureRunId,
      "MANIFEST_INVALID",
      `captures[${index}].captureRunId is invalid`
    );
    if (
      captureRunId === collectionRunId ||
      captureRunIds.has(captureRunId)
    ) {
      fail(
        "MANIFEST_INVALID",
        "capture run identifiers must be unique and distinct from the collection run"
      );
    }
    captureRunIds.add(captureRunId);
    const report = assertSafeRelativePath(
      capture.report,
      `captures[${index}].report`
    );
    const log = assertSafeRelativePath(
      capture.log,
      `captures[${index}].log`
    );
    const androidMonitor = assertSafeRelativePath(
      capture.androidMonitor,
      `captures[${index}].androidMonitor`
    );
    const raspberryMonitor = assertSafeRelativePath(
      capture.raspberryMonitor,
      `captures[${index}].raspberryMonitor`
    );
    if (
      !report.endsWith(".json") ||
      !log.endsWith(".log") ||
      !androidMonitor.endsWith(".json") ||
      !raspberryMonitor.endsWith(".json")
    ) {
      fail(
        "MANIFEST_INVALID",
        "capture reports and monitor attestations must be JSON and logs must be .log"
      );
    }
    const androidMonitorSha256 = requireSha256(
      capture.androidMonitorSha256,
      "MANIFEST_INVALID",
      `captures[${index}].androidMonitorSha256 is invalid`
    );
    const raspberryMonitorSha256 = requireSha256(
      capture.raspberryMonitorSha256,
      "MANIFEST_INVALID",
      `captures[${index}].raspberryMonitorSha256 is invalid`
    );
    for (const evidencePath of [
      report,
      log,
      androidMonitor,
      raspberryMonitor
    ]) {
      if (evidencePaths.has(evidencePath)) {
        fail(
          "MANIFEST_INVALID",
          "capture evidence paths must be unique"
        );
      }
      evidencePaths.add(evidencePath);
    }
    return Object.freeze({
      slot: capture.slot,
      captureRunId,
      report,
      log,
      androidMonitor,
      androidMonitorSha256,
      raspberryMonitor,
      raspberryMonitorSha256
    });
  });

  return Object.freeze({
    schemaVersion: 2,
    gate: EXPECTED_GATE,
    collectionRunId,
    certificationMatrixSha256,
    collectorReport,
    captures: Object.freeze(captures)
  });
}

function resolveEvidencePath(manifestPath, relativePath) {
  const base = path.dirname(manifestPath);
  const resolved = path.resolve(base, ...relativePath.split("/"));
  const relative = path.relative(base, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(
      "MANIFEST_INVALID",
      "evidence path escapes the manifest directory"
    );
  }
  return resolved;
}

function samePath(first, second) {
  const normalizedFirst = path.resolve(first);
  const normalizedSecond = path.resolve(second);
  return process.platform === "win32"
    ? normalizedFirst.toLowerCase() === normalizedSecond.toLowerCase()
    : normalizedFirst === normalizedSecond;
}

function assertNoSymlinkPathComponents(filePath, role) {
  const resolved = path.resolve(filePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep)) {
    if (component.length === 0) continue;
    current = path.join(current, component);
    let status;
    try {
      status = fs.lstatSync(current);
    } catch {
      fail("EVIDENCE_FILE_UNAVAILABLE", `${role} path could not be inspected`);
    }
    if (status.isSymbolicLink()) {
      fail("EVIDENCE_FILE_INVALID", `${role} path must not contain symlinks`);
    }
  }
}

export function readPrivateRegularFile(filePath, maximumBytes, role) {
  const noFollow =
    process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0;
  let descriptor;
  try {
    assertNoSymlinkPathComponents(filePath, role);
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) {
      fail("EVIDENCE_FILE_INVALID", `${role} must be a regular file`);
    }
    if (before.size < 1 || before.size > maximumBytes) {
      fail(
        "EVIDENCE_FILE_INVALID",
        `${role} is empty or exceeds the size limit`
      );
    }
    if (
      process.platform !== "win32" &&
      (
        (before.mode & 0o777) !== 0o600 ||
        (
          typeof process.getuid === "function" &&
          before.uid !== process.getuid()
        )
      )
    ) {
      fail(
        "EVIDENCE_FILE_NOT_PRIVATE",
        `${role} must be owned by the gate user with mode 0600`
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    assertNoSymlinkPathComponents(filePath, role);
    const pathStatus = fs.lstatSync(filePath);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.nlink !== after.nlink ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      after.dev !== pathStatus.dev ||
      after.ino !== pathStatus.ino ||
      after.size !== pathStatus.size ||
      after.mtimeMs !== pathStatus.mtimeMs ||
      after.ctimeMs !== pathStatus.ctimeMs ||
      bytes.byteLength !== before.size
    ) {
      fail("EVIDENCE_FILE_CHANGED", `${role} changed while it was read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof B4TenDeviceGateError) throw error;
    fail("EVIDENCE_FILE_UNAVAILABLE", `${role} could not be read safely`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertStoredB43Report(report, reevaluated, sourceLogSha256) {
  if (
    report.schemaVersion !== 1 ||
    report.harnessVersion !== "1.0.0" ||
    report.product !== "V6" ||
    report.phase !== "B4.3" ||
    report.mode !== "PHYSICAL_SINGLE_ADVERTISER" ||
    report.verdict !== "PASS" ||
    report.sourceLogSha256 !== sourceLogSha256 ||
    report.activeV4Changes !== false
  ) {
    fail(
      "CAPTURE_REPORT_INVALID",
      "stored capture is not a passing physical B4.3 report"
    );
  }
  requireIsoUtc(
    report.generatedAt,
    "CAPTURE_REPORT_INVALID",
    "stored capture timestamp is invalid"
  );
  const measurement = assertExactKeys(
    report.measurement,
    ["requiredDurationSeconds", "wallClockDurationMs"],
    "CAPTURE_REPORT_INVALID",
    "capture measurement"
  );
  if (
    measurement.requiredDurationSeconds !==
      B4_3_REQUIRED_DURATION_SECONDS ||
    requireFiniteNumber(
      measurement.wallClockDurationMs,
      B4_3_REQUIRED_DURATION_SECONDS * 1_000,
      "CAPTURE_REPORT_INVALID",
      "capture wall-clock duration is too short"
    ) <
      B4_3_REQUIRED_DURATION_SECONDS * 1_000
  ) {
    fail(
      "CAPTURE_REPORT_INVALID",
      "capture did not cover the required physical duration"
    );
  }
  if (
    report.gate?.serviceDataLive !== "PASS" ||
    report.gate?.controlledPhysicalAdvertisers !== 1 ||
    report.gate?.requiredDistinctPhysicalNodes !==
      B4_4_REQUIRED_DISTINCT_DEVICES ||
    report.gate?.b4TenNodeGate !== "PENDING"
  ) {
    fail(
      "CAPTURE_REPORT_INVALID",
      "stored capture does not preserve the B4.3 gate boundary"
    );
  }
  if (
    report.privacy?.bluetoothAddressesIncluded !== false ||
    report.privacy?.rotatingAliasesIncluded !== false ||
    report.privacy?.stableNodeIdsIncluded !== false ||
    report.privacy?.rawPayloadsIncluded !== false
  ) {
    fail(
      "CAPTURE_REPORT_INVALID",
      "stored capture privacy contract is invalid"
    );
  }
  if (
    requireFiniteNumber(
      report.lifecycle?.durationMs,
      B4_3_MIN_EVIDENCE_DURATION_MS,
      "CAPTURE_REPORT_INVALID",
      "capture node lifecycle is too short"
    ) < B4_3_MIN_EVIDENCE_DURATION_MS ||
    requireSafeInteger(
      report.serviceData?.observationsAccepted,
      1,
      "CAPTURE_REPORT_INVALID",
      "capture contains no accepted ServiceData"
    ) < 1 ||
    requireSafeInteger(
      report.serviceData?.expiredStreamsRemoved,
      1,
      "CAPTURE_REPORT_INVALID",
      "capture did not exercise stream expiry"
    ) < 1 ||
    requireSafeInteger(
      report.serviceData?.peersPruned,
      1,
      "CAPTURE_REPORT_INVALID",
      "capture did not exercise peer pruning"
    ) < 1
  ) {
    fail(
      "CAPTURE_REPORT_INVALID",
      "stored capture misses required physical evidence"
    );
  }
  const { measurement: _measurement, ...storedBaseReport } = report;
  if (!isDeepStrictEqual(storedBaseReport, reevaluated)) {
    fail(
      "CAPTURE_REPORT_MISMATCH",
      "stored capture report differs from its re-evaluated source log"
    );
  }
  return measurement;
}

function extractStoppedAliases(rawLog) {
  const { stopped } = parseNodeLog(rawLog);
  const peers = stopped?.peers?.peers;
  if (!Array.isArray(peers) || peers.length < 1) {
    fail(
      "CAPTURE_IDENTITY_MISSING",
      "capture contains no final anonymous peer identity"
    );
  }
  const aliases = new Set();
  for (const peer of peers) {
    const alias = peer?.advertisement?.rotatingAlias;
    if (typeof alias !== "string" || !ROTATING_ALIAS_PATTERN.test(alias)) {
      fail(
        "CAPTURE_IDENTITY_INVALID",
        "capture contains a malformed rotating identity"
      );
    }
    aliases.add(alias);
  }
  return Object.freeze([...aliases].sort());
}

export function loadCaptureEvidence({
  slot,
  reportBytes,
  logBytes
}) {
  requireSafeInteger(
    slot,
    1,
    "CAPTURE_INVALID",
    "capture slot is invalid"
  );
  if (!Buffer.isBuffer(reportBytes) || !Buffer.isBuffer(logBytes)) {
    fail(
      "CAPTURE_INVALID",
      "capture evidence must be supplied as immutable file bytes"
    );
  }
  const reportRaw = reportBytes.toString("utf8");
  const logRaw = logBytes.toString("utf8");
  const report = parseJsonObject(
    reportRaw,
    "CAPTURE_REPORT_INVALID",
    "capture report is not valid JSON"
  );
  const sourceLogSha256 = sha256(logBytes);
  let reevaluated;
  try {
    reevaluated = evaluateNodeLog(logRaw, {
      generatedAt: report.generatedAt,
      sourceLogSha256
    });
  } catch {
    fail(
      "CAPTURE_REVALIDATION_FAILED",
      `capture slot ${slot} failed B4.3 source-log validation`
    );
  }
  const measurement = assertStoredB43Report(
    report,
    reevaluated,
    sourceLogSha256
  );
  const aliases = extractStoppedAliases(logRaw);
  const endTimeMs = Date.parse(report.generatedAt);
  const startTimeMs = endTimeMs - measurement.wallClockDurationMs;
  if (!Number.isFinite(startTimeMs) || startTimeMs < 0) {
    fail(
      "CAPTURE_TIME_INVALID",
      "capture time window is invalid"
    );
  }
  return Object.freeze({
    slot,
    generatedAt: report.generatedAt,
    startTimeMs,
    endTimeMs,
    aliases,
    sourceReportSha256: sha256(reportBytes),
    sourceLogSha256,
    wallClockDurationMs: measurement.wallClockDurationMs,
    lifecycleDurationMs: reevaluated.lifecycle.durationMs,
    observationsAccepted: reevaluated.serviceData.observationsAccepted,
    prunePasses: reevaluated.serviceData.prunePasses,
    expiredStreamsRemoved:
      reevaluated.serviceData.expiredStreamsRemoved,
    peersPruned: reevaluated.serviceData.peersPruned,
    nodeKinds: Object.freeze([...reevaluated.serviceData.nodeKinds]),
    rssiDbm: Object.freeze({ ...reevaluated.serviceData.rssiDbm })
  });
}

export function validateCaptureMonitorEvidence(
  {
    slot,
    collectionRunId,
    captureRunId,
    certificationMatrixSha256,
    collectorDevice,
    raspberryReportBytes,
    androidMonitorBytes,
    raspberryMonitorBytes,
    expectedAndroidMonitorSha256,
    expectedRaspberryMonitorSha256
  },
  {
    parseAndroidAttestation = null,
    parseRaspberryAttestation = null
  } = {}
) {
  requireSafeInteger(
    slot,
    1,
    "MONITOR_EVIDENCE_INVALID",
    "monitor evidence slot is invalid"
  );
  requireUuidV4(
    collectionRunId,
    "MONITOR_EVIDENCE_INVALID",
    "monitor collection run identifier is invalid"
  );
  requireUuidV4(
    captureRunId,
    "MONITOR_EVIDENCE_INVALID",
    "monitor capture run identifier is invalid"
  );
  if (collectionRunId === captureRunId) {
    fail(
      "MONITOR_EVIDENCE_INVALID",
      "monitor collection and capture identifiers must be distinct"
    );
  }
  if (
    certificationMatrixSha256 !==
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256
  ) {
    fail(
      "MONITOR_EVIDENCE_INVALID",
      "monitor evidence is bound to a different certification matrix"
    );
  }
  if (
    !Buffer.isBuffer(raspberryReportBytes) ||
    !Buffer.isBuffer(androidMonitorBytes) ||
    !Buffer.isBuffer(raspberryMonitorBytes) ||
    typeof parseAndroidAttestation !== "function" ||
    typeof parseRaspberryAttestation !== "function"
  ) {
    fail(
      "MONITOR_EVIDENCE_INVALID",
      "complete canonical monitor evidence is required"
    );
  }
  const androidMonitorSha256 = sha256(androidMonitorBytes);
  const raspberryMonitorSha256 = sha256(raspberryMonitorBytes);
  if (
    androidMonitorSha256 !== expectedAndroidMonitorSha256 ||
    raspberryMonitorSha256 !== expectedRaspberryMonitorSha256
  ) {
    fail(
      "MONITOR_EVIDENCE_HASH_MISMATCH",
      `capture slot ${slot} monitor hash does not match the private manifest`
    );
  }
  const target = requireRecord(
    collectorDevice,
    "MONITOR_EVIDENCE_INVALID",
    `capture slot ${slot} collector target is invalid`
  );
  if (
    target.ordinal !== slot ||
    target.packageName !== ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId ||
    !Number.isSafeInteger(target.androidApi) ||
    target.androidApi < 33
  ) {
    fail(
      "MONITOR_EVIDENCE_TARGET_MISMATCH",
      `capture slot ${slot} monitor target is not the certified handheld`
    );
  }
  const raspberryReport = parseJsonObject(
    raspberryReportBytes.toString("utf8"),
    "MONITOR_EVIDENCE_INVALID",
    `capture slot ${slot} Raspberry report is invalid`
  );
  let authorization;
  try {
    authorization = validateB4MonitoredSlotAuthorization(
      {
        collectorState: {
          schemaVersion: 2,
          product: "V6",
          phase: "B4",
          runId: collectionRunId,
          certificationMatrixBinding: {
            matrixSha256: certificationMatrixSha256,
            matrix: ADVANCED_CERTIFICATION_TARGETS
          }
        },
        captureRunId,
        expectedPackageName: target.packageName,
        raspberryReport,
        androidAttestationText: androidMonitorBytes.toString("utf8"),
        raspberryAttestationText: raspberryMonitorBytes.toString("utf8")
      },
      { parseAndroidAttestation, parseRaspberryAttestation }
    );
  } catch {
    fail(
      "MONITOR_EVIDENCE_INVALID",
      `capture slot ${slot} failed canonical monitor binding or coverage validation`
    );
  }
  if (
    authorization.androidAttestationSha256 !== androidMonitorSha256 ||
    authorization.raspberryAttestationSha256 !== raspberryMonitorSha256 ||
    authorization.targetPackageName !== target.packageName ||
    authorization.targetAndroidApi !== target.androidApi
  ) {
    fail(
      "MONITOR_EVIDENCE_TARGET_MISMATCH",
      `capture slot ${slot} monitor authorization does not match the collector target`
    );
  }
  return Object.freeze({
    slot,
    sourceReportSha256: sha256(raspberryReportBytes),
    androidMonitorSha256,
    raspberryMonitorSha256,
    targetPackageName: authorization.targetPackageName,
    targetAndroidApi: authorization.targetAndroidApi,
    bindingAndCoverage: "PASS"
  });
}

export async function resolveCaptureIdentity(
  capture,
  registry,
  authorizedDevices
) {
  if (
    !Array.isArray(authorizedDevices) ||
    authorizedDevices.length < B4_4_REQUIRED_DISTINCT_DEVICES
  ) {
    fail(
      "INSUFFICIENT_AUTHORIZED_DEVICES",
      `registry has fewer than ${B4_4_REQUIRED_DISTINCT_DEVICES} active devices`
    );
  }
  const generatedAtSeconds = Math.floor(
    Date.parse(capture.generatedAt) / 1_000
  );
  if (!Number.isSafeInteger(generatedAtSeconds) || generatedAtSeconds < 0) {
    fail(
      "CAPTURE_TIME_INVALID",
      `capture slot ${capture.slot} has an invalid identity timestamp`
    );
  }

  const candidatesByAlias = new Map();
  try {
    for (const device of authorizedDevices) {
      for (const offset of B4_4_ALIAS_CLOCK_OFFSETS_SECONDS) {
        const timestampSeconds = generatedAtSeconds + offset;
        if (timestampSeconds < 0) continue;
        const alias = await registry.deriveRotatingAliasForNode({
          nodeId: device.nodeId,
          timestampSeconds,
          epochSeconds: B4_4_ALIAS_EPOCH_SECONDS
        });
        if (!ROTATING_ALIAS_PATTERN.test(alias)) {
          fail(
            "REGISTRY_ALIAS_INVALID",
            "registry returned a malformed rotating identity"
          );
        }
        const candidates =
          candidatesByAlias.get(alias) ?? new Set();
        candidates.add(device.nodeId);
        candidatesByAlias.set(alias, candidates);
      }
    }
  } catch (error) {
    if (error instanceof B4TenDeviceGateError) throw error;
    fail(
      "REGISTRY_ALIAS_RESOLUTION_FAILED",
      "private device identity correlation failed"
    );
  }

  const resolvedIdentities = new Set();
  for (const alias of capture.aliases) {
    const candidates = candidatesByAlias.get(alias);
    if (candidates === undefined || candidates.size === 0) {
      fail(
        "CAPTURE_IDENTITY_UNAUTHORIZED",
        `capture slot ${capture.slot} does not match an active registry device`
      );
    }
    if (candidates.size !== 1) {
      fail(
        "CAPTURE_IDENTITY_AMBIGUOUS",
        `capture slot ${capture.slot} has an ambiguous private identity`
      );
    }
    resolvedIdentities.add([...candidates][0]);
  }
  if (resolvedIdentities.size !== 1) {
    fail(
      "CAPTURE_MULTIPLE_IDENTITIES",
      `capture slot ${capture.slot} contains more than one physical device`
    );
  }
  return [...resolvedIdentities][0];
}

function validateNormalizedCapture(capture, expectedSlot) {
  requireRecord(
    capture,
    "CAPTURE_INVALID",
    `capture slot ${expectedSlot} is invalid`
  );
  if (capture.slot !== expectedSlot) {
    fail(
      "CAPTURE_ORDER_INVALID",
      "validated captures must remain ordered from slot 1 to 10"
    );
  }
  if (
    typeof capture.identityKey !== "string" ||
    capture.identityKey.length < 1
  ) {
    fail(
      "CAPTURE_IDENTITY_MISSING",
      `capture slot ${expectedSlot} has no resolved identity`
    );
  }
  requireSha256(
    capture.sourceReportSha256,
    "CAPTURE_HASH_INVALID",
    "capture report hash is invalid"
  );
  requireSha256(
    capture.sourceLogSha256,
    "CAPTURE_HASH_INVALID",
    "capture log hash is invalid"
  );
  requireFiniteNumber(
    capture.startTimeMs,
    0,
    "CAPTURE_TIME_INVALID",
    "capture start time is invalid"
  );
  requireFiniteNumber(
    capture.endTimeMs,
    capture.startTimeMs,
    "CAPTURE_TIME_INVALID",
    "capture end time is invalid"
  );
  requireFiniteNumber(
    capture.wallClockDurationMs,
    B4_3_REQUIRED_DURATION_SECONDS * 1_000,
    "CAPTURE_DURATION_INVALID",
    "capture wall-clock duration is too short"
  );
  requireFiniteNumber(
    capture.lifecycleDurationMs,
    B4_3_MIN_EVIDENCE_DURATION_MS,
    "CAPTURE_DURATION_INVALID",
    "capture lifecycle duration is too short"
  );
  requireSafeInteger(
    capture.observationsAccepted,
    1,
    "CAPTURE_METRICS_INVALID",
    "capture accepted-observation count is invalid"
  );
  requireSafeInteger(
    capture.prunePasses,
    1,
    "CAPTURE_METRICS_INVALID",
    "capture prune count is invalid"
  );
  requireSafeInteger(
    capture.expiredStreamsRemoved,
    1,
    "CAPTURE_METRICS_INVALID",
    "capture expiry count is invalid"
  );
  requireSafeInteger(
    capture.peersPruned,
    1,
    "CAPTURE_METRICS_INVALID",
    "capture peer-prune count is invalid"
  );
  if (
    !Array.isArray(capture.nodeKinds) ||
    capture.nodeKinds.length < 1 ||
    capture.nodeKinds.some(
      (nodeKind) => !["handheld", "station"].includes(nodeKind)
    )
  ) {
    fail(
      "CAPTURE_KIND_INVALID",
      "capture node kind is not an Android handheld or station"
    );
  }
  const rssi = requireRecord(
    capture.rssiDbm,
    "CAPTURE_RSSI_INVALID",
    "capture RSSI evidence is invalid"
  );
  requireFiniteNumber(
    rssi.minimum,
    -127,
    "CAPTURE_RSSI_INVALID",
    "capture minimum RSSI is invalid"
  );
  requireFiniteNumber(
    rssi.maximum,
    rssi.minimum,
    "CAPTURE_RSSI_INVALID",
    "capture maximum RSSI is invalid"
  );
  requireSafeInteger(
    rssi.samples,
    1,
    "CAPTURE_RSSI_INVALID",
    "capture RSSI sample count is invalid"
  );
}

export function assertReportRedacted(report, sensitiveValues = []) {
  const privacy = report?.privacy;
  if (
    privacy?.bluetoothAddressesIncluded !== false ||
    privacy?.rotatingAliasesIncluded !== false ||
    privacy?.stableNodeIdsIncluded !== false ||
    privacy?.bootIdsIncluded !== false ||
    privacy?.deviceSerialsIncluded !== false ||
    privacy?.evidencePathsIncluded !== false ||
    privacy?.registryPathIncluded !== false ||
    privacy?.rawPayloadsIncluded !== false
  ) {
    fail(
      "REPORT_PRIVACY_INVALID",
      "B4.4 report privacy contract is incomplete"
    );
  }

  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (BANNED_REPORT_KEYS.has(key.toLowerCase())) {
        fail(
          "REPORT_CONTAINS_PRIVATE_DATA",
          "B4.4 report contains a forbidden identity field"
        );
      }
      visit(nested);
    }
  };
  visit(report);

  const serialized = JSON.stringify(report).toLowerCase();
  for (const sensitiveValue of sensitiveValues) {
    if (
      typeof sensitiveValue === "string" &&
      sensitiveValue.length >= 4 &&
      serialized.includes(sensitiveValue.toLowerCase())
    ) {
      fail(
        "REPORT_CONTAINS_PRIVATE_DATA",
        "B4.4 report contains private evidence material"
      );
    }
  }
  return true;
}

export function validateCollectorReport(
  report,
  captures,
  { sourceCollectorReportSha256, monitoredSlots } = {}
) {
  assertExactKeys(
    report,
    [
      "schemaVersion",
      "harnessVersion",
      "product",
      "phase",
      "generatedAt",
      "mode",
      "operation",
      "verdict",
      "gate",
      "devices",
      "privacy",
      "activeV4Changes"
    ],
    "COLLECTOR_REPORT_INVALID",
    "collector report"
  );
  if (
    report.schemaVersion !== 1 ||
    report.harnessVersion !== "1.0.0" ||
    report.product !== "V6" ||
    report.phase !== "B4" ||
    report.mode !== COLLECTOR_MODE ||
    report.operation !== "MANIFEST_READY" ||
    report.verdict !== "PENDING" ||
    report.activeV4Changes !== false
  ) {
    fail(
      "COLLECTOR_REPORT_INVALID",
      "collector report is not ready for authoritative B4 verification"
    );
  }
  requireIsoUtc(
    report.generatedAt,
    "COLLECTOR_REPORT_INVALID",
    "collector report timestamp is invalid"
  );
  requireSha256(
    sourceCollectorReportSha256,
    "COLLECTOR_REPORT_INVALID",
    "collector report source hash is invalid"
  );
  assertExactKeys(
    report.gate,
    [
      "requiredDistinctPhysicalDevices",
      "distinctPhysicalDevices",
      "remainingPhysicalDevices",
      "collectionStatus",
      "authoritativeB4GateExecuted",
      "b4TenDeviceGate"
    ],
    "COLLECTOR_REPORT_INVALID",
    "collector gate"
  );
  if (
    report.gate.requiredDistinctPhysicalDevices !==
      B4_4_REQUIRED_DISTINCT_DEVICES ||
    report.gate.distinctPhysicalDevices !==
      B4_4_REQUIRED_DISTINCT_DEVICES ||
    report.gate.remainingPhysicalDevices !== 0 ||
    report.gate.collectionStatus !== "READY" ||
    report.gate.authoritativeB4GateExecuted !== false ||
    report.gate.b4TenDeviceGate !== "PENDING"
  ) {
    fail(
      "COLLECTOR_REPORT_INVALID",
      "collector did not verify ten distinct physical devices"
    );
  }
  assertExactKeys(
    report.privacy,
    [
      "hardwareSerialsIncluded",
      "adbTransportSerialsIncluded",
      "bluetoothAddressesIncluded",
      "rotatingAliasesIncluded",
      "stableNodeIdsIncluded",
      "deviceDigestsIncluded",
      "identityHmacKeyIncluded"
    ],
    "COLLECTOR_REPORT_INVALID",
    "collector privacy"
  );
  if (Object.values(report.privacy).some((value) => value !== false)) {
    fail(
      "COLLECTOR_REPORT_INVALID",
      "collector report privacy contract is invalid"
    );
  }
  if (
    !Array.isArray(report.devices) ||
    report.devices.length !== B4_4_REQUIRED_DISTINCT_DEVICES ||
    !Array.isArray(captures) ||
    captures.length !== B4_4_REQUIRED_DISTINCT_DEVICES ||
    !Array.isArray(monitoredSlots) ||
    monitoredSlots.length !== B4_4_REQUIRED_DISTINCT_DEVICES
  ) {
    fail(
      "COLLECTOR_REPORT_INVALID",
      "collector report, captures and monitor evidence must all contain ten slots"
    );
  }

  const reportHashes = new Set();
  const logHashes = new Set();
  for (const [index, device] of report.devices.entries()) {
    assertExactKeys(
      device,
      [
        "ordinal",
        "evidenceRecordId",
        "nodeKind",
        "packageName",
        "model",
        "androidApi",
        "recordedAt",
        "androidSampledAt",
        "raspberryGeneratedAt",
        "raspberryReportSha256",
        "raspberryLogSha256",
        "observationsAccepted",
        "lifecycleDurationMs",
        "wallClockDurationMs",
        "rssiDbm"
      ],
      "COLLECTOR_REPORT_INVALID",
      `collector devices[${index}]`
    );
    if (
      device.ordinal !== index + 1 ||
      COLLECTOR_PACKAGES.get(device.packageName) !== device.nodeKind ||
      typeof device.model !== "string" ||
      device.model.length < 1 ||
      !Number.isSafeInteger(device.androidApi) ||
      device.androidApi < 33
    ) {
      fail(
        "COLLECTOR_REPORT_INVALID",
        "collector device metadata is invalid"
      );
    }
    for (const timestamp of [
      device.recordedAt,
      device.androidSampledAt,
      device.raspberryGeneratedAt
    ]) {
      requireIsoUtc(
        timestamp,
        "COLLECTOR_REPORT_INVALID",
        "collector device timestamp is invalid"
      );
    }
    const reportHash = requireSha256(
      device.raspberryReportSha256,
      "COLLECTOR_REPORT_INVALID",
      "collector device report hash is invalid"
    );
    const logHash = requireSha256(
      device.raspberryLogSha256,
      "COLLECTOR_REPORT_INVALID",
      "collector device log hash is invalid"
    );
    if (reportHashes.has(reportHash) || logHashes.has(logHash)) {
      fail(
        "COLLECTOR_REPORT_INVALID",
        "collector report reuses physical evidence"
      );
    }
    reportHashes.add(reportHash);
    logHashes.add(logHash);
    if (
      captures[index].sourceReportSha256 !== reportHash ||
      captures[index].sourceLogSha256 !== logHash ||
      captures[index].nodeKinds.length !== 1 ||
      captures[index].nodeKinds[0] !== device.nodeKind ||
      monitoredSlots[index]?.slot !== index + 1 ||
      monitoredSlots[index]?.sourceReportSha256 !== reportHash ||
      monitoredSlots[index]?.targetPackageName !== device.packageName ||
      monitoredSlots[index]?.targetAndroidApi !== device.androidApi ||
      monitoredSlots[index]?.bindingAndCoverage !== "PASS"
    ) {
      fail(
        "COLLECTOR_EVIDENCE_MISMATCH",
        "collector and registry verifier do not reference the same captures"
      );
    }
  }

  return Object.freeze({
    sourceCollectorReportSha256,
    distinctPhysicalDevices: B4_4_REQUIRED_DISTINCT_DEVICES,
    hardwareIdentityProof: "PASS",
    evidenceHashBinding: "PASS",
    monitorContinuityBinding: "PASS"
  });
}

export function aggregateValidatedCaptures(
  captures,
  {
    generatedAt = new Date().toISOString(),
    collectorEvidence
  } = {}
) {
  requireIsoUtc(
    generatedAt,
    "REPORT_TIME_INVALID",
    "B4.4 report timestamp is invalid"
  );
  if (
    !Array.isArray(captures) ||
    captures.length !== B4_4_REQUIRED_DISTINCT_DEVICES
  ) {
    fail(
      "CAPTURE_COUNT_INVALID",
      `B4.4 requires exactly ${B4_4_REQUIRED_DISTINCT_DEVICES} validated captures`
    );
  }
  captures.forEach((capture, index) =>
    validateNormalizedCapture(capture, index + 1)
  );
  if (
    collectorEvidence?.distinctPhysicalDevices !==
      B4_4_REQUIRED_DISTINCT_DEVICES ||
    collectorEvidence?.hardwareIdentityProof !== "PASS" ||
    collectorEvidence?.evidenceHashBinding !== "PASS" ||
    collectorEvidence?.monitorContinuityBinding !== "PASS"
  ) {
    fail(
      "COLLECTOR_EVIDENCE_REQUIRED",
      "B4.4 requires the matching ten-device hardware collector PASS"
    );
  }
  requireSha256(
    collectorEvidence.sourceCollectorReportSha256,
    "COLLECTOR_EVIDENCE_REQUIRED",
    "collector evidence hash is invalid"
  );

  const identities = new Set();
  const evidenceHashes = new Set();
  let previousEndTimeMs = null;
  for (const capture of captures) {
    if (identities.has(capture.identityKey)) {
      fail(
        "DUPLICATE_PHYSICAL_DEVICE",
        "two capture slots resolve to the same physical device"
      );
    }
    identities.add(capture.identityKey);
    for (const hash of [
      capture.sourceReportSha256,
      capture.sourceLogSha256
    ]) {
      if (evidenceHashes.has(hash)) {
        fail(
          "DUPLICATE_EVIDENCE",
          "capture evidence is reused across B4.4 slots"
        );
      }
      evidenceHashes.add(hash);
    }
    if (
      previousEndTimeMs !== null &&
      capture.startTimeMs < previousEndTimeMs
    ) {
      fail(
        "CAPTURE_WINDOWS_OVERLAP",
        "physical capture windows overlap or are out of order"
      );
    }
    previousEndTimeMs = capture.endTimeMs;
  }

  const total = (field) =>
    captures.reduce((sum, capture) => sum + capture[field], 0);
  const nodeKinds = [
    ...new Set(captures.flatMap((capture) => capture.nodeKinds))
  ].sort();
  const report = {
    schemaVersion: 1,
    harnessVersion: B4_4_HARNESS_VERSION,
    product: "V6",
    phase: "B4.4",
    generatedAt,
    mode: "PHYSICAL_TEN_DISTINCT_ANDROID_DEVICES",
    verdict: "PASS",
    scope:
      "Ten hardware-distinct Android captures bound to ten distinct active B1 registry identities",
    collector: {
      sourceReportSha256:
        collectorEvidence.sourceCollectorReportSha256,
      distinctPhysicalDevices:
        collectorEvidence.distinctPhysicalDevices,
      hardwareIdentityProof: "PASS",
      evidenceHashBinding: "PASS",
      monitorContinuityBinding: "PASS"
    },
    captures: captures.map((capture) => ({
      slot: capture.slot,
      sourceReportSha256: capture.sourceReportSha256,
      sourceLogSha256: capture.sourceLogSha256,
      nodeKinds: [...capture.nodeKinds],
      wallClockDurationMs: capture.wallClockDurationMs,
      lifecycleDurationMs: capture.lifecycleDurationMs,
      observationsAccepted: capture.observationsAccepted,
      prunePasses: capture.prunePasses,
      expiredStreamsRemoved: capture.expiredStreamsRemoved,
      peersPruned: capture.peersPruned,
      identityResolved: true,
      cleanup: "PASS"
    })),
    totals: {
      sequentialCaptures: captures.length,
      distinctPhysicalDevices: identities.size,
      wallClockDurationMs: total("wallClockDurationMs"),
      lifecycleDurationMs: total("lifecycleDurationMs"),
      observationsAccepted: total("observationsAccepted"),
      prunePasses: total("prunePasses"),
      expiredStreamsRemoved: total("expiredStreamsRemoved"),
      peersPruned: total("peersPruned"),
      nodeKinds,
      rssiDbm: {
        minimum: Math.min(
          ...captures.map((capture) => capture.rssiDbm.minimum)
        ),
        maximum: Math.max(
          ...captures.map((capture) => capture.rssiDbm.maximum)
        ),
        samples: captures.reduce(
          (sum, capture) => sum + capture.rssiDbm.samples,
          0
        )
      }
    },
    checks: [
      {
        id: "b4.capture_count",
        status: "PASS",
        detail: "10 sequential physical captures"
      },
      {
        id: "b4.hardware_distinctness",
        status: "PASS",
        detail: "ADB collector verified 10 distinct physical devices"
      },
      {
        id: "b4.distinct_authorized_devices",
        status: "PASS",
        detail: "10 private registry identities resolved and distinct"
      },
      {
        id: "b4.evidence_integrity",
        status: "PASS",
        detail: "all B4.3 reports and source-log hashes revalidated"
      },
      {
        id: "b4.monitor_continuity",
        status: "PASS",
        detail: "canonical Android and Raspberry monitor coverage revalidated"
      },
      {
        id: "b4.cleanup",
        status: "PASS",
        detail: "all captures completed without scanner or D-Bus leaks"
      }
    ],
    gate: {
      b4: "PASS",
      requiredDistinctPhysicalDevices:
        B4_4_REQUIRED_DISTINCT_DEVICES,
      distinctPhysicalDevices: identities.size,
      sequentialCaptures: captures.length,
      hardwareDistinctness: "PASS",
      registryIdentityDistinctness: "PASS",
      b5: "PENDING"
    },
    privacy: {
      bluetoothAddressesIncluded: false,
      rotatingAliasesIncluded: false,
      stableNodeIdsIncluded: false,
      bootIdsIncluded: false,
      deviceSerialsIncluded: false,
      evidencePathsIncluded: false,
      registryPathIncluded: false,
      rawPayloadsIncluded: false
    },
    activeV4Changes: false
  };
  assertReportRedacted(report, captures.map((capture) => capture.identityKey));
  return Object.freeze(report);
}

function parseArguments(argv) {
  const options = {
    mode: "PHYSICAL_GATE",
    manifest: null,
    registry: null,
    output: null,
    help: false,
    selfTest: false
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) {
      fail("INVALID_ARGUMENT", `duplicate option: ${argument}`);
    }
    seen.add(argument);
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--self-test") {
      options.selfTest = true;
      options.mode = "SELF_TEST";
      continue;
    }
    if (!["--manifest", "--registry", "--output"].includes(argument)) {
      fail("INVALID_ARGUMENT", `unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `missing value for ${argument}`);
    }
    index += 1;
    options[argument.slice(2)] = path.resolve(value);
  }
  if ((options.help || options.selfTest) && argv.length !== 1) {
    fail(
      "INVALID_ARGUMENT",
      "--help and --self-test cannot be combined with other options"
    );
  }
  if (!options.help && !options.selfTest) {
    for (const name of ["manifest", "registry", "output"]) {
      if (options[name] === null) {
        fail("INVALID_ARGUMENT", `--${name} is required`);
      }
    }
    if (
      samePath(options.output, options.manifest) ||
      samePath(options.output, options.registry)
    ) {
      fail(
        "INVALID_ARGUMENT",
        "output must not overwrite the manifest or private registry"
      );
    }
  }
  return Object.freeze(options);
}

function atomicWrite(destination, content) {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${crypto
    .randomBytes(8)
    .toString("hex")}`;
  try {
    fs.writeFileSync(temporary, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeReport(report, destination = null) {
  const formatted = `${JSON.stringify(report, null, 2)}\n`;
  if (destination !== null) atomicWrite(destination, formatted);
  process.stdout.write(formatted);
}

function selfTestCapture(slot) {
  const startTimeMs = slot * 100_000;
  return Object.freeze({
    slot,
    identityKey: `private-test-identity-${slot}`,
    sourceReportSha256: sha256(`report-${slot}`),
    sourceLogSha256: sha256(`log-${slot}`),
    startTimeMs,
    endTimeMs: startTimeMs + 90_000,
    wallClockDurationMs: 90_000,
    lifecycleDurationMs: 89_500,
    observationsAccepted: 10 + slot,
    prunePasses: 90,
    expiredStreamsRemoved: 1,
    peersPruned: 1,
    nodeKinds: slot % 2 === 0 ? ["station"] : ["handheld"],
    rssiDbm: { minimum: -70, maximum: -50, samples: 1 }
  });
}

export function runSelfTest() {
  const captures = Array.from(
    { length: B4_4_REQUIRED_DISTINCT_DEVICES },
    (_, index) => selfTestCapture(index + 1)
  );
  const aggregate = aggregateValidatedCaptures(captures, {
    generatedAt: "2026-07-20T00:00:00.000Z",
    collectorEvidence: {
      sourceCollectorReportSha256: sha256("synthetic-collector-report"),
      distinctPhysicalDevices: B4_4_REQUIRED_DISTINCT_DEVICES,
      hardwareIdentityProof: "PASS",
      evidenceHashBinding: "PASS",
      monitorContinuityBinding: "PASS"
    }
  });
  if (
    aggregate.verdict !== "PASS" ||
    aggregate.gate.b4 !== "PASS" ||
    aggregate.gate.b5 !== "PENDING"
  ) {
    fail(
      "SELF_TEST_FAILED",
      "B4.4 self-test did not preserve gate boundaries"
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B4_4_HARNESS_VERSION,
    product: "V6",
    phase: "B4.4",
    mode: "SELF_TEST",
    verdict: "PASS",
    syntheticCaptures: captures.length,
    physicalEvidenceConsumed: false,
    privateRegistryAccessed: false,
    physicalRadioAccessed: false,
    b4GatePromoted: false,
    b5Started: false,
    activeV4Changes: false
  });
}

function usage() {
  return [
    "V6 B4.4 ten-device physical evidence gate",
    "",
    "Usage:",
    "  node scripts/run-b4-ten-device-gate.mjs --self-test",
    "  node scripts/run-b4-ten-device-gate.mjs \\",
    "    --manifest PRIVATE_MANIFEST.json \\",
    "    --registry /var/lib/cassav6-bluetooth/devices.json \\",
    "    --output b4-ten-device-gate.json",
    "",
    "The manifest and evidence files must be owner-only (0600) on Linux.",
    "A PASS requires 10 sequential B4.3 captures from 10 distinct active registry devices."
  ].join("\n");
}

function failureReport(options, error) {
  return {
    schemaVersion: 1,
    harnessVersion: B4_4_HARNESS_VERSION,
    product: "V6",
    phase: "B4.4",
    generatedAt: new Date().toISOString(),
    mode: options?.mode ?? "UNKNOWN",
    verdict: "FAIL",
    failure: {
      code: error.code,
      message: error.message
    },
    gate: {
      b4: "PENDING",
      b5: "PENDING"
    },
    privacy: {
      bluetoothAddressesIncluded: false,
      rotatingAliasesIncluded: false,
      stableNodeIdsIncluded: false,
      bootIdsIncluded: false,
      deviceSerialsIncluded: false,
      evidencePathsIncluded: false,
      registryPathIncluded: false,
      rawPayloadsIncluded: false
    },
    activeV4Changes: false
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  let safeOutput = null;
  try {
    options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.selfTest) {
      writeReport(runSelfTest());
      return 0;
    }

    const manifestBytes = readPrivateRegularFile(
      options.manifest,
      MAX_MANIFEST_BYTES,
      "evidence manifest"
    );
    const manifest = parseEvidenceManifest(manifestBytes.toString("utf8"));
    const collectorReportPath = resolveEvidencePath(
      options.manifest,
      manifest.collectorReport
    );
    const resolvedCaptures = manifest.captures.map((capture) => ({
      slot: capture.slot,
      captureRunId: capture.captureRunId,
      reportPath: resolveEvidencePath(options.manifest, capture.report),
      logPath: resolveEvidencePath(options.manifest, capture.log),
      androidMonitorPath: resolveEvidencePath(
        options.manifest,
        capture.androidMonitor
      ),
      androidMonitorSha256: capture.androidMonitorSha256,
      raspberryMonitorPath: resolveEvidencePath(
        options.manifest,
        capture.raspberryMonitor
      ),
      raspberryMonitorSha256: capture.raspberryMonitorSha256
    }));
    if (
      resolvedCaptures.some(
        (capture) =>
          samePath(options.output, capture.reportPath) ||
          samePath(options.output, capture.logPath) ||
          samePath(options.output, capture.androidMonitorPath) ||
          samePath(options.output, capture.raspberryMonitorPath)
      ) ||
      samePath(options.output, collectorReportPath)
    ) {
      fail(
        "INVALID_ARGUMENT",
        "output must not overwrite source evidence"
      );
    }
    safeOutput = options.output;

    const registry = new DeviceRegistryV2(options.registry);
    let inspection;
    try {
      inspection = await registry.inspect();
    } catch {
      fail(
        "REGISTRY_UNAVAILABLE",
        "private device registry could not be inspected"
      );
    }
    const authorizedDevices = inspection.devices.filter(
      (device) => device.revokedAt === null
    );
    if (
      authorizedDevices.length < B4_4_REQUIRED_DISTINCT_DEVICES
    ) {
      fail(
        "INSUFFICIENT_AUTHORIZED_DEVICES",
        `registry has fewer than ${B4_4_REQUIRED_DISTINCT_DEVICES} active devices`
      );
    }

    const collectorReportBytes = readPrivateRegularFile(
      collectorReportPath,
      MAX_REPORT_BYTES,
      "ten-device hardware collector report"
    );
    const collectorReport = parseJsonObject(
      collectorReportBytes.toString("utf8"),
      "COLLECTOR_REPORT_INVALID",
      "collector report is not valid JSON"
    );
    const monitorParsers = await loadB4MonitorAttestationParsers();

    const captures = [];
    const monitoredSlots = [];
    const sensitiveValues = [
      options.manifest,
      options.registry,
      collectorReportPath,
      manifest.collectionRunId,
      ...manifest.captures.map((capture) => capture.captureRunId),
      ...authorizedDevices.map((device) => device.nodeId)
    ];
    for (const source of resolvedCaptures) {
      const reportBytes = readPrivateRegularFile(
        source.reportPath,
        MAX_REPORT_BYTES,
        `capture slot ${source.slot} report`
      );
      const logBytes = readPrivateRegularFile(
        source.logPath,
        MAX_LOG_BYTES,
        `capture slot ${source.slot} log`
      );
      const androidMonitorBytes = readPrivateRegularFile(
        source.androidMonitorPath,
        MAX_REPORT_BYTES,
        `capture slot ${source.slot} Android monitor attestation`
      );
      const raspberryMonitorBytes = readPrivateRegularFile(
        source.raspberryMonitorPath,
        MAX_REPORT_BYTES,
        `capture slot ${source.slot} Raspberry monitor attestation`
      );
      const capture = loadCaptureEvidence({
        slot: source.slot,
        reportBytes,
        logBytes
      });
      const monitorEvidence = validateCaptureMonitorEvidence(
        {
          slot: source.slot,
          collectionRunId: manifest.collectionRunId,
          captureRunId: source.captureRunId,
          certificationMatrixSha256:
            manifest.certificationMatrixSha256,
          collectorDevice: collectorReport.devices?.[source.slot - 1],
          raspberryReportBytes: reportBytes,
          androidMonitorBytes,
          raspberryMonitorBytes,
          expectedAndroidMonitorSha256: source.androidMonitorSha256,
          expectedRaspberryMonitorSha256: source.raspberryMonitorSha256
        },
        monitorParsers
      );
      monitoredSlots.push(monitorEvidence);
      const identityKey = await resolveCaptureIdentity(
        capture,
        registry,
        authorizedDevices
      );
      captures.push(Object.freeze({ ...capture, identityKey }));
      sensitiveValues.push(
        source.reportPath,
        source.logPath,
        source.androidMonitorPath,
        source.raspberryMonitorPath,
        identityKey,
        ...capture.aliases
      );
    }

    const collectorEvidence = validateCollectorReport(
      collectorReport,
      captures,
      {
        sourceCollectorReportSha256: sha256(collectorReportBytes),
        monitoredSlots
      }
    );
    const report = aggregateValidatedCaptures(captures, {
      collectorEvidence
    });
    assertReportRedacted(report, sensitiveValues);
    writeReport(report, safeOutput);
    return 0;
  } catch (error) {
    const safeError =
      error instanceof B4TenDeviceGateError
        ? error
        : new B4TenDeviceGateError(
            "B4_TEN_DEVICE_GATE_FAILED",
            "B4.4 ten-device gate failed"
          );
    const report = failureReport(options, safeError);
    try {
      assertReportRedacted(report);
      writeReport(report, safeOutput);
    } catch {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
