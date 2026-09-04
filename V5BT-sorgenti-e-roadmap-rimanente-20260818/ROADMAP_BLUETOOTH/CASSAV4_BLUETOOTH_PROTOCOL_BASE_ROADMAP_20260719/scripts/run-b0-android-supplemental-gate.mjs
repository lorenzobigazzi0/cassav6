#!/usr/bin/env node

import childProcess from "node:child_process";
import crypto from "node:crypto";
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
  parseDiscoveryStatus
} from "./run-b2-android-adb-harness.mjs";
import {
  B3_FGS_TYPE_CONNECTED_DEVICE,
  B3_FGS_TYPE_DATA_SYNC,
  parseCurrentUser,
  parseForegroundServiceDump,
  parseInstalledApkPath,
  parseInstalledApkSha256,
  parseInstalledVersion,
  permissionGrantedForUser
} from "./run-b3-android-service-gate.mjs";
import {
  buildRunAsArgs,
  parseAgentReporter,
  parseAndroidApi,
  parseApplicationExitCommitments,
  parseAuthenticatedSessionPreferences,
  parseGattReporter,
  parsePid,
  sessionBindingHmac
} from "./run-b5-android-continuity-monitor.mjs";

export const B0_ANDROID_SUPPLEMENTAL_VERSION = "1.0.0";
export const B0_CAPTURE_DURATION_SECONDS = 120;
export const B0_FOREGROUND_DURATION_SECONDS = 30;
export const B0_BACKGROUND_DURATION_SECONDS = 90;
export const B0_POLL_INTERVAL_MS = 5_000;
export const B0_REQUIRED_CONTROLS = Object.freeze([
  "scan",
  "advertise",
  "gattClient",
  "gattServer",
  "scanAdvertiseConcurrent",
  "wifiBleCoexistence",
  "backgroundForeground"
]);

const execFileAsync = promisify(childProcess.execFile);
const TARGET = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;
const SERIAL_PATTERN = /^[!-~]{1,200}$/u;
const COMPONENT_PATTERN =
  /^[A-Za-z][A-Za-z0-9_.]*\/(?:\.[A-Za-z][A-Za-z0-9_.$]*|[A-Za-z][A-Za-z0-9_.$]*)$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CAPABILITY_MAX_BYTES = 16 * 1024;
const ADB_MAX_BYTES = 256 * 1024;
const ADB_TIMEOUT_MS = 15_000;
const REPORTER_FRESHNESS_MS = 10_000;
const CLOCK_SKEW_MS = 30_000;
const MAX_POLL_GAP_MS = 12_000;
const BACKGROUND_SETTLE_MS = 2_000;
const DISCOVERY_STATUS_FILE = "no_backup/bluetooth-discovery-status-v1.json";
const AGENT_STATUS_FILE = "no_backup/bluetooth-connectivity-agent-status-v1.json";
const GATT_STATUS_FILE = "no_backup/bluetooth-gatt-client-status-v1.json";
const SESSION_PREFS_FILE = "shared_prefs/webkiosk_prefs.xml";
const BLUETOOTH_PERMISSIONS = Object.freeze([
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.BLUETOOTH_CONNECT"
]);
const CAPABILITY_FIELDS = Object.freeze([
  "manufacturer",
  "model",
  "androidApi",
  "bluetoothLeFeature",
  "adapterPresent",
  "adapterEnabled",
  "scanPermission",
  "advertisePermission",
  "connectPermission",
  "scannerAvailable",
  "advertiserAvailable",
  "gattClientAvailable",
  "multipleAdvertisementSupported",
  "offloadedFilteringSupported",
  "offloadedScanBatchingSupported",
  "gattServerOpen",
  "probeStatus",
  "scan",
  "advertise",
  "gattClient",
  "gattServer",
  "classification",
  "b0GateComplete",
  "pendingFieldTests"
]);
const PROBE_STATUSES = new Set([
  "COMPLETE",
  "UNSUPPORTED_HARDWARE",
  "PERMISSIONS_REQUIRED",
  "BLUETOOTH_DISABLED",
  "PROBE_INCOMPLETE"
]);
const CLASSIFICATIONS = new Set([
  "FULL_NODE",
  "CLIENT_ONLY",
  "UNSUPPORTED"
]);
const FORBIDDEN_ADB_OPERATIONS = new Set([
  "force-stop",
  "clear",
  "uninstall",
  "disable-user",
  "kill",
  "kill-all"
]);
const ALLOWED_RUN_AS_FILES = new Set([
  DISCOVERY_STATUS_FILE,
  AGENT_STATUS_FILE,
  GATT_STATUS_FILE,
  SESSION_PREFS_FILE
]);

