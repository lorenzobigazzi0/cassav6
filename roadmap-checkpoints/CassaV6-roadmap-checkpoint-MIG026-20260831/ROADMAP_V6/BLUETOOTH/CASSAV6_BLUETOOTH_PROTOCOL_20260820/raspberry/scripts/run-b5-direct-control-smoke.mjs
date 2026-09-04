#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CAPABILITY_BITS } from "../../shared/protocol/advertisement-v1.mjs";
import { DeviceRegistryV2 } from "../../shared/provisioning/device-registry-v2.mjs";
import { GattApplication } from "../dist/bluez/GattApplication.js";
import { DirectControlHandshakeV1 } from "../dist/security/DirectControlHandshakeV1.js";
import { MutualAuthHandshakeV1 } from "../dist/security/Handshake.js";
import { GattHelloExchangeV1 } from "../dist/session/GattHelloExchangeV1.js";
import { capturePhysicalGattEvidence } from "./run-b5-raspberry-gatt-smoke.mjs";

export const B5_7_HARNESS_VERSION = "1.0.0";

const NODE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADAPTER_PATTERN = /^hci[0-9]+$/;
const SERVER_CAPABILITIES =
  CAPABILITY_BITS.GATT_SERVER | CAPABILITY_BITS.BACKEND_BRIDGE;
const MINIMUM_TOTAL_PING_PONG_CYCLES = 4;

export class B5DirectControlSmokeError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "B5DirectControlSmokeError";
    this.code = code;
    this.cleanupVerified = options?.cleanupVerified === true;
  }
}

function fail(code, message, options = undefined) {
  throw new B5DirectControlSmokeError(code, message, options);
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
    requireEqual(value[field], expectedValue, code, `${field} is invalid`);
  }
  return value;
}

function requireMinimum(actual, minimum, code, message) {
  if (!Number.isSafeInteger(actual) || actual < minimum) {
    fail(code, `${message}: expected at least ${String(minimum)}`);
  }
}

