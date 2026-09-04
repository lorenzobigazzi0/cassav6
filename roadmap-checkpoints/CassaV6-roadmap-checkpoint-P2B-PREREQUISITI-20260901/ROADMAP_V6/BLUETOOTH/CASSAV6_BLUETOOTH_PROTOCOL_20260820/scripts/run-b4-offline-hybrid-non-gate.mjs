#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  B4PhysicalCollectionError,
  assertCollectionStateUnchanged,
  parseState,
  readStateSnapshot,
  withB4CollectionStateLock
} from "./collect-b4-physical-device.mjs";

export const B4_OFFLINE_HYBRID_NON_GATE_VERSION = "1.0.0";
export const REQUIRED_PHYSICAL_RECORDS = 2;
export const REQUIRED_SIMULATED_RECORDS = 8;
export const REQUIRED_TOTAL_SLOTS = 10;

const MODE = "OFFLINE_HYBRID_SIMULATION_NON_GATE";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ROADMAP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

export class B4OfflineHybridNonGateError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "B4OfflineHybridNonGateError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1) {
  throw new B4OfflineHybridNonGateError(code, message, exitCode);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireExactKeys(value, expectedKeys, code = "REPORT_CONTRACT_INVALID") {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(code, "The non-gate report contract is invalid");
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code, "The non-gate report contract is invalid");
  }
}

function requireExactValue(actual, expected) {
  if (actual !== expected) {
    fail("REPORT_CONTRACT_INVALID", "The non-gate report contract is invalid");
  }
}

