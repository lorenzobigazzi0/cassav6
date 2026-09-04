import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CONFIG_URL = new URL(
  "../configs/advanced-certification-targets.json",
  import.meta.url
);
const MAX_CONFIG_BYTES = 16_384;
const EXPECTED_ROLES = Object.freeze(["handheld", "station"]);
const TARGET_KEYS = Object.freeze([
  "artifactRelativePath",
  "packageId",
  "sha256",
  "signingCertificateSha256",
  "versionCode",
  "versionName"
]);
const CERTIFICATION_CANONICALIZATION =
  "V5BT_ADVANCED_CERTIFICATION_TARGETS_CANONICAL_JSON_V1";

function parseArtifactRelativePath(value, role) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 500 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    !value.startsWith("artifacts/") ||
    value === "artifacts/" ||
    !value.endsWith(".apk")
  ) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      `roles.${role}.artifactRelativePath must be a normalized relative APK path below artifacts/`
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
    )
  ) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      `roles.${role}.artifactRelativePath contains an invalid path segment`
    );
  }
  return value;
}

export class CertificationTargetsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CertificationTargetsError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      `${label} must be an object`
    );
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      `${label} contains missing or unexpected fields`
    );
  }
}

function parseRole(value, role) {
  assertExactKeys(value, TARGET_KEYS, `roles.${role}`);
  if (
    typeof value.packageId !== "string" ||
    value.packageId.length > 200 ||
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(
      value.packageId
    )
  ) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      `roles.${role}.packageId is invalid`
    );
  }
  if (
    typeof value.versionName !== "string" ||
    value.versionName.length > 100 ||
    !/^[0-9]+(?:\.[0-9]+){2}$/.test(value.versionName)
  ) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      `roles.${role}.versionName is invalid`
    );
  }
  if (!Number.isSafeInteger(value.versionCode) || value.versionCode <= 0) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      `roles.${role}.versionCode must be a positive integer`
    );
  }
  if (
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    /^0{64}$/.test(value.sha256)
  ) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      `roles.${role}.sha256 must be a nonzero lowercase SHA-256 digest`
    );
  }
  if (
    typeof value.signingCertificateSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.signingCertificateSha256) ||
    /^0{64}$/.test(value.signingCertificateSha256)
  ) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      `roles.${role}.signingCertificateSha256 must be a nonzero lowercase SHA-256 digest`
    );
  }
  return Object.freeze({
    artifactRelativePath: parseArtifactRelativePath(
      value.artifactRelativePath,
      role
    ),
    packageId: value.packageId,
    versionName: value.versionName,
    versionCode: value.versionCode,
    sha256: value.sha256,
    signingCertificateSha256: value.signingCertificateSha256
  });
}

export function parseAdvancedCertificationTargets(raw) {
  if (typeof raw !== "string") {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      "certification target matrix must be UTF-8 JSON text"
    );
  }
  if (
    Buffer.byteLength(raw, "utf8") === 0 ||
    Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES
  ) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      "certification target matrix has an invalid size"
    );
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      "certification target matrix is not valid JSON"
    );
  }
  assertExactKeys(value, ["roles", "schemaVersion"], "matrix");
  if (value.schemaVersion !== 3) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      "certification target matrix schemaVersion must be 3"
    );
  }
  assertExactKeys(value.roles, EXPECTED_ROLES, "roles");
  const roles = Object.freeze(
    Object.fromEntries(
      EXPECTED_ROLES.map((role) => [role, parseRole(value.roles[role], role)])
    )
  );
  if (roles.handheld.packageId === roles.station.packageId) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      "certification target packages must be distinct"
    );
  }
  if (roles.handheld.sha256 === roles.station.sha256) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      "certification target APK digests must be distinct"
    );
  }
  if (
    roles.handheld.artifactRelativePath ===
    roles.station.artifactRelativePath
  ) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      "certification target APK paths must be distinct"
    );
  }
  return Object.freeze({ schemaVersion: 3, roles });
}

export function canonicalizeAdvancedCertificationTargets(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_INVALID",
      "certification target matrix cannot be serialized"
    );
  }
  const parsed = parseAdvancedCertificationTargets(serialized);
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    roles: Object.fromEntries(
      EXPECTED_ROLES.map((role) => [
        role,
        Object.fromEntries(
          TARGET_KEYS.map((key) => [key, parsed.roles[role][key]])
        )
      ])
    )
  });
}

export function buildAdvancedCertificationTargetsBinding(value) {
  const canonicalJson = canonicalizeAdvancedCertificationTargets(value);
  const matrix = JSON.parse(canonicalJson);
  for (const role of EXPECTED_ROLES) Object.freeze(matrix.roles[role]);
  Object.freeze(matrix.roles);
  Object.freeze(matrix);
  return Object.freeze({
    schemaVersion: 1,
    canonicalization: CERTIFICATION_CANONICALIZATION,
    digestAlgorithm: "SHA-256",
    matrixSha256: crypto
      .createHash("sha256")
      .update(canonicalJson, "utf8")
      .digest("hex"),
    matrix
  });
}

export function loadAdvancedCertificationTargets(configPath = CONFIG_URL) {
  let before;
  try {
    before = fs.lstatSync(configPath);
  } catch {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_UNAVAILABLE",
      "certification target matrix is unavailable"
    );
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0 ||
    before.size > MAX_CONFIG_BYTES
  ) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_UNAVAILABLE",
      "certification target matrix must be a small regular file"
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_UNAVAILABLE",
      "certification target matrix cannot be read"
    );
  }
  const after = fs.lstatSync(configPath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new CertificationTargetsError(
      "CERTIFICATION_TARGETS_CHANGED",
      "certification target matrix changed while being read"
    );
  }
  return parseAdvancedCertificationTargets(raw);
}

export const ADVANCED_CERTIFICATION_TARGETS =
  loadAdvancedCertificationTargets();

export const ADVANCED_CERTIFICATION_TARGETS_BINDING =
  buildAdvancedCertificationTargetsBinding(ADVANCED_CERTIFICATION_TARGETS);
