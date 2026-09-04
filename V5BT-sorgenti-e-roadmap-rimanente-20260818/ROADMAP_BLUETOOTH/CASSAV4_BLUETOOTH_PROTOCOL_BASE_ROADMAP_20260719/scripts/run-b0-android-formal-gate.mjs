#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from "./advanced-certification-targets.mjs";
import {
  AdbClient,
  B0_CAPTURE_DURATION_SECONDS,
  B0_REQUIRED_CONTROLS,
  B0SupplementalError,
  assertPublicReportRedacted,
  buildCaptureSchedule,
  captureDeviceSample,
  captureExitInfo,
  captureStaticBinding,
  collectScheduledSamples,
  evaluateDeviceEvidence,
  readNativeCapabilityViaAdb,
  restoreAppState,
  serializeExitInfo,
  serializeSample,
  verifyFinalBinding,
  writeExclusiveEvidence
} from "./run-b0-android-supplemental-gate.mjs";
import {
  MIN_ANDROID_API as DISCOVERY_MIN_ANDROID_API,
  parseAdbDevices
} from "./run-b2-android-adb-harness.mjs";

export const B0_ANDROID_FORMAL_VERSION = "1.0.0";
export const B0_MIN_ANDROID_API = DISCOVERY_MIN_ANDROID_API;
export const B0_FORMAL_ROLES = Object.freeze(["handheld", "station"]);
export const B0_FORMAL_MODELS = Object.freeze({
  handheld: "SM-A165F",
  station: "SM-T503"
});

const SERIAL_PATTERN = /^[!-~]{1,200}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PRIVATE_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_PUBLIC_REPORT_BYTES = 256 * 1024;
const PRIVATE_CONTINUITY_FIELDS = Object.freeze([
  "stablePackageVersion",
  "stableAndroidUser",
  "stableProcess",
  "stableReporters",
  "noLogout",
  "noCrashOrAnr",
  "clockMonotonic",
  "boundedPolling",
  "serviceContinuous",
  "noForceStop"
]);
const PUBLIC_CONTINUITY_FIELDS = Object.freeze({
  packageVersion: "stablePackageVersion",
  operatingSystemUser: "stableAndroidUser",
  process: "stableProcess",
  reporters: "stableReporters",
  authenticatedContext: "noLogout",
  crashOrAnr: "noCrashOrAnr",
  clock: "clockMonotonic",
  polling: "boundedPolling",
  service: "serviceContinuous",
  forceStopPolicy: "noForceStop"
});

export class B0FormalError extends Error {
  constructor(code, message, exitCode = 1, options = undefined) {
    super(message, options);
    this.name = "B0FormalError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1, options = undefined) {
  throw new B0FormalError(code, message, exitCode, options);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code, `${label} contains missing or unexpected fields`);
  }
}

function targetForRole(role) {
  if (!B0_FORMAL_ROLES.includes(role)) {
    fail("FORMAL_ROLE_INVALID", "B0 formal role is invalid");
  }
  return ADVANCED_CERTIFICATION_TARGETS.roles[role];
}

function sameTarget(actual, expected) {
  return (
    isRecord(actual) &&
    actual.packageId === expected.packageId &&
    actual.versionName === expected.versionName &&
    actual.versionCode === expected.versionCode &&
    actual.sha256 === expected.sha256 &&
    actual.signingCertificateSha256 === expected.signingCertificateSha256 &&
    actual.artifactRelativePath === expected.artifactRelativePath
  );
}

function publicStatus(value, label) {
  if (
    !isRecord(value) ||
    !["PASS", "FAIL"].includes(value.status) ||
    typeof value.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,79}$/u.test(value.code)
  ) {
    fail("EVIDENCE_INVALID", `${label} status is invalid`);
  }
  return Object.freeze({ status: value.status, code: value.code });
}

function status(passed, passCode, failCode) {
  return Object.freeze({
    status: passed ? "PASS" : "FAIL",
    code: passed ? passCode : failCode
  });
}

