import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  B5HelloSmokeError,
  evaluatePhysicalHelloEvidence
} from "../scripts/run-b5-android-hello-smoke.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function fixture() {
  const exchanged = {
    activeExchangeCount: 1,
    responseDeliveredCount: 1,
    writesAcceptedTotal: 1,
    readsDeliveredTotal: 1,
    helloExchangedTotal: 1
  };
  const stopped = {
    writesAcceptedTotal: 1,
    readsDeliveredTotal: 1,
    helloExchangedTotal: 1,
    resetsTotal: 1
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
      application: applicationSnapshot(helloSnapshot(exchanged))
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
    durationMs: 20_000
  };
}

test("B5.5 evaluator accepts exactly one redacted HELLO exchange", () => {
  const report = evaluatePhysicalHelloEvidence(
    fixture(),
    "2026-07-20T12:00:00.000Z"
  );

  assert.equal(report.verdict, "PASS");
  assert.equal(report.phase, "B5.5");
  assert.equal(report.observed.state, "HELLO_EXCHANGED");
  assert.equal(report.observed.writesAccepted, 1);
  assert.equal(report.observed.readsDelivered, 1);
  assert.equal(report.observed.authenticatedSessions, 0);
  assert.equal(report.gate.helloExchange, "PASS_ONE_PHYSICAL_TARGET");
  assert.equal(report.gate.mutualAuthentication, "NOT_STARTED");
  assert.equal(report.gate.b5HundredSessionGate, "PENDING");

  const serialized = JSON.stringify(report);
  for (const forbidden of [
    "\"nodeId\"",
    "\"sessionId\"",
    "\"bluetoothAddress\"",
    "\"nonce\"",
    "\"payload\""
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("B5.5 evaluator rejects partial, duplicate and authenticated exchanges", () => {
  for (const mutate of [
    (value) => {
      value.beforeStop.application.hello.readsDeliveredTotal = 0;
    },
    (value) => {
      value.beforeStop.application.hello.duplicateWritesTotal = 1;
    },
    (value) => {
      value.beforeStop.application.hello.failuresTotal = 1;
    },
    (value) => {
      value.beforeStop.application.hello.authenticatedSessionCount = 1;
    },
    (value) => {
      value.stopped.application.hello.resetsTotal = 0;
    }
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => evaluatePhysicalHelloEvidence(value),
      B5HelloSmokeError
    );
  }
});

test("B5.5 evaluator rejects lifecycle and cleanup regressions", () => {
  for (const mutate of [
    (value) => {
      value.preflight.bluetoothServiceActive = false;
    },
    (value) => {
      value.ownerAfterStop = true;
    },
    (value) => {
      value.discoveryAfter = true;
    },
    (value) => {
      value.stopped.activeMatchRules = 1;
    },
    (value) => {
      value.beforeStop.application.access.writeDeniedTotal = 1;
    },
    (value) => {
      value.beforeStop.application.managedObjectCount = 7;
    },
    (value) => {
      value.stopped.application.hello.failuresTotal = 1;
    }
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => evaluatePhysicalHelloEvidence(value),
      B5HelloSmokeError
    );
  }
});

test("B5.5 self-test is offline and does not promote authentication", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(
        ROOT,
        "scripts",
        "run-b5-android-hello-smoke.mjs"
      ),
      "--self-test"
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 10_000
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, "PASS");
  assert.equal(report.mode, "SELF_TEST");
  assert.equal(report.physicalRadioAccessed, false);
  assert.equal(report.activeV4Changes, false);
});
