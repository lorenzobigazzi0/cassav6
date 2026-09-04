import assert from "node:assert/strict";
import test from "node:test";

import {
  B5DirectControlSmokeError,
  evaluatePhysicalDirectControlEvidence,
  orchestrateSingleDirectControlClose,
  runPhysicalDirectControlSmoke,
  runSelfTest,
  validDirectControlFixtureEvidence,
  verifyDirectControlCleanupEvidence
} from "../scripts/run-b5-direct-control-smoke.mjs";

function cloneFixture() {
  return structuredClone(validDirectControlFixtureEvidence());
}

function assertCode(code) {
  return (error) =>
    error instanceof B5DirectControlSmokeError && error.code === code;
}

test("B5.7 self-test proves one closed and redacted direct-control session", () => {
  const report = runSelfTest();
  assert.equal(report.phase, "B5.7");
  assert.equal(report.mode, "SELF_TEST");
  assert.equal(report.verdict, "PASS");
  assert.equal(report.physicalRadioAccessed, false);
  assert.equal(report.v5btProductionServiceChanges, false);

  const fixture = cloneFixture();
  fixture.preflight.hostname = "123e4567-e89b-12d3-a456-426614174000";
  fixture.beforeStop.application.applicationPath =
    "/org/bluez/hci0/dev_00_11_22_33_44_55";
  const physical = evaluatePhysicalDirectControlEvidence(
    fixture,
    "2026-07-21T00:00:00.000Z"
  );
  assert.equal(physical.observed.finalState, "CLOSED");
  assert.equal(physical.observed.keyEstablishments, 1);
  assert.equal(physical.observed.activeTransitions, 1);
  assert.equal(physical.observed.pingsSent, 4);
  assert.equal(physical.observed.pongsVerified, 4);
  assert.equal(physical.observed.cleanCloses, 1);
  assert.equal(physical.observed.activeAfterClose, 0);
  assert.equal(physical.observed.timersAfterCleanup, 0);
  assert.equal(physical.observed.retainedSecretBuffersAfterCleanup, 0);
  assert.equal(physical.gate.hundredSessionCampaign, "PENDING");

  const encoded = JSON.stringify(physical);
  for (const forbidden of [
    "123e4567-e89b-12d3-a456-426614174000",
    "/org/bluez/",
    "\"applicationPath\":",
    "\"sessionId\":",
    "\"payload\":"
  ]) {
    assert.equal(encoded.includes(forbidden), false);
  }
});

test("B5.7 rejects missing key, ACTIVE transition or heartbeat cycles", () => {
  const missingKey = cloneFixture();
  missingKey.beforeStop.application.hello.keyEstablishedTotal = 0;
  assert.throws(
    () => evaluatePhysicalDirectControlEvidence(missingKey),
    assertCode("DIRECT_CONTROL_EVIDENCE_INVALID")
  );

  const missingActive = cloneFixture();
  missingActive.beforeStop.application.hello.activeSessionsTotal = 0;
  assert.throws(
    () => evaluatePhysicalDirectControlEvidence(missingActive),
    assertCode("DIRECT_CONTROL_EVIDENCE_INVALID")
  );

  const shortHeartbeat = cloneFixture();
  shortHeartbeat.beforeStop.application.hello.pingsSentTotal = 2;
  shortHeartbeat.beforeStop.application.hello.pongsVerifiedTotal = 2;
  assert.throws(
    () => evaluatePhysicalDirectControlEvidence(shortHeartbeat),
    assertCode("DIRECT_CONTROL_EVIDENCE_INVALID")
  );
});

test("B5.7 rejects non-clean close and retained runtime resources", () => {
  const forced = cloneFixture();
  forced.beforeStop.application.hello.cleanClosesTotal = 0;
  forced.beforeStop.application.hello.forcedClosesTotal = 1;
  assert.throws(
    () => evaluatePhysicalDirectControlEvidence(forced),
    assertCode("DIRECT_CONTROL_EVIDENCE_INVALID")
  );

  const timerLeak = cloneFixture();
  timerLeak.beforeStop.application.hello.activeTimerCount = 1;
  assert.throws(
    () => evaluatePhysicalDirectControlEvidence(timerLeak),
    assertCode("DIRECT_CONTROL_EVIDENCE_INVALID")
  );

  const secretLeak = cloneFixture();
  secretLeak.stopped.application.hello.retainedSecretBufferCount = 1;
  assert.throws(
    () => evaluatePhysicalDirectControlEvidence(secretLeak),
    assertCode("DIRECT_CONTROL_EVIDENCE_INVALID")
  );

  const wrongResetDelta = cloneFixture();
  wrongResetDelta.beforeStop.application.hello.resetsTotal = 1;
  assert.throws(
    () => evaluatePhysicalDirectControlEvidence(wrongResetDelta),
    assertCode("DIRECT_CONTROL_EVIDENCE_INVALID")
  );
});

