#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING,
} from "../ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/scripts/advanced-certification-targets.mjs";

const MAX_FIXTURE_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const SERIAL_PATTERN = /^[A-Za-z0-9._:~-]{1,160}$/u;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const APK_PATH_PATTERN = /^\/data\/app\/[A-Za-z0-9_./=+~-]+\.apk$/u;
const READ_ONLY_APP_FILES = new Set([
  "shared_prefs/webkiosk_prefs.xml",
  "shared_prefs/cassav5bt_bluetooth_identity_v1.xml",
  "no_backup/bluetooth-enrollment-status-v1.json",
]);
const ENROLLMENT_ATTEMPT_STATUSES = new Set([
  "IDLE",
  "BUSY",
  "INPUT_INVALID",
  "ENDPOINT_MISMATCH",
  "IDENTITY_FAILED",
  "CLIENT_FAILED",
  "IMPORT_FAILED",
  "READY",
  "ALREADY_PROVISIONED",
  "STORAGE_FAILED",
  "INTERRUPTED",
  "CLOSED",
]);
const REQUIRED_CERTIFIED_ROLES = Object.freeze(["handheld", "station"]);
const PARSED_CONFIGS = new WeakSet();
const SERVICE_REQUIREMENTS = Object.freeze({
  "cassav5bt.service": Object.freeze({
    requirement: "OPERATIONAL_REQUIRED",
    expectedState: "LOADED_ACTIVE_ENABLED",
  }),
  "bluetooth.service": Object.freeze({
    requirement: "OPERATIONAL_REQUIRED",
    expectedState: "LOADED_ACTIVE_ENABLED",
  }),
  "cassav5bt-bluetooth-node.service": Object.freeze({
    requirement: "OBSERVE_ONLY",
    expectedState: "ANY_OBSERVED_STATE",
  }),
  "cassav5bt-bluetooth-enrollment.service": Object.freeze({
    requirement: "OBSERVE_ONLY",
    expectedState: "ANY_OBSERVED_STATE",
  }),
});
const SERVICES = Object.freeze(Object.keys(SERVICE_REQUIREMENTS));
const SERVICE_PROPERTY_NAMES = Object.freeze([
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
]);
const UPS_PROBE_IDS = new Set([
  "raspberry.ups.discovery",
  "raspberry.ups.services",
]);
const STATE_ROOT = "/var/lib/cassav5bt-bluetooth";
const REGISTRY_PATH = `${STATE_ROOT}/devices.json`;
const TRANSACTION_ROOT = `${STATE_ROOT}/enrollment-transactions`;
const TLS_KEY_PATH = "/etc/cassav5bt/bluetooth-enrollment.key";
const TLS_CERT_PATH = "/etc/cassav5bt/bluetooth-enrollment.crt";
const ENVIRONMENT_PATH = "/etc/cassav5bt/cassav5bt-bluetooth-enrollment.env";
const SUDO_REMOTE_PREFIX = "/usr/bin/sudo -S -p '' -- ";
const SSH_AUTH_PUBLIC_KEY = "PUBLIC_KEY";
const SSH_AUTH_PASSWORD = "PASSWORD";
const SSH_PUBLIC_KEY_OPTIONS = Object.freeze([
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "LogLevel=ERROR",
  "-p",
]);
const SSH_PASSWORD_OPTIONS = Object.freeze([
  "-o", "BatchMode=no",
  "-o", "PreferredAuthentications=password",
  "-o", "PasswordAuthentication=yes",
  "-o", "PubkeyAuthentication=no",
  "-o", "KbdInteractiveAuthentication=no",
  "-o", "NumberOfPasswordPrompts=1",
  "-o", "ConnectTimeout=8",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "LogLevel=ERROR",
  "-p",
]);

const REMOTE_COMMANDS = Object.freeze({
  identity: "/usr/bin/uname -m",
  bluezVersion: "/usr/bin/bluetoothctl --version",
  bluezShow: "/usr/bin/bluetoothctl show",
  ntp: "/usr/bin/timedatectl show --property=NTPSynchronized --property=TimeUSec --property=Timezone",
  upsDiscovery: "/usr/bin/upsc -l",
  upsServices: "/usr/bin/systemctl list-units 'nut-*' 'ups-*' --all --no-legend --plain",
  stateStat: `/usr/bin/stat --dereference --format=%a,%U,%G,%s,%F -- ${STATE_ROOT}`,
  registryStat: `/usr/bin/stat --dereference --format=%a,%U,%G,%s,%F -- ${REGISTRY_PATH}`,
  registryRead: `/usr/bin/cat -- ${REGISTRY_PATH}`,
  transactionsStat: `/usr/bin/stat --dereference --format=%a,%U,%G,%s,%F -- ${TRANSACTION_ROOT}`,
  transactionsList: `/usr/bin/find ${TRANSACTION_ROOT} -maxdepth 2 -type f -printf '%y,%m,%u,%g,%p\\n'`,
  tlsKeyStat: `/usr/bin/stat --dereference --format=%a,%U,%G,%s,%F -- ${TLS_KEY_PATH}`,
  tlsCertStat: `/usr/bin/stat --dereference --format=%a,%U,%G,%s,%F -- ${TLS_CERT_PATH}`,
  environmentStat: `/usr/bin/stat --dereference --format=%a,%U,%G,%s,%F -- ${ENVIRONMENT_PATH}`,
});

export class BenchInventoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BenchInventoryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BenchInventoryError(code, message);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("CONFIG_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("CONFIG_INVALID", `${label} contains missing or unexpected fields`);
  }
}

function validHost(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return false;
  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(value)) {
    return value.split(".").every((octet) => Number(octet) <= 255);
  }
  return value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
}

