import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  B4RaspberryContinuityError,
  advanceB4RaspberryRunnerLifecycle,
  assertB4RaspberryCleanBaseline,
  assertB4RaspberryCleanup,
  assertB4RaspberryContinuity,
  buildB4RunCommitments,
  buildB4RaspberryRemoteCommand,
  buildB4RaspberryContinuityAttestation,
  parseB4RaspberryContinuityAttestation,
  parseB4RaspberryMonitorArguments,
  parseB4RaspberrySnapshot,
  runB4RaspberryContinuityMonitor,
} from "../scripts/run-v5bt-b4-raspberry-continuity-monitor.mjs";

const COLLECTION_RUN_ID = "00000000-0000-4000-8000-000000000001";
const CAPTURE_RUN_ID = "00000000-0000-4000-8000-000000000002";
const MATRIX_SHA256 = "a".repeat(64);
const JOURNAL_SHA256 = "b".repeat(64);
const RELEASE_MANIFEST_SHA256 = "c".repeat(64);
const RELEASE_PATH =
  "/opt/cassav5bt-bluetooth-lab/releases/20260805-b4-readiness-matrix3-r2";
const BOOT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_BOOT_ID = "20000000-0000-4000-8000-000000000002";
const START_MS = Date.parse("2026-08-05T10:00:00.000Z");
const START_NS = 1_786_010_400_000_000_000n;
const FRAME = "--V5BT-B4-MONITOR-SPLIT--";

function service(pid, restarts, active, started) {
  return [
    "ActiveState=active",
    "SubState=running",
    `MainPID=${pid}`,
    `NRestarts=${restarts}`,
    `ActiveEnterTimestampMonotonic=${active}`,
    `ExecMainStartTimestampMonotonic=${started}`,
  ].join("\n");
}

function rawSnapshot({
  clockMs = 0,
  bootId = BOOT_ID,
  mainPid = 101,
  mainRestarts = 0,
  bluetoothPid = 202,
  bluetoothRestarts = 0,
  discovering = false,
  activeAdvertisers = 0,
  temporaryRunners = 0,
  matchingRunners = temporaryRunners === 1 ? 1 : 0,
  runnerIdentity = matchingRunners === 1
    ? "303:5000"
    : matchingRunners > 1
      ? "multiple"
      : "none",
  releaseVerified = true,
  releaseManifestSha256 = RELEASE_MANIFEST_SHA256,
} = {}) {
  return [
    String(START_NS + BigInt(clockMs) * 1_000_000n),
    bootId,
    service(mainPid, mainRestarts, 1_000, 900),
    service(bluetoothPid, bluetoothRestarts, 2_000, 1_900),
    [
      `Discovering=${discovering ? "yes" : "no"}`,
      `ActiveAdvertisers=${activeAdvertisers}`,
      `TemporaryRunners=${temporaryRunners}`,
      `MatchingRunners=${matchingRunners}`,
      `RunnerIdentity=${runnerIdentity}`,
      `ReleaseVerified=${releaseVerified ? "yes" : "no"}`,
      `ReleaseManifestSha256=${releaseManifestSha256}`,
    ].join("\n"),
  ].join(`\n${FRAME}\n`);
}

function throwsCode(action, code) {
  assert.throws(
    action,
    (error) => error instanceof B4RaspberryContinuityError && error.code === code,
    `expected ${code}`,
  );
}

async function rejectsCode(action, code) {
  await assert.rejects(
    action,
    (error) => error instanceof B4RaspberryContinuityError && error.code === code,
    `expected ${code}`,
  );
}

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function fixedOptions(directory, overrides = {}) {
  return {
    ssh: "ssh",
    host: "test-host",
    user: "admin",
    pollMs: 2_000,
    collectionRunId: COLLECTION_RUN_ID,
    captureRunId: CAPTURE_RUN_ID,
    certificationMatrixSha256: MATRIX_SHA256,
    runnerReleasePath: RELEASE_PATH,
    runnerReleaseManifestSha256: RELEASE_MANIFEST_SHA256,
    privateOutput: path.join(directory, "private.jsonl"),
    attestation: path.join(directory, "attestation.json"),
    durationMs: 90_000,
    stopFile: null,
    maximumMs: null,
    help: false,
    ...overrides,
  };
}

