import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  B4OfflineHybridNonGateError,
  buildB4OfflineHybridNonGateReport,
  runB4OfflineHybridNonGate,
  runSelfTest
} from "./run-b4-offline-hybrid-non-gate.mjs";
import {
  createInitialState,
  deriveDeviceDigest,
  recordEvidence,
  withB4CollectionStateLock
} from "./collect-b4-physical-device.mjs";
import {
  ADVANCED_CERTIFICATION_TARGETS
} from "./advanced-certification-targets.mjs";
import {
  buildB4TargetHardwareCommitmentFromDeviceDigest
} from "./run-b4-monitored-slot-gate.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./run-b4-offline-hybrid-non-gate.mjs", import.meta.url)
);
const NOW = "2026-08-06T00:00:00.000Z";
const RUN_ID = "10000000-0000-4000-8000-000000000001";
const IDENTITY_KEY = Buffer.alloc(32, 0x4a);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function uuidFor(prefix, index) {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function buildPhysicalState(recordCount = 2) {
  let state = createInitialState({
    now: NOW,
    runId: RUN_ID,
    identityKey: Buffer.from(IDENTITY_KEY)
  });
  for (let index = 1; index <= recordCount; index += 1) {
    const deviceDigest = deriveDeviceDigest(
      IDENTITY_KEY,
      `PRIVATE-SERIAL-${String(index).padStart(2, "0")}`
    );
    const captureRunId = uuidFor("20000000", index);
    const monitorEvidence = {
      collectionRunCommitmentSha256: sha256(
        `V5BT:B4:COLLECTION_RUN:${state.runId}`
      ),
      captureRunCommitmentSha256: sha256(
        `V5BT:B4:CAPTURE_RUN:${captureRunId}`
      ),
      captureRunId,
      certificationMatrixSha256:
        state.certificationMatrixBinding.matrixSha256,
      androidAttestationSha256: sha256(`android-${index}`),
      raspberryAttestationSha256: sha256(`raspberry-${index}`),
      targetPackageName:
        ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId,
      targetAndroidApi: 36,
      targetHardwareCommitmentSha256:
        buildB4TargetHardwareCommitmentFromDeviceDigest({
          identityKey: IDENTITY_KEY,
          deviceDigest,
          captureRunId
        }),
      coverageStartedAt: new Date(Date.parse(NOW) - 90_000).toISOString(),
      coverageCompletedAt: NOW
    };
    state = recordEvidence(state, {
      deviceDigest,
      packageName: ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId,
      model: `PRIVATE_MODEL_${index}`,
      androidApi: 36,
      androidEvidence: { sampledAt: NOW, sampleSequence: index },
      raspberryEvidence: {
        reportHash: sha256(`physical-report-${index}`),
        logHash: sha256(`physical-log-${index}`),
        generatedAt: NOW,
        generatedAtMs: Date.parse(NOW),
        observationsAccepted: 200 + index,
        lifecycleDurationMs: 90_000,
        wallClockDurationMs: 90_000,
        rssiDbm: { minimum: -70, maximum: -50, samples: 2 }
      },
      monitorEvidence,
      recordedAt: NOW,
      evidenceRecordId: uuidFor("30000000", index)
    }).state;
  }
  return state;
}

function createPrivateStateFile(directory, state = buildPhysicalState()) {
  const statePath = path.join(directory, "physical-b4-state.json");
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600
  });
  fs.chmodSync(statePath, 0o600);
  return statePath;
}

function temporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-b4-hybrid-non-gate-")
  );
  fs.chmodSync(directory, 0o700);
  return directory;
}

