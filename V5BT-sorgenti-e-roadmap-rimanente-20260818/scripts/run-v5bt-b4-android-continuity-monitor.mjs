#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING,
} from "../ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/scripts/advanced-certification-targets.mjs";
import {
  HarnessError,
  DISCOVERY_STATUS_FILE,
  parseAdbDevices,
  parseBoundInstalledApkSha256,
  parseCertifiedInstalledVersion,
  parseDiscoveryStatus,
  parseSingleInstalledApkPath,
} from "../ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/scripts/run-b2-android-adb-harness.mjs";
import {
  B5AndroidContinuityError,
  buildAdbCommandArgs,
  buildRunAsArgs,
  parseAndroidApi,
  parseApplicationExitCommitments,
  parseAuthenticatedSessionPreferences,
  parsePid,
  sessionBindingHmac,
} from "../ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/scripts/run-b5-android-continuity-monitor.mjs";
import {
  buildB4TargetHardwareCommitment,
} from "../ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/scripts/run-b4-monitored-slot-gate.mjs";

export const B4_ANDROID_CONTINUITY_MONITOR_VERSION = "1.0.2";

const execFileAsync = promisify(execFile);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SERIAL_PATTERN = /^[!-~]{1,200}$/u;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 5_000;
const MIN_COVERAGE_MS = 90_000;
const MAX_COVERAGE_MS = 600_000;
const ADB_TIMEOUT_MS = 5_000;
const REPORTER_FRESHNESS_MS = 5_000;
const FUTURE_SKEW_MS = 5_000;
const MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024;
const MAX_STATE_BYTES = 256 * 1_024;
const STABLE_HARDWARE_SERIAL_PATTERN = /^[A-Za-z0-9._:-]{4,128}$/u;
const PREFS_FILE = "shared_prefs/webkiosk_prefs.xml";
const TARGET = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;
const MATRIX_SHA256 = ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256;
const EXPECTED_DEPENDENCY_VALIDATION_CODES = new Set([
  "ADB_ARGUMENT_INVALID",
  "ADB_DEVICES_INVALID",
  "ANDROID_API_INVALID",
  "DISCOVERY_STATUS_INVALID",
  "EXIT_INFO_INVALID",
  "PROCESS_MISSING",
  "REPORTER_STALE",
  "SESSION_BINDING_INVALID",
  "SESSION_CONTEXT_INVALID",
  "SESSION_LOGGED_OUT",
]);

const ATTESTATION_FIELDS = Object.freeze([
  "schemaVersion",
  "harnessVersion",
  "product",
  "phase",
  "mode",
  "evidenceClass",
  "verdict",
  "generatedAt",
  "binding",
  "target",
  "coverage",
  "checks",
  "privacy",
  "gate",
]);

export class B4AndroidContinuityError extends Error {
  constructor(code, message, exitCode = 1, options = undefined) {
    super(message, options);
    this.name = "B4AndroidContinuityError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1, options = undefined) {
  throw new B4AndroidContinuityError(code, message, exitCode, options);
}

export function normalizeB4AndroidMonitorError(error) {
  if (error instanceof B4AndroidContinuityError) return error;
  if (
    (error instanceof B5AndroidContinuityError || error instanceof HarnessError) &&
    EXPECTED_DEPENDENCY_VALIDATION_CODES.has(error.code)
  ) {
    return new B4AndroidContinuityError(
      error.code,
      "Android B4 dependency validation failed",
    );
  }
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, expected, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index])
  ) {
    fail(code, `${label} has an invalid field set`);
  }
  return value;
}

function integer(value, minimum, maximum, code, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function timestamp(value, code, label) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail(code, `${label} is invalid`);
  }
  return milliseconds;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validSha256(value) {
  return (
    typeof value === "string" &&
    SHA256_PATTERN.test(value) &&
    !/^0{64}$/u.test(value)
  );
}

function requireUuidV4(value, code = "RUN_BINDING_INVALID") {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    fail(code, "B4 run identifier is invalid");
  }
  return value;
}

function maximumPollingGapMs(pollMs) {
  return pollMs + ADB_TIMEOUT_MS;
}

export function buildB4RunCommitments({ collectionRunId, captureRunId }) {
  requireUuidV4(collectionRunId);
  requireUuidV4(captureRunId);
  if (collectionRunId === captureRunId) {
    fail("RUN_BINDING_INVALID", "Collection and capture runs must be distinct");
  }
  return Object.freeze({
    collectionRunCommitmentSha256: sha256(
      Buffer.from(`V5BT:B4:COLLECTION_RUN:${collectionRunId}`, "utf8"),
    ),
    captureRunCommitmentSha256: sha256(
      Buffer.from(`V5BT:B4:CAPTURE_RUN:${captureRunId}`, "utf8"),
    ),
  });
}

export function validateDiscoveryReporter(status, nowMs) {
  if (
    status.ready !== true ||
    status.readiness !== "READY" ||
    status.radioActive !== true ||
    status.reporterStartedAtEpochMs > status.sampledAtEpochMs ||
    status.sampledAtEpochMs < nowMs - REPORTER_FRESHNESS_MS ||
    status.sampledAtEpochMs > nowMs + FUTURE_SKEW_MS ||
    status.metrics.advertisementsStarted < 1 ||
    status.metrics.advertisementFailures !== 0 ||
    status.metrics.scanFailures !== 0 ||
    status.metrics.scanIngressDropped !== 0 ||
    status.metrics.invalidPayloads !== 0
  ) {
    fail("DISCOVERY_REPORTER_NOT_READY", "Android discovery reporter is not ready");
  }
  return status;
}

function parseCurrentUser(raw) {
  const value = String(raw ?? "").trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    fail("ANDROID_USER_INVALID", "Current Android user is invalid");
  }
  return integer(
    Number(value),
    0,
    Number.MAX_SAFE_INTEGER,
    "ANDROID_USER_INVALID",
    "Current Android user",
  );
}

export function buildPackageUidQueryArgs(currentUser, packageName) {
  integer(
    currentUser,
    0,
    Number.MAX_SAFE_INTEGER,
    "PACKAGE_UID_INVALID",
    "Android user",
  );
  if (
    typeof packageName !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(
      packageName,
    )
  ) {
    fail("PACKAGE_UID_INVALID", "Android package name is invalid");
  }
  return Object.freeze([
    "shell",
    "cmd",
    "package",
    "list",
    "packages",
    "-U",
    "--user",
    String(currentUser),
    packageName,
  ]);
}

