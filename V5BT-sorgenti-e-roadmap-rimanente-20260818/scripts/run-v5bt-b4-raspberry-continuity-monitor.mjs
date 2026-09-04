#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  assertPhysicalRaspberryContinuity,
  parsePhysicalRaspberrySnapshot,
} from "./run-v5bt-physical-raspberry-monitor.mjs";

export const B4_RASPBERRY_CONTINUITY_MONITOR_VERSION = "1.1.0";

const execFileAsync = promisify(execFile);
const FRAME = "--V5BT-B4-MONITOR-SPLIT--";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 5_000;
const MAX_CAPTURE_LATENESS_MS = 5_000;
const MIN_COVERAGE_MS = 90_000;
const MAX_COVERAGE_MS = 600_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const STAGING_RELEASE_PATTERN =
  /^\/opt\/cassav5bt-bluetooth-lab\/releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RUNNER_CAPTURE_ENV = "V5BT_B4_CAPTURE_RUN_ID";
const RUNNER_RELEASE_ENV = "V5BT_B4_RELEASE_PATH";
const SERVICES = Object.freeze(["cassav5bt.service", "bluetooth.service"]);
const SERVICE_FIELDS = Object.freeze([
  "ActiveState",
  "SubState",
  "MainPID",
  "NRestarts",
  "ActiveEnterTimestampMonotonic",
  "ExecMainStartTimestampMonotonic",
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
  "coverage",
  "checks",
  "cleanup",
  "privacy",
  "gate",
]);

const SERVICE_COMMANDS = SERVICES.map(
  (service) =>
    `/usr/bin/systemctl show ${service} --no-page ${SERVICE_FIELDS.map((field) => `--property=${field}`).join(" ")}`,
);
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function buildB4RaspberryRemoteCommand(options) {
  const release = shellQuote(options.runnerReleasePath);
  const captureRunId = shellQuote(options.captureRunId);
  const manifestSha256 = shellQuote(options.runnerReleaseManifestSha256);
  const privilegedRunnerSnapshot = [
    "set -eu",
    "export LC_ALL=C",
    `release=${release}`,
    `expected_capture=${captureRunId}`,
    `expected_manifest_sha=${manifestSha256}`,
    'entry="$release/raspberry/dist/index.js"',
    'manifest="$release/SHA256SUMS"',
    'release_real=$(/usr/bin/readlink -f -- "$release" 2>/dev/null || true)',
    'manifest_sha=$(/usr/bin/sha256sum -- "$manifest" 2>/dev/null | /usr/bin/awk \'NR == 1 { print $1 }\')',
    "release_verified=no",
    'if [ "$release_real" = "$release" ] && [ "$manifest_sha" = "$expected_manifest_sha" ] && [ -f "$entry" ] && (cd "$release" && /usr/bin/sha256sum --status -c SHA256SUMS); then release_verified=yes; fi',
    "runners=0",
    "matching=0",
    "runner_identity=none",
    "for proc in /proc/[0-9]*; do [ -r \"$proc/cmdline\" ] && [ -r \"$proc/environ\" ] && [ -r \"$proc/stat\" ] || continue; candidate=$(/usr/bin/tr '\\000' '\\n' < \"$proc/cmdline\" | /usr/bin/sed -n '2p'); case \"$candidate\" in /opt/cassav5bt-bluetooth-lab/releases/*/raspberry/dist/index.js) runners=$((runners + 1));; *) continue;; esac; [ \"$candidate\" = \"$entry\" ] || continue; capture_matches=$(/usr/bin/tr '\\000' '\\n' < \"$proc/environ\" | /usr/bin/grep -Fxc -- \"" + RUNNER_CAPTURE_ENV + "=$expected_capture\" || true); release_matches=$(/usr/bin/tr '\\000' '\\n' < \"$proc/environ\" | /usr/bin/grep -Fxc -- \"" + RUNNER_RELEASE_ENV + "=$release\" || true); [ \"$capture_matches\" = 1 ] && [ \"$release_matches\" = 1 ] || continue; matching=$((matching + 1)); pid=${proc##*/}; start_ticks=$(/usr/bin/awk '{print $22}' \"$proc/stat\"); runner_identity=\"$pid:$start_ticks\"; done",
    'if [ "$matching" -eq 0 ]; then runner_identity=none; elif [ "$matching" -gt 1 ]; then runner_identity=multiple; fi',
    "printf 'TemporaryRunners=%s\\nMatchingRunners=%s\\nRunnerIdentity=%s\\nReleaseVerified=%s\\nReleaseManifestSha256=%s\\n' \"$runners\" \"$matching\" \"$runner_identity\" \"$release_verified\" \"$manifest_sha\"",
  ].join("; ");
  return [
    "set -eu",
    "export LC_ALL=C",
    "/usr/bin/date +%s%N",
    `printf '\\n${FRAME}\\n'`,
    "/usr/bin/cat /proc/sys/kernel/random/boot_id",
    `printf '\\n${FRAME}\\n'`,
    SERVICE_COMMANDS[0],
    `printf '\\n${FRAME}\\n'`,
    SERVICE_COMMANDS[1],
    `printf '\\n${FRAME}\\n'`,
    "discovering=$(/usr/bin/bluetoothctl show | /usr/bin/sed -n 's/^[[:space:]]*Discovering: //p' | /usr/bin/head -n 1)",
    "advertisers=$(/usr/bin/busctl --system get-property org.bluez /org/bluez/hci0 org.bluez.LEAdvertisingManager1 ActiveInstances | /usr/bin/awk '{print $2}')",
    "printf 'Discovering=%s\\nActiveAdvertisers=%s\\n' \"$discovering\" \"$advertisers\"",
    `/usr/bin/sudo -n /bin/sh -c ${shellQuote(privilegedRunnerSnapshot)}`,
  ].join("; ");
}