export function parseBenchInventoryConfig(value) {
  exactKeys(value, ["android", "raspberryHost", "raspberryUser", "schemaVersion", "sshPort"], "config");
  if (value.schemaVersion !== 1) fail("CONFIG_INVALID", "config schemaVersion must be 1");
  if (!validHost(value.raspberryHost)) fail("CONFIG_INVALID", "Raspberry host is invalid");
  if (typeof value.raspberryUser !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(value.raspberryUser)) {
    fail("CONFIG_INVALID", "Raspberry SSH user is invalid");
  }
  if (!Number.isSafeInteger(value.sshPort) || value.sshPort < 1 || value.sshPort > 65535) {
    fail("CONFIG_INVALID", "SSH port is invalid");
  }
  if (!Array.isArray(value.android) || value.android.length < 1 || value.android.length > 10) {
    fail("CONFIG_INVALID", "one to ten Android targets are required");
  }
  const labels = new Set();
  const serials = new Set();
  const android = value.android.map((entry, index) => {
    exactKeys(entry, ["expectedUserId", "label", "role", "serial"], `android[${index}]`);
    if (typeof entry.label !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(entry.label) || labels.has(entry.label)) {
      fail("CONFIG_INVALID", `android[${index}] label is invalid or duplicated`);
    }
    if (!Object.hasOwn(ADVANCED_CERTIFICATION_TARGETS.roles, entry.role)) {
      fail("CONFIG_INVALID", `android[${index}] role is invalid`);
    }
    if (typeof entry.serial !== "string" || !SERIAL_PATTERN.test(entry.serial) || serials.has(entry.serial)) {
      fail("CONFIG_INVALID", `android[${index}] serial is invalid or duplicated`);
    }
    if (!Number.isSafeInteger(entry.expectedUserId) || entry.expectedUserId < 0 || entry.expectedUserId > 9999) {
      fail("CONFIG_INVALID", `android[${index}] Android user is invalid`);
    }
    labels.add(entry.label);
    serials.add(entry.serial);
    const target = ADVANCED_CERTIFICATION_TARGETS.roles[entry.role];
    return Object.freeze({
      label: entry.label,
      role: entry.role,
      serial: entry.serial,
      expectedUserId: entry.expectedUserId,
      packageId: target.packageId,
      expectedVersionName: target.versionName,
      expectedVersionCode: target.versionCode,
      expectedApkSha256: target.sha256,
      expectedSigningCertificateSha256: target.signingCertificateSha256,
    });
  });
  const parsed = Object.freeze({
    schemaVersion: 1,
    raspberryHost: value.raspberryHost,
    raspberryUser: value.raspberryUser,
    sshPort: value.sshPort,
    android: Object.freeze(android),
  });
  PARSED_CONFIGS.add(parsed);
  return parsed;
}

function adbProbe(id, serial, args) {
  return Object.freeze({ id, transport: "ADB", executable: "adb", args: Object.freeze(serial === null ? [...args] : ["-s", serial, ...args]) });
}

function sshProbe(config, id, remoteCommand, useSudo = false, sshAuthentication = SSH_AUTH_PUBLIC_KEY) {
  if (!allowedRemoteCommands().has(remoteCommand)) {
    fail("COMMAND_NOT_ALLOWED", "remote command is outside the inventory allowlist");
  }
  const authOptions = sshAuthentication === SSH_AUTH_PASSWORD
    ? SSH_PASSWORD_OPTIONS
    : sshAuthentication === SSH_AUTH_PUBLIC_KEY
      ? SSH_PUBLIC_KEY_OPTIONS
      : null;
  if (authOptions === null) fail("SSH_AUTH_INVALID", "SSH authentication method is invalid");
  return Object.freeze({
    id,
    transport: "SSH",
    executable: "ssh",
    args: Object.freeze([
      ...authOptions, String(config.sshPort),
      `${config.raspberryUser}@${config.raspberryHost}`,
      "--",
      useSudo ? `${SUDO_REMOTE_PREFIX}${remoteCommand}` : remoteCommand,
    ]),
  });
}

function serviceRemoteCommand(service) {
  if (!SERVICES.includes(service)) fail("COMMAND_NOT_ALLOWED", "service is outside the inventory allowlist");
  return `/usr/bin/systemctl show --no-pager --property=LoadState --property=ActiveState --property=SubState --property=UnitFileState ${service}`;
}

function allowedRemoteCommands() {
  return new Set([
    ...Object.values(REMOTE_COMMANDS),
    ...SERVICES.map(serviceRemoteCommand),
  ]);
}

function allowedSshRemoteCommand(remote) {
  if (allowedRemoteCommands().has(remote)) return true;
  return remote.startsWith(SUDO_REMOTE_PREFIX) &&
    allowedRemoteCommands().has(remote.slice(SUDO_REMOTE_PREFIX.length));
}

function matchesTail(args, wanted) {
  return args.length === wanted.length && args.every((value, index) => value === wanted[index]);
}

function parseCanonicalSshCommand(args) {
  const profiles = [
    [SSH_AUTH_PUBLIC_KEY, SSH_PUBLIC_KEY_OPTIONS],
    [SSH_AUTH_PASSWORD, SSH_PASSWORD_OPTIONS],
  ];
  for (const [authentication, options] of profiles) {
    if (args.length !== options.length + 4 || !matchesTail(args.slice(0, options.length), options)) continue;
    const port = Number(args[options.length]);
    const target = args[options.length + 1] ?? "";
    const separator = target.indexOf("@");
    const user = separator < 0 ? "" : target.slice(0, separator);
    const host = separator < 0 ? "" : target.slice(separator + 1);
    if (
      !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      !/^[a-z_][a-z0-9_-]{0,31}$/u.test(user) || !validHost(host) ||
      args[options.length + 2] !== "--"
    ) {
      fail("COMMAND_NOT_ALLOWED", "SSH target is invalid");
    }
    const remote = args[options.length + 3];
    if (!allowedSshRemoteCommand(remote)) {
      fail("COMMAND_NOT_ALLOWED", "remote command is outside the inventory allowlist");
    }
    return Object.freeze({ authentication, remote });
  }
  fail("COMMAND_NOT_ALLOWED", "SSH options are not canonical");
}