test("2 physical plus 8 in-memory devices pass only the non-gate exercise", () => {
  const report = buildB4OfflineHybridNonGateReport(buildPhysicalState(), {
    randomBytes: (size) => Buffer.alloc(size, 0x6b)
  });
  assert.equal(report.evidenceClass, "NON_GATE_EVIDENCE");
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(report.gateImpact, "NONE");
  assert.equal(report.simulation.kind, "HYBRID_TWO_PHYSICAL_EIGHT_IN_MEMORY");
  assert.equal(report.simulation.verdict, "PASS");
  assert.equal(report.simulation.physicalRecordsReadOnly, 2);
  assert.equal(report.simulation.simulatedDevicesInMemory, 8);
  assert.deepEqual(report.simulation.simulatedSlots, [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(report.simulation.logicalAggregateChecks, {
    slotsEvaluated: 10,
    orderValid: true,
    uniquenessValid: true,
    privateHashChainEvaluated: true,
    privateHashChainExported: false,
    redactedPlanSha256:
      report.simulation.logicalAggregateChecks.redactedPlanSha256
  });
  assert.equal(report.gates.distinctPhysicalDevices, 2);
  assert.equal(report.gates.simulatedDevicesCountedTowardGate, 0);
  assert.equal(report.gates.remainingDistinctPhysicalDevices, 8);
  assert.equal(report.gates.b4TenPhysicalDeviceGate, "PENDING");
  assert.equal(report.gates.b5HundredSessionGate, "PENDING");
  assert.equal(report.gates.b6AndroidPairGate, "BLOCKED");
  assert.equal(report.authorization.b5_7DiagnosticPilotAuthorized, false);
  assert.equal(report.authorization.b5OfficialCampaignAuthorized, false);
  assert.equal(report.effects.physicalStateWritten, false);
  assert.equal(report.effects.simulatedStatePersisted, false);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.gates), true);
  assert.throws(() => {
    report.gates.b4TenPhysicalDeviceGate = "PASS";
  }, TypeError);
});

test("rejects any physical or simulated count other than 2 plus 8", () => {
  assert.throws(
    () => buildB4OfflineHybridNonGateReport(buildPhysicalState(1)),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "PHYSICAL_COUNT_MISMATCH" &&
      error.exitCode === 2
  );
  assert.throws(
    () =>
      buildB4OfflineHybridNonGateReport(buildPhysicalState(), {
        simulatedCount: 7
      }),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "SIMULATED_COUNT_INVALID" &&
      error.exitCode === 2
  );
});

test("reads the private state without changing a byte and rejects mutation", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = createPrivateStateFile(directory);
  const before = fs.readFileSync(statePath);
  const report = await runB4OfflineHybridNonGate(statePath, {
    beforeStabilityCheck: async () => {
      const lockPath = `${statePath}.lock`;
      const lockStatus = fs.lstatSync(lockPath);
      assert.equal(lockStatus.isFile(), true);
      if (process.platform !== "win32") {
        assert.equal(lockStatus.mode & 0o777, 0o600);
      }
      await assert.rejects(
        withB4CollectionStateLock(statePath, async () => undefined),
        (error) => error.code === "STATE_BUSY"
      );
    }
  });
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.deepEqual(fs.readFileSync(statePath), before);
  assert.equal(fs.existsSync(`${statePath}.lock`), false);

  await assert.rejects(
    runB4OfflineHybridNonGate(statePath, {
      beforeStabilityCheck: async () => {
        fs.appendFileSync(statePath, " ");
      }
    }),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "STATE_CHANGED_DURING_SIMULATION"
  );
});

test("rejects state files with unsafe permissions, symlinks or hardlinks", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const permissive = createPrivateStateFile(directory);
  fs.chmodSync(permissive, 0o640);
  await assert.rejects(
    runB4OfflineHybridNonGate(permissive),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "STATE_NOT_PRIVATE"
  );
  fs.rmSync(permissive);

  const target = createPrivateStateFile(directory);
  const symbolic = path.join(directory, "state-symbolic.json");
  fs.symlinkSync(target, symbolic);
  await assert.rejects(
    runB4OfflineHybridNonGate(symbolic),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "STATE_READ_FAILED"
  );
  fs.rmSync(symbolic);

  const linked = path.join(directory, "state-hardlink.json");
  fs.linkSync(target, linked);
  await assert.rejects(
    runB4OfflineHybridNonGate(target),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "STATE_READ_FAILED"
  );
});

