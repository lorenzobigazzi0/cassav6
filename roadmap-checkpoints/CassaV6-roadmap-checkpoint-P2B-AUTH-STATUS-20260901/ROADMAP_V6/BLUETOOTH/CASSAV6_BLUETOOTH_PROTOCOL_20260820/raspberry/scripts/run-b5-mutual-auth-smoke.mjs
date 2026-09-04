#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CAPABILITY_BITS } from "../../shared/protocol/advertisement-v1.mjs";
import { DeviceRegistryV2 } from "../../shared/provisioning/device-registry-v2.mjs";
import { GattApplication } from "../dist/bluez/GattApplication.js";
import { MutualAuthHandshakeV1 } from "../dist/security/Handshake.js";
import { GattHelloExchangeV1 } from "../dist/session/GattHelloExchangeV1.js";
import { capturePhysicalGattEvidence } from "./run-b5-raspberry-gatt-smoke.mjs";

export const B5_6_HARNESS_VERSION = "1.0.0";

const NODE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADAPTER_PATTERN = /^hci[0-9]+$/;
const SERVER_CAPABILITIES =
  CAPABILITY_BITS.GATT_SERVER | CAPABILITY_BITS.BACKEND_BRIDGE;

export class B5MutualAuthSmokeError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "B5MutualAuthSmokeError";
    this.code = code;
  }
}