function evaluateAndroidPlatform(binding, capability) {
  if (
    !Number.isSafeInteger(binding?.androidApi) ||
    !Number.isSafeInteger(capability?.androidApi) ||
    binding.androidApi !== capability.androidApi
  ) {
    return Object.freeze({
      status: "FAIL",
      code: "ANDROID_API_BINDING_MISMATCH"
    });
  }
  return status(
    binding.androidApi >= B0_MIN_ANDROID_API,
    "ANDROID_API_SUPPORTED",
    "ANDROID_API_UNSUPPORTED"
  );
}

function exitInfoFromSerialized(value, label) {
  if (
    !isRecord(value) ||
    !Array.isArray(value.commitments) ||
    !isRecord(value.counts) ||
    value.commitments.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 256 ||
        /[\x00-\x1f\x7f]/u.test(entry)
    ) ||
    new Set(value.commitments).size !== value.commitments.length
  ) {
    fail("EVIDENCE_INVALID", `${label} exit evidence is invalid`);
  }
  return Object.freeze({ commitments: new Set(value.commitments), counts: value.counts });
}

function assertBindingMatchesRole(binding, role) {
  const target = targetForRole(role);
  if (
    !isRecord(binding) ||
    binding.ordinal !== role ||
    binding.packageId !== target.packageId ||
    binding.apkSha256 !== target.sha256 ||
    binding.model !== B0_FORMAL_MODELS[role] ||
    binding.expectedModel !== B0_FORMAL_MODELS[role] ||
    !sameTarget(binding.certifiedTarget, target)
  ) {
    fail("CERTIFIED_PAIR_MISMATCH", "B0 target does not match its certified role");
  }
  return target;
}

export function evaluateFormalRoleEvidence({
  role,
  binding,
  capability,
  foregroundSamples,
  backgroundSamples,
  exitBaseline,
  exitFinal
}) {
  const target = assertBindingMatchesRole(binding, role);
  const base = evaluateDeviceEvidence({
    binding,
    capability,
    foregroundSamples,
    backgroundSamples,
    exitBaseline,
    exitFinal
  });
  const allSamples = [...foregroundSamples, ...backgroundSamples];
  const runtimeGattServer =
    capability?.gattServerOpen === true &&
    allSamples.some((sample) => sample?.agent?.resources?.gattServerActive === true);
  const controls = Object.freeze({
    ...base.controls,
    gattServer: status(
      runtimeGattServer,
      "GATT_SERVER_OPEN_CLOSE_AND_RUNTIME_MEASURED",
      "GATT_SERVER_NOT_PROVEN"
    )
  });
  const continuity = Object.freeze(
    Object.fromEntries(
      PRIVATE_CONTINUITY_FIELDS.map((field) => [
        field,
        publicStatus(base.continuity?.[field], `continuity ${field}`)
      ])
    )
  );
  const classification = status(
    capability?.classification === "FULL_NODE",
    "FULL_NODE_CLASSIFIED",
    "FULL_NODE_NOT_PROVEN"
  );
  const certifiedBuild = status(
    base.versionName === target.versionName &&
      base.versionCode === target.versionCode &&
      binding.apkSha256 === target.sha256,
    "CERTIFIED_BUILD_MATCH",
    "CERTIFIED_BUILD_MISMATCH"
  );
  const androidPlatform = evaluateAndroidPlatform(binding, capability);
  const passed =
    B0_REQUIRED_CONTROLS.every(
      (control) => controls[control]?.status === "PASS"
    ) &&
    Object.values(continuity).every((entry) => entry.status === "PASS") &&
    classification.status === "PASS" &&
    certifiedBuild.status === "PASS" &&
    androidPlatform.status === "PASS";
  return Object.freeze({
    role,
    packageId: target.packageId,
    model: B0_FORMAL_MODELS[role],
    versionName: target.versionName,
    versionCode: target.versionCode,
    apkSha256: target.sha256,
    controls,
    continuity,
    classification,
    certifiedBuild,
    androidPlatform,
    measurements: base.measurements,
    result: passed ? "PASS" : "FAIL",
    evidenceClass: passed ? "FORMAL" : "NON_GATE_EVIDENCE"
  });
}

