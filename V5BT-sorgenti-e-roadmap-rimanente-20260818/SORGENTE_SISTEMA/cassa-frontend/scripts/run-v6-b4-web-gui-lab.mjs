#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { hashPin } from "../backend/auth/password.js";
import {
  startBackend,
  startFrontendServer,
} from "../backend/tests/helpers/test-server.mjs";
import {
  buildB5WebPilotReport,
  runB5WebPilot,
  validateB5WebPilotReport,
} from "./v6-b5-web-pilot.mjs";
import {
  B4_WEB_WORKLOAD_ACTIONS_PER_DEVICE,
  B4_WEB_WORKLOAD_ORDERS_PER_DEVICE,
  B4_WEB_WORKLOAD_PHASE_OFFSET_MS,
  B4_WEB_WORKLOAD_TOTAL_ACTIONS,
  B4_WEB_WORKLOAD_TOTAL_ORDERS,
  buildB4WebWorkloadEnvelope,
  buildB4WebWorkloadRequest,
  runB4WebWorkload,
  validateB4WebWorkloadEnvelope,
  validateB4WebWorkloadRequest,
  validateB4WebWorkloadResult,
} from "./v6-b4-web-workload.mjs";
import { V6_BATTERY_NOTIFICATION_INTERVAL_MS } from "./v6-operations-gates.mjs";
import { V6_DEVICE_ACTION_INTERVAL_MS } from "./v6-operations-scheduler.mjs";

export const HARNESS_VERSION = "1.0.0";
export const WEB_PALMARE_COUNT = 8;
export const PHYSICAL_RECORD_COUNT = 2;
export const LOGICAL_SLOT_COUNT = 10;
export const MODE = "EIGHT_CHROME_GUI_NON_GATE";
export const PRIVATE_UMASK = 0o077;
export const PRIVATE_JSON_MAX_BYTES = 64 * 1024;
export const HEARTBEAT_FRESHNESS_MS = 15_000;
export const WORKLOAD_REQUEST_FRESHNESS_MS = 60_000;
export const LAB_STATION_HEARTBEAT_INTERVAL_MS = 10_000;
export const LAB_STATION_REQUEST_TIMEOUT_MS = 5_000;
export const LAB_STATION_HEARTBEAT_FAILURE_LIMIT = 3;
export const WEB_PALMARE_CONTEXT_OPTIONS = Object.freeze({
  viewport: Object.freeze({ width: 390, height: 844 }),
  screen: Object.freeze({ width: 390, height: 844 }),
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
  locale: "it-IT",
  colorScheme: "light",
});

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const workspaceRoot = path.resolve(projectRoot, "../..");
const runtimeRoot = path.join(
  workspaceRoot,
  ".runtime",
  "cassav6",
  "b4-web-gui",
);
const activePath = path.join(runtimeRoot, "active.json");
const defaultLedgerPath = path.join(
  workspaceRoot,
  ".runtime",
  "cassav6",
  "b4-physical-collection",
  "b4-device-gate-state.json",
);
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class B4WebGuiLabError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "B4WebGuiLabError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new B4WebGuiLabError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireExactKeys(value, keys, code = "REPORT_CONTRACT_INVALID") {
  if (!isPlainObject(value)) fail(code, "Invalid report object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code, "Invalid report keys");
  }
}

function requireExactValue(actual, expected, code = "REPORT_CONTRACT_INVALID") {
  if (actual !== expected) fail(code, "Invalid report value");
}

export function buildWebPalmarePlan(count = WEB_PALMARE_COUNT) {
  if (count !== WEB_PALMARE_COUNT) {
    fail("WEB_PALMARE_COUNT_INVALID", "Exactly eight web Palmare are required");
  }
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const slot = PHYSICAL_RECORD_COUNT + index + 1;
      return Object.freeze({
        ordinal: index + 1,
        slot,
        username: `web_palmare_${String(slot).padStart(2, "0")}`,
        deviceUuid: `v6-b4-web-slot-${String(slot).padStart(2, "0")}`,
        window: Object.freeze({
          left: (index % 4) * 480,
          top: Math.floor(index / 4) * 540,
          width: 480,
          height: 540,
        }),
      });
    }),
  );
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

export function assertSafeRegularFile(stat, expectedMode, code) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail(code, "Private file must be a regular single-link file");
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    fail(code, "Private file must be owned by the current user");
  }
  if ((stat.mode & 0o777) !== expectedMode) {
    fail(code, `Private file mode must be ${expectedMode.toString(8)}`);
  }
}

function ledgerFingerprint(stat, bytes) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o777,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    sha256: sha256(bytes),
  });
}

