import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  B3_EXPECTED_TARGETS,
  B3_FGS_TYPE_CONNECTED_DEVICE,
  B3_FGS_TYPE_DATA_SYNC,
  B3_MIN_ANDROID_API,
  B3_REQUIRED_FOREGROUND_SERVICE_CHECKS,
  B3_REQUIRED_DURATION_MS,
  B3_REQUIRED_DURATION_SECONDS,
  B3_RUNTIME_AUDIT_INTERVAL_SECONDS,
  B3_STATUS_PATH,
  B3GateError,
  assertB3Scope,
  assertForegroundServiceForStatus,
  assertNoNewFatalApplicationExits,
  assertReportRedacted,
  buildForegroundServiceDumpArgs,
  buildHomeKeyEventArgs,
  buildCurrentUserRunAsArgs,
  buildDryRun,
  buildPhysicalSummary,
  createRuntimeEvidence,
  createStatusTracker,
  parseAdbDevices,
  parseArguments,
  parseApplicationExitInfo,
  parseCurrentUser,
  parseForegroundServiceDump,
  parseInstalledApkPath,
  parseInstalledApkSha256,
  parseInstalledVersion,
  parseStatus,
  permissionGrantedForUser,
  runSelfTest,
  statusFixture,
  validateFreshSample
} from "./run-b3-android-service-gate.mjs";
import { ADVANCED_CERTIFICATION_TARGETS } from "./advanced-certification-targets.mjs";

function parsedFixture(overrides = {}) {
  return parseStatus(JSON.stringify(statusFixture(overrides)));
}

function passingPreflight() {
  return ["handheld", "station"].map((role) => ({
    role,
    androidApi: 34,
    currentAndroidUserVerified: true,
    fixedTargetTransportVerified: true,
    fixedTargetModelVerified: true,
    fixedTargetPackageVerified: true,
    fixedTargetVersionVerified: true,
    fixedTargetApkSha256Verified: true,
    bluetoothLeFeature: true,
    bluetoothEnabled: true,
    currentUserBluetoothPermissionsGranted: true,
    privateStatusReadableWithRunAs: true
  }));
}

function passingTrackers() {
  return ["handheld", "station"].map((role) => {
    const tracker = createStatusTracker();
    const anchor = {
      epochFloorMs: 1_000,
      capturedAtPerformanceMs: 0
    };
    const first = parsedFixture();
    const second = parsedFixture({
      sampleSequence: 2,
      sampledAtEpochMs: 1_200,
      metrics: { transitionCount: 2 }
    });
    validateFreshSample(first, tracker, anchor, 200, role);
    validateFreshSample(second, tracker, anchor, 300, role);
    return tracker;
  });
}

function passingRuntimeEvidence() {
  return ["handheld", "station"].map(() => ({
    ...createRuntimeEvidence(),
    homeKeyEventSent: true,
    foregroundServiceChecks: 61,
    radioActiveForegroundChecks: 61,
    applicationExitBaselineCaptured: true,
    applicationExitFinalCaptured: true,
    newAnrOrCrashCount: 0
  }));
}

test("binds B3 to the fixed duration and Advanced targets", () => {
  assert.equal(B3_REQUIRED_DURATION_SECONDS, 3_600);
  assert.equal(B3_REQUIRED_DURATION_MS, 3_600_000);
  assert.equal(B3_RUNTIME_AUDIT_INTERVAL_SECONDS, 60);
  assert.equal(B3_REQUIRED_FOREGROUND_SERVICE_CHECKS, 61);
  assert.equal(B3_MIN_ANDROID_API, 33);
  assert.equal(B3_EXPECTED_TARGETS.handheld.model, "SM-A165F");
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(ADVANCED_CERTIFICATION_TARGETS.roles.handheld).map((key) => [
        key,
        B3_EXPECTED_TARGETS.handheld[key]
      ])
    ),
    ADVANCED_CERTIFICATION_TARGETS.roles.handheld
  );
  assert.equal(B3_EXPECTED_TARGETS.station.model, "SM-T503");
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(ADVANCED_CERTIFICATION_TARGETS.roles.station).map((key) => [
        key,
        B3_EXPECTED_TARGETS.station[key]
      ])
    ),
    ADVANCED_CERTIFICATION_TARGETS.roles.station
  );
});