export class B0SupplementalError extends Error {
  constructor(code, message, exitCode = 1, options = undefined) {
    super(message, options);
    this.name = "B0SupplementalError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1, options = undefined) {
  throw new B0SupplementalError(code, message, exitCode, options);
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
}

function safeInteger(value, minimum, maximum, code, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function nullableBoolean(value, code, label) {
  if (value !== null && typeof value !== "boolean") {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function parseJson(raw, maximumBytes, code, label) {
  const text = String(raw ?? "");
  const size = Buffer.byteLength(text, "utf8");
  if (size < 2 || size > maximumBytes) {
    fail(code, `${label} has an invalid size`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(code, `${label} is not valid JSON`);
  }
}

export function parseCapabilityReport(raw) {
  const value = parseJson(
    raw,
    CAPABILITY_MAX_BYTES,
    "CAPABILITY_REPORT_INVALID",
    "native capability report"
  );
  exactFields(
    value,
    CAPABILITY_FIELDS,
    "CAPABILITY_REPORT_INVALID",
    "native capability report"
  );
  for (const field of ["manufacturer", "model"]) {
    if (
      typeof value[field] !== "string" ||
      value[field].length === 0 ||
      value[field].length > 120 ||
      /[\x00-\x1f\x7f]/u.test(value[field])
    ) {
      fail("CAPABILITY_REPORT_INVALID", `capability field ${field} is invalid`);
    }
  }
  safeInteger(
    value.androidApi,
    33,
    10_000,
    "CAPABILITY_REPORT_INVALID",
    "capability Android API"
  );
  for (const field of [
    "bluetoothLeFeature",
    "adapterPresent",
    "scanPermission",
    "advertisePermission",
    "connectPermission",
    "b0GateComplete"
  ]) {
    if (typeof value[field] !== "boolean") {
      fail("CAPABILITY_REPORT_INVALID", `capability field ${field} is invalid`);
    }
  }
  for (const field of [
    "adapterEnabled",
    "scannerAvailable",
    "advertiserAvailable",
    "gattClientAvailable",
    "multipleAdvertisementSupported",
    "offloadedFilteringSupported",
    "offloadedScanBatchingSupported",
    "gattServerOpen",
    "scan",
    "advertise",
    "gattClient",
    "gattServer"
  ]) {
    nullableBoolean(
      value[field],
      "CAPABILITY_REPORT_INVALID",
      `capability field ${field}`
    );
  }
  if (!PROBE_STATUSES.has(value.probeStatus)) {
    fail("CAPABILITY_REPORT_INVALID", "capability probe status is invalid");
  }
  if (value.classification !== null && !CLASSIFICATIONS.has(value.classification)) {
    fail("CAPABILITY_REPORT_INVALID", "capability classification is invalid");
  }
  if (
    value.b0GateComplete !== false ||
    !Array.isArray(value.pendingFieldTests) ||
    value.pendingFieldTests.length !== 3 ||
    JSON.stringify(value.pendingFieldTests) !==
      JSON.stringify([
        "SCAN_ADVERTISE_CONCURRENT",
        "WIFI_BLE_COEXISTENCE",
        "BACKGROUND_FOREGROUND"
      ])
  ) {
    fail("CAPABILITY_REPORT_INVALID", "capability B0 scope is invalid");
  }
  if (
    (value.gattServerOpen === null && value.gattServer !== null) ||
    (value.gattServer !== null && value.gattServer !== value.gattServerOpen)
  ) {
    fail("CAPABILITY_REPORT_INVALID", "GATT server capability result is inconsistent");
  }
  return Object.freeze({ ...value, pendingFieldTests: Object.freeze([...value.pendingFieldTests]) });
}

export function parseDeviceEpochSeconds(raw) {
  const value = String(raw ?? "").trim();
  if (!/^[1-9]\d{9,12}$/u.test(value)) {
    fail("DEVICE_CLOCK_INVALID", "device clock output is invalid");
  }
  const seconds = Number(value);
  return safeInteger(
    seconds,
    1_000_000_000,
    Number.MAX_SAFE_INTEGER,
    "DEVICE_CLOCK_INVALID",
    "device clock"
  );
}

export function parseWifiConnectivity(wifiStatusRaw, connectivityRaw) {
  const wifi = String(wifiStatusRaw ?? "");
  const connectivity = String(connectivityRaw ?? "");
  if (
    Buffer.byteLength(wifi, "utf8") > ADB_MAX_BYTES ||
    Buffer.byteLength(connectivity, "utf8") > ADB_MAX_BYTES
  ) {
    fail("WIFI_STATUS_INVALID", "Wi-Fi status output is too large");
  }
  const enabled = /(?:^|\n)\s*Wifi is enabled\s*(?:\n|$)/iu.test(wifi);
  const supplicantConnected =
    /Supplicant state:\s*COMPLETED\b/iu.test(wifi) ||
    /\bstate:\s*CONNECTED\b/iu.test(wifi) ||
    /\bmNetworkInfo\b[^\r\n]*\bCONNECTED\b/iu.test(wifi);
  const validatedWifi = connectivity
    .split(/\n\s*NetworkAgentInfo\{/u)
    .some(
      (block) =>
        /\bTransports:\s*WIFI\b/iu.test(block) &&
        /\bVALIDATED\b/iu.test(block)
    );
  return Object.freeze({ enabled, connected: enabled && (supplicantConnected || validatedWifi) });
}

export function parseAppForeground(raw, packageName) {
  const text = String(raw ?? "");
  if (
    typeof packageName !== "string" ||
    packageName.length === 0 ||
    Buffer.byteLength(text, "utf8") > ADB_MAX_BYTES
  ) {
    fail("ACTIVITY_STATE_INVALID", "activity state output is invalid");
  }
  const resumedLines = text
    .split(/\r?\n/u)
    .filter((line) => /(?:mResumedActivity|topResumedActivity)/u.test(line));
  if (resumedLines.length === 0) {
    fail("ACTIVITY_STATE_INVALID", "resumed activity is unavailable");
  }
  return resumedLines.some((line) => line.includes(`${packageName}/`));
}

export function parseB0PackageState(raw, currentUser) {
  safeInteger(
    currentUser,
    0,
    99_999,
    "PACKAGE_STATE_INVALID",
    "Android user"
  );
  const text = String(raw ?? "");
  if (Buffer.byteLength(text, "utf8") > ADB_MAX_BYTES) {
    fail("PACKAGE_STATE_INVALID", "installed package state is too large");
  }
  const legacyUidMatches = [...text.matchAll(/^\s*userId=(\d+)\s*$/gmu)];
  const appIdMatches = [...text.matchAll(/^\s*appId=(\d+)\s*$/gmu)];
  if (
    legacyUidMatches.length + appIdMatches.length !== 1 ||
    legacyUidMatches.length > 1 ||
    appIdMatches.length > 1
  ) {
    fail("PACKAGE_STATE_INVALID", "installed package UID is unavailable or ambiguous");
  }
  const rawAppId = Number(
    legacyUidMatches[0]?.[1] ?? appIdMatches[0]?.[1]
  );
  safeInteger(
    rawAppId,
    10_000,
    99_999,
    "PACKAGE_STATE_INVALID",
    "installed package app ID"
  );
  const appUid =
    appIdMatches.length === 1 ? currentUser * 100_000 + rawAppId : rawAppId;
  safeInteger(
    appUid,
    10_000,
    Number.MAX_SAFE_INTEGER,
    "PACKAGE_STATE_INVALID",
    "installed package UID"
  );
  const userPattern = new RegExp(
    `^\\s*User ${currentUser}:.*\\bstopped=(true|false)\\b`,
    "gmu"
  );
  const userMatches = [...text.matchAll(userPattern)];
  if (userMatches.length !== 1) {
    fail("PACKAGE_STATE_INVALID", "installed package user state is unavailable or ambiguous");
  }
  return Object.freeze({
    appUid,
    stopped: userMatches[0][1] === "true"
  });
}

export function parseLauncherComponent(raw, packageName) {
  const lines = String(raw ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const component = lines.at(-1) ?? "";
  if (
    lines.length === 0 ||
    !COMPONENT_PATTERN.test(component) ||
    !component.startsWith(`${packageName}/`)
  ) {
    fail("LAUNCHER_COMPONENT_INVALID", "launcher component is invalid");
  }
  return component;
}

export function assertNonDestructiveAdbArgs(
  args,
  packageIds = [TARGET.packageId]
) {
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
  if (args.some((argument) => FORBIDDEN_ADB_OPERATIONS.has(argument))) {
    fail("ADB_OPERATION_FORBIDDEN", "destructive ADB operation is forbidden");
  }
  const exact = (...expected) =>
    args.length === expected.length &&
    args.every((argument, index) => argument === expected[index]);
  if (
    !Array.isArray(packageIds) ||
    packageIds.length === 0 ||
    packageIds.some(
      (packageId) =>
        typeof packageId !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(packageId)
    ) ||
    new Set(packageIds).size !== packageIds.length
  ) {
    fail("ADB_ARGUMENT_INVALID", "ADB target package allowlist is invalid");
  }
  const targetPackages = new Set(packageIds);
  const packageAllowed = (value) => targetPackages.has(value);
  const userId = (value) => /^(?:0|[1-9]\d*)$/u.test(value ?? "");
  const launcher = (value) => {
    if (typeof value !== "string" || !COMPONENT_PATTERN.test(value)) return false;
    const packageId = value.split("/", 1)[0];
    return packageAllowed(packageId);
  };
  const apkPath = (value) =>
    typeof value === "string" &&
    /^\/data\/app\/[A-Za-z0-9._~+=/-]+\.apk$/u.test(value);
  const allowed =
    exact("devices", "-l") ||
    exact("shell", "am", "get-current-user") ||
    exact("shell", "getprop", "ro.build.version.sdk") ||
    exact("shell", "getprop", "ro.product.model") ||
    (args.length === 4 &&
      exact("shell", "dumpsys", "package", args[3]) &&
      packageAllowed(args[3])) ||
    (args.length === 6 &&
      exact(
        "shell",
        "cmd",
        "package",
        "resolve-activity",
        "--brief",
        args[5]
      ) &&
      packageAllowed(args[5])) ||
    (args.length === 4 &&
      exact("shell", "pm", "path", args[3]) &&
      packageAllowed(args[3])) ||
    exact("shell", "dumpsys", "activity", "activities") ||
    (args.length === 4 &&
      exact("shell", "pidof", "-s", args[3]) &&
      packageAllowed(args[3])) ||
    (args.length === 6 &&
      exact(
        "shell",
        "dumpsys",
        "activity",
        "-a",
        "services",
        args[5]
      ) &&
      packageAllowed(args[5])) ||
    exact("shell", "cmd", "wifi", "status") ||
    exact("shell", "dumpsys", "connectivity") ||
    exact("shell", "date", "+%s") ||
    (args.length === 5 &&
      exact("shell", "dumpsys", "activity", "exit-info", args[4]) &&
      packageAllowed(args[4])) ||
    exact("shell", "input", "keyevent", "KEYCODE_HOME") ||
    (args.length === 8 &&
      exact(
        "shell",
        "am",
        "start",
        "-W",
        "--user",
        args[5],
        "-n",
        args[7]
      ) &&
      userId(args[5]) &&
      launcher(args[7])) ||
    (args.length === 7 &&
      args[0] === "exec-out" &&
      args[1] === "run-as" &&
      packageAllowed(args[2]) &&
      args[3] === "--user" &&
      userId(args[4]) &&
      args[5] === "cat" &&
      ALLOWED_RUN_AS_FILES.has(args[6])) ||
    (args.length === 3 &&
      args[0] === "exec-out" &&
      args[1] === "sha256sum" &&
      apkPath(args[2])) ||
    (args.length === 3 &&
      args[0] === "forward" &&
      args[1] === "tcp:0" &&
      /^localabstract:webview_devtools_remote_[1-9]\d*$/u.test(args[2])) ||
    (args.length === 3 &&
      args[0] === "forward" &&
      args[1] === "--remove" &&
      /^tcp:[1-9]\d{0,4}$/u.test(args[2]));
  if (!allowed) {
    fail("ADB_OPERATION_FORBIDDEN", "ADB command is outside the B0 allowlist");
  }
  return [...args];
}

export class AdbClient {
  constructor(
    executable,
    commandRunner = execFileAsync,
    packageIds = [TARGET.packageId]
  ) {
    if (typeof executable !== "string" || !path.isAbsolute(executable)) {
      fail("ADB_PATH_INVALID", "ADB executable path must be absolute");
    }
    this.executable = executable;
    this.commandRunner = commandRunner;
    this.packageIds = Object.freeze([...packageIds]);
  }

  async run(serial, args, timeoutMs = ADB_TIMEOUT_MS) {
    const safeArgs = assertNonDestructiveAdbArgs(args, this.packageIds);
    const commandArgs = serial === null ? safeArgs : ["-s", serial, ...safeArgs];
    if (serial !== null && !SERIAL_PATTERN.test(serial)) {
      fail("ADB_ARGUMENT_INVALID", "ADB target is invalid");
    }
    try {
      const result = await this.commandRunner(this.executable, commandArgs, {
        encoding: "utf8",
        maxBuffer: ADB_MAX_BYTES,
        timeout: timeoutMs,
        windowsHide: true
      });
      return result.stdout ?? "";
    } catch (error) {
      fail("ADB_COMMAND_FAILED", "ADB command failed", 1, { cause: error });
    }
  }
}

function parseDevtoolsPort(raw) {
  const value = String(raw ?? "").trim();
  if (!/^[1-9]\d{0,4}$/u.test(value)) {
    fail("DEVTOOLS_FORWARD_INVALID", "ADB DevTools port is invalid");
  }
  return safeInteger(
    Number(value),
    1,
    65_535,
    "DEVTOOLS_FORWARD_INVALID",
    "ADB DevTools port"
  );
}

export function parseDevtoolsTargets(raw, port) {
  const value = parseJson(
    raw,
    128 * 1024,
    "DEVTOOLS_TARGETS_INVALID",
    "WebView DevTools targets"
  );
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    fail("DEVTOOLS_TARGETS_INVALID", "WebView DevTools target list is invalid");
  }
  const targets = [];
  for (const target of value) {
    if (!isRecord(target) || target.type !== "page") continue;
    if (typeof target.webSocketDebuggerUrl !== "string") continue;
    let url;
    try {
      url = new URL(target.webSocketDebuggerUrl);
    } catch {
      continue;
    }
    if (
      url.protocol !== "ws:" ||
      Number(url.port) !== port ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !url.pathname.startsWith("/devtools/")
    ) {
      continue;
    }
    url.hostname = "127.0.0.1";
    targets.push(url.toString());
  }
  if (targets.length === 0) {
    fail("DEVTOOLS_TARGETS_INVALID", "no eligible WebView page is available");
  }
  return Object.freeze(targets);
}

export function parseDevtoolsEvaluation(raw, requestId = 1) {
  const value = typeof raw === "string"
    ? parseJson(raw, 128 * 1024, "DEVTOOLS_EVALUATION_INVALID", "DevTools response")
    : raw;
  if (
    !isRecord(value) ||
    value.id !== requestId ||
    !isRecord(value.result) ||
    !isRecord(value.result.result) ||
    value.result.exceptionDetails !== undefined
  ) {
    fail("DEVTOOLS_EVALUATION_INVALID", "DevTools evaluation failed");
  }
  const result = value.result.result;
  if (result.type === "object" && result.subtype === "null") return null;
  if (result.type !== "string" || typeof result.value !== "string") {
    fail("DEVTOOLS_EVALUATION_INVALID", "DevTools capability result is invalid");
  }
  return result.value;
}

async function evaluateDevtoolsPage(
  webSocketUrl,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = 5_000
) {
  if (typeof WebSocketImpl !== "function") {
    fail("DEVTOOLS_UNAVAILABLE", "WebSocket support is unavailable");
  }
  const expression =
    "(() => { const b = globalThis.CassaBluetoothDiagnostics; " +
    "return b && typeof b.getCapabilityReport === 'function' " +
    "? b.getCapabilityReport() : null; })()";
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(webSocketUrl);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      callback(value);
    };
    const timer = setTimeout(
      () => finish(reject, new B0SupplementalError("DEVTOOLS_TIMEOUT", "DevTools timed out")),
      timeoutMs
    );
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      );
    });
    socket.addEventListener("message", (event) => {
      try {
        finish(resolve, parseDevtoolsEvaluation(String(event.data), 1));
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.addEventListener("error", () => {
      finish(reject, new B0SupplementalError("DEVTOOLS_UNAVAILABLE", "DevTools failed"));
    });
  });
}

export async function readNativeCapabilityViaAdb(
  adb,
  serial,
  pid,
  runtime = {}
) {
  safeInteger(pid, 1, Number.MAX_SAFE_INTEGER, "PROCESS_INVALID", "application process");
  const forward = await adb.run(
    serial,
    ["forward", "tcp:0", `localabstract:webview_devtools_remote_${pid}`]
  );
  const port = parseDevtoolsPort(forward);
  let cleanupError = null;
  try {
    const fetchImpl = runtime.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      fail("DEVTOOLS_UNAVAILABLE", "HTTP fetch support is unavailable");
    }
    const response = await fetchImpl(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) fail("DEVTOOLS_UNAVAILABLE", "WebView DevTools did not respond");
    const targets = parseDevtoolsTargets(await response.text(), port);
    for (const target of targets) {
      const result = await (runtime.evaluatePage ?? evaluateDevtoolsPage)(
        target,
        runtime.WebSocketImpl
      );
      if (result !== null) return parseCapabilityReport(result);
    }
    fail("CAPABILITY_BRIDGE_UNAVAILABLE", "native capability bridge is unavailable");
  } finally {
    try {
      await adb.run(serial, ["forward", "--remove", `tcp:${port}`]);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError !== null) {
      fail("DEVTOOLS_CLEANUP_FAILED", "ADB DevTools forwarding cleanup failed", 1, {
        cause: cleanupError
      });
    }
  }
}

function reporterIsFresh(reporter, nowMs, label) {
  if (
    !Number.isSafeInteger(reporter?.sampledAtEpochMs) ||
    !Number.isSafeInteger(reporter?.reporterStartedAtEpochMs) ||
    reporter.sampledAtEpochMs < nowMs - REPORTER_FRESHNESS_MS ||
    reporter.sampledAtEpochMs > nowMs + REPORTER_FRESHNESS_MS ||
    reporter.reporterStartedAtEpochMs > reporter.sampledAtEpochMs
  ) {
    fail("REPORTER_STALE", `${label} reporter is stale`);
  }
}

async function readRunAs(adb, binding, file) {
  return adb.run(
    binding.serial,
    buildRunAsArgs(binding.packageId, binding.currentUser, file)
  );
}

export async function captureDeviceSample(adb, binding, sessionKey, runtime = {}) {
  const target = binding.certifiedTarget ?? TARGET;
  if (binding.packageId !== target.packageId) {
    fail("CERTIFIED_BUILD_MISMATCH", "B0 binding does not match its certified role");
  }
  const now = runtime.now ?? Date.now;
  const monotonic = runtime.monotonic ?? (() => performance.now());
  const currentUser = parseCurrentUser(
    await adb.run(binding.serial, ["shell", "am", "get-current-user"]),
    binding.ordinal
  );
  if (currentUser !== binding.currentUser) {
    fail("ANDROID_USER_CHANGED", "Android user changed during B0 capture");
  }
  const hostEpochMs = now();
  const hostMonotonicMs = monotonic();
  const [
    packageRaw,
    pidRaw,
    discoveryRaw,
    agentRaw,
    gattRaw,
    prefsRaw,
    serviceRaw,
    activityRaw,
    wifiRaw,
    connectivityRaw,
    clockRaw
  ] = await Promise.all([
    adb.run(binding.serial, ["shell", "dumpsys", "package", target.packageId]),
    adb.run(binding.serial, ["shell", "pidof", "-s", target.packageId]),
    readRunAs(adb, binding, DISCOVERY_STATUS_FILE),
    readRunAs(adb, binding, AGENT_STATUS_FILE),
    readRunAs(adb, binding, GATT_STATUS_FILE),
    readRunAs(adb, binding, SESSION_PREFS_FILE),
    adb.run(binding.serial, [
      "shell",
      "dumpsys",
      "activity",
      "-a",
      "services",
      target.packageId
    ]),
    adb.run(binding.serial, ["shell", "dumpsys", "activity", "activities"]),
    adb.run(binding.serial, ["shell", "cmd", "wifi", "status"]),
    adb.run(binding.serial, ["shell", "dumpsys", "connectivity"]),
    adb.run(binding.serial, ["shell", "date", "+%s"])
  ]);
  const installedVersion = parseInstalledVersion(packageRaw, binding.ordinal);
  const packageState = parseB0PackageState(packageRaw, currentUser);
  const discovery = parseDiscoveryStatus(discoveryRaw);
  const agent = parseAgentReporter(agentRaw, hostEpochMs);
  const gatt = parseGattReporter(gattRaw, hostEpochMs);
  reporterIsFresh(discovery, hostEpochMs, "discovery");
  reporterIsFresh(agent, hostEpochMs, "agent");
  reporterIsFresh(gatt, hostEpochMs, "GATT");
  const session = parseAuthenticatedSessionPreferences(prefsRaw);
  const sessionHmac = sessionBindingHmac(session, sessionKey);
  const wifi = parseWifiConnectivity(wifiRaw, connectivityRaw);
  const deviceEpochMs = parseDeviceEpochSeconds(clockRaw) * 1_000;
  if (Math.abs(deviceEpochMs - hostEpochMs) > CLOCK_SKEW_MS) {
    fail("DEVICE_CLOCK_SKEW", "device clock is outside the B0 tolerance");
  }
  return Object.freeze({
    hostEpochMs,
    hostMonotonicMs,
    deviceEpochMs,
    currentUser,
    installedVersion: Object.freeze(installedVersion),
    appUid: packageState.appUid,
    packageStopped: packageState.stopped,
    pid: parsePid(pidRaw),
    discovery,
    agent,
    gatt,
    sessionBindingHmacSha256: sessionHmac,
    foregroundService: Object.freeze(
      parseForegroundServiceDump(serviceRaw, currentUser, binding.ordinal)
    ),
    appForeground: parseAppForeground(activityRaw, target.packageId),
    wifi
  });
}

function everySame(values) {
  return values.length > 0 && values.every((value) => value === values[0]);
}

function strictlyIncreasing(values) {
  return values.length > 1 && values.every((value, index) => index === 0 || value > values[index - 1]);
}

function nonDecreasing(values) {
  return values.length > 1 && values.every((value, index) => index === 0 || value >= values[index - 1]);
}

function boundedSamplePolling(samples) {
  const monotonicTimes = samples.map((sample) => sample.hostMonotonicMs);
  return (
    strictlyIncreasing(monotonicTimes) &&
    monotonicTimes.every(
      (value, index) => index === 0 || value - monotonicTimes[index - 1] <= MAX_POLL_GAP_MS
    )
  );
}

function reporterStreamIsFreshAndProgressive(samples, binding, reporter) {
  const bindingField = `${reporter}ReporterStartedAtEpochMs`;
  const startedAt = samples.map(
    (sample) => sample[reporter].reporterStartedAtEpochMs
  );
  return (
    samples.length > 1 &&
    everySame(startedAt) &&
    startedAt[0] === binding[bindingField] &&
    strictlyIncreasing(samples.map((sample) => sample[reporter].sampleSequence)) &&
    strictlyIncreasing(samples.map((sample) => sample[reporter].sampledAtEpochMs)) &&
    samples.every(
      (sample) =>
        sample[reporter].reporterStartedAtEpochMs <=
          sample[reporter].sampledAtEpochMs &&
        sample[reporter].sampledAtEpochMs >=
          sample.hostEpochMs - REPORTER_FRESHNESS_MS &&
        sample[reporter].sampledAtEpochMs <=
          sample.hostEpochMs + REPORTER_FRESHNESS_MS
    ) &&
    boundedSamplePolling(samples)
  );
}

function status(passed, passCode, failCode) {
  return Object.freeze({ status: passed ? "PASS" : "FAIL", code: passed ? passCode : failCode });
}

function metricDelta(samples, selector) {
  if (samples.length < 2) return -1;
  return selector(samples.at(-1)) - selector(samples[0]);
}

function phaseRadioProgress(samples) {
  const scanWindows = samples.map(
    (sample) => sample.discovery.metrics.scanWindowsStarted
  );
  const concurrentWindows = samples.map(
    (sample) =>
      sample.discovery.metrics.concurrentScanAdvertiseWindowsStarted
  );
  return (
    samples.length >= 2 &&
    nonDecreasing(scanWindows) &&
    scanWindows.at(-1) > scanWindows[0] &&
    nonDecreasing(concurrentWindows) &&
    concurrentWindows.at(-1) > concurrentWindows[0]
  );
}

function newExitCommitments(baseline, final) {
  if (!(baseline?.commitments instanceof Set) || !(final?.commitments instanceof Set)) {
    return Number.POSITIVE_INFINITY;
  }
  return [...final.commitments].filter((value) => !baseline.commitments.has(value)).length;
}

export function evaluateDeviceEvidence({
  binding,
  capability,
  foregroundSamples,
  backgroundSamples,
  exitBaseline,
  exitFinal
}) {
  const target = binding.certifiedTarget ?? TARGET;
  const samples = [...foregroundSamples, ...backgroundSamples];
  if (foregroundSamples.length < 2 || backgroundSamples.length < 2) {
    fail("EVIDENCE_INCOMPLETE", "both B0 lifecycle phases require multiple samples");
  }
  const discoveryStart = samples[0].discovery.metrics;
  const discoveryEnd = samples.at(-1).discovery.metrics;
  const noRadioFailures = samples.every(
    (sample) =>
      sample.discovery.metrics.scanFailures === 0 &&
      sample.discovery.metrics.advertisementFailures === 0 &&
      sample.discovery.metrics.scanIngressDropped === 0
  );
  const discoveryRuntimeMeasured = reporterStreamIsFreshAndProgressive(
    samples,
    binding,
    "discovery"
  );
  const agentRuntimeMeasured = reporterStreamIsFreshAndProgressive(
    samples,
    binding,
    "agent"
  );
  const gattRuntimeMeasured = reporterStreamIsFreshAndProgressive(
    samples,
    binding,
    "gatt"
  );
  const bluetoothRuntimeReady =
    capability.bluetoothLeFeature === true &&
    capability.adapterPresent === true &&
    capability.adapterEnabled === true;
  const scanMeasured =
    bluetoothRuntimeReady &&
    capability.scanPermission === true &&
    capability.scannerAvailable === true &&
    discoveryRuntimeMeasured &&
    agentRuntimeMeasured &&
    samples.some((sample) => sample.agent.resources.scannerActive === true) &&
    discoveryEnd.scanWindowsStarted > discoveryStart.scanWindowsStarted &&
    noRadioFailures;
  const advertiseMeasured =
    bluetoothRuntimeReady &&
    capability.advertisePermission === true &&
    capability.advertiserAvailable === true &&
    capability.multipleAdvertisementSupported === true &&
    discoveryRuntimeMeasured &&
    agentRuntimeMeasured &&
    samples.some((sample) => sample.agent.resources.advertiserActive === true) &&
    discoveryEnd.advertisementsStarted >= 1 &&
    noRadioFailures;
  const gattActivityMeasured =
    samples.some((sample) => sample.gatt.active === true) ||
    metricDelta(samples, (sample) => sample.gatt.metrics.connectionAttempts) >= 1 ||
    metricDelta(samples, (sample) => sample.gatt.metrics.connectionsEstablished) >= 1;
  const gattClientMeasured =
    bluetoothRuntimeReady &&
    capability.connectPermission === true &&
    capability.gattClientAvailable === true &&
    gattRuntimeMeasured &&
    samples.every((sample) => sample.gatt.gattClientEnabled === true) &&
    gattActivityMeasured;
  const gattServerMeasured =
    bluetoothRuntimeReady &&
    capability.connectPermission === true &&
    // The native capability probe owns the one-shot open/close lifecycle.
    capability.gattServerOpen === true;
  const foregroundRadioProgress = phaseRadioProgress(foregroundSamples);
  const backgroundRadioProgress = phaseRadioProgress(backgroundSamples);
  const concurrentMeasured =
    scanMeasured &&
    advertiseMeasured &&
    foregroundRadioProgress &&
    backgroundRadioProgress;
  const peerTrafficProgress =
    discoveryEnd.acceptedObservations > discoveryStart.acceptedObservations &&
    samples.some((sample) => sample.discovery.activePeerCount > 0);
  const wifiCoexistenceMeasured =
    samples.every((sample) => sample.wifi.enabled && sample.wifi.connected) &&
    peerTrafficProgress &&
    foregroundRadioProgress &&
    backgroundRadioProgress &&
    noRadioFailures;

  const versions = samples.map(
    (sample) => `${sample.installedVersion.versionName}:${sample.installedVersion.versionCode}`
  );
  const stablePackageVersion =
    everySame(versions) &&
    binding.packageId === target.packageId &&
    versions[0] === `${target.versionName}:${target.versionCode}` &&
    binding.apkSha256 === target.sha256;
  const stableAndroidUser =
    everySame(samples.map((sample) => sample.currentUser)) &&
    samples[0].currentUser === binding.currentUser;
  const stablePid =
    everySame(samples.map((sample) => sample.pid)) &&
    samples[0].pid === binding.pid;
  const stableAppUid =
    everySame(samples.map((sample) => sample.appUid)) &&
    samples[0].appUid === binding.appUid;
  const stableReporters =
    discoveryRuntimeMeasured && agentRuntimeMeasured && gattRuntimeMeasured;
  const stableSession = everySame(
    samples.map((sample) => sample.sessionBindingHmacSha256)
  ) && samples[0].sessionBindingHmacSha256 === binding.sessionBindingHmacSha256;
  const clockMonotonic =
    nonDecreasing(samples.map((sample) => sample.hostEpochMs)) &&
    strictlyIncreasing(samples.map((sample) => sample.hostMonotonicMs)) &&
    nonDecreasing(samples.map((sample) => sample.deviceEpochMs));
  const boundedPolling = boundedSamplePolling(samples);
  const foregroundServiceContinuous = samples.every(
    (sample) =>
      sample.foregroundService.foreground === true &&
      Number.isSafeInteger(sample.foregroundService.typeMask) &&
      (sample.foregroundService.typeMask & B3_FGS_TYPE_DATA_SYNC) !== 0 &&
      (sample.foregroundService.typeMask & B3_FGS_TYPE_CONNECTED_DEVICE) !== 0
  );
  const noReporterStop = samples.every(
    (sample) =>
      sample.agent.metrics.stopCount === samples[0].agent.metrics.stopCount &&
      sample.agent.metrics.invalidTransitionCount === 0 &&
      sample.packageStopped === false
  );
  const noCrashOrAnr = newExitCommitments(exitBaseline, exitFinal) === 0;
  const lifecycleObserved =
    foregroundSamples.every((sample) => sample.appForeground === true) &&
    backgroundSamples.every((sample) => sample.appForeground === false) &&
    foregroundRadioProgress &&
    backgroundRadioProgress;

  const continuity = Object.freeze({
    stablePackageVersion: status(
      stablePackageVersion,
      "PACKAGE_VERSION_STABLE",
      "PACKAGE_VERSION_CHANGED"
    ),
    stableAndroidUser: status(
      stableAndroidUser,
      "ANDROID_USER_STABLE",
      "ANDROID_USER_CHANGED"
    ),
    stableProcess: status(
      stablePid && stableAppUid,
      "PROCESS_STABLE",
      "PROCESS_CHANGED"
    ),
    stableReporters: status(
      stableReporters,
      "REPORTERS_STABLE",
      "REPORTER_RESTART_OR_REGRESSION"
    ),
    noLogout: status(stableSession, "SESSION_STABLE", "LOGOUT_OR_SESSION_CHANGE"),
    noCrashOrAnr: status(noCrashOrAnr, "NO_CRASH_OR_ANR", "CRASH_OR_ANR_DETECTED"),
    clockMonotonic: status(clockMonotonic, "CLOCK_MONOTONIC", "CLOCK_REGRESSION"),
    boundedPolling: status(boundedPolling, "POLLING_BOUNDED", "POLLING_GAP"),
    serviceContinuous: status(
      foregroundServiceContinuous && noReporterStop,
      "SERVICE_CONTINUOUS",
      "SERVICE_INTERRUPTED"
    ),
    noForceStop: Object.freeze({ status: "PASS", code: "RUNNER_FORBIDS_FORCE_STOP" })
  });
  const continuityPass = Object.values(continuity).every(
    (result) => result.status === "PASS"
  );
  const controls = Object.freeze({
    scan: status(scanMeasured, "SCAN_MEASURED", "SCAN_NOT_PROVEN"),
    advertise: status(
      advertiseMeasured,
      "ADVERTISING_MEASURED",
      "ADVERTISING_NOT_PROVEN"
    ),
    gattClient: status(
      gattClientMeasured,
      "GATT_CLIENT_MEASURED",
      "GATT_CLIENT_NOT_PROVEN"
    ),
    gattServer: status(
      gattServerMeasured,
      "GATT_SERVER_OPEN_CLOSE_MEASURED",
      "GATT_SERVER_NOT_PROVEN"
    ),
    scanAdvertiseConcurrent: status(
      concurrentMeasured,
      "SCAN_ADVERTISE_CONCURRENCY_MEASURED",
      "SCAN_ADVERTISE_CONCURRENCY_NOT_PROVEN"
    ),
    wifiBleCoexistence: status(
      wifiCoexistenceMeasured,
      "WIFI_BLE_COEXISTENCE_MEASURED",
      "WIFI_BLE_COEXISTENCE_NOT_PROVEN"
    ),
    backgroundForeground: status(
      lifecycleObserved && continuityPass,
      "FOREGROUND_BACKGROUND_MEASURED",
      "FOREGROUND_BACKGROUND_NOT_PROVEN"
    )
  });
  const passed =
    B0_REQUIRED_CONTROLS.every((field) => controls[field].status === "PASS") &&
    continuityPass;
  return Object.freeze({
    ordinal: binding.ordinal,
    androidApi: capability.androidApi,
    versionName: versions[0].split(":")[0],
    versionCode: Number(versions[0].split(":")[1]),
    evidenceClass: "SUPPLEMENTAL",
    gateImpact: "NON_GATE_EVIDENCE",
    controls,
    continuity,
    result: passed ? "SUPPLEMENTAL_PASS" : "SUPPLEMENTAL_FAIL",
    measurements: Object.freeze({
      foregroundSamples: foregroundSamples.length,
      backgroundSamples: backgroundSamples.length,
      scanWindowsDelta:
        discoveryEnd.scanWindowsStarted - discoveryStart.scanWindowsStarted,
      concurrentScanAdvertiseWindowsDelta:
        discoveryEnd.concurrentScanAdvertiseWindowsStarted -
        discoveryStart.concurrentScanAdvertiseWindowsStarted,
      acceptedObservationsDelta:
        discoveryEnd.acceptedObservations - discoveryStart.acceptedObservations
    })
  });
}

const PUBLIC_CONTROL_CODES = Object.freeze({
  scan: Object.freeze(["SCAN_MEASURED", "SCAN_NOT_PROVEN"]),
  advertise: Object.freeze(["ADVERTISING_MEASURED", "ADVERTISING_NOT_PROVEN"]),
  gattClient: Object.freeze(["GATT_CLIENT_MEASURED", "GATT_CLIENT_NOT_PROVEN"]),
  gattServer: Object.freeze([
    "GATT_SERVER_OPEN_CLOSE_MEASURED",
    "GATT_SERVER_NOT_PROVEN"
  ]),
  scanAdvertiseConcurrent: Object.freeze([
    "SCAN_ADVERTISE_CONCURRENCY_MEASURED",
    "SCAN_ADVERTISE_CONCURRENCY_NOT_PROVEN"
  ]),
  wifiBleCoexistence: Object.freeze([
    "WIFI_BLE_COEXISTENCE_MEASURED",
    "WIFI_BLE_COEXISTENCE_NOT_PROVEN"
  ]),
  backgroundForeground: Object.freeze([
    "FOREGROUND_BACKGROUND_MEASURED",
    "FOREGROUND_BACKGROUND_NOT_PROVEN"
  ])
});
const PUBLIC_CONTINUITY_FIELDS = Object.freeze({
  packageVersion: Object.freeze([
    "stablePackageVersion",
    "PACKAGE_VERSION_STABLE",
    "PACKAGE_VERSION_CHANGED"
  ]),
  operatingSystemUser: Object.freeze([
    "stableAndroidUser",
    "ANDROID_USER_STABLE",
    "ANDROID_USER_CHANGED"
  ]),
  process: Object.freeze(["stableProcess", "PROCESS_STABLE", "PROCESS_CHANGED"]),
  reporters: Object.freeze([
    "stableReporters",
    "REPORTERS_STABLE",
    "REPORTER_RESTART_OR_REGRESSION"
  ]),
  authenticatedContext: Object.freeze([
    "noLogout",
    "SESSION_STABLE",
    "LOGOUT_OR_SESSION_CHANGE"
  ]),
  crashOrAnr: Object.freeze([
    "noCrashOrAnr",
    "NO_CRASH_OR_ANR",
    "CRASH_OR_ANR_DETECTED"
  ]),
  clock: Object.freeze(["clockMonotonic", "CLOCK_MONOTONIC", "CLOCK_REGRESSION"]),
  polling: Object.freeze(["boundedPolling", "POLLING_BOUNDED", "POLLING_GAP"]),
  service: Object.freeze([
    "serviceContinuous",
    "SERVICE_CONTINUOUS",
    "SERVICE_INTERRUPTED"
  ]),
  runnerStopPolicy: Object.freeze([
    "noForceStop",
    "RUNNER_FORBIDS_FORCE_STOP",
    "RUNNER_FORCE_STOP_POLICY_INVALID"
  ])
});

function publicStatus(source, passCode, failCode, label) {
  if (
    !isRecord(source) ||
    !["PASS", "FAIL"].includes(source.status) ||
    source.code !== (source.status === "PASS" ? passCode : failCode)
  ) {
    fail("EVIDENCE_INVALID", `${label} evidence is invalid`);
  }
  return Object.freeze({ status: source.status, code: source.code });
}

function publicDeviceResult(device, expectedOrdinal) {
  const source = device?.result;
  if (
    !isRecord(source) ||
    source.ordinal !== expectedOrdinal ||
    source.evidenceClass !== "SUPPLEMENTAL" ||
    source.gateImpact !== "NON_GATE_EVIDENCE" ||
    source.androidApi !== device?.capability?.androidApi ||
    source.versionName !== TARGET.versionName ||
    source.versionCode !== TARGET.versionCode
  ) {
    fail("EVIDENCE_INVALID", "private B0 device result is invalid");
  }
  const controls = Object.fromEntries(
    B0_REQUIRED_CONTROLS.map((field) => [
      field,
      publicStatus(
        source.controls?.[field],
        PUBLIC_CONTROL_CODES[field][0],
        PUBLIC_CONTROL_CODES[field][1],
        `B0 ${field}`
      )
    ])
  );
  const continuity = Object.fromEntries(
    Object.entries(PUBLIC_CONTINUITY_FIELDS).map(
      ([publicField, [privateField, passCode, failCode]]) => [
        publicField,
        publicStatus(
          source.continuity?.[privateField],
          passCode,
          failCode,
          `B0 continuity ${publicField}`
        )
      ]
    )
  );
  const measurements = source.measurements;
  for (const field of [
    "foregroundSamples",
    "backgroundSamples",
    "scanWindowsDelta",
    "concurrentScanAdvertiseWindowsDelta",
    "acceptedObservationsDelta"
  ]) {
    safeInteger(
      measurements?.[field],
      0,
      Number.MAX_SAFE_INTEGER,
      "EVIDENCE_INVALID",
      `B0 measurement ${field}`
    );
  }
  const passed =
    Object.values(controls).every((entry) => entry.status === "PASS") &&
    Object.values(continuity).every((entry) => entry.status === "PASS");
  if (source.result !== (passed ? "SUPPLEMENTAL_PASS" : "SUPPLEMENTAL_FAIL")) {
    fail("EVIDENCE_INVALID", "private B0 device verdict is inconsistent");
  }
  return Object.freeze({
    ordinal: expectedOrdinal,
    evidenceClass: "SUPPLEMENTAL",
    gateImpact: "NON_GATE_EVIDENCE",
    androidApi: source.androidApi,
    versionName: TARGET.versionName,
    versionCode: TARGET.versionCode,
    controls: Object.freeze(controls),
    continuity: Object.freeze(continuity),
    result: source.result,
    measurements: Object.freeze({
      foregroundSamples: measurements.foregroundSamples,
      backgroundSamples: measurements.backgroundSamples,
      scanWindowsDelta: measurements.scanWindowsDelta,
      concurrentScanAdvertiseWindowsDelta:
        measurements.concurrentScanAdvertiseWindowsDelta,
      acceptedObservationsDelta: measurements.acceptedObservationsDelta
    })
  });
}

export function buildPublicReport(privateEvidence, privateEvidenceSha256) {
  if (!SHA256_PATTERN.test(privateEvidenceSha256)) {
    fail("EVIDENCE_DIGEST_INVALID", "private evidence digest is invalid");
  }
  if (!Array.isArray(privateEvidence?.devices) || privateEvidence.devices.length !== 2) {
    fail("EVIDENCE_INVALID", "private B0 evidence requires exactly two Palmare targets");
  }
  const devices = Object.freeze([
    publicDeviceResult(privateEvidence.devices[0], "handheld-1"),
    publicDeviceResult(privateEvidence.devices[1], "handheld-2")
  ]);
  const passed = devices.every((device) => device.result === "SUPPLEMENTAL_PASS");
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B0_ANDROID_SUPPLEMENTAL_VERSION,
    source: "V5BT_B0_ANDROID_SUPPLEMENTAL",
    evidenceClass: "SUPPLEMENTAL",
    gateImpact: "NON_GATE_EVIDENCE",
    formalGate: "PENDING_UNCHANGED",
    formalGatePromoted: false,
    physicalAdbAccessed: true,
    captureDurationSeconds: B0_CAPTURE_DURATION_SECONDS,
    privateEvidenceSha256,
    result: passed ? "SUPPLEMENTAL_PASS" : "SUPPLEMENTAL_FAIL",
    devices,
    privacy: Object.freeze({
      redacted: true,
      targetIdentifiersRedacted: true,
      provisioningDataRedacted: true,
      operatingSystemUserRedacted: true,
      processDataRedacted: true,
      authenticatedContextRedacted: true,
      rawDiagnosticsRedacted: true
    })
  });
}

