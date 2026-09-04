import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from "./advanced-certification-targets.mjs";
import {
  B0_CAPTURE_DURATION_SECONDS,
  B0_REQUIRED_CONTROLS,
  assertNonDestructiveAdbArgs,
  parseCapabilityReport
} from "./run-b0-android-supplemental-gate.mjs";
import {
  B0FormalError,
  B0_FORMAL_MODELS,
  B0_FORMAL_ROLES,
  B0_MIN_ANDROID_API,
  buildFormalDryRun,
  buildFormalFailure,
  buildPublicFormalReport,
  evaluateFormalRoleEvidence,
  parseFormalArguments,
  publishFormalEvidencePair
} from "./run-b0-android-formal-gate.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./run-b0-android-formal-gate.mjs", import.meta.url)
);
const NOW_MS = Date.parse("2026-08-05T12:00:00.000Z");
const SESSION_HMAC = "c".repeat(64);

function throwsCode(action, code) {
  assert.throws(
    action,
    (error) => error instanceof B0FormalError && error.code === code,
    `expected ${code}`
  );
}

function capability(overrides = {}) {
  return parseCapabilityReport(
    JSON.stringify({
      manufacturer: "Test Vendor",
      model: "Test Model",
      androidApi: 36,
      bluetoothLeFeature: true,
      adapterPresent: true,
      adapterEnabled: true,
      scanPermission: true,
      advertisePermission: true,
      connectPermission: true,
      scannerAvailable: true,
      advertiserAvailable: true,
      gattClientAvailable: true,
      multipleAdvertisementSupported: true,
      offloadedFilteringSupported: true,
      offloadedScanBatchingSupported: true,
      gattServerOpen: true,
      probeStatus: "COMPLETE",
      scan: true,
      advertise: true,
      gattClient: true,
      gattServer: true,
      classification: "FULL_NODE",
      b0GateComplete: false,
      pendingFieldTests: [
        "SCAN_ADVERTISE_CONCURRENT",
        "WIFI_BLE_COEXISTENCE",
        "BACKGROUND_FOREGROUND"
      ],
      ...overrides
    })
  );
}

function binding(role) {
  const target = ADVANCED_CERTIFICATION_TARGETS.roles[role];
  const index = B0_FORMAL_ROLES.indexOf(role);
  return {
    ordinal: role,
    serial: `PRIVATE_${role.toUpperCase()}_SERIAL`,
    packageId: target.packageId,
    certifiedTarget: structuredClone(target),
    model: B0_FORMAL_MODELS[role],
    expectedModel: B0_FORMAL_MODELS[role],
    androidApi: 36,
    currentUser: 0,
    appUid: 10_123 + index,
    pid: 4_321 + index,
    discoveryReporterStartedAtEpochMs: NOW_MS - 60_000,
    agentReporterStartedAtEpochMs: NOW_MS - 55_000,
    gattReporterStartedAtEpochMs: NOW_MS - 50_000,
    apkSha256: target.sha256,
    sessionBindingHmacSha256: SESSION_HMAC,
    launcherComponent: `${target.packageId}/.MainActivity`,
    wasForeground: true,
    wasRunning: true
  };
}

