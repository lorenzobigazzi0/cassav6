#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CAPABILITY_BITS } from "../../shared/protocol/advertisement-v1.mjs";
import { GattApplication } from "../dist/bluez/GattApplication.js";
import { GattHelloExchangeV1 } from "../dist/session/GattHelloExchangeV1.js";
import { capturePhysicalGattEvidence } from "./run-b5-raspberry-gatt-smoke.mjs";

export const B5_5_HARNESS_VERSION = "1.0.0";

const NODE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADAPTER_PATTERN = /^hci[0-9]+$/;

export class B5HelloSmokeError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "B5HelloSmokeError";
    this.code = code;
  }
}

function fail(code, message, options = undefined) {
  throw new B5HelloSmokeError(code, message, options);
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

function requireZeroMetrics(snapshot, fields, code) {
  for (const field of fields) {
    requireEqual(snapshot[field], 0, code, `${field} must remain zero`);
  }
}

function validateServerLifecycle(evidence) {
  const preflight = requireRecord(
    evidence.preflight,
    "PREFLIGHT_INVALID",
    "physical preflight is missing"
  );
  requireEqual(
    preflight.platform,
    "linux",
    "PREFLIGHT_INVALID",
    "physical gate did not run on Linux"
  );
  requireEqual(
    preflight.bluetoothServiceActive,
    true,
    "PREFLIGHT_INVALID",
    "bluetooth.service is not active"
  );
  requireEqual(
    preflight.adapterPowered,
    true,
    "PREFLIGHT_INVALID",
    "Bluetooth adapter is not powered"
  );
  requireEqual(
    preflight.gattManagerAvailable,
    true,
    "PREFLIGHT_INVALID",
    "GattManager1 is not available"
  );
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
  requireEqual(
    stopped.state,
    "STOPPED",
    "SERVER_LIFECYCLE_INVALID",
    "server did not stop"
  );
  for (const [field, expected] of [
    ["busConnected", false],
    ["applicationExported", false],
    ["registered", false],
    ["retryScheduled", false],
    ["activeMatchRules", 0],
    ["exportedInterfaceCount", 0],
    ["unregistersTotal", 1],
    ["unregisterFailuresTotal", 0],
    ["errorsTotal", 0]
  ]) {
    requireEqual(
      stopped[field],
      expected,
      "SERVER_LIFECYCLE_INVALID",
      `stopped ${field} is invalid`
    );
  }
  return { preflight, registered, beforeStop, stopped };
}

export function evaluatePhysicalHelloEvidence(
  input,
  generatedAt = new Date().toISOString()
) {
  const evidence = requireRecord(
    input,
    "EVIDENCE_INVALID",
    "physical HELLO evidence is missing"
  );
  const { preflight, registered, beforeStop, stopped } =
    validateServerLifecycle(evidence);
  const initialHello = requireRecord(
    registered.application?.hello,
    "HELLO_EVIDENCE_INVALID",
    "initial HELLO snapshot is missing"
  );
  const observedHello = requireRecord(
    beforeStop.application?.hello,
    "HELLO_EVIDENCE_INVALID",
    "observed HELLO snapshot is missing"
  );
  const stoppedHello = requireRecord(
    stopped.application?.hello,
    "HELLO_EVIDENCE_INVALID",
    "stopped HELLO snapshot is missing"
  );

  requireEqual(
    initialHello.enabled,
    true,
    "HELLO_EVIDENCE_INVALID",
    "HELLO was not enabled"
  );
  requireZeroMetrics(
    initialHello,
    [
      "activeExchangeCount",
      "writesAcceptedTotal",
      "readsDeliveredTotal",
      "helloExchangedTotal",
      "failuresTotal",
      "authenticatedSessionCount"
    ],
    "HELLO_EVIDENCE_INVALID"
  );

  for (const [field, expected] of [
    ["enabled", true],
    ["activeExchangeCount", 1],
    ["responseReadyCount", 0],
    ["responseDeliveredCount", 1],
    ["failedExchangeCount", 0],
    ["writesAcceptedTotal", 1],
    ["readsDeliveredTotal", 1],
    ["helloExchangedTotal", 1],
    ["authenticatedSessionCount", 0]
  ]) {
    requireEqual(
      observedHello[field],
      expected,
      "HELLO_EVIDENCE_INVALID",
      `observed ${field} is invalid`
    );
  }
  requireZeroMetrics(
    observedHello,
    [
      "duplicateWritesTotal",
      "duplicateReadsTotal",
      "bindingConflictsTotal",
      "capacityRejectedTotal",
      "expiredTotal",
      "failuresTotal",
      "resetsTotal"
    ],
    "HELLO_EVIDENCE_INVALID"
  );
  requireZeroMetrics(
    beforeStop.application?.access ?? {},
    ["readDeniedTotal", "writeDeniedTotal", "notifyDeniedTotal"],
    "HELLO_EVIDENCE_INVALID"
  );
  for (const snapshot of [registered, beforeStop]) {
    requireEqual(
      snapshot.application?.managedObjectCount,
      8,
      "HELLO_EVIDENCE_INVALID",
      "managed object count changed"
    );
    requireEqual(
      snapshot.application?.service?.characteristicCount,
      7,
      "HELLO_EVIDENCE_INVALID",
      "GATT characteristic count changed"
    );
  }

  for (const [field, expected] of [
    ["enabled", true],
    ["activeExchangeCount", 0],
    ["responseReadyCount", 0],
    ["responseDeliveredCount", 0],
    ["writesAcceptedTotal", 1],
    ["readsDeliveredTotal", 1],
    ["helloExchangedTotal", 1],
    ["resetsTotal", 1],
    ["authenticatedSessionCount", 0]
  ]) {
    requireEqual(
      stoppedHello[field],
      expected,
      "HELLO_EVIDENCE_INVALID",
      `stopped ${field} is invalid`
    );
  }
  requireZeroMetrics(
    stoppedHello,
    [
      "failedExchangeCount",
      "duplicateWritesTotal",
      "duplicateReadsTotal",
      "bindingConflictsTotal",
      "capacityRejectedTotal",
      "expiredTotal",
      "failuresTotal"
    ],
    "HELLO_EVIDENCE_INVALID"
  );
  requireZeroMetrics(
    stopped.application?.access ?? {},
    ["readDeniedTotal", "writeDeniedTotal", "notifyDeniedTotal"],
    "HELLO_EVIDENCE_INVALID"
  );

  const report = Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_5_HARNESS_VERSION,
    product: "V6",
    phase: "B5.5",
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
      helloWrite: "PASS",
      helloResponseRead: "PASS",
      exactSingleExchange: "PASS",
      nonHelloCharacteristics: "FAIL_CLOSED",
      authenticatedSessions: "ZERO",
      unregisterApplication: "PASS",
      resourceCleanup: "PASS"
    }),
    observed: Object.freeze({
      state: "HELLO_EXCHANGED",
      durationMs: evidence.durationMs,
      managedObjectCount: beforeStop.application.managedObjectCount,
      characteristicCount:
        beforeStop.application.service.characteristicCount,
      writesAccepted: observedHello.writesAcceptedTotal,
      readsDelivered: observedHello.readsDeliveredTotal,
      helloExchanged: observedHello.helloExchangedTotal,
      failures: observedHello.failuresTotal,
      authenticatedSessions: observedHello.authenticatedSessionCount
    }),
    gate: Object.freeze({
      helloExchange: "PASS_ONE_PHYSICAL_TARGET",
      mutualAuthentication: "NOT_STARTED",
      sessionKey: "NOT_STARTED",
      heartbeat: "NOT_STARTED",
      b5HundredSessionGate: "PENDING"
    }),
    privacy: Object.freeze({
      stableNodeIdsIncluded: false,
      sessionIdsIncluded: false,
      bluetoothAddressesIncluded: false,
      noncesIncluded: false,
      payloadsIncluded: false
    }),
    physicalRadioAccessed: true,
    activeV4Changes: false
  });

  for (const forbidden of [
    "nodeId",
    "sessionId",
    "bluetoothAddress",
    "nonce",
    "payload"
  ]) {
    if (JSON.stringify(report).includes(`"${forbidden}"`)) {
      fail("PRIVACY_INVALID", `report contains forbidden field ${forbidden}`);
    }
  }
  return report;
}

