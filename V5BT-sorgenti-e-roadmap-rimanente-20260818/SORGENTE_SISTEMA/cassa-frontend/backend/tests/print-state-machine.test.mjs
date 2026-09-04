import assert from "node:assert/strict";
import test from "node:test";

import {
  INVALID_PRINT_STATE_TRANSITION_CODE,
  applyPrintStateTransition,
  canTransitionPrintState,
  createPrintStateMachine,
  normalizePrintState,
  resolvePrintRuntimeState,
} from "../modules/print-spool/print-state-machine.js";

test("N3 print state machine formalizza le transizioni principali della roadmap", () => {
  const cases = [
    ["queued", "claimed", true],
    ["claimed", "sent", true],
    ["claimed", "failed_retryable", true],
    ["sent", "confirmed", true],
    ["sent", "failed_retryable", true],
    ["sent", "failed_final", true],
    ["failed_retryable", "queued", false],
    ["failed_final", "queued", false],
    ["confirmed", "queued", false],
    ["queued", "confirmed", false],
    ["queued", "unknown", false],
  ];

  for (const [from, to, expected] of cases) {
    assert.equal(canTransitionPrintState(from, to), expected, `${from} -> ${to}`);
  }
  assert.equal(
    canTransitionPrintState("failed_retryable", "queued", { allowRetry: true }),
    true,
    "failed_retryable -> queued deve essere un retry esplicito",
  );
});

test("N3 print state machine normalizza gli stati legacy spool", () => {
  assert.equal(normalizePrintState("queued"), "queued");
  assert.equal(normalizePrintState("processing"), "claimed");
  assert.equal(normalizePrintState("printed"), "confirmed");
  assert.equal(normalizePrintState("failed"), "failed_retryable");
  assert.equal(normalizePrintState("failed_configuration"), "failed_final");
  assert.equal(normalizePrintState("unknown_after_crash"), "failed_final");
});

test("N3 print state machine applica il percorso queued claimed sent confirmed", () => {
  const claimed = applyPrintStateTransition(
    { id: "print_1", status: "queued" },
    "claimed",
    { now: () => "2026-07-03T12:00:00.000Z" },
  );
  const sent = applyPrintStateTransition(claimed, "sent", {
    now: () => "2026-07-03T12:00:01.000Z",
  });
  const confirmed = applyPrintStateTransition(sent, "confirmed", {
    now: () => "2026-07-03T12:00:02.000Z",
  });

  assert.equal(confirmed.printState, "confirmed");
  assert.deepEqual(confirmed.printStatePath, ["queued", "claimed", "sent", "confirmed"]);
  assert.equal(confirmed.printStateUpdatedAt, "2026-07-03T12:00:02.000Z");
  assert.throws(
    () => applyPrintStateTransition(confirmed, "queued"),
    (error) => {
      assert.equal(error.code, INVALID_PRINT_STATE_TRANSITION_CODE);
      assert.match(error.message, /Transizione stampa non ammessa: confirmed -> queued/);
      return true;
    },
  );
});

test("N3 print state machine proietta runtime legacy e retry espliciti", () => {
  assert.deepEqual(
    resolvePrintRuntimeState({ status: "queued" }),
    { printState: "queued", path: ["queued"] },
  );
  assert.deepEqual(
    resolvePrintRuntimeState({ status: "processing" }),
    { printState: "claimed", path: ["queued", "claimed"] },
  );
  assert.deepEqual(
    resolvePrintRuntimeState({ status: "printed" }),
    { printState: "confirmed", path: ["queued", "claimed", "sent", "confirmed"] },
  );
  assert.deepEqual(
    resolvePrintRuntimeState({ status: "failed", nextRetryAt: "2026-07-03T12:01:00.000Z" }),
    { printState: "failed_retryable", path: ["queued", "claimed", "sent", "failed_retryable"] },
  );
  assert.deepEqual(
    resolvePrintRuntimeState({ status: "failed" }),
    { printState: "failed_final", path: ["queued", "claimed", "sent", "failed_final"] },
  );
});

test("N3 print state machine espone createPrintStateMachine con flag canary", () => {
  const disabledMachine = createPrintStateMachine({ enabled: false });
  const overridden = disabledMachine.applyTransition(
    { id: "print_disabled", printState: "confirmed" },
    "queued",
    { now: () => "2026-07-03T12:02:00.000Z" },
  );
  assert.equal(overridden.printState, "queued");

  const enabledMachine = createPrintStateMachine({ enabled: true });
  assert.throws(
    () => enabledMachine.applyTransition({ printState: "confirmed" }, "queued"),
    { code: INVALID_PRINT_STATE_TRANSITION_CODE },
  );
});
