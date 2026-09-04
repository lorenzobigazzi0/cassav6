import assert from "node:assert/strict";
import test from "node:test";

import {
  B5MutualAuthSmokeError,
  evaluatePhysicalMutualAuthEvidence,
  runSelfTest,
  validMutualAuthFixtureEvidence
} from "../scripts/run-b5-mutual-auth-smoke.mjs";

function cloneFixture() {
  return structuredClone(validMutualAuthFixtureEvidence());
}

function assertCode(code) {
  return (error) =>
    error instanceof B5MutualAuthSmokeError && error.code === code;
}

test("B5.6 self-test proves one redacted mutual-auth exchange", () => {
  const report = runSelfTest();
  assert.equal(report.phase, "B5.6");
  assert.equal(report.mode, "SELF_TEST");
  assert.equal(report.verdict, "PASS");
  assert.equal(report.physicalRadioAccessed, false);
  assert.equal(report.activeV4Changes, false);

  const physical = evaluatePhysicalMutualAuthEvidence(
    cloneFixture(),
    "2026-07-21T00:00:00.000Z"
  );
  assert.equal(physical.observed.authenticatedSessionsBeforeCleanup, 1);
  assert.equal(physical.observed.authenticatedSessionsAfterCleanup, 0);
  assert.equal(physical.gate.sessionKey, "NOT_STARTED");
  assert.equal(physical.gate.b5HundredSessionGate, "PENDING");
  const encoded = JSON.stringify(physical);
  for (const secret of [
    "123e4567-e89b-12d3-a456-426614174000",
    "/org/bluez/hci0/dev_00_11_22_33_44_55",
    "\"aliasKey\":",
    "\"sessionId\":"
  ]) {
    assert.equal(encoded.includes(secret), false);
  }
});

test("B5.6 rejects incomplete authentication and callback duplicates", () => {
  const incomplete = cloneFixture();
  incomplete.beforeStop.application.hello.finishProofsVerifiedTotal = 0;
  assert.throws(
    () => evaluatePhysicalMutualAuthEvidence(incomplete),
    assertCode("MUTUAL_AUTH_EVIDENCE_INVALID")
  );

  const duplicate = cloneFixture();
  duplicate.beforeStop.application.hello.authDuplicateWritesTotal = 1;
  assert.throws(
    () => evaluatePhysicalMutualAuthEvidence(duplicate),
    assertCode("MUTUAL_AUTH_EVIDENCE_INVALID")
  );
});

test("B5.6 requires cleanup to remove the authenticated session", () => {
  const leaked = cloneFixture();
  leaked.stopped.application.hello.activeExchangeCount = 1;
  leaked.stopped.application.hello.authenticatedSessionCount = 1;
  assert.throws(
    () => evaluatePhysicalMutualAuthEvidence(leaked),
    assertCode("MUTUAL_AUTH_EVIDENCE_INVALID")
  );
});