function validateLifecycle(evidence) {
  const preflight = requireRecord(
    evidence.preflight,
    "PREFLIGHT_INVALID",
    "physical preflight is missing"
  );
  requireFields(
    preflight,
    {
      platform: "linux",
      bluetoothServiceActive: true,
      adapterPowered: true,
      gattManagerAvailable: true
    },
    "PREFLIGHT_INVALID"
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

export function verifyDirectControlCleanupEvidence(input) {
  const evidence = requireRecord(
    input,
    "DIRECT_CONTROL_CLEANUP_INVALID",
    "physical cleanup evidence is missing"
  );
  const { stopped } = validateLifecycle(evidence);
  const application = requireRecord(
    stopped.application,
    "DIRECT_CONTROL_CLEANUP_INVALID",
    "stopped application snapshot is missing"
  );
  const hello = requireRecord(
    application.hello,
    "DIRECT_CONTROL_CLEANUP_INVALID",
    "stopped direct-control snapshot is missing"
  );
  requireFields(
    hello,
    {
      activeExchangeCount: 0,
      keyEstablishedSessionCount: 0,
      activeSessionCount: 0,
      closingSessionCount: 0,
      activeTimerCount: 0,
      retainedSecretBufferCount: 0
    },
    "DIRECT_CONTROL_CLEANUP_INVALID"
  );
  return true;
}

function retryableOrchestrationTimeout(error, captureResult) {
  let cleanupVerified = false;
  if (captureResult.status === "fulfilled") {
    try {
      cleanupVerified = verifyDirectControlCleanupEvidence(captureResult.value);
    } catch {
      cleanupVerified = false;
    }
  }
  return new B5DirectControlSmokeError(
    "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
    "physical capture ended before a clean direct-control close",
    { cause: error, cleanupVerified }
  );
}

function validateProfile(snapshot) {
  requireFields(
    snapshot,
    { managedObjectCount: 8, exportedInterfaceCount: 9 },
    "PROFILE_INVALID"
  );
  requireFields(snapshot.service, { characteristicCount: 7 }, "PROFILE_INVALID");
}

function zeroControlSnapshot(overrides = {}) {
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
    directControlEnabled: true,
    clientKeySharesAcceptedTotal: 0,
    serverKeySharesIssuedTotal: 0,
    clientKeyConfirmationsVerifiedTotal: 0,
    keyEstablishedTotal: 0,
    heartbeatStartedTotal: 0,
    pingsSentTotal: 0,
    pongsVerifiedTotal: 0,
    heartbeatMissesTotal: 0,
    activeSessionsTotal: 0,
    cleanClosesTotal: 0,
    heartbeatTimeoutClosesTotal: 0,
    forcedClosesTotal: 0,
    directControlDuplicateWritesTotal: 0,
    directControlFailuresTotal: 0,
    keyEstablishedSessionCount: 0,
    activeSessionCount: 0,
    closingSessionCount: 0,
    activeTimerCount: 0,
    retainedSecretBufferCount: 0,
    ...overrides
  };
}

function validateInitial(snapshot) {
  return requireFields(
    snapshot,
    zeroControlSnapshot(),
    "DIRECT_CONTROL_EVIDENCE_INVALID"
  );
}

function expectedClosedControlSnapshot(resetsTotal = 0) {
  return zeroControlSnapshot({
    writesAcceptedTotal: 1,
    readsDeliveredTotal: 1,
    helloExchangedTotal: 1,
    resetsTotal,
    authStartedTotal: 1,
    clientProofsVerifiedTotal: 1,
    serverProofsIssuedTotal: 1,
    finishProofsVerifiedTotal: 1,
    clientKeySharesAcceptedTotal: 1,
    serverKeySharesIssuedTotal: 1,
    clientKeyConfirmationsVerifiedTotal: 1,
    keyEstablishedTotal: 1,
    heartbeatStartedTotal: 1,
    activeSessionsTotal: 1,
    cleanClosesTotal: 1
  });
}

function validateClosed(snapshot) {
  const value = requireRecord(
    snapshot,
    "DIRECT_CONTROL_EVIDENCE_INVALID",
    "direct-control snapshot is missing"
  );
  const expected = expectedClosedControlSnapshot();
  delete expected.pingsSentTotal;
  delete expected.pongsVerifiedTotal;
  delete expected.heartbeatMissesTotal;
  delete expected.resetsTotal;
  requireFields(value, expected, "DIRECT_CONTROL_EVIDENCE_INVALID");
  requireMinimum(
    value.pingsSentTotal,
    MINIMUM_TOTAL_PING_PONG_CYCLES,
    "DIRECT_CONTROL_EVIDENCE_INVALID",
    "authenticated PING count is too small"
  );
  requireMinimum(
    value.pongsVerifiedTotal,
    MINIMUM_TOTAL_PING_PONG_CYCLES,
    "DIRECT_CONTROL_EVIDENCE_INVALID",
    "authenticated PONG count is too small"
  );
  if (
    !Number.isSafeInteger(value.heartbeatMissesTotal) ||
    value.heartbeatMissesTotal < 0 ||
    value.pongsVerifiedTotal > value.pingsSentTotal
  ) {
    fail(
      "DIRECT_CONTROL_EVIDENCE_INVALID",
      "heartbeat counters are inconsistent"
    );
  }
  if (!Number.isSafeInteger(value.resetsTotal) || value.resetsTotal < 0) {
    fail("DIRECT_CONTROL_EVIDENCE_INVALID", "reset count is invalid");
  }
  return value;
}

function validateAccess(snapshot) {
  requireFields(
    snapshot,
    { readDeniedTotal: 0, writeDeniedTotal: 0, notifyDeniedTotal: 0 },
    "DIRECT_CONTROL_EVIDENCE_INVALID"
  );
}

function assertRedactedReport(report) {
  const forbiddenFields = [
    /node.?id/iu,
    /certificate.?id/iu,
    /session.?id/iu,
    /bluetooth.?address/iu,
    /mac.?address/iu,
    /serial/iu,
    /public.?key/iu,
    /private.?key/iu,
    /alias.?key/iu,
    /session.?key/iu,
    /authentication.?key/iu,
    /payload/iu,
    /registry.?path/iu,
    /device.?path/iu,
    /application.?path/iu,
    /service.?path/iu,
    /output.?path/iu
  ];
  const visit = (value) => {
    if (!isRecord(value)) return;
    for (const [field, nested] of Object.entries(value)) {
      if (forbiddenFields.some((pattern) => pattern.test(field))) {
        fail("PRIVACY_INVALID", "report contains a forbidden field");
      }
      if (isRecord(nested)) visit(nested);
    }
  };
  visit(report);

  const encoded = JSON.stringify(report);
  for (const pattern of [
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu,
    /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/iu,
    /\/org\/bluez\//u,
    /\/(?:home|tmp|var|etc|run)\//u,
    /-----BEGIN [A-Z ]+-----/u
  ]) {
    if (pattern.test(encoded)) {
      fail("PRIVACY_INVALID", "report contains forbidden identifying material");
    }
  }
}

function pollDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateDirectControlControls(options) {
  if (
    options.onRegistered !== undefined &&
    typeof options.onRegistered !== "function"
  ) {
    fail("INVALID_ARGUMENT", "onRegistered must be an async callback");
  }
  const signal = options.signal;
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    fail("INVALID_ARGUMENT", "signal must be an AbortSignal");
  }
}

