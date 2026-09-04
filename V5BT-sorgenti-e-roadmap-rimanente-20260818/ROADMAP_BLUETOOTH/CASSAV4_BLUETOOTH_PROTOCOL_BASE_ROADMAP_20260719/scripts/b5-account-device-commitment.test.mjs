import assert from "node:assert/strict";
import test from "node:test";

import {
  B5_ACCOUNT_DEVICE_SENSITIVE_FIELDS,
  B5AccountDeviceCommitmentError,
  b5AccountDeviceBindingFromPrivateBaseline,
  b5AccountDeviceSensitiveValues,
  createB5AccountDeviceCommitmentSha256,
  parseB5AccountDeviceBinding,
  validB5AccountDeviceBindingFixture
} from "./b5-account-device-commitment.mjs";

function assertInvalid(error) {
  return (
    error instanceof B5AccountDeviceCommitmentError &&
    error.code === "ACCOUNT_DEVICE_BINDING_INVALID"
  );
}

test("B5 account/device commitment has a stable canonical digest", () => {
  const binding = validB5AccountDeviceBindingFixture();
  const reordered = Object.fromEntries(Object.entries(binding).reverse());

  assert.equal(
    createB5AccountDeviceCommitmentSha256(binding),
    "7292f3da964b49ca3a183b4287c28614c4d23b4331778b1681674d784be071cd"
  );
  assert.equal(
    createB5AccountDeviceCommitmentSha256(reordered),
    createB5AccountDeviceCommitmentSha256(binding)
  );
});

test("B5 account/device commitment changes with every mutable binding dimension", () => {
  const binding = validB5AccountDeviceBindingFixture();
  const original = createB5AccountDeviceCommitmentSha256(binding);
  const mutations = {
    campaignId: "00000000-0000-4000-8000-000000000002",
    androidUserId: 1,
    appUid: 10_002,
    sessionBindingHmacSha256: "2".repeat(64),
    deviceSerial: "V5BT-PHYSICAL-HANDHELD-002",
    androidApi: 35,
    packageName: "com.sentrapa.palmare.candidate",
    versionName: "1.0.40",
    versionCode: 41,
    apkSha256: "3".repeat(64),
    signingCertificateSha256: "4".repeat(64)
  };

  for (const [field, value] of Object.entries(mutations)) {
    assert.notEqual(
      createB5AccountDeviceCommitmentSha256({ ...binding, [field]: value }),
      original,
      field
    );
  }
});

test("B5 account/device commitment exposes no private binding value", () => {
  const binding = validB5AccountDeviceBindingFixture();
  const commitment = createB5AccountDeviceCommitmentSha256(binding);
  const encoded = JSON.stringify({ accountDeviceCommitmentSha256: commitment });

  assert.match(commitment, /^(?!0{64}$)[0-9a-f]{64}$/u);
  const sensitiveValues = b5AccountDeviceSensitiveValues(binding);
  assert.deepEqual(B5_ACCOUNT_DEVICE_SENSITIVE_FIELDS, [
    "androidUserId",
    "appUid",
    "sessionBindingHmacSha256",
    "deviceSerial"
  ]);
  assert.equal(sensitiveValues.includes(binding.androidUserId), true);
  assert.equal(sensitiveValues.includes(binding.appUid), true);
  for (const field of B5_ACCOUNT_DEVICE_SENSITIVE_FIELDS) {
    assert.equal(encoded.includes(`"${field}"`), false, field);
  }
  for (const value of sensitiveValues) {
    if (typeof value === "string") {
      assert.equal(encoded.includes(value), false, value);
    }
  }
});

test("B5 account/device binding parser rejects absent, extended and noncanonical data", () => {
  const binding = validB5AccountDeviceBindingFixture();
  const missing = structuredClone(binding);
  delete missing.deviceSerial;

  for (const invalid of [
    missing,
    { ...binding, unexpected: true },
    { ...binding, campaignId: "not-a-campaign" },
    { ...binding, deviceSerial: "serial\nleak" },
    { ...binding, sessionBindingHmacSha256: "0".repeat(64) },
    { ...binding, apkSha256: "A".repeat(64) },
    { ...binding, role: "pos" }
  ]) {
    assert.throws(() => parseB5AccountDeviceBinding(invalid), assertInvalid);
  }
});

test("B5 private Android baseline maps to the certified binding only", () => {
  const binding = validB5AccountDeviceBindingFixture();
  const baseline = {
    campaignId: binding.campaignId,
    binding: {
      androidUserId: binding.androidUserId,
      appUid: binding.appUid,
      sessionBindingHmacSha256: binding.sessionBindingHmacSha256,
      serial: binding.deviceSerial,
      androidApi: binding.androidApi,
      role: binding.role,
      packageName: binding.packageName,
      versionName: binding.versionName,
      versionCode: binding.versionCode,
      apkSha256: binding.apkSha256
    }
  };

  assert.deepEqual(b5AccountDeviceBindingFromPrivateBaseline(baseline), binding);
  assert.throws(
    () =>
      b5AccountDeviceBindingFromPrivateBaseline({
        ...baseline,
        binding: { ...baseline.binding, apkSha256: "5".repeat(64) }
      }),
    assertInvalid
  );
});