function fail(code, message, options = undefined) {
  throw new B5MutualAuthSmokeError(code, message, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, code, message) {
  if (!isRecord(value)) fail(code, message);
  return value;
}

function requireEqual(actual, expected, code, message) {
  if (actual !== expected) {
    fail(code, `${message}: expected ${String(expected)}`);
  }
}

function requireFields(snapshot, expected, code) {
  const value = requireRecord(snapshot, code, "snapshot is missing");
  for (const [field, expectedValue] of Object.entries(expected)) {
    requireEqual(
      value[field],
      expectedValue,
      code,
      `${field} is invalid`
    );
  }
  return value;
}

function validateLifecycle(evidence) {
  const preflight = requireRecord(
    evidence.preflight,
    "PREFLIGHT_INVALID",
    "physical preflight is missing"
  );
  for (const [field, expected] of [
    ["platform", "linux"],
    ["bluetoothServiceActive", true],
    ["adapterPowered", true],
    ["gattManagerAvailable", true]
  ]) {
    requireEqual(
      preflight[field],
      expected,
      "PREFLIGHT_INVALID",
      `${field} is invalid`
    );
  }
  requireEqual(
    evidence.ownerBeforeStop,
    true,
    "SERVER_LIFECYCLE_INVALID",
    "GATT D-Bus owner is missing"
  );
  requireEqual(
    evidence.ownerAfterStop,
    false,
    "SERVER_LIFECYCLE_INVALID",
    "GATT D-Bus owner survived cleanup"
  );
  requireEqual(
    evidence.discoveryAfter,
    evidence.discoveryBefore,
    "SERVER_LIFECYCLE_INVALID",
    "GATT gate changed adapter discovery state"
  );
  if (!Number.isSafeInteger(evidence.durationMs) || evidence.durationMs < 1) {
    fail("EVIDENCE_INVALID", "physical duration is invalid");
  }

  const registered = requireRecord(
    evidence.registered,
    "SERVER_LIFECYCLE_INVALID",
    "registered snapshot is missing"
  );
  const beforeStop = requireRecord(
    evidence.beforeStop,
    "SERVER_LIFECYCLE_INVALID",
    "pre-cleanup snapshot is missing"
  );
  const stopped = requireRecord(
    evidence.stopped,
    "SERVER_LIFECYCLE_INVALID",
    "stopped snapshot is missing"
  );
  requireEqual(
    registered.state,
    "REGISTERED",
    "SERVER_LIFECYCLE_INVALID",
    "server did not register"
  );
  requireEqual(
    beforeStop.state,
    "REGISTERED",
    "SERVER_LIFECYCLE_INVALID",
    "server left REGISTERED before sampling"
  );
  requireFields(
    stopped,
    {
      state: "STOPPED",
      busConnected: false,
      applicationExported: false,
      registered: false,
      retryScheduled: false,
      activeMatchRules: 0,
      exportedInterfaceCount: 0,
      unregistersTotal: 1,
      unregisterFailuresTotal: 0,
      errorsTotal: 0
    },
    "SERVER_LIFECYCLE_INVALID"
  );
  return { preflight, registered, beforeStop, stopped };
}

function validateProfile(snapshot) {
  requireFields(
    snapshot,
    {
      managedObjectCount: 8,
      exportedInterfaceCount: 9
    },
    "PROFILE_INVALID"
  );
  requireFields(
    snapshot.service,
    {
      characteristicCount: 7
    },
    "PROFILE_INVALID"
  );
}

function validateInitial(snapshot) {
  return requireFields(
    snapshot,
    {
      enabled: true,
      mutualAuthEnabled: true,
      activeExchangeCount: 0,
      responseReadyCount: 0,
      responseDeliveredCount: 0,
      failedExchangeCount: 0,
      writesAcceptedTotal: 0,
      readsDeliveredTotal: 0,
      helloExchangedTotal: 0,
      duplicateWritesTotal: 0,
      duplicateReadsTotal: 0,
      bindingConflictsTotal: 0,
      capacityRejectedTotal: 0,
      expiredTotal: 0,
      failuresTotal: 0,
      resetsTotal: 0,
      authStartedTotal: 0,
      clientProofsVerifiedTotal: 0,
      serverProofsIssuedTotal: 0,
      finishProofsVerifiedTotal: 0,
      authDuplicateWritesTotal: 0,
      authReplayRejectedTotal: 0,
      authFailuresTotal: 0,
      authenticatedSessionCount: 0
    },
    "MUTUAL_AUTH_EVIDENCE_INVALID"
  );
}

function validateAuthenticated(snapshot) {
  return requireFields(
    snapshot,
    {
      enabled: true,
      mutualAuthEnabled: true,
      activeExchangeCount: 1,
      responseReadyCount: 0,
      responseDeliveredCount: 1,
      failedExchangeCount: 0,
      writesAcceptedTotal: 1,
      readsDeliveredTotal: 1,
      helloExchangedTotal: 1,
      duplicateWritesTotal: 0,
      duplicateReadsTotal: 0,
      bindingConflictsTotal: 0,
      capacityRejectedTotal: 0,
      expiredTotal: 0,
      failuresTotal: 0,
      resetsTotal: 0,
      authStartedTotal: 1,
      clientProofsVerifiedTotal: 1,
      serverProofsIssuedTotal: 1,
      finishProofsVerifiedTotal: 1,
      authDuplicateWritesTotal: 0,
      authReplayRejectedTotal: 0,
      authFailuresTotal: 0,
      authenticatedSessionCount: 1
    },
    "MUTUAL_AUTH_EVIDENCE_INVALID"
  );
}

function validateStopped(snapshot) {
  return requireFields(
    snapshot,
    {
      enabled: true,
      mutualAuthEnabled: true,
      activeExchangeCount: 0,
      responseReadyCount: 0,
      responseDeliveredCount: 0,
      failedExchangeCount: 0,
      writesAcceptedTotal: 1,
      readsDeliveredTotal: 1,
      helloExchangedTotal: 1,
      duplicateWritesTotal: 0,
      duplicateReadsTotal: 0,
      bindingConflictsTotal: 0,
      capacityRejectedTotal: 0,
      expiredTotal: 0,
      failuresTotal: 0,
      resetsTotal: 1,
      authStartedTotal: 1,
      clientProofsVerifiedTotal: 1,
      serverProofsIssuedTotal: 1,
      finishProofsVerifiedTotal: 1,
      authDuplicateWritesTotal: 0,
      authReplayRejectedTotal: 0,
      authFailuresTotal: 0,
      authenticatedSessionCount: 0
    },
    "MUTUAL_AUTH_EVIDENCE_INVALID"
  );
}

export function evaluatePhysicalMutualAuthEvidence(
  input,
  generatedAt = new Date().toISOString()
) {
  const evidence = requireRecord(
    input,
    "EVIDENCE_INVALID",
    "physical mutual-auth evidence is missing"
  );
  const { preflight, registered, beforeStop, stopped } =
    validateLifecycle(evidence);
  validateProfile(registered.application);
  validateProfile(beforeStop.application);
  validateInitial(registered.application?.hello);
  const authenticated = validateAuthenticated(beforeStop.application?.hello);
  const stoppedHello = validateStopped(stopped.application?.hello);
  requireFields(
    registered.application?.access,
    {
      readDeniedTotal: 0,
      writeDeniedTotal: 0,
      notifyDeniedTotal: 0
    },
    "MUTUAL_AUTH_EVIDENCE_INVALID"
  );
  requireFields(
    beforeStop.application?.access,
    {
      readDeniedTotal: 0,
      writeDeniedTotal: 0,
      notifyDeniedTotal: 0
    },
    "MUTUAL_AUTH_EVIDENCE_INVALID"
  );

  const report = Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_6_HARNESS_VERSION,
    product: "V6",
    phase: "B5.6",
    generatedAt,
    mode: "PHYSICAL",
    verdict: "PASS",
    target: Object.freeze({
      role: "GATT_SERVER",
      hostname: preflight.hostname,
      architecture: preflight.architecture,
      nodeVersion: preflight.nodeVersion,
      bluezVersion: preflight.bluezVersion,
      adapterName: preflight.adapterName
    }),
    checks: Object.freeze({
      bluezPreflight: "PASS",
      registryReadOnlyInspection: "PASS",
      helloExchange: "PASS",
      clientIdentityProof: "PASS",
      serverIdentityProof: "PASS",
      clientFinishProof: "PASS",
      exactSingleAuthenticatedSession: "PASS",
      businessCharacteristics: "FAIL_CLOSED",
      unregisterApplication: "PASS",
      resourceCleanup: "PASS"
    }),
    observed: Object.freeze({
      state: "AUTHENTICATED",
      durationMs: evidence.durationMs,
      managedObjectCount: beforeStop.application.managedObjectCount,
      characteristicCount: beforeStop.application.service.characteristicCount,
      helloExchanged: authenticated.helloExchangedTotal,
      clientProofsVerified: authenticated.clientProofsVerifiedTotal,
      serverProofsIssued: authenticated.serverProofsIssuedTotal,
      finishProofsVerified: authenticated.finishProofsVerifiedTotal,
      authenticatedSessionsBeforeCleanup:
        authenticated.authenticatedSessionCount,
      authenticatedSessionsAfterCleanup:
        stoppedHello.authenticatedSessionCount,
      failures: authenticated.failuresTotal + authenticated.authFailuresTotal
    }),
    gate: Object.freeze({
      mutualAuthentication: "PASS_ONE_PHYSICAL_TARGET",
      sessionKey: "NOT_STARTED",
      heartbeat: "NOT_STARTED",
      activeBusinessSession: "NOT_STARTED",
      b5HundredSessionGate: "PENDING"
    }),
    privacy: Object.freeze({
      stableNodeIdsIncluded: false,
      certificateIdsIncluded: false,
      sessionIdsIncluded: false,
      bluetoothAddressesIncluded: false,
      cryptographicMaterialIncluded: false,
      payloadsIncluded: false
    }),
    physicalRadioAccessed: true,
    activeV4Changes: false
  });

  const encoded = JSON.stringify(report);
  for (const forbidden of [
    "nodeId",
    "certificateId",
    "sessionId",
    "bluetoothAddress",
    "publicKey",
    "privateKey",
    "aliasKey",
    "payload"
  ]) {
    if (encoded.includes(`\"${forbidden}\"`)) {
      fail("PRIVACY_INVALID", `report contains forbidden field ${forbidden}`);
    }
  }
  return report;
}