function directControlAborted() {
  return new B5DirectControlSmokeError(
    "PHYSICAL_CAPTURE_ABORTED",
    "physical direct-control gate was aborted"
  );
}

function createDirectControlAbortGuard(signal) {
  let aborted = signal?.aborted === true;
  const waiters = new Set();
  const onAbort = () => {
    aborted = true;
    for (const reject of waiters) reject(directControlAborted());
    waiters.clear();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  return Object.freeze({
    signal: signal ?? null,
    throwIfAborted() {
      if (aborted) throw directControlAborted();
    },
    async wait(operation) {
      if (aborted) throw directControlAborted();
      return new Promise((resolve, reject) => {
        let settled = false;
        const rejectForAbort = (error) => {
          if (settled) return;
          settled = true;
          waiters.delete(rejectForAbort);
          reject(error);
        };
        waiters.add(rejectForAbort);
        if (aborted) {
          rejectForAbort(directControlAborted());
          return;
        }
        Promise.resolve()
          .then(operation)
          .then(
            (value) => {
              if (settled) return;
              settled = true;
              waiters.delete(rejectForAbort);
              resolve(value);
            },
            (error) => {
              if (settled) return;
              settled = true;
              waiters.delete(rejectForAbort);
              reject(error);
            }
          );
      });
    },
    dispose() {
      signal?.removeEventListener("abort", onAbort);
      waiters.clear();
    }
  });
}

export async function orchestrateSingleDirectControlClose(
  application,
  options = {}
) {
  validateDirectControlControls(options);
  const abortGuard = createDirectControlAbortGuard(options.signal);
  const captureEnded = options.captureEnded ?? (() => false);
  const wait = options.wait ?? pollDelay;
  const pollMs = options.pollMs ?? 100;
  let closeRequested = false;

  try {
    while (true) {
      abortGuard.throwIfAborted();
      const hello = requireRecord(
        application.snapshot()?.hello,
        "DIRECT_CONTROL_ORCHESTRATION_INVALID",
        "direct-control orchestration snapshot is missing"
      );
      for (const [field, maximum] of [
        ["helloExchangedTotal", 1],
        ["finishProofsVerifiedTotal", 1],
        ["keyEstablishedTotal", 1],
        ["activeSessionsTotal", 1],
        ["activeSessionCount", 1],
        ["closingSessionCount", 1],
        ["cleanClosesTotal", 1],
        ["pingsSentTotal", Number.MAX_SAFE_INTEGER],
        ["pongsVerifiedTotal", Number.MAX_SAFE_INTEGER]
      ]) {
        if (!Number.isSafeInteger(hello[field]) || hello[field] < 0) {
          fail(
            "DIRECT_CONTROL_ORCHESTRATION_INVALID",
            "direct-control orchestration counter is invalid"
          );
        }
        if (hello[field] > maximum) {
          fail(
            "DIRECT_CONTROL_ORCHESTRATION_INVALID",
            "more than one sequential session was observed"
          );
        }
      }
      requireFields(
        hello,
        {
          heartbeatTimeoutClosesTotal: 0,
          forcedClosesTotal: 0,
          directControlFailuresTotal: 0
        },
        "DIRECT_CONTROL_ORCHESTRATION_INVALID"
      );
      if (hello.pongsVerifiedTotal > hello.pingsSentTotal) {
        fail(
          "DIRECT_CONTROL_ORCHESTRATION_INVALID",
          "heartbeat counters are inconsistent"
        );
      }

      if (hello.cleanClosesTotal === 1) {
        if (!closeRequested) {
          fail(
            "DIRECT_CONTROL_ORCHESTRATION_INVALID",
            "session closed before the controlled close request"
          );
        }
        requireFields(
          hello,
          {
            activeExchangeCount: 0,
            keyEstablishedSessionCount: 0,
            activeSessionCount: 0,
            closingSessionCount: 0,
            activeTimerCount: 0,
            retainedSecretBufferCount: 0
          },
          "DIRECT_CONTROL_ORCHESTRATION_INVALID"
        );
        return Object.freeze({
          closeRequested: true,
          cleanCloseObserved: true
        });
      }

      if (captureEnded()) {
        fail(
          "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
          "physical capture ended before a clean direct-control close"
        );
      }

      if (
        !closeRequested &&
        hello.pingsSentTotal >= MINIMUM_TOTAL_PING_PONG_CYCLES &&
        hello.pongsVerifiedTotal >= MINIMUM_TOTAL_PING_PONG_CYCLES
      ) {
        requireFields(
          hello,
          {
            activeSessionsTotal: 1,
            activeSessionCount: 1,
            closingSessionCount: 0,
            cleanClosesTotal: 0
          },
          "DIRECT_CONTROL_ORCHESTRATION_INVALID"
        );
        application.requestSingleDirectClose();
        closeRequested = true;
      }

      await abortGuard.wait(() => wait(pollMs));
      abortGuard.throwIfAborted();
    }
  } finally {
    abortGuard.dispose();
  }
}

export function evaluatePhysicalDirectControlEvidence(
  input,
  generatedAt = new Date().toISOString()
) {
  const evidence = requireRecord(
    input,
    "EVIDENCE_INVALID",
    "physical direct-control evidence is missing"
  );
  const { preflight, registered, beforeStop, stopped } =
    validateLifecycle(evidence);
  validateProfile(registered.application);
  validateProfile(beforeStop.application);
  validateInitial(registered.application?.hello);
  const closed = validateClosed(beforeStop.application?.hello);
  const stoppedControl = validateClosed(stopped.application?.hello);
  if (closed.resetsTotal > 1) {
    fail(
      "DIRECT_CONTROL_EVIDENCE_INVALID",
      "unexpected reset occurred before server cleanup"
    );
  }
  requireEqual(
    stoppedControl.resetsTotal,
    closed.resetsTotal + 1,
    "DIRECT_CONTROL_EVIDENCE_INVALID",
    "server cleanup did not add exactly one reset"
  );
  validateAccess(registered.application?.access);
  validateAccess(beforeStop.application?.access);

  const report = Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_7_HARNESS_VERSION,
    product: "V6",
    phase: "B5.7",
    generatedAt,
    mode: "PHYSICAL",
    verdict: "PASS",
    target: Object.freeze({
      role: "GATT_SERVER",
      architecture: preflight.architecture,
      nodeVersion: preflight.nodeVersion,
      bluezVersion: preflight.bluezVersion,
      adapterName: preflight.adapterName
    }),
    checks: Object.freeze({
      bluezPreflight: "PASS",
      registryReadOnlyInspection: "PASS",
      helloExchange: "PASS",
      mutualAuthentication: "PASS",
      keyEstablishment: "PASS",
      activeStateReached: "PASS",
      authenticatedHeartbeat: "PASS",
      exactSingleSequentialSession: "PASS",
      cleanClose: "PASS",
      businessCharacteristics: "FAIL_CLOSED",
      unregisterApplication: "PASS",
      resourceCleanup: "PASS"
    }),
    observed: Object.freeze({
      finalState: "CLOSED",
      durationMs: evidence.durationMs,
      managedObjectCount: beforeStop.application.managedObjectCount,
      characteristicCount: beforeStop.application.service.characteristicCount,
      helloExchanged: closed.helloExchangedTotal,
      mutualAuthentications: closed.finishProofsVerifiedTotal,
      keyEstablishments: closed.keyEstablishedTotal,
      activeTransitions: closed.activeSessionsTotal,
      pingsSent: closed.pingsSentTotal,
      pongsVerified: closed.pongsVerifiedTotal,
      heartbeatMisses: closed.heartbeatMissesTotal,
      cleanCloses: closed.cleanClosesTotal,
      activeAfterClose: closed.activeSessionCount,
      timersAfterClose: closed.activeTimerCount,
      retainedSecretBuffersAfterClose: closed.retainedSecretBufferCount,
      activeAfterCleanup: stoppedControl.activeSessionCount,
      timersAfterCleanup: stoppedControl.activeTimerCount,
      retainedSecretBuffersAfterCleanup:
        stoppedControl.retainedSecretBufferCount,
      failures: closed.failuresTotal +
        closed.authFailuresTotal +
        closed.directControlFailuresTotal
    }),
    gate: Object.freeze({
      directControl: "PASS_ONE_PHYSICAL_TARGET",
      businessTraffic: "NOT_STARTED",
      hundredSessionCampaign: "PENDING"
    }),
    privacy: Object.freeze({
      identifiersIncluded: false,
      addressesIncluded: false,
      cryptographicMaterialIncluded: false,
      messageBodiesIncluded: false,
      localLocationsIncluded: false
    }),
    physicalRadioAccessed: true,
    v6ProductionServiceChanges: false
  });
  assertRedactedReport(report);
  return report;
}

