import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ADVANCED_CERTIFICATION_TARGETS } from "./advanced-certification-targets.mjs";
import {
  b5AccountDeviceBindingFromPrivateBaseline,
  createB5AccountDeviceCommitmentSha256
} from "./b5-account-device-commitment.mjs";
import {
  B5_ANDROID_CONTINUITY_COUNTER_FIELDS,
  B5_ANDROID_CONTINUITY_MONITOR_VERSION,
  assertContinuitySample,
  atomicWritePrivateJson,
  androidMonitorPublicationJournalPath,
  buildAndroidMonitorSampleOffsets,
  buildAdbCommandArgs,
  buildB5AndroidContinuityAttestation,
  buildRunAsArgs,
  main,
  parseAndroidMonitorArguments,
  parseAndroidMonitorPublicationJournal,
  parseAgentReporter,
  parseAndroidApi,
  parseApplicationExitCommitments,
  parseAuthenticatedSessionPreferences,
  parseB5AndroidContinuityAttestation,
  parseGattReporter,
  parseMonitorConfig,
  parsePackageState,
  parsePid,
  parsePrivateBaseline,
  publishAndroidMonitorArtifacts,
  readPrivateJson,
  recoverAndroidMonitorArtifactPublication,
  runSelfTest,
  sessionBindingHmac,
  validB5AndroidContinuityAttestationFixture
} from "./run-b5-android-continuity-monitor.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./run-b5-android-continuity-monitor.mjs", import.meta.url)
);
const NOW_MS = Date.parse("2026-08-03T12:00:00.000Z");
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";
const TARGET = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const GATT_METRIC_FIELDS = [
  "connectionAttempts", "connectionsEstablished", "servicesValidated",
  "mtuNegotiated", "helloWritesStarted", "helloWritesCompleted",
  "helloReadsCompleted", "helloExchanged", "authSubscriptionsStarted",
  "authSubscriptionsCompleted", "clientProofWritesCompleted",
  "serverProofsVerified", "authFinishWritesCompleted", "authenticatedSessions",
  "keyExchangesStarted", "clientKeySharesWritten", "serverKeySharesVerified",
  "clientKeyConfirmsWritten", "keysEstablished", "activationPingsReceived",
  "activationPongsWritten", "activeSessions", "heartbeatPingsReceived",
  "heartbeatPongsWritten", "closeFramesReceived", "cleanCloses", "disconnects",
  "failures", "closes"
];

function throwsCode(action, code) {
  assert.throws(
    action,
    (error) => error?.code === code,
    `expected ${code}`
  );
}

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function writePrivateJson(location, value) {
  fs.writeFileSync(location, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
}

function monitorConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    product: "V6",
    phase: "B5",
    campaignId: CAMPAIGN_ID,
    expected: {
      versionName: TARGET.versionName,
      versionCode: TARGET.versionCode,
      androidUserId: 0,
      ...(overrides.expected ?? {})
    },
    measurement: {
      durationMs: 6_100_000,
      ...(overrides.measurement ?? {})
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([field]) => !["expected", "measurement"].includes(field)
      )
    )
  };
}

function gattReporter(overrides = {}) {
  const metrics = Object.fromEntries(GATT_METRIC_FIELDS.map((field) => [field, 0]));
  Object.assign(metrics, {
    connectionAttempts: 1,
    connectionsEstablished: 1,
    servicesValidated: 1,
    mtuNegotiated: 1,
    helloWritesStarted: 1,
    helloWritesCompleted: 1,
    helloReadsCompleted: 1,
    helloExchanged: 1,
    authSubscriptionsStarted: 1,
    authSubscriptionsCompleted: 1,
    clientProofWritesCompleted: 1,
    serverProofsVerified: 1,
    authFinishWritesCompleted: 1,
    authenticatedSessions: 1,
    keyExchangesStarted: 1,
    clientKeySharesWritten: 1,
    serverKeySharesVerified: 1,
    clientKeyConfirmsWritten: 1,
    keysEstablished: 1,
    activationPingsReceived: 1,
    activationPongsWritten: 1,
    activeSessions: 1,
    ...(overrides.metrics ?? {})
  });
  return {
    schemaVersion: 4,
    source: "V6_ANDROID_DIRECT_CONTROL_LAB",
    labBuild: true,
    diagnosticsEnabled: true,
    gattClientEnabled: true,
    sampleSequence: 10,
    sampledAtEpochMs: NOW_MS,
    reporterStartedAtEpochMs: NOW_MS - 60_000,
    state: "ACTIVE",
    profileValidated: true,
    negotiatedMtu: 517,
    lastFailure: "NONE",
    helloEnabled: true,
    helloExchanged: true,
    helloDeadlineActive: false,
    mutualAuthEnabled: true,
    mutuallyAuthenticated: true,
    authDeadlineActive: false,
    authenticatedSessionCount: 1,
    sessionKeyEnabled: true,
    keyEstablished: true,
    heartbeatEnabled: true,
    active: true,
    directControlDeadlineActive: false,
    metrics,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([field]) => field !== "metrics")
    )
  };
}