export async function runPhysicalMutualAuthSmoke(options) {
  const registry = new DeviceRegistryV2(options.registryPath);
  await registry.inspect();
  const exchange = new GattHelloExchangeV1({
    enabled: true,
    mutualAuthEnabled: true,
    handshake: new MutualAuthHandshakeV1(registry),
    identity: {
      nodeId: options.serverNodeId,
      bootId: options.bootId,
      capabilities: options.capabilities
    }
  });
  const application = new GattApplication(undefined, exchange);
  const evidence = await capturePhysicalGattEvidence(options, application);
  return evaluatePhysicalMutualAuthEvidence(evidence);
}

function helloSnapshot(overrides = {}) {
  return {
    enabled: true,
    activeExchangeCount: 0,
    responseReadyCount: 0,
    responseDeliveredCount: 0,
    failedExchangeCount: 0,
    writesAcceptedTotal: 0,
    readsDeliveredTotal: 0,
    helloExchangedTotal: 0,
    duplicateWritesTotal: 0,
    duplicateReadsTotal: 0,
    bindingConflictsTotal: 0,
    capacityRejectedTotal: 0,
    expiredTotal: 0,
    failuresTotal: 0,
    resetsTotal: 0,
    mutualAuthEnabled: true,
    authStartedTotal: 0,
    clientProofsVerifiedTotal: 0,
    serverProofsIssuedTotal: 0,
    finishProofsVerifiedTotal: 0,
    authDuplicateWritesTotal: 0,
    authReplayRejectedTotal: 0,
    authFailuresTotal: 0,
    authenticatedSessionCount: 0,
    ...overrides
  };
}