function sample(role, index, appForeground) {
  const target = ADVANCED_CERTIFICATION_TARGETS.roles[role];
  const roleIndex = B0_FORMAL_ROLES.indexOf(role);
  const timestamp = NOW_MS + index * 5_000;
  return {
    hostEpochMs: timestamp,
    hostMonotonicMs: index * 5_000,
    deviceEpochMs: timestamp,
    currentUser: 0,
    installedVersion: {
      versionName: target.versionName,
      versionCode: target.versionCode
    },
    appUid: 10_123 + roleIndex,
    packageStopped: false,
    pid: 4_321 + roleIndex,
    discovery: {
      sampleSequence: 100 + index,
      sampledAtEpochMs: timestamp,
      reporterStartedAtEpochMs: NOW_MS - 60_000,
      activePeerCount: 1,
      metrics: {
        scanWindowsStarted: 10 + index,
        concurrentScanAdvertiseWindowsStarted: 20 + index,
        scanFailures: 0,
        advertisementsStarted: 1,
        advertisementFailures: 0,
        acceptedObservations: index,
        scanIngressDropped: 0
      }
    },
    agent: {
      sampleSequence: 200 + index,
      sampledAtEpochMs: timestamp,
      reporterStartedAtEpochMs: NOW_MS - 55_000,
      metrics: { stopCount: 0, invalidTransitionCount: 0 },
      resources: {
        scannerActive: true,
        advertiserActive: true,
        gattServerActive: true,
        gattClientActive: true,
        sessionCount: 1
      }
    },
    gatt: {
      sampleSequence: 300 + index,
      sampledAtEpochMs: timestamp,
      reporterStartedAtEpochMs: NOW_MS - 50_000,
      gattClientEnabled: true,
      active: true,
      metrics: {
        connectionAttempts: index,
        connectionsEstablished: index
      }
    },
    sessionBindingHmacSha256: SESSION_HMAC,
    foregroundService: { foreground: true, typeMask: 0x11 },
    appForeground,
    wifi: { enabled: true, connected: true }
  };
}

function roleFixture(role) {
  return {
    role,
    binding: binding(role),
    capability: capability(),
    foregroundSamples: [
      sample(role, 0, true),
      sample(role, 1, true),
      sample(role, 2, true)
    ],
    backgroundSamples: [
      sample(role, 3, false),
      sample(role, 4, false),
      sample(role, 5, false)
    ],
    exitBaseline: { commitments: new Set(), counts: {} },
    exitFinal: { commitments: new Set(), counts: {} }
  };
}

function cloneFixture(value) {
  return {
    role: value.role,
    binding: structuredClone(value.binding),
    capability: structuredClone(value.capability),
    foregroundSamples: structuredClone(value.foregroundSamples),
    backgroundSamples: structuredClone(value.backgroundSamples),
    exitBaseline: {
      commitments: new Set(value.exitBaseline.commitments),
      counts: structuredClone(value.exitBaseline.counts)
    },
    exitFinal: {
      commitments: new Set(value.exitFinal.commitments),
      counts: structuredClone(value.exitFinal.counts)
    }
  };
}

function serializedDevice(role) {
  const fixture = roleFixture(role);
  return {
    role,
    binding: fixture.binding,
    capability: fixture.capability,
    foregroundSamples: fixture.foregroundSamples,
    backgroundSamples: fixture.backgroundSamples,
    exitBaseline: { commitments: [], counts: {} },
    exitFinal: { commitments: [], counts: {} }
  };
}

function privateEvidence() {
  return {
    schemaVersion: 1,
    harnessVersion: "1.0.0",
    source: "V6_B0_ANDROID_FORMAL_PRIVATE",
    captureRunId: "00000000-0000-4000-8000-000000000001",
    startedAt: "2026-08-05T12:00:00.000Z",
    endedAt: "2026-08-05T12:02:00.000Z",
    fixedDurationSeconds: B0_CAPTURE_DURATION_SECONDS,
    certificationMatrixSha256:
      ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
    sessionHmacKeyBase64: Buffer.alloc(32, 7).toString("base64"),
    devices: B0_FORMAL_ROLES.map(serializedDevice),
    runnerPolicy: {
      forceStopAllowed: false,
      uninstallAllowed: false,
      clearDataAllowed: false,
      userChangeAllowed: false,
      finalAppStopAllowed: false
    },
    restoration: { attempted: true, completed: true }
  };
}

test("formal evaluation requires all controls and continuity for each certified role", () => {
  for (const role of B0_FORMAL_ROLES) {
    const result = evaluateFormalRoleEvidence(roleFixture(role));
    assert.equal(result.result, "PASS");
    assert.equal(result.evidenceClass, "FORMAL");
    assert.deepEqual(Object.keys(result.controls), B0_REQUIRED_CONTROLS);
    assert.equal(
      Object.values(result.controls).every((entry) => entry.status === "PASS"),
      true
    );
    assert.equal(
      Object.values(result.continuity).every((entry) => entry.status === "PASS"),
      true
    );
  }
});