function simulatedRuntime({ snapshotForClock, sleepForPoll, stopSignaled, afterSample } = {}) {
  let clockMs = 0;
  return {
    monotonicNow: () => clockMs,
    nowDate: () => new Date(START_MS + clockMs),
    sleep: async (delayMs) => {
      clockMs += sleepForPoll?.(delayMs, clockMs) ?? delayMs;
    },
    capture: async () =>
      parseB4RaspberrySnapshot(
        rawSnapshot(
          snapshotForClock?.(clockMs) ??
            (clockMs === 0
              ? { clockMs }
              : clockMs < 90_000
                ? { clockMs, discovering: true, temporaryRunners: 1 }
                : { clockMs }),
        ),
      ),
    stopSignaled: stopSignaled === undefined ? undefined : () => stopSignaled(clockMs),
    afterSample,
    clock: () => clockMs,
  };
}

function validAttestation() {
  return buildB4RaspberryContinuityAttestation({
    collectionRunId: COLLECTION_RUN_ID,
    captureRunId: CAPTURE_RUN_ID,
    certificationMatrixSha256: MATRIX_SHA256,
    privateJournalSha256: JOURNAL_SHA256,
    monitoredFrom: "2026-08-05T10:00:00.000Z",
    runnerObservedAt: "2026-08-05T10:00:02.000Z",
    cleanupObservedAt: "2026-08-05T10:01:30.000Z",
    monitoredUntil: "2026-08-05T10:01:30.000Z",
    durationMs: 90_000,
    pollMs: 2_000,
    sampleCount: 46,
    maximumObservedGapMs: 2_000,
    runnerActiveSamples: 44,
    generatedAt: "2026-08-05T10:01:30.000Z",
  });
}

test("parses the fixed service and radio snapshot", () => {
  const snapshot = parseB4RaspberrySnapshot(
    rawSnapshot({ discovering: true, temporaryRunners: 1 }),
  );
  assert.equal(snapshot.services.length, 2);
  assert.deepEqual(snapshot.radio, {
    discovering: true,
    activeAdvertisers: 0,
    temporaryRunners: 1,
    matchingRunners: 1,
    runnerIdentity: "303:5000",
    releaseVerified: true,
    releaseManifestSha256: RELEASE_MANIFEST_SHA256,
  });
  for (const malformed of [
    rawSnapshot().replace("TemporaryRunners=0", ""),
    rawSnapshot().replace("Discovering=no", "Discovering=unknown"),
    rawSnapshot().replace("ActiveAdvertisers=0", "ActiveAdvertisers=-1"),
    rawSnapshot().replace("RunnerIdentity=none", "RunnerIdentity=12:34"),
    rawSnapshot().replace("ReleaseVerified=yes", "ReleaseVerified=unknown"),
    `${rawSnapshot()}\n${FRAME}\nextra`,
  ]) {
    throwsCode(() => parseB4RaspberrySnapshot(malformed), "SNAPSHOT_INVALID");
  }
});

test("continuity rejects reboot, clock regression, process and restart changes", () => {
  const baseline = parseB4RaspberrySnapshot(rawSnapshot());
  assert.equal(
    assertB4RaspberryContinuity(
      baseline,
      baseline,
      parseB4RaspberrySnapshot(rawSnapshot({ clockMs: 1_000 })),
    ),
    true,
  );
  for (const [mutation, code] of [
    [{ clockMs: 1_000, bootId: OTHER_BOOT_ID }, "RASPBERRY_REBOOTED"],
    [{ clockMs: -1 }, "CLOCK_REGRESSION"],
    [{ clockMs: 1_000, mainPid: 303 }, "SERVICE_PROCESS_CHANGED"],
    [{ clockMs: 1_000, bluetoothRestarts: 1 }, "SERVICE_RESTARTED"],
  ]) {
    throwsCode(
      () =>
        assertB4RaspberryContinuity(
          baseline,
          baseline,
          parseB4RaspberrySnapshot(rawSnapshot(mutation)),
        ),
      code,
    );
  }
});