test("B5.7 accepts one client StopNotify reset followed by server cleanup", () => {
  const fixture = cloneFixture();
  fixture.beforeStop.application.hello.resetsTotal = 1;
  fixture.beforeStop.application.hello.pingsSentTotal = 5;
  fixture.beforeStop.application.hello.heartbeatMissesTotal = 1;
  fixture.stopped.application.hello.resetsTotal = 2;
  fixture.stopped.application.hello.pingsSentTotal = 5;
  fixture.stopped.application.hello.heartbeatMissesTotal = 1;
  const report = evaluatePhysicalDirectControlEvidence(fixture);
  assert.equal(report.verdict, "PASS");
  assert.equal(report.observed.activeAfterCleanup, 0);
  assert.equal(report.observed.heartbeatMisses, 1);
});

test("B5.7 closes after activation plus three heartbeat PONGs", async () => {
  let requests = 0;
  let phase = "WAITING";
  const hello = {
    helloExchangedTotal: 1,
    finishProofsVerifiedTotal: 1,
    keyEstablishedTotal: 1,
    activeSessionsTotal: 1,
    activeExchangeCount: 1,
    keyEstablishedSessionCount: 1,
    activeSessionCount: 1,
    closingSessionCount: 0,
    activeTimerCount: 1,
    retainedSecretBufferCount: 2,
    pingsSentTotal: 0,
    pongsVerifiedTotal: 0,
    cleanClosesTotal: 0,
    heartbeatTimeoutClosesTotal: 0,
    forcedClosesTotal: 0,
    directControlFailuresTotal: 0
  };
  const application = {
    snapshot() {
      return { hello: { ...hello } };
    },
    requestSingleDirectClose() {
      requests += 1;
      phase = "CLOSING";
      hello.activeSessionCount = 0;
      hello.closingSessionCount = 1;
      hello.activeTimerCount = 1;
    }
  };
  const result = await orchestrateSingleDirectControlClose(application, {
    pollMs: 0,
    wait: async () => {
      if (phase === "WAITING") {
        hello.pingsSentTotal = 4;
        hello.pongsVerifiedTotal = 4;
      } else {
        phase = "CLOSED";
        hello.activeExchangeCount = 0;
        hello.keyEstablishedSessionCount = 0;
        hello.closingSessionCount = 0;
        hello.activeTimerCount = 0;
        hello.retainedSecretBufferCount = 0;
        hello.cleanClosesTotal = 1;
      }
    }
  });
  assert.equal(requests, 1);
  assert.deepEqual(result, {
    closeRequested: true,
    cleanCloseObserved: true
  });
});

test("B5.7 orchestration rejects parallel sessions and missing clean close", async () => {
  const parallel = {
    snapshot() {
      return {
        hello: {
          helloExchangedTotal: 2,
          finishProofsVerifiedTotal: 2,
          keyEstablishedTotal: 2,
          activeSessionsTotal: 2,
          activeSessionCount: 2,
          closingSessionCount: 0,
          cleanClosesTotal: 0,
          heartbeatTimeoutClosesTotal: 0,
          forcedClosesTotal: 0,
          directControlFailuresTotal: 0
        }
      };
    }
  };
  await assert.rejects(
    () => orchestrateSingleDirectControlClose(parallel),
    assertCode("DIRECT_CONTROL_ORCHESTRATION_INVALID")
  );

  const ended = {
    snapshot() {
      return {
        hello: {
          helloExchangedTotal: 0,
          finishProofsVerifiedTotal: 0,
          keyEstablishedTotal: 0,
          activeSessionsTotal: 0,
          activeSessionCount: 0,
          closingSessionCount: 0,
          cleanClosesTotal: 0,
          pingsSentTotal: 0,
          pongsVerifiedTotal: 0,
          heartbeatTimeoutClosesTotal: 0,
          forcedClosesTotal: 0,
          directControlFailuresTotal: 0
        }
      };
    }
  };
  await assert.rejects(
    () =>
      orchestrateSingleDirectControlClose(ended, {
        captureEnded: () => true
      }),
    assertCode("DIRECT_CONTROL_ORCHESTRATION_TIMEOUT")
  );
});

test("B5.7 orchestration aborts promptly with a fixed redacted error", async () => {
  const controller = new AbortController();
  const waiting = {
    snapshot() {
      return {
        hello: {
          helloExchangedTotal: 0,
          finishProofsVerifiedTotal: 0,
          keyEstablishedTotal: 0,
          activeSessionsTotal: 0,
          activeSessionCount: 0,
          closingSessionCount: 0,
          cleanClosesTotal: 0,
          pingsSentTotal: 0,
          pongsVerifiedTotal: 0,
          heartbeatTimeoutClosesTotal: 0,
          forcedClosesTotal: 0,
          directControlFailuresTotal: 0
        }
      };
    }
  };
  const result = orchestrateSingleDirectControlClose(waiting, {
    signal: controller.signal,
    wait: () => new Promise(() => {})
  });
  controller.abort(new Error("/tmp/private-abort-reason"));
  await assert.rejects(
    () => result,
    (error) =>
      error instanceof B5DirectControlSmokeError &&
      error.code === "PHYSICAL_CAPTURE_ABORTED" &&
      error.message === "physical direct-control gate was aborted"
  );
});

