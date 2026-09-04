import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  API31_COMPAT_BATTERY_INTERVAL_MS,
  API31_COMPAT_CONTROLS,
  API31_COMPAT_CONTINUITY_MAX_GAP_MS,
  API31_COMPAT_CONTINUITY_POLL_INTERVAL_MS,
  API31_COMPAT_PACKAGE_ID,
  API31_COMPAT_PHYSICAL_CONTROLS,
  API31_COMPAT_VERSION_CODE,
  API31_COMPAT_VERSION_NAME,
  Api31CompatNonGateError,
  buildApi31CompatNonGateReport,
  buildApi31CompatPhysicalReport,
  buildSelfTestCapture,
  normalizeApi31CompatNonGateReport,
  parseApi31CompatCapture,
  parseApi31CompatPhysicalCapture,
  runApi31CompatNonGate,
  runSelfTest
} from "./run-api31-compat-non-gate.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./run-api31-compat-non-gate.mjs", import.meta.url)
);

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-api31-non-gate-"));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function continuity(sampleCount, durationMs, faultFields) {
  return {
    sampleCount,
    durationMs,
    expectedPollingIntervalMs: API31_COMPAT_CONTINUITY_POLL_INTERVAL_MS,
    maxAllowedGapMs: API31_COMPAT_CONTINUITY_MAX_GAP_MS,
    maxObservedGapMs: sampleCount >= 2 ? 2_100 : 0,
    ...Object.fromEntries(faultFields.map((field) => [field, 0]))
  };
}

function physicalCapture() {
  return {
    schemaVersion: 2,
    source: "V5BT_API31_COMPAT_PRIVATE_CAPTURE",
    product: "V5BT",
    captureClass: "PHYSICAL_DIAGNOSTIC",
    profile: {
      applicationId: API31_COMPAT_PACKAGE_ID,
      versionName: API31_COMPAT_VERSION_NAME,
      versionCode: API31_COMPAT_VERSION_CODE,
      androidApi: 31,
      partialNonGateBuild: true,
      api31CompatNonGateBuild: true,
      discoveryProfile: "API31_COMPAT_NON_GATE",
      discoveryMinimumAndroidApi: 31,
      formalGateEligible: false
    },
    enrollment: {
      protocolVersion: 2,
      state: "READY",
      publicKeyAlgorithm: "EC-P256",
      proofAlgorithm: "ECDSA-P256-SHA256-P1363",
      transport: "HTTPS_PINNED_V2",
      evidence: "PHYSICAL_STAGING_V2_ACCEPTED",
      stagingRegistryAccepted: true
    },
    evidence: {
      bluetooth: {
        rawCallbacks: 12,
        uuidMatches: 10,
        validObservations: 10,
        invalidPayloads: 0,
        scanFailures: 0,
        advertisementStarts: 1,
        advertisementFailures: 0,
        capabilities: {
          scan: true,
          advertise: true,
          gattClient: true,
          gattServer: true
        },
        runtime: {
          scannerActiveObserved: true,
          advertiserActiveObserved: true,
          gattClientEnabled: true,
          gattClientAttempts: 1,
          gattClientConnections: 1,
          gattClientErrors: 0,
          gattServerEnabled: true,
          gattServerActiveObserved: true,
          gattServerConnections: 0,
          gattServerErrors: 0
        }
      },
      concurrency: {
        scanAdvertiseWindows: 4,
        validObservationsDuringWindows: 8
      },
      wifiBleCoexistence: {
        healthProbeCount: 3,
        successfulHealthProbeCount: 3,
        bluetoothActiveProbeCount: 3
      },
      foregroundBackground: {
        backgroundDurationMs: 20_000,
        reporterSamplesBefore: 5,
        reporterSamplesAfter: 15,
        scannerActiveThroughout: true,
        advertiserActiveThroughout: true,
        foregroundRestored: true
      },
      continuity: {
        android: continuity(100, 198_000, [
          "processRestarts",
          "crashes",
          "anrs",
          "logouts",
          "reporterRestarts",
          "identityChanges",
          "versionChanges"
        ]),
        raspberry: continuity(100, 198_000, [
          "bootChanges",
          "clockRegressions",
          "mainServiceRestarts",
          "bluetoothServiceRestarts",
          "mainServiceFailures",
          "bluetoothServiceFailures"
        ]),
        staging: continuity(100, 198_000, [
          "serviceRestarts",
          "healthFailures",
          "protocolV2UnavailableSamples",
          "registryIntegrityFailures"
        ])
      },
      battery: {
        configuredIntervalMs: API31_COMPAT_BATTERY_INTERVAL_MS,
        observationDurationMs: 240_000,
        observedNotificationCount: 3,
        minimumObservedIntervalMs: 120_000,
        maximumObservedIntervalMs: 120_000
      }
    }
  };
}