export async function runPhysicalDirectControlSmoke(options, runtime = {}) {
  validateDirectControlControls(options);
  const abortGuard = createDirectControlAbortGuard(options.signal);
  const registry =
    runtime.registry ?? new DeviceRegistryV2(options.registryPath);
  const captureRunner =
    runtime.capturePhysicalGattEvidence ?? capturePhysicalGattEvidence;
  const orchestrationRunner =
    runtime.orchestrateSingleDirectControlClose ??
    orchestrateSingleDirectControlClose;

  try {
    abortGuard.throwIfAborted();
    await abortGuard.wait(() => registry.inspect());
    abortGuard.throwIfAborted();
    const exchange = new GattHelloExchangeV1({
      enabled: true,
      mutualAuthEnabled: true,
      handshake: new MutualAuthHandshakeV1(registry),
      directControlEnabled: true,
      directControlHandshake: new DirectControlHandshakeV1(registry),
      identity: {
        nodeId: options.serverNodeId,
        bootId: options.bootId,
        capabilities: options.capabilities
      }
    });
    const application = new GattApplication(undefined, exchange);
    let captureEnded = false;
    const capture = Promise.resolve()
      .then(() => captureRunner(options, application))
      .finally(() => {
        captureEnded = true;
      });
    const orchestration = Promise.resolve().then(() =>
      orchestrationRunner(application, {
        captureEnded: () => captureEnded,
        signal: abortGuard.signal
      })
    );
    const [captureResult, orchestrationResult] = await Promise.allSettled([
      capture,
      orchestration
    ]);
    abortGuard.throwIfAborted();
    if (
      orchestrationResult.status === "rejected" &&
      orchestrationResult.reason?.code ===
        "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT"
    ) {
      throw retryableOrchestrationTimeout(
        orchestrationResult.reason,
        captureResult
      );
    }
    if (captureResult.status === "rejected") throw captureResult.reason;
    if (orchestrationResult.status === "rejected") {
      throw orchestrationResult.reason;
    }
    return evaluatePhysicalDirectControlEvidence(captureResult.value);
  } finally {
    abortGuard.dispose();
  }
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

export function validDirectControlFixtureEvidence() {
  const closed = expectedClosedControlSnapshot(0);
  closed.pingsSentTotal = 4;
  closed.pongsVerifiedTotal = 4;
  const stoppedControl = { ...closed, resetsTotal: 1 };
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
      application: applicationSnapshot(zeroControlSnapshot())
    },
    beforeStop: {
      state: "REGISTERED",
      application: applicationSnapshot(closed)
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
      application: applicationSnapshot(stoppedControl)
    },
    durationMs: 60_000
  };
}

