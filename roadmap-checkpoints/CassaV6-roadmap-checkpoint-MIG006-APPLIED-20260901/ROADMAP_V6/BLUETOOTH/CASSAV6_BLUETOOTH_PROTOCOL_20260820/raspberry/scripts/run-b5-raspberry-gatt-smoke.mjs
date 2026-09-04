#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { systemBus } from "@jellybrick/dbus-next";

import {
  CASSA_GATT_CHARACTERISTICS,
  CASSA_GATT_SERVICE_UUID
} from "../../shared/protocol/gatt-profile-v1.mjs";
import { DbusNextGattServerPort } from "../dist/bluez/DbusNextGattServerPort.js";

export const B5_3_HARNESS_VERSION = "1.0.0";
export const B5_3_APPLICATION_PATH = "/com/cassav6/gatt";
export const B5_3_SERVICE_PATH = `${B5_3_APPLICATION_PATH}/service0`;

const BLUEZ_BUS_NAME = "org.bluez";
const DBUS_BUS_NAME = "org.freedesktop.DBus";
const DBUS_BUS_PATH = "/org/freedesktop/DBus";
const DBUS_INTERFACE = "org.freedesktop.DBus";
const DBUS_PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const BLUEZ_ADAPTER_INTERFACE = "org.bluez.Adapter1";
const BLUEZ_GATT_MANAGER_INTERFACE = "org.bluez.GattManager1";
const ADAPTER_PATTERN = /^hci[0-9]+$/;
const DEFAULT_OPERATION_DEADLINE_MS = 15_000;
const DEFAULT_CLEANUP_DEADLINE_MS = 5_000;
const execFileAsync = promisify(execFile);

export class B5GattSmokeError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "B5GattSmokeError";
    this.code = code;
  }
}

function fail(code, message, options = undefined) {
  throw new B5GattSmokeError(code, message, options);
}

function safeUnexpectedError(error) {
  if (error instanceof B5GattSmokeError) return error;
  const sourceCode =
    isRecord(error) &&
    typeof error.code === "string" &&
    /^[A-Za-z0-9_.-]{1,80}$/u.test(error.code)
      ? error.code
      : isRecord(error) &&
          typeof error.type === "string" &&
          /^[A-Za-z0-9_.-]{1,160}$/u.test(error.type)
        ? error.type
        : error instanceof Error
          ? error.name
          : "UNKNOWN";
  const sourceMessage =
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.length > 0
      ? error.message.replace(/[\r\n\t]+/gu, " ").slice(0, 300)
      : "unexpected physical GATT error";
  return new B5GattSmokeError(
    "B5_GATT_SMOKE_FAILED",
    `${sourceCode}: ${sourceMessage}`,
    { cause: error }
  );
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

function requireNonNegativeInteger(value, code, message) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, message);
  }
  return value;
}

function requireExactStrings(actual, expected, code, message) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(code, message);
  }
}

