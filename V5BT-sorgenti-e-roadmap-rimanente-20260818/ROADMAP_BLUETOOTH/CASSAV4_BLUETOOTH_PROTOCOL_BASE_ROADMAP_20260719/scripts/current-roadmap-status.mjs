#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from "./advanced-certification-targets.mjs";

const STATUS_URL = new URL(
  "../configs/current-roadmap-status.json",
  import.meta.url
);
const SCHEMA_URL = new URL(
  "../contracts/current-roadmap-status-v1.schema.json",
  import.meta.url
);
const MAX_STATUS_BYTES = 16_384;
const MAX_SCHEMA_BYTES = 32_768;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const TOP_LEVEL_FIELDS = Object.freeze([
  "schemaVersion",
  "product",
  "mode",
  "statusAsOf",
  "officialProgressPercent",
  "certificationMatrix",
  "b4",
  "b5",
  "b6",
  "applicationLoad",
  "promotion"
]);
const MATRIX_FIELDS = Object.freeze([
  "schemaVersion",
  "canonicalization",
  "digestAlgorithm",
  "matrixSha256"
]);
const B4_FIELDS = Object.freeze([
  "gateStatus",
  "evidenceClass",
  "requiredPhysicalDevices",
  "recordedPhysicalDevices",
  "remainingPhysicalDevices",
  "simulatedDevices",
  "simulatedDevicesCountedTowardGate"
]);
const B5_FIELDS = Object.freeze([
  "gateStatus",
  "diagnosticPilotAuthorized",
  "officialCampaignAuthorized",
  "requiredOfficialSessions",
  "recordedOfficialSessions"
]);
const B6_FIELDS = Object.freeze(["gateStatus", "startAuthorization"]);
const APPLICATION_LOAD_FIELDS = Object.freeze(["micro", "smoke", "full"]);
const PROMOTION_FIELDS = Object.freeze([
  "physicalGatePromotionAllowed",
  "officialProgressIncreaseAllowed"
]);

