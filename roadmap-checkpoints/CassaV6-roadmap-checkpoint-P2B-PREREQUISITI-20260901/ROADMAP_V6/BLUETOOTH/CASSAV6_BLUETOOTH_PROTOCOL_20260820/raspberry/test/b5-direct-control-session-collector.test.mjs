import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  API31_STAGING_HARNESS_VERSION,
  B5SessionCollectionError,
  B5_SESSION_COLLECTOR_VERSION,
  buildEvidenceManifest,
  buildPreflightReport,
  buildProgressReport,
  capturePhysicalSession,
  createInitialCollectorState,
  inspectApi31StagingRegistry,
  main,
  parseCollectorState,
  prepareApi31StagingRegistrySnapshot,
  reserveCaptureBootId,
  runApi31StagingDirectControl,
  runApi31StagingPreflight,
  runCollectorSelfTest
} from "../scripts/collect-b5-direct-control-session.mjs";
import {
  validPhysicalReportFixture,
  validatePhysicalSessionReport
} from "../scripts/run-b5-hundred-session-gate.mjs";
import { B5DirectControlSmokeError } from "../scripts/run-b5-direct-control-smoke.mjs";
import { DeviceRegistryV2 } from "../../shared/provisioning/device-registry-v2.mjs";
import {
  validB5AccountDeviceBindingFixture
} from "../../scripts/b5-account-device-commitment.mjs";
import {
  ADVANCED_CERTIFICATION_TARGETS
} from "../../scripts/advanced-certification-targets.mjs";
import {
  B5_ANDROID_CONTINUITY_MONITOR_VERSION
} from "../../scripts/run-b5-android-continuity-monitor.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/collect-b5-direct-control-session.mjs", import.meta.url)
);

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}

async function createEnrollmentRegistry(directory, protocolVersion = 2) {
  const registryPath = path.join(directory, `devices-v${protocolVersion}.json`);
  const registry = new DeviceRegistryV2(registryPath);
  await registry.initialize();
  const algorithm = protocolVersion === 2 ? "EC-P256" : "Ed25519";
  const keyPair = crypto.generateKeyPairSync(
    protocolVersion === 2 ? "ec" : "ed25519",
    protocolVersion === 2 ? { namedCurve: "prime256v1" } : undefined
  );
  const issued = await registry.issueEnrollmentToken({
    protocolVersion,
    enrollmentEndpointId: "raspberry-lab-cassav6"
  });
  await registry.enrollDevice({
    protocolVersion,
    enrollmentEndpointId: issued.qr.enrollmentEndpointId,
    token: issued.qr.token,
    nodeId:
      protocolVersion === 2
        ? "123e4567-e89b-42d3-a456-426614174031"
        : "123e4567-e89b-42d3-a456-426614174032",
    publicKeyAlgorithm: algorithm,
    publicKey: keyPair.publicKey
  });
  return registryPath;
}

function stagingPreflightFixture() {
  return {
    mode: "API31_STAGING_PREFLIGHT",
    verdict: "READY",
    physicalRadioAccessed: false,
    protocol: {
      advertisementVersion: 1,
      helloWireVersion: 1,
      enrollmentVersion: 2,
      identityAlgorithm: "EC-P256",
      mutualAuthentication: "ECDSA-P256",
      keyExchange: "X25519",
      directControlVersion: 1
    }
  };
}

function spawnCollector(args, { cwd } = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8"
  });
}

function parseJsonOutput(child) {
  assert.notEqual(child.stdout.trim(), "", child.stderr);
  return JSON.parse(child.stdout);
}

function privateBaselineFixture(campaignId) {
  const target = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;
  const nowMs = Date.parse("2026-07-20T00:00:00.000Z");
  return {
    schemaVersion: 1,
    harnessVersion: B5_ANDROID_CONTINUITY_MONITOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: "PRIVATE_ANDROID_CONTINUITY_BASELINE",
    campaignId,
    createdAt: new Date(nowMs).toISOString(),
    binding: {
      serial: "V6-PHYSICAL-HANDHELD-001",
      role: "handheld",
      packageName: target.packageId,
      versionName: target.versionName,
      versionCode: target.versionCode,
      androidApi: 36,
      androidUserId: 0,
      appUid: 10_001,
      pid: 2_345,
      gattReporterStartedAtEpochMs: nowMs - 60_000,
      agentReporterStartedAtEpochMs: nowMs - 120_000,
      sessionHmacKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      sessionBindingHmacSha256: "1".repeat(64),
      apkSha256: target.sha256
    },
    reporters: {
      gattSampleSequence: 10,
      gattSampledAtEpochMs: nowMs,
      agentSampleSequence: 20,
      agentSampledAtEpochMs: nowMs,
      agentStartCount: 1,
      agentStopCount: 0
    },
    exitInfo: { recordCommitmentsSha256: [] }
  };
}

function boundInitialState(options = {}) {
  const campaignRunId =
    options.campaignRunId ?? "00000000-0000-4000-8000-000000000001";
  return createInitialCollectorState({
    ...options,
    campaignRunId,
    accountDeviceBinding: validB5AccountDeviceBindingFixture({
      campaignId: campaignRunId
    })
  });
}