test("publishes mode 0600 durably and rolls back every failed publication", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateDirectory = path.join(directory, "physical");
  const outputDirectory = path.join(directory, "non-gate");
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const statePath = createPrivateStateFile(stateDirectory);
  const output = path.join(outputDirectory, "report.json");
  await runB4OfflineHybridNonGate(statePath, { outputPath: output });
  const status = fs.lstatSync(output);
  assert.equal(status.isFile(), true);
  assert.equal(status.nlink, 1);
  if (process.platform !== "win32") {
    assert.equal(status.mode & 0o777, 0o600);
  }
  const firstBytes = fs.readFileSync(output);
  await assert.rejects(
    runB4OfflineHybridNonGate(statePath, { outputPath: output }),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "OUTPUT_ALREADY_EXISTS"
  );
  assert.deepEqual(fs.readFileSync(output), firstBytes);

  const linkTarget = path.join(directory, "link-target.json");
  fs.writeFileSync(linkTarget, "protected\n", { mode: 0o600 });
  const symbolic = path.join(directory, "symbolic-output.json");
  fs.symlinkSync(linkTarget, symbolic);
  await assert.rejects(
    runB4OfflineHybridNonGate(statePath, { outputPath: symbolic }),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "OUTPUT_PATH_UNSAFE"
  );
  assert.equal(fs.readFileSync(linkTarget, "utf8"), "protected\n");

  const hardlink = path.join(directory, "hardlink-output.json");
  fs.linkSync(linkTarget, hardlink);
  await assert.rejects(
    runB4OfflineHybridNonGate(statePath, { outputPath: hardlink }),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "OUTPUT_PATH_UNSAFE"
  );
  assert.equal(fs.readFileSync(linkTarget, "utf8"), "protected\n");

  const linkedDirectory = path.join(directory, "linked-directory");
  const realDirectory = path.join(directory, "real-directory");
  fs.mkdirSync(realDirectory, { mode: 0o700 });
  fs.symlinkSync(realDirectory, linkedDirectory);
  await assert.rejects(
    runB4OfflineHybridNonGate(statePath, {
      outputPath: path.join(linkedDirectory, "report.json")
    }),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "OUTPUT_PATH_UNSAFE"
  );

  const rollbackOutput = path.join(outputDirectory, "rollback.json");
  await assert.rejects(
    runB4OfflineHybridNonGate(statePath, {
      outputPath: rollbackOutput,
      afterOutputPublish: (destination) => fs.chmodSync(destination, 0o640)
    }),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "OUTPUT_WRITE_FAILED"
  );
  assert.equal(fs.existsSync(rollbackOutput), false);
  assert.deepEqual(
    fs.readdirSync(outputDirectory).filter((name) => name.includes(".tmp-")),
    []
  );

  const earlyFailureOutput = path.join(outputDirectory, "early-failure.json");
  await assert.rejects(
    runB4OfflineHybridNonGate(statePath, {
      outputPath: earlyFailureOutput,
      afterTemporaryOpen: () => {
        throw new Error("injected early output failure");
      }
    }),
    (error) =>
      error instanceof B4OfflineHybridNonGateError &&
      error.code === "OUTPUT_WRITE_FAILED"
  );
  assert.equal(fs.existsSync(earlyFailureOutput), false);
  assert.deepEqual(
    fs.readdirSync(outputDirectory).filter((name) => name.includes(".tmp-")),
    []
  );
});

