import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  PhysicalRaspberryMonitorError,
  assertPhysicalRaspberryContinuity,
  buildPhysicalRaspberryAttestation,
  consumeSshPasswordEnvironmentVariable,
  parsePhysicalRaspberrySnapshot,
  resolveSshpassExecutable,
} from "../scripts/run-v5bt-physical-raspberry-monitor.mjs";

const execFileAsync = promisify(execFile);
const MONITOR = path.resolve("scripts/run-v5bt-physical-raspberry-monitor.mjs");
const PRIVATE_JOURNAL_SHA256 = "a".repeat(64);

function rawSnapshot({
  clock = "1785790000000000000",
  bootId = "80dc3fec-1168-4f4f-ba6c-1655afeeb768",
  mainPid = 101,
  mainRestarts = 0,
  bluetoothPid = 202,
  bluetoothRestarts = 0,
} = {}) {
  const service = (pid, restarts, active, started) => [
    "ActiveState=active",
    "SubState=running",
    `MainPID=${pid}`,
    `NRestarts=${restarts}`,
    `ActiveEnterTimestampMonotonic=${active}`,
    `ExecMainStartTimestampMonotonic=${started}`,
  ].join("\n");
  return [
    clock,
    bootId,
    service(mainPid, mainRestarts, 1000, 900),
    service(bluetoothPid, bluetoothRestarts, 2000, 1900),
  ].join("\n--V5BT-MONITOR-SPLIT--\n");
}

test("parses an exact active-service snapshot", () => {
  const value = parsePhysicalRaspberrySnapshot(rawSnapshot());
  assert.equal(value.services.length, 2);
  assert.equal(value.services[0].unit, "cassav5bt.service");
  assert.equal(value.wallClockNs, 1785790000000000000n);
});

test("accepts stable services and increasing wall clock", () => {
  const baseline = parsePhysicalRaspberrySnapshot(rawSnapshot());
  const next = parsePhysicalRaspberrySnapshot(
    rawSnapshot({ clock: "1785790001000000000" }),
  );
  assert.equal(assertPhysicalRaspberryContinuity(baseline, baseline, next), true);
});

for (const [name, mutation, code] of [
  ["reboot", { bootId: "91dc3fec-1168-4f4f-ba6c-1655afeeb768" }, "RASPBERRY_REBOOTED"],
  ["main process change", { mainPid: 303 }, "SERVICE_PROCESS_CHANGED"],
  ["restart count", { bluetoothRestarts: 1 }, "SERVICE_RESTARTED"],
]) {
  test(`rejects ${name}`, () => {
    const baseline = parsePhysicalRaspberrySnapshot(rawSnapshot());
    const current = parsePhysicalRaspberrySnapshot(mutation ? rawSnapshot(mutation) : rawSnapshot());
    assert.throws(
      () => assertPhysicalRaspberryContinuity(baseline, baseline, current),
      (error) => error instanceof PhysicalRaspberryMonitorError && error.code === code,
    );
  });
}

test("rejects a regressive wall clock", () => {
  const baseline = parsePhysicalRaspberrySnapshot(rawSnapshot());
  const current = parsePhysicalRaspberrySnapshot(
    rawSnapshot({ clock: "1785789999000000000" }),
  );
  assert.throws(
    () => assertPhysicalRaspberryContinuity(baseline, baseline, current),
    (error) => error.code === "CLOCK_REGRESSION",
  );
});

test("builds a redacted supplemental attestation", () => {
  const value = buildPhysicalRaspberryAttestation({
    startedAt: "2026-08-03T20:00:00.000Z",
    stoppedAt: "2026-08-03T20:01:00.000Z",
    sampleCount: 31,
    maximumObservedGapMs: 2100,
    pollMs: 2000,
    privateJournalSha256: PRIVATE_JOURNAL_SHA256,
  });
  assert.equal(value.verdict, "PASS");
  assert.equal(value.evidenceClass, "SUPPLEMENTAL");
  assert.equal(value.gate.b0, "PENDING");
  assert.equal(value.privateJournalSha256, PRIVATE_JOURNAL_SHA256);
  assert.doesNotMatch(
    JSON.stringify(value),
    /"(?:bootId|mainPid|hostname)"\s*:|192\.168\./u,
  );
});