function normalizePublicReport(report) {
  requireExactKeys(report, [
    "schemaVersion",
    "harnessVersion",
    "product",
    "phase",
    "mode",
    "evidenceClass",
    "verdict",
    "gateImpact",
    "simulation",
    "gates",
    "authorization",
    "effects",
    "privacy"
  ]);
  requireExactValue(report.schemaVersion, 1);
  requireExactValue(report.harnessVersion, B4_OFFLINE_HYBRID_NON_GATE_VERSION);
  requireExactValue(report.product, "V6");
  requireExactValue(report.phase, "B4");
  requireExactValue(report.mode, MODE);
  requireExactValue(report.evidenceClass, "NON_GATE_EVIDENCE");
  requireExactValue(report.verdict, "NON_GATE_PASS");
  requireExactValue(report.gateImpact, "NONE");

  requireExactKeys(report.simulation, [
    "kind",
    "verdict",
    "physicalRecordsReadOnly",
    "simulatedDevicesInMemory",
    "simulatedSlots",
    "logicalAggregateChecks"
  ]);
  requireExactValue(report.simulation.kind, "HYBRID_TWO_PHYSICAL_EIGHT_IN_MEMORY");
  requireExactValue(report.simulation.verdict, "PASS");
  requireExactValue(report.simulation.physicalRecordsReadOnly, 2);
  requireExactValue(report.simulation.simulatedDevicesInMemory, 8);
  if (
    !Array.isArray(report.simulation.simulatedSlots) ||
    report.simulation.simulatedSlots.length !== 8 ||
    report.simulation.simulatedSlots.some((slot, index) => slot !== index + 3)
  ) {
    fail("REPORT_CONTRACT_INVALID", "The non-gate report contract is invalid");
  }
  requireExactKeys(report.simulation.logicalAggregateChecks, [
    "slotsEvaluated",
    "orderValid",
    "uniquenessValid",
    "privateHashChainEvaluated",
    "privateHashChainExported",
    "redactedPlanSha256"
  ]);
  const checks = report.simulation.logicalAggregateChecks;
  requireExactValue(checks.slotsEvaluated, 10);
  requireExactValue(checks.orderValid, true);
  requireExactValue(checks.uniquenessValid, true);
  requireExactValue(checks.privateHashChainEvaluated, true);
  requireExactValue(checks.privateHashChainExported, false);
  if (typeof checks.redactedPlanSha256 !== "string" || !SHA256_PATTERN.test(checks.redactedPlanSha256)) {
    fail("REPORT_CONTRACT_INVALID", "The non-gate report contract is invalid");
  }

  requireExactKeys(report.gates, [
    "requiredDistinctPhysicalDevices",
    "distinctPhysicalDevices",
    "simulatedDevicesCountedTowardGate",
    "remainingDistinctPhysicalDevices",
    "b4TenPhysicalDeviceGate",
    "b5HundredSessionGate",
    "b6AndroidPairGate"
  ]);
  for (const [field, expected] of Object.entries({
    requiredDistinctPhysicalDevices: 10,
    distinctPhysicalDevices: 2,
    simulatedDevicesCountedTowardGate: 0,
    remainingDistinctPhysicalDevices: 8,
    b4TenPhysicalDeviceGate: "PENDING",
    b5HundredSessionGate: "PENDING",
    b6AndroidPairGate: "BLOCKED"
  })) requireExactValue(report.gates[field], expected);

  requireExactKeys(report.authorization, [
    "formalB0ThroughB3Passed",
    "physicalB4Passed",
    "b5_7DiagnosticPilotAuthorized",
    "b5OfficialCampaignAuthorized",
    "reasonCode"
  ]);
  for (const [field, expected] of Object.entries({
    formalB0ThroughB3Passed: false,
    physicalB4Passed: false,
    b5_7DiagnosticPilotAuthorized: false,
    b5OfficialCampaignAuthorized: false,
    reasonCode: "FORMAL_B0_B4_PREREQUISITES_NOT_PASSED"
  })) requireExactValue(report.authorization[field], expected);

  requireExactKeys(report.effects, [
    "physicalStateWritten",
    "physicalEvidenceFilesRead",
    "simulatedStatePersisted",
    "authoritativeGateExecuted",
    "gatePromoted"
  ]);
  for (const field of Object.keys(report.effects)) {
    requireExactValue(report.effects[field], false);
  }

  requireExactKeys(report.privacy, [
    "physicalIdentifiersIncluded",
    "privateRunIdentifiersIncluded",
    "physicalEvidenceHashesIncluded",
    "physicalEvidenceTimestampsIncluded",
    "filesystemLocationsIncluded"
  ]);
  for (const field of Object.keys(report.privacy)) {
    requireExactValue(report.privacy[field], false);
  }

  return deepFreeze({
    schemaVersion: 1,
    harnessVersion: B4_OFFLINE_HYBRID_NON_GATE_VERSION,
    product: "V6",
    phase: "B4",
    mode: MODE,
    evidenceClass: "NON_GATE_EVIDENCE",
    verdict: "NON_GATE_PASS",
    gateImpact: "NONE",
    simulation: {
      kind: "HYBRID_TWO_PHYSICAL_EIGHT_IN_MEMORY",
      verdict: "PASS",
      physicalRecordsReadOnly: 2,
      simulatedDevicesInMemory: 8,
      simulatedSlots: [3, 4, 5, 6, 7, 8, 9, 10],
      logicalAggregateChecks: {
        slotsEvaluated: 10,
        orderValid: true,
        uniquenessValid: true,
        privateHashChainEvaluated: true,
        privateHashChainExported: false,
        redactedPlanSha256: checks.redactedPlanSha256
      }
    },
    gates: {
      requiredDistinctPhysicalDevices: 10,
      distinctPhysicalDevices: 2,
      simulatedDevicesCountedTowardGate: 0,
      remainingDistinctPhysicalDevices: 8,
      b4TenPhysicalDeviceGate: "PENDING",
      b5HundredSessionGate: "PENDING",
      b6AndroidPairGate: "BLOCKED"
    },
    authorization: {
      formalB0ThroughB3Passed: false,
      physicalB4Passed: false,
      b5_7DiagnosticPilotAuthorized: false,
      b5OfficialCampaignAuthorized: false,
      reasonCode: "FORMAL_B0_B4_PREREQUISITES_NOT_PASSED"
    },
    effects: {
      physicalStateWritten: false,
      physicalEvidenceFilesRead: false,
      simulatedStatePersisted: false,
      authoritativeGateExecuted: false,
      gatePromoted: false
    },
    privacy: {
      physicalIdentifiersIncluded: false,
      privateRunIdentifiersIncluded: false,
      physicalEvidenceHashesIncluded: false,
      physicalEvidenceTimestampsIncluded: false,
      filesystemLocationsIncluded: false
    }
  });
}