test("exported report redacts every private identity, hash, timestamp and path", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = buildPhysicalState();
  const statePath = createPrivateStateFile(directory, state);
  const report = await runB4OfflineHybridNonGate(statePath);
  const serialized = JSON.stringify(report);
  const privateValues = new Set([
    state.runId,
    state.createdAt,
    state.updatedAt,
    state.identityKeyBase64Url,
    state.certificationMatrixBinding.matrixSha256,
    statePath
  ]);
  for (const record of state.records) {
    privateValues.add(record.evidenceRecordId);
    privateValues.add(record.deviceDigest);
    privateValues.add(record.recordedAt);
    privateValues.add(record.androidSampledAt);
    privateValues.add(record.raspberryGeneratedAt);
    privateValues.add(record.raspberryReportSha256);
    privateValues.add(record.raspberryLogSha256);
    privateValues.add(record.monitorEvidence.captureRunId);
    privateValues.add(record.monitorEvidence.androidAttestationSha256);
    privateValues.add(record.monitorEvidence.raspberryAttestationSha256);
  }
  for (const value of privateValues) {
    assert.equal(serialized.includes(value), false, `private value leaked: ${value}`);
  }
  assert.equal(serialized.includes("deviceDigest"), false);
  assert.equal(serialized.includes("evidenceRecordId"), false);
  assert.equal(serialized.includes("captureRunId"), false);
  assert.equal(report.privacy.physicalIdentifiersIncluded, false);
  assert.equal(report.privacy.physicalEvidenceHashesIncluded, false);
  assert.equal(report.privacy.physicalEvidenceTimestampsIncluded, false);
  assert.equal(report.privacy.filesystemLocationsIncluded, false);
});

test("CLI run and self-test are redacted, deterministic in contract and no-overwrite", (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateDirectory = path.join(directory, "physical");
  const outputDirectory = path.join(directory, "non-gate");
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const statePath = createPrivateStateFile(stateDirectory);
  const output = path.join(outputDirectory, "cli-report.json");
  const stateBefore = fs.readFileSync(statePath);

  const selfTest = spawnSync(process.execPath, [SCRIPT_PATH, "--self-test"], {
    encoding: "utf8"
  });
  assert.equal(selfTest.status, 0, selfTest.stderr || selfTest.stdout);
  const selfReport = JSON.parse(selfTest.stdout);
  assert.deepEqual(runSelfTest(), selfReport);
  assert.equal(selfReport.gateImpact, "NONE");
  assert.equal(selfReport.evidenceClass, "NON_GATE_EVIDENCE");
  assert.equal(selfReport.simulationKind, "FULLY_SYNTHETIC_SELF_TEST");
  assert.equal(selfReport.gates.b4TenPhysicalDeviceGate, "PENDING");

  const run = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--run", "--state", statePath, "--output", output],
    { encoding: "utf8" }
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const stdoutReport = JSON.parse(run.stdout);
  const storedReport = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.deepEqual(storedReport, stdoutReport);
  assert.equal(storedReport.verdict, "NON_GATE_PASS");
  assert.equal(storedReport.gates.simulatedDevicesCountedTowardGate, 0);
  assert.deepEqual(fs.readFileSync(statePath), stateBefore);

  const secondRun = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--run", "--state", statePath, "--output", output],
    { encoding: "utf8" }
  );
  assert.notEqual(secondRun.status, 0);
  const failure = JSON.parse(secondRun.stdout);
  assert.equal(failure.failure.code, "OUTPUT_ALREADY_EXISTS");
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), storedReport);

  const forbiddenOutput = path.join(stateDirectory, "forbidden.json");
  const forbidden = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--run", "--state", statePath, "--output", forbiddenOutput],
    { encoding: "utf8" }
  );
  assert.notEqual(forbidden.status, 0);
  assert.equal(JSON.parse(forbidden.stdout).failure.code, "OUTPUT_NOT_SEPARATED");
  assert.equal(fs.existsSync(forbiddenOutput), false);

  const packageOutput = path.resolve(
    path.dirname(SCRIPT_PATH),
    "..",
    "reports",
    "physical",
    `.forbidden-hybrid-${process.pid}.json`
  );
  assert.equal(fs.existsSync(packageOutput), false);
  const packageWrite = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--run", "--state", statePath, "--output", packageOutput],
    { encoding: "utf8" }
  );
  assert.notEqual(packageWrite.status, 0);
  assert.equal(JSON.parse(packageWrite.stdout).failure.code, "OUTPUT_NOT_SEPARATED");
  assert.equal(fs.existsSync(packageOutput), false);

  const help = spawnSync(process.execPath, [SCRIPT_PATH, "--help"], {
    encoding: "utf8"
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /simulates eight additional/u);
});