test("all controls can pass only as immutable non-gate evidence", () => {
  const report = buildApi31CompatNonGateReport(buildSelfTestCapture());
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(report.evidenceClass, "NON_GATE_EVIDENCE");
  assert.equal(report.gateImpact, "NONE");
  assert.equal(report.profile.formalGateEligible, false);
  assert.equal(report.profile.endpointEvidence, "TEST_CONFIGURATION_ONLY");
  assert.equal(report.authorization.acceptedAsFormalEvidence, false);
  assert.equal(report.authorization.officialCampaignAuthorized, false);
  assert.equal(report.effects.authoritativeGateExecuted, false);
  assert.equal(report.effects.gatePromoted, false);
  assert.equal(report.effects.roadmapStatusChanged, false);
  assert.equal(Object.values(report.gates).includes("PASS"), false);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.gates), true);
  assert.throws(() => {
    report.gates.b0DeviceCapabilityGate = "PASS";
  }, TypeError);
});

test("one failed or unexecuted control yields NON_GATE_FAIL", () => {
  for (const status of ["FAIL", "NOT_RUN"]) {
    for (const control of API31_COMPAT_CONTROLS) {
      const capture = buildSelfTestCapture();
      capture.controls[control] = status;
      assert.equal(
        buildApi31CompatNonGateReport(capture).verdict,
        "NON_GATE_FAIL",
        `${control}:${status}`
      );
    }
  }
});

test("compat capture cannot relabel package marker endpoint or discovery floor", () => {
  const mutations = [
    (capture) => { capture.profile.applicationId = "com.sentrapa.postazione.advanced"; },
    (capture) => { capture.profile.partialNonGateBuild = false; },
    (capture) => { capture.profile.api31CompatNonGateBuild = false; },
    (capture) => { capture.profile.discoveryProfile = "CERTIFIED"; },
    (capture) => { capture.profile.discoveryMinimumAndroidApi = 33; },
    (capture) => { capture.profile.formalGateEligible = true; },
    (capture) => { capture.profile.enrollmentEndpointPath = "/v1/enroll"; },
    (capture) => { capture.profile.enrollmentSpkiPinned = false; },
    (capture) => { capture.profile.endpointEvidence = "PHYSICAL_TLS_VERIFIED"; }
  ];
  for (const mutate of mutations) {
    const capture = buildSelfTestCapture();
    mutate(capture);
    assert.throws(
      () => parseApi31CompatCapture(JSON.stringify(capture)),
      (error) =>
        error instanceof Api31CompatNonGateError &&
        error.code === "CONTRACT_INVALID"
    );
  }
});

test("report validator rejects every promotion attempt", () => {
  const mutations = [
    (report) => { report.evidenceClass = "FORMAL_GATE_EVIDENCE"; },
    (report) => { report.gateImpact = "PROMOTE"; },
    (report) => { report.profile.formalGateEligible = true; },
    (report) => { report.gates.b0DeviceCapabilityGate = "PASS"; },
    (report) => { report.authorization.acceptedAsFormalEvidence = true; },
    (report) => { report.authorization.officialCampaignAuthorized = true; },
    (report) => { report.effects.authoritativeGateExecuted = true; },
    (report) => { report.effects.gatePromoted = true; },
    (report) => { report.effects.roadmapStatusChanged = true; }
  ];
  for (const mutate of mutations) {
    const report = structuredClone(
      buildApi31CompatNonGateReport(buildSelfTestCapture())
    );
    mutate(report);
    assert.throws(
      () => normalizeApi31CompatNonGateReport(report),
      (error) =>
        error instanceof Api31CompatNonGateError &&
        error.code === "CONTRACT_INVALID"
    );
  }
});