function initCollector(directory) {
  const statePath = path.join(directory, "private", "b5-collector-state.json");
  const androidBaselinePath = path.join(directory, "android-baseline.json");
  fs.writeFileSync(
    androidBaselinePath,
    `${JSON.stringify(
      privateBaselineFixture("00000000-0000-4000-8000-000000000001"),
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  const child = spawnCollector([
    "--init",
    "--state",
    statePath,
    "--android-baseline",
    androidBaselinePath
  ], {
    cwd: directory
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return { statePath, androidBaselinePath, report: parseJsonOutput(child) };
}

function failureCode(child) {
  try {
    return JSON.parse(child.stdout).failure?.code ?? null;
  } catch {
    const match = child.stderr.match(/\b([A-Z][A-Z0-9_]{2,})\b/u);
    return match?.[1] ?? null;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fixtureCapture(sequence) {
  const report = validPhysicalReportFixture(sequence);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const reportSha256 = sha256(reportBytes);
  const validated = validatePhysicalSessionReport({
    sequence,
    sourceReportSha256: reportSha256,
    report
  });
  const generatedAtMs = Date.parse(validated.generatedAt);
  return {
    report,
    reportBytes,
    record: {
      sequence,
      slot: String(sequence).padStart(3, "0"),
      evidenceRecordId: `00000000-0000-4${String(sequence).padStart(3, "0")}-8000-${String(sequence).padStart(12, "0")}`,
      runner: "B5_DIRECT_CONTROL_SMOKE_V1",
      reportSha256,
      generatedAt: validated.generatedAt,
      captureStartedAt: new Date(generatedAtMs - 60_000).toISOString(),
      captureCompletedAt: new Date(generatedAtMs + 1).toISOString(),
      sessionStartedAt: new Date(validated.captureStartMs).toISOString(),
      durationMs: validated.durationMs,
      pingsSent: validated.pingsSent,
      pongsVerified: validated.pongsVerified,
      heartbeatMisses: validated.heartbeatMisses,
      targetSignatureSha256: sha256(validated.targetSignature)
    }
  };
}

function stageCollection(statePath, count) {
  const initial = parseCollectorState(fs.readFileSync(statePath, "utf8"));
  const captures = Array.from(
    { length: count },
    (_, index) => fixtureCapture(index + 1)
  );
  const records = captures.map((capture) => ({
    ...capture.record,
    accountDeviceCommitmentSha256:
      initial.accountDeviceCommitmentSha256
  }));
  const state = {
    ...initial,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: records.at(-1)?.captureCompletedAt ?? initial.updatedAt,
    lastCaptureBootId: count === 0 ? null : (count % 255) + 1,
    collectionCommitmentSha256: sha256(
      records.map((record) => record.reportSha256).join("\n")
    ),
    records
  };
  parseCollectorState(state);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600
  });
  if (count > 0) {
    const evidenceDirectory = `${statePath}.evidence`;
    fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
    for (const capture of captures) {
      fs.writeFileSync(
        path.join(evidenceDirectory, `session-${capture.record.slot}.json`),
        capture.reportBytes,
        { mode: 0o600 }
      );
    }
  }
  return { state, captures };
}

function transactionJournal(state, record) {
  return {
    schemaVersion: 1,
    harnessVersion: B5_SESSION_COLLECTOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: "PHYSICAL_CAPTURE_COMMIT",
    campaignRunId: state.campaignRunId,
    record: {
      ...record,
      accountDeviceCommitmentSha256:
        state.accountDeviceCommitmentSha256
    }
  };
}

function directorySnapshot(directory) {
  const result = [];
  const visit = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const location = path.join(current, name);
      const relative = path.relative(directory, location);
      const status = fs.lstatSync(location);
      result.push({
        relative,
        mode: status.mode & 0o777,
        size: status.size,
        mtimeMs: status.mtimeMs,
        bytes: status.isFile() ? fs.readFileSync(location).toString("base64") : null
      });
      if (status.isDirectory()) visit(location);
    }
  };
  visit(directory);
  return result;
}

test("collector exposes only the documented programmatic surface", () => {
  assert.equal(API31_STAGING_HARNESS_VERSION, "1.0.0");
  assert.equal(typeof createInitialCollectorState, "function");
  assert.equal(typeof parseCollectorState, "function");
  assert.equal(typeof reserveCaptureBootId, "function");
  assert.equal(typeof capturePhysicalSession, "function");
  assert.equal(typeof buildProgressReport, "function");
  assert.equal(typeof buildPreflightReport, "function");
  assert.equal(typeof buildEvidenceManifest, "function");
  assert.equal(typeof runCollectorSelfTest, "function");
  assert.equal(typeof inspectApi31StagingRegistry, "function");
  assert.equal(typeof prepareApi31StagingRegistrySnapshot, "function");
  assert.equal(typeof runApi31StagingPreflight, "function");
  assert.equal(typeof runApi31StagingDirectControl, "function");
  assert.equal(typeof main, "function");
});

test("collector self-test remains synthetic, pending and filesystem-neutral", () => {
  const directory = temporaryDirectory("v6-b5-collector-self-test-");
  try {
    const before = fs.readdirSync(directory);
    const child = spawnCollector(["--self-test"], { cwd: directory });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const report = parseJsonOutput(child);

    assert.equal(report.mode, "SELF_TEST");
    assert.equal(report.verdict, "PASS");
    assert.equal(report.physicalEvidenceConsumed, false);
    assert.equal(report.privateStateWritten, false);
    assert.equal(report.authoritativeB5GateExecuted, false);
    assert.equal(report.b5GatePromoted, false);
    assert.equal(report.gate.b5HundredSessionGate, "PENDING");
    assert.equal(report.gate.b6, "PENDING");
    assert.deepEqual(fs.readdirSync(directory), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("collector pure self-test cannot promote a physical manifest", () => {
  const report = runCollectorSelfTest();
  assert.equal(report.mode, "SELF_TEST");
  assert.equal(report.physicalEvidenceConsumed, false);
  assert.equal(report.privateStateWritten, false);
  assert.equal(report.authoritativeB5GateExecuted, false);
  assert.equal(report.gate.b5HundredSessionGate, "PENDING");
  assert.equal(JSON.stringify(report).includes("PHYSICAL_HUNDRED_SESSION_AGGREGATE"), false);
});

test("collector self-test exercises fail-closed private evidence tamper detection", () => {
  const report = runCollectorSelfTest();
  assert.equal(report.mode, "SELF_TEST");
  assert.equal(report.checks.privateEvidenceTamperRejected, "PASS");
  assert.equal(report.checks.completeCollectionRejectedBeforeRunner, "PASS");
  assert.equal(report.checks.physicalAbortReturns130, "PASS");
  assert.equal(report.physicalEvidenceConsumed, false);
  assert.equal(report.gate.b5HundredSessionGate, "PENDING");
});

test("init creates exact, owner-only state and status keeps the gate pending", () => {
  const directory = temporaryDirectory("v6-b5-collector-init-");
  try {
    const { statePath, report: initReport } = initCollector(directory);
    const status = fs.lstatSync(statePath);
    assert.equal(status.isFile(), true);
    if (process.platform === "linux") {
      assert.equal(status.mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700);
    }

    const raw = fs.readFileSync(statePath, "utf8");
    const state = parseCollectorState(raw);
    assert.equal(state.product, "V6");
    assert.equal(state.phase, "B5");
    assert.equal(Array.isArray(state.records), true);
    assert.equal(state.records.length, 0);
    assert.throws(
      () => parseCollectorState({ ...state, unexpectedField: true }),
      (error) => typeof error?.code === "string"
    );

    assert.equal(initReport.gate.b5HundredSessionGate, "PENDING");
    const child = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const progress = parseJsonOutput(child);
    assert.equal(progress.verdict, "PENDING");
    assert.equal(progress.gate.b5HundredSessionGate, "PENDING");
    assert.deepEqual(
      buildProgressReport(state, { generatedAt: progress.generatedAt }),
      progress
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("collector state update timestamp is bound to the committed inventory", () => {
  const campaignRunId = "00000000-0000-4000-8000-000000000099";
  const empty = boundInitialState({
    campaignRunId,
    now: "2026-08-03T00:00:00.000Z"
  });
  assert.equal(parseCollectorState(empty).updatedAt, empty.createdAt);
  assert.throws(
    () => parseCollectorState({
      ...empty,
      updatedAt: "2026-08-03T00:00:01.000Z"
    }),
    (error) => error?.code === "STATE_INVALID"
  );

  const directory = temporaryDirectory("v6-b5-collector-updated-at-");
  try {
    const { statePath, androidBaselinePath } = initCollector(directory);
    const { state } = stageCollection(statePath, 1);
    assert.equal(
      parseCollectorState(state).updatedAt,
      state.records.at(-1).captureCompletedAt
    );
    assert.throws(
      () => parseCollectorState({
        ...state,
        updatedAt: state.records.at(-1).captureStartedAt
      }),
      (error) => error?.code === "STATE_INVALID"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("empty legacy state remains read-only, pending and unmodified", () => {
  const directory = temporaryDirectory("v6-b5-collector-legacy-empty-");
  try {
    const { statePath, androidBaselinePath } = initCollector(directory);
    const current = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const legacy = {
      ...current,
      schemaVersion: 1,
      harnessVersion: "1.0.0"
    };
    delete legacy.lastCaptureBootId;
    delete legacy.accountDeviceCommitmentSha256;
    for (const record of legacy.records) {
      delete record.accountDeviceCommitmentSha256;
    }
    fs.writeFileSync(statePath, `${JSON.stringify(legacy, null, 2)}\n`, {
      mode: 0o600
    });
    const before = directorySnapshot(directory);
    const inodeBefore = fs.statSync(statePath).ino;

    const preflight = spawnCollector(["--preflight", "--state", statePath], {
      cwd: directory
    });
    assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
    const preflightReport = parseJsonOutput(preflight);
    assert.equal(preflightReport.mode, "PREFLIGHT");
    assert.equal(preflightReport.verdict, "PENDING");
    assert.equal(preflightReport.checks.stateSchema, "LEGACY_READ_ONLY");
    assert.equal(preflightReport.checks.accountDeviceBinding, "MISSING");
    assert.equal(preflightReport.privateStateWritten, false);
    assert.deepEqual(directorySnapshot(directory), before);

    const status = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const unchanged = parseCollectorState(fs.readFileSync(statePath, "utf8"));
    assert.equal(unchanged.schemaVersion, 1);
    assert.equal(unchanged.harnessVersion, "1.0.0");
    if (process.platform === "linux") {
      assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(statePath).ino, inodeBefore);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy state containing records is rejected without rewriting artifacts", () => {
  const directory = temporaryDirectory("v6-b5-collector-legacy-records-");
  try {
    const { statePath, androidBaselinePath } = initCollector(directory);
    const { state } = stageCollection(statePath, 1);
    const legacy = {
      ...state,
      schemaVersion: 1,
      harnessVersion: "1.0.0"
    };
    delete legacy.lastCaptureBootId;
    delete legacy.accountDeviceCommitmentSha256;
    for (const record of legacy.records) {
      delete record.accountDeviceCommitmentSha256;
    }
    fs.writeFileSync(statePath, `${JSON.stringify(legacy, null, 2)}\n`, {
      mode: 0o600
    });
    const stateBefore = fs.readFileSync(statePath);
    const evidenceBefore = fs.readFileSync(
      path.join(`${statePath}.evidence`, "session-001.json")
    );

    const child = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.notEqual(child.status, 0, child.stdout);
    assert.equal(failureCode(child), "STATE_LEGACY_NONEMPTY");
    assert.deepEqual(fs.readFileSync(statePath), stateBefore);
    assert.deepEqual(
      fs.readFileSync(path.join(`${statePath}.evidence`, "session-001.json")),
      evidenceBefore
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("historical schema 2 evidence is readable but remains pending and read-only", () => {
  const directory = temporaryDirectory("v6-b5-collector-historical-v2-");
  try {
    const { statePath } = initCollector(directory);
    const { state } = stageCollection(statePath, 1);
    const historical = {
      ...state,
      schemaVersion: 2,
      harnessVersion: "1.1.0"
    };
    delete historical.accountDeviceCommitmentSha256;
    for (const record of historical.records) {
      delete record.accountDeviceCommitmentSha256;
    }
    fs.writeFileSync(statePath, `${JSON.stringify(historical, null, 2)}\n`, {
      mode: 0o600
    });
    const before = fs.readFileSync(statePath);

    const status = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(parseJsonOutput(status).verdict, "PENDING");

    const capture = spawnCollector(["--capture", "--state", statePath], {
      cwd: directory
    });
    assert.notEqual(capture.status, 0, capture.stdout);
    assert.equal(failureCode(capture), "ACCOUNT_DEVICE_COMMITMENT_REQUIRED");

    const manifestPath = path.join(directory, "private", "manifest.json");
    const finalize = spawnCollector(
      ["--finalize", "--state", statePath, "--manifest", manifestPath],
      { cwd: directory }
    );
    assert.notEqual(finalize.status, 0, finalize.stdout);
    assert.equal(failureCode(finalize), "ACCOUNT_DEVICE_COMMITMENT_REQUIRED");
    assert.deepEqual(fs.readFileSync(statePath), before);
    assert.equal(fs.existsSync(manifestPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("preflight is redacted, non-mutating and refuses file output", () => {
  const directory = temporaryDirectory("v6-b5-collector-preflight-");
  try {
    const { statePath } = initCollector(directory);
    const privateState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const before = directorySnapshot(directory);
    const child = spawnCollector(["--preflight", "--state", statePath], {
      cwd: directory
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const report = parseJsonOutput(child);
    assert.deepEqual(
      report,
      buildPreflightReport(privateState, { generatedAt: report.generatedAt })
    );
    assert.equal(report.privateStateWritten, false);
    assert.equal(report.physicalEvidenceConsumed, false);
    assert.equal(child.stdout.includes(privateState.campaignRunId), false);
    assert.equal(/boot.?id/iu.test(child.stdout), false);
    assert.equal(child.stdout.includes(statePath), false);
    assert.deepEqual(directorySnapshot(directory), before);

    const outputPath = path.join(directory, "must-not-exist.json");
    const rejected = spawnCollector(
      ["--preflight", "--state", statePath, "--output", outputPath],
      { cwd: directory }
    );
    assert.notEqual(rejected.status, 0, rejected.stdout);
    assert.equal(failureCode(rejected), "INVALID_ARGUMENT");
    assert.equal(fs.existsSync(outputPath), false);
    assert.deepEqual(directorySnapshot(directory), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("capture boot identifiers are CSPRNG-bounded, reserved and never repeated", () => {
  const initial = boundInitialState({
    now: "2026-08-03T00:00:00.000Z",
    campaignRunId: "00000000-0000-4000-8000-000000000001"
  });
  const values = [23, 23, 24];
  const first = reserveCaptureBootId(initial, {
    randomInt: (minimum, maximum) => {
      assert.equal(minimum, 1);
      assert.equal(maximum, 256);
      return values.shift();
    }
  });
  const second = reserveCaptureBootId(first.state, {
    randomInt: (minimum, maximum) => {
      assert.equal(minimum, 1);
      assert.equal(maximum, 256);
      return values.shift();
    }
  });
  assert.equal(first.bootId, 23);
  assert.equal(second.bootId, 24);
  assert.equal(second.state.lastCaptureBootId, 24);
  assert.deepEqual(values, []);
  assert.doesNotMatch(JSON.stringify(buildProgressReport(second.state)), /boot.?id/iu);

  let state = initial;
  for (let index = 0; index < 1_000; index += 1) {
    const reservation = reserveCaptureBootId(state);
    assert.ok(reservation.bootId >= 1 && reservation.bootId <= 255);
    assert.notEqual(reservation.bootId, state.lastCaptureBootId);
    state = reservation.state;
  }
});

test("one private boot reservation is passed unchanged to runner and advertiser", async () => {
  const initial = boundInitialState({
    now: "2026-08-03T00:00:00.000Z",
    campaignRunId: "00000000-0000-4000-8000-000000000001"
  });
  const reservation = reserveCaptureBootId(initial, { randomInt: () => 91 });
  const seen = { runner: null, advertiser: null };
  const timestamps = [
    "2026-08-03T00:01:00.000Z",
    "2026-08-03T00:01:02.000Z"
  ];
  const report = validPhysicalReportFixture(1);
  report.generatedAt = "2026-08-03T00:01:01.000Z";
  const capture = await capturePhysicalSession(
    reservation.state,
    reservation.bootId,
    {
      now: () => timestamps.shift(),
      loadPhysicalConfiguration: () => ({
        adapterName: "hci0",
        nodeId: "123e4567-e89b-12d3-a456-426614174000",
        helloCapabilities: 72,
        deviceRegistryPath: "/private/registry.json"
      }),
      radioLockPath: () => "/private/radio.lock",
      acquireKernelLock: async () => async () => {},
      snapshotRelevantServices: async () => ["bluetooth.service active"],
      startTransientAdvertisement: ({ bootId }) => {
        seen.advertiser = bootId;
        return {
          waitUntilReady: async () => {},
          finish: async () => {},
          stop: async () => {}
        };
      },
      runPhysicalDirectControlSmoke: async (options) => {
        seen.runner = options.bootId;
        await options.onRegistered();
        return report;
      }
    }
  );
  assert.deepEqual(seen, { runner: 91, advertiser: 91 });
  assert.equal(capture.state.lastCaptureBootId, 91);
  assert.equal(Object.hasOwn(capture.record, "bootId"), false);
  assert.doesNotMatch(capture.reportBytes.toString("utf8"), /boot.?id/iu);
});

test("collector preserves retryable timeout only after its full cleanup", async () => {
  const initial = boundInitialState({
    now: "2026-08-03T00:00:00.000Z",
    campaignRunId: "00000000-0000-4000-8000-000000000001"
  });
  const reservation = reserveCaptureBootId(initial, { randomInt: () => 92 });
  let advertisementStopped = false;
  let lockReleased = false;
  let serviceSnapshots = 0;
  const timeout = new B5DirectControlSmokeError(
    "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
    "physical capture ended before a clean direct-control close",
    { cleanupVerified: true }
  );

  await assert.rejects(
    () =>
      capturePhysicalSession(reservation.state, reservation.bootId, {
        now: () => "2026-08-03T00:01:00.000Z",
        loadPhysicalConfiguration: () => ({
          adapterName: "hci0",
          nodeId: "123e4567-e89b-12d3-a456-426614174000",
          helloCapabilities: 72,
          deviceRegistryPath: "/private/registry.json"
        }),
        radioLockPath: () => "/private/radio.lock",
        acquireKernelLock: async () => async () => {
          lockReleased = true;
        },
        snapshotRelevantServices: async () => {
          serviceSnapshots += 1;
          return ["bluetooth.service active"];
        },
        startTransientAdvertisement: () => ({
          waitUntilReady: async () => {},
          finish: async () => {},
          stop: async () => {
            advertisementStopped = true;
          }
        }),
        runPhysicalDirectControlSmoke: async (options) => {
          await options.onRegistered();
          throw timeout;
        }
      }),
    (error) =>
      error instanceof B5SessionCollectionError &&
      error.code === "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT" &&
      error.cleanupVerified === true
  );
  assert.equal(advertisementStopped, true);
  assert.equal(lockReleased, true);
  assert.equal(serviceSnapshots, 2);
});

test("collector marks timeout cleanup false when any cleanup stage fails", async () => {
  const initial = boundInitialState({
    now: "2026-08-03T00:00:00.000Z",
    campaignRunId: "00000000-0000-4000-8000-000000000001"
  });
  const reservation = reserveCaptureBootId(initial, { randomInt: () => 93 });
  const timeout = new B5DirectControlSmokeError(
    "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
    "physical capture ended before a clean direct-control close",
    { cleanupVerified: true }
  );

  await assert.rejects(
    () =>
      capturePhysicalSession(reservation.state, reservation.bootId, {
        now: () => "2026-08-03T00:01:00.000Z",
        loadPhysicalConfiguration: () => ({
          adapterName: "hci0",
          nodeId: "123e4567-e89b-12d3-a456-426614174000",
          helloCapabilities: 72,
          deviceRegistryPath: "/private/registry.json"
        }),
        radioLockPath: () => "/private/radio.lock",
        acquireKernelLock: async () => async () => {},
        snapshotRelevantServices: async () => ["bluetooth.service active"],
        startTransientAdvertisement: () => ({
          waitUntilReady: async () => {},
          finish: async () => {},
          stop: async () => {
            throw new Error("stop failed");
          }
        }),
        runPhysicalDirectControlSmoke: async (options) => {
          await options.onRegistered();
          throw timeout;
        }
      }),
    (error) =>
      error instanceof B5SessionCollectionError &&
      error.code === "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT" &&
      error.cleanupVerified === false
  );
});

test("status fails closed when the private state schema is corrupted", () => {
  const directory = temporaryDirectory("v6-b5-collector-corrupt-state-");
  try {
    const { statePath } = initCollector(directory);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({ ...state, injected: true }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );

    const child = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.notEqual(child.status, 0, child.stdout);
    assert.match(failureCode(child) ?? "", /STATE/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("finalize rejects an incomplete collection without creating a manifest", () => {
  const directory = temporaryDirectory("v6-b5-collector-incomplete-");
  try {
    const { statePath } = initCollector(directory);
    const manifestPath = path.join(directory, "private", "manifest.json");
    const child = spawnCollector(
      ["--finalize", "--state", statePath, "--manifest", manifestPath],
      { cwd: directory }
    );
    assert.notEqual(child.status, 0, child.stdout);
    assert.equal(fs.existsSync(manifestPath), false);
    assert.match(
      `${child.stdout}\n${child.stderr}`,
      /COLLECTION_INCOMPLETE|collection.*incomplete|requires.*100/iu
    );

    const state = parseCollectorState(fs.readFileSync(statePath, "utf8"));
    assert.throws(
      () => buildEvidenceManifest(state, statePath, manifestPath),
      (error) =>
        typeof error?.code === "string" &&
        /INCOMPLETE|COUNT|NOT_READY/u.test(error.code)
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI rejects arbitrary report and runner injection", () => {
  const directory = temporaryDirectory("v6-b5-collector-cli-injection-");
  try {
    const { statePath } = initCollector(directory);
    const before = fs.readFileSync(statePath);
    const fakeReport = path.join(directory, "attacker-report.json");
    const fakeRunner = path.join(directory, "attacker-runner.mjs");
    fs.writeFileSync(fakeReport, "{}\n", { mode: 0o600 });
    fs.writeFileSync(fakeRunner, "throw new Error('must not run');\n", {
      mode: 0o600
    });

    for (const [option, value] of [
      ["--report", fakeReport],
      ["--runner", fakeRunner]
    ]) {
      const child = spawnCollector(
        ["--capture", "--state", statePath, option, value],
        { cwd: directory }
      );
      assert.notEqual(child.status, 0, child.stdout);
      assert.match(
        `${child.stdout}\n${child.stderr}`,
        /INVALID_ARGUMENT|unknown (?:argument|option)|CLI option/iu
      );
      assert.deepEqual(fs.readFileSync(statePath), before);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI reserves every state-derived private path from public output", () => {
  const directory = temporaryDirectory("v6-b5-collector-path-collision-");
  try {
    const { statePath, androidBaselinePath } = initCollector(directory);
    const lockPath = `${statePath}.lock`;
    const lockBefore = fs.readFileSync(lockPath);
    for (const outputPath of [
      lockPath,
      `${statePath}.pending`,
      `${statePath}.evidence/session-001.json`,
      `${statePath}.tmp-1-00000000-0000-4000-8000-000000000001`,
      "/var/lib/cassav6-bluetooth/.b5-direct-control-radio-hci0.lock"
    ]) {
      const child = spawnCollector(
        ["--status", "--state", statePath, "--output", outputPath],
        { cwd: directory }
      );
      assert.notEqual(child.status, 0, child.stdout);
      assert.equal(failureCode(child), "INVALID_ARGUMENT");
      assert.deepEqual(fs.readFileSync(lockPath), lockBefore);
    }

    const child = spawnCollector(
      ["--finalize", "--state", statePath, "--manifest", `${statePath}.pending`],
      { cwd: directory }
    );
    assert.notEqual(child.status, 0, child.stdout);
    assert.equal(failureCode(child), "INVALID_ARGUMENT");

    const freshState = path.join(directory, "fresh", "state.json");
    const initCollision = spawnCollector(
      [
        "--init", "--state", freshState,
        "--android-baseline", androidBaselinePath,
        "--output", `${freshState}.lock`
      ],
      { cwd: directory }
    );
    assert.notEqual(initCollision.status, 0, initCollision.stdout);
    assert.equal(failureCode(initCollision), "INVALID_ARGUMENT");
    assert.equal(fs.existsSync(freshState), false);

    const reservedState =
      "/var/lib/cassav6-bluetooth/.b5-direct-control-radio-campaign.lock";
    const reservedInit = spawnCollector([
      "--init", "--state", reservedState,
      "--android-baseline", androidBaselinePath
    ], {
      cwd: directory
    });
    assert.notEqual(reservedInit.status, 0, reservedInit.stdout);
    assert.equal(failureCode(reservedInit), "INVALID_ARGUMENT");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("init rejects an invalid output before committing collector state", () => {
  const directory = temporaryDirectory("v6-b5-collector-output-preflight-");
  try {
    const statePath = path.join(directory, "private", "state.json");
    const androidBaselinePath = path.join(directory, "android-baseline.json");
    fs.writeFileSync(
      androidBaselinePath,
      `${JSON.stringify(privateBaselineFixture(
        "00000000-0000-4000-8000-000000000001"
      ))}\n`,
      { mode: 0o600 }
    );
    const child = spawnCollector(
      [
        "--init", "--state", statePath,
        "--android-baseline", androidBaselinePath,
        "--output", directory
      ],
      { cwd: directory }
    );
    assert.notEqual(child.status, 0, child.stdout);
    assert.equal(failureCode(child), "OUTPUT_PATH_INVALID");
    assert.equal(fs.existsSync(statePath), false);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("kernel lock rejects a concurrent collector and needs no stale-file reclaim", async () => {
  const directory = temporaryDirectory("v6-b5-collector-kernel-lock-");
  let holder = null;
  try {
    const { statePath, androidBaselinePath } = initCollector(directory);
    const lockPath = `${statePath}.lock`;
    holder = spawn("/usr/bin/flock", ["--exclusive", lockPath, "/bin/sleep", "1"], {
      stdio: "ignore"
    });
    let held = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = spawnSync(
        "/usr/bin/flock",
        ["--exclusive", "--nonblock", lockPath, "/bin/true"],
        { stdio: "ignore" }
      );
      if (probe.status === 1) {
        held = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(held, true, "external process did not acquire the test lock");

    const busy = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.notEqual(busy.status, 0, busy.stdout);
    assert.equal(failureCode(busy), "STATE_BUSY");

    await new Promise((resolve) => holder.once("close", resolve));
    holder = null;
    const resumed = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  } finally {
    holder?.kill("SIGKILL");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("status removes a pre-rename evidence temporary and remains resumable", () => {
  const directory = temporaryDirectory("v6-b5-collector-temp-recovery-");
  try {
    const { statePath } = initCollector(directory);
    const evidenceDirectory = `${statePath}.evidence`;
    fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
    const temporary = path.join(
      evidenceDirectory,
      "session-001.json.tmp-999-00000000-0000-4000-8000-000000000001"
    );
    fs.writeFileSync(temporary, "partial", { mode: 0o600 });

    const child = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(parseJsonOutput(child).progress.collectedSessions, 0);
    assert.equal(fs.existsSync(temporary), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("status rejects a broken evidence-directory symlink even for an empty state", () => {
  const directory = temporaryDirectory("v6-b5-collector-evidence-symlink-");
  try {
    const { statePath } = initCollector(directory);
    fs.symlinkSync(path.join(directory, "missing-target"), `${statePath}.evidence`);
    const child = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.notEqual(child.status, 0, child.stdout);
    assert.match(failureCode(child) ?? "", /RECOVERY|EVIDENCE|DIRECTORY/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("uncommitted journal evidence is discarded instead of promoted by status", () => {
  const directory = temporaryDirectory("v6-b5-collector-journal-no-promote-");
  try {
    const { statePath } = initCollector(directory);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const report = validPhysicalReportFixture(1);
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    const reportSha256 = crypto.createHash("sha256").update(reportBytes).digest("hex");
    const validated = validatePhysicalSessionReport({
      sequence: 1,
      sourceReportSha256: reportSha256,
      report
    });
    const generatedAtMs = Date.parse(validated.generatedAt);
    const record = {
      sequence: 1,
      slot: "001",
      evidenceRecordId: "00000000-0000-4000-8000-000000000001",
      runner: "B5_DIRECT_CONTROL_SMOKE_V1",
      reportSha256,
      generatedAt: validated.generatedAt,
      captureStartedAt: new Date(generatedAtMs - 60_000).toISOString(),
      captureCompletedAt: new Date(generatedAtMs + 1).toISOString(),
      sessionStartedAt: new Date(validated.captureStartMs).toISOString(),
      durationMs: validated.durationMs,
      pingsSent: validated.pingsSent,
      pongsVerified: validated.pongsVerified,
      heartbeatMisses: validated.heartbeatMisses,
      targetSignatureSha256: crypto
        .createHash("sha256")
        .update(validated.targetSignature)
        .digest("hex"),
      accountDeviceCommitmentSha256:
        state.accountDeviceCommitmentSha256
    };
    const journal = {
      schemaVersion: 1,
      harnessVersion: B5_SESSION_COLLECTOR_VERSION,
      product: "V6",
      phase: "B5",
      mode: "PHYSICAL_CAPTURE_COMMIT",
      campaignRunId: state.campaignRunId,
      record
    };
    const evidenceDirectory = `${statePath}.evidence`;
    fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
    const evidencePath = path.join(evidenceDirectory, "session-001.json");
    fs.writeFileSync(evidencePath, reportBytes, { mode: 0o600 });
    fs.writeFileSync(`${statePath}.pending`, `${JSON.stringify(journal, null, 2)}\n`, {
      mode: 0o600
    });

    const child = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(parseJsonOutput(child).progress.collectedSessions, 0);
    assert.equal(fs.existsSync(evidencePath), false);
    assert.equal(fs.existsSync(`${statePath}.pending`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("post-commit journal recovery verifies evidence and only removes the journal", () => {
  const directory = temporaryDirectory("v6-b5-collector-post-commit-");
  try {
    const { statePath } = initCollector(directory);
    const { state } = stageCollection(statePath, 1);
    const stateBefore = fs.readFileSync(statePath);
    const evidencePath = path.join(`${statePath}.evidence`, "session-001.json");
    const evidenceBefore = fs.readFileSync(evidencePath);
    fs.writeFileSync(
      `${statePath}.pending`,
      `${JSON.stringify(transactionJournal(state, state.records[0]), null, 2)}\n`,
      { mode: 0o600 }
    );

    const child = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(parseJsonOutput(child).progress.collectedSessions, 1);
    assert.equal(fs.existsSync(`${statePath}.pending`), false);
    assert.deepEqual(fs.readFileSync(statePath), stateBefore);
    assert.deepEqual(fs.readFileSync(evidencePath), evidenceBefore);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("journal without evidence is reported by preflight then safely discarded", () => {
  const directory = temporaryDirectory("v6-b5-collector-journal-no-evidence-");
  try {
    const { statePath } = initCollector(directory);
    const state = parseCollectorState(fs.readFileSync(statePath, "utf8"));
    const capture = fixtureCapture(1);
    const journalPath = `${statePath}.pending`;
    fs.writeFileSync(
      journalPath,
      `${JSON.stringify(transactionJournal(state, capture.record), null, 2)}\n`,
      { mode: 0o600 }
    );
    const journalBefore = fs.readFileSync(journalPath);

    const preflight = spawnCollector(["--preflight", "--state", statePath], {
      cwd: directory
    });
    assert.notEqual(preflight.status, 0, preflight.stdout);
    assert.equal(failureCode(preflight), "PREFLIGHT_RECOVERY_REQUIRED");
    assert.deepEqual(fs.readFileSync(journalPath), journalBefore);

    const recovered = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(parseJsonOutput(recovered).progress.collectedSessions, 0);
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.existsSync(`${statePath}.evidence/session-001.json`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("committed journal without evidence fails closed and remains recoverable", () => {
  const directory = temporaryDirectory("v6-b5-collector-committed-no-evidence-");
  try {
    const { statePath } = initCollector(directory);
    const { state } = stageCollection(statePath, 1);
    const journalPath = `${statePath}.pending`;
    fs.writeFileSync(
      journalPath,
      `${JSON.stringify(transactionJournal(state, state.records[0]), null, 2)}\n`,
      { mode: 0o600 }
    );
    fs.unlinkSync(path.join(`${statePath}.evidence`, "session-001.json"));
    const stateBefore = fs.readFileSync(statePath);
    const journalBefore = fs.readFileSync(journalPath);

    const child = spawnCollector(["--status", "--state", statePath], {
      cwd: directory
    });
    assert.notEqual(child.status, 0, child.stdout);
    assert.equal(failureCode(child), "STATE_RECOVERY_CONFLICT");
    assert.deepEqual(fs.readFileSync(statePath), stateBefore);
    assert.deepEqual(fs.readFileSync(journalPath), journalBefore);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("status rejects modified evidence and an unexpected inventory entry", () => {
  const directory = temporaryDirectory("v6-b5-collector-evidence-integrity-");
  try {
    const tamperDirectory = path.join(directory, "tamper");
    const inventoryDirectory = path.join(directory, "inventory");
    fs.mkdirSync(tamperDirectory, { mode: 0o700 });
    fs.mkdirSync(inventoryDirectory, { mode: 0o700 });
    const first = initCollector(tamperDirectory);
    stageCollection(first.statePath, 1);
    const evidencePath = path.join(`${first.statePath}.evidence`, "session-001.json");
    fs.appendFileSync(evidencePath, " ");
    const tampered = spawnCollector(["--status", "--state", first.statePath], {
      cwd: directory
    });
    assert.notEqual(tampered.status, 0, tampered.stdout);
    assert.equal(failureCode(tampered), "PRIVATE_EVIDENCE_HASH_MISMATCH");

    const second = initCollector(inventoryDirectory);
    stageCollection(second.statePath, 1);
    const unexpected = path.join(
      `${second.statePath}.evidence`,
      "session-999.json"
    );
    fs.writeFileSync(unexpected, "{}\n", { mode: 0o600 });
    const inventory = spawnCollector(["--status", "--state", second.statePath], {
      cwd: directory
    });
    assert.notEqual(inventory.status, 0, inventory.stdout);
    assert.equal(failureCode(inventory), "PRIVATE_EVIDENCE_CONFLICT");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("finalize accepts exactly 100 private reports with mode 0600 and no overwrite", () => {
  const directory = temporaryDirectory("v6-b5-collector-finalize-100-");
  try {
    const { statePath, androidBaselinePath } = initCollector(directory);
    const { state } = stageCollection(statePath, 100);
    const manifestPath = path.join(path.dirname(statePath), "manifest.json");
    const first = spawnCollector(
      ["--finalize", "--state", statePath, "--manifest", manifestPath],
      { cwd: directory }
    );
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const progress = parseJsonOutput(first);
    assert.equal(progress.verdict, "READY");
    assert.equal(progress.progress.collectedSessions, 100);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.reports.length, 100);
    assert.equal(JSON.stringify(manifest).includes("bootId"), false);
    assert.deepEqual(
      manifest,
      buildEvidenceManifest(state, statePath, manifestPath)
    );
    if (process.platform === "linux") {
      assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(`${statePath}.evidence`).mode & 0o777, 0o700);
      for (const { slot } of manifest.reports) {
        assert.equal(
          fs.statSync(path.join(`${statePath}.evidence`, `session-${slot}.json`))
            .mode & 0o777,
          0o600
        );
      }
    }

    const manifestBefore = fs.readFileSync(manifestPath);
    const inodeBefore = fs.statSync(manifestPath).ino;
    const repeated = spawnCollector(
      ["--finalize", "--state", statePath, "--manifest", manifestPath],
      { cwd: directory }
    );
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
    assert.equal(fs.statSync(manifestPath).ino, inodeBefore);

    const conflictingBytes = Buffer.from("{}\n");
    fs.writeFileSync(manifestPath, conflictingBytes, { mode: 0o600 });
    const conflict = spawnCollector(
      ["--finalize", "--state", statePath, "--manifest", manifestPath],
      { cwd: directory }
    );
    assert.notEqual(conflict.status, 0, conflict.stdout);
    assert.equal(failureCode(conflict), "MANIFEST_CONFLICT");
    assert.deepEqual(fs.readFileSync(manifestPath), conflictingBytes);

    const stateBefore = fs.readFileSync(statePath);
    const duplicateInit = spawnCollector([
      "--init", "--state", statePath,
      "--android-baseline", androidBaselinePath
    ], {
      cwd: directory
    });
    assert.notEqual(duplicateInit.status, 0, duplicateInit.stdout);
    assert.equal(failureCode(duplicateInit), "STATE_ALREADY_EXISTS");
    assert.deepEqual(fs.readFileSync(statePath), stateBefore);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("collector keeps the rotating alias out of child process arguments", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  assert.equal(source.includes('"--alias-stdin"'), true);
  assert.equal(/"--alias"\s*,\s*alias/u.test(source), false);
  assert.match(source, /child\.stdin\.end\(`\$\{alias\}\\n`\)/u);
});

test("API31 staging copies one byte-exact private registry and preflights without radio", async () => {
  const directory = temporaryDirectory("cassav6-api31-staging-copy-");
  try {
    const source = await createEnrollmentRegistry(directory, 2);
    const destination = path.join(
      directory,
      "staging",
      "devices-api31.json"
    );
    const sourceBytes = fs.readFileSync(source);
    const copied = await prepareApi31StagingRegistrySnapshot(
      source,
      destination,
      { now: () => "2026-08-18T00:00:00.000Z" }
    );
    assert.equal(copied.mode, "API31_STAGING_REGISTRY_COPY");
    assert.equal(copied.verdict, "READY");
    assert.equal(copied.registry.snapshotCreated, true);
    assert.equal(copied.registry.activeP256IdentityCount, 1);
    assert.equal(copied.registry.boundEnrollmentV2IdentityCount, 1);
    assert.deepEqual(fs.readFileSync(destination), sourceBytes);
    if (process.platform === "linux") {
      assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(destination)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(destination).nlink, 1);
    }

    const summary = await inspectApi31StagingRegistry(destination);
    assert.equal(summary.schemaVersion, 2);
    assert.equal(summary.activeP256IdentityCount, 1);
    const preflight = await runApi31StagingPreflight({
      adapterName: "hci0",
      serverNodeId: "123e4567-e89b-42d3-a456-426614174000",
      holdMs: 60_000,
      registryPath: destination
    }, {
      now: () => "2026-08-18T00:01:00.000Z"
    });
    assert.equal(preflight.mode, "API31_STAGING_PREFLIGHT");
    assert.equal(preflight.verdict, "READY");
    assert.equal(preflight.protocol.helloWireVersion, 1);
    assert.equal(preflight.protocol.enrollmentVersion, 2);
    assert.equal(preflight.protocol.identityAlgorithm, "EC-P256");
    assert.equal(preflight.physicalRadioAccessed, false);

    const repeated = await prepareApi31StagingRegistrySnapshot(
      source,
      destination,
      { now: () => "2026-08-18T00:02:00.000Z" }
    );
    assert.equal(repeated.registry.snapshotCreated, false);
    assert.deepEqual(fs.readFileSync(destination), sourceBytes);

    const encoded = JSON.stringify({ copied, preflight, repeated });
    assert.equal(encoded.includes(source), false);
    assert.equal(encoded.includes(destination), false);
    assert.doesNotMatch(encoded, /123e4567-e89b-42d3-a456-426614174031/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("API31 staging CLI performs copy and radio-free preflight only", async () => {
  const directory = temporaryDirectory("cassav6-api31-staging-cli-");
  try {
    const source = await createEnrollmentRegistry(directory, 2);
    const destination = path.join(directory, "staging", "devices.json");
    const stage = spawnCollector([
      "--stage-registry",
      "--source-registry",
      source,
      "--registry",
      destination
    ]);
    assert.equal(stage.status, 0, stage.stderr || stage.stdout);
    const stageReport = parseJsonOutput(stage);
    assert.equal(stageReport.mode, "API31_STAGING_REGISTRY_COPY");
    assert.equal(stageReport.verdict, "READY");

    const preflight = spawnCollector([
      "--staging-preflight",
      "--registry",
      destination,
      "--server-node-id",
      "123e4567-e89b-42d3-a456-426614174000",
      "--adapter",
      "hci0"
    ]);
    assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
    const preflightReport = parseJsonOutput(preflight);
    assert.equal(preflightReport.mode, "API31_STAGING_PREFLIGHT");
    assert.equal(preflightReport.verdict, "READY");
    assert.equal(preflightReport.physicalRadioAccessed, false);
    assert.equal(preflightReport.v6ProductionServiceChanges, false);

    const missingOutput = spawnCollector([
      "--staging-session",
      "--registry",
      destination,
      "--server-node-id",
      "123e4567-e89b-42d3-a456-426614174000"
    ]);
    assert.notEqual(missingOutput.status, 0);
    assert.equal(failureCode(missingOutput), "INVALID_ARGUMENT");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("API31 staging rejects linked, conflicting and non-P256 registry snapshots", async () => {
  const directory = temporaryDirectory("cassav6-api31-staging-reject-");
  try {
    const linkedSource = await createEnrollmentRegistry(directory, 2);
    const hardlink = path.join(directory, "registry-hardlink.json");
    fs.linkSync(linkedSource, hardlink);
    await assert.rejects(
      prepareApi31StagingRegistrySnapshot(
        linkedSource,
        path.join(directory, "staging-linked", "devices.json")
      ),
      (error) =>
        error instanceof B5SessionCollectionError &&
        error.code === "STAGING_REGISTRY_SOURCE_INVALID"
    );
    fs.unlinkSync(hardlink);

    const destination = path.join(directory, "staging-conflict", "devices.json");
    fs.mkdirSync(path.dirname(destination), { mode: 0o700 });
    fs.writeFileSync(destination, "{}\n", { mode: 0o600 });
    await assert.rejects(
      prepareApi31StagingRegistrySnapshot(linkedSource, destination),
      (error) =>
        error instanceof B5SessionCollectionError &&
        error.code === "STAGING_REGISTRY_CONFLICT"
    );
    assert.equal(fs.readFileSync(destination, "utf8"), "{}\n");

    const legacyOnly = await createEnrollmentRegistry(directory, 1);
    const rejectedDestination = path.join(
      directory,
      "staging-v1",
      "devices.json"
    );
    await assert.rejects(
      prepareApi31StagingRegistrySnapshot(
        legacyOnly,
        rejectedDestination
      ),
      (error) =>
        error instanceof B5SessionCollectionError &&
        error.code === "STAGING_P256_IDENTITY_UNAVAILABLE"
    );
    assert.equal(fs.existsSync(rejectedDestination), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("API31 staging coordinates one boot identity across GATT and advertiser", async () => {
  const calls = [];
  const seen = { runnerBootId: null, advertiserBootId: null, sequence: null };
  const randomValues = [81, 19];
  const report = await runApi31StagingDirectControl(
    {
      adapterName: "hci0",
      serverNodeId: "123e4567-e89b-42d3-a456-426614174000",
      holdMs: 60_000,
      registryPath: "/tmp/cassav6-api31-staging/devices.json"
    },
    {
      now: () => "2026-08-18T00:03:00.000Z",
      runPreflight: async () => {
        calls.push("preflight");
        return stagingPreflightFixture();
      },
      snapshotStagingRegistry: async () => Buffer.from("registry-snapshot"),
      randomInt: (minimum, maximum) => {
        calls.push(`random:${minimum}:${maximum}`);
        return randomValues.shift();
      },
      radioLockPath: () => "/tmp/cassav6-api31-staging/radio.lock",
      acquireKernelLock: async () => {
        calls.push("lock");
        return async () => calls.push("unlock");
      },
      snapshotStagingServices: async () => {
        calls.push("services");
        return ["services-unchanged"];
      },
      startTransientAdvertisement: ({ bootId, sequence }) => {
        calls.push("advertiser:start");
        seen.advertiserBootId = bootId;
        seen.sequence = sequence;
        return {
          waitUntilReady: async () => calls.push("advertiser:ready"),
          finish: async () => calls.push("advertiser:finish"),
          stop: async () => calls.push("advertiser:stop")
        };
      },
      runPhysicalDirectControlSmoke: async (options) => {
        calls.push("gatt:start");
        seen.runnerBootId = options.bootId;
        await options.onRegistered();
        calls.push("gatt:complete");
        return validPhysicalReportFixture(1);
      }
    }
  );
  assert.deepEqual(seen, {
    runnerBootId: 81,
    advertiserBootId: 81,
    sequence: 19
  });
  assert.deepEqual(calls, [
    "preflight",
    "random:1:256",
    "random:0:256",
    "lock",
    "services",
    "gatt:start",
    "advertiser:start",
    "advertiser:ready",
    "gatt:complete",
    "advertiser:finish",
    "services",
    "unlock"
  ]);
  assert.equal(report.mode, "API31_STAGING_PHYSICAL_NON_GATE");
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(report.observed.pingsSent, 4);
  assert.equal(report.observed.pongsVerified, 4);
  assert.equal(report.observed.cleanCloses, 1);
  assert.equal(report.gate.b5HundredSessionGate, "PENDING");
  assert.equal(report.authoritativeB5GateExecuted, false);
  const encoded = JSON.stringify(report);
  assert.doesNotMatch(encoded, /boot.?id/iu);
  assert.equal(encoded.includes("/tmp/"), false);
  assert.equal(encoded.includes("123e4567-e89b-42d3-a456-426614174000"), false);
});

test("API31 staging verifies cleanup on timeout and fails on service restart evidence", async () => {
  const options = {
    adapterName: "hci0",
    serverNodeId: "123e4567-e89b-42d3-a456-426614174000",
    holdMs: 60_000,
    registryPath: "/tmp/cassav6-api31-staging/devices.json"
  };
  let advertisementStopped = false;
  let lockReleased = false;
  const timeout = new B5DirectControlSmokeError(
    "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
    "physical capture ended before a clean direct-control close",
    { cleanupVerified: true }
  );
  await assert.rejects(
    runApi31StagingDirectControl(options, {
      runPreflight: async () => stagingPreflightFixture(),
      snapshotStagingRegistry: async () => Buffer.from("registry-snapshot"),
      randomInt: (minimum) => minimum,
      radioLockPath: () => "/tmp/cassav6-api31-staging/radio.lock",
      acquireKernelLock: async () => async () => {
        lockReleased = true;
      },
      snapshotStagingServices: async () => ["services-unchanged"],
      startTransientAdvertisement: () => ({
        waitUntilReady: async () => {},
        finish: async () => {},
        stop: async () => {
          advertisementStopped = true;
        }
      }),
      runPhysicalDirectControlSmoke: async (received) => {
        await received.onRegistered();
        throw timeout;
      }
    }),
    (error) =>
      error instanceof B5SessionCollectionError &&
      error.code === "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT" &&
      error.cleanupVerified === true
  );
  assert.equal(advertisementStopped, true);
  assert.equal(lockReleased, true);

  let snapshots = 0;
  lockReleased = false;
  await assert.rejects(
    runApi31StagingDirectControl(options, {
      runPreflight: async () => stagingPreflightFixture(),
      snapshotStagingRegistry: async () => Buffer.from("registry-snapshot"),
      randomInt: (minimum) => minimum,
      radioLockPath: () => "/tmp/cassav6-api31-staging/radio.lock",
      acquireKernelLock: async () => async () => {
        lockReleased = true;
      },
      snapshotStagingServices: async () => [
        snapshots++ === 0 ? "pid=100,restarts=0" : "pid=101,restarts=1"
      ],
      startTransientAdvertisement: () => ({
        waitUntilReady: async () => {},
        finish: async () => {},
        stop: async () => {}
      }),
      runPhysicalDirectControlSmoke: async (received) => {
        await received.onRegistered();
        return validPhysicalReportFixture(1);
      }
    }),
    (error) =>
      error instanceof B5SessionCollectionError &&
      error.code === "PRODUCTION_SERVICE_CHANGED"
  );
  assert.equal(lockReleased, true);
});

test("module import has no CLI or filesystem side effects", () => {
  const directory = temporaryDirectory("v6-b5-collector-import-");
  try {
    const moduleUrl = pathToFileURL(SCRIPT_PATH).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-"], {
      cwd: directory,
      input: `await import(${JSON.stringify(moduleUrl)}); process.stdout.write("IMPORTED");\n`,
      encoding: "utf8"
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "IMPORTED");
    assert.equal(child.stderr, "");
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
