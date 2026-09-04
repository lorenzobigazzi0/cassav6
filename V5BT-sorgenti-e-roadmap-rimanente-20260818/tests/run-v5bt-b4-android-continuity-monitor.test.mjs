import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  B4AndroidContinuityError,
  assertB4AndroidContinuity,
  buildPackageUidQueryArgs,
  buildB4RunCommitments,
  buildB4AndroidContinuityAttestation,
  parseB4AndroidContinuityAttestation,
  parseB4AndroidMonitorArguments,
  parsePackageStoppedState,
  parsePackageUidListing,
  publishPrivateJson,
  normalizeB4AndroidMonitorError,
  runB4AndroidContinuityMonitor,
  validateDiscoveryReporter,
} from "../scripts/run-v5bt-b4-android-continuity-monitor.mjs";
import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING,
} from "../ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/scripts/advanced-certification-targets.mjs";
import {
  B5AndroidContinuityError,
} from "../ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/scripts/run-b5-android-continuity-monitor.mjs";

const COLLECTION_RUN_ID = "00000000-0000-4000-8000-000000000001";
const CAPTURE_RUN_ID = "00000000-0000-4000-8000-000000000002";
const MATRIX_SHA256 = ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256;
const TARGET = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;

function fixtureAttestation(overrides = {}) {
  return buildB4AndroidContinuityAttestation({
    collectionRunId: COLLECTION_RUN_ID,
    captureRunId: CAPTURE_RUN_ID,
    certificationMatrixSha256: MATRIX_SHA256,
    privateJournalSha256: "a".repeat(64),
    targetHardwareCommitmentSha256: "d".repeat(64),
    androidApi: 36,
    monitoredFrom: "2026-08-05T00:00:00.000Z",
    monitoredUntil: "2026-08-05T00:01:30.000Z",
    durationMs: 90_000,
    pollMs: 2_000,
    sampleCount: 46,
    maximumObservedGapMs: 2_100,
    generatedAt: "2026-08-05T00:01:30.000Z",
    ...overrides,
  });
}

function fixtureSample(sequence = 10) {
  return {
    sampledAt: new Date(1_786_000_000_000 + sequence * 2_000).toISOString(),
    androidApi: 36,
    currentUser: 0,
    installedVersion: {
      versionName: TARGET.versionName,
      versionCode: TARGET.versionCode,
    },
    appUid: 10_001,
    pid: 4_321,
    discovery: {
      reporterStartedAtEpochMs: 1_785_999_000_000,
      sampleSequence: sequence,
      sampledAtEpochMs: 1_786_000_000_000 + sequence * 2_000,
    },
    sessionBindingHmacSha256: "b".repeat(64),
    exitInfo: { commitments: new Set(["c".repeat(64)]) },
    stableHardwareSerial: "TESTHARDWARE01",
    apkSha256: TARGET.sha256,
  };
}

function fixtureBaseline(sample = fixtureSample()) {
  return {
    androidApi: sample.androidApi,
    currentUser: sample.currentUser,
    appUid: sample.appUid,
    pid: sample.pid,
    versionName: sample.installedVersion.versionName,
    versionCode: sample.installedVersion.versionCode,
    apkSha256: sample.apkSha256,
    discoveryReporterStartedAtEpochMs:
      sample.discovery.reporterStartedAtEpochMs,
    discoverySampleSequence: sample.discovery.sampleSequence,
    sessionBindingHmacSha256: sample.sessionBindingHmacSha256,
    exitInfoCommitments: new Set(sample.exitInfo.commitments),
    stableHardwareSerial: sample.stableHardwareSerial,
  };
}

function expectCode(action, code) {
  assert.throws(
    action,
    (error) => error instanceof B4AndroidContinuityError && error.code === code,
  );
}

