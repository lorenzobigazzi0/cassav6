import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  B5_RASPBERRY_CONTINUITY_COUNTER_FIELDS,
  B5_RASPBERRY_CONTINUITY_MONITOR_VERSION,
  assertRaspberryContinuitySample,
  atomicWriteRaspberryMonitorPrivateJson,
  buildPrivateRaspberryBaseline,
  buildRaspberryContinuityAttestation,
  buildSystemctlShowArgs,
  captureRaspberryContinuitySample,
  main,
  parseB5RaspberryContinuityAttestation,
  parseBootId,
  parsePrivateRaspberryBaseline,
  parseRaspberryContinuityAttestation,
  parseRaspberryMonitorArguments,
  parseRaspberryMonitorPublicationJournal,
  parseRaspberryMonitorConfig,
  parseSystemctlShow,
  readRaspberryMonitorPrivateJson,
  recoverRaspberryMonitorArtifactPublication,
  raspberryMonitorPublicationJournalPath,
  monitorRaspberryCampaign,
  publishRaspberryMonitorArtifacts,
  validB5RaspberryContinuityAttestationFixture,
  validRaspberryContinuityAttestationFixture
} from "./run-b5-raspberry-continuity-monitor.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./run-b5-raspberry-continuity-monitor.mjs", import.meta.url)
);
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";
const BOOT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_BOOT_ID = "20000000-0000-4000-8000-000000000002";
const START_MS = Date.parse("2026-08-03T12:00:00.000Z");
const MAIN_SERVICE = "cassav6.service";
const BLUETOOTH_SERVICE = "bluetooth.service";

function throwsCode(action, code) {
  assert.throws(
    action,
    (error) => error?.code === code,
    `expected ${code}`
  );
}

async function rejectsCode(action, code) {
  await assert.rejects(
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
    measurement: {
      durationMs: 6_000_000,
      ...(overrides.measurement ?? {})
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([field]) => field !== "measurement")
    )
  };
}

function serviceSnapshot(unit, overrides = {}) {
  const main = unit === MAIN_SERVICE;
  return {
    unit,
    activeState: "active",
    subState: "running",
    mainPid: main ? 1200 : 900,
    nRestarts: 0,
    activeEnterTimestampMonotonic: main ? 2_000_000 : 1_000_000,
    execMainStartTimestampMonotonic: main ? 2_100_000 : 1_100_000,
    ...overrides
  };
}

function systemctlOutput(unit, overrides = {}) {
  const snapshot = serviceSnapshot(unit, overrides);
  return [
    `ActiveState=${snapshot.activeState}`,
    `SubState=${snapshot.subState}`,
    `MainPID=${snapshot.mainPid}`,
    `NRestarts=${snapshot.nRestarts}`,
    `ActiveEnterTimestampMonotonic=${snapshot.activeEnterTimestampMonotonic}`,
    `ExecMainStartTimestampMonotonic=${snapshot.execMainStartTimestampMonotonic}`,
    ""
  ].join("\n");
}

function sampleFixture(overrides = {}) {
  const wallClockMs = overrides.wallClockMs ?? START_MS;
  const services = {
    [MAIN_SERVICE]: serviceSnapshot(MAIN_SERVICE),
    [BLUETOOTH_SERVICE]: serviceSnapshot(BLUETOOTH_SERVICE),
    ...(overrides.services ?? {})
  };
  return {
    capturedAt: new Date(wallClockMs).toISOString(),
    wallClockMs,
    monotonicMs: overrides.monotonicMs ?? 10_000,
    bootId: overrides.bootId ?? BOOT_ID,
    services,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([field]) => !["wallClockMs", "monotonicMs", "bootId", "services"].includes(field)
      )
    )
  };
}

function baselineFixture() {
  return buildPrivateRaspberryBaseline(
    parseRaspberryMonitorConfig(monitorConfig()),
    sampleFixture()
  );
}

