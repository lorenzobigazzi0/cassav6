import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  B4_4_ALIAS_CLOCK_OFFSETS_SECONDS,
  B4_4_REQUIRED_DISTINCT_DEVICES,
  B4TenDeviceGateError,
  aggregateValidatedCaptures,
  assertReportRedacted,
  parseEvidenceManifest,
  readPrivateRegularFile,
  resolveCaptureIdentity,
  runSelfTest,
  validateCaptureMonitorEvidence,
  validateCollectorReport
} from "../scripts/run-b4-ten-device-gate.mjs";
import {
  buildB4AndroidContinuityAttestation,
  parseB4AndroidContinuityAttestation
} from "../../../../scripts/run-v5bt-b4-android-continuity-monitor.mjs";
import {
  buildB4RaspberryContinuityAttestation,
  parseB4RaspberryContinuityAttestation
} from "../../../../scripts/run-v5bt-b4-raspberry-continuity-monitor.mjs";
import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from "../../scripts/advanced-certification-targets.mjs";

const COLLECTION_RUN_ID = "00000000-0000-4000-8000-000000000001";
const CAPTURE_RUN_ID = "00000000-0000-4000-8000-000000000101";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function capture(slot, overrides = {}) {
  const startTimeMs = slot * 100_000;
  return {
    slot,
    identityKey: `private-identity-${slot}`,
    sourceReportSha256: hash(`report-${slot}`),
    sourceLogSha256: hash(`log-${slot}`),
    startTimeMs,
    endTimeMs: startTimeMs + 90_000,
    wallClockDurationMs: 90_000,
    lifecycleDurationMs: 89_000,
    observationsAccepted: 100 + slot,
    prunePasses: 90,
    expiredStreamsRemoved: 1,
    peersPruned: 1,
    nodeKinds: slot % 2 === 0 ? ["station"] : ["handheld"],
    rssiDbm: {
      minimum: -70,
      maximum: -50,
      samples: 1
    },
    ...overrides
  };
}

function captures() {
  return Array.from(
    { length: B4_4_REQUIRED_DISTINCT_DEVICES },
    (_, index) => capture(index + 1)
  );
}

function collectorEvidence() {
  return {
    sourceCollectorReportSha256: hash("collector-report"),
    distinctPhysicalDevices: 10,
    hardwareIdentityProof: "PASS",
    evidenceHashBinding: "PASS",
    monitorContinuityBinding: "PASS"
  };
}

function aggregate(values, options = {}) {
  return aggregateValidatedCaptures(values, {
    collectorEvidence: collectorEvidence(),
    ...options
  });
}

function manifest(overrides = {}) {
  const value = {
    schemaVersion: 2,
    gate: "B4_TEN_PHYSICAL_DEVICES",
    collectionRunId: COLLECTION_RUN_ID,
    certificationMatrixSha256:
      ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
    collectorReport: "collector-final.json",
    captures: Array.from(
      { length: B4_4_REQUIRED_DISTINCT_DEVICES },
      (_, index) => ({
        slot: index + 1,
        captureRunId:
          `00000000-0000-4000-8000-${String(index + 101).padStart(12, "0")}`,
        report: `capture-${String(index + 1).padStart(2, "0")}.json`,
        log: `capture-${String(index + 1).padStart(2, "0")}.log`,
        androidMonitor:
          `capture-${String(index + 1).padStart(2, "0")}.android-monitor.json`,
        androidMonitorSha256: hash(`android-monitor-${index + 1}`),
        raspberryMonitor:
          `capture-${String(index + 1).padStart(2, "0")}.raspberry-monitor.json`,
        raspberryMonitorSha256: hash(`raspberry-monitor-${index + 1}`)
      })
    ),
    ...overrides
  };
  return JSON.stringify(value);
}

test("B4.4 manifest accepts exactly ten ordered monitored evidence slots", () => {
  const parsed = parseEvidenceManifest(manifest());
  assert.equal(parsed.captures.length, 10);
  assert.equal(parsed.captures[0].slot, 1);
  assert.equal(parsed.captures[9].slot, 10);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.collectionRunId, COLLECTION_RUN_ID);
});