export async function runPhysicalHelloSmoke(options) {
  const helloExchange = new GattHelloExchangeV1({
    enabled: true,
    identity: {
      nodeId: options.serverNodeId,
      bootId: options.bootId,
      capabilities: options.capabilities
    }
  });
  const application = new GattApplication(undefined, helloExchange);
  const evidence = await capturePhysicalGattEvidence(options, application);
  return evaluatePhysicalHelloEvidence(evidence);
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
    authenticatedSessionCount: 0,
    ...overrides
  };
}

function applicationSnapshot(hello) {
  return {
    managedObjectCount: 8,
    service: { characteristicCount: 7 },
    access: {
      readDeniedTotal: 0,
      writeDeniedTotal: 0,
      notifyDeniedTotal: 0
    },
    hello
  };
}

function validFixtureEvidence() {
  const initial = helloSnapshot();
  const exchanged = helloSnapshot({
    activeExchangeCount: 1,
    responseDeliveredCount: 1,
    writesAcceptedTotal: 1,
    readsDeliveredTotal: 1,
    helloExchangedTotal: 1
  });
  const reset = helloSnapshot({
    writesAcceptedTotal: 1,
    readsDeliveredTotal: 1,
    helloExchangedTotal: 1,
    resetsTotal: 1
  });
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
      application: applicationSnapshot(initial)
    },
    beforeStop: {
      state: "REGISTERED",
      application: applicationSnapshot(exchanged)
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
      application: applicationSnapshot(reset)
    },
    durationMs: 20_000
  };
}