export function assertPublicReportRedacted(report, secrets = []) {
  const forbiddenKeys = /(?:serial|nodeId|deviceUuid|androidUser|\bpid\b|sessionBinding|enrollment)/iu;
  const visit = (value, key = "") => {
    if (forbiddenKeys.test(key)) {
      fail("PUBLIC_REPORT_PRIVACY_FAILURE", "public report contains a private field");
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry));
      return;
    }
    if (isRecord(value)) {
      Object.entries(value).forEach(([field, entry]) => visit(entry, field));
    }
  };
  visit(report);
  const encoded = JSON.stringify(report);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0 && encoded.includes(secret)) {
      fail("PUBLIC_REPORT_PRIVACY_FAILURE", "public report contains a private value");
    }
  }
  return true;
}

function assertNoSymlinkComponents(location) {
  const resolved = path.resolve(location);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        fail("OUTPUT_PATH_INVALID", "output paths cannot contain symbolic links");
      }
    } catch (error) {
      if (error instanceof B0SupplementalError) throw error;
      if (error?.code === "ENOENT") break;
      fail("OUTPUT_PATH_INVALID", "output path cannot be inspected");
    }
  }
}

function encodedJson(value, maximumBytes) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > maximumBytes) {
    fail("OUTPUT_TOO_LARGE", "B0 evidence exceeds its size limit");
  }
  return bytes;
}