export class CurrentRoadmapStatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CurrentRoadmapStatusError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CurrentRoadmapStatusError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactFields(value, expected, label) {
  if (!isRecord(value)) {
    fail("CURRENT_ROADMAP_STATUS_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((field, index) => field !== required[index])
  ) {
    fail(
      "CURRENT_ROADMAP_STATUS_INVALID",
      `${label} contains missing or unexpected fields`
    );
  }
}

function assertValue(actual, expected, label) {
  if (actual !== expected) {
    fail("CURRENT_ROADMAP_STATUS_INVALID", `${label} is not current`);
  }
}

function deepFreeze(value) {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function schemaInvalid(message) {
  fail("CURRENT_ROADMAP_SCHEMA_INVALID", message);
}

function schemaMismatch(message) {
  fail("CURRENT_ROADMAP_STATUS_SCHEMA_MISMATCH", message);
}

function assertSchemaKeys(schema, allowed, label) {
  const unexpected = Object.keys(schema).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    schemaInvalid(`${label} uses unsupported schema keywords`);
  }
}

function resolveSchemaReference(rootSchema, reference, label) {
  const match = /^#\/\$defs\/([A-Za-z][A-Za-z0-9_-]*)$/u.exec(reference);
  if (match === null || !isRecord(rootSchema.$defs)) {
    schemaInvalid(`${label} uses an unsupported schema reference`);
  }
  const definition = rootSchema.$defs[match[1]];
  if (!isRecord(definition)) {
    schemaInvalid(`${label} references a missing schema definition`);
  }
  return definition;
}

function validateSchemaNode(schema, value, rootSchema, label, rootNode = false) {
  if (!isRecord(schema)) schemaInvalid(`${label} schema must be an object`);

  if (Object.hasOwn(schema, "$ref")) {
    if (Object.keys(schema).length !== 1 || typeof schema.$ref !== "string") {
      schemaInvalid(`${label} schema reference is invalid`);
    }
    validateSchemaNode(
      resolveSchemaReference(rootSchema, schema.$ref, label),
      value,
      rootSchema,
      label,
    );
    return;
  }

  if (Object.hasOwn(schema, "const")) {
    if (Object.keys(schema).length !== 1 || isRecord(schema.const) || Array.isArray(schema.const)) {
      schemaInvalid(`${label} const schema is unsupported`);
    }
    if (value !== schema.const) schemaMismatch(`${label} does not satisfy const`);
    return;
  }

  const allowed = rootNode
    ? new Set([
      "$defs",
      "$id",
      "$schema",
      "additionalProperties",
      "properties",
      "required",
      "title",
      "type",
    ])
    : new Set(["additionalProperties", "pattern", "properties", "required", "type"]);
  assertSchemaKeys(schema, allowed, label);

  if (rootNode) {
    if (
      schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
      typeof schema.$id !== "string" ||
      schema.$id.length === 0 ||
      typeof schema.title !== "string" ||
      schema.title.length === 0 ||
      !isRecord(schema.$defs)
    ) {
      schemaInvalid("Current roadmap root schema metadata is invalid");
    }
  }

  if (schema.type === "object") {
    if (
      schema.additionalProperties !== false ||
      !Array.isArray(schema.required) ||
      !isRecord(schema.properties) ||
      schema.required.some((field) => typeof field !== "string") ||
      new Set(schema.required).size !== schema.required.length
    ) {
      schemaInvalid(`${label} object schema is invalid`);
    }
    const propertyNames = Object.keys(schema.properties).sort();
    const requiredNames = [...schema.required].sort();
    if (
      propertyNames.length !== requiredNames.length ||
      propertyNames.some((field, index) => field !== requiredNames[index])
    ) {
      schemaInvalid(`${label} must require every declared property exactly once`);
    }
    if (!isRecord(value)) schemaMismatch(`${label} must be an object`);
    const actualNames = Object.keys(value).sort();
    if (
      actualNames.length !== propertyNames.length ||
      actualNames.some((field, index) => field !== propertyNames[index])
    ) {
      schemaMismatch(`${label} contains missing or unexpected properties`);
    }
    for (const field of propertyNames) {
      validateSchemaNode(
        schema.properties[field],
        value[field],
        rootSchema,
        `${label}.${field}`,
      );
    }
    return;
  }

  if (schema.type === "string") {
    if (typeof schema.pattern !== "string") {
      schemaInvalid(`${label} string schema requires a pattern`);
    }
    let pattern;
    try {
      pattern = new RegExp(schema.pattern, "u");
    } catch {
      schemaInvalid(`${label} string pattern is invalid`);
    }
    if (typeof value !== "string" || !pattern.test(value)) {
      schemaMismatch(`${label} does not satisfy its string pattern`);
    }
    return;
  }

  schemaInvalid(`${label} uses an unsupported schema shape`);
}

export function validateCurrentRoadmapStatusSchema(status, schema) {
  validateSchemaNode(schema, status, schema, "Current roadmap status", true);
  return true;
}

export function loadCurrentRoadmapStatusSchema(schemaPath = SCHEMA_URL) {
  let metadata;
  try {
    metadata = fs.lstatSync(schemaPath);
  } catch {
    schemaInvalid("Current roadmap status schema is unavailable");
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > MAX_SCHEMA_BYTES
  ) {
    schemaInvalid("Current roadmap status schema must be a small regular file");
  }
  try {
    return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    schemaInvalid("Current roadmap status schema is not valid JSON");
  }
}

function assertCertificationMatrixBinding(status, matrixBinding) {
  if (
    !isRecord(matrixBinding) ||
    typeof matrixBinding.matrixSha256 !== "string" ||
    !SHA256_PATTERN.test(matrixBinding.matrixSha256)
  ) {
    fail(
      "CURRENT_ROADMAP_MATRIX_BINDING_INVALID",
      "The certification matrix binding is unavailable or invalid"
    );
  }
  for (const field of MATRIX_FIELDS) {
    if (status.certificationMatrix[field] !== matrixBinding[field]) {
      fail(
        "CURRENT_ROADMAP_MATRIX_MISMATCH",
        `Current roadmap status does not match certification matrix field ${field}`
      );
    }
  }
}

export function parseCurrentRoadmapStatus(
  raw,
  { matrixBinding = ADVANCED_CERTIFICATION_TARGETS_BINDING } = {}
) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") === 0 ||
    Buffer.byteLength(raw, "utf8") > MAX_STATUS_BYTES
  ) {
    fail("CURRENT_ROADMAP_STATUS_INVALID", "Current roadmap status has an invalid size");
  }
  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    fail("CURRENT_ROADMAP_STATUS_INVALID", "Current roadmap status is not valid JSON");
  }

  assertExactFields(status, TOP_LEVEL_FIELDS, "Current roadmap status");
  assertExactFields(
    status.certificationMatrix,
    MATRIX_FIELDS,
    "Certification matrix binding"
  );
  assertExactFields(status.b4, B4_FIELDS, "B4 status");
  assertExactFields(status.b5, B5_FIELDS, "B5 status");
  assertExactFields(status.b6, B6_FIELDS, "B6 status");
  assertExactFields(
    status.applicationLoad,
    APPLICATION_LOAD_FIELDS,
    "Application load status"
  );
  assertExactFields(status.promotion, PROMOTION_FIELDS, "Promotion status");

  for (const [actual, expected, label] of [
    [status.schemaVersion, 1, "schemaVersion"],
    [status.product, "V5BT", "product"],
    [status.mode, "CURRENT_ROADMAP_STATUS", "mode"],
    [status.statusAsOf, "2026-08-10", "statusAsOf"],
    [status.officialProgressPercent, 49, "officialProgressPercent"],
    [status.certificationMatrix.schemaVersion, 1, "matrix schemaVersion"],
    [
      status.certificationMatrix.canonicalization,
      "V5BT_ADVANCED_CERTIFICATION_TARGETS_CANONICAL_JSON_V1",
      "matrix canonicalization"
    ],
    [status.certificationMatrix.digestAlgorithm, "SHA-256", "matrix digestAlgorithm"],
    [status.b4.gateStatus, "PENDING", "B4 gateStatus"],
    [status.b4.evidenceClass, "NON_GATE_EVIDENCE", "B4 evidenceClass"],
    [status.b4.requiredPhysicalDevices, 10, "B4 requiredPhysicalDevices"],
    [status.b4.recordedPhysicalDevices, 2, "B4 recordedPhysicalDevices"],
    [status.b4.remainingPhysicalDevices, 8, "B4 remainingPhysicalDevices"],
    [status.b4.simulatedDevices, 8, "B4 simulatedDevices"],
    [
      status.b4.simulatedDevicesCountedTowardGate,
      0,
      "B4 simulatedDevicesCountedTowardGate"
    ],
    [status.b5.gateStatus, "PENDING", "B5 gateStatus"],
    [status.b5.diagnosticPilotAuthorized, false, "B5 diagnosticPilotAuthorized"],
    [status.b5.officialCampaignAuthorized, false, "B5 officialCampaignAuthorized"],
    [status.b5.requiredOfficialSessions, 100, "B5 requiredOfficialSessions"],
    [status.b5.recordedOfficialSessions, 0, "B5 recordedOfficialSessions"],
    [status.b6.gateStatus, "PENDING", "B6 gateStatus"],
    [status.b6.startAuthorization, "BLOCKED", "B6 startAuthorization"],
    [status.applicationLoad.micro, "PASS", "application micro"],
    [status.applicationLoad.smoke, "FAIL", "application smoke"],
    [status.applicationLoad.full, "NOT_RUN", "application full"],
    [
      status.promotion.physicalGatePromotionAllowed,
      false,
      "physicalGatePromotionAllowed"
    ],
    [
      status.promotion.officialProgressIncreaseAllowed,
      false,
      "officialProgressIncreaseAllowed"
    ]
  ]) {
    assertValue(actual, expected, label);
  }

  if (
    status.b4.recordedPhysicalDevices + status.b4.remainingPhysicalDevices !==
      status.b4.requiredPhysicalDevices ||
    status.b4.simulatedDevices !== status.b4.remainingPhysicalDevices ||
    status.b5.recordedOfficialSessions >= status.b5.requiredOfficialSessions
  ) {
    fail(
      "CURRENT_ROADMAP_STATUS_INVALID",
      "Current roadmap counts are internally inconsistent"
    );
  }

  assertCertificationMatrixBinding(status, matrixBinding);
  return deepFreeze(status);
}