export function parsePackageUidListing(raw, expectedPackageName) {
  const lines = String(raw ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    fail(
      "PACKAGE_UID_INVALID",
      "Package UID query must return exactly one package",
    );
  }
  const match = /^package:([^\s]+) uid:([1-9][0-9]*)$/u.exec(lines[0]);
  if (match === null || match[1] !== expectedPackageName) {
    fail(
      "PACKAGE_UID_INVALID",
      "Package UID query did not return the exact monitored package",
    );
  }
  const uid = Number(match[2]);
  return integer(
    uid,
    10_000,
    Number.MAX_SAFE_INTEGER,
    "PACKAGE_UID_INVALID",
    "Package UID",
  );
}

export function parsePackageStoppedState(raw, currentUser) {
  integer(
    currentUser,
    0,
    Number.MAX_SAFE_INTEGER,
    "PACKAGE_USER_STATE_INVALID",
    "Android user",
  );
  const userLines = [];
  for (const line of String(raw ?? "").split(/\r?\n/u)) {
    const match = /^\s*User ([0-9]+):\s+(.+?)\s*$/u.exec(line);
    if (match === null || Number(match[1]) !== currentUser) continue;
    userLines.push(match[2]);
  }
  if (userLines.length !== 1) {
    fail(
      "PACKAGE_USER_STATE_INVALID",
      "Dumpsys must contain exactly one state row for the current user",
    );
  }
  const stoppedTokens = userLines[0]
    .split(/\s+/u)
    .filter((token) => token.startsWith("stopped="));
  if (
    stoppedTokens.length !== 1 ||
    !/^stopped=(?:true|false)$/u.test(stoppedTokens[0])
  ) {
    fail(
      "PACKAGE_USER_STATE_INVALID",
      "Current-user package state does not contain one exact stopped flag",
    );
  }
  return stoppedTokens[0] === "stopped=true";
}

function sameStringSet(left, right) {
  if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) {
    return false;
  }
  return [...left].every((value) => right.has(value));
}

function redact(value, secrets) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  return text;
}

async function runAdb(options, serial, args, signal, secrets = []) {
  try {
    const result = await execFileAsync(
      options.adb,
      buildAdbCommandArgs(serial, args),
      {
        encoding: "utf8",
        maxBuffer: 128 * 1_024,
        timeout: ADB_TIMEOUT_MS,
        signal,
        windowsHide: true,
      },
    );
    return result.stdout ?? "";
  } catch (error) {
    if (signal?.aborted) {
      fail("MONITOR_INTERRUPTED", "Android B4 monitor was interrupted", 130);
    }
    const detail = redact(error?.stderr || error?.message, secrets);
    fail("ADB_COMMAND_FAILED", detail || "ADB command failed", 1, {
      cause: error,
    });
  }
}

async function captureSample(options, sessionKey, signal, includeApkDigest) {
  const secrets = [options.serial, options.packageName];
  const devicesRaw = await runAdb(options, null, ["devices"], signal, secrets);
  const matchingDevices = parseAdbDevices(devicesRaw).filter(
    (device) => device.serial === options.serial,
  );
  if (matchingDevices.length !== 1 || matchingDevices[0].state !== "device") {
    fail("ADB_TARGET_UNAVAILABLE", "Fixed Android target is unavailable");
  }
  const currentUser = parseCurrentUser(
    await runAdb(
      options,
      options.serial,
      ["shell", "am", "get-current-user"],
      signal,
      secrets,
    ),
  );
  const nowMs = Date.now();
  const [
    apiRaw,
    packageRaw,
    packageUidRaw,
    pidRaw,
    exitInfoRaw,
    discoveryRaw,
    prefsRaw,
    apkPathRaw,
    emulatorRaw,
    hardwareSerialRaw,
    bootHardwareSerialRaw,
  ] = await Promise.all([
    runAdb(
      options,
      options.serial,
      ["shell", "getprop", "ro.build.version.sdk"],
      signal,
      secrets,
    ),
    runAdb(
      options,
      options.serial,
      ["shell", "dumpsys", "package", options.packageName],
      signal,
      secrets,
    ),
    runAdb(
      options,
      options.serial,
      buildPackageUidQueryArgs(currentUser, options.packageName),
      signal,
      secrets,
    ),
    runAdb(
      options,
      options.serial,
      ["shell", "pidof", "-s", options.packageName],
      signal,
      secrets,
    ),
    runAdb(
      options,
      options.serial,
      ["shell", "dumpsys", "activity", "exit-info", options.packageName],
      signal,
      secrets,
    ),
    runAdb(
      options,
      options.serial,
      buildRunAsArgs(options.packageName, currentUser, DISCOVERY_STATUS_FILE),
      signal,
      secrets,
    ),
    runAdb(
      options,
      options.serial,
      buildRunAsArgs(options.packageName, currentUser, PREFS_FILE),
      signal,
      secrets,
    ),
    includeApkDigest
      ? runAdb(
          options,
          options.serial,
          ["shell", "pm", "path", options.packageName],
          signal,
          secrets,
        )
      : Promise.resolve(""),
    runAdb(
      options,
      options.serial,
      ["shell", "getprop", "ro.kernel.qemu"],
      signal,
      secrets,
    ),
    runAdb(
      options,
      options.serial,
      ["shell", "getprop", "ro.serialno"],
      signal,
      secrets,
    ),
    runAdb(
      options,
      options.serial,
      ["shell", "getprop", "ro.boot.serialno"],
      signal,
      secrets,
    ),
  ]);
  const installedVersion = parseCertifiedInstalledVersion(packageRaw);
  if (installedVersion === null) {
    fail("PACKAGE_VERSION_INVALID", "Installed Android version is invalid");
  }
  const appUid = parsePackageUidListing(packageUidRaw, options.packageName);
  if (parsePackageStoppedState(packageRaw, currentUser)) {
    fail("PACKAGE_STOPPED", "Android package is stopped");
  }
  const session = parseAuthenticatedSessionPreferences(prefsRaw);
  const discovery = validateDiscoveryReporter(
    parseDiscoveryStatus(discoveryRaw),
    nowMs,
  );
  if (String(emulatorRaw ?? "").trim() === "1") {
    fail("EMULATOR_NOT_ALLOWED", "The B4 gate requires physical Android hardware");
  }
  const stableHardwareSerial = [hardwareSerialRaw, bootHardwareSerialRaw]
    .map((value) => String(value ?? "").trim())
    .find((value) => STABLE_HARDWARE_SERIAL_PATTERN.test(value));
  if (stableHardwareSerial === undefined) {
    fail("HARDWARE_IDENTITY_INVALID", "Stable Android hardware identity is invalid");
  }
  const sample = {
    sampledAt: new Date(nowMs).toISOString(),
    androidApi: parseAndroidApi(apiRaw),
    currentUser,
    installedVersion,
    appUid,
    pid: parsePid(pidRaw),
    discovery,
    sessionBindingHmacSha256: sessionBindingHmac(session, sessionKey),
    exitInfo: parseApplicationExitCommitments(
      exitInfoRaw,
      currentUser,
      options.packageName,
    ),
    stableHardwareSerial,
  };
  for (const secret of Object.values(session)) {
    if (typeof secret === "string" && secret.length > 0) secrets.push(secret);
  }
  if (includeApkDigest) {
    const apkPath = parseSingleInstalledApkPath(apkPathRaw);
    if (apkPath === null) {
      fail("APK_LAYOUT_INVALID", "Installed APK layout is invalid");
    }
    const apkSha256 = parseBoundInstalledApkSha256(
      await runAdb(
        options,
        options.serial,
        ["exec-out", "sha256sum", apkPath],
        signal,
        [...secrets, apkPath],
      ),
      apkPath,
    );
    if (apkSha256 === null) {
      fail("APK_DIGEST_INVALID", "Installed APK digest is invalid");
    }
    sample.apkSha256 = apkSha256;
  }
  return Object.freeze(sample);
}

