#!/usr/bin/env node

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const B5_RASPBERRY_CONTINUITY_MONITOR_VERSION = "1.0.0";

const execFileAsync = promisify(execFile);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PRIVATE_JSON_BYTES = 256 * 1024;
const PUBLICATION_JOURNAL_SUFFIX = ".publication-v1.journal.json";
const MAX_BOOT_ID_BYTES = 256;
const MAX_SYSTEMCTL_OUTPUT_BYTES = 16 * 1024;
const SYSTEMCTL_TIMEOUT_MS = 5_000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 5_000;
const MIN_CAMPAIGN_DURATION_MS = 6_000_000;
const MAX_CAMPAIGN_DURATION_MS = 14_400_000;
const MAX_MONITOR_OVERRUN_MS = 60_000;
const MAIN_SERVICE = "cassav5bt.service";
const BLUETOOTH_SERVICE = "bluetooth.service";
const SERVICE_NAMES = Object.freeze([MAIN_SERVICE, BLUETOOTH_SERVICE]);
const SYSTEMCTL_FIELDS = Object.freeze([
  "ActiveState",
  "SubState",
  "MainPID",
  "NRestarts",
  "ActiveEnterTimestampMonotonic",
  "ExecMainStartTimestampMonotonic"
]);
const SERVICE_SNAPSHOT_FIELDS = Object.freeze([
  "unit",
  "activeState",
  "subState",
  "mainPid",
  "nRestarts",
  "activeEnterTimestampMonotonic",
  "execMainStartTimestampMonotonic"
]);
const ATTESTATION_CHECK_FIELDS = Object.freeze([
  "fixedBoot",
  "mainServiceContinuity",
  "bluetoothServiceContinuity",
  "noServiceRestarts",
  "monotonicWallClock",
  "boundedPolling",
  "completeCoverage"
]);
export const B5_RASPBERRY_CONTINUITY_COUNTER_FIELDS = Object.freeze([
  "systemctlFailures",
  "bootIdChanges",
  "clockRegressions",
  "pollDeadlineMisses",
  "mainServiceStateChanges",
  "mainServiceProcessChanges",
  "mainServiceRestartCountChanges",
  "bluetoothServiceStateChanges",
  "bluetoothServiceProcessChanges",
  "bluetoothServiceRestartCountChanges"
]);
const ATTESTATION_PRIVACY_FIELDS = Object.freeze([
  "hostnameIncluded",
  "processIdentifiersIncluded",
  "localLocationsIncluded",
  "bootIdIncluded",
  "machineIdentifiersIncluded",
  "sourceStatusBodiesIncluded"
]);

