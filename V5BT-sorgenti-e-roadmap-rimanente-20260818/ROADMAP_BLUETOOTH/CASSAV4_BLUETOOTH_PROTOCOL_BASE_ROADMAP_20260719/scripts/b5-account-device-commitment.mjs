import crypto from "node:crypto";

import { ADVANCED_CERTIFICATION_TARGETS } from "./advanced-certification-targets.mjs";

export const B5_ACCOUNT_DEVICE_COMMITMENT_VERSION = "1.0.0";

const DOMAIN = "V5BT:B5:ACCOUNT_DEVICE_COMMITMENT:1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PACKAGE_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u;
const SERIAL_PATTERN = /^[!-~]{1,200}$/u;
const BINDING_FIELDS = Object.freeze([
  "campaignId",
  "androidUserId",
  "appUid",
  "sessionBindingHmacSha256",
  "deviceSerial",
  "androidApi",
  "role",
  "packageName",
  "versionName",
  "versionCode",
  "apkSha256",
  "signingCertificateSha256"
]);
export const B5_ACCOUNT_DEVICE_SENSITIVE_FIELDS = Object.freeze([
  "androidUserId",
  "appUid",
  "sessionBindingHmacSha256",
  "deviceSerial"
]);

export class B5AccountDeviceCommitmentError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "B5AccountDeviceCommitmentError";
    this.code = code;
  }
}

function fail(message) {
  throw new B5AccountDeviceCommitmentError(
    "ACCOUNT_DEVICE_BINDING_INVALID",
    message
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactFields(value) {
  if (!isRecord(value)) fail("B5 account/device binding must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...BINDING_FIELDS].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail("B5 account/device binding has an invalid field set");
  }
  return value;
}

function requireInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} is invalid`);
  }
  return value;
}

function requireSha256(value, label) {
  if (
    typeof value !== "string" ||
    !SHA256_PATTERN.test(value) ||
    /^0{64}$/u.test(value)
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

export function parseB5AccountDeviceBinding(value) {
  const binding = requireExactFields(value);
  if (!UUID_V4_PATTERN.test(binding.campaignId)) {
    fail("B5 account/device campaign identifier is invalid");
  }
  requireInteger(binding.androidUserId, 0, "B5 Android user identifier");
  requireInteger(binding.appUid, 1, "B5 application UID");
  requireSha256(
    binding.sessionBindingHmacSha256,
    "B5 authenticated account/device session commitment"
  );
  if (!SERIAL_PATTERN.test(binding.deviceSerial)) {
    fail("B5 physical device identity is invalid");
  }
  requireInteger(binding.androidApi, 33, "B5 Android API level");
  if (binding.role !== "handheld") {
    fail("B5 account/device binding must target the certified handheld");
  }
  if (!PACKAGE_PATTERN.test(binding.packageName)) {
    fail("B5 package name is invalid");
  }
  if (!VERSION_PATTERN.test(binding.versionName)) {
    fail("B5 package version is invalid");
  }
  requireInteger(binding.versionCode, 1, "B5 package version code");
  requireSha256(binding.apkSha256, "B5 package build digest");
  requireSha256(
    binding.signingCertificateSha256,
    "B5 package signing certificate digest"
  );
  return Object.freeze({ ...binding });
}

export function createB5AccountDeviceCommitmentSha256(value) {
  const binding = parseB5AccountDeviceBinding(value);
  const canonical = {
    domain: DOMAIN,
    campaignId: binding.campaignId,
    operationalAccount: {
      androidUserId: binding.androidUserId,
      appUid: binding.appUid,
      authenticatedSessionCommitmentSha256:
        binding.sessionBindingHmacSha256
    },
    deviceIdentity: {
      adbSerial: binding.deviceSerial,
      androidApi: binding.androidApi
    },
    packageBuild: {
      role: binding.role,
      packageName: binding.packageName,
      versionName: binding.versionName,
      versionCode: binding.versionCode,
      apkSha256: binding.apkSha256,
      signingCertificateSha256: binding.signingCertificateSha256
    }
  };
  return crypto
    .createHash("sha256")
    .update(Buffer.from(JSON.stringify(canonical), "utf8"))
    .digest("hex");
}

export function b5AccountDeviceBindingFromPrivateBaseline(baseline) {
  if (!isRecord(baseline) || !isRecord(baseline.binding)) {
    fail("B5 private Android baseline is invalid");
  }
  const target = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;
  const binding = {
    campaignId: baseline.campaignId,
    androidUserId: baseline.binding.androidUserId,
    appUid: baseline.binding.appUid,
    sessionBindingHmacSha256:
      baseline.binding.sessionBindingHmacSha256,
    deviceSerial: baseline.binding.serial,
    androidApi: baseline.binding.androidApi,
    role: baseline.binding.role,
    packageName: baseline.binding.packageName,
    versionName: baseline.binding.versionName,
    versionCode: baseline.binding.versionCode,
    apkSha256: baseline.binding.apkSha256,
    signingCertificateSha256: target.signingCertificateSha256
  };
  const parsed = parseB5AccountDeviceBinding(binding);
  if (
    parsed.packageName !== target.packageId ||
    parsed.versionName !== target.versionName ||
    parsed.versionCode !== target.versionCode ||
    parsed.apkSha256 !== target.sha256
  ) {
    fail("B5 private Android baseline is not the certified handheld build");
  }
  return parsed;
}

export function b5AccountDeviceSensitiveValues(value) {
  const binding = parseB5AccountDeviceBinding(value);
  return Object.freeze([
    binding.campaignId,
    binding.androidUserId,
    binding.appUid,
    binding.sessionBindingHmacSha256,
    binding.deviceSerial,
    binding.packageName,
    binding.versionName,
    binding.apkSha256,
    binding.signingCertificateSha256
  ]);
}

export function validB5AccountDeviceBindingFixture({
  campaignId = "00000000-0000-4000-8000-000000000001",
  deviceSerial = "V5BT-PHYSICAL-HANDHELD-001",
  sessionBindingHmacSha256 = "1".repeat(64)
} = {}) {
  const target = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;
  return parseB5AccountDeviceBinding({
    campaignId,
    androidUserId: 0,
    appUid: 10_001,
    sessionBindingHmacSha256,
    deviceSerial,
    androidApi: 36,
    role: "handheld",
    packageName: target.packageId,
    versionName: target.versionName,
    versionCode: target.versionCode,
    apkSha256: target.sha256,
    signingCertificateSha256: target.signingCertificateSha256
  });
}
