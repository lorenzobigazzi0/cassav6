import assert from "node:assert/strict";
import test from "node:test";
import { createPrinterCircuitBreaker } from "../modules/print-spool/printer-circuit-breaker.js";

test("il circuito si apre dopo la soglia di fallimenti consecutivi", () => {
  let t = 0;
  const cb = createPrinterCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, nowMs: () => t });
  assert.equal(cb.canAttempt("pr1"), true);
  cb.recordFailure("pr1");
  cb.recordFailure("pr1");
  assert.equal(cb.stateOf("pr1"), "closed", "sotto soglia resta chiuso");
  cb.recordFailure("pr1");
  assert.equal(cb.stateOf("pr1"), "open");
  assert.equal(cb.canAttempt("pr1"), false, "aperto → nessun tentativo");
});

test("dopo il cooldown passa a half_open e un solo probe", () => {
  let t = 0;
  const cb = createPrinterCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, halfOpenMax: 1, nowMs: () => t });
  cb.recordFailure("pr1");
  cb.recordFailure("pr1");
  assert.equal(cb.stateOf("pr1"), "open");
  t = 1500;
  assert.equal(cb.stateOf("pr1"), "half_open");
  assert.equal(cb.canAttempt("pr1"), true, "primo probe consentito");
  assert.equal(cb.canAttempt("pr1"), false, "secondo probe negato");
});

test("un successo in half_open richiude il circuito", () => {
  let t = 0;
  const cb = createPrinterCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, nowMs: () => t });
  cb.recordFailure("pr1");
  cb.recordFailure("pr1");
  t = 1500;
  cb.canAttempt("pr1"); // half_open probe
  cb.recordSuccess("pr1");
  assert.equal(cb.stateOf("pr1"), "closed");
  assert.equal(cb.canAttempt("pr1"), true);
});

test("un fallimento in half_open riapre subito il circuito", () => {
  let t = 0;
  const cb = createPrinterCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, nowMs: () => t });
  cb.recordFailure("pr1");
  cb.recordFailure("pr1");
  t = 1500;
  cb.canAttempt("pr1"); // half_open probe
  cb.recordFailure("pr1");
  assert.equal(cb.stateOf("pr1"), "open");
  assert.equal(cb.canAttempt("pr1"), false);
});

test("i circuiti sono isolati per stampante", () => {
  let t = 0;
  const cb = createPrinterCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, nowMs: () => t });
  cb.recordFailure("pr1");
  assert.equal(cb.stateOf("pr1"), "open");
  assert.equal(cb.canAttempt("pr2"), true, "pr2 resta chiuso");
});

test("disabilitato è sempre pass-through", () => {
  const cb = createPrinterCircuitBreaker({ enabled: false, failureThreshold: 1 });
  cb.recordFailure("pr1");
  cb.recordFailure("pr1");
  assert.equal(cb.canAttempt("pr1"), true);
});
