import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ADVANCED_CERTIFICATION_TARGETS } from "./advanced-certification-targets.mjs";
import {
  B0_CAPTURE_DURATION_SECONDS,
  B0_REQUIRED_CONTROLS,
  B0SupplementalError,
  assertNonDestructiveAdbArgs,
  assertPublicReportRedacted,
  buildCaptureSchedule,
  buildDryRun,
  buildPublicFailure,
  buildPublicReport,
  buildRestoreArgs,
  evaluateDeviceEvidence,
  parseArguments,
  parseB0PackageState,
  parseCapabilityReport,
  parseDevtoolsEvaluation,
  parseDevtoolsTargets,
  parseWifiConnectivity,
  publishEvidencePair,
  runSelfTest
} from "./run-b0-android-supplemental-gate.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./run-b0-android-supplemental-gate.mjs", import.meta.url)
);
const TARGET = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;
const NOW_MS = Date.parse("2026-08-03T12:00:00.000Z");
const SESSION_HMAC = "c".repeat(64);

function throwsCode(action, code) {
  assert.throws(
    action,
    (error) => error instanceof B0SupplementalError && error.code === code,
    `expected ${code}`
  );
}

function capability(overrides = {}) {
  return parseCapabilityReport(
    JSON.stringify({
      manufacturer: "Test Vendor",
      model: "Test Phone",
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

function binding(overrides = {}) {
  return {
    ordinal: "handheld-1",
    serial: "PRIVATE_TARGET_SERIAL_0001",
    packageId: TARGET.packageId,
    androidApi: 36,
    currentUser: 0,
    appUid: 10_123,
    pid: 4_321,
    discoveryReporterStartedAtEpochMs: NOW_MS - 60_000,
    agentReporterStartedAtEpochMs: NOW_MS - 55_000,
    gattReporterStartedAtEpochMs: NOW_MS - 50_000,
    apkSha256: TARGET.sha256,
    sessionBindingHmacSha256: SESSION_HMAC,
    launcherComponent: `${TARGET.packageId}/.MainActivity`,
    wasForeground: true,
    wasRunning: true,
    ...overrides
  };
}

function sample(index, appForeground) {
  const timestamp = NOW_MS + index * 5_000;
  return {
    hostEpochMs: timestamp,
    hostMonotonicMs: index * 5_000,
    deviceEpochMs: timestamp,
    currentUser: 0,
    installedVersion: {
      versionName: TARGET.versionName,
      versionCode: TARGET.versionCode
    },
    appUid: 10_123,
    packageStopped: false,
    pid: 4_321,
    discovery: {
      sampleSequence: 100 + index,
      sampledAtEpochMs: timestamp,
      reporterStartedAtEpochMs: NOW_MS - 60_000,
      activePeerCount: 1,
      metrics: {
        scanWindowsStarted: 10 + index,
        concurrentScanAdvertiseWindowsStarted: 10 + index,
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

function evidenceFixture() {
  return {
    binding: binding(),
    capability: capability(),
    foregroundSamples: [sample(0, true), sample(1, true), sample(2, true)],
    backgroundSamples: [sample(3, false), sample(4, false), sample(5, false)],
    exitBaseline: { commitments: new Set(), counts: {} },
    exitFinal: { commitments: new Set(), counts: {} }
  };
}

function cloneEvidence(value = evidenceFixture()) {
  return {
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

function evaluate(value = evidenceFixture()) {
  return evaluateDeviceEvidence(value);
}

function privateEvidenceFixture() {
  return {
    schemaVersion: 1,
    source: "V6_B0_ANDROID_SUPPLEMENTAL_PRIVATE",
    sessionHmacKeyBase64: Buffer.alloc(32, 7).toString("base64"),
    devices: ["handheld-1", "handheld-2"].map((ordinal, index) => {
      const fixture = evidenceFixture();
      fixture.binding = binding({
        ordinal,
        serial: `PRIVATE_TARGET_SERIAL_000${index + 1}`
      });
      return {
        binding: fixture.binding,
        capability: fixture.capability,
        privateIdentity: `PRIVATE_PROVISIONING_IDENTITY_${index + 1}`,
        result: evaluate(fixture)
      };
    })
  };
}

test("all seven supplemental controls pass only with measured physical evidence", () => {
  const result = evaluate();
  assert.deepEqual(Object.keys(result.controls), B0_REQUIRED_CONTROLS);
  assert.equal(result.result, "SUPPLEMENTAL_PASS");
  assert.equal(result.evidenceClass, "SUPPLEMENTAL");
  assert.equal(result.gateImpact, "NON_GATE_EVIDENCE");
  assert.equal(
    Object.values(result.controls).every((entry) => entry.status === "PASS"),
    true
  );
  assert.equal(
    Object.values(result.continuity).every((entry) => entry.status === "PASS"),
    true
  );
});

test("null atomic capability outcomes fail every primitive radio control closed", () => {
  const cases = [
    ["scan", { scannerAvailable: null }],
    ["advertise", { advertiserAvailable: null }],
    ["gattClient", { gattClientAvailable: null }],
    ["gattServer", { adapterEnabled: null }]
  ];
  for (const [control, override] of cases) {
    const fixture = evidenceFixture();
    fixture.capability = capability(override);
    assert.equal(evaluate(fixture).controls[control].status, "FAIL", control);
  }
});

test("aggregate probe incompleteness does not mask independently measured primitives", () => {
  const fixture = evidenceFixture();
  fixture.capability = capability({
    gattServerOpen: true,
    probeStatus: "PROBE_INCOMPLETE",
    scan: null,
    advertise: null,
    gattClient: null,
    gattServer: null,
    classification: null
  });
  const result = evaluate(fixture);
  assert.equal(result.controls.scan.status, "PASS");
  assert.equal(result.controls.advertise.status, "PASS");
  assert.equal(result.controls.gattClient.status, "PASS");
  assert.equal(result.controls.gattServer.status, "PASS");
  assert.equal(result.formalGate, undefined);
  assert.equal(result.gateImpact, "NON_GATE_EVIDENCE");
});

test("advertising is independent from the GATT connect permission", () => {
  const fixture = evidenceFixture();
  fixture.capability = capability({ connectPermission: false });
  const result = evaluate(fixture);
  assert.equal(result.controls.scan.status, "PASS");
  assert.equal(result.controls.advertise.status, "PASS");
  assert.equal(result.controls.gattClient.status, "FAIL");
  assert.equal(result.controls.gattServer.status, "FAIL");
});

test("GATT client must be active or progress during the capture", () => {
  const fixture = evidenceFixture();
  for (const entry of [...fixture.foregroundSamples, ...fixture.backgroundSamples]) {
    entry.gatt.active = false;
    entry.gatt.metrics.connectionAttempts = 0;
    entry.gatt.metrics.connectionsEstablished = 0;
  }
  assert.equal(fixture.foregroundSamples[0].agent.resources.gattClientActive, true);
  const result = evaluate(fixture);
  assert.equal(result.controls.gattClient.status, "FAIL");
  assert.equal(result.result, "SUPPLEMENTAL_FAIL");
});

test("GATT server requires an explicit open-close capability result", () => {
  const explicit = evidenceFixture();
  for (const entry of [...explicit.foregroundSamples, ...explicit.backgroundSamples]) {
    entry.agent.resources.gattServerActive = false;
  }
  assert.equal(explicit.capability.gattServerOpen, true);
  assert.equal(evaluate(explicit).controls.gattServer.status, "PASS");

  for (const outcome of [false, null]) {
    const missing = evidenceFixture();
    missing.capability = capability({
      gattServerOpen: outcome,
      probeStatus: outcome === false ? "COMPLETE" : "PROBE_INCOMPLETE",
      gattServer: outcome,
      classification: outcome === false ? "CLIENT_ONLY" : null
    });
    assert.equal(evaluate(missing).controls.gattServer.status, "FAIL");
  }
});

test("concurrency, Wi-Fi coexistence and both lifecycle phases are independently required", () => {
  for (const phase of ["foregroundSamples", "backgroundSamples"]) {
    const noConcurrency = evidenceFixture();
    const firstConcurrentWindow =
      noConcurrency[phase][0].discovery.metrics
        .concurrentScanAdvertiseWindowsStarted;
    for (const entry of noConcurrency[phase]) {
      entry.discovery.metrics.concurrentScanAdvertiseWindowsStarted =
        firstConcurrentWindow;
    }
    assert.equal(
      evaluate(noConcurrency).controls.scanAdvertiseConcurrent.status,
      "FAIL",
      phase
    );
  }

  const cumulativeConcurrency = evidenceFixture();
  for (const [index, entry] of [
    ...cumulativeConcurrency.foregroundSamples,
    ...cumulativeConcurrency.backgroundSamples
  ].entries()) {
    entry.agent.resources.scannerActive = index % 2 === 0;
    entry.agent.resources.advertiserActive = index % 2 !== 0;
  }
  assert.equal(
    evaluate(cumulativeConcurrency).controls.scanAdvertiseConcurrent.status,
    "PASS"
  );

  const regressedConcurrency = evidenceFixture();
  regressedConcurrency.backgroundSamples[1].discovery.metrics
    .concurrentScanAdvertiseWindowsStarted = 1;
  assert.equal(
    evaluate(regressedConcurrency).controls.scanAdvertiseConcurrent.status,
    "FAIL"
  );

  const noWifi = evidenceFixture();
  noWifi.backgroundSamples[1].wifi.connected = false;
  assert.equal(evaluate(noWifi).controls.wifiBleCoexistence.status, "FAIL");

  const noBackground = evidenceFixture();
  noBackground.backgroundSamples[0].appForeground = true;
  assert.equal(evaluate(noBackground).controls.backgroundForeground.status, "FAIL");
});

test("continuity rejects version, user, process, reporter, session and service changes", () => {
  const cases = [
    ["stablePackageVersion", (fixture) => {
      fixture.backgroundSamples[1].installedVersion.versionCode += 1;
    }],
    ["stableAndroidUser", (fixture) => {
      fixture.backgroundSamples[1].currentUser = 10;
    }],
    ["stableProcess", (fixture) => {
      fixture.backgroundSamples[1].pid += 1;
    }],
    ["stableProcess", (fixture) => {
      fixture.backgroundSamples[1].appUid += 1;
    }],
    ["stableReporters", (fixture) => {
      fixture.backgroundSamples[1].agent.reporterStartedAtEpochMs += 1;
    }],
    ["noLogout", (fixture) => {
      fixture.backgroundSamples[1].sessionBindingHmacSha256 = "d".repeat(64);
    }],
    ["serviceContinuous", (fixture) => {
      fixture.backgroundSamples[1].agent.metrics.stopCount = 1;
    }],
    ["serviceContinuous", (fixture) => {
      fixture.backgroundSamples[1].foregroundService.foreground = false;
    }]
  ];
  for (const [field, mutate] of cases) {
    const fixture = cloneEvidence();
    mutate(fixture);
    const result = evaluate(fixture);
    assert.equal(result.continuity[field].status, "FAIL", field);
    assert.equal(result.controls.backgroundForeground.status, "FAIL", field);
    assert.equal(result.result, "SUPPLEMENTAL_FAIL", field);
  }
});

test("continuity rejects clock regression, polling gaps and new crash or ANR exits", () => {
  const clock = cloneEvidence();
  clock.backgroundSamples[1].deviceEpochMs = clock.backgroundSamples[0].deviceEpochMs - 1;
  assert.equal(evaluate(clock).continuity.clockMonotonic.status, "FAIL");

  const gap = cloneEvidence();
  gap.backgroundSamples.forEach((entry, index) => {
    entry.hostMonotonicMs += index === 0 ? 20_000 : 20_000;
  });
  const gapResult = evaluate(gap);
  assert.equal(gapResult.continuity.boundedPolling.status, "FAIL");
  for (const field of ["scan", "advertise", "gattClient"]) {
    assert.equal(gapResult.controls[field].status, "FAIL", field);
  }
  assert.equal(gapResult.controls.gattServer.status, "PASS");

  const exit = cloneEvidence();
  exit.exitFinal.commitments.add("new-private-exit-commitment");
  assert.equal(evaluate(exit).continuity.noCrashOrAnr.status, "FAIL");
});

test("primitive controls reject restart in their own runtime evidence stream", () => {
  const discoveryRestart = evidenceFixture();
  discoveryRestart.backgroundSamples[1].discovery.reporterStartedAtEpochMs += 1;
  const discoveryResult = evaluate(discoveryRestart);
  assert.equal(discoveryResult.controls.scan.status, "FAIL");
  assert.equal(discoveryResult.controls.advertise.status, "FAIL");

  const agentRestart = evidenceFixture();
  agentRestart.backgroundSamples[1].agent.reporterStartedAtEpochMs += 1;
  const agentResult = evaluate(agentRestart);
  assert.equal(agentResult.controls.scan.status, "FAIL");
  assert.equal(agentResult.controls.advertise.status, "FAIL");
  assert.equal(agentResult.controls.gattServer.status, "PASS");
  assert.equal(agentResult.continuity.stableReporters.status, "FAIL");

  const gattRestart = evidenceFixture();
  gattRestart.backgroundSamples[1].gatt.reporterStartedAtEpochMs += 1;
  assert.equal(evaluate(gattRestart).controls.gattClient.status, "FAIL");
});

test("capability parser rejects absent fields, unknown enums and malformed pending tests", () => {
  const valid = JSON.parse(JSON.stringify(capability()));
  delete valid.scan;
  throwsCode(() => parseCapabilityReport(JSON.stringify(valid)), "CAPABILITY_REPORT_INVALID");

  const unknown = JSON.parse(JSON.stringify(capability()));
  unknown.probeStatus = "UNKNOWN";
  throwsCode(() => parseCapabilityReport(JSON.stringify(unknown)), "CAPABILITY_REPORT_INVALID");

  const missingFieldTest = JSON.parse(JSON.stringify(capability()));
  missingFieldTest.pendingFieldTests.pop();
  throwsCode(
    () => parseCapabilityReport(JSON.stringify(missingFieldTest)),
    "CAPABILITY_REPORT_INVALID"
  );

  const contradictoryGatt = JSON.parse(JSON.stringify(capability()));
  contradictoryGatt.gattServer = false;
  throwsCode(
    () => parseCapabilityReport(JSON.stringify(contradictoryGatt)),
    "CAPABILITY_REPORT_INVALID"
  );
});

test("DevTools and Wi-Fi parsers reject ambiguous or exceptional responses", () => {
  const targets = parseDevtoolsTargets(
    JSON.stringify([
      {
        type: "page",
        webSocketDebuggerUrl: "ws://localhost:4567/devtools/page/1"
      }
    ]),
    4567
  );
  assert.equal(targets[0], "ws://127.0.0.1:4567/devtools/page/1");
  assert.equal(
    parseDevtoolsEvaluation(
      JSON.stringify({ id: 1, result: { result: { type: "string", value: "ok" } } })
    ),
    "ok"
  );
  throwsCode(
    () =>
      parseDevtoolsEvaluation(
        JSON.stringify({
          id: 1,
          result: {
            result: { type: "string", value: "not-accepted" },
            exceptionDetails: { text: "failure" }
          }
        })
      ),
    "DEVTOOLS_EVALUATION_INVALID"
  );
  throwsCode(
    () =>
      parseDevtoolsTargets(
        JSON.stringify([
          {
            type: "page",
            webSocketDebuggerUrl: "ws://192.0.2.5:4567/devtools/page/1"
          }
        ]),
        4567
      ),
    "DEVTOOLS_TARGETS_INVALID"
  );

  assert.deepEqual(
    parseWifiConnectivity(
      "Wifi is enabled\nSupplicant state: COMPLETED\n",
      ""
    ),
    { enabled: true, connected: true }
  );
  assert.deepEqual(parseWifiConnectivity("Wifi is disabled\n", ""), {
    enabled: false,
    connected: false
  });
});

test("Android 16 appId package state is parsed without weakening UID binding", () => {
  const android16Fixture = [
    `Package [${TARGET.packageId}] (redacted):`,
    "    appId=10354",
    "    pkg=Package{redacted com.sentrapa.palmare.advanced}",
    "    User 0: ceDataInode=1 deDataInode=2 installed=true hidden=false suspended=false stopped=false notLaunched=false enabled=0",
    "    User 0:"
  ].join("\n");
  assert.deepEqual(parseB0PackageState(android16Fixture, 0), {
    appUid: 10_354,
    stopped: false
  });

  const secondaryUserFixture = android16Fixture.replaceAll("User 0:", "User 10:");
  assert.deepEqual(parseB0PackageState(secondaryUserFixture, 10), {
    appUid: 1_010_354,
    stopped: false
  });

  const legacyFixture = android16Fixture.replace("appId=10354", "userId=10354");
  assert.deepEqual(parseB0PackageState(legacyFixture, 0), {
    appUid: 10_354,
    stopped: false
  });
});

test("package state rejects ambiguous IDs, missing user state and invalid app IDs", () => {
  const state = (idLines, userLine = "User 0: installed=true stopped=false") =>
    [`Package [${TARGET.packageId}] (redacted):`, ...idLines, userLine].join("\n");
  for (const fixture of [
    state([]),
    state(["appId=10354", "userId=10354"]),
    state(["appId=10354", "appId=10354"]),
    state(["appId=9999"]),
    state(["appId=10354"], "User 0: installed=true")
  ]) {
    throwsCode(() => parseB0PackageState(fixture, 0), "PACKAGE_STATE_INVALID");
  }
  assert.deepEqual(
    parseB0PackageState(
      state(["appId=10354"], "User 0: installed=true stopped=true"),
      0
    ),
    { appUid: 10_354, stopped: true }
  );
});

test("public report is allowlisted, redacted and permanently non-gate", () => {
  const privateEvidence = privateEvidenceFixture();
  const report = buildPublicReport(privateEvidence, "a".repeat(64));
  const encoded = JSON.stringify(report);
  assert.equal(report.evidenceClass, "SUPPLEMENTAL");
  assert.equal(report.gateImpact, "NON_GATE_EVIDENCE");
  assert.equal(report.formalGate, "PENDING_UNCHANGED");
  assert.equal(report.formalGatePromoted, false);
  assert.equal(encoded.includes(binding().serial), false);
  assert.equal(encoded.includes(SESSION_HMAC), false);
  assert.equal(encoded.includes("PRIVATE_PROVISIONING_IDENTITY_1"), false);
  assert.equal(assertPublicReportRedacted(report, [binding().serial, SESSION_HMAC]), true);
  throwsCode(
    () => assertPublicReportRedacted({ serial: binding().serial }),
    "PUBLIC_REPORT_PRIVACY_FAILURE"
  );
});

test("evidence publication uses mode 0600 and refuses overwrite or symlink parents", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v6-b0-output-"));
  fs.chmodSync(directory, 0o700);
  const privateOutput = path.join(directory, "private.json");
  const reportOutput = path.join(directory, "report.json");
  const privateEvidence = privateEvidenceFixture();
  try {
    const published = publishEvidencePair(
      privateOutput,
      reportOutput,
      privateEvidence
    );
    assert.match(published.privateDigest, /^[0-9a-f]{64}$/u);
    assert.equal(fs.lstatSync(privateOutput).mode & 0o777, 0o600);
    assert.equal(fs.lstatSync(reportOutput).mode & 0o777, 0o600);
    assert.equal(fs.lstatSync(privateOutput).nlink, 1);
    assert.equal(fs.lstatSync(reportOutput).nlink, 1);
    const exported = fs.readFileSync(reportOutput, "utf8");
    assert.equal(exported.includes(binding().serial), false);
    assert.equal(exported.includes(SESSION_HMAC), false);
    throwsCode(
      () => publishEvidencePair(privateOutput, reportOutput, privateEvidence),
      "OUTPUT_EXISTS"
    );

    const secure = path.join(directory, "secure");
    const linked = path.join(directory, "linked");
    fs.mkdirSync(secure, { mode: 0o700 });
    fs.symlinkSync(secure, linked);
    throwsCode(
      () =>
        publishEvidencePair(
          path.join(linked, "private.json"),
          path.join(directory, "report-2.json"),
          privateEvidence
        ),
      "OUTPUT_PATH_INVALID"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI and restore commands forbid destructive ADB operations", () => {
  assert.deepEqual(
    assertNonDestructiveAdbArgs(["shell", "input", "keyevent", "KEYCODE_HOME"]),
    ["shell", "input", "keyevent", "KEYCODE_HOME"]
  );
  for (const operation of ["force-stop", "clear", "uninstall", "kill", "kill-all"]) {
    throwsCode(
      () => assertNonDestructiveAdbArgs(["shell", "am", operation, TARGET.packageId]),
      "ADB_OPERATION_FORBIDDEN"
    );
  }
  for (const forbidden of [
    ["shell", "reboot"],
    ["shell", "sh", "-c", `pm clear ${TARGET.packageId}`],
    ["shell", "am", "stop-app", TARGET.packageId]
  ]) {
    throwsCode(
      () => assertNonDestructiveAdbArgs(forbidden),
      "ADB_OPERATION_FORBIDDEN"
    );
  }
  assert.equal(buildRestoreArgs(binding()).includes("force-stop"), false);
  assert.deepEqual(buildRestoreArgs(binding({ wasForeground: false })), [
    "shell",
    "input",
    "keyevent",
    "KEYCODE_HOME"
  ]);

  const options = parseArguments([
    "--adb",
    "/usr/bin/adb",
    "--primary-serial",
    "target-a",
    "--secondary-serial",
    "target-b",
    "--private-output",
    "/tmp/private.json",
    "--report-output",
    "/tmp/report.json"
  ]);
  assert.equal(options.mode, "PHYSICAL");
  throwsCode(
    () =>
      parseArguments([
        "--adb",
        "/usr/bin/adb",
        "--primary-serial",
        "same",
        "--secondary-serial",
        "same",
        "--private-output",
        "/tmp/private.json",
        "--report-output",
        "/tmp/report.json"
      ]),
    "INVALID_ARGUMENT"
  );
});

test("ADB allowlist covers every physical transcript and nothing generic", () => {
  const component = `${TARGET.packageId}/.MainActivity`;
  const apk = `/data/app/~~fixture==/${TARGET.packageId}-fixture==/base.apk`;
  const allowed = [
    ["devices", "-l"],
    ["shell", "am", "get-current-user"],
    ["shell", "getprop", "ro.build.version.sdk"],
    ["shell", "dumpsys", "package", TARGET.packageId],
    ["shell", "cmd", "package", "resolve-activity", "--brief", TARGET.packageId],
    ["shell", "pm", "path", TARGET.packageId],
    ["shell", "dumpsys", "activity", "activities"],
    ["shell", "pidof", "-s", TARGET.packageId],
    ["shell", "dumpsys", "activity", "-a", "services", TARGET.packageId],
    ["shell", "cmd", "wifi", "status"],
    ["shell", "dumpsys", "connectivity"],
    ["shell", "date", "+%s"],
    ["shell", "dumpsys", "activity", "exit-info", TARGET.packageId],
    ["shell", "input", "keyevent", "KEYCODE_HOME"],
    ["shell", "am", "start", "-W", "--user", "0", "-n", component],
    [
      "exec-out",
      "run-as",
      TARGET.packageId,
      "--user",
      "0",
      "cat",
      "no_backup/bluetooth-discovery-status-v1.json"
    ],
    ["exec-out", "sha256sum", apk],
    ["forward", "tcp:0", "localabstract:webview_devtools_remote_4321"],
    ["forward", "--remove", "tcp:4567"]
  ];
  for (const transcript of allowed) {
    assert.deepEqual(assertNonDestructiveAdbArgs(transcript), transcript);
  }
  throwsCode(
    () => assertNonDestructiveAdbArgs(["shell", "echo", "arbitrary"]),
    "ADB_OPERATION_FORBIDDEN"
  );
});

test("public failures preserve only safe machine codes", () => {
  assert.equal(
    buildPublicFailure({ code: "PACKAGE_STATE_INVALID", message: "private" })
      .failure.code,
    "PACKAGE_STATE_INVALID"
  );
  const unexpected = buildPublicFailure(new TypeError("private target detail"));
  assert.equal(unexpected.failure.code, "UNEXPECTED_FAILURE");
  assert.equal(JSON.stringify(unexpected).includes("private target detail"), false);
});

test("fixed capture schedule covers 30 seconds foreground and 90 seconds background", () => {
  const schedule = buildCaptureSchedule();
  assert.equal(B0_CAPTURE_DURATION_SECONDS, 120);
  assert.equal(schedule.foregroundOffsetsMs.length, 6);
  assert.equal(schedule.foregroundOffsetsMs.at(-1), 30_000);
  assert.equal(schedule.backgroundOffsetsMs.length, 19);
  assert.equal(schedule.backgroundOffsetsMs[0], 0);
  assert.equal(schedule.backgroundOffsetsMs.at(-1), 90_000);
});

test("offline modes never access ADB and preserve the formal gate", () => {
  const dry = buildDryRun();
  const self = runSelfTest();
  assert.equal(dry.physicalAdbAccessed, false);
  assert.equal(dry.formalGate, "PENDING_UNCHANGED");
  assert.equal(self.physicalAdbAccessed, false);
  assert.equal(self.formalGate, "PENDING_UNCHANGED");

  for (const mode of ["--dry-run", "--self-test"]) {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, mode], {
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.physicalAdbAccessed, false);
    assert.equal(output.formalGatePromoted, false);
  }
});
