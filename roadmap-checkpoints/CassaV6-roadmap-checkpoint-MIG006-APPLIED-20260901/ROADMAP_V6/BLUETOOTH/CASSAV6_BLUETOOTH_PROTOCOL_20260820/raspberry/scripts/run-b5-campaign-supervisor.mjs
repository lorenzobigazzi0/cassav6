#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const B5_CAMPAIGN_SUPERVISOR_VERSION = "1.0.0";

const B5_REQUIRED_SESSION_REPORTS = 100;
const LEDGER_MODE = "PHYSICAL_B5_CAMPAIGN_SUPERVISION";
const TRANSACTION_MODE = "PHYSICAL_B5_SUPERVISOR_TRANSACTION";
const ZERO_SHA256 = "0".repeat(64);
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_COLLECTOR_BYTES = 512 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const COLLECTOR_TIMEOUT_MS = 180_000;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,80}$/u;
const NO_FOLLOW_FLAG =
  process.platform === "linux" ? fs.constants.O_NOFOLLOW ?? 0 : 0;
const NONBLOCK_FLAG =
  process.platform === "linux" ? fs.constants.O_NONBLOCK ?? 0 : 0;
const COLLECTOR_MODULE_URL = new URL(
  "./collect-b5-direct-control-session.mjs",
  import.meta.url
);
const COLLECTOR_SCRIPT = fileURLToPath(COLLECTOR_MODULE_URL);
const execFileAsync = promisify(execFile);

const LEDGER_FIELDS = Object.freeze([
  "schemaVersion",
  "harnessVersion",
  "product",
  "phase",
  "mode",
  "campaignRunId",
  "createdAt",
  "updatedAt",
  "requiredSessions",
  "status",
  "committedSessions",
  "consecutiveTimeouts",
  "nextSlot",
  "headSha256",
  "events"
]);
const EVENT_FIELDS = Object.freeze([
  "sequence",
  "eventId",
  "kind",
  "slot",
  "attempt",
  "startedAt",
  "completedAt",
  "outcome",
  "errorCode",
  "cleanupVerified",
  "collectorCountBefore",
  "collectorCountAfter",
  "previousEventSha256",
  "eventSha256"
]);
const TRANSACTION_FIELDS = Object.freeze([
  "schemaVersion",
  "harnessVersion",
  "product",
  "phase",
  "mode",
  "campaignRunId",
  "phaseState",
  "eventId",
  "ledgerHeadBefore",
  "slot",
  "attempt",
  "startedAt",
  "collectorCountBefore",
  "result"
]);
const RESULT_FIELDS = Object.freeze([
  "outcome",
  "errorCode",
  "cleanupVerified",
  "completedAt",
  "collectorCountAfter"
]);