function evaluatePrivateDevice(device, role) {
  if (!isRecord(device) || device.role !== role) {
    fail("CERTIFIED_PAIR_MISMATCH", "B0 private evidence has an invalid role order");
  }
  return evaluateFormalRoleEvidence({
    role,
    binding: device.binding,
    capability: device.capability,
    foregroundSamples: device.foregroundSamples,
    backgroundSamples: device.backgroundSamples,
    exitBaseline: exitInfoFromSerialized(device.exitBaseline, role),
    exitFinal: exitInfoFromSerialized(device.exitFinal, role)
  });
}

function publicRoleResult(result) {
  const controls = Object.freeze(
    Object.fromEntries(
      B0_REQUIRED_CONTROLS.map((control) => [
        control,
        publicStatus(result.controls?.[control], `${result.role} ${control}`)
      ])
    )
  );
  const continuity = Object.freeze(
    Object.fromEntries(
      Object.entries(PUBLIC_CONTINUITY_FIELDS).map(([publicField, privateField]) => [
        publicField,
        publicStatus(
          result.continuity?.[privateField],
          `${result.role} ${publicField}`
        )
      ])
    )
  );
  return Object.freeze({
    role: result.role,
    packageId: result.packageId,
    model: result.model,
    versionName: result.versionName,
    versionCode: result.versionCode,
    apkSha256: result.apkSha256,
    controls,
    continuity,
    classification: publicStatus(result.classification, `${result.role} classification`),
    certifiedBuild: publicStatus(result.certifiedBuild, `${result.role} build`),
    androidPlatform: publicStatus(
      result.androidPlatform,
      `${result.role} Android platform`
    ),
    measurements: result.measurements,
    result: result.result,
    evidenceClass: result.evidenceClass
  });
}

export function buildPublicFormalReport(privateEvidence, privateEvidenceSha256) {
  if (!SHA256_PATTERN.test(privateEvidenceSha256)) {
    fail("EVIDENCE_DIGEST_INVALID", "private evidence digest is invalid");
  }
  exactKeys(
    privateEvidence,
    [
      "schemaVersion",
      "harnessVersion",
      "source",
      "captureRunId",
      "startedAt",
      "endedAt",
      "fixedDurationSeconds",
      "certificationMatrixSha256",
      "sessionHmacKeyBase64",
      "devices",
      "runnerPolicy",
      "restoration"
    ],
    "EVIDENCE_INVALID",
    "private B0 formal evidence"
  );
  if (
    privateEvidence.schemaVersion !== 1 ||
    privateEvidence.harnessVersion !== B0_ANDROID_FORMAL_VERSION ||
    privateEvidence.source !== "V5BT_B0_ANDROID_FORMAL_PRIVATE" ||
    privateEvidence.fixedDurationSeconds !== B0_CAPTURE_DURATION_SECONDS ||
    privateEvidence.certificationMatrixSha256 !==
      ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256 ||
    !Array.isArray(privateEvidence.devices) ||
    privateEvidence.devices.length !== B0_FORMAL_ROLES.length ||
    privateEvidence.restoration?.completed !== true
  ) {
    fail("EVIDENCE_INVALID", "private B0 formal evidence is incomplete");
  }
  const roleResults = Object.freeze(
    B0_FORMAL_ROLES.map((role, index) =>
      publicRoleResult(evaluatePrivateDevice(privateEvidence.devices[index], role))
    )
  );
  const passed = roleResults.every(
    (roleResult) =>
      roleResult.result === "PASS" && roleResult.evidenceClass === "FORMAL"
  );
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B0_ANDROID_FORMAL_VERSION,
    source: "V5BT_B0_ANDROID_FORMAL",
    evidenceAllowlist: "PUBLIC_ALLOWLIST_V1",
    certificationMatrixSha256:
      ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
    privateEvidenceSha256,
    physicalAdbAccessed: true,
    captureDurationSeconds: B0_CAPTURE_DURATION_SECONDS,
    requiredRoles: B0_FORMAL_ROLES,
    requiredControls: B0_REQUIRED_CONTROLS,
    roles: roleResults,
    result: passed ? "FORMAL_PASS" : "FORMAL_CAPTURE_FAIL",
    evidenceClass: passed ? "FORMAL" : "NON_GATE_EVIDENCE",
    gateImpact: passed ? "GATE_EVIDENCE" : "NON_GATE_EVIDENCE",
    formalGate: passed ? "PASS" : "PENDING",
    formalGatePromoted: passed,
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

function encodedJson(value, maximumBytes) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > maximumBytes) {
    fail("OUTPUT_TOO_LARGE", "B0 formal evidence exceeds its size limit");
  }
  return bytes;
}