export function writeExclusiveEvidence(destination, bytes, requirePrivateParent = false) {
  const resolved = path.resolve(destination);
  const parent = path.dirname(resolved);
  assertNoSymlinkComponents(parent);
  const parentStat = fs.lstatSync(parent);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (currentUid !== null && parentStat.uid !== currentUid) ||
    (requirePrivateParent && (parentStat.mode & 0o777) !== 0o700)
  ) {
    fail("OUTPUT_PATH_INVALID", "B0 output directory is not secure");
  }
  assertNoSymlinkComponents(resolved);
  if (fs.existsSync(resolved)) fail("OUTPUT_EXISTS", "B0 output already exists");
  const temporary = path.join(
    parent,
    `.v5bt-b0-${process.pid}-${crypto.randomUUID()}.tmp`
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
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, resolved);
    fs.unlinkSync(temporary);
    const status = fs.lstatSync(resolved);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      (status.mode & 0o777) !== 0o600 ||
      (currentUid !== null && status.uid !== currentUid)
    ) {
      fail("OUTPUT_PUBLICATION_FAILED", "B0 output metadata is invalid");
    }
    const directoryDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {}
    if (error instanceof B0SupplementalError) throw error;
    fail("OUTPUT_PUBLICATION_FAILED", "B0 output could not be published", 1, {
      cause: error
    });
  }
}

