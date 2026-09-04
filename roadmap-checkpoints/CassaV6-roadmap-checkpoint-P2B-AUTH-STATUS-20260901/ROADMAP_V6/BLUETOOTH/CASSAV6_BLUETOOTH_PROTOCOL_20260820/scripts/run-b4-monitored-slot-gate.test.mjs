import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  B4MonitoredSlotGateError,
  buildB4SlotRunCommitments,
  buildB4TargetHardwareCommitment,
  buildB4TargetHardwareCommitmentFromDeviceDigest,
  validateB4MonitoredSlotAuthorization
} from "./run-b4-monitored-slot-gate.mjs";
import {
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from "./advanced-certification-targets.mjs";
import {
  buildB4AndroidContinuityAttestation,
  parseB4AndroidContinuityAttestation
} from "../../../scripts/run-v6-b4-android-continuity-monitor.mjs";
import {
  buildB4RaspberryContinuityAttestation,
  parseB4RaspberryContinuityAttestation
} from "../../../scripts/run-v6-b4-raspberry-continuity-monitor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTION_RUN_ID = "00000000-0000-4000-8000-000000000001";
const CAPTURE_RUN_ID = "00000000-0000-4000-8000-000000000002";
const MATRIX_SHA256 = "a".repeat(64);
const APK_SHA256 = "b".repeat(64);
const CERTIFICATE_SHA256 = "c".repeat(64);

function collectorState() {
  return {
    schemaVersion: 2,
    product: "V6",
    phase: "B4",
    runId: COLLECTION_RUN_ID,
    certificationMatrixBinding: {
      matrixSha256: MATRIX_SHA256,
      matrix: {
        schemaVersion: 3,
        roles: {
          handheld: {
            packageId: "com.sentrapa.palmare.advanced",
            versionName: "1.0.39",
            versionCode: 40,
            sha256: APK_SHA256,
            signingCertificateSha256: CERTIFICATE_SHA256
          }
        }
      }
    }
  };
}

function fixtures() {
  const binding = {
    ...buildB4SlotRunCommitments({
      collectionRunId: COLLECTION_RUN_ID,
      captureRunId: CAPTURE_RUN_ID
    }),
    certificationMatrixSha256: MATRIX_SHA256,
    privateJournalSha256: "d".repeat(64)
  };
  const android = {
    schemaVersion: 1,
    product: "V6",
    phase: "B4",
    mode: "PHYSICAL_ADB_CONTINUITY",
    verdict: "PASS",
    binding: {
      ...binding,
      targetHardwareCommitmentSha256: "9".repeat(64)
    },
    coverage: {
      monitoredFrom: "2026-08-05T00:00:00.000Z",
      monitoredUntil: "2026-08-05T00:02:00.000Z"
    },
    target: {
      role: "handheld",
      packageName: "com.sentrapa.palmare.advanced",
      versionName: "1.0.39",
      versionCode: 40,
      androidApi: 36,
      apkSha256: APK_SHA256,
      signingCertificateSha256: CERTIFICATE_SHA256
    }
  };
  const raspberry = {
    schemaVersion: 1,
    product: "V6",
    phase: "B4",
    mode: "REDACTED_B4_RASPBERRY_CONTINUITY_ATTESTATION",
    verdict: "PASS",
    binding: { ...binding, privateJournalSha256: "e".repeat(64) },
    coverage: {
      monitoredFrom: "2026-08-05T00:00:00.000Z",
      runnerObservedAt: "2026-08-05T00:00:11.000Z",
      cleanupObservedAt: "2026-08-05T00:01:41.000Z",
      monitoredUntil: "2026-08-05T00:01:42.000Z"
    }
  };
  const runner = {
    schemaVersion: 1,
    product: "V6",
    phase: "B4.3",
    generatedAt: "2026-08-05T00:01:40.000Z",
    mode: "PHYSICAL_SINGLE_ADVERTISER",
    verdict: "PASS",
    measurement: {
      requiredDurationSeconds: 90,
      wallClockDurationMs: 90_000
    }
  };
  return { android, raspberry, runner };
}

function authorize(overrides = {}) {
  const fixture = fixtures();
  const android = overrides.android ?? fixture.android;
  const raspberry = overrides.raspberry ?? fixture.raspberry;
  return validateB4MonitoredSlotAuthorization(
    {
      collectorState: overrides.collectorState ?? collectorState(),
      captureRunId: overrides.captureRunId ?? CAPTURE_RUN_ID,
      expectedPackageName:
        overrides.expectedPackageName ?? "com.sentrapa.palmare.advanced",
      raspberryReport: overrides.runner ?? fixture.runner,
      androidAttestationText:
        overrides.androidText ?? `${JSON.stringify(android)}\n`,
      raspberryAttestationText:
        overrides.raspberryText ?? `${JSON.stringify(raspberry)}\n`
    },
    {
      parseAndroidAttestation:
        overrides.parseAndroidAttestation ??
        ((value) => ({ report: JSON.parse(value) })),
      parseRaspberryAttestation:
        overrides.parseRaspberryAttestation ??
        ((value) => ({ report: JSON.parse(value) }))
    }
  );
}

test("authorizes one redacted handheld slot only with complete dual coverage", () => {
  const fixture = fixtures();
  const androidText = `${JSON.stringify(fixture.android)}\n`;
  const raspberryText = `${JSON.stringify(fixture.raspberry)}\n`;
  const result = authorize({ androidText, raspberryText });
  const commitments = buildB4SlotRunCommitments({
    collectionRunId: COLLECTION_RUN_ID,
    captureRunId: CAPTURE_RUN_ID
  });
  assert.deepEqual(
    {
      collection: result.collectionRunCommitmentSha256,
      capture: result.captureRunCommitmentSha256
    },
    {
      collection: commitments.collectionRunCommitmentSha256,
      capture: commitments.captureRunCommitmentSha256
    }
  );
  assert.equal(
    result.androidAttestationSha256,
    crypto.createHash("sha256").update(androidText).digest("hex")
  );
  assert.equal(
    result.raspberryAttestationSha256,
    crypto.createHash("sha256").update(raspberryText).digest("hex")
  );
  assert.equal(result.coverageStartedAt, "2026-08-05T00:00:00.000Z");
  assert.equal(result.coverageCompletedAt, "2026-08-05T00:02:00.000Z");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(COLLECTION_RUN_ID), false);
  assert.equal(result.captureRunId, CAPTURE_RUN_ID);
  assert.equal(result.targetHardwareCommitmentSha256, "9".repeat(64));
});