test("rejects an attestation without a valid finalized-journal digest", () => {
  assert.throws(
    () =>
      buildPhysicalRaspberryAttestation({
        startedAt: "2026-08-03T20:00:00.000Z",
        stoppedAt: "2026-08-03T20:01:00.000Z",
        sampleCount: 31,
        maximumObservedGapMs: 2100,
        pollMs: 2000,
        privateJournalSha256: "not-a-sha256",
      }),
    (error) =>
      error instanceof PhysicalRaspberryMonitorError &&
      error.code === "ATTESTATION_INVALID",
  );
});

test("consumes SSH password environment input and rejects missing or unsafe values", () => {
  const name = "V5BT_TEST_MONITOR_SSH_PASSWORD";
  const environment = { [name]: "private-monitor-password" };
  assert.equal(
    consumeSshPasswordEnvironmentVariable(name, environment),
    "private-monitor-password",
  );
  assert.equal(Object.hasOwn(environment, name), false);

  for (const [value, code] of [
    [undefined, "SSH_PASSWORD_ENV_UNSET"],
    ["", "SSH_PASSWORD_INVALID"],
    ["line-one\nline-two", "SSH_PASSWORD_INVALID"],
  ]) {
    const candidate = value === undefined ? {} : { [name]: value };
    assert.throws(
      () => consumeSshPasswordEnvironmentVariable(name, candidate),
      (error) =>
        error instanceof PhysicalRaspberryMonitorError && error.code === code,
    );
    assert.equal(Object.hasOwn(candidate, name), false);
  }
});

test("resolves only an executable sshpass from PATH", (t) => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-physical-monitor-sshpass-path-"),
  );
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const sshpass = path.join(temporaryDirectory, "sshpass");
  fs.writeFileSync(sshpass, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.chmodSync(sshpass, 0o700);

  assert.equal(resolveSshpassExecutable({ PATH: temporaryDirectory }), sshpass);
  assert.throws(
    () => resolveSshpassExecutable({ PATH: path.dirname(process.execPath) }),
    (error) =>
      error instanceof PhysicalRaspberryMonitorError &&
      error.code === "SSHPASS_UNAVAILABLE",
  );
});