export function publishEvidencePair(privateOutput, reportOutput, privateEvidence) {
  if (path.resolve(privateOutput) === path.resolve(reportOutput)) {
    fail("OUTPUT_PATH_INVALID", "private and public outputs must be distinct");
  }
  if (fs.existsSync(privateOutput) || fs.existsSync(reportOutput)) {
    fail("OUTPUT_EXISTS", "B0 outputs cannot be overwritten");
  }
  const privateBytes = encodedJson(privateEvidence, 4 * 1024 * 1024);
  const privateDigest = crypto.createHash("sha256").update(privateBytes).digest("hex");
  const report = buildPublicReport(privateEvidence, privateDigest);
  const secrets = privateEvidence.devices.flatMap((device) => [
    device.binding.serial,
    device.binding.sessionBindingHmacSha256
  ]);
  assertPublicReportRedacted(report, secrets);
  const publicBytes = encodedJson(report, 256 * 1024);
  writeExclusiveEvidence(privateOutput, privateBytes, true);
  writeExclusiveEvidence(reportOutput, publicBytes, false);
  return Object.freeze({ privateDigest, report });
}

function offsets(durationSeconds) {
  const result = [];
  for (let offset = B0_POLL_INTERVAL_MS; offset <= durationSeconds * 1_000; offset += B0_POLL_INTERVAL_MS) {
    result.push(offset);
  }
  return Object.freeze(result);
}