test("rejects a missing or canonically invalid monitor attestation", () => {
  assert.throws(
    () => authorize({ androidText: "" }),
    (error) =>
      error instanceof B4MonitoredSlotGateError &&
      error.code === "MONITOR_ATTESTATION_INVALID"
  );
  assert.throws(
    () =>
      authorize({
        parseAndroidAttestation: () => {
          throw new Error("synthetic parser failure");
        }
      }),
    (error) =>
      error instanceof B4MonitoredSlotGateError &&
      error.code === "MONITOR_ATTESTATION_INVALID"
  );
});

test("pure authorization cannot bypass the canonical monitor parsers", () => {
  const fixture = fixtures();
  assert.throws(
    () =>
      validateB4MonitoredSlotAuthorization({
        collectorState: collectorState(),
        captureRunId: CAPTURE_RUN_ID,
        expectedPackageName: "com.sentrapa.palmare.advanced",
        raspberryReport: fixture.runner,
        androidAttestationText: `${JSON.stringify(fixture.android)}\n`,
        raspberryAttestationText: `${JSON.stringify(fixture.raspberry)}\n`
      }),
    (error) =>
      error instanceof B4MonitoredSlotGateError &&
      error.code === "MONITOR_PARSER_UNAVAILABLE"
  );
});

test("rejects collection and capture commitment mismatches", () => {
  for (const field of [
    "collectionRunCommitmentSha256",
    "captureRunCommitmentSha256"
  ]) {
    const fixture = fixtures();
    fixture.raspberry.binding[field] = "f".repeat(64);
    assert.throws(
      () => authorize({ raspberry: fixture.raspberry }),
      (error) =>
        error instanceof B4MonitoredSlotGateError &&
        error.code === "MONITOR_BINDING_MISMATCH"
    );
  }
});

test("rejects a certification matrix mismatch", () => {
  const fixture = fixtures();
  fixture.android.binding.certificationMatrixSha256 = "f".repeat(64);
  assert.throws(
    () => authorize({ android: fixture.android }),
    (error) =>
      error instanceof B4MonitoredSlotGateError &&
      error.code === "MONITOR_MATRIX_MISMATCH"
  );
});

test("rejects a station or modified handheld target", () => {
  for (const change of [
    { role: "station" },
    { versionCode: 41 },
    { apkSha256: "f".repeat(64) },
    { signingCertificateSha256: "f".repeat(64) }
  ]) {
    const fixture = fixtures();
    Object.assign(fixture.android.target, change);
    assert.throws(
      () => authorize({ android: fixture.android }),
      (error) =>
        error instanceof B4MonitoredSlotGateError &&
        error.code === "MONITOR_TARGET_INVALID"
    );
  }
});