export async function captureLedgerSnapshot(ledgerPath = defaultLedgerPath) {
  const resolvedPath = path.resolve(ledgerPath);
  let handle;
  let stat;
  let bytes;
  try {
    handle = await fs.open(
      resolvedPath,
      fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW,
    );
    stat = await handle.stat();
    assertSafeRegularFile(stat, 0o600, "LEDGER_SECURITY_INVALID");
    if (stat.size <= 0 || stat.size > 8 * 1024 * 1024) {
      fail("LEDGER_SECURITY_INVALID", "Private ledger size is invalid");
    }
    bytes = await handle.readFile();
    const afterRead = await handle.stat();
    const linked = await fs.lstat(resolvedPath);
    assertSafeRegularFile(afterRead, 0o600, "LEDGER_SECURITY_INVALID");
    assertSafeRegularFile(linked, 0o600, "LEDGER_SECURITY_INVALID");
    if (
      bytes.length !== stat.size ||
      afterRead.dev !== stat.dev ||
      afterRead.ino !== stat.ino ||
      afterRead.size !== stat.size ||
      afterRead.mtimeMs !== stat.mtimeMs ||
      afterRead.ctimeMs !== stat.ctimeMs ||
      linked.dev !== stat.dev ||
      linked.ino !== stat.ino
    ) {
      fail("LEDGER_SECURITY_INVALID", "Private ledger changed during its safe read");
    }
    stat = afterRead;
  } catch (error) {
    if (error instanceof B4WebGuiLabError) throw error;
    if (error?.code === "ELOOP") {
      fail("LEDGER_SECURITY_INVALID", "Private ledger cannot be a symbolic link");
    }
    fail("LEDGER_READ_FAILED", "The private B4 ledger is unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }

  let state;
  try {
    state = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("LEDGER_SCHEMA_INVALID", "The private B4 ledger is not valid JSON");
  }
  if (
    !isPlainObject(state) ||
    state.schemaVersion !== 2 ||
    !Array.isArray(state.records) ||
    state.records.length !== PHYSICAL_RECORD_COUNT
  ) {
    fail(
      "LEDGER_PHYSICAL_COUNT_INVALID",
      "The web lab requires the existing two-record B4 ledger",
    );
  }
  for (let index = 0; index < state.records.length; index += 1) {
    const record = state.records[index];
    if (
      !isPlainObject(record) ||
      record.ordinal !== index + 1 ||
      typeof record.deviceDigest !== "string" ||
      !SHA256_PATTERN.test(record.deviceDigest)
    ) {
      fail("LEDGER_SCHEMA_INVALID", "The private B4 ledger record is invalid");
    }
  }
  return Object.freeze({
    path: resolvedPath,
    physicalRecords: state.records.length,
    fingerprint: ledgerFingerprint(stat, bytes),
  });
}

export function assertLedgerUnchanged(before, after) {
  if (
    before?.path !== after?.path ||
    JSON.stringify(before?.fingerprint) !== JSON.stringify(after?.fingerprint)
  ) {
    fail("LEDGER_CHANGED", "The private B4 ledger changed during the web lab");
  }
  return true;
}

export function buildPublicReport({
  contexts = WEB_PALMARE_COUNT,
  pages = WEB_PALMARE_COUNT,
  sessions = WEB_PALMARE_COUNT,
  ledgerUnchanged = true,
} = {}) {
  const ready =
    contexts === WEB_PALMARE_COUNT &&
    pages === WEB_PALMARE_COUNT &&
    sessions === WEB_PALMARE_COUNT &&
    ledgerUnchanged === true;
  const report = {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    product: "V6",
    phase: "B4",
    mode: MODE,
    evidenceClass: "NON_GATE_EVIDENCE",
    verdict: ready ? "NON_GATE_PASS" : "NON_GATE_FAIL",
    gateImpact: "NONE",
    ledgerObservation: {
      physicalRecordsReadOnly: PHYSICAL_RECORD_COUNT,
      stateByteIdentical: ledgerUnchanged === true,
      physicalEvidenceFilesRead: false,
    },
    browserIsolation: {
      graphical: true,
      browserEngine: "CHROMIUM",
      contexts,
      pages,
      sessions,
      slots: buildWebPalmarePlan().map((entry) => entry.slot),
      isolatedStorage: contexts === WEB_PALMARE_COUNT,
      loopbackOnly: true,
      hardwareAccessed: false,
    },
    logicalCoverage: {
      totalSlots: LOGICAL_SLOT_COUNT,
      physicalSlots: PHYSICAL_RECORD_COUNT,
      webSlots: WEB_PALMARE_COUNT,
      status: ready ? "SIMULATED_10_OF_10" : "INCOMPLETE",
    },
    gates: {
      requiredDistinctPhysicalDevices: LOGICAL_SLOT_COUNT,
      distinctPhysicalDevices: PHYSICAL_RECORD_COUNT,
      simulatedDevicesCountedTowardGate: 0,
      remainingDistinctPhysicalDevices: WEB_PALMARE_COUNT,
      b4TenPhysicalDeviceGate: "PENDING",
      b5HundredSessionGate: "PENDING",
      b6AndroidPairGate: "BLOCKED",
    },
    authorization: {
      b5DiagnosticPilotAuthorized: false,
      b5OfficialCampaignAuthorized: false,
      reasonCode: "FORMAL_B0_B4_PREREQUISITES_NOT_PASSED",
    },
    effects: {
      physicalStateWritten: false,
      simulatedStatePersisted: false,
      authoritativeGateExecuted: false,
      gatePromoted: false,
    },
    privacy: {
      browserIdentifiersIncluded: false,
      usernamesIncluded: false,
      sessionTokensIncluded: false,
      physicalIdentifiersIncluded: false,
      filesystemLocationsIncluded: false,
      physicalHashesIncluded: false,
    },
  };
  return validatePublicReport(report);
}

export function validatePublicReport(report) {
  requireExactKeys(report, [
    "schemaVersion",
    "harnessVersion",
    "product",
    "phase",
    "mode",
    "evidenceClass",
    "verdict",
    "gateImpact",
    "ledgerObservation",
    "browserIsolation",
    "logicalCoverage",
    "gates",
    "authorization",
    "effects",
    "privacy",
  ]);
  requireExactValue(report.schemaVersion, 1);
  requireExactValue(report.harnessVersion, HARNESS_VERSION);
  requireExactValue(report.product, "V6");
  requireExactValue(report.phase, "B4");
  requireExactValue(report.mode, MODE);
  requireExactValue(report.evidenceClass, "NON_GATE_EVIDENCE");
  if (!new Set(["NON_GATE_PASS", "NON_GATE_FAIL"]).has(report.verdict)) {
    fail("REPORT_CONTRACT_INVALID", "Invalid non-gate verdict");
  }
  requireExactValue(report.gateImpact, "NONE");

  requireExactKeys(report.ledgerObservation, [
    "physicalRecordsReadOnly",
    "stateByteIdentical",
    "physicalEvidenceFilesRead",
  ]);
  requireExactValue(report.ledgerObservation.physicalRecordsReadOnly, 2);
  requireExactValue(report.ledgerObservation.physicalEvidenceFilesRead, false);

  requireExactKeys(report.browserIsolation, [
    "graphical",
    "browserEngine",
    "contexts",
    "pages",
    "sessions",
    "slots",
    "isolatedStorage",
    "loopbackOnly",
    "hardwareAccessed",
  ]);
  requireExactValue(report.browserIsolation.graphical, true);
  requireExactValue(report.browserIsolation.browserEngine, "CHROMIUM");
  if (
    !Array.isArray(report.browserIsolation.slots) ||
    report.browserIsolation.slots.length !== 8 ||
    report.browserIsolation.slots.some((slot, index) => slot !== index + 3)
  ) {
    fail("REPORT_CONTRACT_INVALID", "Invalid web slots");
  }
  requireExactValue(report.browserIsolation.loopbackOnly, true);
  requireExactValue(report.browserIsolation.hardwareAccessed, false);

  requireExactKeys(report.logicalCoverage, [
    "totalSlots",
    "physicalSlots",
    "webSlots",
    "status",
  ]);
  requireExactValue(report.logicalCoverage.totalSlots, 10);
  requireExactValue(report.logicalCoverage.physicalSlots, 2);
  requireExactValue(report.logicalCoverage.webSlots, 8);

  requireExactKeys(report.gates, [
    "requiredDistinctPhysicalDevices",
    "distinctPhysicalDevices",
    "simulatedDevicesCountedTowardGate",
    "remainingDistinctPhysicalDevices",
    "b4TenPhysicalDeviceGate",
    "b5HundredSessionGate",
    "b6AndroidPairGate",
  ]);
  for (const [field, expected] of Object.entries({
    requiredDistinctPhysicalDevices: 10,
    distinctPhysicalDevices: 2,
    simulatedDevicesCountedTowardGate: 0,
    remainingDistinctPhysicalDevices: 8,
    b4TenPhysicalDeviceGate: "PENDING",
    b5HundredSessionGate: "PENDING",
    b6AndroidPairGate: "BLOCKED",
  })) {
    requireExactValue(report.gates[field], expected);
  }

  requireExactKeys(report.authorization, [
    "b5DiagnosticPilotAuthorized",
    "b5OfficialCampaignAuthorized",
    "reasonCode",
  ]);
  requireExactValue(report.authorization.b5DiagnosticPilotAuthorized, false);
  requireExactValue(report.authorization.b5OfficialCampaignAuthorized, false);
  requireExactValue(
    report.authorization.reasonCode,
    "FORMAL_B0_B4_PREREQUISITES_NOT_PASSED",
  );

  requireExactKeys(report.effects, [
    "physicalStateWritten",
    "simulatedStatePersisted",
    "authoritativeGateExecuted",
    "gatePromoted",
  ]);
  for (const value of Object.values(report.effects)) requireExactValue(value, false);

  requireExactKeys(report.privacy, [
    "browserIdentifiersIncluded",
    "usernamesIncluded",
    "sessionTokensIncluded",
    "physicalIdentifiersIncluded",
    "filesystemLocationsIncluded",
    "physicalHashesIncluded",
  ]);
  for (const value of Object.values(report.privacy)) requireExactValue(value, false);

  const pass = report.verdict === "NON_GATE_PASS";
  if (
    pass !==
    (report.ledgerObservation.stateByteIdentical === true &&
      report.browserIsolation.contexts === 8 &&
      report.browserIsolation.pages === 8 &&
      report.browserIsolation.sessions === 8 &&
      report.browserIsolation.isolatedStorage === true &&
      report.logicalCoverage.status === "SIMULATED_10_OF_10")
  ) {
    fail("REPORT_CONTRACT_INVALID", "Verdict and evidence do not match");
  }
  return Object.freeze(report);
}

export function assertSafePrivateDirectory(stat) {
  const uid = currentUid();
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("RUNTIME_DIRECTORY_INVALID", "Private runtime directory is invalid");
  }
  if (uid !== null && stat.uid !== uid) {
    fail(
      "RUNTIME_DIRECTORY_INVALID",
      "Private runtime directory must be owned by the current user",
    );
  }
}

export async function ensurePrivateDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const before = await fs.lstat(directoryPath);
  assertSafePrivateDirectory(before);

  let handle;
  try {
    handle = await fs.open(
      directoryPath,
      fsSync.constants.O_RDONLY |
        fsSync.constants.O_DIRECTORY |
        fsSync.constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    assertSafePrivateDirectory(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail(
        "RUNTIME_DIRECTORY_INVALID",
        "Private runtime directory changed during validation",
      );
    }
    if ((opened.mode & 0o777) !== 0o700) await handle.chmod(0o700);
    const secured = await handle.stat();
    assertSafePrivateDirectory(secured);
    if ((secured.mode & 0o777) !== 0o700) {
      fail("RUNTIME_DIRECTORY_INVALID", "Private runtime directory mode must be 700");
    }
    const linked = await fs.lstat(directoryPath);
    assertSafePrivateDirectory(linked);
    if (linked.dev !== secured.dev || linked.ino !== secured.ino) {
      fail(
        "RUNTIME_DIRECTORY_INVALID",
        "Private runtime directory changed while it was being secured",
      );
    }
  } catch (error) {
    if (error instanceof B4WebGuiLabError) throw error;
    fail("RUNTIME_DIRECTORY_INVALID", "Private runtime directory cannot be secured");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWriteJson(filePath, value) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function writeExclusiveJson(filePath, value) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readPrivateJson(filePath) {
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    fail("PRIVATE_FILE_INVALID", "Private JSON file cannot be opened safely");
  }

  try {
    const stat = await handle.stat();
    assertSafeRegularFile(stat, 0o600, "PRIVATE_FILE_INVALID");
    if (stat.size <= 0 || stat.size > PRIVATE_JSON_MAX_BYTES) {
      fail("PRIVATE_FILE_INVALID", "Private JSON file size is invalid");
    }
    const bytes = await handle.readFile();
    if (bytes.length <= 0 || bytes.length > PRIVATE_JSON_MAX_BYTES) {
      fail("PRIVATE_FILE_INVALID", "Private JSON file size changed during read");
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertOwnedServeProcess(pid) {
  let commandLine;
  try {
    commandLine = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    fail("SUPERVISOR_PROCESS_INVALID", "The GUI supervisor process is unavailable");
  }
  if (!commandLine.includes(scriptPath) || !commandLine.includes("--serve")) {
    fail("SUPERVISOR_PROCESS_INVALID", "Refusing to signal an unrelated process");
  }
}

function resolveOwnedRunDirectory(active) {
  const runId = String(active?.runId || "");
  if (!runId || path.basename(runId) !== runId || runId.includes(path.sep)) {
    fail("RUN_DIRECTORY_INVALID", "The private run directory identifier is invalid");
  }
  const runDir = path.resolve(runtimeRoot, runId);
  if (path.dirname(runDir) !== runtimeRoot) {
    fail("RUN_DIRECTORY_INVALID", "The private run directory is outside the lab root");
  }
  return runDir;
}

async function findChromeExecutable() {
  const candidates = [
    process.env.V6_B4_WEB_GUI_CHROME,
    process.env.LOADTEST_CHROMIUM_EXECUTABLE_PATH,
    path.join(
      os.homedir(),
      ".cache",
      "ms-playwright",
      "chromium-1223",
      "chrome-linux64",
      "chrome",
    ),
  ].filter(Boolean);
  const cacheRoot = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    const entries = await fs.readdir(cacheRoot);
    for (const entry of entries.sort().reverse()) {
      if (!entry.startsWith("chromium-")) continue;
      candidates.push(path.join(cacheRoot, entry, "chrome-linux64", "chrome"));
    }
  } catch {
    // The explicit candidates still provide a deterministic fallback.
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsSync.constants.X_OK);
      const stat = await fs.lstat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next local browser candidate.
    }
  }
  fail("CHROMIUM_NOT_FOUND", "A local graphical Chromium executable is required");
}

export function seedWebPalmari(state, plan) {
  const now = nowIso();
  const roomIds = ["room_pedana", "room_sala", "sala_terrazza"];
  for (const entry of plan) {
    state.users.push({
      id: `u_${entry.username}`,
      username: entry.username,
      fullName: `Palmare Web ${String(entry.slot).padStart(2, "0")}`,
      role: "operator",
      roleLabel: "Operatore",
      permissions: [
        "collect_payments",
        "print_orders",
        "create_bar_replacement",
        "counter_mode",
        "manage_tables",
      ],
      authorizedRoomIds: roomIds,
      enabledRoomIds: roomIds,
      enabledAppIds: ["palmare"],
      pinHash: hashPin("1234"),
      createdAt: now,
      updatedAt: now,
    });
    state.posSettings.mobileDevices.push({
      id: entry.deviceUuid,
      deviceId: entry.deviceUuid,
      name: `Palmare Web ${String(entry.slot).padStart(2, "0")}`,
      fiscalEnabled: false,
      electronicPaymentEnabled: false,
      cashPaymentEnabled: false,
    });
  }
}

function requestAllowed(urlValue) {
  try {
    const url = new URL(urlValue);
    if (new Set(["data:", "blob:", "about:"]).has(url.protocol)) return true;
    return new Set(["http:", "https:", "ws:", "wss:"]).has(url.protocol)
      ? LOOPBACK_NAMES.has(url.hostname)
      : false;
  } catch {
    return false;
  }
}

async function readLoopbackJsonResponse(response, code) {
  let body;
  try {
    body = await response.json();
  } catch {
    fail(code, "The isolated station returned an invalid response");
  }
  if (!response.ok || body?.ok === false) {
    fail(code, "The isolated station request was rejected");
  }
  return body;
}

export async function startIsolatedStationHeartbeat(
  backendOrigin,
  {
    fetchImpl = fetch,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    onFailure = () => undefined,
    deviceUuid = `v6-b4-station-${crypto.randomBytes(12).toString("hex")}`,
  } = {},
) {
  const origin = new URL(backendOrigin);
  if (!LOOPBACK_NAMES.has(origin.hostname)) {
    fail("LAB_STATION_ORIGIN_INVALID", "The isolated station must use loopback only");
  }
  const request = async (pathname, payload, token = "") => {
    const controller = new AbortController();
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(
          new B4WebGuiLabError(
            "LAB_STATION_REQUEST_TIMEOUT",
            "The isolated station request timed out",
          ),
        );
      }, LAB_STATION_REQUEST_TIMEOUT_MS);
      timeout.unref?.();
    });
    let response;
    try {
      response = await Promise.race([
        fetchImpl(new URL(pathname, origin), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeout);
    }
    return readLoopbackJsonResponse(response, "LAB_STATION_REQUEST_FAILED");
  };

  const login = await request("/api/auth/login", {
    username: "cashier",
    pin: "2222",
    deviceUuid,
    clientApp: "postazione",
  });
  const token = String(login?.token || "");
  const userId = String(login?.user?.id || "");
  if (token.length < 16 || !userId) {
    fail("LAB_STATION_LOGIN_FAILED", "The isolated station session is invalid");
  }
  await request(
    "/api/auth/workstation/select",
    {
      token,
      userId,
      deviceUuid,
      clientApp: "postazione",
      workstationId: "workstation_bar_1",
      stationName: "BAR-1",
    },
    token,
  );

  let closed = false;
  let consecutiveFailures = 0;
  let tail = Promise.resolve();
  const postHeartbeat = async (active) => {
    const result = await request(
      "/api/integration/stations/state",
      {
        token,
        userId,
        deviceUuid,
        clientApp: "postazione",
        station: "BAR-1",
        active,
      },
      token,
    );
    if (active) {
      const station = result?.station;
      if (
        station?.station !== "BAR-1" ||
        station?.active !== true ||
        station?.realStation !== true ||
        station?.deviceUuid !== deviceUuid
      ) {
        fail(
          "LAB_STATION_HEARTBEAT_REJECTED",
          "The isolated station heartbeat was not accepted as a real active station",
        );
      }
    }
    return result;
  };
  const heartbeatNow = (active = true) => {
    const next = tail.then(() => postHeartbeat(active));
    tail = next.catch(() => undefined);
    return next;
  };
  await heartbeatNow(true);
  const runScheduledHeartbeat = async () => {
    if (closed) return;
    try {
      await heartbeatNow(true);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures === LAB_STATION_HEARTBEAT_FAILURE_LIMIT) onFailure(error);
    }
  };
  const timer = setIntervalImpl(runScheduledHeartbeat, LAB_STATION_HEARTBEAT_INTERVAL_MS);
  timer?.unref?.();

  return {
    heartbeatNow,
    close: async () => {
      if (closed) return;
      closed = true;
      clearIntervalImpl(timer);
      await tail.catch(() => undefined);
      await heartbeatNow(false).catch(() => undefined);
    },
  };
}