test("Android API 31 cannot pass formal B0 even when all seven controls pass", () => {
  const fixture = cloneFixture(roleFixture("station"));
  fixture.binding.androidApi = 31;
  fixture.capability.androidApi = 31;

  const result = evaluateFormalRoleEvidence(fixture);

  assert.equal(B0_MIN_ANDROID_API, 33);
  assert.equal(
    Object.values(result.controls).every((entry) => entry.status === "PASS"),
    true
  );
  assert.equal(result.androidPlatform.status, "FAIL");
  assert.equal(result.androidPlatform.code, "ANDROID_API_UNSUPPORTED");
  assert.equal(result.result, "FAIL");
  assert.equal(result.evidenceClass, "NON_GATE_EVIDENCE");

  const evidence = privateEvidence();
  evidence.devices[1].binding = {
    ...evidence.devices[1].binding,
    androidApi: 31
  };
  evidence.devices[1].capability = {
    ...evidence.devices[1].capability,
    androidApi: 31
  };
  const report = buildPublicFormalReport(evidence, "a".repeat(64));
  assert.equal(report.roles[1].androidPlatform.code, "ANDROID_API_UNSUPPORTED");
  assert.equal(report.formalGate, "PENDING");
  assert.equal(report.formalGatePromoted, false);
});

test("formal B0 binds the reported Android API to the ADB platform value", () => {
  const fixture = cloneFixture(roleFixture("handheld"));
  fixture.capability.androidApi = fixture.binding.androidApi + 1;

  const result = evaluateFormalRoleEvidence(fixture);

  assert.equal(result.androidPlatform.status, "FAIL");
  assert.equal(result.androidPlatform.code, "ANDROID_API_BINDING_MISMATCH");
  assert.equal(result.result, "FAIL");
});

test("GATT server needs both explicit open-close and observed runtime activity", () => {
  const fixture = cloneFixture(roleFixture("station"));
  for (const entry of [...fixture.foregroundSamples, ...fixture.backgroundSamples]) {
    entry.agent.resources.gattServerActive = false;
  }
  const result = evaluateFormalRoleEvidence(fixture);
  assert.equal(result.controls.gattServer.status, "FAIL");
  assert.equal(result.evidenceClass, "NON_GATE_EVIDENCE");
});

test("absent or unproved radio fields fail closed without UNKNOWN output", () => {
  const cases = [
    ["scan", (fixture) => (fixture.capability.scannerAvailable = null)],
    ["advertise", (fixture) => (fixture.capability.advertiserAvailable = null)],
    ["gattClient", (fixture) => (fixture.capability.gattClientAvailable = null)],
    ["scanAdvertiseConcurrent", (fixture) => {
      for (const entry of [...fixture.foregroundSamples, ...fixture.backgroundSamples]) {
        entry.discovery.metrics.concurrentScanAdvertiseWindowsStarted = 1;
      }
    }]
  ];
  for (const [control, mutate] of cases) {
    const fixture = cloneFixture(roleFixture("handheld"));
    mutate(fixture);
    const result = evaluateFormalRoleEvidence(fixture);
    assert.equal(result.controls[control].status, "FAIL", control);
    assert.equal(JSON.stringify(result).includes("UNKNOWN"), false);
  }
});

test("classification and every continuity family are independently blocking", () => {
  const unknown = cloneFixture(roleFixture("handheld"));
  unknown.capability.classification = null;
  assert.equal(
    evaluateFormalRoleEvidence(unknown).classification.status,
    "FAIL"
  );

  const processChanged = cloneFixture(roleFixture("station"));
  processChanged.backgroundSamples[1].pid += 1;
  const result = evaluateFormalRoleEvidence(processChanged);
  assert.equal(result.continuity.stableProcess.status, "FAIL");
  assert.equal(result.result, "FAIL");
});