test("cleanup requires an observed runner and a fully idle final radio", () => {
  const clean = parseB4RaspberrySnapshot(rawSnapshot());
  assert.equal(assertB4RaspberryCleanBaseline(clean), true);
  assert.equal(assertB4RaspberryCleanup(clean, true), true);
  throwsCode(() => assertB4RaspberryCleanup(clean, false), "RUNNER_NOT_OBSERVED");
  for (const mutation of [
    { discovering: true },
    { activeAdvertisers: 1 },
    { temporaryRunners: 1 },
  ]) {
    throwsCode(
      () => assertB4RaspberryCleanup(parseB4RaspberrySnapshot(rawSnapshot(mutation)), true),
      "CLEANUP_INCOMPLETE",
    );
    throwsCode(
      () => assertB4RaspberryCleanBaseline(parseB4RaspberrySnapshot(rawSnapshot(mutation))),
      "BASELINE_NOT_CLEAN",
    );
  }
});

test("run commitments are domain-separated and reject reused identifiers", () => {
  const commitments = buildB4RunCommitments({
    collectionRunId: COLLECTION_RUN_ID,
    captureRunId: CAPTURE_RUN_ID,
  });
  assert.equal(
    commitments.collectionRunCommitmentSha256,
    crypto.createHash("sha256").update(`V5BT:B4:COLLECTION_RUN:${COLLECTION_RUN_ID}`).digest("hex"),
  );
  assert.equal(
    commitments.captureRunCommitmentSha256,
    crypto.createHash("sha256").update(`V5BT:B4:CAPTURE_RUN:${CAPTURE_RUN_ID}`).digest("hex"),
  );
  assert.notEqual(
    commitments.collectionRunCommitmentSha256,
    commitments.captureRunCommitmentSha256,
  );
  throwsCode(
    () => buildB4RunCommitments({ collectionRunId: COLLECTION_RUN_ID, captureRunId: COLLECTION_RUN_ID }),
    "RUN_BINDING_INVALID",
  );
});

test("CLI accepts only one bounded termination contract", () => {
  const common = [
    "--host", "test-host",
    "--collection-run-id", COLLECTION_RUN_ID,
    "--capture-run-id", CAPTURE_RUN_ID,
    "--certification-matrix-sha256", MATRIX_SHA256,
    "--runner-release-path", RELEASE_PATH,
    "--runner-release-manifest-sha256", RELEASE_MANIFEST_SHA256,
    "--private-output", "/tmp/private.jsonl",
    "--attestation", "/tmp/public.json",
  ];
  const fixed = parseB4RaspberryMonitorArguments([...common, "--duration-seconds", "90"]);
  assert.equal(fixed.durationMs, 90_000);
  const stopped = parseB4RaspberryMonitorArguments([
    ...common,
    "--stop-file", "/tmp/stop",
    "--maximum-seconds", "600",
    "--poll-ms", "5000",
  ]);
  assert.equal(stopped.maximumMs, 600_000);
  for (const tail of [
    [],
    ["--duration-seconds", "89"],
    ["--duration-seconds", "90.5"],
    ["--duration-seconds", "601"],
    ["--stop-file", "/tmp/stop"],
    ["--duration-seconds", "90", "--stop-file", "/tmp/stop", "--maximum-seconds", "90"],
    ["--duration-seconds", "90", "--poll-ms", "999"],
    ["--duration-seconds", "90", "--runner-release-path", "/opt/cassav5bt.service"],
    ["--duration-seconds", "90", "--runner-release-manifest-sha256", "bad"],
  ]) {
    throwsCode(
      () => parseB4RaspberryMonitorArguments([...common, ...tail]),
      "ARGUMENT_INVALID",
    );
  }
});

test("remote contract pins the private capture and root-only staging release", (t) => {
  const directory = temporaryDirectory("v5bt-b4-rpi-command-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const command = buildB4RaspberryRemoteCommand(
    fixedOptions(directory),
  );
  assert.match(command, /\/usr\/bin\/sudo -n \/bin\/sh -c/u);
  assert.match(command, /V5BT_B4_CAPTURE_RUN_ID/u);
  assert.match(command, /V5BT_B4_RELEASE_PATH/u);
  assert.match(command, /sha256sum --status -c SHA256SUMS/u);
  assert.match(command, new RegExp(CAPTURE_RUN_ID, "u"));
  assert.match(command, /20260805-b4-readiness-matrix3-r2/u);
  assert.doesNotMatch(command, /systemctl (?:start|stop|restart|enable)/u);
});