test("runner writes a 0600 report once and never overwrites the capture", (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "capture.json");
  const output = path.join(directory, "report.json");
  fs.writeFileSync(input, `${JSON.stringify(buildSelfTestCapture())}\n`, {
    mode: 0o600
  });
  fs.chmodSync(input, 0o600);

  const report = runApi31CompatNonGate(input, output);
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(fs.lstatSync(output).mode & 0o777, 0o600);
  assert.throws(
    () => runApi31CompatNonGate(input, output),
    (error) =>
      error instanceof Api31CompatNonGateError && error.code === "OUTPUT_EXISTS"
  );
  assert.throws(
    () => runApi31CompatNonGate(input, input),
    (error) =>
      error instanceof Api31CompatNonGateError && error.code === "INVALID_ARGUMENT"
  );
});

test("runner rejects permissive input files and links", (t) => {
  if (process.platform === "win32") return;
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "capture.json");
  const output = path.join(directory, "report.json");
  fs.writeFileSync(input, `${JSON.stringify(buildSelfTestCapture())}\n`, {
    mode: 0o640
  });
  fs.chmodSync(input, 0o640);
  assert.throws(
    () => runApi31CompatNonGate(input, output),
    (error) =>
      error instanceof Api31CompatNonGateError && error.code === "FILE_INVALID"
  );
  fs.chmodSync(input, 0o600);
  const linked = path.join(directory, "capture-link.json");
  fs.linkSync(input, linked);
  assert.throws(
    () => runApi31CompatNonGate(input, output),
    (error) =>
      error instanceof Api31CompatNonGateError && error.code === "FILE_INVALID"
  );
});

test("CLI self-test is redacted and cannot claim a promoted gate", () => {
  assert.equal(runSelfTest(), true);
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--self-test"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.selfTest, "PASS");
  assert.equal(report.evidenceClass, "NON_GATE_EVIDENCE");
  assert.equal(report.gateImpact, "NONE");
  assert.equal(report.gatePromoted, false);
  assert.equal(JSON.stringify(report).includes("serial"), false);
});

test("CLI evaluate publishes the same non-gate contract", (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "capture.json");
  const output = path.join(directory, "report.json");
  fs.writeFileSync(input, `${JSON.stringify(buildSelfTestCapture())}\n`, {
    mode: 0o600
  });
  fs.chmodSync(input, 0o600);

  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--evaluate", "--input", input, "--output", output],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  const stdoutReport = normalizeApi31CompatNonGateReport(
    JSON.parse(result.stdout)
  );
  const fileReport = normalizeApi31CompatNonGateReport(
    JSON.parse(fs.readFileSync(output, "utf8"))
  );
  assert.deepEqual(stdoutReport, fileReport);
  assert.equal(fileReport.verdict, "NON_GATE_PASS");
  assert.equal(fileReport.effects.gatePromoted, false);
});

test("physical diagnostic derives a complete aggregate-only NON_GATE report", () => {
  const report = buildApi31CompatPhysicalReport(physicalCapture());
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.mode, "PHYSICAL_DIAGNOSTIC");
  assert.equal(report.phase, "API31_COMPAT_PHYSICAL_DIAGNOSTIC");
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(report.gateImpact, "NONE");
  assert.equal(report.officialProgressPercent, 49);
  assert.equal(report.profile.androidApi, 31);
  assert.equal(report.enrollment.protocolVersion, 2);
  assert.equal(report.enrollment.state, "READY");
  assert.equal(report.evidence.bluetooth.rawCallbacks, 12);
  assert.equal(report.evidence.bluetooth.uuidMatches, 10);
  assert.equal(report.evidence.bluetooth.validObservations, 10);
  assert.equal(report.assessments.androidContinuityResult, "PASS");
  assert.equal(report.assessments.raspberryContinuityResult, "PASS");
  assert.equal(report.assessments.stagingContinuityResult, "PASS");
  assert.equal(report.assessments.batteryObservationClaim, "INTERVAL_OBSERVED");
  assert.equal(
    API31_COMPAT_PHYSICAL_CONTROLS.every(
      (control) => report.controls[control] === "PASS"
    ),
    true
  );
  assert.equal(Object.values(report.gates).includes("PASS"), false);
  assert.equal(report.gates.b6AndroidPairGate, "BLOCKED");
  assert.equal(report.privacy.aggregateOnly, true);
  assert.equal(report.privacy.privateIdentifiersIncluded, false);
  assert.equal(Object.isFrozen(report.evidence.continuity), true);
});