function requireExactSyntheticCount(value) {
  if (value !== REQUIRED_SIMULATED_RECORDS) {
    fail(
      "SIMULATED_COUNT_INVALID",
      `The non-gate exercise requires exactly ${REQUIRED_SIMULATED_RECORDS} simulated devices`,
      2
    );
  }
}

function requireRandomBytes(randomBytes, size) {
  const bytes = randomBytes(size);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== size) {
    fail("SYNTHETIC_IDENTITY_INVALID", "Synthetic entropy is invalid");
  }
  return bytes;
}

function buildLogicalAggregate(
  physicalRecords,
  {
    simulatedCount = REQUIRED_SIMULATED_RECORDS,
    randomBytes = crypto.randomBytes
  } = {}
) {
  requireExactSyntheticCount(simulatedCount);
  if (!Array.isArray(physicalRecords)) {
    fail("PHYSICAL_STATE_INVALID", "Physical B4 records are invalid");
  }
  if (physicalRecords.length !== REQUIRED_PHYSICAL_RECORDS) {
    fail(
      "PHYSICAL_COUNT_MISMATCH",
      `The exercise requires exactly ${REQUIRED_PHYSICAL_RECORDS} physical records`,
      2
    );
  }
  if (typeof randomBytes !== "function") {
    fail("SYNTHETIC_IDENTITY_INVALID", "Synthetic entropy is unavailable");
  }

  const physicalEntries = physicalRecords.map((record, index) => {
    const expectedOrdinal = index + 1;
    if (
      record?.ordinal !== expectedOrdinal ||
      typeof record.deviceDigest !== "string" ||
      !SHA256_PATTERN.test(record.deviceDigest)
    ) {
      fail("PHYSICAL_ORDER_INVALID", "Physical B4 record order is invalid");
    }
    return {
      slot: expectedOrdinal,
      source: "PHYSICAL",
      internalIdentity: record.deviceDigest
    };
  });

  const simulatedEntries = [];
  for (let index = 0; index < simulatedCount; index += 1) {
    const slot = REQUIRED_PHYSICAL_RECORDS + index + 1;
    const entropy = requireRandomBytes(randomBytes, 32);
    const internalIdentity = sha256(
      Buffer.concat([
        Buffer.from(`V6:B4:NON_GATE:SYNTHETIC:${slot}:`, "utf8"),
        entropy
      ])
    );
    entropy.fill(0);
    simulatedEntries.push({
      slot,
      source: "SIMULATED",
      internalIdentity
    });
  }

  const entries = [...physicalEntries, ...simulatedEntries];
  const expectedOrder = Array.from(
    { length: REQUIRED_TOTAL_SLOTS },
    (_, index) => index + 1
  );
  const orderValid =
    entries.length === REQUIRED_TOTAL_SLOTS &&
    entries.every((entry, index) => entry.slot === expectedOrder[index]);
  const identities = new Set(entries.map((entry) => entry.internalIdentity));
  const uniquenessValid = identities.size === entries.length;
  if (!orderValid || !uniquenessValid) {
    fail(
      "LOGICAL_AGGREGATE_INVALID",
      "The in-memory aggregate failed order or uniqueness validation"
    );
  }

  const genesis = sha256("V6:B4:NON_GATE:HASH_CHAIN:GENESIS");
  let previous = genesis;
  const chain = entries.map((entry) => {
    const current = sha256(
      canonicalJson({
        previous,
        slot: entry.slot,
        source: entry.source,
        internalIdentity: entry.internalIdentity
      })
    );
    const node = { previous, current, entry };
    previous = current;
    return node;
  });
  let replayPrevious = genesis;
  const hashChainValid = chain.every((node) => {
    const replayCurrent = sha256(
      canonicalJson({
        previous: replayPrevious,
        slot: node.entry.slot,
        source: node.entry.source,
        internalIdentity: node.entry.internalIdentity
      })
    );
    const valid =
      node.previous === replayPrevious && node.current === replayCurrent;
    replayPrevious = replayCurrent;
    return valid;
  });
  if (!hashChainValid) {
    fail("LOGICAL_HASH_CHAIN_INVALID", "The in-memory hash chain is invalid");
  }

  const redactedPlan = entries.map(({ slot, source }) => ({ slot, source }));
  return Object.freeze({
    physicalRecordsEvaluated: physicalEntries.length,
    simulatedRecordsEvaluated: simulatedEntries.length,
    totalSlotsEvaluated: entries.length,
    orderValid,
    uniquenessValid,
    hashChainValid,
    redactedPlan,
    redactedPlanSha256: sha256(canonicalJson(redactedPlan))
  });
}