function validateRegisteredSnapshot(value) {
  const snapshot = requireRecord(
    value,
    "REGISTRATION_INVALID",
    "registered snapshot is missing"
  );
  requireEqual(
    snapshot.state,
    "REGISTERED",
    "REGISTRATION_INVALID",
    "GATT server did not enter REGISTERED"
  );
  for (const [field, expected] of [
    ["desiredRunning", true],
    ["busConnected", true],
    ["bluezOwnerAvailable", true],
    ["applicationExported", true],
    ["registered", true],
    ["retryScheduled", false]
  ]) {
    requireEqual(
      snapshot[field],
      expected,
      "REGISTRATION_INVALID",
      `registered snapshot field ${field} is invalid`
    );
  }
  requireEqual(
    snapshot.activeMatchRules,
    1,
    "REGISTRATION_INVALID",
    "owner match rule count is not exact"
  );
  requireEqual(
    snapshot.exportedInterfaceCount,
    9,
    "REGISTRATION_INVALID",
    "exported interface count is not exact"
  );
  requireEqual(
    snapshot.registrationAttemptsTotal,
    1,
    "REGISTRATION_INVALID",
    "registration attempts are not exact"
  );
  requireEqual(
    snapshot.registrationsTotal,
    1,
    "REGISTRATION_INVALID",
    "BlueZ did not acknowledge one registration"
  );
  requireEqual(
    snapshot.registrationFailuresTotal,
    0,
    "REGISTRATION_INVALID",
    "registration failure was recorded"
  );
  requireEqual(
    snapshot.errorsTotal,
    0,
    "REGISTRATION_INVALID",
    "runtime error was recorded while registered"
  );

  const application = requireRecord(
    snapshot.application,
    "PROFILE_INVALID",
    "GATT application snapshot is missing"
  );
  requireEqual(
    application.applicationPath,
    B5_3_APPLICATION_PATH,
    "PROFILE_INVALID",
    "application path changed"
  );
  requireEqual(
    application.exportedInterfaceCount,
    9,
    "PROFILE_INVALID",
    "application export count changed"
  );
  requireEqual(
    application.managedObjectCount,
    8,
    "PROFILE_INVALID",
    "managed object count changed"
  );
  const managedObjectRequestsTotal = requireNonNegativeInteger(
    application.managedObjectRequestsTotal,
    "REGISTRATION_INVALID",
    "ObjectManager request count is invalid"
  );
  if (managedObjectRequestsTotal < 1) {
    fail(
      "REGISTRATION_INVALID",
      "BlueZ did not consume the exported ObjectManager tree"
    );
  }
  const service = requireRecord(
    application.service,
    "PROFILE_INVALID",
    "GATT service snapshot is missing"
  );
  requireEqual(
    service.serviceUuid,
    CASSA_GATT_SERVICE_UUID,
    "PROFILE_INVALID",
    "service UUID changed"
  );
  requireEqual(
    service.characteristicCount,
    7,
    "PROFILE_INVALID",
    "characteristic count changed"
  );

  const access = requireRecord(
    application.access,
    "FAIL_CLOSED_INVALID",
    "GATT access metrics are missing"
  );
  requireEqual(
    access.readDeniedTotal,
    0,
    "FAIL_CLOSED_INVALID",
    "unexpected pre-session read reached the GATT application"
  );
  requireEqual(
    access.writeDeniedTotal,
    0,
    "FAIL_CLOSED_INVALID",
    "unexpected pre-session write reached the GATT application"
  );
  requireEqual(
    access.notifyDeniedTotal,
    0,
    "FAIL_CLOSED_INVALID",
    "unexpected pre-session notify reached the GATT application"
  );
}

function validateStoppedSnapshot(value) {
  const snapshot = requireRecord(
    value,
    "CLEANUP_INVALID",
    "stopped snapshot is missing"
  );
  requireEqual(
    snapshot.state,
    "STOPPED",
    "CLEANUP_INVALID",
    "GATT server did not enter STOPPED"
  );
  for (const [field, expected] of [
    ["desiredRunning", false],
    ["busConnected", false],
    ["bluezOwnerAvailable", false],
    ["applicationExported", false],
    ["registered", false],
    ["retryScheduled", false]
  ]) {
    requireEqual(
      snapshot[field],
      expected,
      "CLEANUP_INVALID",
      `stopped snapshot field ${field} is invalid`
    );
  }
  requireEqual(
    snapshot.activeMatchRules,
    0,
    "CLEANUP_INVALID",
    "owner match rule leaked"
  );
  requireEqual(
    snapshot.exportedInterfaceCount,
    0,
    "CLEANUP_INVALID",
    "D-Bus interface leaked"
  );
  requireEqual(
    snapshot.unregisterAttemptsTotal,
    1,
    "CLEANUP_INVALID",
    "unregister attempt count is not exact"
  );
  requireEqual(
    snapshot.unregistersTotal,
    1,
    "CLEANUP_INVALID",
    "BlueZ did not acknowledge one unregister"
  );
  requireEqual(
    snapshot.unregisterFailuresTotal,
    0,
    "CLEANUP_INVALID",
    "unregister failure was recorded"
  );
  requireEqual(
    snapshot.errorsTotal,
    0,
    "CLEANUP_INVALID",
    "runtime error was recorded during cleanup"
  );
}