export class B5RaspberryContinuityError extends Error {
  constructor(code, message, exitCode = 1, options = undefined) {
    super(message, options);
    this.name = "B5RaspberryContinuityError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1, options = undefined) {
  throw new B5RaspberryContinuityError(code, message, exitCode, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactFields(value, fields, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be a JSON object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(code, `${label} has an invalid field set`);
  }
  return value;
}

function requireInteger(value, minimum, maximum, code, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function requireTimestamp(value, code, label) {
  if (typeof value !== "string") fail(code, `${label} is invalid`);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail(code, `${label} is invalid`);
  }
  return milliseconds;
}

function parseJson(raw, code, label) {
  let value;
  try {
    value = JSON.parse(String(raw ?? ""));
  } catch {
    fail(code, `${label} is not valid JSON`);
  }
  if (!isRecord(value)) fail(code, `${label} must be a JSON object`);
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function campaignCommitment(campaignId) {
  if (typeof campaignId !== "string" || !UUID_V4_PATTERN.test(campaignId)) {
    fail("CAMPAIGN_INVALID", "Campaign identifier is invalid");
  }
  return sha256(Buffer.from(campaignId, "utf8"));
}

function assertNoSymlinkComponents(location) {
  const resolved = path.resolve(location);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    let status;
    try {
      status = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      fail("PRIVATE_FILE_INVALID", "Monitor paths cannot be inspected");
    }
    if (status.isSymbolicLink()) {
      fail("PRIVATE_FILE_INVALID", "Monitor paths must not use symlinks");
    }
  }
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function requirePrivateMetadata(status, label) {
  const expectedUid = currentUid();
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (status.mode & 0o777) !== 0o600 ||
    (expectedUid !== null && status.uid !== expectedUid)
  ) {
    fail("PRIVATE_FILE_INVALID", `${label} must be a private 0600 regular file`);
  }
}

export function readRaspberryMonitorPrivateJson(
  location,
  label = "private JSON"
) {
  return parseJson(
    readRaspberryMonitorPrivateText(location, label),
    "PRIVATE_FILE_INVALID",
    label
  );
}

function readRaspberryMonitorPrivateText(location, label = "private JSON") {
  assertNoSymlinkComponents(location);
  let descriptor;
  try {
    descriptor = fs.openSync(
      location,
      fs.constants.O_RDONLY |
        (process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0)
    );
    const before = fs.fstatSync(descriptor);
    requirePrivateMetadata(before, label);
    if (before.size < 2 || before.size > MAX_PRIVATE_JSON_BYTES) {
      fail("PRIVATE_FILE_INVALID", `${label} has an invalid size`);
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    requirePrivateMetadata(after, label);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      Buffer.byteLength(raw, "utf8") !== before.size
    ) {
      fail("PRIVATE_FILE_CHANGED", `${label} changed while being read`);
    }
    return raw;
  } catch (error) {
    if (error instanceof B5RaspberryContinuityError) throw error;
    fail("PRIVATE_FILE_UNAVAILABLE", `${label} is unavailable`, 1, {
      cause: error
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function encodePrivateJson(value) {
  const encoded = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (encoded.byteLength > MAX_PRIVATE_JSON_BYTES) {
    fail("PRIVATE_OUTPUT_INVALID", "Private output exceeds the size limit");
  }
  return encoded;
}

function requirePrivateParent(destination) {
  const parent = path.dirname(path.resolve(destination));
  assertNoSymlinkComponents(parent);
  let status;
  try {
    status = fs.lstatSync(parent);
  } catch (error) {
    fail("PRIVATE_OUTPUT_INVALID", "Private output directory is unavailable", 1, {
      cause: error
    });
  }
  const expectedUid = currentUid();
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o777) !== 0o700 ||
    (expectedUid !== null && status.uid !== expectedUid)
  ) {
    fail(
      "PRIVATE_OUTPUT_INVALID",
      "Private output directory must be owned by the current user with mode 0700"
    );
  }
  return parent;
}

function preflightPrivateOutput(destination) {
  requirePrivateParent(destination);
  assertNoSymlinkComponents(destination);
  if (fs.existsSync(destination)) {
    fail("PRIVATE_OUTPUT_EXISTS", "Private output already exists");
  }
}

export function atomicWriteRaspberryMonitorPrivateJson(destination, value) {
  const parent = requirePrivateParent(destination);
  assertNoSymlinkComponents(destination);
  if (fs.existsSync(destination)) {
    fail("PRIVATE_OUTPUT_EXISTS", "Private output already exists");
  }
  const encoded = encodePrivateJson(value);
  const temporary = path.join(
    parent,
    `.b5-raspberry-monitor-${process.pid}-${crypto.randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0),
      0o600
    );
    fs.writeFileSync(descriptor, encoded);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, destination);
    fs.unlinkSync(temporary);
    const directoryDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
    requirePrivateMetadata(fs.lstatSync(destination), "private output");
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {}
    if (error instanceof B5RaspberryContinuityError) throw error;
    fail("PRIVATE_OUTPUT_FAILED", "Private output could not be published", 1, {
      cause: error
    });
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function raspberryMonitorPublicationJournalPath(privateOutput) {
  return `${path.resolve(privateOutput)}${PUBLICATION_JOURNAL_SUFFIX}`;
}

export function parseRaspberryMonitorPublicationJournal(raw, expected = {}) {
  const journal = typeof raw === "string"
    ? parseJson(raw, "PUBLICATION_JOURNAL_INVALID", "Raspberry publication journal")
    : raw;
  requireExactFields(
    journal,
    [
      "schemaVersion",
      "product",
      "phase",
      "monitor",
      "mode",
      "transactionId",
      "campaignId",
      "privateOutput",
      "attestationOutput",
      "privateSha256",
      "attestationSha256",
      "privateDocument",
      "attestationDocument"
    ],
    "PUBLICATION_JOURNAL_INVALID",
    "Raspberry publication journal"
  );
  if (
    journal.schemaVersion !== 1 ||
    journal.product !== "V5BT" ||
    journal.phase !== "B5" ||
    journal.monitor !== "RASPBERRY" ||
    journal.mode !== "MONITOR_ARTIFACT_PUBLICATION" ||
    !UUID_V4_PATTERN.test(journal.transactionId) ||
    !UUID_V4_PATTERN.test(journal.campaignId) ||
    typeof journal.privateOutput !== "string" ||
    typeof journal.attestationOutput !== "string" ||
    path.resolve(journal.privateOutput) !== journal.privateOutput ||
    path.resolve(journal.attestationOutput) !== journal.attestationOutput ||
    journal.privateOutput === journal.attestationOutput ||
    !SHA256_PATTERN.test(journal.privateSha256) ||
    !SHA256_PATTERN.test(journal.attestationSha256) ||
    !isRecord(journal.privateDocument) ||
    !isRecord(journal.attestationDocument)
  ) {
    fail("PUBLICATION_JOURNAL_INVALID", "Raspberry publication journal header is invalid");
  }
  if (
    journal.privateDocument.schemaVersion !== 1 ||
    journal.privateDocument.harnessVersion !== B5_RASPBERRY_CONTINUITY_MONITOR_VERSION ||
    journal.privateDocument.product !== "V5BT" ||
    journal.privateDocument.phase !== "B5" ||
    journal.privateDocument.mode !== "PRIVATE_RASPBERRY_CONTINUITY_RESULT" ||
    journal.privateDocument.verdict !== "PASS" ||
    journal.privateDocument.campaignId !== journal.campaignId ||
    journal.privateDocument.attestationSha256 !==
      sha256(Buffer.from(`${JSON.stringify(journal.attestationDocument)}\n`, "utf8")) ||
    journal.privateSha256 !== sha256(encodePrivateJson(journal.privateDocument)) ||
    journal.attestationSha256 !== sha256(encodePrivateJson(journal.attestationDocument))
  ) {
    fail("PUBLICATION_JOURNAL_INVALID", "Raspberry publication journal payload is invalid");
  }
  const parsedAttestation = parseRaspberryContinuityAttestation(
    journal.attestationDocument
  );
  if (
    parsedAttestation.campaignIdCommitmentSha256 !==
      campaignCommitment(journal.campaignId) ||
    (expected.privateOutput !== undefined &&
      path.resolve(expected.privateOutput) !== journal.privateOutput) ||
    (expected.attestation !== undefined &&
      path.resolve(expected.attestation) !== journal.attestationOutput) ||
    (expected.campaignId !== undefined && expected.campaignId !== journal.campaignId)
  ) {
    fail("PUBLICATION_JOURNAL_MISMATCH", "Raspberry publication journal does not match this monitor");
  }
  return Object.freeze(structuredClone(journal));
}

function verifyOrPublishRaspberryPrivateArtifact(location, document, digest, label) {
  assertNoSymlinkComponents(location);
  if (!fs.existsSync(location)) {
    atomicWriteRaspberryMonitorPrivateJson(location, document);
  }
  const raw = readRaspberryMonitorPrivateText(location, label);
  if (sha256(Buffer.from(raw, "utf8")) !== digest) {
    fail("PUBLICATION_CONFLICT", `${label} does not match the publication journal`);
  }
}

export function publishRaspberryMonitorArtifacts(
  options,
  privateDocument = null,
  attestationDocument = null,
  runtime = {}
) {
  const privateOutput = path.resolve(options.privateOutput);
  const attestationOutput = path.resolve(options.attestation);
  const journalLocation = raspberryMonitorPublicationJournalPath(privateOutput);
  requirePrivateParent(privateOutput);
  requirePrivateParent(attestationOutput);
  requirePrivateParent(journalLocation);
  for (const location of [privateOutput, attestationOutput, journalLocation]) {
    assertNoSymlinkComponents(location);
  }
  if (new Set([privateOutput, attestationOutput, journalLocation]).size !== 3) {
    fail("INVALID_ARGUMENT", "Raspberry monitor publication paths must be distinct", 2);
  }

  let journal;
  if (fs.existsSync(journalLocation)) {
    journal = parseRaspberryMonitorPublicationJournal(
      readRaspberryMonitorPrivateJson(
        journalLocation,
        "Raspberry publication journal"
      ),
      {
        privateOutput,
        attestation: attestationOutput,
        campaignId: options.campaignId
      }
    );
    if (
      (privateDocument !== null &&
        sha256(encodePrivateJson(privateDocument)) !== journal.privateSha256) ||
      (attestationDocument !== null &&
        sha256(encodePrivateJson(attestationDocument)) !== journal.attestationSha256)
    ) {
      fail("PUBLICATION_JOURNAL_MISMATCH", "Raspberry recovery payload does not match its journal");
    }
  } else {
    if (privateDocument === null || attestationDocument === null) return null;
    if (fs.existsSync(privateOutput) || fs.existsSync(attestationOutput)) {
      fail("PRIVATE_OUTPUT_EXISTS", "Monitor output already exists without a recovery journal");
    }
    journal = parseRaspberryMonitorPublicationJournal(
      {
        schemaVersion: 1,
        product: "V5BT",
        phase: "B5",
        monitor: "RASPBERRY",
        mode: "MONITOR_ARTIFACT_PUBLICATION",
        transactionId: crypto.randomUUID(),
        campaignId: options.campaignId,
        privateOutput,
        attestationOutput,
        privateSha256: sha256(encodePrivateJson(privateDocument)),
        attestationSha256: sha256(encodePrivateJson(attestationDocument)),
        privateDocument: structuredClone(privateDocument),
        attestationDocument: structuredClone(attestationDocument)
      },
      { privateOutput, attestation: attestationOutput, campaignId: options.campaignId }
    );
    atomicWriteRaspberryMonitorPrivateJson(journalLocation, journal);
  }

  verifyOrPublishRaspberryPrivateArtifact(
    privateOutput,
    journal.privateDocument,
    journal.privateSha256,
    "private Raspberry monitor result"
  );
  runtime.afterPrivatePublished?.();
  verifyOrPublishRaspberryPrivateArtifact(
    attestationOutput,
    journal.attestationDocument,
    journal.attestationSha256,
    "Raspberry monitor attestation"
  );
  runtime.afterAttestationPublished?.();
  verifyOrPublishRaspberryPrivateArtifact(
    privateOutput,
    journal.privateDocument,
    journal.privateSha256,
    "private Raspberry monitor result"
  );
  verifyOrPublishRaspberryPrivateArtifact(
    attestationOutput,
    journal.attestationDocument,
    journal.attestationSha256,
    "Raspberry monitor attestation"
  );
  const finalJournal = parseRaspberryMonitorPublicationJournal(
    readRaspberryMonitorPrivateJson(
      journalLocation,
      "Raspberry publication journal"
    ),
    {
      privateOutput,
      attestation: attestationOutput,
      campaignId: journal.campaignId
    }
  );
  if (finalJournal.transactionId !== journal.transactionId) {
    fail("PUBLICATION_CONFLICT", "Raspberry publication journal changed during commit");
  }
  fs.unlinkSync(journalLocation);
  fsyncDirectory(path.dirname(journalLocation));
  return Object.freeze(structuredClone(journal.attestationDocument));
}

export function recoverRaspberryMonitorArtifactPublication(options, runtime = {}) {
  return publishRaspberryMonitorArtifacts(options, null, null, runtime);
}

function readBoundedRegularText(location, label) {
  assertNoSymlinkComponents(location);
  let descriptor;
  try {
    descriptor = fs.openSync(
      location,
      fs.constants.O_RDONLY |
        (process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0)
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) {
      fail("BOOT_ID_FILE_INVALID", `${label} must be a regular file`);
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      raw.length < 1 ||
      Buffer.byteLength(raw, "utf8") > MAX_BOOT_ID_BYTES
    ) {
      fail("BOOT_ID_FILE_INVALID", `${label} changed while being read`);
    }
    return raw;
  } catch (error) {
    if (error instanceof B5RaspberryContinuityError) throw error;
    fail("BOOT_ID_FILE_UNAVAILABLE", `${label} is unavailable`, 1, {
      cause: error
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateExecutable(location) {
  assertNoSymlinkComponents(location);
  let status;
  try {
    status = fs.lstatSync(location);
  } catch {
    fail("INVALID_ARGUMENT", "systemctl must be an absolute executable path", 2);
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    (status.mode & 0o111) === 0
  ) {
    fail("INVALID_ARGUMENT", "systemctl must be an absolute executable path", 2);
  }
}

function validateBootIdPath(location) {
  assertNoSymlinkComponents(location);
  let status;
  try {
    status = fs.lstatSync(location);
  } catch {
    fail("INVALID_ARGUMENT", "boot_id must be an absolute regular-file path", 2);
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    fail("INVALID_ARGUMENT", "boot_id must be an absolute regular-file path", 2);
  }
}

export function parseRaspberryMonitorConfig(raw) {
  const config = typeof raw === "string"
    ? parseJson(raw, "CONFIG_INVALID", "Raspberry monitor config")
    : raw;
  requireExactFields(
    config,
    ["schemaVersion", "product", "phase", "campaignId", "measurement"],
    "CONFIG_INVALID",
    "Raspberry monitor config"
  );
  if (
    config.schemaVersion !== 1 ||
    config.product !== "V5BT" ||
    config.phase !== "B5" ||
    typeof config.campaignId !== "string" ||
    !UUID_V4_PATTERN.test(config.campaignId)
  ) {
    fail("CONFIG_INVALID", "Raspberry monitor config header is invalid");
  }
  requireExactFields(
    config.measurement,
    ["durationMs"],
    "CONFIG_INVALID",
    "Raspberry monitor measurement"
  );
  requireInteger(
    config.measurement.durationMs,
    MIN_CAMPAIGN_DURATION_MS,
    MAX_CAMPAIGN_DURATION_MS,
    "CONFIG_INVALID",
    "Raspberry campaign duration"
  );
  return Object.freeze(structuredClone(config));
}

export function buildSystemctlShowArgs(unit) {
  if (!SERVICE_NAMES.includes(unit)) {
    fail("SYSTEMCTL_ARGUMENT_INVALID", "Unexpected systemd service target");
  }
  return [
    "show",
    unit,
    "--no-pager",
    ...SYSTEMCTL_FIELDS.map((field) => `--property=${field}`)
  ];
}

function parseDecimal(value, minimum, label) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    fail("SYSTEMCTL_OUTPUT_INVALID", `${label} is invalid`);
  }
  const parsed = Number(value);
  return requireInteger(
    parsed,
    minimum,
    Number.MAX_SAFE_INTEGER,
    "SYSTEMCTL_OUTPUT_INVALID",
    label
  );
}

export function parseSystemctlShow(raw, unit) {
  if (!SERVICE_NAMES.includes(unit)) {
    fail("SYSTEMCTL_OUTPUT_INVALID", "Unexpected systemd service target");
  }
  const text = String(raw ?? "");
  if (
    Buffer.byteLength(text, "utf8") < 1 ||
    Buffer.byteLength(text, "utf8") > MAX_SYSTEMCTL_OUTPUT_BYTES
  ) {
    fail("SYSTEMCTL_OUTPUT_INVALID", `${unit} status has an invalid size`);
  }
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      fail("SYSTEMCTL_OUTPUT_INVALID", `${unit} status is malformed`);
    }
    const field = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!SYSTEMCTL_FIELDS.includes(field) || values.has(field)) {
      fail("SYSTEMCTL_OUTPUT_INVALID", `${unit} status has unexpected fields`);
    }
    values.set(field, value);
  }
  if (
    values.size !== SYSTEMCTL_FIELDS.length ||
    SYSTEMCTL_FIELDS.some((field) => !values.has(field))
  ) {
    fail("SYSTEMCTL_OUTPUT_INVALID", `${unit} status is incomplete`);
  }
  if (values.get("ActiveState") !== "active" || values.get("SubState") !== "running") {
    fail("SERVICE_NOT_RUNNING", `${unit} must remain active and running`);
  }
  return Object.freeze({
    unit,
    activeState: values.get("ActiveState"),
    subState: values.get("SubState"),
    mainPid: parseDecimal(values.get("MainPID"), 1, `${unit} MainPID`),
    nRestarts: parseDecimal(values.get("NRestarts"), 0, `${unit} NRestarts`),
    activeEnterTimestampMonotonic: parseDecimal(
      values.get("ActiveEnterTimestampMonotonic"),
      1,
      `${unit} active-enter timestamp`
    ),
    execMainStartTimestampMonotonic: parseDecimal(
      values.get("ExecMainStartTimestampMonotonic"),
      1,
      `${unit} process-start timestamp`
    )
  });
}

export function parseBootId(raw) {
  const value = String(raw ?? "").trim();
  if (!UUID_PATTERN.test(value)) {
    fail("BOOT_ID_INVALID", "Raspberry boot identifier is invalid");
  }
  return value;
}

async function readServiceSnapshot(systemctlPath, unit, runtime, signal) {
  const executor = runtime.execFile ?? execFileAsync;
  let result;
  try {
    result = await executor(systemctlPath, buildSystemctlShowArgs(unit), {
      encoding: "utf8",
      timeout: SYSTEMCTL_TIMEOUT_MS,
      maxBuffer: MAX_SYSTEMCTL_OUTPUT_BYTES,
      windowsHide: true,
      signal
    });
  } catch (error) {
    fail("SYSTEMCTL_COMMAND_FAILED", "A required systemd service could not be inspected", 1, {
      cause: error
    });
  }
  const stdout = typeof result === "string" ? result : result?.stdout;
  return parseSystemctlShow(stdout, unit);
}

function validateSample(sample, code = "SAMPLE_INVALID") {
  requireExactFields(
    sample,
    ["capturedAt", "wallClockMs", "monotonicMs", "bootId", "services"],
    code,
    "Raspberry continuity sample"
  );
  const capturedAtMs = requireTimestamp(sample.capturedAt, code, "Sample timestamp");
  requireInteger(
    sample.wallClockMs,
    0,
    Number.MAX_SAFE_INTEGER,
    code,
    "Sample wall clock"
  );
  requireInteger(
    sample.monotonicMs,
    0,
    Number.MAX_SAFE_INTEGER,
    code,
    "Sample monotonic clock"
  );
  if (capturedAtMs !== sample.wallClockMs || !UUID_PATTERN.test(sample.bootId)) {
    fail(code, "Raspberry continuity sample metadata is invalid");
  }
  requireExactFields(sample.services, SERVICE_NAMES, code, "Sample services");
  for (const unit of SERVICE_NAMES) {
    const service = requireExactFields(
      sample.services[unit],
      SERVICE_SNAPSHOT_FIELDS,
      code,
      `Sample ${unit}`
    );
    if (
      service.unit !== unit ||
      service.activeState !== "active" ||
      service.subState !== "running"
    ) {
      fail(code, `Sample ${unit} is not running`);
    }
    for (const [field, minimum] of [
      ["mainPid", 1],
      ["nRestarts", 0],
      ["activeEnterTimestampMonotonic", 1],
      ["execMainStartTimestampMonotonic", 1]
    ]) {
      requireInteger(service[field], minimum, Number.MAX_SAFE_INTEGER, code, `${unit} ${field}`);
    }
  }
  return sample;
}

export async function captureRaspberryContinuitySample(context, runtime = {}) {
  if (!isRecord(context)) fail("SAMPLE_INVALID", "Raspberry sample context is invalid");
  const bootReader = runtime.readBootIdText ?? readBoundedRegularText;
  const beforeBoot = parseBootId(
    await bootReader(context.bootIdPath, "Raspberry boot_id")
  );
  const [mainService, bluetoothService] = await Promise.all([
    readServiceSnapshot(context.systemctlPath, MAIN_SERVICE, runtime, context.signal),
    readServiceSnapshot(context.systemctlPath, BLUETOOTH_SERVICE, runtime, context.signal)
  ]);
  const afterBoot = parseBootId(
    await bootReader(context.bootIdPath, "Raspberry boot_id")
  );
  if (beforeBoot !== afterBoot) {
    fail("BOOT_ID_CHANGED", "Raspberry rebooted while a continuity sample was captured");
  }
  const nowMs = runtime.nowMs ?? Date.now;
  const monotonicNow = runtime.monotonicNow ?? performance.now.bind(performance);
  const wallClockMs = Math.round(nowMs());
  const monotonicMs = Math.round(monotonicNow());
  return Object.freeze(
    validateSample({
      capturedAt: new Date(wallClockMs).toISOString(),
      wallClockMs,
      monotonicMs,
      bootId: beforeBoot,
      services: {
        [MAIN_SERVICE]: mainService,
        [BLUETOOTH_SERVICE]: bluetoothService
      }
    })
  );
}

export function buildPrivateRaspberryBaseline(config, sample) {
  validateSample(sample, "BASELINE_INVALID");
  const baseline = {
    schemaVersion: 1,
    harnessVersion: B5_RASPBERRY_CONTINUITY_MONITOR_VERSION,
    product: "V5BT",
    phase: "B5",
    mode: "PRIVATE_RASPBERRY_CONTINUITY_BASELINE",
    campaignId: config.campaignId,
    createdAt: sample.capturedAt,
    bootId: sample.bootId,
    services: structuredClone(sample.services)
  };
  parsePrivateRaspberryBaseline(baseline);
  return Object.freeze(baseline);
}

export function parsePrivateRaspberryBaseline(raw) {
  const baseline = typeof raw === "string"
    ? parseJson(raw, "BASELINE_INVALID", "Raspberry monitor baseline")
    : raw;
  requireExactFields(
    baseline,
    [
      "schemaVersion",
      "harnessVersion",
      "product",
      "phase",
      "mode",
      "campaignId",
      "createdAt",
      "bootId",
      "services"
    ],
    "BASELINE_INVALID",
    "Raspberry monitor baseline"
  );
  for (const [field, expected] of [
    ["schemaVersion", 1],
    ["harnessVersion", B5_RASPBERRY_CONTINUITY_MONITOR_VERSION],
    ["product", "V5BT"],
    ["phase", "B5"],
    ["mode", "PRIVATE_RASPBERRY_CONTINUITY_BASELINE"]
  ]) {
    if (baseline[field] !== expected) {
      fail("BASELINE_INVALID", `Raspberry baseline ${field} is invalid`);
    }
  }
  if (
    typeof baseline.campaignId !== "string" ||
    !UUID_V4_PATTERN.test(baseline.campaignId) ||
    typeof baseline.bootId !== "string" ||
    !UUID_PATTERN.test(baseline.bootId)
  ) {
    fail("BASELINE_INVALID", "Raspberry baseline binding is invalid");
  }
  requireTimestamp(baseline.createdAt, "BASELINE_INVALID", "Raspberry baseline timestamp");
  validateSample(
    {
      capturedAt: baseline.createdAt,
      wallClockMs: Date.parse(baseline.createdAt),
      monotonicMs: 0,
      bootId: baseline.bootId,
      services: baseline.services
    },
    "BASELINE_INVALID"
  );
  return Object.freeze(structuredClone(baseline));
}

function compareServiceSnapshot(expected, actual, prefix) {
  if (
    actual.activeState !== expected.activeState ||
    actual.subState !== expected.subState ||
    actual.activeEnterTimestampMonotonic !== expected.activeEnterTimestampMonotonic
  ) {
    fail(`${prefix}_SERVICE_STATE_CHANGED`, "A monitored systemd service changed state");
  }
  if (
    actual.mainPid !== expected.mainPid ||
    actual.execMainStartTimestampMonotonic !== expected.execMainStartTimestampMonotonic
  ) {
    fail(`${prefix}_SERVICE_PROCESS_CHANGED`, "A monitored systemd service restarted");
  }
  if (actual.nRestarts !== expected.nRestarts) {
    fail(`${prefix}_SERVICE_RESTART_COUNT_CHANGED`, "A monitored service restart counter changed");
  }
}

export function assertRaspberryContinuitySample(baseline, previous, sample) {
  validateSample(sample);
  if (sample.bootId !== baseline.bootId) {
    fail("BOOT_ID_CHANGED", "Raspberry boot identifier changed during the campaign");
  }
  compareServiceSnapshot(
    baseline.services[MAIN_SERVICE],
    sample.services[MAIN_SERVICE],
    "MAIN"
  );
  compareServiceSnapshot(
    baseline.services[BLUETOOTH_SERVICE],
    sample.services[BLUETOOTH_SERVICE],
    "BLUETOOTH"
  );
  if (
    sample.wallClockMs < previous.wallClockMs ||
    (previous.monotonicMs !== null && sample.monotonicMs < previous.monotonicMs)
  ) {
    fail("CLOCK_REGRESSION", "Raspberry clock regressed during the campaign");
  }
  return Object.freeze({
    wallClockMs: sample.wallClockMs,
    monotonicMs: sample.monotonicMs
  });
}

function emptyObserved(scheduledSamples) {
  return {
    scheduledSamples,
    completedSamples: 0,
    maximumPollGapMs: 0,
    ...Object.fromEntries(
      B5_RASPBERRY_CONTINUITY_COUNTER_FIELDS.map((field) => [field, 0])
    )
  };
}

export function buildRaspberryContinuityAttestation({
  campaignId,
  monitoredFrom,
  monitoredUntil,
  requiredDurationMs,
  pollIntervalMs,
  observed,
  generatedAt = monitoredUntil
}) {
  const startMs = requireTimestamp(monitoredFrom, "ATTESTATION_INVALID", "Monitor start");
  const endMs = requireTimestamp(monitoredUntil, "ATTESTATION_INVALID", "Monitor end");
  requireTimestamp(generatedAt, "ATTESTATION_INVALID", "Attestation timestamp");
  const durationMs = endMs - startMs;
  if (durationMs < requiredDurationMs) {
    fail("ATTESTATION_INVALID", "Raspberry monitor duration is incomplete");
  }
  const report = {
    schemaVersion: 1,
    harnessVersion: B5_RASPBERRY_CONTINUITY_MONITOR_VERSION,
    product: "V5BT",
    phase: "B5",
    generatedAt,
    mode: "PHYSICAL_RASPBERRY_CONTINUITY",
    verdict: "PASS",
    campaign: {
      campaignIdCommitmentSha256: campaignCommitment(campaignId),
      monitoredFrom,
      monitoredUntil,
      requiredDurationMs,
      durationMs,
      pollIntervalMs
    },
    target: {
      mainService: MAIN_SERVICE,
      bluetoothService: BLUETOOTH_SERVICE
    },
    checks: Object.fromEntries(
      ATTESTATION_CHECK_FIELDS.map((field) => [field, "PASS"])
    ),
    observed: structuredClone(observed),
    privacy: Object.fromEntries(
      ATTESTATION_PRIVACY_FIELDS.map((field) => [field, false])
    ),
    physicalRaspberryAccessed: true
  };
  parseRaspberryContinuityAttestation(report);
  return Object.freeze(report);
}

function assertRedactedAttestation(value) {
  const encoded = JSON.stringify(value);
  for (const pattern of [
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu,
    /\/(?:home|tmp|var|etc|run|proc)\//u,
    /"(?:hostname|pid|mainPid|bootId|bootIdPath|systemctlPath|activeEnterTimestampMonotonic|execMainStartTimestampMonotonic)"/iu
  ]) {
    if (pattern.test(encoded)) {
      fail("ATTESTATION_PRIVACY_INVALID", "Raspberry attestation leaks private data");
    }
  }
}

export function parseRaspberryContinuityAttestation(raw) {
  const value = typeof raw === "string"
    ? parseJson(raw, "ATTESTATION_INVALID", "Raspberry continuity attestation")
    : raw;
  requireExactFields(
    value,
    [
      "schemaVersion",
      "harnessVersion",
      "product",
      "phase",
      "generatedAt",
      "mode",
      "verdict",
      "campaign",
      "target",
      "checks",
      "observed",
      "privacy",
      "physicalRaspberryAccessed"
    ],
    "ATTESTATION_INVALID",
    "Raspberry continuity attestation"
  );
  for (const [field, expected] of [
    ["schemaVersion", 1],
    ["harnessVersion", B5_RASPBERRY_CONTINUITY_MONITOR_VERSION],
    ["product", "V5BT"],
    ["phase", "B5"],
    ["mode", "PHYSICAL_RASPBERRY_CONTINUITY"],
    ["verdict", "PASS"],
    ["physicalRaspberryAccessed", true]
  ]) {
    if (value[field] !== expected) {
      fail("ATTESTATION_INVALID", `Raspberry attestation ${field} is invalid`);
    }
  }
  const generatedAtMs = requireTimestamp(
    value.generatedAt,
    "ATTESTATION_INVALID",
    "Attestation timestamp"
  );
  requireExactFields(
    value.campaign,
    [
      "campaignIdCommitmentSha256",
      "monitoredFrom",
      "monitoredUntil",
      "requiredDurationMs",
      "durationMs",
      "pollIntervalMs"
    ],
    "ATTESTATION_INVALID",
    "Raspberry attestation campaign"
  );
  if (
    typeof value.campaign.campaignIdCommitmentSha256 !== "string" ||
    !SHA256_PATTERN.test(value.campaign.campaignIdCommitmentSha256) ||
    /^0{64}$/u.test(value.campaign.campaignIdCommitmentSha256)
  ) {
    fail("ATTESTATION_INVALID", "Raspberry campaign commitment is invalid");
  }
  const monitoredFromMs = requireTimestamp(
    value.campaign.monitoredFrom,
    "ATTESTATION_INVALID",
    "Attestation start"
  );
  const monitoredUntilMs = requireTimestamp(
    value.campaign.monitoredUntil,
    "ATTESTATION_INVALID",
    "Attestation end"
  );
  requireInteger(
    value.campaign.requiredDurationMs,
    MIN_CAMPAIGN_DURATION_MS,
    MAX_CAMPAIGN_DURATION_MS,
    "ATTESTATION_INVALID",
    "Required monitor duration"
  );
  requireInteger(
    value.campaign.durationMs,
    value.campaign.requiredDurationMs,
    MAX_CAMPAIGN_DURATION_MS + MAX_MONITOR_OVERRUN_MS,
    "ATTESTATION_INVALID",
    "Monitor duration"
  );
  requireInteger(
    value.campaign.pollIntervalMs,
    MIN_POLL_MS,
    MAX_POLL_MS,
    "ATTESTATION_INVALID",
    "Monitor polling interval"
  );
  if (
    monitoredUntilMs - monitoredFromMs !== value.campaign.durationMs ||
    generatedAtMs < monitoredUntilMs
  ) {
    fail("ATTESTATION_INVALID", "Raspberry attestation timeline is inconsistent");
  }
  requireExactFields(
    value.target,
    ["mainService", "bluetoothService"],
    "ATTESTATION_INVALID",
    "Raspberry attestation target"
  );
  if (
    value.target.mainService !== MAIN_SERVICE ||
    value.target.bluetoothService !== BLUETOOTH_SERVICE
  ) {
    fail("ATTESTATION_INVALID", "Raspberry attestation targets are invalid");
  }
  requireExactFields(
    value.checks,
    ATTESTATION_CHECK_FIELDS,
    "ATTESTATION_INVALID",
    "Raspberry attestation checks"
  );
  for (const field of ATTESTATION_CHECK_FIELDS) {
    if (value.checks[field] !== "PASS") {
      fail("ATTESTATION_INVALID", `Raspberry attestation check ${field} failed`);
    }
  }
  requireExactFields(
    value.observed,
    [
      "scheduledSamples",
      "completedSamples",
      "maximumPollGapMs",
      ...B5_RASPBERRY_CONTINUITY_COUNTER_FIELDS
    ],
    "ATTESTATION_INVALID",
    "Raspberry attestation observations"
  );
  for (const field of [
    "scheduledSamples",
    "completedSamples",
    "maximumPollGapMs",
    ...B5_RASPBERRY_CONTINUITY_COUNTER_FIELDS
  ]) {
    requireInteger(
      value.observed[field],
      0,
      Number.MAX_SAFE_INTEGER,
      "ATTESTATION_INVALID",
      `Raspberry observation ${field}`
    );
  }
  const expectedSamples =
    Math.ceil(
      value.campaign.requiredDurationMs / value.campaign.pollIntervalMs
    ) + 1;
  if (
    value.observed.scheduledSamples !== expectedSamples ||
    value.observed.completedSamples !== expectedSamples ||
    value.observed.maximumPollGapMs === 0 ||
    value.observed.maximumPollGapMs >
      value.campaign.pollIntervalMs + SYSTEMCTL_TIMEOUT_MS ||
    B5_RASPBERRY_CONTINUITY_COUNTER_FIELDS.some(
      (field) => value.observed[field] !== 0
    )
  ) {
    fail("ATTESTATION_INVALID", "Raspberry observations do not prove continuity");
  }
  requireExactFields(
    value.privacy,
    ATTESTATION_PRIVACY_FIELDS,
    "ATTESTATION_PRIVACY_INVALID",
    "Raspberry attestation privacy"
  );
  for (const field of ATTESTATION_PRIVACY_FIELDS) {
    if (value.privacy[field] !== false) {
      fail("ATTESTATION_PRIVACY_INVALID", `Raspberry privacy ${field} is invalid`);
    }
  }
  assertRedactedAttestation(value);
  return Object.freeze({
    report: Object.freeze(value),
    generatedAtMs,
    monitoredFromMs,
    monitoredUntilMs,
    campaignIdCommitmentSha256: value.campaign.campaignIdCommitmentSha256
  });
}

export const parseB5RaspberryContinuityAttestation =
  parseRaspberryContinuityAttestation;

export function validRaspberryContinuityAttestationFixture(options = {}) {
  const campaignId =
    options.campaignId ?? "00000000-0000-4000-8000-000000000001";
  const monitoredFrom =
    options.monitoredFrom ?? "2026-08-03T00:00:00.000Z";
  const startMs = requireTimestamp(
    monitoredFrom,
    "ATTESTATION_INVALID",
    "Fixture monitor start"
  );
  const requiredDurationMs =
    options.requiredDurationMs ??
    (options.monitoredUntil === undefined
      ? 6_100_000
      : Date.parse(options.monitoredUntil) - startMs);
  const monitoredUntil =
    options.monitoredUntil ??
    new Date(startMs + requiredDurationMs).toISOString();
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const scheduledSamples = Math.ceil(requiredDurationMs / pollIntervalMs) + 1;
  const observed = emptyObserved(scheduledSamples);
  observed.completedSamples = scheduledSamples;
  observed.maximumPollGapMs = pollIntervalMs;
  return buildRaspberryContinuityAttestation({
    campaignId,
    monitoredFrom,
    monitoredUntil,
    requiredDurationMs,
    pollIntervalMs,
    observed
  });
}

export const validB5RaspberryContinuityAttestationFixture =
  validRaspberryContinuityAttestationFixture;

function distinctPrivatePaths(paths) {
  const values = paths.filter(Boolean).map((value) => path.resolve(value));
  if (new Set(values).size !== values.length) {
    fail("INVALID_ARGUMENT", "Monitor private artifacts must use distinct paths", 2);
  }
}

export function parseRaspberryMonitorArguments(argv, runtime = {}) {
  const options = {
    mode: null,
    systemctlPath: null,
    bootIdPath: null,
    config: null,
    baseline: null,
    privateOutput: null,
    attestation: null,
    pollMs: 1_000
  };
  const modes = new Map([
    ["--capture-baseline", "BASELINE"],
    ["--monitor", "MONITOR"],
    ["--help", "HELP"]
  ]);
  const values = new Set([
    "--systemctl",
    "--boot-id-file",
    "--config",
    "--baseline",
    "--private-output",
    "--attestation",
    "--poll-ms"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (modes.has(argument)) {
      if (options.mode !== null) {
        fail("INVALID_ARGUMENT", "Monitor modes are mutually exclusive", 2);
      }
      options.mode = modes.get(argument);
      continue;
    }
    if (!values.has(argument) || index + 1 >= argv.length) {
      fail("INVALID_ARGUMENT", `Unsupported monitor argument ${argument}`, 2);
    }
    const value = argv[++index];
    if (argument === "--systemctl") options.systemctlPath = path.resolve(value);
    if (argument === "--boot-id-file") options.bootIdPath = path.resolve(value);
    if (argument === "--config") options.config = path.resolve(value);
    if (argument === "--baseline") options.baseline = path.resolve(value);
    if (argument === "--private-output") {
      options.privateOutput = path.resolve(value);
    }
    if (argument === "--attestation") options.attestation = path.resolve(value);
    if (argument === "--poll-ms") options.pollMs = Number(value);
  }
  if (options.mode === null) {
    fail("INVALID_ARGUMENT", "A Raspberry monitor mode is required", 2);
  }
  if (options.mode === "HELP") {
    if (argv.length !== 1) {
      fail("INVALID_ARGUMENT", "Help accepts no other arguments", 2);
    }
    return options;
  }
  for (const field of ["systemctlPath", "bootIdPath", "config", "baseline"]) {
    if (!options[field]) {
      fail("INVALID_ARGUMENT", `Monitor argument ${field} is required`, 2);
    }
  }
  requireInteger(
    options.pollMs,
    MIN_POLL_MS,
    MAX_POLL_MS,
    "INVALID_ARGUMENT",
    "Monitor poll interval"
  );
  if (options.mode === "BASELINE" && (options.privateOutput || options.attestation)) {
    fail("INVALID_ARGUMENT", "Baseline capture accepts no monitor outputs", 2);
  }
  if (options.mode === "MONITOR" && (!options.privateOutput || !options.attestation)) {
    fail("INVALID_ARGUMENT", "Monitor output and attestation are required", 2);
  }
  distinctPrivatePaths([
    options.config,
    options.baseline,
    options.privateOutput,
    options.attestation,
    options.privateOutput
      ? raspberryMonitorPublicationJournalPath(options.privateOutput)
      : null
  ]);
  (runtime.validateExecutable ?? validateExecutable)(options.systemctlPath);
  (runtime.validateBootIdPath ?? validateBootIdPath)(options.bootIdPath);
  return options;
}

async function captureBaseline(options, config, runtime) {
  preflightPrivateOutput(options.baseline);
  const captureSample =
    runtime.captureSample ?? captureRaspberryContinuitySample;
  const sample = await captureSample(
    {
      systemctlPath: options.systemctlPath,
      bootIdPath: options.bootIdPath,
      signal: undefined
    },
    runtime
  );
  const baseline = buildPrivateRaspberryBaseline(config, sample);
  atomicWriteRaspberryMonitorPrivateJson(options.baseline, baseline);
  return {
    schemaVersion: 1,
    harnessVersion: B5_RASPBERRY_CONTINUITY_MONITOR_VERSION,
    product: "V5BT",
    phase: "B5",
    mode: "RASPBERRY_BASELINE_CAPTURED",
    verdict: "READY",
    physicalRaspberryAccessed: true,
    gate: { b5HundredSessionGate: "PENDING", b6: "PENDING" }
  };
}

export async function monitorRaspberryCampaign(
  options,
  config,
  parsedBaseline,
  runtime = {}
) {
  const baseline = parsePrivateRaspberryBaseline(parsedBaseline);
  if (baseline.campaignId !== config.campaignId) {
    fail("BASELINE_CAMPAIGN_MISMATCH", "Raspberry baseline belongs to another campaign");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signalHandlers = runtime.signalHandlers !== false;
  if (signalHandlers) {
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
  }
  const nowMs = runtime.nowMs ?? Date.now;
  const monotonicNow = runtime.monotonicNow ?? performance.now.bind(performance);
  const wait = runtime.sleep ?? sleep;
  const captureSample =
    runtime.captureSample ?? captureRaspberryContinuitySample;
  const scheduledSamples =
    Math.ceil(config.measurement.durationMs / options.pollMs) + 1;
  const observed = emptyObserved(scheduledSamples);
  const startPerformanceMs = monotonicNow();
  const monitoredFromMs = Math.round(nowMs());
  const monitoredFrom = new Date(monitoredFromMs).toISOString();
  let previousPerformanceMs = null;
  let previous = {
    wallClockMs: Math.max(
      Date.parse(baseline.createdAt),
      monitoredFromMs
    ),
    monotonicMs: null
  };
  let finalSample = null;
  try {
    const recovered = recoverRaspberryMonitorArtifactPublication(
      {
        privateOutput: options.privateOutput,
        attestation: options.attestation,
        campaignId: config.campaignId
      },
      runtime.publicationRuntime ?? {}
    );
    if (recovered !== null) return recovered;
    preflightPrivateOutput(options.privateOutput);
    preflightPrivateOutput(options.attestation);
    for (let index = 0; index < scheduledSamples; index += 1) {
      const offset = Math.min(
        index * options.pollMs,
        config.measurement.durationMs
      );
      const deadline = startPerformanceMs + offset;
      const waitMs = deadline - monotonicNow();
      if (waitMs > 0) await wait(waitMs, undefined, { signal: controller.signal });
      const sampleStart = monotonicNow();
      const lateness = sampleStart - deadline;
      if (lateness > SYSTEMCTL_TIMEOUT_MS) {
        observed.pollDeadlineMisses += 1;
        fail("POLL_DEADLINE_MISSED", "Raspberry monitor missed a polling deadline");
      }
      if (previousPerformanceMs !== null) {
        observed.maximumPollGapMs = Math.max(
          observed.maximumPollGapMs,
          Math.round(sampleStart - previousPerformanceMs)
        );
      }
      const sample = await captureSample(
        {
          systemctlPath: options.systemctlPath,
          bootIdPath: options.bootIdPath,
          signal: controller.signal
        },
        runtime
      );
      previous = assertRaspberryContinuitySample(baseline, previous, sample);
      previousPerformanceMs = sampleStart;
      finalSample = sample;
      observed.completedSamples += 1;
    }
    const monitoredUntilMs = Math.round(nowMs());
    const monitoredUntil = new Date(monitoredUntilMs).toISOString();
    if (monitoredUntilMs < finalSample.wallClockMs) {
      fail("CLOCK_REGRESSION", "Raspberry clock regressed during finalization");
    }
    const generatedAtMs = Math.round(nowMs());
    if (generatedAtMs < monitoredUntilMs) {
      fail("CLOCK_REGRESSION", "Raspberry clock regressed during finalization");
    }
    const attestation = buildRaspberryContinuityAttestation({
      campaignId: config.campaignId,
      monitoredFrom,
      monitoredUntil,
      requiredDurationMs: config.measurement.durationMs,
      pollIntervalMs: options.pollMs,
      observed,
      generatedAt: new Date(generatedAtMs).toISOString()
    });
    const privateReport = {
      schemaVersion: 1,
      harnessVersion: B5_RASPBERRY_CONTINUITY_MONITOR_VERSION,
      product: "V5BT",
      phase: "B5",
      mode: "PRIVATE_RASPBERRY_CONTINUITY_RESULT",
      verdict: "PASS",
      campaignId: config.campaignId,
      baselineSha256: sha256(
        Buffer.from(`${JSON.stringify(baseline)}\n`, "utf8")
      ),
      monitoredFrom,
      monitoredUntil,
      observed: structuredClone(observed),
      finalBinding: {
        bootId: finalSample.bootId,
        services: structuredClone(finalSample.services)
      },
      attestationSha256: sha256(
        Buffer.from(`${JSON.stringify(attestation)}\n`, "utf8")
      )
    };
    return publishRaspberryMonitorArtifacts(
      {
        privateOutput: options.privateOutput,
        attestation: options.attestation,
        campaignId: config.campaignId
      },
      privateReport,
      attestation,
      runtime.publicationRuntime ?? {}
    );
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof B5RaspberryContinuityError)) {
      fail("MONITOR_INTERRUPTED", "Raspberry continuity monitor was interrupted", 130);
    }
    throw error;
  } finally {
    if (signalHandlers) {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
}

function usage() {
  return [
    "V5BT B5 Raspberry continuity monitor",
    "",
    "  --capture-baseline --systemctl /abs/systemctl --boot-id-file /abs/boot_id \\",
    "    --config PRIVATE.json --baseline PRIVATE.json",
    "  --monitor --systemctl /abs/systemctl --boot-id-file /abs/boot_id \\",
    "    --config PRIVATE.json --baseline PRIVATE.json --private-output PRIVATE.json \\",
    "    --attestation REDACTED.json [--poll-ms 1000]",
    ""
  ].join("\n");
}

function failureReport(error) {
  return {
    schemaVersion: 1,
    harnessVersion: B5_RASPBERRY_CONTINUITY_MONITOR_VERSION,
    product: "V5BT",
    phase: "B5",
    mode: "RASPBERRY_CONTINUITY_FAILURE",
    verdict: "FAIL",
    failure: {
      code:
        error instanceof B5RaspberryContinuityError
          ? error.code
          : "UNEXPECTED_FAILURE",
      message: "Raspberry continuity monitoring failed"
    },
    physicalRaspberryAccessed: false,
    gate: { b5HundredSessionGate: "PENDING", b6: "PENDING" }
  };
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const writeStdout =
    runtime.writeStdout ?? ((value) => process.stdout.write(value));
  try {
    const options = parseRaspberryMonitorArguments(argv, runtime);
    if (options.mode === "HELP") {
      writeStdout(`${usage()}\n`);
      return 0;
    }
    const config = parseRaspberryMonitorConfig(
      readRaspberryMonitorPrivateJson(options.config, "Raspberry monitor config")
    );
    const report =
      options.mode === "BASELINE"
        ? await captureBaseline(options, config, runtime)
        : await monitorRaspberryCampaign(
            options,
            config,
            readRaspberryMonitorPrivateJson(
              options.baseline,
              "Raspberry monitor baseline"
            ),
            runtime
          );
    writeStdout(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    writeStdout(`${JSON.stringify(failureReport(error), null, 2)}\n`);
    return error instanceof B5RaspberryContinuityError ? error.exitCode : 1;
  }
}

const invokedPath =
  process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (
  invokedPath !== null &&
  fs.existsSync(invokedPath) &&
  fs.realpathSync(invokedPath) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await main();
}