test("runner lifecycle requires one capture-bound scanner process with stable identity", () => {
  const waiting = Object.freeze({
    phase: "WAITING",
    runnerIdentity: null,
    activeSamples: 0,
  });
  assert.equal(
    advanceB4RaspberryRunnerLifecycle(
      waiting,
      parseB4RaspberrySnapshot(rawSnapshot()),
      RELEASE_MANIFEST_SHA256,
    ),
    waiting,
  );
  const running = advanceB4RaspberryRunnerLifecycle(
    waiting,
    parseB4RaspberrySnapshot(
      rawSnapshot({ clockMs: 2_000, discovering: true, temporaryRunners: 1 }),
    ),
    RELEASE_MANIFEST_SHA256,
  );
  assert.deepEqual(running, {
    phase: "RUNNING",
    runnerIdentity: "303:5000",
    activeSamples: 1,
  });
  const starting = advanceB4RaspberryRunnerLifecycle(
    waiting,
    parseB4RaspberrySnapshot(
      rawSnapshot({ clockMs: 2_000, temporaryRunners: 1 }),
    ),
    RELEASE_MANIFEST_SHA256,
  );
  assert.equal(starting.phase, "STARTING");
  assert.equal(
    advanceB4RaspberryRunnerLifecycle(
      starting,
      parseB4RaspberrySnapshot(
        rawSnapshot({ clockMs: 4_000, discovering: true, temporaryRunners: 1 }),
      ),
      RELEASE_MANIFEST_SHA256,
    ).phase,
    "RUNNING",
  );
  throwsCode(
    () =>
      advanceB4RaspberryRunnerLifecycle(
        starting,
        parseB4RaspberrySnapshot(
          rawSnapshot({ clockMs: 4_000, temporaryRunners: 1 }),
        ),
        RELEASE_MANIFEST_SHA256,
      ),
    "RUNNER_START_TIMEOUT",
  );
  const continued = advanceB4RaspberryRunnerLifecycle(
    running,
    parseB4RaspberrySnapshot(
      rawSnapshot({ clockMs: 4_000, discovering: true, temporaryRunners: 1 }),
    ),
    RELEASE_MANIFEST_SHA256,
  );
  assert.equal(continued.activeSamples, 2);
  const cleaned = advanceB4RaspberryRunnerLifecycle(
    continued,
    parseB4RaspberrySnapshot(rawSnapshot({ clockMs: 90_000 })),
    RELEASE_MANIFEST_SHA256,
  );
  assert.equal(cleaned.phase, "CLEANED");

  for (const [mutation, code] of [
    [
      { discovering: true, temporaryRunners: 1, matchingRunners: 0 },
      "RUNNER_BINDING_MISMATCH",
    ],
    [
      {
        discovering: true,
        temporaryRunners: 2,
        matchingRunners: 1,
        runnerIdentity: "303:5000",
      },
      "RUNNER_COUNT_INVALID",
    ],
    [
      { discovering: true, temporaryRunners: 1, activeAdvertisers: 1 },
      "RASPBERRY_ADVERTISING_ACTIVE",
    ],
    [{ releaseVerified: false }, "RUNNER_RELEASE_INVALID"],
  ]) {
    throwsCode(
      () =>
        advanceB4RaspberryRunnerLifecycle(
          waiting,
          parseB4RaspberrySnapshot(rawSnapshot(mutation)),
          RELEASE_MANIFEST_SHA256,
        ),
      code,
    );
  }
  throwsCode(
    () =>
      advanceB4RaspberryRunnerLifecycle(
        running,
        parseB4RaspberrySnapshot(
          rawSnapshot({
            clockMs: 4_000,
            discovering: true,
            temporaryRunners: 1,
            runnerIdentity: "304:6000",
          }),
        ),
        RELEASE_MANIFEST_SHA256,
      ),
    "RUNNER_IDENTITY_CHANGED",
  );
  const stopping = advanceB4RaspberryRunnerLifecycle(
    running,
    parseB4RaspberrySnapshot(
      rawSnapshot({ clockMs: 88_000, temporaryRunners: 1 }),
    ),
    RELEASE_MANIFEST_SHA256,
  );
  assert.equal(stopping.phase, "STOPPING");
  assert.equal(
    advanceB4RaspberryRunnerLifecycle(
      stopping,
      parseB4RaspberrySnapshot(rawSnapshot({ clockMs: 90_000 })),
      RELEASE_MANIFEST_SHA256,
    ).phase,
    "CLEANED",
  );
  throwsCode(
    () =>
      advanceB4RaspberryRunnerLifecycle(
        stopping,
        parseB4RaspberrySnapshot(
          rawSnapshot({ clockMs: 90_000, temporaryRunners: 1 }),
        ),
        RELEASE_MANIFEST_SHA256,
      ),
    "RUNNER_STOP_TIMEOUT",
  );
  throwsCode(
    () =>
      advanceB4RaspberryRunnerLifecycle(
        stopping,
        parseB4RaspberrySnapshot(
          rawSnapshot({
            clockMs: 90_000,
            discovering: true,
            temporaryRunners: 1,
          }),
        ),
        RELEASE_MANIFEST_SHA256,
      ),
    "RUNNER_RESTARTED_AFTER_STOP",
  );
  throwsCode(
    () =>
      advanceB4RaspberryRunnerLifecycle(
        cleaned,
        parseB4RaspberrySnapshot(
          rawSnapshot({
            clockMs: 92_000,
            discovering: true,
            temporaryRunners: 1,
          }),
        ),
        RELEASE_MANIFEST_SHA256,
      ),
    "RUNNER_REAPPEARED",
  );
});