test("binds the redacted attestation to the finalized private journal", async (t) => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-physical-raspberry-monitor-"),
  );
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  const privateOutput = path.join(temporaryDirectory, "private.jsonl");
  const attestationOutput = path.join(temporaryDirectory, "attestation.json");
  const stopFile = path.join(temporaryDirectory, "stop");
  const counterFile = path.join(temporaryDirectory, "counter");
  const argumentsFile = path.join(temporaryDirectory, "arguments.jsonl");
  const fakeSsh = path.join(temporaryDirectory, "fake-ssh.mjs");
  const fakeSshSource = `#!/usr/bin/env node\n` +
    `import fs from "node:fs";\n` +
    `const counterFile = ${JSON.stringify(counterFile)};\n` +
    `const argumentsFile = ${JSON.stringify(argumentsFile)};\n` +
    `const stopFile = ${JSON.stringify(stopFile)};\n` +
    `fs.appendFileSync(argumentsFile, JSON.stringify(process.argv.slice(2)) + "\\n", { mode: 0o600 });\n` +
    `const count = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) + 1 : 1;\n` +
    `fs.writeFileSync(counterFile, String(count), { mode: 0o600 });\n` +
    `if (count >= 2) fs.writeFileSync(stopFile, "stop\\n", { mode: 0o600 });\n` +
    `process.stdout.write(${JSON.stringify(rawSnapshot())});\n`;
  fs.writeFileSync(fakeSsh, fakeSshSource, { mode: 0o700 });
  fs.chmodSync(fakeSsh, 0o700);

  const arguments_ = [
    MONITOR,
    "--host",
    "test-host",
    "--ssh",
    fakeSsh,
    "--poll-ms",
    "1000",
    "--private-output",
    privateOutput,
    "--attestation",
    attestationOutput,
    "--stop-file",
    stopFile,
  ];
  const firstRun = await execFileAsync(process.execPath, arguments_, {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    },
  });
  const privateBytes = fs.readFileSync(privateOutput);
  const attestationBytes = fs.readFileSync(attestationOutput);
  const attestation = JSON.parse(attestationBytes);
  const expectedDigest = crypto
    .createHash("sha256")
    .update(privateBytes)
    .digest("hex");

  assert.equal(attestation.privateJournalSha256, expectedDigest);
  assert.equal(JSON.parse(firstRun.stdout).privateJournalSha256, expectedDigest);
  assert.equal(attestation.coverage.sampleCount, 2);
  assert.equal(fs.statSync(privateOutput).mode & 0o777, 0o600);
  assert.equal(fs.statSync(attestationOutput).mode & 0o777, 0o644);
  assert.equal(fs.statSync(privateOutput).nlink, 1);
  assert.equal(fs.statSync(attestationOutput).nlink, 1);
  const sshInvocations = fs.readFileSync(argumentsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(sshInvocations.length, 2);
  for (const invocation of sshInvocations) {
    assert.ok(invocation.includes("BatchMode=yes"));
    assert.equal(invocation.includes("BatchMode=no"), false);
    assert.equal(invocation.includes("PreferredAuthentications=password"), false);
  }
  assert.deepEqual(
    fs.readdirSync(temporaryDirectory).filter((name) => name.endsWith(".tmp")),
    [],
  );
  assert.doesNotMatch(
    attestationBytes.toString("utf8"),
    /"(?:bootId|mainPid|hostname)"\s*:|192\.168\.|RFGY|R58Y/u,
  );

  await assert.rejects(
    execFileAsync(process.execPath, arguments_, {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      },
    }),
    (error) => /OUTPUT_INVALID/u.test(error.stderr),
  );
  assert.deepEqual(fs.readFileSync(privateOutput), privateBytes);
  assert.deepEqual(fs.readFileSync(attestationOutput), attestationBytes);
});

test("password SSH uses sshpass environment without leaking the secret", async (t) => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-physical-monitor-password-"),
  );
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  const privateOutput = path.join(temporaryDirectory, "private.jsonl");
  const attestationOutput = path.join(temporaryDirectory, "attestation.json");
  const stopFile = path.join(temporaryDirectory, "stop");
  const counterFile = path.join(temporaryDirectory, "counter");
  const invocationFile = path.join(temporaryDirectory, "sshpass-invocations.jsonl");
  const fakeSshpass = path.join(temporaryDirectory, "sshpass");
  const environmentName = "V5BT_TEST_MONITOR_SSH_PASSWORD";
  const password = "monitor-password-private-value";
  const fakeSsh = "/test-only/fake-ssh";
  const fakeSshpassSource = `#!/usr/bin/env node\n` +
    `import fs from "node:fs";\n` +
    `const counterFile = ${JSON.stringify(counterFile)};\n` +
    `const invocationFile = ${JSON.stringify(invocationFile)};\n` +
    `const stopFile = ${JSON.stringify(stopFile)};\n` +
    `const record = { argv: process.argv.slice(2), passwordMatches: process.env.SSHPASS === ${JSON.stringify(password)}, originalEnvironmentPresent: Object.hasOwn(process.env, ${JSON.stringify(environmentName)}) };\n` +
    `fs.appendFileSync(invocationFile, JSON.stringify(record) + "\\n", { mode: 0o600 });\n` +
    `const count = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) + 1 : 1;\n` +
    `fs.writeFileSync(counterFile, String(count), { mode: 0o600 });\n` +
    `if (count >= 2) fs.writeFileSync(stopFile, "stop\\n", { mode: 0o600 });\n` +
    `process.stdout.write(${JSON.stringify(rawSnapshot())});\n`;
  fs.writeFileSync(fakeSshpass, fakeSshpassSource, { mode: 0o700 });
  fs.chmodSync(fakeSshpass, 0o700);

  const execution = await execFileAsync(process.execPath, [
    MONITOR,
    "--host", "test-host",
    "--ssh", fakeSsh,
    "--ssh-password-env", environmentName,
    "--poll-ms", "1000",
    "--private-output", privateOutput,
    "--attestation", attestationOutput,
    "--stop-file", stopFile,
  ], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      [environmentName]: password,
      PATH: `${temporaryDirectory}:${path.dirname(process.execPath)}`,
    },
  });

  const invocations = fs.readFileSync(invocationFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    assert.equal(invocation.passwordMatches, true);
    assert.equal(invocation.originalEnvironmentPresent, false);
    assert.deepEqual(invocation.argv.slice(0, 2), ["-e", fakeSsh]);
    assert.ok(invocation.argv.includes("BatchMode=no"));
    assert.ok(invocation.argv.includes("PreferredAuthentications=password"));
    assert.ok(invocation.argv.includes("PasswordAuthentication=yes"));
    assert.ok(invocation.argv.includes("PubkeyAuthentication=no"));
    assert.ok(invocation.argv.includes("KbdInteractiveAuthentication=no"));
    assert.ok(invocation.argv.includes("NumberOfPasswordPrompts=1"));
    assert.equal(invocation.argv.includes("BatchMode=yes"), false);
    assert.equal(JSON.stringify(invocation.argv).includes(password), false);
  }

  const privateBytes = fs.readFileSync(privateOutput);
  const attestationBytes = fs.readFileSync(attestationOutput);
  assert.doesNotMatch(execution.stdout, new RegExp(password, "u"));
  assert.equal(privateBytes.includes(Buffer.from(password)), false);
  assert.equal(attestationBytes.includes(Buffer.from(password)), false);
  assert.equal(attestationBytes.includes(Buffer.from(environmentName)), false);
  assert.equal(JSON.parse(attestationBytes).verdict, "PASS");
});

