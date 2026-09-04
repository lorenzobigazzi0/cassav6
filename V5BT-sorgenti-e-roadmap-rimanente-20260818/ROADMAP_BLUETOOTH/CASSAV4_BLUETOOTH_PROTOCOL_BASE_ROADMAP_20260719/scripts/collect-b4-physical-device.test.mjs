import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  B4PhysicalCollectionError,
  MAX_ANDROID_RASPBERRY_SKEW_MS,
  MAX_RASPBERRY_EVIDENCE_AGE_MS,
  assertCollectionStateUnchanged,
  assertStateCertificationMatrixBinding,
  buildDevicePreflightReport,
  buildEvidenceManifest,
  buildManifestReadyReport,
  buildProgressReport,
  classifyPhysicalCandidate,
  createInitialState,
  deriveDeviceDigest,
  parseState,
  persistCaptureEvidence,
  recordEvidence,
  readStateSnapshot,
  runSelfTest,
  selectExplicitAdbTarget,
  validateAndroidEvidence,
  validateAndroidRadioStatus,
  validateRaspberryEvidence,
  withStableCertificationMatrix,
  withStableReadOnlyState
} from "./collect-b4-physical-device.mjs";
import {
  ADVANCED_CERTIFICATION_TARGETS_BINDING,
  buildAdvancedCertificationTargetsBinding
} from "./advanced-certification-targets.mjs";
import {
  buildB4TargetHardwareCommitmentFromDeviceDigest
} from "./run-b4-monitored-slot-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHYSICAL_REPORT_PATH = path.join(
  ROOT,
  "reports",
  "physical",
  "v5bt-b4-3-servicedata-gate-20260720.json"
);
const PHYSICAL_LOG_PATH = path.join(
  ROOT,
  "reports",
  "physical",
  "v5bt-b4-3-servicedata-node-20260720.log"
);
const HISTORICAL_B4_SOURCE_AVAILABLE =
  fs.existsSync(PHYSICAL_REPORT_PATH) && fs.existsSync(PHYSICAL_LOG_PATH);
const HISTORICAL_B4_SKIP = HISTORICAL_B4_SOURCE_AVAILABLE
  ? false
  : "external historical B4 source log is not included and must not be reconstructed";
const NOW = "2026-07-20T12:00:00.000Z";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const KEY = Buffer.alloc(32, 0x4b);

function initialState() {
  return createInitialState({
    now: NOW,
    runId: RUN_ID,
    identityKey: KEY
  });
}

function changedCertificationMatrixBinding() {
  const matrix = structuredClone(
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrix
  );
  matrix.roles.handheld.signingCertificateSha256 = "f".repeat(64);
  return buildAdvancedCertificationTargetsBinding(matrix);
}

function fakeRaspberryEvidence(index) {
  return {
    reportHash: crypto
      .createHash("sha256")
      .update(`report-${index}`)
      .digest("hex"),
    logHash: crypto
      .createHash("sha256")
      .update(`log-${index}`)
      .digest("hex"),
    generatedAt: NOW,
    generatedAtMs: Date.parse(NOW),
    observationsAccepted: 10 + index,
    lifecycleDurationMs: 90_000,
    wallClockDurationMs: 90_100,
    rssiDbm: { minimum: -70, maximum: -50, samples: 1 }
  };
}

function fakeMonitorEvidence(
  index,
  state = initialState(),
  deviceDigest = deriveDeviceDigest(
    KEY,
    `PHYSICAL-DEVICE-${String(index).padStart(2, "0")}`
  )
) {
  const digest = (label) => crypto
    .createHash("sha256")
    .update(`${label}-${index}`)
    .digest("hex");
  const captureRunId =
    `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`;
  return {
    collectionRunCommitmentSha256: crypto
      .createHash("sha256")
      .update(`V5BT:B4:COLLECTION_RUN:${state.runId}`)
      .digest("hex"),
    captureRunCommitmentSha256: crypto
      .createHash("sha256")
      .update(`V5BT:B4:CAPTURE_RUN:${captureRunId}`)
      .digest("hex"),
    captureRunId,
    certificationMatrixSha256:
      state.certificationMatrixBinding.matrixSha256,
    androidAttestationSha256: digest("android-monitor"),
    raspberryAttestationSha256: digest("raspberry-monitor"),
    targetPackageName: "com.sentrapa.palmare.advanced",
    targetAndroidApi: 35,
    targetHardwareCommitmentSha256:
      buildB4TargetHardwareCommitmentFromDeviceDigest({
        identityKey: KEY,
        deviceDigest,
        captureRunId
      }),
    coverageStartedAt: new Date(Date.parse(NOW) - 90_100).toISOString(),
    coverageCompletedAt: NOW
  };
}

function addDevice(state, index, overrides = {}) {
  const deviceDigest =
    overrides.deviceDigest ??
    deriveDeviceDigest(
      KEY,
      `PHYSICAL-DEVICE-${String(index).padStart(2, "0")}`
    );
  return recordEvidence(state, {
    deviceDigest,
    packageName:
      overrides.packageName ?? "com.sentrapa.palmare.advanced",
    model: overrides.model ?? "SM_A165F",
    androidApi: overrides.androidApi ?? 35,
    androidEvidence: overrides.androidEvidence ?? {
      sampledAt: NOW,
      sampleSequence: index
    },
    raspberryEvidence:
      overrides.raspberryEvidence ?? fakeRaspberryEvidence(index),
    monitorEvidence:
      overrides.monitorEvidence ??
      fakeMonitorEvidence(index, state, deviceDigest),
    recordedAt: NOW,
    evidenceRecordId:
      overrides.evidenceRecordId ??
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
  });
}