function assertAllowedAdb(args) {
  if (matchesTail(args, ["devices", "-l"])) return;
  if (args.length < 4 || args[0] !== "-s" || !SERIAL_PATTERN.test(args[1])) {
    fail("COMMAND_NOT_ALLOWED", "ADB command is outside the inventory allowlist");
  }
  const tail = args.slice(2);
  if (matchesTail(tail, ["shell", "am", "get-current-user"])) return;
  if (matchesTail(tail, ["shell", "getprop", "ro.build.version.sdk"])) return;
  if (tail.length === 4 && matchesTail(tail.slice(0, 3), ["shell", "dumpsys", "package"]) && PACKAGE_PATTERN.test(tail[3])) return;
  if (
    tail.length === 6 &&
    matchesTail(tail.slice(0, 4), ["shell", "pm", "path", "--user"]) &&
    /^[0-9]{1,4}$/u.test(tail[4]) &&
    PACKAGE_PATTERN.test(tail[5])
  ) return;
  if (
    tail.length === 7 &&
    matchesTail(tail.slice(0, 2), ["exec-out", "run-as"]) &&
    PACKAGE_PATTERN.test(tail[2]) &&
    tail[3] === "--user" &&
    /^[0-9]{1,4}$/u.test(tail[4]) &&
    tail[5] === "cat" &&
    READ_ONLY_APP_FILES.has(tail[6])
  ) return;
  if (
    tail.length === 3 &&
    tail[0] === "exec-out" &&
    tail[1] === "sha256sum" &&
    APK_PATH_PATTERN.test(tail[2]) &&
    !tail[2].split("/").includes("..")
  ) return;
  fail("COMMAND_NOT_ALLOWED", "ADB command is outside the inventory allowlist");
}

export function assertReadOnlyCommand(spec) {
  exactKeys(spec, ["args", "executable", "id", "transport"], "command");
  if (typeof spec.id !== "string" || !/^[a-z][a-zA-Z0-9_.-]{0,127}$/u.test(spec.id)) {
    fail("COMMAND_NOT_ALLOWED", "probe id is invalid");
  }
  if (!Array.isArray(spec.args) || spec.args.some((argument) => typeof argument !== "string" || /[\x00-\x1f\x7f]/u.test(argument))) {
    fail("COMMAND_NOT_ALLOWED", "command arguments are invalid");
  }
  if (spec.transport === "ADB" && spec.executable === "adb") {
    assertAllowedAdb(spec.args);
    return true;
  }
  if (spec.transport === "SSH" && spec.executable === "ssh") {
    parseCanonicalSshCommand(spec.args);
    return true;
  }
  fail("COMMAND_NOT_ALLOWED", "executable is outside the inventory allowlist");
}

function assertPassword(value, code, label) {
  if (
    value !== null &&
    (typeof value !== "string" || value.length < 1 || value.length > 1024 || /[\r\n\0]/u.test(value))
  ) {
    fail(code, `${label} password input is invalid`);
  }
}

export function consumePasswordEnvironmentVariable(name, label) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(name ?? "")) {
    fail("ARGUMENT_INVALID", `${label} password environment variable name is invalid`);
  }
  const password = process.env[name];
  delete process.env[name];
  if (password === undefined) fail("ARGUMENT_INVALID", `${label} password environment variable is not set`);
  assertPassword(password, label === "SSH" ? "SSH_PASSWORD_INVALID" : "SUDO_PASSWORD_INVALID", label);
  return password;
}

export function createExecCommandRunner({ sudoPassword = null, sshPassword = null, execFileImpl = execFile } = {}) {
  assertPassword(sudoPassword, "SUDO_PASSWORD_INVALID", "sudo");
  assertPassword(sshPassword, "SSH_PASSWORD_INVALID", "SSH");
  if (typeof execFileImpl !== "function") fail("RUNNER_INVALID", "execFile implementation must be a function");
  return (spec) => new Promise((resolve) => {
    assertReadOnlyCommand(spec);
    const sshCommand = spec.transport === "SSH" ? parseCanonicalSshCommand(spec.args) : null;
    const passwordAuthentication = sshCommand?.authentication === SSH_AUTH_PASSWORD;
    if (spec.transport === "SSH" && passwordAuthentication !== (sshPassword !== null)) {
      fail("SSH_AUTH_SPEC_MISMATCH", "SSH command authentication does not match runner authentication");
    }
    const sudoRequired = sshCommand?.remote.startsWith(SUDO_REMOTE_PREFIX) === true;
    if (sudoRequired && sudoPassword === null) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: "read-only sudo authentication is unavailable",
        timedOut: false,
      });
      return;
    }
    const executable = passwordAuthentication ? "sshpass" : spec.executable;
    const args = passwordAuthentication ? ["-e", "ssh", ...spec.args] : spec.args;
    const childOptions = {
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    };
    if (passwordAuthentication) {
      childOptions.env = { ...process.env, SSHPASS: sshPassword };
    }
    const child = execFileImpl(executable, args, childOptions, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : (error?.message ?? ""),
        timedOut: Boolean(error?.killed),
      });
    });
    if (sudoRequired) child.stdin.end(`${sudoPassword}\n`, "utf8");
  });
}

export function createFixtureCommandRunner(results) {
  if (results === null || typeof results !== "object" || Array.isArray(results)) {
    fail("FIXTURE_INVALID", "fixture results must be an object");
  }
  const remaining = new Set(Object.keys(results));
  const runner = async (spec) => {
    assertReadOnlyCommand(spec);
    if (!Object.hasOwn(results, spec.id)) fail("FIXTURE_MISSING", `fixture result missing for ${spec.id}`);
    const result = results[spec.id];
    exactKeys(result, ["exitCode", "stderr", "stdout", "timedOut"], `fixture result ${spec.id}`);
    if (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0 || typeof result.stdout !== "string" || typeof result.stderr !== "string" || typeof result.timedOut !== "boolean") {
      fail("FIXTURE_INVALID", `fixture result ${spec.id} is invalid`);
    }
    remaining.delete(spec.id);
    return { ...result };
  };
  runner.assertConsumed = () => {
    if (remaining.size > 0) fail("FIXTURE_UNUSED", `unused fixture results: ${[...remaining].sort().join(", ")}`);
  };
  return runner;
}

function resultRecord(spec, result, startedAt, completedAt) {
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT_BYTES || Buffer.byteLength(stderr) > MAX_COMMAND_OUTPUT_BYTES) {
    fail("COMMAND_OUTPUT_TOO_LARGE", `${spec.id} output exceeds the inventory limit`);
  }
  return Object.freeze({
    id: spec.id,
    transport: spec.transport,
    command: Object.freeze({ executable: spec.executable, args: Object.freeze([...spec.args]) }),
    outcome: result.exitCode === 0 ? "PASS" : "ERROR",
    exitCode: result.exitCode,
    timedOut: Boolean(result.timedOut),
    stdout,
    stderr,
    startedAt,
    completedAt,
  });
}