function runSelfTest() {
  const report = evaluatePhysicalHelloEvidence(
    validFixtureEvidence(),
    "2026-07-20T12:00:00.000Z"
  );
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_5_HARNESS_VERSION,
    product: "V6",
    phase: "B5.5",
    mode: "SELF_TEST",
    verdict: report.verdict,
    physicalRadioAccessed: false,
    activeV4Changes: false
  });
}

function parseInteger(value, minimum, maximum, argument) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
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
    holdMs: 20_000,
    serverNodeId: "123e4567-e89b-12d3-a456-426614174000",
    bootId: 54,
    capabilities:
      CAPABILITY_BITS.GATT_SERVER | CAPABILITY_BITS.BACKEND_BRIDGE,
    output: null,
    selfTest: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const valueArguments = new Set([
      "--adapter",
      "--hold-ms",
      "--server-node-id",
      "--boot-id",
      "--capabilities",
      "--output"
    ]);
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
    if (argument === "--server-node-id") options.serverNodeId = value;
    if (argument === "--hold-ms") {
      options.holdMs = parseInteger(value, 1_000, 60_000, argument);
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
  if ((options.capabilities & CAPABILITY_BITS.GATT_SERVER) === 0) {
    fail(
      "INVALID_ARGUMENT",
      "--capabilities must include GATT_SERVER"
    );
  }
  if (options.selfTest && argv.some((value) => value !== "--self-test")) {
    fail(
      "INVALID_ARGUMENT",
      "--self-test cannot be combined with physical arguments"
    );
  }
  return Object.freeze(options);
}

function safeUnexpectedError(error) {
  if (error instanceof B5HelloSmokeError) return error;
  const sourceCode =
    isRecord(error) && typeof error.code === "string"
      ? error.code.replace(/[^A-Za-z0-9_.-]/gu, "").slice(0, 80)
      : error instanceof Error
        ? error.name
        : "UNKNOWN";
  return new B5HelloSmokeError(
    "B5_HELLO_SMOKE_FAILED",
    `${sourceCode || "UNKNOWN"}: physical HELLO gate failed`,
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
    "V6 B5.5 Android-Raspberry physical HELLO smoke",
    "",
    "Usage:",
    "  node scripts/run-b5-android-hello-smoke.mjs --self-test",
    "  node scripts/run-b5-android-hello-smoke.mjs [--adapter hci0] \\",
    "    [--hold-ms 20000] [--server-node-id UUID] [--boot-id 54] \\",
    "    [--capabilities 72] [--output REPORT.json]",
    "",
    "The physical gate accepts exactly one HELLO write/read exchange.",
    "It does not authenticate, derive a key, start heartbeat or open ACTIVE."
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
      : await runPhysicalHelloSmoke(options);
    writeReport(report, options.output);
    return 0;
  } catch (error) {
    const safeError = safeUnexpectedError(error);
    const failure = {
      schemaVersion: 1,
      harnessVersion: B5_5_HARNESS_VERSION,
      product: "V6",
      phase: "B5.5",
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
  fs.realpathSync(fileURLToPath(import.meta.url)) ===
    fs.realpathSync(invokedPath)
) {
  process.exitCode = await main();
}