export function publishFormalEvidencePair(
  privateOutput,
  reportOutput,
  privateEvidence
) {
  if (path.resolve(privateOutput) === path.resolve(reportOutput)) {
    fail("OUTPUT_PATH_INVALID", "private and public outputs must be distinct");
  }
  if (fs.existsSync(privateOutput) || fs.existsSync(reportOutput)) {
    fail("OUTPUT_EXISTS", "B0 formal outputs cannot be overwritten");
  }
  const privateBytes = encodedJson(privateEvidence, MAX_PRIVATE_EVIDENCE_BYTES);
  const privateDigest = crypto
    .createHash("sha256")
    .update(privateBytes)
    .digest("hex");
  const report = buildPublicFormalReport(privateEvidence, privateDigest);
  const secrets = privateEvidence.devices.flatMap((device) => [
    device.binding?.serial,
    device.binding?.sessionBindingHmacSha256
  ]);
  assertPublicReportRedacted(report, secrets);
  const publicBytes = encodedJson(report, MAX_PUBLIC_REPORT_BYTES);
  writeExclusiveEvidence(privateOutput, privateBytes, true);
  writeExclusiveEvidence(reportOutput, publicBytes, false);
  return Object.freeze({ privateDigest, report });
}

function bindAnchor(binding, anchor, target) {
  if (
    anchor.pid !== binding.initialPid ||
    anchor.appUid !== binding.appUid ||
    anchor.currentUser !== binding.currentUser ||
    anchor.installedVersion.versionName !== target.versionName ||
    anchor.installedVersion.versionCode !== target.versionCode
  ) {
    fail("INITIAL_BINDING_CHANGED", "certified role binding changed during B0 setup");
  }
  return Object.freeze({
    ...binding,
    pid: anchor.pid,
    sessionBindingHmacSha256: anchor.sessionBindingHmacSha256,
    discoveryReporterStartedAtEpochMs: anchor.discovery.reporterStartedAtEpochMs,
    agentReporterStartedAtEpochMs: anchor.agent.reporterStartedAtEpochMs,
    gattReporterStartedAtEpochMs: anchor.gatt.reporterStartedAtEpochMs
  });
}

function privateDevice(role, binding, capability, foreground, background, baseline, final) {
  return Object.freeze({
    role,
    binding,
    capability,
    foregroundSamples: Object.freeze(foreground.map(serializeSample)),
    backgroundSamples: Object.freeze(background.map(serializeSample)),
    exitBaseline: serializeExitInfo(baseline),
    exitFinal: serializeExitInfo(final)
  });
}

