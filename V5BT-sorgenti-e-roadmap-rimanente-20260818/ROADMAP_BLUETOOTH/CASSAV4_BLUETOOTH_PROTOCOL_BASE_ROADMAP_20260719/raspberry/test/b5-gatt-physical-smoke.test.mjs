import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  B5GattSmokeError,
  capturePhysicalGattEvidence,
  evaluatePhysicalGattEvidence
} from "../scripts/run-b5-raspberry-gatt-smoke.mjs";
import {
  CASSA_GATT_CHARACTERISTICS,
  CASSA_GATT_SERVICE_UUID
} from "../../shared/protocol/gatt-profile-v1.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const APPLICATION_PATH = "/com/cassav5bt/gatt";
const SERVICE_PATH = `${APPLICATION_PATH}/service0`;

function applicationSnapshot() {
  return {
    applicationPath: APPLICATION_PATH,
    exportedInterfaceCount: 9,
    managedObjectCount: 8,
    managedObjectRequestsTotal: 1,
    service: {
      servicePath: SERVICE_PATH,
      serviceUuid: CASSA_GATT_SERVICE_UUID,
      primary: true,
      characteristicCount: 7,
      characteristics: CASSA_GATT_CHARACTERISTICS.map(
        (characteristic) => ({
          id: characteristic.id,
          uuid: characteristic.uuid,
          flags: [...characteristic.flags]
        })
      )
    },
    access: {
      readDeniedTotal: 0,
      writeDeniedTotal: 0,
      notifyDeniedTotal: 0
    }
  };
}