function validAndroidStatus(sampledAtEpochMs = Date.parse(NOW)) {
  return {
    readiness: "READY",
    ready: true,
    radioActive: true,
    sampleSequence: 7,
    sampledAtEpochMs,
    metrics: {
      advertisementsStarted: 1,
      advertisementFailures: 0,
      scanFailures: 0,
      scanIngressDropped: 0,
      invalidPayloads: 0
    }
  };
}

test("state v2 freezes the complete canonical certification matrix binding", () => {
  const state = initialState();
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(
    state.certificationMatrixBinding,
    ADVANCED_CERTIFICATION_TARGETS_BINDING
  );
  assert.equal(
    state.certificationMatrixBinding.matrix.roles.handheld
      .signingCertificateSha256,
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrix.roles.handheld
      .signingCertificateSha256
  );
  assert.equal(
    state.certificationMatrixBinding.matrix.roles.station
      .signingCertificateSha256,
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrix.roles.station
      .signingCertificateSha256
  );
  assert.deepEqual(
    assertStateCertificationMatrixBinding(state),
    ADVANCED_CERTIFICATION_TARGETS_BINDING
  );
});

test("rejects legacy state instead of reconstructing or upgrading it", () => {
  const legacy = { ...initialState(), schemaVersion: 1 };
  delete legacy.certificationMatrixBinding;
  assert.throws(
    () => parseState(legacy),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "STATE_LEGACY_REJECTED"
  );
});

test("rejects tampered and changed matrix bindings before collection", async () => {
  const state = initialState();
  const tampered = structuredClone(state);
  tampered.certificationMatrixBinding.matrixSha256 = "0".repeat(64);
  assert.throws(
    () => parseState(tampered),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "STATE_CERTIFICATION_MATRIX_INVALID"
  );

  const changed = changedCertificationMatrixBinding();
  const mismatched = {
    ...state,
    certificationMatrixBinding: structuredClone(changed)
  };
  assert.throws(
    () => parseState(mismatched),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "CERTIFICATION_MATRIX_BINDING_MISMATCH"
  );

  let collectionActionStarted = false;
  await assert.rejects(
    withStableCertificationMatrix(
      state,
      async () => {
        collectionActionStarted = true;
      },
      { readBinding: () => changed }
    ),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "CERTIFICATION_MATRIX_BINDING_MISMATCH"
  );
  assert.equal(collectionActionStarted, false);
});

test("fails closed when the matrix changes during a collection action", async () => {
  const state = initialState();
  const changed = changedCertificationMatrixBinding();
  let reads = 0;
  let collectionActionCompleted = false;
  await assert.rejects(
    withStableCertificationMatrix(
      state,
      async () => {
        collectionActionCompleted = true;
      },
      {
        readBinding: () => {
          reads += 1;
          return reads === 1
            ? ADVANCED_CERTIFICATION_TARGETS_BINDING
            : changed;
        }
      }
    ),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "CERTIFICATION_MATRIX_CHANGED_DURING_COLLECTION"
  );
  assert.equal(collectionActionCompleted, true);
  assert.equal(reads, 2);
});

test("validates the canonical B4.3 report against its real source log", {
  skip: HISTORICAL_B4_SKIP
}, () => {
  const reportText = fs.readFileSync(PHYSICAL_REPORT_PATH, "utf8");
  const report = JSON.parse(reportText);
  const rawLog = fs.readFileSync(PHYSICAL_LOG_PATH, "utf8");
  const evidence = validateRaspberryEvidence(report, rawLog, "handheld", {
    nowMs: Date.parse(report.generatedAt) + 1_000,
    rawReportText: reportText
  });
  assert.equal(evidence.observationsAccepted, 259);
  assert.equal(evidence.lifecycleDurationMs >= 75_000, true);
  assert.equal(
    evidence.reportHash,
    crypto.createHash("sha256").update(reportText).digest("hex")
  );
  assert.equal(
    evidence.logHash,
    crypto.createHash("sha256").update(rawLog).digest("hex")
  );
});

test("rejects stale, tampered, or wrong-kind Raspberry evidence", {
  skip: HISTORICAL_B4_SKIP
}, () => {
  const reportText = fs.readFileSync(PHYSICAL_REPORT_PATH, "utf8");
  const report = JSON.parse(reportText);
  const rawLog = fs.readFileSync(PHYSICAL_LOG_PATH, "utf8");
  assert.throws(
    () =>
      validateRaspberryEvidence(report, rawLog, "handheld", {
        nowMs:
          Date.parse(report.generatedAt) +
          MAX_RASPBERRY_EVIDENCE_AGE_MS +
          1
      }),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "RASPBERRY_EVIDENCE_STALE"
  );
  assert.throws(
    () => validateRaspberryEvidence(report, `${rawLog}\n`, "handheld", {
      nowMs: Date.parse(report.generatedAt)
    }),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "RASPBERRY_LOG_HASH_MISMATCH"
  );
  assert.throws(
    () => validateRaspberryEvidence(report, rawLog, "station", {
      nowMs: Date.parse(report.generatedAt)
    }),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "RASPBERRY_NODE_KIND_MISMATCH"
  );
});