test("public attestation is exact, redacted and validates expected bindings", () => {
  const attestation = validAttestation();
  assert.deepEqual(
    parseB4RaspberryContinuityAttestation(attestation, {
      collectionRunId: COLLECTION_RUN_ID,
      captureRunId: CAPTURE_RUN_ID,
      certificationMatrixSha256: MATRIX_SHA256,
      notBeforeMs: START_MS,
      notAfterMs: START_MS + 90_000,
    }),
    attestation,
  );
  const encoded = JSON.stringify(attestation);
  assert.doesNotMatch(
    encoded,
    /"(?:bootId|mainPid|hostname|collectionRunId|captureRunId|host|user|path)"\s*:/u,
  );
  assert.doesNotMatch(encoded, /10000000-0000|20000000-0000|\/home\/|192\.168\./u);

  throwsCode(
    () =>
      parseB4RaspberryContinuityAttestation(attestation, {
        collectionRunId: COLLECTION_RUN_ID,
        captureRunId: "00000000-0000-4000-8000-000000000003",
      }),
    "ATTESTATION_BINDING_MISMATCH",
  );
  const changed = structuredClone(attestation);
  changed.cleanup.finalized = false;
  throwsCode(() => parseB4RaspberryContinuityAttestation(changed), "ATTESTATION_INVALID");
  const sparse = structuredClone(attestation);
  sparse.coverage.sampleCount = 2;
  throwsCode(() => parseB4RaspberryContinuityAttestation(sparse), "ATTESTATION_INVALID");
  const zeroBinding = structuredClone(attestation);
  zeroBinding.binding.certificationMatrixSha256 = "0".repeat(64);
  throwsCode(() => parseB4RaspberryContinuityAttestation(zeroBinding), "ATTESTATION_INVALID");
  throwsCode(
    () => parseB4RaspberryContinuityAttestation(attestation, { notBeforeMs: "invalid" }),
    "ATTESTATION_EXPECTATION_INVALID",
  );
  const extra = structuredClone(attestation);
  extra.privatePath = "/private";
  throwsCode(() => parseB4RaspberryContinuityAttestation(extra), "ATTESTATION_INVALID");
});

