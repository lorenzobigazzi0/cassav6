#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const SERVICES = Object.freeze([
  "cassav5bt.service",
  "bluetooth.service",
]);
const SERVICE_FIELDS = Object.freeze([
  "ActiveState",
  "SubState",
  "MainPID",
  "NRestarts",
  "ActiveEnterTimestampMonotonic",
  "ExecMainStartTimestampMonotonic",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SSH_KEY_OPTIONS = Object.freeze([
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
]);
const SSH_PASSWORD_OPTIONS = Object.freeze([
  "-o",
  "BatchMode=no",
  "-o",
  "PreferredAuthentications=password",
  "-o",
  "PasswordAuthentication=yes",
  "-o",
  "PubkeyAuthentication=no",
  "-o",
  "KbdInteractiveAuthentication=no",
  "-o",
  "NumberOfPasswordPrompts=1",
  "-o",
  "ConnectTimeout=5",
]);
const REMOTE_COMMAND = [
  "/usr/bin/date +%s%N",
  "/usr/bin/cat /proc/sys/kernel/random/boot_id",
  ...SERVICES.map(
    (service) =>
      `/usr/bin/systemctl show ${service} --no-page ${SERVICE_FIELDS.map((field) => `--property=${field}`).join(" ")}`,
  ),
].join("; printf '\\n--V5BT-MONITOR-SPLIT--\\n'; ");

export class PhysicalRaspberryMonitorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PhysicalRaspberryMonitorError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PhysicalRaspberryMonitorError(code, message);
}

export function consumeSshPasswordEnvironmentVariable(
  name,
  environment = process.env,
) {
  if (!ENVIRONMENT_NAME_PATTERN.test(name ?? "")) {
    fail("ARGUMENT_INVALID", "SSH password environment variable name is invalid");
  }
  const password = environment[name];
  delete environment[name];
  if (password === undefined) {
    fail("SSH_PASSWORD_ENV_UNSET", "SSH password environment variable is not set");
  }
  if (
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > 1024 ||
    /[\r\n\0]/u.test(password)
  ) {
    fail("SSH_PASSWORD_INVALID", "SSH password input is invalid");
  }
  return password;
}

export function resolveSshpassExecutable(
  environment = process.env,
  fileSystem = fs,
) {
  const searchPath = environment.PATH;
  if (typeof searchPath !== "string" || searchPath.length === 0) {
    fail("SSHPASS_UNAVAILABLE", "sshpass is unavailable");
  }
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.resolve(directory, "sshpass");
    try {
      fileSystem.accessSync(candidate, fs.constants.X_OK);
      if (fileSystem.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  fail("SSHPASS_UNAVAILABLE", "sshpass is unavailable");
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("SNAPSHOT_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail("SNAPSHOT_INVALID", `${label} has an invalid field set`);
  }
}

function parseUnsigned(value, label, { positive = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(normalized)) {
    fail("SNAPSHOT_INVALID", `${label} is invalid`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || (positive && parsed === 0)) {
    fail("SNAPSHOT_INVALID", `${label} is outside the supported range`);
  }
  return parsed;
}

function parseService(raw, expectedUnit) {
  const values = Object.fromEntries(
    String(raw)
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator <= 0) fail("SNAPSHOT_INVALID", "systemd output is invalid");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  exactKeys(values, SERVICE_FIELDS, expectedUnit);
  if (values.ActiveState !== "active" || values.SubState !== "running") {
    fail("SERVICE_NOT_RUNNING", `${expectedUnit} is not active/running`);
  }
  return Object.freeze({
    unit: expectedUnit,
    activeState: values.ActiveState,
    subState: values.SubState,
    mainPid: parseUnsigned(values.MainPID, `${expectedUnit}.MainPID`, {
      positive: true,
    }),
    nRestarts: parseUnsigned(values.NRestarts, `${expectedUnit}.NRestarts`),
    activeEnterTimestampMonotonic: parseUnsigned(
      values.ActiveEnterTimestampMonotonic,
      `${expectedUnit}.ActiveEnterTimestampMonotonic`,
      { positive: true },
    ),
    execMainStartTimestampMonotonic: parseUnsigned(
      values.ExecMainStartTimestampMonotonic,
      `${expectedUnit}.ExecMainStartTimestampMonotonic`,
      { positive: true },
    ),
  });
}

export function parsePhysicalRaspberrySnapshot(raw) {
  const parts = String(raw ?? "").split("\n--V5BT-MONITOR-SPLIT--\n");
  if (parts.length !== 4) {
    fail("SNAPSHOT_INVALID", "Raspberry snapshot framing is invalid");
  }
  const wallClockNsText = parts[0].trim();
  if (!/^[1-9]\d{18}$/u.test(wallClockNsText)) {
    fail("SNAPSHOT_INVALID", "Raspberry wall clock is invalid");
  }
  const wallClockNs = BigInt(wallClockNsText);
  const bootId = parts[1].trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(bootId)) {
    fail("SNAPSHOT_INVALID", "Raspberry boot identifier is invalid");
  }
  return Object.freeze({
    wallClockNs,
    bootId,
    services: Object.freeze([
      parseService(parts[2], SERVICES[0]),
      parseService(parts[3], SERVICES[1]),
    ]),
  });
}

export function assertPhysicalRaspberryContinuity(baseline, previous, current) {
  if (current.bootId !== baseline.bootId) {
    fail("RASPBERRY_REBOOTED", "Raspberry reboot detected");
  }
  if (current.wallClockNs < previous.wallClockNs) {
    fail("CLOCK_REGRESSION", "Raspberry wall clock regressed");
  }
  for (const expected of baseline.services) {
    const observed = current.services.find((entry) => entry.unit === expected.unit);
    if (!observed) fail("SNAPSHOT_INVALID", "Raspberry service is missing");
    if (
      observed.activeState !== expected.activeState ||
      observed.subState !== expected.subState
    ) {
      fail("SERVICE_STATE_CHANGED", `${expected.unit} changed state`);
    }
    if (
      observed.mainPid !== expected.mainPid ||
      observed.execMainStartTimestampMonotonic !==
        expected.execMainStartTimestampMonotonic
    ) {
      fail("SERVICE_PROCESS_CHANGED", `${expected.unit} process changed`);
    }
    if (observed.nRestarts !== expected.nRestarts) {
      fail("SERVICE_RESTARTED", `${expected.unit} restart count changed`);
    }
    if (
      observed.activeEnterTimestampMonotonic !==
      expected.activeEnterTimestampMonotonic
    ) {
      fail("SERVICE_ACTIVATION_CHANGED", `${expected.unit} activation changed`);
    }
  }
  return true;
}

function snapshotForPrivateLog(snapshot, sampledAt) {
  return {
    sampledAt,
    wallClockNs: snapshot.wallClockNs.toString(),
    bootId: snapshot.bootId,
    services: snapshot.services,
  };
}

export function buildPhysicalRaspberryAttestation({
  startedAt,
  stoppedAt,
  sampleCount,
  maximumObservedGapMs,
  pollMs,
  privateJournalSha256,
}) {
  const durationMs = Date.parse(stoppedAt) - Date.parse(startedAt);
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 2 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    !Number.isSafeInteger(maximumObservedGapMs) ||
    maximumObservedGapMs < 0 ||
    !SHA256_PATTERN.test(privateJournalSha256)
  ) {
    fail("ATTESTATION_INVALID", "Raspberry monitor coverage is incomplete");
  }
  return Object.freeze({
    schemaVersion: 1,
    product: "V5BT",
    mode: "REDACTED_PHYSICAL_RASPBERRY_CONTINUITY_ATTESTATION",
    evidenceClass: "SUPPLEMENTAL",
    verdict: "PASS",
    generatedAt: new Date().toISOString(),
    privateJournalSha256,
    coverage: Object.freeze({
      startedAt,
      stoppedAt,
      durationMs,
      pollMs,
      sampleCount,
      maximumObservedGapMs,
    }),
    checks: Object.freeze({
      fixedBoot: "PASS",
      monotonicWallClock: "PASS",
      mainServiceContinuity: "PASS",
      bluetoothServiceContinuity: "PASS",
      noServiceRestarts: "PASS",
      completePollingCoverage: "PASS",
    }),
    privacy: Object.freeze({
      hostnameIncluded: false,
      networkIdentifiersIncluded: false,
      bootIdentifierIncluded: false,
      processIdentifiersIncluded: false,
      localPathsIncluded: false,
    }),
    gate: Object.freeze({ b0: "PENDING", b2: "PENDING", b5: "PENDING" }),
  });
}

function ensureSecureParent(destination) {
  const resolved = path.resolve(destination);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    let metadata;
    try {
      metadata = fs.lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      metadata = fs.lstatSync(current);
    }
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && current !== resolved)) {
      fail("OUTPUT_INVALID", "monitor output path is unsafe");
    }
  }
}