function validateBaseline(sample, options, identityKey) {
  if (
    sample.currentUser !== options.androidUserId ||
    sample.installedVersion.versionName !== TARGET.versionName ||
    sample.installedVersion.versionCode !== TARGET.versionCode ||
    sample.apkSha256 !== TARGET.sha256 ||
    sample.androidApi < 33
  ) {
    fail("TARGET_NOT_CERTIFIED", "Installed Android target is not certified");
  }
  return Object.freeze({
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
    targetHardwareCommitmentSha256: buildB4TargetHardwareCommitment(
      identityKey,
      sample.stableHardwareSerial,
      options.captureRunId,
    ),
  });
}

export function assertB4AndroidContinuity(baseline, previous, sample) {
  if (
    sample.androidApi !== baseline.androidApi ||
    sample.currentUser !== baseline.currentUser ||
    sample.appUid !== baseline.appUid ||
    sample.pid !== baseline.pid ||
    sample.installedVersion.versionName !== baseline.versionName ||
    sample.installedVersion.versionCode !== baseline.versionCode ||
    sample.stableHardwareSerial !== baseline.stableHardwareSerial
  ) {
    fail("TARGET_CONTINUITY_CHANGED", "Android target continuity changed");
  }
  if (
    sample.discovery.reporterStartedAtEpochMs !==
      baseline.discoveryReporterStartedAtEpochMs
  ) {
    fail("REPORTER_CONTINUITY_CHANGED", "Android discovery reporter restarted");
  }
  const duplicateSequence =
    sample.discovery.sampleSequence === previous.discoverySampleSequence;
  const duplicateTimestamp =
    sample.discovery.sampledAtEpochMs === previous.discoverySampledAtEpochMs;
  if (
    sample.discovery.sampleSequence < previous.discoverySampleSequence ||
    sample.discovery.sampledAtEpochMs < previous.discoverySampledAtEpochMs ||
    duplicateSequence !== duplicateTimestamp
  ) {
    fail(
      "REPORTER_CONTINUITY_CHANGED",
      "Android discovery reporter sample regressed or changed inconsistently",
    );
  }
  if (sample.sessionBindingHmacSha256 !== baseline.sessionBindingHmacSha256) {
    fail("SESSION_CHANGED", "Android authenticated session changed");
  }
  if (!sameStringSet(sample.exitInfo.commitments, baseline.exitInfoCommitments)) {
    fail("APPLICATION_EXIT_RECORDED", "Android application exit state changed");
  }
  return Object.freeze({
    discoverySampleSequence: sample.discovery.sampleSequence,
    discoverySampledAtEpochMs: sample.discovery.sampledAtEpochMs,
  });
}

function assertNoSymlinkComponents(location, code = "OUTPUT_UNSAFE") {
  const resolved = path.resolve(location);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    try {
      const status = fs.lstatSync(current);
      if (status.isSymbolicLink()) fail(code, "Monitor paths must not use symlinks");
    } catch (error) {
      if (error instanceof B4AndroidContinuityError) throw error;
      if (error?.code === "ENOENT") break;
      fail(code, "Monitor path cannot be inspected", 1, { cause: error });
    }
  }
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function requirePrivateParent(destination) {
  const parent = path.dirname(path.resolve(destination));
  assertNoSymlinkComponents(parent);
  let status;
  try {
    status = fs.lstatSync(parent);
  } catch (error) {
    fail("OUTPUT_UNSAFE", "Private output directory is unavailable", 1, {
      cause: error,
    });
  }
  const uid = currentUid();
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o777) !== 0o700 ||
    (uid !== null && status.uid !== uid)
  ) {
    fail("OUTPUT_UNSAFE", "Private output directory must use mode 0700");
  }
  return parent;
}

function requirePrivateFile(status, label) {
  const uid = currentUid();
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (status.mode & 0o777) !== 0o600 ||
    (uid !== null && status.uid !== uid)
  ) {
    fail("OUTPUT_TAMPERED", `${label} must be an owned 0600 regular file`);
  }
}

function openPrivateOutput(destination, label) {
  const resolved = path.resolve(destination);
  requirePrivateParent(resolved);
  assertNoSymlinkComponents(resolved);
  if (fs.existsSync(resolved)) fail("OUTPUT_EXISTS", `${label} already exists`);
  let descriptor;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0),
      0o600,
    );
    const status = fs.fstatSync(descriptor);
    requirePrivateFile(status, label);
    return {
      descriptor,
      dev: status.dev,
      ino: status.ino,
      location: resolved,
      bytes: 0,
    };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof B4AndroidContinuityError) throw error;
    fail("OUTPUT_UNSAFE", `${label} cannot be created`, 1, { cause: error });
  }
}