function validateObservedProfile(value) {
  const profile = requireRecord(
    value,
    "PROFILE_INVALID",
    "observed D-Bus profile is missing"
  );
  requireEqual(
    profile.serviceUuid,
    CASSA_GATT_SERVICE_UUID,
    "PROFILE_INVALID",
    "D-Bus service UUID changed"
  );
  requireEqual(
    profile.primary,
    true,
    "PROFILE_INVALID",
    "D-Bus service is not primary"
  );
  requireEqual(
    profile.servicePath,
    B5_3_SERVICE_PATH,
    "PROFILE_INVALID",
    "D-Bus service path changed"
  );
  requireEqual(
    profile.characteristicCount,
    CASSA_GATT_CHARACTERISTICS.length,
    "PROFILE_INVALID",
    "D-Bus characteristic count changed"
  );
  if (
    !Array.isArray(profile.characteristics) ||
    profile.characteristics.length !== CASSA_GATT_CHARACTERISTICS.length
  ) {
    fail(
      "PROFILE_INVALID",
      "D-Bus characteristic collection is incomplete"
    );
  }
  profile.characteristics.forEach((characteristic, index) => {
    const observed = requireRecord(
      characteristic,
      "PROFILE_INVALID",
      `D-Bus characteristic ${index} is invalid`
    );
    const expected = CASSA_GATT_CHARACTERISTICS[index];
    requireEqual(
      observed.id,
      expected.id,
      "PROFILE_INVALID",
      `D-Bus characteristic ${index} identifier changed`
    );
    requireEqual(
      observed.uuid,
      expected.uuid,
      "PROFILE_INVALID",
      `D-Bus characteristic ${index} UUID changed`
    );
    requireExactStrings(
      observed.flags,
      expected.flags,
      "PROFILE_INVALID",
      `D-Bus characteristic ${index} flags changed`
    );
  });
}

export function evaluatePhysicalGattEvidence(
  input,
  generatedAt = new Date().toISOString()
) {
  const evidence = requireRecord(
    input,
    "EVIDENCE_INVALID",
    "physical GATT evidence is missing"
  );
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
    "REGISTRATION_INVALID",
    "GATT application D-Bus owner is missing"
  );
  requireEqual(
    evidence.ownerAfterStop,
    false,
    "CLEANUP_INVALID",
    "GATT application D-Bus owner survived cleanup"
  );
  requireEqual(
    evidence.discoveryAfter,
    evidence.discoveryBefore,
    "CLEANUP_INVALID",
    "GATT smoke changed the adapter discovery state"
  );
  requireNonNegativeInteger(
    evidence.durationMs,
    "EVIDENCE_INVALID",
    "physical duration is invalid"
  );

  validateObservedProfile(evidence.observedProfile);
  validateRegisteredSnapshot(evidence.registered);
  validateStoppedSnapshot(evidence.stopped);

  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_3_HARNESS_VERSION,
    product: "V6",
    phase: "B5.3",
    generatedAt,
    mode: "PHYSICAL",
    verdict: "PASS",
    target: Object.freeze({
      hostname: preflight.hostname,
      architecture: preflight.architecture,
      nodeVersion: preflight.nodeVersion,
      bluezVersion: preflight.bluezVersion,
      adapterName: preflight.adapterName
    }),
    checks: Object.freeze({
      bluezPreflight: "PASS",
      registerApplication: "PASS",
      objectManagerConsumed: "PASS",
      preSessionTraffic: "ZERO",
      unregisterApplication: "PASS",
      resourceCleanup: "PASS"
    }),
    observed: Object.freeze({
      managedObjectCount:
        evidence.registered.application.managedObjectCount,
      managedObjectRequests:
        evidence.registered.application.managedObjectRequestsTotal,
      characteristicCount:
        evidence.observedProfile.characteristics.length,
      durationMs: evidence.durationMs,
      discoveryStatePreserved: true,
      sessionsOpened: 0
    }),
    gate: Object.freeze({
      raspberryGattSmoke: "PASS",
      androidGattClient: "NOT_STARTED",
      b5HundredSessionGate: "PENDING"
    }),
    physicalRadioAccessed: true,
    activeV4Changes: false
  });
}