test("physical controls distinguish capability from runtime observation", () => {
  const capture = physicalCapture();
  capture.evidence.bluetooth.runtime.gattClientAttempts = 0;
  capture.evidence.bluetooth.runtime.gattClientConnections = 0;
  capture.evidence.bluetooth.runtime.gattServerEnabled = false;
  capture.evidence.bluetooth.runtime.gattServerActiveObserved = false;
  capture.evidence.battery.observationDurationMs = 160_000;
  capture.evidence.battery.observedNotificationCount = 1;
  capture.evidence.battery.minimumObservedIntervalMs = null;
  capture.evidence.battery.maximumObservedIntervalMs = null;

  const report = buildApi31CompatPhysicalReport(capture);
  assert.equal(report.controls.gattClientCapability, "PASS");
  assert.equal(report.controls.gattClientRuntime, "NOT_RUN");
  assert.equal(report.controls.gattServerCapability, "PASS");
  assert.equal(report.controls.gattServerRuntime, "NOT_RUN");
  assert.equal(report.controls.batteryCadence, "NOT_RUN");
  assert.equal(report.assessments.batteryObservationClaim, "INTERVAL_NOT_ATTESTED");
  assert.equal(report.verdict, "NON_GATE_FAIL");
});

test("one connected GATT attempt may fail later without becoming a runtime PASS", () => {
  const capture = physicalCapture();
  capture.evidence.bluetooth.runtime.gattClientAttempts = 1;
  capture.evidence.bluetooth.runtime.gattClientConnections = 1;
  capture.evidence.bluetooth.runtime.gattClientErrors = 1;

  const normalized = parseApi31CompatPhysicalCapture(JSON.stringify(capture));
  assert.equal(normalized.evidence.bluetooth.runtime.gattClientAttempts, 1);
  assert.equal(normalized.evidence.bluetooth.runtime.gattClientConnections, 1);
  assert.equal(normalized.evidence.bluetooth.runtime.gattClientErrors, 1);
  const report = buildApi31CompatPhysicalReport(normalized);
  assert.equal(report.controls.gattClientCapability, "PASS");
  assert.equal(report.controls.gattClientRuntime, "FAIL");
  assert.equal(report.verdict, "NON_GATE_FAIL");
});

test("physical capture accepts only exact aggregate evidence", () => {
  const forbiddenFields = [
    ["serial", "private-device"],
    ["macAddress", "00:11:22:33:44:55"],
    ["nodeId", "private-node"],
    ["path", "/private/evidence"],
    ["host", "private-host"]
  ];
  for (const [field, value] of forbiddenFields) {
    const capture = physicalCapture();
    capture.evidence.bluetooth[field] = value;
    assert.throws(
      () => parseApi31CompatPhysicalCapture(JSON.stringify(capture)),
      (error) =>
        error instanceof Api31CompatNonGateError &&
        error.code === "CONTRACT_INVALID"
    );
  }

  const inconsistent = physicalCapture();
  inconsistent.evidence.bluetooth.uuidMatches = 13;
  assert.throws(
    () => parseApi31CompatPhysicalCapture(JSON.stringify(inconsistent)),
    (error) =>
      error instanceof Api31CompatNonGateError && error.code === "CONTRACT_INVALID"
  );
});

test("physical contract rejects identity, enrollment and version substitutions", () => {
  const mutations = [
    (capture) => { capture.profile.applicationId = "com.example.replacement"; },
    (capture) => { capture.profile.versionName = "2.0.24"; },
    (capture) => { capture.profile.versionCode = 26; },
    (capture) => { capture.profile.androidApi = 32; },
    (capture) => { capture.profile.formalGateEligible = true; },
    (capture) => { capture.enrollment.protocolVersion = 1; },
    (capture) => { capture.enrollment.state = "PENDING"; },
    (capture) => { capture.enrollment.stagingRegistryAccepted = false; }
  ];
  for (const mutate of mutations) {
    const capture = physicalCapture();
    mutate(capture);
    assert.throws(
      () => parseApi31CompatPhysicalCapture(JSON.stringify(capture)),
      (error) =>
        error instanceof Api31CompatNonGateError &&
        error.code === "CONTRACT_INVALID"
    );
  }
});