test("role swapping and non-certified package bindings are rejected", () => {
  const swapped = cloneFixture(roleFixture("handheld"));
  swapped.role = "station";
  throwsCode(
    () => evaluateFormalRoleEvidence(swapped),
    "CERTIFIED_PAIR_MISMATCH"
  );

  const packageChanged = cloneFixture(roleFixture("station"));
  packageChanged.binding.packageId = "com.example.untrusted";
  throwsCode(
    () => evaluateFormalRoleEvidence(packageChanged),
    "CERTIFIED_PAIR_MISMATCH"
  );

  const modelChanged = cloneFixture(roleFixture("handheld"));
  modelChanged.binding.model = B0_FORMAL_MODELS.station;
  throwsCode(
    () => evaluateFormalRoleEvidence(modelChanged),
    "CERTIFIED_PAIR_MISMATCH"
  );
});

test("public report promotes only an exact passing Palmare/Postazione pair", () => {
  const evidence = privateEvidence();
  const report = buildPublicFormalReport(evidence, "a".repeat(64));
  assert.equal(report.result, "FORMAL_PASS");
  assert.equal(report.evidenceClass, "FORMAL");
  assert.equal(report.gateImpact, "GATE_EVIDENCE");
  assert.equal(report.formalGate, "PASS");
  assert.equal(report.formalGatePromoted, true);
  assert.deepEqual(report.roles.map((entry) => entry.role), B0_FORMAL_ROLES);

  const failed = structuredClone(evidence);
  for (const entry of [
    ...failed.devices[1].foregroundSamples,
    ...failed.devices[1].backgroundSamples
  ]) {
    entry.agent.resources.gattServerActive = false;
  }
  const failedReport = buildPublicFormalReport(failed, "b".repeat(64));
  assert.equal(failedReport.result, "FORMAL_CAPTURE_FAIL");
  assert.equal(failedReport.evidenceClass, "NON_GATE_EVIDENCE");
  assert.equal(failedReport.formalGate, "PENDING");
  assert.equal(failedReport.formalGatePromoted, false);
});

test("incomplete restoration or matrix mismatch cannot emit formal evidence", () => {
  const restoration = privateEvidence();
  restoration.restoration.completed = false;
  throwsCode(
    () => buildPublicFormalReport(restoration, "a".repeat(64)),
    "EVIDENCE_INVALID"
  );

  const matrix = privateEvidence();
  matrix.certificationMatrixSha256 = "f".repeat(64);
  throwsCode(
    () => buildPublicFormalReport(matrix, "a".repeat(64)),
    "EVIDENCE_INVALID"
  );
});

