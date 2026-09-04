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

import { ADVANCED_CERTIFICATION_TARGETS } from "./advanced-certification-targets.mjs";
import {
  parseAdbDevices,
  parseCurrentUser,
  parseForegroundServiceDump,
  parseInstalledVersion
} from "./run-b3-android-service-gate.mjs";
import {
  b5AccountDeviceBindingFromPrivateBaseline,
  createB5AccountDeviceCommitmentSha256,
  validB5AccountDeviceBindingFixture
} from "./b5-account-device-commitment.mjs";

export const B5_ANDROID_CONTINUITY_MONITOR_VERSION = "1.1.0";
const LEGACY_B5_ANDROID_CONTINUITY_MONITOR_VERSION = "1.0.0";

const execFileAsync = promisify(execFile);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const SERIAL_PATTERN = /^[!-~]{1,200}$/u;
const MAX_PRIVATE_JSON_BYTES = 256 * 1024;
const PUBLICATION_JOURNAL_SUFFIX = ".publication-v1.journal.json";
const MAX_ADB_OUTPUT_BYTES = 64 * 1024;
const ADB_TIMEOUT_MS = 5_000;
const REPORTER_FRESHNESS_MS = 5_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 5_000;
const MIN_CAMPAIGN_DURATION_MS = 6_000_000;
const MAX_CAMPAIGN_DURATION_MS = 14_400_000;
const EXIT_REASONS = new Map([
  [4, "crashes"],
  [5, "nativeCrashes"],
  [6, "anrs"],
  [10, "userRequestedStops"]
]);
const ROLE_TARGETS = Object.freeze({
  handheld: ADVANCED_CERTIFICATION_TARGETS.roles.handheld,
  station: ADVANCED_CERTIFICATION_TARGETS.roles.station
});
const GATT_STATUS_FILE = "no_backup/bluetooth-gatt-client-status-v1.json";
const AGENT_STATUS_FILE =
  "no_backup/bluetooth-connectivity-agent-status-v1.json";
const SESSION_PREFS_FILE = "shared_prefs/webkiosk_prefs.xml";

const ATTESTATION_CHECK_FIELDS = Object.freeze([
  "fixedAdbTarget",
  "fixedPackageVersion",
  "fixedAndroidUser",
  "fixedProcess",
  "fixedReporters",
  "continuousAuthenticatedSession",
  "applicationContinuouslyRunning",
  "noCrashOrAnr",
  "noForceStop",
  "boundedPolling"
]);
export const B5_ANDROID_CONTINUITY_COUNTER_FIELDS = Object.freeze([
  "adbFailures",
  "deviceUnavailableSamples",
  "androidUserChanges",
  "packageVersionChanges",
  "packageStoppedSamples",
  "processMissingSamples",
  "pidChanges",
  "serviceMissingSamples",
  "reporterRestarts",
  "reporterSequenceRegressions",
  "staleReporterSamples",
  "sessionBindingChanges",
  "unauthenticatedSamples",
  "crashes",
  "nativeCrashes",
  "anrs",
  "userRequestedStops",
  "pollDeadlineMisses"
]);
const ATTESTATION_PRIVACY_FIELDS = Object.freeze([
  "serialIncluded",
  "nodeIdIncluded",
  "accountIncluded",
  "localLocationsIncluded",
  "enrollmentIncluded",
  "processIdentifiersIncluded",
  "sourceStatusBodiesIncluded",
  "accountDeviceCommitmentIncluded"
]);
const LEGACY_ATTESTATION_PRIVACY_FIELDS = Object.freeze(
  ATTESTATION_PRIVACY_FIELDS.filter(
    (field) => field !== "accountDeviceCommitmentIncluded"
  )
);

export class B5AndroidContinuityError extends Error {
  constructor(code, message, exitCode = 1, options = undefined) {
    super(message, options);
    this.name = "B5AndroidContinuityError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1, options = undefined) {
  throw new B5AndroidContinuityError(code, message, exitCode, options);
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

function uuidCommitment(value) {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    fail("CAMPAIGN_INVALID", "Campaign identifier is invalid");
  }
  return sha256(Buffer.from(value, "utf8"));
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
      fail("PRIVATE_FILE_INVALID", "Private monitor paths cannot be inspected");
    }
    if (status.isSymbolicLink()) {
      fail("PRIVATE_FILE_INVALID", "Private monitor paths must not use symlinks");
    }
  }
}

function requirePrivateMetadata(stat, label) {
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    (expectedUid !== null && stat.uid !== expectedUid)
  ) {
    fail("PRIVATE_FILE_INVALID", `${label} must be a private 0600 regular file`);
  }
}

export function readPrivateJson(location, label = "private JSON") {
  return parseJson(
    readPrivateText(location, label),
    "PRIVATE_FILE_INVALID",
    label
  );
}

function readPrivateText(location, label = "private JSON") {
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
    if (error instanceof B5AndroidContinuityError) throw error;
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
  let stat;
  try {
    stat = fs.lstatSync(parent);
  } catch (error) {
    fail("PRIVATE_OUTPUT_INVALID", "Private output directory is unavailable", 1, {
      cause: error
    });
  }
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (expectedUid !== null && stat.uid !== expectedUid)
  ) {
    fail(
      "PRIVATE_OUTPUT_INVALID",
      "Private output directory must be owned by the current user with mode 0700"
    );
  }
  return parent;
}