async function captureProbe(spec, context) {
  assertReadOnlyCommand(spec);
  const startedAt = context.clock().toISOString();
  let result;
  try {
    result = await context.runner(spec);
  } catch (error) {
    if (error instanceof BenchInventoryError && error.code.startsWith("FIXTURE_")) throw error;
    result = { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : "runner failed", timedOut: false };
  }
  const completedAt = context.clock().toISOString();
  const record = resultRecord(spec, result, startedAt, completedAt);
  context.records.push(record);
  return record;
}

function adbDevices(raw) {
  const devices = new Map();
  for (const line of String(raw).split(/\r?\n/u).slice(1)) {
    const match = line.trim().match(/^(\S+)\s+(device|offline|unauthorized|no permissions)(?:\s|$)/u);
    if (match && !devices.has(match[1])) devices.set(match[1], match[2]);
  }
  return devices;
}

function currentUser(raw) {
  const value = String(raw).trim();
  return /^[0-9]{1,4}$/u.test(value) ? Number(value) : null;
}

function androidApi(raw) {
  const value = Number(String(raw).trim());
  return Number.isSafeInteger(value) && value >= 24 && value <= 99 ? value : null;
}

function packageInventory(raw) {
  const text = String(raw);
  const versionNameCandidate = text.match(/^\s*versionName=([^\s]+)\s*$/mu)?.[1] ?? null;
  const versionName = /^[0-9]+(?:\.[0-9]+){2}$/u.test(versionNameCandidate ?? "") ? versionNameCandidate : null;
  const versionCodeText = text.match(/^\s*versionCode=([0-9]+)(?:\s|$)/mu)?.[1] ?? null;
  const versionCode = versionCodeText === null ? null : Number(versionCodeText);
  const permissions = Object.fromEntries([
    "android.permission.BLUETOOTH_SCAN",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.BLUETOOTH_ADVERTISE",
  ].map((permission) => [permission, new RegExp(`${permission.replaceAll(".", "\\.")}:\\s+granted=true`, "u").test(text)]));
  const installed = /\binstalled=true\b/u.test(text);
  const stoppedValue = text.match(/\bstopped=(true|false)\b/u)?.[1] ?? null;
  const stopped = stoppedValue === null ? null : stoppedValue === "true";
  return { versionName, versionCode, permissions, installed, stopped };
}

function apkPath(raw) {
  const lines = String(raw).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith("package:")) return null;
  const value = lines[0].slice("package:".length);
  if (!APK_PATH_PATTERN.test(value) || value.split("/").includes("..")) return null;
  return value;
}

function apkDigest(raw) {
  return String(raw).match(/^([0-9a-fA-F]{64})\s+\S+\s*$/u)?.[1]?.toLowerCase() ?? null;
}

function xmlStrings(raw) {
  const text = String(raw);
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) return null;
  const output = new Map();
  for (const match of text.matchAll(/<string\s+name="([A-Za-z0-9_.-]+)">([^<]*)<\/string>/gu)) {
    if (output.has(match[1])) return null;
    output.set(match[1], match[2]);
  }
  return output;
}

function sessionInventory(raw) {
  const values = xmlStrings(raw);
  const authenticated = values !== null && ["notification_token", "notification_user_id", "notification_device_uuid"].every((key) => (values.get(key) ?? "").trim().length > 0);
  return {
    authenticated,
    deviceUuid: authenticated ? values.get("notification_device_uuid").trim() : null,
  };
}

function enrollmentInventory(raw) {
  const values = xmlStrings(raw);
  const ready = values !== null && values.get("enrollment_state") === "READY" && ["enrollment_node_id", "enrollment_certificate_id"].every((key) => (values.get(key) ?? "").trim().length > 0);
  return {
    ready,
    nodeId: ready ? values.get("enrollment_node_id").trim() : null,
    certificateId: ready ? values.get("enrollment_certificate_id").trim() : null,
  };
}

function enrollmentAttempt(raw) {
  try {
    const value = JSON.parse(String(raw));
    return value?.version === 1 && ENROLLMENT_ATTEMPT_STATUSES.has(value.status) ? value.status : null;
  } catch {
    return null;
  }
}

function statRecord(raw) {
  const match = String(raw).trim().match(/^([0-7]{3,4}),([^,]+),([^,]+),([0-9]+),(.+)$/u);
  return match ? { mode: match[1].slice(-3), owner: match[2], group: match[3], size: Number(match[4]), type: match[5] } : null;
}

function propertyLines(raw) {
  return Object.fromEntries(String(raw).split(/\r?\n/u).map((line) => line.match(/^([A-Za-z][A-Za-z0-9]*)=(.*)$/u)).filter(Boolean).map((match) => [match[1], match[2]]));
}

function serviceObservation(record) {
  if (record?.outcome !== "PASS") return null;
  const lines = String(record.stdout).split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== SERVICE_PROPERTY_NAMES.length) return null;
  const values = new Map();
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*)=(.*)$/u);
    if (!match || !SERVICE_PROPERTY_NAMES.includes(match[1]) || values.has(match[1])) return null;
    values.set(match[1], match[2]);
  }
  if (SERVICE_PROPERTY_NAMES.some((property) => !values.has(property))) return null;
  if (
    !/^[a-z-]+$/u.test(values.get("LoadState")) ||
    !/^[a-z-]+$/u.test(values.get("ActiveState")) ||
    !/^[a-z-]+$/u.test(values.get("SubState")) ||
    !/^(?:[a-z-]+)?$/u.test(values.get("UnitFileState"))
  ) return null;
  return Object.freeze({
    loaded: values.get("LoadState") === "loaded",
    active: values.get("ActiveState") === "active",
    subState: values.get("SubState"),
    enabled: ["enabled", "static", "indirect"].includes(values.get("UnitFileState")),
  });
}

function serviceInventory(records, service) {
  const policy = SERVICE_REQUIREMENTS[service];
  const observation = serviceObservation(probeById(records, `raspberry.service.${service}`));
  const observed = observation !== null;
  const expectationMet = policy.requirement === "OBSERVE_ONLY"
    ? observed
    : observed && observation.loaded && observation.active && observation.enabled;
  return Object.freeze({
    service,
    requirement: policy.requirement,
    expectedState: policy.expectedState,
    observed,
    expectationMet,
    loaded: observation?.loaded ?? null,
    active: observation?.active ?? null,
    subState: observation?.subState ?? null,
    enabled: observation?.enabled ?? null,
  });
}