function collectPrivateStateTokens(state) {
  const tokens = new Set();
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.includes("runid") ||
        normalizedKey.includes("identity") ||
        normalizedKey.includes("digest") ||
        normalizedKey.includes("serial") ||
        normalizedKey.includes("alias") ||
        normalizedKey.includes("path") ||
        normalizedKey.includes("model") ||
        normalizedKey.endsWith("sha256") ||
        normalizedKey.endsWith("at")
      ) {
        tokens.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, key));
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childValue, childKey);
      }
    }
  };
  visit(state);
  return tokens;
}

function assertRedactedReport(report, state) {
  const serialized = canonicalJson(report);
  for (const token of collectPrivateStateTokens(state)) {
    if (token.length > 0 && serialized.includes(token)) {
      fail("REPORT_REDACTION_FAILED", "The non-gate report is not redacted");
    }
  }
  return report;
}

export function buildB4OfflineHybridNonGateReport(
  currentState,
  options = {}
) {
  const state = parseState(currentState);
  const aggregate = buildLogicalAggregate(state.records, options);
  const report = {
    schemaVersion: 1,
    harnessVersion: B4_OFFLINE_HYBRID_NON_GATE_VERSION,
    product: "V6",
    phase: "B4",
    mode: MODE,
    evidenceClass: "NON_GATE_EVIDENCE",
    verdict: "NON_GATE_PASS",
    gateImpact: "NONE",
    simulation: {
      kind: "HYBRID_TWO_PHYSICAL_EIGHT_IN_MEMORY",
      verdict: "PASS",
      physicalRecordsReadOnly: aggregate.physicalRecordsEvaluated,
      simulatedDevicesInMemory: aggregate.simulatedRecordsEvaluated,
      simulatedSlots: aggregate.redactedPlan
        .filter((entry) => entry.source === "SIMULATED")
        .map((entry) => entry.slot),
      logicalAggregateChecks: {
        slotsEvaluated: aggregate.totalSlotsEvaluated,
        orderValid: aggregate.orderValid,
        uniquenessValid: aggregate.uniquenessValid,
        privateHashChainEvaluated: aggregate.hashChainValid,
        privateHashChainExported: false,
        redactedPlanSha256: aggregate.redactedPlanSha256
      }
    },
    gates: {
      requiredDistinctPhysicalDevices: REQUIRED_TOTAL_SLOTS,
      distinctPhysicalDevices: aggregate.physicalRecordsEvaluated,
      simulatedDevicesCountedTowardGate: 0,
      remainingDistinctPhysicalDevices:
        REQUIRED_TOTAL_SLOTS - aggregate.physicalRecordsEvaluated,
      b4TenPhysicalDeviceGate: "PENDING",
      b5HundredSessionGate: "PENDING",
      b6AndroidPairGate: "BLOCKED"
    },
    authorization: {
      formalB0ThroughB3Passed: false,
      physicalB4Passed: false,
      b5_7DiagnosticPilotAuthorized: false,
      b5OfficialCampaignAuthorized: false,
      reasonCode: "FORMAL_B0_B4_PREREQUISITES_NOT_PASSED"
    },
    effects: {
      physicalStateWritten: false,
      physicalEvidenceFilesRead: false,
      simulatedStatePersisted: false,
      authoritativeGateExecuted: false,
      gatePromoted: false
    },
    privacy: {
      physicalIdentifiersIncluded: false,
      privateRunIdentifiersIncluded: false,
      physicalEvidenceHashesIncluded: false,
      physicalEvidenceTimestampsIncluded: false,
      filesystemLocationsIncluded: false
    }
  };
  return assertRedactedReport(normalizePublicReport(report), state);
}