function agentReporter(overrides = {}) {
  const metrics = {
    startCount: 1,
    stopCount: 0,
    backoffCount: 0,
    transitionCount: 1,
    duplicateEventCount: 0,
    invalidTransitionCount: 0,
    ...(overrides.metrics ?? {})
  };
  const resources = {
    scannerActive: true,
    advertiserActive: true,
    gattServerActive: false,
    gattClientActive: true,
    sessionCount: 1,
    ...(overrides.resources ?? {})
  };
  return {
    schemaVersion: 1,
    source: "V6_ANDROID_CONNECTIVITY_AGENT",
    labBuild: true,
    diagnosticsEnabled: true,
    agentEnabled: true,
    sampleSequence: 20,
    sampledAtEpochMs: NOW_MS,
    reporterStartedAtEpochMs: NOW_MS - 120_000,
    state: "DISCOVERING",
    metrics,
    resources,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([field]) => !["metrics", "resources"].includes(field)
      )
    )
  };
}

function baselineFixture(overrides = {}) {
  const binding = {
    serial: "adb-fixed-target",
    role: "handheld",
    packageName: TARGET.packageId,
    versionName: TARGET.versionName,
    versionCode: TARGET.versionCode,
    androidApi: 36,
    androidUserId: 0,
    appUid: 10123,
    pid: 2345,
    gattReporterStartedAtEpochMs: NOW_MS - 60_000,
    agentReporterStartedAtEpochMs: NOW_MS - 120_000,
    sessionHmacKeyBase64: Buffer.alloc(32, 7).toString("base64"),
    sessionBindingHmacSha256: SHA_A,
    apkSha256: TARGET.sha256,
    ...(overrides.binding ?? {})
  };
  const reporters = {
    gattSampleSequence: 10,
    gattSampledAtEpochMs: NOW_MS,
    agentSampleSequence: 20,
    agentSampledAtEpochMs: NOW_MS,
    agentStartCount: 1,
    agentStopCount: 0,
    ...(overrides.reporters ?? {})
  };
  const exitInfo = {
    recordCommitmentsSha256: [],
    ...(overrides.exitInfo ?? {})
  };
  return {
    schemaVersion: 1,
    harnessVersion: B5_ANDROID_CONTINUITY_MONITOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: "PRIVATE_ANDROID_CONTINUITY_BASELINE",
    campaignId: CAMPAIGN_ID,
    createdAt: new Date(NOW_MS).toISOString(),
    binding,
    reporters,
    exitInfo,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([field]) => !["binding", "reporters", "exitInfo"].includes(field)
      )
    )
  };
}

function commitmentForBaseline(baseline = baselineFixture()) {
  return createB5AccountDeviceCommitmentSha256(
    b5AccountDeviceBindingFromPrivateBaseline(baseline)
  );
}

function continuitySample(overrides = {}) {
  const sample = {
    currentUser: 0,
    installedVersion: {
      versionName: TARGET.versionName,
      versionCode: TARGET.versionCode
    },
    appUid: 10123,
    pid: 2345,
    gatt: {
      reporterStartedAtEpochMs: NOW_MS - 60_000,
      sampleSequence: 11
    },
    agent: {
      reporterStartedAtEpochMs: NOW_MS - 120_000,
      sampleSequence: 21,
      metrics: { startCount: 1, stopCount: 0 }
    },
    sessionBindingHmacSha256: SHA_A,
    exitInfo: { commitments: new Set() }
  };
  return Object.assign(sample, structuredClone(overrides));
}

test("builds global device inventory and canonical run-as arguments", () => {
  assert.deepEqual(buildAdbCommandArgs(null, ["devices"]), ["devices"]);
  assert.deepEqual(
    buildAdbCommandArgs("adb-fixed-target", ["shell", "id"]),
    ["-s", "adb-fixed-target", "shell", "id"]
  );
  assert.deepEqual(
    buildRunAsArgs(TARGET.packageId, 10, "no_backup/status.json"),
    [
      "exec-out", "run-as", TARGET.packageId, "--user", "10",
      "cat", "no_backup/status.json"
    ]
  );
  throwsCode(
    () => buildRunAsArgs("invalid package", 0, "no_backup/status.json"),
    "ADB_ARGUMENT_INVALID"
  );
});