export function buildCaptureSchedule() {
  return Object.freeze({
    foregroundOffsetsMs: offsets(B0_FOREGROUND_DURATION_SECONDS),
    backgroundOffsetsMs: Object.freeze([0, ...offsets(B0_BACKGROUND_DURATION_SECONDS)]),
    backgroundSettleMs: BACKGROUND_SETTLE_MS
  });
}

async function waitUntil(startMonotonicMs, offsetMs, runtime) {
  const monotonic = runtime.monotonic ?? (() => performance.now());
  const sleepImpl = runtime.sleep ?? sleep;
  const remaining = startMonotonicMs + offsetMs - monotonic();
  if (remaining > 0) await sleepImpl(remaining);
}

export async function collectScheduledSamples(
  adb,
  bindings,
  sessionKey,
  offsetsMs,
  runtime
) {
  const monotonic = runtime.monotonic ?? (() => performance.now());
  const started = monotonic();
  const byDevice = bindings.map(() => []);
  for (const offsetMs of offsetsMs) {
    await waitUntil(started, offsetMs, runtime);
    const captured = await Promise.all(
      bindings.map((binding) => captureDeviceSample(adb, binding, sessionKey, runtime))
    );
    captured.forEach((sample, index) => byDevice[index].push(sample));
  }
  return byDevice;
}

export function serializeSample(sample) {
  return Object.freeze({
    hostEpochMs: sample.hostEpochMs,
    hostMonotonicMs: sample.hostMonotonicMs,
    deviceEpochMs: sample.deviceEpochMs,
    currentUser: sample.currentUser,
    installedVersion: sample.installedVersion,
    appUid: sample.appUid,
    packageStopped: sample.packageStopped,
    pid: sample.pid,
    discovery: sample.discovery,
    agent: sample.agent,
    gatt: sample.gatt,
    sessionBindingHmacSha256: sample.sessionBindingHmacSha256,
    foregroundService: sample.foregroundService,
    appForeground: sample.appForeground,
    wifi: sample.wifi
  });
}

export function serializeExitInfo(value) {
  return Object.freeze({
    commitments: Object.freeze([...value.commitments].sort()),
    counts: value.counts
  });
}

export async function captureExitInfo(adb, binding) {
  const currentUser = parseCurrentUser(
    await adb.run(binding.serial, ["shell", "am", "get-current-user"]),
    binding.ordinal
  );
  if (currentUser !== binding.currentUser) {
    fail("ANDROID_USER_CHANGED", "Android user changed during B0 capture");
  }
  return parseApplicationExitCommitments(
    await adb.run(binding.serial, [
      "shell",
      "dumpsys",
      "activity",
      "exit-info",
      binding.packageId
    ]),
    currentUser,
    binding.packageId
  );
}

export function parseB0DeviceModel(raw) {
  const model = String(raw ?? "").trim();
  if (
    model.length === 0 ||
    model.length > 128 ||
    /[\x00-\x1f\x7f]/u.test(model)
  ) {
    fail("MODEL_INVALID", "Android model is invalid");
  }
  return model;
}