test("B5.7 physical runner forwards readiness and abort controls", async () => {
  const controller = new AbortController();
  const onRegistered = async () => {};
  let inspections = 0;
  let captureOptions = null;
  let orchestrationOptions = null;
  const registry = {
    async inspect() {
      inspections += 1;
    }
  };
  const options = {
    adapterName: "hci0",
    holdMs: 60_000,
    registryPath: "/var/lib/cassav5bt-bluetooth/devices.json",
    serverNodeId: "123e4567-e89b-12d3-a456-426614174000",
    bootId: 54,
    capabilities: 72,
    onRegistered,
    signal: controller.signal
  };

  const report = await runPhysicalDirectControlSmoke(options, {
    registry,
    async capturePhysicalGattEvidence(received) {
      captureOptions = received;
      return cloneFixture();
    },
    async orchestrateSingleDirectControlClose(_application, received) {
      orchestrationOptions = received;
      return { closeRequested: true, cleanCloseObserved: true };
    }
  });

  assert.equal(report.verdict, "PASS");
  assert.equal(inspections, 1);
  assert.equal(captureOptions.onRegistered, onRegistered);
  assert.equal(captureOptions.signal, controller.signal);
  assert.equal(orchestrationOptions.signal, controller.signal);
  assert.equal(typeof orchestrationOptions.captureEnded, "function");
});

test("B5.7 preserves orchestration timeout only with structured cleanup proof", async () => {
  const timeout = new B5DirectControlSmokeError(
    "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
    "physical capture ended before a clean direct-control close"
  );
  const options = {
    adapterName: "hci0",
    holdMs: 60_000,
    registryPath: "/var/lib/cassav5bt-bluetooth/devices.json",
    serverNodeId: "123e4567-e89b-12d3-a456-426614174000",
    bootId: 54,
    capabilities: 72
  };
  const registry = { inspect: async () => {} };

  assert.equal(verifyDirectControlCleanupEvidence(cloneFixture()), true);
  await assert.rejects(
    () =>
      runPhysicalDirectControlSmoke(options, {
        registry,
        capturePhysicalGattEvidence: async () => cloneFixture(),
        orchestrateSingleDirectControlClose: async () => {
          throw timeout;
        }
      }),
    (error) =>
      error instanceof B5DirectControlSmokeError &&
      error.code === "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT" &&
      error.cleanupVerified === true
  );

  const brokenCleanup = cloneFixture();
  brokenCleanup.ownerAfterStop = true;
  await assert.rejects(
    () =>
      runPhysicalDirectControlSmoke(options, {
        registry,
        capturePhysicalGattEvidence: async () => brokenCleanup,
        orchestrateSingleDirectControlClose: async () => {
          throw timeout;
        }
      }),
    (error) =>
      error instanceof B5DirectControlSmokeError &&
      error.code === "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT" &&
      error.cleanupVerified === false
  );
});

test("B5.7 timeout classification wins over a concurrent capture failure", async () => {
  const timeout = new B5DirectControlSmokeError(
    "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
    "physical capture ended before a clean direct-control close"
  );
  await assert.rejects(
    () =>
      runPhysicalDirectControlSmoke(
        {
          adapterName: "hci0",
          holdMs: 60_000,
          registryPath: "/var/lib/cassav5bt-bluetooth/devices.json",
          serverNodeId: "123e4567-e89b-12d3-a456-426614174000",
          bootId: 54,
          capabilities: 72
        },
        {
          registry: { inspect: async () => {} },
          capturePhysicalGattEvidence: async () => {
            throw new Error("capture failed");
          },
          orchestrateSingleDirectControlClose: async () => {
            throw timeout;
          }
        }
      ),
    (error) =>
      error instanceof B5DirectControlSmokeError &&
      error.code === "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT" &&
      error.cleanupVerified === false
  );
});

test("B5.7 pre-aborted physical runner performs no registry or capture work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private abort reason"));
  let inspections = 0;
  let captures = 0;
  await assert.rejects(
    () =>
      runPhysicalDirectControlSmoke(
        {
          adapterName: "hci0",
          holdMs: 60_000,
          registryPath: "/var/lib/cassav5bt-bluetooth/devices.json",
          serverNodeId: "123e4567-e89b-12d3-a456-426614174000",
          bootId: 54,
          capabilities: 72,
          signal: controller.signal
        },
        {
          registry: {
            async inspect() {
              inspections += 1;
            }
          },
          async capturePhysicalGattEvidence() {
            captures += 1;
            return cloneFixture();
          }
        }
      ),
    (error) =>
      error instanceof B5DirectControlSmokeError &&
      error.code === "PHYSICAL_CAPTURE_ABORTED" &&
      error.message === "physical direct-control gate was aborted"
  );
  assert.equal(inspections, 0);
  assert.equal(captures, 0);
});