function fixture() {
  const application = applicationSnapshot();
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

function captureHarness({ wait = async () => {} } = {}) {
  const events = [];
  let busCount = 0;
  let stopCalls = 0;
  let stopped = false;
  let disconnects = 0;
  const probeBus = {
    disconnect() {
      disconnects += 1;
      events.push("probe-disconnect");
    }
  };
  const serverBus = { name: ":1.42" };
  const registered = {
    state: "REGISTERED",
    application: { service: { characteristicCount: 7 } }
  };
  const stoppedSnapshot = {
    state: "STOPPED",
    application: registered.application
  };

  return {
    events,
    get busCount() {
      return busCount;
    },
    get stopCalls() {
      return stopCalls;
    },
    get disconnects() {
      return disconnects;
    },
    runtime: {
      systemBus() {
        busCount += 1;
        return busCount === 1 ? probeBus : serverBus;
      },
      createPort(options) {
        return {
          async start() {
            events.push("port-start");
            options.busFactory();
          },
          snapshot() {
            events.push("port-snapshot");
            return registered;
          },
          async stop() {
            events.push("port-stop");
            stopCalls += 1;
            stopped = true;
            return stoppedSnapshot;
          }
        };
      },
      async readAdapterState() {
        events.push(stopped ? "adapter-after" : "adapter-before");
        return {
          powered: true,
          discovering: false,
          gattManagerAvailable: true
        };
      },
      async readBluezVersion() {
        events.push("bluez-version");
        return "5.82";
      },
      async readBluetoothServiceActive() {
        events.push("bluetooth-service");
        return true;
      },
      async nameHasOwner() {
        events.push(stopped ? "owner-after" : "owner-before");
        return !stopped;
      },
      async delay(milliseconds) {
        events.push(`delay-${milliseconds}`);
        return wait(milliseconds);
      }
    }
  };
}

function blockedCaptureHarness({ stage, controller = null }) {
  let busCount = 0;
  let stopCalls = 0;
  let stopped = false;
  let serverOpened = false;
  let probeDisconnects = 0;
  let serverDisconnects = 0;
  const probeBus = {
    disconnect() {
      probeDisconnects += 1;
    }
  };
  const serverBus = {
    name: ":1.42",
    disconnect() {
      if (serverDisconnects === 0) serverDisconnects += 1;
    }
  };
  const registered = {
    state: "REGISTERED",
    application: { service: { characteristicCount: 7 } }
  };
  const stoppedSnapshot = {
    state: "STOPPED",
    application: registered.application
  };
  const block = () => {
    controller?.abort(new Error("private blocked operation detail"));
    return new Promise(() => {});
  };

  return {
    get stopCalls() {
      return stopCalls;
    },
    get probeDisconnects() {
      return probeDisconnects;
    },
    get serverDisconnects() {
      return serverDisconnects;
    },
    runtime: {
      operationDeadlineMs: 20,
      cleanupDeadlineMs: 20,
      systemBus() {
        busCount += 1;
        if (busCount === 1) return probeBus;
        serverOpened = true;
        return serverBus;
      },
      createPort(options) {
        return {
          async start() {
            options.busFactory();
            if (stage === "start") return block();
          },
          snapshot() {
            return registered;
          },
          async stop() {
            stopCalls += 1;
            if (stage === "stop") return block();
            stopped = true;
            if (serverOpened) serverBus.disconnect();
            return stoppedSnapshot;
          }
        };
      },
      async readAdapterState() {
        const currentStage = stopped
          ? "adapter-after"
          : "adapter-before";
        if (stage === currentStage) return block();
        return {
          powered: true,
          discovering: false,
          gattManagerAvailable: true
        };
      },
      async readBluezVersion() {
        return "5.82";
      },
      async readBluetoothServiceActive() {
        return true;
      },
      async nameHasOwner() {
        const currentStage = stopped ? "owner-after" : "owner-before";
        if (stage === currentStage) return block();
        return !stopped;
      },
      async delay() {}
    }
  };
}

test("B5.3 evaluator accepts exact physical registration and cleanup", () => {
  const report = evaluatePhysicalGattEvidence(
    fixture(),
    "2026-07-20T12:00:00.000Z"
  );

  assert.equal(report.verdict, "PASS");
  assert.equal(report.checks.registerApplication, "PASS");
  assert.equal(report.checks.objectManagerConsumed, "PASS");
  assert.equal(report.checks.preSessionTraffic, "ZERO");
  assert.equal(report.checks.resourceCleanup, "PASS");
  assert.equal(report.observed.managedObjectCount, 8);
  assert.equal(report.observed.managedObjectRequests, 1);
  assert.equal(report.observed.characteristicCount, 7);
  assert.equal(report.observed.sessionsOpened, 0);
  assert.equal(report.gate.raspberryGattSmoke, "PASS");
  assert.equal(report.gate.androidGattClient, "NOT_STARTED");
  assert.equal(report.gate.b5HundredSessionGate, "PENDING");
});

test("B5.3 evaluator rejects registration, profile and access regressions", () => {
  for (const mutate of [
    (value) => {
      value.registered.registrationsTotal = 0;
    },
    (value) => {
      value.registered.application.managedObjectRequestsTotal = 0;
    },
    (value) => {
      value.observedProfile.characteristics.pop();
    },
    (value) => {
      value.registered.application.access.readDeniedTotal = 1;
    }
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => evaluatePhysicalGattEvidence(value),
      B5GattSmokeError
    );
  }
});

test("B5.3 evaluator rejects every cleanup leak", () => {
  for (const mutate of [
    (value) => {
      value.ownerAfterStop = true;
    },
    (value) => {
      value.stopped.busConnected = true;
    },
    (value) => {
      value.stopped.activeMatchRules = 1;
    },
    (value) => {
      value.stopped.exportedInterfaceCount = 1;
    },
    (value) => {
      value.stopped.unregistersTotal = 0;
    },
    (value) => {
      value.discoveryAfter = true;
    }
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => evaluatePhysicalGattEvidence(value),
      B5GattSmokeError
    );
  }
});

test("B5.3 awaits onRegistered exactly once before the physical hold", async () => {
  const harness = captureHarness();
  let hookCalls = 0;
  const evidence = await capturePhysicalGattEvidence(
    {
      adapterName: "hci0",
      holdMs: 1_000,
      async onRegistered(context) {
        hookCalls += 1;
        assert.deepEqual(Object.keys(context).sort(), ["adapterName", "signal"]);
        assert.equal(context.adapterName, "hci0");
        assert.equal(context.signal, null);
        harness.events.push("hook-start");
        await Promise.resolve();
        harness.events.push("hook-end");
      }
    },
    undefined,
    harness.runtime
  );

  assert.equal(hookCalls, 1);
  assert.equal(evidence.registered.state, "REGISTERED");
  assert.equal(harness.stopCalls, 1);
  assert.equal(harness.disconnects, 1);
  assert.ok(
    harness.events.indexOf("port-snapshot") <
      harness.events.indexOf("hook-start")
  );
  assert.ok(
    harness.events.indexOf("hook-end") < harness.events.indexOf("delay-1000")
  );
});

test("B5.3 hook failures are redacted and always stop the GATT port", async () => {
  const harness = captureHarness();
  await assert.rejects(
    () =>
      capturePhysicalGattEvidence(
        {
          adapterName: "hci0",
          holdMs: 1_000,
          async onRegistered() {
            throw new Error("/tmp/private-hook-detail");
          }
        },
        undefined,
        harness.runtime
      ),
    (error) =>
      error instanceof B5GattSmokeError &&
      error.code === "REGISTERED_HOOK_FAILED" &&
      error.message === "registered hook failed"
  );
  assert.equal(harness.stopCalls, 1);
  assert.equal(harness.disconnects, 1);
  assert.equal(harness.events.includes("delay-1000"), false);
});

test("B5.3 AbortSignal is fail-closed before and after registration", async () => {
  const preAbortedHarness = captureHarness();
  const preAborted = new AbortController();
  preAborted.abort(new Error("private abort detail"));
  await assert.rejects(
    () =>
      capturePhysicalGattEvidence(
        {
          adapterName: "hci0",
          holdMs: 1_000,
          signal: preAborted.signal
        },
        undefined,
        preAbortedHarness.runtime
      ),
    (error) =>
      error instanceof B5GattSmokeError &&
      error.code === "PHYSICAL_CAPTURE_ABORTED" &&
      error.message === "physical GATT capture was aborted"
  );
  assert.equal(preAbortedHarness.busCount, 0);
  assert.equal(preAbortedHarness.stopCalls, 0);

  const queuedHarness = captureHarness();
  const queuedController = new AbortController();
  let queuedAdapterReads = 0;
  const queuedReadAdapter = queuedHarness.runtime.readAdapterState;
  queuedHarness.runtime.readAdapterState = async (...arguments_) => {
    queuedAdapterReads += 1;
    return queuedReadAdapter(...arguments_);
  };
  const queuedCapture = capturePhysicalGattEvidence(
    {
      adapterName: "hci0",
      holdMs: 1_000,
      signal: queuedController.signal
    },
    undefined,
    queuedHarness.runtime
  );
  queuedController.abort(new Error("private queued abort detail"));
  await assert.rejects(
    () => queuedCapture,
    (error) =>
      error instanceof B5GattSmokeError &&
      error.code === "PHYSICAL_CAPTURE_ABORTED" &&
      error.message === "physical GATT capture was aborted"
  );
  assert.equal(queuedAdapterReads, 0);
  assert.equal(queuedHarness.stopCalls, 1);
  assert.equal(queuedHarness.disconnects, 1);

  const hookController = new AbortController();
  const hookHarness = captureHarness();
  await assert.rejects(
    () =>
      capturePhysicalGattEvidence(
        {
          adapterName: "hci0",
          holdMs: 1_000,
          signal: hookController.signal,
          async onRegistered() {
            hookController.abort(new Error("private hook abort detail"));
            return new Promise(() => {});
          }
        },
        undefined,
        hookHarness.runtime
      ),
    (error) =>
      error instanceof B5GattSmokeError &&
      error.code === "PHYSICAL_CAPTURE_ABORTED" &&
      error.message === "physical GATT capture was aborted"
  );
  assert.equal(hookHarness.stopCalls, 1);
  assert.equal(hookHarness.disconnects, 1);
  assert.equal(hookHarness.events.includes("delay-1000"), false);

  const controller = new AbortController();
  const activeHarness = captureHarness({
    wait() {
      controller.abort(new Error("private runtime detail"));
      return new Promise(() => {});
    }
  });
  await assert.rejects(
    () =>
      capturePhysicalGattEvidence(
        {
          adapterName: "hci0",
          holdMs: 1_000,
          signal: controller.signal,
          async onRegistered(context) {
            assert.equal(context.signal, controller.signal);
          }
        },
        undefined,
        activeHarness.runtime
      ),
    (error) =>
      error instanceof B5GattSmokeError &&
      error.code === "PHYSICAL_CAPTURE_ABORTED" &&
      error.message === "physical GATT capture was aborted"
  );
  assert.equal(activeHarness.stopCalls, 1);
  assert.equal(activeHarness.disconnects, 1);
});

test("B5.3 abort releases every D-Bus and port await with bounded cleanup", async () => {
  for (const stage of [
    "adapter-before",
    "start",
    "owner-before",
    "stop",
    "owner-after",
    "adapter-after"
  ]) {
    const controller = new AbortController();
    const harness = blockedCaptureHarness({ stage, controller });
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        capturePhysicalGattEvidence(
          {
            adapterName: "hci0",
            holdMs: 1_000,
            signal: controller.signal
          },
          undefined,
          harness.runtime
        ),
      (error) =>
        error instanceof B5GattSmokeError &&
        error.code === "PHYSICAL_CAPTURE_ABORTED" &&
        error.message === "physical GATT capture was aborted",
      stage
    );
    assert.ok(Date.now() - startedAt < 250, stage);
    assert.equal(harness.stopCalls, 1, stage);
    assert.equal(harness.probeDisconnects, 1, stage);
    assert.equal(
      harness.serverDisconnects,
      stage === "adapter-before" ? 0 : 1,
      stage
    );
  }
});

test("B5.3 deadlines bound blocked D-Bus and port operations", async () => {
  for (const stage of [
    "adapter-before",
    "start",
    "owner-before",
    "stop",
    "owner-after",
    "adapter-after"
  ]) {
    const harness = blockedCaptureHarness({ stage });
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        capturePhysicalGattEvidence(
          {
            adapterName: "hci0",
            holdMs: 1_000
          },
          undefined,
          harness.runtime
        ),
      (error) =>
        error instanceof B5GattSmokeError &&
        error.code === "PHYSICAL_CAPTURE_DEADLINE_EXCEEDED" &&
        error.message ===
          "physical GATT operation exceeded its deadline",
      stage
    );
    assert.ok(Date.now() - startedAt < 250, stage);
    assert.equal(harness.stopCalls, 1, stage);
    assert.equal(harness.probeDisconnects, 1, stage);
    assert.equal(
      harness.serverDisconnects,
      stage === "adapter-before" ? 0 : 1,
      stage
    );
  }
});

test("B5.3 self-test is offline and preserves the pending B5 gate", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(
        ROOT,
        "scripts",
        "run-b5-raspberry-gatt-smoke.mjs"
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