test("physical report validator rejects promotion and derived-result tampering", () => {
  const mutations = [
    (report) => { report.evidenceClass = "FORMAL_GATE_EVIDENCE"; },
    (report) => { report.gateImpact = "PROMOTE"; },
    (report) => { report.officialProgressPercent = 50; },
    (report) => { report.gates.b0DeviceCapabilityGate = "PASS"; },
    (report) => { report.gates.b5HundredSessionGate = "PASS"; },
    (report) => { report.authorization.acceptedAsFormalEvidence = true; },
    (report) => { report.authorization.officialCampaignAuthorized = true; },
    (report) => { report.effects.gatePromoted = true; },
    (report) => { report.controls.scanRuntime = "PASS"; report.evidence.bluetooth.validObservations = 0; },
    (report) => { report.assessments.raspberryContinuityResult = "FAIL"; },
    (report) => { report.privacy.privateIdentifiersIncluded = true; }
  ];
  for (const mutate of mutations) {
    const report = structuredClone(
      buildApi31CompatPhysicalReport(physicalCapture())
    );
    mutate(report);
    assert.throws(
      () => normalizeApi31CompatNonGateReport(report),
      (error) => error instanceof Api31CompatNonGateError
    );
  }
});

test("continuity faults and battery cadence violations remain visible", () => {
  const capture = physicalCapture();
  capture.evidence.continuity.android.crashes = 1;
  capture.evidence.continuity.android.anrs = 1;
  capture.evidence.continuity.android.logouts = 1;
  capture.evidence.continuity.raspberry.mainServiceRestarts = 1;
  capture.evidence.continuity.staging.healthFailures = 1;
  capture.evidence.battery.minimumObservedIntervalMs = 119_999;
  const report = buildApi31CompatPhysicalReport(capture);
  assert.equal(report.controls.androidContinuity, "FAIL");
  assert.equal(report.controls.raspberryContinuity, "FAIL");
  assert.equal(report.controls.stagingContinuity, "FAIL");
  assert.equal(report.controls.batteryCadence, "FAIL");
  assert.equal(report.assessments.batteryObservationClaim, "INTERVAL_VIOLATION");
  assert.equal(report.verdict, "NON_GATE_FAIL");
});

test("physical runner keeps private files 0600, publishes once and redacts output", (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "physical-capture.json");
  const output = path.join(directory, "physical-report.json");
  fs.writeFileSync(input, `${JSON.stringify(physicalCapture())}\n`, { mode: 0o600 });
  fs.chmodSync(input, 0o600);

  const report = runApi31CompatNonGate(input, output);
  assert.equal(report.mode, "PHYSICAL_DIAGNOSTIC");
  assert.equal(fs.lstatSync(input).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(output).mode & 0o777, 0o600);
  const published = fs.readFileSync(output, "utf8");
  assert.doesNotMatch(published, /private-device|00:11:22:33:44:55|private-node|private-host/iu);
  assert.throws(
    () => runApi31CompatNonGate(input, output),
    (error) =>
      error instanceof Api31CompatNonGateError && error.code === "OUTPUT_EXISTS"
  );
});

test("CLI evaluation distinguishes physical diagnostic from prephysical self-test", (t) => {
  const selfTest = spawnSync(process.execPath, [SCRIPT_PATH, "--self-test"], {
    encoding: "utf8"
  });
  assert.equal(selfTest.status, 0, selfTest.stderr);
  assert.equal(JSON.parse(selfTest.stdout).mode, "PREPHYSICAL_SELF_TEST");

  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "physical-capture.json");
  const output = path.join(directory, "physical-report.json");
  fs.writeFileSync(input, `${JSON.stringify(physicalCapture())}\n`, { mode: 0o600 });
  fs.chmodSync(input, 0o600);
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--evaluate", "--input", input, "--output", output],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, "PHYSICAL_DIAGNOSTIC");
});