test("Raspberry monitor config enforces an exact campaign contract", () => {
  const parsed = parseRaspberryMonitorConfig(JSON.stringify(monitorConfig()));
  assert.equal(parsed.campaignId, CAMPAIGN_ID);
  assert.equal(parsed.measurement.durationMs, 6_000_000);
  for (const mutation of [
    { extra: true },
    { schemaVersion: 2 },
    { campaignId: "not-a-uuid" },
    { measurement: { durationMs: 5_999_999 } },
    { measurement: { durationMs: 14_400_001 } },
    { measurement: { durationMs: 6_000_000, extra: true } }
  ]) {
    throwsCode(
      () => parseRaspberryMonitorConfig({ ...monitorConfig(), ...mutation }),
      "CONFIG_INVALID"
    );
  }
});

test("systemctl parser requires every fixed property and a running service", () => {
  for (const unit of [MAIN_SERVICE, BLUETOOTH_SERVICE]) {
    const parsed = parseSystemctlShow(systemctlOutput(unit), unit);
    assert.deepEqual(parsed, serviceSnapshot(unit));
    assert.deepEqual(buildSystemctlShowArgs(unit).slice(0, 3), [
      "show",
      unit,
      "--no-pager"
    ]);
    assert.equal(buildSystemctlShowArgs(unit).length, 9);
  }
  throwsCode(
    () => parseSystemctlShow(systemctlOutput(MAIN_SERVICE, { activeState: "inactive" }), MAIN_SERVICE),
    "SERVICE_NOT_RUNNING"
  );
  throwsCode(
    () => parseSystemctlShow(systemctlOutput(MAIN_SERVICE).replace("MainPID=1200\n", ""), MAIN_SERVICE),
    "SYSTEMCTL_OUTPUT_INVALID"
  );
  throwsCode(
    () => parseSystemctlShow(`${systemctlOutput(MAIN_SERVICE)}MainPID=1200\n`, MAIN_SERVICE),
    "SYSTEMCTL_OUTPUT_INVALID"
  );
  throwsCode(
    () => parseSystemctlShow(systemctlOutput(MAIN_SERVICE, { mainPid: 0 }), MAIN_SERVICE),
    "SYSTEMCTL_OUTPUT_INVALID"
  );
  throwsCode(() => buildSystemctlShowArgs("other.service"), "SYSTEMCTL_ARGUMENT_INVALID");
});

test("boot_id parser is canonical and fail-closed", () => {
  assert.equal(parseBootId(` ${BOOT_ID}\n`), BOOT_ID);
  for (const invalid of [
    "",
    "not-a-uuid",
    "ABCDEF00-0000-4000-8000-000000000001",
    "0".repeat(36)
  ]) {
    throwsCode(() => parseBootId(invalid), "BOOT_ID_INVALID");
  }
});

test("sample capture uses only injected command and boot readers", async () => {
  const calls = [];
  let bootReads = 0;
  const sample = await captureRaspberryContinuitySample(
    {
      systemctlPath: "/injected/systemctl",
      bootIdPath: "/injected/boot_id",
      signal: undefined
    },
    {
      async execFile(executable, args) {
        calls.push({ executable, args });
        const unit = args[1];
        return { stdout: systemctlOutput(unit), stderr: "" };
      },
      async readBootIdText(location) {
        bootReads += 1;
        assert.equal(location, "/injected/boot_id");
        return `${BOOT_ID}\n`;
      },
      nowMs: () => START_MS,
      monotonicNow: () => 12_345
    }
  );
  assert.equal(bootReads, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.executable === "/injected/systemctl"), true);
  assert.deepEqual(
    new Set(calls.map((call) => call.args[1])),
    new Set([MAIN_SERVICE, BLUETOOTH_SERVICE])
  );
  assert.equal(sample.bootId, BOOT_ID);
  assert.equal(sample.monotonicMs, 12_345);

  let alternating = false;
  await rejectsCode(
    () =>
      captureRaspberryContinuitySample(
        {
          systemctlPath: "/injected/systemctl",
          bootIdPath: "/injected/boot_id"
        },
        {
          execFile: async (_executable, args) => ({ stdout: systemctlOutput(args[1]) }),
          readBootIdText: async () => {
            alternating = !alternating;
            return alternating ? BOOT_ID : OTHER_BOOT_ID;
          }
        }
      ),
    "BOOT_ID_CHANGED"
  );
});