function parseRegistry(raw, now) {
  try {
    const value = JSON.parse(String(raw));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.devices) || !Array.isArray(value.enrollmentTokens)) return null;
    const activeNodeIds = new Set(value.devices.filter((entry) => entry?.revokedAt === null && typeof entry?.nodeId === "string").map((entry) => entry.nodeId));
    return {
      devices: value.devices.length,
      activeDevices: activeNodeIds.size,
      revokedDevices: value.devices.filter((entry) => typeof entry?.revokedAt === "string").length,
      enrollmentTokens: value.enrollmentTokens.length,
      pendingTokens: value.enrollmentTokens.filter((entry) => entry?.consumedAt === null && Date.parse(entry?.expiresAt) > now.getTime()).length,
      activeNodeIds,
    };
  } catch {
    return null;
  }
}

function transactionInventory(raw) {
  const rows = String(raw).split(/\r?\n/u).filter(Boolean).map((line) => line.split(","));
  return {
    files: rows.length,
    allPrivate: rows.every((row) => row.length === 5 && row[0] === "f" && /^0?600$/u.test(row[1]) && row[2] === "cassav5bt" && row[3] === "cassav5bt"),
  };
}

function probeById(records, id) {
  return records.find((record) => record.id === id) ?? null;
}

function successful(records, id) {
  const record = probeById(records, id);
  return record?.outcome === "PASS" ? record : null;
}