export class B4RaspberryContinuityError extends Error {
  constructor(code, message, exitCode = 1, options = undefined) {
    super(message, options);
    this.name = "B4RaspberryContinuityError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1, options = undefined) {
  throw new B4RaspberryContinuityError(code, message, exitCode, options);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, fields, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be an object`);
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
  return typeof value === "string" &&
    SHA256_PATTERN.test(value) &&
    !/^0{64}$/u.test(value);
}

function maximumPollingGapMs(pollMs) {
  return pollMs + MAX_CAPTURE_LATENESS_MS;
}

function requireUuidV4(value, code = "RUN_BINDING_INVALID") {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    fail(code, "B4 run identifier is invalid");
  }
  return value;
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

function parseRadioSnapshot(raw) {
  const values = new Map();
  for (const line of String(raw ?? "").trim().split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) fail("SNAPSHOT_INVALID", "Radio snapshot is malformed");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      ![
        "Discovering",
        "ActiveAdvertisers",
        "TemporaryRunners",
        "MatchingRunners",
        "RunnerIdentity",
        "ReleaseVerified",
        "ReleaseManifestSha256",
      ].includes(key) ||
      values.has(key)
    ) {
      fail("SNAPSHOT_INVALID", "Radio snapshot fields are invalid");
    }
    values.set(key, value);
  }
  if (
    values.size !== 7 ||
    !["yes", "no"].includes(values.get("Discovering")) ||
    !["yes", "no"].includes(values.get("ReleaseVerified"))
  ) {
    fail("SNAPSHOT_INVALID", "Radio snapshot is incomplete");
  }
  const parseCount = (key) => {
    const value = values.get(key);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value ?? "")) {
      fail("SNAPSHOT_INVALID", `${key} is invalid`);
    }
    return integer(Number(value), 0, Number.MAX_SAFE_INTEGER, "SNAPSHOT_INVALID", key);
  };
  const temporaryRunners = parseCount("TemporaryRunners");
  const matchingRunners = parseCount("MatchingRunners");
  const rawIdentity = values.get("RunnerIdentity");
  const expectedIdentityMarker =
    matchingRunners === 0 ? "none" : matchingRunners > 1 ? "multiple" : null;
  if (
    (expectedIdentityMarker !== null && rawIdentity !== expectedIdentityMarker) ||
    (
      expectedIdentityMarker === null &&
      !/^[1-9][0-9]*:[1-9][0-9]*$/u.test(rawIdentity ?? "")
    ) ||
    matchingRunners > temporaryRunners
  ) {
    fail("SNAPSHOT_INVALID", "Runner identity snapshot is invalid");
  }
  const releaseManifestSha256 = values.get("ReleaseManifestSha256");
  if (!validSha256(releaseManifestSha256)) {
    fail("SNAPSHOT_INVALID", "Release manifest digest is invalid");
  }
  return Object.freeze({
    discovering: values.get("Discovering") === "yes",
    activeAdvertisers: parseCount("ActiveAdvertisers"),
    temporaryRunners,
    matchingRunners,
    runnerIdentity: expectedIdentityMarker === null ? rawIdentity : null,
    releaseVerified: values.get("ReleaseVerified") === "yes",
    releaseManifestSha256,
  });
}

export function parseB4RaspberrySnapshot(raw) {
  const parts = String(raw ?? "").split(`\n${FRAME}\n`);
  if (parts.length !== 5) fail("SNAPSHOT_INVALID", "B4 snapshot framing is invalid");
  let continuity;
  try {
    continuity = parsePhysicalRaspberrySnapshot(
      parts.slice(0, 4).join("\n--V5BT-MONITOR-SPLIT--\n"),
    );
  } catch (error) {
    fail(error?.code ?? "SNAPSHOT_INVALID", "B4 continuity snapshot is invalid", 1, {
      cause: error,
    });
  }
  return Object.freeze({ ...continuity, radio: parseRadioSnapshot(parts[4]) });
}

export function assertB4RaspberryContinuity(baseline, previous, current) {
  try {
    assertPhysicalRaspberryContinuity(baseline, previous, current);
  } catch (error) {
    fail(error?.code ?? "CONTINUITY_INVALID", "B4 Raspberry continuity failed", 1, {
      cause: error,
    });
  }
  return true;
}

export function assertB4RaspberryCleanup(snapshot, runnerObserved) {
  if (runnerObserved !== true) {
    fail("RUNNER_NOT_OBSERVED", "The B4 runner was not observed by the monitor");
  }
  if (
    snapshot.radio.discovering !== false ||
    snapshot.radio.activeAdvertisers !== 0 ||
    snapshot.radio.temporaryRunners !== 0 ||
    snapshot.radio.matchingRunners !== 0 ||
    snapshot.radio.runnerIdentity !== null
  ) {
    fail("CLEANUP_INCOMPLETE", "B4 Raspberry radio cleanup is incomplete");
  }
  return true;
}

export function assertB4RaspberryCleanBaseline(snapshot) {
  if (
    snapshot.radio.discovering !== false ||
    snapshot.radio.activeAdvertisers !== 0 ||
    snapshot.radio.temporaryRunners !== 0 ||
    snapshot.radio.matchingRunners !== 0 ||
    snapshot.radio.runnerIdentity !== null
  ) {
    fail(
      "BASELINE_NOT_CLEAN",
      "The B4 monitor must start before the runner on an idle radio",
    );
  }
  return true;
}

export function advanceB4RaspberryRunnerLifecycle(
  lifecycle,
  snapshot,
  expectedReleaseManifestSha256,
) {
  const radio = snapshot.radio;
  if (
    radio.releaseVerified !== true ||
    radio.releaseManifestSha256 !== expectedReleaseManifestSha256
  ) {
    fail(
      "RUNNER_RELEASE_INVALID",
      "The B4 runner release no longer matches the certified staging tree",
    );
  }
  if (radio.activeAdvertisers !== 0) {
    fail(
      "RASPBERRY_ADVERTISING_ACTIVE",
      "The scanner-only B4 runner must not advertise from Raspberry",
    );
  }
  const idle =
    radio.temporaryRunners === 0 &&
    radio.matchingRunners === 0 &&
    radio.runnerIdentity === null;
  const exactBoundRunner =
    radio.temporaryRunners === 1 &&
    radio.matchingRunners === 1 &&
    typeof radio.runnerIdentity === "string";
  const requireSingleBoundRunner = (bindingMessage) => {
    if (radio.temporaryRunners !== 1) {
      fail("RUNNER_COUNT_INVALID", "Exactly one B4 runner is required");
    }
    if (!exactBoundRunner) {
      fail("RUNNER_BINDING_MISMATCH", bindingMessage);
    }
  };
  const requireSameRunner = () => {
    if (radio.runnerIdentity !== lifecycle.runnerIdentity) {
      fail(
        "RUNNER_IDENTITY_CHANGED",
        "The B4 runner process changed during the measurement window",
      );
    }
  };
  const cleanedLifecycle = () => Object.freeze({
    phase: "CLEANED",
    runnerIdentity: lifecycle.runnerIdentity,
    activeSamples: lifecycle.activeSamples,
  });

  if (lifecycle.phase === "WAITING") {
    if (idle) {
      if (radio.discovering) {
        fail(
          "UNBOUND_DISCOVERY_ACTIVE",
          "BlueZ discovery started without the bound B4 runner",
        );
      }
      return lifecycle;
    }
    requireSingleBoundRunner(
      "The B4 runner is not bound to this capture and staging release",
    );
    if (!radio.discovering) {
      return Object.freeze({
        phase: "STARTING",
        runnerIdentity: radio.runnerIdentity,
        activeSamples: 0,
      });
    }
    return Object.freeze({
      phase: "RUNNING",
      runnerIdentity: radio.runnerIdentity,
      activeSamples: 1,
    });
  }

  if (lifecycle.phase === "STARTING") {
    requireSingleBoundRunner(
      "The starting B4 runner lost its capture or release binding",
    );
    requireSameRunner();
    if (!radio.discovering) {
      fail(
        "RUNNER_START_TIMEOUT",
        "The B4 runner did not activate discovery within one polling interval",
      );
    }
    return Object.freeze({
      phase: "RUNNING",
      runnerIdentity: lifecycle.runnerIdentity,
      activeSamples: 1,
    });
  }

  if (lifecycle.phase === "RUNNING") {
    if (idle) {
      if (radio.discovering) {
        fail(
          "CLEANUP_INCOMPLETE",
          "BlueZ discovery remained active after the B4 runner exited",
        );
      }
      return cleanedLifecycle();
    }
    requireSingleBoundRunner(
      "The active B4 runner lost its capture or release binding",
    );
    requireSameRunner();
    if (!radio.discovering) {
      return Object.freeze({
        phase: "STOPPING",
        runnerIdentity: lifecycle.runnerIdentity,
        activeSamples: lifecycle.activeSamples,
      });
    }
    return Object.freeze({
      ...lifecycle,
      activeSamples: lifecycle.activeSamples + 1,
    });
  }

  if (lifecycle.phase === "STOPPING") {
    if (idle) {
      if (radio.discovering) {
        fail(
          "CLEANUP_INCOMPLETE",
          "BlueZ discovery remained active after the B4 runner exited",
        );
      }
      return cleanedLifecycle();
    }
    requireSingleBoundRunner(
      "The stopping B4 runner lost its capture or release binding",
    );
    requireSameRunner();
    if (radio.discovering) {
      fail(
        "RUNNER_RESTARTED_AFTER_STOP",
        "The scanner returned to RUNNING after shutdown began",
      );
    }
    fail(
      "RUNNER_STOP_TIMEOUT",
      "The B4 runner did not exit within one polling interval",
    );
  }

  if (lifecycle.phase !== "CLEANED") {
    fail("RUNNER_LIFECYCLE_INVALID", "B4 runner lifecycle state is invalid");
  }
  if (!idle || radio.discovering) {
    fail(
      "RUNNER_REAPPEARED",
      "The B4 runner or discovery reappeared after cleanup",
    );
  }
  return lifecycle;
}

function privateSnapshot(snapshot, sampledAt) {
  return {
    sampledAt,
    wallClockNs: snapshot.wallClockNs.toString(),
    bootId: snapshot.bootId,
    services: snapshot.services,
    radio: snapshot.radio,
  };
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
      if (error instanceof B4RaspberryContinuityError) throw error;
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
    fail("OUTPUT_UNSAFE", "Private output directory must be owned with mode 0700");
  }
  return parent;
}

function requirePublicParent(destination) {
  const parent = path.dirname(path.resolve(destination));
  assertNoSymlinkComponents(parent);
  let status;
  try {
    status = fs.lstatSync(parent);
  } catch (error) {
    fail("OUTPUT_UNSAFE", "Attestation directory is unavailable", 1, { cause: error });
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    fail("OUTPUT_UNSAFE", "Attestation directory is unsafe");
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
    fail("OUTPUT_TAMPERED", `${label} must remain a private 0600 regular file`);
  }
}

function openPrivateJournal(destination) {
  const resolved = path.resolve(destination);
  requirePrivateParent(resolved);
  assertNoSymlinkComponents(resolved);
  if (fs.existsSync(resolved)) fail("OUTPUT_EXISTS", "Private output already exists");
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
    requirePrivateFile(status, "Private journal");
    return { descriptor, dev: status.dev, ino: status.ino, location: resolved, bytes: 0 };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof B4RaspberryContinuityError) throw error;
    fail("OUTPUT_UNSAFE", "Private journal cannot be created", 1, { cause: error });
  }
}

function appendPrivateJournal(journal, value, digest) {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const before = fs.fstatSync(journal.descriptor);
  requirePrivateFile(before, "Private journal");
  if (before.dev !== journal.dev || before.ino !== journal.ino) {
    fail("OUTPUT_TAMPERED", "Private journal identity changed");
  }
  journal.bytes += encoded.byteLength;
  if (journal.bytes > MAX_OUTPUT_BYTES) fail("OUTPUT_TOO_LARGE", "Private journal is too large");
  fs.writeFileSync(journal.descriptor, encoded);
  fs.fsyncSync(journal.descriptor);
  const after = fs.fstatSync(journal.descriptor);
  requirePrivateFile(after, "Private journal");
  if (after.size !== journal.bytes || after.dev !== journal.dev || after.ino !== journal.ino) {
    fail("OUTPUT_TAMPERED", "Private journal changed unexpectedly");
  }
  digest.update(encoded);
}

function closeAndVerifyPrivateJournal(journal, expectedSha256) {
  requirePrivateFile(fs.fstatSync(journal.descriptor), "Private journal");
  fs.closeSync(journal.descriptor);
  journal.descriptor = undefined;
  assertNoSymlinkComponents(journal.location);
  const status = fs.lstatSync(journal.location);
  requirePrivateFile(status, "Private journal");
  if (status.dev !== journal.dev || status.ino !== journal.ino || status.size !== journal.bytes) {
    fail("OUTPUT_TAMPERED", "Private journal was replaced");
  }
  const bytes = fs.readFileSync(journal.location);
  if (sha256(bytes) !== expectedSha256) {
    fail("OUTPUT_TAMPERED", "Private journal digest mismatch");
  }
}

function publishAttestation(destination, value) {
  const resolved = path.resolve(destination);
  const parent = requirePublicParent(resolved);
  assertNoSymlinkComponents(resolved);
  if (fs.existsSync(resolved)) fail("OUTPUT_EXISTS", "Attestation already exists");
  const encoded = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (
    /"(?:bootId|mainPid|hostname|collectionRunId|captureRunId|host|user|path)"\s*:/iu.test(
      encoded.toString("utf8"),
    ) ||
    /(?:\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b|\/[A-Za-z0-9_.-]+\/)/u.test(
      encoded.toString("utf8"),
    )
  ) {
    fail("ATTESTATION_PRIVACY_INVALID", "Attestation contains private identifiers");
  }
  const temporary = path.join(parent, `.b4-rpi-${crypto.randomUUID()}.tmp`);
  let descriptor;
  let destinationCreated = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0),
      0o600,
    );
    fs.writeFileSync(descriptor, encoded);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, resolved);
    destinationCreated = true;
    fs.unlinkSync(temporary);
    const directory = fs.openSync(parent, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    const status = fs.lstatSync(resolved);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      (status.mode & 0o777) !== 0o600 ||
      (currentUid() !== null && status.uid !== currentUid())
    ) {
      fail("OUTPUT_UNSAFE", "Published attestation is unsafe");
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    if (destinationCreated) {
      try { fs.unlinkSync(resolved); } catch {}
    }
    if (error instanceof B4RaspberryContinuityError) throw error;
    fail("OUTPUT_UNSAFE", "Attestation cannot be published", 1, { cause: error });
  }
}

function stopFileSignaled(location) {
  if (location === null) return false;
  assertNoSymlinkComponents(location, "STOP_FILE_INVALID");
  if (!fs.existsSync(location)) return false;
  const status = fs.lstatSync(location);
  const uid = currentUid();
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (status.mode & 0o777) !== 0o600 ||
    (uid !== null && status.uid !== uid)
  ) {
    fail("STOP_FILE_INVALID", "Stop file must be an owned 0600 regular file");
  }
  return true;
}

export function buildB4RaspberryContinuityAttestation({
  collectionRunId,
  captureRunId,
  certificationMatrixSha256,
  privateJournalSha256,
  monitoredFrom,
  runnerObservedAt,
  cleanupObservedAt,
  monitoredUntil,
  durationMs,
  pollMs,
  sampleCount,
  maximumObservedGapMs,
  runnerActiveSamples = 1,
  generatedAt = new Date().toISOString(),
}) {
  const commitments = buildB4RunCommitments({ collectionRunId, captureRunId });
  if (!validSha256(certificationMatrixSha256) || !validSha256(privateJournalSha256)) {
    fail("ATTESTATION_INVALID", "Attestation digest binding is invalid");
  }
  const fromMs = timestamp(monitoredFrom, "ATTESTATION_INVALID", "monitoredFrom");
  const runnerMs = timestamp(runnerObservedAt, "ATTESTATION_INVALID", "runnerObservedAt");
  const cleanupMs = timestamp(cleanupObservedAt, "ATTESTATION_INVALID", "cleanupObservedAt");
  const untilMs = timestamp(monitoredUntil, "ATTESTATION_INVALID", "monitoredUntil");
  const generatedAtMs = timestamp(generatedAt, "ATTESTATION_INVALID", "generatedAt");
  integer(durationMs, MIN_COVERAGE_MS, MAX_COVERAGE_MS, "ATTESTATION_INVALID", "durationMs");
  integer(pollMs, MIN_POLL_MS, MAX_POLL_MS, "ATTESTATION_INVALID", "pollMs");
  integer(sampleCount, 2, Number.MAX_SAFE_INTEGER, "ATTESTATION_INVALID", "sampleCount");
  integer(
    runnerActiveSamples,
    1,
    sampleCount,
    "ATTESTATION_INVALID",
    "runnerActiveSamples",
  );
  integer(maximumObservedGapMs, 0, maximumPollingGapMs(pollMs), "ATTESTATION_INVALID", "maximumObservedGapMs");
  if (
    durationMs !== untilMs - fromMs ||
    runnerMs < fromMs ||
    cleanupMs < runnerMs ||
    untilMs < cleanupMs ||
    generatedAtMs < untilMs ||
    (sampleCount - 1) * maximumPollingGapMs(pollMs) < durationMs
  ) {
    fail("ATTESTATION_INVALID", "Attestation coverage chronology is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B4_RASPBERRY_CONTINUITY_MONITOR_VERSION,
    product: "V5BT",
    phase: "B4",
    mode: "REDACTED_B4_RASPBERRY_CONTINUITY_ATTESTATION",
    evidenceClass: "PHYSICAL_GATE_SUPPORT",
    verdict: "PASS",
    generatedAt,
    binding: Object.freeze({
      ...commitments,
      certificationMatrixSha256,
      privateJournalSha256,
    }),
    coverage: Object.freeze({
      monitoredFrom,
      runnerObservedAt,
      cleanupObservedAt,
      monitoredUntil,
      durationMs,
      pollMs,
      sampleCount,
      maximumObservedGapMs,
      runnerActiveSamples,
    }),
    checks: Object.freeze({
      fixedBoot: "PASS",
      monotonicWallClock: "PASS",
      mainServiceContinuity: "PASS",
      bluetoothServiceContinuity: "PASS",
      noServiceRestarts: "PASS",
      completePollingCoverage: "PASS",
      runnerLifecycleObserved: "PASS",
      captureBoundRunner: "PASS",
      fixedStagingRelease: "PASS",
      continuousRunnerIdentity: "PASS",
      scannerActiveDuringRunning: "PASS",
      raspberryAdvertisingInactive: "PASS",
      cleanupVerified: "PASS",
    }),
    cleanup: Object.freeze({
      discovering: false,
      activeAdvertisers: 0,
      temporaryRunners: 0,
      finalized: true,
    }),
    privacy: Object.freeze({
      hostnameIncluded: false,
      networkIdentifiersIncluded: false,
      bootIdentifierIncluded: false,
      processIdentifiersIncluded: false,
      localPathsIncluded: false,
      runnerIdentityIncluded: false,
      releasePathIncluded: false,
      runIdentifiersIncluded: false,
    }),
    gate: Object.freeze({ b4: "PENDING", authoritativeGateExecuted: false }),
  });
}

export function parseB4RaspberryContinuityAttestation(value, expected = {}) {
  let document;
  try {
    document = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    fail("ATTESTATION_INVALID", "Attestation is not valid JSON");
  }
  exactFields(document, ATTESTATION_FIELDS, "ATTESTATION_INVALID", "Attestation");
  if (
    document.schemaVersion !== 1 ||
    document.harnessVersion !== B4_RASPBERRY_CONTINUITY_MONITOR_VERSION ||
    document.product !== "V5BT" ||
    document.phase !== "B4" ||
    document.mode !== "REDACTED_B4_RASPBERRY_CONTINUITY_ATTESTATION" ||
    document.evidenceClass !== "PHYSICAL_GATE_SUPPORT" ||
    document.verdict !== "PASS"
  ) {
    fail("ATTESTATION_INVALID", "Attestation header is invalid");
  }
  exactFields(document.binding, [
    "collectionRunCommitmentSha256",
    "captureRunCommitmentSha256",
    "certificationMatrixSha256",
    "privateJournalSha256",
  ], "ATTESTATION_INVALID", "Attestation binding");
  for (const digest of Object.values(document.binding)) {
    if (!validSha256(digest)) fail("ATTESTATION_INVALID", "Attestation binding digest is invalid");
  }
  exactFields(document.coverage, [
    "monitoredFrom", "runnerObservedAt", "cleanupObservedAt", "monitoredUntil",
    "durationMs", "pollMs", "sampleCount", "maximumObservedGapMs",
    "runnerActiveSamples",
  ], "ATTESTATION_INVALID", "Attestation coverage");
  const fromMs = timestamp(document.coverage.monitoredFrom, "ATTESTATION_INVALID", "monitoredFrom");
  const runnerMs = timestamp(document.coverage.runnerObservedAt, "ATTESTATION_INVALID", "runnerObservedAt");
  const cleanupMs = timestamp(document.coverage.cleanupObservedAt, "ATTESTATION_INVALID", "cleanupObservedAt");
  const untilMs = timestamp(document.coverage.monitoredUntil, "ATTESTATION_INVALID", "monitoredUntil");
  const generatedAtMs = timestamp(document.generatedAt, "ATTESTATION_INVALID", "generatedAt");
  integer(document.coverage.durationMs, MIN_COVERAGE_MS, MAX_COVERAGE_MS, "ATTESTATION_INVALID", "durationMs");
  integer(document.coverage.pollMs, MIN_POLL_MS, MAX_POLL_MS, "ATTESTATION_INVALID", "pollMs");
  integer(document.coverage.sampleCount, 2, Number.MAX_SAFE_INTEGER, "ATTESTATION_INVALID", "sampleCount");
  integer(document.coverage.runnerActiveSamples, 1, document.coverage.sampleCount, "ATTESTATION_INVALID", "runnerActiveSamples");
  integer(document.coverage.maximumObservedGapMs, 0, maximumPollingGapMs(document.coverage.pollMs), "ATTESTATION_INVALID", "maximumObservedGapMs");
  if (
    document.coverage.durationMs !== untilMs - fromMs ||
    runnerMs < fromMs || cleanupMs < runnerMs || untilMs < cleanupMs ||
    generatedAtMs < untilMs ||
    (document.coverage.sampleCount - 1) * maximumPollingGapMs(document.coverage.pollMs) <
      document.coverage.durationMs
  ) fail("ATTESTATION_INVALID", "Attestation chronology is invalid");
  const passChecks = [
    "fixedBoot", "monotonicWallClock", "mainServiceContinuity",
    "bluetoothServiceContinuity", "noServiceRestarts", "completePollingCoverage",
    "runnerLifecycleObserved", "captureBoundRunner", "fixedStagingRelease",
    "continuousRunnerIdentity", "scannerActiveDuringRunning",
    "raspberryAdvertisingInactive", "cleanupVerified",
  ];
  exactFields(document.checks, passChecks, "ATTESTATION_INVALID", "Attestation checks");
  if (passChecks.some((field) => document.checks[field] !== "PASS")) fail("ATTESTATION_INVALID", "Attestation checks are incomplete");
  exactFields(document.cleanup, ["discovering", "activeAdvertisers", "temporaryRunners", "finalized"], "ATTESTATION_INVALID", "Attestation cleanup");
  if (document.cleanup.discovering !== false || document.cleanup.activeAdvertisers !== 0 || document.cleanup.temporaryRunners !== 0 || document.cleanup.finalized !== true) fail("ATTESTATION_INVALID", "Attestation cleanup is incomplete");
  const privacyFields = ["hostnameIncluded", "networkIdentifiersIncluded", "bootIdentifierIncluded", "processIdentifiersIncluded", "localPathsIncluded", "runnerIdentityIncluded", "releasePathIncluded", "runIdentifiersIncluded"];
  exactFields(document.privacy, privacyFields, "ATTESTATION_INVALID", "Attestation privacy");
  if (privacyFields.some((field) => document.privacy[field] !== false)) fail("ATTESTATION_INVALID", "Attestation privacy is invalid");
  exactFields(document.gate, ["b4", "authoritativeGateExecuted"], "ATTESTATION_INVALID", "Attestation gate");
  if (document.gate.b4 !== "PENDING" || document.gate.authoritativeGateExecuted !== false) fail("ATTESTATION_INVALID", "Attestation gate boundary changed");
  if (expected.collectionRunId !== undefined || expected.captureRunId !== undefined) {
    if (expected.collectionRunId === undefined || expected.captureRunId === undefined) fail("ATTESTATION_EXPECTATION_INVALID", "Both expected run identifiers are required");
    const commitments = buildB4RunCommitments(expected);
    if (commitments.collectionRunCommitmentSha256 !== document.binding.collectionRunCommitmentSha256 || commitments.captureRunCommitmentSha256 !== document.binding.captureRunCommitmentSha256) fail("ATTESTATION_BINDING_MISMATCH", "Attestation run binding does not match");
  }
  if (expected.certificationMatrixSha256 !== undefined && expected.certificationMatrixSha256 !== document.binding.certificationMatrixSha256) fail("ATTESTATION_BINDING_MISMATCH", "Attestation matrix binding does not match");
  if (expected.notBeforeMs !== undefined) {
    integer(expected.notBeforeMs, 0, Number.MAX_SAFE_INTEGER, "ATTESTATION_EXPECTATION_INVALID", "notBeforeMs");
    if (fromMs < expected.notBeforeMs) fail("ATTESTATION_WINDOW_MISMATCH", "Attestation starts outside the expected window");
  }
  if (expected.notAfterMs !== undefined) {
    integer(expected.notAfterMs, 0, Number.MAX_SAFE_INTEGER, "ATTESTATION_EXPECTATION_INVALID", "notAfterMs");
    if (untilMs > expected.notAfterMs) fail("ATTESTATION_WINDOW_MISMATCH", "Attestation ends outside the expected window");
  }
  return Object.freeze(structuredClone(document));
}

export function parseB4RaspberryMonitorArguments(argv) {
  const options = {
    ssh: "ssh", host: null, user: "admin", pollMs: 2_000,
    collectionRunId: null, captureRunId: null, certificationMatrixSha256: null,
    runnerReleasePath: null, runnerReleaseManifestSha256: null,
    privateOutput: null, attestation: null, durationMs: null, stopFile: null,
    maximumMs: null, help: false,
  };
  const names = new Set(["--ssh", "--host", "--user", "--poll-ms", "--collection-run-id", "--capture-run-id", "--certification-matrix-sha256", "--runner-release-path", "--runner-release-manifest-sha256", "--private-output", "--attestation", "--duration-seconds", "--stop-file", "--maximum-seconds"]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") { options.help = true; continue; }
    if (!names.has(argument) || seen.has(argument)) fail("ARGUMENT_INVALID", `Unsupported or duplicate option: ${argument}`, 2);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail("ARGUMENT_INVALID", `${argument} requires a value`, 2);
    seen.add(argument);
    if (argument === "--ssh") options.ssh = value;
    else if (argument === "--host") options.host = value;
    else if (argument === "--user") options.user = value;
    else if (argument === "--poll-ms") options.pollMs = Number(value);
    else if (argument === "--collection-run-id") options.collectionRunId = value;
    else if (argument === "--capture-run-id") options.captureRunId = value;
    else if (argument === "--certification-matrix-sha256") options.certificationMatrixSha256 = value;
    else if (argument === "--runner-release-path") options.runnerReleasePath = value;
    else if (argument === "--runner-release-manifest-sha256") options.runnerReleaseManifestSha256 = value;
    else if (argument === "--private-output") options.privateOutput = path.resolve(value);
    else if (argument === "--attestation") options.attestation = path.resolve(value);
    else if (argument === "--duration-seconds") {
      if (!/^[1-9][0-9]*$/u.test(value)) fail("ARGUMENT_INVALID", "Duration seconds must be an integer", 2);
      options.durationMs = Number(value) * 1_000;
    }
    else if (argument === "--stop-file") options.stopFile = path.resolve(value);
    else if (argument === "--maximum-seconds") {
      if (!/^[1-9][0-9]*$/u.test(value)) fail("ARGUMENT_INVALID", "Maximum seconds must be an integer", 2);
      options.maximumMs = Number(value) * 1_000;
    }
  }
  if (options.help) return options;
  requireUuidV4(options.collectionRunId, "ARGUMENT_INVALID");
  requireUuidV4(options.captureRunId, "ARGUMENT_INVALID");
  if (options.collectionRunId === options.captureRunId) fail("ARGUMENT_INVALID", "Run identifiers must be distinct", 2);
  if (typeof options.host !== "string" || !/^[A-Za-z0-9.-]{1,253}$/u.test(options.host) || typeof options.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(options.user) || !validSha256(options.certificationMatrixSha256) || typeof options.runnerReleasePath !== "string" || !STAGING_RELEASE_PATTERN.test(options.runnerReleasePath) || !validSha256(options.runnerReleaseManifestSha256) || !Number.isSafeInteger(options.pollMs) || options.pollMs < MIN_POLL_MS || options.pollMs > MAX_POLL_MS || options.privateOutput === null || options.attestation === null || options.privateOutput === options.attestation) fail("ARGUMENT_INVALID", "Monitor arguments are invalid or incomplete", 2);
  const durationMode = options.durationMs !== null && options.stopFile === null && options.maximumMs === null;
  const stopMode = options.durationMs === null && options.stopFile !== null && options.maximumMs !== null;
  if (!durationMode && !stopMode) fail("ARGUMENT_INVALID", "Choose a duration or a stop file with maximum window", 2);
  const windowMs = durationMode ? options.durationMs : options.maximumMs;
  if (!Number.isSafeInteger(windowMs) || windowMs < MIN_COVERAGE_MS || windowMs > MAX_COVERAGE_MS) fail("ARGUMENT_INVALID", "B4 monitor window must be between 90 and 600 seconds", 2);
  if (options.stopFile !== null && [options.privateOutput, options.attestation].includes(options.stopFile)) fail("ARGUMENT_INVALID", "Monitor paths must be distinct", 2);
  return options;
}

async function captureRemote(options, runtime = {}) {
  const executor = runtime.execFile ?? execFileAsync;
  try {
    const result = await executor(options.ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", `${options.user}@${options.host}`, buildB4RaspberryRemoteCommand(options)], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
    return parseB4RaspberrySnapshot(typeof result === "string" ? result : result.stdout);
  } catch (error) {
    if (error instanceof B4RaspberryContinuityError) throw error;
    fail("SSH_CAPTURE_FAILED", "B4 Raspberry continuity sample failed", 1, { cause: error });
  }
}

export async function runB4RaspberryContinuityMonitor(options, runtime = {}) {
  if (fs.existsSync(options.attestation)) fail("OUTPUT_EXISTS", "Attestation already exists");
  if (options.stopFile !== null) {
    assertNoSymlinkComponents(options.stopFile, "STOP_FILE_INVALID");
    if (fs.existsSync(options.stopFile)) fail("STOP_FILE_INVALID", "Stop file must not exist at startup");
  }
  const journal = openPrivateJournal(options.privateOutput);
  const digest = crypto.createHash("sha256");
  const monotonicNow = runtime.monotonicNow ?? (() => performance.now());
  const nowDate = runtime.nowDate ?? (() => new Date());
  const sleeper = runtime.sleep ?? sleep;
  const capture = runtime.capture ?? ((captureOptions) => captureRemote(captureOptions, runtime));
  const startedMonotonic = monotonicNow();
  const monitoredFrom = nowDate().toISOString();
  let previousSampleMonotonic = null;
  let maximumObservedGapMs = 0;
  let sampleCount = 0;
  let baseline = null;
  let previous = null;
  let runnerLifecycle = Object.freeze({
    phase: "WAITING",
    runnerIdentity: null,
    activeSamples: 0,
  });
  let runnerObservedAt = null;
  let cleanupObservedAt = null;
  let failure = null;
  appendPrivateJournal(journal, { schemaVersion: 1, harnessVersion: B4_RASPBERRY_CONTINUITY_MONITOR_VERSION, product: "V5BT", phase: "B4", mode: "PRIVATE_B4_RASPBERRY_CONTINUITY_JOURNAL", collectionRunId: options.collectionRunId, captureRunId: options.captureRunId, certificationMatrixSha256: options.certificationMatrixSha256, runnerReleasePath: options.runnerReleasePath, runnerReleaseManifestSha256: options.runnerReleaseManifestSha256, monitoredFrom, pollMs: options.pollMs, termination: options.stopFile === null ? { mode: "DURATION", durationMs: options.durationMs } : { mode: "STOP_FILE", maximumMs: options.maximumMs } }, digest);
  try {
    while (true) {
      const sampleStarted = monotonicNow();
      if (previousSampleMonotonic !== null) {
        const gap = Math.round(sampleStarted - previousSampleMonotonic);
        if (gap < 0) fail("LOCAL_CLOCK_REGRESSION", "Local monotonic clock regressed");
        maximumObservedGapMs = Math.max(maximumObservedGapMs, gap);
        if (gap > maximumPollingGapMs(options.pollMs)) fail("POLLING_GAP", "B4 polling gap exceeded the limit");
      }
      const snapshot = await capture(options);
      const sampledAt = nowDate().toISOString();
      if (baseline === null) {
        assertB4RaspberryCleanBaseline(snapshot);
        baseline = snapshot;
      }
      else assertB4RaspberryContinuity(baseline, previous, snapshot);
      const previousRunnerPhase = runnerLifecycle.phase;
      runnerLifecycle = advanceB4RaspberryRunnerLifecycle(
        runnerLifecycle,
        snapshot,
        options.runnerReleaseManifestSha256,
      );
      previous = snapshot;
      previousSampleMonotonic = sampleStarted;
      sampleCount += 1;
      if (
        ["WAITING", "STARTING"].includes(previousRunnerPhase) &&
        runnerLifecycle.phase === "RUNNING"
      ) {
        runnerObservedAt = sampledAt;
      }
      if (
        ["RUNNING", "STOPPING"].includes(previousRunnerPhase) &&
        runnerLifecycle.phase === "CLEANED"
      ) {
        cleanupObservedAt = sampledAt;
      }
      appendPrivateJournal(journal, { type: "sample", sequence: sampleCount, ...privateSnapshot(snapshot, sampledAt) }, digest);
      runtime.afterSample?.({ sampleCount, journal: journal.location, snapshot });
      const elapsedMs = Math.round(monotonicNow() - startedMonotonic);
      if (elapsedMs < 0) fail("LOCAL_CLOCK_REGRESSION", "Local monotonic clock regressed");
      const fixedComplete = options.stopFile === null && elapsedMs >= options.durationMs;
      const stopSignaled = options.stopFile !== null && (runtime.stopSignaled?.() ?? stopFileSignaled(options.stopFile));
      if (stopSignaled && elapsedMs < MIN_COVERAGE_MS) fail("COVERAGE_INCOMPLETE", "B4 stop was requested before 90 seconds");
      if (options.stopFile !== null && !stopSignaled && elapsedMs >= options.maximumMs) fail("STOP_TIMEOUT", "B4 stop file was not received within the maximum window");
      if (fixedComplete || stopSignaled) {
        assertB4RaspberryCleanup(snapshot, runnerObservedAt !== null);
        if (runnerLifecycle.phase !== "CLEANED" || cleanupObservedAt === null) {
          fail(
            "RUNNER_LIFECYCLE_INCOMPLETE",
            "The B4 runner did not complete idle to running to idle",
          );
        }
        break;
      }
      const captureElapsed = Math.max(0, monotonicNow() - sampleStarted);
      await sleeper(Math.max(0, options.pollMs - captureElapsed));
    }
  } catch (error) {
    failure = error;
  }
  const monitoredUntil = nowDate().toISOString();
  const durationMs = Date.parse(monitoredUntil) - Date.parse(monitoredFrom);
  if (failure === null && (durationMs < MIN_COVERAGE_MS || durationMs > MAX_COVERAGE_MS)) failure = new B4RaspberryContinuityError("COVERAGE_INCOMPLETE", "B4 monitor coverage is outside 90 to 600 seconds");
  if (failure === null) {
    try {
      appendPrivateJournal(journal, { type: "final", monitoredUntil, durationMs, sampleCount, maximumObservedGapMs, runnerLifecycle: { phase: runnerLifecycle.phase, activeSamples: runnerLifecycle.activeSamples }, cleanup: { discovering: false, activeAdvertisers: 0, temporaryRunners: 0 }, verdict: "PASS" }, digest);
    } catch (error) {
      if (journal.descriptor !== undefined) {
        fs.closeSync(journal.descriptor);
        journal.descriptor = undefined;
      }
      throw error;
    }
    const privateJournalSha256 = digest.digest("hex");
    closeAndVerifyPrivateJournal(journal, privateJournalSha256);
    const attestation = buildB4RaspberryContinuityAttestation({ collectionRunId: options.collectionRunId, captureRunId: options.captureRunId, certificationMatrixSha256: options.certificationMatrixSha256, privateJournalSha256, monitoredFrom, runnerObservedAt, cleanupObservedAt, monitoredUntil, durationMs, pollMs: options.pollMs, sampleCount, maximumObservedGapMs, runnerActiveSamples: runnerLifecycle.activeSamples });
    parseB4RaspberryContinuityAttestation(attestation, { collectionRunId: options.collectionRunId, captureRunId: options.captureRunId, certificationMatrixSha256: options.certificationMatrixSha256 });
    publishAttestation(options.attestation, attestation);
    return attestation;
  }
  try {
    appendPrivateJournal(journal, { type: "final", monitoredUntil, durationMs, sampleCount, maximumObservedGapMs, verdict: "FAIL", code: failure instanceof B4RaspberryContinuityError ? failure.code : "UNEXPECTED_FAILURE" }, digest);
  } finally {
    if (journal.descriptor !== undefined) fs.closeSync(journal.descriptor);
  }
  throw failure;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/run-v5bt-b4-raspberry-continuity-monitor.mjs --host HOST \\",
    "    --collection-run-id UUIDv4 --capture-run-id UUIDv4 \\",
    "    --certification-matrix-sha256 SHA256 --private-output PRIVATE.jsonl \\",
    "    --runner-release-path /opt/cassav5bt-bluetooth-lab/releases/RELEASE \\",
    "    --runner-release-manifest-sha256 SHA256 \\",
    "    --attestation REDACTED.json [--poll-ms 2000] \\",
    "    (--duration-seconds 90..600 | --stop-file STOP --maximum-seconds 90..600)",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  try {
    const options = parseB4RaspberryMonitorArguments(argv);
    if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
    const attestation = await runB4RaspberryContinuityMonitor(options, runtime);
    process.stdout.write(`${JSON.stringify(attestation)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof B4RaspberryContinuityError ? error.code : "UNEXPECTED_FAILURE";
    process.stderr.write(`${code}: B4 Raspberry continuity monitor failed\n`);
    return error instanceof B4RaspberryContinuityError ? error.exitCode : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