export async function captureStaticBinding(
  adb,
  serial,
  ordinal,
  target = TARGET,
  expectedModel = null
) {
  if (
    expectedModel !== null &&
    (typeof expectedModel !== "string" ||
      expectedModel.length === 0 ||
      expectedModel.length > 128 ||
      /[\x00-\x1f\x7f]/u.test(expectedModel))
  ) {
    fail("MODEL_INVALID", "expected Android model is invalid");
  }
  const currentUser = parseCurrentUser(
    await adb.run(serial, ["shell", "am", "get-current-user"]),
    ordinal
  );
  const [
    apiRaw,
    packageRaw,
    launcherRaw,
    apkPathRaw,
    activityRaw,
    pidRaw,
    modelRaw
  ] =
    await Promise.all([
      adb.run(serial, ["shell", "getprop", "ro.build.version.sdk"]),
      adb.run(serial, ["shell", "dumpsys", "package", target.packageId]),
      adb.run(serial, [
        "shell",
        "cmd",
        "package",
        "resolve-activity",
        "--brief",
        target.packageId
      ]),
      adb.run(serial, ["shell", "pm", "path", target.packageId]),
      adb.run(serial, ["shell", "dumpsys", "activity", "activities"]),
      adb.run(serial, ["shell", "pidof", "-s", target.packageId]),
      expectedModel === null
        ? Promise.resolve(null)
        : adb.run(serial, ["shell", "getprop", "ro.product.model"])
    ]);
  const model = expectedModel === null ? null : parseB0DeviceModel(modelRaw);
  if (expectedModel !== null && model !== expectedModel) {
    fail("FIXED_MODEL_MISMATCH", "Android model does not match its fixed B0 role");
  }
  const installedVersion = parseInstalledVersion(packageRaw, ordinal);
  if (
    installedVersion.versionName !== target.versionName ||
    installedVersion.versionCode !== target.versionCode
  ) {
    fail("CERTIFIED_BUILD_MISMATCH", "installed Android build is not certified");
  }
  const packageState = parseB0PackageState(packageRaw, currentUser);
  if (packageState.stopped) fail("PACKAGE_STOPPED", "Android package is stopped");
  for (const permission of BLUETOOTH_PERMISSIONS) {
    if (!permissionGrantedForUser(packageRaw, currentUser, permission)) {
      fail("BLUETOOTH_PERMISSION_MISSING", "required Bluetooth permission is missing");
    }
  }
  await adb.run(
    serial,
    buildRunAsArgs(target.packageId, currentUser, SESSION_PREFS_FILE)
  );
  const apkPath = parseInstalledApkPath(apkPathRaw, ordinal);
  const apkSha256 = parseInstalledApkSha256(
    await adb.run(serial, ["exec-out", "sha256sum", apkPath]),
    ordinal
  );
  if (apkSha256 !== target.sha256) {
    fail("CERTIFIED_BUILD_MISMATCH", "installed Android APK digest is not certified");
  }
  const initialPid = parsePid(pidRaw);
  return Object.freeze({
    ordinal,
    serial,
    packageId: target.packageId,
    certifiedTarget: target,
    model,
    expectedModel,
    androidApi: parseAndroidApi(apiRaw),
    currentUser,
    appUid: packageState.appUid,
    launcherComponent: parseLauncherComponent(launcherRaw, target.packageId),
    apkSha256,
    initialPid,
    wasForeground: parseAppForeground(activityRaw, target.packageId),
    wasRunning: true
  });
}

export async function verifyFinalBinding(adb, binding) {
  const target = binding.certifiedTarget ?? TARGET;
  const currentUser = parseCurrentUser(
    await adb.run(binding.serial, ["shell", "am", "get-current-user"]),
    binding.ordinal
  );
  const [packageRaw, pidRaw, apkPathRaw, modelRaw] = await Promise.all([
    adb.run(binding.serial, ["shell", "dumpsys", "package", target.packageId]),
    adb.run(binding.serial, ["shell", "pidof", "-s", target.packageId]),
    adb.run(binding.serial, ["shell", "pm", "path", target.packageId]),
    binding.expectedModel === null || binding.expectedModel === undefined
      ? Promise.resolve(null)
      : adb.run(binding.serial, ["shell", "getprop", "ro.product.model"])
  ]);
  const installedVersion = parseInstalledVersion(packageRaw, binding.ordinal);
  const packageState = parseB0PackageState(packageRaw, currentUser);
  const apkPath = parseInstalledApkPath(apkPathRaw, binding.ordinal);
  const apkSha256 = parseInstalledApkSha256(
    await adb.run(binding.serial, ["exec-out", "sha256sum", apkPath]),
    binding.ordinal
  );
  const model =
    binding.expectedModel === null || binding.expectedModel === undefined
      ? null
      : parseB0DeviceModel(modelRaw);
  if (
    currentUser !== binding.currentUser ||
    installedVersion.versionName !== target.versionName ||
    installedVersion.versionCode !== target.versionCode ||
    packageState.appUid !== binding.appUid ||
    packageState.stopped ||
    parsePid(pidRaw) !== binding.pid ||
    apkSha256 !== binding.apkSha256 ||
    apkSha256 !== target.sha256 ||
    model !== binding.model ||
    model !== (binding.expectedModel ?? null)
  ) {
    fail("FINAL_BINDING_CHANGED", "Android role binding changed during B0 capture");
  }
  return true;
}

export function buildRestoreArgs(binding) {
  return binding.wasForeground
    ? [
        "shell",
        "am",
        "start",
        "-W",
        "--user",
        String(binding.currentUser),
        "-n",
        binding.launcherComponent
      ]
    : ["shell", "input", "keyevent", "KEYCODE_HOME"];
}

export async function restoreAppState(adb, bindings) {
  const failures = [];
  for (const binding of bindings) {
    try {
      await adb.run(binding.serial, buildRestoreArgs(binding));
    } catch {
      failures.push(binding.ordinal);
    }
  }
  if (failures.length > 0) {
    fail("APP_STATE_RESTORE_FAILED", "Palmare foreground state could not be restored");
  }
  return true;
}