export async function runFormalPhysicalCapture(options, runtime = {}) {
  const packageIds = B0_FORMAL_ROLES.map(
    (role) => targetForRole(role).packageId
  );
  const adb =
    runtime.adb ?? new AdbClient(options.adb, undefined, packageIds);
  const sessionKey = crypto.randomBytes(32);
  const captureRunId = crypto.randomUUID();
  const now = runtime.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  let bindings = [];
  let evidence = null;
  let captureError = null;
  try {
    const inventory = parseAdbDevices(await adb.run(null, ["devices", "-l"]));
    const serials = [options.handheldSerial, options.stationSerial];
    for (const serial of serials) {
      const selected = inventory.filter((device) => device.serial === serial);
      if (selected.length !== 1 || selected[0].state !== "device") {
        fail("ADB_TARGET_UNAVAILABLE", "one fixed formal B0 target is unavailable");
      }
    }
    bindings = await Promise.all(
      B0_FORMAL_ROLES.map((role, index) =>
        captureStaticBinding(
          adb,
          serials[index],
          role,
          targetForRole(role),
          B0_FORMAL_MODELS[role]
        )
      )
    );
    if (bindings.some((binding) => binding.androidApi < B0_MIN_ANDROID_API)) {
      fail(
        "ANDROID_API_UNSUPPORTED",
        `formal B0 requires Android API ${B0_MIN_ANDROID_API} or newer`
      );
    }
    const baselines = await Promise.all(
      bindings.map((binding) => captureExitInfo(adb, binding))
    );
    const anchors = await Promise.all(
      bindings.map((binding) =>
        captureDeviceSample(adb, binding, sessionKey, runtime)
      )
    );
    bindings = bindings.map((binding, index) =>
      bindAnchor(binding, anchors[index], targetForRole(B0_FORMAL_ROLES[index]))
    );
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
      bindings.map((binding) =>
        captureDeviceSample(adb, binding, sessionKey, runtime)
      )
    );
    const schedule = runtime.schedule ?? buildCaptureSchedule();
    const foregroundAdditional = await collectScheduledSamples(
      adb,
      bindings,
      sessionKey,
      schedule.foregroundOffsetsMs,
      runtime
    );
    const foreground = initialSamples.map((sample, index) => [
      sample,
      ...foregroundAdditional[index]
    ]);
    await Promise.all(
      bindings.map((binding) =>
        adb.run(binding.serial, ["shell", "input", "keyevent", "KEYCODE_HOME"])
      )
    );
    await (runtime.sleep ?? sleep)(schedule.backgroundSettleMs);
    const background = await collectScheduledSamples(
      adb,
      bindings,
      sessionKey,
      schedule.backgroundOffsetsMs,
      runtime
    );
    const finals = await Promise.all(
      bindings.map((binding) => captureExitInfo(adb, binding))
    );
    await Promise.all(bindings.map((binding) => verifyFinalBinding(adb, binding)));
    evidence = {
      schemaVersion: 1,
      harnessVersion: B0_ANDROID_FORMAL_VERSION,
      source: "V5BT_B0_ANDROID_FORMAL_PRIVATE",
      captureRunId,
      startedAt,
      endedAt: new Date(now()).toISOString(),
      fixedDurationSeconds: B0_CAPTURE_DURATION_SECONDS,
      certificationMatrixSha256:
        ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
      sessionHmacKeyBase64: sessionKey.toString("base64"),
      devices: Object.freeze(
        B0_FORMAL_ROLES.map((role, index) =>
          privateDevice(
            role,
            bindings[index],
            capabilities[index],
            foreground[index],
            background[index],
            baselines[index],
            finals[index]
          )
        )
      ),
      runnerPolicy: Object.freeze({
        forceStopAllowed: false,
        uninstallAllowed: false,
        clearDataAllowed: false,
        userChangeAllowed: false,
        finalAppStopAllowed: false
      })
    };
  } catch (error) {
    captureError = error;
  }

  const restoration = {
    attempted: bindings.length > 0,
    completed: bindings.length === 0
  };
  let restorationError = null;
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
    fail("APP_STATE_RESTORE_FAILED", "formal B0 app state could not be restored", 1, {
      cause: restorationError
    });
  }
  if (captureError !== null) throw captureError;
  if (evidence === null) {
    fail("EVIDENCE_INCOMPLETE", "formal B0 private evidence was not produced");
  }
  return Object.freeze({ ...evidence, restoration: Object.freeze(restoration) });
}