export function atomicWritePrivateJson(destination, value) {
  const parent = requirePrivateParent(destination);
  assertNoSymlinkComponents(destination);
  if (fs.existsSync(destination)) {
    fail("PRIVATE_OUTPUT_EXISTS", "Private output already exists");
  }
  const encoded = encodePrivateJson(value);
  const temporary = path.join(
    parent,
    `.b5-android-monitor-${process.pid}-${crypto.randomUUID()}.tmp`
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
    if (error instanceof B5AndroidContinuityError) throw error;
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

export function androidMonitorPublicationJournalPath(privateOutput) {
  return `${path.resolve(privateOutput)}${PUBLICATION_JOURNAL_SUFFIX}`;
}

export function parseAndroidMonitorPublicationJournal(raw, expected = {}) {
  const journal = typeof raw === "string"
    ? parseJson(raw, "PUBLICATION_JOURNAL_INVALID", "Android publication journal")
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
    "Android publication journal"
  );
  if (
    journal.schemaVersion !== 1 ||
    journal.product !== "V6" ||
    journal.phase !== "B5" ||
    journal.monitor !== "ANDROID" ||
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
    fail("PUBLICATION_JOURNAL_INVALID", "Android publication journal header is invalid");
  }
  if (
    journal.privateDocument.schemaVersion !== 1 ||
    journal.privateDocument.harnessVersion !== B5_ANDROID_CONTINUITY_MONITOR_VERSION ||
    journal.privateDocument.product !== "V6" ||
    journal.privateDocument.phase !== "B5" ||
    journal.privateDocument.mode !== "PRIVATE_ANDROID_CONTINUITY_RESULT" ||
    journal.privateDocument.verdict !== "PASS" ||
    journal.privateDocument.campaignId !== journal.campaignId ||
    journal.privateDocument.attestationSha256 !==
      sha256(Buffer.from(`${JSON.stringify(journal.attestationDocument)}\n`, "utf8")) ||
    journal.privateSha256 !== sha256(encodePrivateJson(journal.privateDocument)) ||
    journal.attestationSha256 !== sha256(encodePrivateJson(journal.attestationDocument))
  ) {
    fail("PUBLICATION_JOURNAL_INVALID", "Android publication journal payload is invalid");
  }
  const parsedAttestation = parseB5AndroidContinuityAttestation(
    journal.attestationDocument
  );
  if (
    parsedAttestation.campaignIdCommitmentSha256 !== uuidCommitment(journal.campaignId) ||
    (expected.privateOutput !== undefined &&
      path.resolve(expected.privateOutput) !== journal.privateOutput) ||
    (expected.attestation !== undefined &&
      path.resolve(expected.attestation) !== journal.attestationOutput) ||
    (expected.campaignId !== undefined && expected.campaignId !== journal.campaignId)
  ) {
    fail("PUBLICATION_JOURNAL_MISMATCH", "Android publication journal does not match this monitor");
  }
  return Object.freeze(structuredClone(journal));
}

function verifyOrPublishPrivateArtifact(location, document, digest, label) {
  assertNoSymlinkComponents(location);
  if (!fs.existsSync(location)) {
    atomicWritePrivateJson(location, document);
  }
  const raw = readPrivateText(location, label);
  if (sha256(Buffer.from(raw, "utf8")) !== digest) {
    fail("PUBLICATION_CONFLICT", `${label} does not match the publication journal`);
  }
}

export function publishAndroidMonitorArtifacts(
  options,
  privateDocument = null,
  attestationDocument = null,
  runtime = {}
) {
  const privateOutput = path.resolve(options.privateOutput);
  const attestationOutput = path.resolve(options.attestation);
  const journalLocation = androidMonitorPublicationJournalPath(privateOutput);
  requirePrivateParent(privateOutput);
  requirePrivateParent(attestationOutput);
  requirePrivateParent(journalLocation);
  for (const location of [privateOutput, attestationOutput, journalLocation]) {
    assertNoSymlinkComponents(location);
  }
  if (new Set([privateOutput, attestationOutput, journalLocation]).size !== 3) {
    fail("INVALID_ARGUMENT", "Android monitor publication paths must be distinct", 2);
  }

  let journal;
  if (fs.existsSync(journalLocation)) {
    journal = parseAndroidMonitorPublicationJournal(
      readPrivateJson(journalLocation, "Android publication journal"),
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
      fail("PUBLICATION_JOURNAL_MISMATCH", "Android recovery payload does not match its journal");
    }
  } else {
    if (privateDocument === null || attestationDocument === null) return null;
    if (fs.existsSync(privateOutput) || fs.existsSync(attestationOutput)) {
      fail("PRIVATE_OUTPUT_EXISTS", "Monitor output already exists without a recovery journal");
    }
    journal = parseAndroidMonitorPublicationJournal(
      {
        schemaVersion: 1,
        product: "V6",
        phase: "B5",
        monitor: "ANDROID",
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
    atomicWritePrivateJson(journalLocation, journal);
  }

  verifyOrPublishPrivateArtifact(
    privateOutput,
    journal.privateDocument,
    journal.privateSha256,
    "private Android monitor result"
  );
  runtime.afterPrivatePublished?.();
  verifyOrPublishPrivateArtifact(
    attestationOutput,
    journal.attestationDocument,
    journal.attestationSha256,
    "Android monitor attestation"
  );
  runtime.afterAttestationPublished?.();
  verifyOrPublishPrivateArtifact(
    privateOutput,
    journal.privateDocument,
    journal.privateSha256,
    "private Android monitor result"
  );
  verifyOrPublishPrivateArtifact(
    attestationOutput,
    journal.attestationDocument,
    journal.attestationSha256,
    "Android monitor attestation"
  );
  const finalJournal = parseAndroidMonitorPublicationJournal(
    readPrivateJson(journalLocation, "Android publication journal"),
    {
      privateOutput,
      attestation: attestationOutput,
      campaignId: journal.campaignId
    }
  );
  if (finalJournal.transactionId !== journal.transactionId) {
    fail("PUBLICATION_CONFLICT", "Android publication journal changed during commit");
  }
  fs.unlinkSync(journalLocation);
  fsyncDirectory(path.dirname(journalLocation));
  return Object.freeze(structuredClone(journal.attestationDocument));
}

export function recoverAndroidMonitorArtifactPublication(options, runtime = {}) {
  return publishAndroidMonitorArtifacts(options, null, null, runtime);
}

export function parseMonitorConfig(raw) {
  const config = typeof raw === "string"
    ? parseJson(raw, "CONFIG_INVALID", "Monitor config")
    : raw;
  requireExactFields(
    config,
    ["schemaVersion", "product", "phase", "campaignId", "expected", "measurement"],
    "CONFIG_INVALID",
    "Monitor config"
  );
  if (
    config.schemaVersion !== 1 ||
    config.product !== "V6" ||
    config.phase !== "B5" ||
    typeof config.campaignId !== "string" ||
    !UUID_V4_PATTERN.test(config.campaignId)
  ) {
    fail("CONFIG_INVALID", "Monitor config header is invalid");
  }
  requireExactFields(
    config.expected,
    ["versionName", "versionCode", "androidUserId"],
    "CONFIG_INVALID",
    "Monitor expected target"
  );
  if (
    typeof config.expected.versionName !== "string" ||
    !/^[0-9]+(?:\.[0-9]+){2}$/u.test(config.expected.versionName)
  ) {
    fail("CONFIG_INVALID", "Expected Android version is invalid");
  }
  requireInteger(
    config.expected.versionCode,
    1,
    Number.MAX_SAFE_INTEGER,
    "CONFIG_INVALID",
    "Expected Android version code"
  );
  requireInteger(
    config.expected.androidUserId,
    0,
    Number.MAX_SAFE_INTEGER,
    "CONFIG_INVALID",
    "Expected Android user"
  );
  requireExactFields(
    config.measurement,
    ["durationMs"],
    "CONFIG_INVALID",
    "Monitor measurement"
  );
  requireInteger(
    config.measurement.durationMs,
    MIN_CAMPAIGN_DURATION_MS,
    MAX_CAMPAIGN_DURATION_MS,
    "CONFIG_INVALID",
    "Campaign duration"
  );
  return Object.freeze(structuredClone(config));
}

function decodeXmlText(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/u.test(value)) {
    fail("SESSION_CONTEXT_INVALID", "Session preferences contain an invalid entity");
  }
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function parseAuthenticatedSessionPreferences(raw) {
  const xml = String(raw ?? "");
  if (
    Buffer.byteLength(xml, "utf8") < 7 ||
    Buffer.byteLength(xml, "utf8") > MAX_ADB_OUTPUT_BYTES ||
    /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/iu.test(xml) ||
    !/<map(?:\s[^>]*)?>[\s\S]*<\/map>/u.test(xml)
  ) {
    fail("SESSION_CONTEXT_INVALID", "Session preferences XML is invalid");
  }
  const fields = new Map();
  const stringPattern = /<string\s+name="([A-Za-z0-9_]+)"\s*>([^<]*)<\/string>|<string\s+name="([A-Za-z0-9_]+)"\s*\/>/gu;
  for (const match of xml.matchAll(stringPattern)) {
    const name = match[1] ?? match[3];
    const value = decodeXmlText(match[2] ?? "");
    if (fields.has(name)) {
      fail("SESSION_CONTEXT_INVALID", "Session preferences contain duplicate fields");
    }
    fields.set(name, value.trim());
  }
  const session = Object.freeze({
    token: fields.get("notification_token") ?? "",
    userId: fields.get("notification_user_id") ?? "",
    username: fields.get("notification_username") ?? "",
    deviceUuid: fields.get("notification_device_uuid") ?? "",
    roomId: fields.get("notification_room_id") ?? ""
  });
  if (!session.token || !session.userId || !session.deviceUuid) {
    fail("SESSION_LOGGED_OUT", "Android authenticated session is unavailable");
  }
  return session;
}

export function sessionBindingHmac(session, key) {
  if (!Buffer.isBuffer(key) || key.byteLength !== 32) {
    fail("SESSION_BINDING_INVALID", "Session binding key is invalid");
  }
  const hmac = crypto.createHmac("sha256", key);
  for (const field of ["token", "userId", "username", "deviceUuid", "roomId"]) {
    const bytes = Buffer.from(String(session?.[field] ?? ""), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.byteLength);
    hmac.update(length);
    hmac.update(bytes);
    bytes.fill(0);
  }
  return hmac.digest("hex");
}

function parseReporterHeader(value, fields, code, label, nowMs) {
  requireExactFields(value, fields, code, label);
  for (const field of [
    "sampleSequence",
    "sampledAtEpochMs",
    "reporterStartedAtEpochMs"
  ]) {
    requireInteger(value[field], 1, Number.MAX_SAFE_INTEGER, code, `${label} ${field}`);
  }
  if (
    value.sampledAtEpochMs < nowMs - REPORTER_FRESHNESS_MS ||
    value.sampledAtEpochMs > nowMs + MAX_FUTURE_SKEW_MS ||
    value.reporterStartedAtEpochMs > value.sampledAtEpochMs
  ) {
    fail("REPORTER_STALE", `${label} is stale or from the future`);
  }
}

const GATT_REPORTER_FIELDS = Object.freeze([
  "schemaVersion", "source", "labBuild", "diagnosticsEnabled",
  "gattClientEnabled", "sampleSequence", "sampledAtEpochMs",
  "reporterStartedAtEpochMs", "state", "profileValidated", "negotiatedMtu",
  "lastFailure", "helloEnabled", "helloExchanged", "helloDeadlineActive",
  "mutualAuthEnabled", "mutuallyAuthenticated", "authDeadlineActive",
  "authenticatedSessionCount", "sessionKeyEnabled", "keyEstablished",
  "heartbeatEnabled", "active", "directControlDeadlineActive", "metrics"
]);
const GATT_METRIC_FIELDS = Object.freeze([
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
]);
const GATT_STATES = new Set([
  "IDLE", "CONNECTING", "DISCOVERING_SERVICES", "NEGOTIATING_MTU", "READY",
  "WRITING_HELLO", "READING_HELLO", "HELLO_EXCHANGED", "AUTH_SUBSCRIBING",
  "AUTH_WRITING_CLIENT_PROOF", "AUTH_WAITING_SERVER_PROOF",
  "AUTH_WRITING_FINISH", "AUTHENTICATED", "KEY_WRITING_CLIENT_SHARE",
  "KEY_WAITING_SERVER_SHARE", "KEY_WRITING_CLIENT_CONFIRM", "KEY_ESTABLISHED",
  "ACTIVATION_PROBING", "ACTIVE", "HEARTBEAT_WRITING_PONG", "CLOSING",
  "CLOSED"
]);

export function parseGattReporter(raw, nowMs = Date.now()) {
  const value = parseJson(raw, "GATT_REPORTER_INVALID", "GATT reporter");
  parseReporterHeader(
    value,
    GATT_REPORTER_FIELDS,
    "GATT_REPORTER_INVALID",
    "GATT reporter",
    nowMs
  );
  for (const [field, expected] of [
    ["schemaVersion", 4],
    ["source", "V6_ANDROID_DIRECT_CONTROL_LAB"],
    ["labBuild", true],
    ["diagnosticsEnabled", true],
    ["gattClientEnabled", true],
    ["helloEnabled", true],
    ["mutualAuthEnabled", true],
    ["sessionKeyEnabled", true],
    ["heartbeatEnabled", true],
    ["lastFailure", "NONE"]
  ]) {
    if (value[field] !== expected) {
      fail("GATT_REPORTER_INVALID", `GATT reporter field ${field} is invalid`);
    }
  }
  if (typeof value.state !== "string" || !GATT_STATES.has(value.state)) {
    fail("GATT_REPORTER_INVALID", "GATT reporter state is invalid");
  }
  for (const field of [
    "profileValidated", "helloExchanged", "helloDeadlineActive",
    "mutuallyAuthenticated", "authDeadlineActive", "keyEstablished", "active",
    "directControlDeadlineActive"
  ]) {
    if (typeof value[field] !== "boolean") {
      fail("GATT_REPORTER_INVALID", `GATT reporter field ${field} is invalid`);
    }
  }
  if (value.negotiatedMtu !== null) {
    requireInteger(
      value.negotiatedMtu,
      23,
      517,
      "GATT_REPORTER_INVALID",
      "GATT reporter negotiated MTU"
    );
  }
  requireInteger(
    value.authenticatedSessionCount,
    0,
    Number.MAX_SAFE_INTEGER,
    "GATT_REPORTER_INVALID",
    "GATT reporter authenticated session count"
  );
  requireExactFields(
    value.metrics,
    GATT_METRIC_FIELDS,
    "GATT_REPORTER_INVALID",
    "GATT reporter metrics"
  );
  for (const field of GATT_METRIC_FIELDS) {
    requireInteger(
      value.metrics[field],
      0,
      Number.MAX_SAFE_INTEGER,
      "GATT_REPORTER_INVALID",
      `GATT metric ${field}`
    );
  }
  if (value.metrics.failures !== 0) {
    fail("GATT_FAILURE_REPORTED", "GATT reporter contains failures");
  }
  return Object.freeze(value);
}

const AGENT_REPORTER_FIELDS = Object.freeze([
  "schemaVersion", "source", "labBuild", "diagnosticsEnabled", "agentEnabled",
  "sampleSequence", "sampledAtEpochMs", "reporterStartedAtEpochMs", "state",
  "metrics", "resources"
]);
const AGENT_METRIC_FIELDS = Object.freeze([
  "startCount", "stopCount", "backoffCount", "transitionCount",
  "duplicateEventCount", "invalidTransitionCount"
]);
const AGENT_RESOURCE_FIELDS = Object.freeze([
  "scannerActive", "advertiserActive", "gattServerActive", "gattClientActive",
  "sessionCount"
]);
const AGENT_STATES = new Set([
  "STARTING", "DISCOVERING", "DIRECT_SERVER", "PEER_CONNECTED", "DEGRADED",
  "BACKOFF"
]);

export function parseAgentReporter(raw, nowMs = Date.now()) {
  const value = parseJson(raw, "AGENT_REPORTER_INVALID", "Agent reporter");
  parseReporterHeader(
    value,
    AGENT_REPORTER_FIELDS,
    "AGENT_REPORTER_INVALID",
    "Agent reporter",
    nowMs
  );
  for (const [field, expected] of [
    ["schemaVersion", 1],
    ["source", "V6_ANDROID_CONNECTIVITY_AGENT"],
    ["labBuild", true],
    ["diagnosticsEnabled", true],
    ["agentEnabled", true]
  ]) {
    if (value[field] !== expected) {
      fail("AGENT_REPORTER_INVALID", `Agent reporter field ${field} is invalid`);
    }
  }
  if (typeof value.state !== "string") {
    fail("AGENT_REPORTER_INVALID", "Bluetooth agent state is invalid");
  }
  if (["DISABLED", "PERMISSION_REQUIRED", "STOPPED"].includes(value.state)) {
    fail("AGENT_NOT_RUNNING", "Bluetooth agent is not running");
  }
  if (!AGENT_STATES.has(value.state)) {
    fail("AGENT_REPORTER_INVALID", "Bluetooth agent state is invalid");
  }
  requireExactFields(
    value.metrics,
    AGENT_METRIC_FIELDS,
    "AGENT_REPORTER_INVALID",
    "Agent reporter metrics"
  );
  requireExactFields(
    value.resources,
    AGENT_RESOURCE_FIELDS,
    "AGENT_REPORTER_INVALID",
    "Agent reporter resources"
  );
  for (const field of AGENT_METRIC_FIELDS) {
    requireInteger(value.metrics[field], 0, Number.MAX_SAFE_INTEGER,
      "AGENT_REPORTER_INVALID", `Agent metric ${field}`);
  }
  for (const field of AGENT_RESOURCE_FIELDS) {
    if (field === "sessionCount") {
      requireInteger(value.resources[field], 0, Number.MAX_SAFE_INTEGER,
        "AGENT_REPORTER_INVALID", `Agent resource ${field}`);
    } else if (typeof value.resources[field] !== "boolean") {
      fail("AGENT_REPORTER_INVALID", `Agent resource ${field} is invalid`);
    }
  }
  if (value.metrics.invalidTransitionCount !== 0) {
    fail("AGENT_REPORTER_INVALID", "Agent reporter contains invalid transitions");
  }
  return Object.freeze(value);
}

export function parsePackageState(raw, currentUser) {
  requireInteger(
    currentUser,
    0,
    Number.MAX_SAFE_INTEGER,
    "PACKAGE_STATE_INVALID",
    "Android user"
  );
  const text = String(raw ?? "");
  const uidMatches = [...text.matchAll(/^\s*userId=(\d+)\s*$/gmu)];
  const userPattern = new RegExp(`^\\s*User ${currentUser}:.*\\bstopped=(true|false)\\b`, "mu");
  const userMatch = text.match(userPattern);
  if (uidMatches.length !== 1 || !userMatch) {
    fail("PACKAGE_STATE_INVALID", "Installed package state is unavailable");
  }
  return Object.freeze({
    appUid: requireInteger(Number(uidMatches[0][1]), 1, Number.MAX_SAFE_INTEGER,
      "PACKAGE_STATE_INVALID", "Package UID"),
    stopped: userMatch[1] === "true"
  });
}

export function parsePid(raw) {
  const value = String(raw ?? "").trim();
  if (!/^[1-9]\d*$/u.test(value)) {
    fail("PROCESS_MISSING", "Android application process is not running");
  }
  return requireInteger(Number(value), 1, Number.MAX_SAFE_INTEGER,
    "PROCESS_MISSING", "Android application PID");
}

export function parseAndroidApi(raw) {
  const value = String(raw ?? "").trim();
  if (!/^[1-9]\d*$/u.test(value)) {
    fail("ANDROID_API_INVALID", "Android API level is invalid");
  }
  return requireInteger(Number(value), 33, 10_000,
    "ANDROID_API_INVALID", "Android API level");
}

export function parseApplicationExitCommitments(raw, currentUser, packageName) {
  requireInteger(
    currentUser,
    0,
    Number.MAX_SAFE_INTEGER,
    "EXIT_INFO_INVALID",
    "Android user"
  );
  if (typeof packageName !== "string" || !PACKAGE_PATTERN.test(packageName)) {
    fail("EXIT_INFO_INVALID", "ApplicationExitInfo package is invalid");
  }
  const text = String(raw ?? "");
  if (!text.includes("ACTIVITY MANAGER PROCESS EXIT INFO (dumpsys activity exit-info)")) {
    fail("EXIT_INFO_INVALID", "ApplicationExitInfo output is invalid");
  }
  const commitments = new Set();
  const counts = Object.fromEntries([...EXIT_REASONS.values()].map((field) => [field, 0]));
  const markers = [...text.matchAll(/^\s*ApplicationExitInfo\s+#[^:\r\n]+:\s*$/gmu)];
  for (let index = 0; index < markers.length; index += 1) {
    const start = markers[index].index;
    const end = index + 1 < markers.length ? markers[index + 1].index : text.length;
    const block = text.slice(start, end);
    const user = block.match(/\buser=(\d+)\b/u);
    const reason = block.match(/\breason=(\d+)\b/u);
    const processName = block.match(/\bprocess=([^\r\n]*?)(?=\s+reason=\d+\b|\s*$)/mu)?.[1]?.trim();
    if (!user || !reason || !processName) {
      fail("EXIT_INFO_INVALID", "ApplicationExitInfo record is incomplete");
    }
    if (Number(user[1]) !== currentUser || processName !== packageName) continue;
    const reasonCode = Number(reason[1]);
    const counter = EXIT_REASONS.get(reasonCode);
    if (!counter) continue;
    counts[counter] += 1;
    commitments.add(sha256(Buffer.from(block.trim(), "utf8")));
  }
  return Object.freeze({ commitments, counts: Object.freeze(counts) });
}

function parseApkPath(raw) {
  const lines = String(raw ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith("package:/") || !lines[0].endsWith(".apk")) {
    fail("APK_LAYOUT_INVALID", "Installed APK layout is invalid");
  }
  const value = lines[0].slice("package:".length);
  if (/\s|[\x00-\x1f\x7f]/u.test(value)) {
    fail("APK_LAYOUT_INVALID", "Installed APK path is invalid");
  }
  return value;
}

function parseApkSha256(raw) {
  const match = String(raw ?? "").match(/^([0-9a-fA-F]{64})\s+\S+\s*$/u);
  if (!match) fail("APK_DIGEST_INVALID", "Installed APK digest is invalid");
  return match[1].toLowerCase();
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

export function buildAdbCommandArgs(serial, args) {
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        /[\x00-\x1f\x7f]/u.test(argument)
    )
  ) {
    fail("ADB_ARGUMENT_INVALID", "ADB command arguments are invalid");
  }
  if (serial === null) return [...args];
  if (typeof serial !== "string" || !SERIAL_PATTERN.test(serial)) {
    fail("ADB_ARGUMENT_INVALID", "ADB serial is invalid");
  }
  return ["-s", serial, ...args];
}

async function runAdb(adb, serial, args, signal, secrets) {
  try {
    const result = await execFileAsync(adb, buildAdbCommandArgs(serial, args), {
      encoding: "utf8",
      maxBuffer: MAX_ADB_OUTPUT_BYTES,
      timeout: ADB_TIMEOUT_MS,
      signal,
      windowsHide: true
    });
    return result.stdout ?? "";
  } catch (error) {
    if (signal?.aborted) {
      fail("MONITOR_INTERRUPTED", "Android continuity monitor was interrupted", 130);
    }
    const detail = redact(error?.stderr || error?.message || "ADB command failed", secrets);
    fail("ADB_COMMAND_FAILED", detail || "ADB command failed", 1, { cause: error });
  }
}

export function buildRunAsArgs(packageName, androidUserId, file) {
  if (
    typeof packageName !== "string" ||
    !PACKAGE_PATTERN.test(packageName) ||
    !Number.isSafeInteger(androidUserId) ||
    androidUserId < 0 ||
    typeof file !== "string" ||
    !/^(?:no_backup|shared_prefs)\/[A-Za-z0-9_.-]+$/u.test(file)
  ) {
    fail("ADB_ARGUMENT_INVALID", "Android run-as arguments are invalid");
  }
  return [
    "exec-out", "run-as", packageName, "--user", String(androidUserId), "cat", file
  ];
}

async function captureAndroidSample(context, { includeApkDigest = false } = {}) {
  const { adb, serial, packageName, role, signal, sessionKey } = context;
  const secrets = [serial, packageName];
  const devicesRaw = await runAdb(adb, null, ["devices"], signal, secrets);
  const devices = parseAdbDevices(devicesRaw);
  if (devices.get(serial) !== "device" || [...devices.keys()].filter((key) => key === serial).length !== 1) {
    fail("ADB_DEVICE_UNAVAILABLE", "Fixed Android target is unavailable");
  }
  const currentUser = parseCurrentUser(
    await runAdb(adb, serial, ["shell", "am", "get-current-user"], signal, secrets),
    role
  );
  const nowMs = Date.now();
  const [
    apiRaw,
    packageRaw,
    pidRaw,
    serviceRaw,
    exitInfoRaw,
    gattRaw,
    agentRaw,
    prefsRaw,
    apkPathRaw
  ] = await Promise.all([
    runAdb(adb, serial, ["shell", "getprop", "ro.build.version.sdk"], signal, secrets),
    runAdb(adb, serial, ["shell", "dumpsys", "package", packageName], signal, secrets),
    runAdb(adb, serial, ["shell", "pidof", "-s", packageName], signal, secrets),
    runAdb(adb, serial, ["shell", "dumpsys", "activity", "-a", "services", packageName], signal, secrets),
    runAdb(adb, serial, ["shell", "dumpsys", "activity", "exit-info", packageName], signal, secrets),
    runAdb(adb, serial, buildRunAsArgs(packageName, currentUser, GATT_STATUS_FILE), signal, secrets),
    runAdb(adb, serial, buildRunAsArgs(packageName, currentUser, AGENT_STATUS_FILE), signal, secrets),
    runAdb(adb, serial, buildRunAsArgs(packageName, currentUser, SESSION_PREFS_FILE), signal, secrets),
    includeApkDigest
      ? runAdb(adb, serial, ["shell", "pm", "path", packageName], signal, secrets)
      : Promise.resolve("")
  ]);
  const installedVersion = parseInstalledVersion(packageRaw, role);
  const packageState = parsePackageState(packageRaw, currentUser);
  if (packageState.stopped) fail("PACKAGE_STOPPED", "Android package is stopped");
  const service = parseForegroundServiceDump(serviceRaw, currentUser, role);
  if (service.foreground !== true) {
    fail("FOREGROUND_SERVICE_MISSING", "Bluetooth failover service is not foreground");
  }
  const session = parseAuthenticatedSessionPreferences(prefsRaw);
  const sample = {
    sampledAt: new Date(nowMs).toISOString(),
    androidApi: parseAndroidApi(apiRaw),
    currentUser,
    installedVersion,
    appUid: packageState.appUid,
    pid: parsePid(pidRaw),
    gatt: parseGattReporter(gattRaw, nowMs),
    agent: parseAgentReporter(agentRaw, nowMs),
    sessionBindingHmacSha256: sessionBindingHmac(session, sessionKey),
    exitInfo: parseApplicationExitCommitments(exitInfoRaw, currentUser, packageName)
  };
  for (const value of Object.values(session)) {
    if (typeof value === "string" && value.length > 0) secrets.push(value);
  }
  if (includeApkDigest) {
    const apkPath = parseApkPath(apkPathRaw);
    sample.apkSha256 = parseApkSha256(
      await runAdb(adb, serial, ["exec-out", "sha256sum", apkPath], signal, [...secrets, apkPath])
    );
  }
  return Object.freeze(sample);
}

function roleTarget(role, packageName) {
  const target = ROLE_TARGETS[role];
  if (!target || target.packageId !== packageName || !PACKAGE_PATTERN.test(packageName)) {
    fail("TARGET_ROLE_MISMATCH", "Android role and package do not match");
  }
  return target;
}

function assertConfigMatchesTarget(config, target) {
  if (
    config.expected.versionName !== target.versionName ||
    config.expected.versionCode !== target.versionCode
  ) {
    fail("CONFIG_TARGET_MISMATCH", "Monitor config does not match certified build");
  }
}

function buildBaseline(config, context, sample, sessionKey) {
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_ANDROID_CONTINUITY_MONITOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: "PRIVATE_ANDROID_CONTINUITY_BASELINE",
    campaignId: config.campaignId,
    createdAt: sample.sampledAt,
    binding: Object.freeze({
      serial: context.serial,
      role: context.role,
      packageName: context.packageName,
      versionName: sample.installedVersion.versionName,
      versionCode: sample.installedVersion.versionCode,
      androidApi: sample.androidApi,
      androidUserId: sample.currentUser,
      appUid: sample.appUid,
      pid: sample.pid,
      gattReporterStartedAtEpochMs: sample.gatt.reporterStartedAtEpochMs,
      agentReporterStartedAtEpochMs: sample.agent.reporterStartedAtEpochMs,
      sessionHmacKeyBase64: sessionKey.toString("base64"),
      sessionBindingHmacSha256: sample.sessionBindingHmacSha256,
      apkSha256: sample.apkSha256
    }),
    reporters: Object.freeze({
      gattSampleSequence: sample.gatt.sampleSequence,
      gattSampledAtEpochMs: sample.gatt.sampledAtEpochMs,
      agentSampleSequence: sample.agent.sampleSequence,
      agentSampledAtEpochMs: sample.agent.sampledAtEpochMs,
      agentStartCount: sample.agent.metrics.startCount,
      agentStopCount: sample.agent.metrics.stopCount
    }),
    exitInfo: Object.freeze({
      recordCommitmentsSha256: Object.freeze([...sample.exitInfo.commitments].sort())
    })
  });
}

export function parsePrivateBaseline(value) {
  const baseline = typeof value === "string"
    ? parseJson(value, "BASELINE_INVALID", "Monitor baseline")
    : value;
  requireExactFields(
    baseline,
    ["schemaVersion", "harnessVersion", "product", "phase", "mode", "campaignId", "createdAt", "binding", "reporters", "exitInfo"],
    "BASELINE_INVALID",
    "Monitor baseline"
  );
  for (const [field, expected] of [
    ["schemaVersion", 1],
    ["harnessVersion", B5_ANDROID_CONTINUITY_MONITOR_VERSION],
    ["product", "V6"],
    ["phase", "B5"],
    ["mode", "PRIVATE_ANDROID_CONTINUITY_BASELINE"]
  ]) {
    if (baseline[field] !== expected) fail("BASELINE_INVALID", `Baseline ${field} is invalid`);
  }
  if (!UUID_V4_PATTERN.test(baseline.campaignId)) fail("BASELINE_INVALID", "Baseline campaign is invalid");
  requireTimestamp(baseline.createdAt, "BASELINE_INVALID", "Baseline timestamp");
  const bindingFields = [
    "serial", "role", "packageName", "versionName", "versionCode", "androidApi",
    "androidUserId", "appUid", "pid", "gattReporterStartedAtEpochMs",
    "agentReporterStartedAtEpochMs", "sessionHmacKeyBase64",
    "sessionBindingHmacSha256", "apkSha256"
  ];
  requireExactFields(baseline.binding, bindingFields, "BASELINE_INVALID", "Baseline binding");
  if (
    !SERIAL_PATTERN.test(baseline.binding.serial) ||
    !ROLE_TARGETS[baseline.binding.role] ||
    ROLE_TARGETS[baseline.binding.role].packageId !== baseline.binding.packageName ||
    !SHA256_PATTERN.test(baseline.binding.sessionBindingHmacSha256) ||
    /^0{64}$/u.test(baseline.binding.sessionBindingHmacSha256) ||
    !SHA256_PATTERN.test(baseline.binding.apkSha256)
  ) fail("BASELINE_INVALID", "Baseline binding is invalid");
  const certifiedTarget = ROLE_TARGETS[baseline.binding.role];
  if (
    baseline.binding.versionName !== certifiedTarget.versionName ||
    baseline.binding.versionCode !== certifiedTarget.versionCode ||
    baseline.binding.apkSha256 !== certifiedTarget.sha256
  ) {
    fail("BASELINE_INVALID", "Baseline binding is not a certified target");
  }
  const key = Buffer.from(baseline.binding.sessionHmacKeyBase64, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== baseline.binding.sessionHmacKeyBase64) {
    fail("BASELINE_INVALID", "Baseline session HMAC key is invalid");
  }
  for (const field of ["versionCode", "androidApi", "androidUserId", "appUid", "pid", "gattReporterStartedAtEpochMs", "agentReporterStartedAtEpochMs"]) {
    requireInteger(baseline.binding[field], field === "androidUserId" ? 0 : 1,
      Number.MAX_SAFE_INTEGER, "BASELINE_INVALID", `Baseline ${field}`);
  }
  requireExactFields(baseline.reporters,
    ["gattSampleSequence", "gattSampledAtEpochMs", "agentSampleSequence", "agentSampledAtEpochMs", "agentStartCount", "agentStopCount"],
    "BASELINE_INVALID", "Baseline reporters");
  for (const [field, value] of Object.entries(baseline.reporters)) {
    requireInteger(
      value,
      field === "agentStopCount" ? 0 : 1,
      Number.MAX_SAFE_INTEGER,
      "BASELINE_INVALID",
      "Baseline reporter value"
    );
  }
  requireExactFields(baseline.exitInfo, ["recordCommitmentsSha256"],
    "BASELINE_INVALID", "Baseline exit info");
  if (!Array.isArray(baseline.exitInfo.recordCommitmentsSha256) ||
      baseline.exitInfo.recordCommitmentsSha256.some(
        (item) => !SHA256_PATTERN.test(item) || /^0{64}$/u.test(item)
      ) ||
      new Set(baseline.exitInfo.recordCommitmentsSha256).size !== baseline.exitInfo.recordCommitmentsSha256.length ||
      baseline.exitInfo.recordCommitmentsSha256.some(
        (item, index, items) => index > 0 && items[index - 1] > item
      )) {
    fail("BASELINE_INVALID", "Baseline exit commitments are invalid");
  }
  return Object.freeze({ baseline: Object.freeze(baseline), sessionKey: key });
}

function constantTimeHexEqual(left, right) {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function assertContinuitySample(baseline, previous, sample) {
  const binding = baseline.binding;
  for (const [actual, expected, code] of [
    [sample.currentUser, binding.androidUserId, "ANDROID_USER_CHANGED"],
    [sample.installedVersion.versionName, binding.versionName, "PACKAGE_VERSION_CHANGED"],
    [sample.installedVersion.versionCode, binding.versionCode, "PACKAGE_VERSION_CHANGED"],
    [sample.appUid, binding.appUid, "PACKAGE_UID_CHANGED"],
    [sample.pid, binding.pid, "PROCESS_RESTARTED"],
    [sample.gatt.reporterStartedAtEpochMs, binding.gattReporterStartedAtEpochMs, "REPORTER_RESTARTED"],
    [sample.agent.reporterStartedAtEpochMs, binding.agentReporterStartedAtEpochMs, "REPORTER_RESTARTED"]
  ]) {
    if (actual !== expected) fail(code, "Android continuity binding changed");
  }
  if (!constantTimeHexEqual(sample.sessionBindingHmacSha256, binding.sessionBindingHmacSha256)) {
    fail("SESSION_BINDING_CHANGED", "Authenticated Android session changed");
  }
  if (
    sample.gatt.sampleSequence < previous.gattSampleSequence ||
    sample.agent.sampleSequence < previous.agentSampleSequence
  ) {
    fail("REPORTER_SEQUENCE_REGRESSION", "Android reporter sequence regressed");
  }
  if (
    sample.agent.metrics.startCount !== baseline.reporters.agentStartCount ||
    sample.agent.metrics.stopCount !== baseline.reporters.agentStopCount
  ) {
    fail("AGENT_LIFECYCLE_CHANGED", "Android Bluetooth agent lifecycle changed");
  }
  const known = new Set(baseline.exitInfo.recordCommitmentsSha256);
  for (const commitment of sample.exitInfo.commitments) {
    if (!known.has(commitment)) {
      fail("NEW_ANDROID_EXIT", "Android recorded a crash, ANR or force-stop");
    }
  }
  return Object.freeze({
    gattSampleSequence: sample.gatt.sampleSequence,
    agentSampleSequence: sample.agent.sampleSequence
  });
}

function emptyObserved(scheduledSamples) {
  return {
    scheduledSamples,
    completedSamples: 0,
    maximumPollGapMs: 0,
    ...Object.fromEntries(B5_ANDROID_CONTINUITY_COUNTER_FIELDS.map((field) => [field, 0]))
  };
}

export function buildB5AndroidContinuityAttestation({
  campaignId,
  accountDeviceCommitmentSha256,
  monitoredFrom,
  monitoredUntil,
  requiredDurationMs,
  pollIntervalMs,
  role,
  packageName,
  versionName,
  versionCode,
  androidApi,
  observed,
  generatedAt = monitoredUntil
}) {
  const startMs = requireTimestamp(monitoredFrom, "ATTESTATION_INVALID", "Monitor start");
  const endMs = requireTimestamp(monitoredUntil, "ATTESTATION_INVALID", "Monitor end");
  requireTimestamp(generatedAt, "ATTESTATION_INVALID", "Attestation timestamp");
  const durationMs = endMs - startMs;
  if (durationMs < requiredDurationMs) fail("ATTESTATION_INVALID", "Monitor duration is incomplete");
  if (
    typeof accountDeviceCommitmentSha256 !== "string" ||
    !SHA256_PATTERN.test(accountDeviceCommitmentSha256) ||
    /^0{64}$/u.test(accountDeviceCommitmentSha256)
  ) {
    fail(
      "ATTESTATION_INVALID",
      "Account/device commitment is invalid"
    );
  }
  const report = {
    schemaVersion: 1,
    harnessVersion: B5_ANDROID_CONTINUITY_MONITOR_VERSION,
    product: "V6",
    phase: "B5",
    generatedAt,
    mode: "PHYSICAL_ADB_CONTINUITY",
    verdict: "PASS",
    accountDeviceCommitmentSha256,
    campaign: {
      campaignIdCommitmentSha256: uuidCommitment(campaignId),
      monitoredFrom,
      monitoredUntil,
      requiredDurationMs,
      durationMs,
      pollIntervalMs
    },
    target: { role, packageName, versionName, versionCode, androidApi },
    checks: Object.fromEntries(ATTESTATION_CHECK_FIELDS.map((field) => [field, "PASS"])),
    observed: structuredClone(observed),
    privacy: Object.fromEntries(
      ATTESTATION_PRIVACY_FIELDS.map((field) => [
        field,
        field === "accountDeviceCommitmentIncluded"
      ])
    ),
    physicalAdbAccessed: true
  };
  parseB5AndroidContinuityAttestation(report);
  return Object.freeze(report);
}

function assertRedactedAttestation(value) {
  const encoded = JSON.stringify(value);
  for (const pattern of [
    /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/iu,
    /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu,
    /\/(?:home|tmp|var|etc|run)\//u,
    /"(?:serial|deviceSerial|pid|androidUserId|appUid|sessionBindingHmacSha256|account|token|nodeId|reporterStartedAtEpochMs|enrollment)"/iu
  ]) {
    if (pattern.test(encoded)) fail("ATTESTATION_PRIVACY_INVALID", "Attestation leaks private data");
  }
}

export function parseB5AndroidContinuityAttestation(raw) {
  const value = typeof raw === "string"
    ? parseJson(raw, "ATTESTATION_INVALID", "Android continuity attestation")
    : raw;
  const accountDeviceBound =
    value?.schemaVersion === 1 &&
    value?.harnessVersion === B5_ANDROID_CONTINUITY_MONITOR_VERSION;
  const historical =
    value?.schemaVersion === 1 &&
    value?.harnessVersion === LEGACY_B5_ANDROID_CONTINUITY_MONITOR_VERSION;
  if (!accountDeviceBound && !historical) {
    fail("ATTESTATION_INVALID", "Attestation version is invalid");
  }
  requireExactFields(value,
    accountDeviceBound
      ? ["schemaVersion", "harnessVersion", "product", "phase", "generatedAt", "mode", "verdict", "accountDeviceCommitmentSha256", "campaign", "target", "checks", "observed", "privacy", "physicalAdbAccessed"]
      : ["schemaVersion", "harnessVersion", "product", "phase", "generatedAt", "mode", "verdict", "campaign", "target", "checks", "observed", "privacy", "physicalAdbAccessed"],
    "ATTESTATION_INVALID", "Android continuity attestation");
  for (const [field, expected] of [
    ["schemaVersion", 1],
    [
      "harnessVersion",
      accountDeviceBound
        ? B5_ANDROID_CONTINUITY_MONITOR_VERSION
        : LEGACY_B5_ANDROID_CONTINUITY_MONITOR_VERSION
    ],
    ["product", "V6"], ["phase", "B5"], ["mode", "PHYSICAL_ADB_CONTINUITY"],
    ["verdict", "PASS"], ["physicalAdbAccessed", true]
  ]) if (value[field] !== expected) fail("ATTESTATION_INVALID", `Attestation ${field} is invalid`);
  if (
    accountDeviceBound &&
    (typeof value.accountDeviceCommitmentSha256 !== "string" ||
      !SHA256_PATTERN.test(value.accountDeviceCommitmentSha256) ||
      /^0{64}$/u.test(value.accountDeviceCommitmentSha256))
  ) {
    fail(
      "ATTESTATION_INVALID",
      "Attestation account/device commitment is invalid"
    );
  }
  const generatedAtMs = requireTimestamp(value.generatedAt, "ATTESTATION_INVALID", "Attestation timestamp");
  requireExactFields(value.campaign,
    ["campaignIdCommitmentSha256", "monitoredFrom", "monitoredUntil", "requiredDurationMs", "durationMs", "pollIntervalMs"],
    "ATTESTATION_INVALID", "Attestation campaign");
  if (
    !SHA256_PATTERN.test(value.campaign.campaignIdCommitmentSha256) ||
    /^0{64}$/u.test(value.campaign.campaignIdCommitmentSha256)
  ) {
    fail("ATTESTATION_INVALID", "Attestation campaign commitment is invalid");
  }
  const monitoredFromMs = requireTimestamp(value.campaign.monitoredFrom,
    "ATTESTATION_INVALID", "Attestation start");
  const monitoredUntilMs = requireTimestamp(value.campaign.monitoredUntil,
    "ATTESTATION_INVALID", "Attestation end");
  requireInteger(value.campaign.requiredDurationMs, MIN_CAMPAIGN_DURATION_MS,
    MAX_CAMPAIGN_DURATION_MS, "ATTESTATION_INVALID", "Required monitor duration");
  requireInteger(value.campaign.durationMs, value.campaign.requiredDurationMs,
    MAX_CAMPAIGN_DURATION_MS + 60_000, "ATTESTATION_INVALID", "Monitor duration");
  requireInteger(value.campaign.pollIntervalMs, MIN_POLL_MS, MAX_POLL_MS,
    "ATTESTATION_INVALID", "Monitor polling interval");
  if (monitoredUntilMs - monitoredFromMs !== value.campaign.durationMs || generatedAtMs < monitoredUntilMs) {
    fail("ATTESTATION_INVALID", "Attestation campaign timeline is inconsistent");
  }
  requireExactFields(value.target,
    ["role", "packageName", "versionName", "versionCode", "androidApi"],
    "ATTESTATION_INVALID", "Attestation target");
  const target = roleTarget(value.target.role, value.target.packageName);
  if (value.target.versionName !== target.versionName || value.target.versionCode !== target.versionCode) {
    fail("ATTESTATION_INVALID", "Attestation target version is not certified");
  }
  requireInteger(value.target.androidApi, 33, 10_000, "ATTESTATION_INVALID", "Android API");
  requireExactFields(value.checks, ATTESTATION_CHECK_FIELDS,
    "ATTESTATION_INVALID", "Attestation checks");
  for (const field of ATTESTATION_CHECK_FIELDS) {
    if (value.checks[field] !== "PASS") fail("ATTESTATION_INVALID", `Attestation check ${field} failed`);
  }
  requireExactFields(value.observed,
    ["scheduledSamples", "completedSamples", "maximumPollGapMs", ...B5_ANDROID_CONTINUITY_COUNTER_FIELDS],
    "ATTESTATION_INVALID", "Attestation observations");
  for (const field of ["scheduledSamples", "completedSamples", "maximumPollGapMs", ...B5_ANDROID_CONTINUITY_COUNTER_FIELDS]) {
    requireInteger(value.observed[field], 0, Number.MAX_SAFE_INTEGER,
      "ATTESTATION_INVALID", `Attestation observation ${field}`);
  }
  const expectedSamples = buildAndroidMonitorSampleOffsets(
    value.campaign.requiredDurationMs,
    value.campaign.pollIntervalMs
  ).length;
  if (
    value.observed.scheduledSamples !== expectedSamples ||
    value.observed.completedSamples !== expectedSamples ||
    value.observed.maximumPollGapMs === 0 ||
    value.observed.maximumPollGapMs > value.campaign.pollIntervalMs + ADB_TIMEOUT_MS ||
    B5_ANDROID_CONTINUITY_COUNTER_FIELDS.some((field) => value.observed[field] !== 0)
  ) fail("ATTESTATION_INVALID", "Attestation observations do not prove continuity");
  const privacyFields = accountDeviceBound
    ? ATTESTATION_PRIVACY_FIELDS
    : LEGACY_ATTESTATION_PRIVACY_FIELDS;
  requireExactFields(value.privacy, privacyFields,
    "ATTESTATION_PRIVACY_INVALID", "Attestation privacy");
  for (const field of privacyFields) {
    const expected = field === "accountDeviceCommitmentIncluded";
    if (value.privacy[field] !== expected) fail("ATTESTATION_PRIVACY_INVALID", `Attestation privacy ${field} is invalid`);
  }
  assertRedactedAttestation(value);
  return Object.freeze({
    report: Object.freeze(value),
    generatedAtMs,
    monitoredFromMs,
    monitoredUntilMs,
    campaignIdCommitmentSha256: value.campaign.campaignIdCommitmentSha256,
    accountDeviceBound,
    accountDeviceCommitmentSha256: accountDeviceBound
      ? value.accountDeviceCommitmentSha256
      : null
  });
}

export function validB5AndroidContinuityAttestationFixture({
  campaignId = "00000000-0000-4000-8000-000000000001",
  accountDeviceCommitmentSha256 = createB5AccountDeviceCommitmentSha256(
    validB5AccountDeviceBindingFixture({ campaignId })
  ),
  monitoredFrom = "2026-07-20T23:59:00.000Z",
  requiredDurationMs = 6_100_000,
  pollIntervalMs = 5_000
} = {}) {
  const monitoredUntil = new Date(Date.parse(monitoredFrom) + requiredDurationMs).toISOString();
  const scheduledSamples = buildAndroidMonitorSampleOffsets(
    requiredDurationMs,
    pollIntervalMs
  ).length;
  const observed = emptyObserved(scheduledSamples);
  observed.completedSamples = scheduledSamples;
  observed.maximumPollGapMs = pollIntervalMs;
  return buildB5AndroidContinuityAttestation({
    campaignId,
    accountDeviceCommitmentSha256,
    monitoredFrom,
    monitoredUntil,
    requiredDurationMs,
    pollIntervalMs,
    role: "handheld",
    packageName: ROLE_TARGETS.handheld.packageId,
    versionName: ROLE_TARGETS.handheld.versionName,
    versionCode: ROLE_TARGETS.handheld.versionCode,
    androidApi: 36,
    observed
  });
}

export function buildAndroidMonitorSampleOffsets(durationMs, pollIntervalMs) {
  requireInteger(
    durationMs,
    MIN_CAMPAIGN_DURATION_MS,
    MAX_CAMPAIGN_DURATION_MS,
    "INVALID_ARGUMENT",
    "Monitor duration"
  );
  requireInteger(
    pollIntervalMs,
    MIN_POLL_MS,
    MAX_POLL_MS,
    "INVALID_ARGUMENT",
    "Monitor poll interval"
  );
  const scheduledSamples = Math.ceil(durationMs / pollIntervalMs) + 1;
  return Object.freeze(
    Array.from({ length: scheduledSamples }, (_unused, index) =>
      Math.min(index * pollIntervalMs, durationMs)
    )
  );
}

function distinctPrivatePaths(paths) {
  const values = paths.filter(Boolean).map((value) => path.resolve(value));
  if (new Set(values).size !== values.length) {
    fail("INVALID_ARGUMENT", "Monitor private artifacts must use distinct paths", 2);
  }
}

export function parseAndroidMonitorArguments(argv) {
  const options = {
    mode: null,
    adb: null,
    serial: null,
    packageName: null,
    role: null,
    config: null,
    baseline: null,
    privateOutput: null,
    attestation: null,
    pollMs: 1_000
  };
  const modes = new Map([
    ["--capture-baseline", "BASELINE"],
    ["--monitor", "MONITOR"],
    ["--self-test", "SELF_TEST"],
    ["--help", "HELP"]
  ]);
  const values = new Set([
    "--adb", "--serial", "--package", "--role", "--config", "--baseline",
    "--private-output", "--attestation", "--poll-ms"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (modes.has(argument)) {
      if (options.mode !== null) fail("INVALID_ARGUMENT", "Monitor modes are mutually exclusive", 2);
      options.mode = modes.get(argument);
      continue;
    }
    if (!values.has(argument) || index + 1 >= argv.length) {
      fail("INVALID_ARGUMENT", `Unsupported monitor argument ${argument}`, 2);
    }
    const value = argv[++index];
    if (argument === "--adb") options.adb = path.resolve(value);
    if (argument === "--serial") options.serial = value;
    if (argument === "--package") options.packageName = value;
    if (argument === "--role") options.role = value;
    if (argument === "--config") options.config = path.resolve(value);
    if (argument === "--baseline") options.baseline = path.resolve(value);
    if (argument === "--private-output") options.privateOutput = path.resolve(value);
    if (argument === "--attestation") options.attestation = path.resolve(value);
    if (argument === "--poll-ms") options.pollMs = Number(value);
  }
  if (options.mode === null) fail("INVALID_ARGUMENT", "A monitor mode is required", 2);
  if (["SELF_TEST", "HELP"].includes(options.mode)) {
    if (argv.length !== 1) fail("INVALID_ARGUMENT", "Self-test and help accept no other arguments", 2);
    return options;
  }
  for (const field of ["adb", "serial", "packageName", "role", "config", "baseline"]) {
    if (!options[field]) fail("INVALID_ARGUMENT", `Monitor argument ${field} is required`, 2);
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
      ? androidMonitorPublicationJournalPath(options.privateOutput)
      : null
  ]);
  if (!path.isAbsolute(options.adb) || !fs.existsSync(options.adb) || (fs.statSync(options.adb).mode & 0o111) === 0) {
    fail("INVALID_ARGUMENT", "ADB must be an absolute executable path", 2);
  }
  if (!SERIAL_PATTERN.test(options.serial)) fail("INVALID_ARGUMENT", "ADB serial is invalid", 2);
  roleTarget(options.role, options.packageName);
  requireInteger(options.pollMs, MIN_POLL_MS, MAX_POLL_MS,
    "INVALID_ARGUMENT", "Monitor poll interval");
  return options;
}

async function captureBaseline(options, config, target) {
  const sessionKey = crypto.randomBytes(32);
  const controller = new AbortController();
  const context = {
    ...options,
    signal: controller.signal,
    sessionKey
  };
  const sample = await captureAndroidSample(context, { includeApkDigest: true });
  if (
    sample.currentUser !== config.expected.androidUserId ||
    sample.installedVersion.versionName !== target.versionName ||
    sample.installedVersion.versionCode !== target.versionCode ||
    sample.apkSha256 !== target.sha256
  ) fail("TARGET_NOT_CERTIFIED", "Installed Android target does not match certification baseline");
  const baseline = buildBaseline(config, context, sample, sessionKey);
  atomicWritePrivateJson(options.baseline, baseline);
  sessionKey.fill(0);
  return {
    schemaVersion: 1,
    harnessVersion: B5_ANDROID_CONTINUITY_MONITOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: "BASELINE_CAPTURED",
    verdict: "READY",
    physicalAdbAccessed: true,
    gate: { b5HundredSessionGate: "PENDING", b6: "PENDING" }
  };
}

async function monitorCampaign(options, config, target, parsedBaseline) {
  const { baseline, sessionKey } = parsedBaseline;
  if (
    baseline.campaignId !== config.campaignId ||
    baseline.binding.serial !== options.serial ||
    baseline.binding.role !== options.role ||
    baseline.binding.packageName !== options.packageName ||
    baseline.binding.versionName !== target.versionName ||
    baseline.binding.versionCode !== target.versionCode ||
    baseline.binding.androidUserId !== config.expected.androidUserId ||
    baseline.binding.apkSha256 !== target.sha256
  ) fail("BASELINE_TARGET_MISMATCH", "Monitor baseline does not match campaign target");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const sampleOffsets = buildAndroidMonitorSampleOffsets(
    config.measurement.durationMs,
    options.pollMs
  );
  const scheduledSamples = sampleOffsets.length;
  const observed = emptyObserved(scheduledSamples);
  const startPerformanceMs = performance.now();
  const monitoredFrom = new Date().toISOString();
  let previousPerformanceMs = null;
  let previous = {
    gattSampleSequence: baseline.reporters.gattSampleSequence,
    agentSampleSequence: baseline.reporters.agentSampleSequence
  };
  try {
    const accountDeviceCommitmentSha256 =
      createB5AccountDeviceCommitmentSha256(
        b5AccountDeviceBindingFromPrivateBaseline(baseline)
      );
    const recovered = recoverAndroidMonitorArtifactPublication(
      {
        privateOutput: options.privateOutput,
        attestation: options.attestation,
        campaignId: config.campaignId
      },
      options.publicationRuntime ?? {}
    );
    if (recovered !== null) return recovered;
    requirePrivateParent(options.privateOutput);
    requirePrivateParent(options.attestation);
    if (fs.existsSync(options.privateOutput) || fs.existsSync(options.attestation)) {
      fail("PRIVATE_OUTPUT_EXISTS", "Monitor output already exists");
    }
    for (let index = 0; index < scheduledSamples; index += 1) {
      const deadline = startPerformanceMs + sampleOffsets[index];
      const waitMs = deadline - performance.now();
      if (waitMs > 0) await sleep(waitMs, undefined, { signal: controller.signal });
      const sampleStart = performance.now();
      const lateness = sampleStart - deadline;
      if (lateness > ADB_TIMEOUT_MS) {
        observed.pollDeadlineMisses += 1;
        fail("POLL_DEADLINE_MISSED", "Android monitor missed a polling deadline");
      }
      if (previousPerformanceMs !== null) {
        observed.maximumPollGapMs = Math.max(
          observed.maximumPollGapMs,
          Math.round(sampleStart - previousPerformanceMs)
        );
      }
      const sample = await captureAndroidSample({
        ...options,
        signal: controller.signal,
        sessionKey
      });
      previous = assertContinuitySample(baseline, previous, sample);
      previousPerformanceMs = sampleStart;
      observed.completedSamples += 1;
    }
    const monitoredUntil = new Date().toISOString();
    const attestation = buildB5AndroidContinuityAttestation({
      campaignId: config.campaignId,
      accountDeviceCommitmentSha256,
      monitoredFrom,
      monitoredUntil,
      requiredDurationMs: config.measurement.durationMs,
      pollIntervalMs: options.pollMs,
      role: options.role,
      packageName: options.packageName,
      versionName: target.versionName,
      versionCode: target.versionCode,
      androidApi: baseline.binding.androidApi,
      observed
    });
    const privateReport = {
      schemaVersion: 1,
      harnessVersion: B5_ANDROID_CONTINUITY_MONITOR_VERSION,
      product: "V6",
      phase: "B5",
      mode: "PRIVATE_ANDROID_CONTINUITY_RESULT",
      verdict: "PASS",
      campaignId: config.campaignId,
      baselineSha256: sha256(Buffer.from(`${JSON.stringify(baseline)}\n`, "utf8")),
      binding: {
        serial: baseline.binding.serial,
        role: baseline.binding.role,
        packageName: baseline.binding.packageName,
        versionName: baseline.binding.versionName,
        versionCode: baseline.binding.versionCode,
        androidUserId: baseline.binding.androidUserId,
        appUid: baseline.binding.appUid,
        pid: baseline.binding.pid
      },
      monitoredFrom,
      monitoredUntil,
      observed,
      attestationSha256: sha256(Buffer.from(`${JSON.stringify(attestation)}\n`, "utf8"))
    };
    return publishAndroidMonitorArtifacts(
      {
        privateOutput: options.privateOutput,
        attestation: options.attestation,
        campaignId: config.campaignId
      },
      privateReport,
      attestation,
      options.publicationRuntime ?? {}
    );
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof B5AndroidContinuityError)) {
      fail("MONITOR_INTERRUPTED", "Android continuity monitor was interrupted", 130);
    }
    throw error;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    sessionKey.fill(0);
  }
}

export function runSelfTest() {
  const fixture = validB5AndroidContinuityAttestationFixture();
  parseB5AndroidContinuityAttestation(fixture);
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_ANDROID_CONTINUITY_MONITOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: "SELF_TEST",
    verdict: "PASS",
    physicalAdbAccessed: false,
    gate: Object.freeze({ b5HundredSessionGate: "PENDING", b6: "PENDING" })
  });
}