function variantValue(value, code, message) {
  if (!isRecord(value) || !Object.hasOwn(value, "value")) {
    fail(code, message);
  }
  return value.value;
}

async function readAdapterState(bus, adapterPath) {
  const adapterObject = await bus.getProxyObject(
    BLUEZ_BUS_NAME,
    adapterPath
  );
  const properties = adapterObject.getInterface(DBUS_PROPERTIES_INTERFACE);
  const powered = variantValue(
    await properties.Get(BLUEZ_ADAPTER_INTERFACE, "Powered"),
    "PREFLIGHT_INVALID",
    "BlueZ Powered property is invalid"
  );
  const discovering = variantValue(
    await properties.Get(BLUEZ_ADAPTER_INTERFACE, "Discovering"),
    "PREFLIGHT_INVALID",
    "BlueZ Discovering property is invalid"
  );
  const manager = adapterObject.getInterface(
    BLUEZ_GATT_MANAGER_INTERFACE
  );
  return Object.freeze({
    powered,
    discovering,
    gattManagerAvailable:
      typeof manager.RegisterApplication === "function" &&
      typeof manager.UnregisterApplication === "function"
  });
}

async function readBluezVersion() {
  try {
    const result = await execFileAsync("bluetoothctl", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true
    });
    return result.stdout.trim().replace(/^bluetoothctl:\s*/u, "");
  } catch (error) {
    fail(
      "PREFLIGHT_INVALID",
      "bluetoothctl --version failed",
      { cause: error }
    );
  }
}

async function readBluetoothServiceActive() {
  try {
    const result = await execFileAsync(
      "systemctl",
      ["is-active", "bluetooth.service"],
      {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true
      }
    );
    return result.stdout.trim() === "active";
  } catch {
    return false;
  }
}

async function nameHasOwner(bus, name) {
  const dbusObject = await bus.getProxyObject(
    DBUS_BUS_NAME,
    DBUS_BUS_PATH
  );
  const dbus = dbusObject.getInterface(DBUS_INTERFACE);
  return dbus.NameHasOwner(name);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateCaptureControls(options) {
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

function physicalCaptureAborted() {
  return new B5GattSmokeError(
    "PHYSICAL_CAPTURE_ABORTED",
    "physical GATT capture was aborted"
  );
}

function physicalCaptureDeadlineExceeded() {
  return new B5GattSmokeError(
    "PHYSICAL_CAPTURE_DEADLINE_EXCEEDED",
    "physical GATT operation exceeded its deadline"
  );
}

function resolveRuntimeDeadline(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    fail(
      "INVALID_ARGUMENT",
      "runtime deadlines must be integers from 1 to 60000"
    );
  }
  return value;
}

function waitWithDeadline(operation, deadlineMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(physicalCaptureDeadlineExceeded());
    }, deadlineMs);
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}