test("monitor config parser enforces its exact campaign contract", () => {
  const parsed = parseMonitorConfig(JSON.stringify(monitorConfig()));
  assert.equal(parsed.campaignId, CAMPAIGN_ID);
  assert.equal(parsed.measurement.durationMs, 6_100_000);
  for (const mutation of [
    { unexpected: true },
    { schemaVersion: 2 },
    { campaignId: "not-a-uuid" },
    { expected: { versionName: "1.0", versionCode: 37, androidUserId: 0 } },
    { measurement: { durationMs: 5_999_999 } },
    { measurement: { durationMs: 14_400_001 } }
  ]) {
    throwsCode(
      () => parseMonitorConfig({ ...monitorConfig(), ...mutation }),
      "CONFIG_INVALID"
    );
  }
});

test("authenticated session preferences are strict and HMAC-bound", () => {
  const xml = [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<map>",
    "<string name=\"notification_token\">tok&amp;en</string>",
    "<string name=\"notification_user_id\">42</string>",
    "<string name=\"notification_username\">Operator</string>",
    "<string name=\"notification_device_uuid\">device-private</string>",
    "<string name=\"notification_room_id\">7</string>",
    "</map>"
  ].join("");
  const session = parseAuthenticatedSessionPreferences(xml);
  assert.equal(session.token, "tok&en");
  const key = Buffer.alloc(32, 3);
  const first = sessionBindingHmac(session, key);
  const second = sessionBindingHmac(session, key);
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(first, second);
  assert.notEqual(
    sessionBindingHmac({ ...session, roomId: "8" }, key),
    first
  );
  throwsCode(() => sessionBindingHmac(session, Buffer.alloc(31)), "SESSION_BINDING_INVALID");
  for (const invalid of [
    "<map></map>",
    xml.replace("notification_token", "notification_missing"),
    xml.replace("</map>", "<string name=\"notification_token\">x</string></map>"),
    `<!DOCTYPE map>${xml}`,
    xml.replace("tok&amp;en", "tok&invalid")
  ]) {
    throwsCode(
      () => parseAuthenticatedSessionPreferences(invalid),
      invalid.includes("notification_missing") || invalid === "<map></map>"
        ? "SESSION_LOGGED_OUT"
        : "SESSION_CONTEXT_INVALID"
    );
  }
});

test("GATT reporter parser validates headers, state types and every metric", () => {
  const parsed = parseGattReporter(JSON.stringify(gattReporter()), NOW_MS);
  assert.equal(parsed.state, "ACTIVE");
  assert.equal(parsed.metrics.failures, 0);
  const invalidCases = [
    [gattReporter({ sampledAtEpochMs: NOW_MS - 5_001 }), "REPORTER_STALE"],
    [gattReporter({ sampledAtEpochMs: NOW_MS + 5_001 }), "REPORTER_STALE"],
    [gattReporter({ state: "NOT_A_GATT_STATE" }), "GATT_REPORTER_INVALID"],
    [gattReporter({ profileValidated: "true" }), "GATT_REPORTER_INVALID"],
    [gattReporter({ negotiatedMtu: -1 }), "GATT_REPORTER_INVALID"],
    [gattReporter({ active: 1 }), "GATT_REPORTER_INVALID"],
    [gattReporter({ authenticatedSessionCount: -1 }), "GATT_REPORTER_INVALID"],
    [gattReporter({ metrics: { failures: 1 } }), "GATT_FAILURE_REPORTED"],
    [{ ...gattReporter(), injected: true }, "GATT_REPORTER_INVALID"]
  ];
  for (const [fixture, code] of invalidCases) {
    throwsCode(() => parseGattReporter(JSON.stringify(fixture), NOW_MS), code);
  }
});

test("agent reporter parser rejects stopped, stale and malformed reporters", () => {
  assert.equal(
    parseAgentReporter(JSON.stringify(agentReporter()), NOW_MS).state,
    "DISCOVERING"
  );
  for (const [fixture, code] of [
    [agentReporter({ state: "STOPPED" }), "AGENT_NOT_RUNNING"],
    [agentReporter({ state: 7 }), "AGENT_REPORTER_INVALID"],
    [agentReporter({ state: "UNKNOWN" }), "AGENT_REPORTER_INVALID"],
    [agentReporter({ sampledAtEpochMs: NOW_MS - 5_001 }), "REPORTER_STALE"],
    [agentReporter({ metrics: { invalidTransitionCount: 1 } }), "AGENT_REPORTER_INVALID"],
    [agentReporter({ resources: { scannerActive: "yes" } }), "AGENT_REPORTER_INVALID"],
    [{ ...agentReporter(), injected: true }, "AGENT_REPORTER_INVALID"]
  ]) {
    throwsCode(() => parseAgentReporter(JSON.stringify(fixture), NOW_MS), code);
  }
});