function usage() {
  return [
    "V6 B5 Android continuity monitor",
    "",
    "  --capture-baseline --adb /abs/adb --serial ID --package PACKAGE --role handheld|station \\",
    "    --config PRIVATE.json --baseline PRIVATE.json",
    "  --monitor --adb /abs/adb --serial ID --package PACKAGE --role handheld|station \\",
    "    --config PRIVATE.json --baseline PRIVATE.json --private-output PRIVATE.json \\",
    "    --attestation REDACTED.json [--poll-ms 1000]",
    "  --self-test",
    ""
  ].join("\n");
}

function failureReport(error) {
  return {
    schemaVersion: 1,
    harnessVersion: B5_ANDROID_CONTINUITY_MONITOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: "ANDROID_CONTINUITY_FAILURE",
    verdict: "FAIL",
    failure: {
      code: error instanceof B5AndroidContinuityError ? error.code : "UNEXPECTED_FAILURE",
      message: "Android continuity monitoring failed"
    },
    physicalAdbAccessed: false,
    gate: { b5HundredSessionGate: "PENDING", b6: "PENDING" }
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseAndroidMonitorArguments(argv);
    if (options.mode === "HELP") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.mode === "SELF_TEST") {
      process.stdout.write(`${JSON.stringify(runSelfTest(), null, 2)}\n`);
      return 0;
    }
    const config = parseMonitorConfig(readPrivateJson(options.config, "monitor config"));
    const target = roleTarget(options.role, options.packageName);
    assertConfigMatchesTarget(config, target);
    const report = options.mode === "BASELINE"
      ? await captureBaseline(options, config, target)
      : await monitorCampaign(
          options,
          config,
          target,
          parsePrivateBaseline(readPrivateJson(options.baseline, "monitor baseline"))
        );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failureReport(error), null, 2)}\n`);
    return error instanceof B5AndroidContinuityError ? error.exitCode : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