test("private baseline binds campaign, boot and both systemd services", () => {
  const baseline = parsePrivateRaspberryBaseline(JSON.stringify(baselineFixture()));
  assert.equal(baseline.campaignId, CAMPAIGN_ID);
  assert.equal(baseline.bootId, BOOT_ID);
  assert.equal(baseline.services[MAIN_SERVICE].mainPid, 1200);
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.campaignId = "invalid"; },
    (value) => { value.bootId = "invalid"; },
    (value) => { value.services[MAIN_SERVICE].mainPid = 0; },
    (value) => { delete value.services[BLUETOOTH_SERVICE]; }
  ]) {
    const candidate = structuredClone(baselineFixture());
    mutate(candidate);
    throwsCode(() => parsePrivateRaspberryBaseline(candidate), "BASELINE_INVALID");
  }
});

test("continuity rejects boot, service, restart and clock changes", () => {
  const baseline = parsePrivateRaspberryBaseline(baselineFixture());
  const previous = { wallClockMs: START_MS, monotonicMs: 10_000 };
  assert.deepEqual(
    assertRaspberryContinuitySample(
      baseline,
      previous,
      sampleFixture({ wallClockMs: START_MS + 1_000, monotonicMs: 11_000 })
    ),
    { wallClockMs: START_MS + 1_000, monotonicMs: 11_000 }
  );

  const mutations = [
    [{ bootId: OTHER_BOOT_ID }, "BOOT_ID_CHANGED"],
    [{ services: { [MAIN_SERVICE]: serviceSnapshot(MAIN_SERVICE, { activeEnterTimestampMonotonic: 2_000_001 }) } }, "MAIN_SERVICE_STATE_CHANGED"],
    [{ services: { [MAIN_SERVICE]: serviceSnapshot(MAIN_SERVICE, { mainPid: 1201 }) } }, "MAIN_SERVICE_PROCESS_CHANGED"],
    [{ services: { [MAIN_SERVICE]: serviceSnapshot(MAIN_SERVICE, { nRestarts: 1 }) } }, "MAIN_SERVICE_RESTART_COUNT_CHANGED"],
    [{ services: { [BLUETOOTH_SERVICE]: serviceSnapshot(BLUETOOTH_SERVICE, { activeEnterTimestampMonotonic: 1_000_001 }) } }, "BLUETOOTH_SERVICE_STATE_CHANGED"],
    [{ services: { [BLUETOOTH_SERVICE]: serviceSnapshot(BLUETOOTH_SERVICE, { execMainStartTimestampMonotonic: 1_100_001 }) } }, "BLUETOOTH_SERVICE_PROCESS_CHANGED"],
    [{ services: { [BLUETOOTH_SERVICE]: serviceSnapshot(BLUETOOTH_SERVICE, { nRestarts: 1 }) } }, "BLUETOOTH_SERVICE_RESTART_COUNT_CHANGED"],
    [{ wallClockMs: START_MS - 1, monotonicMs: 11_000 }, "CLOCK_REGRESSION"],
    [{ wallClockMs: START_MS + 1_000, monotonicMs: 9_999 }, "CLOCK_REGRESSION"]
  ];
  for (const [override, code] of mutations) {
    throwsCode(
      () => assertRaspberryContinuitySample(baseline, previous, sampleFixture(override)),
      code
    );
  }
});