test("requires fresh and temporally correlated Android advertising evidence", () => {
  const timestamp = Date.parse(NOW);
  const radioEvidence = validateAndroidRadioStatus(
    validAndroidStatus(timestamp),
    { nowMs: timestamp + 1_000 }
  );
  assert.equal(radioEvidence.sampledAt, NOW);
  const accepted = validateAndroidEvidence(
    validAndroidStatus(timestamp),
    timestamp,
    { nowMs: timestamp + 1_000 }
  );
  assert.equal(accepted.sampledAt, NOW);
  assert.throws(
    () =>
      validateAndroidEvidence(
        validAndroidStatus(timestamp),
        timestamp + MAX_ANDROID_RASPBERRY_SKEW_MS + 1,
        { nowMs: timestamp + 1_000 }
      ),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "ANDROID_RASPBERRY_TIME_MISMATCH"
  );
  assert.throws(
    () =>
      validateAndroidEvidence(
        {
          ...validAndroidStatus(timestamp),
          metrics: {
            ...validAndroidStatus(timestamp).metrics,
            advertisementFailures: 1
          }
        },
        timestamp,
        { nowMs: timestamp + 1_000 }
      ),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "ANDROID_RADIO_EVIDENCE_INVALID"
  );
});

test("preflight classifies a new device without mutating collection state", () => {
  const state = addDevice(initialState(), 1).state;
  const originalState = JSON.stringify(state);
  const candidateDigest = deriveDeviceDigest(KEY, "PHYSICAL-DEVICE-02");
  const classification = classifyPhysicalCandidate(state, candidateDigest);
  const report = buildDevicePreflightReport(state, {
    deviceDigest: candidateDigest,
    packageName: "com.sentrapa.postazione.advanced",
    model: "SM-X210",
    androidApi: 35,
    androidEvidence: {
      sampledAt: NOW,
      sampleSequence: 8
    },
    canonicalChecks: {
      passed: 14,
      total: 14
    },
    generatedAt: NOW
  });

  assert.equal(classification.eligible, true);
  assert.equal(classification.requestedSlot, 2);
  assert.equal(report.verdict, "PASS");
  assert.equal(report.candidate.eligibleForNextSlot, true);
  assert.equal(report.candidate.reasonCode, "READY_FOR_CAPTURE");
  assert.equal(report.candidate.requestedSlot, 2);
  assert.equal(report.candidate.existingSlot, null);
  assert.equal(report.effects.raspberryEvidenceConsumed, false);
  assert.equal(report.effects.privateStateWritten, false);
  assert.equal(report.effects.evidenceStaged, false);
  assert.equal(JSON.stringify(state), originalState);
});

test("preflight rejects an existing device without exposing private identity", () => {
  const state = addDevice(initialState(), 1).state;
  const existingDigest = state.records[0].deviceDigest;
  const classification = classifyPhysicalCandidate(state, existingDigest);
  const report = buildDevicePreflightReport(state, {
    deviceDigest: existingDigest,
    packageName: "com.sentrapa.palmare.advanced",
    model: "SM-A165F",
    androidApi: 36,
    androidEvidence: {
      sampledAt: NOW,
      sampleSequence: 9
    },
    canonicalChecks: {
      passed: 14,
      total: 14
    },
    generatedAt: NOW
  });
  const serialized = JSON.stringify(report);

  assert.equal(classification.eligible, false);
  assert.equal(classification.reasonCode, "ALREADY_RECORDED");
  assert.equal(report.verdict, "NOT_ELIGIBLE");
  assert.equal(report.candidate.eligibleForNextSlot, false);
  assert.equal(report.candidate.existingSlot, 1);
  assert.equal(report.candidate.requestedSlot, 2);
  assert.equal(serialized.includes(existingDigest), false);
  assert.equal(serialized.includes(state.identityKeyBase64Url), false);
  assert.equal(serialized.includes('"deviceDigest":'), false);
  assert.equal(serialized.includes('"identityKeyBase64Url":'), false);
  assert.equal(serialized.includes('"serial":'), false);
});