function applicationSnapshot(hello) {
  return {
    applicationPath: "/com/cassav6/gatt",
    exportedInterfaceCount: 9,
    managedObjectCount: 8,
    managedObjectRequestsTotal: 1,
    service: { characteristicCount: 7 },
    access: {
      readDeniedTotal: 0,
      writeDeniedTotal: 0,
      notifyDeniedTotal: 0
    },
    hello
  };
}

export function validMutualAuthFixtureEvidence() {
  const authenticated = {
    activeExchangeCount: 1,
    responseDeliveredCount: 1,
    writesAcceptedTotal: 1,
    readsDeliveredTotal: 1,
    helloExchangedTotal: 1,
    authStartedTotal: 1,
    clientProofsVerifiedTotal: 1,
    serverProofsIssuedTotal: 1,
    finishProofsVerifiedTotal: 1,
    authenticatedSessionCount: 1
  };
  const stopped = {
    ...authenticated,
    activeExchangeCount: 0,
    responseDeliveredCount: 0,
    resetsTotal: 1,
    authenticatedSessionCount: 0
  };
  return {
    preflight: {
      platform: "linux",
      hostname: "raspberrypi",
      architecture: "arm64",
      nodeVersion: "v24.15.0",
      bluezVersion: "5.82",
      bluetoothServiceActive: true,
      adapterName: "hci0",
      adapterPowered: true,
      gattManagerAvailable: true
    },
    discoveryBefore: false,
    discoveryAfter: false,
    ownerBeforeStop: true,
    ownerAfterStop: false,
    registered: {
      state: "REGISTERED",
      application: applicationSnapshot(helloSnapshot())
    },
    beforeStop: {
      state: "REGISTERED",
      application: applicationSnapshot(helloSnapshot(authenticated))
    },
    stopped: {
      state: "STOPPED",
      busConnected: false,
      applicationExported: false,
      registered: false,
      retryScheduled: false,
      activeMatchRules: 0,
      exportedInterfaceCount: 0,
      unregistersTotal: 1,
      unregisterFailuresTotal: 0,
      errorsTotal: 0,
      application: applicationSnapshot(helloSnapshot(stopped))
    },
    durationMs: 30_000
  };
}

export function runSelfTest() {
  const report = evaluatePhysicalMutualAuthEvidence(
    validMutualAuthFixtureEvidence(),
    "2026-07-21T00:00:00.000Z"
  );
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_6_HARNESS_VERSION,
    product: "V6",
    phase: "B5.6",
    mode: "SELF_TEST",
    verdict: report.verdict,
    physicalRadioAccessed: false,
    activeV4Changes: false
  });
}