function normalizeStateReadError(error) {
  if (error instanceof B4OfflineHybridNonGateError) return error;
  if (error instanceof B4PhysicalCollectionError) {
    return new B4OfflineHybridNonGateError(
      error.code,
      error.message,
      error.exitCode
    );
  }
  return new B4OfflineHybridNonGateError(
    "PHYSICAL_STATE_READ_FAILED",
    "The private physical B4 state cannot be read safely"
  );
}

export async function runB4OfflineHybridNonGate(
  statePath,
  {
    simulatedCount = REQUIRED_SIMULATED_RECORDS,
    randomBytes = crypto.randomBytes,
    beforeStabilityCheck = async () => undefined,
    outputPath = null,
    afterOutputPublish = () => undefined,
    afterTemporaryOpen = () => undefined
  } = {}
) {
  if (typeof statePath !== "string" || statePath.length === 0) {
    fail("INVALID_ARGUMENT", "A private B4 state is required");
  }
  if (typeof beforeStabilityCheck !== "function") {
    fail("INVALID_ARGUMENT", "The stability hook is invalid");
  }
  if (typeof afterOutputPublish !== "function") {
    fail("INVALID_ARGUMENT", "The output hook is invalid");
  }
  if (typeof afterTemporaryOpen !== "function") {
    fail("INVALID_ARGUMENT", "The temporary output hook is invalid");
  }
  if (outputPath !== null && (typeof outputPath !== "string" || outputPath.length === 0)) {
    fail("INVALID_ARGUMENT", "The output report location is invalid");
  }
  const resolvedStatePath = path.resolve(statePath);
  const resolvedOutputPath = outputPath === null ? null : path.resolve(outputPath);
  if (resolvedOutputPath !== null) {
    assertNonGateOutputSeparation(resolvedStatePath, resolvedOutputPath);
    inspectOutputDestination(resolvedOutputPath);
  }
  try {
    return await withB4CollectionStateLock(resolvedStatePath, async () => {
      const snapshot = readStateSnapshot(resolvedStatePath);
      let report;
      let operationError = null;
      try {
        report = buildB4OfflineHybridNonGateReport(snapshot.state, {
          simulatedCount,
          randomBytes
        });
        await beforeStabilityCheck();
      } catch (error) {
        operationError = error;
      }

      try {
        assertCollectionStateUnchanged(resolvedStatePath, snapshot.fingerprint);
      } catch {
        fail(
          "STATE_CHANGED_DURING_SIMULATION",
          "The private physical B4 state changed during the non-gate exercise"
        );
      }
      if (operationError !== null) throw normalizeStateReadError(operationError);
      if (resolvedOutputPath !== null) {
        writeB4OfflineHybridReportNoOverwrite(resolvedOutputPath, report, {
          afterPublish: afterOutputPublish,
          afterTemporaryOpen
        });
      }
      return report;
    });
  } catch (error) {
    throw normalizeStateReadError(error);
  }
}

function pathIsAtOrInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative.length === 0 ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function assertNonGateOutputSeparation(statePath, outputPath) {
  if (
    pathIsAtOrInside(outputPath, path.dirname(statePath)) ||
    pathIsAtOrInside(outputPath, ROADMAP_ROOT)
  ) {
    fail(
      "OUTPUT_NOT_SEPARATED",
      "The non-gate output must remain outside physical state and package directories"
    );
  }
}

function assertNoSymlinkComponents(location) {
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
      fail("OUTPUT_PATH_UNSAFE", "The output location cannot be inspected safely");
    }
    if (status.isSymbolicLink()) {
      fail("OUTPUT_PATH_UNSAFE", "The output location must not contain links");
    }
  }
}

function inspectOutputDestination(outputPath) {
  const resolved = path.resolve(outputPath);
  if (pathIsAtOrInside(resolved, ROADMAP_ROOT)) {
    fail("OUTPUT_NOT_SEPARATED", "The non-gate output must remain outside the package");
  }
  assertNoSymlinkComponents(resolved);
  const parent = path.dirname(resolved);
  let parentStatus;
  try {
    parentStatus = fs.lstatSync(parent);
  } catch {
    fail("OUTPUT_DIRECTORY_INVALID", "The output directory is unavailable");
  }
  if (
    !parentStatus.isDirectory() ||
    parentStatus.isSymbolicLink() ||
    (process.platform !== "win32" && (parentStatus.mode & 0o777) !== 0o700) ||
    (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      parentStatus.uid !== process.getuid()
    )
  ) {
    fail("OUTPUT_DIRECTORY_INVALID", "The output directory is invalid");
  }
  try {
    const existing = fs.lstatSync(resolved);
    if (existing.isSymbolicLink() || existing.nlink !== 1) {
      fail("OUTPUT_PATH_UNSAFE", "The output location must not contain links");
    }
    fail("OUTPUT_ALREADY_EXISTS", "The output report already exists");
  } catch (error) {
    if (error instanceof B4OfflineHybridNonGateError) throw error;
    if (error?.code !== "ENOENT") {
      fail("OUTPUT_PATH_UNSAFE", "The output location cannot be inspected safely");
    }
  }
  return resolved;
}

function sameFileIdentity(status, identity) {
  return status.dev === identity.dev && status.ino === identity.ino;
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const directoryFlag = fs.constants.O_DIRECTORY ?? 0;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | directoryFlag);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function unlinkOwnedPath(location, identity) {
  let status;
  try {
    status = fs.lstatSync(location);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink() || !sameFileIdentity(status, identity)) {
    fail("OUTPUT_ROLLBACK_INCOMPLETE", "The non-gate output ownership changed");
  }
  fs.unlinkSync(location);
  return true;
}

function unlinkPrivateTemporaryWithoutIdentity(location) {
  let status;
  try {
    status = fs.lstatSync(location);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    fail("OUTPUT_ROLLBACK_INCOMPLETE", "The temporary output ownership changed");
  }
  fs.unlinkSync(location);
  return true;
}