test("simulated 90-second run publishes a bound private journal and redacted attestation", async (t) => {
  const directory = temporaryDirectory("v5bt-b4-rpi-monitor-pass-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = fixedOptions(directory);
  const attestation = await runB4RaspberryContinuityMonitor(
    options,
    simulatedRuntime(),
  );
  assert.equal(attestation.verdict, "PASS");
  assert.equal(attestation.coverage.durationMs, 90_000);
  assert.equal(attestation.coverage.sampleCount, 46);
  assert.equal(attestation.cleanup.finalized, true);
  assert.equal(fs.statSync(options.privateOutput).mode & 0o777, 0o600);
  assert.equal(fs.statSync(options.privateOutput).nlink, 1);
  assert.equal(fs.statSync(options.attestation).mode & 0o777, 0o600);
  assert.equal(fs.statSync(options.attestation).nlink, 1);
  assert.equal(
    attestation.binding.privateJournalSha256,
    crypto.createHash("sha256").update(fs.readFileSync(options.privateOutput)).digest("hex"),
  );
  assert.deepEqual(
    parseB4RaspberryContinuityAttestation(fs.readFileSync(options.attestation, "utf8"), {
      collectionRunId: COLLECTION_RUN_ID,
      captureRunId: CAPTURE_RUN_ID,
      certificationMatrixSha256: MATRIX_SHA256,
    }),
    attestation,
  );
  const bytes = fs.readFileSync(options.attestation, "utf8");
  assert.doesNotMatch(bytes, new RegExp(`${COLLECTION_RUN_ID}|${CAPTURE_RUN_ID}|${BOOT_ID}`, "u"));

  const secondPrivate = path.join(directory, "second-private.jsonl");
  await rejectsCode(
    () => runB4RaspberryContinuityMonitor({ ...options, privateOutput: secondPrivate }, simulatedRuntime()),
    "OUTPUT_EXISTS",
  );
  assert.equal(fs.existsSync(secondPrivate), false);
});

test("one-poll startup and shutdown transients are accepted but cannot stall", async (t) => {
  const directory = temporaryDirectory("v5bt-b4-rpi-transient-pass-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = fixedOptions(directory, {
    durationMs: null,
    stopFile: path.join(directory, "stop"),
    maximumMs: 120_000,
  });
  const snapshotForClock = (clockMs) => {
    if (clockMs === 0 || clockMs >= 92_000) return { clockMs };
    if (clockMs === 2_000 || clockMs === 90_000) {
      return { clockMs, temporaryRunners: 1 };
    }
    return { clockMs, discovering: true, temporaryRunners: 1 };
  };
  const attestation = await runB4RaspberryContinuityMonitor(
    options,
    simulatedRuntime({
      snapshotForClock,
      stopSignaled: (clockMs) => clockMs >= 92_000,
    }),
  );
  assert.equal(attestation.coverage.durationMs, 92_000);
  assert.equal(attestation.coverage.runnerActiveSamples, 43);
  assert.equal(attestation.checks.continuousRunnerIdentity, "PASS");

  for (const [name, failingSnapshots, code] of [
    [
      "startup",
      (clockMs) => clockMs === 0 ? { clockMs } : { clockMs, temporaryRunners: 1 },
      "RUNNER_START_TIMEOUT",
    ],
    [
      "shutdown",
      (clockMs) => clockMs === 0
        ? { clockMs }
        : clockMs < 88_000
          ? { clockMs, discovering: true, temporaryRunners: 1 }
          : { clockMs, temporaryRunners: 1 },
      "RUNNER_STOP_TIMEOUT",
    ],
  ]) {
    const failureDirectory = temporaryDirectory(`v5bt-b4-rpi-${name}-timeout-`);
    t.after(() => fs.rmSync(failureDirectory, { recursive: true, force: true }));
    const failureOptions = fixedOptions(failureDirectory);
    await rejectsCode(
      () =>
        runB4RaspberryContinuityMonitor(
          failureOptions,
          simulatedRuntime({ snapshotForClock: failingSnapshots }),
        ),
      code,
    );
    assert.equal(fs.existsSync(failureOptions.attestation), false);
  }
});