function summarize(config, records, generatedAt, commandPolicy) {
  const errors = records
    .filter((record) => record.outcome !== "PASS" && !UPS_PROBE_IDS.has(record.id))
    .map((record) => Object.freeze({ probe: record.id, code: record.timedOut ? "TIMEOUT" : "UNAVAILABLE" }));
  const configuredRoles = [...new Set(config.android.map((target) => target.role))]
    .sort((left, right) => left.localeCompare(right, "en"));
  const missingRequiredRoles = REQUIRED_CERTIFIED_ROLES.filter(
    (role) => !configuredRoles.includes(role),
  );
  if (missingRequiredRoles.length > 0) {
    errors.push(Object.freeze({ probe: "android.roleCoverage", code: "REQUIRED_ROLE_MISSING" }));
  }
  const deviceStates = adbDevices(successful(records, "adb.devices")?.stdout ?? "");
  const expectedSerials = new Set(config.android.map((target) => target.serial));
  const connectedDevices = [...deviceStates.values()].filter((state) => state === "device").length;
  const unavailableDevices = [...deviceStates.values()].filter((state) => state !== "device").length;
  const unexpectedConnectedDevices = [...deviceStates.entries()].filter(([serial, state]) => state === "device" && !expectedSerials.has(serial)).length;
  const bluezShow = successful(records, "raspberry.bluez.show")?.stdout ?? "";
  const bluezVersion = (successful(records, "raspberry.bluez.version")?.stdout ?? "").match(/\b([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b/u)?.[1] ?? null;
  const architectureCandidate = (successful(records, "raspberry.identity")?.stdout ?? "").trim();
  const architecture = /^(?:aarch64|armv7l|armv8l|x86_64)$/u.test(architectureCandidate) ? architectureCandidate : null;
  const ntp = propertyLines(successful(records, "raspberry.ntp")?.stdout ?? "");
  const registryDetails = parseRegistry(successful(records, "raspberry.registry.read")?.stdout ?? "", new Date(generatedAt));
  const registry = registryDetails === null ? null : Object.freeze({
    devices: registryDetails.devices,
    activeDevices: registryDetails.activeDevices,
    revokedDevices: registryDetails.revokedDevices,
    enrollmentTokens: registryDetails.enrollmentTokens,
    pendingTokens: registryDetails.pendingTokens,
  });
  const stats = {
    state: statRecord(successful(records, "raspberry.state.stat")?.stdout ?? ""),
    registry: statRecord(successful(records, "raspberry.registry.stat")?.stdout ?? ""),
    transactions: statRecord(successful(records, "raspberry.transactions.stat")?.stdout ?? ""),
    tlsKey: statRecord(successful(records, "raspberry.tlsKey.stat")?.stdout ?? ""),
    tlsCert: statRecord(successful(records, "raspberry.tlsCert.stat")?.stdout ?? ""),
    environment: statRecord(successful(records, "raspberry.environment.stat")?.stdout ?? ""),
  };
  const transactions = transactionInventory(successful(records, "raspberry.transactions.list")?.stdout ?? "");
  const services = SERVICES.map((service) => serviceInventory(records, service));
  const androidPrivateState = config.android.map((target, index) => {
    const prefix = `android.${index}`;
    const user = currentUser(successful(records, `${prefix}.user`)?.stdout ?? "");
    const api = androidApi(successful(records, `${prefix}.api`)?.stdout ?? "");
    const installed = packageInventory(successful(records, `${prefix}.package`)?.stdout ?? "");
    const digest = apkDigest(successful(records, `${prefix}.apkSha256`)?.stdout ?? "");
    const permissionsGranted = Object.values(installed.permissions).every(Boolean);
    return {
      target,
      user,
      api,
      installed,
      digest,
      permissionsGranted,
      session: sessionInventory(successful(records, `${prefix}.session`)?.stdout ?? ""),
      enrollment: enrollmentInventory(successful(records, `${prefix}.identity`)?.stdout ?? ""),
      enrollmentAttempt: enrollmentAttempt(successful(records, `${prefix}.enrollmentStatus`)?.stdout ?? ""),
      connected: successful(records, `${prefix}.user`) !== null,
    };
  });
  const nodeCounts = new Map();
  const sessionCounts = new Map();
  for (const state of androidPrivateState) {
    if (state.enrollment.nodeId !== null) nodeCounts.set(state.enrollment.nodeId, (nodeCounts.get(state.enrollment.nodeId) ?? 0) + 1);
    if (state.session.deviceUuid !== null) sessionCounts.set(state.session.deviceUuid, (sessionCounts.get(state.session.deviceUuid) ?? 0) + 1);
  }
  const android = androidPrivateState.map((state) => {
    const { target, installed } = state;
    const enrollmentIdentityDistinct = state.enrollment.nodeId !== null && nodeCounts.get(state.enrollment.nodeId) === 1;
    const sessionIdentityDistinct = state.session.deviceUuid !== null && sessionCounts.get(state.session.deviceUuid) === 1;
    const registryBindingMatches = state.enrollment.nodeId !== null && registryDetails?.activeNodeIds.has(state.enrollment.nodeId) === true;
    const apkSha256Matches = state.digest === target.expectedApkSha256;
    return Object.freeze({
      role: target.role,
      connected: state.connected,
      androidUserMatches: state.user === target.expectedUserId,
      androidApi: state.api,
      packageInstalled: installed.installed,
      packageStopped: installed.installed ? installed.stopped : null,
      versionName: installed.versionName,
      versionCode: installed.versionCode,
      versionNameMatches: installed.versionName === target.expectedVersionName,
      versionCodeMatches: installed.versionCode === target.expectedVersionCode,
      apkSha256Matches,
      expectedSigningCertificateSha256:
        target.expectedSigningCertificateSha256,
      signingCertificatePinCoveredByCertifiedApk: apkSha256Matches,
      permissionsGranted: state.permissionsGranted,
      authenticatedSession: state.session.authenticated,
      sessionIdentityDistinct,
      enrollmentReady: state.enrollment.ready,
      enrollmentIdentityDistinct,
      registryBindingMatches,
      enrollmentAttempt: state.enrollmentAttempt,
    });
  });
  const raspberryReachable = successful(records, "raspberry.identity") !== null;
  const upsDiscovery = probeById(records, "raspberry.ups.discovery");
  const upsServices = probeById(records, "raspberry.ups.services");
  const upsNames = (upsDiscovery?.outcome === "PASS" ? upsDiscovery.stdout : "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const limitations = [];
  if (raspberryReachable) {
    if (upsDiscovery?.outcome !== "PASS") {
      limitations.push(Object.freeze({ code: "UPS_DISCOVERY_UNAVAILABLE" }));
    } else if (upsNames.length === 0) {
      limitations.push(Object.freeze({ code: "UPS_NO_DEVICES_DISCOVERED" }));
    }
    if (upsServices?.outcome !== "PASS") {
      limitations.push(Object.freeze({ code: "UPS_SERVICE_DISCOVERY_UNAVAILABLE" }));
    }
  }
  const permissionsSecure =
    stats.state?.mode === "700" && stats.state.owner === "cassav5bt" && stats.state.group === "cassav5bt" &&
    stats.registry?.mode === "600" && stats.registry.owner === "cassav5bt" && stats.registry.group === "cassav5bt" &&
    stats.transactions?.mode === "700" && stats.transactions.owner === "cassav5bt" && stats.transactions.group === "cassav5bt" &&
    stats.tlsKey?.mode === "600" && stats.tlsKey.owner === "cassav5bt" && stats.tlsKey.group === "cassav5bt" &&
    stats.tlsCert?.mode === "644" && stats.tlsCert.owner === "cassav5bt" && stats.tlsCert.group === "cassav5bt" &&
    stats.environment?.mode === "600" && stats.environment.owner === "root" && stats.environment.group === "root" &&
    transactions.allPrivate;
  const raspberryReady =
    raspberryReachable &&
    architecture !== null &&
    successful(records, "raspberry.bluez.version") !== null &&
    /Powered:\s+yes/iu.test(bluezShow) &&
    !/Discovering:\s+yes/iu.test(bluezShow) &&
    ntp.NTPSynchronized === "yes" &&
    registryDetails !== null &&
    registry.activeDevices >= config.android.length &&
    permissionsSecure &&
    services.every((entry) => entry.expectationMet);
  const androidReady = android.every((entry) =>
    entry.connected &&
    entry.androidUserMatches &&
    entry.packageInstalled &&
    entry.packageStopped === false &&
    entry.versionNameMatches &&
    entry.versionCodeMatches &&
    entry.apkSha256Matches &&
    entry.signingCertificatePinCoveredByCertifiedApk &&
    entry.permissionsGranted &&
    entry.authenticatedSession &&
    entry.sessionIdentityDistinct &&
    entry.enrollmentReady &&
    entry.enrollmentIdentityDistinct &&
    entry.registryBindingMatches
  );
  const adbReady =
    successful(records, "adb.devices") !== null &&
    connectedDevices === config.android.length &&
    unavailableDevices === 0 &&
    unexpectedConnectedDevices === 0;
  return Object.freeze({
    schemaVersion: 1,
    product: "V5BT",
    certificationMatrixSha256:
      ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
    mode: "REDACTED_READ_ONLY_BENCH_INVENTORY",
    generatedAt,
    status: errors.length === 0 && raspberryReady && androidReady && adbReady ? "COMPLETE" : "INCOMPLETE",
    readOnly: true,
    commandPolicy,
    limitations: Object.freeze(limitations),
    redaction: Object.freeze({ serialsExcluded: true, networkIdentifiersExcluded: true, registryIdentifiersExcluded: true, rawCommandOutputExcluded: true }),
    roleCoverage: Object.freeze({
      requiredRoles: REQUIRED_CERTIFIED_ROLES,
      configuredRoles: Object.freeze(configuredRoles),
      missingRequiredRoles: Object.freeze(missingRequiredRoles),
      complete: missingRequiredRoles.length === 0,
    }),
    adb: Object.freeze({
      probeAvailable: successful(records, "adb.devices") !== null,
      expectedTargets: config.android.length,
      connectedDevices,
      unavailableDevices,
      unexpectedConnectedDevices,
    }),
    android: Object.freeze(android),
    raspberry: Object.freeze({
      reachable: raspberryReachable,
      architecture,
      bluez: Object.freeze({ available: bluezVersion !== null, version: bluezVersion, powered: /Powered:\s+yes/iu.test(bluezShow), discovering: /Discovering:\s+yes/iu.test(bluezShow) }),
      ntpSynchronized: ntp.NTPSynchronized === "yes",
      ups: Object.freeze({
        discoveryOnly: true,
        probeAvailable: upsDiscovery?.outcome === "PASS",
        discoveredDevices: upsNames.length,
        serviceProbeAvailable: upsServices?.outcome === "PASS",
        serviceUnitsObserved: (upsServices?.outcome === "PASS" ? upsServices.stdout : "").split(/\r?\n/u).filter(Boolean).length,
      }),
      services: Object.freeze(services),
      registry: registry === null ? null : Object.freeze(registry),
      enrollmentTransactions: Object.freeze(transactions),
      permissionsSecure,
    }),
    errors: Object.freeze(errors),
  });
}

function runAsArgs(target, userId, file) {
  return ["exec-out", "run-as", target.packageId, "--user", String(userId), "cat", file];
}

async function captureAndroidTarget(target, index, context, deviceStates) {
  const prefix = `android.${index}`;
  if (deviceStates.get(target.serial) !== "device") return;
  const userRecord = await captureProbe(adbProbe(`${prefix}.user`, target.serial, ["shell", "am", "get-current-user"]), context);
  const userId = currentUser(userRecord.stdout);
  if (userRecord.outcome !== "PASS" || userId === null || userId !== target.expectedUserId) return;
  const probes = await Promise.all([
    captureProbe(adbProbe(`${prefix}.api`, target.serial, ["shell", "getprop", "ro.build.version.sdk"]), context),
    captureProbe(adbProbe(`${prefix}.package`, target.serial, ["shell", "dumpsys", "package", target.packageId]), context),
    captureProbe(adbProbe(`${prefix}.apkPath`, target.serial, ["shell", "pm", "path", "--user", String(userId), target.packageId]), context),
    captureProbe(adbProbe(`${prefix}.session`, target.serial, runAsArgs(target, userId, "shared_prefs/webkiosk_prefs.xml")), context),
    captureProbe(adbProbe(`${prefix}.identity`, target.serial, runAsArgs(target, userId, "shared_prefs/cassav5bt_bluetooth_identity_v1.xml")), context),
    captureProbe(adbProbe(`${prefix}.enrollmentStatus`, target.serial, runAsArgs(target, userId, "no_backup/bluetooth-enrollment-status-v1.json")), context),
  ]);
  const pathRecord = probes.find((entry) => entry.id === `${prefix}.apkPath`);
  const installedApkPath = pathRecord?.outcome === "PASS" ? apkPath(pathRecord.stdout) : null;
  if (installedApkPath !== null) {
    await captureProbe(adbProbe(`${prefix}.apkSha256`, target.serial, ["exec-out", "sha256sum", installedApkPath]), context);
  }
}

async function captureRaspberry(config, context) {
  const identity = await captureProbe(
    sshProbe(config, "raspberry.identity", REMOTE_COMMANDS.identity, context.raspberrySudo, context.sshAuthentication),
    context,
  );
  if (identity.outcome !== "PASS") return;
  const probes = [
    ["raspberry.bluez.version", REMOTE_COMMANDS.bluezVersion],
    ["raspberry.bluez.show", REMOTE_COMMANDS.bluezShow],
    ["raspberry.ntp", REMOTE_COMMANDS.ntp],
    ["raspberry.ups.discovery", REMOTE_COMMANDS.upsDiscovery],
    ["raspberry.ups.services", REMOTE_COMMANDS.upsServices],
    ["raspberry.state.stat", REMOTE_COMMANDS.stateStat],
    ["raspberry.registry.stat", REMOTE_COMMANDS.registryStat],
    ["raspberry.registry.read", REMOTE_COMMANDS.registryRead],
    ["raspberry.transactions.stat", REMOTE_COMMANDS.transactionsStat],
    ["raspberry.transactions.list", REMOTE_COMMANDS.transactionsList],
    ["raspberry.tlsKey.stat", REMOTE_COMMANDS.tlsKeyStat],
    ["raspberry.tlsCert.stat", REMOTE_COMMANDS.tlsCertStat],
    ["raspberry.environment.stat", REMOTE_COMMANDS.environmentStat],
    ...SERVICES.map((service) => [`raspberry.service.${service}`, serviceRemoteCommand(service)]),
  ];
  // Raspberry SSH daemons often cap unauthenticated bursts. Keep the fixed
  // read-only probe set sequential so a complete inventory is reproducible.
  for (const [id, command] of probes) {
    await captureProbe(sshProbe(config, id, command, context.raspberrySudo, context.sshAuthentication), context);
  }
}

export async function runBenchInventory(configInput, options = {}) {
  const config = PARSED_CONFIGS.has(configInput) ? configInput : parseBenchInventoryConfig(configInput);
  const sshPassword = options.sshPassword ?? null;
  const sshAuthentication = options.sshAuthentication ?? (sshPassword === null ? SSH_AUTH_PUBLIC_KEY : SSH_AUTH_PASSWORD);
  if (![SSH_AUTH_PUBLIC_KEY, SSH_AUTH_PASSWORD].includes(sshAuthentication)) {
    fail("SSH_AUTH_INVALID", "SSH authentication method is invalid");
  }
  const runner = options.runner ?? createExecCommandRunner({
    sudoPassword: options.sudoPassword ?? null,
    sshPassword,
  });
  if (typeof runner !== "function") fail("RUNNER_INVALID", "command runner must be a function");
  const clock = options.clock ?? (() => new Date());
  const generatedAt = clock().toISOString();
  const context = {
    runner,
    clock,
    records: [],
    raspberrySudo: options.raspberrySudo === true,
    sshAuthentication,
  };
  const devicesRecord = await captureProbe(adbProbe("adb.devices", null, ["devices", "-l"]), context);
  const deviceStates = devicesRecord.outcome === "PASS" ? adbDevices(devicesRecord.stdout) : new Map();
  await Promise.all([
    captureRaspberry(config, context),
    ...config.android.map((target, index) => captureAndroidTarget(target, index, context, deviceStates)),
  ]);
  if (typeof runner.assertConsumed === "function") runner.assertConsumed();
  context.records.sort((left, right) => left.id.localeCompare(right.id, "en"));
  const commandPolicy = Object.freeze({
    shell: false,
    mutationAllowed: false,
    upsMode: "DISCOVERY_ONLY",
    fixedAllowlist: true,
    sshAuthentication: context.sshAuthentication,
    sudoReadOnly: context.raspberrySudo,
    passwordRecorded: false,
  });
  const privateReport = Object.freeze({
    schemaVersion: 1,
    product: "V5BT",
    certificationMatrixSha256:
      ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
    mode: "PRIVATE_READ_ONLY_BENCH_INVENTORY",
    generatedAt,
    readOnly: true,
    config,
    commandPolicy,
    probes: Object.freeze(context.records),
  });
  return Object.freeze({ privateReport, summary: summarize(config, context.records, generatedAt, commandPolicy) });
}

function ensureDirectoryWithoutSymlinks(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const metadata = fs.lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail("OUTPUT_PATH_INVALID", "output path contains a symlink or non-directory component");
    }
  }
}

function secureWriteJson(destination, value, mode) {
  const absolute = path.resolve(destination);
  const parent = path.dirname(absolute);
  ensureDirectoryWithoutSymlinks(parent);
  const temporary = path.join(parent, `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, absolute);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
  }
  fs.chmodSync(absolute, mode);
}

export function writeBenchInventoryOutputs(result, privateOutput, summaryOutput) {
  const privateAbsolute = path.resolve(privateOutput);
  const summaryAbsolute = path.resolve(summaryOutput);
  if (privateAbsolute === summaryAbsolute) fail("OUTPUT_PATH_INVALID", "private and redacted outputs must differ");
  secureWriteJson(privateAbsolute, result.privateReport, 0o600);
  try {
    secureWriteJson(summaryAbsolute, result.summary, 0o644);
  } catch (error) {
    try { fs.unlinkSync(privateAbsolute); } catch {}
    throw error;
  }
}

function readFixture(fixturePath) {
  const absolute = path.resolve(fixturePath);
  const metadata = fs.lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_FIXTURE_BYTES) {
    fail("FIXTURE_INVALID", "fixture must be a small regular file");
  }
  const value = JSON.parse(fs.readFileSync(absolute, "utf8"));
  exactKeys(value, ["config", "results", "schemaVersion"], "fixture");
  if (value.schemaVersion !== 1) fail("FIXTURE_INVALID", "fixture schemaVersion must be 1");
  return { config: parseBenchInventoryConfig(value.config), runner: createFixtureCommandRunner(value.results) };
}

function parseAndroidArgument(raw) {
  const parts = String(raw).split(",");
  if (parts.length !== 4) fail("ARGUMENT_INVALID", "--android must use LABEL,ROLE,SERIAL,USER_ID");
  return { label: parts[0], role: parts[1], serial: parts[2], expectedUserId: Number(parts[3]) };
}

function parseCli(argv) {
  const output = {
    raspberryHost: null,
    raspberryUser: "admin",
    sshPort: 22,
    raspberrySshPasswordEnv: null,
    raspberrySudoPasswordEnv: null,
    android: [],
    privateOutput: null,
    summaryOutput: null,
    fixture: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      if (index + 1 >= argv.length) fail("ARGUMENT_INVALID", `${argument} requires a value`);
      return argv[++index];
    };
    if (argument === "--raspberry-host") output.raspberryHost = value();
    else if (argument === "--raspberry-user") output.raspberryUser = value();
    else if (argument === "--ssh-port") output.sshPort = Number(value());
    else if (argument === "--raspberry-ssh-password-env") output.raspberrySshPasswordEnv = value();
    else if (argument === "--raspberry-sudo-password-env") output.raspberrySudoPasswordEnv = value();
    else if (argument === "--android") output.android.push(parseAndroidArgument(value()));
    else if (argument === "--private-output") output.privateOutput = value();
    else if (argument === "--summary-output") output.summaryOutput = value();
    else if (argument === "--fixture") output.fixture = value();
    else if (argument === "--help" || argument === "-h") output.help = true;
    else fail("ARGUMENT_INVALID", `unsupported argument: ${argument}`);
  }
  return output;
}

async function main() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
    if (cli.help) {
      process.stdout.write([
        "Usage:",
        "  node scripts/run-v5bt-bench-inventory.mjs --raspberry-host HOST \\",
        "    [--raspberry-ssh-password-env ENV_NAME] \\",
        "    [--raspberry-sudo-password-env ENV_NAME] \\",
        "    --android LABEL,ROLE,SERIAL,USER_ID [--android ...] \\",
        "    --private-output PRIVATE.json --summary-output REDACTED.json",
        "  node scripts/run-v5bt-bench-inventory.mjs --fixture FIXTURE.json \\",
        "    --private-output PRIVATE.json --summary-output REDACTED.json",
        "",
      ].join("\n"));
      return;
    }
    if (!cli.privateOutput || !cli.summaryOutput) fail("ARGUMENT_INVALID", "both output paths are required");
    let config;
    let runner;
    if (cli.fixture) {
      if (
        cli.raspberryHost !== null ||
        cli.android.length > 0 ||
        cli.raspberrySshPasswordEnv !== null ||
        cli.raspberrySudoPasswordEnv !== null
      ) fail("ARGUMENT_INVALID", "fixture mode does not accept live targets or password authentication");
      ({ config, runner } = readFixture(cli.fixture));
    } else {
      config = parseBenchInventoryConfig({ schemaVersion: 1, raspberryHost: cli.raspberryHost, raspberryUser: cli.raspberryUser, sshPort: cli.sshPort, android: cli.android });
      let sshPassword = null;
      let sudoPassword = null;
      if (
        cli.raspberrySshPasswordEnv !== null &&
        cli.raspberrySshPasswordEnv === cli.raspberrySudoPasswordEnv
      ) {
        sshPassword = consumePasswordEnvironmentVariable(cli.raspberrySshPasswordEnv, "SSH");
        sudoPassword = sshPassword;
      } else {
        if (cli.raspberrySshPasswordEnv !== null) {
          sshPassword = consumePasswordEnvironmentVariable(cli.raspberrySshPasswordEnv, "SSH");
        }
        if (cli.raspberrySudoPasswordEnv !== null) {
          sudoPassword = consumePasswordEnvironmentVariable(cli.raspberrySudoPasswordEnv, "sudo");
        }
      }
      runner = createExecCommandRunner({ sudoPassword, sshPassword });
      cli.sshAuthentication = sshPassword === null ? SSH_AUTH_PUBLIC_KEY : SSH_AUTH_PASSWORD;
      cli.raspberrySudo = sudoPassword !== null;
    }
    const result = await runBenchInventory(config, {
      runner,
      raspberrySudo: cli.raspberrySudo === true,
      sshAuthentication: cli.sshAuthentication ?? SSH_AUTH_PUBLIC_KEY,
    });
    writeBenchInventoryOutputs(result, cli.privateOutput, cli.summaryOutput);
    process.stdout.write(`${JSON.stringify({ status: result.summary.status, privateOutput: path.resolve(cli.privateOutput), summaryOutput: path.resolve(cli.summaryOutput) })}\n`);
    if (result.summary.status !== "COMPLETE") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "inventory failed"}\n`);
    process.exitCode = error instanceof BenchInventoryError && error.code === "ARGUMENT_INVALID" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