function writeB4OfflineHybridReportNoOverwrite(
  outputPath,
  report,
  {
    afterPublish = () => undefined,
    afterTemporaryOpen = () => undefined
  } = {}
) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    fail("INVALID_ARGUMENT", "An output report location is required");
  }
  if (typeof afterPublish !== "function") {
    fail("INVALID_ARGUMENT", "The output hook is invalid");
  }
  if (typeof afterTemporaryOpen !== "function") {
    fail("INVALID_ARGUMENT", "The temporary output hook is invalid");
  }
  const destination = inspectOutputDestination(outputPath);
  const normalizedReport = normalizePublicReport(report);
  const content = `${JSON.stringify(normalizedReport, null, 2)}\n`;
  const parent = path.dirname(destination);
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.tmp-${process.pid}-${crypto.randomUUID()}`
  );
  let descriptor = null;
  let published = false;
  let committed = false;
  let identity = null;
  let temporaryCreated = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    temporaryCreated = true;
    afterTemporaryOpen(temporary);
    const temporaryStatus = fs.fstatSync(descriptor);
    identity = { dev: temporaryStatus.dev, ino: temporaryStatus.ino };
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, destination);
      published = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail("OUTPUT_ALREADY_EXISTS", "The output report already exists");
      }
      fail("OUTPUT_WRITE_FAILED", "The output report could not be published safely");
    }
    afterPublish(destination);
    const status = fs.lstatSync(destination);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      !sameFileIdentity(status, identity) ||
      status.nlink !== 2 ||
      (process.platform !== "win32" && (status.mode & 0o777) !== 0o600)
    ) {
      fail("OUTPUT_WRITE_FAILED", "The output report protection is invalid");
    }
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let publishedDescriptor;
    try {
      publishedDescriptor = fs.openSync(destination, fs.constants.O_RDONLY | noFollow);
      const openedStatus = fs.fstatSync(publishedDescriptor);
      if (!sameFileIdentity(openedStatus, identity) || openedStatus.nlink !== 2) {
        fail("OUTPUT_WRITE_FAILED", "The output report identity is invalid");
      }
      const stored = fs.readFileSync(publishedDescriptor, "utf8");
      if (stored !== content) {
        fail("OUTPUT_WRITE_FAILED", "The output report verification failed");
      }
    } finally {
      if (publishedDescriptor !== undefined) fs.closeSync(publishedDescriptor);
    }
    unlinkOwnedPath(temporary, identity);
    const finalStatus = fs.lstatSync(destination);
    if (
      !finalStatus.isFile() ||
      finalStatus.isSymbolicLink() ||
      !sameFileIdentity(finalStatus, identity) ||
      finalStatus.nlink !== 1 ||
      (process.platform !== "win32" && (finalStatus.mode & 0o777) !== 0o600)
    ) {
      fail("OUTPUT_WRITE_FAILED", "The final output report protection is invalid");
    }
    fsyncDirectory(parent);
    committed = true;
    return destination;
  } catch (error) {
    if (error instanceof B4OfflineHybridNonGateError) throw error;
    fail("OUTPUT_WRITE_FAILED", "The output report could not be written safely");
  } finally {
    let cleanupFailed = false;
    try {
      if (descriptor !== null) fs.closeSync(descriptor);
    } catch {
      cleanupFailed = true;
    }
    if (published && !committed && identity !== null) {
      try {
        unlinkOwnedPath(destination, identity);
      } catch {
        cleanupFailed = true;
      }
    }
    if (temporaryCreated) {
      try {
        if (identity === null) {
          unlinkPrivateTemporaryWithoutIdentity(temporary);
        } else {
          unlinkOwnedPath(temporary, identity);
        }
      } catch {
        cleanupFailed = true;
      }
    }
    if (!committed && temporaryCreated) {
      try {
        fsyncDirectory(parent);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      fail("OUTPUT_ROLLBACK_INCOMPLETE", "The non-gate output rollback is incomplete");
    }
  }
}

function parseArguments(argv) {
  const options = { mode: null, state: null, output: null };
  const modes = new Map([
    ["--run", "RUN"],
    ["--self-test", "SELF_TEST"],
    ["--help", "HELP"]
  ]);
  const values = new Map([
    ["--state", "state"],
    ["--output", "output"]
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) fail("INVALID_ARGUMENT", "Duplicate CLI option");
    seen.add(argument);
    if (modes.has(argument)) {
      if (options.mode !== null) {
        fail("INVALID_ARGUMENT", "Select exactly one operation");
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
  if (options.mode === null) fail("INVALID_ARGUMENT", "Select one operation");
  if (options.mode === "RUN" && options.state === null) {
    fail("INVALID_ARGUMENT", "--run requires --state");
  }
  if (options.mode !== "RUN" && (options.state !== null || options.output !== null)) {
    fail("INVALID_ARGUMENT", "This operation does not accept state or output options");
  }
  if (options.mode === "RUN") {
    options.state = path.resolve(options.state);
    if (options.output !== null) options.output = path.resolve(options.output);
    if (options.output !== null && options.output === options.state) {
      fail("INVALID_ARGUMENT", "The output must not overwrite the private state");
    }
  }
  return options;
}

function usage() {
  return [
    "V6 B4 offline hybrid non-gate exercise",
    "",
    "Usage:",
    "  node scripts/run-b4-offline-hybrid-non-gate.mjs --run --state PRIVATE.json [--output REPORT.json]",
    "  node scripts/run-b4-offline-hybrid-non-gate.mjs --self-test",
    "",
    "The runner requires two physical records and simulates eight additional",
    "devices only in memory. Simulated devices never count toward B4."
  ].join("\n");
}

export function runSelfTest() {
  const records = [
    { ordinal: 1, deviceDigest: "a".repeat(64) },
    { ordinal: 2, deviceDigest: "b".repeat(64) }
  ];
  const aggregate = buildLogicalAggregate(records, {
    randomBytes: (size) => Buffer.alloc(size, 0x5a)
  });
  const serialized = canonicalJson(aggregate.redactedPlan);
  if (
    aggregate.physicalRecordsEvaluated !== 2 ||
    aggregate.simulatedRecordsEvaluated !== 8 ||
    aggregate.totalSlotsEvaluated !== 10 ||
    !aggregate.orderValid ||
    !aggregate.uniquenessValid ||
    !aggregate.hashChainValid ||
    serialized.includes(records[0].deviceDigest) ||
    serialized.includes(records[1].deviceDigest)
  ) {
    fail("SELF_TEST_FAILED", "The offline hybrid self-test failed");
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B4_OFFLINE_HYBRID_NON_GATE_VERSION,
    product: "V6",
    phase: "B4",
    mode: "SELF_TEST",
    evidenceClass: "NON_GATE_EVIDENCE",
    simulationKind: "FULLY_SYNTHETIC_SELF_TEST",
    verdict: "PASS",
    gateImpact: "NONE",
    checksPassed: 8,
    simulatedDevicesCountedTowardGate: 0,
    gates: Object.freeze({
      b4TenPhysicalDeviceGate: "PENDING",
      b5HundredSessionGate: "PENDING",
      b6AndroidPairGate: "BLOCKED"
    })
  });
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    if (options.mode === "HELP") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.mode === "SELF_TEST") {
      process.stdout.write(`${JSON.stringify(runSelfTest(), null, 2)}\n`);
      return 0;
    }
    const report = await runB4OfflineHybridNonGate(options.state, {
      outputPath: options.output
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safeError = normalizeStateReadError(error);
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          harnessVersion: B4_OFFLINE_HYBRID_NON_GATE_VERSION,
          product: "V6",
          phase: "B4",
          mode: MODE,
          evidenceClass: "NON_GATE_EVIDENCE",
          verdict: "FAIL",
          gateImpact: "NONE",
          gates: {
            b4TenPhysicalDeviceGate: "PENDING",
            b5HundredSessionGate: "PENDING",
            b6AndroidPairGate: "BLOCKED"
          },
          failure: { code: safeError.code, message: safeError.message }
        },
        null,
        2
      )}\n`
    );
    return safeError.exitCode;
  }
}

const invokedPath =
  process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (
  invokedPath !== null &&
  fs.existsSync(invokedPath) &&
  fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(invokedPath)
) {
  process.exitCode = await main();
}