export function loadCurrentRoadmapStatus(
  statusPath = STATUS_URL,
  { matrixBinding = ADVANCED_CERTIFICATION_TARGETS_BINDING } = {}
) {
  let before;
  try {
    before = fs.lstatSync(statusPath);
  } catch {
    fail("CURRENT_ROADMAP_STATUS_UNAVAILABLE", "Current roadmap status is unavailable");
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0 ||
    before.size > MAX_STATUS_BYTES
  ) {
    fail(
      "CURRENT_ROADMAP_STATUS_UNAVAILABLE",
      "Current roadmap status must be a small regular file"
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(statusPath, "utf8");
  } catch {
    fail("CURRENT_ROADMAP_STATUS_UNAVAILABLE", "Current roadmap status cannot be read");
  }
  const after = fs.lstatSync(statusPath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    fail(
      "CURRENT_ROADMAP_STATUS_CHANGED",
      "Current roadmap status changed while being read"
    );
  }
  const status = parseCurrentRoadmapStatus(raw, { matrixBinding });
  validateCurrentRoadmapStatusSchema(status, loadCurrentRoadmapStatusSchema());
  return status;
}

export function isRoadmapPromotionAllowed({
  packageValid,
  externalEvidenceBlockers,
  currentRoadmapStatus
}) {
  return (
    packageValid === true &&
    Array.isArray(externalEvidenceBlockers) &&
    externalEvidenceBlockers.length === 0 &&
    currentRoadmapStatus?.promotion?.physicalGatePromotionAllowed === true &&
    currentRoadmapStatus?.promotion?.officialProgressIncreaseAllowed === true
  );
}

export const CURRENT_ROADMAP_STATUS = loadCurrentRoadmapStatus();

function isMainModule() {
  return (
    typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 2 || (args.length > 0 && args[0] !== "--status")) {
      fail(
        "CURRENT_ROADMAP_ARGUMENT_INVALID",
        "Usage: node scripts/current-roadmap-status.mjs [--status FILE]"
      );
    }
    if (args.length === 1) {
      fail(
        "CURRENT_ROADMAP_ARGUMENT_INVALID",
        "--status requires a file path"
      );
    }
    const status = loadCurrentRoadmapStatus(
      args.length === 2 ? path.resolve(args[1]) : STATUS_URL
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          product: status.product,
          statusAsOf: status.statusAsOf,
          officialProgressPercent: status.officialProgressPercent,
          b4: status.b4,
          b5: status.b5,
          b6: status.b6,
          applicationLoad: status.applicationLoad,
          promotion: status.promotion
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          code:
            error instanceof CurrentRoadmapStatusError
              ? error.code
              : "CURRENT_ROADMAP_STATUS_FAILURE",
          message: error instanceof Error ? error.message : "Unknown failure"
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}