test("run commitments are domain-separated and reject identifier reuse", () => {
  const commitments = buildB4RunCommitments({
    collectionRunId: COLLECTION_RUN_ID,
    captureRunId: CAPTURE_RUN_ID,
  });
  assert.match(commitments.collectionRunCommitmentSha256, /^[0-9a-f]{64}$/u);
  assert.match(commitments.captureRunCommitmentSha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(
    commitments.collectionRunCommitmentSha256,
    commitments.captureRunCommitmentSha256,
  );
  expectCode(
    () =>
      buildB4RunCommitments({
        collectionRunId: COLLECTION_RUN_ID,
        captureRunId: COLLECTION_RUN_ID,
      }),
    "RUN_BINDING_INVALID",
  );
});

test("Android 16 package UID and stopped state use exact read-only sources", () => {
  assert.deepEqual(buildPackageUidQueryArgs(0, TARGET.packageId), [
    "shell",
    "cmd",
    "package",
    "list",
    "packages",
    "-U",
    "--user",
    "0",
    TARGET.packageId,
  ]);
  assert.equal(
    parsePackageUidListing(
      `package:${TARGET.packageId} uid:10044\n`,
      TARGET.packageId,
    ),
    10_044,
  );
  const android16Dumpsys = [
    "Packages:",
    `  Package [${TARGET.packageId}] (123abc):`,
    "    pkg=Package{123abc com.sentrapa.palmare.advanced}",
    "    User 0: ceDataInode=25769 deDataInode=15486 installed=true hidden=false suspended=false distractionFlags=0 stopped=false notLaunched=false enabled=0 instant=false virtual=false quarantined=false",
    "    User 0:",
  ].join("\n");
  assert.equal(parsePackageStoppedState(android16Dumpsys, 0), false);
  assert.equal(
    parsePackageStoppedState(
      android16Dumpsys.replace("stopped=false", "stopped=true"),
      0,
    ),
    true,
  );
  assert.doesNotMatch(android16Dumpsys, /\buserId=/u);
});

test("package UID parser rejects ambiguity, mismatch and non-UID fields", () => {
  for (const raw of [
    "",
    `package:${TARGET.packageId} uid:10044\npackage:${TARGET.packageId}.debug uid:10045\n`,
    `package:${TARGET.packageId}.debug uid:10044\n`,
    `package:${TARGET.packageId} appId:10044\n`,
    `package:${TARGET.packageId} uid:9999\n`,
    `package:${TARGET.packageId} uid:10044 extra=true\n`,
  ]) {
    expectCode(
      () => parsePackageUidListing(raw, TARGET.packageId),
      "PACKAGE_UID_INVALID",
    );
  }
});

test("stopped parser rejects missing, ambiguous or wrong-user state rows", () => {
  for (const raw of [
    "Packages:\n    appId=10044\n",
    "    User 10: installed=true stopped=false enabled=0\n",
    "    User 0: installed=true enabled=0\n",
    "    User 0: installed=true stopped=unknown enabled=0\n",
    "    User 0: installed=true stopped=false stopped=false enabled=0\n",
    "    User 0: installed=true stopped=false enabled=0\n    User 0: installed=true stopped=false enabled=0\n",
  ]) {
    expectCode(
      () => parsePackageStoppedState(raw, 0),
      "PACKAGE_USER_STATE_INVALID",
    );
  }
});

test("builds and parses a redacted certified B4 Android attestation", () => {
  const report = fixtureAttestation();
  const parsed = parseB4AndroidContinuityAttestation(
    `${JSON.stringify(report)}\n`,
    {
      collectionRunId: COLLECTION_RUN_ID,
      captureRunId: CAPTURE_RUN_ID,
      certificationMatrixSha256: MATRIX_SHA256,
    },
  );
  assert.equal(parsed.verdict, "PASS");
  assert.equal(parsed.target.packageName, TARGET.packageId);
  const encoded = JSON.stringify(parsed);
  assert.doesNotMatch(encoded, new RegExp(COLLECTION_RUN_ID, "u"));
  assert.doesNotMatch(encoded, new RegExp(CAPTURE_RUN_ID, "u"));
  assert.doesNotMatch(encoded, /"(?:serial|pid|token)"\s*:/iu);
});

test("attestation parser rejects tampering, privacy drift and coverage drift", () => {
  const report = fixtureAttestation();
  for (const mutate of [
    (value) => {
      value.binding.certificationMatrixSha256 = "f".repeat(64);
    },
    (value) => {
      value.target.versionCode += 1;
    },
    (value) => {
      value.privacy.serialIncluded = true;
    },
    (value) => {
      value.coverage.durationMs -= 1;
    },
    (value) => {
      value.checks.fixedProcess = "FAIL";
    },
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    expectCode(
      () => parseB4AndroidContinuityAttestation(changed),
      "ATTESTATION_INVALID",
    );
  }
});

test("continuity accepts a progressive sample", () => {
  const first = fixtureSample(10);
  const next = fixtureSample(11);
  const result = assertB4AndroidContinuity(
    fixtureBaseline(first),
    {
      discoverySampleSequence: first.discovery.sampleSequence,
      discoverySampledAtEpochMs: first.discovery.sampledAtEpochMs,
    },
    next,
  );
  assert.equal(result.discoverySampleSequence, 11);
});

test("continuity accepts one fresh duplicate reporter sample followed by progress", () => {
  const first = fixtureSample(10);
  const baseline = fixtureBaseline(first);
  const duplicate = assertB4AndroidContinuity(
    baseline,
    {
      discoverySampleSequence: first.discovery.sampleSequence,
      discoverySampledAtEpochMs: first.discovery.sampledAtEpochMs,
    },
    first,
  );
  assert.deepEqual(duplicate, {
    discoverySampleSequence: first.discovery.sampleSequence,
    discoverySampledAtEpochMs: first.discovery.sampledAtEpochMs,
  });
  const progressed = assertB4AndroidContinuity(
    baseline,
    duplicate,
    fixtureSample(11),
  );
  assert.equal(progressed.discoverySampleSequence, 11);
});

test("discovery reporter freshness rejects a stalled duplicate", () => {
  const nowMs = 1_786_000_010_000;
  expectCode(
    () =>
      validateDiscoveryReporter(
        {
          ready: true,
          readiness: "READY",
          radioActive: true,
          reporterStartedAtEpochMs: nowMs - 60_000,
          sampledAtEpochMs: nowMs - 5_001,
          metrics: {
            advertisementsStarted: 1,
            advertisementFailures: 0,
            scanFailures: 0,
            scanIngressDropped: 0,
            invalidPayloads: 0,
          },
        },
        nowMs,
      ),
    "DISCOVERY_REPORTER_NOT_READY",
  );
});

test("foreign parser failures keep only approved safe reason codes", () => {
  for (const code of ["SESSION_LOGGED_OUT", "REPORTER_STALE"]) {
    const normalized = normalizeB4AndroidMonitorError(
      new B5AndroidContinuityError(code, "sensitive-session-value"),
    );
    assert.ok(normalized instanceof B4AndroidContinuityError);
    assert.equal(normalized.code, code);
    assert.equal(normalized.exitCode, 1);
    assert.doesNotMatch(normalized.message, /sensitive-session-value/u);
  }
  const local = new B4AndroidContinuityError(
    "DISCOVERY_REPORTER_NOT_READY",
    "Android discovery reporter is not ready",
  );
  assert.equal(normalizeB4AndroidMonitorError(local), local);

  const unknown = new B5AndroidContinuityError(
    "UNRECOGNIZED_DEPENDENCY_FAILURE",
    "sensitive-session-value",
  );
  assert.equal(normalizeB4AndroidMonitorError(unknown), unknown);
});

test("continuity rejects process, reporter, session and exit changes", () => {
  const first = fixtureSample(10);
  const baseline = fixtureBaseline(first);
  const previous = {
    discoverySampleSequence: 10,
    discoverySampledAtEpochMs: first.discovery.sampledAtEpochMs,
  };
  const cases = [
    [
      { ...fixtureSample(11), pid: 5_555 },
      "TARGET_CONTINUITY_CHANGED",
    ],
    [
      {
        ...fixtureSample(11),
        discovery: { ...fixtureSample(11).discovery, sampleSequence: 10 },
      },
      "REPORTER_CONTINUITY_CHANGED",
    ],
    [
      { ...fixtureSample(11), sessionBindingHmacSha256: "d".repeat(64) },
      "SESSION_CHANGED",
    ],
    [
      {
        ...fixtureSample(11),
        exitInfo: { commitments: new Set(["e".repeat(64)]) },
      },
      "APPLICATION_EXIT_RECORDED",
    ],
  ];
  for (const [sample, code] of cases) {
    expectCode(
      () => assertB4AndroidContinuity(baseline, previous, sample),
      code,
    );
  }
});

test("argument parser binds the certified target and private outputs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-android-args-"));
  fs.chmodSync(directory, 0o700);
  const collectorState = path.join(directory, "state.json");
  fs.writeFileSync(collectorState, "{}\n", { mode: 0o600 });
  try {
    const options = parseB4AndroidMonitorArguments([
      "--adb",
      process.execPath,
      "--serial",
      "TESTSERIAL01",
      "--android-user-id",
      "0",
      "--capture-run-id",
      CAPTURE_RUN_ID,
      "--private-output",
      path.join(directory, "private.jsonl"),
      "--attestation",
      path.join(directory, "attestation.json"),
      "--collector-state",
      collectorState,
      "--duration-seconds",
      "120",
      "--poll-ms",
      "2000",
    ]);
    assert.equal(options.durationMs, 120_000);
    assert.equal(Object.hasOwn(options, "packageName"), false);
    assert.equal(Object.hasOwn(options, "role"), false);
    assert.equal(Object.hasOwn(options, "collectionRunId"), false);
    assert.equal(Object.hasOwn(options, "certificationMatrixSha256"), false);
    expectCode(
      () =>
        parseB4AndroidMonitorArguments([
          "--adb",
          process.execPath,
          "--serial",
          "TESTSERIAL01",
          "--package",
          TARGET.packageId,
        ]),
      "ARGUMENT_INVALID",
    );
    expectCode(
      () =>
        parseB4AndroidMonitorArguments([
          "--adb",
          process.execPath,
          "--serial",
          "TESTSERIAL01",
        ]),
      "ARGUMENT_INVALID",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("monitor writes immutable 0600 artifacts with synthetic progressive samples", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-android-run-"));
  fs.chmodSync(directory, 0o700);
  let monotonicMs = 0;
  const epochBaseMs = 1_786_000_000_000;
  let sequence = 100;
  const options = {
    adb: process.execPath,
    serial: "TESTSERIAL01",
    androidUserId: 0,
    captureRunId: CAPTURE_RUN_ID,
    privateOutput: path.join(directory, "private.jsonl"),
    attestation: path.join(directory, "attestation.json"),
    collectorState: path.join(directory, "state.json"),
    pollMs: 5_000,
    durationMs: 90_000,
  };
  fs.writeFileSync(
    options.collectorState,
    `${JSON.stringify({
      schemaVersion: 2,
      product: "V5BT",
      phase: "B4",
      runId: COLLECTION_RUN_ID,
      identityKeyBase64Url: Buffer.alloc(32, 0x5a).toString("base64url"),
      certificationMatrixBinding: { matrixSha256: MATRIX_SHA256 },
    })}\n`,
    { mode: 0o600 },
  );
  try {
    const report = await runB4AndroidContinuityMonitor(options, {
      performanceNow: () => monotonicMs,
      wallNow: () => epochBaseMs + monotonicMs,
      sleep: async (delayMs) => {
        monotonicMs += delayMs;
      },
      captureSample: async (_options, _key, _signal, includeApkDigest) => {
        const sampledAtEpochMs = epochBaseMs + monotonicMs;
        sequence += 1;
        return {
          ...fixtureSample(sequence),
          sampledAt: new Date(sampledAtEpochMs).toISOString(),
          discovery: {
            ...fixtureSample(sequence).discovery,
            sampleSequence: sequence,
            sampledAtEpochMs,
          },
          ...(includeApkDigest ? { apkSha256: TARGET.sha256 } : {}),
        };
      },
    });
    assert.equal(report.verdict, "PASS");
    assert.equal(report.target.packageName, TARGET.packageId);
    assert.equal(
      report.binding.collectionRunCommitmentSha256,
      buildB4RunCommitments({
        collectionRunId: COLLECTION_RUN_ID,
        captureRunId: CAPTURE_RUN_ID,
      }).collectionRunCommitmentSha256,
    );
    assert.equal(report.coverage.durationMs, 90_000);
    for (const file of [options.privateOutput, options.attestation]) {
      const status = fs.lstatSync(file);
      assert.equal(status.mode & 0o777, 0o600);
      assert.equal(status.nlink, 1);
    }
    await assert.rejects(
      runB4AndroidContinuityMonitor(options, {
        captureSample: async () => fixtureSample(),
      }),
      (error) =>
        error instanceof B4AndroidContinuityError && error.code === "OUTPUT_EXISTS",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SIGINT abort during timer sleep is normalized and preserves cleanup", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-sleep-abort-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identityKey = Buffer.alloc(32, 0x5a);
  const options = {
    adb: process.execPath,
    serial: "TESTSERIAL01",
    androidUserId: 0,
    captureRunId: CAPTURE_RUN_ID,
    privateOutput: path.join(directory, "private.jsonl"),
    attestation: path.join(directory, "attestation.json"),
    collectorState: path.join(directory, "state.json"),
    pollMs: 5_000,
    durationMs: 90_000,
  };
  const existingSigintListeners = new Set(process.listeners("SIGINT"));
  await assert.rejects(
    runB4AndroidContinuityMonitor(options, {
      readCollectorIdentityBinding: () => ({
        collectionRunId: COLLECTION_RUN_ID,
        certificationMatrixSha256: MATRIX_SHA256,
        identityKey,
      }),
      randomBytes: (size) => Buffer.alloc(size, 0x6b),
      performanceNow: () => 0,
      wallNow: () => 1_786_000_000_000,
      captureSample: async () => fixtureSample(10),
      sleep: async (_delay, _value, { signal }) => {
        const monitorListeners = process
          .listeners("SIGINT")
          .filter((listener) => !existingSigintListeners.has(listener));
        assert.equal(monitorListeners.length, 1);
        monitorListeners[0]();
        assert.equal(signal.aborted, true);
        const abortError = new Error("The operation was aborted");
        abortError.name = "AbortError";
        throw abortError;
      },
    }),
    (error) =>
      error instanceof B4AndroidContinuityError &&
      error.code === "MONITOR_INTERRUPTED" &&
      error.exitCode === 130,
  );
  assert.deepEqual(identityKey, Buffer.alloc(32));
  assert.equal(fs.existsSync(options.attestation), false);
  assert.equal(fs.statSync(options.privateOutput).mode & 0o777, 0o600);
  assert.match(
    fs.readFileSync(options.privateOutput, "utf8"),
    /"verdict":"FAIL","code":"MONITOR_INTERRUPTED"/u,
  );
  assert.deepEqual(
    process
      .listeners("SIGINT")
      .filter((listener) => !existingSigintListeners.has(listener)),
    [],
  );
});

test("post-logout parser failure is normalized in the private journal", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-logout-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identityKey = Buffer.alloc(32, 0x5a);
  const options = {
    adb: process.execPath,
    serial: "TESTSERIAL01",
    androidUserId: 0,
    captureRunId: CAPTURE_RUN_ID,
    privateOutput: path.join(directory, "private.jsonl"),
    attestation: path.join(directory, "attestation.json"),
    collectorState: path.join(directory, "state.json"),
    pollMs: 5_000,
    durationMs: 90_000,
  };
  await assert.rejects(
    runB4AndroidContinuityMonitor(options, {
      readCollectorIdentityBinding: () => ({
        collectionRunId: COLLECTION_RUN_ID,
        certificationMatrixSha256: MATRIX_SHA256,
        identityKey,
      }),
      randomBytes: (size) => Buffer.alloc(size, 0x6b),
      performanceNow: () => 0,
      wallNow: () => 1_786_000_000_000,
      captureSample: async () => {
        throw new B5AndroidContinuityError(
          "SESSION_LOGGED_OUT",
          "sensitive-session-value",
        );
      },
    }),
    (error) =>
      error instanceof B4AndroidContinuityError &&
      error.code === "SESSION_LOGGED_OUT" &&
      error.exitCode === 1 &&
      !error.message.includes("sensitive-session-value"),
  );
  assert.deepEqual(identityKey, Buffer.alloc(32));
  assert.equal(fs.existsSync(options.attestation), false);
  const journal = fs.readFileSync(options.privateOutput, "utf8");
  assert.match(journal, /"verdict":"FAIL","code":"SESSION_LOGGED_OUT"/u);
  assert.doesNotMatch(journal, /sensitive-session-value/u);
  assert.doesNotMatch(journal, /UNEXPECTED_FAILURE/u);
});

test("CLI reports a logged-out parser result with safe B4 semantics", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-logout-cli-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fakeAdb = path.join(directory, "fake-adb.mjs");
  const collectorState = path.join(directory, "state.json");
  const privateOutput = path.join(directory, "private.jsonl");
  const attestation = path.join(directory, "attestation.json");
  fs.writeFileSync(
    fakeAdb,
    `#!/bin/sh\n` +
      `':' //; exec ${JSON.stringify(process.execPath)} "$0" "$@"\n` +
      `const raw = process.argv.slice(2);\n` +
      `const args = raw[0] === "-s" ? raw.slice(2) : raw;\n` +
      `let output = "<map></map>\\n";\n` +
      `if (args[0] === "devices") output = "List of devices attached\\nTESTSERIAL01\\tdevice\\n";\n` +
      `else if (args.join(" ") === "shell am get-current-user") output = "0\\n";\n` +
      `else if (args.join(" ") === "shell getprop ro.build.version.sdk") output = "36\\n";\n` +
      `else if (args[0] === "shell" && args[1] === "dumpsys" && args[2] === "package") output = ${JSON.stringify(`versionCode=${TARGET.versionCode} targetSdk=36\nversionName=${TARGET.versionName}\n    User 0: installed=true stopped=false enabled=0\n`)};\n` +
      `else if (args[0] === "shell" && args[1] === "cmd") output = ${JSON.stringify(`package:${TARGET.packageId} uid:10044\n`)};\n` +
      `else if (args[0] === "shell" && args[1] === "pidof") output = "4321\\n";\n` +
      `else if (args.includes("webkiosk_prefs.xml")) output = "<map></map>\\n";\n` +
      `else if (args.includes("bluetooth-discovery-status-v1.json")) output = "{}\\n";\n` +
      `else if (args.join(" ") === "shell getprop ro.kernel.qemu") output = "0\\n";\n` +
      `else if (args.join(" ") === "shell getprop ro.serialno") output = "TESTHARDWARE01\\n";\n` +
      `else if (args.join(" ") === "shell getprop ro.boot.serialno") output = "TESTHARDWARE01\\n";\n` +
      `else if (args[0] === "shell" && args[1] === "pm" && args[2] === "path") output = "package:/data/app/base.apk\\n";\n` +
      `process.stdout.write(output);\n`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    collectorState,
    `${JSON.stringify({
      schemaVersion: 2,
      product: "V5BT",
      phase: "B4",
      runId: COLLECTION_RUN_ID,
      identityKeyBase64Url: Buffer.alloc(32, 0x5a).toString("base64url"),
      certificationMatrixBinding: { matrixSha256: MATRIX_SHA256 },
    })}\n`,
    { mode: 0o600 },
  );

  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-v5bt-b4-android-continuity-monitor.mjs",
      "--adb",
      fakeAdb,
      "--serial",
      "TESTSERIAL01",
      "--android-user-id",
      "0",
      "--capture-run-id",
      CAPTURE_RUN_ID,
      "--private-output",
      privateOutput,
      "--attestation",
      attestation,
      "--collector-state",
      collectorState,
      "--duration-seconds",
      "90",
      "--poll-ms",
      "5000",
    ],
    { cwd: path.resolve("."), encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "SESSION_LOGGED_OUT: Android B4 continuity monitor failed\n",
  );
  const journal = fs.readFileSync(privateOutput, "utf8");
  assert.match(journal, /"verdict":"FAIL","code":"SESSION_LOGGED_OUT"/u);
  assert.doesNotMatch(journal, /UNEXPECTED_FAILURE|sensitive-session-value/u);
  assert.equal(fs.existsSync(attestation), false);
});

test("collector identity key is wiped when initialization fails", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-key-wipe-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identityKey = Buffer.alloc(32, 0x5a);
  const options = {
    adb: process.execPath,
    serial: "TESTSERIAL01",
    androidUserId: 0,
    captureRunId: CAPTURE_RUN_ID,
    privateOutput: path.join(directory, "private.jsonl"),
    attestation: path.join(directory, "attestation.json"),
    collectorState: path.join(directory, "state.json"),
    pollMs: 5_000,
    durationMs: 90_000,
  };
  await assert.rejects(
    runB4AndroidContinuityMonitor(options, {
      readCollectorIdentityBinding: () => ({
        collectionRunId: COLLECTION_RUN_ID,
        certificationMatrixSha256: MATRIX_SHA256,
        identityKey,
      }),
      randomBytes: () => {
        throw new Error("injected random failure");
      },
    }),
    /injected random failure/u,
  );
  assert.deepEqual(identityKey, Buffer.alloc(32));
  assert.equal(fs.existsSync(options.privateOutput), false);
  assert.equal(fs.existsSync(options.attestation), false);
});

test("atomic attestation publication rolls back an injected post-link error", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b4-publish-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "attestation.json");
  const fileSystem = Object.create(fs);
  let injectFailure = true;
  fileSystem.linkSync = (source, target) => {
    fs.linkSync(source, target);
    if (injectFailure) {
      injectFailure = false;
      const error = new Error("injected link completion failure");
      error.code = "EIO";
      throw error;
    }
  };
  expectCode(
    () => publishPrivateJson(destination, fixtureAttestation(), { fileSystem }),
    "OUTPUT_UNSAFE",
  );
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.startsWith(".b4-android-")),
    [],
  );

  publishPrivateJson(destination, fixtureAttestation());
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  expectCode(
    () => publishPrivateJson(destination, fixtureAttestation()),
    "OUTPUT_EXISTS",
  );
});

test("CLI self-test is radio-free", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/run-v5bt-b4-android-continuity-monitor.mjs", "--self-test"],
    { cwd: path.resolve("."), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, "PASS");
  assert.equal(report.physicalAdbAccessed, false);
});