function openPrivateJournal(destination) {
  const resolved = path.resolve(destination);
  ensureSecureParent(path.dirname(resolved));
  const descriptor = fs.openSync(
    resolved,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const metadata = fs.fstatSync(descriptor);
  if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) {
    fs.closeSync(descriptor);
    fail("OUTPUT_INVALID", "private monitor journal is unsafe");
  }
  return descriptor;
}

function writeRedactedAttestation(destination, value) {
  const resolved = path.resolve(destination);
  const parent = path.dirname(resolved);
  ensureSecureParent(parent);
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (
    /"(?:bootId|mainPid|hostname)"\s*:/iu.test(encoded) ||
    /192\.168\.|RFGY|R58Y/iu.test(encoded)
  ) {
    fail("ATTESTATION_PRIVACY_INVALID", "redacted attestation contains private data");
  }
  const temporary = path.join(
    parent,
    `.${path.basename(resolved)}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o644,
    );
    fs.fchmodSync(descriptor, 0o644);
    const metadata = fs.fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o644
    ) {
      fail("OUTPUT_INVALID", "redacted monitor attestation is unsafe");
    }
    fs.writeFileSync(descriptor, encoded, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, resolved);
    fs.unlinkSync(temporary);
    const directoryDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
    const published = fs.lstatSync(resolved);
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      published.nlink !== 1 ||
      (published.mode & 0o777) !== 0o644
    ) {
      fail("OUTPUT_INVALID", "redacted monitor attestation is unsafe");
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {}
    if (error instanceof PhysicalRaspberryMonitorError) throw error;
    fail("OUTPUT_INVALID", "redacted monitor attestation could not be published");
  }
}

function parseArguments(argv) {
  const options = {
    ssh: "ssh",
    sshPasswordEnv: null,
    sshPassword: null,
    sshpass: null,
    host: null,
    user: "admin",
    pollMs: 2_000,
    privateOutput: null,
    attestation: null,
    stopFile: null,
    help: false,
  };
  const allowed = new Set([
    "--ssh",
    "--ssh-password-env",
    "--host",
    "--user",
    "--poll-ms",
    "--private-output",
    "--attestation",
    "--stop-file",
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (!allowed.has(argument) || seen.has(argument)) {
      fail("ARGUMENT_INVALID", `unsupported or duplicate option: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      fail("ARGUMENT_INVALID", `${argument} requires a value`);
    }
    seen.add(argument);
    if (argument === "--ssh") options.ssh = value;
    else if (argument === "--ssh-password-env") options.sshPasswordEnv = value;
    else if (argument === "--host") options.host = value;
    else if (argument === "--user") options.user = value;
    else if (argument === "--poll-ms") options.pollMs = Number(value);
    else if (argument === "--private-output") options.privateOutput = path.resolve(value);
    else if (argument === "--attestation") options.attestation = path.resolve(value);
    else if (argument === "--stop-file") options.stopFile = path.resolve(value);
  }
  if (options.help) return options;
  if (
    typeof options.host !== "string" ||
    !/^[A-Za-z0-9.-]{1,253}$/u.test(options.host) ||
    typeof options.user !== "string" ||
    !/^[a-z_][a-z0-9_-]{0,31}$/u.test(options.user) ||
    !Number.isSafeInteger(options.pollMs) ||
    options.pollMs < 1_000 ||
    options.pollMs > 10_000 ||
    !options.privateOutput ||
    !options.attestation ||
    !options.stopFile ||
    new Set([options.privateOutput, options.attestation, options.stopFile]).size !== 3
  ) {
    fail("ARGUMENT_INVALID", "monitor arguments are incomplete or invalid");
  }
  if (
    options.sshPasswordEnv !== null &&
    !ENVIRONMENT_NAME_PATTERN.test(options.sshPasswordEnv)
  ) {
    fail("ARGUMENT_INVALID", "SSH password environment variable name is invalid");
  }
  return options;
}