test("package, PID and Android API parsers fail closed", () => {
  const packageDump = [
    "Package [com.example.app]",
    "  userId=10123",
    "  User 0: installed=true hidden=false stopped=false enabled=0"
  ].join("\n");
  assert.deepEqual(parsePackageState(packageDump, 0), {
    appUid: 10123,
    stopped: false
  });
  assert.equal(parsePackageState(packageDump.replace("stopped=false", "stopped=true"), 0).stopped, true);
  throwsCode(() => parsePackageState(packageDump.replace("userId=10123", ""), 0), "PACKAGE_STATE_INVALID");
  throwsCode(() => parsePackageState(packageDump, -1), "PACKAGE_STATE_INVALID");
  assert.equal(parsePid("2345\n"), 2345);
  throwsCode(() => parsePid("0"), "PROCESS_MISSING");
  throwsCode(() => parsePid("2345 2346"), "PROCESS_MISSING");
  assert.equal(parseAndroidApi("36\n"), 36);
  throwsCode(() => parseAndroidApi("32"), "ANDROID_API_INVALID");
});

test("ApplicationExitInfo parser commits only fatal records for the fixed target", () => {
  const raw = [
    "ACTIVITY MANAGER PROCESS EXIT INFO (dumpsys activity exit-info)",
    "ApplicationExitInfo #0:",
    `  timestamp=1 user=0 process=${TARGET.packageId} reason=4 status=0`,
    "ApplicationExitInfo #1:",
    `  timestamp=2 user=0 process=${TARGET.packageId} reason=6 status=0`,
    "ApplicationExitInfo #2:",
    `  timestamp=3 user=0 process=${TARGET.packageId} reason=1 status=0`,
    "ApplicationExitInfo #3:",
    "  timestamp=4 user=10 process=other.package reason=5 status=0"
  ].join("\n");
  const parsed = parseApplicationExitCommitments(raw, 0, TARGET.packageId);
  assert.equal(parsed.commitments.size, 2);
  assert.deepEqual(parsed.counts, {
    crashes: 1,
    nativeCrashes: 0,
    anrs: 1,
    userRequestedStops: 0
  });
  throwsCode(
    () => parseApplicationExitCommitments("invalid", 0, TARGET.packageId),
    "EXIT_INFO_INVALID"
  );
  throwsCode(
    () => parseApplicationExitCommitments(
      `${raw}\nApplicationExitInfo #4:\n  user=0 reason=4`,
      0,
      TARGET.packageId
    ),
    "EXIT_INFO_INVALID"
  );
});

test("private baseline parser binds the exact certified target and secret key", () => {
  const parsed = parsePrivateBaseline(JSON.stringify(baselineFixture()));
  assert.equal(parsed.baseline.binding.packageName, TARGET.packageId);
  assert.equal(parsed.sessionKey.byteLength, 32);
  const cases = [
    [{ unexpected: true }, "BASELINE_INVALID"],
    [{ binding: { ...baselineFixture().binding, versionName: "9.9.9" } }, "BASELINE_INVALID"],
    [{ binding: { ...baselineFixture().binding, apkSha256: SHA_A } }, "BASELINE_INVALID"],
    [{ binding: { ...baselineFixture().binding, sessionHmacKeyBase64: "bad" } }, "BASELINE_INVALID"],
    [{ binding: { ...baselineFixture().binding, sessionBindingHmacSha256: "0".repeat(64) } }, "BASELINE_INVALID"],
    [{ exitInfo: { recordCommitmentsSha256: [SHA_A, SHA_A] } }, "BASELINE_INVALID"],
    [{ exitInfo: { recordCommitmentsSha256: ["0".repeat(64)] } }, "BASELINE_INVALID"],
    [{ reporters: { ...baselineFixture().reporters, gattSampleSequence: 0 } }, "BASELINE_INVALID"]
  ];
  for (const [override, code] of cases) {
    throwsCode(() => parsePrivateBaseline(baselineFixture(override)), code);
  }
});