export class B5CampaignSupervisorError extends Error {
  constructor(code, message, exitCode = 1, options = undefined) {
    super(message, options);
    this.name = "B5CampaignSupervisorError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1, options = undefined) {
  throw new B5CampaignSupervisorError(code, message, exitCode, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactFields(value, expected, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be a JSON object`);
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

function requireInteger(value, minimum, maximum, code, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
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

function requireUuid(value, code, label) {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    fail(code, `${label} is invalid`);
  }
  return value;
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

function canonicalSlot(sequence) {
  return String(sequence).padStart(3, "0");
}

function eventCommitment(event) {
  const committed = Object.fromEntries(
    EVENT_FIELDS
      .filter((field) => field !== "eventSha256")
      .map((field) => [field, event[field]])
  );
  return sha256(Buffer.from(JSON.stringify(committed), "utf8"));
}

function expectedNextSlot(status, committedSessions) {
  if (status === "COMPLETE" || status === "INVALIDATED") return null;
  return canonicalSlot(committedSessions + 1);
}

function ledgerFromReplay(base, replay) {
  return Object.freeze({
    ...base,
    updatedAt:
      base.events.length === 0
        ? base.createdAt
        : base.events.at(-1).completedAt,
    status: replay.status,
    committedSessions: replay.committedSessions,
    consecutiveTimeouts: replay.consecutiveTimeouts,
    nextSlot: expectedNextSlot(
      replay.status,
      replay.committedSessions
    ),
    headSha256:
      base.events.length === 0
        ? ZERO_SHA256
        : base.events.at(-1).eventSha256
  });
}

function validateEventShape(event, expectedSequence) {
  requireExactFields(
    event,
    EVENT_FIELDS,
    "SUPERVISOR_LEDGER_INVALID",
    `supervisor event ${expectedSequence}`
  );
  requireInteger(
    event.sequence,
    expectedSequence,
    expectedSequence,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor event sequence"
  );
  requireUuid(
    event.eventId,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor event identifier"
  );
  if (event.kind !== "ATTEMPT" && event.kind !== "RESUME") {
    fail("SUPERVISOR_LEDGER_INVALID", "Supervisor event kind is invalid");
  }
  if (!/^\d{3}$/u.test(event.slot)) {
    fail("SUPERVISOR_LEDGER_INVALID", "Supervisor event slot is invalid");
  }
  requireInteger(
    event.attempt,
    0,
    Number.MAX_SAFE_INTEGER,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor attempt ordinal"
  );
  const startedAtMs = requireTimestamp(
    event.startedAt,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor event start"
  );
  const completedAtMs = requireTimestamp(
    event.completedAt,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor event completion"
  );
  if (completedAtMs < startedAtMs) {
    fail("SUPERVISOR_LEDGER_INVALID", "Supervisor event clock regressed");
  }
  for (const field of ["collectorCountBefore", "collectorCountAfter"]) {
    requireInteger(
      event[field],
      0,
      B5_REQUIRED_SESSION_REPORTS,
      "SUPERVISOR_LEDGER_INVALID",
      `Supervisor ${field}`
    );
  }
  if (
    typeof event.previousEventSha256 !== "string" ||
    !SHA256_PATTERN.test(event.previousEventSha256) ||
    typeof event.eventSha256 !== "string" ||
    !SHA256_PATTERN.test(event.eventSha256) ||
    event.eventSha256 !== eventCommitment(event)
  ) {
    fail("SUPERVISOR_LEDGER_INVALID", "Supervisor event hash is invalid");
  }
  return Object.freeze({ event, startedAtMs, completedAtMs });
}

function replayEvents(events, createdAtMs) {
  let status = "ACTIVE";
  let committedSessions = 0;
  let consecutiveTimeouts = 0;
  let previousCompletedAtMs = createdAtMs;
  let previousHash = ZERO_SHA256;
  let committedAttemptCount = 0;
  let invalidatedAttemptCount = 0;
  let radioTimeoutCount = 0;
  let resumeCount = 0;
  let firstAttemptStartedAtMs = null;
  let lastAttemptCompletedAtMs = null;
  const attemptCounts = new Map();
  const eventIds = new Set();

  events.forEach((event, index) => {
    const validated = validateEventShape(event, index + 1);
    if (eventIds.has(event.eventId)) {
      fail("SUPERVISOR_LEDGER_INVALID", "Supervisor event identifier is reused");
    }
    eventIds.add(event.eventId);
    if (
      event.previousEventSha256 !== previousHash ||
      validated.startedAtMs < previousCompletedAtMs
    ) {
      fail("SUPERVISOR_LEDGER_INVALID", "Supervisor event chain is discontinuous");
    }
    if (event.collectorCountBefore !== committedSessions) {
      fail("SUPERVISOR_LEDGER_INVALID", "Supervisor collector count is discontinuous");
    }
    const slot = canonicalSlot(committedSessions + 1);
    if (event.slot !== slot) {
      fail("SUPERVISOR_LEDGER_INVALID", "Supervisor slot sequence is invalid");
    }

    if (event.kind === "RESUME") {
      if (
        status !== "SUSPENDED" ||
        event.attempt !== 0 ||
        event.outcome !== "RESUMED" ||
        event.errorCode !== null ||
        event.cleanupVerified !== null ||
        event.collectorCountAfter !== committedSessions
      ) {
        fail("SUPERVISOR_LEDGER_INVALID", "Supervisor resume event is invalid");
      }
      status = "ACTIVE";
      resumeCount += 1;
    } else {
      const suspendedClockInvalidation =
        status === "SUSPENDED" &&
        event.outcome === "INVALIDATED" &&
        event.errorCode === "SUPERVISOR_CLOCK_REGRESSION" &&
        event.cleanupVerified === false &&
        event.collectorCountAfter === committedSessions &&
        validated.startedAtMs === previousCompletedAtMs &&
        validated.completedAtMs === previousCompletedAtMs;
      if (status !== "ACTIVE" && !suspendedClockInvalidation) {
        fail("SUPERVISOR_LEDGER_INVALID", "Attempt recorded while campaign is not active");
      }
      const expectedAttempt = (attemptCounts.get(slot) ?? 0) + 1;
      if (event.attempt !== expectedAttempt) {
        fail("SUPERVISOR_LEDGER_INVALID", "Supervisor attempt ordinal is invalid");
      }
      attemptCounts.set(slot, expectedAttempt);
      firstAttemptStartedAtMs ??= validated.startedAtMs;
      lastAttemptCompletedAtMs = validated.completedAtMs;

      if (event.outcome === "COMMITTED") {
        if (
          event.errorCode !== null ||
          event.cleanupVerified !== true ||
          event.collectorCountAfter !== committedSessions + 1
        ) {
          fail("SUPERVISOR_LEDGER_INVALID", "Committed supervisor attempt is invalid");
        }
        committedSessions += 1;
        committedAttemptCount += 1;
        consecutiveTimeouts = 0;
        status =
          committedSessions === B5_REQUIRED_SESSION_REPORTS
            ? "COMPLETE"
            : "ACTIVE";
      } else if (event.outcome === "RADIO_TIMEOUT") {
        if (
          event.errorCode !== "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT" ||
          event.cleanupVerified !== true ||
          event.collectorCountAfter !== committedSessions
        ) {
          fail("SUPERVISOR_LEDGER_INVALID", "Retryable timeout attempt is invalid");
        }
        radioTimeoutCount += 1;
        consecutiveTimeouts += 1;
        if (consecutiveTimeouts >= 3) status = "SUSPENDED";
      } else if (event.outcome === "INVALIDATED") {
        if (
          typeof event.errorCode !== "string" ||
          !ERROR_CODE_PATTERN.test(event.errorCode) ||
          typeof event.cleanupVerified !== "boolean" ||
          ![
            committedSessions,
            committedSessions + 1
          ].includes(event.collectorCountAfter)
        ) {
          fail("SUPERVISOR_LEDGER_INVALID", "Invalidating supervisor attempt is invalid");
        }
        committedSessions = event.collectorCountAfter;
        invalidatedAttemptCount += 1;
        status = "INVALIDATED";
      } else {
        fail("SUPERVISOR_LEDGER_INVALID", "Supervisor attempt outcome is invalid");
      }
    }

    previousHash = event.eventSha256;
    previousCompletedAtMs = validated.completedAtMs;
  });

  return Object.freeze({
    status,
    committedSessions,
    consecutiveTimeouts,
    headSha256: previousHash,
    committedAttemptCount,
    invalidatedAttemptCount,
    radioTimeoutCount,
    resumeCount,
    firstAttemptStartedAtMs,
    lastAttemptCompletedAtMs
  });
}

export function parseB5CampaignSupervisorLedger(raw) {
  const ledger =
    typeof raw === "string"
      ? parseJson(raw, "SUPERVISOR_LEDGER_INVALID", "Supervisor ledger")
      : raw;
  requireExactFields(
    ledger,
    LEDGER_FIELDS,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor ledger"
  );
  for (const [field, expected] of [
    ["schemaVersion", 1],
    ["harnessVersion", B5_CAMPAIGN_SUPERVISOR_VERSION],
    ["product", "V6"],
    ["phase", "B5"],
    ["mode", LEDGER_MODE],
    ["requiredSessions", B5_REQUIRED_SESSION_REPORTS]
  ]) {
    if (ledger[field] !== expected) {
      fail("SUPERVISOR_LEDGER_INVALID", `Supervisor ledger ${field} is invalid`);
    }
  }
  requireUuid(
    ledger.campaignRunId,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor campaign identifier"
  );
  const createdAtMs = requireTimestamp(
    ledger.createdAt,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor creation timestamp"
  );
  const updatedAtMs = requireTimestamp(
    ledger.updatedAt,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor update timestamp"
  );
  if (!Array.isArray(ledger.events) || ledger.events.length > 10_000) {
    fail("SUPERVISOR_LEDGER_INVALID", "Supervisor event inventory is invalid");
  }
  const replay = replayEvents(ledger.events, createdAtMs);
  if (
    updatedAtMs < createdAtMs ||
    ledger.updatedAt !==
      (ledger.events.length === 0
        ? ledger.createdAt
        : ledger.events.at(-1).completedAt) ||
    ledger.status !== replay.status ||
    ledger.committedSessions !== replay.committedSessions ||
    ledger.consecutiveTimeouts !== replay.consecutiveTimeouts ||
    ledger.nextSlot !==
      expectedNextSlot(replay.status, replay.committedSessions) ||
    ledger.headSha256 !== replay.headSha256
  ) {
    fail("SUPERVISOR_LEDGER_INVALID", "Supervisor derived state is inconsistent");
  }
  return Object.freeze({
    ledger: Object.freeze(ledger),
    events: Object.freeze([...ledger.events]),
    campaignRunId: ledger.campaignRunId,
    createdAtMs,
    updatedAtMs,
    status: replay.status,
    committedSessions: replay.committedSessions,
    committedAttemptCount: replay.committedAttemptCount,
    invalidatedAttemptCount: replay.invalidatedAttemptCount,
    radioTimeoutCount: replay.radioTimeoutCount,
    resumeCount: replay.resumeCount,
    finalConsecutiveTimeouts: replay.consecutiveTimeouts,
    coverageFromMs: replay.firstAttemptStartedAtMs,
    coverageUntilMs: replay.lastAttemptCompletedAtMs,
    headSha256: replay.headSha256
  });
}

export function createInitialB5CampaignSupervisorLedger({
  campaignRunId,
  now = new Date().toISOString()
}) {
  requireUuid(
    campaignRunId,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor campaign identifier"
  );
  requireTimestamp(now, "SUPERVISOR_LEDGER_INVALID", "Supervisor creation timestamp");
  const ledger = {
    schemaVersion: 1,
    harnessVersion: B5_CAMPAIGN_SUPERVISOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: LEDGER_MODE,
    campaignRunId,
    createdAt: now,
    updatedAt: now,
    requiredSessions: B5_REQUIRED_SESSION_REPORTS,
    status: "ACTIVE",
    committedSessions: 0,
    consecutiveTimeouts: 0,
    nextSlot: "001",
    headSha256: ZERO_SHA256,
    events: []
  };
  parseB5CampaignSupervisorLedger(ledger);
  return Object.freeze(ledger);
}

function nextAttemptForSlot(parsed) {
  const slot = canonicalSlot(parsed.committedSessions + 1);
  return (
    parsed.events.filter(
      (event) => event.kind === "ATTEMPT" && event.slot === slot
    ).length + 1
  );
}

function buildEvent(parsed, input, kind) {
  const slot = canonicalSlot(parsed.committedSessions + 1);
  const event = {
    sequence: parsed.events.length + 1,
    eventId: input.eventId,
    kind,
    slot,
    attempt: kind === "RESUME" ? 0 : nextAttemptForSlot(parsed),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    outcome: input.outcome,
    errorCode: input.errorCode,
    cleanupVerified: input.cleanupVerified,
    collectorCountBefore: input.collectorCountBefore,
    collectorCountAfter: input.collectorCountAfter,
    previousEventSha256: parsed.headSha256,
    eventSha256: null
  };
  event.eventSha256 = eventCommitment(event);
  return Object.freeze(event);
}

export function appendB5CampaignSupervisorAttempt(currentLedger, input) {
  const parsed = parseB5CampaignSupervisorLedger(currentLedger);
  const suspendedClockInvalidation =
    parsed.status === "SUSPENDED" &&
    input?.outcome === "INVALIDATED" &&
    input?.errorCode === "SUPERVISOR_CLOCK_REGRESSION";
  if (parsed.status !== "ACTIVE" && !suspendedClockInvalidation) {
    fail("SUPERVISOR_NOT_ACTIVE", "Supervisor campaign is not active", 2);
  }
  requireUuid(
    input.eventId,
    "SUPERVISOR_EVENT_INVALID",
    "Supervisor event identifier"
  );
  const event = buildEvent(parsed, input, "ATTEMPT");
  const events = [...parsed.events, event];
  const replay = replayEvents(events, parsed.createdAtMs);
  const ledger = ledgerFromReplay(
    { ...parsed.ledger, events },
    replay
  );
  parseB5CampaignSupervisorLedger(ledger);
  return ledger;
}

export function appendB5CampaignSupervisorResume(currentLedger, {
  eventId,
  resumedAt,
  collectorCount
}) {
  const parsed = parseB5CampaignSupervisorLedger(currentLedger);
  if (parsed.status !== "SUSPENDED") {
    fail("SUPERVISOR_NOT_SUSPENDED", "Supervisor campaign is not suspended", 2);
  }
  requireUuid(
    eventId,
    "SUPERVISOR_EVENT_INVALID",
    "Supervisor event identifier"
  );
  const event = buildEvent(
    parsed,
    {
      eventId,
      startedAt: resumedAt,
      completedAt: resumedAt,
      outcome: "RESUMED",
      errorCode: null,
      cleanupVerified: null,
      collectorCountBefore: collectorCount,
      collectorCountAfter: collectorCount
    },
    "RESUME"
  );
  const events = [...parsed.events, event];
  const replay = replayEvents(events, parsed.createdAtMs);
  const ledger = ledgerFromReplay(
    { ...parsed.ledger, events },
    replay
  );
  parseB5CampaignSupervisorLedger(ledger);
  return ledger;
}

export function validB5CampaignSupervisorLedgerFixture({
  campaignRunId = "00000000-0000-4000-8000-000000000001",
  firstAttemptStartedAt = "2026-07-21T00:00:00.500Z",
  spacingMs = 61_000,
  durationMs = 60_750
} = {}) {
  const firstAttemptStartedAtMs = requireTimestamp(
    firstAttemptStartedAt,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor fixture start timestamp"
  );
  requireInteger(
    spacingMs,
    1,
    Number.MAX_SAFE_INTEGER,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor fixture spacing"
  );
  requireInteger(
    durationMs,
    0,
    spacingMs,
    "SUPERVISOR_LEDGER_INVALID",
    "Supervisor fixture duration"
  );
  let ledger = createInitialB5CampaignSupervisorLedger({
    campaignRunId,
    now: firstAttemptStartedAt
  });
  for (let sequence = 1; sequence <= B5_REQUIRED_SESSION_REPORTS; sequence += 1) {
    const startedAt = new Date(
      firstAttemptStartedAtMs + (sequence - 1) * spacingMs
    ).toISOString();
    const completedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
    ledger = appendB5CampaignSupervisorAttempt(ledger, {
      eventId: `00000000-0000-4${String(sequence).padStart(3, "0")}-8000-${String(sequence).padStart(12, "0")}`,
      startedAt,
      completedAt,
      outcome: "COMMITTED",
      errorCode: null,
      cleanupVerified: true,
      collectorCountBefore: sequence - 1,
      collectorCountAfter: sequence
    });
  }
  return ledger;
}

function assertNoSymlinkComponents(location, code) {
  const resolved = path.resolve(location);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const status = fs.lstatSync(current);
      if (status.isSymbolicLink()) {
        fail(code, "Supervisor paths must not contain symbolic links");
      }
      if (index < parts.length - 1 && !status.isDirectory()) {
        fail(code, "Supervisor path parent is not a directory");
      }
    } catch (error) {
      if (error?.code === "ENOENT") return resolved;
      if (error instanceof B5CampaignSupervisorError) throw error;
      fail(code, "Supervisor path cannot be inspected safely");
    }
  }
  return resolved;
}

function ensurePrivateDirectory(directory) {
  const resolved = assertNoSymlinkComponents(
    directory,
    "SUPERVISOR_DIRECTORY_INVALID"
  );
  let existed = true;
  try {
    fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fail("SUPERVISOR_DIRECTORY_INVALID", "Supervisor directory is unavailable");
    }
    existed = false;
  }
  try {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const status = fs.lstatSync(resolved);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      fs.realpathSync(resolved) !== resolved ||
      (process.platform === "linux" &&
        ((status.mode & 0o777) !== 0o700 ||
          (uid !== null && status.uid !== uid)))
    ) {
      fail(
        "SUPERVISOR_DIRECTORY_INVALID",
        "Supervisor directory must be private and canonical"
      );
    }
    if (!existed && process.platform === "linux") fs.chmodSync(resolved, 0o700);
    return resolved;
  } catch (error) {
    if (error instanceof B5CampaignSupervisorError) throw error;
    fail("SUPERVISOR_DIRECTORY_INVALID", "Supervisor directory is unavailable");
  }
}

function requirePrivateMetadata(status, label) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (status.mode & 0o777) !== 0o600 ||
    (uid !== null && status.uid !== uid)
  ) {
    fail(
      "SUPERVISOR_PRIVATE_FILE_INVALID",
      `${label} must be an owner-only regular file`
    );
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

function fileExistsSafely(location) {
  assertNoSymlinkComponents(location, "SUPERVISOR_PRIVATE_FILE_INVALID");
  try {
    const status = fs.lstatSync(location);
    if (status.isSymbolicLink()) {
      fail("SUPERVISOR_PRIVATE_FILE_INVALID", "Supervisor file is a symbolic link");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error instanceof B5CampaignSupervisorError) throw error;
    fail("SUPERVISOR_PRIVATE_FILE_INVALID", "Supervisor file cannot be inspected");
  }
}

function readPrivateBytes(location, maximumBytes, label) {
  assertNoSymlinkComponents(location, "SUPERVISOR_PRIVATE_FILE_INVALID");
  let descriptor;
  try {
    descriptor = fs.openSync(
      location,
      fs.constants.O_RDONLY | NO_FOLLOW_FLAG | NONBLOCK_FLAG
    );
    const before = fs.fstatSync(descriptor);
    requirePrivateMetadata(before, label);
    if (before.size < 2 || before.size > maximumBytes) {
      fail("SUPERVISOR_PRIVATE_FILE_INVALID", `${label} has an invalid size`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    requirePrivateMetadata(after, label);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== before.size
    ) {
      fail("SUPERVISOR_PRIVATE_FILE_CHANGED", `${label} changed while being read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof B5CampaignSupervisorError) throw error;
    fail("SUPERVISOR_PRIVATE_FILE_INVALID", `${label} cannot be read safely`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWritePrivate(location, value, { allowExisting }) {
  const parent = ensurePrivateDirectory(path.dirname(location));
  assertNoSymlinkComponents(location, "SUPERVISOR_PRIVATE_FILE_INVALID");
  const exists = fileExistsSafely(location);
  if (exists) {
    const status = fs.lstatSync(location);
    requirePrivateMetadata(status, "Supervisor destination");
    if (!allowExisting) {
      fail("SUPERVISOR_OUTPUT_EXISTS", "Supervisor destination already exists");
    }
  } else if (allowExisting) {
    fail("SUPERVISOR_PRIVATE_FILE_INVALID", "Supervisor destination is missing");
  }
  const encoded = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (encoded.byteLength > MAX_LEDGER_BYTES) {
    fail("SUPERVISOR_PRIVATE_FILE_INVALID", "Supervisor output exceeds size limit");
  }
  const temporary = path.join(
    parent,
    `.b5-supervisor-${process.pid}-${crypto.randomUUID()}.tmp`
  );
  let descriptor;
  let published = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        NO_FOLLOW_FLAG,
      0o600
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, encoded);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (allowExisting) {
      fs.renameSync(temporary, location);
    } else {
      fs.linkSync(temporary, location);
      fs.unlinkSync(temporary);
    }
    published = true;
    fsyncDirectory(parent);
    requirePrivateMetadata(fs.lstatSync(location), "Supervisor output");
  } catch (error) {
    if (error instanceof B5CampaignSupervisorError) throw error;
    fail("SUPERVISOR_WRITE_FAILED", "Supervisor output could not be committed", 1, {
      cause: error
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!published || fs.existsSync(temporary)) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }
}

function removePrivateFile(location) {
  try {
    const status = fs.lstatSync(location);
    requirePrivateMetadata(status, "Supervisor transaction");
    fs.unlinkSync(location);
    fsyncDirectory(path.dirname(location));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error instanceof B5CampaignSupervisorError) throw error;
    fail("SUPERVISOR_RECOVERY_CONFLICT", "Supervisor transaction cannot be removed");
  }
}

function readLedger(ledgerPath) {
  return parseB5CampaignSupervisorLedger(
    readPrivateBytes(ledgerPath, MAX_LEDGER_BYTES, "Supervisor ledger").toString("utf8")
  );
}

async function readCollectorState(statePath) {
  try {
    const { parseCollectorState } = await import(COLLECTOR_MODULE_URL.href);
    return parseCollectorState(
      readPrivateBytes(statePath, MAX_COLLECTOR_BYTES, "Collector state").toString("utf8")
    );
  } catch (error) {
    if (error instanceof B5CampaignSupervisorError) throw error;
    fail("SUPERVISOR_COLLECTOR_STATE_INVALID", "Collector state is invalid", 1, {
      cause: error
    });
  }
}

function assertCampaignBinding(parsed, collectorState, { allowCountMismatch = false } = {}) {
  if (parsed.campaignRunId !== collectorState.campaignRunId) {
    fail("SUPERVISOR_CAMPAIGN_MISMATCH", "Supervisor and collector campaigns differ");
  }
  if (
    !allowCountMismatch &&
    collectorState.records.length !== parsed.committedSessions
  ) {
    fail("SUPERVISOR_COLLECTOR_COUNT_MISMATCH", "Supervisor and collector counts differ");
  }
}

function transactionPath(ledgerPath) {
  return `${ledgerPath}.pending`;
}

function parseTransaction(raw) {
  const transaction =
    typeof raw === "string"
      ? parseJson(raw, "SUPERVISOR_RECOVERY_CONFLICT", "Supervisor transaction")
      : raw;
  requireExactFields(
    transaction,
    TRANSACTION_FIELDS,
    "SUPERVISOR_RECOVERY_CONFLICT",
    "Supervisor transaction"
  );
  for (const [field, expected] of [
    ["schemaVersion", 1],
    ["harnessVersion", B5_CAMPAIGN_SUPERVISOR_VERSION],
    ["product", "V6"],
    ["phase", "B5"],
    ["mode", TRANSACTION_MODE]
  ]) {
    if (transaction[field] !== expected) {
      fail("SUPERVISOR_RECOVERY_CONFLICT", `Supervisor transaction ${field} is invalid`);
    }
  }
  requireUuid(transaction.campaignRunId, "SUPERVISOR_RECOVERY_CONFLICT", "Transaction campaign");
  requireUuid(transaction.eventId, "SUPERVISOR_RECOVERY_CONFLICT", "Transaction event");
  if (!SHA256_PATTERN.test(transaction.ledgerHeadBefore)) {
    fail("SUPERVISOR_RECOVERY_CONFLICT", "Transaction ledger binding is invalid");
  }
  if (!/^\d{3}$/u.test(transaction.slot)) {
    fail("SUPERVISOR_RECOVERY_CONFLICT", "Transaction slot is invalid");
  }
  requireInteger(transaction.attempt, 1, Number.MAX_SAFE_INTEGER,
    "SUPERVISOR_RECOVERY_CONFLICT", "Transaction attempt");
  requireTimestamp(transaction.startedAt, "SUPERVISOR_RECOVERY_CONFLICT", "Transaction start");
  requireInteger(transaction.collectorCountBefore, 0, B5_REQUIRED_SESSION_REPORTS - 1,
    "SUPERVISOR_RECOVERY_CONFLICT", "Transaction collector count");
  if (transaction.phaseState === "STARTED") {
    if (transaction.result !== null) {
      fail("SUPERVISOR_RECOVERY_CONFLICT", "Started transaction contains a result");
    }
  } else if (transaction.phaseState === "RESULT_OBSERVED") {
    requireExactFields(transaction.result, RESULT_FIELDS,
      "SUPERVISOR_RECOVERY_CONFLICT", "Transaction result");
    requireTimestamp(transaction.result.completedAt,
      "SUPERVISOR_RECOVERY_CONFLICT", "Transaction completion");
    requireInteger(transaction.result.collectorCountAfter, 0, B5_REQUIRED_SESSION_REPORTS,
      "SUPERVISOR_RECOVERY_CONFLICT", "Transaction final collector count");
    if (
      !["COMMITTED", "RADIO_TIMEOUT", "INVALIDATED"].includes(transaction.result.outcome) ||
      (transaction.result.errorCode !== null &&
        (typeof transaction.result.errorCode !== "string" ||
          !ERROR_CODE_PATTERN.test(transaction.result.errorCode))) ||
      typeof transaction.result.cleanupVerified !== "boolean"
    ) {
      fail("SUPERVISOR_RECOVERY_CONFLICT", "Transaction result is invalid");
    }
  } else {
    fail("SUPERVISOR_RECOVERY_CONFLICT", "Transaction phase is invalid");
  }
  return Object.freeze(transaction);
}

function readTransaction(ledgerPath) {
  return parseTransaction(
    readPrivateBytes(
      transactionPath(ledgerPath),
      MAX_LEDGER_BYTES,
      "Supervisor transaction"
    ).toString("utf8")
  );
}

function buildStartedTransaction(parsed, { eventId, startedAt }) {
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_CAMPAIGN_SUPERVISOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: TRANSACTION_MODE,
    campaignRunId: parsed.campaignRunId,
    phaseState: "STARTED",
    eventId,
    ledgerHeadBefore: parsed.headSha256,
    slot: canonicalSlot(parsed.committedSessions + 1),
    attempt: nextAttemptForSlot(parsed),
    startedAt,
    collectorCountBefore: parsed.committedSessions,
    result: null
  });
}