export function parseFormalArguments(argv) {
  const options = {
    mode: "PHYSICAL",
    adb: null,
    handheldSerial: null,
    stationSerial: null,
    privateOutput: null,
    reportOutput: null
  };
  const values = new Map([
    ["--adb", "adb"],
    ["--handheld-serial", "handheldSerial"],
    ["--station-serial", "stationSerial"],
    ["--private-output", "privateOutput"],
    ["--report-output", "reportOutput"]
  ]);
  const modes = new Map([
    ["--dry-run", "DRY_RUN"],
    ["--help", "HELP"]
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (modes.has(argument)) {
      if (options.mode !== "PHYSICAL" || seen.has(argument)) {
        fail("INVALID_ARGUMENT", "B0 formal mode flags are mutually exclusive");
      }
      options.mode = modes.get(argument);
      seen.add(argument);
      continue;
    }
    const field = values.get(argument);
    const value = argv[index + 1];
    if (
      field === undefined ||
      seen.has(argument) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      fail("INVALID_ARGUMENT", "B0 formal arguments are invalid");
    }
    options[field] = value;
    seen.add(argument);
    index += 1;
  }
  if (options.mode !== "PHYSICAL") {
    if (seen.size !== 1) {
      fail("INVALID_ARGUMENT", "B0 formal offline modes take no options");
    }
    return Object.freeze(options);
  }
  if (
    !path.isAbsolute(options.adb ?? "") ||
    !SERIAL_PATTERN.test(options.handheldSerial ?? "") ||
    !SERIAL_PATTERN.test(options.stationSerial ?? "") ||
    options.handheldSerial === options.stationSerial ||
    !path.isAbsolute(options.privateOutput ?? "") ||
    !path.isAbsolute(options.reportOutput ?? "") ||
    path.resolve(options.privateOutput) === path.resolve(options.reportOutput)
  ) {
    fail("INVALID_ARGUMENT", "physical B0 formal arguments are incomplete or invalid");
  }
  return Object.freeze(options);
}

function publicTarget(role) {
  const target = targetForRole(role);
  return Object.freeze({
    role,
    model: B0_FORMAL_MODELS[role],
    packageId: target.packageId,
    versionName: target.versionName,
    versionCode: target.versionCode,
    apkSha256: target.sha256,
    signingCertificateSha256: target.signingCertificateSha256,
    minimumAndroidApi: B0_MIN_ANDROID_API
  });
}

export function buildFormalDryRun() {
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B0_ANDROID_FORMAL_VERSION,
    source: "V5BT_B0_ANDROID_FORMAL",
    mode: "DRY_RUN",
    physicalAdbAccessed: false,
    requiresExplicitSerials: true,
    certificationMatrixSha256:
      ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
    certifiedTargets: Object.freeze(B0_FORMAL_ROLES.map(publicTarget)),
    requiredRoles: B0_FORMAL_ROLES,
    minimumAndroidApi: B0_MIN_ANDROID_API,
    requiredControls: B0_REQUIRED_CONTROLS,
    requiredContinuity: Object.freeze(Object.keys(PUBLIC_CONTINUITY_FIELDS)),
    fixedDurationSeconds: B0_CAPTURE_DURATION_SECONDS,
    failClosed: true,
    evidenceClass: "NON_GATE_EVIDENCE",
    formalGate: "PENDING",
    formalGatePromoted: false,
    result: "PENDING_PHYSICAL_CAPTURE"
  });
}

function usage() {
  return [
    "V5BT B0 Android formal gate",
    "",
    "  --adb /abs/adb --handheld-serial ID --station-serial ID \\",
    "    --private-output /secure/evidence.json --report-output /redacted/report.json",
    "  --dry-run",
    ""
  ].join("\n");
}

export function buildFormalFailure(error, physicalAdbAccessed = false) {
  const code =
    typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/u.test(error.code)
      ? error.code
      : "UNEXPECTED_FAILURE";
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B0_ANDROID_FORMAL_VERSION,
    source: "V5BT_B0_ANDROID_FORMAL",
    evidenceAllowlist: "PUBLIC_ALLOWLIST_V1",
    physicalAdbAccessed: physicalAdbAccessed === true,
    result: "FORMAL_CAPTURE_FAIL",
    evidenceClass: "NON_GATE_EVIDENCE",
    gateImpact: "NON_GATE_EVIDENCE",
    formalGate: "PENDING",
    formalGatePromoted: false,
    failure: Object.freeze({ code, message: "B0 formal capture failed" }),
    privacy: Object.freeze({ redacted: true })
  });
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  let options = null;
  try {
    options = parseFormalArguments(argv);
    if (options.mode === "HELP") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.mode === "DRY_RUN") {
      process.stdout.write(`${JSON.stringify(buildFormalDryRun(), null, 2)}\n`);
      return 0;
    }
    const privateEvidence = await runFormalPhysicalCapture(options, runtime);
    const { report } = publishFormalEvidencePair(
      options.privateOutput,
      options.reportOutput,
      privateEvidence
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.result === "FORMAL_PASS" ? 0 : 2;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        buildFormalFailure(error, options?.mode === "PHYSICAL"),
        null,
        2
      )}\n`
    );
    return error instanceof B0FormalError || error instanceof B0SupplementalError
      ? error.exitCode ?? 1
      : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