test("strict preflight state snapshot is read-only and creates no lock", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-readonly-"));
  const statePath = path.join(directory, "state.json");
  try {
    fs.writeFileSync(statePath, `${JSON.stringify(initialState(), null, 2)}\n`, {
      mode: 0o600
    });
    fs.chmodSync(statePath, 0o600);
    const beforeBytes = fs.readFileSync(statePath);
    const beforeStat = fs.statSync(statePath);
    const result = await withStableReadOnlyState(statePath, async (state) =>
      state.records.length
    );
    const afterStat = fs.statSync(statePath);
    assert.equal(result, 0);
    assert.deepEqual(fs.readFileSync(statePath), beforeBytes);
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
    const snapshot = readStateSnapshot(statePath).state;
    assert.equal(snapshot.records.length, 0);
    assert.deepEqual(
      snapshot.certificationMatrixBinding,
      ADVANCED_CERTIFICATION_TARGETS_BINDING
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("strict preflight detects state replacement even with identical bytes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-changed-"));
  const statePath = path.join(directory, "state.json");
  const replacement = path.join(directory, "replacement.json");
  try {
    const bytes = `${JSON.stringify(initialState(), null, 2)}\n`;
    fs.writeFileSync(statePath, bytes, { mode: 0o600 });
    fs.chmodSync(statePath, 0o600);
    await assert.rejects(
      withStableReadOnlyState(statePath, async () => {
        fs.writeFileSync(replacement, bytes, { mode: 0o600 });
        fs.chmodSync(replacement, 0o600);
        fs.renameSync(replacement, statePath);
      }),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "STATE_CHANGED_DURING_PREFLIGHT"
    );
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("record guard rejects state replacement and mutation before commit", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-b4-record-state-change-")
  );
  const statePath = path.join(directory, "state.json");
  const replacementPath = path.join(directory, "replacement.json");
  const original = `${JSON.stringify(initialState(), null, 2)}\n`;
  try {
    for (const mutate of [
      () => {
        fs.writeFileSync(replacementPath, original, { mode: 0o600 });
        fs.renameSync(replacementPath, statePath);
      },
      () => {
        const changed = initialState();
        changed.updatedAt = "2026-07-20T12:00:01.000Z";
        fs.writeFileSync(
          statePath,
          `${JSON.stringify(changed, null, 2)}\n`,
          { mode: 0o600 }
        );
      }
    ]) {
      fs.writeFileSync(statePath, original, { mode: 0o600 });
      const snapshot = readStateSnapshot(statePath);
      mutate();
      assert.throws(
        () =>
          assertCollectionStateUnchanged(statePath, snapshot.fingerprint),
        (error) =>
          error instanceof B4PhysicalCollectionError &&
          error.code === "STATE_CHANGED_DURING_COLLECTION"
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI preflight rejects matrix mismatch before attempting ADB and stays read-only", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-b4-matrix-preflight-")
  );
  const statePath = path.join(directory, "state.json");
  const missingAdb = path.join(directory, "adb-must-not-run");
  try {
    const state = {
      ...initialState(),
      certificationMatrixBinding: structuredClone(
        changedCertificationMatrixBinding()
      )
    };
    const bytes = `${JSON.stringify(state, null, 2)}\n`;
    fs.writeFileSync(statePath, bytes, { mode: 0o600 });
    fs.chmodSync(statePath, 0o600);
    const before = fs.statSync(statePath);
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "collect-b4-physical-device.mjs"),
        "--preflight",
        "--state",
        statePath,
        "--adb",
        missingAdb,
        "--serial",
        "TEST-PHYSICAL-01",
        "--package",
        "com.sentrapa.palmare.advanced"
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).failure.code,
      "CERTIFICATION_MATRIX_BINDING_MISMATCH"
    );
    const after = fs.statSync(statePath);
    assert.equal(fs.readFileSync(statePath, "utf8"), bytes);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("strict state snapshots reject symlinks, hardlinks and loose modes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-links-"));
  const statePath = path.join(directory, "state.json");
  const linkPath = path.join(directory, "state-link.json");
  const hardlinkPath = path.join(directory, "state-hardlink.json");
  try {
    fs.writeFileSync(statePath, `${JSON.stringify(initialState(), null, 2)}\n`, {
      mode: 0o600
    });
    fs.symlinkSync(statePath, linkPath);
    assert.throws(
      () => readStateSnapshot(linkPath),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "STATE_READ_FAILED"
    );
    fs.linkSync(statePath, hardlinkPath);
    assert.throws(
      () => readStateSnapshot(statePath),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "STATE_READ_FAILED"
    );
    fs.rmSync(hardlinkPath);
    fs.chmodSync(statePath, 0o640);
    assert.throws(
      () => readStateSnapshot(statePath),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "STATE_NOT_PRIVATE"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit B4 target remains unambiguous with two authorized ADB devices", () => {
  const inventory = [
    "List of devices attached",
    "PRIMARY device product:a model:Model_A device:a",
    "SUPPLEMENTAL device product:b model:Model_B device:b",
    ""
  ].join("\n");
  assert.equal(
    selectExplicitAdbTarget(inventory, "SUPPLEMENTAL").serial,
    "SUPPLEMENTAL"
  );
  assert.throws(
    () => selectExplicitAdbTarget(inventory, "ABSENT"),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "ADB_TARGET_UNAVAILABLE"
  );
});

test("keeps one physical device pending even when aliases rotated", () => {
  const result = addDevice(initialState(), 1, {
    raspberryEvidence: {
      ...fakeRaspberryEvidence(1),
      observationsAccepted: 259
    }
  });
  const report = buildProgressReport(result.state, { generatedAt: NOW });
  assert.equal(result.status, "RECORDED");
  assert.equal(report.verdict, "PENDING");
  assert.equal(report.gate.distinctPhysicalDevices, 1);
  assert.equal(report.gate.remainingPhysicalDevices, 9);
  assert.equal(report.devices[0].observationsAccepted, 259);
});

test("recordEvidence fails closed without a complete monitor authorization", () => {
  assert.throws(
    () =>
      recordEvidence(initialState(), {
        deviceDigest: deriveDeviceDigest(KEY, "PHYSICAL-DEVICE-01"),
        packageName: "com.sentrapa.palmare.advanced",
        model: "SM_A165F",
        androidApi: 35,
        androidEvidence: { sampledAt: NOW, sampleSequence: 1 },
        raspberryEvidence: fakeRaspberryEvidence(1),
        recordedAt: NOW,
        evidenceRecordId: "00000000-0000-4000-8000-000000000001"
      }),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "MONITOR_AUTHORIZATION_INVALID"
  );
});

test("recordEvidence binds the monitor to the collected package and API", () => {
  for (const change of [
    { targetPackageName: "com.sentrapa.postazione.advanced" },
    { targetAndroidApi: 36 }
  ]) {
    assert.throws(
      () =>
        addDevice(initialState(), 1, {
          monitorEvidence: {
            ...fakeMonitorEvidence(1),
            ...change
          }
        }),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "MONITOR_TARGET_MISMATCH"
    );
  }
});

test("collector refuses clock regression and timestamp detachment", () => {
  const firstAt = "2026-07-20T12:00:01.000Z";
  const state = recordEvidence(initialState(), {
    deviceDigest: deriveDeviceDigest(KEY, "PHYSICAL-DEVICE-01"),
    packageName: "com.sentrapa.palmare.advanced",
    model: "SM_A165F",
    androidApi: 35,
    androidEvidence: { sampledAt: NOW, sampleSequence: 1 },
    raspberryEvidence: fakeRaspberryEvidence(1),
    monitorEvidence: fakeMonitorEvidence(1),
    recordedAt: firstAt,
    evidenceRecordId: "00000000-0000-4000-8000-000000000001"
  }).state;
  assert.throws(
    () =>
      recordEvidence(state, {
        deviceDigest: deriveDeviceDigest(KEY, "PHYSICAL-DEVICE-02"),
        packageName: "com.sentrapa.palmare.advanced",
        model: "SM_A165F",
        androidApi: 35,
        androidEvidence: { sampledAt: NOW, sampleSequence: 2 },
        raspberryEvidence: fakeRaspberryEvidence(2),
        monitorEvidence: fakeMonitorEvidence(2, state),
        recordedAt: NOW,
        evidenceRecordId: "00000000-0000-4000-8000-000000000002"
      }),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "CLOCK_REGRESSION"
  );
  assert.throws(
    () => parseState({ ...state, updatedAt: "2026-07-20T12:00:02.000Z" }),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "STATE_INVALID"
  );
});

test("ten devices only make collection ready for the authoritative B4 gate", () => {
  let state = initialState();
  assert.throws(
    () => buildManifestReadyReport(state, { generatedAt: NOW }),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "COLLECTION_INCOMPLETE" &&
      error.exitCode === 2
  );
  for (let index = 1; index <= 10; index += 1) {
    state = addDevice(state, index).state;
  }
  const report = buildManifestReadyReport(state, { generatedAt: NOW });
  assert.equal(report.verdict, "PENDING");
  assert.equal(report.gate.distinctPhysicalDevices, 10);
  assert.equal(report.gate.remainingPhysicalDevices, 0);
  assert.equal(report.gate.collectionStatus, "READY");
  assert.equal(report.gate.authoritativeB4GateExecuted, false);
  assert.equal(report.gate.b4TenDeviceGate, "PENDING");
});

test("builds the exact private manifest consumed by the authoritative runner", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-b4-manifest-")
  );
  const statePath = path.join(directory, "b4-state.json");
  const manifestPath = path.join(directory, "manifest.json");
  const evidenceDirectory = `${statePath}.evidence`;
  let state = initialState();
  try {
    fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    for (let index = 1; index <= 10; index += 1) {
      state = addDevice(state, index).state;
      const suffix = String(index).padStart(2, "0");
      fs.writeFileSync(
        path.join(evidenceDirectory, `capture-${suffix}.json`),
        `report-${index}`,
        { mode: 0o600 }
      );
      fs.writeFileSync(
        path.join(evidenceDirectory, `capture-${suffix}.log`),
        `log-${index}`,
        { mode: 0o600 }
      );
      fs.writeFileSync(
        path.join(
          evidenceDirectory,
          `capture-${suffix}.android-monitor.json`
        ),
        `android-monitor-${index}`,
        { mode: 0o600 }
      );
      fs.writeFileSync(
        path.join(
          evidenceDirectory,
          `capture-${suffix}.raspberry-monitor.json`
        ),
        `raspberry-monitor-${index}`,
        { mode: 0o600 }
      );
    }
    const manifest = buildEvidenceManifest(
      state,
      statePath,
      manifestPath
    );
    assert.equal(manifest.gate, "B4_TEN_PHYSICAL_DEVICES");
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.collectionRunId, state.runId);
    assert.equal(
      manifest.certificationMatrixSha256,
      state.certificationMatrixBinding.matrixSha256
    );
    assert.equal(manifest.collectorReport, "collector-final.json");
    assert.equal(manifest.captures.length, 10);
    assert.deepEqual(manifest.captures[0], {
      slot: 1,
      captureRunId: state.records[0].monitorEvidence.captureRunId,
      report: "b4-state.json.evidence/capture-01.json",
      log: "b4-state.json.evidence/capture-01.log",
      androidMonitor:
        "b4-state.json.evidence/capture-01.android-monitor.json",
      androidMonitorSha256:
        state.records[0].monitorEvidence.androidAttestationSha256,
      raspberryMonitor:
        "b4-state.json.evidence/capture-01.raspberry-monitor.json",
      raspberryMonitorSha256:
        state.records[0].monitorEvidence.raspberryAttestationSha256
    });
    const serialized = JSON.stringify(manifest);
    assert.equal(serialized.includes(state.identityKeyBase64Url), false);
    assert.equal(serialized.includes(state.records[0].deviceDigest), false);
    fs.chmodSync(evidenceDirectory, 0o755);
    assert.throws(
      () => buildEvidenceManifest(state, statePath, manifestPath),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "PRIVATE_EVIDENCE_DIRECTORY_INVALID"
    );
    fs.chmodSync(evidenceDirectory, 0o700);
    const realEvidenceDirectory = `${evidenceDirectory}.real`;
    fs.renameSync(evidenceDirectory, realEvidenceDirectory);
    fs.symlinkSync(realEvidenceDirectory, evidenceDirectory, "dir");
    assert.throws(
      () => buildEvidenceManifest(state, statePath, manifestPath),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "PRIVATE_EVIDENCE_DIRECTORY_INVALID"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("finalization refuses missing or altered staged monitor attestations", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-b4-monitor-finalize-")
  );
  const statePath = path.join(directory, "b4-state.json");
  const manifestPath = path.join(directory, "manifest.json");
  const evidenceDirectory = `${statePath}.evidence`;
  let state = initialState();
  try {
    fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    for (let index = 1; index <= 10; index += 1) {
      state = addDevice(state, index).state;
      const suffix = String(index).padStart(2, "0");
      for (const [name, content] of [
        [`capture-${suffix}.json`, `report-${index}`],
        [`capture-${suffix}.log`, `log-${index}`],
        [
          `capture-${suffix}.android-monitor.json`,
          `android-monitor-${index}`
        ],
        [
          `capture-${suffix}.raspberry-monitor.json`,
          `raspberry-monitor-${index}`
        ]
      ]) {
        fs.writeFileSync(path.join(evidenceDirectory, name), content, {
          mode: 0o600
        });
      }
    }
    const androidPath = path.join(
      evidenceDirectory,
      "capture-01.android-monitor.json"
    );
    fs.rmSync(androidPath);
    assert.throws(
      () => buildEvidenceManifest(state, statePath, manifestPath),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "PRIVATE_EVIDENCE_MISSING"
    );
    fs.writeFileSync(androidPath, "altered", { mode: 0o600 });
    assert.throws(
      () => buildEvidenceManifest(state, statePath, manifestPath),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "PRIVATE_EVIDENCE_HASH_MISMATCH"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("staging recovers an incomplete uncommitted slot without overwriting a commit", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-b4-monitor-recovery-")
  );
  const statePath = path.join(directory, "b4-state.json");
  const evidenceDirectory = `${statePath}.evidence`;
  const record = addDevice(initialState(), 1).record;
  const paths = {
    report: path.join(evidenceDirectory, "capture-01.json"),
    log: path.join(evidenceDirectory, "capture-01.log"),
    android: path.join(
      evidenceDirectory,
      "capture-01.android-monitor.json"
    ),
    raspberry: path.join(
      evidenceDirectory,
      "capture-01.raspberry-monitor.json"
    )
  };
  try {
    fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
    fs.writeFileSync(paths.report, "stale-uncommitted", { mode: 0o600 });
    persistCaptureEvidence(
      statePath,
      record,
      "report-1",
      "log-1",
      "android-monitor-1",
      "raspberry-monitor-1",
      { replaceUncommitted: true }
    );
    assert.equal(fs.readFileSync(paths.report, "utf8"), "report-1");
    assert.equal(fs.readFileSync(paths.log, "utf8"), "log-1");
    assert.equal(
      fs.readFileSync(paths.android, "utf8"),
      "android-monitor-1"
    );
    assert.equal(
      fs.readFileSync(paths.raspberry, "utf8"),
      "raspberry-monitor-1"
    );
    persistCaptureEvidence(
      statePath,
      record,
      "report-1",
      "log-1",
      "android-monitor-1",
      "raspberry-monitor-1"
    );
    fs.writeFileSync(paths.report, "changed", { mode: 0o600 });
    assert.throws(
      () =>
        persistCaptureEvidence(
          statePath,
          record,
          "report-1",
          "log-1",
          "android-monitor-1",
          "raspberry-monitor-1"
        ),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "PRIVATE_EVIDENCE_CONFLICT"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("duplicate device is idempotent only for the exact same evidence", () => {
  const first = addDevice(initialState(), 1);
  const same = addDevice(first.state, 1, {
    evidenceRecordId: "00000000-0000-4000-8999-000000000999"
  });
  assert.equal(same.status, "ALREADY_RECORDED");
  assert.equal(same.state.records.length, 1);
  assert.throws(
    () =>
      addDevice(first.state, 1, {
        raspberryEvidence: fakeRaspberryEvidence(2)
      }),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "DEVICE_ALREADY_RECORDED"
  );
});

test("does not assign one Raspberry proof to two physical devices", () => {
  const first = addDevice(initialState(), 1);
  assert.throws(
    () =>
      addDevice(first.state, 2, {
        raspberryEvidence: fakeRaspberryEvidence(1)
      }),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "EVIDENCE_ALREADY_USED"
  );
});

test("does not reuse a capture run or either monitor attestation", () => {
  const first = addDevice(initialState(), 1);
  for (const field of [
    "captureRunCommitmentSha256",
    "androidAttestationSha256",
    "raspberryAttestationSha256"
  ]) {
    const monitorEvidence = fakeMonitorEvidence(2, first.state);
    monitorEvidence[field] = first.state.records[0].monitorEvidence[field];
    if (field === "captureRunCommitmentSha256") {
      monitorEvidence.captureRunId =
        first.state.records[0].monitorEvidence.captureRunId;
      monitorEvidence.targetHardwareCommitmentSha256 =
        buildB4TargetHardwareCommitmentFromDeviceDigest({
          identityKey: KEY,
          deviceDigest: deriveDeviceDigest(KEY, "PHYSICAL-DEVICE-02"),
          captureRunId: monitorEvidence.captureRunId
        });
    }
    assert.throws(
      () => addDevice(first.state, 2, { monitorEvidence }),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "EVIDENCE_ALREADY_USED"
    );
  }
});

test("public reports contain no hardware serial, HMAC key, or device digest", () => {
  const state = initialState();
  const serial = "PRIVATE-SERIAL-0001";
  const digest = deriveDeviceDigest(KEY, serial);
  const recorded = addDevice(state, 1, { deviceDigest: digest }).state;
  const serialized = JSON.stringify(
    buildProgressReport(recorded, { generatedAt: NOW })
  );
  assert.equal(serialized.includes(serial), false);
  assert.equal(serialized.includes(digest), false);
  assert.equal(serialized.includes(state.identityKeyBase64Url), false);
  assert.equal(serialized.includes("identityKeyBase64Url"), false);
  assert.equal(serialized.includes("monitorEvidence"), false);
  assert.equal(
    buildProgressReport(recorded, { generatedAt: NOW }).devices.some(
      (device) => Object.hasOwn(device, "deviceDigest")
    ),
    false
  );
});

test("rejects malformed state and duplicate device digests", () => {
  const state = addDevice(initialState(), 1).state;
  const duplicate = {
    ...state,
    records: [
      ...state.records,
      {
        ...state.records[0],
        ordinal: 2,
        evidenceRecordId: "00000000-0000-4000-8999-000000000999",
        raspberryReportSha256: "c".repeat(64),
        raspberryLogSha256: "d".repeat(64)
      }
    ]
  };
  assert.throws(
    () => parseState(duplicate),
    (error) =>
      error instanceof B4PhysicalCollectionError &&
      error.code === "STATE_INVALID"
  );
});

test("parseState revalidates every persisted monitor binding", () => {
  const state = addDevice(initialState(), 1).state;
  for (const change of [
    { collectionRunCommitmentSha256: "f".repeat(64) },
    { certificationMatrixSha256: "f".repeat(64) },
    { targetPackageName: "com.sentrapa.postazione.advanced" },
    { targetAndroidApi: 36 },
    { captureRunId: "00000000-0000-4000-8001-000000000099" },
    { targetHardwareCommitmentSha256: "f".repeat(64) }
  ]) {
    const changed = structuredClone(state);
    Object.assign(changed.records[0].monitorEvidence, change);
    assert.throws(
      () => parseState(changed),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "STATE_INVALID"
    );
  }
});

test("parseState rejects impossible persisted monitored-slot timelines", () => {
  const state = addDevice(initialState(), 1).state;
  const mutations = [
    (record) => {
      record.monitorEvidence.coverageStartedAt = record.raspberryGeneratedAt;
    },
    (record) => {
      record.monitorEvidence.coverageCompletedAt =
        "2026-07-20T12:00:01.000Z";
    },
    (record) => {
      record.androidSampledAt = "2026-07-20T12:00:01.000Z";
    },
    (record) => {
      record.raspberryGeneratedAt = "2026-07-20T12:00:01.000Z";
    }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(state);
    mutate(changed.records[0]);
    assert.throws(
      () => parseState(changed),
      (error) =>
        error instanceof B4PhysicalCollectionError &&
        error.code === "STATE_INVALID"
    );
  }
});

test("CLI init creates a private state atomically in a new directory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-gate-"));
  const statePath = path.join(directory, "private", "gate.json");
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "collect-b4-physical-device.mjs"),
        "--init",
        "--state",
        statePath
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const state = parseState(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.records.length, 0);
    assert.deepEqual(
      state.certificationMatrixBinding,
      ADVANCED_CERTIFICATION_TARGETS_BINDING
    );
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
    assert.equal(JSON.parse(result.stdout).verdict, "PENDING");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI finalize writes the bound collector report and verifier manifest", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-b4-finalize-")
  );
  const statePath = path.join(directory, "gate.json");
  const manifestPath = path.join(directory, "manifest.json");
  const evidenceDirectory = `${statePath}.evidence`;
  let state = initialState();
  try {
    fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    for (let index = 1; index <= 10; index += 1) {
      state = addDevice(state, index).state;
      const suffix = String(index).padStart(2, "0");
      fs.writeFileSync(
        path.join(evidenceDirectory, `capture-${suffix}.json`),
        `report-${index}`,
        { mode: 0o600 }
      );
      fs.writeFileSync(
        path.join(evidenceDirectory, `capture-${suffix}.log`),
        `log-${index}`,
        { mode: 0o600 }
      );
      fs.writeFileSync(
        path.join(
          evidenceDirectory,
          `capture-${suffix}.android-monitor.json`
        ),
        `android-monitor-${index}`,
        { mode: 0o600 }
      );
      fs.writeFileSync(
        path.join(
          evidenceDirectory,
          `capture-${suffix}.raspberry-monitor.json`
        ),
        `raspberry-monitor-${index}`,
        { mode: 0o600 }
      );
    }
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(state, null, 2)}\n`,
      { mode: 0o600 }
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "collect-b4-physical-device.mjs"),
        "--finalize",
        "--state",
        statePath,
        "--manifest",
        manifestPath
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.collectorReport, "collector-final.json");
    const collectorReport = JSON.parse(
      fs.readFileSync(
        path.join(directory, manifest.collectorReport),
        "utf8"
      )
    );
    assert.equal(collectorReport.operation, "MANIFEST_READY");
    assert.equal(collectorReport.gate.collectionStatus, "READY");
    assert.equal(collectorReport.gate.b4TenDeviceGate, "PENDING");
    const collectorReportPath = path.join(
      directory,
      manifest.collectorReport
    );
    const beforeRetry = {
      manifest: fs.readFileSync(manifestPath),
      report: fs.readFileSync(collectorReportPath),
      manifestMtime: fs.statSync(manifestPath).mtimeMs,
      reportMtime: fs.statSync(collectorReportPath).mtimeMs
    };
    const retry = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "collect-b4-physical-device.mjs"),
        "--finalize",
        "--state",
        statePath,
        "--manifest",
        manifestPath
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.deepEqual(fs.readFileSync(manifestPath), beforeRetry.manifest);
    assert.deepEqual(fs.readFileSync(collectorReportPath), beforeRetry.report);
    assert.equal(fs.statSync(manifestPath).mtimeMs, beforeRetry.manifestMtime);
    assert.equal(
      fs.statSync(collectorReportPath).mtimeMs,
      beforeRetry.reportMtime
    );
    fs.writeFileSync(manifestPath, "different", { mode: 0o600 });
    const conflict = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "collect-b4-physical-device.mjs"),
        "--finalize",
        "--state",
        statePath,
        "--manifest",
        manifestPath
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(conflict.status, 1);
    assert.equal(
      JSON.parse(conflict.stdout).failure.code,
      "FINAL_ARTIFACT_CONFLICT"
    );
    assert.deepEqual(fs.readFileSync(collectorReportPath), beforeRetry.report);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI refuses to overwrite its private state with public output", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-b4-collision-")
  );
  const statePath = path.join(directory, "gate.json");
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "collect-b4-physical-device.mjs"),
        "--init",
        "--state",
        statePath,
        "--output",
        statePath
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(statePath), false);
    assert.equal(
      JSON.parse(result.stdout).failure.code,
      "INVALID_ARGUMENT"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI requires an explicit serial before any B4 ADB preflight", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-serial-"));
  const statePath = path.join(directory, "missing-state.json");
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "collect-b4-physical-device.mjs"),
        "--preflight",
        "--state",
        statePath,
        "--package",
        "com.sentrapa.palmare.advanced"
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).failure.code, "INVALID_ARGUMENT");
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI record cannot bypass the dual-monitor authorization", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-b4-monitor-required-")
  );
  const statePath = path.join(directory, "missing-state.json");
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "collect-b4-physical-device.mjs"),
        "--record",
        "--state",
        statePath,
        "--serial",
        "TARGET",
        "--package",
        "com.sentrapa.palmare.advanced",
        "--raspberry-report",
        path.join(directory, "report.json"),
        "--raspberry-log",
        path.join(directory, "report.log")
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(result.status, 1);
    assert.equal(
      JSON.parse(result.stdout).failure.code,
      "INVALID_ARGUMENT"
    );
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI output cannot overwrite any staged evidence path", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-b4-output-evidence-")
  );
  const statePath = path.join(directory, "gate.json");
  const outputPath = path.join(
    `${statePath}.evidence`,
    "capture-01.android-monitor.json"
  );
  try {
    for (const args of [
      [
        "--record",
        "--state",
        statePath,
        "--serial",
        "TARGET",
        "--package",
        "com.sentrapa.palmare.advanced",
        "--capture-run-id",
        "00000000-0000-4000-8000-000000000002",
        "--android-monitor-attestation",
        path.join(directory, "android.json"),
        "--raspberry-monitor-attestation",
        path.join(directory, "raspberry.json"),
        "--raspberry-report",
        path.join(directory, "report.json"),
        "--raspberry-log",
        path.join(directory, "report.log"),
        "--output",
        outputPath
      ],
      [
        "--finalize",
        "--state",
        statePath,
        "--manifest",
        path.join(directory, "manifest.json"),
        "--output",
        outputPath
      ]
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          path.join(ROOT, "scripts", "collect-b4-physical-device.mjs"),
          ...args
        ],
        { encoding: "utf8", timeout: 10_000 }
      );
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).failure.code, "INVALID_ARGUMENT");
      assert.equal(fs.existsSync(outputPath), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI help documents explicit target selection for B4", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "collect-b4-physical-device.mjs"),
      "--help"
    ],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /require an explicit ADB serial/);
  assert.match(result.stdout, /reads only the selected/);
  assert.doesNotMatch(result.stdout, /accept no ADB serial/);
});

test("module import from stdin does not execute the CLI", () => {
  const moduleUrl = pathToFileURL(
    path.join(ROOT, "scripts", "collect-b4-physical-device.mjs")
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(moduleUrl)}); process.stdout.write("OK")`
    ],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "OK");
});

test("self-test never claims or mutates physical B4 evidence", () => {
  const result = runSelfTest();
  assert.equal(result.mode, "SELF_TEST");
  assert.equal(result.verdict, "PASS");
  assert.equal(result.physicalEvidenceConsumed, false);
  assert.equal(result.privateStateWritten, false);
  assert.equal(result.authoritativeB4GateExecuted, false);
  assert.equal(result.b4GatePromoted, false);
});