test("rejects a collector package other than the monitored handheld", () => {
  assert.throws(
    () =>
      authorize({
        expectedPackageName: "com.sentrapa.postazione.advanced"
      }),
    (error) =>
      error instanceof B4MonitoredSlotGateError &&
      error.code === "MONITOR_TARGET_INVALID"
  );
});

test("rejects partial runner, report and cleanup coverage", () => {
  const changes = [
    ["android", "monitoredFrom", "2026-08-05T00:00:11.000Z"],
    ["raspberry", "monitoredFrom", "2026-08-05T00:00:11.000Z"],
    ["raspberry", "runnerObservedAt", "2026-08-05T00:01:41.000Z"],
    ["raspberry", "cleanupObservedAt", "2026-08-05T00:01:39.000Z"],
    ["android", "monitoredUntil", "2026-08-05T00:01:40.000Z"]
  ];
  for (const [source, field, value] of changes) {
    const fixture = fixtures();
    fixture[source].coverage[field] = value;
    assert.throws(
      () => authorize({ [source]: fixture[source] }),
      (error) =>
        error instanceof B4MonitoredSlotGateError &&
        error.code === "MONITOR_COVERAGE_INCOMPLETE"
    );
  }
});

test("rejects a short or non-PASS B4.3 runner report", () => {
  for (const change of [
    { verdict: "FAIL" },
    { measurement: { requiredDurationSeconds: 90, wallClockDurationMs: 89_999 } },
    { phase: "B5" }
  ]) {
    const fixture = fixtures();
    Object.assign(fixture.runner, change);
    assert.throws(
      () => authorize({ runner: fixture.runner }),
      (error) =>
        error instanceof B4MonitoredSlotGateError &&
        error.code === "RUNNER_REPORT_INVALID"
    );
  }
});

test("requires distinct canonical collection and capture UUIDs", () => {
  assert.throws(
    () =>
      buildB4SlotRunCommitments({
        collectionRunId: COLLECTION_RUN_ID,
        captureRunId: COLLECTION_RUN_ID
      }),
    (error) =>
      error instanceof B4MonitoredSlotGateError &&
      error.code === "MONITOR_BINDING_INVALID"
  );
  assert.throws(
    () => authorize({ captureRunId: "not-a-uuid" }),
    (error) =>
      error instanceof B4MonitoredSlotGateError &&
      error.code === "MONITOR_BINDING_INVALID"
  );
});

test("hardware commitment binds secret identity, serial and capture domain", () => {
  const key = Buffer.alloc(32, 0x42);
  const serial = "PHYSICAL-SERIAL-001";
  const deviceDigest = crypto
    .createHmac("sha256", key)
    .update("V6:B4:PHYSICAL-DEVICE:")
    .update(serial)
    .digest("hex");
  const commitment = buildB4TargetHardwareCommitment(
    key,
    serial,
    CAPTURE_RUN_ID
  );
  assert.equal(
    commitment,
    buildB4TargetHardwareCommitmentFromDeviceDigest({
      identityKey: key,
      deviceDigest,
      captureRunId: CAPTURE_RUN_ID
    })
  );
  assert.notEqual(
    commitment,
    buildB4TargetHardwareCommitment(
      key,
      "PHYSICAL-SERIAL-002",
      CAPTURE_RUN_ID
    )
  );
  assert.equal(JSON.stringify({ commitment }).includes(serial), false);
  assert.throws(
    () => buildB4TargetHardwareCommitment(key, serial, "invalid"),
    (error) =>
      error instanceof B4MonitoredSlotGateError &&
      error.code === "TARGET_HARDWARE_BINDING_INVALID"
  );
});

