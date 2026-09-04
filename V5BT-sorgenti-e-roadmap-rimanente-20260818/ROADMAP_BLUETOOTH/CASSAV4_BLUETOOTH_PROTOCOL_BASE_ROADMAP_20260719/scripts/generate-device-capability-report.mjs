#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const B0_REQUIRED_CHECKS = Object.freeze([
  "scan",
  "advertise",
  "gattClient",
  "gattServer",
  "scanAdvertiseConcurrent",
  "wifiBleCoexistence",
  "backgroundForeground"
]);

export const B0_EVIDENCE_CLASSES = Object.freeze([
  "FORMAL",
  "SUPPLEMENTAL",
  "NON_GATE_EVIDENCE"
]);

const REQUIRED_FORMAL_ROLES = Object.freeze(["handheld", "station"]);
const CONTROL_STATUSES = new Set([
  "PASS",
  "FAIL",
  "UNKNOWN",
  "NOT_TESTED",
  "NOT_APPLICABLE"
]);
const CLASSIFICATIONS = new Set([
  "FULL_NODE",
  "CLIENT_ONLY",
  "UNSUPPORTED",
  "UNKNOWN"
]);
const CONNECTION_STATUSES = new Set([
  "CONNECTED",
  "NOT_CONNECTED",
  "UNKNOWN"
]);
const MAX_MATRIX_BYTES = 256 * 1024;
const MAX_DEVICES = 100;
const DEVICE_KEYS = new Set([
  "role",
  "vendor",
  "model",
  "androidApi",
  "connectionStatus",
  "evidenceClass",
  "classification",
  "privateEvidence",
  ...B0_REQUIRED_CHECKS
]);
const MATRIX_KEYS = new Set([
  "schemaVersion",
  "evidenceDate",
  "minimumFullNodesRequired",
  "devices"
]);

export class B0CapabilityGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "B0CapabilityGateError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnexpectedKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      `${label} contains unexpected fields`
    );
  }
}

function publicString(value, label, maximumLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      `${label} must be a bounded public string`
    );
  }
  return value;
}

function normalizedControlStatus(value) {
  if (value === undefined) return "MISSING";
  if (typeof value !== "string" || !CONTROL_STATUSES.has(value)) {
    return "INVALID";
  }
  return value;
}

function normalizedEvidenceClass(value) {
  return typeof value === "string" && B0_EVIDENCE_CLASSES.includes(value)
    ? value
    : "NON_GATE_EVIDENCE";
}

function normalizedClassification(value) {
  return typeof value === "string" && CLASSIFICATIONS.has(value)
    ? value
    : "UNKNOWN";
}

function normalizedConnectionStatus(value) {
  return typeof value === "string" && CONNECTION_STATUSES.has(value)
    ? value
    : "UNKNOWN";
}

function parseDevice(value, index) {
  if (!isRecord(value)) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      `devices[${index}] must be an object`
    );
  }
  rejectUnexpectedKeys(value, DEVICE_KEYS, `devices[${index}]`);
  if (value.role !== "handheld" && value.role !== "station") {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      `devices[${index}].role is invalid`
    );
  }
  if (
    value.androidApi !== null &&
    (!Number.isSafeInteger(value.androidApi) || value.androidApi < 21)
  ) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      `devices[${index}].androidApi is invalid`
    );
  }
  if (value.privateEvidence !== undefined && !isRecord(value.privateEvidence)) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      `devices[${index}].privateEvidence must be an object`
    );
  }

  const checks = Object.fromEntries(
    B0_REQUIRED_CHECKS.map((check) => [
      check,
      normalizedControlStatus(value[check])
    ])
  );
  const evidenceClass = normalizedEvidenceClass(value.evidenceClass);
  const classification = normalizedClassification(value.classification);
  const blockers = [];
  if (!B0_EVIDENCE_CLASSES.includes(value.evidenceClass)) {
    blockers.push("EVIDENCE_CLASS_MISSING_OR_INVALID");
  }
  for (const check of B0_REQUIRED_CHECKS) {
    if (checks[check] !== "PASS") {
      blockers.push(`CHECK_${check}_${checks[check]}`);
    }
  }
  if (classification !== "FULL_NODE") {
    blockers.push(`CLASSIFICATION_${classification}`);
  }

  return Object.freeze({
    record: index + 1,
    role: value.role,
    vendor: publicString(value.vendor, `devices[${index}].vendor`, 80),
    model: publicString(value.model, `devices[${index}].model`, 120),
    androidApi: value.androidApi,
    connectionStatus: normalizedConnectionStatus(value.connectionStatus),
    evidenceClass,
    classification,
    checks: Object.freeze(checks),
    evidenceResult: blockers.length === 0 ? "PASS" : "PENDING",
    blockers: Object.freeze(blockers)
  });
}

export function parseB0CapabilityMatrix(raw) {
  if (typeof raw !== "string") {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      "capability matrix must be UTF-8 JSON text"
    );
  }
  const byteLength = Buffer.byteLength(raw, "utf8");
  if (byteLength === 0 || byteLength > MAX_MATRIX_BYTES) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      "capability matrix has an invalid size"
    );
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      "capability matrix is not valid JSON"
    );
  }
  if (!isRecord(value)) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      "capability matrix must be an object"
    );
  }
  rejectUnexpectedKeys(value, MATRIX_KEYS, "matrix");
  if (value.schemaVersion !== 1) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      "capability matrix schemaVersion must be 1"
    );
  }
  if (
    typeof value.evidenceDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value.evidenceDate)
  ) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      "capability matrix evidenceDate must be YYYY-MM-DD"
    );
  }
  if (
    !Number.isSafeInteger(value.minimumFullNodesRequired) ||
    value.minimumFullNodesRequired < 2 ||
    value.minimumFullNodesRequired > MAX_DEVICES
  ) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      "minimumFullNodesRequired must be an integer from 2 to 100"
    );
  }
  if (
    !Array.isArray(value.devices) ||
    value.devices.length === 0 ||
    value.devices.length > MAX_DEVICES
  ) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INVALID",
      "devices must contain between 1 and 100 records"
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    evidenceDate: value.evidenceDate,
    minimumFullNodesRequired: value.minimumFullNodesRequired,
    devices: Object.freeze(value.devices.map(parseDevice)),
    hasPrivateEvidence: value.devices.some(
      (device) => isRecord(device) && device.privateEvidence !== undefined
    )
  });
}