export function runSelfTest() {
  const report = evaluatePhysicalDirectControlEvidence(
    validDirectControlFixtureEvidence(),
    "2026-07-21T00:00:00.000Z"
  );
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_7_HARNESS_VERSION,
    product: "V6",
    phase: "B5.7",
    mode: "SELF_TEST",
    verdict: report.verdict,
    physicalRadioAccessed: false,
    v6ProductionServiceChanges: false
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
    holdMs: 60_000,
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
      options.holdMs = parseInteger(value, 15_000, 180_000, argument);
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
      `--capabilities must be exactly ${SERVER_CAPABILITIES} for B5.7`
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
      fail("INVALID_ARGUMENT", "--registry must be an absolute V6 location");
    }
    if (!options.registryPath.toLowerCase().includes("cassav6")) {
      fail("INVALID_ARGUMENT", "--registry must reference isolated V6 state");
    }
  }
  return Object.freeze(options);
}

function safeUnexpectedError(error) {
  if (error instanceof B5DirectControlSmokeError) return error;
  const sourceCode =
    isRecord(error) && typeof error.code === "string"
      ? error.code.replace(/[^A-Za-z0-9_.-]/gu, "").slice(0, 80)
      : error instanceof Error
        ? error.name
        : "UNKNOWN";
  return new B5DirectControlSmokeError(
    "B5_DIRECT_CONTROL_SMOKE_FAILED",
    `${sourceCode || "UNKNOWN"}: physical direct-control gate failed`,
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
    "V6 B5.7 Android-Raspberry physical direct-control smoke",
    "",
    "Usage:",
    "  node scripts/run-b5-direct-control-smoke.mjs --self-test",
    "  node scripts/run-b5-direct-control-smoke.mjs --registry ABSOLUTE_LOCATION \\",
    "    [--adapter hci0] [--hold-ms 60000] [--server-node-id UUID] \\",
    "    [--boot-id 54] [--capabilities 72] [--output REPORT.json]",
    "",
    "The physical gate accepts exactly one sequential direct-control session.",
    "It requires ACTIVE, at least three authenticated PING/PONG cycles and a clean close."
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
      : await runPhysicalDirectControlSmoke(options);
    writeReport(report, options.output);
    return 0;
  } catch (error) {
    const safeError = safeUnexpectedError(error);
    const failure = {
      schemaVersion: 1,
      harnessVersion: B5_7_HARNESS_VERSION,
      product: "V6",
      phase: "B5.7",
      generatedAt: new Date().toISOString(),
      mode: options?.selfTest ? "SELF_TEST" : "PHYSICAL",
      verdict: "FAIL",
      failure: { code: safeError.code, message: safeError.message },
      physicalRadioAccessed: options?.selfTest !== true,
      v6ProductionServiceChanges: false
    };
    try {
      assertRedactedReport(failure);
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