test("accepts only the exact enabled B3 Lab status schema", () => {
  const status = parsedFixture();
  assert.equal(status.source, "V6_ANDROID_CONNECTIVITY_AGENT");
  assert.equal(status.labBuild, true);
  assert.equal(status.diagnosticsEnabled, true);
  assert.equal(status.agentEnabled, true);
  assert.equal(status.state, "DISCOVERING");
  assert.deepEqual(Object.keys(status.metrics).sort(), [
    "backoffCount",
    "duplicateEventCount",
    "invalidTransitionCount",
    "startCount",
    "stopCount",
    "transitionCount"
  ]);
  assert.deepEqual(Object.keys(status.resources).sort(), [
    "advertiserActive",
    "gattClientActive",
    "gattServerActive",
    "scannerActive",
    "sessionCount"
  ]);
});

test("rejects extra fields and identifier-shaped fields", () => {
  assert.throws(
    () =>
      parseStatus(
        JSON.stringify({ ...statusFixture(), unexpected: false })
      ),
    (error) =>
      error instanceof B3GateError && error.code === "STATUS_INVALID"
  );
  assert.throws(
    () =>
      parseStatus(
        JSON.stringify({ ...statusFixture(), nodeId: "forbidden" })
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "STATUS_NOT_REDACTED"
  );
  assert.throws(
    () =>
      parseStatus(
        JSON.stringify(
          statusFixture({
            metrics: { accidentalCounter: 0 }
          })
        )
      ),
    (error) =>
      error instanceof B3GateError && error.code === "STATUS_INVALID"
  );
});

test("rejects disabled flags, wrong source and invalid state", () => {
  for (const fixture of [
    statusFixture({ labBuild: false }),
    statusFixture({ diagnosticsEnabled: false }),
    statusFixture({ agentEnabled: false }),
    statusFixture({ source: "OTHER" }),
    statusFixture({ state: "UNKNOWN" })
  ]) {
    assert.throws(
      () => parseStatus(JSON.stringify(fixture)),
      (error) =>
        error instanceof B3GateError &&
        error.code === "STATUS_INVALID"
    );
  }
});

test("fails closed on STOPPED, direct-session states and invalid transitions", () => {
  assert.throws(
    () => assertB3Scope(parsedFixture({ state: "STOPPED" })),
    (error) =>
      error instanceof B3GateError && error.code === "SERVICE_STOPPED"
  );
  for (const state of ["DIRECT_SERVER", "PEER_CONNECTED"]) {
    assert.throws(
      () => assertB3Scope(parsedFixture({ state })),
      (error) =>
        error instanceof B3GateError &&
        error.code === "B3_SCOPE_VIOLATION"
    );
  }
  assert.throws(
    () =>
      assertB3Scope(
        parsedFixture({
          metrics: {
            transitionCount: 1,
            invalidTransitionCount: 1
          }
        })
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "INVALID_TRANSITION_REPORTED"
  );
});

test("requires one uninterrupted service start and no stop", () => {
  assert.throws(
    () =>
      assertB3Scope(
        parsedFixture({ metrics: { startCount: 2 } })
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "SERVICE_START_COUNT_INVALID"
  );
  assert.throws(
    () =>
      assertB3Scope(
        parsedFixture({ metrics: { stopCount: 1 } })
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "SERVICE_STOP_REPORTED"
  );
});

test("rejects all GATT and session activity in B3", () => {
  for (const resources of [
    { gattServerActive: true },
    { gattClientActive: true },
    { sessionCount: 1 }
  ]) {
    assert.throws(
      () => assertB3Scope(parsedFixture({ resources })),
      (error) =>
        error instanceof B3GateError &&
        error.code === "B3_GATT_SESSION_ACTIVITY"
    );
  }
});

test("accepts fresh monotonic samples from the same reporter", () => {
  const tracker = createStatusTracker();
  const anchor = {
    epochFloorMs: 1_000,
    capturedAtPerformanceMs: 0
  };
  validateFreshSample(
    parsedFixture(),
    tracker,
    anchor,
    200,
    "handheld"
  );
  validateFreshSample(
    parsedFixture({
      sampleSequence: 2,
      sampledAtEpochMs: 1_200,
      state: "BACKOFF",
      metrics: {
        backoffCount: 1,
        transitionCount: 2
      }
    }),
    tracker,
    anchor,
    300,
    "handheld"
  );
  assert.equal(tracker.distinctSamples, 2);
  assert.deepEqual([...tracker.statesObserved].sort(), [
    "BACKOFF",
    "DISCOVERING"
  ]);
});

test("rejects sequence reuse, reporter restart and counter regression", () => {
  const tracker = createStatusTracker();
  const anchor = {
    epochFloorMs: 1_000,
    capturedAtPerformanceMs: 0
  };
  validateFreshSample(
    parsedFixture(),
    tracker,
    anchor,
    200,
    "station"
  );
  assert.throws(
    () =>
      validateFreshSample(
        parsedFixture({ state: "BACKOFF" }),
        tracker,
        anchor,
        250,
        "station"
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "STATUS_SEQUENCE_REUSED"
  );
  assert.throws(
    () =>
      validateFreshSample(
        parsedFixture({
          sampleSequence: 2,
          sampledAtEpochMs: 1_300,
          reporterStartedAtEpochMs: 1_250
        }),
        tracker,
        anchor,
        400,
        "station"
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "STATUS_REPORTER_RESTARTED"
  );

  const progressedTracker = createStatusTracker();
  validateFreshSample(
    parsedFixture({ metrics: { transitionCount: 2 } }),
    progressedTracker,
    anchor,
    200,
    "station"
  );
  assert.throws(
    () =>
      validateFreshSample(
        parsedFixture({
          sampleSequence: 2,
          sampledAtEpochMs: 1_200,
          metrics: { transitionCount: 1 }
        }),
        progressedTracker,
        anchor,
        300,
        "station"
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "STATUS_METRICS_REGRESSED"
  );
});

test("rejects stale samples and timestamps outside the launch window", () => {
  const anchor = {
    epochFloorMs: 100_000,
    capturedAtPerformanceMs: 0
  };
  assert.throws(
    () =>
      validateFreshSample(
        parsedFixture({
          reporterStartedAtEpochMs: 99_999,
          sampledAtEpochMs: 100_100
        }),
        createStatusTracker(),
        anchor,
        200,
        "handheld"
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "STATUS_NOT_FRESH"
  );
  assert.throws(
    () =>
      validateFreshSample(
        parsedFixture({
          reporterStartedAtEpochMs: 100_000,
          sampledAtEpochMs: 100_100
        }),
        createStatusTracker(),
        anchor,
        31_000,
        "handheld"
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "STATUS_NOT_FRESH"
  );
});

test("parses ADB inventory and the fixed APK identity", () => {
  const devices = parseAdbDevices(
    "List of devices attached\nABC device\nXYZ unauthorized\n"
  );
  assert.equal(devices.get("ABC"), "device");
  assert.equal(devices.get("XYZ"), "unauthorized");
  assert.equal(parseCurrentUser("10\n"), 10);
  assert.deepEqual(
    parseInstalledVersion(
      "  versionCode=37 minSdk=24\n  versionName=1.0.36\n"
    ),
    { versionCode: 37, versionName: "1.0.36" }
  );
  assert.equal(
    parseInstalledApkPath("package:/data/app/example/base.apk\n"),
    "/data/app/example/base.apk"
  );
  assert.equal(
    parseInstalledApkSha256(
      `${B3_EXPECTED_TARGETS.handheld.sha256}  /data/app/example/base.apk\n`
    ),
    B3_EXPECTED_TARGETS.handheld.sha256
  );
  assert.throws(
    () =>
      parseInstalledApkPath(
        "package:/data/app/example/base.apk\npackage:/data/app/example/split.apk\n"
      ),
    (error) =>
      error instanceof B3GateError && error.code === "APK_LAYOUT_INVALID"
  );
});

test("checks permissions only in the current Android user block", () => {
  const dump = [
    "  User 0:",
    "    runtime permissions:",
    "      android.permission.BLUETOOTH_SCAN: granted=true",
    "  User 10:",
    "    runtime permissions:",
    "      android.permission.BLUETOOTH_SCAN: granted=false"
  ].join("\n");
  assert.equal(
    permissionGrantedForUser(
      dump,
      0,
      "android.permission.BLUETOOTH_SCAN"
    ),
    true
  );
  assert.equal(
    permissionGrantedForUser(
      dump,
      10,
      "android.permission.BLUETOOTH_SCAN"
    ),
    false
  );
});

test("builds run-as commands for the current user without a shell", () => {
  assert.deepEqual(
    buildCurrentUserRunAsArgs(
      "com.sentrapa.palmare.advanced",
      10,
      "cat",
      B3_STATUS_PATH
    ),
    [
      "exec-out",
      "run-as",
      "com.sentrapa.palmare.advanced",
      "--user",
      "10",
      "cat",
      B3_STATUS_PATH
    ]
  );
});

test("backgrounds the launched app with the Android HOME key event", () => {
  assert.deepEqual(buildHomeKeyEventArgs(), [
    "shell",
    "input",
    "keyevent",
    "KEYCODE_HOME"
  ]);
});

test("requests a full service dump so foreground types are present", () => {
  assert.deepEqual(
    buildForegroundServiceDumpArgs(
      "com.sentrapa.palmare.advanced"
    ),
    [
      "shell",
      "dumpsys",
      "activity",
      "-a",
      "services",
      "com.sentrapa.palmare.advanced"
    ]
  );
});

test("parses only the current user's Bluetooth failover ServiceRecord", () => {
  const dump = [
    "ACTIVITY MANAGER SERVICES (dumpsys activity services)",
    " User 0 active services:",
    " * ServiceRecord{aaa u0 com.example/.BluetoothFailoverService}",
    "   isForeground=true foregroundId=1 types=00000001",
    " User 10 active services:",
    " * ServiceRecord{bbb u10 com.example/com.sentrapa.webkiosk.bluetooth.BluetoothFailoverService}",
    "   isForeground=true foregroundId=2 types=0x00000011",
    " * ServiceRecord{ccc u10 com.example/.AlwaysOnService}",
    "   isForeground=true foregroundId=3 types=0x00000003"
  ].join("\n");
  assert.deepEqual(
    parseForegroundServiceDump(dump, 10, "handheld"),
    { foreground: true, typeMask: 0x11 }
  );
  assert.deepEqual(
    parseForegroundServiceDump(dump, 0, "handheld"),
    { foreground: true, typeMask: 0x01 }
  );
  assert.throws(
    () => parseForegroundServiceDump(dump, 11, "handheld"),
    (error) =>
      error instanceof B3GateError &&
      error.code === "FOREGROUND_SERVICE_MISSING"
  );
});

test("requires dataSync and conditionally connectedDevice service types", () => {
  const inactive = parsedFixture({
    resources: {
      scannerActive: false,
      advertiserActive: false
    }
  });
  assert.deepEqual(
    assertForegroundServiceForStatus(
      { foreground: true, typeMask: B3_FGS_TYPE_DATA_SYNC },
      inactive,
      "station"
    ),
    { radioActive: false }
  );
  assert.deepEqual(
    assertForegroundServiceForStatus(
      {
        foreground: true,
        typeMask:
          B3_FGS_TYPE_DATA_SYNC |
          B3_FGS_TYPE_CONNECTED_DEVICE
      },
      parsedFixture(),
      "station"
    ),
    { radioActive: true }
  );
  assert.throws(
    () =>
      assertForegroundServiceForStatus(
        { foreground: true, typeMask: B3_FGS_TYPE_DATA_SYNC },
        parsedFixture(),
        "station"
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "FOREGROUND_SERVICE_TYPE_INVALID"
  );
  assert.throws(
    () =>
      assertForegroundServiceForStatus(
        { foreground: false, typeMask: 0 },
        inactive,
        "station"
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "FOREGROUND_SERVICE_NOT_ACTIVE"
  );
});

test("parses fatal ApplicationExitInfo records only for the current user", () => {
  const dump = [
    "ACTIVITY MANAGER PROCESS EXIT INFO (dumpsys activity exit-info)",
    " package: com.example",
    "  Historical Process Exit for uid=1010123",
    "   ApplicationExitInfo #0:",
    "    timestamp=2026-07-20 09:00:00.000",
    "    pid=200",
    "    realUid=1010123",
    "    packageUid=1010123",
    "    definingUid=1010123",
    "    user=10",
    "    process=com.example",
    "    reason=4 (APP CRASH(EXCEPTION))",
    "   ApplicationExitInfo #1:",
    "    timestamp=2026-07-20 09:01:00.000 pid=201 realUid=1010123 packageUid=1010123 definingUid=1010123 user=10",
    "    process=com.example reason=10 (USER REQUESTED) subreason=0 (UNKNOWN) status=0",
    "  Historical Process Exit for uid=10123",
    "   ApplicationExitInfo #0:",
    "    timestamp=2026-07-20 09:02:00.000 pid=202 realUid=10123 packageUid=10123 definingUid=10123 user=0",
    "    process=com.example reason=6 (ANR) subreason=0 (UNKNOWN) status=0"
  ].join("\n");
  const parsed = parseApplicationExitInfo(dump, 10, "handheld");
  assert.equal(parsed.currentUserRecordCount, 2);
  assert.equal(parsed.fatalRecordCount, 1);
  assert.equal(parsed.fatalFingerprints.size, 1);
});

test("fails on a new Java crash, native crash or ANR exit record", () => {
  const header =
    "ACTIVITY MANAGER PROCESS EXIT INFO (dumpsys activity exit-info)";
  const oldRecord = [
    " ApplicationExitInfo #0:",
    "  timestamp=2026-07-19 09:00:00.000 pid=100 realUid=1010123 packageUid=1010123 definingUid=1010123 user=10",
    "  process=com.example reason=4 (APP CRASH(EXCEPTION)) subreason=0 (UNKNOWN) status=0"
  ].join("\n");
  const baseline = parseApplicationExitInfo(
    [header, oldRecord].join("\n"),
    10,
    "station"
  );
  assert.equal(
    assertNoNewFatalApplicationExits(
      baseline,
      parseApplicationExitInfo(
        [
          header,
          oldRecord,
          " ApplicationExitInfo #1:",
          "  timestamp=2026-07-20 09:01:00.000 pid=101 realUid=1010123 packageUid=1010123 definingUid=1010123 user=10",
          "  process=com.example reason=10 (USER REQUESTED) subreason=0 (UNKNOWN) status=0"
        ].join("\n"),
        10,
        "station"
      ),
      "station"
    ),
    0
  );

  for (const [reason, label] of [
    [4, "APP CRASH(EXCEPTION)"],
    [5, "APP CRASH(NATIVE)"],
    [6, "ANR"]
  ]) {
    const final = parseApplicationExitInfo(
      [
        header,
        oldRecord,
        " ApplicationExitInfo #1:",
        `  timestamp=2026-07-20 09:0${reason}:00.000 pid=10${reason} realUid=1010123 packageUid=1010123 definingUid=1010123 user=10`,
        `  process=com.example reason=${reason} (${label}) subreason=0 (UNKNOWN) status=0`
      ].join("\n"),
      10,
      "station"
    );
    assert.throws(
      () =>
        assertNoNewFatalApplicationExits(
          baseline,
          final,
          "station"
        ),
      (error) =>
        error instanceof B3GateError &&
        error.code === "NEW_ANR_OR_CRASH"
    );
  }
});

test("rejects malformed foreground-service and exit-info evidence", () => {
  assert.throws(
    () =>
      parseForegroundServiceDump(
        " * ServiceRecord{abc u10 com.example/.AlwaysOnService}",
        10
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "FOREGROUND_SERVICE_MISSING"
  );
  assert.throws(
    () => parseApplicationExitInfo("unsupported output", 10),
    (error) =>
      error instanceof B3GateError &&
      error.code === "APPLICATION_EXIT_INFO_INVALID"
  );
});

test("argument parser fixes both target roles and rejects duration overrides", () => {
  const physical = parseArguments([
    "--handheld-serial",
    B3_EXPECTED_TARGETS.handheld.serial,
    "--station-serial",
    B3_EXPECTED_TARGETS.station.serial
  ]);
  assert.equal(
    physical.handheldSerial,
    B3_EXPECTED_TARGETS.handheld.serial
  );
  assert.throws(
    () =>
      parseArguments([
        "--handheld-serial",
        B3_EXPECTED_TARGETS.handheld.serial
      ]),
    (error) =>
      error instanceof B3GateError &&
      error.code === "INVALID_ARGUMENT"
  );
  assert.throws(
    () =>
      parseArguments([
        "--dry-run",
        "--duration-seconds",
        "10"
      ]),
    (error) =>
      error instanceof B3GateError &&
      error.code === "INVALID_ARGUMENT"
  );
});

test("dry-run is offline, fixed at 3600 seconds and remains pending", () => {
  const report = buildDryRun(
    parseArguments(["--dry-run", "--adb", "/missing/adb"])
  );
  assert.equal(report.adbExecuted, false);
  assert.equal(report.physicalRunExecuted, false);
  assert.equal(report.requiredDurationSeconds, 3_600);
  assert.equal(report.runtimeAuditIntervalSeconds, 60);
  assert.equal(report.requiredForegroundServiceChecks, 61);
  assert.equal(report.gate, "PENDING");
  assert.equal(report.localMeasurementVerdict, "NOT_RUN");
  assert.equal(report.activeV4Changes, false);
});

test("successful physical measurements remain pending for review", () => {
  const report = buildPhysicalSummary(
    passingPreflight(),
    passingTrackers(),
    B3_REQUIRED_DURATION_MS,
    passingRuntimeEvidence()
  );
  assert.equal(report.localMeasurementVerdict, "PASS");
  assert.equal(report.gate, "PENDING");
  assert.equal(
    report.gateReason,
    "PHYSICAL_EVIDENCE_REVIEW_REQUIRED"
  );
  assert.equal(report.physicalCertificationPassEmittedByHarness, false);
  assert.equal(report.measuredDurationMs, 3_600_000);
  assert.equal(report.runtimeAuditIntervalSeconds, 60);
  assert.equal(report.requiredForegroundServiceChecks, 61);
  assert.equal(report.targets.length, 2);
  for (const target of report.targets) {
    assert.equal(target.backgroundLifecycle.homeKeyEventSent, true);
    assert.equal(
      target.backgroundLifecycle.foregroundServiceChecks,
      61
    );
    assert.equal(target.applicationExitInfo.baselineCaptured, true);
    assert.equal(target.applicationExitInfo.finalCaptured, true);
    assert.equal(target.applicationExitInfo.newAnrOrCrashCount, 0);
  }
});

test("short or incomplete measurements cannot pass locally", () => {
  const short = buildPhysicalSummary(
    passingPreflight(),
    passingTrackers(),
    B3_REQUIRED_DURATION_MS - 1,
    passingRuntimeEvidence()
  );
  assert.equal(short.localMeasurementVerdict, "PENDING");

  const incompletePreflight = passingPreflight();
  incompletePreflight[0].currentUserBluetoothPermissionsGranted = false;
  const incomplete = buildPhysicalSummary(
    incompletePreflight,
    passingTrackers(),
    B3_REQUIRED_DURATION_MS,
    passingRuntimeEvidence()
  );
  assert.equal(incomplete.localMeasurementVerdict, "PENDING");

  const unverifiedApk = passingPreflight();
  unverifiedApk[0].fixedTargetApkSha256Verified = false;
  assert.equal(
    buildPhysicalSummary(
      unverifiedApk,
      passingTrackers(),
      B3_REQUIRED_DURATION_MS,
      passingRuntimeEvidence()
    ).localMeasurementVerdict,
    "PENDING"
  );

  const missingRuntimeEvidence = buildPhysicalSummary(
    passingPreflight(),
    passingTrackers(),
    B3_REQUIRED_DURATION_MS
  );
  assert.equal(
    missingRuntimeEvidence.localMeasurementVerdict,
    "PENDING"
  );

  const insufficientRuntimeEvidence = passingRuntimeEvidence();
  insufficientRuntimeEvidence[0].foregroundServiceChecks =
    B3_REQUIRED_FOREGROUND_SERVICE_CHECKS - 1;
  const insufficientRuntime = buildPhysicalSummary(
    passingPreflight(),
    passingTrackers(),
    B3_REQUIRED_DURATION_MS,
    insufficientRuntimeEvidence
  );
  assert.equal(insufficientRuntime.localMeasurementVerdict, "PENDING");
});

test("report firewall rejects target values and identifier fields", () => {
  const report = buildPhysicalSummary(
    passingPreflight(),
    passingTrackers(),
    B3_REQUIRED_DURATION_MS,
    passingRuntimeEvidence()
  );
  assert.equal(
    assertReportRedacted(report, [
      B3_EXPECTED_TARGETS.handheld.serial,
      B3_EXPECTED_TARGETS.station.serial
    ]),
    true
  );
  assert.throws(
    () =>
      assertReportRedacted(
        { accidental: B3_EXPECTED_TARGETS.handheld.serial },
        [B3_EXPECTED_TARGETS.handheld.serial]
      ),
    (error) =>
      error instanceof B3GateError &&
      error.code === "OUTPUT_IDENTIFIER_DETECTED"
  );
  assert.throws(
    () => assertReportRedacted({ nested: { nodeId: "x" } }),
    (error) =>
      error instanceof B3GateError &&
      error.code === "OUTPUT_IDENTIFIER_FIELD"
  );
});

test("built-in self-test is offline and leaves the gate pending", () => {
  const report = runSelfTest();
  assert.equal(report.result, "PASS");
  assert.equal(report.adbExecuted, false);
  assert.equal(report.physicalRunExecuted, false);
  assert.equal(report.activeV4Changes, false);
  assert.equal(report.gate, "PENDING");
  assert.ok(report.tests >= 30);
});

test("end-to-end self-test does not execute the configured ADB path", () => {
  const script = fileURLToPath(
    new URL("./run-b3-android-service-gate.mjs", import.meta.url)
  );
  const environment = {
    ...process.env,
    ADB: "/definitely/not/an/adb/binary"
  };
  delete environment.NODE_TEST_CONTEXT;
  const result = childProcess.spawnSync(
    process.execPath,
    [script, "--self-test"],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: environment
    }
  );
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result, "PASS");
  assert.equal(report.adbExecuted, false);
  assert.equal(report.gate, "PENDING");
});

test("end-to-end dry-run writes a mode-0600 report without target values", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v6-b3-dry-run-")
  );
  const output = path.join(directory, "b3.json");
  const script = fileURLToPath(
    new URL("./run-b3-android-service-gate.mjs", import.meta.url)
  );
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  try {
    const result = childProcess.spawnSync(
      process.execPath,
      [
        script,
        "--dry-run",
        "--adb",
        "/definitely/not/an/adb/binary",
        "--handheld-serial",
        B3_EXPECTED_TARGETS.handheld.serial,
        "--station-serial",
        B3_EXPECTED_TARGETS.station.serial,
        "--output",
        output
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: environment
      }
    );
    assert.equal(result.status, 0);
    const payload = fs.readFileSync(output, "utf8");
    assert.equal(
      payload.includes(B3_EXPECTED_TARGETS.handheld.serial),
      false
    );
    assert.equal(
      payload.includes(B3_EXPECTED_TARGETS.station.serial),
      false
    );
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const report = JSON.parse(payload);
    assert.equal(report.bothFixedTargetsConfigured, true);
    assert.equal(report.adbExecuted, false);
    assert.equal(report.gate, "PENDING");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