test("formal public evidence is redacted and private publication is mode 0600", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v6-b0-formal-"));
  const privateDirectory = path.join(directory, "private");
  fs.mkdirSync(privateDirectory, { mode: 0o700 });
  const privatePath = path.join(privateDirectory, "evidence.json");
  const reportPath = path.join(directory, "report.json");
  try {
    const evidence = privateEvidence();
    const { report } = publishFormalEvidencePair(
      privatePath,
      reportPath,
      evidence
    );
    const encoded = JSON.stringify(report);
    for (const role of B0_FORMAL_ROLES) {
      const source = evidence.devices[B0_FORMAL_ROLES.indexOf(role)].binding;
      assert.equal(encoded.includes(source.serial), false);
      assert.equal(encoded.includes(String(source.pid)), false);
      assert.equal(encoded.includes(String(source.appUid)), false);
    }
    assert.equal(fs.statSync(privatePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);
    assert.throws(() =>
      publishFormalEvidencePair(privatePath, reportPath, evidence)
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("formal ADB allowlist accepts both certified packages but default remains handheld-only", () => {
  const handheld = ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId;
  const station = ADVANCED_CERTIFICATION_TARGETS.roles.station.packageId;
  const packages = [handheld, station];
  const component = `${station}/.MainActivity`;
  const apk = `/data/app/~~fixture==/${station}-fixture==/base.apk`;
  const stationTranscripts = [
    ["shell", "dumpsys", "package", station],
    ["shell", "cmd", "package", "resolve-activity", "--brief", station],
    ["shell", "pm", "path", station],
    ["shell", "pidof", "-s", station],
    ["shell", "dumpsys", "activity", "-a", "services", station],
    ["shell", "dumpsys", "activity", "exit-info", station],
    ["shell", "am", "start", "-W", "--user", "0", "-n", component],
    [
      "exec-out",
      "run-as",
      station,
      "--user",
      "0",
      "cat",
      "no_backup/bluetooth-discovery-status-v1.json"
    ],
    ["exec-out", "sha256sum", apk]
  ];
  for (const transcript of stationTranscripts) {
    assert.deepEqual(
      assertNonDestructiveAdbArgs(transcript, packages),
      transcript
    );
  }
  assert.throws(() =>
    assertNonDestructiveAdbArgs(["shell", "dumpsys", "package", station])
  );
  assert.throws(() =>
    assertNonDestructiveAdbArgs(
      ["shell", "dumpsys", "package", "com.example.untrusted"],
      packages
    )
  );
});

test("physical CLI requires explicit, distinct serials and absolute paths", () => {
  const parsed = parseFormalArguments([
    "--adb",
    "/opt/android/adb",
    "--handheld-serial",
    "HANDHELD",
    "--station-serial",
    "STATION",
    "--private-output",
    "/secure/evidence.json",
    "--report-output",
    "/reports/redacted.json"
  ]);
  assert.equal(parsed.handheldSerial, "HANDHELD");
  assert.equal(parsed.stationSerial, "STATION");
  throwsCode(
    () =>
      parseFormalArguments([
        "--adb",
        "/opt/android/adb",
        "--handheld-serial",
        "SAME",
        "--station-serial",
        "SAME",
        "--private-output",
        "/secure/evidence.json",
        "--report-output",
        "/reports/redacted.json"
      ]),
    "INVALID_ARGUMENT"
  );
  throwsCode(() => parseFormalArguments(["--dry-run", "--adb", "/adb"]), "INVALID_ARGUMENT");
});

test("dry-run is matrix-bound, fail-closed and never accesses ADB", () => {
  const dryRun = buildFormalDryRun();
  assert.equal(dryRun.physicalAdbAccessed, false);
  assert.equal(dryRun.failClosed, true);
  assert.equal(dryRun.formalGate, "PENDING");
  assert.equal(
    dryRun.certificationMatrixSha256,
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256
  );
  assert.deepEqual(dryRun.certifiedTargets.map((entry) => entry.role), B0_FORMAL_ROLES);
  assert.deepEqual(
    dryRun.certifiedTargets.map((entry) => entry.model),
    ["SM-A165F", "SM-T503"]
  );
  assert.equal(dryRun.minimumAndroidApi, B0_MIN_ANDROID_API);
  assert.deepEqual(
    dryRun.certifiedTargets.map((entry) => entry.minimumAndroidApi),
    [B0_MIN_ANDROID_API, B0_MIN_ANDROID_API]
  );

  const spawned = spawnSync(process.execPath, [SCRIPT_PATH, "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" }
  });
  assert.equal(spawned.status, 0, spawned.stderr);
  const output = JSON.parse(spawned.stdout);
  assert.equal(output.physicalAdbAccessed, false);
  assert.equal(output.result, "PENDING_PHYSICAL_CAPTURE");
});

test("public failures preserve only a safe code", () => {
  const report = buildFormalFailure({
    code: "CERTIFIED_PAIR_MISMATCH",
    message: "private serial detail"
  });
  assert.equal(report.failure.code, "CERTIFIED_PAIR_MISMATCH");
  assert.equal(JSON.stringify(report).includes("private serial detail"), false);
  assert.equal(report.formalGate, "PENDING");
  assert.equal(buildFormalFailure({ code: "ADB_COMMAND_FAILED" }, true).physicalAdbAccessed, true);
});