function configureSshAuthentication(options) {
  if (options.sshPasswordEnv === null) return options;
  options.sshPassword = consumeSshPasswordEnvironmentVariable(
    options.sshPasswordEnv,
  );
  options.sshpass = resolveSshpassExecutable();
  return options;
}

async function capture(options) {
  try {
    const passwordAuthentication = options.sshPassword !== null;
    const sshArguments = [
      ...(passwordAuthentication ? SSH_PASSWORD_OPTIONS : SSH_KEY_OPTIONS),
      `${options.user}@${options.host}`,
      REMOTE_COMMAND,
    ];
    const executable = passwordAuthentication ? options.sshpass : options.ssh;
    const arguments_ = passwordAuthentication
      ? ["-e", options.ssh, ...sshArguments]
      : sshArguments;
    const childOptions = {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    };
    if (passwordAuthentication) {
      childOptions.env = { ...process.env, SSHPASS: options.sshPassword };
    }
    const result = await execFileAsync(
      executable,
      arguments_,
      childOptions,
    );
    return parsePhysicalRaspberrySnapshot(result.stdout);
  } catch (error) {
    if (error instanceof PhysicalRaspberryMonitorError) throw error;
    fail("SSH_CAPTURE_FAILED", "Raspberry continuity sample failed");
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function runMonitor(options) {
  if (fs.existsSync(options.privateOutput) || fs.existsSync(options.attestation)) {
    fail("OUTPUT_INVALID", "monitor outputs already exist");
  }
  if (fs.existsSync(options.stopFile)) fs.unlinkSync(options.stopFile);
  ensureSecureParent(path.dirname(options.stopFile));
  const journal = openPrivateJournal(options.privateOutput);
  const startedAt = new Date().toISOString();
  let previousStartedMs = Date.now();
  let maximumObservedGapMs = 0;
  let sampleCount = 0;
  let baseline;
  let previous;
  let failure = null;
  const privateJournalDigest = crypto.createHash("sha256");
  const append = (value) => {
    const encoded = `${JSON.stringify(value)}\n`;
    fs.writeFileSync(journal, encoded, "utf8");
    fs.fsyncSync(journal);
    privateJournalDigest.update(encoded, "utf8");
  };
  try {
    append({ schemaVersion: 1, product: "V5BT", mode: "PRIVATE_RASPBERRY_CONTINUITY_JOURNAL", startedAt });
    while (true) {
      const sampleStartedMs = Date.now();
      const gapMs = sampleStartedMs - previousStartedMs;
      if (sampleCount > 0) maximumObservedGapMs = Math.max(maximumObservedGapMs, gapMs);
      if (sampleCount > 0 && gapMs > options.pollMs * 4) {
        fail("POLLING_GAP", "Raspberry continuity polling gap exceeded the limit");
      }
      const snapshot = await capture(options);
      const sampledAt = new Date().toISOString();
      if (!baseline) baseline = snapshot;
      else assertPhysicalRaspberryContinuity(baseline, previous, snapshot);
      previous = snapshot;
      sampleCount += 1;
      append({ type: "sample", sequence: sampleCount, ...snapshotForPrivateLog(snapshot, sampledAt) });
      previousStartedMs = sampleStartedMs;
      if (fs.existsSync(options.stopFile)) {
        const metadata = fs.lstatSync(options.stopFile);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          fail("STOP_FILE_INVALID", "monitor stop file is unsafe");
        }
        break;
      }
      const elapsedMs = Date.now() - sampleStartedMs;
      await sleep(Math.max(0, options.pollMs - elapsedMs));
    }
  } catch (error) {
    failure = error;
  }
  const stoppedAt = new Date().toISOString();
  if (failure === null && sampleCount < 2) {
    failure = new PhysicalRaspberryMonitorError(
      "COVERAGE_INCOMPLETE",
      "Raspberry monitor requires at least two samples",
    );
  }
  if (failure === null) {
    append({ type: "final", stoppedAt, verdict: "PASS", sampleCount, maximumObservedGapMs });
    fs.closeSync(journal);
    const privateJournalSha256 = privateJournalDigest.digest("hex");
    const attestation = buildPhysicalRaspberryAttestation({
      startedAt,
      stoppedAt,
      sampleCount,
      maximumObservedGapMs,
      pollMs: options.pollMs,
      privateJournalSha256,
    });
    writeRedactedAttestation(options.attestation, attestation);
    process.stdout.write(`${JSON.stringify(attestation)}\n`);
    return;
  }
  append({
    type: "final",
    stoppedAt,
    verdict: "FAIL",
    code: failure instanceof PhysicalRaspberryMonitorError ? failure.code : "UNEXPECTED_FAILURE",
  });
  fs.closeSync(journal);
  throw failure;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/run-v5bt-physical-raspberry-monitor.mjs --host HOST \\",
    "    --private-output PRIVATE.jsonl --attestation REDACTED.json \\",
    "    --stop-file STOP [--ssh PATH] [--ssh-password-env NAME] \\",
    "    [--user admin] [--poll-ms 2000]",
  ].join("\n");
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    await runMonitor(configureSshAuthentication(options));
  } catch (error) {
    const code = error instanceof PhysicalRaspberryMonitorError ? error.code : "UNEXPECTED_FAILURE";
    process.stderr.write(`${code}: Raspberry continuity monitor failed\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