test("continuity accepts monotonic samples and rejects every binding change", () => {
  const { baseline } = parsePrivateBaseline(baselineFixture());
  const previous = {
    gattSampleSequence: baseline.reporters.gattSampleSequence,
    agentSampleSequence: baseline.reporters.agentSampleSequence
  };
  assert.deepEqual(
    assertContinuitySample(baseline, previous, continuitySample()),
    { gattSampleSequence: 11, agentSampleSequence: 21 }
  );
  const violations = [
    [{ currentUser: 10 }, "ANDROID_USER_CHANGED"],
    [{ installedVersion: { versionName: "9.9.9", versionCode: TARGET.versionCode } }, "PACKAGE_VERSION_CHANGED"],
    [{ installedVersion: { versionName: TARGET.versionName, versionCode: 999 } }, "PACKAGE_VERSION_CHANGED"],
    [{ appUid: 999 }, "PACKAGE_UID_CHANGED"],
    [{ pid: 999 }, "PROCESS_RESTARTED"],
    [{ gatt: { reporterStartedAtEpochMs: 1, sampleSequence: 11 } }, "REPORTER_RESTARTED"],
    [{ agent: { reporterStartedAtEpochMs: 1, sampleSequence: 21 } }, "REPORTER_RESTARTED"],
    [{ agent: { reporterStartedAtEpochMs: NOW_MS - 120_000, sampleSequence: 21, metrics: { startCount: 2, stopCount: 0 } } }, "AGENT_LIFECYCLE_CHANGED"],
    [{ agent: { reporterStartedAtEpochMs: NOW_MS - 120_000, sampleSequence: 21, metrics: { startCount: 1, stopCount: 1 } } }, "AGENT_LIFECYCLE_CHANGED"],
    [{ sessionBindingHmacSha256: SHA_B }, "SESSION_BINDING_CHANGED"],
    [{ gatt: { reporterStartedAtEpochMs: NOW_MS - 60_000, sampleSequence: 9 } }, "REPORTER_SEQUENCE_REGRESSION"],
    [{ exitInfo: { commitments: new Set([SHA_B]) } }, "NEW_ANDROID_EXIT"]
  ];
  for (const [override, code] of violations) {
    throwsCode(
      () => assertContinuitySample(baseline, previous, continuitySample(override)),
      code
    );
  }
});