function appendJournal(journal, value, digest) {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const before = fs.fstatSync(journal.descriptor);
  requirePrivateFile(before, "Private journal");
  if (before.dev !== journal.dev || before.ino !== journal.ino) {
    fail("OUTPUT_TAMPERED", "Private journal identity changed");
  }
  journal.bytes += encoded.byteLength;
  if (journal.bytes > MAX_OUTPUT_BYTES) {
    fail("OUTPUT_TOO_LARGE", "Private journal is too large");
  }
  fs.writeFileSync(journal.descriptor, encoded);
  fs.fsyncSync(journal.descriptor);
  const after = fs.fstatSync(journal.descriptor);
  requirePrivateFile(after, "Private journal");
  if (
    after.dev !== journal.dev ||
    after.ino !== journal.ino ||
    after.size !== journal.bytes
  ) {
    fail("OUTPUT_TAMPERED", "Private journal changed unexpectedly");
  }
  digest.update(encoded);
}

function closeAndVerifyJournal(journal, expectedSha256) {
  requirePrivateFile(fs.fstatSync(journal.descriptor), "Private journal");
  fs.closeSync(journal.descriptor);
  journal.descriptor = undefined;
  const status = fs.lstatSync(journal.location);
  requirePrivateFile(status, "Private journal");
  if (
    status.dev !== journal.dev ||
    status.ino !== journal.ino ||
    status.size !== journal.bytes ||
    sha256(fs.readFileSync(journal.location)) !== expectedSha256
  ) {
    fail("OUTPUT_TAMPERED", "Private journal verification failed");
  }
}

function fsyncDirectory(location, fileSystem = fs) {
  const descriptor = fileSystem.openSync(location, fs.constants.O_RDONLY);
  try {
    fileSystem.fsyncSync(descriptor);
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function matchesFileIdentity(location, expected, fileSystem = fs) {
  try {
    const status = fileSystem.lstatSync(location);
    return (
      status.isFile() &&
      !status.isSymbolicLink() &&
      status.dev === expected.dev &&
      status.ino === expected.ino
    );
  } catch {
    return false;
  }
}

export function publishPrivateJson(destination, value, runtime = {}) {
  const fileSystem = runtime.fileSystem ?? fs;
  const resolved = path.resolve(destination);
  const parent = requirePrivateParent(resolved);
  assertNoSymlinkComponents(resolved);
  if (fs.existsSync(resolved)) {
    fail("OUTPUT_EXISTS", "Android attestation already exists");
  }
  const encoded = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const text = encoded.toString("utf8");
  if (
    /"(?:serial|pid|appUid|account|token|nodeId|collectionRunId|captureRunId|localPath)"\s*:/iu.test(
      text,
    ) ||
    /(?:\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b|RFGY|R58Y)/iu.test(text)
  ) {
    fail("ATTESTATION_PRIVACY_INVALID", "Android attestation is not redacted");
  }
  const expectedSha256 = sha256(encoded);
  const temporary = path.join(parent, `.b4-android-${crypto.randomUUID()}.tmp`);
  let descriptor;
  let identity;
  let destinationCreated = false;
  try {
    descriptor = fileSystem.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0),
      0o600,
    );
    const created = fileSystem.fstatSync(descriptor);
    requirePrivateFile(created, "Temporary Android attestation");
    identity = { dev: created.dev, ino: created.ino };
    fileSystem.writeFileSync(descriptor, encoded);
    fileSystem.fsyncSync(descriptor);
    const written = fileSystem.fstatSync(descriptor);
    requirePrivateFile(written, "Temporary Android attestation");
    if (
      written.dev !== identity.dev ||
      written.ino !== identity.ino ||
      written.size !== encoded.byteLength
    ) {
      fail("OUTPUT_TAMPERED", "Temporary Android attestation changed");
    }
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.linkSync(temporary, resolved);
    destinationCreated = true;
    fileSystem.unlinkSync(temporary);
    fsyncDirectory(parent, fileSystem);

    descriptor = fileSystem.openSync(
      resolved,
      fs.constants.O_RDONLY |
        (process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0),
    );
    const before = fileSystem.fstatSync(descriptor);
    requirePrivateFile(before, "Android attestation");
    const published = fileSystem.readFileSync(descriptor);
    const after = fileSystem.fstatSync(descriptor);
    requirePrivateFile(after, "Android attestation");
    if (
      before.dev !== identity.dev ||
      before.ino !== identity.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      published.byteLength !== encoded.byteLength ||
      sha256(published) !== expectedSha256
    ) {
      fail("OUTPUT_TAMPERED", "Android attestation verification failed");
    }
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    let rollbackIncomplete = false;
    const destinationBelongsToAttempt =
      identity !== undefined &&
      matchesFileIdentity(resolved, identity, fileSystem);
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        rollbackIncomplete = true;
      }
    }
    if (destinationBelongsToAttempt) {
      try {
        fileSystem.unlinkSync(resolved);
      } catch {
        rollbackIncomplete = true;
      }
    } else if (destinationCreated) {
      rollbackIncomplete = true;
    }
    try {
      fileSystem.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") rollbackIncomplete = true;
    }
    try {
      fsyncDirectory(parent, fileSystem);
    } catch {
      rollbackIncomplete = true;
    }
    if (
      fileSystem.existsSync(temporary) ||
      (destinationBelongsToAttempt &&
        matchesFileIdentity(resolved, identity, fileSystem))
    ) {
      rollbackIncomplete = true;
    }
    if (rollbackIncomplete) {
      fail(
        "OUTPUT_ROLLBACK_INCOMPLETE",
        "Android attestation rollback is incomplete",
      );
    }
    if (error instanceof B4AndroidContinuityError) throw error;
    if (error?.code === "EEXIST") {
      fail("OUTPUT_EXISTS", "Android attestation already exists", 1, {
        cause: error,
      });
    }
    fail("OUTPUT_UNSAFE", "Android attestation cannot be published", 1, {
      cause: error,
    });
  }
}