test("restart, reboot, clock regression and polling gap prevent attestation", async (t) => {
  const cases = [
    ["restart", (clockMs) => clockMs >= 4_000 ? { clockMs, mainRestarts: 1, discovering: true, temporaryRunners: 1 } : clockMs === 0 ? { clockMs } : { clockMs, discovering: true, temporaryRunners: 1 }, undefined, "SERVICE_RESTARTED"],
    ["reboot", (clockMs) => clockMs >= 4_000 ? { clockMs, bootId: OTHER_BOOT_ID, discovering: true, temporaryRunners: 1 } : clockMs === 0 ? { clockMs } : { clockMs, discovering: true, temporaryRunners: 1 }, undefined, "RASPBERRY_REBOOTED"],
    ["clock", (clockMs) => clockMs >= 4_000 ? { clockMs: 500, discovering: true, temporaryRunners: 1 } : clockMs === 0 ? { clockMs } : { clockMs, discovering: true, temporaryRunners: 1 }, undefined, "CLOCK_REGRESSION"],
    ["gap", undefined, () => 8_000, "POLLING_GAP"],
  ];
  for (const [name, snapshotForClock, sleepForPoll, code] of cases) {
    const directory = temporaryDirectory(`v5bt-b4-rpi-${name}-`);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const options = fixedOptions(directory);
    await rejectsCode(
      () => runB4RaspberryContinuityMonitor(options, simulatedRuntime({ snapshotForClock, sleepForPoll })),
      code,
    );
    assert.equal(fs.existsSync(options.attestation), false);
    assert.equal(fs.statSync(options.privateOutput).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(options.privateOutput, "utf8"), new RegExp(`"code":"${code}"`, "u"));
  }
});

test("runner omission and incomplete radio cleanup are blocking", async (t) => {
  for (const [name, snapshotForClock, code] of [
    ["no-runner", (clockMs) => ({ clockMs }), "RUNNER_NOT_OBSERVED"],
    ["discovering", (clockMs) => clockMs === 0 ? { clockMs } : { clockMs, discovering: true, temporaryRunners: clockMs < 90_000 ? 1 : 0 }, "CLEANUP_INCOMPLETE"],
    ["advertiser", (clockMs) => clockMs === 0 ? { clockMs } : clockMs < 90_000 ? { clockMs, discovering: true, temporaryRunners: 1 } : { clockMs, activeAdvertisers: 1 }, "RASPBERRY_ADVERTISING_ACTIVE"],
    ["runner", (clockMs) => clockMs === 0 ? { clockMs } : { clockMs, discovering: true, temporaryRunners: 1 }, "CLEANUP_INCOMPLETE"],
  ]) {
    const directory = temporaryDirectory(`v5bt-b4-rpi-cleanup-${name}-`);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const options = fixedOptions(directory);
    await rejectsCode(
      () => runB4RaspberryContinuityMonitor(options, simulatedRuntime({ snapshotForClock })),
      code,
    );
    assert.equal(fs.existsSync(options.attestation), false);
  }
});

test("stop-file mode rejects early stop and timeout, then accepts a clean 90-second stop", async (t) => {
  for (const [name, stopSignaled, code] of [
    ["early", (clockMs) => clockMs >= 20_000, "COVERAGE_INCOMPLETE"],
    ["timeout", () => false, "STOP_TIMEOUT"],
  ]) {
    const directory = temporaryDirectory(`v5bt-b4-rpi-stop-${name}-`);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const options = fixedOptions(directory, {
      durationMs: null,
      stopFile: path.join(directory, "stop"),
      maximumMs: 90_000,
    });
    await rejectsCode(
      () => runB4RaspberryContinuityMonitor(options, simulatedRuntime({ stopSignaled })),
      code,
    );
    assert.equal(fs.existsSync(options.attestation), false);
  }

  const directory = temporaryDirectory("v5bt-b4-rpi-stop-pass-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = fixedOptions(directory, {
    durationMs: null,
    stopFile: path.join(directory, "stop"),
    maximumMs: 120_000,
  });
  const attestation = await runB4RaspberryContinuityMonitor(
    options,
    simulatedRuntime({ stopSignaled: (clockMs) => clockMs >= 90_000 }),
  );
  assert.equal(attestation.coverage.durationMs, 90_000);
});