for (const scenario of [
  {
    name: "unset password environment",
    code: "SSH_PASSWORD_ENV_UNSET",
    environmentValue: undefined,
  },
  {
    name: "empty password environment",
    code: "SSH_PASSWORD_INVALID",
    environmentValue: "",
  },
  {
    name: "missing sshpass",
    code: "SSHPASS_UNAVAILABLE",
    environmentValue: "monitor-password-private-value",
  },
]) {
  test(`fails closed for ${scenario.name} without leaking credentials`, async (t) => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "v5bt-physical-monitor-password-failure-"),
    );
    t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
    const privateOutput = path.join(temporaryDirectory, "private.jsonl");
    const attestationOutput = path.join(temporaryDirectory, "attestation.json");
    const stopFile = path.join(temporaryDirectory, "stop");
    const environmentName = "V5BT_TEST_MONITOR_SSH_PASSWORD";
    const environment = {
      ...process.env,
      PATH: path.dirname(process.execPath),
    };
    if (scenario.environmentValue !== undefined) {
      environment[environmentName] = scenario.environmentValue;
    } else {
      delete environment[environmentName];
    }

    await assert.rejects(
      execFileAsync(process.execPath, [
        MONITOR,
        "--host", "test-host",
        "--ssh", "/test-only/fake-ssh",
        "--ssh-password-env", environmentName,
        "--poll-ms", "1000",
        "--private-output", privateOutput,
        "--attestation", attestationOutput,
        "--stop-file", stopFile,
      ], {
        encoding: "utf8",
        timeout: 5000,
        env: environment,
      }),
      (error) => {
        const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
        assert.match(output, new RegExp(scenario.code, "u"));
        if (scenario.environmentValue) {
          assert.equal(output.includes(scenario.environmentValue), false);
        }
        return true;
      },
    );
    assert.equal(fs.existsSync(privateOutput), false);
    assert.equal(fs.existsSync(attestationOutput), false);
  });
}

test("help documents password environment authentication", async () => {
  const result = await execFileAsync(process.execPath, [MONITOR, "--help"], {
    encoding: "utf8",
  });
  assert.match(result.stdout, /--ssh-password-env NAME/u);
});