export function readB4CollectorIdentityBinding(statePath) {
  const resolved = path.resolve(statePath);
  assertNoSymlinkComponents(resolved, "COLLECTOR_STATE_INVALID");
  let descriptor;
  let identityKey;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY |
        (process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0),
    );
    const before = fs.fstatSync(descriptor);
    requirePrivateFile(before, "Collector state");
    if (before.size < 2 || before.size > MAX_STATE_BYTES) {
      fail("COLLECTOR_STATE_INVALID", "Collector state size is invalid");
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      Buffer.byteLength(raw, "utf8") !== before.size
    ) {
      fail("COLLECTOR_STATE_INVALID", "Collector state changed while reading");
    }
    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      fail("COLLECTOR_STATE_INVALID", "Collector state is malformed");
    }
    if (
      !isRecord(state) ||
      state.schemaVersion !== 2 ||
      state.product !== "V5BT" ||
      state.phase !== "B4" ||
      !UUID_V4_PATTERN.test(state.runId) ||
      !isRecord(state.certificationMatrixBinding) ||
      state.certificationMatrixBinding.matrixSha256 !== MATRIX_SHA256 ||
      typeof state.identityKeyBase64Url !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(state.identityKeyBase64Url)
    ) {
      fail("COLLECTOR_STATE_INVALID", "Collector state binding is invalid");
    }
    identityKey = Buffer.from(state.identityKeyBase64Url, "base64url");
    if (
      identityKey.byteLength !== 32 ||
      identityKey.toString("base64url") !== state.identityKeyBase64Url
    ) {
      identityKey.fill(0);
      fail("COLLECTOR_STATE_INVALID", "Collector identity key is invalid");
    }
    return Object.freeze({
      collectionRunId: state.runId,
      certificationMatrixSha256:
        state.certificationMatrixBinding.matrixSha256,
      identityKey,
    });
  } catch (error) {
    identityKey?.fill(0);
    if (error instanceof B4AndroidContinuityError) throw error;
    fail("COLLECTOR_STATE_INVALID", "Collector state cannot be read safely", 1, {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function buildB4AndroidContinuityAttestation({
  collectionRunId,
  captureRunId,
  certificationMatrixSha256,
  privateJournalSha256,
  targetHardwareCommitmentSha256,
  androidApi,
  monitoredFrom,
  monitoredUntil,
  durationMs,
  pollMs,
  sampleCount,
  maximumObservedGapMs,
  generatedAt = new Date().toISOString(),
}) {
  const commitments = buildB4RunCommitments({ collectionRunId, captureRunId });
  if (
    certificationMatrixSha256 !== MATRIX_SHA256 ||
    !validSha256(privateJournalSha256) ||
    !validSha256(targetHardwareCommitmentSha256)
  ) {
    fail("ATTESTATION_INVALID", "Android attestation binding is invalid");
  }
  const fromMs = timestamp(monitoredFrom, "ATTESTATION_INVALID", "monitoredFrom");
  const untilMs = timestamp(monitoredUntil, "ATTESTATION_INVALID", "monitoredUntil");
  const generatedAtMs = timestamp(generatedAt, "ATTESTATION_INVALID", "generatedAt");
  integer(durationMs, MIN_COVERAGE_MS, MAX_COVERAGE_MS, "ATTESTATION_INVALID", "durationMs");
  integer(pollMs, MIN_POLL_MS, MAX_POLL_MS, "ATTESTATION_INVALID", "pollMs");
  integer(sampleCount, 2, Number.MAX_SAFE_INTEGER, "ATTESTATION_INVALID", "sampleCount");
  integer(
    maximumObservedGapMs,
    0,
    maximumPollingGapMs(pollMs),
    "ATTESTATION_INVALID",
    "maximumObservedGapMs",
  );
  integer(androidApi, 33, 10_000, "ATTESTATION_INVALID", "androidApi");
  if (
    durationMs !== untilMs - fromMs ||
    generatedAtMs < untilMs ||
    (sampleCount - 1) * maximumPollingGapMs(pollMs) < durationMs
  ) {
    fail("ATTESTATION_INVALID", "Android attestation chronology is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B4_ANDROID_CONTINUITY_MONITOR_VERSION,
    product: "V5BT",
    phase: "B4",
    mode: "REDACTED_B4_ANDROID_CONTINUITY_ATTESTATION",
    evidenceClass: "PHYSICAL_GATE_SUPPORT",
    verdict: "PASS",
    generatedAt,
    binding: Object.freeze({
      ...commitments,
      certificationMatrixSha256,
      privateJournalSha256,
      targetHardwareCommitmentSha256,
    }),
    target: Object.freeze({
      role: "handheld",
      packageName: TARGET.packageId,
      versionName: TARGET.versionName,
      versionCode: TARGET.versionCode,
      apkSha256: TARGET.sha256,
      signingCertificateSha256: TARGET.signingCertificateSha256,
      androidApi,
    }),
    coverage: Object.freeze({
      monitoredFrom,
      monitoredUntil,
      durationMs,
      pollMs,
      sampleCount,
      maximumObservedGapMs,
    }),
    checks: Object.freeze({
      fixedAdbTarget: "PASS",
      fixedCertifiedPackage: "PASS",
      fixedAndroidUser: "PASS",
      fixedProcess: "PASS",
      fixedReporter: "PASS",
      continuousAuthenticatedSession: "PASS",
      continuousReadyRadio: "PASS",
      noCrashAnrOrForceStop: "PASS",
      monotonicWallClock: "PASS",
      completePollingCoverage: "PASS",
    }),
    privacy: Object.freeze({
      serialIncluded: false,
      processIdentifiersIncluded: false,
      accountIncluded: false,
      sessionSecretsIncluded: false,
      enrollmentIncluded: false,
      networkIdentifiersIncluded: false,
      runIdentifiersIncluded: false,
      localPathsIncluded: false,
    }),
    gate: Object.freeze({ b4: "PENDING", authoritativeGateExecuted: false }),
  });
}

export function parseB4AndroidContinuityAttestation(value, expected = {}) {
  let document;
  try {
    document = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    fail("ATTESTATION_INVALID", "Android attestation is not valid JSON");
  }
  exactFields(document, ATTESTATION_FIELDS, "ATTESTATION_INVALID", "Attestation");
  if (
    document.schemaVersion !== 1 ||
    document.harnessVersion !== B4_ANDROID_CONTINUITY_MONITOR_VERSION ||
    document.product !== "V5BT" ||
    document.phase !== "B4" ||
    document.mode !== "REDACTED_B4_ANDROID_CONTINUITY_ATTESTATION" ||
    document.evidenceClass !== "PHYSICAL_GATE_SUPPORT" ||
    document.verdict !== "PASS"
  ) {
    fail("ATTESTATION_INVALID", "Android attestation header is invalid");
  }
  exactFields(
    document.binding,
    [
      "collectionRunCommitmentSha256",
      "captureRunCommitmentSha256",
      "certificationMatrixSha256",
      "privateJournalSha256",
      "targetHardwareCommitmentSha256",
    ],
    "ATTESTATION_INVALID",
    "Attestation binding",
  );
  if (Object.values(document.binding).some((digest) => !validSha256(digest))) {
    fail("ATTESTATION_INVALID", "Android attestation digest is invalid");
  }
  if (document.binding.certificationMatrixSha256 !== MATRIX_SHA256) {
    fail("ATTESTATION_INVALID", "Android attestation matrix is not certified");
  }
  exactFields(
    document.target,
    [
      "role",
      "packageName",
      "versionName",
      "versionCode",
      "apkSha256",
      "signingCertificateSha256",
      "androidApi",
    ],
    "ATTESTATION_INVALID",
    "Attestation target",
  );
  const targetFields = {
    role: "handheld",
    packageName: TARGET.packageId,
    versionName: TARGET.versionName,
    versionCode: TARGET.versionCode,
    apkSha256: TARGET.sha256,
    signingCertificateSha256: TARGET.signingCertificateSha256,
  };
  if (
    Object.entries(targetFields).some(([field, value]) => document.target[field] !== value)
  ) {
    fail("ATTESTATION_INVALID", "Android attestation target is not certified");
  }
  integer(document.target.androidApi, 33, 10_000, "ATTESTATION_INVALID", "androidApi");
  exactFields(
    document.coverage,
    [
      "monitoredFrom",
      "monitoredUntil",
      "durationMs",
      "pollMs",
      "sampleCount",
      "maximumObservedGapMs",
    ],
    "ATTESTATION_INVALID",
    "Attestation coverage",
  );
  const fromMs = timestamp(document.coverage.monitoredFrom, "ATTESTATION_INVALID", "monitoredFrom");
  const untilMs = timestamp(document.coverage.monitoredUntil, "ATTESTATION_INVALID", "monitoredUntil");
  const generatedAtMs = timestamp(document.generatedAt, "ATTESTATION_INVALID", "generatedAt");
  integer(document.coverage.durationMs, MIN_COVERAGE_MS, MAX_COVERAGE_MS, "ATTESTATION_INVALID", "durationMs");
  integer(document.coverage.pollMs, MIN_POLL_MS, MAX_POLL_MS, "ATTESTATION_INVALID", "pollMs");
  integer(document.coverage.sampleCount, 2, Number.MAX_SAFE_INTEGER, "ATTESTATION_INVALID", "sampleCount");
  integer(
    document.coverage.maximumObservedGapMs,
    0,
    maximumPollingGapMs(document.coverage.pollMs),
    "ATTESTATION_INVALID",
    "maximumObservedGapMs",
  );
  if (
    document.coverage.durationMs !== untilMs - fromMs ||
    generatedAtMs < untilMs ||
    (document.coverage.sampleCount - 1) * maximumPollingGapMs(document.coverage.pollMs) <
      document.coverage.durationMs
  ) {
    fail("ATTESTATION_INVALID", "Android attestation chronology is invalid");
  }
  const checkFields = [
    "fixedAdbTarget",
    "fixedCertifiedPackage",
    "fixedAndroidUser",
    "fixedProcess",
    "fixedReporter",
    "continuousAuthenticatedSession",
    "continuousReadyRadio",
    "noCrashAnrOrForceStop",
    "monotonicWallClock",
    "completePollingCoverage",
  ];
  exactFields(document.checks, checkFields, "ATTESTATION_INVALID", "Attestation checks");
  if (checkFields.some((field) => document.checks[field] !== "PASS")) {
    fail("ATTESTATION_INVALID", "Android attestation checks are incomplete");
  }
  const privacyFields = [
    "serialIncluded",
    "processIdentifiersIncluded",
    "accountIncluded",
    "sessionSecretsIncluded",
    "enrollmentIncluded",
    "networkIdentifiersIncluded",
    "runIdentifiersIncluded",
    "localPathsIncluded",
  ];
  exactFields(document.privacy, privacyFields, "ATTESTATION_INVALID", "Attestation privacy");
  if (privacyFields.some((field) => document.privacy[field] !== false)) {
    fail("ATTESTATION_INVALID", "Android attestation privacy is invalid");
  }
  exactFields(document.gate, ["b4", "authoritativeGateExecuted"], "ATTESTATION_INVALID", "Attestation gate");
  if (document.gate.b4 !== "PENDING" || document.gate.authoritativeGateExecuted !== false) {
    fail("ATTESTATION_INVALID", "Android attestation gate boundary changed");
  }
  if (expected.collectionRunId !== undefined || expected.captureRunId !== undefined) {
    if (expected.collectionRunId === undefined || expected.captureRunId === undefined) {
      fail("ATTESTATION_EXPECTATION_INVALID", "Both expected run identifiers are required");
    }
    const commitments = buildB4RunCommitments(expected);
    if (
      commitments.collectionRunCommitmentSha256 !==
        document.binding.collectionRunCommitmentSha256 ||
      commitments.captureRunCommitmentSha256 !==
        document.binding.captureRunCommitmentSha256
    ) {
      fail("ATTESTATION_BINDING_MISMATCH", "Android run binding does not match");
    }
  }
  if (
    expected.certificationMatrixSha256 !== undefined &&
    expected.certificationMatrixSha256 !== document.binding.certificationMatrixSha256
  ) {
    fail("ATTESTATION_BINDING_MISMATCH", "Android matrix binding does not match");
  }
  return Object.freeze(structuredClone(document));
}

export function parseB4AndroidMonitorArguments(argv) {
  const options = {
    adb: null,
    serial: null,
    androidUserId: 0,
    captureRunId: null,
    privateOutput: null,
    attestation: null,
    collectorState: null,
    pollMs: 2_000,
    durationMs: null,
    help: false,
  };
  const names = new Set([
    "--adb",
    "--serial",
    "--android-user-id",
    "--capture-run-id",
    "--private-output",
    "--attestation",
    "--collector-state",
    "--poll-ms",
    "--duration-seconds",
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (!names.has(argument) || seen.has(argument)) {
      fail("ARGUMENT_INVALID", `Unsupported or duplicate option: ${argument}`, 2);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      fail("ARGUMENT_INVALID", `${argument} requires a value`, 2);
    }
    seen.add(argument);
    if (argument === "--adb") options.adb = path.resolve(value);
    else if (argument === "--serial") options.serial = value;
    else if (argument === "--android-user-id") options.androidUserId = Number(value);
    else if (argument === "--capture-run-id") options.captureRunId = value;
    else if (argument === "--private-output") options.privateOutput = path.resolve(value);
    else if (argument === "--attestation") options.attestation = path.resolve(value);
    else if (argument === "--collector-state") options.collectorState = path.resolve(value);
    else if (argument === "--poll-ms") options.pollMs = Number(value);
    else if (argument === "--duration-seconds") options.durationMs = Number(value) * 1_000;
  }
  if (options.help) return options;
  if (
    !options.adb ||
    !path.isAbsolute(options.adb) ||
    !fs.existsSync(options.adb) ||
    (fs.statSync(options.adb).mode & 0o111) === 0 ||
    typeof options.serial !== "string" ||
    !SERIAL_PATTERN.test(options.serial) ||
    !options.privateOutput ||
    !options.attestation ||
    !options.collectorState ||
    new Set([
      options.privateOutput,
      options.attestation,
      options.collectorState,
    ]).size !== 3
  ) {
    fail("ARGUMENT_INVALID", "Android B4 monitor arguments are invalid", 2);
  }
  integer(options.androidUserId, 0, Number.MAX_SAFE_INTEGER, "ARGUMENT_INVALID", "androidUserId");
  integer(options.pollMs, MIN_POLL_MS, MAX_POLL_MS, "ARGUMENT_INVALID", "pollMs");
  integer(options.durationMs, MIN_COVERAGE_MS, MAX_COVERAGE_MS, "ARGUMENT_INVALID", "durationMs");
  requireUuidV4(options.captureRunId, "ARGUMENT_INVALID");
  return options;
}

export async function runB4AndroidContinuityMonitor(options, runtime = {}) {
  const capture = runtime.captureSample ?? captureSample;
  const sleepFn = runtime.sleep ?? sleep;
  const performanceNow = runtime.performanceNow ?? (() => performance.now());
  const wallNow = runtime.wallNow ?? (() => Date.now());
  const readCollectorBinding =
    runtime.readCollectorIdentityBinding ?? readB4CollectorIdentityBinding;
  const randomBytes = runtime.randomBytes ?? ((size) => crypto.randomBytes(size));
  const publishAttestation = runtime.publishPrivateJson ?? publishPrivateJson;
  if (fs.existsSync(options.privateOutput) || fs.existsSync(options.attestation)) {
    fail("OUTPUT_EXISTS", "Android monitor outputs already exist");
  }
  const collectorBinding = readCollectorBinding(options.collectorState);
  const identityKey = collectorBinding.identityKey;
  let boundOptions;
  let digest;
  let sessionKey;
  let journal = null;
  let controller;
  let abort;
  try {
    boundOptions = Object.freeze({
      ...options,
      packageName: TARGET.packageId,
      role: "handheld",
      collectionRunId: collectorBinding.collectionRunId,
      certificationMatrixSha256:
        collectorBinding.certificationMatrixSha256,
    });
    buildB4RunCommitments(boundOptions);
    digest = crypto.createHash("sha256");
    sessionKey = randomBytes(32);
    controller = new AbortController();
    abort = () => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    journal = openPrivateOutput(boundOptions.privateOutput, "Private journal");
    const startedPerformanceMs = performanceNow();
    const offsets = [];
    for (
      let offset = 0;
      offset < boundOptions.durationMs;
      offset += boundOptions.pollMs
    ) {
      offsets.push(offset);
    }
    offsets.push(boundOptions.durationMs);
    const commitments = buildB4RunCommitments(boundOptions);
    appendJournal(
      journal,
      {
        schemaVersion: 1,
        product: "V5BT",
        phase: "B4",
        mode: "PRIVATE_ANDROID_CONTINUITY_JOURNAL",
        startedAt: new Date(wallNow()).toISOString(),
        binding: commitments,
        target: {
          serial: boundOptions.serial,
          packageName: boundOptions.packageName,
          androidUserId: boundOptions.androidUserId,
        },
      },
      digest,
    );
    let baseline;
    let previous;
    let monitoredFrom;
    let monitoredUntil;
    let previousWallMs = null;
    let previousSamplePerformanceMs = null;
    let maximumObservedGapMs = 0;
    let sampleCount = 0;
    for (let index = 0; index < offsets.length; index += 1) {
      const deadline = startedPerformanceMs + offsets[index];
      const remaining = deadline - performanceNow();
      if (remaining > 0) await sleepFn(remaining, undefined, { signal: controller.signal });
      const samplePerformanceMs = performanceNow();
      if (samplePerformanceMs - deadline > ADB_TIMEOUT_MS) {
        fail("POLL_DEADLINE_MISSED", "Android monitor missed a polling deadline");
      }
      const wallMs = wallNow();
      if (previousWallMs !== null && wallMs < previousWallMs) {
        fail("CLOCK_REGRESSION", "Android monitor wall clock regressed");
      }
      if (previousSamplePerformanceMs !== null) {
        const gap = Math.round(samplePerformanceMs - previousSamplePerformanceMs);
        maximumObservedGapMs = Math.max(maximumObservedGapMs, gap);
        if (gap > maximumPollingGapMs(boundOptions.pollMs)) {
          fail("POLLING_GAP", "Android monitor polling gap exceeded the limit");
        }
      }
      const sample = await capture(
        boundOptions,
        sessionKey,
        controller.signal,
        index === 0,
      );
      if (index === 0) {
        baseline = validateBaseline(sample, boundOptions, identityKey);
        previous = {
          discoverySampleSequence: sample.discovery.sampleSequence,
          discoverySampledAtEpochMs: sample.discovery.sampledAtEpochMs,
        };
        monitoredFrom = sample.sampledAt;
      } else {
        previous = assertB4AndroidContinuity(baseline, previous, sample);
      }
      monitoredUntil = sample.sampledAt;
      sampleCount += 1;
      appendJournal(
        journal,
        {
          type: "sample",
          sequence: sampleCount,
          sampledAt: sample.sampledAt,
          androidApi: sample.androidApi,
          currentUser: sample.currentUser,
          appUid: sample.appUid,
          pid: sample.pid,
          versionName: sample.installedVersion.versionName,
          versionCode: sample.installedVersion.versionCode,
          discoveryReporterStartedAtEpochMs:
            sample.discovery.reporterStartedAtEpochMs,
          discoverySampleSequence: sample.discovery.sampleSequence,
          discoverySampledAtEpochMs: sample.discovery.sampledAtEpochMs,
          sessionBindingHmacSha256: sample.sessionBindingHmacSha256,
          exitInfoCommitments: [...sample.exitInfo.commitments].sort(),
          targetHardwareCommitmentSha256:
            baseline.targetHardwareCommitmentSha256,
        },
        digest,
      );
      previousWallMs = wallMs;
      previousSamplePerformanceMs = samplePerformanceMs;
    }
    const durationMs = Date.parse(monitoredUntil) - Date.parse(monitoredFrom);
    if (durationMs < MIN_COVERAGE_MS || durationMs > MAX_COVERAGE_MS) {
      fail("COVERAGE_INCOMPLETE", "Android monitor coverage is incomplete");
    }
    appendJournal(
      journal,
      {
        type: "final",
        stoppedAt: monitoredUntil,
        verdict: "PASS",
        sampleCount,
        maximumObservedGapMs,
      },
      digest,
    );
    const privateJournalSha256 = digest.digest("hex");
    closeAndVerifyJournal(journal, privateJournalSha256);
    const attestation = buildB4AndroidContinuityAttestation({
      collectionRunId: boundOptions.collectionRunId,
      captureRunId: boundOptions.captureRunId,
      certificationMatrixSha256: boundOptions.certificationMatrixSha256,
      privateJournalSha256,
      targetHardwareCommitmentSha256:
        baseline.targetHardwareCommitmentSha256,
      androidApi: baseline.androidApi,
      monitoredFrom,
      monitoredUntil,
      durationMs,
      pollMs: boundOptions.pollMs,
      sampleCount,
      maximumObservedGapMs,
      generatedAt: new Date(wallNow()).toISOString(),
    });
    parseB4AndroidContinuityAttestation(attestation, {
      collectionRunId: boundOptions.collectionRunId,
      captureRunId: boundOptions.captureRunId,
      certificationMatrixSha256: boundOptions.certificationMatrixSha256,
    });
    publishAttestation(boundOptions.attestation, attestation);
    return attestation;
  } catch (error) {
    const normalizedError = controller?.signal.aborted
      ? new B4AndroidContinuityError(
          "MONITOR_INTERRUPTED",
          "Android B4 monitor was interrupted",
          130,
          { cause: error },
        )
      : normalizeB4AndroidMonitorError(error);
    try {
      if (journal?.descriptor !== undefined) {
        appendJournal(
          journal,
          {
            type: "final",
            stoppedAt: new Date().toISOString(),
            verdict: "FAIL",
            code:
              normalizedError instanceof B4AndroidContinuityError
                ? normalizedError.code
                : "UNEXPECTED_FAILURE",
          },
          digest,
        );
        fs.closeSync(journal.descriptor);
        journal.descriptor = undefined;
      }
    } catch {}
    throw normalizedError;
  } finally {
    sessionKey?.fill(0);
    identityKey.fill(0);
    if (abort !== undefined) {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
}

function usage() {
  return [
    "V5BT B4 Android continuity monitor",
    "",
    "  --adb /abs/adb --serial ID --android-user-id 0 --capture-run-id UUID \\",
    "    --collector-state PRIVATE.json \\",
    "    --private-output PRIVATE.jsonl \\",
    "    --attestation PRIVATE-REDACTED.json --duration-seconds 120 [--poll-ms 2000]",
    "  --self-test",
  ].join("\n");
}

export function runSelfTest() {
  const collectionRunId = "00000000-0000-4000-8000-000000000001";
  const captureRunId = "00000000-0000-4000-8000-000000000002";
  const monitoredFrom = "2026-08-05T00:00:00.000Z";
  const monitoredUntil = "2026-08-05T00:01:30.000Z";
  const report = buildB4AndroidContinuityAttestation({
    collectionRunId,
    captureRunId,
    certificationMatrixSha256: MATRIX_SHA256,
    privateJournalSha256: "a".repeat(64),
    targetHardwareCommitmentSha256: "b".repeat(64),
    androidApi: 36,
    monitoredFrom,
    monitoredUntil,
    durationMs: 90_000,
    pollMs: 2_000,
    sampleCount: 46,
    maximumObservedGapMs: 2_100,
    generatedAt: monitoredUntil,
  });
  parseB4AndroidContinuityAttestation(report, {
    collectionRunId,
    captureRunId,
    certificationMatrixSha256: MATRIX_SHA256,
  });
  return Object.freeze({
    schemaVersion: 1,
    product: "V5BT",
    phase: "B4",
    mode: "SELF_TEST",
    verdict: "PASS",
    physicalAdbAccessed: false,
    gate: Object.freeze({ b4: "PENDING" }),
  });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (argv.length === 1 && argv[0] === "--self-test") {
      process.stdout.write(`${JSON.stringify(runSelfTest(), null, 2)}\n`);
      return 0;
    }
    const options = parseB4AndroidMonitorArguments(argv);
    const report = await runB4AndroidContinuityMonitor(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch (error) {
    const normalizedError = normalizeB4AndroidMonitorError(error);
    const safe =
      normalizedError instanceof B4AndroidContinuityError
        ? normalizedError
        : new B4AndroidContinuityError(
            "B4_ANDROID_MONITOR_FAILED",
            "Android B4 continuity monitor failed",
          );
    process.stderr.write(`${safe.code}: Android B4 continuity monitor failed\n`);
    return safe.exitCode;
  }
}

const invokedPath =
  process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (
  invokedPath !== null &&
  fs.existsSync(invokedPath) &&
  fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(invokedPath)
) {
  process.exitCode = await main();
}