test("private JSON is 0600, atomic and never overwritten", () => {
  const directory = temporaryDirectory("v6-b5-rpi-private-");
  try {
    const output = path.join(directory, "private.json");
    atomicWriteRaspberryMonitorPrivateJson(output, { schemaVersion: 1, value: "private" });
    const status = fs.lstatSync(output);
    assert.equal(status.isFile(), true);
    assert.equal(status.mode & 0o777, 0o600);
    assert.equal(status.nlink, 1);
    assert.deepEqual(readRaspberryMonitorPrivateJson(output), {
      schemaVersion: 1,
      value: "private"
    });
    const before = fs.readFileSync(output);
    const inode = status.ino;
    throwsCode(
      () => atomicWriteRaspberryMonitorPrivateJson(output, { schemaVersion: 2 }),
      "PRIVATE_OUTPUT_EXISTS"
    );
    assert.deepEqual(fs.readFileSync(output), before);
    assert.equal(fs.statSync(output).ino, inode);
    assert.deepEqual(fs.readdirSync(directory), ["private.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("private JSON rejects permissive files, hard links and symlinks", () => {
  const directory = temporaryDirectory("v6-b5-rpi-private-invalid-");
  try {
    const permissive = path.join(directory, "permissive.json");
    writePrivateJson(permissive, { value: 1 });
    fs.chmodSync(permissive, 0o640);
    throwsCode(() => readRaspberryMonitorPrivateJson(permissive), "PRIVATE_FILE_INVALID");

    const original = path.join(directory, "original.json");
    const hardLink = path.join(directory, "hard-link.json");
    writePrivateJson(original, { value: 2 });
    fs.linkSync(original, hardLink);
    throwsCode(() => readRaspberryMonitorPrivateJson(original), "PRIVATE_FILE_INVALID");
    throwsCode(() => readRaspberryMonitorPrivateJson(hardLink), "PRIVATE_FILE_INVALID");

    const symlink = path.join(directory, "link.json");
    fs.symlinkSync(permissive, symlink);
    throwsCode(() => readRaspberryMonitorPrivateJson(symlink), "PRIVATE_FILE_INVALID");
    throwsCode(
      () => atomicWriteRaspberryMonitorPrivateJson(symlink, { value: 3 }),
      "PRIVATE_FILE_INVALID"
    );

    const realParent = path.join(directory, "real-parent");
    const linkedParent = path.join(directory, "linked-parent");
    fs.mkdirSync(realParent, { mode: 0o700 });
    fs.symlinkSync(realParent, linkedParent);
    throwsCode(
      () => atomicWriteRaspberryMonitorPrivateJson(path.join(linkedParent, "out.json"), { value: 4 }),
      "PRIVATE_FILE_INVALID"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Raspberry paired publication recovers failures and protects its exact journal", () => {
  const directory = temporaryDirectory("v6-b5-rpi-publication-");
  try {
    const privateOutput = path.join(directory, "private-result.json");
    const attestationOutput = path.join(directory, "attestation.json");
    const options = {
      privateOutput,
      attestation: attestationOutput,
      campaignId: CAMPAIGN_ID
    };
    const attestationDocument = validRaspberryContinuityAttestationFixture({
      campaignId: CAMPAIGN_ID
    });
    const privateDocument = {
      schemaVersion: 1,
      harnessVersion: B5_RASPBERRY_CONTINUITY_MONITOR_VERSION,
      product: "V6",
      phase: "B5",
      mode: "PRIVATE_RASPBERRY_CONTINUITY_RESULT",
      verdict: "PASS",
      campaignId: CAMPAIGN_ID,
      attestationSha256: crypto
        .createHash("sha256")
        .update(`${JSON.stringify(attestationDocument)}\n`)
        .digest("hex")
    };

    assert.throws(
      () =>
        publishRaspberryMonitorArtifacts(
          options,
          privateDocument,
          attestationDocument,
          { afterPrivatePublished: () => { throw new Error("simulated interruption"); } }
        ),
      /simulated interruption/u
    );
    const journalPath = raspberryMonitorPublicationJournalPath(privateOutput);
    assert.equal(fs.existsSync(privateOutput), true);
    assert.equal(fs.existsSync(attestationOutput), false);
    assert.equal(fs.statSync(privateOutput).mode & 0o777, 0o600);
    assert.equal(fs.statSync(journalPath).mode & 0o777, 0o600);
    const journal = readRaspberryMonitorPrivateJson(
      journalPath,
      "publication journal"
    );
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
    parseRaspberryMonitorPublicationJournal(journal, options);
    throwsCode(
      () =>
        parseRaspberryMonitorPublicationJournal(
          { ...journal, unexpected: true },
          options
        ),
      "PUBLICATION_JOURNAL_INVALID"
    );

    const hardLink = path.join(directory, "journal-hard-link.json");
    fs.linkSync(journalPath, hardLink);
    throwsCode(
      () => recoverRaspberryMonitorArtifactPublication(options),
      "PRIVATE_FILE_INVALID"
    );
    fs.unlinkSync(hardLink);

    fs.writeFileSync(privateOutput, `${JSON.stringify({ tampered: true })}\n`);
    throwsCode(
      () => recoverRaspberryMonitorArtifactPublication(options),
      "PUBLICATION_CONFLICT"
    );
    fs.writeFileSync(
      privateOutput,
      `${JSON.stringify(privateDocument, null, 2)}\n`
    );

    assert.deepEqual(
      recoverRaspberryMonitorArtifactPublication(options),
      attestationDocument
    );
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.statSync(attestationOutput).mode & 0o777, 0o600);
    throwsCode(
      () =>
        publishRaspberryMonitorArtifacts(
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

test("Raspberry paired publication recovers after both commits before cleanup", () => {
  const directory = temporaryDirectory("v6-b5-rpi-post-commit-");
  try {
    const options = {
      privateOutput: path.join(directory, "private-result.json"),
      attestation: path.join(directory, "attestation.json"),
      campaignId: CAMPAIGN_ID
    };
    const attestationDocument = validRaspberryContinuityAttestationFixture();
    const privateDocument = {
      schemaVersion: 1,
      harnessVersion: B5_RASPBERRY_CONTINUITY_MONITOR_VERSION,
      product: "V6",
      phase: "B5",
      mode: "PRIVATE_RASPBERRY_CONTINUITY_RESULT",
      verdict: "PASS",
      campaignId: CAMPAIGN_ID,
      attestationSha256: crypto
        .createHash("sha256")
        .update(`${JSON.stringify(attestationDocument)}\n`)
        .digest("hex")
    };
    assert.throws(
      () =>
        publishRaspberryMonitorArtifacts(
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
      fs.existsSync(raspberryMonitorPublicationJournalPath(options.privateOutput)),
      true
    );
    recoverRaspberryMonitorArtifactPublication(options);
    assert.equal(
      fs.existsSync(raspberryMonitorPublicationJournalPath(options.privateOutput)),
      false
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("valid attestation fixture is configurable, campaign-bound and redacted", () => {
  const monitoredFrom = "2026-08-03T01:00:00.000Z";
  const monitoredUntil = "2026-08-03T02:40:00.000Z";
  const fixture = validRaspberryContinuityAttestationFixture({
    campaignId: CAMPAIGN_ID,
    monitoredFrom,
    monitoredUntil,
    pollIntervalMs: 5_000
  });
  const parsed = parseRaspberryContinuityAttestation(JSON.stringify(fixture));
  assert.equal(parsed.report.verdict, "PASS");
  assert.equal(parsed.report.campaign.monitoredFrom, monitoredFrom);
  assert.equal(parsed.report.campaign.monitoredUntil, monitoredUntil);
  assert.match(parsed.campaignIdCommitmentSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(
    parseB5RaspberryContinuityAttestation(fixture),
    parsed
  );
  assert.deepEqual(
    validB5RaspberryContinuityAttestationFixture(),
    validRaspberryContinuityAttestationFixture()
  );
  const encoded = JSON.stringify(fixture);
  assert.equal(encoded.includes(CAMPAIGN_ID), false);
  assert.equal(encoded.includes(BOOT_ID), false);
  assert.equal(/"(?:hostname|pid|mainPid|bootId|systemctlPath|bootIdPath)"/iu.test(encoded), false);
  assert.equal(/\/(?:home|tmp|var|etc|run|proc)\//u.test(encoded), false);
  assert.equal(
    B5_RASPBERRY_CONTINUITY_COUNTER_FIELDS.every(
      (field) => fixture.observed[field] === 0
    ),
    true
  );
});

test("attestation builder clones observations defensively", () => {
  const requiredDurationMs = 6_000_000;
  const pollIntervalMs = 5_000;
  const scheduledSamples = Math.ceil(requiredDurationMs / pollIntervalMs) + 1;
  const observed = {
    scheduledSamples,
    completedSamples: scheduledSamples,
    maximumPollGapMs: pollIntervalMs,
    ...Object.fromEntries(
      B5_RASPBERRY_CONTINUITY_COUNTER_FIELDS.map((field) => [field, 0])
    )
  };
  const monitoredFrom = "2026-08-03T00:00:00.000Z";
  const monitoredUntil = new Date(Date.parse(monitoredFrom) + requiredDurationMs).toISOString();
  const report = buildRaspberryContinuityAttestation({
    campaignId: CAMPAIGN_ID,
    monitoredFrom,
    monitoredUntil,
    requiredDurationMs,
    pollIntervalMs,
    observed
  });
  observed.systemctlFailures = 1;
  assert.equal(report.observed.systemctlFailures, 0);
});

test("attestation parser rejects timeline, target, counter and privacy mutations", () => {
  const mutations = [
    [(value) => { value.extra = true; }, "ATTESTATION_INVALID"],
    [(value) => { value.campaign.campaignIdCommitmentSha256 = "0".repeat(64); }, "ATTESTATION_INVALID"],
    [(value) => { value.campaign.durationMs += 1; }, "ATTESTATION_INVALID"],
    [(value) => { value.generatedAt = value.campaign.monitoredFrom; }, "ATTESTATION_INVALID"],
    [(value) => { value.target.mainService = "other.service"; }, "ATTESTATION_INVALID"],
    [(value) => { value.checks.fixedBoot = "FAIL"; }, "ATTESTATION_INVALID"],
    [(value) => { value.observed.completedSamples -= 1; }, "ATTESTATION_INVALID"],
    [(value) => { value.observed.maximumPollGapMs = 0; }, "ATTESTATION_INVALID"],
    [(value) => { value.observed.maximumPollGapMs = 10_001; }, "ATTESTATION_INVALID"],
    [(value) => { value.observed.bootIdChanges = 1; }, "ATTESTATION_INVALID"],
    [(value) => { value.privacy.hostnameIncluded = true; }, "ATTESTATION_PRIVACY_INVALID"],
    [(value) => { value.hostname = "private-host"; }, "ATTESTATION_INVALID"]
  ];
  for (const [mutate, code] of mutations) {
    const candidate = structuredClone(validRaspberryContinuityAttestationFixture());
    mutate(candidate);
    throwsCode(() => parseRaspberryContinuityAttestation(candidate), code);
  }
});

test("CLI baseline and monitor run entirely through injected samples", async () => {
  const directory = temporaryDirectory("v6-b5-rpi-cli-");
  try {
    const systemctl = path.join(directory, "systemctl-fixture");
    const bootIdPath = path.join(directory, "boot_id-fixture");
    const configPath = path.join(directory, "config.json");
    const baselinePath = path.join(directory, "baseline.json");
    const privateOutput = path.join(directory, "monitor-private.json");
    const attestation = path.join(directory, "attestation.json");
    fs.writeFileSync(systemctl, "#!/bin/false\n", { mode: 0o700 });
    fs.writeFileSync(bootIdPath, `${BOOT_ID}\n`, { mode: 0o600 });
    writePrivateJson(configPath, monitorConfig());

    const baselineStdout = [];
    const baselineExit = await main(
      [
        "--capture-baseline",
        "--systemctl",
        systemctl,
        "--boot-id-file",
        bootIdPath,
        "--config",
        configPath,
        "--baseline",
        baselinePath
      ],
      {
        captureSample: async () => sampleFixture(),
        execFile: async () => {
          throw new Error("a real command must never run in this test");
        },
        writeStdout: (value) => baselineStdout.push(value)
      }
    );
    assert.equal(baselineExit, 0, baselineStdout.join(""));
    assert.equal(JSON.parse(baselineStdout.join("")).verdict, "READY");
    assert.equal(fs.statSync(baselinePath).mode & 0o777, 0o600);

    let wallClockMs = START_MS;
    let monotonicMs = 0;
    let sampleCount = 0;
    const monitorStdout = [];
    const monitorExit = await main(
      [
        "--monitor",
        "--systemctl",
        systemctl,
        "--boot-id-file",
        bootIdPath,
        "--config",
        configPath,
        "--baseline",
        baselinePath,
        "--private-output",
        privateOutput,
        "--attestation",
        attestation,
        "--poll-ms",
        "5000"
      ],
      {
        signalHandlers: false,
        nowMs: () => wallClockMs,
        monotonicNow: () => monotonicMs,
        sleep: async (milliseconds) => {
          wallClockMs += milliseconds;
          monotonicMs += milliseconds;
        },
        captureSample: async () => {
          sampleCount += 1;
          return sampleFixture({ wallClockMs, monotonicMs });
        },
        execFile: async () => {
          throw new Error("a real command must never run in this test");
        },
        writeStdout: (value) => monitorStdout.push(value)
      }
    );
    assert.equal(monitorExit, 0, monitorStdout.join(""));
    const publicReport = JSON.parse(monitorStdout.join(""));
    assert.equal(publicReport.verdict, "PASS");
    assert.equal(sampleCount, 1201);
    assert.equal(publicReport.observed.completedSamples, 1201);
    assert.equal(fs.statSync(privateOutput).mode & 0o777, 0o600);
    assert.equal(fs.statSync(attestation).mode & 0o777, 0o600);
    parseRaspberryContinuityAttestation(
      readRaspberryMonitorPrivateJson(attestation, "attestation")
    );
    const privateReport = readRaspberryMonitorPrivateJson(
      privateOutput,
      "private monitor result"
    );
    assert.equal(privateReport.finalBinding.bootId, BOOT_ID);
    assert.equal(privateReport.finalBinding.services[MAIN_SERVICE].mainPid, 1200);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("monitor rejects a wall-clock regression during finalization", async () => {
  const directory = temporaryDirectory("v6-b5-rpi-final-clock-");
  try {
    let wallClockMs = START_MS;
    let monotonicMs = 0;
    let nowCalls = 0;
    await rejectsCode(
      () =>
        monitorRaspberryCampaign(
          {
            systemctlPath: "/injected/systemctl",
            bootIdPath: "/injected/boot_id",
            privateOutput: path.join(directory, "private.json"),
            attestation: path.join(directory, "attestation.json"),
            pollMs: 5_000
          },
          parseRaspberryMonitorConfig(monitorConfig()),
          baselineFixture(),
          {
            signalHandlers: false,
            nowMs: () => {
              nowCalls += 1;
              return nowCalls === 1 ? wallClockMs : wallClockMs - 1;
            },
            monotonicNow: () => monotonicMs,
            sleep: async (milliseconds) => {
              wallClockMs += milliseconds;
              monotonicMs += milliseconds;
            },
            captureSample: async () =>
              sampleFixture({ wallClockMs, monotonicMs })
          }
        ),
      "CLOCK_REGRESSION"
    );
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI rejects aliased private paths before executable validation", () => {
  throwsCode(
    () =>
      parseRaspberryMonitorArguments(
        [
          "--monitor",
          "--systemctl",
          "/injected/systemctl",
          "--boot-id-file",
          "/injected/boot_id",
          "--config",
          "/private/config.json",
          "--baseline",
          "/private/baseline.json",
          "--private-output",
          "/private/output.json",
          "--attestation",
          "/private/output.json"
        ],
        {
          validateExecutable: () => {},
          validateBootIdPath: () => {}
        }
      ),
    "INVALID_ARGUMENT"
  );
});

test("CLI failure output is generic and redacts private paths", async () => {
  const privatePath = "/private/raspberry/systemctl-secret";
  const writes = [];
  const exitCode = await main(
    ["--capture-baseline", "--systemctl", privatePath],
    { writeStdout: (value) => writes.push(value) }
  );
  assert.equal(exitCode, 2);
  const report = JSON.parse(writes.join(""));
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.failure.message, "Raspberry continuity monitoring failed");
  assert.equal(JSON.stringify(report).includes(privatePath), false);
});

test("module import has no command or filesystem side effects", () => {
  const directory = temporaryDirectory("v6-b5-rpi-import-");
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

test("version export remains stable", () => {
  assert.equal(B5_RASPBERRY_CONTINUITY_MONITOR_VERSION, "1.0.0");
});