test("private JSON publication is 0600, atomic and never overwrites", () => {
  const directory = temporaryDirectory("v6-b5-monitor-private-");
  try {
    const output = path.join(directory, "private.json");
    atomicWritePrivateJson(output, { schemaVersion: 1, value: "private" });
    const stat = fs.lstatSync(output);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
    assert.deepEqual(readPrivateJson(output), { schemaVersion: 1, value: "private" });
    const before = fs.readFileSync(output);
    const inode = stat.ino;
    throwsCode(
      () => atomicWritePrivateJson(output, { schemaVersion: 2 }),
      "PRIVATE_OUTPUT_EXISTS"
    );
    assert.deepEqual(fs.readFileSync(output), before);
    assert.equal(fs.statSync(output).ino, inode);
    assert.deepEqual(
      fs.readdirSync(directory).sort(),
      ["private.json"]
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("private JSON rejects permissive modes, hard links and every symlink", () => {
  const directory = temporaryDirectory("v6-b5-monitor-private-invalid-");
  try {
    const permissive = path.join(directory, "permissive.json");
    writePrivateJson(permissive, { value: 1 });
    fs.chmodSync(permissive, 0o640);
    throwsCode(() => readPrivateJson(permissive), "PRIVATE_FILE_INVALID");

    const original = path.join(directory, "original.json");
    const hardLink = path.join(directory, "hard-link.json");
    writePrivateJson(original, { value: 2 });
    fs.linkSync(original, hardLink);
    throwsCode(() => readPrivateJson(original), "PRIVATE_FILE_INVALID");
    throwsCode(() => readPrivateJson(hardLink), "PRIVATE_FILE_INVALID");

    const symlink = path.join(directory, "link.json");
    fs.symlinkSync(permissive, symlink);
    throwsCode(() => readPrivateJson(symlink), "PRIVATE_FILE_INVALID");
    const broken = path.join(directory, "broken.json");
    fs.symlinkSync(path.join(directory, "missing.json"), broken);
    throwsCode(() => readPrivateJson(broken), "PRIVATE_FILE_INVALID");
    throwsCode(
      () => atomicWritePrivateJson(broken, { value: 3 }),
      "PRIVATE_FILE_INVALID"
    );

    const realParent = path.join(directory, "real-parent");
    const linkedParent = path.join(directory, "linked-parent");
    fs.mkdirSync(realParent, { mode: 0o700 });
    fs.symlinkSync(realParent, linkedParent);
    throwsCode(
      () => atomicWritePrivateJson(path.join(linkedParent, "output.json"), { value: 4 }),
      "PRIVATE_FILE_INVALID"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Android sample scheduling covers a non-divisible duration exactly", () => {
  const offsets = buildAndroidMonitorSampleOffsets(6_000_001, 5_000);
  assert.equal(offsets.length, Math.ceil(6_000_001 / 5_000) + 1);
  assert.equal(offsets[0], 0);
  assert.equal(offsets.at(-2), 6_000_000);
  assert.equal(offsets.at(-1), 6_000_001);
  assert.equal(offsets.every((offset) => offset <= 6_000_001), true);

  const fixture = validB5AndroidContinuityAttestationFixture({
    requiredDurationMs: 6_000_001,
    pollIntervalMs: 5_000
  });
  assert.equal(fixture.observed.scheduledSamples, offsets.length);
  parseB5AndroidContinuityAttestation(fixture);
});

test("Android CLI rejects aliased private artifact paths", () => {
  throwsCode(
    () =>
      parseAndroidMonitorArguments([
        "--monitor",
        "--adb",
        "/bin/true",
        "--serial",
        "private-device",
        "--package",
        TARGET.packageId,
        "--role",
        "handheld",
        "--config",
        "/private/config.json",
        "--baseline",
        "/private/baseline.json",
        "--private-output",
        "/private/output.json",
        "--attestation",
        "/private/output.json"
      ]),
    "INVALID_ARGUMENT"
  );
});

test("Android paired publication recovers failures and protects its exact journal", () => {
  const directory = temporaryDirectory("v6-b5-monitor-publication-");
  try {
    const privateOutput = path.join(directory, "private-result.json");
    const attestationOutput = path.join(directory, "attestation.json");
    const options = {
      privateOutput,
      attestation: attestationOutput,
      campaignId: CAMPAIGN_ID
    };
    const attestationDocument = validB5AndroidContinuityAttestationFixture({
      campaignId: CAMPAIGN_ID
    });
    const privateDocument = {
      schemaVersion: 1,
      harnessVersion: B5_ANDROID_CONTINUITY_MONITOR_VERSION,
      product: "V6",
      phase: "B5",
      mode: "PRIVATE_ANDROID_CONTINUITY_RESULT",
      verdict: "PASS",
      campaignId: CAMPAIGN_ID,
      attestationSha256: crypto
        .createHash("sha256")
        .update(`${JSON.stringify(attestationDocument)}\n`)
        .digest("hex")
    };

    assert.throws(
      () =>
        publishAndroidMonitorArtifacts(
          options,
          privateDocument,
          attestationDocument,
          { afterPrivatePublished: () => { throw new Error("simulated interruption"); } }
        ),
      /simulated interruption/u
    );
    const journalPath = androidMonitorPublicationJournalPath(privateOutput);
    assert.equal(fs.existsSync(privateOutput), true);
    assert.equal(fs.existsSync(attestationOutput), false);
    assert.equal(fs.statSync(privateOutput).mode & 0o777, 0o600);
    assert.equal(fs.statSync(journalPath).mode & 0o777, 0o600);
    const journal = readPrivateJson(journalPath, "publication journal");
    assert.deepEqual(Object.keys(journal).sort(), [
      "attestationDocument",
      "attestationOutput",
      "attestationSha256",
      "campaignId",
      "mode",
      "monitor",
      "phase",
      "privateDocument",
      "privateOutput",
      "privateSha256",
      "product",
      "schemaVersion",
      "transactionId"
    ]);
    parseAndroidMonitorPublicationJournal(journal, options);
    throwsCode(
      () =>
        parseAndroidMonitorPublicationJournal(
          { ...journal, unexpected: true },
          options
        ),
      "PUBLICATION_JOURNAL_INVALID"
    );

    const hardLink = path.join(directory, "journal-hard-link.json");
    fs.linkSync(journalPath, hardLink);
    throwsCode(
      () => recoverAndroidMonitorArtifactPublication(options),
      "PRIVATE_FILE_INVALID"
    );
    fs.unlinkSync(hardLink);

    fs.writeFileSync(privateOutput, `${JSON.stringify({ tampered: true })}\n`);
    throwsCode(
      () => recoverAndroidMonitorArtifactPublication(options),
      "PUBLICATION_CONFLICT"
    );
    fs.writeFileSync(
      privateOutput,
      `${JSON.stringify(privateDocument, null, 2)}\n`
    );

    assert.deepEqual(
      recoverAndroidMonitorArtifactPublication(options),
      attestationDocument
    );
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.statSync(attestationOutput).mode & 0o777, 0o600);
    throwsCode(
      () =>
        publishAndroidMonitorArtifacts(
          options,
          privateDocument,
          attestationDocument
        ),
      "PRIVATE_OUTPUT_EXISTS"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Android paired publication recovers after both commits before journal cleanup", () => {
  const directory = temporaryDirectory("v6-b5-monitor-post-commit-");
  try {
    const options = {
      privateOutput: path.join(directory, "private-result.json"),
      attestation: path.join(directory, "attestation.json"),
      campaignId: CAMPAIGN_ID
    };
    const attestationDocument = validB5AndroidContinuityAttestationFixture();
    const privateDocument = {
      schemaVersion: 1,
      harnessVersion: B5_ANDROID_CONTINUITY_MONITOR_VERSION,
      product: "V6",
      phase: "B5",
      mode: "PRIVATE_ANDROID_CONTINUITY_RESULT",
      verdict: "PASS",
      campaignId: CAMPAIGN_ID,
      attestationSha256: crypto
        .createHash("sha256")
        .update(`${JSON.stringify(attestationDocument)}\n`)
        .digest("hex")
    };
    assert.throws(
      () =>
        publishAndroidMonitorArtifacts(
          options,
          privateDocument,
          attestationDocument,
          { afterAttestationPublished: () => { throw new Error("post-commit"); } }
        ),
      /post-commit/u
    );
    assert.equal(fs.existsSync(options.privateOutput), true);
    assert.equal(fs.existsSync(options.attestation), true);
    assert.equal(
      fs.existsSync(androidMonitorPublicationJournalPath(options.privateOutput)),
      true
    );
    recoverAndroidMonitorArtifactPublication(options);
    assert.equal(
      fs.existsSync(androidMonitorPublicationJournalPath(options.privateOutput)),
      false
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("attestation fixture is complete, redacted and campaign-committed", () => {
  const fixture = validB5AndroidContinuityAttestationFixture();
  const parsed = parseB5AndroidContinuityAttestation(JSON.stringify(fixture));
  assert.equal(parsed.report.verdict, "PASS");
  assert.equal(parsed.accountDeviceBound, true);
  assert.match(parsed.campaignIdCommitmentSha256, /^[0-9a-f]{64}$/u);
  assert.match(parsed.accountDeviceCommitmentSha256, /^[0-9a-f]{64}$/u);
  assert.equal(fixture.privacy.accountDeviceCommitmentIncluded, true);
  const encoded = JSON.stringify(fixture);
  assert.equal(encoded.includes(CAMPAIGN_ID), false);
  assert.equal(
    /"(?:serial|deviceSerial|pid|androidUserId|appUid|sessionBindingHmacSha256|token|account|nodeId)"/iu.test(encoded),
    false
  );
  assert.equal(
    B5_ANDROID_CONTINUITY_COUNTER_FIELDS.every(
      (field) => fixture.observed[field] === 0
    ),
    true
  );
});

test("attestation builder defensively clones observations", () => {
  const requiredDurationMs = 6_100_000;
  const pollIntervalMs = 5_000;
  const scheduledSamples = Math.ceil(requiredDurationMs / pollIntervalMs) + 1;
  const observed = {
    scheduledSamples,
    completedSamples: scheduledSamples,
    maximumPollGapMs: pollIntervalMs,
    ...Object.fromEntries(B5_ANDROID_CONTINUITY_COUNTER_FIELDS.map((field) => [field, 0]))
  };
  const monitoredFrom = "2026-08-03T00:00:00.000Z";
  const monitoredUntil = new Date(Date.parse(monitoredFrom) + requiredDurationMs).toISOString();
  const report = buildB5AndroidContinuityAttestation({
    campaignId: CAMPAIGN_ID,
    accountDeviceCommitmentSha256: commitmentForBaseline(),
    monitoredFrom,
    monitoredUntil,
    requiredDurationMs,
    pollIntervalMs,
    role: "handheld",
    packageName: TARGET.packageId,
    versionName: TARGET.versionName,
    versionCode: TARGET.versionCode,
    androidApi: 36,
    observed
  });
  observed.anrs = 1;
  assert.equal(report.observed.anrs, 0);
});

test("attestation parser rejects structural, timeline, counter and privacy mutations", () => {
  const fixture = validB5AndroidContinuityAttestationFixture();
  const mutations = [
    [(value) => { value.injected = true; }, "ATTESTATION_INVALID"],
    [(value) => { delete value.accountDeviceCommitmentSha256; }, "ATTESTATION_INVALID"],
    [(value) => { value.accountDeviceCommitmentSha256 = "0".repeat(64); }, "ATTESTATION_INVALID"],
    [(value) => { value.campaign.campaignIdCommitmentSha256 = "0".repeat(64); }, "ATTESTATION_INVALID"],
    [(value) => { value.campaign.durationMs += 1; }, "ATTESTATION_INVALID"],
    [(value) => { value.generatedAt = value.campaign.monitoredFrom; }, "ATTESTATION_INVALID"],
    [(value) => { value.target.versionCode += 1; }, "ATTESTATION_INVALID"],
    [(value) => { value.checks.fixedProcess = "FAIL"; }, "ATTESTATION_INVALID"],
    [(value) => { value.observed.completedSamples -= 1; }, "ATTESTATION_INVALID"],
    [(value) => { value.observed.maximumPollGapMs = 0; }, "ATTESTATION_INVALID"],
    [(value) => { value.observed.maximumPollGapMs = 20_000; }, "ATTESTATION_INVALID"],
    [(value) => { value.observed.anrs = 1; }, "ATTESTATION_INVALID"],
    [(value) => { value.privacy.serialIncluded = true; }, "ATTESTATION_PRIVACY_INVALID"],
    [(value) => { value.privacy.accountDeviceCommitmentIncluded = false; }, "ATTESTATION_PRIVACY_INVALID"]
  ];
  for (const [mutate, code] of mutations) {
    const candidate = structuredClone(fixture);
    mutate(candidate);
    throwsCode(() => parseB5AndroidContinuityAttestation(candidate), code);
  }
});

test("historical attestation remains readable but explicitly unbound", () => {
  const historical = structuredClone(
    validB5AndroidContinuityAttestationFixture()
  );
  historical.harnessVersion = "1.0.0";
  delete historical.accountDeviceCommitmentSha256;
  delete historical.privacy.accountDeviceCommitmentIncluded;

  const parsed = parseB5AndroidContinuityAttestation(historical);
  assert.equal(parsed.accountDeviceBound, false);
  assert.equal(parsed.accountDeviceCommitmentSha256, null);
});

test("different private baselines produce different redacted attestations", () => {
  const firstBaseline = baselineFixture();
  const secondBaseline = baselineFixture({
    binding: {
      ...baselineFixture().binding,
      sessionBindingHmacSha256: SHA_B
    }
  });
  const first = validB5AndroidContinuityAttestationFixture({
    accountDeviceCommitmentSha256: commitmentForBaseline(firstBaseline)
  });
  const second = validB5AndroidContinuityAttestationFixture({
    accountDeviceCommitmentSha256: commitmentForBaseline(secondBaseline)
  });

  assert.notEqual(
    first.accountDeviceCommitmentSha256,
    second.accountDeviceCommitmentSha256
  );
  assert.notEqual(
    crypto.createHash("sha256").update(JSON.stringify(first)).digest("hex"),
    crypto.createHash("sha256").update(JSON.stringify(second)).digest("hex")
  );
});

test("self-test is offline, pending and filesystem-neutral", () => {
  const directory = temporaryDirectory("v6-b5-monitor-self-test-");
  try {
    const child = spawnSync(process.execPath, [SCRIPT_PATH, "--self-test"], {
      cwd: directory,
      encoding: "utf8"
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const report = JSON.parse(child.stdout);
    assert.deepEqual(report, runSelfTest());
    assert.equal(report.physicalAdbAccessed, false);
    assert.equal(report.gate.b5HundredSessionGate, "PENDING");
    assert.equal(report.gate.b6, "PENDING");
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("module import has no CLI or filesystem side effects", () => {
  const directory = temporaryDirectory("v6-b5-monitor-import-");
  try {
    const moduleUrl = pathToFileURL(SCRIPT_PATH).href;
    const entrypoint = path.join(directory, "import-monitor.mjs");
    fs.writeFileSync(
      entrypoint,
      `await import(${JSON.stringify(moduleUrl)}); process.stdout.write("IMPORTED");\n`,
      { mode: 0o600 }
    );
    const before = fs.readdirSync(directory);
    const child = spawnSync(process.execPath, [entrypoint], {
      cwd: directory,
      encoding: "utf8"
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "IMPORTED");
    assert.equal(child.stderr, "");
    assert.deepEqual(fs.readdirSync(directory), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI failures remain generic and redact the fixed serial", async () => {
  const serial = "private-adb-serial";
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    const exitCode = await main([
      "--capture-baseline", "--adb", "/bin/true", "--serial", serial
    ]);
    assert.equal(exitCode, 2);
  } finally {
    process.stdout.write = originalWrite;
  }
  const report = JSON.parse(writes.join(""));
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.failure.message, "Android continuity monitoring failed");
  assert.equal(JSON.stringify(report).includes(serial), false);
});