function createAbortGuard(signal) {
  let aborted = signal?.aborted === true;
  const waiters = new Set();
  const onAbort = () => {
    aborted = true;
    for (const reject of waiters) reject(physicalCaptureAborted());
    waiters.clear();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  return Object.freeze({
    signal: signal ?? null,
    throwIfAborted() {
      if (aborted) throw physicalCaptureAborted();
    },
    async wait(operation, deadlineMs = null) {
      if (aborted) throw physicalCaptureAborted();
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finish = () => {
          waiters.delete(rejectForAbort);
          if (timer !== null) clearTimeout(timer);
        };
        const rejectForAbort = (error) => {
          if (settled) return;
          settled = true;
          finish();
          reject(error);
        };
        waiters.add(rejectForAbort);
        if (aborted) {
          rejectForAbort(physicalCaptureAborted());
          return;
        }
        if (deadlineMs !== null) {
          timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            finish();
            reject(physicalCaptureDeadlineExceeded());
          }, deadlineMs);
        }
        Promise.resolve()
          .then(() => {
            if (settled) return undefined;
            return operation();
          })
          .then(
            (value) => {
              if (settled) return;
              settled = true;
              finish();
              resolve(value);
            },
            (error) => {
              if (settled) return;
              settled = true;
              finish();
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

export async function capturePhysicalGattEvidence(
  options,
  application = undefined,
  runtime = {}
) {
  if (process.platform !== "linux") {
    fail(
      "PREFLIGHT_INVALID",
      "physical GATT smoke must run on the Raspberry Linux target"
    );
  }
  if (!ADAPTER_PATTERN.test(options.adapterName)) {
    fail("INVALID_ARGUMENT", "adapter must match hci[0-9]+");
  }
  validateCaptureControls(options);

  const operationDeadlineMs = resolveRuntimeDeadline(
    runtime.operationDeadlineMs,
    DEFAULT_OPERATION_DEADLINE_MS
  );
  const cleanupDeadlineMs = resolveRuntimeDeadline(
    runtime.cleanupDeadlineMs,
    DEFAULT_CLEANUP_DEADLINE_MS
  );
  const abortGuard = createAbortGuard(options.signal);
  const openSystemBus = runtime.systemBus ?? systemBus;
  const createPort =
    runtime.createPort ??
    ((portOptions) => new DbusNextGattServerPort(portOptions));
  const readAdapter = runtime.readAdapterState ?? readAdapterState;
  const readVersion = runtime.readBluezVersion ?? readBluezVersion;
  const readServiceActive =
    runtime.readBluetoothServiceActive ?? readBluetoothServiceActive;
  const readOwner = runtime.nameHasOwner ?? nameHasOwner;
  const wait = runtime.delay ?? delay;
  let probeBus = null;
  let serverBus = null;
  let port = null;
  let startCompleted = false;
  let stopped = false;
  let stopPromise = null;
  const disconnectedBuses = new Set();
  const startedAt = Date.now();
  const disconnectBus = (bus) => {
    if (bus === null || disconnectedBuses.has(bus)) return;
    disconnectedBuses.add(bus);
    try {
      if (typeof bus.disconnect === "function") bus.disconnect();
    } catch {
      // Emergency disconnect is best-effort and must not mask the gate error.
    }
  };
  const stopPort = () => {
    if (stopPromise === null) {
      stopPromise = Promise.resolve().then(() => port.stop());
    }
    return stopPromise;
  };
  const onCaptureAbort = () => {
    disconnectBus(probeBus);
    if (!stopped) disconnectBus(serverBus);
  };
  options.signal?.addEventListener("abort", onCaptureAbort, {
    once: true
  });

  try {
    abortGuard.throwIfAborted();
    probeBus = openSystemBus();
    port = createPort({
      busFactory() {
        if (serverBus !== null) {
          fail(
            "BUS_FACTORY_INVALID",
            "GATT smoke attempted to open a second server bus"
          );
        }
        abortGuard.throwIfAborted();
        const candidate = openSystemBus();
        serverBus = candidate;
        try {
          abortGuard.throwIfAborted();
        } catch (error) {
          disconnectBus(candidate);
          throw error;
        }
        return serverBus;
      },
      ...(application === undefined ? {} : { application })
    });
    const adapterPath = `/org/bluez/${options.adapterName}`;
    const before = await abortGuard.wait(
      () => readAdapter(probeBus, adapterPath),
      operationDeadlineMs
    );
    abortGuard.throwIfAborted();
    const bluezVersion = await abortGuard.wait(
      () => readVersion(),
      operationDeadlineMs
    );
    abortGuard.throwIfAborted();
    const bluetoothServiceActive = await abortGuard.wait(
      () => readServiceActive(),
      operationDeadlineMs
    );
    abortGuard.throwIfAborted();
    const preflight = Object.freeze({
      platform: process.platform,
      hostname: os.hostname(),
      architecture: process.arch,
      nodeVersion: process.version,
      bluezVersion,
      bluetoothServiceActive,
      adapterName: options.adapterName,
      adapterPowered: before.powered,
      gattManagerAvailable: before.gattManagerAvailable
    });
    abortGuard.throwIfAborted();

    await abortGuard.wait(
      () => port.start({ adapterName: options.adapterName }),
      operationDeadlineMs
    );
    startCompleted = true;
    abortGuard.throwIfAborted();
    if (
      serverBus === null ||
      typeof serverBus.name !== "string" ||
      !serverBus.name.startsWith(":")
    ) {
      fail(
        "REGISTRATION_INVALID",
        "server D-Bus unique owner was not assigned"
      );
    }
    const serverName = serverBus.name;
    const ownerBeforeStop = await abortGuard.wait(
      () => readOwner(probeBus, serverName),
      operationDeadlineMs
    );
    abortGuard.throwIfAborted();
    const registered = port.snapshot();
    if (registered?.state !== "REGISTERED") {
      fail(
        "REGISTRATION_INVALID",
        "GATT server did not enter REGISTERED before the readiness hook"
      );
    }
    if (options.onRegistered !== undefined) {
      try {
        await abortGuard.wait(() =>
          options.onRegistered(
            Object.freeze({
              adapterName: options.adapterName,
              signal: abortGuard.signal
            })
          )
        );
      } catch (error) {
        if (
          error instanceof B5GattSmokeError &&
          error.code === "PHYSICAL_CAPTURE_ABORTED"
        ) {
          throw error;
        }
        fail(
          "REGISTERED_HOOK_FAILED",
          "registered hook failed",
          { cause: error }
        );
      }
      abortGuard.throwIfAborted();
    }
    const observedProfile = registered.application.service;
    await abortGuard.wait(() => wait(options.holdMs));
    abortGuard.throwIfAborted();
    const beforeStop = port.snapshot();
    const stoppedSnapshot = await abortGuard.wait(
      stopPort,
      operationDeadlineMs
    );
    stopped = true;
    abortGuard.throwIfAborted();
    const ownerAfterStop = await abortGuard.wait(
      () => readOwner(probeBus, serverName),
      operationDeadlineMs
    );
    abortGuard.throwIfAborted();
    const after = await abortGuard.wait(
      () => readAdapter(probeBus, adapterPath),
      operationDeadlineMs
    );
    abortGuard.throwIfAborted();

    return Object.freeze({
      preflight,
      discoveryBefore: before.discovering,
      discoveryAfter: after.discovering,
      ownerBeforeStop,
      ownerAfterStop,
      observedProfile,
      registered,
      beforeStop,
      stopped: stoppedSnapshot,
      durationMs: Date.now() - startedAt
    });
  } finally {
    if (port !== null && !stopped) {
      try {
        await waitWithDeadline(stopPort, cleanupDeadlineMs);
        stopped = true;
      } catch {
        // Preserve the original physical gate failure.
      }
    }
    if (!stopped || !startCompleted) disconnectBus(serverBus);
    disconnectBus(probeBus);
    options.signal?.removeEventListener("abort", onCaptureAbort);
    abortGuard.dispose();
  }
}

export async function runPhysicalGattSmoke(options) {
  return evaluatePhysicalGattEvidence(
    await capturePhysicalGattEvidence(options)
  );
}

function validFixtureEvidence() {
  const characteristics = CASSA_GATT_CHARACTERISTICS.map(
    (characteristic) => ({
      id: characteristic.id,
      uuid: characteristic.uuid,
      flags: [...characteristic.flags]
    })
  );
  const application = {
    applicationPath: B5_3_APPLICATION_PATH,
    exportedInterfaceCount: 9,
    managedObjectCount: 8,
    managedObjectRequestsTotal: 1,
    service: {
      servicePath: B5_3_SERVICE_PATH,
      serviceUuid: CASSA_GATT_SERVICE_UUID,
      primary: true,
      characteristicCount: 7,
      characteristics
    },
    access: {
      readDeniedTotal: 0,
      writeDeniedTotal: 0,
      notifyDeniedTotal: 0
    }
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
    observedProfile: application.service,
    registered: {
      state: "REGISTERED",
      desiredRunning: true,
      busConnected: true,
      bluezOwnerAvailable: true,
      applicationExported: true,
      registered: true,
      retryScheduled: false,
      activeMatchRules: 1,
      exportedInterfaceCount: 9,
      registrationAttemptsTotal: 1,
      registrationsTotal: 1,
      registrationFailuresTotal: 0,
      unregisterAttemptsTotal: 0,
      unregistersTotal: 0,
      unregisterFailuresTotal: 0,
      errorsTotal: 0,
      application
    },
    stopped: {
      state: "STOPPED",
      desiredRunning: false,
      busConnected: false,
      bluezOwnerAvailable: false,
      applicationExported: false,
      registered: false,
      retryScheduled: false,
      activeMatchRules: 0,
      exportedInterfaceCount: 0,
      registrationAttemptsTotal: 1,
      registrationsTotal: 1,
      registrationFailuresTotal: 0,
      unregisterAttemptsTotal: 1,
      unregistersTotal: 1,
      unregisterFailuresTotal: 0,
      errorsTotal: 0,
      application
    },
    durationMs: 1_000
  };
}

export function runSelfTest() {
  const result = evaluatePhysicalGattEvidence(
    validFixtureEvidence(),
    "2026-07-20T00:00:00.000Z"
  );
  if (
    result.verdict !== "PASS" ||
    result.gate.raspberryGattSmoke !== "PASS" ||
    result.gate.b5HundredSessionGate !== "PENDING"
  ) {
    fail(
      "SELF_TEST_FAILED",
      "B5.3 self-test did not preserve gate semantics"
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B5_3_HARNESS_VERSION,
    product: "V6",
    phase: "B5.3",
    mode: "SELF_TEST",
    verdict: "PASS",
    physicalRadioAccessed: false,
    activeV4Changes: false
  });
}

function parseArguments(argv) {
  const options = {
    adapterName: "hci0",
    holdMs: 1_000,
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
    if (
      argument === "--adapter" ||
      argument === "--hold-ms" ||
      argument === "--output"
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail("INVALID_ARGUMENT", `${argument} requires a value`);
      }
      index += 1;
      if (argument === "--adapter") options.adapterName = value;
      if (argument === "--output") options.output = path.resolve(value);
      if (argument === "--hold-ms") {
        const holdMs = Number(value);
        if (
          !Number.isSafeInteger(holdMs) ||
          holdMs < 100 ||
          holdMs > 10_000
        ) {
          fail(
            "INVALID_ARGUMENT",
            "--hold-ms must be an integer from 100 to 10000"
          );
        }
        options.holdMs = holdMs;
      }
      continue;
    }
    fail("INVALID_ARGUMENT", `unknown argument: ${argument}`);
  }
  if (options.selfTest && argv.some((value) => value === "--adapter")) {
    fail(
      "INVALID_ARGUMENT",
      "--self-test cannot be combined with --adapter"
    );
  }
  return Object.freeze(options);
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
    "V6 B5.3 Raspberry physical GATT smoke",
    "",
    "Usage:",
    "  node scripts/run-b5-raspberry-gatt-smoke.mjs --self-test",
    "  node scripts/run-b5-raspberry-gatt-smoke.mjs [--adapter hci0] \\",
    "    [--hold-ms 1000] [--output REPORT.json]",
    "",
    "The physical mode registers one fail-closed GATT application and removes it.",
    "It does not advertise, open a B5 session or promote the 100-session gate."
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
      : await runPhysicalGattSmoke(options);
    writeReport(report, options.output);
    return 0;
  } catch (error) {
    const safeError = safeUnexpectedError(error);
    const failure = {
      schemaVersion: 1,
      harnessVersion: B5_3_HARNESS_VERSION,
      product: "V6",
      phase: "B5.3",
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