test("symlink and hardlink attacks are rejected without publishing an attestation", async (t) => {
  const real = temporaryDirectory("v5bt-b4-rpi-real-");
  const outer = temporaryDirectory("v5bt-b4-rpi-outer-");
  t.after(() => {
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(outer, { recursive: true, force: true });
  });
  const linkedParent = path.join(outer, "linked");
  fs.symlinkSync(real, linkedParent, "dir");
  await rejectsCode(
    () => runB4RaspberryContinuityMonitor(fixedOptions(linkedParent), simulatedRuntime()),
    "OUTPUT_UNSAFE",
  );

  const hardlinkDirectory = temporaryDirectory("v5bt-b4-rpi-hardlink-");
  t.after(() => fs.rmSync(hardlinkDirectory, { recursive: true, force: true }));
  const options = fixedOptions(hardlinkDirectory);
  let attacked = false;
  await rejectsCode(
    () =>
      runB4RaspberryContinuityMonitor(
        options,
        simulatedRuntime({
          afterSample({ journal }) {
            if (!attacked) {
              fs.linkSync(journal, path.join(hardlinkDirectory, "journal-link"));
              attacked = true;
            }
          },
        }),
      ),
    "OUTPUT_TAMPERED",
  );
  assert.equal(fs.existsSync(options.attestation), false);

  const finalDirectory = temporaryDirectory("v5bt-b4-rpi-final-hardlink-");
  t.after(() => fs.rmSync(finalDirectory, { recursive: true, force: true }));
  const finalOptions = fixedOptions(finalDirectory);
  let finalAttack = false;
  await rejectsCode(
    () =>
      runB4RaspberryContinuityMonitor(
        finalOptions,
        simulatedRuntime({
          afterSample({ journal, snapshot }) {
            if (!finalAttack && snapshot.radio.temporaryRunners === 0 && snapshot.wallClockNs > START_NS) {
              fs.linkSync(journal, path.join(finalDirectory, "final-journal-link"));
              finalAttack = true;
            }
          },
        }),
      ),
    "OUTPUT_TAMPERED",
  );
  assert.equal(fs.existsSync(finalOptions.attestation), false);
});

test("existing private and public outputs are never overwritten", async (t) => {
  const privateDirectory = temporaryDirectory("v5bt-b4-rpi-private-existing-");
  t.after(() => fs.rmSync(privateDirectory, { recursive: true, force: true }));
  const privateOptions = fixedOptions(privateDirectory);
  const originalPrivate = Buffer.from("existing-private\n", "utf8");
  fs.writeFileSync(privateOptions.privateOutput, originalPrivate, { mode: 0o600 });
  await rejectsCode(
    () => runB4RaspberryContinuityMonitor(privateOptions, simulatedRuntime()),
    "OUTPUT_EXISTS",
  );
  assert.deepEqual(fs.readFileSync(privateOptions.privateOutput), originalPrivate);
  assert.equal(fs.existsSync(privateOptions.attestation), false);

  const publicDirectory = temporaryDirectory("v5bt-b4-rpi-public-existing-");
  t.after(() => fs.rmSync(publicDirectory, { recursive: true, force: true }));
  const publicOptions = fixedOptions(publicDirectory);
  const originalPublic = Buffer.from("existing-public\n", "utf8");
  fs.writeFileSync(publicOptions.attestation, originalPublic, { mode: 0o644 });
  await rejectsCode(
    () => runB4RaspberryContinuityMonitor(publicOptions, simulatedRuntime()),
    "OUTPUT_EXISTS",
  );
  assert.deepEqual(fs.readFileSync(publicOptions.attestation), originalPublic);
  assert.equal(fs.existsSync(publicOptions.privateOutput), false);
});

test("a hard-linked stop file cannot terminate the monitor", async (t) => {
  const directory = temporaryDirectory("v5bt-b4-rpi-stop-hardlink-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stopFile = path.join(directory, "stop");
  const options = fixedOptions(directory, {
    durationMs: null,
    stopFile,
    maximumMs: 120_000,
  });
  await rejectsCode(
    () =>
      runB4RaspberryContinuityMonitor(
        options,
        simulatedRuntime({
          afterSample({ sampleCount }) {
            if (sampleCount === 2) {
              fs.writeFileSync(stopFile, "stop\n", { mode: 0o600 });
              fs.linkSync(stopFile, path.join(directory, "stop-link"));
            }
          },
        }),
      ),
    "STOP_FILE_INVALID",
  );
  assert.equal(fs.existsSync(options.attestation), false);
});