function parseInteger(value, minimum, maximum, argument) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(
      "INVALID_ARGUMENT",
      `${argument} must be an integer from ${minimum} to ${maximum}`
    );
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    adapterName: "hci0",
    holdMs: 30_000,
    serverNodeId: "123e4567-e89b-12d3-a456-426614174000",
    bootId: 54,
    capabilities: SERVER_CAPABILITIES,
    registryPath: null,
    output: null,
    selfTest: false,
    help: false
  };
  const valueArguments = new Set([
    "--adapter",
    "--hold-ms",
    "--server-node-id",
    "--boot-id",
    "--capabilities",
    "--registry",
    "--output"
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) fail("INVALID_ARGUMENT", "duplicate argument");
    seen.add(argument);
    if (argument === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!valueArguments.has(argument)) {
      fail("INVALID_ARGUMENT", "unknown argument");
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `${argument} requires a value`);
    }
    index += 1;
    if (argument === "--adapter") options.adapterName = value;
    if (argument === "--output") options.output = path.resolve(value);
    if (argument === "--registry") options.registryPath = path.resolve(value);
    if (argument === "--server-node-id") options.serverNodeId = value;
    if (argument === "--hold-ms") {
      options.holdMs = parseInteger(value, 5_000, 90_000, argument);
    }
    if (argument === "--boot-id") {
      options.bootId = parseInteger(value, 1, 255, argument);
    }
    if (argument === "--capabilities") {
      options.capabilities = parseInteger(value, 0, 0x7f, argument);
    }
  }
  if (!ADAPTER_PATTERN.test(options.adapterName)) {
    fail("INVALID_ARGUMENT", "--adapter must match hci[0-9]+");
  }
  if (!NODE_ID_PATTERN.test(options.serverNodeId)) {
    fail(
      "INVALID_ARGUMENT",
      "--server-node-id must be a canonical lowercase UUID"
    );
  }
  if (options.capabilities !== SERVER_CAPABILITIES) {
    fail(
      "INVALID_ARGUMENT",
      `--capabilities must be exactly ${SERVER_CAPABILITIES} for B5.6`
    );
  }
  if (options.selfTest) {
    if (argv.some((value) => value !== "--self-test")) {
      fail(
        "INVALID_ARGUMENT",
        "--self-test cannot be combined with physical arguments"
      );
    }
  } else if (!options.help) {
    if (options.registryPath === null || !path.isAbsolute(options.registryPath)) {
      fail("INVALID_ARGUMENT", "--registry must be an absolute V6 path");
    }
    if (!options.registryPath.toLowerCase().includes("cassav6")) {
      fail("INVALID_ARGUMENT", "--registry must reference isolated V6 state");
    }
  }
  return Object.freeze(options);
}

function safeUnexpectedError(error) {
  if (error instanceof B5MutualAuthSmokeError) return error;
  const sourceCode =
    isRecord(error) && typeof error.code === "string"
      ? error.code.replace(/[^A-Za-z0-9_.-]/gu, "").slice(0, 80)
      : error instanceof Error
        ? error.name
        : "UNKNOWN";
  return new B5MutualAuthSmokeError(
    "B5_MUTUAL_AUTH_SMOKE_FAILED",
    `${sourceCode || "UNKNOWN"}: physical mutual-auth gate failed`,
    { cause: error }
  );
}

function writeReport(report, outputPath) {
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath !== null) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encoded, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  }
  process.stdout.write(encoded);
}

function usage() {
  return [
    "V6 B5.6 Android-Raspberry physical mutual-auth smoke",
    "",
    "Usage:",
    "  node scripts/run-b5-mutual-auth-smoke.mjs --self-test",
    "  node scripts/run-b5-mutual-auth-smoke.mjs --registry ABSOLUTE_PATH \\",
    "    [--adapter hci0] [--hold-ms 30000] [--server-node-id UUID] \\",
    "    [--boot-id 54] [--capabilities 72] [--output REPORT.json]",
    "",
    "The physical gate accepts exactly one bound mutual-auth exchange.",
    "It does not derive a session key, start heartbeat or open business traffic."
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let options = null;
  try {
    options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const report = options.selfTest
      ? runSelfTest()
      : await runPhysicalMutualAuthSmoke(options);
    writeReport(report, options.output);
    return 0;
  } catch (error) {
    const safeError = safeUnexpectedError(error);
    const failure = {
      schemaVersion: 1,
      harnessVersion: B5_6_HARNESS_VERSION,
      product: "V6",
      phase: "B5.6",
      generatedAt: new Date().toISOString(),
      mode: options?.selfTest ? "SELF_TEST" : "PHYSICAL",
      verdict: "FAIL",
      failure: {
        code: safeError.code,
        message: safeError.message
      },
      physicalRadioAccessed: options?.selfTest !== true,
      activeV4Changes: false
    };
    try {
      writeReport(failure, options?.output ?? null);
    } catch {
      process.stderr.write(`${JSON.stringify(failure)}\n`);
    }
    return 1;
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