function withObservedResult(transaction, result) {
  return Object.freeze({
    ...transaction,
    phaseState: "RESULT_OBSERVED",
    result: Object.freeze(result)
  });
}

async function acquireSupervisorLock(lockPath) {
  const parent = ensurePrivateDirectory(path.dirname(lockPath));
  assertNoSymlinkComponents(lockPath, "SUPERVISOR_LOCK_FAILED");
  let descriptor;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | NO_FOLLOW_FLAG,
      0o600
    );
    const status = fs.fstatSync(descriptor);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      (status.mode & 0o777) !== 0o600 ||
      (uid !== null && status.uid !== uid)
    ) {
      fail("SUPERVISOR_LOCK_FAILED", "Supervisor lock is not private");
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof B5CampaignSupervisorError) throw error;
    fail("SUPERVISOR_LOCK_FAILED", "Supervisor lock cannot be opened");
  }

  const child = spawn(
    "/usr/bin/flock",
    ["--exclusive", "--nonblock", "3"],
    { stdio: ["ignore", "ignore", "ignore", descriptor], windowsHide: true }
  );
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new B5CampaignSupervisorError(
          "SUPERVISOR_LOCK_FAILED",
          "Supervisor lock timed out"
        )),
        5_000
      );
      timer.unref?.();
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new B5CampaignSupervisorError(
          code === 1 ? "SUPERVISOR_BUSY" : "SUPERVISOR_LOCK_FAILED",
          code === 1 ? "Supervisor ledger is already in use" : "Supervisor lock failed"
        ));
      });
    });
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({
        schemaVersion: 1,
        acquiredAt: new Date().toISOString(),
        ownerToken: crypto.randomUUID()
      })}\n`,
      "utf8"
    );
    fs.fsyncSync(descriptor);
    fsyncDirectory(parent);
  } catch (error) {
    child.kill("SIGKILL");
    fs.closeSync(descriptor);
    if (error instanceof B5CampaignSupervisorError) throw error;
    fail("SUPERVISOR_LOCK_FAILED", "Supervisor lock cannot be acquired", 1, {
      cause: error
    });
  } finally {
    clearTimeout(timer);
  }
  return () => fs.closeSync(descriptor);
}

async function withSupervisorLock(ledgerPath, action, runtime) {
  const acquire = runtime.acquireLock ?? acquireSupervisorLock;
  const release = await acquire(`${ledgerPath}.lock`);
  try {
    return await action();
  } finally {
    await release();
  }
}

function safeNow(runtime) {
  const value = (runtime.now ?? (() => new Date().toISOString()))();
  const encoded = value instanceof Date ? value.toISOString() : value;
  requireTimestamp(encoded, "SUPERVISOR_CLOCK_INVALID", "Supervisor clock");
  return encoded;
}

function logicalCompletion(startedAt, candidate) {
  return Date.parse(candidate) < Date.parse(startedAt) ? startedAt : candidate;
}

function invalidatingResult(errorCode, cleanupVerified, completedAt, countAfter) {
  return Object.freeze({
    outcome: "INVALIDATED",
    errorCode,
    cleanupVerified: cleanupVerified === true,
    completedAt,
    collectorCountAfter: countAfter
  });
}

function parseCollectorChildReport(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_CHILD_OUTPUT_BYTES) {
    fail("SUPERVISOR_COLLECTOR_RESULT_INVALID", "Collector result is invalid");
  }
  return parseJson(raw, "SUPERVISOR_COLLECTOR_RESULT_INVALID", "Collector result");
}

async function defaultCaptureRunner({ statePath }) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [COLLECTOR_SCRIPT, "--capture", "--state", statePath],
      {
        encoding: "utf8",
        maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        timeout: COLLECTOR_TIMEOUT_MS,
        windowsHide: true
      }
    );
    const report = parseCollectorChildReport(result.stdout ?? "");
    return Object.freeze({ success: true, report });
  } catch (error) {
    try {
      const report = parseCollectorChildReport(error?.stdout ?? "");
      const code = report.failure?.code;
      if (typeof code !== "string" || !ERROR_CODE_PATTERN.test(code)) {
        throw new Error("invalid collector failure code");
      }
      return Object.freeze({
        success: false,
        errorCode: code,
        cleanupVerified: report.failure.cleanupVerified === true
      });
    } catch {
      return Object.freeze({
        success: false,
        errorCode: "SUPERVISOR_COLLECTOR_EXECUTION_FAILED",
        cleanupVerified: false
      });
    }
  }
}

async function defaultPreflightRunner({ statePath }) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [COLLECTOR_SCRIPT, "--preflight", "--state", statePath],
      {
        encoding: "utf8",
        maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        timeout: 30_000,
        windowsHide: true
      }
    );
    const report = parseCollectorChildReport(result.stdout ?? "");
    if (report.operation !== "PREFLIGHT" || report.verdict !== "PASS") {
      fail("SUPERVISOR_PREFLIGHT_FAILED", "Collector preflight did not pass");
    }
    return report;
  } catch (error) {
    if (error instanceof B5CampaignSupervisorError) throw error;
    fail("SUPERVISOR_PREFLIGHT_FAILED", "Collector preflight failed", 1, {
      cause: error
    });
  }
}

function classifyCaptureResult(runResult, beforeCount, afterCount, completedAt) {
  if (runResult?.success === true && afterCount === beforeCount + 1) {
    return Object.freeze({
      outcome: "COMMITTED",
      errorCode: null,
      cleanupVerified: true,
      completedAt,
      collectorCountAfter: afterCount
    });
  }
  if (
    runResult?.success === false &&
    runResult.errorCode === "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT" &&
    runResult.cleanupVerified === true &&
    afterCount === beforeCount
  ) {
    return Object.freeze({
      outcome: "RADIO_TIMEOUT",
      errorCode: "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
      cleanupVerified: true,
      completedAt,
      collectorCountAfter: afterCount
    });
  }
  let errorCode = "SUPERVISOR_COLLECTOR_STATE_TRANSITION_INVALID";
  if (
    runResult?.success === false &&
    typeof runResult.errorCode === "string" &&
    ERROR_CODE_PATTERN.test(runResult.errorCode)
  ) {
    errorCode = runResult.errorCode;
  }
  const representableAfter = [beforeCount, beforeCount + 1].includes(afterCount)
    ? afterCount
    : beforeCount;
  return invalidatingResult(
    errorCode,
    runResult?.cleanupVerified === true,
    completedAt,
    representableAfter
  );
}

function commitObservedTransaction(ledgerPath, parsed, transaction) {
  if (
    transaction.campaignRunId !== parsed.campaignRunId ||
    transaction.ledgerHeadBefore !== parsed.headSha256 ||
    transaction.slot !== canonicalSlot(parsed.committedSessions + 1) ||
    transaction.attempt !== nextAttemptForSlot(parsed) ||
    transaction.collectorCountBefore !== parsed.committedSessions ||
    transaction.phaseState !== "RESULT_OBSERVED"
  ) {
    fail("SUPERVISOR_RECOVERY_CONFLICT", "Supervisor transaction binding is invalid");
  }
  const result = transaction.result;
  const ledger = appendB5CampaignSupervisorAttempt(parsed.ledger, {
    eventId: transaction.eventId,
    startedAt: transaction.startedAt,
    completedAt: result.completedAt,
    outcome: result.outcome,
    errorCode: result.errorCode,
    cleanupVerified: result.cleanupVerified,
    collectorCountBefore: transaction.collectorCountBefore,
    collectorCountAfter: result.collectorCountAfter
  });
  atomicWritePrivate(ledgerPath, ledger, { allowExisting: true });
  removePrivateFile(transactionPath(ledgerPath));
  return parseB5CampaignSupervisorLedger(ledger);
}

function recoverTransaction(ledgerPath, parsed, collectorState, runtime) {
  const transaction = readTransaction(ledgerPath);
  if (transaction.campaignRunId !== parsed.campaignRunId) {
    fail("SUPERVISOR_RECOVERY_CONFLICT", "Supervisor transaction campaign differs");
  }
  const alreadyCommitted = parsed.events.at(-1);
  if (
    alreadyCommitted?.eventId === transaction.eventId &&
    parsed.headSha256 === alreadyCommitted.eventSha256
  ) {
    const resultMatches =
      transaction.phaseState === "STARTED" ||
      (transaction.result.outcome === alreadyCommitted.outcome &&
        transaction.result.errorCode === alreadyCommitted.errorCode &&
        transaction.result.cleanupVerified === alreadyCommitted.cleanupVerified &&
        transaction.result.completedAt === alreadyCommitted.completedAt &&
        transaction.result.collectorCountAfter ===
          alreadyCommitted.collectorCountAfter);
    if (
      transaction.ledgerHeadBefore !== alreadyCommitted.previousEventSha256 ||
      transaction.slot !== alreadyCommitted.slot ||
      transaction.attempt !== alreadyCommitted.attempt ||
      transaction.startedAt !== alreadyCommitted.startedAt ||
      transaction.collectorCountBefore !==
        alreadyCommitted.collectorCountBefore ||
      !resultMatches
    ) {
      fail(
        "SUPERVISOR_RECOVERY_CONFLICT",
        "Committed supervisor transaction does not match its ledger event"
      );
    }
    removePrivateFile(transactionPath(ledgerPath));
    return parsed;
  }
  if (transaction.ledgerHeadBefore !== parsed.headSha256) {
    fail("SUPERVISOR_RECOVERY_CONFLICT", "Supervisor transaction head differs");
  }
  if (transaction.phaseState === "RESULT_OBSERVED") {
    if (collectorState.records.length !== transaction.result.collectorCountAfter) {
      fail("SUPERVISOR_RECOVERY_CONFLICT", "Collector count changed after observed result");
    }
    return commitObservedTransaction(ledgerPath, parsed, transaction);
  }

  const countAfter = collectorState.records.length;
  let completedAt = logicalCompletion(transaction.startedAt, safeNow(runtime));
  let result;
  if (countAfter === transaction.collectorCountBefore + 1) {
    const committedRecord = collectorState.records.at(-1);
    const committedAt = committedRecord.captureCompletedAt;
    if (
      Date.parse(committedRecord.captureStartedAt) >=
        Date.parse(transaction.startedAt) &&
      Date.parse(committedAt) >= Date.parse(transaction.startedAt)
    ) {
      completedAt = committedAt;
      result = {
        outcome: "COMMITTED",
        errorCode: null,
        cleanupVerified: true,
        completedAt,
        collectorCountAfter: countAfter
      };
    } else {
      result = invalidatingResult(
        "SUPERVISOR_COLLECTOR_STATE_TRANSITION_INVALID",
        false,
        completedAt,
        countAfter
      );
    }
  } else if (countAfter === transaction.collectorCountBefore) {
    result = invalidatingResult(
      "SUPERVISOR_ATTEMPT_RESULT_LOST",
      false,
      completedAt,
      countAfter
    );
  } else {
    result = invalidatingResult(
      "SUPERVISOR_COLLECTOR_STATE_TRANSITION_INVALID",
      false,
      completedAt,
      transaction.collectorCountBefore
    );
  }
  const observed = withObservedResult(transaction, result);
  atomicWritePrivate(transactionPath(ledgerPath), observed, {
    allowExisting: true
  });
  return commitObservedTransaction(ledgerPath, parsed, observed);
}

function buildStatusReport(parsed, operation, {
  lastOutcome = null,
  recoveryPerformed = false,
  collectorStateVerified = true
} = {}) {
  const totalAttempts = parsed.events.filter(
    (event) => event.kind === "ATTEMPT"
  ).length;
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_CAMPAIGN_SUPERVISOR_VERSION,
    product: "V6",
    phase: "B5",
    generatedAt: new Date().toISOString(),
    mode: "B5_CAMPAIGN_SUPERVISOR_STATUS",
    operation,
    verdict:
      parsed.status === "COMPLETE"
        ? "READY"
        : parsed.status === "INVALIDATED"
          ? "FAIL"
          : "PENDING",
    campaign: Object.freeze({
      status: parsed.status,
      requiredSessions: B5_REQUIRED_SESSION_REPORTS,
      committedSessions: parsed.committedSessions,
      remainingSessions:
        B5_REQUIRED_SESSION_REPORTS - parsed.committedSessions,
      nextSlot: parsed.ledger.nextSlot,
      consecutiveTimeouts: parsed.finalConsecutiveTimeouts,
      totalAttempts,
      committedAttempts: parsed.committedAttemptCount,
      radioTimeouts: parsed.radioTimeoutCount,
      invalidatedAttempts: parsed.invalidatedAttemptCount,
      resumptions: parsed.resumeCount
    }),
    lastOutcome,
    recoveryPerformed,
    checks: Object.freeze({
      campaignBinding: collectorStateVerified ? "PASS" : "PENDING",
      ledgerHashChain: "PASS",
      collectorStateCount: collectorStateVerified ? "PASS" : "PENDING"
    }),
    gate: Object.freeze({
      b5HundredSessionGate: "PENDING",
      b6: "PENDING"
    }),
    privacy: Object.freeze({
      identifiersIncluded: false,
      campaignIdentifierIncluded: false,
      pathsIncluded: false,
      hashesIncluded: false,
      sourceErrorsIncluded: false
    }),
    physicalRadioAccessed: operation === "CAPTURE"
  });
}

function assertReportRedacted(report, privateValues = []) {
  const encoded = JSON.stringify(report);
  for (const value of privateValues) {
    if (typeof value === "string" && value.length > 0 && encoded.includes(value)) {
      fail("SUPERVISOR_REPORT_PRIVACY_INVALID", "Supervisor report leaks private data");
    }
  }
  return true;
}

async function initializeSupervisor(options, runtime) {
  return withSupervisorLock(options.ledger, async () => {
    if (
      fileExistsSafely(options.ledger) ||
      fileExistsSafely(transactionPath(options.ledger))
    ) {
      fail("SUPERVISOR_OUTPUT_EXISTS", "Supervisor artifacts already exist");
    }
    const collectorState = await readCollectorState(options.state);
    if (collectorState.records.length !== 0) {
      fail("SUPERVISOR_COLLECTOR_NOT_EMPTY", "Supervisor requires an empty collector state");
    }
    const ledger = createInitialB5CampaignSupervisorLedger({
      campaignRunId: collectorState.campaignRunId,
      now: safeNow(runtime)
    });
    atomicWritePrivate(options.ledger, ledger, { allowExisting: false });
    return buildStatusReport(
      parseB5CampaignSupervisorLedger(ledger),
      "INIT"
    );
  }, runtime);
}

async function preflightSupervisor(options, runtime) {
  if (fileExistsSafely(transactionPath(options.ledger))) {
    fail("SUPERVISOR_RECOVERY_REQUIRED", "Supervisor recovery is required", 2);
  }
  let parsed = readLedger(options.ledger);
  let collectorState = await readCollectorState(options.state);
  assertCampaignBinding(parsed, collectorState);
  const runner = runtime.preflightRunner ?? defaultPreflightRunner;
  await runner({ statePath: options.state });
  parsed = readLedger(options.ledger);
  collectorState = await readCollectorState(options.state);
  assertCampaignBinding(parsed, collectorState);
  return buildStatusReport(parsed, "PREFLIGHT");
}

async function statusSupervisor(options) {
  const parsed = readLedger(options.ledger);
  const collectorState = await readCollectorState(options.state);
  assertCampaignBinding(parsed, collectorState, {
    allowCountMismatch: fileExistsSafely(transactionPath(options.ledger))
  });
  return buildStatusReport(parsed, "STATUS", {
    recoveryPerformed: false,
    collectorStateVerified:
      collectorState.records.length === parsed.committedSessions
  });
}

async function captureSupervisor(options, runtime) {
  return withSupervisorLock(options.ledger, async () => {
    if (fileExistsSafely(transactionPath(options.ledger))) {
      fail("SUPERVISOR_RECOVERY_REQUIRED", "Supervisor recovery is required", 2);
    }
    const parsed = readLedger(options.ledger);
    const collectorBefore = await readCollectorState(options.state);
    assertCampaignBinding(parsed, collectorBefore);
    if (parsed.status !== "ACTIVE") {
      fail("SUPERVISOR_NOT_ACTIVE", "Supervisor campaign is not active", 2);
    }

    const wallStartedAt = safeNow(runtime);
    const clockRegressed = Date.parse(wallStartedAt) < parsed.updatedAtMs;
    const startedAt = clockRegressed ? parsed.ledger.updatedAt : wallStartedAt;
    const transaction = buildStartedTransaction(parsed, {
      eventId: (runtime.randomUUID ?? crypto.randomUUID)(),
      startedAt
    });
    atomicWritePrivate(transactionPath(options.ledger), transaction, {
      allowExisting: false
    });

    let runResult;
    if (clockRegressed) {
      runResult = {
        success: false,
        errorCode: "SUPERVISOR_CLOCK_REGRESSION",
        cleanupVerified: false
      };
    } else {
      const runner = runtime.captureRunner ?? defaultCaptureRunner;
      try {
        runResult = await runner({
          statePath: options.state,
          slot: transaction.slot,
          attempt: transaction.attempt
        });
      } catch {
        runResult = {
          success: false,
          errorCode: "SUPERVISOR_COLLECTOR_EXECUTION_FAILED",
          cleanupVerified: false
        };
      }
    }

    const collectorAfter = await readCollectorState(options.state);
    if (collectorAfter.campaignRunId !== parsed.campaignRunId) {
      runResult = {
        success: false,
        errorCode: "SUPERVISOR_CAMPAIGN_MISMATCH",
        cleanupVerified: false
      };
    }
    const rawCompletedAt = safeNow(runtime);
    const completionRegressed =
      Date.parse(rawCompletedAt) < Date.parse(startedAt);
    const committedRecord =
      collectorAfter.records.length === transaction.collectorCountBefore + 1
        ? collectorAfter.records.at(-1)
        : null;
    const committedTimelineInvalid =
      committedRecord !== null &&
      (Date.parse(startedAt) > Date.parse(committedRecord.captureStartedAt) ||
        Date.parse(rawCompletedAt) <
          Date.parse(committedRecord.captureCompletedAt));
    const completedAt = logicalCompletion(startedAt, rawCompletedAt);
    let result = classifyCaptureResult(
      runResult,
      transaction.collectorCountBefore,
      collectorAfter.records.length,
      completedAt
    );
    if (
      clockRegressed ||
      completionRegressed ||
      (result.outcome === "COMMITTED" && committedTimelineInvalid)
    ) {
      const representableAfter = [
        transaction.collectorCountBefore,
        transaction.collectorCountBefore + 1
      ].includes(collectorAfter.records.length)
        ? collectorAfter.records.length
        : transaction.collectorCountBefore;
      result = invalidatingResult(
        clockRegressed || completionRegressed
          ? "SUPERVISOR_CLOCK_REGRESSION"
          : "SUPERVISOR_COLLECTOR_STATE_TRANSITION_INVALID",
        false,
        completedAt,
        representableAfter
      );
    }
    const observed = withObservedResult(transaction, result);
    atomicWritePrivate(transactionPath(options.ledger), observed, {
      allowExisting: true
    });
    const committed = commitObservedTransaction(
      options.ledger,
      parsed,
      observed
    );
    return buildStatusReport(committed, "CAPTURE", {
      lastOutcome: result.outcome
    });
  }, runtime);
}

async function resumeSupervisor(options, runtime) {
  return withSupervisorLock(options.ledger, async () => {
    let parsed = readLedger(options.ledger);
    let collectorState = await readCollectorState(options.state);
    assertCampaignBinding(parsed, collectorState, {
      allowCountMismatch: fileExistsSafely(transactionPath(options.ledger))
    });
    if (fileExistsSafely(transactionPath(options.ledger))) {
      parsed = recoverTransaction(
        options.ledger,
        parsed,
        collectorState,
        runtime
      );
      collectorState = await readCollectorState(options.state);
      assertCampaignBinding(parsed, collectorState);
      return buildStatusReport(parsed, "RESUME", {
        lastOutcome: parsed.events.at(-1)?.outcome ?? null,
        recoveryPerformed: true
      });
    }
    if (parsed.status === "ACTIVE") {
      return buildStatusReport(parsed, "RESUME");
    }
    if (parsed.status !== "SUSPENDED") {
      fail("SUPERVISOR_RESUME_FORBIDDEN", "Supervisor campaign cannot be resumed", 2);
    }
    const wallNow = safeNow(runtime);
    if (Date.parse(wallNow) < parsed.updatedAtMs) {
      const invalidated = appendB5CampaignSupervisorAttempt(parsed.ledger, {
        eventId: (runtime.randomUUID ?? crypto.randomUUID)(),
        startedAt: parsed.ledger.updatedAt,
        completedAt: parsed.ledger.updatedAt,
        outcome: "INVALIDATED",
        errorCode: "SUPERVISOR_CLOCK_REGRESSION",
        cleanupVerified: false,
        collectorCountBefore: parsed.committedSessions,
        collectorCountAfter: parsed.committedSessions
      });
      atomicWritePrivate(options.ledger, invalidated, { allowExisting: true });
      return buildStatusReport(
        parseB5CampaignSupervisorLedger(invalidated),
        "RESUME",
        { lastOutcome: "INVALIDATED" }
      );
    }
    const resumed = appendB5CampaignSupervisorResume(parsed.ledger, {
      eventId: (runtime.randomUUID ?? crypto.randomUUID)(),
      resumedAt: wallNow,
      collectorCount: parsed.committedSessions
    });
    atomicWritePrivate(options.ledger, resumed, { allowExisting: true });
    parsed = parseB5CampaignSupervisorLedger(resumed);
    return buildStatusReport(parsed, "RESUME", {
      lastOutcome: "RESUMED"
    });
  }, runtime);
}

function parseArguments(argv) {
  const options = {
    mode: null,
    ledger: null,
    state: null
  };
  const modes = new Map([
    ["--init", "INIT"],
    ["--preflight", "PREFLIGHT"],
    ["--capture", "CAPTURE"],
    ["--resume", "RESUME"],
    ["--status", "STATUS"],
    ["--self-test", "SELF_TEST"],
    ["--help", "HELP"],
    ["-h", "HELP"]
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) fail("INVALID_ARGUMENT", "Duplicate supervisor argument", 2);
    seen.add(argument);
    if (modes.has(argument)) {
      if (options.mode !== null) fail("INVALID_ARGUMENT", "Choose one supervisor action", 2);
      options.mode = modes.get(argument);
      continue;
    }
    if (argument !== "--ledger" && argument !== "--state") {
      fail("INVALID_ARGUMENT", "Unknown supervisor argument", 2);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `${argument} requires a value`, 2);
    }
    if (argument === "--ledger") options.ledger = path.resolve(value);
    if (argument === "--state") options.state = path.resolve(value);
  }
  if (options.mode === null) fail("INVALID_ARGUMENT", "Supervisor action is required", 2);
  if (options.mode === "HELP" || options.mode === "SELF_TEST") {
    if (argv.length !== 1) fail("INVALID_ARGUMENT", "Help and self-test accept no options", 2);
    return options;
  }
  if (options.ledger === null || options.state === null) {
    fail("INVALID_ARGUMENT", "--ledger and --state are required", 2);
  }
  const reserved = [
    options.ledger,
    transactionPath(options.ledger),
    `${options.ledger}.lock`,
    options.state,
    `${options.state}.pending`,
    `${options.state}.lock`,
    `${options.state}.evidence`
  ].map((value) => path.resolve(value));
  if (new Set(reserved).size !== reserved.length) {
    fail("INVALID_ARGUMENT", "Supervisor and collector namespaces overlap", 2);
  }
  return options;
}

export function runSupervisorSelfTest() {
  const ledger = validB5CampaignSupervisorLedgerFixture();
  const parsed = parseB5CampaignSupervisorLedger(ledger);
  if (
    parsed.status !== "COMPLETE" ||
    parsed.committedAttemptCount !== B5_REQUIRED_SESSION_REPORTS ||
    parsed.invalidatedAttemptCount !== 0 ||
    parsed.finalConsecutiveTimeouts !== 0 ||
    parsed.coverageFromMs === null ||
    parsed.coverageUntilMs === null
  ) {
    fail("SUPERVISOR_SELF_TEST_FAILED", "Supervisor fixture is incomplete");
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_CAMPAIGN_SUPERVISOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: "SELF_TEST",
    verdict: "PASS",
    syntheticCommittedAttempts: parsed.committedAttemptCount,
    physicalRadioAccessed: false,
    gate: Object.freeze({ b5HundredSessionGate: "PENDING", b6: "PENDING" })
  });
}

export async function executeB5CampaignSupervisorAction(options, runtime = {}) {
  if (!isRecord(options)) {
    fail("INVALID_ARGUMENT", "Supervisor options are required", 2);
  }
  if (options.mode === "INIT") return initializeSupervisor(options, runtime);
  if (options.mode === "PREFLIGHT") return preflightSupervisor(options, runtime);
  if (options.mode === "CAPTURE") return captureSupervisor(options, runtime);
  if (options.mode === "RESUME") return resumeSupervisor(options, runtime);
  if (options.mode === "STATUS") return statusSupervisor(options);
  fail("INVALID_ARGUMENT", "Unsupported supervisor action", 2);
}

function usage() {
  return [
    "V6 B5 physical campaign supervisor",
    "",
    "  --init|--preflight|--capture|--resume|--status --ledger PRIVATE.json --state COLLECTOR.json",
    "  --self-test",
    "",
    "Only a direct-control orchestration timeout with verified cleanup is retryable."
  ].join("\n");
}

function failureReport(error) {
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_CAMPAIGN_SUPERVISOR_VERSION,
    product: "V6",
    phase: "B5",
    generatedAt: new Date().toISOString(),
    mode: "B5_CAMPAIGN_SUPERVISOR_FAILURE",
    verdict: "FAIL",
    failure: Object.freeze({
      code:
        error instanceof B5CampaignSupervisorError
          ? error.code
          : "SUPERVISOR_UNEXPECTED_FAILURE",
      message: "B5 campaign supervision failed"
    }),
    gate: Object.freeze({ b5HundredSessionGate: "PENDING", b6: "PENDING" }),
    physicalRadioAccessed: false
  });
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  let options;
  try {
    options = parseArguments(argv);
    if (options.mode === "HELP") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.mode === "SELF_TEST") {
      process.stdout.write(`${JSON.stringify(runSupervisorSelfTest(), null, 2)}\n`);
      return 0;
    }
    const report = await executeB5CampaignSupervisorAction(options, runtime);
    assertReportRedacted(report, [
      options.ledger,
      options.state,
      readLedger(options.ledger).campaignRunId
    ]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.campaign?.status === "INVALIDATED") return 1;
    if (report.lastOutcome === "RADIO_TIMEOUT" || report.campaign?.status === "SUSPENDED") {
      return 2;
    }
    return 0;
  } catch (error) {
    const report = failureReport(error);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return error instanceof B5CampaignSupervisorError ? error.exitCode : 1;
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