export async function runPhysicalCapture(options, runtime = {}) {
  const adb = runtime.adb ?? new AdbClient(options.adb);
  const sessionKey = crypto.randomBytes(32);
  const captureRunId = crypto.randomUUID();
  const startedAt = new Date((runtime.now ?? Date.now)()).toISOString();
  let bindings = [];
  let privateEvidence = null;
  let captureError = null;
  try {
    const inventory = parseAdbDevices(await adb.run(null, ["devices", "-l"]));
    for (const serial of [options.primarySerial, options.secondarySerial]) {
      const selected = inventory.filter((device) => device.serial === serial);
      if (selected.length !== 1 || selected[0].state !== "device") {
        fail("ADB_TARGET_UNAVAILABLE", "one fixed Palmare target is unavailable");
      }
    }
    bindings = await Promise.all([
      captureStaticBinding(adb, options.primarySerial, "handheld-1"),
      captureStaticBinding(adb, options.secondarySerial, "handheld-2")
    ]);
    const exitBaselines = await Promise.all(
      bindings.map((binding) => captureExitInfo(adb, binding))
    );
    const anchorSamples = await Promise.all(
      bindings.map((binding) => captureDeviceSample(adb, binding, sessionKey, runtime))
    );
    bindings = bindings.map((binding, index) => {
      const anchor = anchorSamples[index];
      if (
        anchor.pid !== binding.initialPid ||
        anchor.appUid !== binding.appUid ||
        anchor.currentUser !== binding.currentUser ||
        anchor.installedVersion.versionName !== TARGET.versionName ||
        anchor.installedVersion.versionCode !== TARGET.versionCode
      ) {
        fail("INITIAL_BINDING_CHANGED", "Palmare binding changed during B0 setup");
      }
      return Object.freeze({
        ...binding,
        pid: anchor.pid,
        sessionBindingHmacSha256: anchor.sessionBindingHmacSha256,
        discoveryReporterStartedAtEpochMs:
          anchor.discovery.reporterStartedAtEpochMs,
        agentReporterStartedAtEpochMs: anchor.agent.reporterStartedAtEpochMs,
        gattReporterStartedAtEpochMs: anchor.gatt.reporterStartedAtEpochMs
      });
    });
    await Promise.all(
      bindings.map((binding) =>
        adb.run(binding.serial, [
          "shell",
          "am",
          "start",
          "-W",
          "--user",
          String(binding.currentUser),
          "-n",
          binding.launcherComponent
        ])
      )
    );
    const capabilities = await Promise.all(
      bindings.map((binding) =>
        (runtime.capabilityReader ?? readNativeCapabilityViaAdb)(
          adb,
          binding.serial,
          binding.pid,
          runtime
        )
      )
    );
    const initialSamples = await Promise.all(
      bindings.map((binding) => captureDeviceSample(adb, binding, sessionKey, runtime))
    );
    const schedule = runtime.schedule ?? buildCaptureSchedule();
    const foregroundAdditional = await collectScheduledSamples(
      adb,
      bindings,
      sessionKey,
      schedule.foregroundOffsetsMs,
      runtime
    );
    const foregroundSamples = initialSamples.map((sample, index) => [
      sample,
      ...foregroundAdditional[index]
    ]);
    await Promise.all(
      bindings.map((binding) =>
        adb.run(binding.serial, ["shell", "input", "keyevent", "KEYCODE_HOME"])
      )
    );
    await (runtime.sleep ?? sleep)(schedule.backgroundSettleMs);
    const backgroundSamples = await collectScheduledSamples(
      adb,
      bindings,
      sessionKey,
      schedule.backgroundOffsetsMs,
      runtime
    );
    const exitFinals = await Promise.all(
      bindings.map((binding) => captureExitInfo(adb, binding))
    );
    await Promise.all(bindings.map((binding) => verifyFinalBinding(adb, binding)));
    const devices = bindings.map((binding, index) => {
      const result = evaluateDeviceEvidence({
        binding,
        capability: capabilities[index],
        foregroundSamples: foregroundSamples[index],
        backgroundSamples: backgroundSamples[index],
        exitBaseline: exitBaselines[index],
        exitFinal: exitFinals[index]
      });
      return Object.freeze({
        binding,
        capability: capabilities[index],
        foregroundSamples: Object.freeze(
          foregroundSamples[index].map(serializeSample)
        ),
        backgroundSamples: Object.freeze(
          backgroundSamples[index].map(serializeSample)
        ),
        exitBaseline: serializeExitInfo(exitBaselines[index]),
        exitFinal: serializeExitInfo(exitFinals[index]),
        result
      });
    });
    privateEvidence = {
      schemaVersion: 1,
      harnessVersion: B0_ANDROID_SUPPLEMENTAL_VERSION,
      source: "V5BT_B0_ANDROID_SUPPLEMENTAL_PRIVATE",
      evidenceClass: "SUPPLEMENTAL",
      gateImpact: "NON_GATE_EVIDENCE",
      formalGate: "PENDING_UNCHANGED",
      captureRunId,
      startedAt,
      endedAt: new Date((runtime.now ?? Date.now)()).toISOString(),
      fixedDurationSeconds: B0_CAPTURE_DURATION_SECONDS,
      sessionHmacKeyBase64: sessionKey.toString("base64"),
      devices: Object.freeze(devices),
      runnerPolicy: Object.freeze({
        forceStopAllowed: false,
        uninstallAllowed: false,
        clearDataAllowed: false,
        finalAppStopAllowed: false
      })
    };
  } catch (error) {
    captureError = error;
  }

  let restorationError = null;
  const restoration = {
    attempted: bindings.length > 0,
    completed: bindings.length === 0
  };
  try {
    if (bindings.length > 0) {
      await restoreAppState(adb, bindings);
      restoration.completed = true;
    }
  } catch (error) {
    restorationError = error;
  } finally {
    sessionKey.fill(0);
  }
  if (restorationError !== null) {
    fail("APP_STATE_RESTORE_FAILED", "Palmare foreground state could not be restored", 1, {
      cause: restorationError
    });
  }
  if (captureError !== null) throw captureError;
  if (privateEvidence === null) {
    fail("EVIDENCE_INCOMPLETE", "B0 private evidence was not produced");
  }
  return Object.freeze({
    ...privateEvidence,
    restoration: Object.freeze(restoration)
  });
}

export function parseArguments(argv) {
  const options = {
    mode: "PHYSICAL",
    adb: null,
    primarySerial: null,
    secondarySerial: null,
    privateOutput: null,
    reportOutput: null
  };
  const valueOptions = new Map([
    ["--adb", "adb"],
    ["--primary-serial", "primarySerial"],
    ["--secondary-serial", "secondarySerial"],
    ["--private-output", "privateOutput"],
    ["--report-output", "reportOutput"]
  ]);
  const flagModes = new Map([
    ["--dry-run", "DRY_RUN"],
    ["--self-test", "SELF_TEST"],
    ["--help", "HELP"]
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flagModes.has(argument)) {
      if (options.mode !== "PHYSICAL" || seen.has(argument)) {
        fail("INVALID_ARGUMENT", "B0 mode flags are mutually exclusive");
      }
      options.mode = flagModes.get(argument);
      seen.add(argument);
      continue;
    }
    const field = valueOptions.get(argument);
    const value = argv[index + 1];
    if (
      field === undefined ||
      seen.has(argument) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      fail("INVALID_ARGUMENT", "B0 arguments are invalid");
    }
    options[field] = value;
    seen.add(argument);
    index += 1;
  }
  if (options.mode !== "PHYSICAL") {
    if (seen.size !== 1) fail("INVALID_ARGUMENT", "B0 offline modes take no options");
    return Object.freeze(options);
  }
  if (
    !path.isAbsolute(options.adb ?? "") ||
    !SERIAL_PATTERN.test(options.primarySerial ?? "") ||
    !SERIAL_PATTERN.test(options.secondarySerial ?? "") ||
    options.primarySerial === options.secondarySerial ||
    !path.isAbsolute(options.privateOutput ?? "") ||
    !path.isAbsolute(options.reportOutput ?? "") ||
    path.resolve(options.privateOutput) === path.resolve(options.reportOutput)
  ) {
    fail("INVALID_ARGUMENT", "physical B0 arguments are incomplete or invalid");
  }
  return Object.freeze(options);
}

export function buildDryRun() {
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B0_ANDROID_SUPPLEMENTAL_VERSION,
    source: "V5BT_B0_ANDROID_SUPPLEMENTAL",
    mode: "DRY_RUN",
    evidenceClass: "SUPPLEMENTAL",
    gateImpact: "NON_GATE_EVIDENCE",
    formalGate: "PENDING_UNCHANGED",
    formalGatePromoted: false,
    physicalAdbAccessed: false,
    requiredControls: B0_REQUIRED_CONTROLS,
    fixedDurationSeconds: B0_CAPTURE_DURATION_SECONDS,
    finalForceStop: false,
    result: "PENDING_PHYSICAL_CAPTURE"
  });
}

function syntheticCapability() {
  return parseCapabilityReport(
    JSON.stringify({
      manufacturer: "Synthetic",
      model: "Synthetic",
      androidApi: 36,
      bluetoothLeFeature: true,
      adapterPresent: true,
      adapterEnabled: true,
      scanPermission: true,
      advertisePermission: true,
      connectPermission: true,
      scannerAvailable: true,
      advertiserAvailable: true,
      gattClientAvailable: true,
      multipleAdvertisementSupported: true,
      offloadedFilteringSupported: true,
      offloadedScanBatchingSupported: true,
      gattServerOpen: true,
      probeStatus: "COMPLETE",
      scan: true,
      advertise: true,
      gattClient: true,
      gattServer: true,
      classification: "FULL_NODE",
      b0GateComplete: false,
      pendingFieldTests: [
        "SCAN_ADVERTISE_CONCURRENT",
        "WIFI_BLE_COEXISTENCE",
        "BACKGROUND_FOREGROUND"
      ]
    })
  );
}

export function runSelfTest() {
  const capability = syntheticCapability();
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B0_ANDROID_SUPPLEMENTAL_VERSION,
    source: "V5BT_B0_ANDROID_SUPPLEMENTAL",
    mode: "SELF_TEST",
    verdict: capability.classification === "FULL_NODE" ? "PASS" : "FAIL",
    synthetic: true,
    physicalAdbAccessed: false,
    evidenceClass: "NON_GATE_EVIDENCE",
    formalGate: "PENDING_UNCHANGED",
    formalGatePromoted: false
  });
}

function usage() {
  return [
    "V5BT B0 Android supplemental gate",
    "",
    "  --adb /abs/adb --primary-serial ID --secondary-serial ID \\",
    "    --private-output /secure/evidence.json --report-output /redacted/report.json",
    "  --dry-run",
    "  --self-test",
    ""
  ].join("\n");
}

export function buildPublicFailure(error) {
  const failureCode =
    typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/u.test(error.code)
      ? error.code
      : "UNEXPECTED_FAILURE";
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B0_ANDROID_SUPPLEMENTAL_VERSION,
    source: "V5BT_B0_ANDROID_SUPPLEMENTAL",
    evidenceClass: "NON_GATE_EVIDENCE",
    gateImpact: "NON_GATE_EVIDENCE",
    formalGate: "PENDING_UNCHANGED",
    formalGatePromoted: false,
    result: "SUPPLEMENTAL_FAIL",
    failure: Object.freeze({
      code: failureCode,
      message: "B0 supplemental capture failed"
    }),
    privacy: Object.freeze({ redacted: true })
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
    if (options.mode === "DRY_RUN") {
      process.stdout.write(`${JSON.stringify(buildDryRun(), null, 2)}\n`);
      return 0;
    }
    if (options.mode === "SELF_TEST") {
      process.stdout.write(`${JSON.stringify(runSelfTest(), null, 2)}\n`);
      return 0;
    }
    const privateEvidence = await runPhysicalCapture(options, runtime);
    const { report } = publishEvidencePair(
      options.privateOutput,
      options.reportOutput,
      privateEvidence
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.result === "SUPPLEMENTAL_PASS" ? 0 : 1;
  } catch (error) {
    const report = buildPublicFailure(error);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return error instanceof B0SupplementalError ? error.exitCode : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