test("B4.4 manifest rejects extra fields, reused paths and path traversal", () => {
  assert.throws(
    () => parseEvidenceManifest(manifest({ unexpected: true })),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "MANIFEST_INVALID"
  );

  const duplicate = JSON.parse(manifest());
  duplicate.captures[1].log = duplicate.captures[0].log;
  assert.throws(
    () => parseEvidenceManifest(JSON.stringify(duplicate)),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "MANIFEST_INVALID"
  );

  const traversal = JSON.parse(manifest());
  traversal.captures[0].report = "../capture.json";
  assert.throws(
    () => parseEvidenceManifest(JSON.stringify(traversal)),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "MANIFEST_INVALID"
  );
});

test("B4.4 private reader rejects loose, linked and symlinked evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-reader-"));
  fs.chmodSync(directory, 0o700);
  const evidence = path.join(directory, "evidence.json");
  const hardlink = path.join(directory, "evidence-hardlink.json");
  const symlink = path.join(directory, "evidence-symlink.json");
  try {
    fs.writeFileSync(evidence, "{}\n", { mode: 0o600 });
    assert.equal(
      readPrivateRegularFile(evidence, 1024, "test evidence").toString("utf8"),
      "{}\n"
    );
    fs.chmodSync(evidence, 0o644);
    assert.throws(
      () => readPrivateRegularFile(evidence, 1024, "test evidence"),
      (error) =>
        error instanceof B4TenDeviceGateError &&
        error.code === "EVIDENCE_FILE_NOT_PRIVATE"
    );
    fs.chmodSync(evidence, 0o600);
    fs.linkSync(evidence, hardlink);
    assert.throws(
      () => readPrivateRegularFile(evidence, 1024, "test evidence"),
      (error) =>
        error instanceof B4TenDeviceGateError &&
        error.code === "EVIDENCE_FILE_INVALID"
    );
    fs.unlinkSync(hardlink);
    fs.symlinkSync(evidence, symlink);
    assert.throws(
      () => readPrivateRegularFile(symlink, 1024, "test evidence"),
      (error) =>
        error instanceof B4TenDeviceGateError &&
        error.code === "EVIDENCE_FILE_INVALID"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function monitorFixture(overrides = {}) {
  const matrixSha256 =
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256;
  const monitoredFrom = "2026-08-05T23:59:59.000Z";
  const monitoredUntil = "2026-08-06T00:01:31.000Z";
  const android = buildB4AndroidContinuityAttestation({
    collectionRunId: COLLECTION_RUN_ID,
    captureRunId: CAPTURE_RUN_ID,
    certificationMatrixSha256: matrixSha256,
    privateJournalSha256: hash("android-private-journal"),
    targetHardwareCommitmentSha256: hash("physical-handheld-target"),
    androidApi: 35,
    monitoredFrom,
    monitoredUntil,
    durationMs: 92_000,
    pollMs: 2_000,
    sampleCount: 47,
    maximumObservedGapMs: 2_100,
    generatedAt: monitoredUntil,
    ...overrides.android
  });
  const raspberry = buildB4RaspberryContinuityAttestation({
    collectionRunId: COLLECTION_RUN_ID,
    captureRunId: CAPTURE_RUN_ID,
    certificationMatrixSha256: matrixSha256,
    privateJournalSha256: hash("raspberry-private-journal"),
    monitoredFrom,
    runnerObservedAt: "2026-08-06T00:00:00.500Z",
    cleanupObservedAt: "2026-08-06T00:01:30.000Z",
    monitoredUntil,
    durationMs: 92_000,
    pollMs: 2_000,
    sampleCount: 47,
    maximumObservedGapMs: 2_100,
    generatedAt: monitoredUntil,
    ...overrides.raspberry
  });
  const report = {
    schemaVersion: 1,
    product: "V5BT",
    phase: "B4.3",
    mode: "PHYSICAL_SINGLE_ADVERTISER",
    verdict: "PASS",
    generatedAt: "2026-08-06T00:01:30.000Z",
    measurement: {
      requiredDurationSeconds: 90,
      wallClockDurationMs: 90_000
    }
  };
  return {
    reportBytes: Buffer.from(`${JSON.stringify(report)}\n`, "utf8"),
    androidBytes: Buffer.from(`${JSON.stringify(android)}\n`, "utf8"),
    raspberryBytes: Buffer.from(`${JSON.stringify(raspberry)}\n`, "utf8")
  };
}

function validateMonitorFixture(fixture) {
  return validateCaptureMonitorEvidence(
    {
      slot: 1,
      collectionRunId: COLLECTION_RUN_ID,
      captureRunId: CAPTURE_RUN_ID,
      certificationMatrixSha256:
        ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
      collectorDevice: {
        ordinal: 1,
        packageName: ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId,
        androidApi: 35
      },
      raspberryReportBytes: fixture.reportBytes,
      androidMonitorBytes: fixture.androidBytes,
      raspberryMonitorBytes: fixture.raspberryBytes,
      expectedAndroidMonitorSha256: hash(fixture.androidBytes),
      expectedRaspberryMonitorSha256: hash(fixture.raspberryBytes)
    },
    {
      parseAndroidAttestation: parseB4AndroidContinuityAttestation,
      parseRaspberryAttestation: parseB4RaspberryContinuityAttestation
    }
  );
}

test("B4.4 canonical monitor gate revalidates binding, target and coverage", () => {
  const evidence = validateMonitorFixture(monitorFixture());
  assert.equal(evidence.bindingAndCoverage, "PASS");
  assert.equal(
    evidence.targetPackageName,
    ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId
  );

  const tampered = monitorFixture();
  const changed = JSON.parse(tampered.androidBytes.toString("utf8"));
  changed.binding.captureRunCommitmentSha256 = "f".repeat(64);
  tampered.androidBytes = Buffer.from(`${JSON.stringify(changed)}\n`, "utf8");
  assert.throws(
    () => validateMonitorFixture(tampered),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "MONITOR_EVIDENCE_INVALID"
  );

  const shortAndroid = monitorFixture({
    android: {
      monitoredUntil: "2026-08-06T00:01:29.000Z",
      durationMs: 90_000,
      sampleCount: 46,
      generatedAt: "2026-08-06T00:01:29.000Z"
    }
  });
  assert.throws(
    () => validateMonitorFixture(shortAndroid),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "MONITOR_EVIDENCE_INVALID"
  );
});

test("B4.4 aggregate promotes only B4 after ten distinct sequential captures", () => {
  const report = aggregate(captures(), {
    generatedAt: "2026-07-20T12:00:00.000Z"
  });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.gate.b4, "PASS");
  assert.equal(report.gate.b5, "PENDING");
  assert.equal(report.gate.distinctPhysicalDevices, 10);
  assert.equal(report.gate.hardwareDistinctness, "PASS");
  assert.equal(report.gate.registryIdentityDistinctness, "PASS");
  assert.equal(report.collector.evidenceHashBinding, "PASS");
  assert.equal(report.captures.length, 10);
  assert.equal(report.totals.observationsAccepted, 1055);
  assert.deepEqual(report.totals.nodeKinds, ["handheld", "station"]);
  assert.equal(
    JSON.stringify(report).includes("private-identity-"),
    false
  );
});

test("B4.4 aggregate rejects duplicate devices and evidence reuse", () => {
  const duplicateDevice = captures();
  duplicateDevice[9].identityKey = duplicateDevice[0].identityKey;
  assert.throws(
    () => aggregate(duplicateDevice),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "DUPLICATE_PHYSICAL_DEVICE"
  );

  const duplicateEvidence = captures();
  duplicateEvidence[9].sourceLogSha256 =
    duplicateEvidence[0].sourceLogSha256;
  assert.throws(
    () => aggregate(duplicateEvidence),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "DUPLICATE_EVIDENCE"
  );
});

test("B4.4 aggregate rejects overlapping or reordered capture windows", () => {
  const overlapping = captures();
  overlapping[1].startTimeMs = overlapping[0].endTimeMs - 1;
  assert.throws(
    () => aggregate(overlapping),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "CAPTURE_WINDOWS_OVERLAP"
  );
});

function fakeRegistry(devices, aliasFactory) {
  return {
    async deriveRotatingAliasForNode({
      nodeId,
      timestampSeconds,
      epochSeconds
    }) {
      return aliasFactory(nodeId, timestampSeconds, epochSeconds);
    }
  };
}

function deterministicAlias(nodeId, timestampSeconds, epochSeconds) {
  return hash(
    `${nodeId}:${Math.floor(timestampSeconds / epochSeconds)}`
  ).slice(0, 12);
}

test("B4.4 resolves rotating aliases through the private registry only", async () => {
  const devices = Array.from({ length: 10 }, (_, index) => ({
    nodeId: `device-${index + 1}`,
    revokedAt: null
  }));
  const generatedAt = "2026-07-20T12:00:00.000Z";
  const timestampSeconds = Date.parse(generatedAt) / 1_000;
  const registry = fakeRegistry(devices, deterministicAlias);
  const identity = await resolveCaptureIdentity(
    {
      slot: 1,
      generatedAt,
      aliases: [
        deterministicAlias(
          devices[3].nodeId,
          timestampSeconds - 60,
          60
        ),
        deterministicAlias(
          devices[3].nodeId,
          timestampSeconds,
          60
        )
      ]
    },
    registry,
    devices
  );
  assert.equal(identity, devices[3].nodeId);
  assert.deepEqual(B4_4_ALIAS_CLOCK_OFFSETS_SECONDS, [
    -180,
    -120,
    -60,
    0,
    60,
    120
  ]);
});

test("B4.4 rejects unauthorized and ambiguous rotating aliases", async () => {
  const devices = Array.from({ length: 10 }, (_, index) => ({
    nodeId: `device-${index + 1}`,
    revokedAt: null
  }));
  const generatedAt = "2026-07-20T12:00:00.000Z";

  await assert.rejects(
    resolveCaptureIdentity(
      { slot: 1, generatedAt, aliases: ["ffffffffffff"] },
      fakeRegistry(devices, deterministicAlias),
      devices
    ),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "CAPTURE_IDENTITY_UNAUTHORIZED"
  );

  await assert.rejects(
    resolveCaptureIdentity(
      { slot: 1, generatedAt, aliases: ["aaaaaaaaaaaa"] },
      fakeRegistry(devices, () => "aaaaaaaaaaaa"),
      devices
    ),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "CAPTURE_IDENTITY_AMBIGUOUS"
  );
});

test("B4.4 rejects a single capture containing two registry identities", async () => {
  const devices = Array.from({ length: 10 }, (_, index) => ({
    nodeId: `device-${index + 1}`,
    revokedAt: null
  }));
  const generatedAt = "2026-07-20T12:00:00.000Z";
  const timestampSeconds = Date.parse(generatedAt) / 1_000;
  await assert.rejects(
    resolveCaptureIdentity(
      {
        slot: 1,
        generatedAt,
        aliases: [
          deterministicAlias(devices[0].nodeId, timestampSeconds, 60),
          deterministicAlias(devices[1].nodeId, timestampSeconds, 60)
        ]
      },
      fakeRegistry(devices, deterministicAlias),
      devices
    ),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "CAPTURE_MULTIPLE_IDENTITIES"
  );
});

test("B4.4 report firewall rejects private keys and sensitive values", () => {
  const report = aggregate(captures());
  assert.equal(
    assertReportRedacted(report, ["private-secret-not-present"]),
    true
  );
  assert.throws(
    () =>
      assertReportRedacted(
        {
          ...report,
          nodeId: "private-secret"
        },
        ["private-secret"]
      ),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "REPORT_CONTAINS_PRIVATE_DATA"
  );
});

function collectorReport(values) {
  return {
    schemaVersion: 1,
    harnessVersion: "1.0.0",
    product: "V5BT",
    phase: "B4",
    generatedAt: "2026-07-20T12:00:00.000Z",
    mode: "PHYSICAL_TEN_DEVICE_SEQUENCE",
    operation: "MANIFEST_READY",
    verdict: "PENDING",
    gate: {
      requiredDistinctPhysicalDevices: 10,
      distinctPhysicalDevices: 10,
      remainingPhysicalDevices: 0,
      collectionStatus: "READY",
      authoritativeB4GateExecuted: false,
      b4TenDeviceGate: "PENDING"
    },
    devices: values.map((value, index) => ({
      ordinal: index + 1,
      evidenceRecordId:
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      nodeKind: value.nodeKinds[0],
      packageName:
        value.nodeKinds[0] === "station"
          ? "com.sentrapa.postazione.advanced"
          : "com.sentrapa.palmare.advanced",
      model: "Physical Android",
      androidApi: 35,
      recordedAt: "2026-07-20T12:00:00.000Z",
      androidSampledAt: "2026-07-20T12:00:00.000Z",
      raspberryGeneratedAt: "2026-07-20T12:00:00.000Z",
      raspberryReportSha256: value.sourceReportSha256,
      raspberryLogSha256: value.sourceLogSha256,
      observationsAccepted: value.observationsAccepted,
      lifecycleDurationMs: value.lifecycleDurationMs,
      wallClockDurationMs: value.wallClockDurationMs,
      rssiDbm: { ...value.rssiDbm }
    })),
    privacy: {
      hardwareSerialsIncluded: false,
      adbTransportSerialsIncluded: false,
      bluetoothAddressesIncluded: false,
      rotatingAliasesIncluded: false,
      stableNodeIdsIncluded: false,
      deviceDigestsIncluded: false,
      identityHmacKeyIncluded: false
    },
    activeV4Changes: false
  };
}

function monitoredSlots(values) {
  return values.map((value, index) => ({
    slot: index + 1,
    sourceReportSha256: value.sourceReportSha256,
    androidMonitorSha256: hash(`android-monitor-${index + 1}`),
    raspberryMonitorSha256: hash(`raspberry-monitor-${index + 1}`),
    targetPackageName:
      value.nodeKinds[0] === "station"
        ? "com.sentrapa.postazione.advanced"
        : "com.sentrapa.palmare.advanced",
    targetAndroidApi: 35,
    bindingAndCoverage: "PASS"
  }));
}

test("B4.4 binds the hardware collector to the same ten capture hashes", () => {
  const values = captures();
  assert.throws(
    () =>
      validateCollectorReport(collectorReport(values), values, {
        sourceCollectorReportSha256: hash("collector-final")
      }),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "COLLECTOR_REPORT_INVALID"
  );
  const evidence = validateCollectorReport(
    collectorReport(values),
    values,
    {
      sourceCollectorReportSha256: hash("collector-final"),
      monitoredSlots: monitoredSlots(values)
    }
  );
  assert.equal(evidence.hardwareIdentityProof, "PASS");
  assert.equal(evidence.evidenceHashBinding, "PASS");
  assert.equal(evidence.monitorContinuityBinding, "PASS");
  assert.equal(evidence.distinctPhysicalDevices, 10);

  const mismatched = collectorReport(values);
  mismatched.devices[9].raspberryLogSha256 = hash("different-log");
  assert.throws(
    () =>
      validateCollectorReport(mismatched, values, {
        sourceCollectorReportSha256: hash("collector-final"),
        monitoredSlots: monitoredSlots(values)
      }),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "COLLECTOR_EVIDENCE_MISMATCH"
  );

  const kindMismatchValues = captures();
  const kindMismatchReport = collectorReport(kindMismatchValues);
  const kindMismatchMonitors = monitoredSlots(kindMismatchValues);
  kindMismatchValues[0].nodeKinds = ["station"];
  assert.throws(
    () =>
      validateCollectorReport(kindMismatchReport, kindMismatchValues, {
        sourceCollectorReportSha256: hash("collector-final"),
        monitoredSlots: kindMismatchMonitors
      }),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "COLLECTOR_EVIDENCE_MISMATCH"
  );
});

test("B4.4 cannot promote without the hardware collector layer", () => {
  assert.throws(
    () => aggregateValidatedCaptures(captures()),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "COLLECTOR_EVIDENCE_REQUIRED"
  );

  const withoutMonitorBinding = collectorEvidence();
  delete withoutMonitorBinding.monitorContinuityBinding;
  assert.throws(
    () =>
      aggregateValidatedCaptures(captures(), {
        collectorEvidence: withoutMonitorBinding
      }),
    (error) =>
      error instanceof B4TenDeviceGateError &&
      error.code === "COLLECTOR_EVIDENCE_REQUIRED"
  );
});

test("B4.4 self-test is offline and never claims a physical gate result", () => {
  const result = runSelfTest();
  assert.equal(result.verdict, "PASS");
  assert.equal(result.syntheticCaptures, 10);
  assert.equal(result.physicalEvidenceConsumed, false);
  assert.equal(result.privateRegistryAccessed, false);
  assert.equal(result.physicalRadioAccessed, false);
  assert.equal(result.b4GatePromoted, false);
  assert.equal(result.b5Started, false);
});

test("B4.4 CLI self-test succeeds without private files or radio", () => {
  const script = new URL(
    "../scripts/run-b4-ten-device-gate.mjs",
    import.meta.url
  );
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(script), "--self-test"],
    { encoding: "utf8" }
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.mode, "SELF_TEST");
  assert.equal(result.verdict, "PASS");
});

test("B4.4 module import does not execute the CLI entrypoint", () => {
  const moduleUrl = new URL(
    "../scripts/run-b4-ten-device-gate.mjs",
    import.meta.url
  ).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: `await import(${JSON.stringify(moduleUrl)});\n`,
    encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
});