test("real Android and Raspberry parsers authorize the same monitored slot", () => {
  const matrixBinding = ADVANCED_CERTIFICATION_TARGETS_BINDING;
  const state = {
    schemaVersion: 2,
    product: "V6",
    phase: "B4",
    runId: COLLECTION_RUN_ID,
    certificationMatrixBinding: matrixBinding
  };
  const android = buildB4AndroidContinuityAttestation({
    collectionRunId: COLLECTION_RUN_ID,
    captureRunId: CAPTURE_RUN_ID,
    certificationMatrixSha256: matrixBinding.matrixSha256,
    privateJournalSha256: "d".repeat(64),
    targetHardwareCommitmentSha256: "9".repeat(64),
    androidApi: 36,
    monitoredFrom: "2026-08-05T00:00:00.000Z",
    monitoredUntil: "2026-08-05T00:02:00.000Z",
    durationMs: 120_000,
    pollMs: 2_000,
    sampleCount: 61,
    maximumObservedGapMs: 2_000,
    generatedAt: "2026-08-05T00:02:00.000Z"
  });
  const raspberry = buildB4RaspberryContinuityAttestation({
    collectionRunId: COLLECTION_RUN_ID,
    captureRunId: CAPTURE_RUN_ID,
    certificationMatrixSha256: matrixBinding.matrixSha256,
    privateJournalSha256: "e".repeat(64),
    monitoredFrom: "2026-08-05T00:00:00.000Z",
    runnerObservedAt: "2026-08-05T00:00:11.000Z",
    cleanupObservedAt: "2026-08-05T00:01:41.000Z",
    monitoredUntil: "2026-08-05T00:01:42.000Z",
    durationMs: 102_000,
    pollMs: 2_000,
    sampleCount: 52,
    maximumObservedGapMs: 2_000,
    generatedAt: "2026-08-05T00:01:42.000Z"
  });
  const result = validateB4MonitoredSlotAuthorization(
    {
      collectorState: state,
      captureRunId: CAPTURE_RUN_ID,
      expectedPackageName:
        matrixBinding.matrix.roles.handheld.packageId,
      raspberryReport: fixtures().runner,
      androidAttestationText: `${JSON.stringify(android)}\n`,
      raspberryAttestationText: `${JSON.stringify(raspberry)}\n`
    },
    {
      parseAndroidAttestation: parseB4AndroidContinuityAttestation,
      parseRaspberryAttestation: parseB4RaspberryContinuityAttestation
    }
  );
  assert.equal(result.captureRunId, CAPTURE_RUN_ID);
  assert.equal(
    result.targetHardwareCommitmentSha256,
    "9".repeat(64)
  );
  assert.equal(
    result.certificationMatrixSha256,
    matrixBinding.matrixSha256
  );
});

test("wrapper refuses record before hardware when either attestation is absent", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "run-b4-monitored-slot-gate.mjs"),
      "--record",
      "--state",
      "/private/missing.json",
      "--capture-run-id",
      CAPTURE_RUN_ID,
      "--android-monitor-attestation",
      "/private/android.json",
      "--raspberry-report",
      "/private/report.json",
      "--raspberry-log",
      "/private/log.txt",
      "--serial",
      "TARGET",
      "--package",
      "com.sentrapa.palmare.advanced"
    ],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).failure.code, "INVALID_ARGUMENT");
});

test("wrapper record reaches the canonical monitor parser without an ESM deadlock", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v6-b4-wrapper-parser-")
  );
  fs.chmodSync(directory, 0o700);
  const statePath = path.join(directory, "state.json");
  const androidPath = path.join(directory, "android-monitor.json");
  const raspberryMonitorPath = path.join(
    directory,
    "raspberry-monitor.json"
  );
  const raspberryReportPath = path.join(directory, "raspberry-report.json");
  const raspberryLogPath = path.join(directory, "raspberry.log");
  const collectorPath = path.join(
    ROOT,
    "scripts",
    "collect-b4-physical-device.mjs"
  );
  const wrapperPath = path.join(
    ROOT,
    "scripts",
    "run-b4-monitored-slot-gate.mjs"
  );
  try {
    const initialized = spawnSync(
      process.execPath,
      [collectorPath, "--init", "--state", statePath],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(
      initialized.status,
      0,
      initialized.stderr || initialized.stdout
    );
    for (const [destination, content] of [
      [androidPath, "{}\n"],
      [raspberryMonitorPath, "{}\n"],
      [raspberryReportPath, "{}\n"],
      [raspberryLogPath, "synthetic parser-boundary fixture\n"]
    ]) {
      fs.writeFileSync(destination, content, { mode: 0o600 });
      fs.chmodSync(destination, 0o600);
    }
    const beforeBytes = fs.readFileSync(statePath);
    const beforeStat = fs.statSync(statePath);
    const result = spawnSync(
      process.execPath,
      [
        wrapperPath,
        "--record",
        "--state",
        statePath,
        "--capture-run-id",
        CAPTURE_RUN_ID,
        "--android-monitor-attestation",
        androidPath,
        "--raspberry-monitor-attestation",
        raspberryMonitorPath,
        "--raspberry-report",
        raspberryReportPath,
        "--raspberry-log",
        raspberryLogPath,
        "--adb",
        path.join(directory, "adb-must-not-run"),
        "--serial",
        "TEST-PHYSICAL-01",
        "--package",
        "com.sentrapa.palmare.advanced"
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.notEqual(result.error?.code, "ETIMEDOUT");
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/iu);
    assert.equal(
      JSON.parse(result.stdout).failure.code,
      "MONITOR_ATTESTATION_INVALID"
    );
    const afterStat = fs.statSync(statePath);
    assert.deepEqual(fs.readFileSync(statePath), beforeBytes);
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStat.ctimeMs, beforeStat.ctimeMs);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
    assert.equal(fs.existsSync(`${statePath}.evidence`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