export function buildRedactedB0CapabilityReport(matrix) {
  const formalDevices = matrix.devices.filter(
    (device) => device.evidenceClass === "FORMAL"
  );
  const passingFormalDevices = formalDevices.filter(
    (device) => device.evidenceResult === "PASS"
  );
  const formalRoleCoverage = Object.fromEntries(
    REQUIRED_FORMAL_ROLES.map((role) => [
      role,
      passingFormalDevices.some((device) => device.role === role)
    ])
  );
  const allFormalEvidencePasses =
    formalDevices.length > 0 &&
    formalDevices.every((device) => device.evidenceResult === "PASS");
  const gate =
    allFormalEvidencePasses &&
    passingFormalDevices.length >= matrix.minimumFullNodesRequired &&
    Object.values(formalRoleCoverage).every(Boolean)
      ? "PASS"
      : "PENDING";

  return Object.freeze({
    schemaVersion: 1,
    source: "V5BT_B0_DEVICE_CAPABILITY_GATE",
    evidenceDate: matrix.evidenceDate,
    redaction: Object.freeze({
      status: "REDACTED",
      policy: "PUBLIC_ALLOWLIST_V1"
    }),
    gate,
    minimumFullNodesRequired: matrix.minimumFullNodesRequired,
    requiredFormalRoles: REQUIRED_FORMAL_ROLES,
    requiredChecks: B0_REQUIRED_CHECKS,
    counts: Object.freeze({
      total: matrix.devices.length,
      formal: formalDevices.length,
      passingFormalFullNodes: passingFormalDevices.length,
      supplemental: matrix.devices.filter(
        (device) => device.evidenceClass === "SUPPLEMENTAL"
      ).length,
      nonGate: matrix.devices.filter(
        (device) => device.evidenceClass === "NON_GATE_EVIDENCE"
      ).length
    }),
    formalRoleCoverage: Object.freeze(formalRoleCoverage),
    devices: matrix.devices
  });
}

export function evaluateB0CapabilityMatrix(raw) {
  return buildRedactedB0CapabilityReport(parseB0CapabilityMatrix(raw));
}

export function loadB0CapabilityMatrix(matrixPath) {
  let before;
  try {
    before = fs.lstatSync(matrixPath);
  } catch {
    throw new B0CapabilityGateError(
      "B0_MATRIX_UNAVAILABLE",
      "capability matrix is unavailable"
    );
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0 ||
    before.size > MAX_MATRIX_BYTES
  ) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_UNAVAILABLE",
      "capability matrix must be a small regular file"
    );
  }
  let raw;
  let after;
  try {
    raw = fs.readFileSync(matrixPath, "utf8");
    after = fs.lstatSync(matrixPath);
  } catch {
    throw new B0CapabilityGateError(
      "B0_MATRIX_UNAVAILABLE",
      "capability matrix cannot be read safely"
    );
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.mode !== after.mode ||
    before.nlink !== after.nlink ||
    before.uid !== after.uid
  ) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_CHANGED",
      "capability matrix changed while being read"
    );
  }
  const matrix = parseB0CapabilityMatrix(raw);
  const currentUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  if (
    matrix.hasPrivateEvidence &&
    ((before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 ||
      (currentUid !== null && before.uid !== currentUid))
  ) {
    throw new B0CapabilityGateError(
      "B0_MATRIX_INSECURE",
      "a matrix with private evidence must be an owner-only regular file"
    );
  }
  return matrix;
}

export function parseArguments(argv) {
  const options = { root: ".", matrix: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option !== "--root" && option !== "--matrix") {
      throw new B0CapabilityGateError(
        "B0_ARGUMENT_INVALID",
        "only --root and --matrix are supported"
      );
    }
    if (
      seen.has(option) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new B0CapabilityGateError(
        "B0_ARGUMENT_INVALID",
        `${option} must be provided exactly once with a value`
      );
    }
    seen.add(option);
    if (option === "--root") options.root = value;
    else options.matrix = value;
  }
  return Object.freeze(options);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const root = path.resolve(options.root);
  const activeMatrixPath = path.join(
    root,
    "configs",
    "device-capability-matrix.json"
  );
  const exampleMatrixPath = path.join(
    root,
    "configs",
    "device-capability-matrix.example.json"
  );
  const matrixPath = options.matrix
    ? path.resolve(options.matrix)
    : fs.existsSync(activeMatrixPath)
      ? activeMatrixPath
      : exampleMatrixPath;
  const report = buildRedactedB0CapabilityReport(
    loadB0CapabilityMatrix(matrixPath)
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.gate !== "PASS") process.exitCode = 2;
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    const controlled = error instanceof B0CapabilityGateError;
    const code = controlled ? error.code : "B0_CAPABILITY_GATE_FAILED";
    const message = controlled ? error.message : "B0 capability gate failed";
    process.stderr.write(
      `${JSON.stringify({ gate: "ERROR", code, message })}\n`
    );
    process.exitCode = 1;
  }
}