async function positionWindow(context, page, bounds) {
  const session = await context.newCDPSession(page);
  try {
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { ...bounds, windowState: "normal" },
    });
  } finally {
    await session.detach();
  }
}

async function loginWebPalmare(browser, frontendUrl, entry, privateDir, stopLab) {
  const context = await browser.newContext(WEB_PALMARE_CONTEXT_OPTIONS);
  let intentionalClose = false;
  const diagnostics = { blockedRequests: 0, pageErrors: 0 };
  await context.route("**/*", async (route) => {
    if (requestAllowed(route.request().url())) {
      await route.continue();
      return;
    }
    diagnostics.blockedRequests += 1;
    await route.abort("blockedbyclient");
  });
  await context.addInitScript((uuid) => {
    window.localStorage.setItem("pos_device_uuid", uuid);
  }, entry.deviceUuid);
  const page = await context.newPage();
  context.on("page", (openedPage) => {
    if (openedPage !== page) stopLab("EXTRA_PAGE_OPENED");
  });
  page.on("pageerror", () => {
    diagnostics.pageErrors += 1;
    stopLab("PAGE_ERROR");
  });
  page.on("close", () => {
    if (!intentionalClose) stopLab("PAGE_CLOSED");
  });
  const response = await page.goto(`${frontendUrl}/mobile/`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  if (response?.status() !== 200) {
    fail("MOBILE_FRONTEND_UNAVAILABLE", "The isolated mobile frontend did not load");
  }
  await positionWindow(context, page, entry.window);
  await page.getByPlaceholder("Username").fill(entry.username);
  await page.getByPlaceholder("PIN").fill("1234");
  // The SPA can replace the login route while background requests are still
  // open; session readiness below is the authoritative completion signal.
  await page
    .getByRole("button", { name: /Entra/i })
    .click({ noWaitAfter: true, timeout: 20_000 });
  await page.waitForFunction(
    () =>
      Boolean(
        window.localStorage.getItem("pos_token") &&
          window.localStorage.getItem("pos_user_id") &&
          window.localStorage.getItem("pos_device_uuid"),
      ),
    undefined,
    { timeout: 60_000 },
  );
  const appReady = page
    .getByRole("button", { name: /Operatore .*Server connesso/i })
    .or(page.locator(".system-status"))
    .first();
  try {
    await appReady.waitFor({ state: "visible", timeout: 20_000 });
  } catch (error) {
    const hasSession = await page.evaluate(() =>
      Boolean(
        window.localStorage.getItem("pos_token") &&
          window.localStorage.getItem("pos_user_id"),
      ),
    );
    if (!hasSession) throw error;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    await appReady.waitFor({ state: "visible", timeout: 20_000 });
  }
  await page.waitForTimeout(500);
  const identity = await page.evaluate(() => ({
    deviceUuid: window.localStorage.getItem("pos_device_uuid") || "",
    token: window.localStorage.getItem("pos_token") || "",
    userId: window.localStorage.getItem("pos_user_id") || "",
  }));
  if (
    identity.deviceUuid !== entry.deviceUuid ||
    identity.token.length < 16 ||
    identity.userId.length === 0
  ) {
    fail("WEB_SESSION_INVALID", "A web Palmare session is not isolated or authenticated");
  }
  await page.evaluate((slot) => {
    document.title = `V6 Palmare Web ${String(slot).padStart(2, "0")}`;
  }, entry.slot);
  const screenshotPath = path.join(
    privateDir,
    `palmare-web-${String(entry.slot).padStart(2, "0")}.png`,
  );
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await fs.chmod(screenshotPath, 0o600);
  return {
    context,
    page,
    identity,
    diagnostics,
    close: async () => {
      intentionalClose = true;
      await context.close();
    },
  };
}

function heartbeatFresh(active, nowMs = Date.now()) {
  const heartbeatMs = Date.parse(String(active?.heartbeatAt || ""));
  if (!Number.isFinite(heartbeatMs)) return false;
  const ageMs = nowMs - heartbeatMs;
  return ageMs >= 0 && ageMs <= HEARTBEAT_FRESHNESS_MS;
}

export function assertFreshWorkloadRequest(request, nowMs = Date.now()) {
  const requestedAtMs = Date.parse(String(request?.requestedAt || ""));
  const requestAgeMs = nowMs - requestedAtMs;
  if (
    !Number.isFinite(requestedAtMs) ||
    requestAgeMs < 0 ||
    requestAgeMs > WORKLOAD_REQUEST_FRESHNESS_MS
  ) {
    fail(
      "WEB_WORKLOAD_REQUEST_STALE",
      "The workload request is stale; start a new isolated graphical run",
    );
  }
  return true;
}

export function countHealthySinglePageDevices(devices) {
  return devices.filter((device) => {
    if (device.page.isClosed()) return false;
    const pages = device.context.pages();
    return pages.length === 1 && pages[0] === device.page && !pages[0].isClosed();
  }).length;
}

export function publicStatus(active) {
  const alive = processAlive(Number(active?.pid));
  const operational = alive && active?.status === "ACTIVE" && heartbeatFresh(active);
  const readyWebPalmari = operational
    ? Number(active?.readyWebPalmari) || 0
    : 0;
  const pilotStatus = new Set(["NOT_RUN", "NON_GATE_PASS", "NON_GATE_FAIL"]).has(
    active?.b5WebPilotStatus,
  )
    ? active.b5WebPilotStatus
    : "NOT_RUN";
  let workloadStatus = new Set([
    "NOT_RUN",
    "RUNNING",
    "NON_GATE_PASS",
    "NON_GATE_FAIL",
  ]).has(active?.webWorkloadStatus)
    ? active.webWorkloadStatus
    : "NOT_RUN";
  if (!operational && workloadStatus === "RUNNING") workloadStatus = "NON_GATE_FAIL";
  const completedActions = Math.max(
    0,
    Math.min(B4_WEB_WORKLOAD_TOTAL_ACTIONS, Number(active?.webWorkloadActionsCompleted) || 0),
  );
  const completedOrders = Math.max(
    0,
    Math.min(B4_WEB_WORKLOAD_TOTAL_ORDERS, Number(active?.webWorkloadOrdersCompleted) || 0),
  );
  return {
    product: "V6",
    phase: "B4",
    mode: MODE,
    status: operational
      ? "ACTIVE"
      : active?.status === "STOPPED"
        ? "STOPPED"
        : "INACTIVE",
    graphical: true,
    webPalmari: `${readyWebPalmari}/${WEB_PALMARE_COUNT}`,
    logicalCoverage:
      readyWebPalmari === WEB_PALMARE_COUNT
        ? "SIMULATED_10_OF_10"
        : "INCOMPLETE",
    officialPhysicalLedger: "2/10",
    ledgerUnchanged: operational && active?.ledgerUnchanged === true,
    b4OfficialStatus: "PENDING",
    b5Authorized: false,
    b5WebPilotStatus: pilotStatus,
    webWorkloadStatus: workloadStatus,
    webWorkloadProgress: {
      completedActions,
      totalActions: B4_WEB_WORKLOAD_TOTAL_ACTIONS,
      completedOrders,
      totalOrders: B4_WEB_WORKLOAD_TOTAL_ORDERS,
    },
    frontendUrl: operational ? String(active?.frontendUrl ?? "") : "",
  };
}

async function readActiveOrNull() {
  try {
    return await readPrivateJson(activePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function startSupervisor() {
  await ensurePrivateDirectory(runtimeRoot);
  const current = await readActiveOrNull();
  if (current && processAlive(Number(current.pid))) {
    console.log(JSON.stringify(publicStatus(current), null, 2));
    return;
  }

  const runId = `${nowIso().replace(/[-:.]/gu, "").replace("Z", "Z")}-${crypto
    .randomBytes(5)
    .toString("hex")}`;
  const runDir = path.join(runtimeRoot, runId);
  await ensurePrivateDirectory(runDir);
  const logPath = path.join(runDir, "supervisor.log");
  const logFd = fsSync.openSync(logPath, "wx", 0o600);
  const child = spawn(process.execPath, [scriptPath, "--serve", "--run-dir", runDir], {
    cwd: projectRoot,
    detached: true,
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" },
    stdio: ["ignore", logFd, logFd],
  });
  fsSync.closeSync(logFd);
  child.unref();

  const readyPath = path.join(runDir, "ready.json");
  const errorPath = path.join(runDir, "error.json");
  // Eight independent PIN verifications are intentionally serialized so the
  // lab does not create a CPU burst on the workstation.
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (!processAlive(child.pid)) {
      let detail = "The graphical web lab exited before becoming ready";
      try {
        detail = (await readPrivateJson(errorPath)).message || detail;
      } catch {
        // The private supervisor log retains the diagnostic details.
      }
      fail("SUPERVISOR_START_FAILED", detail);
    }
    try {
      await readPrivateJson(readyPath);
      const active = await readPrivateJson(activePath);
      console.log(JSON.stringify(publicStatus(active), null, 2));
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(250);
  }
  await assertOwnedServeProcess(child.pid);
  process.kill(child.pid, "SIGTERM");
  fail("SUPERVISOR_START_TIMEOUT", "The graphical web lab did not become ready in time");
}

async function statusSupervisor() {
  const active = await readActiveOrNull();
  console.log(
    JSON.stringify(
      active
        ? publicStatus(active)
        : {
            product: "V6",
            phase: "B4",
            mode: MODE,
            status: "INACTIVE",
            graphical: true,
            webPalmari: "0/8",
            logicalCoverage: "INCOMPLETE",
            officialPhysicalLedger: "2/10",
            ledgerUnchanged: false,
            b4OfficialStatus: "PENDING",
            b5Authorized: false,
            b5WebPilotStatus: "NOT_RUN",
            webWorkloadStatus: "NOT_RUN",
            webWorkloadProgress: {
              completedActions: 0,
              totalActions: B4_WEB_WORKLOAD_TOTAL_ACTIONS,
              completedOrders: 0,
              totalOrders: B4_WEB_WORKLOAD_TOTAL_ORDERS,
            },
            frontendUrl: "",
          },
      null,
      2,
    ),
  );
}

async function pilotSupervisor() {
  const active = await readActiveOrNull();
  const pid = Number(active?.pid);
  if (
    !active ||
    !processAlive(pid) ||
    active.status !== "ACTIVE" ||
    active.readyWebPalmari !== WEB_PALMARE_COUNT ||
    !heartbeatFresh(active) ||
    active.ledgerUnchanged !== true
  ) {
    fail("B5_WEB_PILOT_LAB_NOT_READY", "The eight-Palmare graphical lab is not active");
  }
  if (active.webWorkloadStatus === "RUNNING") {
    fail("B5_WEB_PILOT_BUSY", "The graphical workload is already running");
  }
  await assertOwnedServeProcess(pid);
  const runDir = resolveOwnedRunDirectory(active);
  const requestPath = path.join(runDir, "b5-web-pilot-request.json");
  const resultPath = path.join(runDir, "b5-web-pilot-result.json");
  try {
    const existing = validateB5WebPilotReport(await readPrivateJson(resultPath));
    console.log(JSON.stringify(existing, null, 2));
    if (existing.verdict !== "NON_GATE_PASS") process.exitCode = 1;
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await writeExclusiveJson(requestPath, {
      schemaVersion: 1,
      mode: "B5_7_WEB_GUI_LOOPBACK_DIAGNOSTIC_REQUEST",
      requestedAt: nowIso(),
      requestNonce: crypto.randomBytes(24).toString("base64url"),
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      fail("B5_WEB_PILOT_LAB_STOPPED", "The graphical lab stopped during the pilot");
    }
    try {
      const report = validateB5WebPilotReport(await readPrivateJson(resultPath));
      console.log(JSON.stringify(report, null, 2));
      if (report.verdict !== "NON_GATE_PASS") process.exitCode = 1;
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(250);
  }
  fail("B5_WEB_PILOT_TIMEOUT", "The graphical B5.7 diagnostic did not finish in time");
}

async function workloadSupervisor() {
  const active = await readActiveOrNull();
  const pid = Number(active?.pid);
  if (
    !active ||
    !processAlive(pid) ||
    active.status !== "ACTIVE" ||
    active.readyWebPalmari !== WEB_PALMARE_COUNT ||
    active.ledgerUnchanged !== true ||
    !heartbeatFresh(active)
  ) {
    fail("WEB_WORKLOAD_LAB_NOT_READY", "The eight-Palmare graphical lab is not active");
  }
  await assertOwnedServeProcess(pid);
  const runDir = resolveOwnedRunDirectory(active);
  const requestPath = path.join(runDir, "b4-web-workload-request.json");
  const envelopePath = path.join(runDir, "b4-web-workload-envelope.json");
  const resultPath = path.join(runDir, "b4-web-workload-result.json");

  let request;
  try {
    request = validateB4WebWorkloadRequest(await readPrivateJson(requestPath));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    request = buildB4WebWorkloadRequest();
    await writeExclusiveJson(requestPath, request);
  }
  let envelope;
  try {
    envelope = validateB4WebWorkloadEnvelope(
      await readPrivateJson(envelopePath),
      request,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    envelope = buildB4WebWorkloadEnvelope(request);
    await writeExclusiveJson(envelopePath, envelope);
  }

  try {
    const existing = validateB4WebWorkloadResult(await readPrivateJson(resultPath), {
      request,
      envelope,
    });
    console.log(JSON.stringify(existing.report, null, 2));
    if (existing.report.verdict !== "NON_GATE_PASS") process.exitCode = 1;
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  assertFreshWorkloadRequest(request);

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      fail("WEB_WORKLOAD_LAB_STOPPED", "The graphical lab stopped during the workload");
    }
    try {
      const result = validateB4WebWorkloadResult(await readPrivateJson(resultPath), {
        request,
        envelope,
      });
      console.log(JSON.stringify(result.report, null, 2));
      if (result.report.verdict !== "NON_GATE_PASS") process.exitCode = 1;
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(250);
  }
  fail("WEB_WORKLOAD_TIMEOUT", "The eight-Palmare DOM workload did not finish in time");
}

async function stopSupervisor() {
  const active = await readActiveOrNull();
  const pid = Number(active?.pid);
  if (!active || !processAlive(pid)) {
    console.log(JSON.stringify(publicStatus(active ?? {}), null, 2));
    return;
  }
  await assertOwnedServeProcess(pid);
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 20_000;
  while (processAlive(pid) && Date.now() < deadline) await sleep(100);
  if (processAlive(pid)) {
    await assertOwnedServeProcess(pid);
    process.kill(-pid, "SIGKILL");
  }
  const stopped = await readActiveOrNull();
  console.log(JSON.stringify(publicStatus(stopped ?? {}), null, 2));
}

async function serveSupervisor(runDirValue) {
  process.umask(PRIVATE_UMASK);
  const runDir = path.resolve(runDirValue || "");
  if (!runDir.startsWith(`${runtimeRoot}${path.sep}`)) {
    fail("RUN_DIRECTORY_INVALID", "The private run directory is outside the lab root");
  }
  const plan = buildWebPalmarePlan();
  const baseline = await captureLedgerSnapshot(defaultLedgerPath);
  const chromePath = await findChromeExecutable();
  const backendRunDir = path.join(runDir, "backend");
  const screenshotsDir = path.join(runDir, "screenshots");
  await ensurePrivateDirectory(backendRunDir);
  await ensurePrivateDirectory(screenshotsDir);

  let backend = null;
  let frontend = null;
  let browser = null;
  let stationHeartbeat = null;
  const devices = [];
  let stopping = false;
  let stopReason = "STOPPED";
  let activeOperation = null;
  let workloadAbortController = null;
  let workloadPromise = null;
  let activeWriteTail = Promise.resolve();
  let resolveStop;
  const stopped = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const stopLab = (reason) => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    workloadAbortController?.abort();
    resolveStop();
  };
  process.once("SIGINT", () => stopLab("STOPPED"));
  process.once("SIGTERM", () => stopLab("STOPPED"));

  const startedAt = nowIso();
  let monitor = null;
  try {
    backend = await startBackend(null, {
      runDir: backendRunDir,
      dbPath: path.join(backendRunDir, "app-state.json"),
      stateOverrides: (state) => seedWebPalmari(state, plan),
    });
    stationHeartbeat = await startIsolatedStationHeartbeat(backend.baseUrl, {
      onFailure: (error) => {
        console.error(error);
        stopLab("LAB_STATION_HEARTBEAT_FAILED");
      },
    });
    frontend = await startFrontendServer(null, { backendOrigin: backend.baseUrl });
    browser = await chromium.launch({
      headless: false,
      executablePath: chromePath,
      args: [
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--no-default-browser-check",
        "--no-first-run",
      ],
    });
    browser.on("disconnected", () => stopLab("BROWSER_DISCONNECTED"));

    for (const entry of plan) {
      const device = await loginWebPalmare(
        browser,
        frontend.baseUrl,
        entry,
        screenshotsDir,
        stopLab,
      );
      devices.push(device);
    }

    const uuids = new Set(devices.map((device) => device.identity.deviceUuid));
    const tokens = new Set(devices.map((device) => device.identity.token));
    const users = new Set(devices.map((device) => device.identity.userId));
    if (
      uuids.size !== WEB_PALMARE_COUNT ||
      tokens.size !== WEB_PALMARE_COUNT ||
      users.size !== WEB_PALMARE_COUNT ||
      countHealthySinglePageDevices(devices) !== WEB_PALMARE_COUNT
    ) {
      fail("WEB_SESSION_COLLISION", "The eight web Palmare sessions are not unique");
    }
    const currentLedger = await captureLedgerSnapshot(defaultLedgerPath);
    assertLedgerUnchanged(baseline, currentLedger);
    const report = buildPublicReport({ ledgerUnchanged: true });
    await writeExclusiveJson(path.join(runDir, "public-report.json"), report);

    let active = {
      schemaVersion: 1,
      product: "V6",
      phase: "B4",
      mode: MODE,
      status: "ACTIVE",
      pid: process.pid,
      runId: path.basename(runDir),
      startedAt,
      heartbeatAt: nowIso(),
      frontendUrl: `${frontend.baseUrl}/mobile/`,
      expectedWebPalmari: WEB_PALMARE_COUNT,
      readyWebPalmari: devices.length,
      logicalCoverage: "SIMULATED_10_OF_10",
      officialPhysicalRecords: PHYSICAL_RECORD_COUNT,
      officialB4Status: "PENDING",
      ledgerUnchanged: true,
      b5WebPilotStatus: "NOT_RUN",
      webWorkloadStatus: "NOT_RUN",
      webWorkloadActionsCompleted: 0,
      webWorkloadOrdersCompleted: 0,
    };
    await atomicWriteJson(activePath, active);
    await writeExclusiveJson(path.join(runDir, "ready.json"), {
      schemaVersion: 1,
      status: "ACTIVE",
      readyWebPalmari: devices.length,
    });

    const updateActive = async (patch) => {
      active = { ...active, ...patch };
      const snapshot = active;
      const write = activeWriteTail.then(() => atomicWriteJson(activePath, snapshot));
      activeWriteTail = write.catch(() => undefined);
      await write;
    };

    let monitorBusy = false;
    monitor = setInterval(async () => {
      if (monitorBusy) return;
      monitorBusy = true;
      try {
        const latest = await captureLedgerSnapshot(defaultLedgerPath);
        assertLedgerUnchanged(baseline, latest);
        const openDevices = countHealthySinglePageDevices(devices);
        if (openDevices !== WEB_PALMARE_COUNT) {
          stopLab("WEB_DEVICE_CLOSED");
          return;
        }
        const pilotRequestPath = path.join(runDir, "b5-web-pilot-request.json");
        const pilotResultPath = path.join(runDir, "b5-web-pilot-result.json");
        let pilotRequested = false;
        try {
          await readPrivateJson(pilotRequestPath);
          pilotRequested = true;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        if (pilotRequested && activeOperation === null) {
          let hasResult = false;
          try {
            validateB5WebPilotReport(await readPrivateJson(pilotResultPath));
            hasResult = true;
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          if (!hasResult) {
            activeOperation = "PILOT";
            let pilotReport;
            try {
              pilotReport = await runB5WebPilot(devices[0].page);
            } catch (error) {
              console.error(error);
              pilotReport = buildB5WebPilotReport({
                reachedActive: false,
                pingPongCount: 0,
                closeAckCount: 0,
                errors: 1,
                connectionsAfterCleanup: 0,
                browserSessionPreserved: false,
              });
            }
            await writeExclusiveJson(pilotResultPath, pilotReport);
            await updateActive({
              b5WebPilotStatus: pilotReport.verdict,
            });
            activeOperation = null;
          }
        }

        const workloadRequestPath = path.join(runDir, "b4-web-workload-request.json");
        const workloadEnvelopePath = path.join(runDir, "b4-web-workload-envelope.json");
        const workloadResultPath = path.join(runDir, "b4-web-workload-result.json");
        let workloadRequest = null;
        let workloadEnvelope = null;
        try {
          workloadRequest = validateB4WebWorkloadRequest(
            await readPrivateJson(workloadRequestPath),
          );
          workloadEnvelope = validateB4WebWorkloadEnvelope(
            await readPrivateJson(workloadEnvelopePath),
            workloadRequest,
          );
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          workloadRequest = null;
          workloadEnvelope = null;
        }
        if (workloadRequest && workloadEnvelope && activeOperation === null) {
          let hasWorkloadResult = false;
          try {
            validateB4WebWorkloadResult(await readPrivateJson(workloadResultPath), {
              request: workloadRequest,
              envelope: workloadEnvelope,
            });
            hasWorkloadResult = true;
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          if (!hasWorkloadResult) {
            assertFreshWorkloadRequest(workloadRequest);
            activeOperation = "WORKLOAD";
            workloadAbortController = new AbortController();
            await updateActive({
              webWorkloadStatus: "RUNNING",
              webWorkloadActionsCompleted: 0,
              webWorkloadOrdersCompleted: 0,
            });
            workloadPromise = (async () => {
              try {
                const result = await runB4WebWorkload(
                  devices.map((device) => device.page),
                  {
                    request: workloadRequest,
                    envelope: workloadEnvelope,
                    signal: workloadAbortController.signal,
                    privateArtifactsDir: path.join(screenshotsDir, "workload"),
                    onProgress: ({ completedActions, completedOrders }) => {
                      active = {
                        ...active,
                        webWorkloadActionsCompleted: completedActions,
                        webWorkloadOrdersCompleted: completedOrders,
                      };
                    },
                    verifyLedgerUnchanged: async () => {
                      const after = await captureLedgerSnapshot(defaultLedgerPath);
                      return assertLedgerUnchanged(baseline, after);
                    },
                  },
                );
                await writeExclusiveJson(workloadResultPath, result);
                await updateActive({
                  webWorkloadStatus: result.report.verdict,
                  webWorkloadActionsCompleted: result.report.execution.completedActions,
                  webWorkloadOrdersCompleted: result.report.execution.completedOrders,
                });
              } catch (error) {
                console.error(error);
                await updateActive({ webWorkloadStatus: "NON_GATE_FAIL" }).catch(
                  () => undefined,
                );
                stopLab(error?.code || "WEB_WORKLOAD_FAILED");
              } finally {
                activeOperation = null;
                workloadAbortController = null;
              }
            })();
          }
        }
        await updateActive({
          heartbeatAt: nowIso(),
          readyWebPalmari: openDevices,
        });
      } catch (error) {
        console.error(error);
        stopLab(error?.code || "MONITOR_FAILED");
      } finally {
        monitorBusy = false;
      }
    }, 5_000);
    monitor.unref();
    await stopped;
  } catch (error) {
    stopReason = error?.code || "START_FAILED";
    try {
      await writeExclusiveJson(path.join(runDir, "error.json"), {
        schemaVersion: 1,
        code: stopReason,
        message: String(error?.message || "The graphical web lab failed"),
      });
    } catch {
      // Keep the original failure as the primary diagnostic.
    }
    throw error;
  } finally {
    stopping = true;
    if (monitor) clearInterval(monitor);
    workloadAbortController?.abort();
    await workloadPromise?.catch(() => undefined);
    await activeWriteTail.catch(() => undefined);
    for (const device of devices.reverse()) {
      await device.close().catch(() => undefined);
    }
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
    if (frontend?.child && !frontend.child.killed) frontend.child.kill("SIGTERM");
    await stationHeartbeat?.close().catch(() => undefined);
    if (backend?.child && !backend.child.killed) backend.child.kill("SIGTERM");
    const previous = await readActiveOrNull().catch(() => null);
    if (Number(previous?.pid) === process.pid) {
      await atomicWriteJson(activePath, {
        ...previous,
        status: stopReason === "STOPPED" ? "STOPPED" : "INVALIDATED",
        heartbeatAt: nowIso(),
        frontendUrl: "",
        readyWebPalmari: 0,
        stopReason,
      }).catch(() => undefined);
    }
  }
}

function dryRun() {
  console.log(
    JSON.stringify(
      {
        product: "V6",
        phase: "B4",
        mode: MODE,
        evidenceClass: "NON_GATE_EVIDENCE",
        graphical: true,
        browserEngine: "CHROMIUM",
        webPalmari: WEB_PALMARE_COUNT,
        slots: buildWebPalmarePlan().map((entry) => entry.slot),
        loopbackOnly: true,
        hardwareAccessed: false,
        officialPhysicalLedger: "2/10",
        b4OfficialStatus: "PENDING",
        b5Authorized: false,
        workload: {
          evidenceClass: "NON_GATE_EVIDENCE",
          actionsPerPalmare: B4_WEB_WORKLOAD_ACTIONS_PER_DEVICE,
          totalActions: B4_WEB_WORKLOAD_TOTAL_ACTIONS,
          ordersPerPalmare: B4_WEB_WORKLOAD_ORDERS_PER_DEVICE,
          totalOrders: B4_WEB_WORKLOAD_TOTAL_ORDERS,
          actionIntervalMs: V6_DEVICE_ACTION_INTERVAL_MS,
          phaseOffsetMs: B4_WEB_WORKLOAD_PHASE_OFFSET_MS,
          batteryIntervalMs: V6_BATTERY_NOTIFICATION_INTERVAL_MS,
        },
      },
      null,
      2,
    ),
  );
}

function usage() {
  console.error(
    "Usage: node scripts/run-v6-b4-web-gui-lab.mjs --start|--status|--pilot|--workload|--stop|--dry-run",
  );
}

async function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "--start" && rest.length === 0) return startSupervisor();
  if (mode === "--status" && rest.length === 0) return statusSupervisor();
  if (mode === "--pilot" && rest.length === 0) return pilotSupervisor();
  if (mode === "--workload" && rest.length === 0) return workloadSupervisor();
  if (mode === "--stop" && rest.length === 0) return stopSupervisor();
  if (mode === "--dry-run" && rest.length === 0) return dryRun();
  if (mode === "--serve" && rest[0] === "--run-dir" && rest.length === 2) {
    return serveSupervisor(rest[1]);
  }
  usage();
  process.exitCode = 2;
}

if (path.resolve(process.argv[1] || "") === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`${error?.code || "B4_WEB_GUI_LAB_FAILED"}: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
